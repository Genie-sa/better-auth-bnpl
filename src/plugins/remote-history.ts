import { parseAmount } from "../core/money";
import type { BnplProvider } from "../core/provider";
import type { BnplOrderState, BnplWebhookEvent } from "../core/types";
import { readAppliedOperations } from "./order-store";

interface FinancialOrder {
	providerOrderId: string;
	currency: string;
	amountMinor: number;
	capturedAmountMinor: number;
	refundedAmountMinor?: number;
	canceledAmountMinor?: number;
	appliedOperations?: string | null;
}

/** Verify complete native history before importing balances; preserve newer local money. */
export function readRemoteHistory(
	provider: BnplProvider,
	row: FinancialOrder,
	remote: BnplOrderState,
) {
	const totals = {
		captured: remote.capturedAmountMinor,
		refunded: remote.refundedAmountMinor,
		canceled: remote.canceledAmountMinor ?? 0,
	};
	if (
		remote.providerOrderId !== row.providerOrderId ||
		remote.totalAmount.currency !== row.currency ||
		parseAmount(remote.totalAmount) !== row.amountMinor ||
		Object.values(totals).some((value) => !Number.isSafeInteger(value) || value < 0) ||
		totals.captured + totals.canceled > row.amountMinor ||
		totals.refunded > totals.captured
	)
		throw new Error("bnpl: invalid remote financial snapshot");
	const localKeys = readAppliedOperations(row.appliedOperations);
	const keys = new Set(localKeys);
	const seen = new Set<string>();
	const sums = { captured: 0, refunded: 0, canceled: 0 };
	for (const operation of remote.operations ?? []) {
		if (
			!operation.id ||
			operation.currency !== row.currency ||
			!Number.isSafeInteger(operation.amountMinor) ||
			operation.amountMinor <= 0 ||
			!["captured", "refunded", "canceled"].includes(operation.kind)
		)
			throw new Error("bnpl: invalid remote operation");
		let key: string;
		if (operation.kind === "canceled") key = `${provider.id}:cancel:${operation.id}`;
		else {
			const common = {
				provider: provider.id,
				orderId: row.providerOrderId,
				currency: operation.currency,
				amountMinor: operation.amountMinor,
				raw: null,
			};
			const event: BnplWebhookEvent =
				operation.kind === "captured"
					? { ...common, kind: "captured", captureId: operation.id }
					: { ...common, kind: "refunded", refundId: operation.id };
			key = provider.webhookDedupKey?.(event) ?? `${provider.id}:${operation.kind}:${operation.id}`;
		}
		if (seen.has(key)) throw new Error("bnpl: duplicate remote operation");
		seen.add(key);
		keys.add(key);
		sums[operation.kind] += operation.amountMinor;
	}
	const increases =
		totals.captured > row.capturedAmountMinor ||
		totals.refunded > (row.refundedAmountMinor ?? 0) ||
		totals.canceled > (row.canceledAmountMinor ?? 0);
	if (
		(increases && !remote.operations) ||
		(remote.operations &&
			(localKeys.some((key) => !key.startsWith("delivery:") && !seen.has(key)) ||
				sums.captured !== totals.captured ||
				sums.refunded !== totals.refunded ||
				sums.canceled !== totals.canceled))
	)
		throw new Error("bnpl: recovery requires complete native operation history");
	const captured = Math.max(row.capturedAmountMinor, totals.captured);
	const refunded = Math.max(row.refundedAmountMinor ?? 0, totals.refunded);
	const canceled = Math.max(row.canceledAmountMinor ?? 0, totals.canceled);
	if (captured + canceled > row.amountMinor || refunded > captured)
		throw new Error("bnpl: recovery would exceed the order's financial balance");
	return { captured, refunded, canceled, keys: [...keys] };
}
