import { z } from "zod";
import { absoluteUrlMax1024Schema, absoluteUrlSchema } from "../../core/url";
import {
	TAMARA_COUNTRY_CODES,
	TAMARA_CURRENCIES,
	TAMARA_LOCALES,
	TAMARA_PAYMENT_TYPES,
} from "./constants";
const nonEmptyStringSchema = z.string().min(1);
const tamaraCountryCodeSchema = z.enum(TAMARA_COUNTRY_CODES);
const tamaraCurrencySchema = z.enum(TAMARA_CURRENCIES);
const tamaraLocaleSchema = z.enum(TAMARA_LOCALES);
const tamaraPaymentTypeSchema = z.enum(TAMARA_PAYMENT_TYPES);
export const tamaraMoneySchema = z
	.object({
		amount: z.union([z.number(), z.string()]),
		currency: z.string(),
	})
	.passthrough();
export const tamaraMoneyRequestSchema = z.object({
	amount: z.union([z.number(), z.string()]),
	currency: tamaraCurrencySchema,
});
export const tamaraAddressRequestSchema = z.object({
	first_name: z.string(),
	last_name: z.string(),
	line1: nonEmptyStringSchema,
	line2: z.string().optional(),
	region: z.string().optional(),
	postal_code: z.string().optional(),
	city: nonEmptyStringSchema,
	country_code: tamaraCountryCodeSchema,
	phone_number: z.string().optional(),
});
export const tamaraConsumerRequestSchema = z.object({
	first_name: nonEmptyStringSchema,
	last_name: nonEmptyStringSchema,
	email: nonEmptyStringSchema,
	phone_number: nonEmptyStringSchema,
	national_id: z.string().optional(),
	date_of_birth: z.string().optional(),
	is_first_order: z.boolean().optional(),
});
export const tamaraOrderItemRequestSchema = z.object({
	reference_id: nonEmptyStringSchema,
	type: nonEmptyStringSchema,
	name: nonEmptyStringSchema.max(255),
	sku: nonEmptyStringSchema.max(128),
	image_url: absoluteUrlMax1024Schema.optional(),
	item_url: absoluteUrlMax1024Schema.optional(),
	quantity: z.number().positive(),
	unit_price: tamaraMoneyRequestSchema.optional(),
	total_amount: tamaraMoneyRequestSchema,
	tax_amount: tamaraMoneyRequestSchema.optional(),
	discount_amount: tamaraMoneyRequestSchema.optional(),
});
export const tamaraMerchantUrlRequestSchema = z.object({
	success: absoluteUrlSchema,
	failure: absoluteUrlSchema,
	cancel: absoluteUrlSchema,
	notification: absoluteUrlSchema.optional(),
});
export const tamaraCheckoutRequestSchema = z.object({
	order_reference_id: nonEmptyStringSchema,
	order_number: z.string().optional(),
	total_amount: tamaraMoneyRequestSchema,
	description: nonEmptyStringSchema.max(256),
	country_code: tamaraCountryCodeSchema,
	payment_type: tamaraPaymentTypeSchema.optional(),
	instalments: z.number().int().positive().optional(),
	locale: tamaraLocaleSchema.optional(),
	items: z.array(tamaraOrderItemRequestSchema).min(1),
	consumer: tamaraConsumerRequestSchema,
	shipping_address: tamaraAddressRequestSchema,
	billing_address: tamaraAddressRequestSchema.optional(),
	discount: z
		.object({
			name: nonEmptyStringSchema,
			amount: tamaraMoneyRequestSchema,
		})
		.optional(),
	tax_amount: tamaraMoneyRequestSchema,
	shipping_amount: tamaraMoneyRequestSchema,
	merchant_url: tamaraMerchantUrlRequestSchema,
	platform: z.string().optional(),
	is_mobile: z.boolean().optional(),
	expires_in_minutes: z.number().int().min(5).max(1440).optional(),
	additional_data: z.record(z.string(), z.unknown()).optional(),
	risk_assessment: z.record(z.string(), z.unknown()).optional(),
});
export const tamaraCaptureBodySchema = z.object({
	order_id: nonEmptyStringSchema,
	total_amount: tamaraMoneyRequestSchema,
	shipping_info: z.object({
		shipped_at: nonEmptyStringSchema,
		shipping_company: nonEmptyStringSchema.max(100),
		tracking_number: z.string().max(100).optional(),
		tracking_url: absoluteUrlMax1024Schema.optional(),
	}),
	shipping_amount: tamaraMoneyRequestSchema.optional(),
	tax_amount: tamaraMoneyRequestSchema.optional(),
	discount_amount: tamaraMoneyRequestSchema.optional(),
	items: z.array(tamaraOrderItemRequestSchema).optional(),
});
export const tamaraSimplifiedRefundBodySchema = z.object({
	total_amount: tamaraMoneyRequestSchema,
	comment: nonEmptyStringSchema,
	merchant_refund_id: z.string().optional(),
});
export const tamaraCancelBodySchema = z.object({
	total_amount: tamaraMoneyRequestSchema,
	shipping_amount: tamaraMoneyRequestSchema.optional(),
	tax_amount: tamaraMoneyRequestSchema.optional(),
	discount_amount: tamaraMoneyRequestSchema.optional(),
	items: z.array(tamaraOrderItemRequestSchema).optional(),
});
export const tamaraVoidQuerySchema = z.object({
	order_id: nonEmptyStringSchema,
	store_code: z.string().optional(),
});
export const tamaraPreCheckoutEligibilityRequestSchema = z.object({
	order: z.object({
		amount: z.number().nonnegative(),
		currency: tamaraCurrencySchema,
	}),
	customer: z.object({
		phone: nonEmptyStringSchema,
	}),
});
export const tamaraRegisterWebhookRequestSchema = z.object({
	type: z.enum(["order", "dispute"]),
	events: z.array(nonEmptyStringSchema).min(1),
	url: absoluteUrlSchema,
	headers: z.record(z.string(), z.string()).optional(),
});
export const tamaraUpdateWebhookRequestSchema = z.object({
	url: absoluteUrlSchema,
	events: z.array(nonEmptyStringSchema).min(1),
	headers: z.record(z.string(), z.string()).optional(),
});
export const tamaraUpdateReferenceIdRequestSchema = z.object({
	order_reference_id: nonEmptyStringSchema,
});
export const tamaraCheckoutResponseSchema = z
	.object({
		order_id: z.string(),
		checkout_id: z.string(),
		checkout_url: absoluteUrlSchema,
		status: z.string(),
	})
	.passthrough();
