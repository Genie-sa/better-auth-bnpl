import { describe, expect, it, vi } from "vitest";
import { bnpl } from "../plugin";
import { type CheckoutSubpluginOptions, checkout } from "../plugins/checkout";
import { makeBnplTestInstance, stubProvider } from "./_harness";

async function setup(options: CheckoutSubpluginOptions = {}, failProvider = false) {
	const createCheckout = vi.fn(async () => {
		if (failProvider) throw new Error("response lost after creation");
		return {
			providerOrderId: "recovery-order",
			providerCheckoutId: "recovery-session",
			checkoutUrl: "https://provider.example/checkout" as const,
			status: "new" as const,
			raw: {},
		};
	});
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { tabby: stubProvider("tabby", { createCheckout }) },
			persistOrders: true,
			use: [checkout(options)],
		}),
	]);
	const { headers } = await instance.signInWithTestUser();
	const post = (override: Record<string, unknown> = {}) =>
		instance.client.$fetch("/bnpl/checkout", {
			method: "POST",
			headers,
			body: {
				provider: "tabby",
				orderReferenceId: "recovery-ref",
				description: "Test",
				countryCode: "SA",
				buyer: {
					firstName: "Test",
					lastName: "Buyer",
					email: "buyer@example.test",
					phone: "+966500000001",
				},
				totalAmount: { amount: "100.00", currency: "SAR" },
				items: [
					{
						referenceId: "item",
						name: "Test",
						sku: "item",
						quantity: 1,
						totalAmount: { amount: "100.00", currency: "SAR" },
					},
				],
				...override,
			},
		});
	return { ...instance, post, createCheckout };
}

