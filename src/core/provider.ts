import type { BnplCurrency } from "./money";
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
} from "./types";
import type { AbsoluteUrl } from "./url";
export interface ProviderLogger {
	info: (msg: string) => void;
	warn: (msg: string) => void;
	error: (msg: string) => void;
	debug?: (msg: string) => void;
}
export interface ProviderContext {
	logger: ProviderLogger;
}
export type ProviderFetch = typeof globalThis.fetch;
export interface WebhookRequest {
	url: string;
	headers: Headers;
	rawBody: string;
}
export interface ProviderCapabilities {
	preCheck: boolean;
	separateAuthorise: boolean;
	voidCheckout: boolean;
	closePayment: boolean;
	partialCapture: boolean;
	partialRefund: boolean;
	multipleCaptures: boolean;
	disputes: boolean;
}
export interface ProviderDisplay {
	displayName: string;
	logoUrl?: AbsoluteUrl;
	tagline?: string;
}
export interface BnplProvider<
	Id extends string = string,
	CaptureArgs extends BnplCaptureArgs = BnplCaptureArgs,
	RefundArgs extends BnplRefundArgs = BnplRefundArgs,
	CancelArgs extends BnplCancelArgs = BnplCancelArgs,
> {
	readonly id: Id;
	readonly display: ProviderDisplay;
	readonly capabilities: ProviderCapabilities;
	readonly supportedCountries: readonly string[];
	readonly supportedCurrencies: readonly BnplCurrency[];
	createCheckout(input: BnplCheckoutInput, ctx: ProviderContext): Promise<BnplCheckoutResult>;
	fetchOrder(providerOrderId: string, ctx: ProviderContext): Promise<BnplOrderState>;
	capture(
		providerOrderId: string,
		args: CaptureArgs,
		ctx: ProviderContext,
	): Promise<BnplCaptureResult>;
	refund(
		providerOrderId: string,
		args: RefundArgs,
		ctx: ProviderContext,
	): Promise<BnplRefundResult>;
	cancel(providerOrderId: string, args: CancelArgs, ctx: ProviderContext): Promise<void>;
	verifyWebhook(req: WebhookRequest): Promise<BnplVerifyWebhookResult>;
	webhookDedupKey?(event: BnplWebhookEvent): string;
	toCanonicalEvent(payload: Record<string, unknown>): BnplWebhookEvent | null;
	preCheck(input: BnplPreCheckInput, ctx: ProviderContext): Promise<BnplPreCheckResult>;
	authorize?(providerOrderId: string, ctx: ProviderContext): Promise<BnplAuthorizeResult>;
	voidCheckout?(checkoutId: string, providerOrderId: string, ctx: ProviderContext): Promise<void>;
	closePayment?(providerPaymentId: string, ctx: ProviderContext): Promise<void>;
}
export type ProviderIds<P extends Record<string, BnplProvider>> = keyof P & string;
export type ProviderCaptureArgs<P extends BnplProvider> = P extends BnplProvider<
	string,
	infer Args,
	infer _RefundArgs,
	infer _CancelArgs
>
	? Args
	: BnplCaptureArgs;
export type ProviderRefundArgs<P extends BnplProvider> = P extends BnplProvider<
	string,
	infer _CaptureArgs,
	infer Args,
	infer _CancelArgs
>
	? Args
	: BnplRefundArgs;
export type ProviderCancelArgs<P extends BnplProvider> = P extends BnplProvider<
	string,
	infer _CaptureArgs,
	infer _RefundArgs,
	infer Args
>
	? Args
	: BnplCancelArgs;
