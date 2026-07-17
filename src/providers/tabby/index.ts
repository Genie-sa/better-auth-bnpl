import { BnplPluginError, BnplProviderError } from "../../core/errors";
import { isOneOf } from "../../core/guards";
import { parseJsonObject } from "../../core/json";
import type { BnplCurrency } from "../../core/money";
import { formatAmount, parseAmount } from "../../core/money";
import type {
	BnplProvider,
	ProviderContext,
	ProviderDisplay,
	ProviderFetch,
	WebhookRequest,
} from "../../core/provider";
import type {
	BnplCancelArgs,
	BnplCaptureArgs,
	BnplCaptureResult,
	BnplCheckoutInput,
	BnplCheckoutResult,
	BnplOrderState,
	BnplPreCheckInput,
	BnplPreCheckResult,
	BnplRefundArgs,
	BnplRefundResult,
	BnplVerifyWebhookResult,
	BnplWebhookEvent,
} from "../../core/types";
import {
	fromTabbyPaymentDetails,
	tabbyDedupKey,
	tabbyProductKeyForPaymentType,
	tabbyToCanonicalEvent,
	tabbyWebhookDedupKeyForEvent,
	toTabbyCheckoutRequest,
	toTabbyItem,
} from "./adapter";
import { TabbyClient, type TabbyEnvironment } from "./client";
import type { TabbyCheckoutResponse } from "./types";
import { type TabbyWebhookSecretConfig, verifyTabbyHeaderSecret } from "./webhook-verify";
export const TABBY_COUNTRY_CODES = ["SA", "AE", "KW"] as const;
export type TabbyCountryCode = (typeof TABBY_COUNTRY_CODES)[number];
export const TABBY_CURRENCIES = ["SAR", "AED", "KWD"] as const satisfies readonly BnplCurrency[];
export type TabbyCurrency = (typeof TABBY_CURRENCIES)[number];
const DEFAULT_PRECHECK_BOUNDS: Record<
	TabbyCurrency,
	{
		minMinor: number;
		maxMinor: number;
	}
