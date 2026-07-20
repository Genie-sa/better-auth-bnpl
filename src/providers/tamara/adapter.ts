import { createHash } from "node:crypto";
import { BnplPluginError } from "../../core/errors";
import { isMoneyLike, isOneOf, isRecord, readStringField } from "../../core/guards";
import { isBnplCurrency, parseAmount } from "../../core/money";
import { type CanonicalStatus, isCanonicalStatus } from "../../core/status";
import type {
	BnplAddress,
	BnplBuyer,
	BnplCheckoutInput,
	BnplOrderItem,
	BnplWebhookEvent,
} from "../../core/types";
import {
	TAMARA_COUNTRY_CODES,
	TAMARA_PAYMENT_TYPES,
	type TamaraCountryCode,
	type TamaraLocale,
	type TamaraPaymentType,
} from "./constants";
import type {
	TamaraAddress,
	TamaraCheckoutRequest,
	TamaraConsumer,
	TamaraIncomingMessage,
	TamaraOrderItem,
} from "./types";
import { isTamaraAuthoriseMessage } from "./types";
const PROVIDER_ID = "tamara";
const LOCALE_MAP: Record<string, TamaraLocale> = {
	en: "en_US",
	en_US: "en_US",
	ar: "ar_SA",
	ar_SA: "ar_SA",
};
function narrowTamaraCountry(code: string): TamaraCountryCode {
	if (!isOneOf(code, TAMARA_COUNTRY_CODES)) {
		throw new BnplPluginError(
			"PROVIDER_NOT_AVAILABLE",
			`tamara does not support country code: ${code}`,
		);
	}
	return code;
}
function narrowTamaraPaymentType(value: string | undefined): TamaraPaymentType | undefined {
	if (value === undefined) return undefined;
	if (!isOneOf(value, TAMARA_PAYMENT_TYPES)) {
		throw new BnplPluginError(
			"PROVIDER_NOT_AVAILABLE",
			`tamara does not support paymentType: ${value}`,
		);
	}
	return value;
}
export function toTamaraConsumer(buyer: BnplBuyer): TamaraConsumer {
	return {
		first_name: buyer.firstName,
		last_name: buyer.lastName,
		email: buyer.email,
		phone_number: buyer.phone,
		national_id: buyer.nationalId,
		date_of_birth: buyer.dateOfBirth,
		is_first_order: buyer.isFirstOrder,
	};
}
export function toTamaraAddress(addr: BnplAddress): TamaraAddress {
	return {
		first_name: addr.firstName ?? "",
		last_name: addr.lastName ?? "",
		line1: addr.line1,
		line2: addr.line2,
		region: addr.region,
		postal_code: addr.postalCode,
		city: addr.city,
		country_code: narrowTamaraCountry(addr.countryCode),
		phone_number: addr.phone,
	};
}
export function toTamaraItem(item: BnplOrderItem): TamaraOrderItem {
	return {
		reference_id: item.referenceId,
		type: item.type ?? "Physical",
		name: item.name,
		sku: item.sku,
		image_url: item.imageUrl,
		item_url: item.itemUrl,
		quantity: item.quantity,
		unit_price: item.unitPrice,
		total_amount: item.totalAmount,
		tax_amount: item.taxAmount,
		discount_amount: item.discountAmount,
	};
}
export interface ToTamaraCheckoutOptions {
	defaultLocale?: TamaraLocale;
	defaultPaymentType?: TamaraPaymentType;
}
export function toTamaraCheckoutRequest(
	input: BnplCheckoutInput,
	opts: ToTamaraCheckoutOptions = {},
): TamaraCheckoutRequest {
	if (!input.shippingAddress) {
		throw new BnplPluginError("PROVIDER_NOT_AVAILABLE", "tamara: shippingAddress is required");
	}
	const locale = input.locale ? LOCALE_MAP[input.locale] : opts.defaultLocale;
	return {
		order_reference_id: input.orderReferenceId,
		total_amount: input.totalAmount,
		description: input.description,
		country_code: narrowTamaraCountry(input.countryCode),
		payment_type:
			narrowTamaraPaymentType(input.paymentType) ?? opts.defaultPaymentType ?? "PAY_BY_INSTALMENTS",
		instalments: input.instalments,
		locale,
		items: input.items.map(toTamaraItem),
		consumer: toTamaraConsumer(input.buyer),
		shipping_address: toTamaraAddress(input.shippingAddress),
		billing_address: input.billingAddress ? toTamaraAddress(input.billingAddress) : undefined,
		discount: input.discount,
		tax_amount: input.taxAmount ?? { amount: "0.00", currency: input.totalAmount.currency },
		shipping_amount: input.shippingAmount ?? {
			amount: "0.00",
			currency: input.totalAmount.currency,
		},
		merchant_url: {
			success: input.merchantUrl.success,
			failure: input.merchantUrl.failure,
			cancel: input.merchantUrl.cancel,
			notification: input.merchantUrl.notification,
		},
		is_mobile: input.isMobile,
		expires_in_minutes: input.expiresInMinutes,
		additional_data: input.additionalData,
	};
}
export function tamaraStatusToCanonical(status: string): CanonicalStatus {
	return isCanonicalStatus(status) ? status : "new";
}
const EVENT_TO_KIND_DIRECT = {
	order_approved: "approved",
	order_authorised: "authorized",
	order_declined: "declined",
	order_canceled: "canceled",
	order_expired: "expired",
	order_updated: "updated",
} as const;
const isDirectEvent = (t: string): t is keyof typeof EVENT_TO_KIND_DIRECT =>
	Object.hasOwn(EVENT_TO_KIND_DIRECT, t);
