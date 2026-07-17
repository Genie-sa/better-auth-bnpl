import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
	BnplAuthorizeResult,
	BnplCaptureArgs,
	BnplCaptureResult,
	BnplCheckoutInput,
	BnplCheckoutResult,
	BnplWebhookEvent,
} from "../core/types";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { checkout } from "../plugins/checkout";
import { options } from "../plugins/options";
import { orders } from "../plugins/orders";
import { webhooks } from "../plugins/webhooks";
import type { TabbyCheckoutData } from "../providers/tabby";
import { makeBnplTestInstance, stubProvider } from "./_harness";
const checkoutBody = {
	provider: "tabby",
	orderReferenceId: "ref-integration",
	description: "Integration checkout",
	totalAmount: { amount: "100.00", currency: "SAR" },
	taxAmount: { amount: "0.00", currency: "SAR" },
	shippingAmount: { amount: "0.00", currency: "SAR" },
	items: [
		{
			referenceId: "sku-1",
			name: "Integration Item",
			sku: "SKU1",
			quantity: 1,
			totalAmount: { amount: "100.00", currency: "SAR" },
		},
	],
	shippingAddress: { line1: "King Fahd Rd", city: "Riyadh", countryCode: "SA" },
	countryCode: "SA",
};
const recordSchema = z.record(z.string(), z.unknown());
const ordersResponseSchema = z
	.object({
		orders: z.array(recordSchema),
	})
	.passthrough();
const optionsResponseSchema = z
	.object({
		available: z.array(recordSchema),
		unavailable: z.array(recordSchema),
	})
	.passthrough();
