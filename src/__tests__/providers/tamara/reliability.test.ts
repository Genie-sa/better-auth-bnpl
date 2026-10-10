import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BnplCheckoutInput } from "../../../core/types";
import { TamaraClient, tamara } from "../../../providers/tamara";
import {
	tamaraDedupKey,
	tamaraStatusToCanonical,
	toTamaraCheckoutRequest,
} from "../../../providers/tamara/adapter";
import { verifyTamaraJwt } from "../../../providers/tamara/webhook-verify";
import { ctx } from "../../_harness";

const config = { apiToken: "test", notificationToken: "test-notification" };
const riskAssessment = {
	is_premium_customer: false,
	account_creation_date: "10-10-2026",
	total_order_count: 0,
	date_first_paid: null,
	date_last_paid: null,
};
const checkout: BnplCheckoutInput = {
	orderReferenceId: "reference-1",
	description: "Order",
	countryCode: "SA",
	totalAmount: { amount: "100.00", currency: "SAR" },
	items: [
		{
			referenceId: "sku",
			sku: "sku",
			name: "Item",
			quantity: 1,
			totalAmount: { amount: "100.00", currency: "SAR" },
		},
	],
	buyer: { firstName: "A", lastName: "B", email: "buyer@example.test", phone: "966500000000" },
	shippingAddress: { line1: "Street", city: "Riyadh", countryCode: "SA" },
	merchantUrl: {
		success: "https://shop.test/success",
		failure: "https://shop.test/failure",
		cancel: "https://shop.test/cancel",
		notification: "https://shop.test/webhook",
	},
	providerData: { riskAssessment },
};
const money = { amount: "100.00", currency: "SAR" } as const;
const captureArgs = {
	totalAmount: money,
	shippingInfo: { shippedAt: "2026-10-10T10:00:00Z", shippingCompany: "DHL" },
};
const order = {
	order_id: "order-1",
	order_reference_id: "reference-1",
	status: "fully_captured",
	total_amount: money,
	captured_amount: money,
	refunded_amount: { ...money, amount: "0.00" },
};
const providerReturning = (body: unknown) =>
	tamara({ ...config, fetch: async () => Response.json(body) });

afterEach(() => vi.useRealTimers());

