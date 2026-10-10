import { describe, expect, it, vi } from "vitest";
import type { BnplProvider } from "../core/provider";
import type { BnplOrderState } from "../core/types";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { makeBnplTestInstance, stubProvider } from "./_harness";

const orderId = "lifecycle-order";
function snapshot(
	status: BnplOrderState["status"],
	overrides: Partial<BnplOrderState> = {},
): BnplOrderState {
	return {
		providerOrderId: orderId,
		status,
		totalAmount: { amount: "100.00", currency: "SAR" },
		capturedAmountMinor: 0,
		refundedAmountMinor: 0,
		operations: [],
		raw: { status: status === "closed" ? "CLOSED" : "AUTHORIZED" },
		...overrides,
	};
}
async function setup(overrides: Partial<BnplProvider>) {
	const base = stubProvider("tabby");
	const provider = stubProvider("tabby", {
		capabilities: { ...base.capabilities, voidCheckout: true, closePayment: true },
		...overrides,
	});
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { tabby: provider },
			persistOrders: true,
			use: [admin({ isAuthorized: () => true })],
		}),
	]);
	const row = {
		id: "lifecycle-row",
		provider: "tabby",
		providerOrderId: orderId,
		providerCheckoutId: "lifecycle-checkout",
		orderReferenceId: "lifecycle-reference",
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
	const post = (operation: "void" | "close", body: Record<string, unknown> = {}) =>
		instance.client.$fetch(`/bnpl/admin/orders/${orderId}/${operation}`, {
			method: "POST",
			headers,
			...(operation === "void" ? { body } : {}),
		});
	return { row, post, instance };
}
describe("durable void and close commands", () => {
	it("accepts the documented successful void with verified positive captured funds", async () => {
		const voidCheckout = vi.fn(async () => ({
			voided: true,
			capturedCurrency: "SAR" as const,
			capturedAmountMinor: 10000,
			raw: { order_was_voided: true, captured_amount: { amount: 100, currency: "SAR" } },
		}));
		const { post, row } = await setup({
			voidCheckout,
			fetchOrder: async () =>
				snapshot("fully_captured", {
					capturedAmountMinor: 10000,
					operations: [{ id: "void-paid", kind: "captured", amountMinor: 10000, currency: "SAR" }],
				}),
		});
		expect((await post("void")).data).toMatchObject({ voided: true, capturedAmountMinor: 10000 });
		expect(row).toMatchObject({
			status: "fully_captured",
			capturedAmountMinor: 10000,
			canceledAmountMinor: 0,
		});
	});
	it("rejects a known void capture amount differing from GET history", async () => {
		const { post, row } = await setup({
			voidCheckout: async () => ({
				voided: true,
				capturedAmountMinor: 5000,
				capturedCurrency: "SAR",
				raw: {},
			}),
			fetchOrder: async () =>
				snapshot("fully_captured", {
					capturedAmountMinor: 10000,
					operations: [{ id: "mismatch", kind: "captured", amountMinor: 10000, currency: "SAR" }],
				}),
		});
		expect((await post("void")).error).toBeTruthy();
		expect(row.capturedAmountMinor).toBe(0);
	});
	it.each(["void", "close"] as const)(
		"rejects %s completion from a GET snapshot older than the latest local money",
		async (operation) => {
			const state: { row?: Record<string, unknown> } = {};
			const mutation = async () => {
				Object.assign(state.row ?? {}, {
					status: "fully_captured",
					capturedAmountMinor: 10000,
					version: 2,
				});
				return {
					voided: true,
					capturedAmountMinor: 1000,
					capturedCurrency: "SAR" as const,
					raw: {},
				};
			};
			const { post, row } = await setup({
				voidCheckout: mutation,
				closePayment: async () => {
					await mutation();
				},
				fetchOrder: async () =>
					snapshot(operation === "void" ? "partially_captured" : "closed", {
						capturedAmountMinor: 1000,
						operations: [{ id: "older", kind: "captured", amountMinor: 1000, currency: "SAR" }],
					}),
			});
			state.row = row;
			expect((await post(operation)).error).toBeTruthy();
			expect(row).toMatchObject({ status: "fully_captured", capturedAmountMinor: 10000 });
		},
	);
	it.each(["fully_captured", "canceled"] as const)(
		"verifies already closed %s payments without another close POST",
		async (status) => {
			const closePayment = vi.fn(async () => {
				throw new Error("must not POST already closed");
			});
			const capture = status === "fully_captured";
			const { post, row } = await setup({
				closePayment,
				fetchOrder: async () =>
					snapshot(status, {
						capturedAmountMinor: capture ? 10000 : 0,
						canceledAmountMinor: capture ? 0 : 10000,
						raw: { status: "CLOSED" },
						operations: [
							{
								id: "alias",
								kind: capture ? "captured" : "canceled",
								amountMinor: 10000,
								currency: "SAR",
							},
						],
					}),
			});
			Object.assign(row, {
				status,
				capturedAmountMinor: capture ? 10000 : 0,
				canceledAmountMinor: capture ? 0 : 10000,
			});
			expect((await post("close")).error).toBeNull();
			expect(closePayment).not.toHaveBeenCalled();
		},
	);
	it("keeps terminal close retries GET-only while the provider has not confirmed closure", async () => {
		const closePayment = vi.fn(async () => undefined);
		const { post, row } = await setup({
			closePayment,
			fetchOrder: async () =>
				snapshot("fully_captured", {
					capturedAmountMinor: 10000,
					operations: [{ id: "unclosed", kind: "captured", amountMinor: 10000, currency: "SAR" }],
				}),
		});
		Object.assign(row, { status: "fully_captured", capturedAmountMinor: 10000 });
		expect((await post("close")).error?.status).toBe(409);
		expect((await post("close")).error?.status).toBe(409);
		expect(closePayment).not.toHaveBeenCalled();
	});
	it("rejects a supplied checkout ID belonging to another checkout before POST", async () => {
		const voidCheckout = vi.fn(async () => undefined);
		const { post } = await setup({ voidCheckout, fetchOrder: async () => snapshot("expired") });
		expect((await post("void", { checkoutId: "another-checkout" })).error?.status).toBe(400);
		expect(voidCheckout).not.toHaveBeenCalled();
	});
	it("accepts an explicit checkout ID when the persisted order lacks one", async () => {
		const voidCheckout = vi.fn(async () => undefined);
		const { post, row } = await setup({
			voidCheckout,
			fetchOrder: async () => snapshot("expired"),
		});
		Reflect.deleteProperty(row, "providerCheckoutId");
		expect((await post("void", { checkoutId: "recovered-checkout" })).error).toBeNull();
		expect(voidCheckout).toHaveBeenCalledWith("recovered-checkout", orderId, expect.anything());
	});
	it.each(["void", "close"] as const)(
		"shares one %s mutation between concurrent workers",
		async (operation) => {
			let release!: () => void;
			let enter!: () => void;
			let finished = false;
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const mutation = vi.fn(async () => {
				enter();
				if (mutation.mock.calls.length === 1) await gate;
				finished = true;
			});
			const { post } = await setup({
				voidCheckout: mutation,
				closePayment: mutation,
				fetchOrder: async () =>
					snapshot(finished ? (operation === "void" ? "expired" : "closed") : "authorised"),
			});
			const first = post(operation);
			await entered;
			const second = await post(operation);
			release();
			expect(second.error?.status).toBe(409);
			expect((await first).error).toBeNull();
			expect(mutation).toHaveBeenCalledOnce();
		},
	);
	it.each([
		snapshot("canceled", {
			canceledAmountMinor: 10000,
			raw: { status: "CLOSED" },
			operations: [
				{ id: "closed-remainder", kind: "canceled", amountMinor: 10000, currency: "SAR" },
			],
		}),
		snapshot("fully_captured", {
			capturedAmountMinor: 10000,
			raw: { status: "CLOSED" },
			operations: [{ id: "closed-capture", kind: "captured", amountMinor: 10000, currency: "SAR" }],
		}),
	])("preserves closed provider snapshot canonical status %s", async (remote) => {
		const closePayment = vi.fn(async () => undefined);
		const { post, row } = await setup({ closePayment, fetchOrder: async () => remote });
		expect((await post("close")).error).toBeNull();
		expect(row.status).toBe(remote.status);
		expect(row.capturedAmountMinor).toBe(remote.capturedAmountMinor);
		expect(row.canceledAmountMinor).toBe(remote.canceledAmountMinor ?? 0);
	});
	it.each(["void", "close"] as const)(
		"never reissues uncertain %s while GET remains authorised",
		async (operation) => {
			const mutation = vi.fn(async () => {
				throw new Error("response timed out");
			});
			const { post } = await setup({
				voidCheckout: mutation,
				closePayment: mutation,
				fetchOrder: async () => snapshot("authorised"),
			});
			expect((await post(operation)).error).toBeTruthy();
			expect((await post(operation)).error?.status).toBe(409);
			expect(mutation).toHaveBeenCalledOnce();
		},
	);
	it.each(["void", "close"] as const)(
		"recovers %s after confirmed result cannot be committed locally",
		async (operation) => {
			const mutation = vi.fn(async () => undefined);
			const { post, instance } = await setup({
				voidCheckout: mutation,
				closePayment: mutation,
				fetchOrder: async () => snapshot(operation === "void" ? "expired" : "closed"),
			});
			const adapter = (await instance.auth.$context).adapter;
			const original = adapter.incrementOne.bind(adapter);
			let failed = false;
			vi.spyOn(adapter, "incrementOne").mockImplementation(async (args) => {
				if (
					!failed &&
					typeof args.set?.moneyCommands === "string" &&
					JSON.parse(args.set.moneyCommands).some(
						(entry: { state: string }) => entry.state === "completed",
					)
				) {
					failed = true;
					throw new Error("database commit unavailable");
				}
				return original(args);
			});
			expect((await post(operation)).error).toBeTruthy();
			expect((await post(operation)).error).toBeNull();
			expect((await post(operation)).error).toBeNull();
			expect(mutation).toHaveBeenCalledOnce();
		},
	);
	it("does not mistake a terminal paid order for a successful void", async () => {
		const voidCheckout = vi.fn(async () => {
			throw new Error("response timed out");
		});
		const { post, row } = await setup({
			voidCheckout,
			fetchOrder: async () =>
				snapshot("expired", {
					capturedAmountMinor: 10000,
					operations: [{ id: "paid", kind: "captured", amountMinor: 10000, currency: "SAR" }],
				}),
		});
		expect((await post("void")).error).toBeTruthy();
		expect((await post("void")).error?.status).toBe(409);
		expect(voidCheckout).toHaveBeenCalledOnce();
		expect(row.status).toBe("authorised");
	});
	it("caches an explicit unsuccessful void and preserves the original status", async () => {
		const voidCheckout = vi.fn(async () => ({ voided: false, capturedAmountMinor: 1000, raw: {} }));
		const fetchOrder = vi.fn(async () => snapshot("fully_captured"));
		const { post, row } = await setup({ voidCheckout, fetchOrder });
		expect((await post("void")).data).toMatchObject({ voided: false });
		expect((await post("void")).data).toMatchObject({ voided: false });
		expect(voidCheckout).toHaveBeenCalledOnce();
		expect(fetchOrder).not.toHaveBeenCalled();
		expect(row.status).toBe("authorised");
	});
	it.each([
		snapshot("closed", { providerOrderId: "another-order" }),
		snapshot("closed", { totalAmount: { amount: "99.00", currency: "SAR" } }),
		snapshot("fully_captured", {
			capturedAmountMinor: 10000,
			operations: undefined,
			raw: { status: "CLOSED" },
		}),
	])("does not complete close from malformed GET %j", async (remote) => {
		const closePayment = vi.fn(async () => undefined);
		const { post, row } = await setup({ closePayment, fetchOrder: async () => remote });
		expect((await post("close")).error).toBeTruthy();
		expect((await post("close")).error).toBeTruthy();
		expect(closePayment).toHaveBeenCalledOnce();
		expect(row).toMatchObject({ status: "authorised", capturedAmountMinor: 0 });
	});
	it("does not guess closure from captured totals without a provider closed lifecycle", async () => {
		const closePayment = vi.fn(async () => undefined);
		const { post } = await setup({
			closePayment,
			fetchOrder: async () =>
				snapshot("fully_captured", {
					capturedAmountMinor: 10000,
					operations: [{ id: "capture", kind: "captured", amountMinor: 10000, currency: "SAR" }],
				}),
		});
		expect((await post("close")).error?.status).toBe(409);
		expect((await post("close")).error?.status).toBe(409);
		expect(closePayment).toHaveBeenCalledOnce();
	});
	it("preserves refund status when confirmed close imports complete native history", async () => {
		const state: { row?: Record<string, unknown> } = {};
		const { post, row } = await setup({
			closePayment: async () => {
				Object.assign(state.row ?? {}, {
					capturedAmountMinor: 10000,
					refundedAmountMinor: 2500,
					status: "partially_refunded",
					version: 2,
				});
			},
			fetchOrder: async () =>
				snapshot("partially_refunded", {
					capturedAmountMinor: 10000,
					refundedAmountMinor: 2500,
					raw: { status: "CLOSED" },
					operations: [
						{ id: "capture", kind: "captured", amountMinor: 10000, currency: "SAR" },
						{ id: "refund", kind: "refunded", amountMinor: 2500, currency: "SAR" },
					],
				}),
		});
		state.row = row;
		expect((await post("close")).error).toBeNull();
		expect(row).toMatchObject({
			status: "partially_refunded",
			capturedAmountMinor: 10000,
			refundedAmountMinor: 2500,
		});
	});
});

