import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import { BnplProviderError, isDefinitiveRejection } from "../core/errors";
import { parseAmount } from "../core/money";
import type { BnplProvider } from "../core/provider";
import { isAuthorisedState, statusFromBalances } from "../core/status";
import type { BnplCaptureResult, BnplOrderState, BnplRefundResult } from "../core/types";
import { commandInputHash } from "./command-input";
import {
	type OrderBaseline,
	type OrderRecord,
	applyMoneyOperations,
	attributePendingOperations,
} from "./order";
import { type OrderWhere, mutateOrder } from "./order-store";

export type JournalOperation = "capture" | "refund" | "authorise" | "cancel" | "void" | "close";

/** What the provider confirmed for a pending command, so a retry can verify it without resending. */
type CommandEvidence = Record<string, number>;

type JournalEntry =
	| {
			key: string;
			hash: string;
			token?: string;
			before?: OrderBaseline;
			evidence?: CommandEvidence;
			state: "pending";
	  }
	| { key: string; hash: string; state: "completed"; result: Record<string, unknown> };

interface Reservation {
	key: string;
	hash: string;
	token?: string;
	before?: OrderBaseline;
	evidence?: CommandEvidence;
}

export interface MoneyCommandSpec<Checked> {
	where: OrderWhere;
	operation: JournalOperation;
	reference: string;
	input: unknown;
	/** Whether an uncertain earlier attempt blocks this request or is handed back for verification. */
	onPending: "conflict" | "verify";
	recordBaseline?: boolean;
	/**
	 * Validates a new reservation against the latest order inside the reserving write; its result
	 * reaches the command. A pending command skips it, since its own effect may already be applied.
	 */
	check?: (order: OrderRecord) => Checked;
}

export interface Settlement<Response> {
	response: Response;
	patch?: object;
}

export interface MoneyCommand<Checked> {
	/** `pending` means an earlier attempt's outcome is unknown: verify it, never send again. */
	readonly state: "reserved" | "pending";
	readonly reference: string;
	readonly baseline?: OrderBaseline;
	readonly checked: Checked | undefined;
	readonly evidence?: CommandEvidence;
	/**
	 * Sends the provider request once; a provably rejected request frees the reference for a retry,
	 * unless `recoverable` says the refusal means the target state may already hold.
	 */
	send<Result>(
		request: () => Promise<Result>,
		recoverable?: (error: unknown) => boolean,
	): Promise<Result>;
	/** Frees a reservation whose command sent nothing, such as a failed verification-only retry. */
	release(): Promise<void>;
	/** Persists provider-confirmed facts on the pending command for later verification. */
	recordEvidence(evidence: CommandEvidence): Promise<void>;
	/**
	 * Completes the command in the same versioned write as its order change and resolves to its saved
	 * response, which is another worker's when that worker completed the command first.
	 */
	settle<Response extends object>(
		settlement: (order: OrderRecord) => Settlement<Response>,
	): Promise<Response>;
	/** Like `settle`, but a null settlement leaves the command untouched and resolves to undefined. */
	settleIf<Response extends object>(
		settlement: (order: OrderRecord) => Settlement<Response> | null,
	): Promise<Response | undefined>;
}

/**
 * Runs a durable money command: one reservation per reference and input, a saved result replayed on
 * retry, and no provider request while any command on the order is unresolved.
 */
