import { describe, expect, expectTypeOf, it } from "vitest";
import type { BnplWebhookEvent } from "../core/types";
import { BnplProviders, type ProviderIdsOf, bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { checkout } from "../plugins/checkout";
import { options } from "../plugins/options";
import { orders } from "../plugins/orders";
import type {
	AutoAuthoriseOutcome,
	DispatchContextOf,
	StatusChangeContext,
	WebhookDispatchContext,
	WebhooksSubpluginOptions,
} from "../plugins/webhooks";
import { webhooks } from "../plugins/webhooks";
import { stubProvider } from "./_harness";
describe("bnpl() provider map validation", () => {
	it("requires provider map keys to match provider.id", () => {
		expect(() =>
			bnpl({
				providers: {
					tamaraKsa: stubProvider("tamara"),
				},
				use: [],
			}),
		).toThrow(/provider map key `tamaraKsa` must match provider\.id `tamara`/);
	});
	it("accepts providers keyed by their stable provider id", () => {
		expect(() =>
			bnpl({
				providers: {
					tamara: stubProvider("tamara"),
					tabby: stubProvider("tabby"),
				},
				use: [],
			}),
		).not.toThrow();
	});
	it("defines one-provider and two-provider maps with inferred ids", () => {
		const tabbyOnly = BnplProviders({
			tabby: stubProvider("tabby"),
		});
		const both = BnplProviders({
			tamara: stubProvider("tamara"),
			tabby: stubProvider("tabby"),
		});
		expectTypeOf<ProviderIdsOf<typeof tabbyOnly>>().toEqualTypeOf<"tabby">();
		expectTypeOf<ProviderIdsOf<typeof both>>().toEqualTypeOf<"tamara" | "tabby">();
		expect(tabbyOnly.tabby.id).toBe("tabby");
		expect(Object.keys(both)).toEqual(["tamara", "tabby"]);
	});
	it("exports narrowed webhook handler callback types", () => {
		type PayloadContext = Parameters<NonNullable<WebhooksSubpluginOptions["onPayload"]>>[0];
		type StatusContext = Parameters<NonNullable<WebhooksSubpluginOptions["onStatusChange"]>>[0];
		type ApprovedContext = Parameters<NonNullable<WebhooksSubpluginOptions["onApproved"]>>[0];
		type AuthorizedContext = Parameters<NonNullable<WebhooksSubpluginOptions["onAuthorized"]>>[0];
		type CapturedContext = Parameters<NonNullable<WebhooksSubpluginOptions["onCaptured"]>>[0];
		type RefundedContext = Parameters<NonNullable<WebhooksSubpluginOptions["onRefunded"]>>[0];
		type CanceledContext = Parameters<NonNullable<WebhooksSubpluginOptions["onCanceled"]>>[0];
		type ExpiredContext = Parameters<NonNullable<WebhooksSubpluginOptions["onExpired"]>>[0];
		type DeclinedContext = Parameters<NonNullable<WebhooksSubpluginOptions["onDeclined"]>>[0];
		type UpdatedContext = Parameters<NonNullable<WebhooksSubpluginOptions["onUpdated"]>>[0];
		expectTypeOf<PayloadContext>().toEqualTypeOf<WebhookDispatchContext>();
		expectTypeOf<StatusContext>().toEqualTypeOf<StatusChangeContext>();
		expectTypeOf<ApprovedContext>().toEqualTypeOf<DispatchContextOf<"approved">>();
		expectTypeOf<AuthorizedContext>().toEqualTypeOf<DispatchContextOf<"authorized">>();
		expectTypeOf<CapturedContext>().toEqualTypeOf<DispatchContextOf<"captured">>();
		expectTypeOf<RefundedContext>().toEqualTypeOf<DispatchContextOf<"refunded">>();
		expectTypeOf<CanceledContext>().toEqualTypeOf<DispatchContextOf<"canceled">>();
		expectTypeOf<ExpiredContext>().toEqualTypeOf<DispatchContextOf<"expired">>();
		expectTypeOf<DeclinedContext>().toEqualTypeOf<DispatchContextOf<"declined">>();
		expectTypeOf<UpdatedContext>().toEqualTypeOf<DispatchContextOf<"updated">>();
		expectTypeOf<CapturedContext["event"]>().toEqualTypeOf<
			Extract<
				BnplWebhookEvent,
				{
					kind: "captured";
				}
			>
		>();
		expectTypeOf<CapturedContext["event"]>().toHaveProperty("captureId");
		expectTypeOf<CapturedContext["event"]>().toHaveProperty("amountMinor");
		expectTypeOf<RefundedContext["event"]>().toHaveProperty("refundId");
		expectTypeOf<ApprovedContext["event"]>().not.toHaveProperty("captureId");
		expectTypeOf<AuthorizedContext["autoAuthoriseResult"]>().toEqualTypeOf<
			AutoAuthoriseOutcome | undefined
		>();
	});
	it("exposes typed sub-plugin endpoints on the composed record for a const `use` tuple", () => {
		const instance = bnpl({
			providers: { tamara: stubProvider("tamara"), tabby: stubProvider("tabby") },
			mapUserToBuyer: () => ({
				firstName: "T",
				lastName: "U",
				email: "t@u.dev",
				phone: "+966500000000",
			}),
			use: [checkout(), options(), orders(), webhooks(), admin({ isAuthorized: () => true })],
		});
		type Endpoints = typeof instance.endpoints;
		expectTypeOf<Endpoints>().toHaveProperty("bnplCheckout");
		expectTypeOf<Endpoints>().toHaveProperty("bnplOptions");
		expectTypeOf<Endpoints>().toHaveProperty("bnplGetOrder");
		expectTypeOf<Endpoints>().toHaveProperty("bnplListOrders");
		expectTypeOf<Endpoints>().toHaveProperty("bnplAdminCapture");
		expectTypeOf<Endpoints>().toHaveProperty("bnplAdminRefund");
		expectTypeOf<Endpoints["bnplCheckout"]>().toBeFunction();
		expectTypeOf<Endpoints["bnplCheckout"]>().toHaveProperty("path");
		expectTypeOf<Endpoints["bnplAdminCapture"]>().toHaveProperty("path");
	});
	it("narrows the composed record to only the endpoints actually mounted", () => {
		const checkoutOnly = bnpl({
			providers: { tabby: stubProvider("tabby") },
			mapUserToBuyer: () => ({
				firstName: "T",
				lastName: "U",
				email: "t@u.dev",
				phone: "+966500000000",
			}),
			use: [checkout()],
		});
		type Endpoints = typeof checkoutOnly.endpoints;
		expectTypeOf<Endpoints>().toHaveProperty("bnplCheckout");
		expectTypeOf<Endpoints>().not.toHaveProperty("bnplAdminCapture");
		expectTypeOf<Endpoints>().not.toHaveProperty("bnplOptions");
	});
	it("exports provider-specific webhook hook types", () => {
		type TamaraHooks = NonNullable<WebhooksSubpluginOptions["tamara"]>;
		type TabbyHooks = NonNullable<WebhooksSubpluginOptions["tabby"]>;
		type AuthoriseNotification = NonNullable<TamaraHooks["onAuthoriseNotification"]>;
		type PaymentClosed = NonNullable<TabbyHooks["onPaymentClosed"]>;
		expectTypeOf<Parameters<AuthoriseNotification>[0]>().toEqualTypeOf<Record<string, unknown>>();
		expectTypeOf<Parameters<AuthoriseNotification>[1]>().toEqualTypeOf<{
			autoAuthoriseResult: AutoAuthoriseOutcome;
		}>();
		expectTypeOf<Parameters<PaymentClosed>[0]>().toEqualTypeOf<Record<string, unknown>>();
	});
});