export const tamaraOrderDetailsResponseSchema = z
	.object({
		order_id: z.string(),
		order_reference_id: z.string(),
		status: z.string(),
		total_amount: tamaraMoneySchema,
		captured_amount: tamaraMoneySchema.optional(),
		refunded_amount: tamaraMoneySchema.optional(),
	})
	.passthrough();
export const tamaraAuthoriseResponseSchema = z
	.object({
		order_id: z.string(),
		status: z.string(),
	})
	.passthrough();
export const tamaraCaptureResponseSchema = z
	.object({
		capture_id: z.string(),
		order_id: z.string(),
	})
	.passthrough();
export const tamaraSimplifiedRefundResponseSchema = z
	.object({
		refund_id: z.string(),
		order_id: z.string(),
	})
	.passthrough();
export const tamaraCancelResponseSchema = z
	.object({
		order_id: z.string(),
		status: z.string(),
	})
	.passthrough();
export const tamaraVoidResponseSchema = z
	.object({
		order_was_voided: z.boolean(),
	})
	.passthrough();
export const tamaraPreCheckoutEligibilityResponseSchema = z
	.object({
		is_eligible: z.boolean(),
	})
	.passthrough();
export const tamaraWebhookRegistrationResponseSchema = z
	.object({
		webhook_id: z.string(),
	})
	.passthrough();
export const tamaraWebhookDetailsResponseSchema = z
	.object({
		webhook_id: z.string(),
		url: z.string(),
		events: z.array(z.string()),
		type: z.string().optional(),
		headers: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();
export const tamaraUpdateReferenceIdResponseSchema = z
	.object({
		order_id: z.string().optional(),
		message: z.string().optional(),
	})
	.passthrough();
