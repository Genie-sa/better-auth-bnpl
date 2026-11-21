import type { GenericEndpointContext } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { BnplProviderError, isDefinitiveRejection } from "../core/errors";
import type { BnplProvider } from "../core/provider";
import type { BnplOrderState, BnplWebhookEvent } from "../core/types";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import {
	claimWebhookEvent,
	markWebhookEventProcessed,
	recordWebhookEvent,
	saveWebhookDeliveryState,
} from "../plugins/webhook-events";
import { webhooks } from "../plugins/webhooks";
import { tabby } from "../providers/tabby";
import { tabbyToCanonicalEvents } from "../providers/tabby/adapter";
import { tamaraDedupKey } from "../providers/tamara/adapter";
import { makeBnplTestInstance, stubProvider } from "./_harness";

const orderId = "hardening-order";
const sar = (amount: string) => ({ amount, currency: "SAR" as const });

function snapshot(overrides: Partial<BnplOrderState>): BnplOrderState {
	return {
		providerOrderId: orderId,
		status: "authorised",
		totalAmount: sar("100.00"),
		capturedAmountMinor: 0,
		refundedAmountMinor: 0,
		operations: [],
		raw: {},
		...overrides,
	};
}

async function setup(
	providerId: "tabby" | "tamara",
	overrides: Partial<BnplProvider>,
	row: Record<string, unknown> = {},
) {
	const base = stubProvider(providerId);
	const provider = stubProvider(providerId, {
		capabilities: {
			...base.capabilities,
			separateAuthorise: providerId === "tamara",
			voidCheckout: true,
			closePayment: true,
			partialCancel: providerId === "tamara",
			cancelClosesPayment: providerId === "tabby",
		},
		verifyWebhook: async (request) => ({
			ok: true,
			payload: JSON.parse(request.rawBody),
			rawBody: request.rawBody,
			dedupKey: JSON.parse(request.rawBody).delivery,
		}),
		toCanonicalEvent: (payload) => payload.event as BnplWebhookEvent,
		...overrides,
	});
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { [providerId]: provider },
			persistOrders: true,
			use: [admin({ isAuthorized: () => true }), webhooks()],
		}),
	]);
	const stored: Record<string, unknown> = {
		id: "hardening-row",
		provider: providerId,
		providerOrderId: orderId,
		providerCheckoutId: "hardening-checkout",
		orderReferenceId: "hardening-ref",
		status: "authorised",
		amountMinor: 10000,
		currency: "SAR",
		capturedAmountMinor: 0,
		refundedAmountMinor: 0,
		canceledAmountMinor: 0,
		version: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
		...row,
	};
	instance.db.bnplOrder?.push(stored);
	const { headers } = await instance.signInWithTestUser();
	const post = (operation: string, body?: Record<string, unknown>) =>
		instance.client.$fetch(`/bnpl/admin/orders/${orderId}/${operation}`, {
			method: "POST",
			headers,
			...(body ? { body } : {}),
		});
	const webhook = (delivery: string, event: BnplWebhookEvent) =>
		instance.client.$fetch(`/bnpl/webhooks/${providerId}`, {
			method: "POST",
			body: { delivery, event },
		});
	const journal = () =>
		stored.moneyCommands
			? (JSON.parse(String(stored.moneyCommands)) as Array<{ state: string }>).map(
					(command) => command.state,
				)
			: [];
	return { instance, stored, post, webhook, journal };
}

describe("Tabby documented conflicts and nullable history", () => {
	const config = {
		secretKey: "sk_test_unit",
		merchantCode: "unit",
		webhookHeader: { name: "X-Test", value: "unit" },
	};
	it.each([
		["could not acquire lock: payment is locked", true],
		["payment is disputed", true],
		["something else conflicted", false],
	])("classifies a capture 409 %j as rejected=%s", async (error, rejected) => {
		const provider = tabby({
			...config,
			fetch: async () =>
				Response.json({ status: "error", errorType: "conflict", error }, { status: 409 }),
		});
		const failure = await provider
			.capture(
				orderId,
				{ totalAmount: sar("10.00"), merchantReferenceId: "ref" },
				{ logger: console },
			)
			.catch((e: unknown) => e);
		expect(isDefinitiveRejection(failure)).toBe(rejected);
	});
	it("accepts null captures, refunds and references documented as nullable", async () => {
		const payment = {
			id: orderId,
			status: "CLOSED",
			amount: "100.00",
			currency: "SAR",
			captures: [{ id: "tabby-side-capture", amount: "100.00", reference_id: null }],
			refunds: null,
		};
		expect(tabbyToCanonicalEvents(payment).map((event) => event.kind)).toEqual([
			"captured",
			"updated",
		]);
		const provider = tabby({ ...config, fetch: async () => Response.json(payment) });
		await expect(provider.fetchOrder(orderId, { logger: console })).resolves.toMatchObject({
			status: "fully_captured",
			capturedAmountMinor: 10000,
		});
	});
});

