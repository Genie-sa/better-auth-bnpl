import { createHmac, timingSafeEqual } from "node:crypto";
import { parseJsonObject } from "../../core/json";
export class TamaraWebhookVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TamaraWebhookVerificationError";
	}
}
export interface VerifiedTamaraJwt {
	header: Record<string, unknown>;
	payload: Record<string, unknown>;
}
export function verifyTamaraJwt(token: string, notificationToken: string): VerifiedTamaraJwt {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new TamaraWebhookVerificationError("Malformed JWT: expected 3 segments");
	}
	const [encHeader, encPayload, encSignature] = parts;
	if (encHeader === undefined || encPayload === undefined || encSignature === undefined) {
		throw new TamaraWebhookVerificationError("Malformed JWT: missing segment");
	}
	const header = decodeJsonSegment(encHeader, "header");
	const payload = decodeJsonSegment(encPayload, "payload");
	if (header.alg !== "HS256") {
		throw new TamaraWebhookVerificationError(
			`Unsupported JWT algorithm: ${String(header.alg)} (expected HS256)`,
		);
	}
	const expected = createHmac("sha256", notificationToken)
		.update(`${encHeader}.${encPayload}`)
		.digest();
	const actual = base64UrlDecode(encSignature);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		throw new TamaraWebhookVerificationError("Invalid JWT signature");
	}
	if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
		throw new TamaraWebhookVerificationError("JWT expired");
	}
	if (payload.iss !== "Tamara") {
		throw new TamaraWebhookVerificationError(
			`Unexpected JWT issuer: ${String(payload.iss)} (expected "Tamara")`,
		);
	}
	return { header, payload };
}
export function extractTamaraToken(request: {
	url: string;
	headers: Headers;
}): string | null {
	const url = new URL(request.url);
	const queryToken = url.searchParams.get("tamaraToken");
	if (queryToken) return queryToken;
	const auth = request.headers.get("authorization") ?? request.headers.get("Authorization");
	if (auth?.startsWith("Bearer ")) {
		return auth.slice("Bearer ".length).trim();
	}
	return null;
}
function decodeJsonSegment(segment: string, label: string): Record<string, unknown> {
	try {
		const json = base64UrlDecode(segment).toString("utf8");
		const parsed = parseJsonObject(json);
		if (!parsed.ok) throw new Error(parsed.reason);
		return parsed.data;
	} catch (err) {
		throw new TamaraWebhookVerificationError(
			`Malformed JWT ${label}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
function base64UrlDecode(input: string): Buffer {
	const padLength = (4 - (input.length % 4)) % 4;
	const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLength);
	return Buffer.from(padded, "base64");
}
