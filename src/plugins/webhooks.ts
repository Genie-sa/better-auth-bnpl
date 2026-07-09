import type { GenericEndpointContext, Where } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import { BNPL_ERROR_CODES, BnplProviderError } from "../core/errors";
import { isRecord } from "../core/guards";
import { extractMinorAmount, formatAmount } from "../core/money";
import type { BnplProvider } from "../core/provider";
import {
	type CanonicalStatus,
	canTransition,
	deriveCapturedStatus,
	deriveRefundedStatus,
} from "../core/status";
import type { BnplWebhookEvent } from "../core/types";
import type { BnplEndpointRecord, BnplOptions } from "../plugin-types";
import { type AdminAuthorizer, assertAdmin } from "./admin";
import { buildAuthoriseOrderUpdate } from "./authorise-update";
import { OrderStoreMissingError, mutateOrder } from "./order-store";
import { assertPersistedOrders } from "./persistence";
import {
	type StoredWebhookEvent,
	markWebhookEventFailed,
	markWebhookEventOrderApplied,
	markWebhookEventProcessed,
	recordSyntheticCaptureEvent,
	recordWebhookEvent,
} from "./webhook-events";
export type AutoAuthoriseOutcome =
	| {
			status: "authorised";
			raw: unknown;
	  }
	| {
			status: "already-authorised";
	  }
	| {
			status: "disabled";
	  }
	| {
			status: "not-applicable";
	  }
	| {
			status: "failed";
			error: Error;
	  };
export interface StatusChangeContext {
	provider: string;
	orderId: string;
	from: string | null;
	to: CanonicalStatus | string;
	event: BnplWebhookEvent;
}
export interface WebhookDispatchContext {
	provider: string;
	event: BnplWebhookEvent;
	autoAuthoriseResult?: AutoAuthoriseOutcome;
}
export type DispatchContextOf<K extends BnplWebhookEvent["kind"]> = Omit<
	WebhookDispatchContext,
	"event"
