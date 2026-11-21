import { describe, expect, it, vi } from "vitest";
import { BnplPluginError, BnplProviderError, isDefinitiveRejection } from "../core/errors";
import type { BnplProvider } from "../core/provider";
import type { BnplOrderState, BnplWebhookEvent } from "../core/types";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { checkout } from "../plugins/checkout";
import { webhooks } from "../plugins/webhooks";
import { tabby } from "../providers/tabby";
import { makeBnplTestInstance, stubProvider } from "./_harness";

const orderId = "rejected-order";
type Operation = "capture" | "refund" | "cancel" | "void" | "close" | "authorise";
const providerMethod = {
	capture: "capture",
	refund: "refund",
	cancel: "cancel",
	void: "voidCheckout",
	close: "closePayment",
	authorise: "authorize",
} as const satisfies Record<Operation, keyof BnplProvider>;
const requestBody: Record<Operation, Record<string, unknown> | undefined> = {
	capture: {
		totalAmount: { amount: "10.00", currency: "SAR" },
		merchantReferenceId: "capture-ref",
	},
	refund: { totalAmount: { amount: "10.00", currency: "SAR" }, merchantRefundId: "refund-ref" },
	cancel: { totalAmount: { amount: "10.00", currency: "SAR" }, merchantReferenceId: "cancel-ref" },
	void: {},
	close: undefined,
	authorise: undefined,
};

function tabbyRejection(status: number, message = "only authorized payments can be closed") {
	return new BnplProviderError("tabby", message, { status, body: { message }, rejected: true });
}
function validationRejection(message = "tamara: capture requires shippingInfo") {
	return new BnplPluginError("SHIPPING_INFO_REQUIRED", message, undefined, { rejected: true });
}

async function setupAdmin(operation: Operation, error: unknown) {
	const base = stubProvider("tabby");
	const call = vi.fn(async () => {
		throw error;
	});
	const fetchOrder = vi.fn(async (): Promise<BnplOrderState> => {
		throw new Error("recovery GET must not run after a definitive rejection");
	});
	const provider = stubProvider("tabby", {
		capabilities: {
			...base.capabilities,
			separateAuthorise: true,
			voidCheckout: true,
			closePayment: true,
		},
		fetchOrder,
		[providerMethod[operation]]: call,
	});
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { tabby: provider },
			persistOrders: true,
			use: [admin({ isAuthorized: () => true })],
		}),
	]);
	const row: Record<string, unknown> = {
		id: "rejected-row",
		provider: "tabby",
		providerOrderId: orderId,
		providerCheckoutId: "rejected-checkout",
		orderReferenceId: "rejected-reference",
		status: operation === "authorise" ? "approved" : "partially_captured",
		amountMinor: 10000,
		currency: "SAR",
		capturedAmountMinor: operation === "authorise" ? 0 : 5000,
		refundedAmountMinor: 0,
		canceledAmountMinor: 0,
		version: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	instance.db.bnplOrder?.push(row);
	const { headers } = await instance.signInWithTestUser();
	const post = () =>
		instance.client.$fetch(`/bnpl/admin/orders/${orderId}/${operation}`, {
			method: "POST",
			headers,
			...(requestBody[operation] ? { body: requestBody[operation] } : {}),
		});
	const pending = () =>
		row.moneyCommands
			? (JSON.parse(String(row.moneyCommands)) as Array<{ state: string }>).filter(
					(command) => command.state === "pending",
				)
			: [];
	return { post, call, fetchOrder, pending, row };
}

describe("definitive rejection classification", () => {
	it.each([
		["plugin validation before any request", validationRejection()],
		["a refused mutation response", tabbyRejection(400)],
		["explicit provider no-op", new BnplProviderError("tamara", "not applied", { rejected: true })],
	])("treats %s as definitive", (_label, error) => {
		expect(isDefinitiveRejection(error)).toBe(true);
	});
	it.each([
		["a timeout without a response", new BnplProviderError("tabby", "timed out")],
		[
			"a bare 4xx status, which may come from a read after the mutation",
			new BnplProviderError("tamara", "order not found", { status: 404 }),
		],
		[
			"an unmarked plugin error, which a provider may throw after dispatch",
			new BnplPluginError("INVALID_URL", "returned checkout URL is invalid"),
		],
		["an unclassified error", new Error("socket hang up")],
	])("treats %s as uncertain", (_label, error) => {
		expect(isDefinitiveRejection(error)).toBe(false);
	});
});

