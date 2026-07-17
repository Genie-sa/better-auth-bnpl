import { describe, expect, it } from "vitest";
import type { BnplCheckoutInput } from "../../../core/types";
import type { TabbyCheckoutData } from "../../../providers/tabby";
import {
	fromTabbyPaymentDetails,
	tabbyDedupKey,
	tabbyStatusToCanonical,
	tabbyToCanonicalEvent,
	tabbyWebhookDedupKeyForEvent,
	toTabbyBuyer,
	toTabbyCheckoutRequest,
} from "../../../providers/tabby/adapter";
import { silentLogger } from "../../_harness";
const baseCheckout: BnplCheckoutInput = {
	orderReferenceId: "ord-1",
	description: "Test order",
	totalAmount: { amount: "500.00", currency: "AED" },
	taxAmount: { amount: "0.00", currency: "AED" },
	shippingAmount: { amount: "0.00", currency: "AED" },
	items: [
		{
			referenceId: "sku-1",
			name: "Keyboard",
			sku: "KB1",
			quantity: 1,
			totalAmount: { amount: "500.00", currency: "AED" },
			unitPrice: { amount: "500.00", currency: "AED" },
		},
	],
	buyer: {
		firstName: "Ali",
		lastName: "Dhamen",
		email: "ali@example.com",
		phone: "+971500000000",
	},
	shippingAddress: { line1: "Sheikh Zayed Rd", city: "Dubai", countryCode: "AE" },
	countryCode: "AE",
	merchantUrl: {
		success: "https://shop/ok",
		failure: "https://shop/no",
		cancel: "https://shop/back",
		notification: "https://shop/api/auth/bnpl/webhooks/tabby",
	},
};
const checkoutProviderData = {
	buyer_history: {
		registered_since: "2024-01-15T12:00:00Z",
		loyalty_level: 2,
		wishlist_count: 1,
		is_phone_number_verified: true,
		is_email_verified: true,
	},
	order_history: [
		{
			purchased_at: "2025-12-10T08:30:00+03:00",
			amount: "250.00",
			payment_method: "card",
			status: "complete",
			buyer: {
				name: "Ali Dhamen",
				email: "ali@example.com",
				phone: "+971500000000",
			},
			shipping_address: {
				address: "Sheikh Zayed Rd",
				city: "Dubai",
				zip: "00000",
			},
			items: [{ quantity: 1, unit_price: "250.00", discount_amount: "0.00" }],
		},
	],
	attachment: {
		body: {
			education_details: {
				merchant_subtype: "courses_training",
				program: { payment_tenure_months: 0, months_to_completion: 0 },
				student_history: { late_payments_count: 0, avg_overdue_duration_days: 0 },
			},
		},
		content_type: "application/vnd.tabby.v1+json",
	},
} satisfies TabbyCheckoutData;
const checkoutHistoryOrder = checkoutProviderData.order_history[0];
if (!checkoutHistoryOrder) throw new Error("checkout history fixture is missing");
describe("toTabbyBuyer", () => {
	it("preserves a provided buyer name after trimming", () => {
		expect(
			toTabbyBuyer({
				...baseCheckout.buyer,
				firstName: " Ali",
				lastName: "Dhamen ",
			}),
		).toMatchObject({
			name: "Ali Dhamen",
			email: "ali@example.com",
			phone: "+971500000000",
		});
	});
	it("sends an empty name when the buyer has no name", () => {
		expect(
			toTabbyBuyer({
				...baseCheckout.buyer,
				firstName: " ",
				lastName: " ",
			}),
		).toMatchObject({
			name: "",
			email: "ali@example.com",
			phone: "+971500000000",
		});
	});
});
describe("toTabbyCheckoutRequest", () => {
	it("translates canonical input to Tabby wire shape", () => {
		const req = toTabbyCheckoutRequest(baseCheckout, { merchantCode: "MERCHANT" });
		expect(req.merchant_code).toBe("MERCHANT");
		expect(req.payment.amount).toBe("500.00");
		expect(req.payment.currency).toBe("AED");
		expect(req.payment.buyer.name).toBe("Ali Dhamen");
		expect(req.payment.shipping_address.address).toBe("Sheikh Zayed Rd");
		expect(req.payment.shipping_address.city).toBe("Dubai");
		expect(req.payment.order.reference_id).toBe("ord-1");
		expect(req.payment.order.items[0]?.title).toBe("Keyboard");
		expect(req.payment.order.items[0]?.unit_price).toBe("500.00");
	});
	it("derives lang from canonical locale", () => {
		expect(
			toTabbyCheckoutRequest({ ...baseCheckout, locale: "ar_SA" }, { merchantCode: "M" }).lang,
		).toBe("ar");
		expect(
			toTabbyCheckoutRequest({ ...baseCheckout, locale: "en" }, { merchantCode: "M" }).lang,
		).toBe("en");
	});
	it("forwards merchant_urls", () => {
		const req = toTabbyCheckoutRequest(baseCheckout, { merchantCode: "M" });
		expect(req.merchant_urls.success).toBe("https://shop/ok");
		expect(req.merchant_urls.cancel).toBe("https://shop/back");
		expect(req.merchant_urls.failure).toBe("https://shop/no");
	});
	it("concatenates address line1 + line2", () => {
		const req = toTabbyCheckoutRequest(
			{
				...baseCheckout,
				shippingAddress: { ...baseCheckout.shippingAddress, line2: "Floor 5" },
			},
			{ merchantCode: "M" },
		);
		expect(req.payment.shipping_address.address).toBe("Sheikh Zayed Rd, Floor 5");
	});
	it("validates and maps trusted checkout provider data to Tabby's payment fields", () => {
		const req = toTabbyCheckoutRequest(
			{ ...baseCheckout, providerData: checkoutProviderData },
			{ merchantCode: "M" },
		);
		expect(req.payment.buyer_history).toEqual(checkoutProviderData.buyer_history);
		expect(req.payment.order_history).toEqual(checkoutProviderData.order_history);
		expect(req.payment.attachment).toEqual({
			body: JSON.stringify({
				education_details: {
					merchant_subtype: "courses_training",
					program: { payment_tenure_months: 0, months_to_completion: 0 },
					student_history: { late_payments_count: 0, avg_overdue_duration_days: 0 },
				},
			}),
			content_type: "application/vnd.tabby.v1+json",
		});
	});
	it("preserves the previous payment shape when checkout provider data is absent", () => {
		const req = toTabbyCheckoutRequest(baseCheckout, { merchantCode: "M" });
		expect(req.payment).not.toHaveProperty("buyer_history");
		expect(req.payment).not.toHaveProperty("order_history");
		expect(req.payment).not.toHaveProperty("attachment");
	});
	it.each([
		[
			"registered date",
			{
				...checkoutProviderData,
				buyer_history: { ...checkoutProviderData.buyer_history, registered_since: "not-a-date" },
			},
		],
		[
			"negative loyalty",
			{
				...checkoutProviderData,
				buyer_history: { ...checkoutProviderData.buyer_history, loyalty_level: -1 },
			},
		],
		[
			"money",
			{
				...checkoutProviderData,
				order_history: [{ ...checkoutHistoryOrder, amount: "-1.00" }],
			},
		],
		[
			"status",
			{
				...checkoutProviderData,
				order_history: [{ ...checkoutHistoryOrder, status: "paid" }],
			},
		],
		[
			"buyer",
			{
				...checkoutProviderData,
				order_history: [
					{
						...checkoutHistoryOrder,
						buyer: { ...checkoutHistoryOrder.buyer, email: "invalid" },
					},
				],
			},
		],
		[
			"address",
			{
				...checkoutProviderData,
				order_history: [
					{
						...checkoutHistoryOrder,
						shipping_address: { address: "Road", city: "Dubai" },
					},
				],
			},
		],
		[
			"history limit",
			{
				...checkoutProviderData,
				order_history: Array.from({ length: 11 }, () => checkoutHistoryOrder),
			},
		],
		[
			"attachment",
			{
				...checkoutProviderData,
				attachment: { ...checkoutProviderData.attachment, content_type: "application/json" },
			},
		],
		[
			"fractional education month",
			{
				...checkoutProviderData,
				attachment: {
					...checkoutProviderData.attachment,
					body: {
						education_details: {
							...checkoutProviderData.attachment.body.education_details,
							program: { payment_tenure_months: 1.5, months_to_completion: 0 },
						},
					},
				},
			},
		],
	])("rejects invalid checkout provider data: %s", (_label, providerData) => {
		expect(() =>
			toTabbyCheckoutRequest({ ...baseCheckout, providerData }, { merchantCode: "M" }),
		).toThrow("tabby: checkout providerData is invalid");
	});
});
describe("tabbyStatusToCanonical", () => {
	it("CREATED → new", () => {
		expect(tabbyStatusToCanonical("CREATED", 50000, 0, 0)).toBe("new");
	});
	it("AUTHORIZED with no captures → authorised", () => {
		expect(tabbyStatusToCanonical("AUTHORIZED", 50000, 0, 0)).toBe("authorised");
	});
	it("AUTHORIZED with a partial capture → partially_captured (Tabby keeps partials AUTHORIZED)", () => {
		expect(tabbyStatusToCanonical("AUTHORIZED", 50000, 20000, 0)).toBe("partially_captured");
	});
	it("CLOSED disambiguates by cumulative amounts in refund→capture→cancel priority", () => {
		expect(tabbyStatusToCanonical("CLOSED", 50000, 50000, 0)).toBe("fully_captured");
		expect(tabbyStatusToCanonical("CLOSED", 50000, 20000, 0)).toBe("closed");
		expect(tabbyStatusToCanonical("CLOSED", 50000, 0, 0)).toBe("canceled");
		expect(tabbyStatusToCanonical("CLOSED", 50000, 50000, 50000)).toBe("fully_refunded");
		expect(tabbyStatusToCanonical("CLOSED", 50000, 50000, 25000)).toBe("partially_refunded");
	});
	it("REJECTED → declined, EXPIRED → expired", () => {
		expect(tabbyStatusToCanonical("REJECTED", 0, 0, 0)).toBe("declined");
		expect(tabbyStatusToCanonical("EXPIRED", 0, 0, 0)).toBe("expired");
	});
	it("accepts lowercase wire statuses (webhook casing)", () => {
		expect(tabbyStatusToCanonical("authorized", 50000, 0, 0)).toBe("authorised");
		expect(tabbyStatusToCanonical("closed", 50000, 50000, 0)).toBe("fully_captured");
	});
	it("falls back to `new` with a warn for statuses outside the documented enum", () => {
		const warnings: string[] = [];
		const logger = { warn: (msg: string) => warnings.push(msg) };
		expect(tabbyStatusToCanonical("CAPTURED", 50000, 50000, 0, logger)).toBe("new");
		expect(tabbyStatusToCanonical("SOMETHING_NEW", 50000, 0, 0, logger)).toBe("new");
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toMatch(/unknown payment status "CAPTURED"/);
	});
});
describe("tabbyToCanonicalEvent", () => {
	const authorizeDelivery = {
		id: "pay-1",
		created_at: "2026-06-04T10:00:00Z",
		expires_at: "2026-06-04T11:00:00Z",
		closed_at: null,
		status: "authorized",
		is_test: true,
		is_expired: false,
		amount: "500.00",
		currency: "AED",
		order: { reference_id: "ref-1" },
		captures: [],
		refunds: [],
		meta: null,
		token: "tok-1",
	};
	it("infers `authorized` from an authorize delivery with empty captures", () => {
		const event = tabbyToCanonicalEvent(authorizeDelivery);
		expect(event?.kind).toBe("authorized");
		if (event?.kind === "authorized") {
			expect(event.orderId).toBe("pay-1");
			expect(event.orderReferenceId).toBe("ref-1");
		}
	});
	it("infers `captured` from a capture delivery (status authorized + a captures[] record)", () => {
		const event = tabbyToCanonicalEvent({
			...authorizeDelivery,
			status: "authorized",
			captures: [{ id: "cap-1", amount: "200.00" }],
		});
		expect(event?.kind).toBe("captured");
		if (event?.kind === "captured") {
			expect(event.captureId).toBe("cap-1");
			expect(event.amountMinor).toBe(20000);
			expect(event.currency).toBe("AED");
		}
	});
	it("uses the latest capture record as the delta on a second capture delivery", () => {
		const event = tabbyToCanonicalEvent({
			...authorizeDelivery,
			status: "authorized",
			captures: [
				{ id: "cap-1", amount: "200.00" },
				{ id: "cap-2", amount: "100.00" },
			],
		});
		expect(event?.kind).toBe("captured");
		if (event?.kind === "captured") {
			expect(event.captureId).toBe("cap-2");
			expect(event.amountMinor).toBe(10000);
		}
	});
	it("infers `captured` from a full-capture delivery that arrives as CLOSED", () => {
		const event = tabbyToCanonicalEvent({
			...authorizeDelivery,
			status: "closed",
			closed_at: "2026-06-04T10:30:00Z",
			captures: [{ id: "cap-1", amount: "500.00" }],
		});
		expect(event?.kind).toBe("captured");
		if (event?.kind === "captured") {
			expect(event.captureId).toBe("cap-1");
			expect(event.amountMinor).toBe(50000);
		}
	});
	it("infers `refunded` from a refund delivery (status closed + a refunds[] record), refund taking precedence over the capture", () => {
		const event = tabbyToCanonicalEvent({
			...authorizeDelivery,
			status: "closed",
			closed_at: "2026-06-04T10:30:00Z",
			captures: [{ id: "cap-1", amount: "500.00" }],
			refunds: [{ id: "rfd-1", amount: "100.00" }],
		});
		expect(event?.kind).toBe("refunded");
		if (event?.kind === "refunded") {
			expect(event.refundId).toBe("rfd-1");
			expect(event.amountMinor).toBe(10000);
		}
	});
	it("maps a close-with-no-refunds delivery to `updated`", () => {
		const event = tabbyToCanonicalEvent({
			...authorizeDelivery,
			status: "closed",
			closed_at: "2026-06-04T10:30:00Z",
			captures: [],
			refunds: [],
		});
		expect(event?.kind).toBe("updated");
	});
	it("maps a rejected delivery to `declined`", () => {
		const event = tabbyToCanonicalEvent({
			...authorizeDelivery,
			status: "rejected",
			captures: [],
			refunds: [],
		});
		expect(event?.kind).toBe("declined");
	});
	it("maps an expired delivery to `expired`", () => {
		const event = tabbyToCanonicalEvent({
			...authorizeDelivery,
			status: "expired",
			is_expired: true,
			captures: [],
			refunds: [],
		});
		expect(event?.kind).toBe("expired");
	});
	it("returns null for missing payment id", () => {
		expect(tabbyToCanonicalEvent({})).toBeNull();
	});
});
describe("tabbyDedupKey", () => {
	it("uses the latest capture id for a lowercase-authorized capture delivery", () => {
		const key = tabbyDedupKey({
			id: "pay-1",
			status: "authorized",
			captures: [
				{ id: "cap-1", amount: "100.00" },
				{ id: "cap-2", amount: "200.00" },
			],
		});
		expect(key).toBe("tabby:captured:cap-2");
	});
	it("uses the latest capture id for a full-capture delivery that arrives as closed", () => {
		const key = tabbyDedupKey({
			id: "pay-1",
			status: "closed",
			captures: [{ id: "cap-1", amount: "500.00" }],
			refunds: [],
		});
		expect(key).toBe("tabby:captured:cap-1");
	});
	it("uses the latest refund id for a refund delivery, taking precedence over captures", () => {
		const key = tabbyDedupKey({
			id: "pay-1",
			status: "closed",
			captures: [{ id: "cap-1", amount: "500.00" }],
			refunds: [{ id: "rfd-1", amount: "50.00" }],
		});
		expect(key).toBe("tabby:refunded:rfd-1");
	});
	it("falls back to status:payment_id for deliveries with no capture/refund delta", () => {
		expect(tabbyDedupKey({ id: "pay-1", status: "authorized" })).toBe("tabby:AUTHORIZED:pay-1");
		expect(tabbyDedupKey({ id: "pay-1", status: "closed", captures: [], refunds: [] })).toBe(
			"tabby:CLOSED:pay-1",
		);
	});
});
describe("tabbyWebhookDedupKeyForEvent", () => {
	it("matches Tabby's native capture/refund webhook dedup format", () => {
		expect(
			tabbyWebhookDedupKeyForEvent({
				kind: "captured",
				provider: "tabby",
				orderId: "pay-1",
				captureId: "cap-1",
				amountMinor: 10000,
				currency: "SAR",
				raw: {},
			}),
		).toBe("tabby:captured:cap-1");
		expect(
			tabbyWebhookDedupKeyForEvent({
				kind: "refunded",
				provider: "tabby",
				orderId: "pay-1",
				refundId: "rfd-1",
				amountMinor: 5000,
				currency: "SAR",
				raw: {},
			}),
		).toBe("tabby:refunded:rfd-1");
	});
});
describe("fromTabbyPaymentDetails", () => {
	it("computes cumulative captured/refunded from the payment payload", () => {
		const result = fromTabbyPaymentDetails(
			{
				id: "pay-1",
				status: "CLOSED",
				amount: "500.00",
				currency: "AED",
				captures: [
					{ id: "c1", amount: "200.00" },
					{ id: "c2", amount: "300.00" },
				],
				refunds: [{ id: "r1", amount: "100.00" }],
			},
			silentLogger,
		);
		expect(result.totalMinor).toBe(50000);
		expect(result.capturedMinor).toBe(50000);
		expect(result.refundedMinor).toBe(10000);
		expect(result.status).toBe("partially_refunded");
	});
	it("derives the real Tabby lifecycle statuses from the retrieved payment", () => {
		const partialCapture = fromTabbyPaymentDetails(
			{
				id: "pay-1",
				status: "AUTHORIZED",
				amount: "500.00",
				currency: "AED",
				captures: [{ id: "c1", amount: "200.00" }],
			},
			silentLogger,
		);
		expect(partialCapture.status).toBe("partially_captured");
		const fullyCaptured = fromTabbyPaymentDetails(
			{
				id: "pay-1",
				status: "CLOSED",
				amount: "500.00",
				currency: "AED",
				captures: [{ id: "c1", amount: "500.00" }],
			},
			silentLogger,
		);
		expect(fullyCaptured.status).toBe("fully_captured");
		const partialThenClosed = fromTabbyPaymentDetails(
			{
				id: "pay-1",
				status: "CLOSED",
				amount: "500.00",
				currency: "AED",
				captures: [{ id: "c1", amount: "200.00" }],
			},
			silentLogger,
		);
		expect(partialThenClosed.status).toBe("closed");
		const canceled = fromTabbyPaymentDetails(
			{ id: "pay-1", status: "CLOSED", amount: "500.00", currency: "AED", captures: [] },
			silentLogger,
		);
		expect(canceled.status).toBe("canceled");
	});
});
