import type { Where } from "better-auth";
import { type LedgerOperation, ledgerKey } from "../core/ledger";
import { type BnplCurrency, isBnplCurrency, parseAmount } from "../core/money";
import type { BnplProvider } from "../core/provider";
import {
	type CanonicalStatus,
	canTransition,
	deriveCapturedStatus,
	deriveRefundedStatus,
	statusFromBalances,
} from "../core/status";
import type { BnplAuthorizeResult, BnplMoneyOperation, BnplOrderState } from "../core/types";
import { readAppliedOperations } from "./order-store";

/** The persisted `bnplOrder` columns that carry money, status and their journals. */
export interface OrderRecord {
	id?: string;
	provider: string;
	providerOrderId: string;
	providerCheckoutId?: string | null;
	status: string;
	currency: string;
	amountMinor: number;
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	canceledAmountMinor?: number | null;
	authorisedAt?: Date | null;
	canceledAt?: Date | null;
	version?: number | null;
	appliedOperations?: string | null;
	webhookTransitions?: string | null;
	moneyCommands?: string | null;
	rawData?: string | null;
}

type MoneyKind = Extract<LedgerOperation["kind"], "captured" | "refunded">;

interface Balances {
	total: number;
	captured: number;
	refunded: number;
	canceled: number;
}

/** Statuses after which the provider holds no open, uncaptured balance for the order. */
const SETTLED_STATUSES: ReadonlySet<string> = new Set([
	"closed",
	"canceled",
	"fully_captured",
	"partially_refunded",
	"fully_refunded",
]);

export function orderWhere(provider: string, providerOrderId: string): Where[] {
	return [
		{ field: "provider", value: provider },
		{ field: "providerOrderId", value: providerOrderId },
	];
}

function balances(order: OrderRecord): Balances {
	return {
		total: order.amountMinor,
		captured: order.capturedAmountMinor ?? 0,
		refunded: order.refundedAmountMinor ?? 0,
		canceled: order.canceledAmountMinor ?? 0,
	};
}

function persistedCurrency(order: OrderRecord): BnplCurrency {
	if (!isBnplCurrency(order.currency)) throw new Error("bnpl: invalid persisted currency");
	return order.currency;
}

export function capturableMinor(order: OrderRecord): number {
	const { total, captured, canceled } = balances(order);
	return total - canceled - captured;
}

export function refundableMinor(order: OrderRecord): number {
	const { captured, refunded } = balances(order);
	return captured - refunded;
}

export function isSettled(status: string): boolean {
	return SETTLED_STATUSES.has(status);
}

const NO_CAPTURE_STATUSES: ReadonlySet<string> = new Set([
	"closed",
	"canceled",
	"expired",
	"declined",
]);

/** A fully refunded partial capture still accepts a capture of its remaining authorisation. */
export function acceptsCaptures(status: string): boolean {
	return !NO_CAPTURE_STATUSES.has(status);
}

/** True when the provider holds no uncaptured balance that a close could still release. */
export function hasNothingLeftToClose(order: OrderRecord): boolean {
	if (order.status === "closed" || order.status === "canceled") return true;
	const { total, captured, canceled } = balances(order);
	return (
		["fully_captured", "partially_refunded", "fully_refunded"].includes(order.status) &&
		captured + canceled >= total
	);
}

export function nextStatus(current: string, candidate: string): string {
	return canTransition(current, candidate) ? candidate : current;
}

function ledgerStatus(order: OrderRecord, captured: number, refunded: number): CanonicalStatus {
	const { total, canceled } = balances(order);
	if (refunded > 0)
		return deriveRefundedStatus({
			totalAmountMinor: captured > 0 ? captured : total - canceled,
			cumulativeMinor: refunded,
		});
	return deriveCapturedStatus({ totalAmountMinor: total - canceled, cumulativeMinor: captured });
}

export interface MoneyMovement {
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	status: CanonicalStatus;
}