describe("admin commands rejected by the provider", () => {
	it.each(Object.keys(providerMethod) as Operation[])(
		"releases the %s reservation so the order accepts the next command",
		async (operation) => {
			const { post, call, fetchOrder, pending } = await setupAdmin(operation, tabbyRejection(400));
			const first = await post();
			expect(first.error?.status).not.toBe(409);
			expect(pending()).toEqual([]);
			const retry = await post();
			expect(retry.error?.status).not.toBe(409);
			expect(call).toHaveBeenCalledTimes(2);
			expect(fetchOrder).not.toHaveBeenCalled();
		},
	);
	it("releases a capture that failed plugin validation before any request", async () => {
		const { post, call, pending } = await setupAdmin("capture", validationRejection());
		expect((await post()).error?.status).toBe(400);
		expect(pending()).toEqual([]);
		expect((await post()).error?.status).toBe(400);
		expect(call).toHaveBeenCalledTimes(2);
	});
	it.each([undefined, 408, 425, 429, 500])(
		"keeps an uncertain capture pending after error status %s",
		async (status) => {
			const { post, call, pending } = await setupAdmin(
				"capture",
				new BnplProviderError("tabby", "outcome unknown", { status }),
			);
			await post();
			expect(pending()).toHaveLength(1);
			expect((await post()).error?.status).toBe(409);
			expect(call).toHaveBeenCalledOnce();
		},
	);
	it("keeps a capture pending when an unmarked error follows a dispatched request", async () => {
		const { post, call, pending } = await setupAdmin(
			"capture",
			new BnplProviderError("tabby", "capture response could not be verified", { status: 404 }),
		);
		await post();
		expect(pending()).toHaveLength(1);
		expect((await post()).error?.status).toBe(409);
		expect(call).toHaveBeenCalledOnce();
	});
	it("releases a capture the provider refused because the order is already captured", async () => {
		const { post, call, pending } = await setupAdmin(
			"capture",
			new BnplProviderError("tabby", "already captured", {
				status: 400,
				body: { status: "error", errorType: "bad_data", error: "already captured" },
				rejected: true,
			}),
		);
		await post();
		expect(pending()).toEqual([]);
		expect(call).toHaveBeenCalledOnce();
	});
	it("releases an amount-bearing cancel when someone else already closed the payment", async () => {
		const { post, call, pending } = await setupAdmin(
			"cancel",
			new BnplProviderError("tabby", "already closed", {
				status: 400,
				body: { status: "error", errorType: "bad_data", error: "already closed" },
				rejected: true,
			}),
		);
		await post();
		expect(pending()).toEqual([]);
		expect(call).toHaveBeenCalledOnce();
	});
	it.each(["Order already voided", "Order already canceled"])(
		"releases a void refused with %j because recovery cannot prove a paid void",
		async (message) => {
			const { post, pending } = await setupAdmin(
				"void",
				new BnplProviderError("tamara", message, {
					status: 400,
					body: { message },
					rejected: true,
				}),
			);
			await post();
			expect(pending()).toEqual([]);
		},
	);
	it("releases a void refused because the order was already captured", async () => {
		const { post, pending } = await setupAdmin(
			"void",
			new BnplProviderError("tamara", "already captured", {
				status: 400,
				body: { message: "Order already captured" },
				rejected: true,
			}),
		);
		await post();
		expect(pending()).toEqual([]);
	});
	it("keeps a close pending when Tabby reports it already closed, then verifies it through GET", async () => {
		const { post, call, fetchOrder, pending, row } = await setupAdmin(
			"close",
			new BnplProviderError("tabby", "already closed", {
				status: 400,
				body: { status: "error", errorType: "bad_data", error: "already closed" },
				rejected: true,
			}),
		);
		await post();
		expect(pending()).toHaveLength(1);
		fetchOrder.mockImplementation(async () => ({
			providerOrderId: orderId,
			status: "closed",
			totalAmount: { amount: "100.00", currency: "SAR" },
			capturedAmountMinor: 5000,
			refundedAmountMinor: 0,
			operations: [{ kind: "captured", id: "capture-1", amountMinor: 5000, currency: "SAR" }],
			raw: { status: "CLOSED" },
		}));
		row.appliedOperations = JSON.stringify(["tabby:captured:capture-1"]);
		expect((await post()).error).toBeNull();
		expect(call).toHaveBeenCalledOnce();
		expect(row.status).toBe("closed");
	});
});

