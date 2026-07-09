import type { z } from "zod";
import { BnplProviderError } from "../core/errors";
import { isRecord } from "../core/guards";
import type { ProviderFetch } from "../core/provider";
export type ProviderHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15000;
const MAX_GET_RETRIES = 2;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const BASE_BACKOFF_MS = 250;
export type SleepFn = (ms: number) => Promise<void>;
const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
type ProviderBody<TSchema extends z.ZodTypeAny | undefined> = TSchema extends z.ZodTypeAny
	? z.input<TSchema>
	: unknown;
interface ProviderRequest<TBodySchema extends z.ZodTypeAny | undefined = undefined> {
	provider: string;
	providerName: string;
	baseUrl: string;
	fetchImpl: ProviderFetch;
	method: ProviderHttpMethod;
	path: string;
	headers: Record<string, string>;
	body?: ProviderBody<TBodySchema>;
	bodySchema?: TBodySchema;
	label?: string;
	timeoutMs?: number;
	sleep?: SleepFn;
}
interface ProviderJsonRequest<
	TResponseSchema extends z.ZodTypeAny,
	TBodySchema extends z.ZodTypeAny | undefined = undefined,
> extends ProviderRequest<TBodySchema> {
	schema: TResponseSchema;
	label: string;
}
function isRetryableMethod(method: ProviderHttpMethod): boolean {
	return method === "GET";
}
function isTimeoutError(err: unknown): boolean {
	return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
function backoffDelayMs(attempt: number): number {
	const ceiling = BASE_BACKOFF_MS * 2 ** attempt;
	return Math.floor(Math.random() * ceiling);
}
async function requestProviderRaw<TBodySchema extends z.ZodTypeAny | undefined = undefined>(
	request: ProviderRequest<TBodySchema>,
): Promise<unknown> {
	const {
		provider,
		providerName,
		baseUrl,
		fetchImpl,
		method,
		path,
		headers,
		body,
		bodySchema,
		label,
	} = request;
	const timeoutMs = request.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
	const sleep = request.sleep ?? realSleep;
	const serializedBody = serializeProviderRequestBody({
		provider,
		providerName,
		method,
		path,
		body,
		bodySchema,
		label,
	});
	const maxAttempts = isRetryableMethod(method) ? MAX_GET_RETRIES + 1 : 1;
	const url = `${baseUrl}${path}`;
	const what = label ?? `${method} ${path}`;
	let lastError: BnplProviderError | undefined;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const res = await fetchImpl(url, {
				method,
				headers,
				body: serializedBody,
				signal: AbortSignal.timeout(timeoutMs),
			});
			const text = await res.text();
			const parsed = text ? safeJsonParse(text) : null;
			if (!res.ok) {
				const message =
					extractProviderErrorMessage(parsed) ??
					(res.statusText || `${providerName} ${what} failed`);
				const error = new BnplProviderError(provider, message, {
					status: res.status,
					body: parsed ?? text,
				});
				if (attempt + 1 < maxAttempts && RETRYABLE_STATUS.has(res.status)) {
					lastError = error;
					await sleep(backoffDelayMs(attempt));
					continue;
				}
				throw error;
			}
			return parsed;
		} catch (err) {
			if (err instanceof BnplProviderError) throw err;
			const timedOut = isTimeoutError(err);
			const message = timedOut
				? `${providerName} ${what} timed out after ${timeoutMs}ms`
				: `${providerName} ${what} request failed: ${err instanceof Error ? err.message : String(err)}`;
			const error = new BnplProviderError(provider, message, { cause: err });
			if (attempt + 1 < maxAttempts) {
				lastError = error;
				await sleep(backoffDelayMs(attempt));
				continue;
			}
			throw error;
		}
	}
	throw lastError ?? new BnplProviderError(provider, `${providerName} ${what} exhausted retries`);
}
export async function requestProviderJson<
	TResponseSchema extends z.ZodTypeAny,
	TBodySchema extends z.ZodTypeAny | undefined = undefined,
>(request: ProviderJsonRequest<TResponseSchema, TBodySchema>): Promise<z.infer<TResponseSchema>> {
	const raw = await requestProviderRaw(request);
	const result = request.schema.safeParse(raw);
	if (!result.success) {
		throw new BnplProviderError(
			request.provider,
			`${request.providerName} ${request.label} returned unexpected shape`,
			{
				body: raw,
				cause: result.error,
			},
		);
	}
	return result.data;
}
export async function requestProviderVoid(request: ProviderRequest): Promise<void> {
	const raw = await requestProviderRaw(request);
	if (raw !== null) {
		throw new BnplProviderError(
			request.provider,
			`${request.providerName} ${request.method} ${request.path} returned unexpected shape`,
			{
				body: raw,
			},
		);
	}
}
interface SerializeProviderRequestBodyInput {
	provider: string;
	providerName: string;
	method: ProviderHttpMethod;
	path: string;
	body: unknown;
	bodySchema?: z.ZodTypeAny;
	label?: string;
}
function serializeProviderRequestBody({
	provider,
	providerName,
	method,
	path,
	body,
	bodySchema,
	label,
}: SerializeProviderRequestBodyInput): BodyInit | undefined {
	if (bodySchema === undefined && body === undefined) return undefined;
	if (bodySchema === undefined) return JSON.stringify(body);
	const result = bodySchema.safeParse(body);
	if (!result.success) {
		throw new BnplProviderError(
			provider,
			`${providerName} ${label ?? `${method} ${path}`} request body failed validation`,
			{
				body,
				cause: result.error,
			},
		);
	}
	return JSON.stringify(result.data);
}
function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
function extractProviderErrorMessage(body: unknown): string | null {
	if (!isRecord(body)) return null;
	if (typeof body.message === "string") return body.message;
	if (typeof body.error === "string") return body.error;
	const errors = body.errors;
	if (Array.isArray(errors) && errors.length > 0 && isRecord(errors[0])) {
		const firstMessage = errors[0].message;
		if (typeof firstMessage === "string") return firstMessage;
	}
	return null;
}
