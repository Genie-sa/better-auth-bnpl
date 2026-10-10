import { BnplPluginError, BnplProviderError } from "../../core/errors";
import { isOneOf, isRecord } from "../../core/guards";
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
	tabbyProductKeyForPaymentType,
	tabbySnapshotDedupKey,
	tabbyToCanonicalEvent,
	tabbyToCanonicalEvents,
	tabbyWebhookDedupKeyForEvent,
	toTabbyCheckoutRequest,
	toTabbyItem,
} from "./adapter";
import { TabbyClient, type TabbyEnvironment } from "./client";
import type { TabbyCaptureRecord, TabbyCheckoutResponse, TabbyPaymentDetails } from "./types";
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
function operationRecord(
	payment: TabbyPaymentDetails,
	providerOrderId: string,
	referenceId: string,
	money: BnplCaptureArgs["totalAmount"],
	operation: "capture" | "refund",
): { record: TabbyCaptureRecord; amountMinor: number } {
	if (payment.id !== providerOrderId || payment.currency !== money.currency) {
		throw new BnplProviderError(
			"tabby",
			`${operation} response payment identity or currency mismatch`,
		);
	}
	const records = operation === "capture" ? payment.captures : payment.refunds;
	const matches = records?.filter((record) => record.reference_id === referenceId) ?? [];
	const record = matches[0];
	if (matches.length !== 1 || !record?.id) {
		throw new BnplProviderError(
			"tabby",
			`${operation} response missing unique matching operation record`,
		);
	}
	const amountMinor = parseAmount({ amount: record.amount, currency: payment.currency });
	if (amountMinor !== parseAmount(money)) {
		throw new BnplProviderError(
			"tabby",
			`${operation} reference was applied with a different amount`,
		);
	}
	return { record, amountMinor };
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
	async function closePayment(providerOrderId: string, ctx: ProviderContext): Promise<void> {
		const payment = await client.closePayment(providerOrderId);
		if (payment.id !== providerOrderId)
			throw new BnplProviderError("tabby", "closed payment identity mismatch");
		if (payment.status.toUpperCase() !== "CLOSED")
			throw new BnplProviderError("tabby", "payment was not closed");
		fromTabbyPaymentDetails(payment, ctx.logger);
	}
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
			disputes: false,
		},
		supportedCountries: TABBY_COUNTRY_CODES,
		supportedCurrencies: TABBY_CURRENCIES,
		async createCheckout(
			input: BnplCheckoutInput,
			ctx: ProviderContext,
		): Promise<BnplCheckoutResult> {
			const tabbyRequest = toTabbyCheckoutRequest(input, {
				merchantCode: options.merchantCode,
			});
			const response = await client.createCheckout(tabbyRequest);
			const payment = response.payment;
			const derived = fromTabbyPaymentDetails(payment, ctx.logger);
			if (
				payment.currency !== input.totalAmount.currency ||
				derived.totalMinor !== parseAmount(input.totalAmount) ||
				(isRecord(payment.order) &&
					payment.order.reference_id !== undefined &&
					payment.order.reference_id !== input.orderReferenceId)
			)
				throw new BnplProviderError("tabby", "checkout response financial identity mismatch", {
					body: response,
				});
			const result = mapCheckoutResponse(
				response,
				tabbyProductKeyForPaymentType(input.paymentType),
			);
			if (
				result.status !== "declined" &&
				(response.status !== "created" ||
					payment.status.toUpperCase() !== "CREATED" ||
					derived.capturedMinor !== 0 ||
					derived.refundedMinor !== 0)
			)
				throw new BnplProviderError(
					"tabby",
					"checkout response is not an unfunded created payment",
					{
						body: response,
					},
				);
			return result;
		},
		async fetchOrder(providerOrderId: string, ctx: ProviderContext): Promise<BnplOrderState> {
			const payment = await client.getPayment(providerOrderId);
			if (payment.id !== providerOrderId)
				throw new BnplProviderError("tabby", "retrieved payment identity mismatch");
			const derived = fromTabbyPaymentDetails(payment, ctx.logger);
			return {
				providerOrderId: payment.id,
				orderReferenceId:
					typeof payment.order === "object" &&
					payment.order !== null &&
					"reference_id" in payment.order &&
					typeof payment.order.reference_id === "string"
						? payment.order.reference_id
						: undefined,
				status: derived.status,
				totalAmount: formatAmount(derived.totalMinor, payment.currency),
				capturedAmountMinor: derived.capturedMinor,
				refundedAmountMinor: derived.refundedMinor,
				operations: [
					...(payment.captures ?? []).map((record) => ({
						id: record.id,
						kind: "captured" as const,
						amountMinor: parseAmount({ amount: record.amount, currency: payment.currency }),
						currency: formatAmount(0, payment.currency).currency,
					})),
					...(payment.refunds ?? []).map((record) => ({
						id: record.id,
						kind: "refunded" as const,
						amountMinor: parseAmount({ amount: record.amount, currency: payment.currency }),
						currency: formatAmount(0, payment.currency).currency,
					})),
				],
				raw: payment,
			};
		},
		async capture(
			providerOrderId: string,
			args: TabbyCaptureArgs,
			ctx: ProviderContext,
		): Promise<BnplCaptureResult> {
			const referenceId = requireTabbyReferenceId(args.merchantReferenceId, "capture");
			if (parseAmount(args.totalAmount) <= 0)
				throw new BnplProviderError("tabby", "capture amount must be positive");
			const response = await client.capture(providerOrderId, {
				amount: args.totalAmount.amount,
				reference_id: referenceId,
				tax_amount: args.taxAmount?.amount,
				shipping_amount: args.shippingAmount?.amount,
				discount_amount: args.discountAmount?.amount,
				items: args.items?.map(toTabbyItem),
			});
			const { record: latest, amountMinor } = operationRecord(
				response,
				providerOrderId,
				referenceId,
				args.totalAmount,
				"capture",
			);
			ctx.logger.info(
				`tabby: captured ${args.totalAmount.amount} ${args.totalAmount.currency} for ${providerOrderId} (capture_id=${latest.id})`,
			);
			return {
				captureId: latest.id,
				providerOrderId: response.id,
				amountMinor,
				raw: response,
			};
		},
		async refund(
			providerOrderId: string,
			args: TabbyRefundArgs,
			ctx: ProviderContext,
		): Promise<BnplRefundResult> {
			const referenceId = requireTabbyReferenceId(args.merchantRefundId, "refund");
			if (parseAmount(args.totalAmount) <= 0)
				throw new BnplProviderError("tabby", "refund amount must be positive");
			const response = await client.refund(providerOrderId, {
				amount: args.totalAmount.amount,
				reference_id: referenceId,
				reason: args.comment,
				items: args.items?.map(toTabbyItem),
			});
			const { record: latest, amountMinor } = operationRecord(
				response,
				providerOrderId,
				referenceId,
				args.totalAmount,
				"refund",
			);
			ctx.logger.info(
				`tabby: refunded ${args.totalAmount.amount} ${args.totalAmount.currency} for ${providerOrderId} (refund_id=${latest.id})`,
			);
			return {
				refundId: latest.id,
				providerOrderId: response.id,
				amountMinor,
				raw: response,
			};
		},
		async cancel(
			providerOrderId: string,
			args: BnplCancelArgs,
			ctx: ProviderContext,
		): Promise<void> {
			if (args.totalAmount) {
				const payment = await client.getPayment(providerOrderId);
				if (payment.id !== providerOrderId)
					throw new BnplProviderError("tabby", "cancel payment identity mismatch");
				const derived = fromTabbyPaymentDetails(payment, ctx.logger);
				const amountMinor = parseAmount(args.totalAmount);
				if (
					args.totalAmount.currency !== payment.currency ||
					amountMinor <= 0 ||
					amountMinor !== derived.totalMinor - derived.capturedMinor
				)
					throw new BnplProviderError(
						"tabby",
						"cancel must cover the full uncaptured balance in the payment currency",
					);
			}
			await closePayment(providerOrderId, ctx);
		},
		closePayment,
		async verifyWebhook(req: WebhookRequest): Promise<BnplVerifyWebhookResult> {
			const result = verifyTabbyHeaderSecret(req.headers, webhookConfig);
			if (!result.ok) return result;
			const parsed = parseJsonObject(req.rawBody);
			if (!parsed.ok) return parsed;
			return {
				ok: true,
				payload: parsed.data,
				dedupKey: tabbySnapshotDedupKey(parsed.data),
				rawBody: req.rawBody,
			};
		},
		webhookDedupKey(event: BnplWebhookEvent): string {
			return tabbyWebhookDedupKeyForEvent(event);
		},
		toCanonicalEvents(payload: Record<string, unknown>): BnplWebhookEvent[] {
			return tabbyToCanonicalEvents(payload);
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
				if (
					e instanceof BnplProviderError &&
					e.status !== undefined &&
					e.status >= 400 &&
					e.status < 500 &&
					e.status !== 429
				)
					throw e;
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
