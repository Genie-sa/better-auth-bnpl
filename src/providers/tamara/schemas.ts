import { z } from "zod";
import { parseAmount } from "../../core/money";
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
const tamaraHistoryDateSchema = z.string().refine((value) => {
	if (!/^\d{2}-\d{2}-\d{4}$/.test(value)) return false;
	const [day, month, year] = value.split("-").map(Number);
	if (day === undefined || month === undefined || year === undefined || year < 1000) return false;
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}, "Expected a valid date in dd-mm-yyyy format");
export const tamaraRiskAssessmentSchema = z
	.object({
		is_premium_customer: z.boolean(),
		account_creation_date: tamaraHistoryDateSchema,
		total_order_count: z.number().int().nonnegative(),
		date_first_paid: tamaraHistoryDateSchema.nullable(),
		date_last_paid: tamaraHistoryDateSchema.nullable(),
		risk_score: z.number().int().optional(),
		order_count_last_24h: z.number().int().nonnegative().optional(),
		account_security: z
			.object({
				is_email_verified: z.boolean().optional(),
				is_phone_verified: z.boolean().optional(),
				password_last_changed: tamaraHistoryDateSchema.optional(),
				last_login_date: tamaraHistoryDateSchema.optional(),
				last_verification_method: nonEmptyStringSchema.optional(),
				device_id: nonEmptyStringSchema.optional(),
				devices_linked: z.number().int().nonnegative().optional(),
			})
			.optional(),
	})
	.passthrough();
export const tamaraProviderDataSchema = z.object({ riskAssessment: tamaraRiskAssessmentSchema });
export const tamaraMoneySchema = z
	.object({
		amount: z.union([z.number(), z.string()]),
		currency: z.string(),
	})
	.passthrough();
export const tamaraMoneyRequestSchema = z
	.object({
		amount: z.union([z.number(), z.string()]),
		currency: tamaraCurrencySchema,
	})
	.refine((money) => {
		try {
			parseAmount(money);
			return true;
		} catch {
			return false;
		}
	}, "Amount must be nonnegative and use the currency's precision");
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
	risk_assessment: tamaraRiskAssessmentSchema.optional(),
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
		phone_number: nonEmptyStringSchema.optional(),
		email: z.string().email().optional(),
	}),
});
export const tamaraRegisterWebhookRequestSchema = z.object({
	type: z.enum(["order", "dispute"]),
	events: z.array(nonEmptyStringSchema).min(1),
	url: absoluteUrlSchema.refine(
		(url) => url.startsWith("https://") && url.length <= 255,
		"Webhook URL must use HTTPS and contain at most 255 characters",
	),
	headers: z.record(z.string(), z.string()).optional(),
});
export const tamaraUpdateWebhookRequestSchema = z.object({
	url: absoluteUrlSchema.refine(
		(url) => url.startsWith("https://") && url.length <= 255,
		"Webhook URL must use HTTPS and contain at most 255 characters",
	),
	events: z.array(nonEmptyStringSchema).min(1),
	headers: z.record(z.string(), z.string()).optional(),
});
export const tamaraUpdateReferenceIdRequestSchema = z.object({
	order_reference_id: nonEmptyStringSchema,
});
export const tamaraCheckoutResponseSchema = z
	.object({
		order_id: nonEmptyStringSchema,
		checkout_id: z.string(),
		checkout_url: absoluteUrlSchema,
		status: z.string(),
	})
	.passthrough();
export const tamaraOrderDetailsResponseSchema = z
	.object({
		order_id: nonEmptyStringSchema,
		order_reference_id: z.string(),
		status: z.string(),
		total_amount: tamaraMoneySchema,
		captured_amount: tamaraMoneySchema.optional(),
		refunded_amount: tamaraMoneySchema.optional(),
		canceled_amount: tamaraMoneySchema.optional(),
		transactions: z
			.object({
				captures: z.array(
					z
						.object({
							capture_id: nonEmptyStringSchema,
							order_id: nonEmptyStringSchema.optional(),
							total_amount: tamaraMoneySchema,
							refunded_amount: tamaraMoneySchema.optional(),
						})
						.passthrough(),
				),
				cancels: z
					.array(
						z
							.object({
								cancel_id: nonEmptyStringSchema,
								order_id: nonEmptyStringSchema.optional(),
								total_amount: tamaraMoneySchema,
							})
							.passthrough(),
					)
					.optional(),
				refunds: z.array(
					z
						.object({
							refund_id: nonEmptyStringSchema,
							capture_id: nonEmptyStringSchema,
							total_amount: tamaraMoneySchema,
							refund_status: nonEmptyStringSchema,
						})
						.passthrough(),
				),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();
export const tamaraAuthoriseResponseSchema = z
	.object({
		order_id: nonEmptyStringSchema,
		status: z.string(),
	})
	.passthrough();
export const tamaraCaptureResponseSchema = z
	.object({
		capture_id: nonEmptyStringSchema,
		order_id: nonEmptyStringSchema,
		status: z.enum(["fully_captured", "partially_captured"]),
		captured_amount: tamaraMoneySchema,
	})
	.passthrough();
export const tamaraSimplifiedRefundResponseSchema = z
	.object({
		refund_id: nonEmptyStringSchema,
		order_id: nonEmptyStringSchema,
		status: z.enum(["fully_refunded", "partially_refunded"]),
		refunded_amount: tamaraMoneySchema,
	})
	.passthrough();
export const tamaraCancelResponseSchema = z
	.object({
		order_id: nonEmptyStringSchema,
		cancel_id: nonEmptyStringSchema,
		status: z.enum(["updated", "canceled"]),
		canceled_amount: tamaraMoneySchema,
	})
	.passthrough();
export const tamaraVoidResponseSchema = z
	.object({
		order_was_voided: z.boolean(),
		captured_amount: tamaraMoneySchema.optional(),
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
export const tamaraDeleteWebhookResponseSchema = z.union([
	z.null(),
	z.object({
		message: z.string().min(1),
	}),
]);
const tamaraWebhookResponseHeadersSchema = z
	.union([z.record(z.string(), z.unknown()), z.array(z.never()).max(0)])
	.transform((headers): Record<string, unknown> => (Array.isArray(headers) ? {} : headers));
export const tamaraWebhookDetailsResponseSchema = z
	.object({
		webhook_id: z.string(),
		url: z.string(),
		events: z.array(z.string()),
		type: z.string().optional(),
		headers: tamaraWebhookResponseHeadersSchema.optional(),
	})
	.passthrough();
export const tamaraUpdateReferenceIdResponseSchema = z
	.object({
		order_id: z.string().optional(),
		message: z.string().optional(),
	})
	.passthrough();
