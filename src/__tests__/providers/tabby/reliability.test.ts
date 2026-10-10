import { describe, expect, it, vi } from "vitest";
import type { BnplCheckoutInput } from "../../../core/types";
import { tabby } from "../../../providers/tabby";
import {
	fromTabbyPaymentDetails,
	tabbyStatusToCanonical,
	toTabbyItem,
} from "../../../providers/tabby/adapter";
import { TabbyClient } from "../../../providers/tabby/client";
import { tabbyCheckoutDataSchema } from "../../../providers/tabby/schemas";
import { ctx, silentLogger } from "../../_harness";
const config = {
	secretKey: "sk_test_example",
	merchantCode: "merchant",
	webhookHeader: { name: "X-Auth", value: "test-secret" },
};
const payment = {
	id: "payment",
	status: "CLOSED",
	amount: "100.00",
	currency: "SAR",
	captures: [
		{ id: "capture-a", reference_id: "a", amount: "25.00" },
		{ id: "capture-b", reference_id: "b", amount: "50.00" },
	],
	refunds: [
		{ id: "refund-a", reference_id: "a", amount: "10.00" },
		{ id: "refund-b", reference_id: "b", amount: "15.00" },
	],
};
function providerFor(body: unknown) {
	return tabby({
		...config,
		fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
	});
}
describe("Tabby financial reliability", () => {
	it("finds a replayed capture by merchant reference rather than position", async () => {
		expect(
			await providerFor(payment).capture(
				"payment",
				{ totalAmount: { amount: "25.00", currency: "SAR" }, merchantReferenceId: "a" },
				ctx,
			),
		).toMatchObject({ captureId: "capture-a", amountMinor: 2500 });
	});
	it("finds a replayed refund by merchant reference rather than position", async () => {
		expect(
			await providerFor(payment).refund(
				"payment",
				{ totalAmount: { amount: "10.00", currency: "SAR" }, merchantRefundId: "a" },
				ctx,
			),
		).toMatchObject({ refundId: "refund-a", amountMinor: 1000 });
	});
	it.each([
		{ ...payment, id: "other" },
		{ ...payment, currency: "AED" },
		{ ...payment, captures: [] },
	])("rejects unrelated operation responses", async (body) => {
		await expect(
			providerFor(body).capture(
				"payment",
				{ totalAmount: { amount: "25.00", currency: "SAR" }, merchantReferenceId: "a" },
				ctx,
			),
		).rejects.toThrow();
	});
	it("rejects reuse of a reference with a different amount", async () => {
		await expect(
			providerFor(payment).capture(
				"payment",
				{ totalAmount: { amount: "30.00", currency: "SAR" }, merchantReferenceId: "a" },
				ctx,
			),
		).rejects.toThrow();
	});
	it("derives exact unit price from the line total", () => {
		expect(
			toTabbyItem({
				referenceId: "sku",
				sku: "sku",
				name: "Item",
				quantity: 2,
				totalAmount: { amount: "100.00", currency: "SAR" },
			}).unit_price,
		).toBe("50.00");
	});
	it("rejects indivisible line totals without an explicit unit price", () => {
		expect(() =>
			toTabbyItem({
				referenceId: "sku",
				sku: "sku",
				name: "Item",
				quantity: 3,
				totalAmount: { amount: "100.00", currency: "SAR" },
			}),
		).toThrow();
	});
	it("recognizes full refund after partial capture and close", () => {
		expect(tabbyStatusToCanonical("CLOSED", 10000, 4000, 4000)).toBe("fully_refunded");
	});
	it("fails closed for malformed capture money", () => {
		expect(() =>
			fromTabbyPaymentDetails(
				{ ...payment, captures: [{ id: "capture", amount: "NaN" }], refunds: [] },
				silentLogger,
			),
		).toThrow();
	});
	it("fails closed for unknown payment statuses", () => {
		expect(() => tabbyStatusToCanonical("UNRECOGNIZED", 10000, 0, 0)).toThrow();
	});
	it("allows buyer history without unrelated education attachment", () => {
		expect(
			tabbyCheckoutDataSchema.safeParse({
				buyer_history: { registered_since: "2026-01-01T00:00:00Z", loyalty_level: 0 },
			}).success,
		).toBe(true);
	});
	it.each([401, 403, 400])(
		"does not advertise availability after permanent API error %i",
		async (status) => {
			const provider = tabby({
				...config,
				fetch: async () =>
					new Response(JSON.stringify({ error: "configuration invalid" }), { status }),
			});
			await expect(
				provider.preCheck(
					{
						countryCode: "SA",
						amount: { amount: "100.00", currency: "SAR" },
						email: "buyer@example.com",
						phone: "+966500000001",
					},
					ctx,
				),
			).rejects.toThrow();
		},
	);
	it("only advertises implemented dispute support", () => {
		expect(tabby(config).capabilities.disputes).toBe(false);
	});
});
describe("Tabby snapshot delivery", () => {
	it.each([
		["REJECTED", "declined"],
		["EXPIRED", "expired"],
	] as const)("maps a %s snapshot and its final lifecycle event", (status, kind) => {
		const events = providerFor(payment).toCanonicalEvents?.({
			...payment,
			status,
			captures: [],
			refunds: [],
		});
		expect(events?.map((event) => event.kind)).toEqual([kind, "updated"]);
		expect(events?.at(-1)).toMatchObject({ status: kind });
	});
	it("emits every money operation followed by derived payment state", () => {
		const events = providerFor(payment).toCanonicalEvents?.(payment);
		expect(events?.map((event) => event.kind)).toEqual([
			"captured",
			"captured",
			"refunded",
			"refunded",
			"updated",
		]);
		expect(events?.at(-1)).toMatchObject({ status: "partially_refunded" });
	});
	it("maps close without captures to canceled", () => {
		const events = providerFor(payment).toCanonicalEvents?.({
			...payment,
			captures: [],
			refunds: [],
		});
		expect(events?.at(-1)).toMatchObject({ kind: "updated", status: "canceled" });
	});
	it("separates capture confirmation from close and ignores incidental metadata", async () => {
		const provider = providerFor(payment);
		const verify = async (body: unknown) =>
			provider.verifyWebhook({
				url: "https://example.com",
				headers: new Headers({ "X-Auth": "test-secret" }),
				rawBody: JSON.stringify(body),
			});
		const authorized = await verify({ ...payment, status: "authorized", refunds: [] });
		const closed = await verify({ ...payment, status: "closed", refunds: [] });
		const metadataChanged = await verify({
			...payment,
			status: "closed",
			refunds: [],
			meta: { irrelevant: true },
		});
		expect(authorized.ok && closed.ok && authorized.dedupKey !== closed.dedupKey).toBe(true);
		expect(closed.ok && metadataChanged.ok && closed.dedupKey === metadataChanged.dedupKey).toBe(
			true,
		);
	});
	it("returns the complete operation ledger when fetching a payment", async () => {
		expect((await providerFor(payment).fetchOrder("payment", ctx)).operations).toHaveLength(4);
	});
});
describe("Tabby snapshot validation", () => {
	it("rejects retrieval of a different payment", async () => {
		await expect(
			providerFor({ ...payment, id: "other" }).fetchOrder("payment", ctx),
		).rejects.toThrow();
	});
	it("rejects an empty payment identifier", () => {
		expect(() => providerFor(payment).toCanonicalEvents?.({ ...payment, id: "" })).toThrow();
	});
	it("allows mandatory buyer registration history without optional loyalty data", () => {
		expect(
			tabbyCheckoutDataSchema.safeParse({
				buyer_history: { registered_since: "2026-01-01T00:00:00Z" },
			}).success,
		).toBe(true);
	});
	it("does not change snapshot identity when operation arrays are reordered", async () => {
		const provider = providerFor(payment);
		const verify = async (body: unknown) =>
			provider.verifyWebhook({
				url: "https://example.com",
				headers: new Headers({ "X-Auth": "test-secret" }),
				rawBody: JSON.stringify(body),
			});
		const first = await verify(payment);
		const reordered = await verify({
			...payment,
			captures: [...payment.captures].reverse(),
			refunds: [...payment.refunds].reverse(),
		});
		expect(first.ok && reordered.ok && first.dedupKey === reordered.dedupKey).toBe(true);
	});
	it("tracks changed merchant reference as a distinct snapshot", async () => {
		const provider = providerFor(payment);
		const verify = async (reference_id: string) =>
			provider.verifyWebhook({
				url: "https://example.com",
				headers: new Headers({ "X-Auth": "test-secret" }),
				rawBody: JSON.stringify({ ...payment, order: { reference_id } }),
			});
		const first = await verify("first");
		const updated = await verify("updated");
		expect(first.ok && updated.ok && first.dedupKey !== updated.dedupKey).toBe(true);
	});
});

