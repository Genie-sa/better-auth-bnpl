import type { z } from "zod";
import type { AbsoluteUrl } from "../../core/url";
import type { TamaraKnownWebhookEventType } from "./constants";
import type {
	tamaraAddressRequestSchema,
	tamaraCancelBodySchema,
	tamaraCaptureBodySchema,
	tamaraCheckoutRequestSchema,
	tamaraConsumerRequestSchema,
	tamaraOrderItemRequestSchema,
	tamaraPreCheckoutEligibilityRequestSchema,
	tamaraRegisterWebhookRequestSchema,
	tamaraSimplifiedRefundBodySchema,
	tamaraUpdateReferenceIdRequestSchema,
	tamaraUpdateWebhookRequestSchema,
	tamaraVoidQuerySchema,
} from "./schemas";
export interface TamaraMoney {
	amount: number | string;
	currency: string;
}
export type TamaraAddress = z.input<typeof tamaraAddressRequestSchema>;
export type TamaraConsumer = z.input<typeof tamaraConsumerRequestSchema>;
export type TamaraOrderItem = z.input<typeof tamaraOrderItemRequestSchema>;
export type TamaraMerchantUrl = z.input<typeof tamaraCheckoutRequestSchema>["merchant_url"];
export type TamaraCheckoutRequest = z.input<typeof tamaraCheckoutRequestSchema>;
export interface TamaraCheckoutResponse {
	order_id: string;
	checkout_id: string;
	checkout_url: AbsoluteUrl;
	status: string;
	[k: string]: unknown;
}
export interface TamaraOrderDetailsResponse {
	order_id: string;
	order_reference_id: string;
	status: string;
	total_amount: TamaraMoney;
	captured_amount?: TamaraMoney;
	refunded_amount?: TamaraMoney;
	[k: string]: unknown;
}
export interface TamaraCaptureResponse {
	capture_id: string;
	order_id: string;
	[k: string]: unknown;
}
export interface TamaraSimplifiedRefundResponse {
	refund_id: string;
	order_id: string;
	[k: string]: unknown;
}
export interface TamaraCancelResponse {
	order_id: string;
	status: string;
	[k: string]: unknown;
}
export interface TamaraVoidResponse {
	order_was_voided: boolean;
	[k: string]: unknown;
}
export interface TamaraAuthoriseResponse {
	order_id: string;
	status: string;
	[k: string]: unknown;
}
export interface TamaraPreCheckoutEligibilityResponse {
	is_eligible: boolean;
	[k: string]: unknown;
}
export type TamaraRegisterWebhookRequest = z.input<typeof tamaraRegisterWebhookRequestSchema>;
export type TamaraUpdateWebhookRequest = z.input<typeof tamaraUpdateWebhookRequestSchema>;
export type TamaraCaptureBody = z.input<typeof tamaraCaptureBodySchema>;
export type TamaraSimplifiedRefundBody = z.input<typeof tamaraSimplifiedRefundBodySchema>;
export type TamaraCancelBody = z.input<typeof tamaraCancelBodySchema>;
export type TamaraVoidQuery = z.input<typeof tamaraVoidQuerySchema>;
export type TamaraPreCheckoutEligibilityRequest = z.input<
	typeof tamaraPreCheckoutEligibilityRequestSchema
>;
export type TamaraUpdateReferenceIdRequest = z.input<typeof tamaraUpdateReferenceIdRequestSchema>;
export interface TamaraWebhookRegistrationResponse {
	webhook_id: string;
	[k: string]: unknown;
}
export interface TamaraWebhookDetails {
	webhook_id: string;
	url: string;
	events: string[];
	type?: string;
	headers?: Record<string, unknown>;
	[k: string]: unknown;
}
export interface TamaraUpdateReferenceIdResponse {
	order_id?: string;
	message?: string;
	[k: string]: unknown;
}
export interface TamaraMessageBase<T = Record<string, unknown>> {
	order_id: string;
	order_reference_id: string;
	data: T;
}
export interface TamaraAuthoriseMessage<T = Record<string, unknown>> extends TamaraMessageBase<T> {
	order_status: string;
}
export type TamaraWebhookEventType = TamaraKnownWebhookEventType | (string & {});
export interface TamaraWebhookEvent<T = Record<string, unknown>> extends TamaraMessageBase<T> {
	event_type: TamaraWebhookEventType;
}
export type TamaraIncomingMessage<T = Record<string, unknown>> =
	| TamaraAuthoriseMessage<T>
	| TamaraWebhookEvent<T>;
export const isTamaraAuthoriseMessage = (
	msg: Partial<TamaraIncomingMessage>,
): msg is TamaraAuthoriseMessage => "order_status" in msg && typeof msg.order_status === "string";
export const isTamaraWebhookEvent = (
	msg: Partial<TamaraIncomingMessage>,
): msg is TamaraWebhookEvent => "event_type" in msg && typeof msg.event_type === "string";
