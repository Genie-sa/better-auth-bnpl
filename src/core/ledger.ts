import type { BnplCurrency } from "./money";
import type { BnplProvider } from "./provider";
import type { BnplMoneyOperation, BnplWebhookEvent } from "./types";

export interface LedgerOperation {
	kind: BnplMoneyOperation["kind"];
	id: string;
	orderId: string;
	amountMinor: number;
	currency: BnplCurrency;
}

/**
 * The persisted identity of a native money operation. Webhook deliveries, admin commands and
 * snapshot imports all record operations under this key, so it must stay byte-stable across releases.
 */
export function ledgerKey(provider: BnplProvider, operation: LedgerOperation): string {
	if (operation.kind === "canceled") return `${provider.id}:cancel:${operation.id}`;
	const common = {
		provider: provider.id,
		orderId: operation.orderId,
		amountMinor: operation.amountMinor,
		currency: operation.currency,
		raw: null,
	};
	return ledgerKeyForEvent(
		provider,
		operation.kind === "captured"
			? { ...common, kind: "captured", captureId: operation.id }
			: { ...common, kind: "refunded", refundId: operation.id },
	);
}

export function ledgerKeyForEvent(
	provider: BnplProvider,
	event: Extract<BnplWebhookEvent, { kind: "captured" | "refunded" }>,
): string {
	return (
		provider.webhookDedupKey?.(event) ??
		`${provider.id}:${event.kind}:${event.kind === "captured" ? event.captureId : event.refundId}`
	);
}
