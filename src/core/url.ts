import { z } from "zod";
export type AbsoluteUrl = `http://${string}` | `https://${string}`;
export function isAbsoluteUrl(value: string): value is AbsoluteUrl {
	try {
		const parsed = new URL(value);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.length > 0;
	} catch {
		return false;
	}
}
export function createAbsoluteUrlSchema(maxLength?: number): z.ZodType<AbsoluteUrl> {
	return z.custom<AbsoluteUrl>(
		(value) =>
			typeof value === "string" &&
			(maxLength === undefined || value.length <= maxLength) &&
			isAbsoluteUrl(value),
		{
			message:
				maxLength === undefined
					? "Expected an absolute HTTP(S) URL"
					: `Expected an absolute HTTP(S) URL up to ${maxLength} characters`,
		},
	);
}
export const absoluteUrlSchema = createAbsoluteUrlSchema();
export const absoluteUrlMax1024Schema = createAbsoluteUrlSchema(1024);
