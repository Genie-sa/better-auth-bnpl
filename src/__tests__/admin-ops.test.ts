import { describe, expect, it } from "vitest";
import { BnplProviderError } from "../core/errors";
import type { BnplProvider, ProviderCapabilities } from "../core/provider";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { type BnplTestInstance, makeBnplTestInstance, stubProvider } from "./_harness";
const ORDER_ID = "ord-admin";
const capabilities = (overrides: Partial<ProviderCapabilities>): ProviderCapabilities => ({
	preCheck: true,
	separateAuthorise: false,
	voidCheckout: false,
	closePayment: false,
	partialCapture: true,
	partialRefund: true,
	multipleCaptures: true,
	disputes: false,
	...overrides,
});
function seedOrderRow(instance: BnplTestInstance, row: Record<string, unknown> = {}): void {
	instance.db.bnplOrder?.push({
		id: "row-admin",
		userId: "user-admin",
		provider: "tabby",
		orderReferenceId: "ref-admin",
		providerOrderId: ORDER_ID,
		providerCheckoutId: "co-admin",
		status: "authorised",
		amountMinor: 10000,
		currency: "SAR",
		capturedAmountMinor: 0,
		refundedAmountMinor: 0,
		version: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
		...row,
	});
}
function orderRow(instance: BnplTestInstance): Record<string, unknown> {
	const row = instance.db.bnplOrder?.[0];
	if (!row) throw new Error("no order row seeded");
	return row;
}
async function makeAdminInstance(
	provider: BnplProvider,
	isAuthorized: () => boolean = () => true,
): Promise<{
	instance: BnplTestInstance;
	headers: Headers;
}> {
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { [provider.id]: provider },
			persistOrders: true,
			use: [admin({ isAuthorized })],
		}),
	]);
	seedOrderRow(instance);
	const { headers } = await instance.signInWithTestUser();
	return { instance, headers };
}
function post(
	instance: BnplTestInstance,
	headers: Headers,
	operation: string,
	body?: Record<string, unknown>,
) {
	return instance.client.$fetch(`/bnpl/admin/orders/${ORDER_ID}/${operation}`, {
		method: "POST",
		headers,
		body,
	});
}
describe("admin order operations", () => {
	describe("authorise", () => {
		it("rejects providers without a separate authorise step", async () => {
			const { instance, headers } = await makeAdminInstance(stubProvider("tabby"));
			const res = await post(instance, headers, "authorise");
			expect(res.error?.status).toBe(400);
			expect(orderRow(instance).status).toBe("authorised");
		});
		it("authorises via the provider and persists the result", async () => {
			const provider = stubProvider("tabby", {
				capabilities: capabilities({ separateAuthorise: true }),
				authorize: async () => ({
					providerOrderId: ORDER_ID,
					status: "authorised",
					raw: { upstream: true },
				}),
			});
			const { instance, headers } = await makeAdminInstance(provider);
			orderRow(instance).status = "approved";
			const res = await post(instance, headers, "authorise");
			expect(res.error).toBeNull();
			expect(orderRow(instance).status).toBe("authorised");
			expect(orderRow(instance).authorisedAt).toBeInstanceOf(Date);
			expect(orderRow(instance).version).not.toBe(0);
		});
		it("recovers idempotently when the provider says already authorised", async () => {
			const provider = stubProvider("tabby", {
				capabilities: capabilities({ separateAuthorise: true }),
				authorize: async () => {
					throw new BnplProviderError("tabby", "Order already authorised", {
						status: 400,
						body: { message: "Order already authorised" },
					});
				},
			});
			const { instance, headers } = await makeAdminInstance(provider);
			orderRow(instance).status = "approved";
			const res = await post(instance, headers, "authorise");
			expect(res.error).toBeNull();
			expect(res.data).toMatchObject({ orderId: ORDER_ID, status: "authorised", already: true });
			expect(orderRow(instance).status).toBe("authorised");
		});
		it("returns 403 when the admin authorizer rejects the session", async () => {
			const { instance, headers } = await makeAdminInstance(stubProvider("tabby"), () => false);
			const res = await post(instance, headers, "authorise");
			expect(res.error?.status).toBe(403);
		});
	});
	describe("void", () => {
		it("rejects providers without void support", async () => {
			const { instance, headers } = await makeAdminInstance(stubProvider("tabby"));
			const res = await post(instance, headers, "void", {});
			expect(res.error?.status).toBe(400);
		});
		it("voids the checkout session using the persisted checkout id", async () => {
			let voided:
				| {
						checkoutId: string;
						orderId: string;
				  }
				| undefined;
			const provider = stubProvider("tabby", {
				capabilities: capabilities({ voidCheckout: true }),
				voidCheckout: async (checkoutId, providerOrderId) => {
					voided = { checkoutId, orderId: providerOrderId };
				},
			});
			const { instance, headers } = await makeAdminInstance(provider);
			const res = await post(instance, headers, "void", {});
			expect(res.error).toBeNull();
			expect(res.data).toMatchObject({ orderId: ORDER_ID, voided: true });
			expect(voided).toEqual({ checkoutId: "co-admin", orderId: ORDER_ID });
		});
	});
	describe("close", () => {
		it("rejects providers without close support", async () => {
			const { instance, headers } = await makeAdminInstance(stubProvider("tabby"));
			const res = await post(instance, headers, "close");
			expect(res.error?.status).toBe(400);
		});
		it("closes the payment and persists the closed status", async () => {
			let closedPaymentId: string | undefined;
			const provider = stubProvider("tabby", {
				capabilities: capabilities({ closePayment: true }),
				closePayment: async (providerPaymentId) => {
					closedPaymentId = providerPaymentId;
				},
			});
			const { instance, headers } = await makeAdminInstance(provider);
			const res = await post(instance, headers, "close");
			expect(res.error).toBeNull();
			expect(closedPaymentId).toBe(ORDER_ID);
			expect(orderRow(instance).status).toBe("closed");
		});
	});
	describe("reconcile", () => {
		it("syncs the local row from the provider's authoritative state", async () => {
			const provider = stubProvider("tabby", {
				fetchOrder: async () => ({
					providerOrderId: ORDER_ID,
					status: "fully_captured",
					totalAmount: { amount: "100.00", currency: "SAR" },
					capturedAmountMinor: 10000,
					refundedAmountMinor: 0,
					raw: { remote: true },
				}),
			});
			const { instance, headers } = await makeAdminInstance(provider);
			const res = await post(instance, headers, "reconcile");
			expect(res.error).toBeNull();
			expect(res.data).toMatchObject({ synced: true });
			expect(orderRow(instance).status).toBe("fully_captured");
			expect(orderRow(instance).capturedAmountMinor).toBe(10000);
		});
		it("maps provider failures to a 502 without touching the row", async () => {
			const provider = stubProvider("tabby", {
				fetchOrder: async () => {
					throw new BnplProviderError("tabby", "upstream down", { status: 503 });
				},
			});
			const { instance, headers } = await makeAdminInstance(provider);
			const res = await post(instance, headers, "reconcile");
			expect(res.error?.status).toBe(502);
			expect(orderRow(instance).status).toBe("authorised");
			expect(orderRow(instance).capturedAmountMinor).toBe(0);
		});
	});
});
