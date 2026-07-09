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
const STATUS_TRANSITIONS: Readonly<Record<CanonicalStatus, ReadonlySet<CanonicalStatus>>> = {
	new: new Set([
		"approved",
		"authorised",
		"declined",
		"expired",
		"canceled",
		"partially_captured",
		"fully_captured",
	]),
	approved: new Set([
		"authorised",
		"declined",
		"expired",
		"canceled",
		"partially_captured",
		"fully_captured",
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
	fully_refunded: new Set(),
	closed: new Set(),
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
