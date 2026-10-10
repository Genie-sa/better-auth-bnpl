import type { GenericEndpointContext } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { BnplProviderError } from "../core/errors";
import type { BnplCaptureResult, BnplWebhookEvent } from "../core/types";
import { bnpl } from "../plugin";
import { releaseRejectedMoneyCommand, reserveMoneyCommand } from "../plugins/money-command";
import { webhooks } from "../plugins/webhooks";
import { makeBnplTestInstance, stubProvider } from "./_harness";

const orderId = "uncertain-auto-capture";
async function setup(capture: () => Promise<BnplCaptureResult>, shipping?: () => void) {
	const provider = stubProvider("tamara", {
		capture,
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
	});
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { tamara: provider },
			persistOrders: true,
			captureOnAuthorise: true,
			captureOnAuthoriseShippingInfo: () => {
				shipping?.();
				return { shippingCompany: "Digital", shippedAt: new Date().toISOString() };
			},
			use: [webhooks()],
		}),
	]);
	const row = {
		id: "auto-capture-row",
		provider: "tamara",
		providerOrderId: orderId,
		orderReferenceId: "auto-capture-ref",
		status: "authorised",
		amountMinor: 10000,
		currency: "SAR",
		capturedAmountMinor: 0,
		canceledAmountMinor: 0,
		refundedAmountMinor: 0,
		version: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	instance.db.bnplOrder?.push(row);
	const post = (
		delivery = "capture-trigger",
		event: BnplWebhookEvent = { kind: "authorized", provider: "tamara", orderId, raw: {} },
	) =>
		instance.client.$fetch("/bnpl/webhooks/tamara", { method: "POST", body: { delivery, event } });
	return { row, post, instance };
}
function result(overrides: Partial<BnplCaptureResult> = {}): BnplCaptureResult {
	return {
		providerOrderId: orderId,
		captureId: "auto-capture-native",
		amountMinor: 10000,
		raw: {},
		...overrides,
	};
}
describe("durable automatic capture intent", () => {
	it("does not release a newer command when an old rejected owner's cleanup arrives late", async () => {
		const { instance, row } = await setup(async () => result());
		const ctx = { context: await instance.auth.$context } as GenericEndpointContext;
		const where = () => [{ field: "id", value: row.id }];
		const first = await reserveMoneyCommand(ctx, where, "capture", "same-reference", {});
		if (first.kind !== "reserved") throw new Error("missing first reservation");
		await releaseRejectedMoneyCommand(ctx, where, first.command);
		const second = await reserveMoneyCommand(ctx, where, "capture", "same-reference", {});
		if (second.kind !== "reserved") throw new Error("missing second reservation");
		await releaseRejectedMoneyCommand(ctx, where, first.command);
		await expect(
			reserveMoneyCommand(ctx, where, "capture", "same-reference", {}),
		).rejects.toMatchObject({ status: "CONFLICT" });
		expect(first.command.token).not.toBe(second.command.token);
	});
	it("completes its journal without counting money twice when the native webhook beats its response", async () => {
		let release!: () => void;
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const capture = vi.fn(async () => {
			enter();
			await gate;
			return result();
		});
		const { post, row } = await setup(capture);
		const first = post();
		await entered;
		const echo = await post("capture-before-response", {
			kind: "captured",
			provider: "tamara",
			orderId,
			captureId: "auto-capture-native",
			amountMinor: 10000,
			currency: "SAR",
			raw: {},
		});
		release();
		expect(echo.error).toBeNull();
		expect((await first).error).toBeNull();
		expect(row.capturedAmountMinor).toBe(10000);
		expect(capture).toHaveBeenCalledOnce();
		expect(JSON.parse((row as unknown as { moneyCommands: string }).moneyCommands)[0].state).toBe(
			"completed",
		);
	});
	it.each([undefined, 408, 429, 500])(
		"does not repeat an uncertain capture POST after error status %s",
		async (status) => {
			const capture = vi.fn(async () => {
				throw status === undefined
					? new Error("response timeout")
					: new BnplProviderError("tamara", "capture uncertain", { status });
			});
			const { post } = await setup(capture);
			expect((await post()).error).toBeTruthy();
			expect((await post()).error).toBeTruthy();
			expect(capture).toHaveBeenCalledOnce();
		},
	);
	it("does not issue a new amount/reference after cancellation changes an uncertain capture", async () => {
		const capture = vi.fn(async () => {
			throw new Error("response timeout");
		});
		const { post, row } = await setup(capture);
		expect((await post()).error).toBeTruthy();
		Object.assign(row, { canceledAmountMinor: 2000, version: row.version + 1 });
		expect((await post()).error).toBeTruthy();
		expect(capture).toHaveBeenCalledOnce();
	});
	it("retries a confirmed rejection despite fresh shipping timestamps", async () => {
		const capture = vi
			.fn()
			.mockRejectedValueOnce(new BnplProviderError("tamara", "capture rejected", { status: 400 }))
			.mockResolvedValue(result());
		const { post, row } = await setup(capture);
		expect((await post()).error).toBeTruthy();
		expect((await post()).error).toBeNull();
		expect(capture).toHaveBeenCalledTimes(2);
		expect(row.capturedAmountMinor).toBe(10000);
	});
	it("finishes a timed out delivery after a native captured webhook confirms its remaining balance", async () => {
		const capture = vi.fn(async () => {
			throw new Error("response timeout");
		});
		const { post, row } = await setup(capture);
		expect((await post()).error).toBeTruthy();
		expect(
			(
				await post("capture-confirmed", {
					kind: "captured",
					provider: "tamara",
					orderId,
					captureId: "auto-capture-native",
					amountMinor: 10000,
					currency: "SAR",
					raw: {},
				})
			).error,
		).toBeNull();
		expect((await post()).error).toBeNull();
		expect(capture).toHaveBeenCalledOnce();
		expect(row.capturedAmountMinor).toBe(10000);
	});
	it.each([{ providerOrderId: "another-order" }, { amountMinor: 9000 }])(
		"rejects inconsistent provider capture result %j",
		async (override) => {
			const { post, row } = await setup(async () => result(override));
			expect((await post()).error).toBeTruthy();
			expect(row.capturedAmountMinor).toBe(0);
		},
	);
	it("validates the latest canceled balance before posting capture", async () => {
		const state: { current?: { canceledAmountMinor: number; version: number } } = {};
		const capture = vi.fn(async () => result());
		const { post, row } = await setup(capture, () => {
			if (state.current) {
				state.current.canceledAmountMinor = 5000;
				state.current.version++;
			}
		});
		state.current = row;
		expect((await post()).error).toBeTruthy();
		expect(capture).not.toHaveBeenCalled();
	});
	it("rejects a capture commit exceeding a concurrently canceled balance", async () => {
		const state: { current?: { canceledAmountMinor: number; version: number } } = {};
		const { post, row } = await setup(async () => {
			if (state.current) {
				state.current.canceledAmountMinor = 5000;
				state.current.version++;
			}
			return result();
		});
		state.current = row;
		expect((await post()).error).toBeTruthy();
		expect(row.capturedAmountMinor).toBe(0);
	});
});
