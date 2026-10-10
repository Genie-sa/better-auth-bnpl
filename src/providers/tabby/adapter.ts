import { createHash } from "node:crypto";
import { BnplProviderError } from "../../core/errors";
import { isOneOf, isRecord, readStringField } from "../../core/guards";
import { formatAmount, isBnplCurrency, parseAmount } from "../../core/money";
import type { CanonicalStatus } from "../../core/status";
import type {
	BnplAddress,
	BnplBuyer,
	BnplCheckoutInput,
	BnplOrderItem,
	BnplPaymentType,
	BnplWebhookEvent,
} from "../../core/types";
import { tabbyCheckoutDataSchema, tabbyPaymentDetailsSchema } from "./schemas";
import type {
	TabbyBuyer,
	TabbyCaptureRecord,
	TabbyCheckoutRequest,
	TabbyOrderItem,
	TabbyPaymentDetails,
	TabbyPaymentStatus,
	TabbyRefundRecord,
	TabbyShippingAddress,
} from "./types";
const PROVIDER_ID = "tabby";
export type TabbyProductKey = "installments" | "pay_later" | "pay_in_full";
const TABBY_PAYMENT_STATUSES = [
	"CREATED",
	"AUTHORIZED",
	"CLOSED",
	"REJECTED",
	"EXPIRED",
] as const satisfies readonly TabbyPaymentStatus[];
interface TabbyAmountRecord {
	id: string;
	amount: string;
}
function readPaymentRecord(value: unknown): TabbyCaptureRecord | null {
	if (!isRecord(value)) return null;
	const id = value.id;
	const amount = value.amount;
	if (typeof id !== "string" || typeof amount !== "string") return null;
	const created = value.created_at;
	const referenceId = value.reference_id;
	return {
		id,
		amount,
		created_at: typeof created === "string" ? created : undefined,
		reference_id: typeof referenceId === "string" ? referenceId : undefined,
	};
}
function readPaymentRecords(value: unknown): TabbyCaptureRecord[] {
	if (!Array.isArray(value)) return [];
	const out: TabbyCaptureRecord[] = [];
	for (const item of value) {
		const rec = readPaymentRecord(item);
		if (rec) out.push(rec);
	}
	return out;
}
export function toTabbyBuyer(buyer: BnplBuyer): TabbyBuyer {
	const fullName = `${buyer.firstName} ${buyer.lastName}`.trim();
	return {
		name: fullName,
		email: buyer.email,
		phone: buyer.phone,
		dob: buyer.dateOfBirth,
	};
}
export function toTabbyShippingAddress(addr: BnplAddress): TabbyShippingAddress {
	const line = [addr.line1, addr.line2].filter(Boolean).join(", ");
	return {
		address: line || addr.line1,
		city: addr.city,
		zip: addr.postalCode,
	};
}
export function toTabbyItem(item: BnplOrderItem): TabbyOrderItem {
	if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
		throw new BnplProviderError("tabby", "item quantity must be a positive safe integer");
	}
	const totalMinor = parseAmount(item.totalAmount);
	if (item.unitPrice && item.unitPrice.currency !== item.totalAmount.currency) {
		throw new BnplProviderError("tabby", "item unit price currency differs from line total");
	}
	if (!item.unitPrice && totalMinor % item.quantity !== 0) {
		throw new BnplProviderError(
			"tabby",
			"item line total cannot be divided exactly; provide unitPrice",
		);
	}
	const unitPrice = item.unitPrice
		? formatAmount(parseAmount(item.unitPrice), item.unitPrice.currency).amount
		: formatAmount(totalMinor / item.quantity, item.totalAmount.currency).amount;
	return {
		reference_id: item.referenceId,
		title: item.name,
		quantity: item.quantity,
		unit_price: unitPrice,
		category: item.category ?? item.type,
		discount_amount: item.discountAmount?.amount,
		image_url: item.imageUrl,
		product_url: item.itemUrl,
	};
}
export function tabbyProductKeyForPaymentType(
	paymentType: BnplPaymentType | undefined,
): TabbyProductKey {
	switch (paymentType) {
		case "PAY_BY_LATER":
			return "pay_later";
		case "PAY_NOW":
			return "pay_in_full";
		case "PAY_BY_INSTALMENTS":
		case "SPLIT_IN_3":
		case undefined:
			return "installments";
	}
}
export interface ToTabbyCheckoutOptions {
	merchantCode: string;
}
export function toTabbyCheckoutRequest(
	input: BnplCheckoutInput,
	opts: ToTabbyCheckoutOptions,
): TabbyCheckoutRequest {
	const amounts = [
		input.totalAmount,
		input.taxAmount,
		input.shippingAmount,
		input.discount?.amount,
		...input.items.flatMap((item) => [
			item.totalAmount,
			item.unitPrice,
			item.taxAmount,
			item.discountAmount,
		]),
	];
	for (const money of amounts) {
		if (!money) continue;
		if (money.currency !== input.totalAmount.currency)
			throw new BnplProviderError("tabby", "checkout money currency differs from payment currency");
		parseAmount(money);
	}
	const lang = input.locale?.startsWith("ar") ? "ar" : "en";
	const providerData =
		input.providerData === undefined
			? undefined
			: tabbyCheckoutDataSchema.safeParse(input.providerData);
	if (providerData && !providerData.success) {
		throw new Error("tabby: checkout providerData is invalid");
	}
	return {
		payment: {
			amount: input.totalAmount.amount,
			currency: input.totalAmount.currency,
			description: input.description,
			buyer: toTabbyBuyer(input.buyer),
			...(input.shippingAddress
				? { shipping_address: toTabbyShippingAddress(input.shippingAddress) }
				: {}),
			order: {
				reference_id: input.orderReferenceId,
				tax_amount: input.taxAmount?.amount,
				shipping_amount: input.shippingAmount?.amount,
				discount_amount: input.discount?.amount.amount,
				items: input.items.map(toTabbyItem),
			},
			meta: input.metadata,
			...(providerData
				? {
						buyer_history: providerData.data.buyer_history,
						order_history: providerData.data.order_history,
						...(providerData.data.attachment
							? {
									attachment: {
										...providerData.data.attachment,
										body: JSON.stringify(providerData.data.attachment.body),
									},
								}
							: {}),
					}
				: {}),
		},
		lang,
		merchant_code: opts.merchantCode,
		merchant_urls: {
			success: input.merchantUrl.success,
			cancel: input.merchantUrl.cancel,
			failure: input.merchantUrl.failure,
		},
	};
}
export function tabbyStatusToCanonical(
	status: string,
	totalMinor: number,
	capturedMinor: number,
	refundedMinor: number,
	logger?: {
		warn: (msg: string) => void;
	},
): CanonicalStatus {
	const normalized = normalizeTabbyPaymentStatus(status);
	if (normalized === null) {
		logger?.warn(`tabby: unknown payment status "${status}"`);
		throw new BnplProviderError("tabby", "unknown payment status");
	}
	switch (normalized) {
		case "CREATED":
			return "new";
		case "AUTHORIZED":
			return capturedMinor > 0 ? "partially_captured" : "authorised";
		case "CLOSED":
			if (capturedMinor > 0 && refundedMinor >= capturedMinor) return "fully_refunded";
			if (refundedMinor > 0) return "partially_refunded";
			if (capturedMinor >= totalMinor && capturedMinor > 0) return "fully_captured";
			if (capturedMinor > 0) return "closed";
			return "canceled";
		case "REJECTED":
			return "declined";
		case "EXPIRED":
			return "expired";
	}
}
export function sumCapturesMinor(
	records: TabbyCaptureRecord[] | undefined,
	currency: string,
	logger: {
		warn: (msg: string) => void;
	},
): number {
	return sumAmountRecordsMinor(records, "capture", currency, logger);
}
export function sumRefundsMinor(
	records: TabbyRefundRecord[] | undefined,
	currency: string,
	logger: {
		warn: (msg: string) => void;
	},
): number {
	return sumAmountRecordsMinor(records, "refund", currency, logger);
}
function sumAmountRecordsMinor(
	records: readonly TabbyAmountRecord[] | undefined,
	recordKind: "capture" | "refund",
	currency: string,
	logger: {
		warn: (msg: string) => void;
	},
): number {
	if (!records || records.length === 0) return 0;
	let total = 0;
	const ids = new Set<string>();
	for (const rec of records) {
		if (!rec.id || ids.has(rec.id)) {
			throw new BnplProviderError("tabby", `invalid or duplicate ${recordKind} record ID`);
		}
		ids.add(rec.id);
		try {
			total += parseAmount({ amount: rec.amount, currency });
			if (!Number.isSafeInteger(total)) throw new Error("aggregate exceeds safe integer range");
		} catch (e) {
			logger.warn(`tabby: invalid ${recordKind} amount`);
			throw new BnplProviderError("tabby", `invalid ${recordKind} amount`, { cause: e });
		}
	}
	return total;
}
export function tabbyToCanonicalEvent(payload: Record<string, unknown>): BnplWebhookEvent | null {
	const orderId = typeof payload.id === "string" ? payload.id : undefined;
	if (!orderId) return null;
	const status = normalizeTabbyPaymentStatus(payload.status);
	const event = typeof payload.event === "string" ? payload.event.toLowerCase() : null;
	const currency = typeof payload.currency === "string" ? payload.currency : null;
	const captures = readPaymentRecords(payload.captures);
	const refunds = readPaymentRecords(payload.refunds);
	const refId = isRecord(payload.order)
		? readStringField(payload.order, "reference_id")
		: undefined;
	const eventKindByName = (() => {
		if (!event) return null;
		if (event.includes("authoriz")) return "authorized";
		if (event.includes("captur")) return "captured";
		if (event.includes("refund")) return "refunded";
		if (event.includes("closed")) return "closed";
		if (event.includes("reject") || event.includes("declined")) return "declined";
		if (event.includes("expir")) return "expired";
		return null;
	})();
	const inferredKind = eventKindByName ?? statusToEventKind(status, captures, refunds);
	if (inferredKind === "captured" && currency && captures.length > 0) {
		const latest = captures[captures.length - 1];
		if (latest && isBnplCurrency(currency)) {
			let amountMinor: number;
			try {
				amountMinor = parseAmount({ amount: latest.amount, currency });
			} catch {
				return fallbackUnknown(payload, orderId, event ?? status ?? "captured");
			}
			return {
				kind: "captured",
				provider: PROVIDER_ID,
				orderId,
				captureId: latest.id,
				amountMinor,
				currency,
				raw: payload,
			};
		}
	}
	if (inferredKind === "refunded" && currency && refunds.length > 0) {
		const latest = refunds[refunds.length - 1];
		if (latest && isBnplCurrency(currency)) {
			let amountMinor: number;
			try {
				amountMinor = parseAmount({ amount: latest.amount, currency });
			} catch {
				return fallbackUnknown(payload, orderId, event ?? status ?? "refunded");
			}
			return {
				kind: "refunded",
				provider: PROVIDER_ID,
				orderId,
				refundId: latest.id,
				amountMinor,
				currency,
				raw: payload,
			};
		}
	}
	if (inferredKind === "authorized") {
		return {
			kind: "authorized",
			provider: PROVIDER_ID,
			orderId,
			orderReferenceId: refId,
			raw: payload,
		};
	}
	if (inferredKind === "declined") {
		return { kind: "declined", provider: PROVIDER_ID, orderId, raw: payload };
	}
	if (inferredKind === "expired") {
		return { kind: "expired", provider: PROVIDER_ID, orderId, raw: payload };
	}
	if (inferredKind === "closed") {
		return { kind: "updated", provider: PROVIDER_ID, orderId, raw: payload };
	}
	return fallbackUnknown(payload, orderId, event ?? status ?? "unknown");
}
function normalizeTabbyPaymentStatus(value: unknown): TabbyPaymentStatus | null {
	if (typeof value !== "string") return null;
	const upper = value.toUpperCase();
	return isOneOf(upper, TABBY_PAYMENT_STATUSES) ? upper : null;
}
function statusToEventKind(
	status: TabbyPaymentStatus | null,
	captures: readonly TabbyCaptureRecord[],
	refunds: readonly TabbyRefundRecord[],
): string | null {
	if (!status) return null;
	if (refunds.length > 0) return "refunded";
	switch (status) {
		case "AUTHORIZED":
			return captures.length > 0 ? "captured" : "authorized";
		case "CLOSED":
			return captures.length > 0 ? "captured" : "closed";
		case "REJECTED":
			return "declined";
		case "EXPIRED":
			return "expired";
		default:
			return null;
	}
}
export function tabbyDedupKey(payload: Record<string, unknown>): string {
	const paymentId = typeof payload.id === "string" ? payload.id : "unknown";
	const event = typeof payload.event === "string" ? payload.event.toLowerCase() : null;
	const status = normalizeTabbyPaymentStatus(payload.status);
	const captures = readPaymentRecords(payload.captures);
	const refunds = readPaymentRecords(payload.refunds);
	if (event?.includes("refund") || refunds.length > 0) {
		const latest = refunds[refunds.length - 1];
		if (latest) return `${PROVIDER_ID}:refunded:${latest.id}`;
	}
	if (event?.includes("captur") || status === "AUTHORIZED" || status === "CLOSED") {
		const latest = captures[captures.length - 1];
		if (latest) return `${PROVIDER_ID}:captured:${latest.id}`;
	}
	return `${PROVIDER_ID}:${event ?? status ?? "event"}:${paymentId}`;
}
export function tabbyWebhookDedupKeyForEvent(event: BnplWebhookEvent): string {
	switch (event.kind) {
		case "captured":
			return `${PROVIDER_ID}:captured:${event.captureId}`;
		case "refunded":
			return `${PROVIDER_ID}:refunded:${event.refundId}`;
		case "authorized":
			return `${PROVIDER_ID}:AUTHORIZED:${event.orderId}`;
		case "declined":
			return `${PROVIDER_ID}:REJECTED:${event.orderId}`;
		case "expired":
			return `${PROVIDER_ID}:EXPIRED:${event.orderId}`;
		case "updated":
			return `${PROVIDER_ID}:CLOSED:${event.orderId}`;
		case "approved":
			return `${PROVIDER_ID}:approved:${event.orderId}`;
		case "canceled":
			return `${PROVIDER_ID}:canceled:${event.orderId}`;
		case "unknown":
			return `${PROVIDER_ID}:${event.eventType}:${event.orderId ?? "unknown"}`;
	}
}
function fallbackUnknown(
	payload: Record<string, unknown>,
	orderId: string,
	eventType: string,
): BnplWebhookEvent {
	return { kind: "unknown", provider: PROVIDER_ID, orderId, eventType, raw: payload };
}
export function fromTabbyPaymentDetails(
	payment: TabbyPaymentDetails,
	logger: {
		warn: (msg: string) => void;
	},
): {
	totalMinor: number;
	capturedMinor: number;
	refundedMinor: number;
	status: CanonicalStatus;
} {
	const totalMinor = parseAmount({ amount: payment.amount, currency: payment.currency });
	const capturedMinor = sumCapturesMinor(payment.captures, payment.currency, logger);
	const refundedMinor = sumRefundsMinor(payment.refunds, payment.currency, logger);
	if (capturedMinor > totalMinor || refundedMinor > capturedMinor) {
		throw new BnplProviderError("tabby", "payment financial totals are inconsistent");
	}
	return {
		totalMinor,
		capturedMinor,
		refundedMinor,
		status: tabbyStatusToCanonical(
			payment.status,
			totalMinor,
			capturedMinor,
			refundedMinor,
			logger,
		),
	};
}

