import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { anonymous } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import type { BnplCheckoutInput } from "../core/types";
import { bnpl } from "../plugin";
import { type CheckoutSubpluginOptions, checkout } from "../plugins/checkout";
import { stubProvider } from "./_harness";
function memoryDb(persistOrders: boolean): Record<string, unknown[]> {
	const tables: Record<string, unknown[]> = {
		user: [],
		session: [],
		account: [],
		verification: [],
	};
	if (persistOrders) tables.bnplOrder = [];
	return tables;
}
const BASE_ORIGIN = "http://localhost:3000";
const BASE_PATH = "/custom-base";
const BASE_URL = `${BASE_ORIGIN}${BASE_PATH}`;
interface HarnessOptions {
	checkoutOptions?: CheckoutSubpluginOptions;
	persistOrders?: boolean;
	basePath?: string;
	baseURL?: string;
}
function makeHarness(opts: HarnessOptions = {}) {
	const captured: {
		canonical?: BnplCheckoutInput;
	} = {};
	const provider = stubProvider("tabby", {
		async createCheckout(input) {
			captured.canonical = input;
			return {
				providerOrderId: "ord",
				providerCheckoutId: "chk",
				checkoutUrl: "https://tabby.example/co",
				status: "new",
				raw: { created: true },
			};
		},
	});
	const basePath = opts.basePath ?? BASE_PATH;
	const baseURL = opts.baseURL ?? `${BASE_ORIGIN}${basePath}`;
	const persistOrders = opts.persistOrders ?? false;
	const auth = betterAuth({
		secret: "test-secret-please-ignore-1234567890",
		baseURL,
		basePath,
		database: memoryAdapter(memoryDb(persistOrders)),
		emailAndPassword: { enabled: true },
		plugins: [
			anonymous(),
			bnpl({
				providers: { tabby: provider },
				persistOrders,
				mapUserToBuyer: ({ user }) => ({
					firstName: "T",
					lastName: "U",
					email: user.email,
					phone: "+966500000000",
				}),
				use: [checkout(opts.checkoutOptions ?? {})],
			}),
		],
	});
	return { auth, captured, baseURL };
}
function sessionCookie(res: Response): string {
	return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}