> = {
	AED: { minMinor: 10000, maxMinor: 3000000 },
	SAR: { minMinor: 7500, maxMinor: 3000000 },
	KWD: { minMinor: 8000, maxMinor: 3000000 },
};
export interface TabbyOptions {
	secretKey: string;
	merchantCode: string;
	webhookHeader: {
		name: string;
		value: string;
	};
	environment?: TabbyEnvironment;
	country?: TabbyCountryCode;
	baseUrl?: string;
	fetch?: ProviderFetch;
	timeoutMs?: number;
	preCheckBounds?: Partial<
		Record<
			TabbyCurrency,
			{
				minMinor: number;
				maxMinor: number;
			}
		>
	>;
	display?: Partial<ProviderDisplay>;
}
export interface TabbyCaptureArgs extends BnplCaptureArgs {
	merchantReferenceId: string;
}
export interface TabbyRefundArgs extends BnplRefundArgs {
	merchantRefundId: string;
}
const DEFAULT_DISPLAY = {
	displayName: "Tabby",
	logoUrl: "https://checkout.tabby.ai/assets/tabby-logo.svg",
	tagline: "Pay in 4 — interest-free, no fees",
} as const;
function requireTabbyReferenceId(
	value: string | undefined,
	operation: "capture" | "refund",
): string {
	if (value && value.trim().length > 0) return value;
	const field = operation === "capture" ? "merchantReferenceId" : "merchantRefundId";
	throw new BnplPluginError(
		"REFERENCE_ID_REQUIRED",
		`tabby: ${field} is required because Tabby's ${operation} API requires reference_id for idempotency`,
	);
}
export function tabby(
	options: TabbyOptions,
): BnplProvider<"tabby", TabbyCaptureArgs, TabbyRefundArgs> {
	const client = new TabbyClient({
		secretKey: options.secretKey,
		merchantCode: options.merchantCode,
		environment: options.environment,
		country: options.country,
		baseUrl: options.baseUrl,
		fetch: options.fetch,
		timeoutMs: options.timeoutMs,
	});
	const display = { ...DEFAULT_DISPLAY, ...options.display };
	const bounds = { ...DEFAULT_PRECHECK_BOUNDS, ...options.preCheckBounds };
	const webhookConfig: TabbyWebhookSecretConfig = {
		headerName: options.webhookHeader.name,
		headerValue: options.webhookHeader.value,
	};
	return {
		id: "tabby",
		display,
		capabilities: {
			preCheck: true,
			separateAuthorise: false,
			voidCheckout: false,
			closePayment: true,
			partialCapture: true,
			partialRefund: true,
			multipleCaptures: true,
			disputes: true,
		},
		supportedCountries: TABBY_COUNTRY_CODES,
		supportedCurrencies: TABBY_CURRENCIES,
		async createCheckout(input: BnplCheckoutInput): Promise<BnplCheckoutResult> {
			const tabbyRequest = toTabbyCheckoutRequest(input, {
				merchantCode: options.merchantCode,
			});
			const response = await client.createCheckout(tabbyRequest);
			return mapCheckoutResponse(response, tabbyProductKeyForPaymentType(input.paymentType));
		},
		async fetchOrder(providerOrderId: string, ctx: ProviderContext): Promise<BnplOrderState> {
			const payment = await client.getPayment(providerOrderId);
			const derived = fromTabbyPaymentDetails(payment, ctx.logger);
			return {
				providerOrderId: payment.id,
				orderReferenceId: undefined,
				status: derived.status,
				totalAmount: formatAmount(derived.totalMinor, payment.currency),
				capturedAmountMinor: derived.capturedMinor,
				refundedAmountMinor: derived.refundedMinor,
				raw: payment,
			};
		},
		async capture(
			providerOrderId: string,
			args: TabbyCaptureArgs,
			ctx: ProviderContext,
		): Promise<BnplCaptureResult> {
			const referenceId = requireTabbyReferenceId(args.merchantReferenceId, "capture");
			const response = await client.capture(providerOrderId, {
				amount: args.totalAmount.amount,
				reference_id: referenceId,
				tax_amount: args.taxAmount?.amount,
				shipping_amount: args.shippingAmount?.amount,
				discount_amount: args.discountAmount?.amount,
				items: args.items?.map(toTabbyItem),
			});
			const captures = response.captures ?? [];
			const latest = captures[captures.length - 1];
			if (!latest) {
				throw new BnplProviderError("tabby", "capture response missing capture record", {
					body: response,
				});
			}
			ctx.logger.info(
				`tabby: captured ${args.totalAmount.amount} ${args.totalAmount.currency} for ${providerOrderId} (capture_id=${latest.id})`,
			);
			return {
				captureId: latest.id,
				providerOrderId: response.id,
				amountMinor: parseAmount(args.totalAmount),
				raw: response,
			};
		},
		async refund(
			providerOrderId: string,
			args: TabbyRefundArgs,
			ctx: ProviderContext,
		): Promise<BnplRefundResult> {
			const referenceId = requireTabbyReferenceId(args.merchantRefundId, "refund");
			const response = await client.refund(providerOrderId, {
				amount: args.totalAmount.amount,
				reference_id: referenceId,
				reason: args.comment,
				items: args.items?.map(toTabbyItem),
			});
			const refunds = response.refunds ?? [];
			const latest = refunds[refunds.length - 1];
			if (!latest) {
				throw new BnplProviderError("tabby", "refund response missing refund record", {
					body: response,
				});
			}
			ctx.logger.info(
				`tabby: refunded ${args.totalAmount.amount} ${args.totalAmount.currency} for ${providerOrderId} (refund_id=${latest.id})`,
			);
			return {
				refundId: latest.id,
				providerOrderId: response.id,
				amountMinor: parseAmount(args.totalAmount),
				raw: response,
			};
		},
		async cancel(providerOrderId: string, _args: BnplCancelArgs): Promise<void> {
			await client.closePayment(providerOrderId);
		},
		async closePayment(providerPaymentId: string): Promise<void> {
			await client.closePayment(providerPaymentId);
		},
		async verifyWebhook(req: WebhookRequest): Promise<BnplVerifyWebhookResult> {
			const result = verifyTabbyHeaderSecret(req.headers, webhookConfig);
			if (!result.ok) return result;
			const parsed = parseJsonObject(req.rawBody);
			if (!parsed.ok) return parsed;
			return {
				ok: true,
				payload: parsed.data,
				dedupKey: tabbyDedupKey(parsed.data),
				rawBody: req.rawBody,
			};
		},
		webhookDedupKey(event: BnplWebhookEvent): string {
			return tabbyWebhookDedupKeyForEvent(event);
		},
		toCanonicalEvent(payload: Record<string, unknown>): BnplWebhookEvent | null {
			return tabbyToCanonicalEvent(payload);
		},
		async preCheck(input: BnplPreCheckInput, ctx: ProviderContext): Promise<BnplPreCheckResult> {
			const country = input.countryCode.toUpperCase();
			if (!isOneOf(country, TABBY_COUNTRY_CODES)) {
				return { available: false, reason: "country_not_supported" };
			}
			const currency = input.amount.currency;
			if (!isOneOf(currency, TABBY_CURRENCIES)) {
				return { available: false, reason: "currency_not_supported" };
			}
			const limits = bounds[currency];
			if (!limits) {
				return { available: true };
			}
			let amountMinor: number;
			try {
				amountMinor = parseAmount(input.amount);
			} catch (e) {
				throw new BnplPluginError(
					"INVALID_AMOUNT",
					`tabby: preCheck amount invalid: ${e instanceof Error ? e.message : e}`,
				);
			}
			if (amountMinor < limits.minMinor) {
				return { available: false, reason: "amount_too_low" };
			}
			if (amountMinor > limits.maxMinor) {
				return { available: false, reason: "amount_too_high" };
			}
			const fallbackAvailable = tabbyDefaultAvailablePreCheck();
			if (!input.email || !input.phone) {
				return fallbackAvailable;
			}
			try {
				const response = await client.checkEligibility({
					payment: {
						amount: input.amount.amount,
						currency: input.amount.currency,
						buyer: {
							email: input.email,
							phone: input.phone,
						},
					},
					merchant_code: options.merchantCode,
					lang: "en",
				});
				return mapEligibilityResponse(response);
			} catch (e) {
				ctx.logger.warn(
					`tabby: eligibility check failed, falling back to local availability: ${e instanceof Error ? e.message : e}`,
				);
				return fallbackAvailable;
			}
		},
	};
}
function tabbyDefaultAvailablePreCheck(): BnplPreCheckResult {
	return {
		available: true,
		availablePaymentTypes: [
			{
				paymentType: "PAY_BY_INSTALMENTS",
				instalments: 4,
				descriptionEn: "Pay in 4 monthly installments",
				descriptionAr: "ادفع على 4 دفعات شهرية",
			},
		],
	};
}
function mapEligibilityResponse(response: TabbyCheckoutResponse): BnplPreCheckResult {
	const installments = response.configuration.products?.installments;
	const hasInstallmentsUrl =
		(response.configuration.available_products?.installments?.length ?? 0) > 0;
	if (
		response.status === "rejected" ||
		(installments?.is_available === false && !hasInstallmentsUrl)
	) {
		return { available: false, reason: installments?.rejection_reason ?? "rejected" };
	}
	return tabbyDefaultAvailablePreCheck();
}
function mapCheckoutResponse(
	response: TabbyCheckoutResponse,
	preferredProduct: "installments" | "pay_later" | "pay_in_full",
): BnplCheckoutResult {
	const productOptions = response.configuration.available_products?.[preferredProduct] ?? [];
	const firstOption = productOptions[0];
	const firstUrl = firstOption?.web_url;
	const qr = firstOption?.qr_code;
	const productInfo = response.configuration.products?.[preferredProduct];
	const rejectionReason = productInfo?.rejection_reason ?? null;
	if (response.status === "rejected" || (productInfo && productInfo.is_available === false)) {
		return {
			providerOrderId: response.payment.id,
			providerCheckoutId: response.id,
			status: "declined",
			rejectionReason: rejectionReason ?? "rejected",
			raw: response,
		};
	}
	if (!firstUrl) {
		throw new BnplProviderError(
			"tabby",
			`Tabby returned no hosted-checkout URL for product \`${preferredProduct}\``,
			{ body: response },
		);
	}
	return {
		providerOrderId: response.payment.id,
		providerCheckoutId: response.id,
		checkoutUrl: firstUrl,
		status: "new",
		qrCodeUrl: qr,
		raw: response,
	};
}
export { TabbyClient } from "./client";
export type { TabbyClientConfig, TabbyEnvironment } from "./client";
export {
	tabbyCheckoutCreationOrderHistorySchema,
	tabbyCheckoutDataSchema,
	tabbyEducationAttachmentSchema,
} from "./schemas";
export type {
	TabbyCheckoutCreationOrderHistory,
	TabbyCheckoutData,
	TabbyDeleteWebhookResponse,
	TabbyEducationAttachment,
	TabbyListWebhooksResponse,
	TabbyRegisterWebhookRequest,
	TabbyUpdateWebhookRequest,
	TabbyUpdateWebhookResponse,
	TabbyWebhookDetails,
	TabbyWebhookHeader,
	TabbyWebhookResponseHeader,
	TabbyWebhookRegistration,
} from "./types";
