import { describe, expect, it, vi } from "vitest";
import { BnplProviderError } from "../core/errors";
import type { BnplCaptureArgs, BnplWebhookEvent } from "../core/types";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { checkout } from "../plugins/checkout";
import { orders } from "../plugins/orders";
import { type WebhooksSubpluginOptions, webhooks } from "../plugins/webhooks";
import { type BnplTestInstance, makeBnplTestInstance, stubProvider } from "./_harness";
const checkoutBody = {
	provider: "tabby",
	orderReferenceId: "ref-lc",
	description: "Lifecycle checkout",
	totalAmount: { amount: "100.00", currency: "SAR" },
	items: [
		{
			referenceId: "sku-1",
			name: "Item",
			sku: "SKU1",
			quantity: 1,
			totalAmount: { amount: "100.00", currency: "SAR" },
		},
	],
	shippingAddress: { line1: "King Fahd Rd", city: "Riyadh", countryCode: "SA" },
	countryCode: "SA",
};
const ORDER_ID = "ord-lc";
interface DrivePayload {
	dedupKey: string;
	event: BnplWebhookEvent;
	[key: string]: unknown;
}
function makeDrivableProvider(overrides: Parameters<typeof stubProvider<"tabby">>[1] = {}) {
	return stubProvider("tabby", {
		async createCheckout() {
			return {
				providerOrderId: ORDER_ID,
				providerCheckoutId: "chk-lc",
				checkoutUrl: "https://checkout.example.test/chk-lc",
				status: "new",
				raw: { created: true },
			};
		},
		async verifyWebhook(req) {
			const payload = JSON.parse(req.rawBody) as DrivePayload;
			return { ok: true, payload, dedupKey: payload.dedupKey, rawBody: req.rawBody };
		},
		toCanonicalEvent(payload) {
			const driven = payload as unknown as DrivePayload;
			return driven.event ?? null;
		},
		webhookDedupKey(event) {
			if (event.kind === "captured") return `tabby:captured:${event.captureId}`;
			if (event.kind === "refunded") return `tabby:refunded:${event.refundId}`;
			return `tabby:${event.kind}`;
		},
		...overrides,
	});
}
async function makeInstance(
	provider = makeDrivableProvider(),
	webhookOptions: WebhooksSubpluginOptions = {},
): Promise<BnplTestInstance> {
	return makeBnplTestInstance([
		bnpl({
			providers: { tabby: provider },
			persistOrders: true,
			mapUserToBuyer: ({ user }) => ({
				firstName: "Test",
				lastName: "User",
				email: user.email,
				phone: "+966500000000",
			}),
			use: [checkout(), orders(), webhooks(webhookOptions), admin({ isAuthorized: () => true })],
		}),
	]);
}
async function seedCheckout(instance: BnplTestInstance): Promise<{
	headers: Headers;
}> {
	const { headers } = await instance.signInWithTestUser();
	const res = await instance.client.$fetch("/bnpl/checkout", {
		method: "POST",
		headers,
		body: checkoutBody,
	});
	expect(res.error).toBeNull();
	return { headers };
}
function orderRow(instance: BnplTestInstance): Record<string, unknown> {
	const row = instance.db.bnplOrder?.[0];
	expect(row).toBeDefined();
	return row as Record<string, unknown>;
}
function capturedEvent(captureId: string, amountMinor: number): BnplWebhookEvent {
	return {
		kind: "captured",
		provider: "tabby",
		orderId: ORDER_ID,
		captureId,
		amountMinor,
		currency: "SAR",
		raw: { id: ORDER_ID },
	};
}
function post(instance: BnplTestInstance, payload: DrivePayload) {
	return instance.client.$fetch("/bnpl/webhooks/tabby", { method: "POST", body: payload });
}
describe("webhook lifecycle", () => {
	it("keeps a webhook pending until its order has been persisted", async () => {
		const instance = await makeInstance();
		const payload = { dedupKey: "tabby:captured:early", event: capturedEvent("early", 4000) };
		expect((await post(instance, payload)).error?.status).toBe(500);
		await seedCheckout(instance);
		expect((await post(instance, payload)).error).toBeNull();
		expect(orderRow(instance).capturedAmountMinor).toBe(4000);
	});
	it("retries the original status callback after it throws", async () => {
		let failed = true;
		const onStatusChange = vi.fn((_context: unknown) => {
			if (failed) throw new Error("status callback unavailable");
		});
		const instance = await makeInstance(makeDrivableProvider(), { onStatusChange });
		await seedCheckout(instance);
		const payload = {
			dedupKey: "tabby:captured:transition",
			event: capturedEvent("transition", 4000),
		};
		expect((await post(instance, payload)).error?.status).toBe(500);
		failed = false;
		expect((await post(instance, payload)).error).toBeNull();
		expect(onStatusChange).toHaveBeenCalledTimes(2);
		expect(onStatusChange.mock.calls[1]?.[0]).toMatchObject({
			from: "new",
			to: "partially_captured",
		});
	});
	it("does not dispatch a second copy while the first delivery owns the event", async () => {
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		const onCaptured = vi.fn(async () => {
			if (onCaptured.mock.calls.length === 1) {
				enter();
				await paused;
			}
		});
		const instance = await makeInstance(makeDrivableProvider(), { onCaptured });
		await seedCheckout(instance);
		const payload = { dedupKey: "tabby:captured:active", event: capturedEvent("active", 4000) };
		const first = post(instance, payload);
		await entered;
		const second = await post(instance, payload);
		release();
		expect((await first).error).toBeNull();
		expect(second.error?.status).toBe(503);
		expect(onCaptured).toHaveBeenCalledOnce();
		expect(orderRow(instance).capturedAmountMinor).toBe(4000);
	});
	it("does not repeat a capture delta after the event checkpoint write fails", async () => {
		const instance = await makeInstance();
		await seedCheckout(instance);
		const adapter = (await instance.auth.$context).adapter;
		const original = adapter.incrementOne.bind(adapter);
		let inject = true;
		vi.spyOn(adapter, "incrementOne").mockImplementation(async (args) => {
			if (inject && args.model === "bnplWebhookEvent" && args.set?.orderApplied === true) {
				inject = false;
				throw new Error("checkpoint connection dropped");
			}
			return original(args);
		});
		const payload = {
			dedupKey: "tabby:captured:checkpoint",
			event: capturedEvent("checkpoint", 4000),
		};
		expect((await post(instance, payload)).error?.status).toBe(500);
		expect((await post(instance, payload)).error).toBeNull();
		expect(orderRow(instance).capturedAmountMinor).toBe(4000);
	});

	it("retries capture after an approved event authorised successfully", async () => {
		let failCapture = true;
		const authorize = vi.fn(async () => ({
			providerOrderId: ORDER_ID,
			status: "authorised" as const,
			raw: {},
		}));
		const capture = vi.fn(async () => {
			if (failCapture) throw new BnplProviderError("tabby", "capture unavailable", { status: 400 });
			return {
				captureId: "approved-retry",
				providerOrderId: ORDER_ID,
				amountMinor: 10000,
				raw: {},
			};
		});
		const base = makeDrivableProvider();
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: {
					tabby: makeDrivableProvider({
						capabilities: { ...base.capabilities, separateAuthorise: true },
						authorize,
						capture,
					}),
				},
				persistOrders: true,
				captureOnAuthorise: true,
				captureOnAuthoriseShippingInfo: () => ({
					shippedAt: "2026-06-04T16:00:00.000Z",
					shippingCompany: "Delivery",
				}),
				mapUserToBuyer: ({ user }) => ({
					firstName: "T",
					lastName: "U",
					email: user.email,
					phone: "+966500000000",
				}),
				use: [checkout(), webhooks()],
			}),
		]);
		await seedCheckout(instance);
		const payload: DrivePayload = {
			dedupKey: "approved-capture-retry",
			event: { kind: "approved", provider: "tabby", orderId: ORDER_ID, raw: {} },
		};
		expect((await post(instance, payload)).error?.status).toBe(500);
		failCapture = false;
		expect((await post(instance, payload)).error).toBeNull();
		expect(authorize).toHaveBeenCalledOnce();
		expect(capture).toHaveBeenCalledTimes(2);
		expect(orderRow(instance).capturedAmountMinor).toBe(10000);
	});
	it("automatically captures only the remaining Tabby balance without shipping information", async () => {
		const capture = vi.fn(async (_id: string, args: BnplCaptureArgs) => ({
			captureId: "remaining",
			providerOrderId: ORDER_ID,
			amountMinor: 7000,
			raw: { amount: args.totalAmount.amount },
		}));
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tabby: makeDrivableProvider({ capture }) },
				persistOrders: true,
				captureOnAuthorise: true,
				mapUserToBuyer: ({ user }) => ({
					firstName: "T",
					lastName: "U",
					email: user.email,
					phone: "+966500000000",
				}),
				use: [checkout(), webhooks()],
			}),
		]);
		await seedCheckout(instance);
		await post(instance, {
			dedupKey: "partial-before-auto",
			event: capturedEvent("partial", 3000),
		});
		expect(
			(
				await post(instance, {
					dedupKey: "late-auth-auto",
					event: { kind: "authorized", provider: "tabby", orderId: ORDER_ID, raw: {} },
				})
			).error,
		).toBeNull();
		expect(capture).toHaveBeenCalledOnce();
		expect(capture.mock.calls[0]?.[1].totalAmount).toEqual({ amount: "70.00", currency: "SAR" });
		expect(orderRow(instance).capturedAmountMinor).toBe(10000);
	});
	it("applies every operation in successive provider snapshots exactly once", async () => {
		const onCaptured = vi.fn();
		const onRefunded = vi.fn();
		const provider = makeDrivableProvider({
			toCanonicalEvents(payload) {
				return payload.events as BnplWebhookEvent[];
			},
			toCanonicalEvent(payload) {
				return (payload.events as BnplWebhookEvent[])[0] ?? null;
			},
		});
		const instance = await makeInstance(provider, { onCaptured, onRefunded });
		await seedCheckout(instance);
		const firstCapture = capturedEvent("snapshot-1", 3000);
		const secondCapture = capturedEvent("snapshot-2", 7000);
		await instance.client.$fetch("/bnpl/webhooks/tabby", {
			method: "POST",
			body: { dedupKey: "snapshot-a", events: [firstCapture] },
		});
		await instance.client.$fetch("/bnpl/webhooks/tabby", {
			method: "POST",
			body: {
				dedupKey: "snapshot-b",
				events: [
					firstCapture,
					secondCapture,
					{
						kind: "refunded",
						provider: "tabby",
						orderId: ORDER_ID,
						refundId: "snapshot-refund",
						amountMinor: 4000,
						currency: "SAR",
						raw: {},
					},
				],
			},
		});
		expect(orderRow(instance)).toMatchObject({
			capturedAmountMinor: 10000,
			refundedAmountMinor: 4000,
			status: "partially_refunded",
		});
		expect(onCaptured).toHaveBeenCalledTimes(2);
		expect(onRefunded).toHaveBeenCalledOnce();
	});

	it("does not repeat a completed callback when the next callback fails", async () => {
		let unavailable = true;
		const onPayload = vi.fn();
		const onCaptured = vi.fn((_context: { deliveryId?: string }) => {
			if (unavailable) throw new Error("fulfilment unavailable");
		});
		const instance = await makeInstance(makeDrivableProvider(), { onPayload, onCaptured });
		await seedCheckout(instance);
		const payload = {
			dedupKey: "callback-checkpoint",
			event: capturedEvent("callback-checkpoint", 4000),
		};
		expect((await post(instance, payload)).error?.status).toBe(500);
		unavailable = false;
		expect((await post(instance, payload)).error).toBeNull();
		expect(onPayload).toHaveBeenCalledOnce();
		expect(onCaptured).toHaveBeenCalledTimes(2);
		expect(typeof onCaptured.mock.calls[0]?.[0]?.deliveryId).toBe("string");
		expect(onCaptured.mock.calls[0]?.[0]?.deliveryId).toBe(
			onCaptured.mock.calls[1]?.[0]?.deliveryId,
		);
	});
	it("recovers an expired processing lease without replaying its applied money", async () => {
		let unavailable = true;
		const onCaptured = vi.fn(() => {
			if (unavailable) throw new Error("worker stopped");
		});
		const instance = await makeInstance(makeDrivableProvider(), { onCaptured });
		await seedCheckout(instance);
		const payload = { dedupKey: "expired-claim", event: capturedEvent("expired-claim", 4000) };
		expect((await post(instance, payload)).error?.status).toBe(500);
		Object.assign(instance.db.bnplWebhookEvent?.[0] ?? {}, {
			status: "processing",
			processingToken: "old-worker",
			processingUntil: new Date(0),
		});
		unavailable = false;
		expect((await post(instance, payload)).error).toBeNull();
		expect(orderRow(instance).capturedAmountMinor).toBe(4000);
		expect(instance.db.bnplWebhookEvent?.[0]?.status).toBe("processed");
	});

	it("derives the same refunded balances when refund arrives before capture", async () => {
		const instance = await makeInstance();
		await seedCheckout(instance);
		await post(instance, {
			dedupKey: "refund-first",
			event: {
				kind: "refunded",
				provider: "tabby",
				orderId: ORDER_ID,
				refundId: "refund-first",
				amountMinor: 4000,
				currency: "SAR",
				raw: {},
			},
		});
		await post(instance, {
			dedupKey: "capture-second",
			event: capturedEvent("capture-second", 10000),
		});
		expect(orderRow(instance)).toMatchObject({
			capturedAmountMinor: 10000,
			refundedAmountMinor: 4000,
			status: "partially_refunded",
		});
	});
	it("updates a fully refunded partial capture when a delayed additional capture arrives", async () => {
		const instance = await makeInstance();
		await seedCheckout(instance);
		await post(instance, {
			dedupKey: "partial-capture",
			event: capturedEvent("partial-capture", 3000),
		});
		await post(instance, {
			dedupKey: "partial-refund",
			event: {
				kind: "refunded",
				provider: "tabby",
				orderId: ORDER_ID,
				refundId: "partial-refund",
				amountMinor: 3000,
				currency: "SAR",
				raw: {},
			},
		});
		expect(orderRow(instance).status).toBe("fully_refunded");
		await post(instance, {
			dedupKey: "delayed-capture",
			event: capturedEvent("delayed-capture", 7000),
		});
		expect(orderRow(instance)).toMatchObject({
			capturedAmountMinor: 10000,
			refundedAmountMinor: 3000,
			status: "partially_refunded",
		});
	});

	it("deduplicates an auto-authorise capture even when its synthetic event insert fails", async () => {
		const base = makeDrivableProvider();
		const provider = makeDrivableProvider({
			capabilities: { ...base.capabilities, separateAuthorise: true },
			authorize: async () => ({
				providerOrderId: ORDER_ID,
				status: "fully_captured",
				autoCaptured: true,
				captureId: "authorise-capture",
				capturedAmountMinor: 10000,
				raw: {},
			}),
			webhookDedupKey(event) {
				return event.kind === "captured"
					? `tabby:order_captured:${event.captureId}`
					: `tabby:${event.kind}`;
			},
		});
		const onCaptured = vi.fn();
		const instance = await makeInstance(provider, { onCaptured });
		await seedCheckout(instance);
		const adapter = (await instance.auth.$context).adapter;
		const original = adapter.create.bind(adapter);
		vi.spyOn(adapter, "create").mockImplementation(async (args) => {
			if (args.model === "bnplWebhookEvent" && args.data.status === "processed")
				throw new Error("synthetic insert unavailable");
			return original(args);
		});
		expect(
			(
				await post(instance, {
					dedupKey: "auto-approved",
					event: { kind: "approved", provider: "tabby", orderId: ORDER_ID, raw: {} },
				})
			).error,
		).toBeNull();
		expect(
			(
				await post(instance, {
					dedupKey: "tabby:order_captured:authorise-capture",
					event: capturedEvent("authorise-capture", 10000),
				})
			).error,
		).toBeNull();
		expect(orderRow(instance).capturedAmountMinor).toBe(10000);
		expect(onCaptured).not.toHaveBeenCalled();
	});

	it("keeps fully_captured when a late authorized event arrives out of order", async () => {
		const instance = await makeInstance();
		await seedCheckout(instance);
		await post(instance, {
			dedupKey: "tabby:captured:cap-1",
			event: capturedEvent("cap-1", 10000),
		});
		expect(orderRow(instance).status).toBe("fully_captured");
		expect(orderRow(instance).capturedAmountMinor).toBe(10000);
		const late = await post(instance, {
			dedupKey: "tabby:authorized:1",
			event: { kind: "authorized", provider: "tabby", orderId: ORDER_ID, raw: { id: ORDER_ID } },
		});
		expect(late.error).toBeNull();
		expect(orderRow(instance).status).toBe("fully_captured");
		expect(orderRow(instance).capturedAmountMinor).toBe(10000);
	});
	it("re-processes after a handler throw and counts the amount exactly once", async () => {
		let shouldThrow = true;
		const onCaptured = vi.fn(() => {
			if (shouldThrow) throw new Error("handler boom");
		});
		const instance = await makeInstance(makeDrivableProvider(), { onCaptured });
		await seedCheckout(instance);
		const payload: DrivePayload = {
			dedupKey: "tabby:captured:cap-retry",
			event: capturedEvent("cap-retry", 5000),
		};
		const first = await post(instance, payload);
		expect(first.error).not.toBeNull();
		expect(first.error?.status).toBe(500);
		expect(instance.db.bnplWebhookEvent?.[0]?.status).toBe("failed");
		expect(instance.db.bnplWebhookEvent?.[0]?.attempts).toBe(1);
		expect(orderRow(instance).capturedAmountMinor).toBe(5000);
		shouldThrow = false;
		const second = await post(instance, payload);
		expect(second.error).toBeNull();
		expect(second.data).toMatchObject({ received: true, kind: "captured" });
		expect(onCaptured).toHaveBeenCalledTimes(2);
		expect(instance.db.bnplWebhookEvent?.[0]?.status).toBe("processed");
		expect(instance.db.bnplWebhookEvent?.[0]?.attempts).toBe(2);
		expect(orderRow(instance).capturedAmountMinor).toBe(5000);
	});
	it("retries an authorized webhook after auto-capture fails", async () => {
		let shouldThrow = true;
		const references: Array<string | undefined> = [];
		const capture = vi.fn(async (_orderId: string, args: BnplCaptureArgs) => {
			references.push(args.merchantReferenceId);
			if (shouldThrow) throw new BnplProviderError("tabby", "capture boom", { status: 400 });
			return {
				captureId: "cap-auto-retry",
				providerOrderId: ORDER_ID,
				amountMinor: 10000,
				raw: { capture_id: "cap-auto-retry" },
			};
		});
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tabby: makeDrivableProvider({ capture }) },
				persistOrders: true,
				captureOnAuthorise: true,
				captureOnAuthoriseShippingInfo: () => ({
					shippedAt: "2026-06-04T16:00:00.000Z",
					shippingCompany: "Digital delivery",
				}),
				mapUserToBuyer: ({ user }) => ({
					firstName: "Test",
					lastName: "User",
					email: user.email,
					phone: "+966500000000",
				}),
				use: [checkout(), orders(), webhooks()],
			}),
		]);
		await seedCheckout(instance);
		const payload: DrivePayload = {
			dedupKey: "tabby:authorized:auto-capture-retry",
			event: { kind: "authorized", provider: "tabby", orderId: ORDER_ID, raw: { id: ORDER_ID } },
		};
		const first = await post(instance, payload);
		expect(first.error?.status).toBe(500);
		expect(capture).toHaveBeenCalledOnce();
		expect(instance.db.bnplWebhookEvent?.[0]?.status).toBe("failed");
		expect(instance.db.bnplWebhookEvent?.[0]?.attempts).toBe(1);
		expect(orderRow(instance).status).toBe("authorised");
		expect(orderRow(instance).capturedAmountMinor).toBe(0);
		shouldThrow = false;
		const second = await post(instance, payload);
		expect(second.error).toBeNull();
		expect(second.data).toMatchObject({ received: true, kind: "authorized" });
		expect(capture).toHaveBeenCalledTimes(2);
		expect(instance.db.bnplWebhookEvent?.[0]?.status).toBe("processed");
		expect(instance.db.bnplWebhookEvent?.[0]?.attempts).toBe(2);
		expect(orderRow(instance).status).toBe("fully_captured");
		expect(orderRow(instance).capturedAmountMinor).toBe(10000);
		expect(references).toEqual([
			`bnpl:tabby:${ORDER_ID}:capture:10000`,
			`bnpl:tabby:${ORDER_ID}:capture:10000`,
		]);
		const afterSuccess = await post(instance, {
			...payload,
			dedupKey: "tabby:authorized:auto-capture-after-success",
		});
		expect(afterSuccess.error).toBeNull();
		expect(capture).toHaveBeenCalledTimes(2);
		expect(orderRow(instance).status).toBe("fully_captured");
		expect(orderRow(instance).capturedAmountMinor).toBe(10000);
	});
	it("acknowledges a duplicate after success without re-running handlers or double-counting", async () => {
		const onCaptured = vi.fn();
		const instance = await makeInstance(makeDrivableProvider(), { onCaptured });
		await seedCheckout(instance);
		const payload: DrivePayload = {
			dedupKey: "tabby:captured:cap-dup",
			event: capturedEvent("cap-dup", 4000),
		};
		const first = await post(instance, payload);
		const dup = await post(instance, payload);
		expect(first.data).toMatchObject({ received: true, kind: "captured" });
		expect(dup.data).toMatchObject({ received: true, kind: "captured", duplicate: true });
		expect(onCaptured).toHaveBeenCalledOnce();
		expect(orderRow(instance).capturedAmountMinor).toBe(4000);
	});
	it("skips a capture delta whose currency mismatches the order currency", async () => {
		const instance = await makeInstance();
		await seedCheckout(instance);
		const mismatched: BnplWebhookEvent = {
			kind: "captured",
			provider: "tabby",
			orderId: ORDER_ID,
			captureId: "cap-kwd",
			amountMinor: 0,
			currency: "KWD",
			raw: { id: ORDER_ID, data: { captured_amount: { amount: "5.000", currency: "KWD" } } },
		};
		const res = await post(instance, { dedupKey: "tabby:captured:cap-kwd", event: mismatched });
		expect(res.error).toBeNull();
		expect(orderRow(instance).capturedAmountMinor).toBe(0);
		expect(orderRow(instance).status).toBe("new");
	});
	it("skips a primary-path capture delta whose event currency mismatches the order currency", async () => {
		const instance = await makeInstance();
		await seedCheckout(instance);
		const mismatched: BnplWebhookEvent = {
			kind: "captured",
			provider: "tabby",
			orderId: ORDER_ID,
			captureId: "cap-kwd-primary",
			amountMinor: 5000,
			currency: "KWD",
			raw: { id: ORDER_ID },
		};
		const res = await post(instance, {
			dedupKey: "tabby:captured:cap-kwd-primary",
			event: mismatched,
		});
		expect(res.error).toBeNull();
		expect(orderRow(instance).capturedAmountMinor).toBe(0);
		expect(orderRow(instance).status).toBe("new");
	});
	it("does not clobber status on an `updated` event but still persists rawData", async () => {
		const onUpdated = vi.fn();
		const instance = await makeInstance(makeDrivableProvider(), { onUpdated });
		await seedCheckout(instance);
		await post(instance, {
			dedupKey: "tabby:captured:cap-u",
			event: capturedEvent("cap-u", 10000),
		});
		expect(orderRow(instance).status).toBe("fully_captured");
		const updated = await post(instance, {
			dedupKey: "tabby:updated:1",
			marker: "updated-body",
			event: { kind: "updated", provider: "tabby", orderId: ORDER_ID, raw: { id: ORDER_ID } },
		});
		expect(updated.error).toBeNull();
		expect(onUpdated).toHaveBeenCalledOnce();
		expect(orderRow(instance).status).toBe("fully_captured");
		expect(orderRow(instance).rawData).toContain("updated-body");
	});
	it("keeps auto-authorise idempotent when an approved event is re-processed", async () => {
		const authorize = vi.fn(async () => ({
			providerOrderId: ORDER_ID,
			status: "authorised" as const,
			raw: { order_id: ORDER_ID, status: "authorised" },
		}));
		let throwInHandler = true;
		const onApproved = vi.fn(() => {
			if (throwInHandler) throw new Error("approved handler boom");
		});
		const provider = makeDrivableProvider({
			capabilities: {
				preCheck: true,
				separateAuthorise: true,
				voidCheckout: true,
				closePayment: false,
				partialCapture: true,
				partialRefund: true,
				multipleCaptures: true,
				disputes: false,
			},
			authorize,
		});
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tabby: provider },
				persistOrders: true,
				autoAuthorise: true,
				mapUserToBuyer: ({ user }) => ({
					firstName: "T",
					lastName: "U",
					email: user.email,
					phone: "+966500000000",
				}),
				use: [checkout(), orders(), webhooks({ onApproved })],
			}),
		]);
		await seedCheckout(instance);
		const payload: DrivePayload = {
			dedupKey: "tabby:approved:1",
			event: { kind: "approved", provider: "tabby", orderId: ORDER_ID, raw: { id: ORDER_ID } },
		};
		const first = await post(instance, payload);
		expect(first.error?.status).toBe(500);
		expect(authorize).toHaveBeenCalledOnce();
		expect(orderRow(instance).status).toBe("authorised");
		throwInHandler = false;
		const second = await post(instance, payload);
		expect(second.error).toBeNull();
		expect(authorize).toHaveBeenCalledOnce();
		expect(orderRow(instance).status).toBe("authorised");
	});
	it("suppresses the provider webhook echo after an admin refund pre-seeds a synthetic event", async () => {
		const onRefunded = vi.fn();
		const provider = makeDrivableProvider({
			async capture(_orderId, args) {
				return {
					captureId: "cap-seed",
					providerOrderId: ORDER_ID,
					amountMinor: 10000,
					raw: { capture_id: "cap-seed", ref: args.merchantReferenceId },
				};
			},
			async refund(_orderId, args) {
				return {
					refundId: "ref-seed",
					providerOrderId: ORDER_ID,
					amountMinor: 3000,
					raw: { refund_id: "ref-seed", ref: args.merchantRefundId },
				};
			},
		});
		const instance = await makeInstance(provider, { onRefunded });
		const { headers } = await seedCheckout(instance);
		await instance.client.$fetch(`/bnpl/admin/orders/${ORDER_ID}/capture`, {
			method: "POST",
			headers,
			body: {
				totalAmount: { amount: "100.00", currency: "SAR" },
				merchantReferenceId: "admin-capture-seed",
			},
		});
		const refundRes = await instance.client.$fetch(`/bnpl/admin/orders/${ORDER_ID}/refund`, {
			method: "POST",
			headers,
			body: {
				totalAmount: { amount: "30.00", currency: "SAR" },
				merchantRefundId: "admin-refund-echo",
			},
		});
		expect(refundRes.error).toBeNull();
		expect(orderRow(instance).refundedAmountMinor).toBe(3000);
		const echo = await post(instance, {
			dedupKey: "tabby:refunded:ref-seed",
			event: {
				kind: "refunded",
				provider: "tabby",
				orderId: ORDER_ID,
				refundId: "ref-seed",
				amountMinor: 3000,
				currency: "SAR",
				raw: { id: ORDER_ID },
			},
		});
		expect(echo.data).toMatchObject({ received: true, duplicate: true });
		expect(onRefunded).not.toHaveBeenCalled();
		expect(orderRow(instance).refundedAmountMinor).toBe(3000);
	});
});
describe("admin list + redelivery", () => {
	it("lists orders for an admin with provider/status filters", async () => {
		const instance = await makeInstance();
		const { headers } = await seedCheckout(instance);
		const all = await instance.client.$fetch<{
			orders: Array<Record<string, unknown>>;
		}>("/bnpl/admin/orders", { method: "GET", headers });
		expect(all.error).toBeNull();
		expect(all.data?.orders?.length).toBe(1);
		expect(all.data?.orders?.[0]).toMatchObject({ provider: "tabby", providerOrderId: ORDER_ID });
		const filtered = await instance.client.$fetch<{
			orders: Array<Record<string, unknown>>;
		}>("/bnpl/admin/orders?provider=tabby&status=new", { method: "GET", headers });
		expect(filtered.data?.orders?.length).toBe(1);
		const emptyFilter = await instance.client.$fetch<{
			orders: Array<Record<string, unknown>>;
		}>("/bnpl/admin/orders?status=fully_captured", { method: "GET", headers });
		expect(emptyFilter.data?.orders?.length).toBe(0);
	});
	it("rejects the admin order list for a non-admin", async () => {
		const provider = makeDrivableProvider();
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tabby: provider },
				persistOrders: true,
				mapUserToBuyer: ({ user }) => ({
					firstName: "T",
					lastName: "U",
					email: user.email,
					phone: "+966500000000",
				}),
				use: [checkout(), orders(), admin({ isAuthorized: () => false })],
			}),
		]);
		const { headers } = await instance.signInWithTestUser();
		const res = await instance.client.$fetch("/bnpl/admin/orders", { method: "GET", headers });
		expect(res.error?.status).toBe(403);
	});
	it("redelivers a failed webhook event and marks it processed", async () => {
		let shouldThrow = true;
		const onCaptured = vi.fn(() => {
			if (shouldThrow) throw new Error("boom once");
		});
		const instance = await makeInstance(makeDrivableProvider(), {
			onCaptured,
			redelivery: { isAuthorized: () => true },
		});
		const { headers } = await seedCheckout(instance);
		const first = await post(instance, {
			dedupKey: "tabby:captured:cap-redeliver",
			event: capturedEvent("cap-redeliver", 6000),
		});
		expect(first.error?.status).toBe(500);
		const eventId = instance.db.bnplWebhookEvent?.[0]?.id as string;
		expect(instance.db.bnplWebhookEvent?.[0]?.status).toBe("failed");
		shouldThrow = false;
		const redeliver = await instance.client.$fetch(
			`/bnpl/admin/webhook-events/${eventId}/redeliver`,
			{ method: "POST", headers },
		);
		expect(redeliver.error).toBeNull();
		expect(redeliver.data).toMatchObject({ redelivered: true, status: "processed" });
		expect(instance.db.bnplWebhookEvent?.[0]?.status).toBe("processed");
		expect(orderRow(instance).capturedAmountMinor).toBe(6000);
	});
	it("lists webhook events filtered by status for redelivery tooling", async () => {
		const instance = await makeInstance(makeDrivableProvider(), {
			redelivery: { isAuthorized: () => true },
		});
		const { headers } = await seedCheckout(instance);
		await post(instance, {
			dedupKey: "tabby:captured:cap-listed",
			event: capturedEvent("cap-listed", 2000),
		});
		const res = await instance.client.$fetch<{
			events: Array<Record<string, unknown>>;
		}>("/bnpl/admin/webhook-events?status=processed", { method: "GET", headers });
		expect(res.error).toBeNull();
		expect(res.data?.events?.length).toBe(1);
		expect(res.data?.events?.[0]).toMatchObject({ status: "processed", providerOrderId: ORDER_ID });
	});
	it("rejects redelivery for a non-admin", async () => {
		const instance = await makeInstance(makeDrivableProvider(), {
			redelivery: { isAuthorized: () => false },
		});
		await seedCheckout(instance);
		await post(instance, {
			dedupKey: "tabby:captured:cap-authz",
			event: capturedEvent("cap-authz", 1000),
		});
		const eventId = instance.db.bnplWebhookEvent?.[0]?.id as string;
		const { headers } = await instance.signInWithTestUser();
		const res = await instance.client.$fetch(`/bnpl/admin/webhook-events/${eventId}/redeliver`, {
			method: "POST",
			headers,
		});
		expect(res.error?.status).toBe(403);
	});
});

