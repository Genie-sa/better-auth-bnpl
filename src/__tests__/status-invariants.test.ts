import { describe, expect, it, vi } from "vitest";
import { canTransition, statusFromBalances } from "../core/status";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { makeBnplTestInstance, stubProvider } from "./_harness";

const orderId = "invariant-order";

async function setup(row: Record<string, unknown>) {
	const capture = vi.fn(async () => ({
		providerOrderId: orderId,
		captureId: `capture-${capture.mock.calls.length}`,
		amountMinor: 6000,
		raw: {},
	}));
	const refund = vi.fn(async () => ({
		providerOrderId: orderId,
		refundId: `refund-${refund.mock.calls.length}`,
		amountMinor: 1000,
		raw: {},
	}));
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { tamara: stubProvider("tamara", { capture, refund }) },
			persistOrders: true,
			use: [admin({ isAuthorized: () => true })],
		}),
	]);
	const stored: Record<string, unknown> = {
		id: "invariant-row",
		provider: "tamara",
		providerOrderId: orderId,
		orderReferenceId: "invariant-ref",
		amountMinor: 10000,
		currency: "SAR",
		refundedAmountMinor: 0,
		canceledAmountMinor: 0,
		version: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
		...row,
	};
	instance.db.bnplOrder?.push(stored);
	const { headers } = await instance.signInWithTestUser();
	const post = (operation: "capture" | "refund", body: Record<string, unknown>) =>
		instance.client.$fetch(`/bnpl/admin/orders/${orderId}/${operation}`, {
			method: "POST",
			headers,
			body,
		});
	return { post, capture, refund, stored };
}

describe("order status invariants", () => {
	it("lets the remaining authorisation be captured after the captured part was fully refunded", async () => {
		const { post, capture, stored } = await setup({
			status: "fully_refunded",
			capturedAmountMinor: 4000,
			refundedAmountMinor: 4000,
		});
		const result = await post("capture", {
			totalAmount: { amount: "60.00", currency: "SAR" },
			merchantReferenceId: "remaining",
			shippingInfo: { shippedAt: "2026-11-21T00:00:00Z", shippingCompany: "Test" },
		});
		expect(result.error).toBeNull();
		expect(capture).toHaveBeenCalledOnce();
		expect(stored).toMatchObject({
			status: "partially_refunded",
			capturedAmountMinor: 10000,
			refundedAmountMinor: 4000,
		});
	});
	it("still rejects a capture once nothing remains capturable", async () => {
		const { post, capture } = await setup({
			status: "fully_refunded",
			capturedAmountMinor: 10000,
			refundedAmountMinor: 10000,
		});
		const result = await post("capture", {
			totalAmount: { amount: "60.00", currency: "SAR" },
			merchantReferenceId: "nothing-left",
		});
		expect(result.error?.status).toBe(400);
		expect(capture).not.toHaveBeenCalled();
	});
	it("never moves a canceled order to a refund status the transition table forbids", async () => {
		const { post, refund, stored } = await setup({
			status: "canceled",
			capturedAmountMinor: 5000,
			canceledAmountMinor: 5000,
		});
		const result = await post("refund", {
			totalAmount: { amount: "10.00", currency: "SAR" },
			merchantRefundId: "after-cancel",
		});
		expect(result.error).toBeNull();
		expect(refund).toHaveBeenCalledOnce();
		expect(stored).toMatchObject({ status: "canceled", refundedAmountMinor: 1000 });
	});
});

describe("status derivation from balances", () => {
	it("does not call a refund that arrived before its capture a full refund", () => {
		expect(
			statusFromBalances("partially_refunded", {
				amountMinor: 10000,
				captured: 0,
				refunded: 3000,
				canceled: 0,
			}),
		).toBe("partially_refunded");
	});
	it.each(["new", "approved"])(
		"allows %s to reach closed when reconciliation finds a closed payment",
		(from) => {
			expect(canTransition(from, "closed")).toBe(true);
		},
	);
});
