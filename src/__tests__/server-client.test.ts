import { describe, expect, expectTypeOf, it } from "vitest";
import type { BnplProvider } from "../core/provider";
import type { BnplAuthorizeResult, BnplCheckoutInput } from "../core/types";
import { type TabbyCaptureArgs, type TabbyRefundArgs, tabby } from "../providers/tabby";
import { type TamaraCancelArgs, type TamaraCaptureArgs, tamara } from "../providers/tamara";
import { createBnplClient } from "../server-client";
import { stubProvider } from "./_harness";
type SecondParameter<Fn> = Fn extends (
	first: string,
	second: infer Arg,
	...rest: readonly unknown[]
) => unknown
	? Arg
	: never;
const checkoutInput: BnplCheckoutInput = {
	orderReferenceId: "ref-1",
	description: "x",
	totalAmount: { amount: "100.00", currency: "SAR" },
	items: [
		{
			referenceId: "sku-1",
			name: "Item",
			sku: "SKU1",
			quantity: 1,
			totalAmount: { amount: "100.00", currency: "SAR" },
		},
	],
	buyer: { firstName: "A", lastName: "B", email: "a@b.com", phone: "+966" },
	shippingAddress: { line1: "X", city: "X", countryCode: "SA" },
	countryCode: "SA",
	merchantUrl: {
		success: "https://merchant.example/success",
		failure: "https://merchant.example/failure",
		cancel: "https://merchant.example/cancel",
		notification: "https://merchant.example/bnpl/webhooks/test",
	},
};
function matrixProvider(id: "tamara" | "tabby") {
	const calls: string[] = [];
	const provider = stubProvider(id, {
		async createCheckout() {
			calls.push(`${id}.createCheckout`);
			return {
				providerOrderId: `${id}-order`,
				providerCheckoutId: `${id}-checkout`,
				checkoutUrl: `https://${id}.example/checkout`,
				status: "new",
				raw: { provider: id, operation: "createCheckout" },
			};
		},
		async fetchOrder(providerOrderId) {
			calls.push(`${id}.fetchOrder:${providerOrderId}`);
			return {
				providerOrderId,
				status: "authorised",
				totalAmount: { amount: "100.00", currency: "SAR" },
				capturedAmountMinor: 0,
				refundedAmountMinor: 0,
				raw: { provider: id, operation: "fetchOrder" },
			};
		},
		async capture(providerOrderId) {
			calls.push(`${id}.capture:${providerOrderId}`);
			return {
				captureId: `${id}-capture`,
				providerOrderId,
				amountMinor: 10000,
				raw: { provider: id, operation: "capture" },
			};
		},
		async refund(providerOrderId) {
			calls.push(`${id}.refund:${providerOrderId}`);
			return {
				refundId: `${id}-refund`,
				providerOrderId,
				amountMinor: 10000,
				raw: { provider: id, operation: "refund" },
			};
		},
		async cancel(providerOrderId) {
			calls.push(`${id}.cancel:${providerOrderId}`);
		},
		async preCheck(input) {
			calls.push(`${id}.preCheck:${input.amount.amount}`);
			return { available: true };
		},
		async authorize(providerOrderId) {
			calls.push(`${id}.authorize:${providerOrderId}`);
			return {
				providerOrderId,
				status: "authorised",
				autoCaptured: true,
				captureId: `${id}-authcap`,
				capturedAmountMinor: 10000,
				raw: { provider: id, operation: "authorize" },
			};
		},
		async voidCheckout(checkoutId, providerOrderId) {
			calls.push(`${id}.voidCheckout:${checkoutId}:${providerOrderId}`);
		},
		async closePayment(providerPaymentId) {
			calls.push(`${id}.closePayment:${providerPaymentId}`);
		},
	});
	return { provider, calls };
}
describe("createBnplClient", () => {
	it("exposes both generic + namespaced helpers", async () => {
		const client = createBnplClient({
			providers: {
				tamara: stubProvider("tamara"),
				tabby: stubProvider("tabby"),
			},
		});
		expect(client.tamara).toBeDefined();
		expect(client.tabby).toBeDefined();
		expect(typeof client.options).toBe("function");
		expect(typeof client.createCheckout).toBe("function");
	});
	it("dispatches to the right provider via the generic API", async () => {
		const calls: string[] = [];
		const client = createBnplClient({
			providers: {
				tamara: stubProvider("tamara", {
					async createCheckout() {
						calls.push("tamara.createCheckout");
						return {
							providerOrderId: "ord-tamara",
							providerCheckoutId: "co-tamara",
							checkoutUrl: "https://tamara/co",
							status: "new",
							raw: {},
						};
					},
				}),
				tabby: stubProvider("tabby", {
					async createCheckout() {
						calls.push("tabby.createCheckout");
						return {
							providerOrderId: "ord-tabby",
							providerCheckoutId: "co-tabby",
							checkoutUrl: "https://tabby/co",
							status: "new",
							raw: {},
						};
					},
				}),
			},
		});
		await client.createCheckout("tabby", {
			orderReferenceId: "ref-1",
			description: "x",
			totalAmount: { amount: "100.00", currency: "AED" },
			items: [
				{
					referenceId: "sku-1",
					name: "Item",
					sku: "SKU1",
					quantity: 1,
					totalAmount: { amount: "100.00", currency: "AED" },
				},
			],
			buyer: {
				firstName: "A",
				lastName: "B",
				email: "a@b.com",
				phone: "+97150",
			},
			shippingAddress: { line1: "X", city: "X", countryCode: "AE" },
			countryCode: "AE",
			merchantUrl: {
				success: "https://merchant.example/success",
				failure: "https://merchant.example/failure",
				cancel: "https://merchant.example/cancel",
				notification: "https://merchant.example/bnpl/webhooks/test",
			},
		});
		expect(calls).toEqual(["tabby.createCheckout"]);
	});
	it("throws PROVIDER_NOT_CONFIGURED for unknown ids", () => {
		const providers: Record<string, BnplProvider> = { tabby: stubProvider("tabby") };
		const client = createBnplClient({
			providers,
		});
		expect(() => client.createCheckout("tamara", checkoutInput)).toThrow(/not configured/);
	});
	it("provider-namespaced helpers preset the provider", async () => {
		let called: string | null = null;
		const client = createBnplClient({
			providers: {
				tamara: stubProvider("tamara", {
					async createCheckout() {
						called = "tamara";
						return {
							providerOrderId: "x",
							providerCheckoutId: "x",
							checkoutUrl: "https://checkout.example.test/x",
							status: "new",
							raw: {},
						};
					},
				}),
			},
		});
		await client.tamara.createCheckout({ ...checkoutInput, orderReferenceId: "r" });
		expect(called).toBe("tamara");
	});
	it("infers provider-specific operation args from configured factories", () => {
		const client = createBnplClient({
			providers: {
				tabby: tabby({
					secretKey: "sk_test_x",
					merchantCode: "MERCH",
					webhookHeader: { name: "X-Sig", value: "secret-32-byte-or-more-of-entropy" },
					environment: "sandbox",
				}),
				tamara: tamara({
					apiToken: "tamara-token",
					notificationToken: "notification-token",
					environment: "sandbox",
				}),
			},
		});
		const tabbyNamespace = client.provider("tabby");
		expectTypeOf<SecondParameter<typeof client.tabby.capture>>().toEqualTypeOf<TabbyCaptureArgs>();
		expectTypeOf<SecondParameter<typeof tabbyNamespace.refund>>().toEqualTypeOf<TabbyRefundArgs>();
		expectTypeOf<
			SecondParameter<typeof client.tamara.capture>
		>().toEqualTypeOf<TamaraCaptureArgs>();
		expectTypeOf<SecondParameter<typeof client.tamara.cancel>>().toEqualTypeOf<TamaraCancelArgs>();
		expectTypeOf<
			Awaited<ReturnType<typeof client.authorize>>
		>().toEqualTypeOf<BnplAuthorizeResult>();
		expectTypeOf<
			Awaited<ReturnType<NonNullable<typeof tabbyNamespace.authorize>>>
		>().toEqualTypeOf<BnplAuthorizeResult>();
	});
	it("options() runs preCheck on every provider in parallel", async () => {
		const client = createBnplClient({
			providers: {
				tamara: stubProvider("tamara", {
					async preCheck() {
						return { available: true };
					},
				}),
				tabby: stubProvider("tabby", {
					async preCheck() {
						return { available: false, reason: "amount_too_low" };
					},
				}),
			},
		});
		const results = await client.options({
			countryCode: "SA",
			amount: { amount: "10.00", currency: "SAR" },
		});
		expect(results).toHaveLength(2);
		const byId = Object.fromEntries(results.map((r) => [r.id, r]));
		expect(byId.tamara?.available).toBe(true);
		expect(byId.tabby?.available).toBe(false);
		expect(byId.tabby?.reason).toBe("amount_too_low");
	});
	it("options() degrades gracefully on provider preCheck failures", async () => {
		const client = createBnplClient({
			providers: {
				tamara: stubProvider("tamara", {
					async preCheck() {
						throw new Error("upstream blew up");
					},
				}),
				tabby: stubProvider("tabby", {
					async preCheck() {
						return { available: true };
					},
				}),
			},
		});
		const results = await client.options({
			countryCode: "SA",
			amount: { amount: "100.00", currency: "SAR" },
		});
		const byId = Object.fromEntries(results.map((r) => [r.id, r]));
		expect(byId.tamara?.available).toBe(false);
		expect(byId.tamara?.reason).toBe("precheck_failed");
		expect(byId.tabby?.available).toBe(true);
	});
	it("authorize on a Tabby provider throws OPERATION_NOT_SUPPORTED", async () => {
		const client = createBnplClient({
			providers: {
				tabby: stubProvider("tabby", { authorize: undefined }),
			},
		});
		await expect(client.authorize("tabby", "x")).rejects.toThrow(/does not require/);
	});
	it.each([
		["tabby only", ["tabby"] as const],
		["tamara only", ["tamara"] as const],
		["both providers", ["tamara", "tabby"] as const],
	])("exercises every server-client function with %s enabled", async (_label, ids) => {
		const entries = ids.map((id) => [id, matrixProvider(id)] as const);
		const providers = Object.fromEntries(entries.map(([id, entry]) => [id, entry.provider]));
		const callsById = Object.fromEntries(entries.map(([id, entry]) => [id, entry.calls]));
		const client = createBnplClient({ providers });
		const optionRows = await client.options({
			countryCode: "SA",
			amount: { amount: "100.00", currency: "SAR" },
		});
		expect(optionRows.map((row) => row.id).sort()).toEqual([...ids].sort());
		for (const id of ids) {
			const namespace = client.provider(id);
			const directCheckout = await client.createCheckout(id, checkoutInput);
			const namespacedCheckout = await namespace.createCheckout(checkoutInput);
			const fetched = await client.fetchOrder(id, `${id}-order`);
			const captured = await client.capture(id, `${id}-order`, {
				totalAmount: { amount: "100.00", currency: "SAR" },
			});
			const refunded = await client.refund(id, `${id}-order`, {
				totalAmount: { amount: "100.00", currency: "SAR" },
			});
			await client.cancel(id, `${id}-order`, {});
			const preCheck = await client.preCheck(id, {
				countryCode: "SA",
				amount: { amount: "100.00", currency: "SAR" },
			});
			const authorise = await client.authorize(id, `${id}-order`);
			await namespace.voidCheckout?.(`${id}-checkout`, `${id}-order`);
			await namespace.closePayment?.(`${id}-order`);
			expect(directCheckout.providerOrderId).toBe(`${id}-order`);
			expect(namespacedCheckout.providerCheckoutId).toBe(`${id}-checkout`);
			expect(fetched.status).toBe("authorised");
			expect(captured.captureId).toBe(`${id}-capture`);
			expect(refunded.refundId).toBe(`${id}-refund`);
			expect(preCheck.available).toBe(true);
			expect(authorise.status).toBe("authorised");
			expect(authorise.autoCaptured).toBe(true);
			expect(authorise.captureId).toBe(`${id}-authcap`);
			expect(authorise.capturedAmountMinor).toBe(10000);
			expect(authorise.raw).toEqual({ provider: id, operation: "authorize" });
			expect(callsById[id]).toEqual([
				`${id}.preCheck:100.00`,
				`${id}.createCheckout`,
				`${id}.createCheckout`,
				`${id}.fetchOrder:${id}-order`,
				`${id}.capture:${id}-order`,
				`${id}.refund:${id}-order`,
				`${id}.cancel:${id}-order`,
				`${id}.preCheck:100.00`,
				`${id}.authorize:${id}-order`,
				`${id}.voidCheckout:${id}-checkout:${id}-order`,
				`${id}.closePayment:${id}-order`,
			]);
		}
	});
});