describe("automatic authorisation after a rejected attempt", () => {
	it("authorises on the next approval delivery instead of staying blocked", async () => {
		const base = stubProvider("tamara");
		const authorize = vi.fn(async () => {
			if (authorize.mock.calls.length === 1)
				throw new BnplProviderError("tamara", "There is a wrong data type in your payload", {
					status: 400,
					body: { message: "There is a wrong data type in your payload" },
					rejected: true,
				});
			return { providerOrderId: orderId, status: "authorised" as const, raw: {} };
		});
		const provider = stubProvider("tamara", {
			capabilities: { ...base.capabilities, separateAuthorise: true },
			authorize,
			verifyWebhook: async (request) => ({
				ok: true,
				payload: JSON.parse(request.rawBody),
				rawBody: request.rawBody,
				dedupKey: JSON.parse(request.rawBody).delivery,
			}),
			toCanonicalEvent: (payload) => payload.event as BnplWebhookEvent,
		});
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tamara: provider },
				persistOrders: true,
				use: [admin({ isAuthorized: () => true }), webhooks()],
			}),
		]);
		const row: Record<string, unknown> = {
			id: "approval-row",
			provider: "tamara",
			providerOrderId: orderId,
			orderReferenceId: "approval-reference",
			status: "new",
			amountMinor: 10000,
			currency: "SAR",
			capturedAmountMinor: 0,
			refundedAmountMinor: 0,
			version: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		instance.db.bnplOrder?.push(row);
		const { headers } = await instance.signInWithTestUser();
		const early = await instance.client.$fetch(`/bnpl/admin/orders/${orderId}/authorise`, {
			method: "POST",
			headers,
		});
		expect(early.error?.status).toBe(502);
		const approved = await instance.client.$fetch("/bnpl/webhooks/tamara", {
			method: "POST",
			body: {
				delivery: "approved-after-rejection",
				event: { kind: "approved", provider: "tamara", orderId, raw: {} },
			},
		});
		expect(approved.error).toBeNull();
		expect(authorize).toHaveBeenCalledTimes(2);
		expect(row.status).toBe("authorised");
	});
});

