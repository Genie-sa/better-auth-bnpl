import { describe, expect, it, vi } from "vitest";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { makeBnplTestInstance, stubProvider } from "./_harness";

async function setup() {
	const capture = vi.fn(async (_id, args) => ({
		providerOrderId: "bounds-order",
		captureId: "bounds-capture",
		amountMinor: Number(args.totalAmount.amount) * 100,
		raw: {},
	}));
	const refund = vi.fn(async (_id, args) => ({
		providerOrderId: "bounds-order",
		refundId: "bounds-refund",
		amountMinor: Number(args.totalAmount.amount) * 100,
		raw: {},
	}));
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { tabby: stubProvider("tabby", { capture, refund }) },
			persistOrders: true,
			use: [admin({ isAuthorized: () => true })],
		}),
	]);
	const row: Record<string, unknown> = {
		id: "bounds-row",
		provider: "tabby",
		providerOrderId: "bounds-order",
		orderReferenceId: "bounds-reference",
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
	const post = (operation: string, amount: string) =>
		instance.client.$fetch(`/bnpl/admin/orders/bounds-order/${operation}`, {
			method: "POST",
			headers,
			body: {
				totalAmount: { amount, currency: "SAR" },
				[operation === "capture" ? "merchantReferenceId" : "merchantRefundId"]: "bounds-command",
			},
		});
	return { capture, refund, instance, row, post };
}

describe("admin money reservation bounds", () => {
	it("rejects capture after partial payment closure without poisoning the refund journal", async () => {
		const { row, post, capture } = await setup();
		row.status = "closed";
		expect((await post("capture", "10.00")).error?.status).toBe(400);
		expect(capture).not.toHaveBeenCalled();
		expect(row.moneyCommands).toBeUndefined();
		expect((await post("refund", "10.00")).error).toBeNull();
	});

	it("fully captures the remaining funds after partial cancellation", async () => {
		const { row, post } = await setup();
		Object.assign(row, { capturedAmountMinor: 0, canceledAmountMinor: 2500, status: "authorised" });
		expect((await post("capture", "75.00")).error).toBeNull();
		expect(row).toMatchObject({
			capturedAmountMinor: 7500,
			canceledAmountMinor: 2500,
			status: "fully_captured",
		});
	});
	it("rejects capturing canceled funds before calling the provider", async () => {
		const { row, post, capture } = await setup();
		Object.assign(row, { capturedAmountMinor: 0, canceledAmountMinor: 2500, status: "authorised" });
		expect((await post("capture", "100.00")).error?.status).toBe(400);
		expect(capture).not.toHaveBeenCalled();
	});
	it.each(["capture", "refund"])(
		"rejects an oversized %s before issuing money upstream",
		async (operation) => {
			const { capture, refund, row, post } = await setup();
			expect((await post(operation, "60.00")).error?.status).toBe(400);
			expect(capture).not.toHaveBeenCalled();
			expect(refund).not.toHaveBeenCalled();
			expect(row.moneyCommands).toBeUndefined();
		},
	);
	it.each(["capture", "refund"])(
		"replays a completed %s after its available balance reaches zero",
		async (operation) => {
			const { capture, refund, row, post } = await setup();
			const first = await post(operation, "50.00");
			expect(first.error).toBeNull();
			const replay = await post(operation, "50.00");
			expect(replay.error).toBeNull();
			expect(replay.data).toEqual(first.data);
			expect(operation === "capture" ? capture : refund).toHaveBeenCalledOnce();
			expect(row[operation === "capture" ? "capturedAmountMinor" : "refundedAmountMinor"]).toBe(
				operation === "capture" ? 10000 : 5000,
			);
		},
	);
	it("uses the latest balance when another write commits after the initial order read", async () => {
		const { capture, instance, row, post } = await setup();
		const adapter = (await instance.auth.$context).adapter;
		const original = adapter.findOne.bind(adapter);
		let changed = false;
		vi.spyOn(adapter, "findOne").mockImplementation(async (args) => {
			const result = await original(args);
			if (args.model === "bnplOrder" && !changed) {
				changed = true;
				Object.assign(row, { capturedAmountMinor: 9500, version: 1 });
			}
			return result;
		});
		expect((await post("capture", "10.00")).error?.status).toBe(400);
		expect(capture).not.toHaveBeenCalled();
		expect(row.capturedAmountMinor).toBe(9500);
	});
});