describe("persisted checkout recovery", () => {
	it("blocks concurrent delivery while the first checkout hook is running", async () => {
		let release!: () => void;
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const onCheckoutCreated = vi.fn(async () => {
			enter();
			if (onCheckoutCreated.mock.calls.length === 1) await gate;
		});
		const { post, createCheckout } = await setup({ onCheckoutCreated });
		const first = post();
		await entered;
		const second = await post();
		release();
		expect(second.error?.status).toBe(409);
		expect((await first).error).toBeNull();
		expect((await post()).error).toBeNull();
		expect(onCheckoutCreated).toHaveBeenCalledOnce();
		expect(createCheckout).toHaveBeenCalledOnce();
	});
	it("resumes an expired saved-result claim from the last hook checkpoint and rejects its stale owner", async () => {
		let release!: () => void;
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const onCheckoutCreated = vi.fn();
		const onOrderPersisted = vi.fn(async () => {
			enter();
			if (onOrderPersisted.mock.calls.length === 1) await gate;
		});
		const { post, createCheckout, db } = await setup({ onCheckoutCreated, onOrderPersisted });
		const first = post();
		await entered;
		const row = db.bnplOrder?.[0];
		expect(row).toBeDefined();
		if (!row) throw new Error("missing checkout reservation");
		const checkpoint = JSON.parse(row.checkoutAttempt as string);
		expect(checkpoint.createdHook).toBe(true);
		row.checkoutAttempt = JSON.stringify({ ...checkpoint, processingUntil: Date.now() - 1 });
		row.version = Number(row.version) + 1;
		const resumed = await post();
		release();
		expect(resumed.error).toBeNull();
		expect((await first).error?.status).toBe(409);
		expect(onCheckoutCreated).toHaveBeenCalledOnce();
		expect(onOrderPersisted).toHaveBeenCalledTimes(2);
		expect(createCheckout).toHaveBeenCalledOnce();
		const complete = JSON.parse(row.checkoutAttempt as string);
		expect(complete).toMatchObject({ createdHook: true, persistedHook: true });
		expect(complete.processingToken).toBeUndefined();
	});
	it("replays a completed checkout without creating another payment", async () => {
		const { post, createCheckout } = await setup();
		const first = await post();
		expect(first.error).toBeNull();
		expect((await post()).data).toEqual(first.data);
		expect(createCheckout).toHaveBeenCalledOnce();
	});
	it("blocks a retry after an uncertain provider result", async () => {
		const { post, createCheckout, db } = await setup({}, true);
		expect((await post()).error).not.toBeNull();
		expect((await post()).error?.status).toBe(409);
		expect(createCheckout).toHaveBeenCalledOnce();
		expect(db.bnplOrder).toHaveLength(1);
	});
	it("never reissues an uncertain provider checkout after its lease expires", async () => {
		const { post, createCheckout, db } = await setup({}, true);
		expect((await post()).error).not.toBeNull();
		const row = db.bnplOrder?.[0];
		if (!row) throw new Error("missing checkout reservation");
		row.checkoutAttempt = JSON.stringify({
			...JSON.parse(row.checkoutAttempt as string),
			processingUntil: Date.now() - 1,
		});
		row.version = Number(row.version) + 1;
		expect((await post()).error?.status).toBe(409);
		expect(createCheckout).toHaveBeenCalledOnce();
	});
	it("rejects changed input under the same reference before another provider call", async () => {
		const { post, createCheckout } = await setup();
		await post();
		expect((await post({ description: "Different purchase" })).error?.status).toBe(409);
		expect(createCheckout).toHaveBeenCalledOnce();
	});
	it("resumes a failed integration hook without another checkout or completed hook", async () => {
		const onCheckoutCreated = vi.fn();
		const onOrderPersisted = vi
			.fn()
			.mockRejectedValueOnce(new Error("integration offline"))
			.mockResolvedValue(undefined);
		const { post, createCheckout } = await setup({ onCheckoutCreated, onOrderPersisted });
		expect((await post()).error).not.toBeNull();
		expect((await post()).error).toBeNull();
		expect(createCheckout).toHaveBeenCalledOnce();
		expect(onCheckoutCreated).toHaveBeenCalledOnce();
		expect(onOrderPersisted).toHaveBeenCalledTimes(2);
	});
	it("does not repeat checkout when saving its accepted response fails", async () => {
		const { post, createCheckout, auth } = await setup();
		const adapter = (await auth.$context).adapter;
		vi.spyOn(adapter, "incrementOne").mockRejectedValue(new Error("commit unavailable"));
		expect((await post()).error).not.toBeNull();
		expect((await post()).error?.status).toBe(409);
		expect(createCheckout).toHaveBeenCalledOnce();
	});
	it("preserves lifecycle progress when a webhook beats the checkout response", async () => {
		const { post, createCheckout, db } = await setup();
		createCheckout.mockImplementationOnce(async () => {
			const row = db.bnplOrder?.[0];
			if (row)
				Object.assign(row, { status: "fully_captured", capturedAmountMinor: 10000, version: 1 });
			return {
				providerOrderId: "recovery-order",
				providerCheckoutId: "recovery-session",
				checkoutUrl: "https://provider.example/checkout" as const,
				status: "new",
				raw: {},
			};
		});
		expect((await post()).error).toBeNull();
		expect(db.bnplOrder?.[0]?.status).toBe("fully_captured");
	});
	it("replays equal nested metadata despite reordered object keys", async () => {
		const { post, createCheckout } = await setup();
		await post({ metadata: { one: 1, two: { a: 2, b: 3 } } });
		expect((await post({ metadata: { two: { b: 3, a: 2 }, one: 1 } })).error).toBeNull();
		expect(createCheckout).toHaveBeenCalledOnce();
	});

	it("rejects unsupported decimal precision before creating a provider order", async () => {
		const { post, createCheckout } = await setup();
		expect((await post({ totalAmount: { amount: "10.001", currency: "SAR" } })).error?.status).toBe(
			400,
		);
		expect(createCheckout).not.toHaveBeenCalled();
	});
	it("does not create a remote checkout when the initial database reservation fails", async () => {
		const { post, createCheckout, auth } = await setup();
		const adapter = (await auth.$context).adapter;
		const original = adapter.create.bind(adapter);
		vi.spyOn(adapter, "create").mockImplementation(async (args) => {
			if (args.model === "bnplOrder") throw new Error("database unavailable");
			return original(args);
		});
		expect((await post()).error).not.toBeNull();
		expect(createCheckout).not.toHaveBeenCalled();
	});
});