describe("authorisation already completed upstream", () => {
	it("recovers through GET when Tamara refuses authorise because the order is already authorised", async () => {
		const authorize = vi.fn(async () => {
			throw new BnplProviderError(
				"tamara",
				"cannot be moved to the status authorised from authorised",
				{
					status: 409,
					body: {
						errors: [
							{
								error_code: "transition_not_allowed",
								data: { old_state: "authorised", new_state: "authorised" },
							},
						],
					},
					rejected: true,
				},
			);
		});
		const { stored, webhook, journal } = await setup(
			"tamara",
			{ authorize, fetchOrder: async () => snapshot({ status: "authorised" }) },
			{ status: "approved" },
		);
		const result = await webhook("approved-auto-authorised", {
			kind: "approved",
			provider: "tamara",
			orderId,
			raw: {},
		});
		expect(result.error).toBeNull();
		expect(stored.status).toBe("authorised");
		expect(journal()).toEqual(["completed"]);
		expect(authorize).toHaveBeenCalledOnce();
	});
	it("recovers when Tamara reports the order already moved on to a partial cancellation", async () => {
		const authorize = vi.fn(async () => {
			throw new BnplProviderError(
				"tamara",
				"cannot be moved to the status authorised from updated",
				{
					status: 409,
					body: {
						errors: [
							{
								error_code: "transition_not_allowed",
								data: { old_state: "updated", new_state: "authorised" },
							},
						],
					},
					rejected: true,
				},
			);
		});
		const fetchOrder = async () =>
			snapshot({
				status: "updated",
				canceledAmountMinor: 2500,
				operations: [{ kind: "canceled", id: "cancel-1", amountMinor: 2500, currency: "SAR" }],
			});
		const { stored, webhook, journal } = await setup(
			"tamara",
			{ authorize, fetchOrder },
			{ status: "approved" },
		);
		const result = await webhook("approved-after-partial-cancel", {
			kind: "approved",
			provider: "tamara",
			orderId,
			raw: {},
		});
		expect(result.error).toBeNull();
		expect(stored).toMatchObject({ status: "authorised", canceledAmountMinor: 2500 });
		expect(journal()).toEqual(["completed"]);
	});
	it("refuses an auto-captured authorisation in a different currency", async () => {
		const authorize = vi.fn(async () => ({
			providerOrderId: orderId,
			status: "fully_captured" as const,
			autoCaptured: true,
			captureId: "auto",
			capturedAmountMinor: 10000,
			capturedCurrency: "KWD" as const,
			raw: {},
		}));
		const { stored, post, journal } = await setup("tamara", { authorize }, { status: "approved" });
		expect((await post("authorise")).error).not.toBeNull();
		expect(stored.capturedAmountMinor).toBe(0);
		expect(journal()).toEqual(["pending"]);
	});
});