> & {
	event: Extract<
		BnplWebhookEvent,
		{
			kind: K;
		}
	>;
};
export interface ProviderSpecificHandlers {
	tamara?: {
		onAuthoriseNotification?: (
			payload: Record<string, unknown>,
			ctx: {
				autoAuthoriseResult: AutoAuthoriseOutcome;
			},
		) => Promise<void> | void;
	};
	tabby?: {
		onPaymentClosed?: (payload: Record<string, unknown>) => Promise<void> | void;
	};
}
export interface WebhookRedeliveryOptions {
	isAuthorized: AdminAuthorizer;
}
export interface WebhooksSubpluginOptions extends ProviderSpecificHandlers {
	onPayload?: (ctx: WebhookDispatchContext) => Promise<void> | void;
	onStatusChange?: (ctx: StatusChangeContext) => Promise<void> | void;
	redelivery?: WebhookRedeliveryOptions;
	onApproved?: (ctx: DispatchContextOf<"approved">) => Promise<void> | void;
	onAuthorized?: (ctx: DispatchContextOf<"authorized">) => Promise<void> | void;
	onCaptured?: (ctx: DispatchContextOf<"captured">) => Promise<void> | void;
	onRefunded?: (ctx: DispatchContextOf<"refunded">) => Promise<void> | void;
	onCanceled?: (ctx: DispatchContextOf<"canceled">) => Promise<void> | void;
	onExpired?: (ctx: DispatchContextOf<"expired">) => Promise<void> | void;
	onDeclined?: (ctx: DispatchContextOf<"declined">) => Promise<void> | void;
	onUpdated?: (ctx: DispatchContextOf<"updated">) => Promise<void> | void;
}
interface StoredOrder {
	provider: string;
	status: string;
	amountMinor: number;
	currency: string;
	authorisedAt?: Date;
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	version?: number;
}
interface OrderUpdate {
	status: string;
	updatedAt: Date;
	rawData: string;
	authorisedAt?: Date;
	capturedAt?: Date;
	capturedAmountMinor?: number;
	canceledAt?: Date;
	refundedAmountMinor?: number;
}
interface AutoAuthoriseStoredOrder {
	status: string;
	authorisedAt?: Date;
	amountMinor: number;
	capturedAmountMinor: number;
	currency: string;
	version?: number;
}
interface PersistedStatusChange {
	from: string;
	to: CanonicalStatus | string;
	provider: string;
}
function webhookOrderWhere(providerId: string, providerOrderId: string): Where[] {
	return [
		{ field: "provider", value: providerId },
		{ field: "providerOrderId", value: providerOrderId },
	];
}
export const webhooks = (webhookOptions: WebhooksSubpluginOptions = {}) => {
	return (providers: Record<string, BnplProvider>, options: BnplOptions) => {
		const endpoints: BnplEndpointRecord = {
			bnplWebhook: createAuthEndpoint(
				"/bnpl/webhooks/:provider",
				{
					method: "POST",
					metadata: { isAction: false },
					cloneRequest: true,
				},
				async (ctx) => {
					if (!ctx.request) {
						throw new APIError("BAD_REQUEST", { message: "No request on context" });
					}
					const providerId = ctx.params?.provider;
					if (!providerId) {
						throw new APIError("NOT_FOUND", {
							message: BNPL_ERROR_CODES.WEBHOOK_PROVIDER_UNKNOWN.message,
							code: "WEBHOOK_PROVIDER_UNKNOWN",
						});
					}
					const provider = providers[providerId];
					if (!provider) {
						throw new APIError("NOT_FOUND", {
							message: `${BNPL_ERROR_CODES.WEBHOOK_PROVIDER_UNKNOWN.message}: \`${providerId}\``,
							code: "WEBHOOK_PROVIDER_UNKNOWN",
						});
					}
					const rawBody = await ctx.request.text();
					const verification = await provider.verifyWebhook({
						url: ctx.request.url,
						headers: ctx.request.headers,
						rawBody,
					});
					if (!verification.ok) {
						ctx.context.logger.warn(`bnpl: ${providerId} webhook rejected: ${verification.reason}`);
						throw new APIError("UNAUTHORIZED", {
							message: verification.reason,
							code: "WEBHOOK_INVALID_SIGNATURE",
						});
					}
					const event = provider.toCanonicalEvent(verification.payload);
					if (!event) {
						ctx.context.logger.warn(
							`bnpl: ${providerId} webhook unrecognised shape — raw: ${rawBody.slice(0, 600)}`,
						);
						throw new APIError("BAD_REQUEST", {
							message: BNPL_ERROR_CODES.WEBHOOK_UNKNOWN_SHAPE.message,
							code: "WEBHOOK_UNKNOWN_SHAPE",
						});
					}
					if (!options.persistOrders) {
						const autoAuthoriseResult = await resolveAutoAuthorise(provider, ctx, event, options, {
							alreadyProcessed: false,
						});
						throwIfAutoAuthoriseFailed(autoAuthoriseResult);
						await runCaptureOnAuthorized(provider, ctx, event, options);
						await runHandlers(provider, event, verification.payload, autoAuthoriseResult, {
							statusChange: null,
							webhookOptions,
							dispatchTyped: true,
						});
						return ackReceived(ctx, providerId, event);
					}
					const record = await recordWebhookEvent(ctx, {
						provider: provider.id,
						event,
						dedupKey: verification.dedupKey,
						rawBody: verification.rawBody,
					});
					if (record.outcome === "infra-error") {
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: BNPL_ERROR_CODES.WEBHOOK_PERSIST_FAILED.message,
							code: "WEBHOOK_PERSIST_FAILED",
						});
					}
					if (record.outcome === "unrecordable") {
						const autoAuthoriseResult: AutoAuthoriseOutcome = { status: "not-applicable" };
						await runHandlers(provider, event, verification.payload, autoAuthoriseResult, {
							statusChange: null,
							webhookOptions,
							dispatchTyped: false,
						});
						return ackReceived(ctx, providerId, event);
					}
					if (record.outcome === "duplicate") {
						ctx.context.logger.info(
							`bnpl: ${providerId} webhook duplicate acknowledged — kind=${event.kind} dedupKey=${verification.dedupKey}`,
						);
						return ctx.json({ received: true, kind: event.kind, duplicate: true });
					}
					return processDelivery(ctx, provider, event, verification, record.row, options, {
						webhookOptions,
					});
				},
			),
		};
		if (webhookOptions.redelivery) {
			endpoints.bnplListWebhookEvents = buildListWebhookEventsEndpoint(
				webhookOptions.redelivery,
				options,
			);
			endpoints.bnplRedeliverWebhookEvent = buildRedeliverWebhookEventEndpoint(
				providers,
				webhookOptions,
				options,
			);
		}
		return endpoints;
	};
};
const listWebhookEventsQuerySchema = z
	.object({
		status: z.string().optional(),
		provider: z.string().optional(),
		providerOrderId: z.string().optional(),
		limit: z.coerce.number().min(1).max(100).optional(),
		offset: z.coerce.number().min(0).optional(),
	})
	.optional();
