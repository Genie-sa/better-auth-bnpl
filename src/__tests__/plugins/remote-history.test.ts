import { describe, expect, it } from "vitest";
import type { BnplMoneyOperation, BnplOrderState } from "../../core/types";
import { readRemoteHistory } from "../../plugins/remote-history";
import { stubProvider } from "../_harness";

const provider = stubProvider("tamara");
const base = {
	providerOrderId: "history-order",
	currency: "SAR",
	amountMinor: 10000,
	capturedAmountMinor: 0,
	refundedAmountMinor: 0,
	canceledAmountMinor: 0,
};
const capture: BnplMoneyOperation = {
	id: "capture-a",
	kind: "captured",
	amountMinor: 2000,
	currency: "SAR",
};

function snapshot(operations: BnplMoneyOperation[]): BnplOrderState {
	return {
		providerOrderId: base.providerOrderId,
		status: "partially_captured" as const,
		totalAmount: { amount: "100.00", currency: "SAR" },
		capturedAmountMinor: operations
			.filter((op) => op.kind === "captured")
			.reduce((sum, op) => sum + op.amountMinor, 0),
		refundedAmountMinor: operations
			.filter((op) => op.kind === "refunded")
			.reduce((sum, op) => sum + op.amountMinor, 0),
		canceledAmountMinor: operations
			.filter((op) => op.kind === "canceled")
			.reduce((sum, op) => sum + op.amountMinor, 0),
		operations,
		raw: {},
	};
}

describe("remote native history", () => {
	it.each(["captured", "refunded", "canceled"] as const)(
		"rejects a snapshot missing a locally committed %s identity even when remote totals are higher",
		(kind) => {
			const localKey = `tamara:${kind === "canceled" ? "cancel" : kind}:newer-local`;
			const row = {
				...base,
				capturedAmountMinor: kind === "captured" ? 1000 : 2000,
				refundedAmountMinor: kind === "refunded" ? 500 : 0,
				canceledAmountMinor: kind === "canceled" ? 500 : 0,
				appliedOperations: JSON.stringify([localKey]),
			};
			const operations: BnplMoneyOperation[] =
				kind === "captured"
					? [capture]
					: [
							capture,
							{
								id: "older-remote",
								kind,
								amountMinor: 1000,
								currency: "SAR",
							},
						];
			expect(() => readRemoteHistory(provider, row, snapshot(operations))).toThrow();
		},
	);
	it("accepts complete financial history without requiring webhook delivery markers upstream", () => {
		const row = {
			...base,
			capturedAmountMinor: 2000,
			appliedOperations: JSON.stringify([
				"tamara:captured:capture-a",
				"delivery:local-notification",
			]),
		};
		expect(readRemoteHistory(provider, row, snapshot([capture]))).toMatchObject({
			captured: 2000,
			refunded: 0,
			canceled: 0,
			keys: ["tamara:captured:capture-a", "delivery:local-notification"],
		});
	});
});
