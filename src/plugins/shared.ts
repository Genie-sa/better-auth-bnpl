import { z } from "zod";
import { BNPL_CURRENCIES, DECIMAL_PATTERN } from "../core/money";
import { absoluteUrlMax1024Schema } from "../core/url";
export const moneySchema = z.object({
	amount: z
		.union([z.string(), z.number()])
		.transform((v) => (typeof v === "number" ? String(v) : v))
		.refine((v) => DECIMAL_PATTERN.test(v), {
			message:
				'amount must be a canonical decimal string (e.g. "100.00") — no separators, sign, or scientific notation',
		}),
	currency: z.enum(BNPL_CURRENCIES),
});
export const localeSchema = z.enum(["en", "ar", "en_US", "ar_SA"]);
export const addressSchema = z.object({
	firstName: z.string().optional(),
	lastName: z.string().optional(),
	line1: z.string(),
	line2: z.string().optional(),
	city: z.string(),
	region: z.string().optional(),
	postalCode: z.string().optional(),
	countryCode: z.string().min(2).max(2),
	phone: z.string().optional(),
});
export const buyerSchema = z.object({
	firstName: z.string(),
	lastName: z.string(),
	email: z.string().email(),
	phone: z.string(),
	dateOfBirth: z.string().optional(),
	nationalId: z.string().optional(),
	isFirstOrder: z.boolean().optional(),
});
export const orderItemSchema = z.object({
	referenceId: z.string(),
	name: z.string().max(255),
	sku: z.string().max(128),
	quantity: z.number().int().positive(),
	totalAmount: moneySchema,
	unitPrice: moneySchema.optional(),
	taxAmount: moneySchema.optional(),
	discountAmount: moneySchema.optional(),
	imageUrl: absoluteUrlMax1024Schema.optional(),
	itemUrl: absoluteUrlMax1024Schema.optional(),
	type: z.string().optional(),
	category: z.string().optional(),
});
export const paymentTypeSchema = z.enum([
	"PAY_BY_INSTALMENTS",
	"PAY_BY_LATER",
	"PAY_NOW",
	"SPLIT_IN_3",
]);
