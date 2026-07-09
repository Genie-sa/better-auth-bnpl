import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BnplProvider } from "../../../core/provider";
import type { BnplOrderItem } from "../../../core/types";
import { tamara } from "../../../providers/tamara";
import type { TamaraOptions } from "../../../providers/tamara";
import { ctx } from "../../_harness";
const NOTIFICATION_TOKEN = "test-notification";
function base64Url(input: Buffer | string): string {
	const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
	return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function signTamaraToken(payload: Record<string, unknown>): string {
	const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = base64Url(JSON.stringify({ iss: "Tamara", ...payload }));
	const sig = createHmac("sha256", NOTIFICATION_TOKEN).update(`${header}.${body}`).digest();
	return `${header}.${body}.${base64Url(sig)}`;
}
const WEBHOOK_BODY = JSON.stringify({
	order_id: "ord-1",
	order_reference_id: "ref-1",
	event_type: "order_captured",
	data: { capture_id: "cap-9", captured_amount: { amount: "100.00", currency: "SAR" } },
});
describe("tamara() factory", () => {
	const baseConfig = {
		apiToken: "test-token",
		notificationToken: "test-notification",
		environment: "sandbox",
	} satisfies TamaraOptions;
	it("declares static capabilities matching Tamara's flow", () => {
		const provider = tamara(baseConfig);
		expect(provider.id).toBe("tamara");
		expect(provider.capabilities.separateAuthorise).toBe(true);
		expect(provider.capabilities.voidCheckout).toBe(true);
		expect(provider.capabilities.closePayment).toBe(false);
		expect(provider.capabilities.preCheck).toBe(true);
	});
	it("supports the full GCC currency set", () => {
		const provider = tamara(baseConfig);
		expect(provider.supportedCurrencies).toEqual(["SAR", "AED", "KWD", "BHD", "OMR"]);
		expect(provider.supportedCountries).toEqual(["SA", "AE", "BH", "KW", "OM"]);
	});
	it("exposes optional methods only when capabilities allow", () => {
		const provider = tamara(baseConfig);
		expect(provider.authorize).toBeDefined();
		expect(provider.voidCheckout).toBeDefined();
		expect(provider.closePayment).toBeUndefined();
	});
	it("maps canonical preCheck input to Tamara's documented eligibility request", async () => {
		let body: unknown;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			expect(String(input)).toBe("https://api-sandbox.tamara.co/pre-checkout/v1/eligibility");
			body = init?.body ? JSON.parse(String(init.body)) : undefined;
			return new Response(JSON.stringify({ is_eligible: false }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const provider = tamara({ ...baseConfig, fetch });
		const result = await provider.preCheck(
			{
				countryCode: "SA",
				amount: { amount: "100.00", currency: "SAR" },
				phone: "+966500000000",
			},
			ctx,
		);
		expect(body).toEqual({
			order: { amount: 100, currency: "SAR" },
			customer: { phone: "+966500000000" },
		});
		expect(result).toEqual({ available: false });
	});
	it("validates required Tamara operation fields after provider type erasure", async () => {
		const provider: BnplProvider = tamara(baseConfig);
		await expect(
			provider.capture("ord-1", { totalAmount: { amount: "100.00", currency: "SAR" } }, ctx),
		).rejects.toMatchObject({ code: "SHIPPING_INFO_REQUIRED" });
		await expect(
			provider.capture(
				"ord-1",
				{
					totalAmount: { amount: "100.00", currency: "SAR" },
					shippingInfo: { trackingNumber: "TRK123" },
				},
				ctx,
			),
		).rejects.toMatchObject({ code: "SHIPPING_INFO_REQUIRED" });
		await expect(provider.cancel("ord-1", {}, ctx)).rejects.toMatchObject({
			code: "TOTAL_AMOUNT_REQUIRED",
		});
	});
	it("verifyWebhook rejects requests without a token", async () => {
		const provider = tamara(baseConfig);
		const result = await provider.verifyWebhook({
			url: "https://x/y",
			headers: new Headers(),
			rawBody: "{}",
		});
		expect(result.ok).toBe(false);
	});
	describe("verifyWebhook body + replay window", () => {
		const nowSeconds = () => Math.floor(Date.now() / 1000);
		it("builds payload and dedupKey from the (unsigned) body since the JWT carries no event data", async () => {
			const provider = tamara(baseConfig);
			const token = signTamaraToken({ iat: nowSeconds() });
			const result = await provider.verifyWebhook({
				url: `https://x/y?tamaraToken=${token}`,
				headers: new Headers(),
				rawBody: WEBHOOK_BODY,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.payload.order_id).toBe("ord-1");
				expect(result.payload.event_type).toBe("order_captured");
				expect(result.dedupKey).toBe("tamara:order_captured:cap-9");
				expect(result.rawBody).toBe(WEBHOOK_BODY);
			}
		});
		it("accepts a Bearer token as well as the query param", async () => {
			const provider = tamara(baseConfig);
			const token = signTamaraToken({ iat: nowSeconds() });
			const result = await provider.verifyWebhook({
				url: "https://x/y",
				headers: new Headers({ Authorization: `Bearer ${token}` }),
				rawBody: WEBHOOK_BODY,
			});
			expect(result.ok).toBe(true);
		});
		it("rejects a token whose iat is older than the default 300s window", async () => {
			const provider = tamara(baseConfig);
			const token = signTamaraToken({ iat: nowSeconds() - 3600 });
			const result = await provider.verifyWebhook({
				url: `https://x/y?tamaraToken=${token}`,
				headers: new Headers(),
				rawBody: WEBHOOK_BODY,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toMatch(/replay tolerance/);
		});
		it("accepts a token with no iat (Tamara does not guarantee iat) — exp still bounds it", async () => {
			const provider = tamara(baseConfig);
			const token = signTamaraToken({ exp: nowSeconds() + 3600 });
			const result = await provider.verifyWebhook({
				url: `https://x/y?tamaraToken=${token}`,
				headers: new Headers(),
				rawBody: WEBHOOK_BODY,
			});
			expect(result.ok).toBe(true);
		});
		it("honours an explicit replayToleranceSeconds: false opt-out for an old iat", async () => {
			const provider = tamara({ ...baseConfig, replayToleranceSeconds: false });
			const token = signTamaraToken({ iat: nowSeconds() - 86400 });
			const result = await provider.verifyWebhook({
				url: `https://x/y?tamaraToken=${token}`,
				headers: new Headers(),
				rawBody: WEBHOOK_BODY,
			});
			expect(result.ok).toBe(true);
		});
		it("honours a custom numeric window", async () => {
			const provider = tamara({ ...baseConfig, replayToleranceSeconds: 60 });
			const withinWindow = signTamaraToken({ iat: nowSeconds() - 30 });
			const outsideWindow = signTamaraToken({ iat: nowSeconds() - 120 });
			await expect(
				provider.verifyWebhook({
					url: `https://x/y?tamaraToken=${withinWindow}`,
					headers: new Headers(),
					rawBody: WEBHOOK_BODY,
				}),
			).resolves.toMatchObject({ ok: true });
			await expect(
				provider.verifyWebhook({
					url: `https://x/y?tamaraToken=${outsideWindow}`,
					headers: new Headers(),
					rawBody: WEBHOOK_BODY,
				}),
			).resolves.toMatchObject({ ok: false });
		});
		it("rejects when the JWT signature does not match the notification token", async () => {
			const provider = tamara(baseConfig);
			const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
			const body = base64Url(JSON.stringify({ iss: "Tamara", iat: nowSeconds() }));
			const forgedSig = createHmac("sha256", "wrong-secret").update(`${header}.${body}`).digest();
			const forged = `${header}.${body}.${base64Url(forgedSig)}`;
			const result = await provider.verifyWebhook({
				url: `https://x/y?tamaraToken=${forged}`,
				headers: new Headers(),
				rawBody: WEBHOOK_BODY,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toMatch(/signature/i);
		});
	});
	it("returns auto-capture metadata from authorise responses", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					order_id: "ord-1",
					status: "fully_captured",
					auto_captured: true,
					capture_id: "cap-1",
					authorized_amount: { amount: "100.00", currency: "SAR" },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		const provider = tamara({
			...baseConfig,
			fetch,
		});
		const result = await provider.authorize?.("ord-1", ctx);
		expect(result).toMatchObject({
			providerOrderId: "ord-1",
			status: "fully_captured",
			autoCaptured: true,
			captureId: "cap-1",
			capturedAmountMinor: 10000,
		});
	});
	it("forwards canonical capture items to Tamara wire payload", async () => {
		let body: unknown;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			body = init?.body ? JSON.parse(String(init.body)) : undefined;
			return new Response(JSON.stringify({ capture_id: "cap-1", order_id: "ord-1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const provider = tamara({
			...baseConfig,
			fetch,
		});
		const items: BnplOrderItem[] = [
			{
				referenceId: "sku-1",
				name: "Item",
				sku: "SKU1",
				quantity: 1,
				totalAmount: { amount: "100.00", currency: "SAR" },
			},
		];
		await provider.capture(
			"ord-1",
			{
				totalAmount: { amount: "100.00", currency: "SAR" },
				shippingInfo: {
					shippedAt: "2026-06-04T16:00:00.000Z",
					shippingCompany: "Aramex",
				},
				items,
			},
			ctx,
		);
		expect(body).toMatchObject({
			order_id: "ord-1",
			shipping_info: {
				shipped_at: "2026-06-04T16:00:00.000Z",
				shipping_company: "Aramex",
			},
			items: [{ reference_id: "sku-1", type: "Physical", sku: "SKU1" }],
		});
	});
});
