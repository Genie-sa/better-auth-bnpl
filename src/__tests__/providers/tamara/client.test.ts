import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TamaraClient } from "../../../providers/tamara";
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
				});
			}
			if (request.method === "DELETE" && request.url.endsWith("/webhooks/wh_1")) {
				return new Response(null, { status: 200 });
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
		expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			"POST https://api.tamara.test/webhooks",
			"GET https://api.tamara.test/webhooks/wh_1",
			"PUT https://api.tamara.test/webhooks/wh_1",
			"DELETE https://api.tamara.test/webhooks/wh_1",
		]);
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
