function defineBnplErrorCodes<const T extends Record<string, string>>(
	messages: T,
): {
	readonly [K in keyof T]: {
		readonly code: K & string;
		readonly message: T[K];
	};
} {
	return Object.fromEntries(
		Object.entries(messages).map(([code, message]) => [code, { code, message }]),
	) as {
		readonly [K in keyof T]: {
			readonly code: K & string;
			readonly message: T[K];
		};
	};
}
export const BNPL_ERROR_CODES = defineBnplErrorCodes({
	AUTH_REQUIRED: "You must be logged in to perform this action",
	ANONYMOUS_USER_NOT_ALLOWED: "Anonymous users cannot checkout",
	USER_NOT_FOUND: "No authenticated user found",
	BUYER_MAPPER_MISSING: "bnpl: `mapUserToBuyer` option is required on the main plugin",
	BUYER_PHONE_REQUIRED: "User has no phone number on file",
	PROVIDER_NOT_CONFIGURED: "Requested BNPL provider is not configured on this plugin",
	PROVIDER_NOT_AVAILABLE: "Provider is not available for this country/currency/amount",
	OPERATION_NOT_SUPPORTED: "This operation is not supported by the order's provider",
	CHECKOUT_CREATION_FAILED: "BNPL checkout creation failed",
	CHECKOUT_REJECTED: "Provider rejected this checkout",
	INVALID_URL: "URL must be an absolute HTTP(S) URL",
	RESOLVE_CHECKOUT_INCOMPLETE:
		"resolveCheckout must return totalAmount, items, and the other canonical money fields",
	ORDER_NOT_FOUND: "Order not found",
	ORDER_NOT_OWNED: "This order does not belong to the authenticated user",
	ORDER_FETCH_FAILED: "Failed to fetch order from provider",
	REFERENCE_ID_REQUIRED: "referenceId is required",
	SHIPPING_INFO_REQUIRED: "shippingInfo is required for this provider operation",
	TOTAL_AMOUNT_REQUIRED: "totalAmount is required for this provider operation",
	LIST_REQUIRES_PERSISTENCE:
		"Listing orders requires `persistOrders: true` — providers don't expose merchant lists",
	ADMIN_AUTHORIZATION_REQUIRED:
		"admin(): `isAuthorized` callback is required to use admin endpoints",
	ADMIN_FORBIDDEN: "You are not authorized to perform this admin action",
	CAPTURE_FAILED: "Provider capture failed",
	REFUND_FAILED: "Provider refund failed",
	CANCEL_FAILED: "Provider cancel failed",
	VOID_FAILED: "Provider void failed",
	AUTHORISE_FAILED: "Provider authorise failed",
	RECONCILE_FAILED: "Provider reconcile failed",
	CLOSE_PAYMENT_FAILED: "Provider close-payment failed",
	PRECHECK_FAILED: "BNPL pre-check failed",
	WEBHOOK_PROVIDER_UNKNOWN: "Webhook URL did not specify a configured provider",
	WEBHOOK_MISSING_TOKEN: "Webhook is missing its signature/token",
	WEBHOOK_INVALID_SIGNATURE: "Webhook signature/token is invalid",
	WEBHOOK_MALFORMED_BODY: "Webhook body is not valid JSON",
	WEBHOOK_UNKNOWN_SHAPE: "Webhook payload shape is not recognized",
	WEBHOOK_HANDLER_FAILED: "Webhook handler threw",
	WEBHOOK_PERSIST_FAILED: "Failed to record the webhook event before processing",
	WEBHOOK_EVENT_NOT_FOUND: "Webhook event not found",
	WEBHOOK_EVENT_NOT_REPLAYABLE:
		"Webhook event cannot be redelivered — its stored payload is missing or unparseable",
	WEBHOOK_REDELIVERY_FAILED: "Webhook redelivery failed during re-processing",
	INVALID_AMOUNT: "Amount is not a valid BNPL money value",
	UNKNOWN_CURRENCY: "Currency is not supported (SAR/AED/KWD/BHD/OMR)",
	CURRENCY_NOT_SUPPORTED_BY_PROVIDER: "This currency is not supported by the requested provider",
});
export type BnplErrorCode = keyof typeof BNPL_ERROR_CODES;
export class BnplPluginError extends Error {
	readonly code: BnplErrorCode;
	override readonly cause?: unknown;
	constructor(code: BnplErrorCode, message?: string, cause?: unknown) {
		super(message ?? BNPL_ERROR_CODES[code].message);
		this.name = "BnplPluginError";
		this.code = code;
		this.cause = cause;
	}
}
export const isBnplPluginError = (e: unknown): e is BnplPluginError => e instanceof BnplPluginError;
export class BnplProviderError extends Error {
	readonly provider: string;
	readonly status?: number;
	readonly body?: unknown;
	override readonly cause?: unknown;
	constructor(
		provider: string,
		message: string,
		init?: {
			status?: number;
			body?: unknown;
			cause?: unknown;
		},
	) {
		super(message);
		this.name = "BnplProviderError";
		this.provider = provider;
		this.status = init?.status;
		this.body = init?.body;
		this.cause = init?.cause;
	}
	get isAlreadyInTargetState(): boolean {
		if (this.status !== 400 && this.status !== 409) return false;
		const body = this.body;
		if (!body || typeof body !== "object" || !("message" in body)) return false;
		const message = body.message;
		if (typeof message !== "string") return false;
		return /already|not\s+allowed|invalid\s+status/i.test(message);
	}
}
export const isBnplProviderError = (e: unknown): e is BnplProviderError =>
	e instanceof BnplProviderError;
