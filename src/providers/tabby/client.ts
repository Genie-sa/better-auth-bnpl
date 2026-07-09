import type { z } from "zod";
import type { ProviderFetch } from "../../core/provider";
import { type ProviderHttpMethod, type SleepFn, requestProviderJson } from "../http";
import { createOpenApiPathBuilder } from "../openapi-path";
import type { paths as TabbyOpenApiPaths } from "./openapi";
import {
	tabbyCaptureRequestSchema,
	tabbyCheckoutRequestSchema,
	tabbyCheckoutResponseSchema,
	tabbyDeleteWebhookResponseSchema,
	tabbyEligibilityCheckRequestSchema,
	tabbyListWebhooksResponseSchema,
	tabbyPaymentDetailsSchema,
	tabbyRefundRequestSchema,
	tabbyRegisterWebhookRequestSchema,
	tabbyUpdatePaymentReferenceRequestSchema,
	tabbyUpdateWebhookRequestSchema,
	tabbyWebhookRegistrationResponseSchema,
	tabbyWebhookUpdateResponseSchema,
} from "./schemas";
import type {
	TabbyCaptureRequest,
	TabbyCheckoutRequest,
	TabbyCheckoutResponse,
	TabbyDeleteWebhookResponse,
	TabbyEligibilityCheckRequest,
	TabbyListWebhooksResponse,
	TabbyPaymentDetails,
	TabbyRefundRequest,
	TabbyRegisterWebhookRequest,
	TabbyUpdateWebhookRequest,
	TabbyUpdateWebhookResponse,
	TabbyWebhookDetails,
	TabbyWebhookRegistration,
} from "./types";
const TABBY_BASE_URLS = {
	default: "https://api.tabby.ai",
	sa: "https://api.tabby.sa",
} as const;
export type TabbyEnvironment = "sandbox" | "production";
const tabbyPath = createOpenApiPathBuilder<TabbyOpenApiPaths>();
export interface TabbyClientConfig {
	secretKey: string;
	merchantCode: string;
	environment?: TabbyEnvironment;
	country?: "SA" | "AE" | "KW";
	baseUrl?: string;
	fetch?: ProviderFetch;
	timeoutMs?: number;
	sleep?: SleepFn;
}
export class TabbyClient {
	readonly baseUrl: string;
	readonly merchantCode: string;
	private readonly secretKey: string;
	private readonly fetchImpl: ProviderFetch;
	private readonly timeoutMs: number | undefined;
	private readonly sleep: SleepFn | undefined;
	constructor(config: TabbyClientConfig) {
		this.merchantCode = config.merchantCode;
		this.secretKey = config.secretKey;
		this.fetchImpl = config.fetch ?? globalThis.fetch;
		this.timeoutMs = config.timeoutMs;
		this.sleep = config.sleep;
		if (config.baseUrl) {
			this.baseUrl = config.baseUrl;
		} else {
			this.baseUrl = config.country === "SA" ? TABBY_BASE_URLS.sa : TABBY_BASE_URLS.default;
		}
	}
	private request<
		TResponseSchema extends z.ZodTypeAny,
		TBodySchema extends z.ZodTypeAny | undefined = undefined,
	>({
		method,
		path,
		schema,
		label,
		body,
		bodySchema,
		extraHeaders,
	}: {
		method: ProviderHttpMethod;
		path: string;
		schema: TResponseSchema;
		label: string;
		body?: TBodySchema extends z.ZodTypeAny ? z.input<TBodySchema> : unknown;
		bodySchema?: TBodySchema;
		extraHeaders?: Record<string, string>;
	}): Promise<z.infer<TResponseSchema>> {
		return requestProviderJson({
			provider: "tabby",
			providerName: "Tabby",
			baseUrl: this.baseUrl,
			fetchImpl: this.fetchImpl,
			method,
			headers: {
				Authorization: `Bearer ${this.secretKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
				...extraHeaders,
			},
			path,
			body,
			bodySchema,
			schema,
			label,
			timeoutMs: this.timeoutMs,
			sleep: this.sleep,
		});
	}
	async createCheckout(body: TabbyCheckoutRequest): Promise<TabbyCheckoutResponse> {
		return this.request({
			method: "POST",
			path: tabbyPath("/api/v2/checkout"),
			body,
			bodySchema: tabbyCheckoutRequestSchema,
			schema: tabbyCheckoutResponseSchema,
			label: "createCheckout",
		});
	}
	async checkEligibility(body: TabbyEligibilityCheckRequest): Promise<TabbyCheckoutResponse> {
		return this.request({
			method: "POST",
			path: tabbyPath("/api/v2/checkout"),
			body,
			bodySchema: tabbyEligibilityCheckRequestSchema,
			schema: tabbyCheckoutResponseSchema,
			label: "checkEligibility",
		});
	}
	async getCheckout(checkoutId: string): Promise<TabbyCheckoutResponse> {
		return this.request({
			method: "GET",
			path: tabbyPath("/api/v2/checkout/{id}", { id: checkoutId }),
			schema: tabbyCheckoutResponseSchema,
			label: "getCheckout",
		});
	}
	async getPayment(paymentId: string): Promise<TabbyPaymentDetails> {
		return this.request({
			method: "GET",
			path: tabbyPath("/api/v2/payments/{id}", { id: paymentId }),
			schema: tabbyPaymentDetailsSchema,
			label: "getPayment",
		});
	}
	async updatePaymentReference(
		paymentId: string,
		referenceId: string,
	): Promise<TabbyPaymentDetails> {
		return this.request({
			method: "PUT",
			path: tabbyPath("/api/v2/payments/{id}", { id: paymentId }),
			body: {
				order: { reference_id: referenceId },
			},
			bodySchema: tabbyUpdatePaymentReferenceRequestSchema,
			schema: tabbyPaymentDetailsSchema,
			label: "updatePaymentReference",
		});
	}
	async capture(paymentId: string, body: TabbyCaptureRequest): Promise<TabbyPaymentDetails> {
		return this.request({
			method: "POST",
			path: tabbyPath("/api/v2/payments/{id}/captures", { id: paymentId }),
			body,
			bodySchema: tabbyCaptureRequestSchema,
			schema: tabbyPaymentDetailsSchema,
			label: "capture",
		});
	}
	async refund(paymentId: string, body: TabbyRefundRequest): Promise<TabbyPaymentDetails> {
		return this.request({
			method: "POST",
			path: tabbyPath("/api/v2/payments/{id}/refunds", { id: paymentId }),
			body,
			bodySchema: tabbyRefundRequestSchema,
			schema: tabbyPaymentDetailsSchema,
			label: "refund",
		});
	}
	async closePayment(paymentId: string): Promise<TabbyPaymentDetails> {
		return this.request({
			method: "POST",
			path: tabbyPath("/api/v2/payments/{id}/close", { id: paymentId }),
			schema: tabbyPaymentDetailsSchema,
			label: "closePayment",
		});
	}
	async listWebhooks(): Promise<TabbyListWebhooksResponse> {
		return this.request({
			method: "GET",
			path: tabbyPath("/api/v1/webhooks"),
			schema: tabbyListWebhooksResponseSchema,
			label: "listWebhooks",
			extraHeaders: {
				"X-Merchant-Code": this.merchantCode,
			},
		});
	}
	async registerWebhook(body: TabbyRegisterWebhookRequest): Promise<TabbyWebhookRegistration> {
		return this.request({
			method: "POST",
			path: tabbyPath("/api/v1/webhooks"),
			body,
			bodySchema: tabbyRegisterWebhookRequestSchema,
			schema: tabbyWebhookRegistrationResponseSchema,
			label: "registerWebhook",
			extraHeaders: {
				"X-Merchant-Code": this.merchantCode,
			},
		});
	}
	async retrieveWebhook(webhookId: string): Promise<TabbyWebhookDetails> {
		return this.request({
			method: "GET",
			path: tabbyPath("/api/v1/webhooks/{id}", { id: webhookId }),
			schema: tabbyWebhookRegistrationResponseSchema,
			label: "retrieveWebhook",
			extraHeaders: {
				"X-Merchant-Code": this.merchantCode,
			},
		});
	}
	async updateWebhook(
		webhookId: string,
		body: TabbyUpdateWebhookRequest,
	): Promise<TabbyUpdateWebhookResponse> {
		return this.request({
			method: "PUT",
			path: tabbyPath("/api/v1/webhooks/{id}", { id: webhookId }),
			body,
			bodySchema: tabbyUpdateWebhookRequestSchema,
			schema: tabbyWebhookUpdateResponseSchema,
			label: "updateWebhook",
			extraHeaders: {
				"X-Merchant-Code": this.merchantCode,
			},
		});
	}
	async deleteWebhook(webhookId: string): Promise<TabbyDeleteWebhookResponse> {
		return this.request({
			method: "DELETE",
			path: tabbyPath("/api/v1/webhooks/{id}", { id: webhookId }),
			schema: tabbyDeleteWebhookResponseSchema,
			label: "deleteWebhook",
			extraHeaders: {
				"X-Merchant-Code": this.merchantCode,
			},
		});
	}
}
