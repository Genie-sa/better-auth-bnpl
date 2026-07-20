import { z } from "zod";
import { absoluteUrlMax1024Schema, absoluteUrlSchema } from "../../core/url";
const nonEmptyStringSchema = z.string().min(1);
const decimalStringSchema = z.string().min(1);
const nonNegativeDecimalStringSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
const dateTimeSchema = z.string().datetime({ offset: true });
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
	name: z.string(),
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
export const tabbyBuyerHistoryRequestSchema = z
	.object({
		registered_since: dateTimeSchema,
		loyalty_level: z.number().nonnegative(),
		wishlist_count: z.number().int().nonnegative().optional(),
		is_phone_number_verified: z.boolean().optional(),
		is_email_verified: z.boolean().optional(),
		is_social_networks_connected: z.boolean().optional(),
	})
	.strict();
const tabbyHistoryBuyerSchema = z
	.object({
		name: nonEmptyStringSchema,
		email: z.string().email(),
		phone: nonEmptyStringSchema,
		dob: z.string().date().optional(),
	})
	.strict();
const tabbyHistoryShippingAddressSchema = z
	.object({
		address: nonEmptyStringSchema,
		city: nonEmptyStringSchema,
		zip: nonEmptyStringSchema,
	})
	.strict();
const tabbyOrderItemHistorySchema = z
	.object({
		reference_id: z.string().optional(),
		title: z.string().optional(),
		description: z.string().optional(),
		quantity: z.number().positive(),
		unit_price: nonNegativeDecimalStringSchema,
		discount_amount: nonNegativeDecimalStringSchema,
		image_url: absoluteUrlMax1024Schema.optional(),
		product_url: absoluteUrlMax1024Schema.optional(),
		gender: z.enum(["Male", "Female", "Kids", "Other"]).optional(),
		category: z.string().optional(),
		color: z.string().optional(),
		product_material: z.string().optional(),
		size_type: z.string().optional(),
		size: z.string().optional(),
		brand: z.string().optional(),
		is_refundable: z.boolean().optional(),
		barcode: z.string().optional(),
		ppn: z.string().optional(),
		seller: z.string().optional(),
	})
	.strict();
export const tabbyCheckoutCreationOrderHistorySchema = z
	.object({
		purchased_at: dateTimeSchema,
		amount: nonNegativeDecimalStringSchema,
		payment_method: z.enum(["card", "cod"]).optional(),
		status: z.enum(["new", "processing", "complete", "refunded", "canceled", "unknown"]),
		buyer: tabbyHistoryBuyerSchema,
		shipping_address: tabbyHistoryShippingAddressSchema.optional(),
		items: z.array(tabbyOrderItemHistorySchema).optional(),
	})
	.strict();
export const tabbyEducationAttachmentSchema = z
	.object({
		body: z
			.object({
				education_details: z
					.object({
						merchant_subtype: z.enum(["formal_education", "courses_training"]),
						program: z
							.object({
								payment_tenure_months: z.number().int().nonnegative(),
								months_to_completion: z.number().int().nonnegative(),
							})
							.strict(),
						student_history: z
							.object({
								late_payments_count: z.number().int().nonnegative(),
								avg_overdue_duration_days: z.number().nonnegative(),
								observation_window_months: z.number().int().nonnegative().optional(),
							})
							.strict(),
					})
					.strict(),
			})
			.strict(),
		content_type: z.literal("application/vnd.tabby.v1+json"),
	})
	.strict();
const tabbyEducationAttachmentRequestSchema = z
	.object({
		body: nonEmptyStringSchema,
		content_type: z.literal("application/vnd.tabby.v1+json"),
	})
	.strict();
export const tabbyCheckoutDataSchema = z
	.object({
		buyer_history: tabbyBuyerHistoryRequestSchema,
		order_history: z.array(tabbyCheckoutCreationOrderHistorySchema).max(10),
		attachment: tabbyEducationAttachmentSchema,
	})
	.strict();
export const tabbyPaymentRequestSchema = z.object({
	amount: decimalStringSchema,
	currency: nonEmptyStringSchema,
	description: z.string().optional(),
	buyer: tabbyBuyerRequestSchema,
	shipping_address: tabbyShippingAddressRequestSchema.optional(),
	order: tabbyOrderRequestSchema,
	buyer_history: tabbyBuyerHistoryRequestSchema.optional(),
	order_history: z.array(tabbyCheckoutCreationOrderHistorySchema).max(10).optional(),
	attachment: tabbyEducationAttachmentRequestSchema.optional(),
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