export function tamaraToCanonicalEvent(payload: Record<string, unknown>): BnplWebhookEvent | null {
	const msg = normaliseTamaraMessage(payload);
	if (!msg) return null;
	if (isTamaraAuthoriseMessage(msg)) {
		const status = msg.order_status;
		if (status === "approved") {
			return {
				kind: "approved",
				provider: PROVIDER_ID,
				orderId: msg.order_id,
				orderReferenceId: msg.order_reference_id,
				raw: payload,
			};
		}
		if (status === "declined") {
			return {
				kind: "declined",
				provider: PROVIDER_ID,
				orderId: msg.order_id,
				raw: payload,
			};
		}
		return {
			kind: "unknown",
			provider: PROVIDER_ID,
			orderId: msg.order_id,
			eventType: `authorise:${status}`,
			raw: payload,
		};
	}
	const eventType = msg.event_type;
	if (isDirectEvent(eventType)) {
		const kind = EVENT_TO_KIND_DIRECT[eventType];
		switch (kind) {
			case "declined": {
				const reason =
					readStringField(msg.data, "declined_reason") ??
					readStringField(msg.data, "declined_code");
				return {
					kind: "declined",
					provider: PROVIDER_ID,
					orderId: msg.order_id,
					reason,
					raw: payload,
				};
			}
			case "updated":
				return { kind: "updated", provider: PROVIDER_ID, orderId: msg.order_id, raw: payload };
			case "canceled":
				return { kind: "canceled", provider: PROVIDER_ID, orderId: msg.order_id, raw: payload };
			case "expired":
				return { kind: "expired", provider: PROVIDER_ID, orderId: msg.order_id, raw: payload };
			case "approved":
				return {
					kind: "approved",
					provider: PROVIDER_ID,
					orderId: msg.order_id,
					orderReferenceId: msg.order_reference_id,
					raw: payload,
				};
			case "authorized":
				return {
					kind: "authorized",
					provider: PROVIDER_ID,
					orderId: msg.order_id,
					orderReferenceId: msg.order_reference_id,
					raw: payload,
				};
		}
	}
	if (eventType === "order_captured") {
		const captureId = readStringField(msg.data, "capture_id") ?? "";
		const moneyField = isRecord(msg.data) ? msg.data.captured_amount : undefined;
		if (!isMoneyLike(moneyField) || !captureId || !isBnplCurrency(moneyField.currency)) {
			return fallbackUnknown(payload, msg.order_id, eventType);
		}
		const amountMinor = parseAmountSafe(moneyField);
		if (amountMinor === null) return fallbackUnknown(payload, msg.order_id, eventType);
		return {
			kind: "captured",
			provider: PROVIDER_ID,
			orderId: msg.order_id,
			captureId,
			amountMinor,
			currency: moneyField.currency,
			raw: payload,
		};
	}
	if (eventType === "order_refunded") {
		const refundId = readStringField(msg.data, "refund_id") ?? "";
		const moneyField = isRecord(msg.data) ? msg.data.refunded_amount : undefined;
		if (!isMoneyLike(moneyField) || !refundId || !isBnplCurrency(moneyField.currency)) {
			return fallbackUnknown(payload, msg.order_id, eventType);
		}
		const amountMinor = parseAmountSafe(moneyField);
		if (amountMinor === null) return fallbackUnknown(payload, msg.order_id, eventType);
		return {
			kind: "refunded",
			provider: PROVIDER_ID,
			orderId: msg.order_id,
			refundId,
			amountMinor,
			currency: moneyField.currency,
			raw: payload,
		};
	}
	return fallbackUnknown(payload, msg.order_id, eventType);
}
export function tamaraDedupKey(payload: Record<string, unknown>): string {
	const msg = normaliseTamaraMessage(payload);
	if (!msg) {
		const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
		return `${PROVIDER_ID}:unknown:${digest}`;
	}
	const orderId = msg.order_id;
	if (isTamaraAuthoriseMessage(msg)) {
		return `${PROVIDER_ID}:authorise:${orderId}`;
	}
	const data = msg.data;
	switch (msg.event_type) {
		case "order_captured": {
			const captureId = readStringField(data, "capture_id");
			if (captureId) return `${PROVIDER_ID}:order_captured:${captureId}`;
			break;
		}
		case "order_refunded": {
			const refundId = readStringField(data, "refund_id");
			if (refundId) return `${PROVIDER_ID}:order_refunded:${refundId}`;
			break;
		}
		case "order_canceled": {
			const cancelId = readStringField(data, "cancel_id");
			if (cancelId) return `${PROVIDER_ID}:order_canceled:${cancelId}`;
			break;
		}
	}
	return `${PROVIDER_ID}:${msg.event_type}:${orderId}`;
}
export function tamaraWebhookDedupKeyForEvent(event: BnplWebhookEvent): string {
	switch (event.kind) {
		case "approved":
			return `${PROVIDER_ID}:order_approved:${event.orderId}`;
		case "authorized":
			return `${PROVIDER_ID}:order_authorised:${event.orderId}`;
		case "captured":
			return `${PROVIDER_ID}:order_captured:${event.captureId}`;
		case "refunded":
			return `${PROVIDER_ID}:order_refunded:${event.refundId}`;
		case "canceled":
			return `${PROVIDER_ID}:order_canceled:${event.orderId}`;
		case "expired":
			return `${PROVIDER_ID}:order_expired:${event.orderId}`;
		case "declined":
			return `${PROVIDER_ID}:order_declined:${event.orderId}`;
		case "updated":
			return `${PROVIDER_ID}:order_updated:${event.orderId}`;
		case "unknown":
			return `${PROVIDER_ID}:${event.eventType}:${event.orderId ?? "unknown"}`;
	}
}
function fallbackUnknown(
	payload: Record<string, unknown>,
	orderId: string | undefined,
	eventType: string,
): BnplWebhookEvent {
	return { kind: "unknown", provider: PROVIDER_ID, orderId, eventType, raw: payload };
}
function parseAmountSafe(money: {
	amount: number | string;
	currency: string;
}): number | null {
	try {
		return parseAmount(money);
	} catch {
		return null;
	}
}
function normaliseTamaraMessage(payload: Record<string, unknown>): TamaraIncomingMessage | null {
	const orderId = payload.order_id;
	const orderRefId = payload.order_reference_id;
	if (typeof orderId !== "string" || typeof orderRefId !== "string") return null;
	const rawData = payload.data;
	const data: Record<string, unknown> =
		Array.isArray(rawData) && rawData.length === 0 ? {} : isRecord(rawData) ? rawData : {};
	if (typeof payload.event_type === "string") {
		return {
			order_id: orderId,
			order_reference_id: orderRefId,
			event_type: payload.event_type,
			data,
		};
	}
	if (typeof payload.order_status === "string") {
		return {
			order_id: orderId,
			order_reference_id: orderRefId,
			order_status: payload.order_status,
			data,
		};
	}
	return null;
}
