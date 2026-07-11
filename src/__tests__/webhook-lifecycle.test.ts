import { describe, expect, it, vi } from "vitest";
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
			if (shouldThrow) throw new Error("capture boom");
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
			body: { totalAmount: { amount: "100.00", currency: "SAR" } },
		});
		const refundRes = await instance.client.$fetch(`/bnpl/admin/orders/${ORDER_ID}/refund`, {
			method: "POST",
			headers,
			body: { totalAmount: { amount: "30.00", currency: "SAR" } },
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