export async function runMoneyCommand<Response, Checked = undefined>(
	ctx: GenericEndpointContext,
	spec: MoneyCommandSpec<Checked> & {
		/** Maps the result saved by an earlier completed attempt to this request's response. */
		replay: (saved: Record<string, unknown>) => Response;
	},
	execute: (command: MoneyCommand<Checked>) => Promise<Response>,
): Promise<Response> {
	const reserved = await reserve(ctx, spec);
	if (reserved.kind === "completed") return spec.replay(reserved.result);
	const { reservation } = reserved;
	let sent = false;
	const settleIf = async <Settled extends object>(
		settlement: (order: OrderRecord) => Settlement<Settled> | null,
	): Promise<Settled | undefined> => {
		let response: Settled | undefined;
		await mutateOrder<OrderRecord>(ctx, spec.where, (order) => {
			const journal = readJournal(order.moneyCommands);
			const existing = journal.find((entry) => entry.key === reservation.key);
			if (existing?.state === "completed") {
				if (existing.hash !== reservation.hash)
					conflict("Money command reference was reused with different input");
				// Another worker completed this command first; its saved result is the only answer.
				response = existing.result as Settled;
				return null;
			}
			const settled = settlement(order);
			response = settled?.response;
			if (!settled) return null;
			return {
				updatedAt: new Date(),
				...settled.patch,
				moneyCommands: completeEntry(journal, reservation, settled.response),
			};
		});
		return response;
	};
	return execute({
		state: reserved.kind,
		reference: spec.reference,
		baseline: reservation.before,
		checked: reserved.checked,
		evidence: reservation.evidence,
		async send(request, recoverable) {
			if (reserved.kind === "pending" || sent)
				throw new Error("bnpl: a command whose outcome is uncertain must be verified, not resent");
			sent = true;
			try {
				return await request();
			} catch (error) {
				if (isDefinitiveRejection(error) && !recoverable?.(error))
					await release(ctx, spec.where, reservation);
				throw error;
			}
		},
		async release() {
			if (reserved.kind === "reserved" && !sent) await release(ctx, spec.where, reservation);
		},
		async recordEvidence(evidence) {
			await mutateOrder<OrderRecord>(ctx, spec.where, (order) => {
				const journal = readJournal(order.moneyCommands);
				const index = journal.findIndex((entry) => entry.key === reservation.key);
				const existing = journal[index];
				if (
					!existing ||
					existing.state !== "pending" ||
					existing.hash !== reservation.hash ||
					existing.token !== reservation.token
				)
					throw new Error("bnpl: money command ownership changed");
				journal[index] = { ...existing, evidence: { ...existing.evidence, ...evidence } };
				return { moneyCommands: JSON.stringify(journal), updatedAt: new Date() };
			});
			reservation.evidence = { ...reservation.evidence, ...evidence };
		},
		settleIf,
		async settle(settlement) {
			const response = await settleIf(settlement);
			if (response === undefined)
				throw new Error("bnpl: money command settlement produced no response");
			return response;
		},
	});
}

/**
 * Completes a pending capture or refund from native history, never by resending it. The outcome is
 * accepted only when the operations native history gained since reservation prove the request.
 */
export async function settlePendingMoneyOperation<Kind extends "captured" | "refunded">(
	ctx: GenericEndpointContext,
	command: MoneyCommand<unknown>,
	provider: BnplProvider,
	order: OrderRecord,
	kind: Kind,
	amountMinor: number,
): Promise<Kind extends "captured" ? BnplCaptureResult : BnplRefundResult> {
	if (!command.baseline)
		conflict("Money command outcome is uncertain; reconcile before issuing another command");
	const remote = await provider.fetchOrder(order.providerOrderId, { logger: ctx.context.logger });
	const operations = attributePendingOperations(
		provider,
		order,
		command.baseline,
		remote,
		kind,
		amountMinor,
		command.reference,
	);
	const [first] = operations ?? [];
	if (!operations || !first)
		conflict("Money command outcome is not uniquely proven by native history; verify it upstream");
	const common = { providerOrderId: order.providerOrderId, amountMinor, raw: null };
	const result =
		kind === "captured"
			? { ...common, captureId: first.id }
			: { ...common, refundId: first.id, operations };
	const settled = await command.settle((latest) => ({
		response: result,
		patch: applyMoneyOperations(latest, provider, kind, operations) ?? undefined,
	}));
	return settled as Kind extends "captured" ? BnplCaptureResult : BnplRefundResult;
}

