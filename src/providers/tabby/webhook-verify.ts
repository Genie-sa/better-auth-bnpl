import { timingSafeEqual } from "node:crypto";
export class TabbyWebhookVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TabbyWebhookVerificationError";
	}
}
export interface TabbyWebhookSecretConfig {
	headerName: string;
	headerValue: string;
}
export function verifyTabbyHeaderSecret(
	headers: Headers,
	config: TabbyWebhookSecretConfig,
):
	| {
			ok: true;
	  }
	| {
			ok: false;
			reason: string;
	  } {
	const received = headers.get(config.headerName);
	if (!received) {
		return { ok: false, reason: `missing webhook header \`${config.headerName}\`` };
	}
	const expectedBuf = Buffer.from(config.headerValue, "utf8");
	const receivedBuf = Buffer.from(received, "utf8");
	if (expectedBuf.length !== receivedBuf.length) {
		return { ok: false, reason: "webhook header value length mismatch" };
	}
	if (!timingSafeEqual(expectedBuf, receivedBuf)) {
		return { ok: false, reason: "webhook header value mismatch" };
	}
	return { ok: true };
}