function parseRawBody(rawBody: string): Record<string, unknown> {
	const raw: unknown = JSON.parse(rawBody);
	return recordSchema.parse(raw);
}
function makeProvider(overrides: Parameters<typeof stubProvider<"tabby">>[1] = {}) {
	return stubProvider("tabby", {
		async createCheckout() {
			return {
				providerOrderId: "ord-integration",
				providerCheckoutId: "chk-integration",
				checkoutUrl: "https://checkout.example.test/chk-integration",
				status: "new",
				raw: { created: true },
			};
		},
		...overrides,
	});
}
function makeEndpointProvider(id: "tamara" | "tabby") {
	const calls: string[] = [];
	const provider = stubProvider(id, {
		async createCheckout() {
			calls.push(`${id}.createCheckout`);
			return {
				providerOrderId: `${id}-order`,
				providerCheckoutId: `${id}-checkout`,
				checkoutUrl: `https://${id}.example.test/checkout`,
				status: "new",
				raw: { provider: id, created: true },
			};
		},
		async preCheck(input) {
			calls.push(`${id}.preCheck:${input.amount.amount}`);
			return { available: true };
		},
		async fetchOrder(providerOrderId) {
			calls.push(`${id}.fetchOrder:${providerOrderId}`);
			return {
				providerOrderId,
				status: "authorised",
				totalAmount: { amount: "100.00", currency: "SAR" },
				capturedAmountMinor: 0,
				refundedAmountMinor: 0,
				raw: { provider: id, fetched: true },
			};
		},
	});
	return { provider, calls };
}
async function makeEndpointMatrixInstance(ids: readonly ("tamara" | "tabby")[]) {
	const entries = ids.map((id) => [id, makeEndpointProvider(id)] as const);
	const providers = Object.fromEntries(entries.map(([id, entry]) => [id, entry.provider]));
	const callsById = Object.fromEntries(entries.map(([id, entry]) => [id, entry.calls]));
	const instance = await makeBnplTestInstance([
		bnpl({
			providers,
			persistOrders: true,
			mapUserToBuyer: ({ user }) => ({
				firstName: "Test",
				lastName: "User",
				email: user.email,
				phone: "+966500000000",
			}),
			use: [checkout(), options(), orders()],
		}),
	]);
	return { instance, callsById };
}
const tamaraApprovedWebhookBody = {
	order_id: "ord-authorise",
	order_reference_id: "ref-authorise",
	order_status: "approved",
};
const tamaraAuthoriseCapabilities = {
	preCheck: true,
	separateAuthorise: true,
	voidCheckout: true,
	closePayment: false,
	partialCapture: true,
	partialRefund: true,
	multipleCaptures: true,
	disputes: false,
} as const;
function tamaraAuthoriseResult(): BnplAuthorizeResult {
	return {
		providerOrderId: "ord-authorise",
		status: "authorised",
		raw: { order_id: "ord-authorise", status: "authorised" },
	};
}
function tamaraCaptureResult(): BnplCaptureResult {
	return {
		captureId: "cap-authorise",
		providerOrderId: "ord-authorise",
		amountMinor: 10000,
		raw: { capture_id: "cap-authorise" },
	};
}
function makeTamaraAuthorise() {
	return vi.fn(async () => tamaraAuthoriseResult());
}
function makeTamaraCapture(recordArgs?: (args: BnplCaptureArgs) => void) {
	return vi.fn(async (_providerOrderId: string, args: BnplCaptureArgs) => {
		recordArgs?.(args);
		return tamaraCaptureResult();
	});
}
function makeTamaraApprovedProvider(overrides: Parameters<typeof stubProvider<"tamara">>[1] = {}) {
	return stubProvider("tamara", {
		capabilities: tamaraAuthoriseCapabilities,
		async verifyWebhook(req) {
			return {
				ok: true,
				payload: parseRawBody(req.rawBody),
				dedupKey: "tamara:order_approved:ord-authorise",
				rawBody: req.rawBody,
			};
		},
		toCanonicalEvent(payload) {
			return {
				kind: "approved",
				provider: "tamara",
				orderId: "ord-authorise",
				orderReferenceId:
					typeof payload.order_reference_id === "string" ? payload.order_reference_id : undefined,
				raw: payload,
			};
		},
		...overrides,
	});
}
async function makeInstance(provider = makeProvider(), webhookHooks = {}) {
	return makeBnplTestInstance([
		bnpl({
			providers: { tabby: provider },
			persistOrders: true,
			mapUserToBuyer: ({ user }) => ({
				firstName: "Test",
				lastName: "User",
				email: user.email,
				phone: "+966500000000",
			}),
			use: [
				checkout(),
				options(),
				orders(),
				webhooks(webhookHooks),
				admin({ isAuthorized: () => true }),
			],
		}),
	]);
}
async function seedCheckout(instance: Awaited<ReturnType<typeof makeInstance>>) {
	const { headers } = await instance.signInWithTestUser();
	const res = await instance.client.$fetch("/bnpl/checkout", {
		method: "POST",
		headers,
		body: checkoutBody,
	});
	expect(res.error).toBeNull();
	return { headers, checkout: res.data };
}
async function listFirstOrder(
	instance: Awaited<ReturnType<typeof makeInstance>>,
	headers: Headers,
): Promise<Record<string, unknown>> {
	const res = await instance.client.$fetch("/bnpl/orders", { method: "GET", headers });
	expect(res.error).toBeNull();
	const { orders } = ordersResponseSchema.parse(res.data);
	expect(orders.length).toBeGreaterThan(0);
	return orders[0] ?? {};
}
describe("bnpl() Better Auth integration", () => {
	it("creates checkout through the configured provider and persists a canonical order row", async () => {
		const canonicalInputs: BnplCheckoutInput[] = [];
		const provider = makeProvider({
			async createCheckout(input) {
				canonicalInputs.push(input);
				return {
					providerOrderId: "ord-integration",
					providerCheckoutId: "chk-integration",
					checkoutUrl: "https://checkout.example.test/chk-integration",
					status: "new",
					raw: { created: true },
				};
			},
		});
		const instance = await makeInstance(provider);
		const { headers, checkout: checkoutResult } = await seedCheckout(instance);
		expect(checkoutResult).toMatchObject({
			provider: "tabby",
			providerOrderId: "ord-integration",
			providerCheckoutId: "chk-integration",
			orderReferenceId: "ref-integration",
		});
		const [canonicalInput] = canonicalInputs;
		expect(canonicalInput).toBeDefined();
		expect(canonicalInput?.merchantUrl.notification).toContain("/bnpl/webhooks/tabby");
		const row = await listFirstOrder(instance, headers);
		expect(row).toMatchObject({
			provider: "tabby",
			providerOrderId: "ord-integration",
			providerCheckoutId: "chk-integration",
			orderReferenceId: "ref-integration",
			status: "new",
			amountMinor: 10000,
			currency: "SAR",
		});
	});
	it("validates resolveCheckout output before provider dispatch", async () => {
		const createCheckout = vi.fn(
			async (): Promise<BnplCheckoutResult> => ({
				providerOrderId: "ord-integration",
				providerCheckoutId: "chk-integration",
				checkoutUrl: "https://checkout.example.test/chk-integration",
				status: "new",
				raw: { created: true },
			}),
		);
		const provider = makeProvider({ createCheckout });
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tabby: provider },
				mapUserToBuyer: ({ user }) => ({
					firstName: "Test",
					lastName: "User",
					email: user.email,
					phone: "+966500000000",
				}),
				use: [
					checkout({
						resolveCheckout: () => ({
							totalAmount: { amount: "100.00", currency: "SAR" },
							items: [],
						}),
					}),
				],
			}),
		]);
		const { headers } = await instance.signInWithTestUser();
		const res = await instance.client.$fetch("/bnpl/checkout", {
			method: "POST",
			headers,
			body: checkoutBody,
		});
		expect(res.error).not.toBeNull();
		expect(createCheckout).not.toHaveBeenCalled();
	});
	it("forwards only resolver-produced provider data and does not disclose it", async () => {
		const trustedProviderData = {
			buyer_history: {
				registered_since: "2024-01-15T12:00:00Z",
				loyalty_level: 1,
			},
			order_history: [],
			attachment: {
				body: {
					education_details: {
						merchant_subtype: "courses_training",
						program: { payment_tenure_months: 0, months_to_completion: 0 },
						student_history: { late_payments_count: 0, avg_overdue_duration_days: 0 },
					},
				},
				content_type: "application/vnd.tabby.v1+json",
			},
		} satisfies TabbyCheckoutData;
		const attackerProviderData = { secret: "attacker-provider-data" };
		let resolverSawAttackerData = false;
		let providerInput: BnplCheckoutInput | undefined;
		const callbackSurfaces: unknown[] = [];
		const provider = makeProvider({
			async createCheckout(input) {
				providerInput = input;
				return {
					providerOrderId: "ord-provider-data",
					providerCheckoutId: "chk-provider-data",
					checkoutUrl: "https://checkout.example.test/chk-provider-data",
					status: "new",
					raw: { created: true },
				};
			},
		});
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tabby: provider },
				persistOrders: true,
				mapUserToBuyer: ({ user }) => ({
					firstName: "Test",
					lastName: "User",
					email: user.email,
					phone: "+966500000000",
				}),
				use: [
					checkout({
						resolveCheckout: ({ input }) => {
							resolverSawAttackerData = "providerData" in input;
							return {
								totalAmount: { amount: "100.00", currency: "SAR" },
								items: [
									{
										referenceId: "sku-1",
										name: "Integration Item",
										sku: "SKU1",
										quantity: 1,
										totalAmount: { amount: "100.00", currency: "SAR" },
									},
								],
								providerData: trustedProviderData,
							};
						},
						onCheckoutCreated: ({ input, canonicalRequest, checkoutResult }) => {
							callbackSurfaces.push(input, canonicalRequest, checkoutResult);
						},
						onOrderPersisted: ({ record }) => {
							callbackSurfaces.push(record);
						},
					}),
					orders(),
				],
			}),
		]);
		const { headers } = await instance.signInWithTestUser();
		const response = await instance.client.$fetch("/bnpl/checkout", {
			method: "POST",
			headers,
			body: { ...checkoutBody, providerData: attackerProviderData },
		});
		expect(response.error).toBeNull();
		expect(resolverSawAttackerData).toBe(false);
		expect(providerInput?.providerData).toEqual(trustedProviderData);
		const publicAndPersisted = JSON.stringify({
			response: response.data,
			database: instance.db,
			callbacks: callbackSurfaces,
		});
		expect(publicAndPersisted).not.toContain("attacker-provider-data");
		expect(publicAndPersisted).not.toContain("registered_since");
		expect(
			callbackSurfaces.every((surface) => !("providerData" in recordSchema.parse(surface))),
		).toBe(true);
	});
	it("runs provider pre-checks through /bnpl/options without requiring a session", async () => {
		const provider = makeProvider({
			async preCheck(input) {
				return {
					available: input.amount.amount === "100.00",
					reason: input.amount.amount === "100.00" ? undefined : "amount_too_low",
				};
			},
		});
		const instance = await makeInstance(provider);
		const res = await instance.client.$fetch("/bnpl/options", {
			method: "POST",
			body: {
				country: "SA",
				amount: { amount: "100.00", currency: "SAR" },
				phone: "+966500000000",
			},
		});
		expect(res.error).toBeNull();
		const { available, unavailable } = optionsResponseSchema.parse(res.data);
		expect(available).toHaveLength(1);
		expect(available[0]).toMatchObject({ id: "tabby", available: true });
		expect(unavailable).toEqual([]);
	});
	it.each([
		["tabby only", ["tabby"] as const],
		["tamara only", ["tamara"] as const],
		["both providers", ["tamara", "tabby"] as const],
	])("routes options, checkout, and order listing with %s enabled", async (_label, ids) => {
		const { instance, callsById } = await makeEndpointMatrixInstance(ids);
		const { headers } = await instance.signInWithTestUser();
		const optionsRes = await instance.client.$fetch("/bnpl/options", {
			method: "POST",
			body: {
				country: "SA",
				amount: { amount: "100.00", currency: "SAR" },
				email: "buyer@example.test",
				phone: "+966500000000",
			},
		});
		expect(optionsRes.error).toBeNull();
		const { available } = optionsResponseSchema.parse(optionsRes.data);
		expect(available.map((row) => row.id).sort()).toEqual([...ids].sort());
		for (const id of ids) {
			const checkoutRes = await instance.client.$fetch("/bnpl/checkout", {
				method: "POST",
				headers,
				body: { ...checkoutBody, provider: id, orderReferenceId: `ref-${id}` },
			});
			expect(checkoutRes.error).toBeNull();
			expect(checkoutRes.data).toMatchObject({
				provider: id,
				providerOrderId: `${id}-order`,
				providerCheckoutId: `${id}-checkout`,
				orderReferenceId: `ref-${id}`,
			});
			const orderRes = await instance.client.$fetch(`/bnpl/orders/${id}-order`, {
				method: "GET",
				headers,
			});
			expect(orderRes.error).toBeNull();
			expect(orderRes.data).toMatchObject({
				provider: id,
				providerOrderId: `${id}-order`,
				orderReferenceId: `ref-${id}`,
				status: "new",
			});
			const referenceRes = await instance.client.$fetch(`/bnpl/orders/reference-id/ref-${id}`, {
				method: "GET",
				headers,
			});
			expect(referenceRes.error).toBeNull();
			expect(referenceRes.data).toMatchObject({
				provider: id,
				providerOrderId: `${id}-order`,
				orderReferenceId: `ref-${id}`,
			});
		}
		const enabled = new Set<string>(ids);
		for (const disabled of (["tamara", "tabby"] as const).filter((id) => !enabled.has(id))) {
			const checkoutRes = await instance.client.$fetch("/bnpl/checkout", {
				method: "POST",
				headers,
				body: { ...checkoutBody, provider: disabled, orderReferenceId: `ref-disabled-${disabled}` },
			});
			expect(checkoutRes.error).not.toBeNull();
		}
		const listRes = await instance.client.$fetch("/bnpl/orders", { method: "GET", headers });
		expect(listRes.error).toBeNull();
		const { orders: listedOrders } = ordersResponseSchema.parse(listRes.data);
		expect(listedOrders.map((row) => row.provider).sort()).toEqual([...ids].sort());
		for (const id of ids) {
			expect(callsById[id]).toEqual([
				`${id}.preCheck:100.00`,
				`${id}.createCheckout`,
				`${id}.fetchOrder:${id}-order`,
			]);
		}
	});
	it("deduplicates provider webhooks before persistence and typed handlers", async () => {
		const onCaptured = vi.fn();
		const event: BnplWebhookEvent = {
			kind: "captured",
			provider: "tabby",
			orderId: "ord-integration",
			captureId: "cap-webhook",
			amountMinor: 5000,
			currency: "SAR",
			raw: { id: "ord-integration" },
		};
		const provider = makeProvider({
			async verifyWebhook(req) {
				return {
					ok: true,
					payload: parseRawBody(req.rawBody),
					dedupKey: "tabby:captured:cap-webhook",
					rawBody: req.rawBody,
				};
			},
			toCanonicalEvent() {
				return event;
			},
		});
		const instance = await makeInstance(provider, { onCaptured });
		const { headers } = await seedCheckout(instance);
		const payload = { id: "ord-integration", status: "CAPTURED" };
		const firstWebhook = await instance.client.$fetch("/bnpl/webhooks/tabby", {
			method: "POST",
			body: payload,
		});
		const duplicateWebhook = await instance.client.$fetch("/bnpl/webhooks/tabby", {
			method: "POST",
			body: payload,
		});
		expect(firstWebhook.data).toMatchObject({ received: true, kind: "captured" });
		expect(duplicateWebhook.data).toMatchObject({
			received: true,
			kind: "captured",
			duplicate: true,
		});
		expect(onCaptured).toHaveBeenCalledOnce();
		const row = await listFirstOrder(instance, headers);
		expect(row.capturedAmountMinor).toBe(5000);
		expect(row.status).toBe("partially_captured");
	});
	it("pre-seeds webhook dedup keys for admin capture to avoid double-counting later webhooks", async () => {
		const onCaptured = vi.fn();
		let captureReferenceId: string | undefined;
		const provider = makeProvider({
			async capture(_orderId, args) {
				captureReferenceId = args.merchantReferenceId;
				return {
					captureId: "cap-admin",
					providerOrderId: "ord-integration",
					amountMinor: 5000,
					raw: { capture_id: "cap-admin" },
				};
			},
			async verifyWebhook(req) {
				return {
					ok: true,
					payload: parseRawBody(req.rawBody),
					dedupKey: "tabby:captured:cap-admin",
					rawBody: req.rawBody,
				};
			},
			webhookDedupKey(event) {
				return event.kind === "captured" ? `tabby:captured:${event.captureId}` : "tabby:event";
			},
			toCanonicalEvent() {
				return {
					kind: "captured",
					provider: "tabby",
					orderId: "ord-integration",
					captureId: "cap-admin",
					amountMinor: 5000,
					currency: "SAR",
					raw: { id: "ord-integration" },
				};
			},
		});
		const instance = await makeInstance(provider, { onCaptured });
		const { headers } = await seedCheckout(instance);
		const captureRes = await instance.client.$fetch("/bnpl/admin/orders/ord-integration/capture", {
			method: "POST",
			headers,
			body: { totalAmount: { amount: "50.00", currency: "SAR" } },
		});
		expect(captureRes.error).toBeNull();
		expect(captureReferenceId).toBe("bnpl:tabby:ord-integration:capture:5000");
		const duplicateWebhook = await instance.client.$fetch("/bnpl/webhooks/tabby", {
			method: "POST",
			body: { id: "ord-integration", status: "CAPTURED" },
		});
		expect(duplicateWebhook.data).toMatchObject({
			received: true,
			kind: "captured",
			duplicate: true,
		});
		expect(onCaptured).not.toHaveBeenCalled();
		const row = await listFirstOrder(instance, headers);
		expect(row.capturedAmountMinor).toBe(5000);
		expect(row.status).toBe("partially_captured");
	});
	it("skips captureOnAuthorise when orders are not persisted", async () => {
		const authorize = makeTamaraAuthorise();
		const capture = makeTamaraCapture();
		const provider = makeTamaraApprovedProvider({
			authorize,
			capture,
		});
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tamara: provider },
				persistOrders: false,
				autoAuthorise: true,
				captureOnAuthorise: true,
				use: [webhooks()],
			}),
		]);
		const res = await instance.client.$fetch("/bnpl/webhooks/tamara", {
			method: "POST",
			body: tamaraApprovedWebhookBody,
		});
		expect(res.error).toBeNull();
		expect(res.data).toMatchObject({
			received: true,
			kind: "approved",
		});
		expect(authorize).toHaveBeenCalledOnce();
		expect(capture).not.toHaveBeenCalled();
	});
	it("uses captureOnAuthoriseShippingInfo for docs-valid auto-capture", async () => {
		const captureArgs: BnplCaptureArgs[] = [];
		const authorize = makeTamaraAuthorise();
		const capture = makeTamaraCapture((args) => captureArgs.push(args));
		const provider = makeTamaraApprovedProvider({
			async createCheckout() {
				return {
					providerOrderId: "ord-authorise",
					providerCheckoutId: "chk-authorise",
					checkoutUrl: "https://checkout.example.test/chk-authorise",
					status: "new",
					raw: { created: true },
				};
			},
			authorize,
			capture,
		});
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tamara: provider },
				persistOrders: true,
				autoAuthorise: true,
				captureOnAuthorise: true,
				captureOnAuthoriseShippingInfo: () => ({
					shippedAt: "2026-06-04T16:00:00.000Z",
					shippingCompany: "Digital delivery",
				}),
				mapUserToBuyer: ({ user }) => ({
					firstName: "Test",
					lastName: "User",
					email: user.email,
					phone: "+966500000000",
				}),
				use: [checkout(), webhooks()],
			}),
		]);
		const { headers } = await instance.signInWithTestUser();
		const checkoutRes = await instance.client.$fetch("/bnpl/checkout", {
			method: "POST",
			headers,
			body: { ...checkoutBody, provider: "tamara", orderReferenceId: "ref-authorise" },
		});
		expect(checkoutRes.error).toBeNull();
		const res = await instance.client.$fetch("/bnpl/webhooks/tamara", {
			method: "POST",
			body: tamaraApprovedWebhookBody,
		});
		expect(res.error).toBeNull();
		expect(authorize).toHaveBeenCalledOnce();
		expect(capture).toHaveBeenCalledOnce();
		expect(captureArgs[0]?.shippingInfo).toEqual({
			shippedAt: "2026-06-04T16:00:00.000Z",
			shippingCompany: "Digital delivery",
		});
	});
	it("captures Tabby automatically when an authorized webhook arrives", async () => {
		const captureArgs: BnplCaptureArgs[] = [];
		const capture = vi.fn(async (_orderId: string, args: BnplCaptureArgs) => {
			if (!args.merchantReferenceId?.trim()) {
				throw new Error("merchantReferenceId is required");
			}
			captureArgs.push(args);
			return {
				captureId: "cap-tabby-authorized",
				providerOrderId: "ord-integration",
				amountMinor: 10000,
				raw: { capture_id: "cap-tabby-authorized" },
			};
		});
		const provider = makeProvider({
			capture,
			async verifyWebhook(req) {
				return {
					ok: true,
					payload: parseRawBody(req.rawBody),
					dedupKey: "tabby:authorized:ord-integration",
					rawBody: req.rawBody,
				};
			},
			webhookDedupKey(event) {
				return event.kind === "captured" ? `tabby:captured:${event.captureId}` : "tabby:event";
			},
			toCanonicalEvent(payload) {
				return {
					kind: "authorized",
					provider: "tabby",
					orderId: typeof payload.id === "string" ? payload.id : "ord-integration",
					raw: payload,
				};
			},
		});
		const instance = await makeBnplTestInstance([
			bnpl({
				providers: { tabby: provider },
				persistOrders: true,
				captureOnAuthorise: true,
				captureOnAuthoriseShippingInfo: () => ({
					shippedAt: "2026-06-04T16:00:00.000Z",
					shippingCompany: "Digital delivery",
				}),
				mapUserToBuyer: ({ user }) => ({
					firstName: "Test",
					lastName: "User",
					email: user.email,
					phone: "+966500000000",
				}),
				use: [checkout(), orders(), webhooks()],
			}),
		]);
		const { headers } = await seedCheckout(instance);
		const res = await instance.client.$fetch("/bnpl/webhooks/tabby", {
			method: "POST",
			body: { id: "ord-integration", status: "authorized" },
		});
		expect(res.error).toBeNull();
		expect(res.data).toMatchObject({
			received: true,
			kind: "authorized",
		});
		expect(capture).toHaveBeenCalledOnce();
		expect(captureArgs[0]).toMatchObject({
			totalAmount: { amount: "100.00", currency: "SAR" },
			merchantReferenceId: "bnpl:tabby:ord-integration:capture:10000",
			shippingInfo: {
				shippedAt: "2026-06-04T16:00:00.000Z",
				shippingCompany: "Digital delivery",
			},
		});
		const row = await listFirstOrder(instance, headers);
		expect(row.status).toBe("fully_captured");
		expect(row.capturedAmountMinor).toBe(10000);
	});
});
