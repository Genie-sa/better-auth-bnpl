import type { BnplAuthorizeResult } from "../core/types";
interface AuthoriseOrderSnapshot {
	amountMinor?: number;
	capturedAmountMinor: number;
}
interface AuthoriseOrderUpdate {
	status: BnplAuthorizeResult["status"];
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
	const capturedAmountMinor =
		result.capturedAmountMinor ??
		(result.autoCaptured || result.status === "fully_captured" ? snapshot.amountMinor : undefined);
	const now = new Date();
	const update: AuthoriseOrderUpdate = {
		status: result.status,
		authorisedAt: now,
		rawData: JSON.stringify(result.raw),
		updatedAt: now,
	};
	if (capturedAmountMinor !== undefined) {
		update.capturedAt = now;
		update.capturedAmountMinor = Math.max(snapshot.capturedAmountMinor, capturedAmountMinor);
	}
	return { update, capturedAmountMinor };
}
