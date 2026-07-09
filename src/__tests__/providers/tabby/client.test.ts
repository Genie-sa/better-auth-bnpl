import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TabbyClient } from "../../../providers/tabby";
const registerWebhookBodySchema = z.object({
	url: z.string(),
	is_test: z.boolean().optional(),
	header: z
		.object({
			title: z.string(),
			value: z.string(),
		})
		.optional(),
});
const updateWebhookBodySchema = z.object({
	url: z.string(),
	header: z
		.object({
			title: z.string(),
			value: z.string(),
		})
		.optional(),
});
function parseRequestBody(body: BodyInit | null | undefined): unknown {
	if (typeof body !== "string") {
		throw new Error("expected JSON string request body");
	}
	return JSON.parse(body);
}
interface CapturedTabbyRequest {
	url: string;
	method: string;
	merchantCode: string | null;
	body?: unknown;
}
function makeClient(responses: readonly unknown[]) {
	const responseQueue = [...responses];
	const requests: CapturedTabbyRequest[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		requests.push({
			url: String(input),
			method: init?.method ?? "GET",
			merchantCode: new Headers(init?.headers).get("X-Merchant-Code"),
			body: init?.body ? parseRequestBody(init.body) : undefined,
		});
		const responseBody = responseQueue.length > 0 ? responseQueue.shift() : {};
		return new Response(JSON.stringify(responseBody), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	const client = new TabbyClient({
		secretKey: "sk_test_x",
		merchantCode: "MERCH",
		baseUrl: "https://api.tabby.test",
		fetch,
	});
	return { client, requests };
}
describe("TabbyClient", () => {
	it("selects the host by country alone — Tabby has no sandbox host", async () => {
		const seen: string[] = [];
		const fetch: typeof globalThis.fetch = async (input) => {
			seen.push(String(input));
			return new Response(
				JSON.stringify({
					id: "payment-id",
					status: "AUTHORIZED",
					amount: "100.00",
					currency: "SAR",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const base = { secretKey: "sk_test_x", merchantCode: "MERCH", fetch } as const;
		const clients = [
			new TabbyClient({ ...base, environment: "sandbox", country: "SA" }),
			new TabbyClient({ ...base, environment: "production", country: "SA" }),
			new TabbyClient({ ...base, environment: "sandbox", country: "AE" }),
			new TabbyClient({ ...base, country: "KW" }),
			new TabbyClient({ ...base }),
			new TabbyClient({
				...base,
				environment: "sandbox",
				country: "SA",
				baseUrl: "https://api.tabby.test",
			}),
		];
		for (const client of clients) {
			await client.getPayment("payment-id");
		}
		expect(seen).toEqual([
			"https://api.tabby.sa/api/v2/payments/payment-id",
			"https://api.tabby.sa/api/v2/payments/payment-id",
			"https://api.tabby.ai/api/v2/payments/payment-id",
			"https://api.tabby.ai/api/v2/payments/payment-id",
			"https://api.tabby.ai/api/v2/payments/payment-id",
			"https://api.tabby.test/api/v2/payments/payment-id",
		]);
	});
	it("registers webhooks with Tabby's documented header.title payload", async () => {
		const { client, requests } = makeClient([
			{
				id: "wh_1",
				url: "https://merchant.example/bnpl/webhooks/tabby",
				is_test: true,
				header: {
					title: "X-Tabby-Signature",
					value: "secret-32-byte-or-more-of-entropy",
				},
			},
		]);
		const result = await client.registerWebhook({
			url: "https://merchant.example/bnpl/webhooks/tabby",
			is_test: true,
			header: {
				title: "X-Tabby-Signature",
				value: "secret-32-byte-or-more-of-entropy",
			},
		});
		const request = requests[0];
		expect(request?.url).toBe("https://api.tabby.test/api/v1/webhooks");
		expect(request?.merchantCode).toBe("MERCH");
		expect(registerWebhookBodySchema.parse(request?.body)).toEqual({
			url: "https://merchant.example/bnpl/webhooks/tabby",
			is_test: true,
			header: {
				title: "X-Tabby-Signature",
				value: "secret-32-byte-or-more-of-entropy",
			},
		});
		expect(result.header?.title).toBe("X-Tabby-Signature");
	});
	it("parses webhook CRUD responses with documented OpenAPI shapes", async () => {
		const { client, requests } = makeClient([
			[],
			{
				id: "wh_1",
				url: "https://merchant.example/bnpl/webhooks/tabby",
				is_test: true,
				header: null,
			},
			{
				id: "wh_1",
				url: "https://merchant.example/updated",
				header: { title: null, value: null },
			},
			{ status: "ok" },
		]);
		await expect(client.listWebhooks()).resolves.toEqual([]);
		await expect(client.retrieveWebhook("wh/1")).resolves.toMatchObject({
			id: "wh_1",
			is_test: true,
			header: null,
		});
		await expect(
			client.updateWebhook("wh/1", {
				url: "https://merchant.example/updated",
				header: {
					title: "X-Tabby-Signature",
					value: "secret-32-byte-or-more-of-entropy",
				},
			}),
		).resolves.toMatchObject({
			id: "wh_1",
			url: "https://merchant.example/updated",
			header: { title: null, value: null },
		});
		await expect(client.deleteWebhook("wh/1")).resolves.toEqual({ status: "ok" });
		expect(
			requests.map(({ method, url, merchantCode }) => ({ method, url, merchantCode })),
		).toEqual([
			{ method: "GET", url: "https://api.tabby.test/api/v1/webhooks", merchantCode: "MERCH" },
			{
				method: "GET",
				url: "https://api.tabby.test/api/v1/webhooks/wh%2F1",
				merchantCode: "MERCH",
			},
			{
				method: "PUT",
				url: "https://api.tabby.test/api/v1/webhooks/wh%2F1",
				merchantCode: "MERCH",
			},
			{
				method: "DELETE",
				url: "https://api.tabby.test/api/v1/webhooks/wh%2F1",
				merchantCode: "MERCH",
			},
		]);
		expect(updateWebhookBodySchema.parse(requests[2]?.body)).toEqual({
			url: "https://merchant.example/updated",
			header: {
				title: "X-Tabby-Signature",
				value: "secret-32-byte-or-more-of-entropy",
			},
		});
	});
});
