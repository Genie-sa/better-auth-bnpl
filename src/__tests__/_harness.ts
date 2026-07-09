import { webcrypto } from "node:crypto";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthClient } from "better-auth/client";
import { parseSetCookieHeader } from "better-auth/cookies";
import type { BnplProvider, ProviderContext } from "../core/provider";
if (!globalThis.crypto) {
	Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}
export const silentLogger = {
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
	debug: () => undefined,
} satisfies ProviderContext["logger"];
export const ctx: ProviderContext = { logger: silentLogger };
export function makeHeaders(init: Record<string, string> = {}): Headers {
	const h = new Headers();
	for (const [k, v] of Object.entries(init)) h.set(k, v);
	return h;
}
export function stubProvider<Id extends string>(
	id: Id,
	overrides: Partial<BnplProvider<Id>> = {},
): BnplProvider<Id> {
	return {
		id,
		display: { displayName: id, logoUrl: undefined, tagline: undefined },
		capabilities: {
			preCheck: true,
			separateAuthorise: false,
			voidCheckout: false,
			closePayment: false,
			partialCapture: true,
			partialRefund: true,
			multipleCaptures: true,
			disputes: false,
		},
		supportedCountries: ["SA", "AE", "KW"],
		supportedCurrencies: ["SAR", "AED", "KWD"],
		async createCheckout() {
			return {
				providerOrderId: "stub-order",
				providerCheckoutId: "stub-checkout",
				checkoutUrl: "https://stub.example.com/co/123",
				status: "new",
				raw: { stub: true },
			};
		},
		async fetchOrder() {
			throw new Error("not implemented");
		},
		async capture() {
			throw new Error("not implemented");
		},
		async refund() {
			throw new Error("not implemented");
		},
		async cancel() {
			return undefined;
		},
		async verifyWebhook() {
			return { ok: false, reason: "stub" };
		},
		toCanonicalEvent() {
			return null;
		},
		async preCheck() {
			return { available: true };
		},
		...overrides,
	};
}
const MEMORY_MODELS = [
	"user",
	"session",
	"account",
	"verification",
	"bnplOrder",
	"bnplWebhookEvent",
	"rateLimit",
] as const;
const TEST_SECRET = "better-auth-secret-that-is-long-enough-for-validation-test";
const TEST_BASE_URL = "http://localhost:3000";
const TEST_USER = { email: "test@test.com", password: "test123456", name: "test user" } as const;
export async function makeBnplTestInstance(
	plugins: BetterAuthPlugin[],
	overrides: Partial<BetterAuthOptions> = {},
) {
	const db: Record<string, Record<string, unknown>[]> = {};
	for (const model of MEMORY_MODELS) db[model] = [];
	const auth = betterAuth({
		baseURL: TEST_BASE_URL,
		secret: TEST_SECRET,
		database: memoryAdapter(db),
		emailAndPassword: { enabled: true },
		rateLimit: { enabled: false },
		advanced: { cookies: {} },
		...overrides,
		plugins,
	});
	const customFetchImpl = async (url: string | URL | Request, init?: RequestInit) =>
		auth.handler(new Request(url, init));
	const client = createAuthClient({
		baseURL: `${TEST_BASE_URL}/api/auth`,
		fetchOptions: { customFetchImpl },
	});
	await auth.api.signUpEmail({ body: { ...TEST_USER } });
	async function signInWithTestUser(): Promise<{
		headers: Headers;
	}> {
		const headers = new Headers();
		await client.signIn.email({
			email: TEST_USER.email,
			password: TEST_USER.password,
			fetchOptions: {
				onSuccess(context) {
					const token = parseSetCookieHeader(context.response.headers.get("set-cookie") || "").get(
						"better-auth.session_token",
					)?.value;
					headers.set("cookie", `better-auth.session_token=${token}`);
				},
			},
		});
		return { headers };
	}
	return { auth, client, db, signInWithTestUser };
}
export type BnplTestInstance = Awaited<ReturnType<typeof makeBnplTestInstance>>;
