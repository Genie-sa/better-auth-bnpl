import { brandInstance, recogniseBrand } from "./guards";
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
	CHECKOUT_CONFLICT: "Checkout reference conflicts with an existing or uncertain checkout",
	MONEY_COMMAND_CONFLICT: "Order operation conflicts with an existing or uncertain command",
	INVALID_CANCEL_REFERENCE: "Amount-bearing cancellation requires merchantReferenceId",
	INVALID_URL: "URL must be an absolute HTTP(S) URL",
	INVALID_RESOURCE_ID: "Provider resource ID must be nonempty and cannot be a dot segment",
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
const PLUGIN_ERROR_BRAND = Symbol.for("better-auth-bnpl.BnplPluginError");
const PROVIDER_ERROR_BRAND = Symbol.for("better-auth-bnpl.BnplProviderError");
export class BnplPluginError extends Error {
	readonly code: BnplErrorCode;
	/** Validation failed before any provider request was sent. */
	readonly rejected: boolean;
	override readonly cause?: unknown;
	constructor(
		code: BnplErrorCode,
		message?: string,
		cause?: unknown,
		init?: { rejected?: boolean },
	) {
		super(message ?? BNPL_ERROR_CODES[code].message);
		brandInstance(this, PLUGIN_ERROR_BRAND);
		this.name = "BnplPluginError";
		this.code = code;
		this.cause = cause;
		this.rejected = init?.rejected === true;
	}
}
recogniseBrand(BnplPluginError, PLUGIN_ERROR_BRAND);
export const isBnplPluginError = (e: unknown): e is BnplPluginError => e instanceof BnplPluginError;
export class BnplProviderError extends Error {
	readonly provider: string;
	readonly status?: number;
	readonly body?: unknown;
	/** The provider answered and provably did not apply the operation, whatever the HTTP status. */
	readonly rejected: boolean;
	override readonly cause?: unknown;
	constructor(
		provider: string,
		message: string,
		init?: {
			status?: number;
			body?: unknown;
			cause?: unknown;
			rejected?: boolean;
		},
	) {
		super(message);
		brandInstance(this, PROVIDER_ERROR_BRAND);
		this.name = "BnplProviderError";
		this.provider = provider;
		this.status = init?.status;
		this.body = init?.body;
		this.cause = init?.cause;
		this.rejected = init?.rejected === true;
	}
	get isAlreadyInTargetState(): boolean {
		return this.reportsAlready([
			"authorised",
			"authorized",
			"captured",
			"refunded",
			"canceled",
			"cancelled",
			"closed",
		]);
	}
	/** True when the provider refused because the order is already in one of `states`. */
	reportsAlready(states: readonly string[]): boolean {
		if (this.status !== 400 && this.status !== 409 && this.status !== 422) return false;
		const pattern = new RegExp(`\\balready\\s+(?:been\\s+)?(?:${states.join("|")})\\b`, "i");
		return providerMessages(this.body).some((message) => pattern.test(message));
	}
	/** The order state a provider reported when refusing a transition (Tamara `transition_not_allowed`). */
	get conflictingState(): string | undefined {
		const errors = isErrorBody(this.body) ? this.body.errors : undefined;
		if (!Array.isArray(errors)) return undefined;
		for (const error of errors) {
			if (!isErrorBody(error) || error.error_code !== "transition_not_allowed") continue;
			const data = error.data;
			if (isErrorBody(data) && typeof data.old_state === "string") return data.old_state;
		}
		return undefined;
	}
}
recogniseBrand(BnplProviderError, PROVIDER_ERROR_BRAND);
function isErrorBody(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function providerMessages(body: unknown): string[] {
	if (!isErrorBody(body)) return [];
	const nested = Array.isArray(body.errors)
		? body.errors.flatMap((error) => (isErrorBody(error) ? [error.message] : []))
		: [];
	return [body.message, body.error, ...nested].filter(
		(message): message is string => typeof message === "string",
	);
}
export const isBnplProviderError = (e: unknown): e is BnplProviderError =>
	e instanceof BnplProviderError;

/** Nothing reached the provider's mutation endpoint, so whatever failed had no effect. */
export function rejectedBeforeDispatch(provider: string, cause: unknown): BnplProviderError {
	return new BnplProviderError(
		provider,
		cause instanceof Error ? cause.message : "request was not sent",
		{ cause, rejected: true },
	);
}

/**
 * True only for errors explicitly marked `rejected`: validation failed before any request, or the
 * mutation's own response proves the provider refused it. A bare HTTP status is never enough,
 * because a provider method may fail on a follow-up read after its mutation succeeded. Callers that
 * can verify through GET treat "already in target state" refusals as recoverable instead.
 */
export function isDefinitiveRejection(error: unknown): boolean {
	if (error instanceof BnplPluginError) return error.rejected;
	return error instanceof BnplProviderError && error.rejected;
}
