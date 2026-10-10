import type { GenericEndpointContext, Where } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import { BNPL_ERROR_CODES, BnplProviderError } from "../core/errors";
import { isRecord } from "../core/guards";
import {
	BNPL_CURRENCIES,
	extractMinorAmount,
	formatAmount,
	isBnplCurrency,
	parseAmount,
} from "../core/money";
import type { BnplProvider } from "../core/provider";
import {
	CANONICAL_STATUSES,
	type CanonicalStatus,
	canTransition,
	deriveCapturedStatus,
	deriveRefundedStatus,
} from "../core/status";
import type { BnplOrderState, BnplWebhookEvent } from "../core/types";
import type { BnplOptions } from "../plugin-types";
import { type AdminAuthorizer, assertAdmin } from "./admin";
import { buildAuthoriseOrderUpdate } from "./authorise-update";
import {
	type MoneyCommandReservation,
	completeMoneyCommand,
	isAuthorisedState,
	recoverLocalAuthoriseCommand,
	releaseRejectedMoneyCommand,
	reserveMoneyCommand,
} from "./money-command";
import { operationReference } from "./operation-reference";
import { OrderStoreMissingError, mutateOrder, readAppliedOperations } from "./order-store";
import { assertPersistedOrders } from "./persistence";
import { readRemoteHistory } from "./remote-history";
import {
	type StoredWebhookEvent,
	claimWebhookEvent,
	markWebhookEventFailed,
	markWebhookEventOrderApplied,
	markWebhookEventProcessed,
	recordSyntheticCaptureEvent,
	recordWebhookEvent,
	saveWebhookDeliveryState,
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
	deliveryId?: string;
}
export interface WebhookDispatchContext {
	provider: string;
	event: BnplWebhookEvent;
	autoAuthoriseResult?: AutoAuthoriseOutcome;
	deliveryId?: string;
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
	canceledAmountMinor?: number;
	provider: string;
	status: string;
	amountMinor: number;
	currency: string;
	authorisedAt?: Date;
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	version?: number;
	appliedOperations?: string | null;
	webhookTransitions?: string | null;
}
interface OrderUpdate {
	status: string;
	updatedAt: Date;
	rawData: string;
	authorisedAt?: Date;
	capturedAt?: Date;
	capturedAmountMinor?: number;
	canceledAt?: Date | null;
	refundedAmountMinor?: number;
	canceledAmountMinor?: number;
}
interface AutoAuthoriseStoredOrder {
	providerOrderId: string;
	canceledAmountMinor?: number;
	status: string;
	authorisedAt?: Date;
	amountMinor: number;
	capturedAmountMinor: number;
	currency: string;
	version?: number;
	appliedOperations?: string | null;
	moneyCommands?: string | null;
	refundedAmountMinor?: number;
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
		const endpoints = {
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
					const canonicalEvents = provider.toCanonicalEvents?.(verification.payload);
					const event = canonicalEvents
						? canonicalEvents[0]
						: provider.toCanonicalEvent(verification.payload);
					if (!event) {
						ctx.context.logger.warn(`bnpl: ${providerId} webhook unrecognised shape`);
						throw new APIError("BAD_REQUEST", {
							message: BNPL_ERROR_CODES.WEBHOOK_UNKNOWN_SHAPE.message,
							code: "WEBHOOK_UNKNOWN_SHAPE",
						});
					}
					if (!options.persistOrders) {
						const events = canonicalEvents ?? [event];
						for (const [index, incomingEvent] of events.entries()) {
							const { event: currentEvent, remote } = await normalizeCancellationEvent(
								provider,
								ctx,
								incomingEvent,
							);
							if (remote)
								readCancellationHistory(
									provider,
									currentEvent,
									{
										provider: provider.id,
										status: remote.status,
										amountMinor: parseAmount(remote.totalAmount),
										currency: remote.totalAmount.currency,
										capturedAmountMinor: 0,
										refundedAmountMinor: 0,
									},
									remote,
								);
							const autoAuthoriseResult = await resolveAutoAuthorise(
								provider,
								ctx,
								currentEvent,
								options,
								{ alreadyProcessed: false },
							);
							throwIfAutoAuthoriseFailed(autoAuthoriseResult);
							await runCaptureOnAuthorized(provider, ctx, currentEvent, options);
							await runHandlers(provider, currentEvent, verification.payload, autoAuthoriseResult, {
								statusChange: null,
								webhookOptions,
								dispatchTyped: true,
								providerHandler: index === events.length - 1,
							});
						}
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
						events: canonicalEvents,
					});
				},
			),
		};
		return {
			...endpoints,
			...(webhookOptions.redelivery
				? {
						bnplListWebhookEvents: buildListWebhookEventsEndpoint(
							webhookOptions.redelivery,
							options,
						),
						bnplRedeliverWebhookEvent: buildRedeliverWebhookEventEndpoint(
							providers,
							webhookOptions,
							options,
						),
					}
				: {}),
		};
	};
};
const listWebhookEventsQuerySchema = z
	.object({
		status: z.string().optional(),
		provider: z.string().optional(),
		providerOrderId: z.string().optional(),
		limit: z.coerce.number().int().min(1).max(100).optional(),
		offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
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
			const events = provider.toCanonicalEvents?.(parsed);
			const event = events ? events[0] : provider.toCanonicalEvent(parsed);
			if (!event)
				throw new APIError("BAD_REQUEST", {
					message: BNPL_ERROR_CODES.WEBHOOK_EVENT_NOT_REPLAYABLE.message,
					code: "WEBHOOK_EVENT_NOT_REPLAYABLE",
				});
			await processDelivery(
				ctx,
				provider,
				event,
				{
					ok: true,
					payload: parsed,
					rawBody: row.rawData ?? JSON.stringify(parsed),
					dedupKey: row.dedupKey,
				},
				row,
				options,
				{ webhookOptions, events, redelivery: true },
			);
			return ctx.json({ redelivered: true, status: "processed", kind: event.kind });
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
function readCancellationHistory(
	provider: BnplProvider,
	event: BnplWebhookEvent,
	existing: StoredOrder,
	remote: BnplOrderState,
) {
	const orderId = "orderId" in event ? event.orderId : undefined;
	if (
		remote.providerOrderId !== orderId ||
		remote.capturedAmountMinor < existing.capturedAmountMinor ||
		remote.refundedAmountMinor < existing.refundedAmountMinor ||
		(remote.canceledAmountMinor ?? 0) < (existing.canceledAmountMinor ?? 0)
	)
		throw new Error("bnpl: cancellation notification snapshot is stale or mismatched");
	const history = readRemoteHistory(provider, { ...existing, providerOrderId: orderId }, remote);
	const raw = isRecord(event.raw) ? event.raw : null;
	const data = raw && isRecord(raw.data) ? raw.data : null;
	const cancelId = data?.cancel_id ?? raw?.cancel_id;
	if (
		typeof cancelId === "string" &&
		!remote.operations?.some(
			(operation) => operation.kind === "canceled" && operation.id === cancelId,
		)
	)
		throw new Error("bnpl: cancellation notification identity is absent from native history");
	if (
		history.canceled <= 0 ||
		!remote.operations?.some((operation) => operation.kind === "canceled")
	)
		throw new Error("bnpl: cancellation notification requires native cancellation history");
	const partial =
		remote.status === "updated" &&
		history.canceled < existing.amountMinor &&
		history.captured === 0 &&
		history.refunded === 0;
	if (
		(remote.status === "updated" && !partial) ||
		(remote.status === "canceled" &&
			(history.canceled !== existing.amountMinor ||
				history.captured !== 0 ||
				history.refunded !== 0))
	)
		throw new Error("bnpl: cancellation notification status contradicts native balances");
	return { history, partial };
}
async function normalizeCancellationEvent(
	provider: BnplProvider,
	ctx: GenericEndpointContext,
	event: BnplWebhookEvent,
) {
	if (provider.id !== "tamara" || event.kind !== "canceled") return { event, remote: undefined };
	const remote = await provider.fetchOrder(event.orderId, { logger: ctx.context.logger });
	const normalized: BnplWebhookEvent =
		remote.status === "canceled"
			? event
			: {
					...event,
					kind: "updated",
					status: remote.status === "updated" ? "authorised" : remote.status,
				};
	return { event: normalized, remote };
}
const cancellationSnapshotSchema = z.object({
	providerOrderId: z.string().min(1),
	status: z.enum(CANONICAL_STATUSES),
	totalAmount: z.object({ amount: z.string(), currency: z.enum(BNPL_CURRENCIES) }),
	capturedAmountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	refundedAmountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	canceledAmountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
	operations: z
		.array(
			z.object({
				id: z.string().min(1),
				kind: z.enum(["captured", "refunded", "canceled"]),
				amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
				currency: z.enum(BNPL_CURRENCIES),
			}),
		)
		.optional(),
});
const cancellationContextSchema = z.object({
	kind: z.enum(["updated", "canceled"]),
	status: z.enum(CANONICAL_STATUSES).optional(),
	snapshot: cancellationSnapshotSchema.optional(),
});
const deliveryCheckpointSchema = z.union([
	z.array(z.string()).transform((completed) => ({ completed, contexts: {} })),
	z.object({
		completed: z.array(z.string()),
		contexts: z.record(z.string(), cancellationContextSchema),
	}),
]);
async function processDelivery(
	ctx: GenericEndpointContext,
	provider: BnplProvider,
	event: BnplWebhookEvent,
	verification: Extract<Awaited<ReturnType<BnplProvider["verifyWebhook"]>>, { ok: true }>,
	row: StoredWebhookEvent,
	options: BnplOptions,
	deps: {
		webhookOptions: WebhooksSubpluginOptions;
		events?: BnplWebhookEvent[];
		redelivery?: boolean;
	},
): Promise<WebhookAck> {
	const claimed = await claimWebhookEvent(ctx, row);
	if (!claimed)
		throw new APIError("SERVICE_UNAVAILABLE", {
			message: "Webhook event is already being processed",
			code: "WEBHOOK_PROCESSING",
		});
	const checkpoint: {
		completed: string[];
		contexts: Record<string, z.infer<typeof cancellationContextSchema>>;
	} = deliveryCheckpointSchema.parse(row.deliveryState ? JSON.parse(row.deliveryState) : []);
	if (deps.redelivery && row.status === "processed") checkpoint.completed = [];
	const completed = checkpoint.completed;
	try {
		const events = deps.events ?? [event];
		for (const [index, incomingEvent] of events.entries()) {
			const frozen = checkpoint.contexts[index];
			const normalized = frozen
				? {
						event: {
							...incomingEvent,
							kind: frozen.kind,
							...(frozen.kind === "updated" ? { status: frozen.status } : {}),
						} as BnplWebhookEvent,
						remote: frozen.snapshot ? { ...frozen.snapshot, raw: null } : undefined,
					}
				: await normalizeCancellationEvent(provider, ctx, incomingEvent);
			const { event: currentEvent, remote } = normalized;
			if (remote && !frozen) {
				const orderId = "orderId" in currentEvent ? currentEvent.orderId : undefined;
				if (!orderId) throw new Error("bnpl: cancellation notification lacks order identity");
				const existing = await ctx.context.adapter.findOne<StoredOrder>({
					model: "bnplOrder",
					where: webhookOrderWhere(provider.id, orderId),
				});
				if (!existing)
					throw new OrderStoreMissingError("bnpl: cancellation order is not persisted");
				readCancellationHistory(provider, currentEvent, existing, remote);
				checkpoint.contexts[index] = {
					kind: currentEvent.kind === "updated" ? "updated" : "canceled",
					...(currentEvent.kind === "updated" ? { status: currentEvent.status } : {}),
					snapshot: cancellationSnapshotSchema.parse(remote),
				};
				await saveWebhookDeliveryState(ctx, claimed, checkpoint);
			}
			const application = await persistOrderUpdate(
				ctx,
				provider,
				currentEvent,
				verification.rawBody,
				`${row.id}:${index}`,
				row.orderApplied === true,
				remote,
			);
			const autoAuthoriseResult = await resolveAutoAuthorise(provider, ctx, currentEvent, options, {
				alreadyProcessed: false,
			});
			throwIfAutoAuthoriseFailed(autoAuthoriseResult);
			await runCaptureOnAuthorized(provider, ctx, currentEvent, options);
			await runHandlers(provider, currentEvent, verification.payload, autoAuthoriseResult, {
				statusChange: application.statusChange,
				webhookOptions: deps.webhookOptions,
				dispatchTyped: application.dispatchTyped,
				providerHandler: index === events.length - 1,
				deliveryId: `${row.id}:${index}`,
				runOnce: async (name, handler) => {
					const key = `${index}:${name}`;
					if (completed.includes(key)) return;
					await saveWebhookDeliveryState(ctx, claimed, checkpoint);
					await handler();
					completed.push(key);
					await saveWebhookDeliveryState(ctx, claimed, checkpoint);
				},
			});
		}
		await markWebhookEventOrderApplied(ctx, claimed);
		await markWebhookEventProcessed(ctx, claimed);
	} catch (e) {
		ctx.context.logger.error(
			`bnpl: ${provider.id} webhook processing failed: ${e instanceof Error ? e.message : e}`,
		);
		try {
			await markWebhookEventFailed(ctx, claimed, e);
		} catch (checkpointError) {
			ctx.context.logger.error(
				`bnpl: failed to checkpoint webhook failure: ${checkpointError instanceof Error ? checkpointError.message : checkpointError}`,
			);
		}
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
		providerHandler?: boolean;
		deliveryId?: string;
		runOnce?: (name: string, handler: () => Promise<void> | void) => Promise<void>;
	},
): Promise<void> {
	const { webhookOptions } = deps;
	const dispatchCtx: WebhookDispatchContext = {
		provider: provider.id,
		event,
		deliveryId: deps.deliveryId,
		autoAuthoriseResult: event.kind === "approved" ? autoAuthoriseResult : undefined,
	};
	const run =
		deps.runOnce ??
		(async (_name: string, handler: () => Promise<void> | void) => {
			await handler();
		});
	await run("payload", () => webhookOptions.onPayload?.(dispatchCtx));
	if (deps.providerHandler !== false && provider.id === "tamara") {
		if (typeof payload.order_status === "string") {
			await run("provider", () =>
				webhookOptions.tamara?.onAuthoriseNotification?.(payload, { autoAuthoriseResult }),
			);
		}
	}
	if (deps.providerHandler !== false && provider.id === "tabby") {
		if (isClosedTabbyPayload(payload)) {
			await run("provider", () => webhookOptions.tabby?.onPaymentClosed?.(payload));
		}
	}
	if (deps.dispatchTyped) {
		await run("typed", () =>
			dispatchTyped(provider.id, event, autoAuthoriseResult, webhookOptions, deps.deliveryId),
		);
	}
	const statusChange = deps.statusChange;
	if (statusChange && webhookOptions.onStatusChange) {
		await run("status", () =>
			webhookOptions.onStatusChange?.({
				provider: statusChange.provider,
				orderId: "orderId" in event ? (event.orderId ?? "") : "",
				deliveryId: deps.deliveryId,
				from: statusChange.from,
				to: statusChange.to,
				event,
			}),
		);
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
	deliveryId?: string,
): Promise<void> {
	switch (event.kind) {
		case "approved":
			await opts.onApproved?.({ provider, event, autoAuthoriseResult, deliveryId });
			return;
		case "authorized":
			await opts.onAuthorized?.({ provider, event, autoAuthoriseResult, deliveryId });
			return;
		case "captured":
			await opts.onCaptured?.({ provider, event, autoAuthoriseResult, deliveryId });
			return;
		case "refunded":
			await opts.onRefunded?.({ provider, event, autoAuthoriseResult, deliveryId });
			return;
		case "canceled":
			await opts.onCanceled?.({ provider, event, autoAuthoriseResult, deliveryId });
			return;
		case "expired":
			await opts.onExpired?.({ provider, event, autoAuthoriseResult, deliveryId });
			return;
		case "declined":
			await opts.onDeclined?.({ provider, event, autoAuthoriseResult, deliveryId });
			return;
		case "updated":
			await opts.onUpdated?.({ provider, event, autoAuthoriseResult, deliveryId });
			return;
		case "unknown":
			return;
	}
}
function moneyEventKey(
	provider: BnplProvider,
	event: Extract<BnplWebhookEvent, { kind: "captured" | "refunded" }>,
): string {
	return (
		provider.webhookDedupKey?.(event) ??
		`${provider.id}:${event.kind}:${event.kind === "captured" ? event.captureId : event.refundId}`
	);
}
function captureEventKey(
	provider: BnplProvider,
	orderId: string,
	currency: string,
	captureId: string,
	amountMinor: number,
): string {
	if (!isBnplCurrency(currency)) throw new Error("bnpl: invalid persisted currency");
	return moneyEventKey(provider, {
		kind: "captured",
		provider: provider.id,
		orderId,
		captureId,
		amountMinor,
		currency,
		raw: null,
	});
}
async function persistOrderUpdate(
	ctx: GenericEndpointContext,
	provider: BnplProvider,
	event: BnplWebhookEvent,
	rawBody: string,
	deliveryKey: string,
	legacyApplied = false,
	remoteCancellation?: BnplOrderState,
): Promise<{ statusChange: PersistedStatusChange | null; dispatchTyped: boolean }> {
	const orderId = "orderId" in event ? event.orderId : undefined;
	if (!orderId) return { statusChange: null, dispatchTyped: false };
	let statusChange: PersistedStatusChange | null = null;
	let dispatch = true;
	const operationKey =
		event.kind === "captured" || event.kind === "refunded" ? moneyEventKey(provider, event) : null;
	await mutateOrder<StoredOrder>(
		ctx,
		() => webhookOrderWhere(provider.id, orderId),
		(existing) => {
			const operations = readAppliedOperations(existing.appliedOperations);
			const transitions: Record<string, PersistedStatusChange> = existing.webhookTransitions
				? JSON.parse(existing.webhookTransitions)
				: {};
			const marker = `delivery:${deliveryKey}`;
			statusChange = transitions[deliveryKey] ?? null;
			if (operations.includes(marker)) return null;
			if (operationKey && operations.includes(operationKey)) {
				dispatch = false;
				return null;
			}
			const now = new Date();
			const update: OrderUpdate = { status: existing.status, updatedAt: now, rawData: rawBody };
			const candidate = computeEventTarget(
				event,
				existing,
				now,
				update,
				ctx.context.logger,
				legacyApplied,
			);
			let partialCancellationRepair = false;
			let importedKeys = operations;
			if (remoteCancellation) {
				const { history, partial } = readCancellationHistory(
					provider,
					event,
					existing,
					remoteCancellation,
				);
				Object.assign(update, {
					capturedAmountMinor: history.captured,
					refundedAmountMinor: history.refunded,
					canceledAmountMinor: history.canceled,
				});
				importedKeys = history.keys;
				partialCancellationRepair = partial && existing.status === "canceled";
				if (partialCancellationRepair) update.canceledAt = null;
			}
			const finalStatus = partialCancellationRepair
				? "authorised"
				: candidate !== existing.status && canTransition(existing.status, candidate)
					? candidate
					: applyRegressionGuard(existing.status, candidate, event, ctx.context.logger);
			update.status = finalStatus;
			statusChange =
				finalStatus !== existing.status
					? { from: existing.status, to: finalStatus, provider: existing.provider }
					: null;
			if (statusChange) transitions[deliveryKey] = statusChange;
			return {
				...update,
				appliedOperations: JSON.stringify([
					...importedKeys,
					...(operationKey ? [operationKey] : []),
					marker,
				]),
				webhookTransitions: JSON.stringify(transitions),
			};
		},
	);
	return { statusChange, dispatchTyped: dispatch };
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
			return existing.refundedAmountMinor > 0
				? deriveRefundedStatus({
						totalAmountMinor: cumulative,
						cumulativeMinor: existing.refundedAmountMinor,
					})
				: deriveCapturedStatus({
						totalAmountMinor: existing.amountMinor - (existing.canceledAmountMinor ?? 0),
						cumulativeMinor: cumulative,
					});
		}
		case "refunded": {
			const cumulative = skipMoneyDelta
				? existing.refundedAmountMinor
				: applyRefundDelta(event, existing, update, logger);
			if (cumulative === null) return existing.status;
			return deriveRefundedStatus({
				totalAmountMinor:
					existing.capturedAmountMinor > 0 ? existing.capturedAmountMinor : existing.amountMinor,
				cumulativeMinor: cumulative,
			});
		}
		case "updated":
			if (event.totalAmount) {
				if (event.totalAmount.currency !== existing.currency)
					throw new Error("bnpl: updated order currency differs");
				Object.assign(update, { amountMinor: parseAmount(event.totalAmount) });
			}
			return event.status ?? existing.status;
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
	if (
		!Number.isSafeInteger(cumulative) ||
		cumulative > existing.amountMinor - (existing.canceledAmountMinor ?? 0)
	)
		throw new Error("bnpl: capture exceeds order amount");
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
	if (
		!Number.isSafeInteger(cumulative) ||
		cumulative > existing.amountMinor - (existing.canceledAmountMinor ?? 0)
	)
		throw new Error("bnpl: refund exceeds order amount");
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
	if (event.amountMinor > 0) {
		if (!Number.isSafeInteger(event.amountMinor))
			throw new Error("bnpl: operation amount must be a safe integer");
		return event.amountMinor;
	}
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
	if (event.amountMinor > 0) {
		if (!Number.isSafeInteger(event.amountMinor))
			throw new Error("bnpl: operation amount must be a safe integer");
		return event.amountMinor;
	}
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
	if (!options.persistOrders)
		return {
			status: "failed",
			error: new Error("bnpl: durable auto-authorisation requires persistOrders"),
		};
	const orderId = event.orderId;
	let stored: AutoAuthoriseStoredOrder | null = null;
	if (options.persistOrders) {
		stored = await ctx.context.adapter.findOne<AutoAuthoriseStoredOrder>({
			model: "bnplOrder",
			where: webhookOrderWhere(provider.id, orderId),
		});
		if (stored && !isAuthorisedState(stored.status) && !canTransition(stored.status, "authorised"))
			return { status: "not-applicable" };
	}
	let command: MoneyCommandReservation | undefined;
	let recoveryRequested = false;
	try {
		const reservation = await reserveMoneyCommand<AutoAuthoriseStoredOrder>(
			ctx,
			() => webhookOrderWhere(provider.id, orderId),
			"authorise",
			orderId,
			{},
			undefined,
			true,
		);
		if (reservation.kind === "completed") {
			if (options.captureOnAuthorise) await runAutoCapture(provider, ctx, orderId, options);
			return { status: "already-authorised" };
		}
		command = reservation.command;
		const reservedCommand = reservation.command;
		const local = await recoverLocalAuthoriseCommand<AutoAuthoriseStoredOrder>(
			ctx,
			() => webhookOrderWhere(provider.id, orderId),
			reservedCommand,
			orderId,
		);
		if (local) {
			if (options.captureOnAuthorise) await runAutoCapture(provider, ctx, orderId, options);
			return { status: "already-authorised" };
		}
		recoveryRequested = reservation.kind === "pending";
		if (recoveryRequested)
			throw new Error("bnpl: authorisation outcome is uncertain; verifying remote state");
		const result = await provider.authorize(orderId, { logger: ctx.context.logger });
		if (result.providerOrderId !== orderId)
			throw new Error("bnpl: authorisation order identity mismatch");
		let capturedAmountMinor: number | undefined;
		let storedCurrency: string | undefined;
		if (options.persistOrders) {
			const mutation = await mutateOrder<AutoAuthoriseStoredOrder>(
				ctx,
				() => webhookOrderWhere(provider.id, orderId),
				(row) => {
					const updateResult = buildAuthoriseOrderUpdate(result, {
						amountMinor: row.amountMinor,
						canceledAmountMinor: row.canceledAmountMinor,
						status: row.status,
						capturedAmountMinor: row.capturedAmountMinor ?? 0,
					});
					capturedAmountMinor = updateResult.capturedAmountMinor;
					if (
						capturedAmountMinor !== undefined &&
						(!Number.isSafeInteger(capturedAmountMinor) ||
							capturedAmountMinor < 0 ||
							capturedAmountMinor > row.amountMinor - (row.canceledAmountMinor ?? 0))
					)
						throw new Error("bnpl: invalid authorised capture amount");
					const operations = readAppliedOperations(row.appliedOperations);
					if (result.captureId && capturedAmountMinor !== undefined)
						operations.push(
							captureEventKey(
								provider,
								orderId,
								row.currency,
								result.captureId,
								capturedAmountMinor,
							),
						);
					return {
						...updateResult.update,
						appliedOperations: JSON.stringify([...new Set(operations)]),
						moneyCommands: completeMoneyCommand(
							row.moneyCommands,
							reservedCommand,
							result as unknown as Record<string, unknown>,
						),
					};
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
		if (recoveryRequested || (e instanceof BnplProviderError && e.isAlreadyInTargetState)) {
			const recoveryCommand = command;
			if (!recoveryCommand)
				return { status: "failed", error: e instanceof Error ? e : new Error(String(e)) };
			const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
			if (!isAuthorisedState(remote.status))
				return { status: "failed", error: e instanceof Error ? e : new Error(String(e)) };
			if (options.persistOrders)
				await mutateOrder<AutoAuthoriseStoredOrder>(
					ctx,
					() => webhookOrderWhere(provider.id, orderId),
					(current) => {
						const {
							keys: operations,
							captured,
							refunded,
							canceled,
						} = readRemoteHistory(provider, current, remote);
						const candidate =
							refunded > 0
								? deriveRefundedStatus({ totalAmountMinor: captured, cumulativeMinor: refunded })
								: remote.status;
						return {
							...buildAuthoriseOrderUpdate(
								{
									providerOrderId: orderId,
									status: remote.status,
									capturedAmountMinor: remote.capturedAmountMinor,
									raw: remote.raw,
								},
								{
									amountMinor: current.amountMinor,
									canceledAmountMinor: current.canceledAmountMinor,
									capturedAmountMinor: current.capturedAmountMinor,
									status: current.status,
								},
							).update,
							appliedOperations: JSON.stringify([...new Set(operations)]),
							status: canTransition(current.status, candidate) ? candidate : current.status,
							refundedAmountMinor: refunded,
							canceledAmountMinor: canceled,
							moneyCommands: completeMoneyCommand(current.moneyCommands, recoveryCommand, {
								orderId,
								status: remote.status,
								already: true,
							}),
						};
					},
				);
			if (options.captureOnAuthorise) await runAutoCapture(provider, ctx, orderId, options);
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
		type CaptureOrder = StoredOrder & { moneyCommands?: string | null };
		const row = await ctx.context.adapter.findOne<CaptureOrder>({
			model: "bnplOrder",
			where: webhookOrderWhere(provider.id, orderId),
		});
		if (!row) throw new OrderStoreMissingError("bnpl: auto-capture order is not persisted");
		if (["canceled", "expired", "declined", "closed", "fully_refunded"].includes(row.status))
			return;
		if (
			row.status === "fully_captured" ||
			(row.capturedAmountMinor ?? 0) >= row.amountMinor - (row.canceledAmountMinor ?? 0)
		) {
			ctx.context.logger.info(
				`bnpl: ${provider.id} captureOnAuthorise skipped for ${orderId} — already captured`,
			);
			return;
		}
		const remainingMinor =
			row.amountMinor - (row.canceledAmountMinor ?? 0) - (row.capturedAmountMinor ?? 0);
		const total = formatAmount(remainingMinor, row.currency);
		const shippingInfo = await options.captureOnAuthoriseShippingInfo?.({
			providerId: provider.id,
			orderId,
			totalAmount: total,
		});
		if (!shippingInfo && provider.id === "tamara")
			throw new Error("bnpl: Tamara auto-capture requires shipping information");
		const reference = operationReference(
			{
				provider: provider.id,
				providerOrderId: orderId,
				capturedAmountMinor: row.capturedAmountMinor,
			},
			"capture",
			remainingMinor,
		);
		const reservation = await reserveMoneyCommand<CaptureOrder>(
			ctx,
			() => webhookOrderWhere(provider.id, orderId),
			"capture",
			reference,
			{ amountMinor: remainingMinor, currency: row.currency },
			(current) => {
				if (
					["canceled", "expired", "declined", "closed", "fully_refunded"].includes(
						current.status,
					) ||
					current.currency !== row.currency ||
					remainingMinor >
						current.amountMinor - (current.canceledAmountMinor ?? 0) - current.capturedAmountMinor
				)
					throw new Error("bnpl: auto-capture amount exceeds latest remaining balance");
			},
		);
		let captureResult: Awaited<ReturnType<BnplProvider["capture"]>>;
		if (reservation.kind === "completed")
			captureResult = reservation.result as unknown as typeof captureResult;
		else {
			try {
				captureResult = await provider.capture(
					orderId,
					{ totalAmount: total, shippingInfo, merchantReferenceId: reference },
					{ logger: ctx.context.logger },
				);
			} catch (error) {
				if (
					error instanceof BnplProviderError &&
					error.status !== undefined &&
					error.status >= 400 &&
					error.status < 500 &&
					error.status !== 408 &&
					error.status !== 429 &&
					!error.isAlreadyInTargetState
				) {
					try {
						await releaseRejectedMoneyCommand(
							ctx,
							() => webhookOrderWhere(provider.id, orderId),
							reservation.command,
						);
					} catch {
						ctx.context.logger.error("bnpl: could not release rejected auto-capture command");
					}
				}
				throw error;
			}
		}
		if (
			captureResult.providerOrderId !== orderId ||
			!captureResult.captureId ||
			!Number.isSafeInteger(captureResult.amountMinor) ||
			captureResult.amountMinor !== remainingMinor
		)
			throw new Error("bnpl: invalid auto-capture result returned by provider");
		const key = captureEventKey(
			provider,
			orderId,
			row.currency,
			captureResult.captureId,
			captureResult.amountMinor,
		);
		await mutateOrder<CaptureOrder>(
			ctx,
			() => webhookOrderWhere(provider.id, orderId),
			(current) => {
				const moneyCommands =
					reservation.kind === "completed"
						? current.moneyCommands
						: completeMoneyCommand(
								current.moneyCommands,
								reservation.command,
								captureResult as unknown as Record<string, unknown>,
							);
				const operations = readAppliedOperations(current.appliedOperations);
				if (operations.includes(key)) return { moneyCommands, updatedAt: new Date() };
				const capturedAmountMinor = current.capturedAmountMinor + captureResult.amountMinor;
				if (
					!Number.isSafeInteger(capturedAmountMinor) ||
					capturedAmountMinor + (current.canceledAmountMinor ?? 0) > current.amountMinor
				)
					throw new Error("bnpl: auto-capture exceeds latest order balance");
				const candidate =
					current.refundedAmountMinor > 0
						? deriveRefundedStatus({
								totalAmountMinor: capturedAmountMinor,
								cumulativeMinor: current.refundedAmountMinor,
							})
						: deriveCapturedStatus({
								totalAmountMinor: current.amountMinor - (current.canceledAmountMinor ?? 0),
								cumulativeMinor: capturedAmountMinor,
							});
				return {
					status: canTransition(current.status, candidate) ? candidate : current.status,
					capturedAt: new Date(),
					capturedAmountMinor,
					appliedOperations: JSON.stringify([...operations, key]),
					moneyCommands,
					updatedAt: new Date(),
				};
			},
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
