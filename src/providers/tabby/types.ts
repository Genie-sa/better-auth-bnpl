import type { z } from "zod";
import type { AbsoluteUrl } from "../../core/url";
import type {
	tabbyBuyerHistoryRequestSchema,
	tabbyBuyerRequestSchema,
	tabbyCaptureRequestSchema,
	tabbyCheckoutRequestSchema,
	tabbyEligibilityCheckRequestSchema,
	tabbyEligibilityPaymentRequestSchema,
	tabbyMerchantUrlsRequestSchema,
	tabbyOrderItemRequestSchema,
	tabbyOrderRequestSchema,
	tabbyPaymentRequestSchema,
	tabbyRefundRequestSchema,
	tabbyRegisterWebhookRequestSchema,
	tabbyShippingAddressRequestSchema,
	tabbyUpdateWebhookRequestSchema,
	tabbyWebhookHeaderSchema,
} from "./schemas";
export interface TabbyMoney {
	amount: string;
	currency: string;
}
export type TabbyBuyer = z.input<typeof tabbyBuyerRequestSchema>;
export type TabbyEligibilityPayment = z.input<typeof tabbyEligibilityPaymentRequestSchema>;
export type TabbyShippingAddress = z.input<typeof tabbyShippingAddressRequestSchema>;
export type TabbyOrderItem = z.input<typeof tabbyOrderItemRequestSchema>;
export type TabbyOrder = z.input<typeof tabbyOrderRequestSchema>;
export type TabbyBuyerHistory = z.input<typeof tabbyBuyerHistoryRequestSchema>;
export type TabbyMerchantUrls = z.input<typeof tabbyMerchantUrlsRequestSchema>;
export type TabbyPayment = z.input<typeof tabbyPaymentRequestSchema>;
export type TabbyCheckoutRequest = z.input<typeof tabbyCheckoutRequestSchema>;
export type TabbyEligibilityCheckRequest = z.input<typeof tabbyEligibilityCheckRequestSchema>;
export interface TabbyProductOption {
	web_url: AbsoluteUrl;
	qr_code?: string;
	[k: string]: unknown;
}
export interface TabbyAvailableProducts {
	installments?: TabbyProductOption[];
	pay_later?: TabbyProductOption[];
	pay_in_full?: TabbyProductOption[];
}
export interface TabbyProductInfo {
	type: string;
	is_available: boolean;
	rejection_reason?: string | null;
	[k: string]: unknown;
}
export interface TabbyConfiguration {
	available_products?: TabbyAvailableProducts;
	products?: Record<string, TabbyProductInfo>;
}
export type TabbyPaymentStatus = "CREATED" | "AUTHORIZED" | "CLOSED" | "REJECTED" | "EXPIRED";
export interface TabbyPaymentDetails {
	id: string;
	status: string;
	amount: string;
	currency: string;
	created_at?: string;
	captures?: TabbyCaptureRecord[];
	refunds?: TabbyRefundRecord[];
	[k: string]: unknown;
}
export interface TabbyCheckoutResponse {
	id: string;
	status: "created" | "rejected" | "expired" | "approved";
	configuration: TabbyConfiguration;
	token?: string | null;
	payment: TabbyPaymentDetails;
	merchant_urls?: TabbyMerchantUrls;
	[k: string]: unknown;
}
export interface TabbyCaptureRecord {
	id: string;
	amount: string;
	created_at?: string;
	reference_id?: string;
	[k: string]: unknown;
}
export interface TabbyRefundRecord {
	id: string;
	amount: string;
	created_at?: string;
	reference_id?: string;
	reason?: string;
	[k: string]: unknown;
}
export type TabbyCaptureRequest = z.input<typeof tabbyCaptureRequestSchema>;
export type TabbyRefundRequest = z.input<typeof tabbyRefundRequestSchema>;
export type TabbyWebhookHeader = z.input<typeof tabbyWebhookHeaderSchema>;
export interface TabbyWebhookResponseHeader {
	title?: string | null;
	value?: string | null;
	[k: string]: unknown;
}
export type TabbyRegisterWebhookRequest = z.input<typeof tabbyRegisterWebhookRequestSchema>;
export type TabbyUpdateWebhookRequest = z.input<typeof tabbyUpdateWebhookRequestSchema>;
export interface TabbyWebhookRegistration {
	id: string;
	url: string;
	is_test: boolean;
	header?: TabbyWebhookResponseHeader | null;
	[k: string]: unknown;
}
export type TabbyWebhookDetails = TabbyWebhookRegistration;
export type TabbyListWebhooksResponse = TabbyWebhookDetails | TabbyWebhookDetails[] | null;
export interface TabbyUpdateWebhookResponse {
	id: string;
	url: string;
	header?: TabbyWebhookResponseHeader | null;
	[k: string]: unknown;
}
export interface TabbyDeleteWebhookResponse {
	status?: string;
	[k: string]: unknown;
}
export interface TabbyWebhookPayload extends TabbyPaymentDetails {
	event?: string;
	[k: string]: unknown;
}
