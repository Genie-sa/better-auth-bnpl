import type { GenericEndpointContext } from "better-auth";
import { isBnplCurrency } from "../core/money";
import type { BnplProvider } from "../core/provider";
import type { BnplCaptureResult, BnplRefundResult, BnplWebhookEvent } from "../core/types";
export type WebhookEventStatus = "received" | "processing" | "processed" | "failed";
export interface StoredWebhookEvent {
	id: string;
	provider: string;
	providerOrderId: string;
	providerOrderReferenceId?: string | null;
	eventKind: string;
	eventType: string;
	dedupKey: string;
	receivedAt: Date;
	rawData?: string | null;
	status: WebhookEventStatus | string;
	attempts: number;
	orderApplied?: boolean;
	processingToken?: string | null;
	processingUntil?: Date | null;
	deliveryState?: string | null;
	processedAt?: Date | null;
	lastError?: string | null;
}
interface InsertWebhookEventInput {
	provider: string;
	event: BnplWebhookEvent;
	dedupKey: string;
	rawBody: string;
}
export type RecordWebhookEventResult =
	| {
			outcome: "inserted";
			row: StoredWebhookEvent;
	  }
	| {
			outcome: "reprocess";
			row: StoredWebhookEvent;
	  }
	| {
			outcome: "duplicate";
			row: StoredWebhookEvent;
	  }
	| {
			outcome: "unrecordable";
	  }
	| {
			outcome: "infra-error";
			error: unknown;
	  };