describe("cancellation after partial capture", () => {
	it("keeps a partially captured Tamara order capture-derived when the remainder is canceled", async () => {
		const cancel = vi.fn(async () => ({
			providerOrderId: orderId,
			status: "canceled" as const,
			cancelId: "cancel-rest",
			amountMinor: 4000,
			raw: {},
		}));
		const { stored, post } = await setup(
			"tamara",
			{ cancel },
			{ status: "partially_captured", capturedAmountMinor: 6000 },
		);
		const result = await post("cancel", {
			totalAmount: sar("40.00"),
			merchantReferenceId: "cancel-rest",
		});
		expect(result.error).toBeNull();
		expect(stored).toMatchObject({
			status: "fully_captured",
			capturedAmountMinor: 6000,
			canceledAmountMinor: 4000,
		});
	});
	it("applies a Tamara cancellation notification on a partially captured order", async () => {
		const fetchOrder = async () =>
			snapshot({
				status: "updated",
				capturedAmountMinor: 6000,
				canceledAmountMinor: 2000,
				operations: [
					{ kind: "captured", id: "capture-1", amountMinor: 6000, currency: "SAR" },
					{ kind: "canceled", id: "cancel-1", amountMinor: 2000, currency: "SAR" },
				],
			});
		const { instance, stored, webhook } = await setup(
			"tamara",
			{ fetchOrder },
			{
				status: "partially_captured",
				capturedAmountMinor: 6000,
				appliedOperations: JSON.stringify(["tamara:captured:capture-1"]),
			},
		);
		const result = await webhook("cancel-after-capture", {
			kind: "canceled",
			provider: "tamara",
			orderId,
			raw: { data: { cancel_id: "cancel-1" } },
		});
		expect(result.error).toBeNull();
		expect(stored).toMatchObject({
			status: "partially_captured",
			capturedAmountMinor: 6000,
			canceledAmountMinor: 2000,
		});
		const delivery = instance.db.bnplWebhookEvent?.[0];
		expect(JSON.parse(String(delivery?.deliveryState)).contexts[0]).toMatchObject({
			kind: "updated",
			status: "partially_captured",
		});
	});
	it("completes a Tabby amount-bearing cancel once the remote payment is closed", async () => {
		const closed = snapshot({
			status: "closed",
			capturedAmountMinor: 6000,
			operations: [{ kind: "captured", id: "capture-1", amountMinor: 6000, currency: "SAR" }],
			closed: true,
			raw: { status: "CLOSED" },
		});
		const cancel = vi.fn(async () => undefined);
		const { stored, post, journal } = await setup(
			"tabby",
			{ cancel, fetchOrder: async () => closed },
			{
				status: "partially_captured",
				capturedAmountMinor: 6000,
				appliedOperations: JSON.stringify(["tabby:captured:capture-1"]),
			},
		);
		const result = await post("cancel", {
			totalAmount: sar("40.00"),
			merchantReferenceId: "close-rest",
		});
		expect(result.error).toBeNull();
		expect(stored.status).toBe("closed");
		expect(journal()).toEqual(["completed"]);
	});
});

describe("reconciliation status", () => {
	it("derives the captured status when Tamara reports a partially canceled order as updated", async () => {
		const fetchOrder = async () =>
			snapshot({
				status: "updated",
				capturedAmountMinor: 5000,
				canceledAmountMinor: 2500,
				operations: [
					{ kind: "captured", id: "capture-1", amountMinor: 5000, currency: "SAR" },
					{ kind: "canceled", id: "cancel-1", amountMinor: 2500, currency: "SAR" },
				],
			});
		const { stored, post } = await setup("tamara", { fetchOrder });
		expect((await post("reconcile")).error).toBeNull();
		expect(stored).toMatchObject({
			status: "partially_captured",
			capturedAmountMinor: 5000,
			canceledAmountMinor: 2500,
		});
	});
});

describe("paid void recovery", () => {
	it("verifies a paid void from durable evidence after the follow-up read failed", async () => {
		let reads = 0;
		const fetchOrder = vi.fn(async () => {
			reads++;
			if (reads === 1) throw new BnplProviderError("tamara", "timed out");
			return snapshot({
				status: "fully_captured",
				capturedAmountMinor: 10000,
				operations: [{ kind: "captured", id: "capture-1", amountMinor: 10000, currency: "SAR" }],
			});
		});
		const voidCheckout = vi.fn(async () => ({
			voided: true,
			capturedAmountMinor: 10000,
			capturedCurrency: "SAR" as const,
			raw: {},
		}));
		const { stored, post, journal } = await setup(
			"tamara",
			{ voidCheckout, fetchOrder },
			{ status: "new" },
		);
		expect((await post("void", {})).error).not.toBeNull();
		expect(journal()).toEqual(["pending"]);
		expect((await post("void", {})).error).toBeNull();
		expect(voidCheckout).toHaveBeenCalledOnce();
		expect(stored).toMatchObject({ status: "fully_captured", capturedAmountMinor: 10000 });
		expect(journal()).toEqual(["completed"]);
	});
});

