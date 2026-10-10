import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { isBnplProviderError } from "../../core/errors";
import type { ProviderFetch } from "../../core/provider";
import { type SleepFn, requestProviderJson } from "../../providers/http";
const okSchema = z.object({ ok: z.boolean() });
const noopSleep: SleepFn = async () => undefined;
interface StubOptions {
	method?: "GET" | "POST";
	timeoutMs?: number;
	sleep?: SleepFn;
	body?: unknown;
	bodySchema?: z.ZodTypeAny;
}
function callJson(fetchImpl: ProviderFetch, opts: StubOptions = {}) {
	return requestProviderJson({
		provider: "tamara",
		providerName: "Tamara",
		baseUrl: "https://api.test",
		fetchImpl,
		method: opts.method ?? "GET",
		path: "/orders/ord-1",
		headers: {},
		schema: okSchema,
		label: "getOrder",
		timeoutMs: opts.timeoutMs,
		sleep: opts.sleep ?? noopSleep,
		body: opts.body,
		bodySchema: opts.bodySchema,
	});
}
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
describe("requestProvider timeouts", () => {
	it("passes an AbortSignal so a hung upstream call is aborted", async () => {
		let signalSeen: AbortSignal | undefined;
		const fetchImpl: ProviderFetch = (_url, init) => {
			signalSeen = init?.signal ?? undefined;
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				signal?.addEventListener("abort", () => {
					reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
				});
			});
		};
		const err = await callJson(fetchImpl, { timeoutMs: 10 }).catch((e) => e);
		expect(signalSeen).toBeInstanceOf(AbortSignal);
		expect(isBnplProviderError(err)).toBe(true);
		if (isBnplProviderError(err)) {
			expect(err.message).toMatch(/timed out after 10ms/);
			expect(err.status).toBeUndefined();
		}
	});
	it("surfaces a network error cleanly as a BnplProviderError with no status", async () => {
		const fetchImpl: ProviderFetch = async () => {
			throw new TypeError("fetch failed");
		};
		const err = await callJson(fetchImpl).catch((e) => e);
		expect(isBnplProviderError(err)).toBe(true);
		if (isBnplProviderError(err)) {
			expect(err.status).toBeUndefined();
			expect(err.message).toMatch(/request failed/);
		}
	});
});
describe("requestProvider retries", () => {
	it("retries a 503 GET and succeeds on the follow-up 200", async () => {
		const sleep = vi.fn<SleepFn>(async () => undefined);
		let calls = 0;
		const fetchImpl: ProviderFetch = async () => {
			calls += 1;
			if (calls === 1) return jsonResponse({ error: "unavailable" }, 503);
			return jsonResponse({ ok: true });
		};
		const result = await callJson(fetchImpl, { sleep });
		expect(result).toEqual({ ok: true });
		expect(calls).toBe(2);
		expect(sleep).toHaveBeenCalledTimes(1);
	});
	it("retries GET up to the budget then fails with the last error (network)", async () => {
		let calls = 0;
		const fetchImpl: ProviderFetch = async () => {
			calls += 1;
			throw new TypeError("connection reset");
		};
		const err = await callJson(fetchImpl).catch((e) => e);
		expect(calls).toBe(3);
		expect(isBnplProviderError(err)).toBe(true);
	});
	it("never retries a POST — a mutating call that may have succeeded upstream must not be replayed", async () => {
		let calls = 0;
		const fetchImpl: ProviderFetch = async () => {
			calls += 1;
			return jsonResponse({ error: "unavailable" }, 503);
		};
		const err = await callJson(fetchImpl, { method: "POST" }).catch((e) => e);
		expect(calls).toBe(1);
		expect(isBnplProviderError(err)).toBe(true);
		if (isBnplProviderError(err)) expect(err.status).toBe(503);
	});
	it("does not retry a non-retryable 400 GET — fails immediately", async () => {
		let calls = 0;
		const fetchImpl: ProviderFetch = async () => {
			calls += 1;
			return jsonResponse({ message: "bad request" }, 400);
		};
		const err = await callJson(fetchImpl).catch((e) => e);
		expect(calls).toBe(1);
		expect(isBnplProviderError(err)).toBe(true);
		if (isBnplProviderError(err)) {
			expect(err.status).toBe(400);
			expect(err.message).toBe("bad request");
		}
	});
});
describe("bounded provider retry policy", () => {
	it("retries a transient 500 GET with the same request", async () => {
		const fetchImpl = vi
			.fn<ProviderFetch>()
			.mockResolvedValueOnce(jsonResponse({ error: "internal" }, 500))
			.mockResolvedValueOnce(jsonResponse({ ok: true }));
		expect(await callJson(fetchImpl)).toEqual({ ok: true });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
	it("honors Retry-After seconds on a rate-limited GET", async () => {
		const sleep = vi.fn<SleepFn>(async () => undefined);
		const fetchImpl = vi
			.fn<ProviderFetch>()
			.mockResolvedValueOnce(
				new Response('{"error":"limited"}', { status: 429, headers: { "retry-after": "2" } }),
			)
			.mockResolvedValueOnce(jsonResponse({ ok: true }));
		expect(await callJson(fetchImpl, { sleep })).toEqual({ ok: true });
		expect(sleep).toHaveBeenCalledWith(2000);
	});
	it("honors Retry-After HTTP date", async () => {
		const now = 1800000000000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			const sleep = vi.fn<SleepFn>(async () => undefined);
			const fetchImpl = vi
				.fn<ProviderFetch>()
				.mockResolvedValueOnce(
					new Response('{"error":"limited"}', {
						status: 503,
						headers: { "retry-after": new Date(now + 3000).toUTCString() },
					}),
				)
				.mockResolvedValueOnce(jsonResponse({ ok: true }));
			expect(await callJson(fetchImpl, { sleep })).toEqual({ ok: true });
			expect(sleep).toHaveBeenCalledWith(3000);
		} finally {
			clock.mockRestore();
		}
	});
	it("does not retry early when Retry-After exceeds the total timeout budget", async () => {
		const sleep = vi.fn<SleepFn>(async () => undefined);
		const fetchImpl = vi
			.fn<ProviderFetch>()
			.mockResolvedValue(
				new Response('{"error":"limited"}', { status: 429, headers: { "retry-after": "60" } }),
			);
		await expect(callJson(fetchImpl, { timeoutMs: 1000, sleep })).rejects.toMatchObject({
			status: 429,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});
	it("does not begin a new attempt after the request deadline", async () => {
		let now = 1800000000000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const fetchImpl = vi.fn<ProviderFetch>(async () => {
				now += 100;
				throw new TypeError("connection reset");
			});
			await expect(callJson(fetchImpl, { timeoutMs: 100 })).rejects.toThrow();
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		} finally {
			clock.mockRestore();
		}
	});
});
