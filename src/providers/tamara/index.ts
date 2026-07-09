import { BnplPluginError, BnplProviderError } from "../../core/errors";
import { isMoneyLike, isOneOf } from "../../core/guards";
import { parseJsonObject } from "../../core/json";
import { type BnplCurrency, formatAmount, isBnplCurrency, parseAmount } from "../../core/money";
import type {
	BnplProvider,
	ProviderContext,
	ProviderDisplay,
	ProviderFetch,
	WebhookRequest,
} from "../../core/provider";
import type {
	BnplAuthorizeResult,
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
import type { AbsoluteUrl } from "../../core/url";
import {
	tamaraDedupKey,
	tamaraStatusToCanonical,
	tamaraToCanonicalEvent,
	tamaraWebhookDedupKeyForEvent,
	toTamaraCheckoutRequest,
	toTamaraItem,
} from "./adapter";
import { TamaraClient } from "./client";
import { TAMARA_COUNTRY_CODES, TAMARA_CURRENCIES, type TamaraLocale } from "./constants";
import type { TamaraAuthoriseResponse } from "./types";
import {
	TamaraWebhookVerificationError,
	extractTamaraToken,
	verifyTamaraJwt,
} from "./webhook-verify";
export interface TamaraOptions {
	apiToken: string;
	notificationToken: string;
	environment?: "sandbox" | "production";
	baseUrl?: string;
	fetch?: ProviderFetch;
	timeoutMs?: number;
	defaultLocale?: TamaraLocale;
	replayToleranceSeconds?: number | false;
	storeCode?: string;
	display?: Partial<ProviderDisplay>;
}
export interface TamaraShippingInfo {
	shippedAt: string;
	shippingCompany: string;
	trackingNumber?: string;
	trackingUrl?: AbsoluteUrl;
}
export interface TamaraCaptureArgs extends BnplCaptureArgs {
	shippingInfo: TamaraShippingInfo;
}
export interface TamaraCancelArgs extends BnplCancelArgs {
	totalAmount: NonNullable<BnplCancelArgs["totalAmount"]>;
}
const DEFAULT_DISPLAY = {
	displayName: "Tamara",
	logoUrl: "https://cdn.tamara.co/assets/logo.svg",
	tagline: "Pay later, no interest, no fees",
} as const;
const DEFAULT_REPLAY_TOLERANCE_SECONDS = 300;
function requireTamaraShippingInfo(value: BnplCaptureArgs["shippingInfo"]): TamaraShippingInfo {
	if (!value) {
		throw new BnplPluginError(
			"SHIPPING_INFO_REQUIRED",
			"tamara: capture requires `shippingInfo.shippedAt` and `shippingInfo.shippingCompany` because Tamara's capture API requires shipping_info.shipped_at and shipping_info.shipping_company",
		);
	}
	const shippedAt = value?.shippedAt?.trim();
	const shippingCompany = value?.shippingCompany?.trim();
	if (shippedAt && shippingCompany) {
		return {
			shippedAt,
			shippingCompany,
			trackingNumber: value.trackingNumber,
			trackingUrl: value.trackingUrl,
		};
	}
	throw new BnplPluginError(
		"SHIPPING_INFO_REQUIRED",
		"tamara: capture requires `shippingInfo.shippedAt` and `shippingInfo.shippingCompany` because Tamara's capture API requires shipping_info.shipped_at and shipping_info.shipping_company",
	);
}
function requireTamaraCancelAmount(
	value: BnplCancelArgs["totalAmount"],
): NonNullable<BnplCancelArgs["totalAmount"]> {
	if (value) return value;
	throw new BnplPluginError(
		"TOTAL_AMOUNT_REQUIRED",
		"tamara: cancel requires `totalAmount` because Tamara's cancel API requires total_amount",
	);
}
export function tamara(
	options: TamaraOptions,
): BnplProvider<"tamara", TamaraCaptureArgs, BnplRefundArgs, TamaraCancelArgs> {
	const client = new TamaraClient({
		apiToken: options.apiToken,
		environment: options.environment,
		baseUrl: options.baseUrl,
		fetch: options.fetch,
		timeoutMs: options.timeoutMs,
	});
	const display = { ...DEFAULT_DISPLAY, ...options.display };
	return {
		id: "tamara",
		display,
		capabilities: {
			preCheck: true,
			separateAuthorise: true,
			voidCheckout: true,
			closePayment: false,
			partialCapture: true,
			partialRefund: true,
			multipleCaptures: true,
			disputes: false,
		},
		supportedCountries: TAMARA_COUNTRY_CODES,
		supportedCurrencies: TAMARA_CURRENCIES,
		async createCheckout(input: BnplCheckoutInput): Promise<BnplCheckoutResult> {
			const tamaraRequest = toTamaraCheckoutRequest(input, {
				defaultLocale: options.defaultLocale,
			});
			const response = await client.createCheckout(tamaraRequest);
			const status = tamaraStatusToCanonical(response.status);
			if (status === "declined") {
				return {
					providerOrderId: response.order_id,
					providerCheckoutId: response.checkout_id,
					status,
					rejectionReason: "declined",
					raw: response,
				};
			}
			return {
				providerOrderId: response.order_id,
				providerCheckoutId: response.checkout_id,
				checkoutUrl: response.checkout_url,
				status,
				raw: response,
			};
		},
		async fetchOrder(providerOrderId: string): Promise<BnplOrderState> {
			const remote = await client.getOrder(providerOrderId);
			const currencyRaw = remote.total_amount.currency;
			if (!isBnplCurrency(currencyRaw)) {
				throw new BnplProviderError(
					"tamara",
					`tamara returned unsupported currency: ${currencyRaw}`,
					{ body: remote },
				);
			}
			const currency: BnplCurrency = currencyRaw;
			const totalMinor = parseAmount({ amount: remote.total_amount.amount, currency });
			const capturedMinor = remote.captured_amount
				? parseAmount({ amount: remote.captured_amount.amount, currency })
				: 0;
			const refundedMinor = remote.refunded_amount
				? parseAmount({ amount: remote.refunded_amount.amount, currency })
				: 0;
			return {
				providerOrderId: remote.order_id,
				orderReferenceId: remote.order_reference_id,
				status: tamaraStatusToCanonical(remote.status),
				totalAmount:
					typeof remote.total_amount.amount === "string"
						? { amount: remote.total_amount.amount, currency }
						: formatAmount(totalMinor, currency),
				capturedAmountMinor: capturedMinor,
				refundedAmountMinor: refundedMinor,
				raw: remote,
			};
		},
		async capture(
			providerOrderId: string,
			args: TamaraCaptureArgs,
			ctx: ProviderContext,
		): Promise<BnplCaptureResult> {
			const shippingInfo = requireTamaraShippingInfo(args.shippingInfo);
			const response = await client.captureOrder({
				order_id: providerOrderId,
				total_amount: args.totalAmount,
				shipping_amount: args.shippingAmount,
				tax_amount: args.taxAmount,
				discount_amount: args.discountAmount,
				items: args.items?.map(toTamaraItem),
				shipping_info: {
					shipped_at: shippingInfo.shippedAt,
					shipping_company: shippingInfo.shippingCompany,
					tracking_number: shippingInfo.trackingNumber,
					tracking_url: shippingInfo.trackingUrl,
				},
			});
			ctx.logger.info(
				`tamara: captured ${args.totalAmount.amount} ${args.totalAmount.currency} for ${providerOrderId} (capture_id=${response.capture_id})`,
			);
			return {
				captureId: response.capture_id,
				providerOrderId: response.order_id,
				amountMinor: parseAmount(args.totalAmount),
				raw: response,
			};
		},
		async refund(providerOrderId: string, args: BnplRefundArgs): Promise<BnplRefundResult> {
			const response = await client.simplifiedRefund(providerOrderId, {
				total_amount: args.totalAmount,
				comment: args.comment ?? "Refund",
				merchant_refund_id: args.merchantRefundId,
			});
			return {
				refundId: response.refund_id,
				providerOrderId: response.order_id,
				amountMinor: parseAmount(args.totalAmount),
				raw: response,
			};
		},
		async cancel(providerOrderId: string, args: TamaraCancelArgs): Promise<void> {
			const totalAmount = requireTamaraCancelAmount(args.totalAmount);
			await client.cancelOrder(providerOrderId, {
				total_amount: totalAmount,
				shipping_amount: args.shippingAmount,
				tax_amount: args.taxAmount,
				discount_amount: args.discountAmount,
				items: args.items?.map(toTamaraItem),
			});
		},
		async authorize(providerOrderId: string): Promise<BnplAuthorizeResult> {
			const response = await client.authoriseOrder(providerOrderId);
			const status = tamaraStatusToCanonical(response.status);
			const autoCapture = readTamaraAutoCapture(response, status);
			return {
				providerOrderId: response.order_id,
				status,
				...autoCapture,
				raw: response,
			};
		},
		async voidCheckout(checkoutId: string, providerOrderId: string): Promise<void> {
			await client.voidCheckoutSession(checkoutId, {
				order_id: providerOrderId,
				store_code: options.storeCode,
			});
		},
		async verifyWebhook(req: WebhookRequest): Promise<BnplVerifyWebhookResult> {
			const token = extractTamaraToken(req);
			if (!token) {
				return { ok: false, reason: "missing token (?tamaraToken or Bearer)" };
			}
			try {
				const verified = verifyTamaraJwt(token, options.notificationToken);
				const tolerance = options.replayToleranceSeconds ?? DEFAULT_REPLAY_TOLERANCE_SECONDS;
				const iat = verified.payload.iat;
				if (tolerance !== false && typeof iat === "number") {
					const ageSeconds = Math.abs(Date.now() / 1000 - iat);
					if (ageSeconds > tolerance) {
						return {
							ok: false,
							reason: `JWT iat outside replay tolerance window (${ageSeconds.toFixed(0)}s > ${tolerance}s)`,
						};
					}
				}
				const parsed = parseJsonObject(req.rawBody);
				if (!parsed.ok) return parsed;
				return {
					ok: true,
					payload: parsed.data,
					dedupKey: tamaraDedupKey(parsed.data),
					rawBody: req.rawBody,
				};
			} catch (err) {
				if (err instanceof TamaraWebhookVerificationError) {
					return { ok: false, reason: err.message };
				}
				throw err;
			}
		},
		webhookDedupKey(event: BnplWebhookEvent): string {
			return tamaraWebhookDedupKeyForEvent(event);
		},
		toCanonicalEvent(payload: Record<string, unknown>): BnplWebhookEvent | null {
			return tamaraToCanonicalEvent(payload);
		},
		async preCheck(input: BnplPreCheckInput): Promise<BnplPreCheckResult> {
			if (!input.phone) {
				return {
					available: false,
					reason: "phone_required",
				};
			}
			if (!isOneOf(input.countryCode, TAMARA_COUNTRY_CODES)) {
				return {
					available: false,
					reason: "unsupported_country",
				};
			}
			try {
				const response = await client.preCheckoutEligibility({
					order: {
						amount: Number(formatAmount(parseAmount(input.amount), input.amount.currency).amount),
						currency: input.amount.currency,
					},
					customer: {
						phone: input.phone,
					},
				});
				return {
					available: response.is_eligible,
				};
			} catch (e) {
				if (e instanceof BnplProviderError) {
					return { available: false, reason: e.message };
				}
				throw e;
			}
		},
	};
}
function readTamaraAutoCapture(
	response: TamaraAuthoriseResponse,
	status: BnplAuthorizeResult["status"],
): Pick<BnplAuthorizeResult, "autoCaptured" | "captureId" | "capturedAmountMinor"> {
	const autoCaptured = response.auto_captured === true || status === "fully_captured";
	if (!autoCaptured) return {};
	const captureId = typeof response.capture_id === "string" ? response.capture_id : undefined;
	const authorizedAmount = response.authorized_amount;
	const capturedAmountMinor =
		isMoneyLike(authorizedAmount) && isBnplCurrency(authorizedAmount.currency)
			? parseAmount(authorizedAmount)
			: undefined;
	return {
		autoCaptured: true,
		captureId: captureId || undefined,
		capturedAmountMinor,
	};
}
export { TamaraClient } from "./client";
export type { TamaraClientConfig } from "./client";
export {
	TAMARA_COUNTRY_CODES,
	TAMARA_CURRENCIES,
	TAMARA_LOCALES,
	TAMARA_PAYMENT_TYPES,
} from "./constants";
export type {
	TamaraCountryCode,
	TamaraCurrency,
	TamaraLocale,
	TamaraPaymentType,
} from "./constants";
export type {
	TamaraRegisterWebhookRequest,
	TamaraUpdateReferenceIdResponse,
	TamaraUpdateWebhookRequest,
	TamaraWebhookDetails,
	TamaraWebhookRegistrationResponse,
} from "./types";