describe("verification-only commands", () => {
	it("sends close for an open Tabby payment whose captured part was refunded", async () => {
		const closed = snapshot({
			status: "fully_refunded",
			capturedAmountMinor: 6000,
			refundedAmountMinor: 6000,
			operations: [
				{ kind: "captured", id: "capture-1", amountMinor: 6000, currency: "SAR" },
				{ kind: "refunded", id: "refund-1", amountMinor: 6000, currency: "SAR" },
			],
			closed: true,
			raw: { status: "CLOSED" },
		});
		const closePayment = vi.fn(async () => undefined);
		const { stored, post, journal } = await setup(
			"tabby",
			{ closePayment, fetchOrder: async () => closed },
			{
				status: "fully_refunded",
				capturedAmountMinor: 6000,
				refundedAmountMinor: 6000,
				appliedOperations: JSON.stringify(["tabby:captured:capture-1", "tabby:refunded:refund-1"]),
			},
		);
		expect((await post("close")).error).toBeNull();
		expect(closePayment).toHaveBeenCalledOnce();
		expect(stored.status).toBe("fully_refunded");
		expect(journal()).toEqual(["completed"]);
	});
	it("releases a close that sent nothing when verification fails", async () => {
		const closePayment = vi.fn(async () => undefined);
		const { post, journal } = await setup(
			"tamara",
			{
				closePayment,
				fetchOrder: async () =>
					snapshot({
						status: "fully_captured",
						capturedAmountMinor: 10000,
						operations: [
							{ kind: "captured", id: "capture-1", amountMinor: 10000, currency: "SAR" },
						],
					}),
			},
			{
				status: "fully_captured",
				capturedAmountMinor: 10000,
				appliedOperations: JSON.stringify(["tamara:captured:capture-1"]),
			},
		);
		expect((await post("close")).error?.status).toBe(409);
		expect(closePayment).not.toHaveBeenCalled();
		expect(journal()).toEqual([]);
	});
});

describe("webhook money invariants", () => {
	it("refuses an order total update below the committed balance", async () => {
		const { stored, webhook } = await setup(
			"tabby",
			{},
			{ status: "partially_captured", capturedAmountMinor: 6000 },
		);
		const result = await webhook("shrunk-total", {
			kind: "updated",
			provider: "tabby",
			orderId,
			totalAmount: sar("50.00"),
			raw: {},
		});
		expect(result.error).not.toBeNull();
		expect(stored.amountMinor).toBe(10000);
	});
	it("bases an early refund on the uncanceled balance", async () => {
		const { stored, webhook } = await setup("tamara", {}, { canceledAmountMinor: 4000 });
		const result = await webhook("early-refund", {
			kind: "refunded",
			provider: "tamara",
			orderId,
			refundId: "refund-1",
			amountMinor: 6000,
			currency: "SAR",
			raw: {},
		});
		expect(result.error).toBeNull();
		expect(stored).toMatchObject({ status: "fully_refunded", refundedAmountMinor: 6000 });
	});
	it("keeps a non-Tabby amountless cancel refused as already closed from waiting forever", async () => {
		const cancel = vi.fn(async () => {
			throw new BnplProviderError("custom", "already closed", {
				status: 400,
				body: { message: "Order already closed" },
				rejected: true,
			});
		});
		const { post, journal } = await setup("tamara", { cancel });
		await post("cancel", {});
		expect(journal()).toEqual([]);
	});
	it("ignores a zero-amount capture notification", async () => {
		const { stored, webhook } = await setup("tamara", {});
		const result = await webhook("zero-capture", {
			kind: "captured",
			provider: "tamara",
			orderId,
			captureId: "zero",
			amountMinor: 0,
			currency: "SAR",
			raw: { data: { captured_amount: sar("0.00") } },
		});
		expect(result.error).toBeNull();
		expect(stored).toMatchObject({ status: "authorised", capturedAmountMinor: 0 });
	});
});