describe("Tamara financial contracts", () => {
	it("rejects empty checkout IDs while preserving opaque hosted checkout URLs", async () => {
		const response = {
			order_id: "order-1",
			checkout_id: "checkout-1",
			checkout_url: "https://hosted.tamara.example/session/opaque-token",
			status: "new",
		};
		await expect(providerReturning(response).createCheckout(checkout, ctx)).resolves.toMatchObject({
			providerCheckoutId: "checkout-1",
			checkoutUrl: response.checkout_url,
		});
		await expect(
			providerReturning({ ...response, checkout_id: "" }).createCheckout(checkout, ctx),
		).rejects.toMatchObject({ name: "BnplProviderError" });
	});

	it.each([
		{ currency: "SAR", amount: "100.01", invalid: "100.001" },
		{ currency: "KWD", amount: "100.001", invalid: "100.0001" },
	])(
		"preserves integer-minor-unit history for $currency",
		async ({ currency, amount, invalid }) => {
			const totalAmount = { amount, currency };
			const snapshot = {
				order_id: "order-1",
				order_reference_id: "reference-1",
				status: "fully_captured",
				total_amount: totalAmount,
				captured_amount: totalAmount,
				refunded_amount: { amount: currency === "SAR" ? "0.00" : "0.000", currency },
				transactions: {
					captures: [{ capture_id: "capture-1", total_amount: { amount, currency } }],
					refunds: [],
				},
			};
			const state = await providerReturning(snapshot).fetchOrder("order-1", ctx);
			expect(state.capturedAmountMinor).toBe(currency === "SAR" ? 10001 : 100001);
			await expect(
				providerReturning({ ...snapshot, total_amount: { amount: invalid, currency } }).fetchOrder(
					"order-1",
					ctx,
				),
			).rejects.toMatchObject({ name: "BnplProviderError" });
		},
	);

	it("returns confirmed canceled totals while preserving the original order amount", async () => {
		const state = await providerReturning({
			...order,
			captured_amount: { ...money, amount: "75.00" },
			canceled_amount: { ...money, amount: "25.00" },
			transactions: {
				captures: [{ capture_id: "capture-1", total_amount: { ...money, amount: "75.00" } }],
				refunds: [],
				cancels: [
					{
						cancel_id: "cancel-1",
						order_id: "order-1",
						total_amount: { ...money, amount: "25.00" },
					},
				],
			},
		}).fetchOrder("order-1", ctx);
		expect(state).toMatchObject({
			totalAmount: money,
			capturedAmountMinor: 7500,
			canceledAmountMinor: 2500,
		});
		expect(state.operations).toContainEqual({
			kind: "canceled",
			id: "cancel-1",
			amountMinor: 2500,
			currency: "SAR",
		});
	});
	it.each([
		{ ...money, currency: "KWD", amount: "25.00" },
		{ ...money, amount: "26.00" },
	])("rejects inconsistent canceled balances %j", async (canceled_amount) => {
		await expect(
			providerReturning({
				...order,
				captured_amount: { ...money, amount: "75.00" },
				canceled_amount,
			}).fetchOrder("order-1", ctx),
		).rejects.toMatchObject({ name: "BnplProviderError" });
	});

	it.each(
		[
			undefined,
			[],
			[{ cancel_id: "cancel-1", order_id: "wrong", total_amount: { ...money, amount: "25.00" } }],
			[{ cancel_id: "cancel-1", total_amount: { ...money, currency: "KWD", amount: "25.00" } }],
			[{ cancel_id: "cancel-1", total_amount: { ...money, amount: "20.00" } }],
			[
				{ cancel_id: "cancel-1", total_amount: { ...money, amount: "12.50" } },
				{ cancel_id: "cancel-1", total_amount: { ...money, amount: "12.50" } },
			],
		].map((cancels) => ({ cancels })),
	)(
		"rejects positive canceled totals without complete native cancellation history %j",
		async ({ cancels }) => {
			await expect(
				providerReturning({
					...order,
					captured_amount: { ...money, amount: "75.00" },
					canceled_amount: { ...money, amount: "25.00" },
					transactions: {
						captures: [{ capture_id: "capture-1", total_amount: { ...money, amount: "75.00" } }],
						refunds: [],
						...(cancels !== undefined ? { cancels } : {}),
					},
				}).fetchOrder("order-1", ctx),
			).rejects.toMatchObject({ name: "BnplProviderError" });
		},
	);
	it("maps complete native capture/refund history using gross capture amounts and successful refunds", async () => {
		const snapshot = {
			...order,
			status: "partially_refunded",
			refunded_amount: { ...money, amount: "25.00" },
			transactions: {
				captures: [
					{
						capture_id: "capture-1",
						order_id: "order-1",
						total_amount: money,
						refunded_amount: { ...money, amount: "25.00" },
					},
				],
				refunds: [
					{
						refund_id: "refund-1",
						capture_id: "capture-1",
						total_amount: { ...money, amount: "25.00" },
						refund_status: "success",
					},
					{
						refund_id: "failed",
						capture_id: "capture-1",
						total_amount: { ...money, amount: "75.00" },
						refund_status: "failed",
					},
				],
			},
		};
		expect((await providerReturning(snapshot).fetchOrder("order-1", ctx)).operations).toEqual([
			{ kind: "captured", id: "capture-1", amountMinor: 10000, currency: "SAR" },
			{ kind: "refunded", id: "refund-1", amountMinor: 2500, currency: "SAR" },
		]);
	});
	it("rejects capture and cancellation totals that exceed the original amount", async () => {
		const snapshot = {
			...order,
			captured_amount: { ...money, amount: "80.00" },
			canceled_amount: { ...money, amount: "25.00" },
			transactions: {
				captures: [{ capture_id: "capture-1", total_amount: { ...money, amount: "80.00" } }],
				refunds: [],
				cancels: [{ cancel_id: "cancel-1", total_amount: { ...money, amount: "25.00" } }],
			},
		};
		await expect(providerReturning(snapshot).fetchOrder("order-1", ctx)).rejects.toMatchObject({
			name: "BnplProviderError",
		});
	});
	it.each([
		{
			captures: [{ capture_id: "capture-1", total_amount: { ...money, amount: "99.00" } }],
			refunds: [],
		},
		{
			captures: [
				{ capture_id: "capture-1", total_amount: money },
				{ capture_id: "capture-1", total_amount: money },
			],
			refunds: [],
		},
		{
			captures: [{ capture_id: "capture-1", order_id: "wrong", total_amount: money }],
			refunds: [],
		},
		{
			captures: [{ capture_id: "capture-1", total_amount: { ...money, currency: "KWD" } }],
			refunds: [],
		},
		{ captures: [{ capture_id: "", total_amount: money }], refunds: [] },
		{ captures: "malformed", refunds: [] },
		{
			captures: [{ capture_id: "capture-1", total_amount: money }],
			refunds: [
				{
					refund_id: "refund-1",
					capture_id: "missing",
					total_amount: { ...money, amount: "25.00" },
					refund_status: "success",
				},
			],
		},
		{
			captures: [{ capture_id: "capture-1", total_amount: money }],
			refunds: [
				{
					refund_id: "refund-1",
					capture_id: "capture-1",
					total_amount: { ...money, amount: "25.00" },
				},
			],
		},
	])("rejects incomplete or inconsistent native transaction history %j", async (transactions) => {
		await expect(
			providerReturning({ ...order, transactions }).fetchOrder("order-1", ctx),
		).rejects.toMatchObject({
			name: "BnplProviderError",
		});
	});
	it.each([
		[
			{
				refund_id: "refund-1",
				capture_id: "capture-1",
				total_amount: { ...money, amount: "25.00" },
				refund_status: "success",
			},
			{
				refund_id: "refund-1",
				capture_id: "capture-1",
				total_amount: { ...money, amount: "25.00" },
				refund_status: "success",
			},
		],
		[
			{
				refund_id: "refund-1",
				capture_id: "capture-1",
				total_amount: { ...money, currency: "KWD", amount: "25.00" },
				refund_status: "success",
			},
		],
		[
			{
				refund_id: "refund-1",
				capture_id: "capture-1",
				total_amount: { ...money, amount: "20.00" },
				refund_status: "success",
			},
		],
	])("rejects duplicate, wrong-currency, or incomplete refund history %j", async (...refunds) => {
		await expect(
			providerReturning({
				...order,
				status: "partially_refunded",
				refunded_amount: { ...money, amount: "25.00" },
				transactions: { captures: [{ capture_id: "capture-1", total_amount: money }], refunds },
			}).fetchOrder("order-1", ctx),
		).rejects.toMatchObject({ name: "BnplProviderError" });
	});
	it("maps two successful partial refunds to the full refunded total", async () => {
		const state = await providerReturning({
			...order,
			status: "fully_refunded",
			refunded_amount: money,
			transactions: {
				captures: [{ capture_id: "capture-1", total_amount: money }],
				refunds: [
					{
						refund_id: "refund-1",
						capture_id: "capture-1",
						total_amount: { ...money, amount: "25.00" },
						refund_status: "success",
					},
					{
						refund_id: "refund-2",
						capture_id: "capture-1",
						total_amount: { ...money, amount: "75.00" },
						refund_status: "success",
					},
				],
			},
		}).fetchOrder("order-1", ctx);
		expect(state.operations?.map((operation) => operation.amountMinor)).toEqual([
			10000, 2500, 7500,
		]);
	});
	it("preserves compatibility for snapshots without transaction history", async () => {
		expect((await providerReturning(order).fetchOrder("order-1", ctx)).operations).toBeUndefined();
	});

	it.each(["provider_new_status", "CANCELED", "CAPTURED"])(
		"rejects noncanonical native order status %s instead of inventing a mapping",
		(status) => {
			expect(() => tamaraStatusToCanonical(status)).toThrow(/status/i);
		},
	);
	it("rejects order snapshots without confirmed financial totals", async () => {
		const { captured_amount: _captured, ...incomplete } = order;
		await expect(providerReturning(incomplete).fetchOrder("order-1", ctx)).rejects.toMatchObject({
			name: "BnplProviderError",
		});
	});
	it.each([
		{ ...order, order_id: "another-order" },
		{ ...order, captured_amount: { ...money, currency: "KWD" } },
	])("rejects snapshots for the wrong order or currency", async (body) => {
		await expect(providerReturning(body).fetchOrder("order-1", ctx)).rejects.toMatchObject({
			name: "BnplProviderError",
		});
	});
	it.each([
		{
			capture_id: "capture-1",
			order_id: "another-order",
			status: "fully_captured",
			captured_amount: money,
		},
		{
			capture_id: "capture-1",
			order_id: "order-1",
			status: "fully_captured",
			captured_amount: { ...money, currency: "KWD" },
		},
		{
			capture_id: "capture-1",
			order_id: "order-1",
			status: "fully_captured",
			captured_amount: { ...money, amount: "99.00" },
		},
	])(
		"rejects capture success inconsistent with the requested financial operation",
		async (body) => {
			await expect(
				providerReturning(body).capture("order-1", captureArgs, ctx),
			).rejects.toMatchObject({ name: "BnplProviderError" });
		},
	);
	it("preserves partial cancellation result rather than implying full cancellation", async () => {
		const body = {
			order_id: "order-1",
			cancel_id: "cancel-1",
			status: "updated",
			canceled_amount: { ...money, amount: "30.00" },
		};
		await expect(
			providerReturning(body).cancel(
				"order-1",
				{ totalAmount: { ...money, amount: "30.00" } },
				ctx,
			),
		).resolves.toMatchObject({ status: "updated", cancelId: "cancel-1", amountMinor: 3000 });
	});
	it.each([
		{ requested: "75.00", cumulative: "100.00", status: "fully_refunded" },
		{ requested: "25.00", cumulative: "50.00", status: "partially_refunded" },
	])(
		"verifies the native refund when the API returns cumulative totals %j",
		async ({ requested, cumulative, status }) => {
			const fetch = vi.fn(async (_url, options) =>
				Response.json(
					options?.method === "GET"
						? {
								...order,
								status,
								refunded_amount: { ...money, amount: cumulative },
								transactions: {
									captures: [{ capture_id: "capture-1", order_id: "order-1", total_amount: money }],
									refunds: [
										{
											refund_id: "previous",
											capture_id: "capture-1",
											total_amount: { ...money, amount: "25.00" },
											refund_status: "success",
										},
										{
											refund_id: "current",
											capture_id: "capture-1",
											total_amount: { ...money, amount: requested },
											refund_status: "success",
										},
									],
								},
							}
						: {
								order_id: "order-1",
								refund_id: "current",
								status,
								refunded_amount: { ...money, amount: cumulative },
							},
				),
			);
			const provider = tamara({ ...config, fetch });
			await expect(
				provider.refund("order-1", { totalAmount: { ...money, amount: requested } }, ctx),
			).resolves.toMatchObject({ refundId: "current", amountMinor: Number(requested) * 100 });
			expect(fetch).toHaveBeenCalledTimes(2);
		},
	);
	it("keeps a cumulative refund uncertain when its native operation cannot be corroborated", async () => {
		const fetch = vi.fn(async (_url, options) =>
			Response.json(
				options?.method === "GET"
					? {
							...order,
							status: "fully_refunded",
							refunded_amount: money,
							transactions: {
								captures: [{ capture_id: "capture-1", total_amount: money }],
								refunds: [
									{
										refund_id: "other",
										capture_id: "capture-1",
										total_amount: money,
										refund_status: "success",
									},
								],
							},
						}
					: {
							order_id: "order-1",
							refund_id: "current",
							status: "fully_refunded",
							refunded_amount: money,
						},
			),
		);
		await expect(
			tamara({ ...config, fetch }).refund(
				"order-1",
				{ totalAmount: { ...money, amount: "75.00" } },
				ctx,
			),
		).rejects.toMatchObject({ name: "BnplProviderError" });
	});
	it("rejects refund success with a different currency", async () => {
		const body = {
			order_id: "order-1",
			refund_id: "refund-1",
			status: "partially_refunded",
			refunded_amount: { ...money, currency: "KWD" },
		};
		await expect(
			providerReturning(body).refund("order-1", { totalAmount: money }, ctx),
		).rejects.toMatchObject({ name: "BnplProviderError" });
	});
	it("returns independently confirmed capture and refund amounts", async () => {
		await expect(
			providerReturning({
				capture_id: "capture-1",
				order_id: "order-1",
				status: "fully_captured",
				captured_amount: money,
			}).capture("order-1", captureArgs, ctx),
		).resolves.toMatchObject({ amountMinor: 10000 });
		await expect(
			providerReturning({
				refund_id: "refund-1",
				order_id: "order-1",
				status: "fully_refunded",
				refunded_amount: money,
			}).refund("order-1", { totalAmount: money }, ctx),
		).resolves.toMatchObject({ amountMinor: 10000 });
	});
	it.each(["-1.00", "0.001", "not-money"])(
		"rejects invalid outbound money %s before sending a cancellation",
		async (amount) => {
			const fetch = vi.fn(async () =>
				Response.json({
					order_id: "order-1",
					cancel_id: "cancel-1",
					status: "canceled",
					canceled_amount: money,
				}),
			);
			await expect(
				new TamaraClient({ apiToken: "test", fetch }).cancelOrder("order-1", {
					total_amount: { amount, currency: "SAR" },
				}),
			).rejects.toMatchObject({ name: "BnplProviderError" });
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it("preserves a provider refusal to void a paid checkout", async () => {
		const body = {
			order_was_voided: false,
			captured_amount: money,
			message: "checkout_already_completed",
		};
		await expect(
			providerReturning(body).voidCheckout?.("checkout-1", "order-1", ctx),
		).resolves.toMatchObject({
			voided: false,
			capturedAmountMinor: 10000,
			capturedCurrency: "SAR",
		});
	});
	it("rejects auto-capture metadata whose monetary amount is not authoritative", async () => {
		await expect(
			providerReturning({
				order_id: "order-1",
				status: "fully_captured",
				auto_captured: true,
				capture_id: "capture-1",
				authorized_amount: { amount: "100.00", currency: "USD" },
			}).authorize?.("order-1", ctx),
		).rejects.toMatchObject({ name: "BnplProviderError" });
	});
});

describe("Tamara trusted checkout data", () => {
	it("forwards real merchant history including first-order null dates", () => {
		expect(toTamaraCheckoutRequest(checkout)).toMatchObject({ risk_assessment: riskAssessment });
	});
	it("fails before contacting Tamara when supplied risk assessment is incomplete", async () => {
		const fetch = vi.fn(async () => Response.json({}));
		await expect(
			tamara({ ...config, fetch }).createCheckout(
				{ ...checkout, providerData: { riskAssessment: {} } },
				ctx,
			),
		).rejects.toMatchObject({ name: "BnplPluginError" });
		expect(fetch).not.toHaveBeenCalled();
	});
	it("rejects invalid history dates without replacing them with invented history", () => {
		expect(() =>
			toTamaraCheckoutRequest({
				...checkout,
				providerData: {
					riskAssessment: { ...riskAssessment, account_creation_date: "31-02-2026" },
				},
			}),
		).toThrow();
	});
});
describe("Tamara optional eligibility checks", () => {
	it("keeps Tamara available when the customer phone is missing", async () => {
		await expect(
			tamara(config).preCheck({ countryCode: "SA", amount: money }, ctx),
		).resolves.toEqual({ available: true });
	});
	it("keeps Tamara available when the eligibility service fails", async () => {
		const fetch: typeof globalThis.fetch = async () => {
			throw new TypeError("Network unavailable");
		};
		await expect(
			tamara({ ...config, fetch }).preCheck(
				{ countryCode: "SA", amount: money, phone: "966501234567" },
				ctx,
			),
		).resolves.toMatchObject({ available: true });
	});
	it("sends the documented customer phone_number and optional email", async () => {
		let body: unknown;
		const fetch: typeof globalThis.fetch = async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return Response.json({ is_eligible: false });
		};
		await expect(
			tamara({ ...config, fetch }).preCheck(
				{
					countryCode: "SA",
					amount: money,
					phone: "966504591298",
					email: "precheck-fallback@example.com",
				},
				ctx,
			),
		).resolves.toEqual({ available: false });
		expect(body).toMatchObject({
			customer: { phone_number: "966504591298", email: "precheck-fallback@example.com" },
		});
	});
	it("bounds stalled eligibility checks independently of the normal operation timeout", async () => {
		const fetch: typeof globalThis.fetch = async (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("Timed out", "AbortError")),
					{ once: true },
				);
			});
		await expect(
			tamara({ ...config, fetch, timeoutMs: 15000 }).preCheck(
				{ countryCode: "SA", amount: money, phone: "966501234567" },
				ctx,
			),
		).resolves.toMatchObject({ available: true });
	}, 1000);
});

