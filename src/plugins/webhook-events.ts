import type { GenericEndpointContext } from "better-auth";
import { isBnplCurrency } from "../core/money";
import type { BnplProvider } from "../core/provider";
import type { BnplCaptureResult, BnplRefundResult, BnplWebhookEvent } from "../core/types";
export type WebhookEventStatus = "received" | "processed" | "failed";
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
export async function recordWebhookEvent(
	ctx: GenericEndpointContext,
	input: InsertWebhookEventInput,
): Promise<RecordWebhookEventResult> {
	const orderId = eventOrderId(input.event);
	if (!orderId) return { outcome: "unrecordable" };
	const existing = await findEventByDedupKey(ctx, input.dedupKey);
	if (existing) return classifyExisting(existing);
	try {
		const created = await ctx.context.adapter.create<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			data: {
				provider: input.provider,
				providerOrderId: orderId,
				providerOrderReferenceId: eventReferenceId(input.event),
				eventKind: input.event.kind,
				eventType: eventType(input.event),
				dedupKey: input.dedupKey,
				receivedAt: new Date(),
				rawData: input.rawBody,
				status: "received",
				attempts: 0,
				orderApplied: false,
			},
		});
		return { outcome: "inserted", row: created };
	} catch (createError) {
		const raced = await findEventByDedupKey(ctx, input.dedupKey);
		if (raced) return classifyExisting(raced);
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
export async function markWebhookEventProcessed(
	ctx: GenericEndpointContext,
	row: StoredWebhookEvent,
): Promise<void> {
	await ctx.context.adapter.update({
		model: "bnplWebhookEvent",
		where: [{ field: "id", value: row.id }],
		update: {
			status: "processed",
			processedAt: new Date(),
			attempts: (row.attempts ?? 0) + 1,
			lastError: null,
		},
	});
}
export async function markWebhookEventFailed(
	ctx: GenericEndpointContext,
	row: StoredWebhookEvent,
	error: unknown,
): Promise<void> {
	await ctx.context.adapter.update({
		model: "bnplWebhookEvent",
		where: [{ field: "id", value: row.id }],
		update: {
			status: "failed",
			attempts: (row.attempts ?? 0) + 1,
			lastError: error instanceof Error ? error.message : String(error),
		},
	});
}
export async function markWebhookEventOrderApplied(
	ctx: GenericEndpointContext,
	row: StoredWebhookEvent,
): Promise<void> {
	if (row.orderApplied) return;
	await ctx.context.adapter.update({
		model: "bnplWebhookEvent",
		where: [{ field: "id", value: row.id }],
		update: { orderApplied: true },
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
	const dedupKey = provider.webhookDedupKey(event);
	const existing = await findEventByDedupKey(ctx, dedupKey);
	if (existing) return;
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
