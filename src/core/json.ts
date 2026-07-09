import { z } from "zod";
export const jsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof jsonObjectSchema>;
export type JsonObjectParseResult =
	| {
			ok: true;
			data: JsonObject;
	  }
	| {
			ok: false;
			reason: string;
	  };
export function parseJsonObject(text: string): JsonObjectParseResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, reason: "body is not valid JSON" };
	}
	const result = jsonObjectSchema.safeParse(raw);
	if (!result.success) {
		return { ok: false, reason: "body is not a JSON object" };
	}
	return { ok: true, data: result.data };
}
