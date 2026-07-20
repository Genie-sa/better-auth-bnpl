import { describe, expect, it } from "vitest";
import type { BnplCheckoutInput } from "../../../core/types";
import {
	tamaraDedupKey,
	tamaraStatusToCanonical,
	tamaraToCanonicalEvent,
	tamaraWebhookDedupKeyForEvent,
	toTamaraCheckoutRequest,
} from "../../../providers/tamara/adapter";
const baseCheckout: BnplCheckoutInput = {
	orderReferenceId: "ord-1",
	description: "Test order",
	totalAmount: { amount: "450.00", currency: "SAR" },
	taxAmount: { amount: "0.00", currency: "SAR" },
	shippingAmount: { amount: "0.00", currency: "SAR" },
	items: [
		{
			referenceId: "sku-1",
			name: "Item",
			sku: "SKU1",
			quantity: 1,
			totalAmount: { amount: "450.00", currency: "SAR" },
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
		success: "https://shop.example.com/ok",
		failure: "https://shop.example.com/no",
		cancel: "https://shop.example.com/back",
		notification: "https://shop.example.com/api/auth/bnpl/webhooks/tamara",
	},
};
describe("toTamaraCheckoutRequest", () => {
	it("translates canonical input to Tamara wire shape", () => {
		const tamaraReq = toTamaraCheckoutRequest(baseCheckout);
		expect(tamaraReq.order_reference_id).toBe("ord-1");
		expect(tamaraReq.country_code).toBe("SA");
		expect(tamaraReq.consumer.first_name).toBe("Ali");
		expect(tamaraReq.consumer.phone_number).toBe("+966500000000");
		expect(tamaraReq.shipping_address.line1).toBe("X");
		expect(tamaraReq.items[0]?.reference_id).toBe("sku-1");
		expect(tamaraReq.items[0]?.type).toBe("Physical");
	});
	it("normalises locales `en` → `en_US` and `ar` → `ar_SA`", () => {
		expect(toTamaraCheckoutRequest({ ...baseCheckout, locale: "en" }).locale).toBe("en_US");
		expect(toTamaraCheckoutRequest({ ...baseCheckout, locale: "ar" }).locale).toBe("ar_SA");
		expect(toTamaraCheckoutRequest({ ...baseCheckout, locale: "ar_SA" }).locale).toBe("ar_SA");
	});
	it("defaults paymentType to PAY_BY_INSTALMENTS", () => {
		expect(toTamaraCheckoutRequest(baseCheckout).payment_type).toBe("PAY_BY_INSTALMENTS");
	});
	it("preserves merchant_url structure", () => {
		const req = toTamaraCheckoutRequest(baseCheckout);
		expect(req.merchant_url.notification).toBe(
			"https://shop.example.com/api/auth/bnpl/webhooks/tamara",
		);
	});
	it("rejects checkout without a shipping address with a typed error", () => {
		const { shippingAddress: _shippingAddress, ...input } = baseCheckout;

		expect(() => toTamaraCheckoutRequest(input)).toThrowError(
			expect.objectContaining({
				name: "BnplPluginError",
				code: "PROVIDER_NOT_AVAILABLE",
				message: "tamara: shippingAddress is required",
			}),
		);
	});
});
describe("tamaraStatusToCanonical", () => {
	it("passes through canonical statuses", () => {
		expect(tamaraStatusToCanonical("approved")).toBe("approved");
		expect(tamaraStatusToCanonical("authorised")).toBe("authorised");
		expect(tamaraStatusToCanonical("fully_captured")).toBe("fully_captured");
	});
	it("falls back to `new` for unknown values", () => {
		expect(tamaraStatusToCanonical("totally_unknown_status")).toBe("new");
	});
});
describe("tamaraToCanonicalEvent", () => {
	it("maps order_approved event", () => {
		const event = tamaraToCanonicalEvent({
			order_id: "ord-1",
			order_reference_id: "ref-1",
			event_type: "order_approved",
			data: {},
		});
		expect(event?.kind).toBe("approved");
		if (event?.kind === "approved") {
			expect(event.orderId).toBe("ord-1");
			expect(event.orderReferenceId).toBe("ref-1");
		}
	});
	it("maps order_authorised event", () => {
		const event = tamaraToCanonicalEvent({
			order_id: "ord-1",
			order_reference_id: "ref-1",
			event_type: "order_authorised",
			data: {},
		});
		expect(event?.kind).toBe("authorized");
	});
	it("maps order_captured to a captured event with delta amount", () => {
		const event = tamaraToCanonicalEvent({
			order_id: "ord-1",
			order_reference_id: "ref-1",
			event_type: "order_captured",
			data: {
				capture_id: "cap-123",
				captured_amount: { amount: "100.00", currency: "SAR" },
				total_amount: { amount: "450.00", currency: "SAR" },
			},
		});
		expect(event?.kind).toBe("captured");
		if (event?.kind === "captured") {
			expect(event.captureId).toBe("cap-123");
			expect(event.amountMinor).toBe(10000);
			expect(event.currency).toBe("SAR");
		}
	});
	it("maps order_refunded with refund delta", () => {
		const event = tamaraToCanonicalEvent({
			order_id: "ord-1",
			order_reference_id: "ref-1",
			event_type: "order_refunded",
			data: {
				refund_id: "rfd-9",
				refunded_amount: { amount: "50.00", currency: "SAR" },
				total_amount: { amount: "450.00", currency: "SAR" },
			},
		});
		expect(event?.kind).toBe("refunded");
		if (event?.kind === "refunded") {
			expect(event.refundId).toBe("rfd-9");
			expect(event.amountMinor).toBe(5000);
		}
	});
	it("normalises the PHP serialisation quirk (`data: []` becomes `{}`)", () => {
		const event = tamaraToCanonicalEvent({
			order_id: "ord-1",
			order_reference_id: "ref-1",
			event_type: "order_authorised",
			data: [],
		});
		expect(event?.kind).toBe("authorized");
	});
	it("maps AuthoriseMessage with order_status='approved' to canonical 'approved'", () => {
		const event = tamaraToCanonicalEvent({
			order_id: "ord-1",
			order_reference_id: "ref-1",
			order_status: "approved",
			data: {},
		});
		expect(event?.kind).toBe("approved");
	});
	it("maps AuthoriseMessage with order_status='declined' to canonical 'declined'", () => {
		const event = tamaraToCanonicalEvent({
			order_id: "ord-1",
			order_reference_id: "ref-1",
			order_status: "declined",
			data: {},
		});
		expect(event?.kind).toBe("declined");
	});
	it("returns null for malformed payloads", () => {
		expect(tamaraToCanonicalEvent({})).toBeNull();
		expect(tamaraToCanonicalEvent({ order_id: 123 })).toBeNull();
	});
	it("captures declined_reason from order_declined data", () => {
		const event = tamaraToCanonicalEvent({
			order_id: "ord-1",
			order_reference_id: "ref-1",
			event_type: "order_declined",
			data: { declined_reason: "CONSUMER_EXCEEDS_LIMIT", declined_code: "E2001" },
		});
		expect(event?.kind).toBe("declined");
		if (event?.kind === "declined") {
			expect(event.reason).toBe("CONSUMER_EXCEEDS_LIMIT");
		}
	});
});
describe("tamaraDedupKey", () => {
	it("uses capture_id for capture events", () => {
		expect(
			tamaraDedupKey({
				order_id: "ord-1",
				order_reference_id: "ref-1",
				event_type: "order_captured",
				data: { capture_id: "cap-9" },
			}),
		).toBe("tamara:order_captured:cap-9");
	});
	it("uses refund_id for refund events", () => {
		expect(
			tamaraDedupKey({
				order_id: "ord-1",
				order_reference_id: "ref-1",
				event_type: "order_refunded",
				data: { refund_id: "rfd-3" },
			}),
		).toBe("tamara:order_refunded:rfd-3");
	});
	it("uses order_id for AuthoriseMessages", () => {
		expect(
			tamaraDedupKey({
				order_id: "ord-1",
				order_reference_id: "ref-1",
				order_status: "approved",
				data: {},
			}),
		).toBe("tamara:authorise:ord-1");
	});
	it("falls back to {event_type}:{order_id} when no natural id is present", () => {
		expect(
			tamaraDedupKey({
				order_id: "ord-1",
				order_reference_id: "ref-1",
				event_type: "order_expired",
				data: {},
			}),
		).toBe("tamara:order_expired:ord-1");
	});
});
describe("tamaraWebhookDedupKeyForEvent", () => {
	it("matches Tamara's native capture/refund webhook dedup format", () => {
		expect(
			tamaraWebhookDedupKeyForEvent({
				kind: "captured",
				provider: "tamara",
				orderId: "ord-1",
				captureId: "cap-1",
				amountMinor: 10000,
				currency: "SAR",
				raw: {},
			}),
		).toBe("tamara:order_captured:cap-1");
		expect(
			tamaraWebhookDedupKeyForEvent({
				kind: "refunded",
				provider: "tamara",
				orderId: "ord-1",
				refundId: "rfd-1",
				amountMinor: 5000,
				currency: "SAR",
				raw: {},
			}),
		).toBe("tamara:order_refunded:rfd-1");
	});
});
