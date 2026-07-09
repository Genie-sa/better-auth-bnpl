import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	TamaraWebhookVerificationError,
	extractTamaraToken,
	verifyTamaraJwt,
} from "../../../providers/tamara/webhook-verify";
const SECRET = "test-notification-token-32-bytes-or-more-of-entropy";
function base64UrlEncode(input: Buffer | string): string {
	const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
	return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function buildJwt(
	header: Record<string, unknown>,
	payload: Record<string, unknown>,
	secret: string = SECRET,
): string {
	const fullPayload = { iss: "Tamara", ...payload };
	const encHeader = base64UrlEncode(JSON.stringify(header));
	const encPayload = base64UrlEncode(JSON.stringify(fullPayload));
	const signature = createHmac("sha256", secret).update(`${encHeader}.${encPayload}`).digest();
	return `${encHeader}.${encPayload}.${base64UrlEncode(signature)}`;
}
describe("verifyTamaraJwt", () => {
	it("accepts a valid HS256 JWT", () => {
		const token = buildJwt({ alg: "HS256", typ: "JWT" }, { iat: Math.floor(Date.now() / 1000) });
		const { header, payload } = verifyTamaraJwt(token, SECRET);
		expect(header.alg).toBe("HS256");
		expect(payload.iat).toBeTypeOf("number");
		expect(payload.iss).toBe("Tamara");
	});
	it("rejects a tampered signature", () => {
		const token = buildJwt({ alg: "HS256", typ: "JWT" }, { iat: 1 });
		const tampered = `${token.slice(0, -10)}AAAAAAAAAA`;
		expect(() => verifyTamaraJwt(tampered, SECRET)).toThrow(TamaraWebhookVerificationError);
	});
	it("rejects when signed with the wrong secret", () => {
		const token = buildJwt({ alg: "HS256", typ: "JWT" }, { iat: 1 }, "wrong-secret");
		expect(() => verifyTamaraJwt(token, SECRET)).toThrow(/Invalid JWT signature/);
	});
	it("rejects malformed JWTs", () => {
		expect(() => verifyTamaraJwt("not.a.jwt-segment", SECRET)).toThrow();
		expect(() => verifyTamaraJwt("only-one-segment", SECRET)).toThrow(/3 segments/);
	});
	it("rejects non-HS256 algorithms", () => {
		const token = buildJwt({ alg: "RS256", typ: "JWT" }, { iat: 1 });
		expect(() => verifyTamaraJwt(token, SECRET)).toThrow(/Unsupported JWT algorithm/);
	});
	it("rejects expired tokens (exp claim)", () => {
		const token = buildJwt(
			{ alg: "HS256", typ: "JWT" },
			{ iat: 1, exp: Math.floor(Date.now() / 1000) - 60 },
		);
		expect(() => verifyTamaraJwt(token, SECRET)).toThrow(/expired/);
	});
	it("rejects a validly-signed token whose issuer is not Tamara", () => {
		const token = buildJwt({ alg: "HS256", typ: "JWT" }, { iss: "attacker", iat: 1 });
		expect(() => verifyTamaraJwt(token, SECRET)).toThrow(/issuer/);
	});
});
describe("extractTamaraToken", () => {
	it("reads ?tamaraToken= query param", () => {
		const token = extractTamaraToken({
			url: "https://example.com/x?tamaraToken=abc.def.ghi",
			headers: new Headers(),
		});
		expect(token).toBe("abc.def.ghi");
	});
	it("falls back to Authorization: Bearer", () => {
		const headers = new Headers({ Authorization: "Bearer xyz.123.456" });
		const token = extractTamaraToken({ url: "https://example.com/x", headers });
		expect(token).toBe("xyz.123.456");
	});
	it("returns null when no token is present", () => {
		const token = extractTamaraToken({
			url: "https://example.com/x",
			headers: new Headers(),
		});
		expect(token).toBeNull();
	});
	it("prefers query param over Authorization header", () => {
		const headers = new Headers({ Authorization: "Bearer header.token" });
		const token = extractTamaraToken({
			url: "https://example.com/x?tamaraToken=query.token",
			headers,
		});
		expect(token).toBe("query.token");
	});
});