export function tabbyToCanonicalEvents(payload: Record<string, unknown>): BnplWebhookEvent[] {
	const parsed = tabbyPaymentDetailsSchema.safeParse(payload);
	if (!parsed.success)
		throw new BnplProviderError("tabby", "invalid payment snapshot", { cause: parsed.error });
	const payment = parsed.data;
	const derived = fromTabbyPaymentDetails(payment, { warn: () => {} });
	const currency = payment.currency;
	if (!isBnplCurrency(currency)) throw new BnplProviderError("tabby", "invalid payment currency");
	const events: BnplWebhookEvent[] = [];
	for (const record of payment.captures ?? []) {
		events.push({
			kind: "captured",
			provider: PROVIDER_ID,
			orderId: payment.id,
			captureId: record.id,
			amountMinor: parseAmount({ amount: record.amount, currency }),
			currency,
			raw: payload,
		});
	}
	for (const record of payment.refunds ?? []) {
		events.push({
			kind: "refunded",
			provider: PROVIDER_ID,
			orderId: payment.id,
			refundId: record.id,
			amountMinor: parseAmount({ amount: record.amount, currency }),
			currency,
			raw: payload,
		});
	}
	const orderReferenceId = isRecord(payload.order)
		? readStringField(payload.order, "reference_id")
		: undefined;
	if (
		payment.status.toUpperCase() === "AUTHORIZED" &&
		!payment.captures?.length &&
		!payment.refunds?.length
	) {
		events.push({
			kind: "authorized",
			provider: PROVIDER_ID,
			orderId: payment.id,
			orderReferenceId,
			raw: payload,
		});
	}
	if (derived.status === "declined" || derived.status === "expired") {
		events.push({ kind: derived.status, provider: PROVIDER_ID, orderId: payment.id, raw: payload });
	}
	events.push({
		kind: "updated",
		provider: PROVIDER_ID,
		orderId: payment.id,
		status: derived.status,
		orderReferenceId,
		totalAmount: formatAmount(derived.totalMinor, currency),
		raw: payload,
	});
	return events;
}
export function tabbySnapshotDedupKey(payload: Record<string, unknown>): string {
	const events = tabbyToCanonicalEvents(payload);
	const identity = events.map(({ raw: _raw, ...event }) => event);
	const money = identity
		.filter((event) => event.kind === "captured" || event.kind === "refunded")
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	const lifecycle = identity.filter(
		(event) => event.kind !== "captured" && event.kind !== "refunded",
	);
	return `${PROVIDER_ID}:snapshot:${createHash("sha256")
		.update(JSON.stringify([...money, ...lifecycle]))
		.digest("hex")}`;
}