function moveMoney(
	order: OrderRecord,
	kind: MoneyKind,
	amountMinor: number,
	refundsMayLeadCaptures: boolean,
): MoneyMovement {
	if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
		throw new Error("bnpl: operation amount must be a positive safe integer");
	const { total, captured, refunded, canceled } = balances(order);
	const nextCaptured = captured + (kind === "captured" ? amountMinor : 0);
	const nextRefunded = refunded + (kind === "refunded" ? amountMinor : 0);
	if (
		!Number.isSafeInteger(nextCaptured) ||
		!Number.isSafeInteger(nextRefunded) ||
		nextCaptured + canceled > total ||
		nextRefunded > (refundsMayLeadCaptures ? total - canceled : nextCaptured)
	)
		throw new Error("bnpl: operation would exceed the order's financial balance");
	return {
		capturedAmountMinor: nextCaptured,
		refundedAmountMinor: nextRefunded,
		status: ledgerStatus(order, nextCaptured, nextRefunded),
	};
}

/** Balances after a capture or refund this plugin confirmed: a refund never exceeds captured money. */
export function addMoney(order: OrderRecord, kind: MoneyKind, amountMinor: number): MoneyMovement {
	return moveMoney(order, kind, amountMinor, false);
}

/**
 * Balances after a provider notification. Deliveries arrive in any order, so a refund may precede the
 * capture it refunds; both stay within the uncanceled order total and converge once all arrive.
 */
export function addObservedMoney(
	order: OrderRecord,
	kind: MoneyKind,
	amountMinor: number,
): MoneyMovement {
	return moveMoney(order, kind, amountMinor, true);
}

export type MoneyOperationPatch = {
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	status: string;
	appliedOperations: string;
	capturedAt?: Date;
};

/** Records a provider-confirmed capture or refund once; null when the ledger already holds it. */
export function applyMoneyOperation(
	order: OrderRecord,
	provider: BnplProvider,
	operation: { kind: MoneyKind; id: string; amountMinor: number },
): MoneyOperationPatch | null {
	const key = ledgerKey(provider, {
		...operation,
		orderId: order.providerOrderId,
		currency: persistedCurrency(order),
	});
	const keys = readAppliedOperations(order.appliedOperations);
	if (keys.includes(key)) return null;
	const moved = addMoney(order, operation.kind, operation.amountMinor);
	return {
		capturedAmountMinor: moved.capturedAmountMinor,
		refundedAmountMinor: moved.refundedAmountMinor,
		status: nextStatus(order.status, moved.status),
		appliedOperations: JSON.stringify([...keys, key]),
		...(operation.kind === "captured" ? { capturedAt: new Date() } : {}),
	};
}

/** Records several confirmed operations of one kind once each; null when the ledger holds them all. */
export function applyMoneyOperations(
	order: OrderRecord,
	provider: BnplProvider,
	kind: MoneyKind,
	operations: readonly { id: string; amountMinor: number }[],
): MoneyOperationPatch | null {
	let current = order;
	let patch: MoneyOperationPatch | null = null;
	for (const operation of operations) {
		const applied = applyMoneyOperation(current, provider, { kind, ...operation });
		if (!applied) continue;
		patch = { ...(patch ?? {}), ...applied };
		current = { ...current, ...applied };
	}
	return patch;
}

/** Records a confirmed partial or full cancellation once; null when the ledger already holds it. */
export function applyCancellation(
	order: OrderRecord,
	provider: BnplProvider,
	cancelId: string,
	amountMinor: number,
): { canceledAmountMinor: number; appliedOperations: string } | null {
	const key = cancellationKey(provider, order, cancelId);
	const keys = readAppliedOperations(order.appliedOperations);
	if (keys.includes(key)) return null;
	const { total, captured, canceled } = balances(order);
	const nextCanceled = canceled + amountMinor;
	if (!Number.isSafeInteger(nextCanceled) || nextCanceled + captured > total)
		throw new Error("bnpl: cancellation exceeds the remaining order balance");
	return { canceledAmountMinor: nextCanceled, appliedOperations: JSON.stringify([...keys, key]) };
}

export function cancellationKey(
	provider: BnplProvider,
	order: OrderRecord,
	cancelId: string,
): string {
	return ledgerKey(provider, {
		kind: "canceled",
		id: cancelId,
		orderId: order.providerOrderId,
		amountMinor: 0,
		currency: persistedCurrency(order),
	});
}

