import { describe, expect, it } from "vitest";
import {
	tabbyCaptureRequestSchema,
	tabbyCheckoutRequestSchema,
	tabbyRefundRequestSchema,
} from "../../providers/tabby/schemas";
import {
	tamaraCaptureBodySchema,
	tamaraPreCheckoutEligibilityRequestSchema,
} from "../../providers/tamara/schemas";
describe("provider request schemas", () => {
	it("requires Tamara capture shipping fields documented by the capture endpoint", () => {
		const result = tamaraCaptureBodySchema.safeParse({
			order_id: "ord_1",
			total_amount: { amount: "120.00", currency: "SAR" },
			shipping_info: {
				shipped_at: "2026-06-04T10:00:00Z",
			},
		});
		expect(result.success).toBe(false);
	});
	it("narrows Tamara pre-check eligibility to supported currencies", () => {
		const invalidCurrency = tamaraPreCheckoutEligibilityRequestSchema.safeParse({
			order: { amount: 120, currency: "USD" },
			customer: { phone: "+966500000000" },
		});
		expect(invalidCurrency.success).toBe(false);
	});
	it("requires Tabby checkout orders to contain at least one item", () => {
		const result = tabbyCheckoutRequestSchema.safeParse({
			payment: {
				amount: "120.00",
				currency: "SAR",
				buyer: {
					name: "Test Buyer",
					email: "buyer@example.com",
					phone: "+966500000000",
				},
				shipping_address: {
					address: "King Fahd Road",
					city: "Riyadh",
				},
				order: {
					reference_id: "merchant-ref-1",
					items: [],
				},
			},
			lang: "en",
			merchant_code: "MERCH",
			merchant_urls: {
				success: "https://merchant.example/success",
				cancel: "https://merchant.example/cancel",
				failure: "https://merchant.example/failure",
			},
		});
		expect(result.success).toBe(false);
	});
	it("requires Tabby capture and refund references for idempotent reconciliation", () => {
		const invalidCapture = tabbyCaptureRequestSchema.safeParse({
			amount: "50.00",
		});
		const invalidRefund = tabbyRefundRequestSchema.safeParse({
			amount: "25.00",
		});
		expect(invalidCapture.success).toBe(false);
		expect(invalidRefund.success).toBe(false);
	});
});