function reportsAlready(states: readonly string[]) {
	return (error: unknown): boolean =>
		error instanceof BnplProviderError && error.reportsAlready(states);
}
export const reportsAlreadyClosed = reportsAlready(["closed"]);
export const reportsAlreadyCanceled = reportsAlready(["canceled", "cancelled"]);
const reportsAlreadyAuthorised = reportsAlready(["authorised", "authorized"]);

/** The provider refused to authorise because the order already is, or has moved past that. */
export function reportsAuthorisedState(error: unknown): boolean {
	return (
		reportsAlreadyAuthorised(error) ||
		(error instanceof BnplProviderError &&
			error.conflictingState !== undefined &&
			isAuthorisedState(error.conflictingState))
	);
}

/** Whether a verified provider snapshot proves the order was authorised, judged by its balances. */
export function remoteShowsAuthorisation(remote: BnplOrderState): boolean {
	return isAuthorisedState(
		statusFromBalances(remote.status, {
			amountMinor: parseAmount(remote.totalAmount),
			captured: remote.capturedAmountMinor,
			refunded: remote.refundedAmountMinor,
			canceled: remote.canceledAmountMinor ?? 0,
		}),
	);
}

/** The reference automatic capture uses: stable for one remaining balance, distinct once it changes. */
export function automaticCaptureReference(order: OrderRecord, amountMinor: number): string {
	return `${automaticCapturePrefix(order)}${(order.capturedAmountMinor ?? 0) + amountMinor}`;
}

function automaticCapturePrefix(order: OrderRecord): string {
	return `bnpl:${order.provider}:${order.providerOrderId}:capture:`;
}

/**
 * Completes automatic captures left pending by a lost response, from native history. A capture that a
 * notification already recorded would otherwise block the order once nothing remains to capture.
 */
export async function settleLostAutomaticCaptures(
	ctx: GenericEndpointContext,
	provider: BnplProvider,
	order: OrderRecord,
	where: OrderWhere,
): Promise<boolean> {
	const prefix = automaticCapturePrefix(order);
	let settled = false;
	for (const entry of readJournal(order.moneyCommands)) {
		const [operation, reference] = JSON.parse(entry.key) as [string, string];
		if (
			entry.state !== "pending" ||
			!entry.before ||
			operation !== "capture" ||
			!reference.startsWith(prefix)
		)
			continue;
		const amountMinor = Number(reference.slice(prefix.length)) - entry.before.capturedAmountMinor;
		try {
			await runMoneyCommand<object>(
				ctx,
				{
					where,
					operation: "capture",
					reference,
					input: { amountMinor, currency: order.currency },
					onPending: "verify",
					replay: (saved) => saved,
				},
				(command) =>
					settlePendingMoneyOperation(ctx, command, provider, order, "captured", amountMinor),
			);
			settled = true;
		} catch (error) {
			ctx.context.logger.warn(
				`bnpl: automatic capture ${reference} remains unresolved: ${error instanceof Error ? error.message : error}`,
			);
		}
	}
	return settled;
}

function readJournal(value?: string | null): JournalEntry[] {
	if (!value) return [];
	const parsed: unknown = JSON.parse(value);
	if (
		!Array.isArray(parsed) ||
		parsed.some(
			(entry) =>
				!entry ||
				typeof entry.key !== "string" ||
				typeof entry.hash !== "string" ||
				(entry.token !== undefined && typeof entry.token !== "string") ||
				(entry.before !== undefined &&
					(!entry.before ||
						["capturedAmountMinor", "refundedAmountMinor", "canceledAmountMinor"].some(
							(field) => !Number.isSafeInteger(entry.before[field]) || entry.before[field] < 0,
						) ||
						(entry.before.appliedOperations != null &&
							typeof entry.before.appliedOperations !== "string"))) ||
				(entry.evidence !== undefined &&
					(!entry.evidence ||
						typeof entry.evidence !== "object" ||
						Array.isArray(entry.evidence) ||
						Object.values(entry.evidence).some((value) => !Number.isSafeInteger(value)))) ||
				(entry.state !== "pending" && entry.state !== "completed") ||
				(entry.state === "completed" &&
					(!entry.result || typeof entry.result !== "object" || Array.isArray(entry.result))),
		)
	)
		throw new Error("bnpl: invalid money command journal");
	if (new Set(parsed.map((entry) => entry.key)).size !== parsed.length)
		throw new Error("bnpl: duplicate money commands");
	return parsed;
}

