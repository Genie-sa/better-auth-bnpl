import { BnplPluginError, BnplProviderError, rejectedBeforeDispatch } from "../../core/errors";
import { isMoneyLike, isOneOf, isRecord } from "../../core/guards";
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
	BnplCancelResult,
	BnplCaptureArgs,
	BnplCaptureResult,
	BnplCheckoutInput,
	BnplCheckoutResult,
	BnplMoneyOperation,
	BnplOrderState,
	BnplPreCheckInput,
	BnplPreCheckResult,
	BnplRefundArgs,
	BnplRefundResult,
	BnplVerifyWebhookResult,
	BnplVoidResult,
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
import { tamaraSingleRefundResponseSchema, tamaraSplitRefundResponseSchema } from "./schemas";
import type { TamaraAuthoriseResponse, TamaraOrderDetailsResponse } from "./types";
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
	preCheckTimeoutMs?: number;
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
			undefined,
			{ rejected: true },
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
		undefined,
		{ rejected: true },
	);
}
const TAMARA_CANCEL_STATUSES = ["updated", "canceled"] as const;
function requireTamaraCancelAmount(
	value: BnplCancelArgs["totalAmount"],
): NonNullable<BnplCancelArgs["totalAmount"]> {
	if (value) return value;
	throw new BnplPluginError(
		"TOTAL_AMOUNT_REQUIRED",
		"tamara: cancel requires `totalAmount` because Tamara's cancel API requires total_amount",
		undefined,
		{ rejected: true },
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
	const eligibilityClient = new TamaraClient({
		apiToken: options.apiToken,
		environment: options.environment,
		baseUrl: options.baseUrl,
		fetch: options.fetch,
		timeoutMs: options.preCheckTimeoutMs ?? 200,
	});
	/** Nothing has been sent yet, so any failure to read the baseline is a rejection without effect. */
	async function readStateBeforeDispatch(providerOrderId: string): Promise<BnplOrderState> {
		try {
			return readTamaraOrderState(await client.getOrder(providerOrderId), providerOrderId);
		} catch (cause) {
			throw rejectedBeforeDispatch("tamara", cause);
		}
	}
	/** The mutation was accepted, so a failed read must stay uncertain rather than look like a rejection. */
	async function readStateAfterDispatch(
		providerOrderId: string,
		response: unknown,
	): Promise<BnplOrderState> {
		try {
			return readTamaraOrderState(await client.getOrder(providerOrderId), providerOrderId);
		} catch (cause) {
			throw new BnplProviderError(
				"tamara",
				"Tamara accepted the operation but its order could not be read to corroborate it",
				{ body: response, cause },
			);
		}
	}
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
			captureRequiresShipping: true,
			partialCancel: true,
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
			return readTamaraOrderState(await client.getOrder(providerOrderId), providerOrderId);
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
			assertResponseOrderId(response.order_id, providerOrderId, response);
			const requestedMinor = parseAmount(args.totalAmount);
			let amountMinor = readResponseMoney(
				response.captured_amount,
				args.totalAmount.currency,
				"captured_amount",
				response,
			);
			if (amountMinor !== requestedMinor) {
				const snapshot = await readStateAfterDispatch(providerOrderId, response);
				const native = snapshot.operations?.find(
					(operation) => operation.kind === "captured" && operation.id === response.capture_id,
				);
				if (
					!native ||
					native.amountMinor !== requestedMinor ||
					native.currency !== args.totalAmount.currency
				)
					throw new BnplProviderError(
						"tamara",
						"Tamara capture response could not be corroborated with its native transaction",
						{ body: response },
					);
				amountMinor = native.amountMinor;
			}
			ctx.logger.info(
				`tamara: captured ${args.totalAmount.amount} ${args.totalAmount.currency} for ${providerOrderId} (capture_id=${response.capture_id})`,
			);
			return {
				captureId: response.capture_id,
				providerOrderId: response.order_id,
				amountMinor,
				raw: response,
			};
		},
		async refund(providerOrderId: string, args: BnplRefundArgs): Promise<BnplRefundResult> {
			const before = await readStateBeforeDispatch(providerOrderId);
			const response = await client.simplifiedRefund(providerOrderId, {
				total_amount: args.totalAmount,
				comment: args.comment ?? "Refund",
				merchant_refund_id: args.merchantRefundId,
			});
			assertResponseOrderId(response.order_id, providerOrderId, response);
			const split = tamaraSplitRefundResponseSchema.safeParse(response);
			const entries = split.success
				? split.data.refunds
				: [tamaraSingleRefundResponseSchema.parse(response)];
			for (const entry of entries)
				readResponseMoney(
					entry.refunded_amount,
					args.totalAmount.currency,
					"refunded_amount",
					response,
				);
			const refundIds = new Set(entries.map((entry) => entry.refund_id));
			const after = await readStateAfterDispatch(providerOrderId, response);
			const prior = new Set(
				(before.operations ?? [])
					.filter((operation) => operation.kind === "refunded")
					.map((operation) => operation.id),
			);
			const created = (after.operations ?? []).filter(
				(operation) => operation.kind === "refunded" && !prior.has(operation.id),
			);
			const amountMinor = parseAmount(args.totalAmount);
			const [first] = entries;
			if (
				!first ||
				created.length !== refundIds.size ||
				created.some(
					(operation) =>
						!refundIds.has(operation.id) || operation.currency !== args.totalAmount.currency,
				) ||
				created.reduce((sum, operation) => sum + operation.amountMinor, 0) !== amountMinor
			)
				throw new BnplProviderError(
					"tamara",
					"Tamara refund response could not be corroborated with its native transactions",
					{ body: response },
				);
			return {
				refundId: first.refund_id,
				providerOrderId: response.order_id,
				amountMinor,
				operations: created,
				raw: response,
			};
		},
		async cancel(providerOrderId: string, args: TamaraCancelArgs): Promise<BnplCancelResult> {
			const totalAmount = requireTamaraCancelAmount(args.totalAmount);
			const response = await client.cancelOrder(providerOrderId, {
				total_amount: totalAmount,
				shipping_amount: args.shippingAmount,
				tax_amount: args.taxAmount,
				discount_amount: args.discountAmount,
				items: args.items?.map(toTamaraItem),
			});
			assertResponseOrderId(response.order_id, providerOrderId, response);
			const requestedMinor = parseAmount(totalAmount);
			let amountMinor = readResponseMoney(
				response.canceled_amount,
				totalAmount.currency,
				"canceled_amount",
				response,
			);
			if (amountMinor !== requestedMinor) {
				const snapshot = await readStateAfterDispatch(providerOrderId, response);
				const cancellation = snapshot.operations?.find(
					(operation) => operation.kind === "canceled" && operation.id === response.cancel_id,
				);
				if (
					amountMinor === 0 &&
					!isOneOf(response.status, TAMARA_CANCEL_STATUSES) &&
					snapshot.status !== "canceled" &&
					reportsCancellationHistory(snapshot) &&
					!cancellation
				)
					throw new BnplProviderError("tamara", "Tamara did not apply the cancellation", {
						body: response,
						rejected: true,
					});
				if (
					!cancellation ||
					cancellation.amountMinor !== requestedMinor ||
					cancellation.currency !== totalAmount.currency
				)
					throw new BnplProviderError(
						"tamara",
						"Tamara cancellation response could not be corroborated with its native transaction",
						{ body: response },
					);
				amountMinor = cancellation.amountMinor;
			}
			if (!isOneOf(response.status, TAMARA_CANCEL_STATUSES))
				throw new BnplProviderError(
					"tamara",
					`Tamara cancellation returned unexpected status: ${response.status}`,
					{ body: response },
				);
			return {
				providerOrderId: response.order_id,
				status: response.status,
				cancelId: response.cancel_id,
				amountMinor,
				raw: response,
			};
		},
		async authorize(providerOrderId: string): Promise<BnplAuthorizeResult> {
			const response = await client.authoriseOrder(providerOrderId);
			assertResponseOrderId(response.order_id, providerOrderId, response);
			const status = tamaraStatusToCanonical(response.status);
			const autoCapture = readTamaraAutoCapture(response, status);
			return {
				providerOrderId: response.order_id,
				status,
				...autoCapture,
				raw: response,
			};
		},
		async voidCheckout(checkoutId: string, providerOrderId: string): Promise<BnplVoidResult> {
			const response = await client.voidCheckoutSession(checkoutId, {
				order_id: providerOrderId,
				store_code: options.storeCode,
			});
			return {
				voided: response.order_was_voided,
				capturedAmountMinor: response.captured_amount
					? readResponseMoney(response.captured_amount, undefined, "captured_amount", response)
					: undefined,
				capturedCurrency:
					response.captured_amount && isBnplCurrency(response.captured_amount.currency)
						? response.captured_amount.currency
						: undefined,
				raw: response,
			};
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
			if (!isOneOf(input.countryCode, TAMARA_COUNTRY_CODES)) {
				return {
					available: false,
					reason: "unsupported_country",
				};
			}
			if (!input.phone) return { available: true };
			try {
				const response = await eligibilityClient.preCheckoutEligibility({
					order: {
						amount: Number(formatAmount(parseAmount(input.amount), input.amount.currency).amount),
						currency: input.amount.currency,
					},
					customer: {
						phone_number: input.phone,
						email: input.email,
					},
				});
				return {
					available: response.is_eligible,
				};
			} catch (e) {
				if (e instanceof BnplProviderError) {
					return { available: true, reason: "eligibility_check_unavailable" };
				}
				throw e;
			}
		},
	};
}
function reportsCancellationHistory(snapshot: BnplOrderState): boolean {
	const native = snapshot.raw;
	return (
		isRecord(native) && isRecord(native.transactions) && Array.isArray(native.transactions.cancels)
	);
}
function assertResponseOrderId(actual: string, expected: string, body: unknown): void {
	if (actual !== expected)
		throw new BnplProviderError("tamara", "Tamara returned a different order ID", { body });
}
function readResponseMoney(
	money: unknown,
	currency: BnplCurrency | undefined,
	label: string,
	body: unknown,
): number {
	if (
		!isMoneyLike(money) ||
		!isBnplCurrency(money.currency) ||
		(currency !== undefined && money.currency !== currency)
	) {
		throw new BnplProviderError("tamara", `Tamara returned invalid ${label} currency or amount`, {
			body,
		});
	}
	try {
		return parseAmount(money);
	} catch (cause) {
		throw new BnplProviderError("tamara", `Tamara returned invalid ${label}`, { body, cause });
	}
}
function readTamaraAutoCapture(
	response: TamaraAuthoriseResponse,
	status: BnplAuthorizeResult["status"],
): Pick<
	BnplAuthorizeResult,
	"autoCaptured" | "captureId" | "capturedAmountMinor" | "capturedCurrency"