function buildListWebhookEventsEndpoint(
	redelivery: WebhookRedeliveryOptions,
	options: BnplOptions,
) {
	return createAuthEndpoint(
		"/bnpl/admin/webhook-events",
		{ method: "GET", query: listWebhookEventsQuerySchema, use: [sessionMiddleware] },
		async (ctx) => {
			await assertAdmin(redelivery.isAuthorized, ctx);
			assertPersistedOrders(options);
			const where: Where[] = [];
			if (ctx.query?.status) where.push({ field: "status", value: ctx.query.status });
			if (ctx.query?.provider) where.push({ field: "provider", value: ctx.query.provider });
			if (ctx.query?.providerOrderId) {
				where.push({ field: "providerOrderId", value: ctx.query.providerOrderId });
			}
			const events = await ctx.context.adapter.findMany({
				model: "bnplWebhookEvent",
				where: where.length > 0 ? where : undefined,
				limit: ctx.query?.limit ?? 20,
				offset: ctx.query?.offset ?? 0,
				sortBy: { field: "receivedAt", direction: "desc" },
			});
			return ctx.json({ events });
		},
	);
}
function buildRedeliverWebhookEventEndpoint(
	providers: Record<string, BnplProvider>,
	webhookOptions: WebhooksSubpluginOptions,
	options: BnplOptions,
) {
	const redelivery = webhookOptions.redelivery;
	return createAuthEndpoint(
		"/bnpl/admin/webhook-events/:id/redeliver",
		{ method: "POST", use: [sessionMiddleware] },
		async (ctx) => {
			if (!redelivery) {
				throw new APIError("NOT_FOUND", {
					message: BNPL_ERROR_CODES.WEBHOOK_EVENT_NOT_FOUND.message,
					code: "WEBHOOK_EVENT_NOT_FOUND",
				});
			}
			await assertAdmin(redelivery.isAuthorized, ctx);
			assertPersistedOrders(options);
			const id = ctx.params?.id;
			if (!id) {
				throw new APIError("BAD_REQUEST", { message: "webhook event id is required" });
			}
			const row = await ctx.context.adapter.findOne<StoredWebhookEvent>({
				model: "bnplWebhookEvent",
				where: [{ field: "id", value: id }],
			});
			if (!row) {
				throw new APIError("NOT_FOUND", {
					message: BNPL_ERROR_CODES.WEBHOOK_EVENT_NOT_FOUND.message,
					code: "WEBHOOK_EVENT_NOT_FOUND",
				});
			}
			const provider = providers[row.provider];
			if (!provider) {
				throw new APIError("BAD_REQUEST", {
					message: `${BNPL_ERROR_CODES.PROVIDER_NOT_CONFIGURED.message}: \`${row.provider}\``,
					code: "PROVIDER_NOT_CONFIGURED",
				});
			}
			const parsed = parseStoredRawData(row.rawData);
			if (!parsed) {
				throw new APIError("BAD_REQUEST", {
					message: BNPL_ERROR_CODES.WEBHOOK_EVENT_NOT_REPLAYABLE.message,
					code: "WEBHOOK_EVENT_NOT_REPLAYABLE",
				});
			}
			const event = provider.toCanonicalEvent(parsed);
			if (!event) {
				throw new APIError("BAD_REQUEST", {
					message: BNPL_ERROR_CODES.WEBHOOK_EVENT_NOT_REPLAYABLE.message,
					code: "WEBHOOK_EVENT_NOT_REPLAYABLE",
				});
			}
			try {
				const statusChange = await persistOrderUpdate(
					ctx,
					provider,
					event,
					row.rawData ?? JSON.stringify(parsed),
					{ skipMoneyDelta: row.orderApplied === true },
				);
				await markWebhookEventOrderApplied(ctx, row);
				const autoAuthoriseResult = await resolveAutoAuthorise(provider, ctx, event, options, {
					alreadyProcessed: false,
				});
				throwIfAutoAuthoriseFailed(autoAuthoriseResult);
				await runCaptureOnAuthorized(provider, ctx, event, options);
				await runHandlers(provider, event, parsed, autoAuthoriseResult, {
					statusChange,
					webhookOptions,
					dispatchTyped: true,
				});
				await markWebhookEventProcessed(ctx, row);
				return ctx.json({ redelivered: true, status: "processed", kind: event.kind });
			} catch (e) {
				await markWebhookEventFailed(ctx, row, e);
				ctx.context.logger.error(
					`bnpl: redelivery of webhook event ${id} failed: ${e instanceof Error ? e.message : e}`,
				);
				throw new APIError("INTERNAL_SERVER_ERROR", {
					message: BNPL_ERROR_CODES.WEBHOOK_REDELIVERY_FAILED.message,
					code: "WEBHOOK_REDELIVERY_FAILED",
				});
			}
		},
	);
}
function parseStoredRawData(rawData: string | null | undefined): Record<string, unknown> | null {
	if (!rawData) return null;
	try {
		const parsed: unknown = JSON.parse(rawData);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
interface WebhookAck {
	received: true;
	kind: BnplWebhookEvent["kind"];
	duplicate?: true;
}
function ackReceived(
	ctx: GenericEndpointContext,
	providerId: string,
	event: BnplWebhookEvent,
): Promise<WebhookAck> {
	const orderIdStr = "orderId" in event ? (event.orderId ?? "—") : "—";
	ctx.context.logger.info(
		`bnpl: ${providerId} webhook processed — kind=${event.kind} orderId=${orderIdStr}`,
	);
	return ctx.json({ received: true, kind: event.kind });
}
async function processDelivery(
	ctx: GenericEndpointContext,
	provider: BnplProvider,
	event: BnplWebhookEvent,
	verification: Extract<
		Awaited<ReturnType<BnplProvider["verifyWebhook"]>>,
		{
			ok: true;
		}
	>,
	row: StoredWebhookEvent,
	options: BnplOptions,
	deps: {
		webhookOptions: WebhooksSubpluginOptions;
	},
): Promise<WebhookAck> {
	try {
		const statusChange = await persistOrderUpdate(ctx, provider, event, verification.rawBody, {
			skipMoneyDelta: row.orderApplied === true,
		});
		await markWebhookEventOrderApplied(ctx, row);
		const autoAuthoriseResult = await resolveAutoAuthorise(provider, ctx, event, options, {
			alreadyProcessed: false,
		});
		throwIfAutoAuthoriseFailed(autoAuthoriseResult);
		await runCaptureOnAuthorized(provider, ctx, event, options);
		await runHandlers(provider, event, verification.payload, autoAuthoriseResult, {
			statusChange,
			webhookOptions: deps.webhookOptions,
			dispatchTyped: true,
		});
		await markWebhookEventProcessed(ctx, row);
	} catch (e) {
		ctx.context.logger.error(
			`bnpl: ${provider.id} webhook processing failed — kind=${event.kind} dedupKey=${verification.dedupKey}: ${e instanceof Error ? e.message : e}`,
		);
		await markWebhookEventFailed(ctx, row, e);
		throw new APIError("INTERNAL_SERVER_ERROR", {
			message: BNPL_ERROR_CODES.WEBHOOK_HANDLER_FAILED.message,
			code: "WEBHOOK_HANDLER_FAILED",
		});
	}
	return ackReceived(ctx, provider.id, event);
}
async function resolveAutoAuthorise(
	provider: BnplProvider,
	ctx: GenericEndpointContext,
	event: BnplWebhookEvent,
	options: BnplOptions,
	flags: {
		alreadyProcessed: boolean;
	},
): Promise<AutoAuthoriseOutcome> {
	if (event.kind === "approved") {
		return runAutoAuthorise(provider, ctx, event, options, flags.alreadyProcessed);
	}
	if (event.kind === "authorized") return { status: "not-applicable" };
	return { status: "disabled" };
}
function throwIfAutoAuthoriseFailed(result: AutoAuthoriseOutcome): void {
	if (result.status === "failed") throw result.error;
}
async function runCaptureOnAuthorized(
	provider: BnplProvider,
	ctx: GenericEndpointContext,
	event: BnplWebhookEvent,
	options: BnplOptions,
): Promise<void> {
	if (event.kind !== "authorized" || !options.captureOnAuthorise) return;
	await runAutoCapture(provider, ctx, event.orderId, options);
}
async function runHandlers(
	provider: BnplProvider,
	event: BnplWebhookEvent,
	payload: Record<string, unknown>,
	autoAuthoriseResult: AutoAuthoriseOutcome,
	deps: {
		statusChange: PersistedStatusChange | null;
		webhookOptions: WebhooksSubpluginOptions;
		dispatchTyped: boolean;
	},
): Promise<void> {
	const { webhookOptions } = deps;
	const dispatchCtx: WebhookDispatchContext = {
		provider: provider.id,
		event,
		autoAuthoriseResult: event.kind === "approved" ? autoAuthoriseResult : undefined,
	};
	await webhookOptions.onPayload?.(dispatchCtx);
	if (provider.id === "tamara") {
		if (typeof payload.order_status === "string") {
			await webhookOptions.tamara?.onAuthoriseNotification?.(payload, { autoAuthoriseResult });
		}
	}
	if (provider.id === "tabby") {
		if (isClosedTabbyPayload(payload)) {
			await webhookOptions.tabby?.onPaymentClosed?.(payload);
		}
	}
	if (deps.dispatchTyped) {
		await dispatchTyped(provider.id, event, autoAuthoriseResult, webhookOptions);
	}
	if (deps.statusChange && webhookOptions.onStatusChange) {
		await webhookOptions.onStatusChange({
			provider: deps.statusChange.provider,
			orderId: "orderId" in event ? (event.orderId ?? "") : "",
			from: deps.statusChange.from,
			to: deps.statusChange.to,
			event,
		});
	}
}
function isClosedTabbyPayload(payload: Record<string, unknown>): boolean {
	const status = payload.status;
	if (typeof status === "string" && status.toLowerCase() === "closed") return true;
	const legacyEvent = payload.event;
	return typeof legacyEvent === "string" && legacyEvent.toLowerCase().includes("closed");
}
async function dispatchTyped(
	provider: string,
	event: BnplWebhookEvent,
	autoAuthoriseResult: AutoAuthoriseOutcome | undefined,
	opts: WebhooksSubpluginOptions,
): Promise<void> {
	switch (event.kind) {
		case "approved":
			await opts.onApproved?.({ provider, event, autoAuthoriseResult });
			return;
		case "authorized":
			await opts.onAuthorized?.({ provider, event, autoAuthoriseResult });
			return;
		case "captured":
			await opts.onCaptured?.({ provider, event, autoAuthoriseResult });
			return;
		case "refunded":
			await opts.onRefunded?.({ provider, event, autoAuthoriseResult });
			return;
		case "canceled":
			await opts.onCanceled?.({ provider, event, autoAuthoriseResult });
			return;
		case "expired":
			await opts.onExpired?.({ provider, event, autoAuthoriseResult });
			return;
		case "declined":
			await opts.onDeclined?.({ provider, event, autoAuthoriseResult });
			return;
		case "updated":
			await opts.onUpdated?.({ provider, event, autoAuthoriseResult });
			return;
		case "unknown":
			return;
	}
}
async function persistOrderUpdate(
	ctx: GenericEndpointContext,
	provider: BnplProvider,
	event: BnplWebhookEvent,
	rawBody: string,
	flags: {
		skipMoneyDelta: boolean;
	} = { skipMoneyDelta: false },
): Promise<PersistedStatusChange | null> {
	const orderId = "orderId" in event ? event.orderId : undefined;
	if (!orderId) return null;
	let statusChange: PersistedStatusChange | null = null;
	try {
		await mutateOrder<StoredOrder>(
			ctx,
			() => webhookOrderWhere(provider.id, orderId),
			(existing) => {
				const now = new Date();
				const update: OrderUpdate = {
					status: existing.status,
					updatedAt: now,
					rawData: rawBody,
				};
				const candidate = computeEventTarget(
					event,
					existing,
					now,
					update,
					ctx.context.logger,
					flags.skipMoneyDelta,
				);
				const finalStatus =
					candidate !== existing.status && canTransition(existing.status, candidate)
						? candidate
						: applyRegressionGuard(existing.status, candidate, event, ctx.context.logger);
				update.status = finalStatus;
				statusChange =
					finalStatus !== existing.status
						? { from: existing.status, to: finalStatus, provider: existing.provider }
						: null;
				return { ...update };
			},
		);
	} catch (e) {
		if (e instanceof OrderStoreMissingError) {
			ctx.context.logger.warn(
				`bnpl: no persisted row for provider=${provider.id} providerOrderId=${orderId} — skipping update`,
			);
			return null;
		}
		throw e;
	}
	return statusChange;
}
function computeEventTarget(
	event: BnplWebhookEvent,
	existing: StoredOrder,
	now: Date,
	update: OrderUpdate,
	logger: {
		warn: (msg: string) => void;
	},
	skipMoneyDelta: boolean,
): CanonicalStatus | string {
	switch (event.kind) {
		case "approved":
			return "approved";
		case "authorized":
			update.authorisedAt = now;
			return "authorised";
		case "declined":
			return "declined";
		case "expired":
			return "expired";
		case "canceled":
			update.canceledAt = now;
			return "canceled";
		case "captured": {
			const cumulative = skipMoneyDelta
				? existing.capturedAmountMinor
				: applyCaptureDelta(event, existing, update, now, logger);
			if (cumulative === null) return existing.status;
			return deriveCapturedStatus({
				totalAmountMinor: existing.amountMinor,
				cumulativeMinor: cumulative,
			});
		}
		case "refunded": {
			const cumulative = skipMoneyDelta
				? existing.refundedAmountMinor
				: applyRefundDelta(event, existing, update, logger);
			if (cumulative === null) return existing.status;
			return deriveRefundedStatus({
				totalAmountMinor: existing.amountMinor,
				cumulativeMinor: cumulative,
			});
		}
		default:
			return existing.status;
	}
}
function applyCaptureDelta(
	event: BnplWebhookEvent,
	existing: StoredOrder,
	update: OrderUpdate,
	now: Date,
	logger: {
		warn: (msg: string) => void;
	},
): number | null {
	const delta = pickCaptureDelta(event, existing, logger);
	if (delta === null) return null;
	const cumulative = existing.capturedAmountMinor + delta;
	update.capturedAmountMinor = cumulative;
	update.capturedAt = now;
	return cumulative;
}
function applyRefundDelta(
	event: BnplWebhookEvent,
	existing: StoredOrder,
	update: OrderUpdate,
	logger: {
		warn: (msg: string) => void;
	},
): number | null {
	const delta = pickRefundDelta(event, existing, logger);
	if (delta === null) return null;
	const cumulative = existing.refundedAmountMinor + delta;
	update.refundedAmountMinor = cumulative;
	return cumulative;
}
function applyRegressionGuard(
	currentStatus: string,
	candidate: CanonicalStatus | string,
	event: BnplWebhookEvent,
	logger: {
		warn: (msg: string) => void;
	},
): string {
	if (candidate === currentStatus) return currentStatus;
	logger.warn(
		`bnpl: ignoring status regression for ${event.kind} event — ${currentStatus} → ${candidate} is not a legitimate forward transition; keeping ${currentStatus}`,
	);
	return currentStatus;
}
function pickCaptureDelta(
	event: BnplWebhookEvent,
	existing: StoredOrder,
	logger: {
		warn: (msg: string) => void;
	},
): number | null {
	if (event.kind !== "captured") return null;
	if (event.currency !== existing.currency) {
		logger.warn(
			`bnpl: captured event currency ${event.currency} differs from order currency ${existing.currency} — skipping delta`,
		);
		return null;
	}
	if (event.amountMinor > 0) return event.amountMinor;
	const data = isRecord(event.raw) ? event.raw.data : undefined;
	return extractMinorAmount(data, "captured_amount", existing.currency, logger);
}
function pickRefundDelta(
	event: BnplWebhookEvent,
	existing: StoredOrder,
	logger: {
		warn: (msg: string) => void;
	},
): number | null {
	if (event.kind !== "refunded") return null;
	if (event.currency !== existing.currency) {
		logger.warn(
			`bnpl: refunded event currency ${event.currency} differs from order currency ${existing.currency} — skipping delta`,
		);
		return null;
	}
	if (event.amountMinor > 0) return event.amountMinor;
	const data = isRecord(event.raw) ? event.raw.data : undefined;
	return extractMinorAmount(data, "refunded_amount", existing.currency, logger);
}
async function runAutoAuthorise(
	provider: BnplProvider,
	ctx: GenericEndpointContext,
	event: BnplWebhookEvent,
	options: BnplOptions,
	alreadyProcessed: boolean,
): Promise<AutoAuthoriseOutcome> {
	if (event.kind !== "approved") return { status: "not-applicable" };
	if (!provider.capabilities.separateAuthorise || !provider.authorize) {
		return { status: "not-applicable" };
	}
	if (options.autoAuthorise === false) return { status: "disabled" };
	if (alreadyProcessed) return { status: "already-authorised" };
	const orderId = event.orderId;
	let stored: AutoAuthoriseStoredOrder | null = null;
	if (options.persistOrders) {
		stored = await ctx.context.adapter.findOne<AutoAuthoriseStoredOrder>({
			model: "bnplOrder",
			where: webhookOrderWhere(provider.id, orderId),
		});
		if (stored?.status === "authorised" || stored?.authorisedAt) {
			return { status: "already-authorised" };
		}
	}
	try {
		const result = await provider.authorize(orderId, { logger: ctx.context.logger });
		let capturedAmountMinor: number | undefined;
		let storedCurrency: string | undefined;
		if (options.persistOrders) {
			const mutation = await mutateOrder<AutoAuthoriseStoredOrder>(
				ctx,
				() => webhookOrderWhere(provider.id, orderId),
				(row) => {
					const updateResult = buildAuthoriseOrderUpdate(result, {
						amountMinor: row.amountMinor,
						capturedAmountMinor: row.capturedAmountMinor ?? 0,
					});
					capturedAmountMinor = updateResult.capturedAmountMinor;
					return { ...updateResult.update };
				},
			);
			storedCurrency = mutation.previous.currency;
		}
		if (result.captureId && capturedAmountMinor !== undefined && storedCurrency) {
			await recordSyntheticCaptureEvent(ctx, provider, orderId, storedCurrency, {
				captureId: result.captureId,
				amountMinor: capturedAmountMinor,
				raw: result.raw,
			});
		}
		if (options.captureOnAuthorise && !result.autoCaptured && result.status !== "fully_captured") {
			await runAutoCapture(provider, ctx, orderId, options);
		}
		return { status: "authorised", raw: result.raw };
	} catch (e) {
		if (e instanceof OrderStoreMissingError) {
			ctx.context.logger.warn(
				`bnpl: auto-authorise could not persist — no row for provider=${provider.id} orderId=${orderId}`,
			);
			return { status: "authorised", raw: undefined };
		}
		if (e instanceof BnplProviderError && e.isAlreadyInTargetState) {
			ctx.context.logger.info(
				`bnpl: ${provider.id} auto-authorise — ${orderId} already authorised upstream`,
			);
			return { status: "already-authorised" };
		}
		ctx.context.logger.error(
			`bnpl: ${provider.id} auto-authorise failed for ${orderId}: ${e instanceof Error ? e.message : e}`,
		);
		return { status: "failed", error: e instanceof Error ? e : new Error(String(e)) };
	}
}
async function runAutoCapture(
	provider: BnplProvider,
	ctx: GenericEndpointContext,
	orderId: string,
	options: BnplOptions,
): Promise<void> {
	if (!options.persistOrders) {
		ctx.context.logger.warn(
			`bnpl: ${provider.id} captureOnAuthorise requires persistOrders — skipping auto-capture for ${orderId}`,
		);
		return;
	}
	try {
		const row = await ctx.context.adapter.findOne<{
			amountMinor: number;
			capturedAmountMinor?: number | null;
			currency: string;
			status?: string | null;
		}>({
			model: "bnplOrder",
			where: webhookOrderWhere(provider.id, orderId),
		});
		if (!row) {
			ctx.context.logger.warn(`bnpl: captureOnAuthorise — no row for ${provider.id}/${orderId}`);
			return;
		}
		if (row.status === "fully_captured" || (row.capturedAmountMinor ?? 0) >= row.amountMinor) {
			ctx.context.logger.info(
				`bnpl: ${provider.id} captureOnAuthorise skipped for ${orderId} — already captured`,
			);
			return;
		}
		const total = formatAmount(row.amountMinor, row.currency);
		const shippingInfo = await options.captureOnAuthoriseShippingInfo?.({
			providerId: provider.id,
			orderId,
			totalAmount: total,
		});
		if (!shippingInfo) {
			ctx.context.logger.warn(
				`bnpl: ${provider.id} captureOnAuthorise requires captureOnAuthoriseShippingInfo — skipping auto-capture for ${orderId}`,
			);
			return;
		}
		const captureResult = await provider.capture(
			orderId,
			{ totalAmount: total, shippingInfo },
			{ logger: ctx.context.logger },
		);
		await mutateOrder<{
			amountMinor: number;
			currency: string;
			version?: number;
		}>(
			ctx,
			() => webhookOrderWhere(provider.id, orderId),
			(current) => ({
				status: "fully_captured",
				capturedAt: new Date(),
				capturedAmountMinor: current.amountMinor,
				updatedAt: new Date(),
			}),
		);
		await recordSyntheticCaptureEvent(ctx, provider, orderId, row.currency, captureResult);
		ctx.context.logger.info(
			`bnpl: ${provider.id} captureOnAuthorise succeeded for ${orderId} (capture_id=${captureResult.captureId})`,
		);
	} catch (e) {
		ctx.context.logger.error(
			`bnpl: ${provider.id} captureOnAuthorise failed for ${orderId}: ${e instanceof Error ? e.message : e}`,
		);
		throw e;
	}
}
