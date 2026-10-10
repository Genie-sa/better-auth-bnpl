import type { GenericEndpointContext, Where } from "better-auth";
import { APIError } from "better-auth/api";
import { commandInputHash } from "./command-input";
import type { MoneyOperation } from "./operation-reference";
import { mutateOrder } from "./order-store";

export type JournalOperation = MoneyOperation | "authorise" | "cancel" | "void" | "close";
export interface CommandBefore {
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	canceledAmountMinor: number;
	appliedOperations?: string | null;
}

type Command =
	| { key: string; hash: string; token?: string; before?: CommandBefore; state: "pending" }
	| { key: string; hash: string; state: "completed"; result: Record<string, unknown> };
interface CommandOrder {
	id?: string;
	version?: number | null;
	moneyCommands?: string | null;
	capturedAmountMinor?: number;
	refundedAmountMinor?: number;
	canceledAmountMinor?: number;
	appliedOperations?: string | null;
}
export interface MoneyCommandReservation {
	key: string;
	hash: string;
	token?: string;
	before?: CommandBefore;
}
function readCommands(value?: string | null): Command[] {
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
export async function reserveMoneyCommand<Row extends CommandOrder = CommandOrder>(
	ctx: GenericEndpointContext,
	where: () => Where[],
	operation: JournalOperation,
	reference: string,
	body: unknown,
	validate?: (row: Row) => void,
	recoverPending = false,
): Promise<
	| { kind: "reserved"; command: MoneyCommandReservation }
	| { kind: "pending"; command: MoneyCommandReservation }
	| { kind: "completed"; result: Record<string, unknown> }
> {
	const key = JSON.stringify([operation, reference]);
	const hash = commandInputHash(body);
	const token = crypto.randomUUID();
	let result:
		| { kind: "reserved"; command: MoneyCommandReservation }
		| { kind: "pending"; command: MoneyCommandReservation }
		| { kind: "completed"; result: Record<string, unknown> } = {
		kind: "reserved",
		command: { key, hash, token },
	};
	await mutateOrder<Row>(ctx, where, (row) => {
		const commands = readCommands(row.moneyCommands);
		const existing = commands.find((command) => command.key === key);
		if (existing) {
			if (existing.hash !== hash)
				conflict("Money command reference was already used with different input");
			if (existing.state === "pending") {
				if (!recoverPending)
					conflict("Money command outcome is uncertain; reconcile before issuing another command");
				result = {
					kind: "pending",
					command: { key, hash, token: existing.token, before: existing.before },
				};
				return null;
			}
			result = { kind: "completed", result: existing.result };
			return null;
		}
		if (commands.some((command) => command.state === "pending"))
			conflict("Another order operation is uncertain; verify it before issuing a new command");
		validate?.(row);
		const before =
			operation === "cancel"
				? {
						capturedAmountMinor: row.capturedAmountMinor ?? 0,
						refundedAmountMinor: row.refundedAmountMinor ?? 0,
						canceledAmountMinor: row.canceledAmountMinor ?? 0,
						appliedOperations: row.appliedOperations,
					}
				: undefined;
		result = { kind: "reserved", command: { key, hash, token, before } };
		return {
			moneyCommands: JSON.stringify([...commands, { key, hash, token, before, state: "pending" }]),
			updatedAt: new Date(),
		};
	});
	return result;
}
export function completeMoneyCommand(
	value: string | null | undefined,
	reservation: MoneyCommandReservation,
	result: Record<string, unknown>,
): string {
	const commands = readCommands(value);
	const index = commands.findIndex((command) => command.key === reservation.key);
	const existing = commands[index];
	if (!existing || existing.hash !== reservation.hash)
		throw new Error("bnpl: money command reservation changed");
	if (existing.state === "completed") return JSON.stringify(commands);
	if (existing.token !== reservation.token)
		throw new Error("bnpl: money command ownership changed");
	commands[index] = { key: reservation.key, hash: reservation.hash, state: "completed", result };
	return JSON.stringify(commands);
}

export async function releaseRejectedMoneyCommand(
	ctx: GenericEndpointContext,
	where: () => Where[],
	reservation: MoneyCommandReservation,
): Promise<void> {
	await mutateOrder<CommandOrder>(ctx, where, (row) => {
		const commands = readCommands(row.moneyCommands);
		const index = commands.findIndex((command) => command.key === reservation.key);
		const existing = commands[index];
		if (
			!existing ||
			existing.state !== "pending" ||
			existing.hash !== reservation.hash ||
			existing.token !== reservation.token
		)
			return null;
		commands.splice(index, 1);
		return { moneyCommands: JSON.stringify(commands), updatedAt: new Date() };
	});
}

export function isAuthorisedState(status: string): boolean {
	return [
		"authorised",
		"partially_captured",
		"fully_captured",
		"partially_refunded",
		"fully_refunded",
		"closed",
	].includes(status);
}

export async function recoverLocalAuthoriseCommand<Row extends CommandOrder & { status: string }>(
	ctx: GenericEndpointContext,
	where: () => Where[],
	command: MoneyCommandReservation,
	orderId: string,
): Promise<Record<string, unknown> | undefined> {
	let result: Record<string, unknown> | undefined;
	await mutateOrder<Row>(ctx, where, (row) => {
		result = undefined;
		if (!isAuthorisedState(row.status)) return null;
		result = { orderId, status: row.status, already: true };
		return {
			moneyCommands: completeMoneyCommand(row.moneyCommands, command, result),
			updatedAt: new Date(),
		};
	});
	return result;
}