describe("webhook processing lease", () => {
	it("rotates the lease token on renewal so a stale reclaimer cannot take a live lease", async () => {
		const { instance } = await setup("tamara", {});
		const ctx = { context: await instance.auth.$context } as GenericEndpointContext;
		const recorded = await recordWebhookEvent(ctx, {
			provider: "tamara",
			event: { kind: "approved", provider: "tamara", orderId, raw: {} },
			dedupKey: "lease-renewal",
			rawBody: "{}",
		});
		if (recorded.outcome !== "inserted") throw new Error("expected a new event");
		const owner = await claimWebhookEvent(ctx, recorded.row);
		if (!owner) throw new Error("expected the first claim to succeed");
		const staleRead = { ...owner, processingUntil: new Date(Date.now() - 1) };
		await saveWebhookDeliveryState(ctx, owner, { completed: ["0:payload"], contexts: {} });
		expect(owner.processingToken).not.toBe(staleRead.processingToken);
		expect(await claimWebhookEvent(ctx, staleRead)).toBeNull();
	});
});

describe("request validation at the boundary", () => {
	it("rejects money with more decimals than its currency before reserving a command", async () => {
		const capture = vi.fn();
		const { post, journal } = await setup("tabby", { capture });
		const result = await post("capture", {
			totalAmount: sar("10.00"),
			merchantReferenceId: "precise",
			items: [
				{
					referenceId: "item",
					name: "Item",
					sku: "item",
					quantity: 1,
					totalAmount: sar("10.005"),
				},
			],
		});
		expect(result.error?.status).toBe(400);
		expect(capture).not.toHaveBeenCalled();
		expect(journal()).toEqual([]);
	});
});

describe("Tabby snapshot deliveries", () => {
	async function setupTabbySnapshots(row: Record<string, unknown> = {}) {
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: {
					tabby: tabby({
						secretKey: "sk_test_unit",
						merchantCode: "unit",
						webhookHeader: { name: "X-Test", value: "unit" },
						fetch: async () => Response.json({}),
					}),
				},
				persistOrders: true,
				use: [webhooks()],
			}),
		]);
		const stored: Record<string, unknown> = {
			id: "snapshot-row",
			provider: "tabby",
			providerOrderId: orderId,
			orderReferenceId: "snapshot-ref",
			status: "authorised",
			amountMinor: 10000,
			currency: "SAR",
			capturedAmountMinor: 0,
			refundedAmountMinor: 0,
			canceledAmountMinor: 0,
			version: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
			...row,
		};
		instance.db.bnplOrder?.push(stored);
		const deliver = (payment: Record<string, unknown>) =>
			instance.client.$fetch("/bnpl/webhooks/tabby", {
				method: "POST",
				headers: { "X-Test": "unit" },
				body: { id: orderId, amount: "100.00", currency: "SAR", ...payment },
			});
		return { instance, stored, deliver };
	}
	const capture = (id: string, amount: string) => ({ id, amount, reference_id: id });

	it("applies every capture when a failed snapshot is retried with its records reordered", async () => {
		const { instance, stored, deliver } = await setupTabbySnapshots();
		const context = await instance.auth.$context;
		const original = context.adapter.incrementOne.bind(context.adapter);
		const write = vi.spyOn(context.adapter, "incrementOne").mockImplementation(async (args) => {
			if (
				args.model === "bnplOrder" &&
				String(args.set?.appliedOperations).includes("tabby:captured:B")
			)
				throw new Error("order write unavailable");
			return original(args);
		});
		const first = await deliver({
			status: "AUTHORIZED",
			captures: [capture("A", "30.00"), capture("B", "20.00")],
		});
		expect(first.error?.status).toBe(500);
		expect(stored.capturedAmountMinor).toBe(3000);
		write.mockRestore();
		const retry = await deliver({
			status: "AUTHORIZED",
			captures: [capture("B", "20.00"), capture("A", "30.00")],
		});
		expect(retry.error).toBeNull();
		expect(stored).toMatchObject({ capturedAmountMinor: 5000, status: "partially_captured" });
	});

	it("does not let a late closed snapshot hide a refund", async () => {
		const { stored, deliver } = await setupTabbySnapshots({
			status: "partially_refunded",
			capturedAmountMinor: 4000,
			refundedAmountMinor: 2000,
			appliedOperations: JSON.stringify(["tabby:captured:c1", "tabby:refunded:r1"]),
		});
		const result = await deliver({ status: "CLOSED", captures: [capture("c1", "40.00")] });
		expect(result.error).toBeNull();
		expect(stored.status).toBe("partially_refunded");
	});
	it("does not let an older refund snapshot reverse a completed refund", async () => {
		const { stored, deliver } = await setupTabbySnapshots({
			status: "fully_captured",
			capturedAmountMinor: 10000,
			appliedOperations: JSON.stringify(["tabby:captured:c1"]),
		});
		const captures = [capture("c1", "100.00")];
		const latest = await deliver({
			status: "CLOSED",
			captures,
			refunds: [capture("r1", "40.00"), capture("r2", "60.00")],
		});
		expect(latest.error).toBeNull();
		expect(stored.status).toBe("fully_refunded");
		const older = await deliver({ status: "CLOSED", captures, refunds: [capture("r1", "40.00")] });
		expect(older.error).toBeNull();
		expect(stored).toMatchObject({ status: "fully_refunded", refundedAmountMinor: 10000 });
	});
});

