import type { GenericEndpointContext } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { BnplProviderError, isDefinitiveRejection } from "../core/errors";
import type { BnplProvider } from "../core/provider";
import type { BnplOrderState, BnplWebhookEvent } from "../core/types";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import {
	claimWebhookEvent,
	recordWebhookEvent,
	saveWebhookDeliveryState,
} from "../plugins/webhook-events";
import { webhooks } from "../plugins/webhooks";
import { tabby } from "../providers/tabby";
import { tabbyToCanonicalEvents } from "../providers/tabby/adapter";
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
