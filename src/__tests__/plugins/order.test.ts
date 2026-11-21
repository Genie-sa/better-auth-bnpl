import { describe, expect, it } from "vitest";
import type { BnplMoneyOperation, BnplOrderState } from "../../core/types";
import { automaticCaptureReference } from "../../plugins/money-command";
import {
	type OrderRecord,
	addMoney,
	addObservedMoney,
	applyAuthorisation,
	applyCancellation,
	applyMoneyOperation,
	attributePendingOperations,
	importSnapshot,
	readRemoteHistory,
	snapshotIsBehind,
} from "../../plugins/order";
import { stubProvider } from "../_harness";

const provider = stubProvider("tamara");
const base: OrderRecord = {
	provider: "tamara",
	providerOrderId: "history-order",
	status: "authorised",
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

function snapshot(
	operations: BnplMoneyOperation[],
	status: BnplOrderState["status"] = "partially_captured",
): BnplOrderState {
	const sum = (kind: BnplMoneyOperation["kind"]) =>
		operations.filter((op) => op.kind === kind).reduce((total, op) => total + op.amountMinor, 0);
	return {
		providerOrderId: base.providerOrderId,
		status,
		totalAmount: { amount: "100.00", currency: "SAR" },
		capturedAmountMinor: sum("captured"),
		refundedAmountMinor: sum("refunded"),
		canceledAmountMinor: sum("canceled"),
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
					: [capture, { id: "older-remote", kind, amountMinor: 1000, currency: "SAR" }];
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

describe("order money invariants", () => {
	it("rejects a confirmed refund that exceeds captured money", () => {
		expect(() => addMoney(base, "refunded", 1000)).toThrow(/financial balance/);
	});
	it("accepts a notified refund that arrives before its capture, then converges", () => {
		const refunded = addObservedMoney(base, "refunded", 4000);
		expect(refunded).toMatchObject({ refundedAmountMinor: 4000, status: "partially_refunded" });
		expect(addObservedMoney({ ...base, ...refunded }, "captured", 10000)).toMatchObject({
			capturedAmountMinor: 10000,
			refundedAmountMinor: 4000,
			status: "partially_refunded",
		});
	});
	it("bounds a notified refund by the uncanceled order total", () => {
		expect(() =>
			addObservedMoney({ ...base, canceledAmountMinor: 2500 }, "refunded", 7501),
		).toThrow(/financial balance/);
	});
	it("rejects a capture beyond the uncanceled balance", () => {
		expect(() => addMoney({ ...base, canceledAmountMinor: 4000 }, "captured", 6001)).toThrow(
			/financial balance/,
		);
	});
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects a non-positive or unsafe amount %s",
		(amountMinor) => {
			expect(() => addMoney(base, "captured", amountMinor)).toThrow();
		},
	);
	it.each([
		["captured", { capturedAmountMinor: 4000 }, 6000, "fully_captured"],
		["captured", { capturedAmountMinor: 0 }, 2500, "partially_captured"],
		["refunded", { capturedAmountMinor: 6000 }, 6000, "fully_refunded"],
		["refunded", { capturedAmountMinor: 6000 }, 1000, "partially_refunded"],
		[
			"captured",
			{ capturedAmountMinor: 2000, refundedAmountMinor: 2000 },
			1000,
			"partially_refunded",
		],
	] as const)("%s from %j by %i reaches %s", (kind, balances, amountMinor, status) => {
		expect(addMoney({ ...base, ...balances }, kind, amountMinor).status).toBe(status);
	});
	it("treats a partially canceled order as fully captured once its remainder is captured", () => {
		expect(addMoney({ ...base, canceledAmountMinor: 2500 }, "captured", 7500).status).toBe(
			"fully_captured",
		);
	});
	it("records a confirmed capture once and keeps a closed order closed", () => {
		const closed = { ...base, status: "closed", capturedAmountMinor: 5000 };
		const applied = applyMoneyOperation(closed, provider, {
			kind: "captured",
			id: "late-capture",
			amountMinor: 1000,
		});
		expect(applied).toMatchObject({ capturedAmountMinor: 6000, status: "closed" });
		const replay = applyMoneyOperation(
			{ ...closed, ...applied, appliedOperations: applied?.appliedOperations },
			provider,
			{ kind: "captured", id: "late-capture", amountMinor: 1000 },
		);
		expect(replay).toBeNull();
	});
	it("records a cancellation once and bounds it by the uncaptured balance", () => {
		const applied = applyCancellation(
			{ ...base, capturedAmountMinor: 4000 },
			provider,
			"c-1",
			6000,
		);
		expect(applied).toEqual({
			canceledAmountMinor: 6000,
			appliedOperations: JSON.stringify(["tamara:cancel:c-1"]),
		});
		expect(
			applyCancellation(
				{ ...base, appliedOperations: applied?.appliedOperations },
				provider,
				"c-1",
				1,
			),
		).toBeNull();
		expect(() =>
			applyCancellation({ ...base, capturedAmountMinor: 4000 }, provider, "c-2", 6001),
		).toThrow(/remaining order balance/);
	});
});

describe("snapshot import", () => {
	it("derives a refunded status from merged history rather than trusting the snapshot status", () => {
		const row = {
			...base,
			status: "fully_captured",
			capturedAmountMinor: 10000,
			appliedOperations: JSON.stringify(["tamara:captured:full"]),
		};
		const remote = snapshot(
			[
				{ id: "full", kind: "captured", amountMinor: 10000, currency: "SAR" },
				{ id: "partial", kind: "refunded", amountMinor: 2500, currency: "SAR" },
			],
			"fully_captured",
		);
		expect(importSnapshot(row, provider, remote)).toMatchObject({
			capturedAmountMinor: 10000,
			refundedAmountMinor: 2500,
			status: "partially_refunded",
		});
	});
	it("keeps the local status when the snapshot status would move it backwards", () => {
		const row = { ...base, status: "fully_captured", capturedAmountMinor: 0 };
		expect(importSnapshot(row, provider, snapshot([], "authorised")).status).toBe("fully_captured");
	});
	it.each([
		[{ capturedAmountMinor: 2000 }, { capturedAmountMinor: 1000 }],
		[{ refundedAmountMinor: 500 }, { refundedAmountMinor: 0 }],
		[{ canceledAmountMinor: 500 }, { canceledAmountMinor: 0 }],
	])("detects a snapshot behind local balances %j", (local, remote) => {
		expect(snapshotIsBehind({ ...base, ...local }, { ...snapshot([]), ...remote })).toBe(true);
	});
	it("treats an omitted canceled total as unspecified rather than zero", () => {
		expect(
			snapshotIsBehind(
				{ ...base, canceledAmountMinor: 500 },
				{
					...snapshot([]),
					canceledAmountMinor: undefined,
				},
			),
		).toBe(false);
	});
	it("accepts a snapshot level with local balances", () => {
		expect(snapshotIsBehind({ ...base, capturedAmountMinor: 2000 }, snapshot([capture]))).toBe(
			false,
		);
	});
});

describe("authorisation", () => {
	it("preserves a refund committed while the authorisation request was in flight", () => {
		const result = applyAuthorisation(
			{ ...base, status: "fully_refunded", capturedAmountMinor: 10000, refundedAmountMinor: 10000 },
			provider,
			{ providerOrderId: "history-order", status: "authorised", raw: {} },
		);
		expect(result.patch.status).toBe("fully_refunded");
		expect(result.capturedAmountMinor).toBeUndefined();
	});
	it("derives the capture status when an auto-captured response still reports authorised", () => {
		const result = applyAuthorisation({ ...base, status: "approved" }, provider, {
			providerOrderId: "history-order",
			status: "authorised",
			autoCaptured: true,
			captureId: "capture-1",
			capturedAmountMinor: 10000,
			raw: {},
		});
		expect(result.patch).toMatchObject({ status: "fully_captured", capturedAmountMinor: 10000 });
	});
	it("derives a partial capture against the uncanceled balance", () => {
		const result = applyAuthorisation(
			{ ...base, status: "approved", canceledAmountMinor: 2500 },
			provider,
			{
				providerOrderId: "history-order",
				status: "authorised",
				capturedAmountMinor: 5000,
				raw: {},
			},
		);
		expect(result.patch.status).toBe("partially_captured");
	});
	it("keeps the authorised status when the response reports a zero capture", () => {
		const result = applyAuthorisation({ ...base, status: "approved" }, provider, {
			providerOrderId: "history-order",
			status: "authorised",
			capturedAmountMinor: 0,
			raw: {},
		});
		expect(result.patch.status).toBe("authorised");
		expect(result.patch.capturedAt).toBeUndefined();
	});
	it("rejects an authorised capture in another currency", () => {
		expect(() =>
			applyAuthorisation(base, provider, {
				providerOrderId: "history-order",
				status: "authorised",
				capturedAmountMinor: 100,
				capturedCurrency: "AED",
				raw: {},
			}),
		).toThrow(/currency/);
	});
	it("records an automatic capture under its ledger key", () => {
		const result = applyAuthorisation({ ...base, canceledAmountMinor: 2500 }, provider, {
			providerOrderId: "history-order",
			status: "fully_captured",
			autoCaptured: true,
			captureId: "auto",
			raw: {},
		});
		expect(result.capturedAmountMinor).toBe(7500);
		expect(result.patch).toMatchObject({
			capturedAmountMinor: 7500,
			appliedOperations: JSON.stringify(["tamara:captured:auto"]),
		});
	});
	it("rejects an automatic capture beyond the uncanceled balance", () => {
		expect(() =>
			applyAuthorisation({ ...base, canceledAmountMinor: 2500 }, provider, {
				providerOrderId: "history-order",
				status: "fully_captured",
				capturedAmountMinor: 9000,
				raw: {},
			}),
		).toThrow(/invalid authorised capture amount/);
	});
});

describe("automaticCaptureReference", () => {
	it.each([
		[0, 10000, "bnpl:tabby:order-1:capture:10000"],
		[2500, 7500, "bnpl:tabby:order-1:capture:10000"],
		[2500, 5000, "bnpl:tabby:order-1:capture:7500"],
	])("from %i captured plus %i targets the cumulative balance", (captured, amount, expected) => {
		expect(
			automaticCaptureReference(
				{ ...base, provider: "tabby", providerOrderId: "order-1", capturedAmountMinor: captured },
				amount,
			),
		).toBe(expected);
	});
});

describe("pending operation attribution", () => {
	const baseline = {
		capturedAmountMinor: 2000,
		refundedAmountMinor: 0,
		canceledAmountMinor: 0,
		appliedOperations: JSON.stringify(["tamara:captured:capture-a"]),
	};
	const row = { ...base, ...baseline };
	const second: BnplMoneyOperation = {
		id: "capture-b",
		kind: "captured",
		amountMinor: 5000,
		currency: "SAR",
	};
	it("identifies the single new operation of the requested amount", () => {
		expect(
			attributePendingOperations(
				provider,
				row,
				baseline,
				snapshot([capture, second]),
				"captured",
				5000,
			),
		).toEqual([second]);
	});
	it.each([
		["no new operation", [capture], 5000],
		["a different amount", [capture, second], 4000],
		[
			"two candidate operations",
			[
				capture,
				{ ...second, amountMinor: 3000 },
				{ ...second, id: "capture-c", amountMinor: 3000 },
			],
			3000,
		],
	] as const)("refuses to attribute %s", (_label, operations, amount) => {
		expect(
			attributePendingOperations(
				provider,
				row,
				baseline,
				snapshot([...operations]),
				"captured",
				amount,
			),
		).toBeNull();
	});
	it("attributes a refund the provider split across captures by its total", () => {
		const refunds: BnplMoneyOperation[] = [
			{ id: "r-a", kind: "refunded", amountMinor: 500, currency: "SAR" },
			{ id: "r-b", kind: "refunded", amountMinor: 1500, currency: "SAR" },
		];
		expect(
			attributePendingOperations(
				provider,
				row,
				baseline,
				snapshot([capture, ...refunds]),
				"refunded",
				2000,
			),
		).toEqual(refunds);
		expect(
			attributePendingOperations(
				provider,
				row,
				baseline,
				snapshot([capture, ...refunds]),
				"refunded",
				1500,
			),
		).toBeNull();
	});
	it("identifies the operation the provider recorded under the command's reference", () => {
		const referencing = stubProvider("tamara", {
			capabilities: { ...provider.capabilities, operationReferences: true },
		});
		const ours = { ...second, amountMinor: 3000, reference: "cmd-ref" };
		const theirs = { ...second, id: "dashboard", amountMinor: 3000, reference: "other" };
		expect(
			attributePendingOperations(
				referencing,
				row,
				baseline,
				snapshot([capture, theirs, ours]),
				"captured",
				3000,
				"cmd-ref",
			),
		).toEqual([ours]);
		expect(
			attributePendingOperations(
				referencing,
				row,
				baseline,
				snapshot([capture, theirs]),
				"captured",
				3000,
				"cmd-ref",
			),
		).toBeNull();
	});
	it("never attributes by amount for a provider that records operation references", () => {
		const referencing = stubProvider("tamara", {
			capabilities: { ...provider.capabilities, operationReferences: true },
		});
		const unreferenced = { ...second, amountMinor: 3000 };
		expect(
			attributePendingOperations(
				referencing,
				row,
				baseline,
				snapshot([capture, unreferenced]),
				"captured",
				3000,
				"cmd-ref",
			),
		).toBeNull();
	});
	it("matches by reference whenever new operations carry one, even without the capability", () => {
		const theirs = { ...second, amountMinor: 3000, reference: "other" };
		expect(
			attributePendingOperations(
				provider,
				row,
				baseline,
				snapshot([capture, theirs]),
				"captured",
				3000,
				"cmd-ref",
			),
		).toBeNull();
	});
	it("refuses amount-only attribution when anything else changed since the baseline", () => {
		const refund: BnplMoneyOperation = {
			id: "r",
			kind: "refunded",
			amountMinor: 500,
			currency: "SAR",
		};
		expect(
			attributePendingOperations(
				provider,
				row,
				baseline,
				snapshot([capture, second, refund]),
				"captured",
				5000,
			),
		).toBeNull();
	});
	it("ignores new operations of another kind", () => {
		const refund: BnplMoneyOperation = {
			id: "r",
			kind: "refunded",
			amountMinor: 1000,
			currency: "SAR",
		};
		expect(
			attributePendingOperations(
				provider,
				row,
				baseline,
				snapshot([capture, refund]),
				"captured",
				5000,
			),
		).toBeNull();
	});
	it("rejects history that omits an operation recorded before the command", () => {
		expect(() =>
			attributePendingOperations(provider, row, baseline, snapshot([second]), "captured", 5000),
		).toThrow(/complete native operation history/);
	});
});
