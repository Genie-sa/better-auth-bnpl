import type { z } from "zod";
import type { ProviderFetch } from "../../core/provider";
import {
	type ProviderHttpMethod,
	type SleepFn,
	requestProviderJson,
	requestProviderVoid,
} from "../http";
import { createOpenApiPathBuilder } from "../openapi-path";
import { TAMARA_BASE_URLS } from "./constants";
import type { paths as TamaraOpenApiPaths } from "./openapi";
import {
	tamaraAuthoriseResponseSchema,
	tamaraCancelBodySchema,
	tamaraCancelResponseSchema,
	tamaraCaptureBodySchema,
	tamaraCaptureResponseSchema,
	tamaraCheckoutRequestSchema,
	tamaraCheckoutResponseSchema,
	tamaraOrderDetailsResponseSchema,
	tamaraPreCheckoutEligibilityRequestSchema,
	tamaraPreCheckoutEligibilityResponseSchema,
	tamaraSimplifiedRefundBodySchema,
	tamaraSimplifiedRefundResponseSchema,
	tamaraUpdateReferenceIdRequestSchema,
	tamaraUpdateReferenceIdResponseSchema,
	tamaraVoidQuerySchema,
	tamaraVoidResponseSchema,
	tamaraWebhookDetailsResponseSchema,
	tamaraWebhookRegistrationResponseSchema,
} from "./schemas";
import type {
	TamaraAuthoriseResponse,
	TamaraCancelBody,
	TamaraCancelResponse,
	TamaraCaptureBody,
	TamaraCaptureResponse,
	TamaraCheckoutRequest,
	TamaraCheckoutResponse,
	TamaraOrderDetailsResponse,
	TamaraPreCheckoutEligibilityRequest,
	TamaraPreCheckoutEligibilityResponse,
	TamaraRegisterWebhookRequest,
	TamaraSimplifiedRefundBody,
	TamaraSimplifiedRefundResponse,
	TamaraUpdateReferenceIdRequest,
	TamaraUpdateReferenceIdResponse,
	TamaraUpdateWebhookRequest,
	TamaraVoidQuery,
	TamaraVoidResponse,
	TamaraWebhookDetails,
	TamaraWebhookRegistrationResponse,
} from "./types";
export interface TamaraClientConfig {
	apiToken: string;
	environment?: "sandbox" | "production";
	baseUrl?: string;
	fetch?: ProviderFetch;
	timeoutMs?: number;
	sleep?: SleepFn;
}
const tamaraPath = createOpenApiPathBuilder<TamaraOpenApiPaths>();
export class TamaraClient {
	readonly baseUrl: string;
	private readonly apiToken: string;
	private readonly fetchImpl: ProviderFetch;
	private readonly timeoutMs: number | undefined;
	private readonly sleep: SleepFn | undefined;
	constructor(config: TamaraClientConfig) {
		const env = config.environment ?? "sandbox";
		this.baseUrl = config.baseUrl ?? TAMARA_BASE_URLS[env];
		this.apiToken = config.apiToken;
		this.fetchImpl = config.fetch ?? globalThis.fetch;
		this.timeoutMs = config.timeoutMs;
		this.sleep = config.sleep;
	}
	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.apiToken}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		};
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
	}: {
		method: ProviderHttpMethod;
		path: string;
		schema: TResponseSchema;
		label: string;
		body?: TBodySchema extends z.ZodTypeAny ? z.input<TBodySchema> : unknown;
		bodySchema?: TBodySchema;
	}): Promise<z.infer<TResponseSchema>> {
		return requestProviderJson({
			provider: "tamara",
			providerName: "Tamara",
			baseUrl: this.baseUrl,
			fetchImpl: this.fetchImpl,
			method,
			headers: this.headers(),
			path,
			body,
			bodySchema,
			schema,
			label,
			timeoutMs: this.timeoutMs,
			sleep: this.sleep,
		});
	}
	private requestVoid(method: ProviderHttpMethod, path: string, body?: unknown): Promise<void> {
		return requestProviderVoid({
			provider: "tamara",
			providerName: "Tamara",
			baseUrl: this.baseUrl,
			fetchImpl: this.fetchImpl,
			method,
			headers: this.headers(),
			path,
			body,
			timeoutMs: this.timeoutMs,
			sleep: this.sleep,
		});
	}
	async createCheckout(body: TamaraCheckoutRequest): Promise<TamaraCheckoutResponse> {
		return this.request({
			method: "POST",
			path: tamaraPath("/checkout"),
			body,
			bodySchema: tamaraCheckoutRequestSchema,
			schema: tamaraCheckoutResponseSchema,
			label: "createCheckout",
		});
	}
	async getOrder(orderId: string): Promise<TamaraOrderDetailsResponse> {
		return this.request({
			method: "GET",
			path: tamaraPath("/orders/{order_id}", { order_id: orderId }),
			schema: tamaraOrderDetailsResponseSchema,
			label: "getOrder",
		});
	}
	async getOrderByReferenceId(referenceId: string): Promise<TamaraOrderDetailsResponse> {
		return this.request({
			method: "GET",
			path: `/merchants/orders/reference-id/${encodeURIComponent(referenceId)}`,
			schema: tamaraOrderDetailsResponseSchema,
			label: "getOrderByReferenceId",
		});
	}
	async authoriseOrder(orderId: string): Promise<TamaraAuthoriseResponse> {
		return this.request({
			method: "POST",
			path: tamaraPath("/orders/{order_id}/authorise", { order_id: orderId }),
			schema: tamaraAuthoriseResponseSchema,
			label: "authoriseOrder",
		});
	}
	async captureOrder(body: TamaraCaptureBody): Promise<TamaraCaptureResponse> {
		return this.request({
			method: "POST",
			path: tamaraPath("/payments/capture"),
			body,
			bodySchema: tamaraCaptureBodySchema,
			schema: tamaraCaptureResponseSchema,
			label: "captureOrder",
		});
	}
	async simplifiedRefund(
		orderId: string,
		body: TamaraSimplifiedRefundBody,
	): Promise<TamaraSimplifiedRefundResponse> {
		return this.request({
			method: "POST",
			path: tamaraPath("/payments/simplified-refund/{order_id}", { order_id: orderId }),
			body,
			bodySchema: tamaraSimplifiedRefundBodySchema,
			schema: tamaraSimplifiedRefundResponseSchema,
			label: "simplifiedRefund",
		});
	}
	async cancelOrder(orderId: string, body: TamaraCancelBody): Promise<TamaraCancelResponse> {
		return this.request({
			method: "POST",
			path: tamaraPath("/orders/{order_id}/cancel", { order_id: orderId }),
			body,
			bodySchema: tamaraCancelBodySchema,
			schema: tamaraCancelResponseSchema,
			label: "cancelOrder",
		});
	}
	async voidCheckoutSession(
		checkoutId: string,
		query: TamaraVoidQuery,
	): Promise<TamaraVoidResponse> {
		const validatedQuery = tamaraVoidQuerySchema.parse(query);
		const search = new URLSearchParams({ order_id: validatedQuery.order_id });
		if (validatedQuery.store_code) search.set("store_code", validatedQuery.store_code);
		const path = tamaraPath("/checkout/{checkout_id}/void", { checkout_id: checkoutId });
		return this.request({
			method: "POST",
			path: `${path}?${search.toString()}`,
			schema: tamaraVoidResponseSchema,
			label: "voidCheckoutSession",
		});
	}
	async preCheckoutEligibility(
		body: TamaraPreCheckoutEligibilityRequest,
	): Promise<TamaraPreCheckoutEligibilityResponse> {
		return this.request({
			method: "POST",
			path: tamaraPath("/pre-checkout/v1/eligibility"),
			body,
			bodySchema: tamaraPreCheckoutEligibilityRequestSchema,
			schema: tamaraPreCheckoutEligibilityResponseSchema,
			label: "preCheckoutEligibility",
		});
	}
	async registerWebhook(
		body: TamaraRegisterWebhookRequest,
	): Promise<TamaraWebhookRegistrationResponse> {
		return this.request({
			method: "POST",
			path: "/webhooks",
			body,
			schema: tamaraWebhookRegistrationResponseSchema,
			label: "registerWebhook",
		});
	}
	async retrieveWebhook(webhookId: string): Promise<TamaraWebhookDetails> {
		return this.request({
			method: "GET",
			path: `/webhooks/${encodeURIComponent(webhookId)}`,
			schema: tamaraWebhookDetailsResponseSchema,
			label: "retrieveWebhook",
		});
	}
	async updateWebhook(
		webhookId: string,
		body: TamaraUpdateWebhookRequest,
	): Promise<TamaraWebhookDetails> {
		return this.request({
			method: "PUT",
			path: `/webhooks/${encodeURIComponent(webhookId)}`,
			body,
			schema: tamaraWebhookDetailsResponseSchema,
			label: "updateWebhook",
		});
	}
	async deleteWebhook(webhookId: string): Promise<void> {
		await this.requestVoid("DELETE", `/webhooks/${encodeURIComponent(webhookId)}`);
	}
	async updateReferenceId(
		orderId: string,
		body: TamaraUpdateReferenceIdRequest,
	): Promise<TamaraUpdateReferenceIdResponse> {
		return this.request({
			method: "PUT",
			path: tamaraPath("/orders/{order_id}/reference-id", { order_id: orderId }),
			body,
			bodySchema: tamaraUpdateReferenceIdRequestSchema,
			schema: tamaraUpdateReferenceIdResponseSchema,
			label: "updateReferenceId",
		});
	}
}
