import { describe, expect, it, vi } from "vitest";
import { BnplProviderError } from "../core/errors";
import type { BnplProvider } from "../core/provider";
import type { BnplWebhookEvent } from "../core/types";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { webhooks } from "../plugins/webhooks";
import { makeBnplTestInstance, stubProvider } from "./_harness";

const orderId = "authorise-order";
async function setup(overrides: Partial<BnplProvider>) {
	const base = stubProvider("tabby");
	const provider = stubProvider("tabby", {
		capabilities: { ...base.capabilities, separateAuthorise: true },
		webhookDedupKey(event) {
			return event.kind === "captured"
				? `tabby:order_captured:${event.captureId}`
				: `tabby:${event.kind}`;
		},
		async verifyWebhook(request) {
			const event = JSON.parse(request.rawBody) as BnplWebhookEvent;
			return {
				ok: true,
				payload: event as unknown as Record<string, unknown>,
				rawBody: request.rawBody,
				dedupKey: this.webhookDedupKey?.(event) ?? "event",
			};
		},
		toCanonicalEvent(payload) {
			return payload as unknown as BnplWebhookEvent;
		},
		...overrides,
	});
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { tabby: provider },
			persistOrders: true,
			use: [admin({ isAuthorized: () => true }), webhooks()],
		}),
	]);
	const row = {
		id: "authorise-row",
		provider: "tabby",
		providerOrderId: orderId,
		orderReferenceId: "authorise-reference",
		status: "approved",
		amountMinor: 10000,
		currency: "SAR",
		capturedAmountMinor: 0,
		refundedAmountMinor: 0,
		version: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	instance.db.bnplOrder?.push(row);
	const { headers } = await instance.signInWithTestUser();
	const authorise = () =>
		instance.client.$fetch(`/bnpl/admin/orders/${orderId}/authorise`, { method: "POST", headers });
	const echo = (amountMinor = 10000) =>
		instance.client.$fetch("/bnpl/webhooks/tabby", {
			method: "POST",
			body: {
				kind: "captured",
				provider: "tabby",
				orderId,
				captureId: "authorise-capture",
				amountMinor,
				currency: "SAR",
				raw: {},
			},
		});
	return { instance, row, authorise, echo };
}

describe("admin authorisation financial durability", () => {
	it("keeps the capture identity durable when synthetic event recording fails", async () => {
		const { instance, row, authorise, echo } = await setup({
			authorize: async () => ({
				providerOrderId: orderId,
				status: "fully_captured",
				autoCaptured: true,
				captureId: "authorise-capture",
				capturedAmountMinor: 10000,
				raw: {},
			}),
		});
		const adapter = (await instance.auth.$context).adapter;
		const original = adapter.create.bind(adapter);
		vi.spyOn(adapter, "create").mockImplementation(async (args) => {
			if (args.model === "bnplWebhookEvent" && args.data.status === "processed")
				throw new Error("synthetic write unavailable");
			return original(args);
		});
		expect((await authorise()).error).toBeNull();
		expect((await echo()).error).toBeNull();
		expect(row.capturedAmountMinor).toBe(10000);
	});
	it("persists confirmed captures without regressing a concurrent refund", async () => {
		const state: { row?: Record<string, unknown> } = {};
		const { row, authorise, echo } = await setup({
			authorize: async () => {
				Object.assign(state.row ?? {}, {
					status: "partially_refunded",
					capturedAmountMinor: 6000,
					refundedAmountMinor: 2000,
					version: 1,
				});
				return {
					providerOrderId: orderId,
					status: "fully_captured",
					autoCaptured: true,
					captureId: "authorise-capture",
					capturedAmountMinor: 10000,
					raw: {},
				};
			},
		});
		state.row = row;
		expect((await authorise()).error).toBeNull();
		expect(row).toMatchObject({
			status: "partially_refunded",
			capturedAmountMinor: 10000,
			refundedAmountMinor: 2000,
		});
		expect((await echo(4000)).error).toBeNull();
		expect(row.capturedAmountMinor).toBe(10000);
	});
	it.each([
		{ providerOrderId: "another-order", capturedAmountMinor: 10000 },
		{ providerOrderId: orderId, capturedAmountMinor: 10001 },
		{ providerOrderId: orderId, capturedAmountMinor: -1 },
	])(
		"rejects inconsistent authorisation response %j without changing balances",
		async (response) => {
			const { row, authorise } = await setup({
				authorize: async () => ({
					...response,
					status: "fully_captured",
					autoCaptured: true,
					captureId: "authorise-capture",
					raw: {},
				}),
			});
			expect((await authorise()).error?.status).toBe(500);
			expect(row).toMatchObject({
				status: "approved",
				capturedAmountMinor: 0,
				refundedAmountMinor: 0,
			});
		},
	);

	it.each([
		undefined,
		[{ kind: "captured" as const, id: "incomplete", amountMinor: 3000, currency: "SAR" as const }],
	])(
		"rejects increased recovery totals with incomplete operation history %j",
		async (operations) => {
			const { row, authorise } = await setup({
				authorize: async () => {
					throw new BnplProviderError("tabby", "already authorised", {
						status: 409,
						body: { message: "already authorised" },
					});
				},
				fetchOrder: async () => ({
					providerOrderId: orderId,
					status: "partially_captured",
					totalAmount: { amount: "100.00", currency: "SAR" },
					capturedAmountMinor: 4000,
					refundedAmountMinor: 0,
					operations,
					raw: {},
				}),
			});
			expect((await authorise()).error?.status).toBe(500);
			expect(row).toMatchObject({ status: "approved", capturedAmountMinor: 0 });
		},
	);

	it("recovers verified upstream totals and operation IDs together", async () => {
		const { row, authorise, echo } = await setup({
			authorize: async () => {
				throw new BnplProviderError("tabby", "already authorised", {
					status: 409,
					body: { message: "already authorised" },
				});
			},
			fetchOrder: async () => ({
				providerOrderId: orderId,
				status: "partially_captured",
				totalAmount: { amount: "100.00", currency: "SAR" },
				capturedAmountMinor: 4000,
				refundedAmountMinor: 0,
				operations: [
					{ kind: "captured", id: "authorise-capture", amountMinor: 4000, currency: "SAR" },
				],
				raw: {},
			}),
		});
		expect((await authorise()).error).toBeNull();
		expect(row).toMatchObject({ status: "partially_captured", capturedAmountMinor: 4000 });
		expect((await echo(4000)).error).toBeNull();
		expect(row.capturedAmountMinor).toBe(4000);
	});
});
