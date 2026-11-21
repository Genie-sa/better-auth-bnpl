import type { GenericEndpointContext, Where } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import { BNPL_ERROR_CODES } from "../core/errors";
import { isRecord } from "../core/guards";
import { ledgerKeyForEvent } from "../core/ledger";
import { BNPL_CURRENCIES, formatAmount, parseAmount } from "../core/money";
import type { BnplProvider } from "../core/provider";
import {
	CANONICAL_STATUSES,
	type CanonicalStatus,
	canTransition,
	isAuthorisedState,
	isTerminalStatus,
	statusFromBalances,
} from "../core/status";
import type { BnplCaptureResult, BnplOrderState, BnplWebhookEvent } from "../core/types";
import type { BnplOptions } from "../plugin-types";
import { type AdminAuthorizer, assertAdmin } from "./admin";
import {
	automaticCaptureReference,
	reportsAuthorisedState,
	runMoneyCommand,
	settleLostAutomaticCaptures,
	settlePendingMoneyOperation,
} from "./money-command";
import {
	type OrderRecord,
	addObservedMoney,
	applyAuthorisation,
	applyMoneyOperation,
	capturableMinor,
	importSnapshot,
	orderWhere,
	readRemoteHistory,
	snapshotIsBehind,
} from "./order";
import { OrderStoreMissingError, mutateOrder, readAppliedOperations } from "./order-store";
import { assertPersistedOrders } from "./persistence";
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
interface PersistedStatusChange {
	from: string;
	to: CanonicalStatus | string;
	provider: string;
}
function parseEvents(
	provider: BnplProvider,
	payload: Record<string, unknown>,
): { event: BnplWebhookEvent | null | undefined; events: BnplWebhookEvent[] | undefined } {
	const events = provider.toCanonicalEvents?.(payload);
	return { event: events ? events[0] : provider.toCanonicalEvent(payload), events };
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
					const { event, events: canonicalEvents } = parseEvents(provider, verification.payload);
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
									cancelIdOf(incomingEvent),
									{
										provider: provider.id,
										providerOrderId: remote.providerOrderId,
										status: remote.status,
										amountMinor: parseAmount(remote.totalAmount),
										currency: remote.totalAmount.currency,
										capturedAmountMinor: 0,
										refundedAmountMinor: 0,
									},
									remote,
								);
							await completeEvent(provider, ctx, currentEvent, verification.payload, options, {
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
			const { event, events } = parseEvents(provider, parsed);
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
function cancelIdOf(event: BnplWebhookEvent): string | undefined {
	return event.kind === "canceled" ? event.cancelId : undefined;
}
function readCancellationHistory(
	provider: BnplProvider,
	event: BnplWebhookEvent,
	cancelId: string | undefined,
	existing: OrderRecord,
	remote: BnplOrderState,
) {
	const orderId = "orderId" in event ? event.orderId : undefined;
	if (!orderId || remote.providerOrderId !== orderId || snapshotIsBehind(existing, remote))
		throw new Error("bnpl: cancellation notification snapshot is stale or mismatched");
	const history = readRemoteHistory(provider, { ...existing, providerOrderId: orderId }, remote);
	if (
		cancelId !== undefined &&
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
	const uncommitted = existing.amountMinor - history.canceled - history.captured;
	if (
		(remote.status === "updated" && uncommitted <= 0) ||
		(remote.status === "canceled" && uncommitted !== 0)
	)
		throw new Error("bnpl: cancellation notification status contradicts native balances");
	const status = statusFromBalances(remote.status, {
		amountMinor: existing.amountMinor,
		captured: history.captured,
		refunded: history.refunded,
		canceled: history.canceled,
	});
	return { history, status };
}
async function normalizeCancellationEvent(
	provider: BnplProvider,
	ctx: GenericEndpointContext,
	event: BnplWebhookEvent,
) {
	if (!provider.capabilities.partialCancel || event.kind !== "canceled")
		return { event, remote: undefined };
	const remote = await provider.fetchOrder(event.orderId, { logger: ctx.context.logger });
	const status = statusFromBalances(remote.status, {
		amountMinor: parseAmount(remote.totalAmount),
		captured: remote.capturedAmountMinor,
		refunded: remote.refundedAmountMinor,
		canceled: remote.canceledAmountMinor ?? 0,
	});
	const normalized: BnplWebhookEvent =
		status === "canceled" ? event : { ...event, kind: "updated", status };
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
	} = deliveryCheckpointSchema.parse(
		claimed.deliveryState ? JSON.parse(claimed.deliveryState) : [],
	);
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
				const existing = await ctx.context.adapter.findOne<OrderRecord>({
					model: "bnplOrder",
					where: orderWhere(provider.id, orderId),
				});
				if (!existing)
					throw new OrderStoreMissingError("bnpl: cancellation order is not persisted");
				readCancellationHistory(
					provider,
					currentEvent,
					cancelIdOf(incomingEvent),
					existing,
					remote,
				);
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
				claimed.orderApplied === true,
				remote ? { remote, cancelId: cancelIdOf(incomingEvent) } : undefined,
			);
			await completeEvent(provider, ctx, currentEvent, verification.payload, options, {
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

/** Runs the automatic payment steps an event triggers, then the integrator's handlers. */
async function completeEvent(
	provider: BnplProvider,
	ctx: GenericEndpointContext,
	event: BnplWebhookEvent,
	payload: Record<string, unknown>,
	options: BnplOptions,
	handlers: HandlerDeps,
): Promise<void> {
	const autoAuthoriseResult: AutoAuthoriseOutcome =
		event.kind === "approved"
			? await runAutoAuthorise(provider, ctx, event, options)
			: event.kind === "authorized"
				? { status: "not-applicable" }
				: { status: "disabled" };
	if (autoAuthoriseResult.status === "failed") throw autoAuthoriseResult.error;
	if (event.kind === "authorized" && options.captureOnAuthorise)
		await runAutoCapture(provider, ctx, event.orderId, options);
	await runHandlers(provider, event, payload, autoAuthoriseResult, handlers);
}
interface HandlerDeps {
	statusChange: PersistedStatusChange | null;
	webhookOptions: WebhooksSubpluginOptions;
	dispatchTyped: boolean;
	providerHandler?: boolean;
	deliveryId?: string;
	runOnce?: (name: string, handler: () => Promise<void> | void) => Promise<void>;
}
async function runHandlers(
	provider: BnplProvider,
	event: BnplWebhookEvent,
	payload: Record<string, unknown>,
	autoAuthoriseResult: AutoAuthoriseOutcome,
	deps: HandlerDeps,
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
async function persistOrderUpdate(
	ctx: GenericEndpointContext,
	provider: BnplProvider,
	event: BnplWebhookEvent,
	rawBody: string,
	deliveryKey: string,
	legacyApplied = false,
	cancellation?: { remote: BnplOrderState; cancelId?: string },
): Promise<{ statusChange: PersistedStatusChange | null; dispatchTyped: boolean }> {
	const orderId = "orderId" in event ? event.orderId : undefined;
	if (!orderId) return { statusChange: null, dispatchTyped: false };
	let statusChange: PersistedStatusChange | null = null;
	let dispatch = true;
	const operationKey =
		event.kind === "captured" || event.kind === "refunded"
			? ledgerKeyForEvent(provider, event)
			: null;
	await mutateOrder<OrderRecord>(
		ctx,
		() => orderWhere(provider.id, orderId),
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
			let target = candidate;
			let cancellationRepair = false;
			let importedKeys = operations;
			if (cancellation) {
				const { history, status } = readCancellationHistory(
					provider,
					event,
					cancellation.cancelId,
					existing,
					cancellation.remote,
				);
				Object.assign(update, {
					capturedAmountMinor: history.captured,
					refundedAmountMinor: history.refunded,
					canceledAmountMinor: history.canceled,
				});
				importedKeys = history.keys;
				target = status;
				if (status !== "canceled") {
					if (existing.status === "canceled") update.canceledAt = null;
					else if (update.canceledAt !== undefined) update.canceledAt = existing.canceledAt ?? null;
				}
				cancellationRepair = existing.status === "canceled" && status !== "canceled";
			}
			const finalStatus = cancellationRepair
				? target
				: target !== existing.status && canTransition(existing.status, target)
					? target
					: applyRegressionGuard(existing.status, target, event, ctx.context.logger);
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
	existing: OrderRecord,
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
		case "captured":
		case "refunded": {
			if (skipMoneyDelta) return existing.status;
			if (event.currency !== existing.currency || event.amountMinor <= 0) {
				logger.warn(
					`bnpl: ${event.kind} event carries no applicable ${existing.currency} amount — skipping delta`,
				);
				return existing.status;
			}
			const moved = addObservedMoney(existing, event.kind, event.amountMinor);
			update.capturedAmountMinor = moved.capturedAmountMinor;
			update.refundedAmountMinor = moved.refundedAmountMinor;
			if (event.kind === "captured") update.capturedAt = now;
			return moved.status;
		}
		case "updated":
			if (event.totalAmount) {
				if (event.totalAmount.currency !== existing.currency)
					throw new Error("bnpl: updated order currency differs");
				const amountMinor = parseAmount(event.totalAmount);
				if (
					amountMinor <= 0 ||
					amountMinor < existing.capturedAmountMinor + (existing.canceledAmountMinor ?? 0)
				)
					throw new Error("bnpl: updated order total is below its committed balance");
				Object.assign(update, { amountMinor });
			}
			return event.status ?? existing.status;
		default:
			return existing.status;
	}
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
interface AutoAuthoriseRun {
	outcome: AutoAuthoriseOutcome;
	capture: boolean;
}
async function runAutoAuthorise(
	provider: BnplProvider,
	ctx: GenericEndpointContext,
	event: Extract<BnplWebhookEvent, { kind: "approved" }>,
	options: BnplOptions,
): Promise<AutoAuthoriseOutcome> {
	const authorize = provider.authorize?.bind(provider);
	if (!provider.capabilities.separateAuthorise || !authorize) return { status: "not-applicable" };
	if (options.autoAuthorise === false) return { status: "disabled" };
	if (!options.persistOrders)
		return {
			status: "failed",
			error: new Error("bnpl: durable auto-authorisation requires persistOrders"),
		};
	const orderId = event.orderId;
	const where = () => orderWhere(provider.id, orderId);
	const failed = (e: unknown): AutoAuthoriseRun => {
		ctx.context.logger.error(
			`bnpl: ${provider.id} auto-authorise failed for ${orderId}: ${e instanceof Error ? e.message : e}`,
		);
		return {
			outcome: { status: "failed", error: e instanceof Error ? e : new Error(String(e)) },
			capture: false,
		};
	};
	const already: AutoAuthoriseRun = { outcome: { status: "already-authorised" }, capture: true };
	let run: AutoAuthoriseRun;
	try {
		const stored = await ctx.context.adapter.findOne<OrderRecord>({
			model: "bnplOrder",
			where: where(),
		});
		if (stored && !isAuthorisedState(stored.status) && !canTransition(stored.status, "authorised"))
			return { status: "not-applicable" };
		run = await runMoneyCommand<AutoAuthoriseRun>(
			ctx,
			{
				where,
				operation: "authorise",
				reference: orderId,
				input: {},
				onPending: "verify",
				replay: () => already,
			},
			async (command) => {
				const recoveryRequested = command.state === "pending";
				try {
					const local = await command.settleIf((order) =>
						isAuthorisedState(order.status)
							? { response: { orderId, status: order.status, already: true } }
							: null,
					);
					if (local) return already;
					if (recoveryRequested)
						throw new Error("bnpl: authorisation outcome is uncertain; verifying remote state");
					const result = await command.send(
						() => authorize(orderId, { logger: ctx.context.logger }),
						reportsAuthorisedState,
					);
					if (result.providerOrderId !== orderId)
						throw new Error("bnpl: authorisation order identity mismatch");
					let capturedAmountMinor: number | undefined;
					let currency: string | undefined;
					await command.settle((order) => {
						const applied = applyAuthorisation(order, provider, result);
						capturedAmountMinor = applied.capturedAmountMinor;
						currency = order.currency;
						return { response: result, patch: applied.patch };
					});
					if (result.captureId && capturedAmountMinor !== undefined && currency)
						await recordSyntheticCaptureEvent(ctx, provider, orderId, currency, {
							captureId: result.captureId,
							amountMinor: capturedAmountMinor,
							raw: result.raw,
						});
					return {
						outcome: { status: "authorised", raw: result.raw },
						capture: !result.autoCaptured && result.status !== "fully_captured",
					};
				} catch (e) {
					if (!recoveryRequested && !reportsAuthorisedState(e)) return failed(e);
					const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
					if (!isAuthorisedState(remote.status))
						return {
							outcome: { status: "failed", error: e instanceof Error ? e : new Error(String(e)) },
							capture: false,
						};
					await command.settle((order) => ({
						response: { orderId, status: remote.status, already: true },
						patch: {
							...importSnapshot(order, provider, remote),
							authorisedAt: new Date(),
							rawData: JSON.stringify(remote.raw),
						},
					}));
					return already;
				}
			},
		);
	} catch (e) {
		run = failed(e);
	}
	if (run.capture && options.captureOnAuthorise)
		await runAutoCapture(provider, ctx, orderId, options);
	return run.outcome;
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
	const where = () => orderWhere(provider.id, orderId);
	try {
		const load = () =>
			ctx.context.adapter.findOne<OrderRecord>({ model: "bnplOrder", where: where() });
		let row = await load();
		if (row && (await settleLostAutomaticCaptures(ctx, provider, row, where))) row = await load();
		if (!row) throw new OrderStoreMissingError("bnpl: auto-capture order is not persisted");
		if (isTerminalStatus(row.status)) return;
		const remainingMinor = capturableMinor(row);
		if (row.status === "fully_captured" || remainingMinor <= 0) {
			ctx.context.logger.info(
				`bnpl: ${provider.id} captureOnAuthorise skipped for ${orderId} — already captured`,
			);
			return;
		}
		const total = formatAmount(remainingMinor, row.currency);
		const shippingInfo = await options.captureOnAuthoriseShippingInfo?.({
			providerId: provider.id,
			orderId,
			totalAmount: total,
		});
		if (!shippingInfo && provider.capabilities.captureRequiresShipping)
			throw new Error(`bnpl: ${provider.id} auto-capture requires shipping information`);
		const reference = automaticCaptureReference(row, remainingMinor);
		const captureResult = await runMoneyCommand<BnplCaptureResult>(
			ctx,
			{
				where,
				operation: "capture",
				reference,
				input: { amountMinor: remainingMinor, currency: row.currency },
				onPending: "verify",
				recordBaseline: true,
				check: (order) => {
					if (
						isTerminalStatus(order.status) ||
						order.currency !== row.currency ||
						remainingMinor > capturableMinor(order)
					)
						throw new Error("bnpl: auto-capture amount exceeds latest remaining balance");
				},
				replay: (saved) => saved as unknown as BnplCaptureResult,
			},
			async (command) => {
				if (command.state === "pending")
					return settlePendingMoneyOperation(
						ctx,
						command,
						provider,
						row,
						"captured",
						remainingMinor,
					);
				const result = await command.send(() =>
					provider.capture(
						orderId,
						{ totalAmount: total, shippingInfo, merchantReferenceId: reference },
						{ logger: ctx.context.logger },
					),
				);
				if (
					result.providerOrderId !== orderId ||
					!result.captureId ||
					!Number.isSafeInteger(result.amountMinor) ||
					result.amountMinor !== remainingMinor
				)
					throw new Error("bnpl: invalid auto-capture result returned by provider");
				return await command.settle((order) => ({
					response: result,
					patch:
						applyMoneyOperation(order, provider, {
							kind: "captured",
							id: result.captureId,
							amountMinor: result.amountMinor,
						}) ?? undefined,
				}));
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
