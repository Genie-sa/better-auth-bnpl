import { describe, expect, it, vi } from "vitest";
import { BnplProviderError } from "../core/errors";
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
	describe("provider rejection policy", () => {
		const body = (operation: string, reference: string) => ({
			totalAmount: { amount: "10.00", currency: "SAR" },
			[operation === "capture" ? "merchantReferenceId" : "merchantRefundId"]: reference,
		});
		it.each([
			["capture", 400],
			["capture", 422],
			["refund", 404],
		])("frees a %s the provider refused with %i for a retry", async (operation, status) => {
			const { post, capture, refund, row } = await setup();
			const request = operation === "capture" ? capture : refund;
			request.mockRejectedValueOnce(
				new BnplProviderError("tamara", "refused", { status, rejected: true }),
			);
			expect((await post(operation, body(operation, "retry"))).error?.status).toBe(502);
			expect((await post(operation, body(operation, "retry"))).error).toBeNull();
			expect(request).toHaveBeenCalledTimes(2);
			expect(JSON.parse(String(row.moneyCommands))).toEqual([
				expect.objectContaining({ state: "completed" }),
			]);
		});
		it.each([
			["capture", 409],
			["capture", 429],
			["capture", 503],
			["refund", 408],
			["refund", undefined],
		])("keeps a %s with an uncertain %s outcome pending", async (operation, status) => {
			const { post, capture, refund } = await setup();
			const request = operation === "capture" ? capture : refund;
			request.mockRejectedValueOnce(new BnplProviderError("tamara", "unclear", { status }));
			expect((await post(operation, body(operation, "unclear"))).error?.status).toBe(502);
			expect((await post(operation, body(operation, "unclear"))).error?.status).toBe(409);
			expect((await post(operation, body(operation, "different"))).error?.status).toBe(409);
			expect(request).toHaveBeenCalledTimes(1);
		});
		it("keeps a provider-accepted capture pending when its local write fails", async () => {
			const { post, capture } = await setup();
			capture.mockResolvedValueOnce({
				providerOrderId: "command-order",
				captureId: "accepted",
				amountMinor: 999,
				raw: {},
			});
			expect((await post("capture", body("capture", "accepted"))).error?.status).toBe(502);
			expect((await post("capture", body("capture", "accepted"))).error?.status).toBe(409);
			expect(capture).toHaveBeenCalledTimes(1);
		});
	});
	describe("pending command recovery", () => {
		const body = { totalAmount: { amount: "10.00", currency: "SAR" }, merchantReferenceId: "lost" };
		const remote = (captures: { id: string; amountMinor: number }[]) => ({
			providerOrderId: "command-order",
			status: "partially_captured" as const,
			totalAmount: { amount: "100.00", currency: "SAR" as const },
			capturedAmountMinor: captures.reduce((sum, capture) => sum + capture.amountMinor, 0),
			refundedAmountMinor: 0,
			operations: captures.map((capture) => ({
				...capture,
				kind: "captured" as const,
				currency: "SAR" as const,
			})),
			raw: {},
		});
		it("completes a lost capture from native history without resending it", async () => {
			let history = remote([{ id: "earlier", amountMinor: 5000 }]);
			const { post, capture, row } = await setup({ fetchOrder: async () => history });
			row.appliedOperations = JSON.stringify(["tamara:captured:earlier"]);
			capture.mockRejectedValueOnce(new BnplProviderError("tamara", "timeout"));
			expect((await post("capture", body)).error?.status).toBe(502);
			history = remote([
				{ id: "earlier", amountMinor: 5000 },
				{ id: "landed", amountMinor: 1000 },
			]);
			const recovered = await post("capture", body);
			expect(recovered.error).toBeNull();
			expect(recovered.data).toMatchObject({ captureId: "landed", amountMinor: 1000 });
			expect((await post("capture", body)).data).toEqual(recovered.data);
			expect(capture).toHaveBeenCalledTimes(1);
			expect(row.capturedAmountMinor).toBe(6000);
			expect(JSON.parse(String(row.moneyCommands))).toEqual([
				expect.objectContaining({ state: "completed" }),
			]);
		});
		it("keeps a lost capture pending while native history is ambiguous", async () => {
			const { post, capture, row } = await setup({
				fetchOrder: async () =>
					remote([
						{ id: "earlier", amountMinor: 5000 },
						{ id: "one", amountMinor: 1000 },
						{ id: "two", amountMinor: 1000 },
					]),
			});
			row.appliedOperations = JSON.stringify(["tamara:captured:earlier"]);
			capture.mockRejectedValueOnce(new BnplProviderError("tamara", "timeout"));
			await post("capture", body);
			expect((await post("capture", body)).error).toMatchObject({ status: 409 });
			expect(capture).toHaveBeenCalledTimes(1);
			expect(row.capturedAmountMinor).toBe(5000);
		});
	});
	describe("refunds split across captures", () => {
		const body = { totalAmount: { amount: "30.00", currency: "SAR" }, merchantRefundId: "split" };
		const split = (amounts: number[]) => ({
			providerOrderId: "command-order",
			refundId: "split-1",
			amountMinor: 3000,
			operations: amounts.map((amountMinor, index) => ({
				id: `split-${index + 1}`,
				kind: "refunded" as const,
				amountMinor,
				currency: "SAR" as const,
			})),
			raw: {},
		});
		it("records every native refund once so their notifications never count again", async () => {
			const { post, refund, row } = await setup();
			refund.mockResolvedValueOnce(split([1000, 2000]));
			expect((await post("refund", body)).error).toBeNull();
			expect(row.refundedAmountMinor).toBe(3000);
			expect(JSON.parse(String(row.appliedOperations))).toEqual([
				"tamara:refunded:split-1",
				"tamara:refunded:split-2",
			]);
		});
		it("keeps a split refund pending when it repeats an operation identity", async () => {
			const { post, refund, row } = await setup();
			const repeated = split([1500, 1500]);
			const duplicate = {
				...repeated,
				operations: repeated.operations.map((operation) => ({ ...operation, id: "split-1" })),
			};
			refund.mockResolvedValueOnce(duplicate);
			expect((await post("refund", body)).error?.status).toBe(502);
			expect(row.refundedAmountMinor).toBe(0);
		});
		it("keeps a split refund pending when its operations do not add up", async () => {
			const { post, refund, row } = await setup();
			refund.mockResolvedValueOnce(split([1000, 1500]));
			expect((await post("refund", body)).error?.status).toBe(502);
			expect(row.refundedAmountMinor).toBe(0);
			expect(JSON.parse(String(row.moneyCommands))).toEqual([
				expect.objectContaining({ state: "pending" }),
			]);
		});
	});
});