describe("Tabby closure safeguards", () => {
	it.each(["cancel", "closePayment"] as const)(
		"rejects %s responses for a different payment",
		async (operation) => {
			const provider = providerFor({ ...payment, id: "unrelated" });
			await expect(
				operation === "cancel"
					? provider.cancel("payment", {}, ctx)
					: provider.closePayment?.("payment", ctx),
			).rejects.toThrow(/identity/);
		},
	);
	it("rejects a close response that leaves the payment open", async () => {
		await expect(
			providerFor({ ...payment, status: "AUTHORIZED" }).closePayment?.("payment", ctx),
		).rejects.toThrow(/closed/);
	});
	it("rejects financial contradictions in a close response", async () => {
		await expect(
			providerFor({ ...payment, amount: "50.00" }).closePayment?.("payment", ctx),
		).rejects.toThrow(/financial/);
	});
	it.each([
		{ amount: "25.00", currency: "SAR" as const },
		{ amount: "75.00", currency: "AED" as const },
	])(
		"does not close a whole unpaid balance for a partial or wrong-currency cancel",
		async (money) => {
			const methods: string[] = [];
			const provider = tabby({
				...config,
				fetch: async (_url, init) => {
					methods.push(init?.method ?? "GET");
					return new Response(
						JSON.stringify({
							...payment,
							status: "AUTHORIZED",
							captures: [{ id: "capture", amount: "25.00" }],
							refunds: [],
						}),
					);
				},
			});
			await expect(provider.cancel("payment", { totalAmount: money }, ctx)).rejects.toThrow(
				/cancel/,
			);
			expect(methods).toEqual(["GET"]);
		},
	);
	it("closes only after a supplied cancel amount matches the unpaid balance", async () => {
		const methods: string[] = [];
		const provider = tabby({
			...config,
			fetch: async (_url, init) => {
				methods.push(init?.method ?? "GET");
				return new Response(
					JSON.stringify({
						...payment,
						status: init?.method === "GET" ? "AUTHORIZED" : "CLOSED",
						captures: [{ id: "capture", amount: "25.00" }],
						refunds: [],
					}),
				);
			},
		});
		await provider.cancel("payment", { totalAmount: { amount: "75.00", currency: "SAR" } }, ctx);
		expect(methods).toEqual(["GET", "POST"]);
	});
});