describe("Tamara cancellation notification snapshots", () => {
	async function setupTamara(canceled = 2500, persistOrders = true) {
		const state: import("../core/types").BnplOrderState = {
			providerOrderId: "tamara-cancel-order",
			status: canceled === 10000 ? "canceled" : "updated",
			totalAmount: { amount: "100.00", currency: "SAR" },
			capturedAmountMinor: 0,
			refundedAmountMinor: 0,
			canceledAmountMinor: canceled,
			operations: [
				{ kind: "canceled", id: "native-cancel", amountMinor: canceled, currency: "SAR" },
			],
			raw: {},
		};
		const get = vi.fn(async () => state);
		const onCanceled = vi.fn();
		const onUpdated = vi.fn();
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: {
					tamara: stubProvider("tamara", {
						fetchOrder: get,
						verifyWebhook: async (req) => ({
							ok: true,
							payload: JSON.parse(req.rawBody),
							dedupKey: "tamara:order_canceled:native-cancel",
							rawBody: req.rawBody,
						}),
						toCanonicalEvent: (raw) => ({
							kind: "canceled",
							provider: "tamara",
							orderId: "tamara-cancel-order",
							raw,
						}),
					}),
				},
				persistOrders,
				use: [webhooks({ onCanceled, onUpdated })],
			}),
		]);
		const row: Record<string, unknown> = {
			id: "tamara-cancel-row",
			provider: "tamara",
			providerOrderId: "tamara-cancel-order",
			orderReferenceId: "tamara-cancel-ref",
			status: "authorised",
			amountMinor: 10000,
			currency: "SAR",
			capturedAmountMinor: 0,
			refundedAmountMinor: 0,
			canceledAmountMinor: 0,
			version: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		instance.db.bnplOrder?.push(row);
		const notify = () =>
			instance.client.$fetch("/bnpl/webhooks/tamara", {
				method: "POST",
				body: {
					order_id: "tamara-cancel-order",
					event_type: "order_canceled",
					data: {
						cancel_id: "native-cancel",
						canceled_amount: { amount: canceled / 100, currency: "SAR" },
					},
				},
			});
		return { instance, row, state, get, notify, onCanceled, onUpdated };
	}
	it("preserves authorised remaining funds and dispatches updated for a partial cancellation", async () => {
		const { row, notify, onCanceled, onUpdated } = await setupTamara();
		expect((await notify()).error).toBeNull();
		expect(row).toMatchObject({
			status: "authorised",
			canceledAmountMinor: 2500,
			capturedAmountMinor: 0,
		});
		expect(row.canceledAt).toBeUndefined();
		expect(onCanceled).not.toHaveBeenCalled();
		expect(onUpdated).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(row.appliedOperations))).toContain("tamara:cancel:native-cancel");
	});
	it("dispatches canceled only after confirming a full cancellation", async () => {
		const { row, notify, onCanceled, onUpdated } = await setupTamara(10000);
		expect((await notify()).error).toBeNull();
		expect(row.status).toBe("canceled");
		expect(row.canceledAmountMinor).toBe(10000);
		expect(onCanceled).toHaveBeenCalledTimes(1);
		expect(onUpdated).not.toHaveBeenCalled();
	});
	it("repairs only a verified Tamara partial cancellation misclassified as terminal", async () => {
		const { row, notify } = await setupTamara();
		row.status = "canceled";
		row.canceledAt = new Date();
		expect((await notify()).error).toBeNull();
		expect(row.status).toBe("authorised");
		expect(row.canceledAt).toBeNull();
	});
	it("keeps unrelated terminal states outside the narrow cancellation repair", async () => {
		const { row, notify } = await setupTamara();
		row.status = "declined";
		expect((await notify()).error).toBeNull();
		expect(row.status).toBe("declined");
	});
	it("does not count a native cancellation already imported by the admin command twice", async () => {
		const { row, notify } = await setupTamara();
		row.canceledAmountMinor = 2500;
		row.appliedOperations = JSON.stringify(["tamara:cancel:native-cancel"]);
		expect((await notify()).error).toBeNull();
		expect(row.canceledAmountMinor).toBe(2500);
	});
	it.each(["currency", "identity", "native identity", "stale", "missing history"])(
		"rejects %s financial evidence without making the order terminal",
		async (problem) => {
			const { row, state, notify } = await setupTamara();
			if (problem === "currency") state.totalAmount.currency = "AED";
			if (problem === "identity") state.providerOrderId = "other-order";
			if (problem === "native identity")
				state.operations = [
					{ kind: "canceled", id: "unrelated-cancel", amountMinor: 2500, currency: "SAR" },
				];
			if (problem === "stale") row.canceledAmountMinor = 5000;
			if (problem === "missing history") state.operations = undefined;
			expect((await notify()).error?.status).toBe(500);
			expect(row.status).toBe("authorised");
		},
	);
	it("keeps a failed GET retryable and processes after native verification recovers", async () => {
		const { row, get, notify } = await setupTamara();
		get.mockRejectedValueOnce(new Error("network unavailable"));
		expect((await notify()).error?.status).toBe(500);
		expect(row.canceledAmountMinor).toBe(0);
		expect((await notify()).error).toBeNull();
		expect(row.status).toBe("authorised");
		expect(row.canceledAmountMinor).toBe(2500);
	});
	it("keeps a failed partial callback identical when native state later becomes fully canceled", async () => {
		const { state, get, notify, onUpdated, onCanceled } = await setupTamara();
		onUpdated.mockImplementationOnce(() => {
			throw new Error("callback unavailable");
		});
		expect((await notify()).error?.status).toBe(500);
		Object.assign(state, {
			status: "canceled",
			canceledAmountMinor: 10000,
			operations: [
				{ kind: "canceled", id: "native-cancel", amountMinor: 2500, currency: "SAR" },
				{ kind: "canceled", id: "later-cancel", amountMinor: 7500, currency: "SAR" },
			],
		});
		expect((await notify()).error).toBeNull();
		expect(onUpdated).toHaveBeenCalledTimes(2);
		expect(onCanceled).not.toHaveBeenCalled();
		expect(onUpdated.mock.calls[1]?.[0]).toEqual(onUpdated.mock.calls[0]?.[0]);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("preserves a partial callback across a checkpoint failure after the order commit", async () => {
		const { instance, row, state, get, notify, onUpdated, onCanceled } = await setupTamara();
		const context = await instance.auth.$context;
		const original = context.adapter.incrementOne.bind(context.adapter);
		let fail = true;
		const write = vi.spyOn(context.adapter, "incrementOne").mockImplementation(async (args) => {
			if (
				fail &&
				args.model === "bnplWebhookEvent" &&
				args.set?.deliveryState &&
				String(row.appliedOperations).includes("delivery:")
			) {
				fail = false;
				throw new Error("checkpoint unavailable after order commit");
			}
			return original(args);
		});
		expect((await notify()).error?.status).toBe(500);
		write.mockRestore();
		expect(row.canceledAmountMinor).toBe(2500);
		Object.assign(state, {
			status: "canceled",
			canceledAmountMinor: 10000,
			operations: [
				{ kind: "canceled", id: "native-cancel", amountMinor: 2500, currency: "SAR" },
				{ kind: "canceled", id: "later-cancel", amountMinor: 7500, currency: "SAR" },
			],
		});
		expect((await notify()).error).toBeNull();
		expect(onUpdated).toHaveBeenCalledTimes(1);
		expect(onCanceled).not.toHaveBeenCalled();
		expect(onUpdated.mock.calls[0]?.[0].event).toMatchObject({
			kind: "updated",
			status: "authorised",
		});
		expect(get).toHaveBeenCalledTimes(1);
	});
	it("replays the frozen validated financial snapshot when the order write initially fails", async () => {
		const { instance, row, state, get, notify, onUpdated, onCanceled } = await setupTamara();
		const context = await instance.auth.$context;
		const original = context.adapter.incrementOne.bind(context.adapter);
		const write = vi.spyOn(context.adapter, "incrementOne").mockImplementation(async (args) => {
			if (args.model === "bnplOrder" && args.set?.appliedOperations)
				throw new Error("order write unavailable");
			return original(args);
		});
		expect((await notify()).error?.status).toBe(500);
		write.mockRestore();
		expect(row.canceledAmountMinor).toBe(0);
		Object.assign(state, {
			status: "canceled",
			canceledAmountMinor: 10000,
			operations: [
				{ kind: "canceled", id: "native-cancel", amountMinor: 2500, currency: "SAR" },
				{ kind: "canceled", id: "later-cancel", amountMinor: 7500, currency: "SAR" },
			],
		});
		expect((await notify()).error).toBeNull();
		expect(row).toMatchObject({ canceledAmountMinor: 2500, status: "authorised" });
		expect(onUpdated).toHaveBeenCalledTimes(1);
		expect(onCanceled).not.toHaveBeenCalled();
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("rejects a frozen cancellation snapshot that becomes stale before its order write", async () => {
		const { instance, row, get, notify, onUpdated, onCanceled } = await setupTamara();
		const context = await instance.auth.$context;
		const original = context.adapter.incrementOne.bind(context.adapter);
		const write = vi.spyOn(context.adapter, "incrementOne").mockImplementation(async (args) => {
			if (args.model === "bnplOrder" && args.set?.appliedOperations)
				throw new Error("order unavailable");
			return original(args);
		});
		expect((await notify()).error?.status).toBe(500);
		write.mockRestore();
		row.canceledAmountMinor = 5000;
		expect((await notify()).error?.status).toBe(500);
		expect(row.canceledAmountMinor).toBe(5000);
		expect(onUpdated).not.toHaveBeenCalled();
		expect(onCanceled).not.toHaveBeenCalled();
		expect(get).toHaveBeenCalledTimes(1);
	});
	it("resumes historical string-array callback checkpoints", async () => {
		const { instance, notify, onUpdated } = await setupTamara();
		onUpdated.mockImplementationOnce(() => {
			throw new Error("callback unavailable");
		});
		expect((await notify()).error?.status).toBe(500);
		const delivery = instance.db.bnplWebhookEvent?.[0];
		expect(delivery).toBeDefined();
		if (delivery) delivery.deliveryState = JSON.stringify(["0:payload"]);
		expect((await notify()).error).toBeNull();
		expect(onUpdated).toHaveBeenCalledTimes(2);
	});
	it("normalizes partial cancellation callbacks with persistence disabled", async () => {
		const { notify, onUpdated, onCanceled } = await setupTamara(2500, false);
		expect((await notify()).error).toBeNull();
		expect(onUpdated).toHaveBeenCalledTimes(1);
		expect(onCanceled).not.toHaveBeenCalled();
	});
	it("rejects incomplete stateless native cancellation history", async () => {
		const { state, notify, onUpdated, onCanceled } = await setupTamara(2500, false);
		state.operations = undefined;
		expect((await notify()).error).not.toBeNull();
		expect(onUpdated).not.toHaveBeenCalled();
		expect(onCanceled).not.toHaveBeenCalled();
	});
});

describe("stateless compound webhook callbacks", () => {
	it("dispatches all canonical events and the provider snapshot callback once", async () => {
		const onCaptured = vi.fn();
		const onRefunded = vi.fn();
		const onUpdated = vi.fn();
		const onPaymentClosed = vi.fn();
		const events: BnplWebhookEvent[] = [
			capturedEvent("stateless-capture", 10000),
			{
				kind: "refunded",
				provider: "tabby",
				orderId: ORDER_ID,
				refundId: "stateless-refund",
				amountMinor: 2500,
				currency: "SAR",
				raw: {},
			},
			{
				kind: "updated",
				provider: "tabby",
				orderId: ORDER_ID,
				status: "partially_refunded",
				raw: {},
			},
		];
		const provider = makeDrivableProvider({ toCanonicalEvents: () => events });
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tabby: provider },
				persistOrders: false,
				use: [webhooks({ onCaptured, onRefunded, onUpdated, tabby: { onPaymentClosed } })],
			}),
		]);
		expect(
			(
				await post(instance, {
					dedupKey: "stateless-compound",
					event: events[0] as BnplWebhookEvent,
					status: "CLOSED",
				})
			).error,
		).toBeNull();
		expect(onCaptured).toHaveBeenCalledTimes(1);
		expect(onRefunded).toHaveBeenCalledTimes(1);
		expect(onUpdated).toHaveBeenCalledTimes(1);
		expect(onPaymentClosed).toHaveBeenCalledTimes(1);
	});
});