export interface AuthorisationPatch {
	patch: Record<string, unknown>;
	capturedAmountMinor?: number;
}

/** Applies a direct authorisation response, including any capture the provider performed with it. */
export function applyAuthorisation(
	order: OrderRecord,
	provider: BnplProvider,
	result: BnplAuthorizeResult,
): AuthorisationPatch {
	if (result.capturedCurrency !== undefined && result.capturedCurrency !== order.currency)
		throw new Error("bnpl: authorised capture currency differs from the order currency");
	const { total, captured, canceled } = balances(order);
	const capturedAmountMinor =
		result.capturedAmountMinor ??
		(result.autoCaptured || result.status === "fully_captured" ? total - canceled : undefined);
	if (
		capturedAmountMinor !== undefined &&
		(!Number.isSafeInteger(capturedAmountMinor) ||
			capturedAmountMinor < 0 ||
			capturedAmountMinor > total - canceled)
	)
		throw new Error("bnpl: invalid authorised capture amount");
	const keys = readAppliedOperations(order.appliedOperations);
	if (result.captureId && capturedAmountMinor !== undefined)
		keys.push(
			ledgerKey(provider, {
				kind: "captured",
				id: result.captureId,
				orderId: order.providerOrderId,
				amountMinor: capturedAmountMinor,
				currency: persistedCurrency(order),
			}),
		);
	const nextCaptured = Math.max(captured, capturedAmountMinor ?? 0);
	const candidate =
		capturedAmountMinor !== undefined && nextCaptured > 0
			? deriveCapturedStatus({ totalAmountMinor: total - canceled, cumulativeMinor: nextCaptured })
			: result.status;
	const now = new Date();
	return {
		capturedAmountMinor,
		patch: {
			status: nextStatus(order.status, candidate),
			authorisedAt: now,
			rawData: JSON.stringify(result.raw),
			updatedAt: now,
			...(capturedAmountMinor !== undefined
				? {
						capturedAmountMinor: nextCaptured,
						...(capturedAmountMinor > 0 ? { capturedAt: now } : {}),
					}
				: {}),
			appliedOperations: JSON.stringify([...new Set(keys)]),
		},
	};
}

/** True when a snapshot reports less money than the order already records locally. */
export function snapshotIsBehind(order: OrderRecord, remote: BnplOrderState): boolean {
	const { captured, refunded, canceled } = balances(order);
	return (
		remote.capturedAmountMinor < captured ||
		remote.refundedAmountMinor < refunded ||
		(remote.canceledAmountMinor ?? canceled) < canceled
	);
}

export interface RemoteHistory {
	captured: number;
	refunded: number;
	canceled: number;
	keys: string[];
}

/** Verifies complete native history before importing balances; never lowers newer local money. */
export function readRemoteHistory(
	provider: BnplProvider,
	order: OrderRecord,
	remote: BnplOrderState,
): RemoteHistory {
	const local = balances(order);
	const totals = {
		captured: remote.capturedAmountMinor,
		refunded: remote.refundedAmountMinor,
		canceled: remote.canceledAmountMinor ?? 0,
	};
	if (
		remote.providerOrderId !== order.providerOrderId ||
		remote.totalAmount.currency !== order.currency ||
		parseAmount(remote.totalAmount) !== order.amountMinor ||
		Object.values(totals).some((value) => !Number.isSafeInteger(value) || value < 0) ||
		totals.captured + totals.canceled > order.amountMinor ||
		totals.refunded > totals.captured
	)
		throw new Error("bnpl: invalid remote financial snapshot");
	const localKeys = readAppliedOperations(order.appliedOperations);
	const keys = new Set(localKeys);
	const seen = new Set<string>();
	const sums = { captured: 0, refunded: 0, canceled: 0 };
	for (const operation of remote.operations ?? []) {
		if (
			!operation.id ||
			operation.currency !== order.currency ||
			!Number.isSafeInteger(operation.amountMinor) ||
			operation.amountMinor <= 0 ||
			!["captured", "refunded", "canceled"].includes(operation.kind)
		)
			throw new Error("bnpl: invalid remote operation");
		const key = ledgerKey(provider, { ...operation, orderId: order.providerOrderId });
		if (seen.has(key)) throw new Error("bnpl: duplicate remote operation");
		seen.add(key);
		keys.add(key);
		sums[operation.kind] += operation.amountMinor;
	}
	const increases =
		totals.captured > local.captured ||
		totals.refunded > local.refunded ||
		totals.canceled > local.canceled;
	if (
		(increases && !remote.operations) ||
		(remote.operations &&
			(localKeys.some((key) => !key.startsWith("delivery:") && !seen.has(key)) ||
				sums.captured !== totals.captured ||
				sums.refunded !== totals.refunded ||
				sums.canceled !== totals.canceled))
	)
		throw new Error("bnpl: recovery requires complete native operation history");
	const captured = Math.max(local.captured, totals.captured);
	const refunded = Math.max(local.refunded, totals.refunded);
	const canceled = Math.max(local.canceled, totals.canceled);
	if (captured + canceled > order.amountMinor || refunded > captured)
		throw new Error("bnpl: recovery would exceed the order's financial balance");
	return { captured, refunded, canceled, keys: [...keys] };
}

