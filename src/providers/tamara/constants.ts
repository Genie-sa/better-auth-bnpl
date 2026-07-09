export const TAMARA_COUNTRY_CODES = ["SA", "AE", "BH", "KW", "OM"] as const;
export type TamaraCountryCode = (typeof TAMARA_COUNTRY_CODES)[number];
export const TAMARA_CURRENCIES = ["SAR", "AED", "KWD", "BHD", "OMR"] as const;
export type TamaraCurrency = (typeof TAMARA_CURRENCIES)[number];
export const TAMARA_LOCALES = ["ar_SA", "en_US"] as const;
export type TamaraLocale = (typeof TAMARA_LOCALES)[number];
export const TAMARA_PAYMENT_TYPES = [
	"PAY_BY_INSTALMENTS",
	"PAY_BY_LATER",
	"PAY_NOW",
	"SPLIT_IN_3",
] as const;
export type TamaraPaymentType = (typeof TAMARA_PAYMENT_TYPES)[number];
export const TAMARA_KNOWN_WEBHOOK_EVENT_TYPES = [
	"order_approved",
	"order_declined",
	"order_authorised",
	"order_canceled",
	"order_expired",
	"order_captured",
	"order_refunded",
	"order_updated",
] as const;
export type TamaraKnownWebhookEventType = (typeof TAMARA_KNOWN_WEBHOOK_EVENT_TYPES)[number];
export const TAMARA_BASE_URLS = {
	sandbox: "https://api-sandbox.tamara.co",
	production: "https://api.tamara.co",
} as const;