describe("Tamara webhook boundaries", () => {
	it("keeps separate cancellation updates and deduplicates reordered redeliveries", () => {
		const first = {
			order_id: "order-1",
			order_reference_id: "reference-1",
			event_type: "order_updated",
			data: { canceled_amount: { amount: 30, currency: "SAR" } },
		};
		const second = { ...first, data: { canceled_amount: { amount: 40, currency: "SAR" } } };
		const reordered = {
			data: { canceled_amount: { currency: "SAR", amount: 30 } },
			event_type: "order_updated",
			order_reference_id: "reference-1",
			order_id: "order-1",
		};
		expect(tamaraDedupKey(first)).not.toBe(tamaraDedupKey(second));
		expect(tamaraDedupKey(first)).toBe(tamaraDedupKey(reordered));
	});
	it("identifies updated cancellations by operation ID when available", () => {
		const payload = {
			order_id: "order-1",
			order_reference_id: "reference-1",
			event_type: "order_updated",
			data: { cancel_id: "cancel-1" },
		};
		expect(tamaraDedupKey(payload)).toBe("tamara:order_updated:cancel-1");
		expect(tamaraDedupKey({ ...payload, data: { cancel_id: "cancel-2" } })).not.toBe(
			tamaraDedupKey(payload),
		);
	});
	it.each(["register", "update"])(
		"validates %s payload before an external write",
		async (method) => {
			const fetch = vi.fn(async () =>
				Response.json({ webhook_id: "webhook-1", url: "https://shop.test", events: [] }),
			);
			const client = new TamaraClient({ apiToken: "test", fetch });
			const body = { type: "order" as const, events: [], url: "http://shop.test/webhook" as const };
			const operation =
				method === "register"
					? client.registerWebhook(body)
					: client.updateWebhook("webhook-1", body);
			await expect(operation).rejects.toMatchObject({ name: "BnplProviderError" });
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ exp: "9999999999" },
		{ exp: null },
		{ iat: "123" },
		{ iat: null },
		{ exp: 1000 },
		{ exp: 999 },
		{ iat: -1 },
	])("rejects malformed NumericDate claims and exact expiration boundary", (claims) => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
		const payload = Buffer.from(JSON.stringify({ iss: "Tamara", ...claims })).toString("base64url");
		const signature = createHmac("sha256", config.notificationToken)
			.update(`${header}.${payload}`)
			.digest("base64url");
		expect(() =>
			verifyTamaraJwt(`${header}.${payload}.${signature}`, config.notificationToken),
		).toThrow();
	});
});