export type SnapshotImport = {
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	canceledAmountMinor: number;
	appliedOperations: string;
	status: string;
};

/** Imports a verified snapshot: merged balances, its ledger keys, and the status they imply. */
export function importSnapshot(
	order: OrderRecord,
	provider: BnplProvider,
	remote: BnplOrderState,
): SnapshotImport {
	const history = readRemoteHistory(provider, order, remote);
	const candidate = statusFromBalances(remote.status, {
		amountMinor: order.amountMinor,
		captured: history.captured,
		refunded: history.refunded,
		canceled: history.canceled,
	});
	return {
		capturedAmountMinor: history.captured,
		refundedAmountMinor: history.refunded,
		canceledAmountMinor: history.canceled,
		appliedOperations: JSON.stringify(history.keys),
		status: nextStatus(order.status, candidate),
	};
}

/** Balances recorded when a command was reserved, to attribute the native operations it caused. */
export interface OrderBaseline {
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	canceledAmountMinor: number;
	appliedOperations?: string | null;
}

/**
 * The native operations a pending command produced, from what native history gained since the
 * command's baseline. A capture or cancellation is exactly one new operation of the requested
 * amount; a refund may be split per capture, so every new refund together must equal it. Null
 * when that is not proven.
 */
export function attributePendingOperations(
	provider: BnplProvider,
	order: OrderRecord,
	baseline: OrderBaseline,
	remote: BnplOrderState,
	kind: BnplMoneyOperation["kind"],
	amountMinor: number,
	reference?: string,
): BnplMoneyOperation[] | null {
	readRemoteHistory(provider, { ...order, ...baseline }, remote);
	const prior = new Set(readAppliedOperations(baseline.appliedOperations));
	const unseen = (remote.operations ?? []).filter(
		(operation) =>
			operation.kind === kind &&
			!prior.has(ledgerKey(provider, { ...operation, orderId: order.providerOrderId })),
	);
	const referenced =
		reference !== undefined &&
		(provider.capabilities.operationReferences === true ||
			unseen.some((operation) => operation.reference !== undefined));
	const candidates = referenced
		? unseen.filter((operation) => operation.reference === reference)
		: unseen;
	const expected = {
		captured: baseline.capturedAmountMinor,
		refunded: baseline.refundedAmountMinor,
		canceled: baseline.canceledAmountMinor,
	};
	expected[kind] += amountMinor;
	const onlyThisChanged =
		remote.capturedAmountMinor === expected.captured &&
		remote.refundedAmountMinor === expected.refunded &&
		(remote.canceledAmountMinor ?? 0) === expected.canceled;
	const total = candidates.reduce((sum, operation) => sum + operation.amountMinor, 0);
	const proven =
		(referenced || onlyThisChanged) &&
		total === amountMinor &&
		(kind === "refunded" ? candidates.length > 0 : candidates.length === 1);
	return proven ? candidates : null;
}