async function signUp(
	auth: ReturnType<typeof makeHarness>["auth"],
	baseURL: string,
): Promise<string> {
	const res = await auth.handler(
		new Request(`${baseURL}/sign-up/email`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: `user-${crypto.randomUUID()}@example.test`,
				password: "password123456",
				name: "Test User",
			}),
		}),
	);
	return sessionCookie(res);
}
async function signInAnonymous(
	auth: ReturnType<typeof makeHarness>["auth"],
	baseURL: string,
): Promise<string> {
	const res = await auth.handler(
		new Request(`${baseURL}/sign-in/anonymous`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		}),
	);
	return sessionCookie(res);
}
function checkoutBody(overrides: Record<string, unknown> = {}) {
	return {
		provider: "tabby",
		description: "x",
		countryCode: "SA",
		shippingAddress: { line1: "King Fahd Rd", city: "Riyadh", countryCode: "SA" },
		totalAmount: { amount: "100.00", currency: "SAR" },
		items: [
			{
				referenceId: "s",
				name: "n",
				sku: "S",
				quantity: 1,
				totalAmount: { amount: "100.00", currency: "SAR" },
			},
		],
		...overrides,
	};
}
async function postCheckout(
	auth: ReturnType<typeof makeHarness>["auth"],
	baseURL: string,
	cookie: string,
	body: Record<string, unknown>,
) {
	return auth.handler(
		new Request(`${baseURL}/bnpl/checkout`, {
			method: "POST",
			headers: cookie
				? { "content-type": "application/json", cookie }
				: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}
describe("checkout session contract (authenticatedUsersOnly)", () => {
	it("rejects with 401 when there is no session, regardless of authenticatedUsersOnly", async () => {
		for (const authenticatedUsersOnly of [true, false]) {
			const { auth, baseURL } = makeHarness({ checkoutOptions: { authenticatedUsersOnly } });
			const res = await postCheckout(auth, baseURL, "", checkoutBody());
			expect(res.status).toBe(401);
		}
	});
	it("rejects anonymous sessions when authenticatedUsersOnly is the default (true)", async () => {
		const { auth, baseURL } = makeHarness({ checkoutOptions: {} });
		const cookie = await signInAnonymous(auth, baseURL);
		expect(cookie).not.toBe("");
		const res = await postCheckout(auth, baseURL, cookie, checkoutBody());
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.code).toBe("ANONYMOUS_USER_NOT_ALLOWED");
	});
	it("permits anonymous sessions when authenticatedUsersOnly is false", async () => {
		const { auth, baseURL } = makeHarness({ checkoutOptions: { authenticatedUsersOnly: false } });
		const cookie = await signInAnonymous(auth, baseURL);
		const res = await postCheckout(auth, baseURL, cookie, checkoutBody());
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ provider: "tabby", providerOrderId: "ord" });
	});
	it("permits regular authenticated sessions", async () => {
		const { auth, baseURL } = makeHarness();
		const cookie = await signUp(auth, baseURL);
		const res = await postCheckout(auth, baseURL, cookie, checkoutBody());
		expect(res.status).toBe(200);
	});
});
describe("notification URL basepath", () => {
	it("builds the webhook URL under a non-default basePath", async () => {
		const { auth, baseURL, captured } = makeHarness();
		const cookie = await signUp(auth, baseURL);
		const res = await postCheckout(auth, baseURL, cookie, checkoutBody());
		expect(res.status).toBe(200);
		expect(captured.canonical?.merchantUrl.notification).toBe(`${BASE_URL}/bnpl/webhooks/tabby`);
	});
	it("builds the webhook URL correctly for the default basePath", async () => {
		const { auth, baseURL, captured } = makeHarness({
			basePath: "/api/auth",
			baseURL: `${BASE_ORIGIN}/api/auth`,
		});
		const cookie = await signUp(auth, baseURL);
		const res = await postCheckout(auth, baseURL, cookie, checkoutBody());
		expect(res.status).toBe(200);
		expect(captured.canonical?.merchantUrl.notification).toBe(
			`${BASE_ORIGIN}/api/auth/bnpl/webhooks/tabby`,
		);
	});
});
describe("per-checkout redirect URLs + open-redirect guard", () => {
	it("uses body URLs whose origin matches baseURL by default", async () => {
		const { auth, baseURL, captured } = makeHarness();
		const cookie = await signUp(auth, baseURL);
		const res = await postCheckout(
			auth,
			baseURL,
			cookie,
			checkoutBody({
				successUrl: `${BASE_ORIGIN}/cart/success`,
				failureUrl: `${BASE_ORIGIN}/cart/failure`,
				cancelUrl: `${BASE_ORIGIN}/cart/cancel`,
			}),
		);
		expect(res.status).toBe(200);
		expect(captured.canonical?.merchantUrl.success).toBe(`${BASE_ORIGIN}/cart/success`);
		expect(captured.canonical?.merchantUrl.failure).toBe(`${BASE_ORIGIN}/cart/failure`);
		expect(captured.canonical?.merchantUrl.cancel).toBe(`${BASE_ORIGIN}/cart/cancel`);
	});
	it("rejects body URLs from an untrusted origin with 400 INVALID_URL", async () => {
		const { auth, baseURL } = makeHarness();
		const cookie = await signUp(auth, baseURL);
		const res = await postCheckout(
			auth,
			baseURL,
			cookie,
			checkoutBody({ successUrl: "https://evil.example/phish" }),
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.code).toBe("INVALID_URL");
	});
	it("accepts an additional origin listed in trustedRedirectOrigins", async () => {
		const { auth, baseURL, captured } = makeHarness({
			checkoutOptions: { trustedRedirectOrigins: ["https://shop.example"] },
		});
		const cookie = await signUp(auth, baseURL);
		const res = await postCheckout(
			auth,
			baseURL,
			cookie,
			checkoutBody({ successUrl: "https://shop.example/thanks" }),
		);
		expect(res.status).toBe(200);
		expect(captured.canonical?.merchantUrl.success).toBe("https://shop.example/thanks");
	});
	it("falls back to plugin-level option URLs when no body URL is supplied", async () => {
		const { auth, baseURL, captured } = makeHarness({
			checkoutOptions: { successUrl: "https://configured.example/ok" },
		});
		const cookie = await signUp(auth, baseURL);
		const res = await postCheckout(auth, baseURL, cookie, checkoutBody());
		expect(res.status).toBe(200);
		expect(captured.canonical?.merchantUrl.success).toBe("https://configured.example/ok");
	});
	it("body URL takes precedence over plugin option and default", async () => {
		const { auth, baseURL, captured } = makeHarness({
			checkoutOptions: { successUrl: "https://configured.example/ok" },
		});
		const cookie = await signUp(auth, baseURL);
		const res = await postCheckout(
			auth,
			baseURL,
			cookie,
			checkoutBody({ successUrl: `${BASE_ORIGIN}/body-wins` }),
		);
		expect(res.status).toBe(200);
		expect(captured.canonical?.merchantUrl.success).toBe(`${BASE_ORIGIN}/body-wins`);
	});
});
describe("request-size caps", () => {
	it("rejects metadata larger than 8KB", async () => {
		const { auth, baseURL } = makeHarness();
		const cookie = await signUp(auth, baseURL);
		const big = { blob: "x".repeat(9 * 1024) };
		const res = await postCheckout(auth, baseURL, cookie, checkoutBody({ metadata: big }));
		expect(res.status).toBe(400);
	});
	it("rejects additionalData larger than 8KB", async () => {
		const { auth, baseURL } = makeHarness();
		const cookie = await signUp(auth, baseURL);
		const big = { blob: "x".repeat(9 * 1024) };
		const res = await postCheckout(auth, baseURL, cookie, checkoutBody({ additionalData: big }));
		expect(res.status).toBe(400);
	});
	it("accepts metadata under the cap", async () => {
		const { auth, baseURL, captured } = makeHarness();
		const cookie = await signUp(auth, baseURL);
		const res = await postCheckout(
			auth,
			baseURL,
			cookie,
			checkoutBody({ metadata: { orderId: "abc", tags: ["a", "b"] } }),
		);
		expect(res.status).toBe(200);
		expect(captured.canonical?.metadata).toEqual({ orderId: "abc", tags: ["a", "b"] });
	});
});