describe("round-two hunt regressions", () => {
	const tabbyConfig = {
		secretKey: "sk_test_unit",
		merchantCode: "unit",
		webhookHeader: { name: "X-Test", value: "unit" },
	};
	it("marks a Tabby cancel that failed before closing as a definitive rejection", async () => {
		const methods: string[] = [];
		const provider = tabby({
			...tabbyConfig,
			fetch: async (_url, init) => {
				methods.push(String(init?.method));
				return Response.json({ error: "unavailable" }, { status: 503 });
			},
		});
		const error = await provider
			.cancel(orderId, { totalAmount: sar("100.00") }, { logger: console })
			.catch((e: unknown) => e);
		expect(isDefinitiveRejection(error)).toBe(true);
		expect(methods.every((method) => method === "GET")).toBe(true);
	});
	it("refuses a Tabby cancel that does not cover the locally known uncaptured balance", async () => {
		const cancel = vi.fn(async () => undefined);
		const { post, journal } = await setup("tabby", { cancel });
		const result = await post("cancel", {
			totalAmount: sar("60.00"),
			merchantReferenceId: "stale",
		});
		expect(result.error?.status).toBe(400);
		expect(cancel).not.toHaveBeenCalled();
		expect(journal()).toEqual([]);
	});
	it("completes a pending Tabby cancel once the payment is verified closed, even after a new capture", async () => {
		let attempt = 0;
		const cancel = vi.fn(async () => {
			attempt++;
			if (attempt === 1) throw new BnplProviderError("tabby", "timed out");
		});
		const closed = snapshot({
			status: "closed",
			capturedAmountMinor: 4000,
			operations: [{ kind: "captured", id: "capture-1", amountMinor: 4000, currency: "SAR" }],
			raw: { status: "CLOSED" },
		});
		const { stored, post, journal } = await setup("tabby", {
			cancel,
			fetchOrder: async () => closed,
		});
		const body = { totalAmount: sar("100.00"), merchantReferenceId: "close-all" };
		expect((await post("cancel", body)).error).not.toBeNull();
		expect(journal()).toEqual(["pending"]);
		expect((await post("cancel", body)).error).toBeNull();
		expect(cancel).toHaveBeenCalledOnce();
		expect(stored).toMatchObject({ status: "closed", capturedAmountMinor: 4000 });
		expect(journal()).toEqual(["completed"]);
	});
	it("keeps an ignored zero-amount notification out of the operation ledger", async () => {
		const { stored, webhook } = await setup("tamara", {});
		await webhook("zero-ledger", {
			kind: "captured",
			provider: "tamara",
			orderId,
			captureId: "zero",
			amountMinor: 0,
			currency: "SAR",
			raw: { data: { captured_amount: sar("0.00") } },
		});
		expect(String(stored.appliedOperations)).not.toContain("zero");
	});
	it("recovers a pending authorise when the order was partially captured and the rest canceled", async () => {
		const authorize = vi.fn(async () => {
			throw new BnplProviderError("tamara", "timed out");
		});
		const fetchOrder = async () =>
			snapshot({
				status: "canceled",
				capturedAmountMinor: 4000,
				canceledAmountMinor: 6000,
				operations: [
					{ kind: "captured", id: "capture-1", amountMinor: 4000, currency: "SAR" },
					{ kind: "canceled", id: "cancel-1", amountMinor: 6000, currency: "SAR" },
				],
			});
		const { stored, post, journal } = await setup(
			"tamara",
			{ authorize, fetchOrder },
			{ status: "approved" },
		);
		expect((await post("authorise")).error).not.toBeNull();
		expect((await post("authorise")).error).toBeNull();
		expect(stored).toMatchObject({ status: "fully_captured", capturedAmountMinor: 4000 });
		expect(journal()).toEqual(["completed"]);
	});
	it("keeps the 0.3.2 dedup key for Tamara status notifications", () => {
		const base = { order_id: "o-1", order_reference_id: "r-1" };
		expect(tamaraDedupKey({ ...base, order_status: "declined" })).toBe("tamara:authorise:o-1");
		expect(tamaraDedupKey({ ...base, order_status: "approved" })).toBe("tamara:authorise:o-1");
	});
});