describe("checkout rejected by the provider", () => {
	async function setupCheckout(error: unknown) {
		const createCheckout = vi.fn(async () => {
			if (createCheckout.mock.calls.length === 1) throw error;
			return {
				providerOrderId: "accepted-order",
				providerCheckoutId: "accepted-session",
				checkoutUrl: "https://provider.example/checkout" as const,
				status: "new" as const,
				raw: {},
			};
		});
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tamara: stubProvider("tamara", { createCheckout }) },
				persistOrders: true,
				use: [checkout()],
			}),
		]);
		const { headers } = await instance.signInWithTestUser();
		const post = () =>
			instance.client.$fetch("/bnpl/checkout", {
				method: "POST",
				headers,
				body: {
					provider: "tamara",
					orderReferenceId: "rejected-checkout-ref",
					description: "Test",
					countryCode: "SA",
					buyer: {
						firstName: "Test",
						lastName: "Buyer",
						email: "buyer@example.test",
						phone: "+966500000001",
					},
					totalAmount: { amount: "100.00", currency: "SAR" },
					items: [
						{
							referenceId: "item",
							name: "Test",
							sku: "item",
							quantity: 1,
							totalAmount: { amount: "100.00", currency: "SAR" },
						},
					],
				},
			});
		return { ...instance, post, createCheckout };
	}
	it.each([
		["plugin validation", validationRejection("tamara does not support country code: ZZ")],
		[
			"a refused provider response",
			new BnplProviderError("tamara", "invalid phone", { status: 400, rejected: true }),
		],
	])("discards the reservation after %s so the reference can be retried", async (_label, error) => {
		const { post, createCheckout, db } = await setupCheckout(error);
		expect((await post()).error).not.toBeNull();
		expect(db.bnplOrder).toHaveLength(0);
		const retry = await post();
		expect(retry.error).toBeNull();
		expect(createCheckout).toHaveBeenCalledTimes(2);
		expect(db.bnplOrder).toHaveLength(1);
		expect(db.bnplOrder?.[0]?.providerOrderId).toBe("accepted-order");
	});
	it("keeps the reservation when a provider fails after creating the checkout", async () => {
		const sideEffects: string[] = [];
		const createCheckout = vi.fn(async () => {
			sideEffects.push("remote-checkout");
			throw new BnplPluginError("INVALID_URL", "returned checkout URL is invalid");
		});
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tamara: stubProvider("tamara", { createCheckout }) },
				persistOrders: true,
				use: [checkout()],
			}),
		]);
		const { headers } = await instance.signInWithTestUser();
		const post = () =>
			instance.client.$fetch("/bnpl/checkout", {
				method: "POST",
				headers,
				body: {
					provider: "tamara",
					orderReferenceId: "post-dispatch-ref",
					description: "Test",
					countryCode: "SA",
					buyer: {
						firstName: "Test",
						lastName: "Buyer",
						email: "buyer@example.test",
						phone: "+966500000001",
					},
					totalAmount: { amount: "100.00", currency: "SAR" },
					items: [
						{
							referenceId: "item",
							name: "Test",
							sku: "item",
							quantity: 1,
							totalAmount: { amount: "100.00", currency: "SAR" },
						},
					],
				},
			});
		expect((await post()).error).not.toBeNull();
		expect((await post()).error?.status).toBe(409);
		expect(sideEffects).toEqual(["remote-checkout"]);
		expect(instance.db.bnplOrder).toHaveLength(1);
	});
	it("keeps the reservation after an uncertain provider failure", async () => {
		const { post, createCheckout, db } = await setupCheckout(
			new BnplProviderError("tamara", "timed out"),
		);
		expect((await post()).error).not.toBeNull();
		expect((await post()).error?.status).toBe(409);
		expect(createCheckout).toHaveBeenCalledOnce();
		expect(db.bnplOrder).toHaveLength(1);
	});
	it("discards a Tabby checkout rejected while building the request", async () => {
		const fetch = vi.fn(async () => Response.json({}));
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: {
					tabby: tabby({
						secretKey: "sk_test_unit",
						merchantCode: "unit",
						webhookHeader: { name: "X-Test", value: "unit" },
						fetch,
					}),
				},
				persistOrders: true,
				use: [checkout()],
			}),
		]);
		const { headers } = await instance.signInWithTestUser();
		const indivisible = await instance.client.$fetch("/bnpl/checkout", {
			method: "POST",
			headers,
			body: {
				provider: "tabby",
				orderReferenceId: "indivisible-ref",
				description: "Test",
				countryCode: "SA",
				buyer: {
					firstName: "Test",
					lastName: "Buyer",
					email: "buyer@example.test",
					phone: "+966500000001",
				},
				totalAmount: { amount: "100.00", currency: "SAR" },
				items: [
					{
						referenceId: "item",
						name: "Test",
						sku: "item",
						quantity: 3,
						totalAmount: { amount: "100.00", currency: "SAR" },
					},
				],
			},
		});
		expect(indivisible.error?.status).toBe(502);
		expect(fetch).not.toHaveBeenCalled();
		expect(instance.db.bnplOrder).toHaveLength(0);
	});
});