> {
	const autoCaptured = response.auto_captured === true || status === "fully_captured";
	if (!autoCaptured) return {};
	const captureId = typeof response.capture_id === "string" ? response.capture_id : undefined;
	if (!captureId?.trim()) {
		throw new BnplProviderError(
			"tamara",
			"Tamara auto-capture response is missing its capture ID",
			{ body: response },
		);
	}
	const capturedAmountMinor = readResponseMoney(
		response.authorized_amount,
		undefined,
		"authorized_amount",
		response,
	);
	const authorized = response.authorized_amount;
	const currency = isMoneyLike(authorized) ? authorized.currency : undefined;
	return {
		autoCaptured: true,
		captureId,
		capturedAmountMinor,
		...(currency !== undefined && isBnplCurrency(currency) ? { capturedCurrency: currency } : {}),
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
	TamaraProviderData,
	TamaraRiskAssessment,
	TamaraUpdateReferenceIdResponse,
	TamaraUpdateWebhookRequest,
	TamaraWebhookDetails,
	TamaraWebhookRegistrationResponse,
} from "./types";

function readTamaraOrderState(
	remote: TamaraOrderDetailsResponse,
	providerOrderId: string,
): BnplOrderState {
	assertResponseOrderId(remote.order_id, providerOrderId, remote);
	const status = tamaraStatusToCanonical(remote.status);
	const currencyRaw = remote.total_amount.currency;
	if (!isBnplCurrency(currencyRaw)) {
		throw new BnplProviderError("tamara", `tamara returned unsupported currency: ${currencyRaw}`, {
			body: remote,
		});
	}
	const currency: BnplCurrency = currencyRaw;
	const totalMinor = readResponseMoney(remote.total_amount, currency, "total_amount", remote);
	const hasFinancialActivity =
		status === "partially_captured" ||
		status === "fully_captured" ||
		status === "partially_refunded" ||
		status === "fully_refunded" ||
		status === "updated" ||
		status === "canceled";
	const hasRefunds = status === "partially_refunded" || status === "fully_refunded";
	if (
		(!remote.captured_amount && hasFinancialActivity) ||
		(!remote.refunded_amount && (hasRefunds || status === "updated" || status === "canceled"))
	) {
		throw new BnplProviderError(
			"tamara",
			"Tamara order snapshot is missing required financial totals",
			{ body: remote },
		);
	}
	const capturedMinor = remote.captured_amount
		? readResponseMoney(remote.captured_amount, currency, "captured_amount", remote)
		: 0;
	const refundedMinor = remote.refunded_amount
		? readResponseMoney(remote.refunded_amount, currency, "refunded_amount", remote)
		: 0;
	const canceledMinor = remote.canceled_amount
		? readResponseMoney(remote.canceled_amount, currency, "canceled_amount", remote)
		: undefined;
	if (capturedMinor + (canceledMinor ?? 0) > totalMinor || refundedMinor > capturedMinor) {
		throw new BnplProviderError(
			"tamara",
			"Tamara order snapshot has inconsistent financial totals",
			{ body: remote },
		);
	}
	if ((canceledMinor ?? 0) > 0 && !remote.transactions?.cancels)
		throw new BnplProviderError("tamara", "Tamara order snapshot is missing cancellation history", {
			body: remote,
		});
	let operations: BnplMoneyOperation[] | undefined;
	if (remote.transactions) {
		operations = [];
		const captures = new Map<string, number>();
		const refunds = new Set<string>();
		const refundedByCapture = new Map<string, number>();
		let capturedSum = 0;
		let refundedSum = 0;
		const invalidHistory = () => {
			throw new BnplProviderError("tamara", "Tamara order transaction history is inconsistent", {
				body: remote,
			});
		};
		for (const capture of remote.transactions.captures) {
			if (
				captures.has(capture.capture_id) ||
				(capture.order_id && capture.order_id !== remote.order_id)
			)
				invalidHistory();
			const amountMinor = readResponseMoney(
				capture.total_amount,
				currency,
				"capture.total_amount",
				remote,
			);
			if (amountMinor <= 0) invalidHistory();
			if (
				capture.refunded_amount &&
				readResponseMoney(capture.refunded_amount, currency, "capture.refunded_amount", remote) >
					amountMinor
			)
				invalidHistory();
			captures.set(capture.capture_id, amountMinor);
			capturedSum += amountMinor;
			operations.push({ kind: "captured", id: capture.capture_id, amountMinor, currency });
		}
		for (const refund of remote.transactions.refunds) {
			if (refunds.has(refund.refund_id) || !captures.has(refund.capture_id)) invalidHistory();
			refunds.add(refund.refund_id);
			const amountMinor = readResponseMoney(
				refund.total_amount,
				currency,
				"refund.total_amount",
				remote,
			);
			if (amountMinor <= 0) invalidHistory();
			if (refund.refund_status !== "success") continue;
			const captureRefunds = (refundedByCapture.get(refund.capture_id) ?? 0) + amountMinor;
			if (
				!Number.isSafeInteger(captureRefunds) ||
				captureRefunds > (captures.get(refund.capture_id) ?? 0)
			)
				invalidHistory();
			refundedByCapture.set(refund.capture_id, captureRefunds);
			refundedSum += amountMinor;
			operations.push({ kind: "refunded", id: refund.refund_id, amountMinor, currency });
		}
		const cancels = new Set<string>();
		let canceledSum = 0;
		for (const cancel of remote.transactions.cancels ?? []) {
			if (cancels.has(cancel.cancel_id) || (cancel.order_id && cancel.order_id !== remote.order_id))
				invalidHistory();
			cancels.add(cancel.cancel_id);
			const amountMinor = readResponseMoney(
				cancel.total_amount,
				currency,
				"cancel.total_amount",
				remote,
			);
			if (amountMinor <= 0) invalidHistory();
			canceledSum += amountMinor;
			operations.push({ kind: "canceled", id: cancel.cancel_id, amountMinor, currency });
		}
		if (
			!Number.isSafeInteger(capturedSum) ||
			!Number.isSafeInteger(refundedSum) ||
			!Number.isSafeInteger(canceledSum) ||
			canceledSum !== (canceledMinor ?? 0) ||
			capturedSum !== capturedMinor ||
			refundedSum !== refundedMinor
		)
			invalidHistory();
	}
	return {
		providerOrderId: remote.order_id,
		orderReferenceId: remote.order_reference_id,
		status,
		totalAmount:
			typeof remote.total_amount.amount === "string"
				? { amount: remote.total_amount.amount, currency }
				: formatAmount(totalMinor, currency),
		capturedAmountMinor: capturedMinor,
		refundedAmountMinor: refundedMinor,
		...(canceledMinor !== undefined ? { canceledAmountMinor: canceledMinor } : {}),
		...(operations ? { operations } : {}),
		raw: remote,
	};
}