describe("webhook redelivery checkpoint", () => {
	it("still runs handlers when a redelivery fails before its first handler and is retried", async () => {
		const onPayload = vi.fn();
		const provider = stubProvider("tamara", {
			verifyWebhook: async (request) => ({
				ok: true,
				payload: JSON.parse(request.rawBody),
				rawBody: request.rawBody,
				dedupKey: "redelivery-delivery",
			}),
			toCanonicalEvent: () => ({ kind: "updated", provider: "tamara", orderId, raw: {} }),
		});
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tamara: provider },
				persistOrders: true,
				use: [webhooks({ onPayload, redelivery: { isAuthorized: () => true } })],
			}),
		]);
		instance.db.bnplOrder?.push({
			id: "redelivery-row",
			provider: "tamara",
			providerOrderId: orderId,
			orderReferenceId: "redelivery-ref",
			status: "authorised",
			amountMinor: 10000,
			currency: "SAR",
			capturedAmountMinor: 0,
			refundedAmountMinor: 0,
			version: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const { headers } = await instance.signInWithTestUser();
		expect(
			(await instance.client.$fetch("/bnpl/webhooks/tamara", { method: "POST", body: {} })).error,
		).toBeNull();
		const eventId = String(instance.db.bnplWebhookEvent?.[0]?.id);
		const redeliver = () =>
			instance.client.$fetch(`/bnpl/admin/webhook-events/${eventId}/redeliver`, {
				method: "POST",
				headers,
			});
		const context = await instance.auth.$context;
		const original = context.adapter.findOne.bind(context.adapter);
		let failNextOrderRead = true;
		const read = vi.spyOn(context.adapter, "findOne").mockImplementation(async (args) => {
			if (args.model === "bnplOrder" && failNextOrderRead) {
				failNextOrderRead = false;
				throw new Error("order store unavailable");
			}
			return original(args);
		});
		expect((await redeliver()).error).not.toBeNull();
		read.mockRestore();
		expect((await redeliver()).error).toBeNull();
		expect(onPayload).toHaveBeenCalledTimes(2);
	});
});