describe("void response currency corroboration", () => {
	it.each(["AED", undefined] as const)(
		"cannot prove a paid void from currency %s against a SAR order",
		async (capturedCurrency) => {
			const voidCheckout = vi.fn(async () => ({
				voided: true,
				capturedAmountMinor: 10000,
				capturedCurrency,
				raw: {},
			}));
			const { post, row } = await setup({
				voidCheckout,
				fetchOrder: async () =>
					snapshot("fully_captured", {
						capturedAmountMinor: 10000,
						operations: [
							{ id: "paid-currency", kind: "captured", amountMinor: 10000, currency: "SAR" },
						],
					}),
			});
			expect((await post("void")).error).toBeTruthy();
			expect((await post("void")).error?.status).toBe(409);
			expect(voidCheckout).toHaveBeenCalledTimes(1);
			expect(row.capturedAmountMinor).toBe(0);
			expect(JSON.parse(String(Reflect.get(row, "moneyCommands")))[0].state).toBe("pending");
		},
	);
	it("rejects a mismatching currency before caching an unsuccessful void", async () => {
		const voidCheckout = vi.fn(async () => ({
			voided: false,
			capturedAmountMinor: 10000,
			capturedCurrency: "AED" as const,
			raw: {},
		}));
		const { post, row } = await setup({
			voidCheckout,
			fetchOrder: async () =>
				snapshot("fully_captured", {
					capturedAmountMinor: 10000,
					operations: [
						{ id: "false-currency", kind: "captured", amountMinor: 10000, currency: "SAR" },
					],
				}),
		});
		expect((await post("void")).error).toBeTruthy();
		expect((await post("void")).error?.status).toBe(409);
		expect(voidCheckout).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(Reflect.get(row, "moneyCommands")))[0].state).toBe("pending");
	});
	it("allows a legacy amount without currency only with a strictly unpaid terminal snapshot", async () => {
		const { post, row } = await setup({
			voidCheckout: async () => ({ voided: true, capturedAmountMinor: 1000, raw: {} }),
			fetchOrder: async () => snapshot("expired"),
		});
		expect((await post("void")).error).toBeNull();
		expect(row.capturedAmountMinor).toBe(0);
		expect(row.status).toBe("expired");
	});
});
