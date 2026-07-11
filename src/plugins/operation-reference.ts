export type MoneyOperation = "capture" | "refund";

export interface OperationReferenceOrder {
	provider: string;
	providerOrderId: string;
	capturedAmountMinor?: number | null;
	refundedAmountMinor?: number | null;
}

export function operationReference(
	row: OperationReferenceOrder,
	operation: MoneyOperation,
	amountMinor: number,
): string {
	const previousMinor =
		operation === "capture" ? (row.capturedAmountMinor ?? 0) : (row.refundedAmountMinor ?? 0);

	return `bnpl:${row.provider}:${row.providerOrderId}:${operation}:${previousMinor + amountMinor}`;
}