describe("round-two review regressions", () => {
	it("does not treat an event of a different kind under the same dedup key as a duplicate", async () => {
		const { instance } = await setup("tamara", {});
		const ctx = { context: await instance.auth.$context } as GenericEndpointContext;
		const declined = await recordWebhookEvent(ctx, {
			provider: "tamara",
			event: { kind: "declined", provider: "tamara", orderId, raw: {} },
			dedupKey: "tamara:authorise:legacy-order",
			rawBody: "{}",
		});
		if (declined.outcome !== "inserted") throw new Error("expected a new event");
		const claimed = await claimWebhookEvent(ctx, declined.row);
		if (!claimed) throw new Error("expected a claim");
		await markWebhookEventProcessed(ctx, claimed);
		const approved = await recordWebhookEvent(ctx, {
			provider: "tamara",
			event: { kind: "approved", provider: "tamara", orderId, raw: {} },
			dedupKey: "tamara:authorise:legacy-order",
			rawBody: "{}",
		});
		expect(approved.outcome).toBe("inserted");
	});

	it("processes a retried single-event delivery from its stored payload", async () => {
		const { instance, stored, webhook } = await setup("tamara", {
			verifyWebhook: async (request) => ({
				ok: true,
				payload: JSON.parse(request.rawBody),
				rawBody: request.rawBody,
				dedupKey: "stable-capture-delivery",
			}),
		});
		const context = await instance.auth.$context;
		const original = context.adapter.incrementOne.bind(context.adapter);
		let failOrderWrite = true;
		vi.spyOn(context.adapter, "incrementOne").mockImplementation(async (args) => {
			if (args.model === "bnplOrder" && failOrderWrite) {
				failOrderWrite = false;
				throw new Error("order write unavailable");
			}
			return original(args);
		});
		const captured = (amountMinor: number): BnplWebhookEvent => ({
			kind: "captured",
			provider: "tamara",
			orderId,
			captureId: "same-capture",
			amountMinor,
			currency: "SAR",
			raw: {},
		});
		expect((await webhook("first", captured(1000))).error).not.toBeNull();
		expect((await webhook("retry", captured(2000))).error).toBeNull();
		expect(stored.capturedAmountMinor).toBe(1000);
	});

	it("clears handler checkpoints in the same write that claims a processed event for redelivery", async () => {
		const { instance } = await setup("tamara", {});
		const ctx = { context: await instance.auth.$context } as GenericEndpointContext;
		const recorded = await recordWebhookEvent(ctx, {
			provider: "tamara",
			event: { kind: "approved", provider: "tamara", orderId, raw: {} },
			dedupKey: "redelivery-claim",
			rawBody: "{}",
		});
		if (recorded.outcome !== "inserted") throw new Error("expected a new event");
		const first = await claimWebhookEvent(ctx, recorded.row);
		if (!first) throw new Error("expected a claim");
		await saveWebhookDeliveryState(ctx, first, { completed: ["0:payload"], contexts: {} });
		await markWebhookEventProcessed(ctx, first);
		const processed = instance.db.bnplWebhookEvent?.find((row) => row.id === recorded.row.id);
		const reclaimed = await claimWebhookEvent(
			ctx,
			processed as unknown as Parameters<typeof claimWebhookEvent>[1],
			{ resetHandlers: true },
		);
		expect(JSON.parse(String(reclaimed?.deliveryState)).completed).toEqual([]);
	});
});

describe("round-two review test gaps", () => {
	it("recovers webhook authorisation from balance-derived status", async () => {
		const authorize = vi.fn(async () => {
			throw new BnplProviderError("tamara", "timed out");
		});
		const fetchOrder = async () =>
			snapshot({
				status: "canceled",
				capturedAmountMinor: 4000,
				canceledAmountMinor: 6000,
				operations: [
					{ kind: "captured", id: "capture-1", amountMinor: 4000, currency: "SAR" },
					{ kind: "canceled", id: "cancel-1", amountMinor: 6000, currency: "SAR" },
				],
			});
		const { stored, webhook, journal } = await setup(
			"tamara",
			{ authorize, fetchOrder },
			{ status: "approved" },
		);
		const approved: BnplWebhookEvent = { kind: "approved", provider: "tamara", orderId, raw: {} };
		expect((await webhook("approved", approved)).error).not.toBeNull();
		expect((await webhook("approved", approved)).error).toBeNull();
		expect(stored).toMatchObject({ status: "fully_captured", capturedAmountMinor: 4000 });
		expect(journal()).toEqual(["completed"]);
	});
	it("maps an authorise recovery failure to AUTHORISE_FAILED", async () => {
		const authorize = vi.fn(async () => {
			throw new BnplProviderError("tamara", "timed out");
		});
		const fetchOrder = vi.fn(async (): Promise<BnplOrderState> => {
			throw new BnplProviderError("tamara", "order read failed");
		});
		const { post } = await setup("tamara", { authorize, fetchOrder }, { status: "approved" });
		await post("authorise");
		const retry = await post("authorise");
		expect(retry.error?.status).toBe(502);
		expect((retry.error as { code?: string } | null)?.code).toBe("AUTHORISE_FAILED");
	});
});
