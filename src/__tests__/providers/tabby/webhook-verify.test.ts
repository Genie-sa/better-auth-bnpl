import { describe, expect, it } from "vitest";
import { verifyTabbyHeaderSecret } from "../../../providers/tabby/webhook-verify";
const HEADER = "X-Tabby-Webhook-Secret";
const VALUE = "long-random-secret-32-bytes-of-entropy-or-more";
function headersWith(...pairs: Array<[string, string]>): Headers {
	const h = new Headers();
	for (const [k, v] of pairs) h.set(k, v);
	return h;
}
describe("verifyTabbyHeaderSecret", () => {
	it("accepts the expected header value", () => {
		const result = verifyTabbyHeaderSecret(headersWith([HEADER, VALUE]), {
			headerName: HEADER,
			headerValue: VALUE,
		});
		expect(result).toEqual({ ok: true });
	});
	it("rejects when header is missing", () => {
		const result = verifyTabbyHeaderSecret(headersWith(), {
			headerName: HEADER,
			headerValue: VALUE,
		});
		expect(result).toEqual({ ok: false, reason: expect.stringContaining("missing") });
	});
	it("rejects on length mismatch (timing-attack guard)", () => {
		const result = verifyTabbyHeaderSecret(headersWith([HEADER, "short"]), {
			headerName: HEADER,
			headerValue: VALUE,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/length/);
	});
	it("rejects when value differs (same length)", () => {
		const wrong = "x".repeat(VALUE.length);
		const result = verifyTabbyHeaderSecret(headersWith([HEADER, wrong]), {
			headerName: HEADER,
			headerValue: VALUE,
		});
		expect(result).toEqual({ ok: false, reason: expect.stringContaining("mismatch") });
	});
	it("matches case-insensitive header names (Headers API contract)", () => {
		const result = verifyTabbyHeaderSecret(headersWith([HEADER.toLowerCase(), VALUE]), {
			headerName: HEADER,
			headerValue: VALUE,
		});
		expect(result).toEqual({ ok: true });
	});
});
