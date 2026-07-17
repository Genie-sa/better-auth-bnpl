import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BnplCheckoutInput } from "../../../core/types";
import { TabbyClient } from "../../../providers/tabby";
import { toTabbyCheckoutRequest } from "../../../providers/tabby/adapter";
const checkoutAttachmentWireBodySchema = z.object({
	payment: z.object({
		attachment: z.object({
			body: z.string(),
			content_type: z.literal("application/vnd.tabby.v1+json"),
		}),
	}),
});
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
	it("serializes checkout attachment.body as JSON on the wire", async () => {
		const { client, requests } = makeClient([
			{
				id: "checkout-id",
				status: "created",
				configuration: {},
				payment: {
					id: "payment-id",
					status: "CREATED",
					amount: "100.00",
					currency: "SAR",
				},
			},
		]);
		const educationDetails = {
			merchant_subtype: "courses_training" as const,
			program: { payment_tenure_months: 3, months_to_completion: 3 },
			student_history: { late_payments_count: 0, avg_overdue_duration_days: 0 },
		};
		const input: BnplCheckoutInput = {
			orderReferenceId: "ord-attachment",
			description: "Course checkout",
			totalAmount: { amount: "100.00", currency: "SAR" },
			items: [
				{
					referenceId: "course-1",
					name: "Course",
					sku: "course-1",
					quantity: 1,
					totalAmount: { amount: "100.00", currency: "SAR" },
				},
			],
			buyer: {
				firstName: "Test",
				lastName: "Buyer",
				email: "buyer@example.com",
				phone: "+966500000000",
			},
			shippingAddress: {
				line1: "King Fahd Road",
				city: "Riyadh",
				countryCode: "SA",
			},
			countryCode: "SA",
			merchantUrl: {
				success: "https://merchant.example/success",
				cancel: "https://merchant.example/cancel",
				failure: "https://merchant.example/failure",
				notification: "https://merchant.example/webhooks/tabby",
			},
			providerData: {
				buyer_history: {
					registered_since: "2024-01-01T00:00:00Z",
					loyalty_level: 0,
				},
				order_history: [],
				attachment: {
					body: { education_details: educationDetails },
					content_type: "application/vnd.tabby.v1+json",
				},
			},
		};

		await client.createCheckout(toTabbyCheckoutRequest(input, { merchantCode: "MERCH" }));

		const wireBody = checkoutAttachmentWireBodySchema.parse(requests[0]?.body);
		expect(JSON.parse(wireBody.payment.attachment.body)).toEqual({
			education_details: educationDetails,
		});
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