function conflict(message: string): never {
	throw new APIError("CONFLICT", { message, code: "MONEY_COMMAND_CONFLICT" });
}

type Reserved<Checked> =
	| { kind: "reserved" | "pending"; reservation: Reservation; checked?: Checked }
	| { kind: "completed"; result: Record<string, unknown> };

async function reserve<Checked>(
	ctx: GenericEndpointContext,
	spec: MoneyCommandSpec<Checked>,
): Promise<Reserved<Checked>> {
	const key = JSON.stringify([spec.operation, spec.reference]);
	const hash = commandInputHash(spec.input);
	const token = crypto.randomUUID();
	let reserved: Reserved<Checked> = { kind: "reserved", reservation: { key, hash, token } };
	await mutateOrder<OrderRecord>(ctx, spec.where, (order) => {
		const journal = readJournal(order.moneyCommands);
		const existing = journal.find((entry) => entry.key === key);
		if (existing) {
			if (existing.hash !== hash)
				conflict("Money command reference was already used with different input");
			if (existing.state === "completed") {
				reserved = { kind: "completed", result: existing.result };
				return null;
			}
			if (spec.onPending === "conflict")
				conflict("Money command outcome is uncertain; reconcile before issuing another command");
			reserved = {
				kind: "pending",
				reservation: {
					key,
					hash,
					token: existing.token,
					before: existing.before,
					evidence: existing.evidence,
				},
			};
			return null;
		}
		if (journal.some((entry) => entry.state === "pending"))
			conflict("Another order operation is uncertain; verify it before issuing a new command");
		const checked = spec.check?.(order);
		const before = spec.recordBaseline
			? {
					capturedAmountMinor: order.capturedAmountMinor ?? 0,
					refundedAmountMinor: order.refundedAmountMinor ?? 0,
					canceledAmountMinor: order.canceledAmountMinor ?? 0,
					appliedOperations: order.appliedOperations,
				}
			: undefined;
		reserved = { kind: "reserved", reservation: { key, hash, token, before }, checked };
		return {
			moneyCommands: JSON.stringify([...journal, { key, hash, token, before, state: "pending" }]),
			updatedAt: new Date(),
		};
	});
	return reserved;
}

function completeEntry(journal: JournalEntry[], reservation: Reservation, result: object): string {
	const index = journal.findIndex((entry) => entry.key === reservation.key);
	const existing = journal[index];
	if (!existing || existing.hash !== reservation.hash || existing.state !== "pending")
		throw new Error("bnpl: money command reservation changed");
	if (existing.token !== reservation.token)
		throw new Error("bnpl: money command ownership changed");
	journal[index] = {
		key: reservation.key,
		hash: reservation.hash,
		state: "completed",
		result: result as Record<string, unknown>,
	};
	return JSON.stringify(journal);
}

async function release(
	ctx: GenericEndpointContext,
	where: OrderWhere,
	reservation: Reservation,
): Promise<void> {
	try {
		await mutateOrder<OrderRecord>(ctx, where, (order) => {
			const journal = readJournal(order.moneyCommands);
			const index = journal.findIndex((entry) => entry.key === reservation.key);
			const existing = journal[index];
			if (
				!existing ||
				existing.state !== "pending" ||
				existing.hash !== reservation.hash ||
				existing.token !== reservation.token
			)
				return null;
			journal.splice(index, 1);
			return { moneyCommands: JSON.stringify(journal), updatedAt: new Date() };
		});
	} catch (error) {
		ctx.context.logger.error(
			`bnpl: could not release rejected command ${reservation.key}: ${error instanceof Error ? error.message : error}`,
		);
	}
}
