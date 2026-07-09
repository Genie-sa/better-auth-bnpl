import type { GenericEndpointContext, User } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { z } from "zod";
import { BNPL_ERROR_CODES, BnplProviderError } from "../core/errors";
import { parseAmount } from "../core/money";
import type { BnplProvider } from "../core/provider";
import type {
	BnplBuyer,
	BnplCheckoutInput,
	BnplDiscount,
	BnplMerchantUrls,
	BnplMoney,
	BnplOrderItem,
	NonEmptyArray,
} from "../core/types";
import { type AbsoluteUrl, absoluteUrlMax1024Schema, isAbsoluteUrl } from "../core/url";
import type { BnplOptions } from "../plugin-types";
import {
	addressSchema,
	buyerSchema,
	localeSchema,
	moneySchema,
	orderItemSchema,
	paymentTypeSchema,
} from "./shared";
const MAX_JSON_BYTES = 8 * 1024;
function boundedJsonRecordSchema(field: string): z.ZodType<Record<string, unknown>> {
	return z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
		const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
		if (bytes > MAX_JSON_BYTES) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `${field} must be at most ${MAX_JSON_BYTES} bytes when JSON-encoded (received ${bytes})`,
			});
		}
	});
}
const sharedFields = {
	provider: z.string(),
	orderReferenceId: z.string().optional(),
	description: z.string().max(256),
	buyer: buyerSchema.optional(),
	shippingAddress: addressSchema,
	billingAddress: addressSchema.optional(),
	countryCode: z.string().min(2).max(2),
	locale: localeSchema.optional(),
	paymentType: paymentTypeSchema.optional(),
	instalments: z.number().int().min(2).max(12).optional(),
	expiresInMinutes: z.number().int().min(5).max(1440).optional(),
	isMobile: z.boolean().optional(),
	successUrl: absoluteUrlMax1024Schema.optional(),
	failureUrl: absoluteUrlMax1024Schema.optional(),
	cancelUrl: absoluteUrlMax1024Schema.optional(),
	metadata: boundedJsonRecordSchema("metadata").optional(),
	additionalData: boundedJsonRecordSchema("additionalData").optional(),
};
const discountSchema = z.object({ name: z.string(), amount: moneySchema });
const resolvedCheckoutFieldsSchema = z.object({
	totalAmount: moneySchema,
	taxAmount: moneySchema.optional(),
	shippingAmount: moneySchema.optional(),
	items: z.array(orderItemSchema).min(1),
	discount: discountSchema.optional(),
});
const strictSchema = z.object({
	...sharedFields,
	totalAmount: moneySchema,
	taxAmount: moneySchema.optional(),
	shippingAmount: moneySchema.optional(),
	items: z.array(orderItemSchema).min(1),
	discount: discountSchema.optional(),
});
const relaxedSchema = z.object({
	...sharedFields,
	totalAmount: moneySchema.optional(),
	taxAmount: moneySchema.optional(),
	shippingAmount: moneySchema.optional(),
	items: z.array(orderItemSchema).min(1).optional(),
	discount: discountSchema.optional(),
});
export type CheckoutBody = z.infer<typeof strictSchema>;
export type CheckoutBodyRelaxed = z.infer<typeof relaxedSchema>;
export type CheckoutBodyInput = z.input<typeof strictSchema>;
export type CheckoutBodyRelaxedInput = z.input<typeof relaxedSchema>;
export interface ResolveCheckoutContext {
	input: CheckoutBodyRelaxed;
	provider: BnplProvider;
	user: User;
	request?: Request;
	endpointContext: GenericEndpointContext;
}
export type ResolvedCheckoutFields = z.infer<typeof resolvedCheckoutFieldsSchema>;
export interface CheckoutCreatedContext {
	input: CheckoutBody | CheckoutBodyRelaxed;
	provider: BnplProvider;
	canonicalRequest: BnplCheckoutInput;
	checkoutResult: {
		providerOrderId: string;
		providerCheckoutId: string;
		checkoutUrl: AbsoluteUrl;
		status: string;
	};
	user: User;
	orderReferenceId: string;
	endpointContext: GenericEndpointContext;
}
export interface OrderPersistedContext extends CheckoutCreatedContext {
	record: {
		userId: string;
		provider: string;
		orderReferenceId: string;
		providerOrderId: string;
		providerCheckoutId: string;
		status: string;
		amountMinor: number;
		currency: string;
		paymentType?: string;
	};
}
export interface CheckoutSubpluginOptions {
	successUrl?: string;
	failureUrl?: string;
	cancelUrl?: string;
	trustedRedirectOrigins?: string[];
	notificationUrlBuilder?: (provider: string, baseURL: string) => string;
	authenticatedUsersOnly?: boolean;
	defaultPaymentType?: "PAY_BY_INSTALMENTS" | "PAY_BY_LATER" | "PAY_NOW" | "SPLIT_IN_3";
	generateOrderReferenceId?: () => string;
	resolveCheckout?: (
		ctx: ResolveCheckoutContext,
	) => Promise<ResolvedCheckoutFields> | ResolvedCheckoutFields;
	onCheckoutCreated?: (ctx: CheckoutCreatedContext) => Promise<void> | void;
	onOrderPersisted?: (ctx: OrderPersistedContext) => Promise<void> | void;
}
const defaultNotificationUrlBuilder = (provider: string, baseURL: string): string => {
	const normalizedBase = baseURL.replace(/\/+$/, "");
	return `${normalizedBase}/bnpl/webhooks/${provider}`;
};
function apiInvalidUrl(label: string, cause?: unknown): APIError {
	return new APIError("BAD_REQUEST", {
		message: `${BNPL_ERROR_CODES.INVALID_URL.message}: ${label}`,
		code: "INVALID_URL",
		cause,
	});
}
function requireAbsoluteUrl(value: string, label: string): AbsoluteUrl {
	if (isAbsoluteUrl(value)) return value;
	throw apiInvalidUrl(label);
}
function resolveCheckoutUrl(
	value: string | undefined,
	fallback: string,
	base: string,
	label: string,
): AbsoluteUrl {
	try {
		return requireAbsoluteUrl(new URL(value ?? fallback, base).toString(), label);
	} catch (cause) {
		if (cause instanceof APIError) throw cause;
		throw apiInvalidUrl(label, cause);
	}
}
function resolveNotificationUrl(
	builder: (provider: string, baseURL: string) => string,
	providerId: string,
	baseURL: string,
): AbsoluteUrl {
	try {
		return requireAbsoluteUrl(builder(providerId, baseURL), "notificationUrlBuilder");
	} catch (cause) {
		if (cause instanceof APIError) throw cause;
		throw apiInvalidUrl("notificationUrlBuilder", cause);
	}
}
function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}
function buildTrustedOrigins(baseURL: string, configured: string[] | undefined): Set<string> {
	const origins = new Set<string>();
	const baseOrigin = originOf(baseURL);
	if (baseOrigin) origins.add(baseOrigin);
	for (const entry of configured ?? []) {
		const origin = originOf(entry);
		if (origin) origins.add(origin);
	}
	return origins;
}
function requireTrustedBodyUrl(
	value: AbsoluteUrl,
	trustedOrigins: Set<string>,
	label: string,
): AbsoluteUrl {
	const origin = originOf(value);
	if (!origin || !trustedOrigins.has(origin)) {
		throw apiInvalidUrl(`${label} origin is not in trustedRedirectOrigins`);
	}
	return value;
}
interface MerchantUrlInputs {
	bodyUrl: AbsoluteUrl | undefined;
	optionUrl: string | undefined;
	defaultPath: string;
	label: string;
}
function resolveMerchantUrl(
	input: MerchantUrlInputs,
	trustedOrigins: Set<string>,
	base: string,
): AbsoluteUrl {
	if (input.bodyUrl) {
		return requireTrustedBodyUrl(input.bodyUrl, trustedOrigins, input.label);
	}
	return resolveCheckoutUrl(input.optionUrl, input.defaultPath, base, input.label);
}
function resolveMerchantUrls(
	body: {
		successUrl?: AbsoluteUrl;
		failureUrl?: AbsoluteUrl;
		cancelUrl?: AbsoluteUrl;
	},
	checkoutOptions: CheckoutSubpluginOptions,
	providerId: string,
	baseURL: string,
	redirectBase: string,
): BnplMerchantUrls {
	const trustedOrigins = buildTrustedOrigins(baseURL, checkoutOptions.trustedRedirectOrigins);
	const builder = checkoutOptions.notificationUrlBuilder ?? defaultNotificationUrlBuilder;
	return {
		success: resolveMerchantUrl(
			{
				bodyUrl: body.successUrl,
				optionUrl: checkoutOptions.successUrl,
				defaultPath: "/payment/success",
				label: "successUrl",
			},
			trustedOrigins,
			redirectBase,
		),
		failure: resolveMerchantUrl(
			{
				bodyUrl: body.failureUrl,
				optionUrl: checkoutOptions.failureUrl,
				defaultPath: "/payment/failure",
				label: "failureUrl",
			},
			trustedOrigins,
			redirectBase,
		),
		cancel: resolveMerchantUrl(
			{
				bodyUrl: body.cancelUrl,
				optionUrl: checkoutOptions.cancelUrl,
				defaultPath: "/payment/cancel",
				label: "cancelUrl",
			},
			trustedOrigins,
			redirectBase,
		),
		notification: resolveNotificationUrl(builder, providerId, baseURL),
	};
}
function requireNonEmptyItems(items: BnplOrderItem[]): NonEmptyArray<BnplOrderItem> {
	const first = items[0];
	if (!first) {
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: BNPL_ERROR_CODES.RESOLVE_CHECKOUT_INCOMPLETE.message,
			code: "RESOLVE_CHECKOUT_INCOMPLETE",
		});
	}
	return [first, ...items.slice(1)];
}
type CheckoutRequestBody = CheckoutBody | CheckoutBodyRelaxed;
interface ResolvedCheckoutMoney {
	totalAmount: BnplMoney;
	items: BnplOrderItem[];
	taxAmount?: BnplMoney;
	shippingAmount?: BnplMoney;
	discount?: BnplDiscount;
}
function requireCheckoutSession(
	session: {
		user?: User;
	} | null,
	checkoutOptions: CheckoutSubpluginOptions,
): {
	user: User;
} {
	if (checkoutOptions.authenticatedUsersOnly !== false) {
		if (!session?.user?.id) {
			throw new APIError("UNAUTHORIZED", {
				message: BNPL_ERROR_CODES.AUTH_REQUIRED.message,
				code: "AUTH_REQUIRED",
			});
		}
		if ("isAnonymous" in session.user && session.user.isAnonymous === true) {
			throw new APIError("UNAUTHORIZED", {
				message: BNPL_ERROR_CODES.ANONYMOUS_USER_NOT_ALLOWED.message,
				code: "ANONYMOUS_USER_NOT_ALLOWED",
			});
		}
	}
	if (!session?.user) {
		throw new APIError("UNAUTHORIZED", {
			message: BNPL_ERROR_CODES.USER_NOT_FOUND.message,
			code: "USER_NOT_FOUND",
		});
	}
	return { user: session.user };
}
function requireProvider(
	providers: Record<string, BnplProvider>,
	providerId: string,
): BnplProvider {
	const provider = providers[providerId];
	if (!provider) {
		throw new APIError("BAD_REQUEST", {
			message: `${BNPL_ERROR_CODES.PROVIDER_NOT_CONFIGURED.message}: \`${providerId}\``,
			code: "PROVIDER_NOT_CONFIGURED",
		});
	}
	return provider;
}
async function resolveBuyer(
	rawInput: CheckoutRequestBody,
	user: User,
	options: BnplOptions,
	ctx: GenericEndpointContext,
): Promise<BnplBuyer> {
	if (rawInput.buyer) return rawInput.buyer;
	if (options.mapUserToBuyer) {
		return options.mapUserToBuyer({ user, request: ctx.request, endpointContext: ctx });
	}
	throw new APIError("INTERNAL_SERVER_ERROR", {
		message: BNPL_ERROR_CODES.BUYER_MAPPER_MISSING.message,
		code: "BUYER_MAPPER_MISSING",
	});
}
async function resolveCheckoutMoney(
	rawInput: CheckoutRequestBody,
	provider: BnplProvider,
	user: User,
	checkoutOptions: CheckoutSubpluginOptions,
	ctx: GenericEndpointContext,
): Promise<ResolvedCheckoutMoney> {
	let fields: {
		totalAmount?: BnplMoney;
		items?: BnplOrderItem[];
		taxAmount?: BnplMoney;
		shippingAmount?: BnplMoney;
		discount?: BnplDiscount;
	};
	if (checkoutOptions.resolveCheckout) {
		const resolvedInput = await checkoutOptions.resolveCheckout({
			input: rawInput,
			provider,
			user,
			request: ctx.request,
			endpointContext: ctx,
		});
		const resolved = resolvedCheckoutFieldsSchema.safeParse(resolvedInput);
		if (!resolved.success) {
			throw new APIError("INTERNAL_SERVER_ERROR", {
				message: BNPL_ERROR_CODES.RESOLVE_CHECKOUT_INCOMPLETE.message,
				code: "RESOLVE_CHECKOUT_INCOMPLETE",
			});
		}
		fields = resolved.data;
	} else {
		fields = rawInput;
	}
	if (!fields.totalAmount || !fields.items) {
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: BNPL_ERROR_CODES.RESOLVE_CHECKOUT_INCOMPLETE.message,
			code: "RESOLVE_CHECKOUT_INCOMPLETE",
		});
	}
	if (!provider.supportedCurrencies.includes(fields.totalAmount.currency)) {
		throw new APIError("BAD_REQUEST", {
			message: `${BNPL_ERROR_CODES.CURRENCY_NOT_SUPPORTED_BY_PROVIDER.message}: ${provider.id} does not support ${fields.totalAmount.currency}`,
			code: "CURRENCY_NOT_SUPPORTED_BY_PROVIDER",
		});
	}
	return {
		totalAmount: fields.totalAmount,
		items: fields.items,
		taxAmount: fields.taxAmount,
		shippingAmount: fields.shippingAmount,
		discount: fields.discount,
	};
}
async function createProviderCheckout(
	provider: BnplProvider,
	canonicalRequest: BnplCheckoutInput,
	ctx: GenericEndpointContext,
): Promise<Awaited<ReturnType<BnplProvider["createCheckout"]>>> {
	try {
		return await provider.createCheckout(canonicalRequest, { logger: ctx.context.logger });
	} catch (e) {
		if (e instanceof Error) {
			ctx.context.logger.error(`bnpl: ${provider.id} checkout creation failed: ${e.message}`);
		}
		if (e instanceof BnplProviderError) {
			throw new APIError("BAD_GATEWAY", {
				message: e.message,
				code: "CHECKOUT_CREATION_FAILED",
			});
		}
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: BNPL_ERROR_CODES.CHECKOUT_CREATION_FAILED.message,
			code: "CHECKOUT_CREATION_FAILED",
		});
	}
}
function assertNotDeclined(
	result: Awaited<ReturnType<BnplProvider["createCheckout"]>>,
): asserts result is Extract<
	typeof result,
	{
		status: Exclude<typeof result.status, "declined">;
	}
