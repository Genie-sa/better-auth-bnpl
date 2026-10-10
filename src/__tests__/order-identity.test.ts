import { describe, expect, it, vi } from "vitest";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { orders } from "../plugins/orders";
import { makeBnplTestInstance, stubProvider } from "./_harness";

async function setup() {
	const capture = vi.fn(async () => ({
		providerOrderId: "shared",
		captureId: "cap",
		amountMinor: 1000,
		raw: {},
	}));
	const refund = vi.fn(async () => ({
		providerOrderId: "shared",
		refundId: "ref",
		amountMinor: 1000,
		raw: {},
	}));
	const firstFetch = vi.fn(async () => {
		throw new Error("wrong provider");
	});
	const secondFetch = vi.fn(async () => ({
		providerOrderId: "shared",
		status: "partially_captured" as const,
		totalAmount: { amount: "100.00", currency: "SAR" as const },
		capturedAmountMinor: 5000,
		refundedAmountMinor: 0,
		raw: {},
	}));
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: {
				first: stubProvider("first", { capture, refund, fetchOrder: firstFetch }),
				second: stubProvider("second", { capture, refund, fetchOrder: secondFetch }),
			},
			persistOrders: true,
			use: [orders(), admin({ isAuthorized: () => true })],
		}),
	]);
	const { headers } = await instance.signInWithTestUser();
	const userId = instance.db.user?.[0]?.id;
	const row = (provider: string, owner: unknown) => ({
		id: `${provider}-row`,
		userId: owner,
		provider,
		providerOrderId: "shared",
		orderReferenceId: `${provider}-ref`,
		status: "partially_captured",
		amountMinor: 10000,
		currency: "SAR",
		capturedAmountMinor: 5000,
		refundedAmountMinor: 0,
		canceledAmountMinor: 0,
		version: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	const first = row("first", "other-user");
	const second = row("second", userId);
	instance.db.bnplOrder?.push(first, second);
	return { instance, headers, userId, first, capture, refund, firstFetch, secondFetch };
}

describe("provider-scoped order identity", () => {
	it.each(["capture", "refund"])(
		"rejects ambiguous admin %s without posting to either provider",
		async (operation) => {
			const { instance, headers, capture, refund } = await setup();
			const response = await instance.client.$fetch(`/bnpl/admin/orders/shared/${operation}`, {
				method: "POST",
				headers,
				body: {
					totalAmount: { amount: "10.00", currency: "SAR" },
					merchantReferenceId: "command",
					merchantRefundId: "command",
				},
			});
			expect(response.error?.status).toBe(409);
			expect(capture).not.toHaveBeenCalled();
			expect(refund).not.toHaveBeenCalled();
		},
	);
	it("selects the rightful owner's provider despite an earlier foreign order with the same ID", async () => {
		const { instance, headers, firstFetch, secondFetch } = await setup();
		const response = await instance.client.$fetch<{ provider: string }>("/bnpl/orders/shared", {
			headers,
		});
		expect(response.error).toBeNull();
		expect(response.data?.provider).toBe("second");
		expect(firstFetch).not.toHaveBeenCalled();
		expect(secondFetch).toHaveBeenCalledOnce();
	});
	it("rejects an owner lookup when both providers' colliding IDs belong to that user", async () => {
		const { instance, headers, first, userId, firstFetch, secondFetch } = await setup();
		first.userId = userId;
		expect((await instance.client.$fetch("/bnpl/orders/shared", { headers })).error?.status).toBe(
			409,
		);
		expect(firstFetch).not.toHaveBeenCalled();
		expect(secondFetch).not.toHaveBeenCalled();
	});
	it("preserves forbidden foreign-order and missing-order responses", async () => {
		const { instance, headers } = await setup();
		instance.db.bnplOrder?.pop();
		expect((await instance.client.$fetch("/bnpl/orders/shared", { headers })).error?.status).toBe(
			403,
		);
		expect((await instance.client.$fetch("/bnpl/orders/missing", { headers })).error?.status).toBe(
			404,
		);
	});
});
