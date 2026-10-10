import { describe, expect, it, vi } from "vitest";
import type { BnplProvider } from "../core/provider";
import type { BnplCancelResult, BnplOrderState } from "../core/types";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { makeBnplTestInstance, stubProvider } from "./_harness";

async function setup(result: BnplCancelResult | undefined, overrides: Partial<BnplProvider> = {}) {
	const post = vi.fn(async () => result);
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: {
				[overrides.id ?? "tamara"]: stubProvider(overrides.id ?? "tamara", {
					cancel: post,
					...overrides,
				}),
			},
			persistOrders: true,
			use: [admin({ isAuthorized: () => true })],
		}),
	]);
	const row: Record<string, unknown> = {
		id: "cancel-row",
		provider: overrides.id ?? "tamara",
		providerOrderId: "cancel-order",
		orderReferenceId: "cancel-reference",
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
	const { headers } = await instance.signInWithTestUser();
	const cancel = (
		amount: string | undefined = "25.00",
		reference: string | undefined = `cancel-${amount}`,
	) =>
		instance.client.$fetch("/bnpl/admin/orders/cancel-order/cancel", {
			method: "POST",
			headers,
			body: {
				...(amount === "" ? {} : { totalAmount: { amount, currency: "SAR" } }),
				...(reference === "" ? {} : { merchantReferenceId: reference }),
			},
		});
	return { row, cancel, post, instance };
}
const partial: BnplCancelResult = {
	providerOrderId: "cancel-order",
	status: "updated",
	cancelId: "cancel-1",
	amountMinor: 2500,
	raw: {},
};
describe("admin cancellation financial balance", () => {
	it("cancels 25 then the remaining 75 against the original total", async () => {
		const result = { ...partial };
		const { row, cancel } = await setup(result);
		expect((await cancel()).error).toBeNull();
		Object.assign(result, { status: "canceled", cancelId: "cancel-2", amountMinor: 7500 });
		expect((await cancel("75.00")).error).toBeNull();
		expect(row).toMatchObject({
			status: "canceled",
			canceledAmountMinor: 10000,
			capturedAmountMinor: 0,
		});
		expect(JSON.parse(String(row.appliedOperations))).toEqual([
			"tamara:cancel:cancel-1",
			"tamara:cancel:cancel-2",
		]);
	});

	it("stores a confirmed partial cancellation and counts native response replays once", async () => {
		const { row, cancel } = await setup(partial);
		expect((await cancel()).error).toBeNull();
		expect((await cancel()).error).toBeNull();
		expect(row).toMatchObject({
			status: "authorised",
			canceledAmountMinor: 2500,
			capturedAmountMinor: 0,
		});
		expect(JSON.parse(String(row.appliedOperations))).toEqual(["tamara:cancel:cancel-1"]);
	});
	it("rejects cancellation that overlaps already captured funds", async () => {
		const { row, cancel } = await setup(partial);
		row.capturedAmountMinor = 8000;
		expect((await cancel()).error).not.toBeNull();
		expect(row.canceledAmountMinor).toBe(0);
		expect(row.appliedOperations).toBeUndefined();
	});
	it("rejects response amounts that differ from the requested amount", async () => {
		const { row, cancel } = await setup({ ...partial, amountMinor: 3000 });
		expect((await cancel()).error).not.toBeNull();
		expect(row.canceledAmountMinor).toBe(0);
	});
	it("preserves legacy cancellation status without inventing a financial operation", async () => {
		const { row, cancel } = await setup(undefined, {
			fetchOrder: async () => ({ ...remote(), status: "canceled", raw: { status: "CLOSED" } }),
		});
		expect((await cancel("", "")).error).toBeNull();
		expect(row.status).toBe("canceled");
		expect(row.canceledAmountMinor).toBe(0);
		expect(JSON.parse(String(row.appliedOperations))).toEqual([]);
	});
});

