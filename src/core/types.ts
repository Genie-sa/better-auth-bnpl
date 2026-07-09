import type { BnplCurrency } from "./money";
import type { CanonicalStatus } from "./status";
import type { AbsoluteUrl } from "./url";
export type NonEmptyArray<T> = [T, ...T[]];
export type BnplEnvironment = "sandbox" | "production";
export interface BnplMoney {
	amount: string;
	currency: BnplCurrency;
}
export type BnplLocale = "en" | "ar" | "en_US" | "ar_SA";
export type BnplPaymentType = "PAY_BY_INSTALMENTS" | "PAY_BY_LATER" | "PAY_NOW" | "SPLIT_IN_3";
export interface BnplBuyer {
	firstName: string;
	lastName: string;
	email: string;
	phone: string;
	dateOfBirth?: string;
	nationalId?: string;
	isFirstOrder?: boolean;
}
export interface BnplAddress {
	firstName?: string;
	lastName?: string;
	line1: string;
	line2?: string;
	city: string;
	region?: string;
	postalCode?: string;
	countryCode: string;
	phone?: string;
}
export interface BnplOrderItem {
	referenceId: string;
	name: string;
	sku: string;
	quantity: number;
	totalAmount: BnplMoney;
	unitPrice?: BnplMoney;
	taxAmount?: BnplMoney;
	discountAmount?: BnplMoney;
	imageUrl?: AbsoluteUrl;
	itemUrl?: AbsoluteUrl;
	type?: string;
	category?: string;
}
export interface BnplDiscount {
	name: string;
	amount: BnplMoney;
}
export interface BnplMerchantUrls {
	success: AbsoluteUrl;
	failure: AbsoluteUrl;
	cancel: AbsoluteUrl;
	notification: AbsoluteUrl;
}
export interface BnplCheckoutInput {
	orderReferenceId: string;
	description: string;
	totalAmount: BnplMoney;
	taxAmount?: BnplMoney;
	shippingAmount?: BnplMoney;
	discount?: BnplDiscount;
	items: NonEmptyArray<BnplOrderItem>;
	buyer: BnplBuyer;
	shippingAddress: BnplAddress;
	billingAddress?: BnplAddress;
	countryCode: string;
	locale?: BnplLocale;
	paymentType?: BnplPaymentType;
	instalments?: number;
	expiresInMinutes?: number;
	isMobile?: boolean;
	metadata?: Record<string, unknown>;
	additionalData?: Record<string, unknown>;
	merchantUrl: BnplMerchantUrls;
}
interface BnplCheckoutResultBase {
	providerOrderId: string;
	providerCheckoutId: string;
	raw: unknown;
}
export interface BnplApprovedCheckoutResult extends BnplCheckoutResultBase {
	checkoutUrl: AbsoluteUrl;
	status: Exclude<CanonicalStatus, "declined">;
	qrCodeUrl?: string;
}
export interface BnplDeclinedCheckoutResult extends BnplCheckoutResultBase {
	status: "declined";
	rejectionReason?: string;
}
export type BnplCheckoutResult = BnplApprovedCheckoutResult | BnplDeclinedCheckoutResult;
export interface BnplCaptureArgs {
	totalAmount: BnplMoney;
	shippingAmount?: BnplMoney;
	taxAmount?: BnplMoney;
	discountAmount?: BnplMoney;
	items?: BnplOrderItem[];
	shippingInfo?: {
		shippedAt?: string;
		shippingCompany?: string;
		trackingNumber?: string;
		trackingUrl?: AbsoluteUrl;
	};
	merchantReferenceId?: string;
}
export interface BnplCaptureResult {
	captureId: string;
	providerOrderId: string;
	amountMinor: number;
	raw: unknown;
}
export interface BnplRefundArgs {
	totalAmount: BnplMoney;
	items?: BnplOrderItem[];
	comment?: string;
	merchantRefundId?: string;
}
export interface BnplRefundResult {
	refundId: string;
	providerOrderId: string;
	amountMinor: number;
	raw: unknown;
}
export interface BnplCancelArgs {
	totalAmount?: BnplMoney;
	shippingAmount?: BnplMoney;
	taxAmount?: BnplMoney;
	discountAmount?: BnplMoney;
	items?: BnplOrderItem[];
	merchantReferenceId?: string;
	comment?: string;
}
export interface BnplAuthorizeResult {
	providerOrderId: string;
	status: CanonicalStatus;
	autoCaptured?: boolean;
	captureId?: string;
	capturedAmountMinor?: number;
	raw: unknown;
}
export interface BnplOrderState {
	providerOrderId: string;
	orderReferenceId?: string;
	status: CanonicalStatus;
	totalAmount: BnplMoney;
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	raw: unknown;
}
export interface BnplPersistedOrder {
	userId?: string | null;
	provider: string;
	orderReferenceId: string;
	providerOrderId?: string;
	providerCheckoutId?: string;
	status: CanonicalStatus | (string & {});
	amountMinor: number;
	currency: BnplCurrency | (string & {});
	paymentType?: BnplPaymentType | (string & {});
	authorisedAt?: Date | string | null;
	capturedAt?: Date | string | null;
	capturedAmountMinor: number;
	canceledAt?: Date | string | null;
	refundedAmountMinor: number;
	rawData?: string;
	metadata?: string;
	createdAt: Date | string;
	updatedAt: Date | string;
}
export interface BnplPersistedOrderWithRemote extends Omit<BnplPersistedOrder, "rawData"> {
	remote?: Omit<BnplOrderState, "raw">;
}
export interface BnplPreCheckInput {
	countryCode: string;
	amount: BnplMoney;
	email?: string;
	phone?: string;
	isVip?: boolean;
}
export interface BnplPreCheckResult {
	available: boolean;
	reason?: string;
	availablePaymentTypes?: Array<{
		paymentType: BnplPaymentType | (string & {});
		instalments?: number;
		descriptionEn?: string;
		descriptionAr?: string;
	}>;
}
export type BnplWebhookEvent =
	| {
			kind: "approved";
			provider: string;
			orderId: string;
			orderReferenceId?: string;
			raw: unknown;
	  }
	| {
			kind: "authorized";
			provider: string;
			orderId: string;
			orderReferenceId?: string;
			raw: unknown;
	  }
	| {
			kind: "declined";
			provider: string;
			orderId: string;
			reason?: string;
			raw: unknown;
	  }
	| {
			kind: "captured";
			provider: string;
			orderId: string;
			captureId: string;
			amountMinor: number;
			currency: BnplCurrency;
			raw: unknown;
	  }
	| {
			kind: "refunded";
			provider: string;
			orderId: string;
			refundId: string;
			amountMinor: number;
			currency: BnplCurrency;
			raw: unknown;
	  }
	| {
			kind: "canceled";
			provider: string;
			orderId: string;
			raw: unknown;
	  }
	| {
			kind: "expired";
			provider: string;
			orderId: string;
			raw: unknown;
	  }
	| {
			kind: "updated";
			provider: string;
			orderId: string;
			raw: unknown;
	  }
	| {
			kind: "unknown";
			provider: string;
			orderId?: string;
			eventType: string;
			raw: unknown;
	  };
export type BnplWebhookEventKind = BnplWebhookEvent["kind"];
export type BnplVerifyWebhookResult =
	| {
			ok: true;
			payload: Record<string, unknown>;
			dedupKey: string;
			rawBody: string;
	  }
	| {
			ok: false;
			reason: string;
	  };