describe("Tamara cumulative cancellation responses", () => {
	const current = {
		cancel_id: "current",
		order_id: "order-1",
		total_amount: { ...money, amount: "25.00" },
	};
	const snapshot = {
		...order,
		status: "updated",
		captured_amount: { ...money, amount: "0.00" },
		canceled_amount: { ...money, amount: "50.00" },
		transactions: {
			captures: [],
			refunds: [],
			cancels: [current, { ...current, cancel_id: "previous" }],
		},
	};
	it.each([
		{ requested: "25.00", cumulative: "50.00", status: "updated", previous: ["25.00"] },
		{ requested: "50.00", cumulative: "100.00", status: "canceled", previous: ["25.00", "25.00"] },
	])("returns only the matched cancellation delta for %j", async (input) => {
		const methods: string[] = [];
		const provider = tamara({
			...config,
			fetch: async (_url, init) => {
				methods.push(init?.method ?? "GET");
				return Response.json(
					init?.method === "GET"
						? {
								...snapshot,
								status: input.status,
								canceled_amount: { ...money, amount: input.cumulative },
								transactions: {
									captures: [],
									refunds: [],
									cancels: [
										{ ...current, total_amount: { ...money, amount: input.requested } },
										...input.previous.map((amount, index) => ({
											...current,
											cancel_id: `previous-${index}`,
											total_amount: { ...money, amount },
										})),
									],
								},
							}
						: {
								order_id: "order-1",
								cancel_id: "current",
								status: input.status,
								canceled_amount: { ...money, amount: input.cumulative },
							},
				);
			},
		});
		await expect(
			provider.cancel(
				"order-1",
				{
					totalAmount: { ...money, amount: input.requested },
				},
				ctx,
			),
		).resolves.toMatchObject({
			cancelId: "current",
			amountMinor: Number(input.requested) * 100,
			status: input.status,
		});
		expect(methods).toEqual(["POST", "GET"]);
	});
	it("keeps the first exact-amount cancellation on one provider request", async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				order_id: "order-1",
				cancel_id: "current",
				status: "updated",
				canceled_amount: current.total_amount,
			}),
		);
		await expect(
			tamara({ ...config, fetch }).cancel(
				"order-1",
				{
					totalAmount: current.total_amount,
				},
				ctx,
			),
		).resolves.toMatchObject({ cancelId: "current", amountMinor: 2500 });
		expect(fetch).toHaveBeenCalledOnce();
	});
	it.each([
		{
			label: "missing matched cancellation",
			body: {
				...snapshot,
				transactions: {
					...snapshot.transactions,
					cancels: [
						{ ...current, cancel_id: "other", total_amount: { ...money, amount: "50.00" } },
					],
				},
			},
		},
		{
			label: "wrong matched delta",
			body: {
				...snapshot,
				transactions: {
					...snapshot.transactions,
					cancels: [
						{ ...current, total_amount: { ...money, amount: "30.00" } },
						{ ...current, cancel_id: "previous", total_amount: { ...money, amount: "20.00" } },
					],
				},
			},
		},
		{
			label: "wrong operation currency",
			body: {
				...snapshot,
				transactions: {
					...snapshot.transactions,
					cancels: [
						{ ...current, total_amount: { ...money, currency: "AED" } },
						snapshot.transactions.cancels[1],
					],
				},
			},
		},
		{
			label: "duplicate native cancellation ID",
			body: {
				...snapshot,
				transactions: { ...snapshot.transactions, cancels: [current, current] },
			},
		},
		{ label: "wrong payment identity", body: { ...snapshot, order_id: "unrelated" } },
		{
			label: "contradictory cumulative total",
			body: { ...snapshot, canceled_amount: { ...money, amount: "51.00" } },
		},
		{ label: "malformed snapshot", body: {} },
	])("keeps an uncorroborated cancellation uncertain: $label", async ({ body }) => {
		const methods: string[] = [];
		const provider = tamara({
			...config,
			fetch: async (_url, init) => {
				methods.push(init?.method ?? "GET");
				return Response.json(
					init?.method === "GET"
						? body
						: {
								order_id: "order-1",
								cancel_id: "current",
								status: "updated",
								canceled_amount: snapshot.canceled_amount,
							},
				);
			},
		});
		await expect(
			provider.cancel("order-1", { totalAmount: current.total_amount }, ctx),
		).rejects.toMatchObject({ name: "BnplProviderError" });
		expect(methods).toEqual(["POST", "GET"]);
	});
});
