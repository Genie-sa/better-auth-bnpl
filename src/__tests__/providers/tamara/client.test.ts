import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { TamaraClient } from "../../../providers/tamara";
import {
	tamaraRegisterWebhookRequestSchema,
	tamaraUpdateWebhookRequestSchema,
	type tamaraWebhookDetailsResponseSchema,
} from "../../../providers/tamara/schemas";
const registerWebhookBodySchema = z.object({
	type: z.enum(["order", "dispute"]),
	events: z.array(z.string()),
	url: z.string(),
	headers: z.record(z.string(), z.string()).optional(),
});
const updateWebhookBodySchema = z.object({
	events: z.array(z.string()),
	url: z.string(),
	headers: z.record(z.string(), z.string()).optional(),
});
const updateReferenceIdBodySchema = z.object({
	order_reference_id: z.string(),
});
const preCheckoutEligibilityBodySchema = z.object({
	order: z.object({
		amount: z.number(),
		currency: z.literal("SAR"),
	}),
	customer: z.object({
		phone: z.string(),
	}),
});
interface CapturedRequest {
	method: string | undefined;
	url: string;
	body: unknown;
}
function parseRequestBody(body: BodyInit | null | undefined): unknown {
	if (body === undefined || body === null) return undefined;
	if (typeof body !== "string") {
		throw new Error("expected JSON string request body");
	}
	return JSON.parse(body);
}
describe("TamaraClient", () => {
	it("manages webhooks using Tamara's documented endpoints", async () => {
		const requests: CapturedRequest[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = {
				method: init?.method,
				url: String(input),
				body: parseRequestBody(init?.body),
			};
			requests.push(request);
			if (request.method === "POST" && request.url.endsWith("/webhooks")) {
				registerWebhookBodySchema.parse(request.body);
				return Response.json({ webhook_id: "wh_1" });
			}
			if (request.method === "GET" && request.url.endsWith("/webhooks/wh_1")) {
				return Response.json({
					webhook_id: "wh_1",
					url: "https://merchant.example/bnpl/webhooks/tamara",
					events: ["order_approved"],
					type: "order",
				});
			}
			if (request.method === "PUT" && request.url.endsWith("/webhooks/wh_1")) {
				updateWebhookBodySchema.parse(request.body);
				return Response.json({
					webhook_id: "wh_1",
					url: "https://merchant.example/bnpl/webhooks/tamara-v2",
					events: ["order_approved", "order_authorised"],
					type: "order",
					headers: [],
				});
			}
			if (request.method === "DELETE" && request.url.endsWith("/webhooks/wh_1")) {
				return Response.json({ message: "Webhook was removed successfully" });
			}
			throw new Error(`unexpected Tamara request: ${request.method} ${request.url}`);
		};
		const client = new TamaraClient({
			apiToken: "tamara-token",
			baseUrl: "https://api.tamara.test",
			fetch,
		});
		const registered = await client.registerWebhook({
			type: "order",
			events: ["order_approved"],
			url: "https://merchant.example/bnpl/webhooks/tamara",
			headers: { "X-Merchant-Webhook": "merchant-secret" },
		});
		const retrieved = await client.retrieveWebhook("wh_1");
		const updated = await client.updateWebhook("wh_1", {
			events: ["order_approved", "order_authorised"],
			url: "https://merchant.example/bnpl/webhooks/tamara-v2",
		});
		await client.deleteWebhook("wh_1");
		expect(registered.webhook_id).toBe("wh_1");
		expect(retrieved.url).toBe("https://merchant.example/bnpl/webhooks/tamara");
		expect(updated.events).toEqual(["order_approved", "order_authorised"]);
		expect(updated.headers).toEqual({});
		expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			"POST https://api.tamara.test/webhooks",
			"GET https://api.tamara.test/webhooks/wh_1",
			"PUT https://api.tamara.test/webhooks/wh_1",
			"DELETE https://api.tamara.test/webhooks/wh_1",
		]);
	});
	it("accepts Tamara's deletion acknowledgement and encodes the webhook id", async () => {
		let method: string | undefined;
		let url: string | undefined;
		let authorization: string | null = null;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			method = init?.method;
			url = String(input);
			authorization = new Headers(init?.headers).get("Authorization");
			return Response.json({ message: "Webhook was removed successfully" });
		};
		const client = new TamaraClient({
			apiToken: "tamara-token",
			baseUrl: "https://api.tamara.test",
			fetch,
		});

		const result = await client.deleteWebhook("webhook/id with spaces");

		expect(result).toBeUndefined();
		expect(method).toBe("DELETE");
		expect(url).toBe("https://api.tamara.test/webhooks/webhook%2Fid%20with%20spaces");
		expect(authorization).toBe("Bearer tamara-token");
		expectTypeOf<ReturnType<TamaraClient["deleteWebhook"]>>().toEqualTypeOf<Promise<void>>();
	});
	it("accepts an empty successful deletion response", async () => {
		const fetch: typeof globalThis.fetch = async () => new Response(null, { status: 204 });
		const client = new TamaraClient({
			apiToken: "tamara-token",
			baseUrl: "https://api.tamara.test",
			fetch,
		});

		await expect(client.deleteWebhook("wh_empty_response")).resolves.toBeUndefined();
	});
	it("rejects malformed successful deletion responses", async () => {
		const fetch: typeof globalThis.fetch = async () => Response.json({ ok: true });
		const client = new TamaraClient({
			apiToken: "tamara-token",
			baseUrl: "https://api.tamara.test",
			fetch,
		});

		await expect(client.deleteWebhook("wh_malformed_response")).rejects.toMatchObject({
			name: "BnplProviderError",
			provider: "tamara",
			message: "Tamara deleteWebhook returned unexpected shape",
			body: { ok: true },
		});
	});
	it.each([401, 403, 500])("preserves Tamara deletion HTTP %i errors", async (status) => {
		const body = { message: `Tamara deletion failed with ${status}` };
		const fetch: typeof globalThis.fetch = async () => Response.json(body, { status });
		const client = new TamaraClient({
			apiToken: "tamara-token",
			baseUrl: "https://api.tamara.test",
			fetch,
		});

		await expect(client.deleteWebhook("wh_provider_error")).rejects.toMatchObject({
			name: "BnplProviderError",
			provider: "tamara",
			status,
			body,
		});
	});
	it("normalizes empty webhook response headers", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			Response.json({
				webhook_id: "wh_empty_headers",
				url: "https://merchant.example/bnpl/webhooks/tamara",
				events: ["order_approved"],
				type: "order",
				headers: [],
			});
		const client = new TamaraClient({
			apiToken: "tamara-token",
			baseUrl: "https://api.tamara.test",
			fetch,
		});

		const webhook = await client.retrieveWebhook("wh_empty_headers");

		expect(webhook.headers).toEqual({});
	});
	it("preserves configured webhook response headers", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			Response.json({
				webhook_id: "wh_configured_headers",
				url: "https://merchant.example/bnpl/webhooks/tamara",
				events: ["order_approved"],
				headers: { "X-Merchant-Webhook": "configured-value" },
			});
		const client = new TamaraClient({
			apiToken: "tamara-token",
			baseUrl: "https://api.tamara.test",
			fetch,
		});

		const webhook = await client.retrieveWebhook("wh_configured_headers");

		expect(webhook.headers).toEqual({ "X-Merchant-Webhook": "configured-value" });
	});
	it("rejects non-empty webhook response header arrays", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			Response.json({
				webhook_id: "wh_invalid_headers",
				url: "https://merchant.example/bnpl/webhooks/tamara",
				events: ["order_approved"],
				headers: ["unexpected"],
			});
		const client = new TamaraClient({
			apiToken: "tamara-token",
			baseUrl: "https://api.tamara.test",
			fetch,
		});

		await expect(client.retrieveWebhook("wh_invalid_headers")).rejects.toMatchObject({
			name: "BnplProviderError",
			message: "Tamara retrieveWebhook returned unexpected shape",
		});
	});
	it("keeps webhook request headers record-only", () => {
		expectTypeOf<z.output<typeof tamaraWebhookDetailsResponseSchema>["headers"]>().toEqualTypeOf<
			Record<string, unknown> | undefined
		>();
		const registerRequest = {
			type: "order",
			events: ["order_approved"],
			url: "https://merchant.example/bnpl/webhooks/tamara",
			headers: { "X-Merchant-Webhook": "configured-value" },
		};
		const updateRequest = {
			events: ["order_approved"],
			url: "https://merchant.example/bnpl/webhooks/tamara",
			headers: { "X-Merchant-Webhook": "configured-value" },
		};

		expect(tamaraRegisterWebhookRequestSchema.safeParse(registerRequest).success).toBe(true);
		expect(tamaraUpdateWebhookRequestSchema.safeParse(updateRequest).success).toBe(true);
		expect(
			tamaraRegisterWebhookRequestSchema.safeParse({ ...registerRequest, headers: [] }).success,
		).toBe(false);
		expect(
			tamaraUpdateWebhookRequestSchema.safeParse({ ...updateRequest, headers: [] }).success,
		).toBe(false);
	});
	it("updates Tamara order_reference_id with the documented body", async () => {
		let requestBody: z.infer<typeof updateReferenceIdBodySchema> | undefined;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			expect(String(input)).toBe("https://api.tamara.test/orders/ord_1/reference-id");
			expect(init?.method).toBe("PUT");
			requestBody = updateReferenceIdBodySchema.parse(parseRequestBody(init?.body));
			return Response.json({ message: "Order reference id was updated successfully" });
		};
		const client = new TamaraClient({
			apiToken: "tamara-token",
			baseUrl: "https://api.tamara.test",
			fetch,
		});
		const result = await client.updateReferenceId("ord_1", {
			order_reference_id: "merchant-ref-2",
		});
		expect(requestBody).toEqual({ order_reference_id: "merchant-ref-2" });
		expect(result.message).toMatch(/updated/i);
	});
	it("checks Tamara eligibility using the documented pre-checkout endpoint", async () => {
		let requestBody: z.infer<typeof preCheckoutEligibilityBodySchema> | undefined;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			expect(String(input)).toBe("https://api.tamara.test/pre-checkout/v1/eligibility");
			expect(init?.method).toBe("POST");
			requestBody = preCheckoutEligibilityBodySchema.parse(parseRequestBody(init?.body));
			return Response.json({ is_eligible: true });
		};
		const client = new TamaraClient({
			apiToken: "tamara-token",
			baseUrl: "https://api.tamara.test",
			fetch,
		});
		const result = await client.preCheckoutEligibility({
			order: {
				amount: 120,
				currency: "SAR",
			},
			customer: {
				phone: "+966500000000",
			},
		});
		expect(requestBody).toEqual({
			order: { amount: 120, currency: "SAR" },
			customer: { phone: "+966500000000" },
		});
		expect(result.is_eligible).toBe(true);
	});
});