function remote(canceledAmountMinor = 0): BnplOrderState {
	return {
		providerOrderId: "cancel-order",
		status: canceledAmountMinor === 10000 ? "canceled" : "updated",
		totalAmount: { amount: "100.00", currency: "SAR" },
		capturedAmountMinor: 0,
		refundedAmountMinor: 0,
		canceledAmountMinor,
		operations: canceledAmountMinor
			? [{ kind: "canceled", id: "cancel-1", amountMinor: canceledAmountMinor, currency: "SAR" }]
			: [],
		raw: {},
	};
}
describe("durable admin cancellation commands", () => {
	it("requires an explicit reference before an amount-bearing POST", async () => {
		const { cancel, post } = await setup(partial);
		expect((await cancel("25.00", "")).error?.status).toBe(400);
		expect(post).not.toHaveBeenCalled();
	});
	it("returns cached completion without another provider POST", async () => {
		const { cancel, post } = await setup(partial);
		const first = await cancel();
		const second = await cancel();
		expect(second.data).toEqual(first.data);
		expect(post).toHaveBeenCalledTimes(1);
	});
	it("rejects a prior native cancellation identity on a new command", async () => {
		const { cancel, row } = await setup(partial);
		expect((await cancel("25.00", "first")).error).toBeNull();
		expect((await cancel("25.00", "second")).error).not.toBeNull();
		expect(row.canceledAmountMinor).toBe(2500);
	});
	it("rejects changed input under the same reference", async () => {
		const { cancel, post } = await setup(partial);
		await cancel("25.00", "stable");
		expect((await cancel("50.00", "stable")).error?.status).toBe(409);
		expect(post).toHaveBeenCalledTimes(1);
	});
	it("recovers a lost response from one exact native cancellation", async () => {
		const post = vi.fn(async () => {
			throw new Error("response lost");
		});
		const get = vi.fn(async () => remote(2500));
		const { cancel, row } = await setup(partial, { cancel: post, fetchOrder: get });
		expect((await cancel()).error).not.toBeNull();
		expect((await cancel()).error).toBeNull();
		expect(post).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledTimes(1);
		expect(row.canceledAmountMinor).toBe(2500);
		expect(JSON.parse(String(row.moneyCommands))[0].state).toBe("completed");
	});
	it("leaves an unproven pending outcome blocked without another POST", async () => {
		const post = vi.fn(async () => {
			throw new Error("timeout");
		});
		const { cancel, row } = await setup(partial, {
			cancel: post,
			fetchOrder: async () => remote(),
		});
		await cancel();
		expect((await cancel()).error?.status).toBe(409);
		expect(post).toHaveBeenCalledTimes(1);
		expect(row.canceledAmountMinor).toBe(0);
	});
	it("blocks a concurrent retry while the first provider call is outstanding", async () => {
		let finish!: (value: BnplCancelResult) => void;
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const post = vi.fn(() => {
			started();
			return new Promise<BnplCancelResult>((resolve) => {
				finish = resolve;
			});
		});
		const { cancel } = await setup(partial, { cancel: post, fetchOrder: async () => remote() });
		const first = cancel();
		await entered;
		const second = await cancel();
		finish(partial);
		expect((await first).error).toBeNull();
		expect(second.error?.status).toBe(409);
		expect(post).toHaveBeenCalledTimes(1);
	});
	it("completes recovery when a webhook already applied the native cancellation", async () => {
		const post = vi.fn(async () => {
			throw new Error("lost");
		});
		const { cancel, row } = await setup(partial, {
			cancel: post,
			fetchOrder: async () => remote(2500),
		});
		await cancel();
		row.canceledAmountMinor = 2500;
		row.appliedOperations = JSON.stringify(["tamara:cancel:cancel-1"]);
		expect((await cancel()).error).toBeNull();
		expect(row.canceledAmountMinor).toBe(2500);
		expect(post).toHaveBeenCalledTimes(1);
	});
});

