import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	type BnplAdminReconcileResult,
	type BnplClientError,
	type BnplClientFetch,
	type BnplClientResponse,
	type BnplStartCheckoutResult,
	bnplClient,
} from "../client";
import type { BnplProvider } from "../core/provider";
import type {
	BnplCaptureResult,
	BnplPersistedOrder,
	BnplPersistedOrderWithRemote,
} from "../core/types";
type CustomProviders = {
	custom: BnplProvider<"custom">;
};
const OK = <T>(body: T): BnplClientResponse<T> => ({ data: body, error: null });
const FAIL = (error: BnplClientError): BnplClientResponse<never> => ({ data: null, error });
function recordingFetch(response: BnplClientResponse<unknown> = OK(null)): {
	fetch: BnplClientFetch;
	calls: Array<{
		url: string;
		opts?: object;
	}>;
} {
	const calls: Array<{
		url: string;
		opts?: object;
	}> = [];
	const fetch: BnplClientFetch = async <T>(url: string, opts?: object) => {
		calls.push({ url, opts });
		return response as BnplClientResponse<T>;
	};
	return { fetch, calls };
}
afterEach(() => {
	vi.unstubAllGlobals();
});
describe("bnplClient()", () => {
	it("accepts either a provider map or provider-id union for narrowing", () => {
		type FromProviderMap = ReturnType<ReturnType<typeof bnplClient<CustomProviders>>["getActions"]>;
		type FromProviderIds = ReturnType<ReturnType<typeof bnplClient<"custom">>["getActions"]>;
		const { fetch } = recordingFetch();
		const actions = bnplClient<"custom">().getActions(fetch);
		const orderPromise = actions.bnpl.getOrder("ord_1");
		const orderByReferencePromise = actions.bnpl.getOrderByReferenceId("ref_1");
		const listPromise = actions.bnpl.listOrders();
		const capturePromise = actions.bnpl.admin.capture("ord_1", {
			totalAmount: { amount: "100.00", currency: "SAR" },
		});
		const reconcilePromise = actions.bnpl.admin.reconcile("ord_1");
		expectTypeOf<Parameters<FromProviderMap["bnpl"]["provider"]>[0]>().toEqualTypeOf<"custom">();
		expectTypeOf<Parameters<FromProviderIds["bnpl"]["provider"]>[0]>().toEqualTypeOf<"custom">();
		expectTypeOf<Parameters<FromProviderIds["bnpl"]["startCheckout"]>[0]>().toMatchTypeOf<{
			provider: "custom";
		}>();
		expectTypeOf<Awaited<typeof orderPromise>>().toEqualTypeOf<
			BnplClientResponse<BnplPersistedOrderWithRemote>
		>();
		expectTypeOf<Awaited<typeof orderByReferencePromise>>().toEqualTypeOf<
			BnplClientResponse<BnplPersistedOrder>
		>();
		expectTypeOf<Awaited<typeof listPromise>>().toEqualTypeOf<
			BnplClientResponse<{
				orders: BnplPersistedOrder[];
			}>
		>();
		expectTypeOf<Awaited<typeof capturePromise>>().toEqualTypeOf<
			BnplClientResponse<BnplCaptureResult>
		>();
		expectTypeOf<Awaited<typeof reconcilePromise>>().toEqualTypeOf<
			BnplClientResponse<BnplAdminReconcileResult>
		>();
	});
	it("only exposes built-in shortcut namespaces for configured providers", () => {
		type TamaraOnly = ReturnType<ReturnType<typeof bnplClient<"tamara">>["getActions"]>;
		type TabbyOnly = ReturnType<ReturnType<typeof bnplClient<"tabby">>["getActions"]>;
		type Both = ReturnType<ReturnType<typeof bnplClient<"tamara" | "tabby">>["getActions"]>;
		expectTypeOf<TamaraOnly["bnpl"]>().toHaveProperty("tamara");
		expectTypeOf<TamaraOnly["bnpl"]>().not.toHaveProperty("tabby");
		expectTypeOf<TabbyOnly["bnpl"]>().toHaveProperty("tabby");
		expectTypeOf<TabbyOnly["bnpl"]>().not.toHaveProperty("tamara");
		expectTypeOf<Both["bnpl"]>().toHaveProperty("tamara");
		expectTypeOf<Both["bnpl"]>().toHaveProperty("tabby");
		expectTypeOf<Parameters<Both["bnpl"]["startCheckout"]>[0]>().toMatchTypeOf<{
			provider: "tamara" | "tabby";
		}>();
		expectTypeOf<Parameters<Both["bnpl"]["provider"]>[0]>().toEqualTypeOf<"tamara" | "tabby">();
	});
	it("wires $InferServerPlugin to the umbrella plugin", () => {
		const plugin = bnplClient<"tamara" | "tabby">();
		expect(plugin.id).toBe("bnpl-client");
		expectTypeOf<(typeof plugin)["$InferServerPlugin"]>().toHaveProperty("id");
		expectTypeOf<(typeof plugin)["$InferServerPlugin"]>().toHaveProperty("endpoints");
	});
});
describe("bnplClient() { data, error } convention", () => {
	it("returns { data } on success and does not reject", async () => {
		const checkoutResult: BnplStartCheckoutResult = {
			provider: "tamara",
			providerOrderId: "ord_1",
			providerCheckoutId: "chk_1",
			checkoutUrl: "https://tamara.example/co",
			status: "new",
			orderReferenceId: "ref_1",
		};
		const { fetch } = recordingFetch(OK(checkoutResult));
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		const { data, error } = await actions.bnpl.startCheckout(
			{
				provider: "tamara",
				description: "x",
				countryCode: "SA",
				shippingAddress: { line1: "King Fahd Rd", city: "Riyadh", countryCode: "SA" },
			},
			{ redirect: false },
		);
		expect(error).toBeNull();
		expect(data).toEqual(checkoutResult);
	});
	it("passes through the server error code and status without throwing", async () => {
		const { fetch } = recordingFetch(
			FAIL({
				code: "CHECKOUT_REJECTED",
				message: "Provider rejected this checkout",
				status: 422,
				statusText: "Unprocessable Entity",
			}),
		);
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		const { data, error } = await actions.bnpl.startCheckout(
			{
				provider: "tabby",
				description: "x",
				countryCode: "SA",
				shippingAddress: { line1: "King Fahd Rd", city: "Riyadh", countryCode: "SA" },
			},
			{ redirect: false },
		);
		expect(data).toBeNull();
		expect(error?.code).toBe("CHECKOUT_REJECTED");
		expect(error?.status).toBe(422);
		if (error?.code === "CHECKOUT_REJECTED") {
			expect(error.message).toContain("rejected");
		} else {
			throw new Error("expected CHECKOUT_REJECTED");
		}
	});
	it("surfaces errors from provider-namespaced and admin actions too", async () => {
		const { fetch } = recordingFetch(
			FAIL({ code: "PROVIDER_NOT_CONFIGURED", status: 400, statusText: "Bad Request" }),
		);
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		const namespaced = await actions.bnpl.provider("tamara").startCheckout(
			{
				description: "x",
				countryCode: "SA",
				shippingAddress: { line1: "a", city: "b", countryCode: "SA" },
			},
			{ redirect: false },
		);
		expect(namespaced.data).toBeNull();
		expect(namespaced.error?.code).toBe("PROVIDER_NOT_CONFIGURED");
		const captured = await actions.bnpl.admin.capture("ord_1", {
			totalAmount: { amount: "100.00", currency: "SAR" },
		});
		expect(captured.data).toBeNull();
		expect(captured.error?.status).toBe(400);
	});
});
describe("bnplClient() browser redirect", () => {
	it("redirects only when data is present and checkoutUrl is set", async () => {
		const location = { href: "" };
		vi.stubGlobal("window", { location });
		const { fetch } = recordingFetch(
			OK<BnplStartCheckoutResult>({
				provider: "tamara",
				providerOrderId: "ord_1",
				providerCheckoutId: "chk_1",
				checkoutUrl: "https://tamara.example/co/redirect",
				status: "new",
				orderReferenceId: "ref_1",
			}),
		);
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		await actions.bnpl.startCheckout({
			provider: "tamara",
			description: "x",
			countryCode: "SA",
			shippingAddress: { line1: "a", city: "b", countryCode: "SA" },
		});
		expect(location.href).toBe("https://tamara.example/co/redirect");
	});
	it("does not redirect when the call errored", async () => {
		const location = { href: "" };
		vi.stubGlobal("window", { location });
		const { fetch } = recordingFetch(
			FAIL({ code: "CHECKOUT_REJECTED", status: 422, statusText: "Unprocessable Entity" }),
		);
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		await actions.bnpl.startCheckout({
			provider: "tamara",
			description: "x",
			countryCode: "SA",
			shippingAddress: { line1: "a", city: "b", countryCode: "SA" },
		});
		expect(location.href).toBe("");
	});
	it("does not redirect when redirect: false even with data", async () => {
		const location = { href: "" };
		vi.stubGlobal("window", { location });
		const { fetch } = recordingFetch(
			OK<BnplStartCheckoutResult>({
				provider: "tabby",
				providerOrderId: "ord_1",
				providerCheckoutId: "chk_1",
				checkoutUrl: "https://tabby.example/co",
				status: "new",
				orderReferenceId: "ref_1",
			}),
		);
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		await actions.bnpl.tabby.startCheckout(
			{
				description: "x",
				countryCode: "SA",
				shippingAddress: { line1: "a", city: "b", countryCode: "SA" },
			},
			{ redirect: false },
		);
		expect(location.href).toBe("");
	});
});
describe("bnplClient() endpoint contract", () => {
	it("starts checkout through the provider-agnostic namespace", async () => {
		const { fetch, calls } = recordingFetch(
			FAIL({ code: "PROVIDER_NOT_CONFIGURED", status: 400, statusText: "Bad Request" }),
		);
		const actions = bnplClient<CustomProviders>().getActions(fetch);
		const res = await actions.bnpl.provider("custom").startCheckout(
			{
				description: "Custom provider checkout",
				countryCode: "SA",
				shippingAddress: { line1: "King Fahd Rd", city: "Riyadh", countryCode: "SA" },
			},
			{ redirect: false },
		);
		expect(res.error?.code).toBe("PROVIDER_NOT_CONFIGURED");
		expect(calls).toEqual([
			{
				url: "/bnpl/checkout",
				opts: {
					method: "POST",
					body: {
						provider: "custom",
						description: "Custom provider checkout",
						countryCode: "SA",
						shippingAddress: {
							line1: "King Fahd Rd",
							city: "Riyadh",
							countryCode: "SA",
						},
					},
				},
			},
		]);
	});
	it("wraps admin endpoints with typed client methods", async () => {
		const { fetch, calls } = recordingFetch(
			FAIL({ code: "CAPTURE_FAILED", status: 502, statusText: "Bad Gateway" }),
		);
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		const capture = await actions.bnpl.admin.capture("ord/1", {
			totalAmount: { amount: "450", currency: "SAR" },
			merchantReferenceId: "capture:ord/1:shipment-1",
			shippingInfo: {
				shippedAt: "2026-06-04T20:00:00.000Z",
				shippingCompany: "Aramex",
				trackingNumber: "TRK123",
			},
		});
		expect(capture.error?.code).toBe("CAPTURE_FAILED");
		await actions.bnpl.admin.refund("ord/1", {
			totalAmount: { amount: "100", currency: "SAR" },
			merchantRefundId: "refund:ord/1:rma-1",
			comment: "Customer returned item",
		});
		await actions.bnpl.admin.reconcile("ord/1");
		expect(calls).toEqual([
			{
				url: "/bnpl/admin/orders/ord%2F1/capture",
				opts: {
					method: "POST",
					body: {
						totalAmount: { amount: "450", currency: "SAR" },
						merchantReferenceId: "capture:ord/1:shipment-1",
						shippingInfo: {
							shippedAt: "2026-06-04T20:00:00.000Z",
							shippingCompany: "Aramex",
							trackingNumber: "TRK123",
						},
					},
				},
			},
			{
				url: "/bnpl/admin/orders/ord%2F1/refund",
				opts: {
					method: "POST",
					body: {
						totalAmount: { amount: "100", currency: "SAR" },
						merchantRefundId: "refund:ord/1:rma-1",
						comment: "Customer returned item",
					},
				},
			},
			{
				url: "/bnpl/admin/orders/ord%2F1/reconcile",
				opts: {
					method: "POST",
					body: undefined,
				},
			},
		]);
	});
	it("wraps every client action with the expected endpoint contract", async () => {
		const calls: Array<{
			url: string;
			opts?: object;
		}> = [];
		const data = <T>(body: unknown): BnplClientResponse<T> => ({
			data: body as T,
			error: null,
		});
		const fetch: BnplClientFetch = async <T>(url: string, opts?: object) => {
			calls.push({ url, opts });
			if (url === "/bnpl/options") {
				return data<T>({ options: [], available: [], unavailable: [] });
			}
			if (url === "/bnpl/checkout") {
				const provider =
					typeof opts === "object" &&
					opts !== null &&
					"body" in opts &&
					typeof opts.body === "object" &&
					opts.body !== null &&
					"provider" in opts.body &&
					typeof opts.body.provider === "string"
						? opts.body.provider
						: "tamara";
				return data<T>({
					provider,
					providerOrderId: `${provider}-order`,
					providerCheckoutId: `${provider}-checkout`,
					checkoutUrl: `https://${provider}.example/checkout`,
					status: "new",
					orderReferenceId: `ref-${provider}`,
				});
			}
			if (url === "/bnpl/orders") {
				return data<T>({ orders: [] });
			}
			if (url.includes("/reconcile")) {
				return data<T>({
					synced: true,
					order: {
						providerOrderId: "ord/1",
						status: "authorised",
						totalAmount: { amount: "100.00", currency: "SAR" },
						capturedAmountMinor: 0,
						refundedAmountMinor: 0,
						raw: {},
					},
				});
			}
			if (url.includes("/capture")) {
				return data<T>({
					captureId: "cap_1",
					providerOrderId: "ord/1",
					amountMinor: 10000,
					raw: {},
				});
			}
			if (url.includes("/refund")) {
				return data<T>({
					refundId: "ref_1",
					providerOrderId: "ord/1",
					amountMinor: 10000,
					raw: {},
				});
			}
			if (url.includes("/cancel")) {
				return data<T>({ orderId: "ord/1", status: "canceled" });
			}
			if (url.includes("/authorise")) {
				return data<T>({ orderId: "ord/1", status: "authorised", already: true });
			}
			if (url.includes("/void")) {
				return data<T>({ orderId: "ord/1", voided: true });
			}
			if (url.includes("/close")) {
				return data<T>({ orderId: "ord/1", closed: true });
			}
			return data<T>({
				id: "row_1",
				provider: "tamara",
				providerOrderId: "ord/1",
				orderReferenceId: "ref/1",
				status: "new",
			});
		};
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		const optionsRes = await actions.bnpl.options({
			country: "SA",
			amount: { amount: "100.00", currency: "SAR" },
			email: "buyer@example.test",
			phone: "+966500000000",
		});
		expect(optionsRes.error).toBeNull();
		expect(optionsRes.data).toEqual({ options: [], available: [], unavailable: [] });
		const checkoutRes = await actions.bnpl.startCheckout(
			{
				provider: "tamara",
				orderReferenceId: "ref-tamara",
				description: "Tamara",
				countryCode: "SA",
				shippingAddress: { line1: "King Fahd Road", city: "Riyadh", countryCode: "SA" },
			},
			{ redirect: false },
		);
		expect(checkoutRes.data?.providerOrderId).toBe("tamara-order");
		await actions.bnpl.tabby.startCheckout(
			{
				orderReferenceId: "ref-tabby",
				description: "Tabby",
				countryCode: "SA",
				shippingAddress: { line1: "King Fahd Road", city: "Riyadh", countryCode: "SA" },
			},
			{ redirect: false },
		);
		await actions.bnpl.provider("tamara").startCheckout(
			{
				orderReferenceId: "ref-provider",
				description: "Provider namespace",
				countryCode: "SA",
				shippingAddress: { line1: "King Fahd Road", city: "Riyadh", countryCode: "SA" },
			},
			{ redirect: false },
		);
		const orderRes = await actions.bnpl.getOrder("ord/1");
		expect(orderRes.data).toMatchObject({ providerOrderId: "ord/1" });
		await actions.bnpl.getOrderByReferenceId("ref/1");
		const listRes = await actions.bnpl.listOrders({ provider: "tamara", limit: 10, offset: 0 });
		expect(listRes.data?.orders).toEqual([]);
		await actions.bnpl.admin.capture("ord/1", {
			totalAmount: { amount: "100.00", currency: "SAR" },
		});
		await actions.bnpl.admin.refund("ord/1", {
			totalAmount: { amount: "100.00", currency: "SAR" },
		});
		await actions.bnpl.admin.cancel("ord/1", {
			totalAmount: { amount: "100.00", currency: "SAR" },
		});
		await actions.bnpl.admin.authorise("ord/1");
		await actions.bnpl.admin.reconcile("ord/1");
		await actions.bnpl.admin.void("ord/1", { checkoutId: "chk/1" });
		await actions.bnpl.admin.close("ord/1");
		expect(calls).toMatchObject([
			{ url: "/bnpl/options", opts: { method: "POST" } },
			{ url: "/bnpl/checkout", opts: { method: "POST", body: { provider: "tamara" } } },
			{ url: "/bnpl/checkout", opts: { method: "POST", body: { provider: "tabby" } } },
			{ url: "/bnpl/checkout", opts: { method: "POST", body: { provider: "tamara" } } },
			{ url: "/bnpl/orders/ord%2F1", opts: { method: "GET" } },
			{ url: "/bnpl/orders/reference-id/ref%2F1", opts: { method: "GET" } },
			{
				url: "/bnpl/orders",
				opts: { method: "GET", query: { provider: "tamara", limit: 10, offset: 0 } },
			},
			{ url: "/bnpl/admin/orders/ord%2F1/capture", opts: { method: "POST" } },
			{ url: "/bnpl/admin/orders/ord%2F1/refund", opts: { method: "POST" } },
			{ url: "/bnpl/admin/orders/ord%2F1/cancel", opts: { method: "POST" } },
			{ url: "/bnpl/admin/orders/ord%2F1/authorise", opts: { method: "POST" } },
			{ url: "/bnpl/admin/orders/ord%2F1/reconcile", opts: { method: "POST" } },
			{ url: "/bnpl/admin/orders/ord%2F1/void", opts: { method: "POST" } },
			{ url: "/bnpl/admin/orders/ord%2F1/close", opts: { method: "POST" } },
		]);
	});
});
describe("bnplClient() admin list + webhook redelivery helpers", () => {
	it("serializes admin.listOrders as a GET with query", async () => {
		const { fetch, calls } = recordingFetch(OK({ orders: [] }));
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		const res = await actions.bnpl.admin.listOrders({
			status: "partially_captured",
			provider: "tamara",
			userId: "user_1",
			limit: 50,
			offset: 20,
		});
		expect(res.error).toBeNull();
		expect(calls).toEqual([
			{
				url: "/bnpl/admin/orders",
				opts: {
					method: "GET",
					query: {
						status: "partially_captured",
						provider: "tamara",
						userId: "user_1",
						limit: 50,
						offset: 20,
					},
				},
			},
		]);
	});
	it("serializes admin.listWebhookEvents as a GET with query", async () => {
		const { fetch, calls } = recordingFetch(OK({ events: [] }));
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		await actions.bnpl.admin.listWebhookEvents({
			status: "failed",
			provider: "tabby",
			providerOrderId: "ord_1",
			limit: 10,
			offset: 0,
		});
		expect(calls).toEqual([
			{
				url: "/bnpl/admin/webhook-events",
				opts: {
					method: "GET",
					query: {
						status: "failed",
						provider: "tabby",
						providerOrderId: "ord_1",
						limit: 10,
						offset: 0,
					},
				},
			},
		]);
	});
	it("posts admin.redeliverWebhookEvent to the encoded :id path", async () => {
		const { fetch, calls } = recordingFetch(
			OK({ redelivered: true, status: "processed", kind: "captured" }),
		);
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		const res = await actions.bnpl.admin.redeliverWebhookEvent("evt/1");
		expect(res.data).toEqual({ redelivered: true, status: "processed", kind: "captured" });
		expect(calls).toEqual([
			{ url: "/bnpl/admin/webhook-events/evt%2F1/redeliver", opts: { method: "POST" } },
		]);
	});
	it("passes through errors from redeliverWebhookEvent without throwing", async () => {
		const { fetch } = recordingFetch(
			FAIL({ code: "WEBHOOK_EVENT_NOT_FOUND", status: 404, statusText: "Not Found" }),
		);
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		const { data, error } = await actions.bnpl.admin.redeliverWebhookEvent("missing");
		expect(data).toBeNull();
		expect(error?.code).toBe("WEBHOOK_EVENT_NOT_FOUND");
		expect(error?.status).toBe(404);
	});
	it("keeps rawData on admin.listOrders rows but strips it from user-level getOrder", () => {
		const { fetch } = recordingFetch();
		const actions = bnplClient<"tamara" | "tabby">().getActions(fetch);
		const adminList = actions.bnpl.admin.listOrders();
		const userOrder = actions.bnpl.getOrder("ord_1");
		type AdminOrderRow = NonNullable<Awaited<typeof adminList>["data"]>["orders"][number];
		type UserOrder = NonNullable<Awaited<typeof userOrder>["data"]>;
		expectTypeOf<AdminOrderRow>().toHaveProperty("rawData");
		expectTypeOf<UserOrder>().not.toHaveProperty("rawData");
	});
});