describe("Tabby checkout financial identity", () => {
	const money = { amount: "100.00", currency: "SAR" } as const;
	const item = { referenceId: "sku", sku: "SKU", name: "Item", quantity: 1, totalAmount: money };
	const input: BnplCheckoutInput = {
		orderReferenceId: "checkout-reference",
		description: "Synthetic",
		totalAmount: money,
		items: [item],
		buyer: { firstName: "Test", lastName: "Buyer", email: "test@example.com", phone: "000000000" },
		countryCode: "SA",
		merchantUrl: {
			success: "https://example.com/success",
			failure: "https://example.com/failure",
			cancel: "https://example.com/cancel",
			notification: "https://example.com/webhook",
		},
	};
	const response = {
		id: "checkout",
		status: "created",
		payment: {
			id: "payment",
			status: "CREATED",
			...money,
			captures: [],
			refunds: [],
			order: { reference_id: input.orderReferenceId },
		},
		configuration: {
			available_products: {
				installments: [{ web_url: "https://checkout.example.test/synthetic" }],
			},
		},
	};
	const other = { ...money, currency: "AED" } as const;
	it.each<Partial<BnplCheckoutInput>>([
		{ taxAmount: other },
		{ shippingAmount: other },
		{ discount: { name: "Discount", amount: other } },
		{ items: [{ ...item, totalAmount: other }] },
		{ items: [{ ...item, unitPrice: other }] },
		{ items: [{ ...item, taxAmount: other }] },
		{ items: [{ ...item, discountAmount: other }] },
	])("rejects mixed checkout money currencies before POST: %j", async (patch) => {
		const fetch = vi.fn(async () => Response.json(response));
		await expect(
			tabby({ ...config, fetch }).createCheckout({ ...input, ...patch }, ctx),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each([
		{ ...response.payment, amount: "999.00" },
		{ ...response.payment, currency: "AED" },
		{ ...response.payment, order: { reference_id: "unrelated" } },
		{ ...response.payment, order: { reference_id: 123 } },
		{ ...response.payment, status: "AUTHORIZED" },
		{ ...response.payment, captures: [{ id: "unexpected-capture", amount: "25.00" }] },
	])("rejects an unrelated or already-funded checkout response: %j", async (payment) => {
		await expect(
			providerFor({ ...response, payment }).createCheckout(input, ctx),
		).rejects.toThrow();
	});
	it.each(["expired", "approved"])(
		"does not return a new hosted checkout for session status %s",
		async (status) => {
			await expect(
				providerFor({ ...response, status }).createCheckout(input, ctx),
			).rejects.toThrow();
		},
	);
	it("accepts matching numeric identity without an optional returned order reference", async () => {
		const { order: _order, ...payment } = response.payment;
		await expect(
			providerFor({ ...response, payment: { ...payment, amount: "100" } }).createCheckout(
				input,
				ctx,
			),
		).resolves.toMatchObject({ status: "new", providerOrderId: "payment" });
	});
	it("preserves legitimate checkout rejection", async () => {
		await expect(
			providerFor({
				...response,
				status: "rejected",
				payment: { ...response.payment, status: "REJECTED" },
				configuration: {},
			}).createCheckout(input, ctx),
		).resolves.toMatchObject({ status: "declined" });
	});
	it.each([
		{ amount: "not-money", currency: "SAR" },
		{ amount: "100.00", currency: "USD" },
		{ amount: "1.001", currency: "SAR" },
		{ amount: "-1", currency: "AED" },
	])("rejects invalid direct eligibility money before POST: %j", async (money) => {
		const fetch = vi.fn(async () => Response.json(response));
		const client = new TabbyClient({ ...config, fetch });
		await expect(
			client.checkEligibility({
				merchant_code: config.merchantCode,
				payment: { ...money, buyer: { email: "test@example.com", phone: "000000000" } },
			}),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("accepts KWD precision under the existing compatibility contract", async () => {
		const fetch = vi.fn(async () => Response.json(response));
		await new TabbyClient({ ...config, fetch }).checkEligibility({
			merchant_code: config.merchantCode,
			payment: {
				amount: "1.001",
				currency: "KWD",
				buyer: { email: "test@example.com", phone: "000000000" },
			},
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
});
