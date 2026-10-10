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
	seedOrderRow(instance, { provider: provider.id });
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
	it("refuses to import unidentifiable remote money operations", async () => {
		const provider = stubProvider("tabby", {
			fetchOrder: async () => ({
				providerOrderId: ORDER_ID,
				status: "partially_captured",
				totalAmount: { amount: "100.00", currency: "SAR" },
				capturedAmountMinor: 4000,
				refundedAmountMinor: 0,
				raw: {},
			}),
		});
		const { instance, headers } = await makeAdminInstance(provider);
		expect((await post(instance, headers, "reconcile")).error).not.toBeNull();
		expect(orderRow(instance).capturedAmountMinor).toBe(0);
	});
	it("imports native operation identities with reconciled balances", async () => {
		const provider = stubProvider("tabby", {
			fetchOrder: async () => ({
				providerOrderId: ORDER_ID,
				status: "partially_captured",
				totalAmount: { amount: "100.00", currency: "SAR" },
				capturedAmountMinor: 4000,
				refundedAmountMinor: 0,
				operations: [{ id: "historic", kind: "captured", amountMinor: 4000, currency: "SAR" }],
				raw: {},
			}),
			capture: async () => ({
				providerOrderId: ORDER_ID,
				captureId: "historic",
				amountMinor: 4000,
				raw: {},
			}),
		});
		const { instance, headers } = await makeAdminInstance(provider);
		expect((await post(instance, headers, "reconcile")).error).toBeNull();
		expect(
			(
				await post(instance, headers, "capture", {
					totalAmount: { amount: "40.00", currency: "SAR" },
					merchantReferenceId: "historic-command",
				})
			).error,
		).toBeNull();
		expect(orderRow(instance).capturedAmountMinor).toBe(4000);
	});
	it("counts an idempotent capture response only once", async () => {
		const provider = stubProvider("tabby", {
			capture: async () => ({
				providerOrderId: ORDER_ID,
				captureId: "same-capture",
				amountMinor: 1000,
				raw: {},
			}),
		});
		const { instance, headers } = await makeAdminInstance(provider);
		const body = {
			totalAmount: { amount: "10.00", currency: "SAR" },
			merchantReferenceId: "stable-request",
		};
		expect((await post(instance, headers, "capture", body)).error).toBeNull();
		expect((await post(instance, headers, "capture", body)).error).toBeNull();
		expect(orderRow(instance).capturedAmountMinor).toBe(1000);
	});
	it("keeps a partially canceled order authorised", async () => {
		const provider = stubProvider("tabby", {
			cancel: async () => ({
				providerOrderId: ORDER_ID,
				status: "authorised",
				cancelId: "partial",
				amountMinor: 1000,
				raw: {},
			}),
		});
		const { instance, headers } = await makeAdminInstance(provider);
		expect(
			(
				await post(instance, headers, "cancel", {
					merchantReferenceId: "stable-partial-cancel",
					totalAmount: { amount: "10.00", currency: "SAR" },
				})
			).error,
		).toBeNull();
		expect(orderRow(instance).status).toBe("authorised");
	});
	it("reports an unsuccessful provider void", async () => {
		const provider = stubProvider("tabby", {
			capabilities: capabilities({ voidCheckout: true }),
			voidCheckout: async () => ({ voided: false, capturedAmountMinor: 1000, raw: {} }),
		});
		const { instance, headers } = await makeAdminInstance(provider);
		expect((await post(instance, headers, "void", {})).data).toMatchObject({
			voided: false,
			capturedAmountMinor: 1000,
		});
	});
	it("does not treat canceled-order authorisation errors as success", async () => {
		const provider = stubProvider("tabby", {
			capabilities: capabilities({ separateAuthorise: true }),
			authorize: async () => {
				throw new BnplProviderError("tabby", "not allowed for cancelled order", {
					status: 400,
					body: { message: "not allowed for cancelled order" },
				});
			},
		});
		const { instance, headers } = await makeAdminInstance(provider);
		orderRow(instance).status = "approved";
		expect((await post(instance, headers, "authorise")).error?.status).toBe(502);
		expect(orderRow(instance).status).toBe("approved");
	});
	it("does not overwrite a capture arriving during reconciliation", async () => {
		const provider = stubProvider("tabby", {
			fetchOrder: async () => {
				Object.assign(orderRow(instance), {
					capturedAmountMinor: 1000,
					status: "partially_captured",
					version: 1,
				});
				return {
					providerOrderId: ORDER_ID,
					status: "authorised",
					totalAmount: { amount: "100.00", currency: "SAR" },
					capturedAmountMinor: 0,
					refundedAmountMinor: 0,
					raw: {},
				};
			},
		});
		const prepared = await makeAdminInstance(provider);
		const instance = prepared.instance;
		await post(instance, prepared.headers, "reconcile");
		expect(orderRow(instance).capturedAmountMinor).toBe(1000);
	});
	it("uses captured funds as the full-refund denominator", async () => {
		const provider = stubProvider("tabby", {
			refund: async () => ({
				providerOrderId: ORDER_ID,
				refundId: "refund-all-captured",
				amountMinor: 1000,
				raw: {},
			}),
		});
		const { instance, headers } = await makeAdminInstance(provider);
		Object.assign(orderRow(instance), { status: "partially_captured", capturedAmountMinor: 1000 });
		expect(
			(
				await post(instance, headers, "refund", {
					merchantRefundId: "refund-all",
					totalAmount: { amount: "10.00", currency: "SAR" },
				})
			).error,
		).toBeNull();
		expect(orderRow(instance).status).toBe("fully_refunded");
	});
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
				fetchOrder: async () => ({
					providerOrderId: ORDER_ID,
					status: "authorised",
					totalAmount: { amount: "100.00", currency: "SAR" },
					capturedAmountMinor: 0,
					refundedAmountMinor: 0,
					raw: {},
				}),
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
				fetchOrder: async () => ({
					providerOrderId: ORDER_ID,
					status: "expired",
					totalAmount: { amount: "100.00", currency: "SAR" },
					capturedAmountMinor: 0,
					refundedAmountMinor: 0,
					operations: [],
					raw: {},
				}),
			});
			const { instance, headers } = await makeAdminInstance(provider);
			const res = await post(instance, headers, "void", {});
			expect(res.error).toBeNull();
			expect(res.data).toMatchObject({ orderId: ORDER_ID, voided: true });
			expect(voided).toEqual({ checkoutId: "co-admin", orderId: ORDER_ID });
		});
	});
	describe("close", () => {
		it("preserves a refund committed while close awaits", async () => {
			const provider = stubProvider("tabby", {
				capabilities: capabilities({ closePayment: true }),
				closePayment: async () => {
					Object.assign(orderRow(instance), {
						capturedAmountMinor: 10000,
						refundedAmountMinor: 2500,
						status: "partially_refunded",
						version: 1,
					});
				},
				fetchOrder: async () => ({
					providerOrderId: ORDER_ID,
					status: "partially_refunded",
					totalAmount: { amount: "100.00", currency: "SAR" },
					capturedAmountMinor: 10000,
					refundedAmountMinor: 2500,
					operations: [
						{ id: "close-capture", kind: "captured", amountMinor: 10000, currency: "SAR" },
						{ id: "close-refund", kind: "refunded", amountMinor: 2500, currency: "SAR" },
					],
					raw: { status: "CLOSED" },
				}),
			});
			const prepared = await makeAdminInstance(provider);
			const instance = prepared.instance;
			expect((await post(instance, prepared.headers, "close")).error).toBeNull();
			expect(orderRow(instance).status).toBe("partially_refunded");
		});
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
				fetchOrder: async () => ({
					providerOrderId: ORDER_ID,
					status: "closed",
					totalAmount: { amount: "100.00", currency: "SAR" },
					capturedAmountMinor: 1000,
					refundedAmountMinor: 0,
					operations: [
						{ id: "close-capture", kind: "captured", amountMinor: 1000, currency: "SAR" },
					],
					raw: { status: "CLOSED" },
				}),
			});
			const { instance, headers } = await makeAdminInstance(provider);
			const res = await post(instance, headers, "close");
			expect(res.error).toBeNull();
			expect(closedPaymentId).toBe(ORDER_ID);
			expect(orderRow(instance).status).toBe("closed");
		});
	});
	describe("reconcile", () => {
		it("recovers missed cancellation with capture history without refunding canceled funds", async () => {
			const provider = stubProvider("tamara", {
				fetchOrder: async () => ({
					providerOrderId: ORDER_ID,
					status: "fully_captured",
					totalAmount: { amount: "100.00", currency: "SAR" },
					capturedAmountMinor: 7500,
					refundedAmountMinor: 0,
					canceledAmountMinor: 2500,
					operations: [
						{ id: "missed-cancel", kind: "canceled", amountMinor: 2500, currency: "SAR" },
						{ id: "remaining-capture", kind: "captured", amountMinor: 7500, currency: "SAR" },
					],
					raw: {},
				}),
			});
			const { instance, headers } = await makeAdminInstance(provider);
			expect((await post(instance, headers, "reconcile")).error).toBeNull();
			expect(orderRow(instance)).toMatchObject({
				capturedAmountMinor: 7500,
				refundedAmountMinor: 0,
				canceledAmountMinor: 2500,
				status: "fully_captured",
			});
			expect(JSON.parse(String(orderRow(instance).appliedOperations))).toContain(
				"tamara:cancel:missed-cancel",
			);
		});
		it("syncs the local row from the provider's authoritative state", async () => {
			const provider = stubProvider("tabby", {
				fetchOrder: async () => ({
					providerOrderId: ORDER_ID,
					status: "fully_captured",
					totalAmount: { amount: "100.00", currency: "SAR" },
					capturedAmountMinor: 10000,
					refundedAmountMinor: 0,
					operations: [
						{ id: "remote-full-capture", kind: "captured", amountMinor: 10000, currency: "SAR" },
					],
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