describe("cancellation recovery evidence", () => {
	it.each([
		[
			"two new cancellation identities",
			{
				...remote(2500),
				operations: [
					{ kind: "canceled", id: "a", amountMinor: 1000, currency: "SAR" },
					{ kind: "canceled", id: "b", amountMinor: 1500, currency: "SAR" },
				],
			},
		],
		["absent native history", { ...remote(2500), operations: undefined }],
		[
			"a different captured balance",
			{
				...remote(2500),
				capturedAmountMinor: 1000,
				operations: [
					...(remote(2500).operations ?? []),
					{ kind: "captured", id: "capture-a", amountMinor: 1000, currency: "SAR" },
				],
			},
		],
	] as const)("blocks %s without issuing another cancellation", async (_label, state) => {
		const post = vi.fn(async () => {
			throw new Error("lost");
		});
		const { cancel, row } = await setup(partial, {
			cancel: post,
			fetchOrder: async () => state as BnplOrderState,
		});
		await cancel();
		expect((await cancel()).error?.status).toBe(409);
		expect(post).toHaveBeenCalledTimes(1);
		expect(row.canceledAmountMinor).toBe(0);
	});
	it("recovers a successful native cancellation after the local completion write fails", async () => {
		const { cancel, row, instance, post } = await setup(partial, {
			fetchOrder: async () => remote(2500),
		});
		const adapter = instance.auth.$context;
		const context = await adapter;
		const original = context.adapter.incrementOne.bind(context.adapter);
		const write = vi.spyOn(context.adapter, "incrementOne").mockImplementation(async (args) => {
			if (args.set && String(args.set.moneyCommands).includes('"completed"'))
				throw new Error("database unavailable");
			return original(args);
		});
		expect((await cancel()).error).not.toBeNull();
		write.mockRestore();
		expect((await cancel()).error).toBeNull();
		expect(post).toHaveBeenCalledTimes(1);
		expect(row.canceledAmountMinor).toBe(2500);
	});
	it("uses confirmed Tabby closure status without changing captured funds", async () => {
		const state: BnplOrderState = {
			...remote(),
			status: "closed",
			capturedAmountMinor: 2500,
			operations: [{ kind: "captured", id: "capture-a", amountMinor: 2500, currency: "SAR" }],
			raw: { status: "CLOSED" },
		};
		const { row, cancel, post } = await setup(undefined, {
			id: "tabby",
			fetchOrder: async () => state,
		});
		row.capturedAmountMinor = 2500;
		row.status = "partially_captured";
		row.appliedOperations = JSON.stringify(["tabby:captured:capture-a"]);
		expect((await cancel("", "")).error).toBeNull();
		expect((await cancel("", "")).error).toBeNull();
		expect(row.status).toBe("closed");
		expect(row.capturedAmountMinor).toBe(2500);
		expect(row.canceledAmountMinor).toBe(0);
		expect(post).toHaveBeenCalledTimes(1);
	});
});

describe("Tabby cancellation closure aliases", () => {
	it.each(["closed", "fully_captured", "partially_refunded", "fully_refunded", "canceled"])(
		"verifies %s locally without another closing POST",
		async (status) => {
			const captured = status === "canceled" ? 0 : 10000;
			const refunded =
				status === "fully_refunded" ? 10000 : status === "partially_refunded" ? 2500 : 0;
			const get = vi.fn(async () => ({
				...remote(),
				status: status as BnplOrderState["status"],
				capturedAmountMinor: captured,
				refundedAmountMinor: refunded,
				operations: undefined,
				raw: { status: "CLOSED" },
			}));
			const { row, cancel, post } = await setup(undefined, { id: "tabby", fetchOrder: get });
			Object.assign(row, { status, capturedAmountMinor: captured, refundedAmountMinor: refunded });
			expect((await cancel("", "")).error).toBeNull();
			expect(post).not.toHaveBeenCalled();
			expect(get).toHaveBeenCalledTimes(1);
			expect(row.status).toBe(status);
		},
	);
	it("keeps uncertain existing closure blocked without another POST", async () => {
		const { row, cancel, post } = await setup(undefined, {
			id: "tabby",
			fetchOrder: async () => ({
				...remote(),
				status: "authorised",
				raw: { status: "AUTHORIZED" },
			}),
		});
		row.status = "closed";
		expect((await cancel("", "")).error?.status).toBe(409);
		expect(post).not.toHaveBeenCalled();
	});
	it("rejects stale remote closure totals before completing the journal", async () => {
		const { row, cancel, post } = await setup(undefined, {
			id: "tabby",
			fetchOrder: async () => ({
				...remote(),
				status: "canceled",
				operations: undefined,
				raw: { status: "CLOSED" },
			}),
		});
		Object.assign(row, { status: "closed", capturedAmountMinor: 2500 });
		expect((await cancel("", "")).error?.status).toBe(409);
		expect(post).not.toHaveBeenCalled();
		expect(row.capturedAmountMinor).toBe(2500);
		expect(row.status).toBe("closed");
		expect(JSON.parse(String(row.moneyCommands))[0].state).toBe("pending");
	});
	it("checks financial freshness against the latest row during completion", async () => {
		const updateRow = () => {
			row.capturedAmountMinor = 2500;
		};
		const { row, cancel, post } = await setup(undefined, {
			id: "tabby",
			fetchOrder: async () => {
				updateRow();
				return {
					...remote(),
					status: "canceled",
					operations: undefined,
					raw: { status: "CLOSED" },
				};
			},
		});
		row.status = "closed";
		expect((await cancel("", "")).error?.status).toBe(409);
		expect(post).not.toHaveBeenCalled();
		expect(row.capturedAmountMinor).toBe(2500);
		expect(JSON.parse(String(row.moneyCommands))[0].state).toBe("pending");
	});
});
