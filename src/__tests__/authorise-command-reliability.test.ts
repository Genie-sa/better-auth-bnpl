import { describe, expect, it, vi } from "vitest";
import type { BnplProvider } from "../core/provider";
import type { BnplOrderState, BnplWebhookEvent } from "../core/types";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { webhooks } from "../plugins/webhooks";
import { makeBnplTestInstance, stubProvider } from "./_harness";

const orderId = "uncertain-authorise";
function snapshot(status: BnplOrderState["status"]): BnplOrderState {
	return {
		providerOrderId: orderId,
		status,
		totalAmount: { amount: "100.00", currency: "SAR" },
		capturedAmountMinor: status === "fully_captured" ? 10000 : 0,
		refundedAmountMinor: 0,
		operations:
			status === "fully_captured"
				? [{ kind: "captured", id: "native-capture", amountMinor: 10000, currency: "SAR" }]
				: [],
		raw: {},
	};
}
async function setup(overrides: Partial<BnplProvider>, persistOrders = true) {
	const base = stubProvider("tamara");
	const provider = stubProvider("tamara", {
		capabilities: { ...base.capabilities, separateAuthorise: true },
		verifyWebhook: async (request) => ({
			ok: true,
			payload: JSON.parse(request.rawBody),
			rawBody: request.rawBody,
			dedupKey: JSON.parse(request.rawBody).delivery,
		}),
		toCanonicalEvent: (payload) => payload.event as BnplWebhookEvent,
		webhookDedupKey: (event) =>
			event.kind === "captured"
				? `tamara:order_captured:${event.captureId}`
				: `tamara:${event.kind}`,
		...overrides,
	});
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { tamara: provider },
			persistOrders,
			use: [admin({ isAuthorized: () => true }), webhooks()],
		}),
	]);
	const row = {
		id: "uncertain-row",
		provider: "tamara",
		providerOrderId: orderId,
		orderReferenceId: "uncertain-ref",
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
	const webhook = (
		delivery: string,
		event: BnplWebhookEvent = { kind: "approved", provider: "tamara", orderId, raw: {} },
	) =>
		instance.client.$fetch("/bnpl/webhooks/tamara", { method: "POST", body: { delivery, event } });
	return { row, authorise, webhook };
}

describe("durable authorisation intent", () => {
	it("refuses automatic authorisation without durable persistence", async () => {
		const authorize = vi.fn(async () => ({
			providerOrderId: orderId,
			status: "authorised" as const,
			raw: {},
		}));
		const { webhook } = await setup({ authorize }, false);
		expect((await webhook("nonpersistent")).error).toBeTruthy();
		expect(authorize).not.toHaveBeenCalled();
	});
	it("shares one reservation between concurrent admin and webhook workers", async () => {
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const authorize = vi.fn(async () => {
			entered();
			if (authorize.mock.calls.length === 1) await gate;
			return { providerOrderId: orderId, status: "authorised" as const, raw: {} };
		});
		const { authorise, webhook } = await setup({
			authorize,
			fetchOrder: async () => snapshot("approved"),
		});
		const first = authorise();
		await started;
		const second = await webhook("parallel");
		release();
		expect((await first).error).toBeNull();
		expect(second.error).toBeTruthy();
		expect(authorize).toHaveBeenCalledTimes(1);
	});
	it("accepts GET recovery completing the journal before the original POST response", async () => {
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const authorize = vi.fn(async () => {
			entered();
			if (authorize.mock.calls.length === 1) await gate;
			return {
				providerOrderId: orderId,
				status: "fully_captured" as const,
				captureId: "native-capture",
				capturedAmountMinor: 10000,
				autoCaptured: true,
				raw: {},
			};
		});
		const { authorise, webhook, row } = await setup({
			authorize,
			fetchOrder: async () => snapshot("fully_captured"),
		});
		const first = authorise();
		await started;
		const recovered = await webhook("get-beats-post");
		release();
		expect(recovered.error).toBeNull();
		expect((await first).error).toBeNull();
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(
			(
				await webhook("echo-after-race", {
					kind: "captured",
					provider: "tamara",
					orderId,
					captureId: "native-capture",
					amountMinor: 10000,
					currency: "SAR",
					raw: {},
				})
			).error,
		).toBeNull();
		expect(row.capturedAmountMinor).toBe(10000);
	});
	it("does not reissue a timed out POST while remote state remains approved", async () => {
		const authorize = vi.fn(async () => {
			throw new Error("response timed out");
		});
		const fetchOrder = vi.fn(async () => snapshot("approved"));
		const { authorise, webhook, row } = await setup({ authorize, fetchOrder });
		expect((await authorise()).error).toBeTruthy();
		expect((await authorise()).error).toBeTruthy();
		expect((await webhook("timeout-retry")).error).toBeTruthy();
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(fetchOrder).toHaveBeenCalledTimes(2);
		expect(row.status).toBe("approved");
	});
	it("completes uncertain intent from durable local authorisation without a provider call", async () => {
		const authorize = vi.fn(async () => {
			throw new Error("response timed out");
		});
		const fetchOrder = vi.fn(async () => {
			throw new Error("provider unavailable");
		});
		const { authorise, webhook, row } = await setup({ authorize, fetchOrder });
		expect((await authorise()).error).toBeTruthy();
		Object.assign(row, {
			status: "authorised",
			authorisedAt: new Date(),
			version: row.version + 1,
		});
		expect((await webhook("local-confirmation")).error).toBeNull();
		expect((await authorise()).error).toBeNull();
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(fetchOrder).not.toHaveBeenCalled();
		expect(JSON.parse((row as unknown as { moneyCommands: string }).moneyCommands)[0].state).toBe(
			"completed",
		);
	});
	it.each([
		undefined,
		[{ kind: "captured" as const, id: "incomplete", amountMinor: 9000, currency: "SAR" as const }],
	])(
		"rejects incomplete remote financial history on webhook timeout recovery: %j",
		async (operations) => {
			const authorize = vi.fn(async () => {
				throw new Error("response timed out");
			});
			const { webhook, row } = await setup({
				authorize,
				fetchOrder: async () => ({ ...snapshot("fully_captured"), operations }),
			});
			expect((await webhook("incomplete-history")).error).toBeTruthy();
			expect((await webhook("incomplete-history")).error).toBeTruthy();
			expect(authorize).toHaveBeenCalledTimes(1);
			expect(row).toMatchObject({ status: "approved", capturedAmountMinor: 0 });
		},
	);
	it.each(["authorised", "fully_captured"] as const)(
		"recovers a timeout through verified %s state across entry points",
		async (status) => {
			const authorize = vi.fn(async () => {
				throw new Error("response timed out");
			});
			const { authorise, webhook, row } = await setup({
				authorize,
				fetchOrder: async () => snapshot(status),
			});
			expect((await webhook("first-timeout")).error).toBeTruthy();
			expect((await authorise()).error).toBeNull();
			expect((await webhook("first-timeout")).error).toBeNull();
			expect((await authorise()).error).toBeNull();
			expect(authorize).toHaveBeenCalledTimes(1);
			expect(row.status).toBe(status);
			if (status === "fully_captured") {
				expect(
					(
						await webhook("capture-echo", {
							kind: "captured",
							provider: "tamara",
							orderId,
							captureId: "native-capture",
							amountMinor: 10000,
							currency: "SAR",
							raw: {},
						})
					).error,
				).toBeNull();
				expect(row.capturedAmountMinor).toBe(10000);
			}
		},
	);
});
