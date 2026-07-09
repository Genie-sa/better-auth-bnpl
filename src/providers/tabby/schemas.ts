import { z } from "zod";
import { absoluteUrlMax1024Schema, absoluteUrlSchema } from "../../core/url";
const nonEmptyStringSchema = z.string().min(1);
const decimalStringSchema = z.string().min(1);
export const tabbyWebhookHeaderSchema = z.object({
	title: nonEmptyStringSchema,
	value: nonEmptyStringSchema,
});
export const tabbyMerchantUrlsRequestSchema = z.object({
	success: absoluteUrlSchema,
	cancel: absoluteUrlSchema,
	failure: absoluteUrlSchema,
});
export const tabbyBuyerRequestSchema = z.object({
	name: nonEmptyStringSchema,
	email: nonEmptyStringSchema,
	phone: nonEmptyStringSchema,
	dob: z.string().optional(),
});
export const tabbyEligibilityBuyerRequestSchema = z.object({
	email: nonEmptyStringSchema,
	phone: nonEmptyStringSchema,
});
export const tabbyShippingAddressRequestSchema = z.object({
	address: nonEmptyStringSchema,
	city: nonEmptyStringSchema,
	zip: z.string().optional(),
});
export const tabbyOrderItemRequestSchema = z.object({
	reference_id: nonEmptyStringSchema,
	title: nonEmptyStringSchema,
	quantity: z.number().positive(),
	unit_price: decimalStringSchema,
	category: z.string().optional(),
	description: z.string().optional(),
	discount_amount: decimalStringSchema.optional(),
	image_url: absoluteUrlMax1024Schema.optional(),
	product_url: absoluteUrlMax1024Schema.optional(),
});
export const tabbyOrderRequestSchema = z.object({
	reference_id: nonEmptyStringSchema,
	tax_amount: decimalStringSchema.optional(),
	shipping_amount: decimalStringSchema.optional(),
	discount_amount: decimalStringSchema.optional(),
	items: z.array(tabbyOrderItemRequestSchema).min(1),
	updated_at: z.string().optional(),
});
export const tabbyBuyerHistoryRequestSchema = z.object({
	registered_since: z.string().optional(),
	loyalty_level: z.number().optional(),
	wishlist_count: z.number().optional(),
	is_phone_number_verified: z.boolean().optional(),
	is_email_verified: z.boolean().optional(),
	is_social_networks_connected: z.boolean().optional(),
});
export const tabbyPaymentRequestSchema = z.object({
	amount: decimalStringSchema,
	currency: nonEmptyStringSchema,
	description: z.string().optional(),
	buyer: tabbyBuyerRequestSchema,
	shipping_address: tabbyShippingAddressRequestSchema,
	order: tabbyOrderRequestSchema,
	buyer_history: tabbyBuyerHistoryRequestSchema.optional(),
	order_history: z.array(z.unknown()).optional(),
	meta: z.record(z.string(), z.unknown()).optional(),
});
export const tabbyEligibilityPaymentRequestSchema = z.object({
	amount: decimalStringSchema,
	currency: nonEmptyStringSchema,
	buyer: tabbyEligibilityBuyerRequestSchema,
});
export const tabbyCheckoutRequestSchema = z.object({
	payment: tabbyPaymentRequestSchema,
	lang: z.enum(["en", "ar"]),
	merchant_code: nonEmptyStringSchema,
	merchant_urls: tabbyMerchantUrlsRequestSchema,
	token: z.string().nullable().optional(),
});
export const tabbyEligibilityCheckRequestSchema = z.object({
	payment: tabbyEligibilityPaymentRequestSchema,
	merchant_code: nonEmptyStringSchema,
	lang: z.enum(["en", "ar"]).optional(),
});
export const tabbyCaptureRequestSchema = z.object({
	amount: decimalStringSchema,
	reference_id: nonEmptyStringSchema,
	tax_amount: decimalStringSchema.optional(),
	shipping_amount: decimalStringSchema.optional(),
	discount_amount: decimalStringSchema.optional(),
	items: z.array(tabbyOrderItemRequestSchema).optional(),
});
export const tabbyUpdatePaymentReferenceRequestSchema = z.object({
	order: z.object({
		reference_id: nonEmptyStringSchema,
	}),
});
export const tabbyRefundRequestSchema = z.object({
	amount: decimalStringSchema,
	reference_id: nonEmptyStringSchema,
	reason: z.string().optional(),
	items: z.array(tabbyOrderItemRequestSchema).optional(),
});
export const tabbyRegisterWebhookRequestSchema = z.object({
	url: absoluteUrlSchema,
	is_test: z.boolean().optional(),
	header: tabbyWebhookHeaderSchema.optional(),
});
export const tabbyUpdateWebhookRequestSchema = z.object({
	url: absoluteUrlSchema,
	header: tabbyWebhookHeaderSchema.optional(),
});
const tabbyCaptureRecordSchema = z
	.object({
		id: z.string(),
		amount: z.string(),
		created_at: z.string().optional(),
		reference_id: z.string().optional(),
	})
	.passthrough();
const tabbyRefundRecordSchema = z
	.object({
		id: z.string(),
		amount: z.string(),
		created_at: z.string().optional(),
		reference_id: z.string().optional(),
		reason: z.string().optional(),
	})
	.passthrough();
export const tabbyPaymentDetailsSchema = z
	.object({
		id: z.string(),
		status: z.string(),
		amount: z.string(),
		currency: z.string(),
		created_at: z.string().optional(),
		captures: z.array(tabbyCaptureRecordSchema).optional(),
		refunds: z.array(tabbyRefundRecordSchema).optional(),
	})
	.passthrough();
const tabbyProductOptionSchema = z
	.object({
		web_url: absoluteUrlSchema,
		qr_code: z.string().optional(),
	})
	.passthrough();
const tabbyProductInfoSchema = z
	.object({
		type: z.string(),
		is_available: z.boolean(),
		rejection_reason: z.string().nullable().optional(),
	})
	.passthrough();
export const tabbyCheckoutResponseSchema = z
	.object({
		id: z.string(),
		status: z.enum(["created", "rejected", "expired", "approved"]),
		configuration: z
			.object({
				available_products: z
					.object({
						installments: z.array(tabbyProductOptionSchema).optional(),
						pay_later: z.array(tabbyProductOptionSchema).optional(),
						pay_in_full: z.array(tabbyProductOptionSchema).optional(),
					})
					.passthrough()
					.optional(),
				products: z.record(z.string(), tabbyProductInfoSchema).optional(),
			})
			.passthrough(),
		token: z.string().nullable().optional(),
		payment: tabbyPaymentDetailsSchema,
	})
	.passthrough();
const tabbyWebhookResponseHeaderSchema = z
	.object({
		title: z.string().nullable().optional(),
		value: z.string().nullable().optional(),
	})
	.passthrough();
export const tabbyWebhookRegistrationResponseSchema = z
	.object({
		id: z.string(),
		url: z.string(),
		is_test: z.boolean(),
		header: tabbyWebhookResponseHeaderSchema.nullable().optional(),
	})
	.passthrough();
export const tabbyListWebhooksResponseSchema = z.union([
	tabbyWebhookRegistrationResponseSchema,
	z.array(tabbyWebhookRegistrationResponseSchema),
	z.null(),
]);
export const tabbyWebhookUpdateResponseSchema = z
	.object({
		id: z.string(),
		url: z.string(),
		header: tabbyWebhookResponseHeaderSchema.nullable().optional(),
	})
	.passthrough();
export const tabbyDeleteWebhookResponseSchema = z
	.object({
		status: z.string().optional(),
	})
	.passthrough();