> {
	if (result.status === "declined") {
		throw new APIError("UNPROCESSABLE_ENTITY", {
			message: result.rejectionReason
				? `${BNPL_ERROR_CODES.CHECKOUT_REJECTED.message}: ${result.rejectionReason}`
				: BNPL_ERROR_CODES.CHECKOUT_REJECTED.message,
			code: "CHECKOUT_REJECTED",
			reason: result.rejectionReason,
		});
	}
}
async function persistCheckoutOrder(
	ctx: GenericEndpointContext,
	params: {
		user: User;
		provider: BnplProvider;
		orderReferenceId: string;
		totalAmount: BnplMoney;
		paymentType: BnplCheckoutInput["paymentType"];
		result: Extract<
			Awaited<ReturnType<BnplProvider["createCheckout"]>>,
			{
				checkoutUrl: AbsoluteUrl;
			}
		>;
		metadata: Record<string, unknown> | undefined;
	},
): Promise<OrderPersistedContext["record"]> {
	let amountMinor: number;
	try {
		amountMinor = parseAmount(params.totalAmount);
	} catch (e) {
		ctx.context.logger.error(
			`bnpl: rejecting checkout — totalAmount invalid: ${e instanceof Error ? e.message : e}`,
		);
		throw new APIError("BAD_REQUEST", {
			message: BNPL_ERROR_CODES.INVALID_AMOUNT.message,
			code: "INVALID_AMOUNT",
		});
	}
	const record = {
		userId: params.user.id,
		provider: params.provider.id,
		orderReferenceId: params.orderReferenceId,
		providerOrderId: params.result.providerOrderId,
		providerCheckoutId: params.result.providerCheckoutId,
		status: params.result.status,
		amountMinor,
		currency: params.totalAmount.currency,
		paymentType: params.paymentType,
	};
	await ctx.context.adapter.create({
		model: "bnplOrder",
		data: {
			...record,
			capturedAmountMinor: 0,
			refundedAmountMinor: 0,
			rawData: JSON.stringify(params.result.raw),
			metadata: params.metadata ? JSON.stringify(params.metadata) : undefined,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	return record;
}
export const checkout = (checkoutOptions: CheckoutSubpluginOptions = {}) => {
	const hasResolver = typeof checkoutOptions.resolveCheckout === "function";
	const bodySchema = hasResolver ? relaxedSchema : strictSchema;
	return (providers: Record<string, BnplProvider>, options: BnplOptions) => ({
		bnplCheckout: createAuthEndpoint(
			"/bnpl/checkout",
			{ method: "POST", body: bodySchema },
			async (ctx) => {
				const rawInput = ctx.body;
				const { user } = requireCheckoutSession(await getSessionFromCtx(ctx), checkoutOptions);
				const provider = requireProvider(providers, rawInput.provider);
				const buyer = await resolveBuyer(rawInput, user, options, ctx);
				const money = await resolveCheckoutMoney(rawInput, provider, user, checkoutOptions, ctx);
				const orderReferenceId =
					rawInput.orderReferenceId ??
					checkoutOptions.generateOrderReferenceId?.() ??
					`bnpl_${crypto.randomUUID()}`;
				const baseURL = ctx.context.baseURL;
				const redirectBase = ctx.request?.url ?? baseURL;
				const canonicalRequest: BnplCheckoutInput = {
					orderReferenceId,
					description: rawInput.description,
					totalAmount: money.totalAmount,
					taxAmount: money.taxAmount,
					shippingAmount: money.shippingAmount,
					items: requireNonEmptyItems(money.items),
					discount: money.discount,
					buyer,
					shippingAddress: rawInput.shippingAddress,
					billingAddress: rawInput.billingAddress,
					countryCode: rawInput.countryCode,
					locale: rawInput.locale,
					paymentType: rawInput.paymentType ?? checkoutOptions.defaultPaymentType,
					instalments: rawInput.instalments,
					expiresInMinutes: rawInput.expiresInMinutes,
					isMobile: rawInput.isMobile,
					metadata: rawInput.metadata,
					additionalData: rawInput.additionalData,
					merchantUrl: resolveMerchantUrls(
						rawInput,
						checkoutOptions,
						provider.id,
						baseURL,
						redirectBase,
					),
				};
				const result = await createProviderCheckout(provider, canonicalRequest, ctx);
				assertNotDeclined(result);
				const hookContext: CheckoutCreatedContext = {
					input: rawInput,
					provider,
					canonicalRequest,
					checkoutResult: {
						providerOrderId: result.providerOrderId,
						providerCheckoutId: result.providerCheckoutId,
						checkoutUrl: result.checkoutUrl,
						status: result.status,
					},
					user,
					orderReferenceId,
					endpointContext: ctx,
				};
				if (options.persistOrders) {
					const record = await persistCheckoutOrder(ctx, {
						user,
						provider,
						orderReferenceId,
						totalAmount: money.totalAmount,
						paymentType: canonicalRequest.paymentType,
						result,
						metadata: rawInput.metadata,
					});
					await checkoutOptions.onCheckoutCreated?.(hookContext);
					await checkoutOptions.onOrderPersisted?.({ ...hookContext, record });
				} else {
					await checkoutOptions.onCheckoutCreated?.(hookContext);
				}
				return ctx.json({
					provider: provider.id,
					providerOrderId: result.providerOrderId,
					providerCheckoutId: result.providerCheckoutId,
					checkoutUrl: result.checkoutUrl,
					qrCodeUrl: result.qrCodeUrl,
					status: result.status,
					orderReferenceId,
				});
			},
		),
	});
};