type CaptureEventResult = Pick<BnplCaptureResult, "captureId" | "amountMinor" | "raw">;
type RefundEventResult = Pick<BnplRefundResult, "refundId" | "amountMinor" | "raw">;
function eventOrderId(event: BnplWebhookEvent): string | undefined {
	return "orderId" in event ? event.orderId : undefined;
}
function eventReferenceId(event: BnplWebhookEvent): string | undefined {
	return "orderReferenceId" in event && event.orderReferenceId ? event.orderReferenceId : undefined;
}
function eventType(event: BnplWebhookEvent): string {
	return "eventType" in event ? event.eventType : event.kind;
}
async function findEventByDedupKey(
	ctx: GenericEndpointContext,
	dedupKey: string,
): Promise<StoredWebhookEvent | null> {
	return ctx.context.adapter.findOne<StoredWebhookEvent>({
		model: "bnplWebhookEvent",
		where: [{ field: "dedupKey", value: dedupKey }],
	});
}
function storageDedupKey(provider: string, dedupKey: string): string {
	return JSON.stringify([provider, dedupKey]);
}
async function findProviderEvent(
	ctx: GenericEndpointContext,
	provider: string,
	dedupKey: string,
): Promise<{ row: StoredWebhookEvent | null; error?: Error }> {
	const storedKey = storageDedupKey(provider, dedupKey);
	const scoped = await findEventByDedupKey(ctx, storedKey);
	if (scoped) {
		return scoped.provider === provider
			? { row: scoped }
			: {
					row: null,
					error: new Error("bnpl: scoped webhook dedup key belongs to another provider"),
				};
	}
	// Preserve deliveries recorded before keys were scoped by provider.
	const legacy = await findEventByDedupKey(ctx, dedupKey);
	if (legacy?.provider === provider) return { row: legacy };
	return { row: null };
}
export async function recordWebhookEvent(
	ctx: GenericEndpointContext,
	input: InsertWebhookEventInput,
): Promise<RecordWebhookEventResult> {
	const orderId = eventOrderId(input.event);
	if (!orderId) return { outcome: "unrecordable" };
	const dedupKey = storageDedupKey(input.provider, input.dedupKey);
	const existing = await findProviderEvent(ctx, input.provider, input.dedupKey);
	if (existing.error) return { outcome: "infra-error", error: existing.error };
	if (existing.row) return classifyExisting(existing.row);
	try {
		const created = await ctx.context.adapter.create<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			data: {
				provider: input.provider,
				providerOrderId: orderId,
				providerOrderReferenceId: eventReferenceId(input.event),
				eventKind: input.event.kind,
				eventType: eventType(input.event),
				dedupKey,
				receivedAt: new Date(),
				rawData: input.rawBody,
				status: "received",
				attempts: 0,
				orderApplied: false,
			},
		});
		return { outcome: "inserted", row: created };
	} catch (createError) {
		const raced = await findProviderEvent(ctx, input.provider, input.dedupKey);
		if (raced.error) return { outcome: "infra-error", error: raced.error };
		if (raced.row) return classifyExisting(raced.row);
		ctx.context.logger.error(
			`bnpl: failed to record webhook event ${input.dedupKey} and no row exists — treating as infrastructural: ${createError instanceof Error ? createError.message : createError}`,
		);
		return { outcome: "infra-error", error: createError };
	}
}
function classifyExisting(row: StoredWebhookEvent): RecordWebhookEventResult {
	if (row.status === "processed") return { outcome: "duplicate", row };
	return { outcome: "reprocess", row };
}
const PROCESSING_LEASE_MS = 5 * 60 * 1000;
export async function claimWebhookEvent(
	ctx: GenericEndpointContext,
	row: StoredWebhookEvent,
): Promise<StoredWebhookEvent | null> {
	if (
		row.status === "processing" &&
		row.processingUntil &&
		new Date(row.processingUntil).getTime() > Date.now()
	)
		return null;
	const processingToken = crypto.randomUUID();
	return ctx.context.adapter.incrementOne<StoredWebhookEvent>({
		model: "bnplWebhookEvent",
		where: [
			{ field: "id", value: row.id },
			{ field: "status", value: row.status },
			...(row.processingToken ? [{ field: "processingToken", value: row.processingToken }] : []),
		],
		increment: { attempts: 1 },
		set: {
			status: "processing",
			processingToken,
			processingUntil: new Date(Date.now() + PROCESSING_LEASE_MS),
		},
	});
}
export async function updateClaimedWebhookEvent(
	ctx: GenericEndpointContext,
	row: StoredWebhookEvent,
	update: Record<string, unknown>,
): Promise<void> {
	const result = await ctx.context.adapter.incrementOne<StoredWebhookEvent>({
		model: "bnplWebhookEvent",
		where: [
			{ field: "id", value: row.id },
			{ field: "processingToken", value: row.processingToken ?? null },
		],
		increment: {},
		set: update,
	});
	if (!result) throw new Error("bnpl: webhook processing lease was lost");
}
export async function markWebhookEventProcessed(
	ctx: GenericEndpointContext,
	row: StoredWebhookEvent,
): Promise<void> {
	await updateClaimedWebhookEvent(ctx, row, {
		status: "processed",
		processedAt: new Date(),
		lastError: null,
		processingToken: null,
		processingUntil: null,
	});
}
export async function markWebhookEventFailed(
	ctx: GenericEndpointContext,
	row: StoredWebhookEvent,
	error: unknown,
): Promise<void> {
	await updateClaimedWebhookEvent(ctx, row, {
		status: "failed",
		lastError: error instanceof Error ? error.message : String(error),
		processingToken: null,
		processingUntil: null,
	});
}
export async function markWebhookEventOrderApplied(
	ctx: GenericEndpointContext,
	row: StoredWebhookEvent,
): Promise<void> {
	if (!row.orderApplied) await updateClaimedWebhookEvent(ctx, row, { orderApplied: true });
}
export async function saveWebhookDeliveryState(
	ctx: GenericEndpointContext,
	row: StoredWebhookEvent,
	state: unknown,
): Promise<void> {
	await updateClaimedWebhookEvent(ctx, row, {
		deliveryState: JSON.stringify(state),
		processingUntil: new Date(Date.now() + PROCESSING_LEASE_MS),
	});
}
export async function recordSyntheticProviderEvent(
	ctx: GenericEndpointContext,
	provider: BnplProvider,
	event: BnplWebhookEvent,
	raw: unknown,
): Promise<void> {
	if (!provider.webhookDedupKey) return;
	const orderId = eventOrderId(event);
	if (!orderId) return;
	const rawDedupKey = provider.webhookDedupKey(event);
	const dedupKey = storageDedupKey(provider.id, rawDedupKey);
	const existing = await findProviderEvent(ctx, provider.id, rawDedupKey);
	if (existing.error) {
		ctx.context.logger.error(`bnpl: ${existing.error.message}`);
		return;
	}
	if (existing.row) return;
	try {
		await ctx.context.adapter.create<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			data: {
				provider: provider.id,
				providerOrderId: orderId,
				providerOrderReferenceId: eventReferenceId(event),
				eventKind: event.kind,
				eventType: eventType(event),
				dedupKey,
				receivedAt: new Date(),
				rawData: JSON.stringify(raw),
				status: "processed",
				attempts: 1,
				orderApplied: true,
				processedAt: new Date(),
			},
		});
	} catch (e) {
		ctx.context.logger.info(
			`bnpl: synthetic webhook dedup race on ${dedupKey} — ${e instanceof Error ? e.message : e}`,
		);
	}
}
export async function recordSyntheticCaptureEvent(
	ctx: GenericEndpointContext,
	provider: BnplProvider,
	orderId: string,
	currency: string,
	result: CaptureEventResult,
): Promise<void> {
	if (!isBnplCurrency(currency)) return;
	await recordSyntheticProviderEvent(
		ctx,
		provider,
		{
			kind: "captured",
			provider: provider.id,
			orderId,
			captureId: result.captureId,
			amountMinor: result.amountMinor,
			currency,
			raw: result.raw,
		},
		result.raw,
	);
}
export async function recordSyntheticRefundEvent(
	ctx: GenericEndpointContext,
	provider: BnplProvider,
	orderId: string,
	currency: string,
	result: RefundEventResult,
): Promise<void> {
	if (!isBnplCurrency(currency)) return;
	await recordSyntheticProviderEvent(
		ctx,
		provider,
		{
			kind: "refunded",
			provider: provider.id,
			orderId,
			refundId: result.refundId,
			amountMinor: result.amountMinor,
			currency,
			raw: result.raw,
		},
		result.raw,
	);
}
