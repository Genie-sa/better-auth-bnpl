import { type CanonicalStatus, canTransition, deriveCapturedStatus } from "../core/status";
import type { BnplAuthorizeResult } from "../core/types";
interface AuthoriseOrderSnapshot {
	currency?: string;
	amountMinor?: number;
	canceledAmountMinor?: number;
	status?: CanonicalStatus | string;
	capturedAmountMinor: number;
}
interface AuthoriseOrderUpdate {
	status: CanonicalStatus | string;
	authorisedAt: Date;
	rawData: string;
	updatedAt: Date;
	capturedAt?: Date;
	capturedAmountMinor?: number;
}
export interface AuthoriseOrderUpdateResult {
	update: AuthoriseOrderUpdate;
	capturedAmountMinor?: number;
}
export function buildAuthoriseOrderUpdate(
	result: BnplAuthorizeResult,
	snapshot: AuthoriseOrderSnapshot,
): AuthoriseOrderUpdateResult {
	if (
		result.capturedCurrency !== undefined &&
		snapshot.currency !== undefined &&
		result.capturedCurrency !== snapshot.currency
	)
		throw new Error("bnpl: authorised capture currency differs from the order currency");
	const capturedAmountMinor =
		result.capturedAmountMinor ??
		(result.autoCaptured || result.status === "fully_captured"
			? snapshot.amountMinor === undefined
				? undefined
				: snapshot.amountMinor - (snapshot.canceledAmountMinor ?? 0)
			: undefined);
	const now = new Date();
	const nextCapturedMinor = Math.max(snapshot.capturedAmountMinor, capturedAmountMinor ?? 0);
	const target =
		capturedAmountMinor !== undefined && nextCapturedMinor > 0 && snapshot.amountMinor !== undefined
			? deriveCapturedStatus({
					totalAmountMinor: snapshot.amountMinor - (snapshot.canceledAmountMinor ?? 0),
					cumulativeMinor: nextCapturedMinor,
				})
			: result.status;
	const update: AuthoriseOrderUpdate = {
		status: snapshot.status && !canTransition(snapshot.status, target) ? snapshot.status : target,
		authorisedAt: now,
		rawData: JSON.stringify(result.raw),
		updatedAt: now,
	};
	if (capturedAmountMinor !== undefined) {
		if (capturedAmountMinor > 0) update.capturedAt = now;
		update.capturedAmountMinor = Math.max(snapshot.capturedAmountMinor, capturedAmountMinor);
	}
	return { update, capturedAmountMinor };
}
