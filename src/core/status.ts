export const CANONICAL_STATUSES = [
	"new",
	"approved",
	"authorised",
	"declined",
	"expired",
	"canceled",
	"updated",
	"partially_captured",
	"fully_captured",
	"partially_refunded",
	"fully_refunded",
	"closed",
] as const;
export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];
export const isCanonicalStatus = (s: string): s is CanonicalStatus => {
	for (const status of CANONICAL_STATUSES) {
		if (status === s) return true;
	}
	return false;
};
export const APPROVED_STATUSES: ReadonlySet<CanonicalStatus> = new Set(["approved", "authorised"]);
/**
 * Statuses conventionally treated as final for the order lifecycle. They are not all sinks:
 * `fully_refunded` describes the captured portion, so any remaining authorisation can still be
 * captured, and `fully_refunded` and `closed` can still receive refunds.
 */
export const TERMINAL_STATUSES: ReadonlySet<CanonicalStatus> = new Set([
	"declined",
	"expired",
	"canceled",
	"fully_refunded",
	"closed",
]);
export interface PartialFullDerivationContext {
	totalAmountMinor: number | null;
	cumulativeMinor?: number | null;
}
export function deriveCapturedStatus(ctx: PartialFullDerivationContext): CanonicalStatus {
	if (ctx.totalAmountMinor == null || ctx.cumulativeMinor == null) {
		return "partially_captured";
	}
	return ctx.cumulativeMinor >= ctx.totalAmountMinor ? "fully_captured" : "partially_captured";
}
export function deriveRefundedStatus(ctx: PartialFullDerivationContext): CanonicalStatus {
	if (ctx.totalAmountMinor == null || ctx.cumulativeMinor == null) {
		return "partially_refunded";
	}
	return ctx.cumulativeMinor >= ctx.totalAmountMinor ? "fully_refunded" : "partially_refunded";
}
export interface OrderBalances {
	amountMinor: number;
	captured: number;
	refunded: number;
	canceled: number;
}
/** Status implied by a provider's native status once verified balances are applied. */
export function statusFromBalances(
	native: CanonicalStatus,
	balances: OrderBalances,
): CanonicalStatus {
	if (balances.refunded > 0)
		return deriveRefundedStatus({
			totalAmountMinor:
				balances.captured > 0 ? balances.captured : balances.amountMinor - balances.canceled,
			cumulativeMinor: balances.refunded,
		});
	if (native === "closed") return native;
	if (balances.captured > 0)
		return deriveCapturedStatus({
			totalAmountMinor: balances.amountMinor - balances.canceled,
			cumulativeMinor: balances.captured,
		});
	return native === "updated" ? "authorised" : native;
}
const STATUS_TRANSITIONS: Readonly<Record<CanonicalStatus, ReadonlySet<CanonicalStatus>>> = {
	new: new Set([
		"approved",
		"authorised",
		"declined",
		"expired",
		"canceled",
		"partially_captured",
		"fully_captured",
		"partially_refunded",
		"fully_refunded",
		"closed",
	]),
	approved: new Set([
		"authorised",
		"declined",
		"expired",
		"canceled",
		"partially_captured",
		"fully_captured",
		"partially_refunded",
		"fully_refunded",
		"closed",
	]),
	authorised: new Set([
		"expired",
		"canceled",
		"partially_captured",
		"fully_captured",
		"partially_refunded",
		"fully_refunded",
		"closed",
	]),
	partially_captured: new Set([
		"fully_captured",
		"partially_refunded",
		"fully_refunded",
		"canceled",
		"closed",
	]),
	fully_captured: new Set(["partially_refunded", "fully_refunded", "closed"]),
	partially_refunded: new Set(["fully_refunded", "closed"]),
	declined: new Set(),
	expired: new Set(),
	canceled: new Set(),
	fully_refunded: new Set(["partially_refunded"]),
	closed: new Set(["partially_refunded", "fully_refunded"]),
	updated: new Set(),
};
export function canTransition(
	from: CanonicalStatus | string,
	to: CanonicalStatus | string,
): boolean {
	if (from === to) return true;
	if (!isCanonicalStatus(to)) return false;
	if (!isCanonicalStatus(from)) return true;
	return STATUS_TRANSITIONS[from].has(to);
}
