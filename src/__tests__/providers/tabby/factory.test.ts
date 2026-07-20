import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BnplProvider } from "../../../core/provider";
import type { BnplCheckoutInput, BnplOrderItem } from "../../../core/types";
import { tabby } from "../../../providers/tabby";
import type { TabbyOptions } from "../../../providers/tabby";
import { ctx } from "../../_harness";
const operationRequestSchema = z
	.object({
		amount: z.string(),
		reference_id: z.string(),
		items: z
			.array(
				z
					.object({
						reference_id: z.string(),
						discount_amount: z.string().optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();
function parseRequestBody(body: BodyInit | null | undefined): unknown {
	if (typeof body !== "string") {
		throw new Error("expected JSON string request body");
	}
	return JSON.parse(body);
}
describe("tabby() factory", () => {
	const baseConfig = {
		secretKey: "sk_test_x",
		merchantCode: "MERCH",
		webhookHeader: { name: "X-Sig", value: "secret-32-byte-or-more-of-entropy" },
		environment: "sandbox",
	} satisfies TabbyOptions;
	it("declares static capabilities matching the docs", () => {
		const provider = tabby(baseConfig);
		expect(provider.id).toBe("tabby");
		expect(provider.capabilities.separateAuthorise).toBe(false);
		expect(provider.capabilities.voidCheckout).toBe(false);
		expect(provider.capabilities.closePayment).toBe(true);
		expect(provider.capabilities.disputes).toBe(true);
	});
	it("supports SAR/AED/KWD only", () => {
		const provider = tabby(baseConfig);
		expect(provider.supportedCurrencies).toEqual(["SAR", "AED", "KWD"]);
		expect(provider.supportedCountries).toEqual(["SA", "AE", "KW"]);
	});
	describe("preCheck heuristics", () => {
		const provider = tabby(baseConfig);
		it("rejects unsupported countries", async () => {
			const result = await provider.preCheck(
				{ countryCode: "US", amount: { amount: "100", currency: "SAR" } },
				ctx,
			);
			expect(result.available).toBe(false);
			expect(result.reason).toBe("country_not_supported");
		});
		it("rejects unsupported currencies", async () => {
			const result = await provider.preCheck(
				{ countryCode: "SA", amount: { amount: "100", currency: "OMR" } },
				ctx,
			);
			expect(result.available).toBe(false);
			expect(result.reason).toBe("currency_not_supported");
		});
		it("rejects amounts below SAR minimum", async () => {
			const result = await provider.preCheck(
				{ countryCode: "SA", amount: { amount: "10", currency: "SAR" } },
				ctx,
			);
			expect(result.available).toBe(false);
			expect(result.reason).toBe("amount_too_low");
		});
		it("rejects amounts above the cap", async () => {
			const result = await provider.preCheck(
				{ countryCode: "SA", amount: { amount: "100000", currency: "SAR" } },
				ctx,
			);
			expect(result.available).toBe(false);
			expect(result.reason).toBe("amount_too_high");
		});
		it("approves a valid order", async () => {
			const result = await provider.preCheck(
				{ countryCode: "SA", amount: { amount: "450", currency: "SAR" } },
				ctx,
			);
			expect(result.available).toBe(true);
			expect(result.availablePaymentTypes?.[0]?.paymentType).toBe("PAY_BY_INSTALMENTS");
		});
		it("respects custom preCheckBounds", async () => {
			const customProvider = tabby({
				...baseConfig,
				preCheckBounds: { SAR: { minMinor: 100, maxMinor: 50000 } },
			});
			const result = await customProvider.preCheck(
				{ countryCode: "SA", amount: { amount: "1.50", currency: "SAR" } },
				ctx,
			);
			expect(result.available).toBe(true);
		});
		it("uses Tabby's checkout endpoint for eligibility when email and phone are available", async () => {
			let requestBody: unknown;
			const fetch: typeof globalThis.fetch = async (_input, init) => {
				requestBody = parseRequestBody(init?.body);
				return new Response(
					JSON.stringify({
						id: "checkout-eligibility-1",
						status: "created",
						configuration: {
							products: {
								installments: { type: "installments", is_available: true },
								pay_later: { type: "pay_later", is_available: false },
							},
						},
						payment: {
							id: "payment-eligibility-1",
							status: "CREATED",
							amount: "450.00",
							currency: "SAR",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			};
			const apiProvider = tabby({ ...baseConfig, fetch });
			const result = await apiProvider.preCheck(
				{
					countryCode: "SA",
					amount: { amount: "450.00", currency: "SAR" },
					email: "otp.success@tabby.ai",
					phone: "+966500000001",
				},
				ctx,
			);
			expect(requestBody).toEqual({
				payment: {
					amount: "450.00",
					currency: "SAR",
					buyer: {
						email: "otp.success@tabby.ai",
						phone: "+966500000001",
					},
				},
				merchant_code: "MERCH",
				lang: "en",
			});
			expect(result.available).toBe(true);
			expect(result.availablePaymentTypes).toEqual([
				expect.objectContaining({ paymentType: "PAY_BY_INSTALMENTS", instalments: 4 }),
			]);
		});
		it("maps Tabby rejected eligibility responses to unavailable", async () => {
			const fetch: typeof globalThis.fetch = async () =>
				new Response(
					JSON.stringify({
						id: "checkout-eligibility-2",
						status: "rejected",
						configuration: {
							products: {
								installments: {
									type: "installments",
									is_available: false,
									rejection_reason: "not_available",
								},
							},
						},
						payment: {
							id: "payment-eligibility-2",
							status: "REJECTED",
							amount: "450.00",
							currency: "SAR",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			const apiProvider = tabby({ ...baseConfig, fetch });
			const result = await apiProvider.preCheck(
				{
					countryCode: "SA",
					amount: { amount: "450.00", currency: "SAR" },
					email: "otp.success@tabby.ai",
					phone: "+966500000002",
				},
				ctx,
			);
			expect(result).toEqual({ available: false, reason: "not_available" });
		});
		it("maps eligibility to PAY_BY_INSTALMENTS only — the docs define no other product key", async () => {
			const fetch: typeof globalThis.fetch = async () =>
				new Response(
					JSON.stringify({
						id: "checkout-eligibility-3",
						status: "created",
						configuration: {
							available_products: {
								installments: [{ web_url: "https://tabby/installments" }],
								pay_later: [{ web_url: "https://tabby/pay-later" }],
								pay_in_full: [{ web_url: "https://tabby/pay-in-full" }],
							},
							products: {
								installments: { type: "installments", is_available: true },
								pay_later: { type: "pay_later", is_available: true },
								pay_in_full: { type: "pay_in_full", is_available: true },
							},
						},
						payment: {
							id: "payment-eligibility-3",
							status: "CREATED",
							amount: "450.00",
							currency: "SAR",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			const apiProvider = tabby({ ...baseConfig, fetch });
			const result = await apiProvider.preCheck(
				{
					countryCode: "SA",
					amount: { amount: "450.00", currency: "SAR" },
					email: "otp.success@tabby.ai",
					phone: "+966500000001",
				},
				ctx,
			);
			expect(result.available).toBe(true);
			expect(result.availablePaymentTypes?.map((t) => t.paymentType)).toEqual([
				"PAY_BY_INSTALMENTS",
			]);
		});
		it("trusts issued installments checkout URLs over a contradictory is_available flag", async () => {
			const fetch: typeof globalThis.fetch = async () =>
				new Response(
					JSON.stringify({
						id: "checkout-eligibility-4",
						status: "created",
						configuration: {
							available_products: {
								installments: [{ web_url: "https://tabby/installments" }],
							},
							products: {
								installments: { type: "installments", is_available: false },
							},
						},
						payment: {
							id: "payment-eligibility-4",
							status: "CREATED",
							amount: "450.00",
							currency: "SAR",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			const apiProvider = tabby({ ...baseConfig, fetch });
			const result = await apiProvider.preCheck(
				{
					countryCode: "SA",
					amount: { amount: "450.00", currency: "SAR" },
					email: "otp.success@tabby.ai",
					phone: "+966500000001",
				},
				ctx,
			);
			expect(result.available).toBe(true);
		});
		it("falls back to local availability when Tabby eligibility fails", async () => {
			const fetch: typeof globalThis.fetch = async () =>
				new Response(JSON.stringify({ error: "temporary outage" }), {
					status: 503,
					headers: { "content-type": "application/json" },
				});
			const apiProvider = tabby({ ...baseConfig, fetch });
			const result = await apiProvider.preCheck(
				{
					countryCode: "SA",
					amount: { amount: "450.00", currency: "SAR" },
					email: "otp.success@tabby.ai",
					phone: "+966500000001",
				},
				ctx,
			);
			expect(result.available).toBe(true);
			expect(result.availablePaymentTypes?.[0]?.paymentType).toBe("PAY_BY_INSTALMENTS");
		});
	});
	describe("verifyWebhook", () => {
		const provider = tabby(baseConfig);
		it("rejects when header secret missing", async () => {
			const result = await provider.verifyWebhook({
				url: "https://x/y",
				headers: new Headers(),
				rawBody: "{}",
			});
			expect(result.ok).toBe(false);
		});
		it("accepts a properly signed webhook + parses body", async () => {
			const result = await provider.verifyWebhook({
				url: "https://x/y",
				headers: new Headers({ "X-Sig": "secret-32-byte-or-more-of-entropy" }),
				rawBody: '{"id":"pay-1","status":"AUTHORIZED","amount":"100","currency":"SAR"}',
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.payload.id).toBe("pay-1");
				expect(result.dedupKey).toMatch(/^tabby:/);
			}
		});
		it("rejects invalid JSON body", async () => {
			const result = await provider.verifyWebhook({
				url: "https://x/y",
				headers: new Headers({ "X-Sig": "secret-32-byte-or-more-of-entropy" }),
				rawBody: "not json",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toMatch(/JSON/);
		});
	});
	describe("createCheckout payment type selection", () => {
		const checkoutInput: BnplCheckoutInput = {
			orderReferenceId: "ref-1",
			description: "Order",
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
			buyer: {
				firstName: "Ali",
				lastName: "Dhamen",
				email: "ali@example.com",
				phone: "+966500000000",
			},
			shippingAddress: { line1: "X", city: "Riyadh", countryCode: "SA" },
			countryCode: "SA",
			merchantUrl: {
				success: "https://merchant.example/success",
				failure: "https://merchant.example/failure",
				cancel: "https://merchant.example/cancel",
				notification: "https://merchant.example/bnpl/webhooks/tabby",
			},
		};
		it("uses Tabby's pay_later checkout URL when PAY_BY_LATER is requested", async () => {
			const fetch: typeof globalThis.fetch = async () =>
				new Response(
					JSON.stringify({
						id: "checkout-1",
						status: "created",
						configuration: {
							available_products: {
								installments: [{ web_url: "https://tabby/installments" }],
								pay_later: [{ web_url: "https://tabby/pay-later" }],
							},
							products: {
								pay_later: { type: "pay_later", is_available: true },
							},
						},
						payment: {
							id: "payment-1",
							status: "CREATED",
							amount: "100.00",
							currency: "SAR",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			const provider = tabby({
				...baseConfig,
				fetch,
			});
			const result = await provider.createCheckout(
				{ ...checkoutInput, paymentType: "PAY_BY_LATER" },
				ctx,
			);
			expect(result.status).not.toBe("declined");
			if (result.status === "declined") {
				throw new Error("expected approved checkout");
			}
			expect(result.checkoutUrl).toBe("https://tabby/pay-later");
			expect(result.providerOrderId).toBe("payment-1");
		});
		it("omits shipping_address from the outgoing JSON when shipping is absent", async () => {
			let requestBody: unknown;
			const fetch: typeof globalThis.fetch = async (_input, init) => {
				requestBody = parseRequestBody(init?.body);
				return new Response(
					JSON.stringify({
						id: "checkout-digital",
						status: "created",
						configuration: {
							available_products: {
								installments: [{ web_url: "https://tabby/digital" }],
							},
						},
						payment: {
							id: "payment-digital",
							status: "CREATED",
							amount: "100.00",
							currency: "SAR",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			};
			const provider = tabby({ ...baseConfig, fetch });
			const { shippingAddress: _shippingAddress, ...input } = checkoutInput;

			await provider.createCheckout(input, ctx);

			const parsed = z.object({ payment: z.object({}).passthrough() }).parse(requestBody);
			expect(parsed.payment).not.toHaveProperty("shipping_address");
		});
	});
	describe("capture/refund references", () => {
		it("requires operation references before calling Tabby", async () => {
			const provider: BnplProvider = tabby(baseConfig);
			await expect(
				provider.capture("pay-1", { totalAmount: { amount: "25.00", currency: "SAR" } }, ctx),
			).rejects.toMatchObject({ code: "REFERENCE_ID_REQUIRED" });
			await expect(
				provider.refund("pay-1", { totalAmount: { amount: "5.00", currency: "SAR" } }, ctx),
			).rejects.toMatchObject({ code: "REFERENCE_ID_REQUIRED" });
		});
		it("forwards required references and item payloads to capture/refund", async () => {
			let captureBody: z.infer<typeof operationRequestSchema> | undefined;
			let refundBody: z.infer<typeof operationRequestSchema> | undefined;
			const fetch: typeof globalThis.fetch = async (input, init) => {
				const url = String(input);
				if (url.endsWith("/captures")) {
					captureBody = operationRequestSchema.parse(parseRequestBody(init?.body));
					return new Response(
						JSON.stringify({
							id: "pay-1",
							status: "AUTHORIZED",
							amount: "100.00",
							currency: "SAR",
							captures: [{ id: "cap-1", amount: "25.00" }],
							refunds: [],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (url.endsWith("/refunds")) {
					refundBody = operationRequestSchema.parse(parseRequestBody(init?.body));
					return new Response(
						JSON.stringify({
							id: "pay-1",
							status: "CLOSED",
							amount: "100.00",
							currency: "SAR",
							captures: [{ id: "cap-1", amount: "25.00" }],
							refunds: [{ id: "rfd-1", amount: "5.00" }],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				throw new Error(`unexpected Tabby request: ${url}`);
			};
			const provider = tabby({ ...baseConfig, fetch });
			const items: BnplOrderItem[] = [
				{
					referenceId: "sku-1",
					name: "Item",
					sku: "SKU1",
					quantity: 1,
					totalAmount: { amount: "25.00", currency: "SAR" },
					discountAmount: { amount: "1.00", currency: "SAR" },
				},
			];
			await provider.capture(
				"pay-1",
				{
					totalAmount: { amount: "25.00", currency: "SAR" },
					merchantReferenceId: "cap-ref-1",
					items,
				},
				ctx,
			);
			await provider.refund(
				"pay-1",
				{
					totalAmount: { amount: "5.00", currency: "SAR" },
					merchantRefundId: "rfd-ref-1",
					items,
				},
				ctx,
			);
			expect(captureBody).toMatchObject({
				amount: "25.00",
				reference_id: "cap-ref-1",
				items: [{ reference_id: "sku-1", discount_amount: "1.00" }],
			});
			expect(refundBody).toMatchObject({
				amount: "5.00",
				reference_id: "rfd-ref-1",
				items: [{ reference_id: "sku-1", discount_amount: "1.00" }],
			});
		});
	});
});
