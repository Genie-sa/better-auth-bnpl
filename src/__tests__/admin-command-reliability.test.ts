import { describe, expect, it, vi } from "vitest";
import type { BnplProvider } from "../core/provider";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { makeBnplTestInstance, stubProvider } from "./_harness";

async function setup(overrides: Partial<BnplProvider> = {}) {
	const capture = vi.fn(async () => ({
		providerOrderId: "command-order",
		captureId: `capture-${capture.mock.calls.length}`,
		amountMinor: 1000,
		raw: {},
	}));
	const refund = vi.fn(async () => ({
		providerOrderId: "command-order",
		refundId: `refund-${refund.mock.calls.length}`,
		amountMinor: 1000,
		raw: {},
	}));
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { tamara: stubProvider("tamara", { capture, refund, ...overrides }) },
			persistOrders: true,
			use: [admin({ isAuthorized: () => true })],
		}),
	]);
	const row: Record<string, unknown> = {
		id: "command-row",
		provider: "tamara",
		providerOrderId: "command-order",
		orderReferenceId: "command-ref",
		status: "partially_captured",
		amountMinor: 10000,
		currency: "SAR",
		capturedAmountMinor: 5000,
		refundedAmountMinor: 0,
		version: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	instance.db.bnplOrder?.push(row);
	const { headers } = await instance.signInWithTestUser();
	const post = (
		operation = "capture",
		body: Record<string, unknown> = {
			totalAmount: { amount: "10.00", currency: "SAR" },
			merchantReferenceId: "stable-capture",
		},
	) =>
		instance.client.$fetch(`/bnpl/admin/orders/command-order/${operation}`, {
			method: "POST",
			headers,
			body,
		});
	return { post, row, capture, refund, instance };
}

describe("durable admin money commands", () => {
	it.each(["capture", "refund"])(
		"rejects %s without a stable reference before calling upstream",
		async (operation) => {
			const { post, capture, refund } = await setup();
			expect(
				(await post(operation, { totalAmount: { amount: "10.00", currency: "SAR" } })).error
					?.status,
			).toBe(400);
			expect(capture).not.toHaveBeenCalled();
			expect(refund).not.toHaveBeenCalled();
		},
	);
	it.each(["capture", "refund"])(
		"replays completed %s without requesting a fresh provider operation",
		async (operation) => {
			const { post, row, capture, refund } = await setup();
			const body = {
				totalAmount: { amount: "10.00", currency: "SAR" },
				[operation === "capture" ? "merchantReferenceId" : "merchantRefundId"]: "stable",
			};
			const first = await post(operation, body);
			const replay = await post(operation, body);
			expect(first.error).toBeNull();
			expect(replay.data).toEqual(first.data);
			expect(operation === "capture" ? capture : refund).toHaveBeenCalledTimes(1);
			expect(row[operation === "capture" ? "capturedAmountMinor" : "refundedAmountMinor"]).toBe(
				operation === "capture" ? 6000 : 1000,
			);
		},
	);
	it("rejects changed input under the same reference", async () => {
		const { post, capture } = await setup();
		await post();
		expect(
			(
				await post("capture", {
					totalAmount: { amount: "20.00", currency: "SAR" },
					merchantReferenceId: "stable-capture",
				})
			).error?.status,
		).toBe(409);
		expect(capture).toHaveBeenCalledTimes(1);
	});
	it("blocks concurrent execution while a command is pending", async () => {
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const capture = vi.fn(async () => {
			entered();
			await gate;
			return {
				providerOrderId: "command-order",
				captureId: "concurrent",
				amountMinor: 1000,
				raw: {},
			};
		});
		const { post } = await setup({ capture });
		const first = post();
		await started;
		const second = await post();
		release();
		await first;
		expect(second.error?.status).toBe(409);
		expect(capture).toHaveBeenCalledTimes(1);
	});
	it("retains uncertain commands after timeout instead of resending money", async () => {
		const capture = vi.fn(async () => {
			throw new Error("response lost after acceptance");
		});
		const { post, row } = await setup({ capture });
		expect((await post()).error).not.toBeNull();
		expect((await post()).error?.status).toBe(409);
		expect(capture).toHaveBeenCalledTimes(1);
		expect(String(row.moneyCommands)).toContain('"pending"');
	});
	it("does not resend accepted money when the final local commit fails", async () => {
		const { post, row, capture, instance } = await setup();
		const adapter = (await instance.auth.$context).adapter;
		const original = adapter.incrementOne.bind(adapter);
		vi.spyOn(adapter, "incrementOne").mockImplementation(async (args) => {
			if (args.model === "bnplOrder" && "capturedAmountMinor" in (args.set ?? {}))
				throw new Error("commit unavailable");
			return original(args);
		});
		expect((await post()).error?.status).toBe(500);
		expect((await post()).error?.status).toBe(409);
		expect(capture).toHaveBeenCalledTimes(1);
		expect(row.capturedAmountMinor).toBe(5000);
		expect(row.appliedOperations).toBeUndefined();
		expect(String(row.moneyCommands)).toContain('"pending"');
	});
	it("replays requests with reordered JSON keys", async () => {
		const { post, capture } = await setup();
		const first = await post();
		const second = await post("capture", {
			merchantReferenceId: "stable-capture",
			totalAmount: { currency: "SAR", amount: "10.00" },
		});
		expect(second.data).toEqual(first.data);
		expect(capture).toHaveBeenCalledTimes(1);
	});
	it("completes the command when the native operation was already applied by a webhook", async () => {
		const capture = vi.fn(async () => {
			Object.assign(row, {
				capturedAmountMinor: 6000,
				appliedOperations: JSON.stringify(["tamara:captured:echo"]),
				version: Number(row.version) + 1,
			});
			return { providerOrderId: "command-order", captureId: "echo", amountMinor: 1000, raw: {} };
		});
		const instance = await setup({ capture });
		const row = instance.row;
		expect((await instance.post()).error).toBeNull();
		expect((await instance.post()).error).toBeNull();
		expect(row.capturedAmountMinor).toBe(6000);
		expect(capture).toHaveBeenCalledTimes(1);
	});
});
