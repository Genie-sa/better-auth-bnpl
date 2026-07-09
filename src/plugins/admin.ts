import type { GenericEndpointContext, Session, User, Where } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	getSessionFromCtx,
	sessionMiddleware,
} from "better-auth/api";
import { z } from "zod";
import { BNPL_ERROR_CODES, BnplPluginError, BnplProviderError } from "../core/errors";
import { parseAmount } from "../core/money";
import type { BnplProvider } from "../core/provider";
import { absoluteUrlMax1024Schema } from "../core/url";
import type { BnplOptions } from "../plugin-types";
import { buildAuthoriseOrderUpdate } from "./authorise-update";
import { mutateOrder } from "./order-store";
import { assertPersistedOrders } from "./persistence";
import { moneySchema, orderItemSchema } from "./shared";
import { recordSyntheticCaptureEvent, recordSyntheticRefundEvent } from "./webhook-events";
const captureBodySchema = z.object({
	totalAmount: moneySchema,
	shippingAmount: moneySchema.optional(),
	taxAmount: moneySchema.optional(),
	discountAmount: moneySchema.optional(),
	merchantReferenceId: z.string().min(1).optional(),
	items: z.array(orderItemSchema).optional(),
	shippingInfo: z
		.object({
			shippedAt: z.string().optional(),
			shippingCompany: z.string().optional(),
			trackingNumber: z.string().optional(),
			trackingUrl: absoluteUrlMax1024Schema.optional(),
		})
		.optional(),
});
const refundBodySchema = z.object({
	totalAmount: moneySchema,
	comment: z.string().optional(),
	merchantRefundId: z.string().min(1).optional(),
	items: z.array(orderItemSchema).optional(),
});
const cancelBodySchema = z.object({
	totalAmount: moneySchema.optional(),
	shippingAmount: moneySchema.optional(),
	taxAmount: moneySchema.optional(),
	discountAmount: moneySchema.optional(),
	merchantReferenceId: z.string().min(1).optional(),
	items: z.array(orderItemSchema).optional(),
	comment: z.string().optional(),
});
const voidBodySchema = z.object({
	checkoutId: z.string().optional(),
});
const listOrdersQuerySchema = z
	.object({
		provider: z.string().optional(),
		status: z.string().optional(),
		userId: z.string().optional(),
		limit: z.coerce.number().min(1).max(100).optional(),
		offset: z.coerce.number().min(0).optional(),
	})
	.optional();
export type AdminAuthorizer = (args: {
	session: {
		user: User;
		session: Session;
	};
	endpointContext: GenericEndpointContext;
}) => boolean | Promise<boolean>;
export interface AdminSubpluginOptions {
	isAuthorized: AdminAuthorizer;
}
interface OrderRow {
	provider: string;
	providerOrderId: string;
	providerCheckoutId: string;
	currency: string;
	amountMinor: number;
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	status: string;
	version?: number;
}
function adminOrderWhere(row: OrderRow): Where[] {
	return [
		{ field: "provider", value: row.provider },
		{ field: "providerOrderId", value: row.providerOrderId },
	];
}
type AdminFailureCode =
	| "CAPTURE_FAILED"
	| "REFUND_FAILED"
	| "CANCEL_FAILED"
	| "VOID_FAILED"
	| "AUTHORISE_FAILED"
	| "RECONCILE_FAILED"
	| "CLOSE_PAYMENT_FAILED";
type AdminMoneyOperation = "capture" | "refund";
interface AdminMoneyOperationUpdate {
	status: string;
	rawData: string;
	updatedAt: Date;
	capturedAmountMinor?: number;
	capturedAt?: Date;
	refundedAmountMinor?: number;
}
function requireOrderId(ctx: GenericEndpointContext): string {
	const orderId = ctx.params?.orderId;
	if (!orderId) throw new APIError("BAD_REQUEST", { message: "orderId is required" });
	return orderId;
}
function assertOperationCurrency(
	row: OrderRow,
	money: {
		currency: string;
	},
	operation: string,
): void {
	if (row.currency !== money.currency) {
		throw new APIError("BAD_REQUEST", {
			message: `${operation} currency ${money.currency} does not match order currency ${row.currency}`,
			code: "CURRENCY_NOT_SUPPORTED_BY_PROVIDER",
		});
	}
}
function parseOperationAmount(
	money: {
		amount: string;
		currency: string;
	},
	operation: string,
): number {
	try {
		return parseAmount(money);
	} catch (e) {
		throw new APIError("BAD_REQUEST", {
			message: `${operation} amount is invalid: ${e instanceof Error ? e.message : e}`,
			code: "INVALID_AMOUNT",
		});
	}
}
function operationReference(
	row: OrderRow,
	operation: AdminMoneyOperation,
	amountMinor: number,
): string {
	const previousMinor = operation === "capture" ? row.capturedAmountMinor : row.refundedAmountMinor;
	return `bnpl:${row.provider}:${row.providerOrderId}:${operation}:${previousMinor + amountMinor}`;
}
function moneyOperationStatus(
	operation: AdminMoneyOperation,
	cumulativeMinor: number,
	orderAmountMinor: number,
): string {
	if (operation === "capture") {
		return cumulativeMinor >= orderAmountMinor ? "fully_captured" : "partially_captured";
	}
	return cumulativeMinor >= orderAmountMinor ? "fully_refunded" : "partially_refunded";
}
async function persistAdminMoneyOperation(
	ctx: GenericEndpointContext,
	row: OrderRow,
	operation: AdminMoneyOperation,
	amountMinor: number,
	raw: unknown,
): Promise<void> {
	const isCapture = operation === "capture";
	await mutateOrder<OrderRow>(
		ctx,
		() => adminOrderWhere(row),
		(current) => {
			const cumulative =
				(isCapture ? current.capturedAmountMinor : current.refundedAmountMinor) + amountMinor;
			const update: AdminMoneyOperationUpdate = {
				status: moneyOperationStatus(operation, cumulative, current.amountMinor),
				rawData: JSON.stringify(raw),
				updatedAt: new Date(),
			};
			if (isCapture) {
				update.capturedAmountMinor = cumulative;
				update.capturedAt = new Date();
			} else {
				update.refundedAmountMinor = cumulative;
			}
			return { ...update };
		},
	);
}
function throwAdminOperationError(
	ctx: GenericEndpointContext,
	e: unknown,
	operation: string,
	code: AdminFailureCode,
): never {
	if (e instanceof BnplPluginError) {
		throw new APIError("BAD_REQUEST", { message: e.message, code: e.code });
	}
	if (e instanceof BnplProviderError) {
		ctx.context.logger.error(`bnpl: ${operation} failed: ${e.message}`);
		throw new APIError("BAD_GATEWAY", { message: e.message, code });
	}
	throw new APIError("INTERNAL_SERVER_ERROR", {
		message: BNPL_ERROR_CODES[code].message,
		code,
	});
}
export async function assertAdmin(
	isAuthorized: AdminAuthorizer,
	ctx: GenericEndpointContext,
): Promise<{
	user: User;
	session: Session;
}> {
	const session = await getSessionFromCtx(ctx);
	if (!session?.user) {
		throw new APIError("UNAUTHORIZED", {
			message: BNPL_ERROR_CODES.AUTH_REQUIRED.message,
			code: "AUTH_REQUIRED",
		});
	}
	const ok = await isAuthorized({ session, endpointContext: ctx });
	if (!ok) {
		throw new APIError("FORBIDDEN", {
			message: BNPL_ERROR_CODES.ADMIN_FORBIDDEN.message,
			code: "ADMIN_FORBIDDEN",
		});
	}
	return session;
}
async function loadOrder(
	ctx: GenericEndpointContext,
	providers: Record<string, BnplProvider>,
	orderId: string,
): Promise<{
	row: OrderRow;
	provider: BnplProvider;
}> {
	const row = await ctx.context.adapter.findOne<OrderRow>({
		model: "bnplOrder",
		where: [{ field: "providerOrderId", value: orderId }],
	});
	if (!row) {
		throw new APIError("NOT_FOUND", {
			message: BNPL_ERROR_CODES.ORDER_NOT_FOUND.message,
			code: "ORDER_NOT_FOUND",
		});
	}
	const provider = providers[row.provider];
	if (!provider) {
		throw new APIError("BAD_REQUEST", {
			message: `${BNPL_ERROR_CODES.PROVIDER_NOT_CONFIGURED.message}: \`${row.provider}\``,
			code: "PROVIDER_NOT_CONFIGURED",
		});
	}
	return { row, provider };
}
async function loadAdminOrder(
	adminOptions: AdminSubpluginOptions,
	options: BnplOptions,
	ctx: GenericEndpointContext,
	providers: Record<string, BnplProvider>,
): Promise<{
	orderId: string;
	row: OrderRow;
	provider: BnplProvider;
}> {
	await assertAdmin(adminOptions.isAuthorized, ctx);
	const orderId = requireOrderId(ctx);
	assertPersistedOrders(options);
	const { row, provider } = await loadOrder(ctx, providers, orderId);
	return { orderId, row, provider };
}
export const admin = (adminOptions: AdminSubpluginOptions) => {
	if (typeof adminOptions?.isAuthorized !== "function") {
		throw new Error(BNPL_ERROR_CODES.ADMIN_AUTHORIZATION_REQUIRED.message);
	}
	return (providers: Record<string, BnplProvider>, options: BnplOptions) => ({
		bnplAdminListOrders: createAuthEndpoint(
			"/bnpl/admin/orders",
			{ method: "GET", query: listOrdersQuerySchema, use: [sessionMiddleware] },
			async (ctx) => {
				await assertAdmin(adminOptions.isAuthorized, ctx);
				assertPersistedOrders(options);
				const where: Where[] = [];
				if (ctx.query?.provider) where.push({ field: "provider", value: ctx.query.provider });
				if (ctx.query?.status) where.push({ field: "status", value: ctx.query.status });
				if (ctx.query?.userId) where.push({ field: "userId", value: ctx.query.userId });
				const orders = await ctx.context.adapter.findMany({
					model: "bnplOrder",
					where: where.length > 0 ? where : undefined,
					limit: ctx.query?.limit ?? 20,
					offset: ctx.query?.offset ?? 0,
					sortBy: { field: "createdAt", direction: "desc" },
				});
				return ctx.json({ orders });
			},
		),
		bnplAdminCapture: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/capture",
			{ method: "POST", body: captureBodySchema, use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, row } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				assertOperationCurrency(row, ctx.body.totalAmount, "capture");
				const amountMinor = parseOperationAmount(ctx.body.totalAmount, "capture");
				const merchantReferenceId =
					ctx.body.merchantReferenceId ?? operationReference(row, "capture", amountMinor);
				try {
					const result = await provider.capture(
						orderId,
						{
							totalAmount: ctx.body.totalAmount,
							shippingAmount: ctx.body.shippingAmount,
							taxAmount: ctx.body.taxAmount,
							discountAmount: ctx.body.discountAmount,
							merchantReferenceId,
							shippingInfo: ctx.body.shippingInfo,
							items: ctx.body.items,
						},
						{ logger: ctx.context.logger },
					);
					await persistAdminMoneyOperation(ctx, row, "capture", amountMinor, result.raw);
					await recordSyntheticCaptureEvent(ctx, provider, orderId, row.currency, result);
					return ctx.json(result);
				} catch (e) {
					throwAdminOperationError(ctx, e, "capture", "CAPTURE_FAILED");
				}
			},
		),
		bnplAdminRefund: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/refund",
			{ method: "POST", body: refundBodySchema, use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, row } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				assertOperationCurrency(row, ctx.body.totalAmount, "refund");
				const amountMinor = parseOperationAmount(ctx.body.totalAmount, "refund");
				const merchantRefundId =
					ctx.body.merchantRefundId ?? operationReference(row, "refund", amountMinor);
				try {
					const result = await provider.refund(
						orderId,
						{
							totalAmount: ctx.body.totalAmount,
							items: ctx.body.items,
							comment: ctx.body.comment,
							merchantRefundId,
						},
						{ logger: ctx.context.logger },
					);
					await persistAdminMoneyOperation(ctx, row, "refund", amountMinor, result.raw);
					await recordSyntheticRefundEvent(ctx, provider, orderId, row.currency, result);
					return ctx.json(result);
				} catch (e) {
					throwAdminOperationError(ctx, e, "refund", "REFUND_FAILED");
				}
			},
		),
		bnplAdminCancel: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/cancel",
			{ method: "POST", body: cancelBodySchema, use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, row } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				if (ctx.body.totalAmount) {
					assertOperationCurrency(row, ctx.body.totalAmount, "cancel");
				}
				try {
					await provider.cancel(
						orderId,
						{
							totalAmount: ctx.body.totalAmount,
							shippingAmount: ctx.body.shippingAmount,
							taxAmount: ctx.body.taxAmount,
							discountAmount: ctx.body.discountAmount,
							merchantReferenceId: ctx.body.merchantReferenceId,
							items: ctx.body.items,
							comment: ctx.body.comment,
						},
						{ logger: ctx.context.logger },
					);
					await mutateOrder<OrderRow>(
						ctx,
						() => adminOrderWhere(row),
						() => ({
							status: "canceled",
							canceledAt: new Date(),
							updatedAt: new Date(),
						}),
					);
					return ctx.json({ orderId, status: "canceled" });
				} catch (e) {
					throwAdminOperationError(ctx, e, "cancel", "CANCEL_FAILED");
				}
			},
		),
		bnplAdminAuthorise: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/authorise",
			{ method: "POST", use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, row } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				if (!provider.authorize || !provider.capabilities.separateAuthorise) {
					throw new APIError("BAD_REQUEST", {
						message: `${BNPL_ERROR_CODES.OPERATION_NOT_SUPPORTED.message}: ${provider.id} does not require a separate authorise call`,
						code: "OPERATION_NOT_SUPPORTED",
					});
				}
				try {
					const result = await provider.authorize(orderId, { logger: ctx.context.logger });
					let capturedAmountMinor: number | undefined;
					await mutateOrder<OrderRow>(
						ctx,
						() => adminOrderWhere(row),
						(current) => {
							const built = buildAuthoriseOrderUpdate(result, {
								amountMinor: current.amountMinor,
								capturedAmountMinor: current.capturedAmountMinor,
							});
							capturedAmountMinor = built.capturedAmountMinor;
							return { ...built.update };
						},
					);
					if (result.captureId && capturedAmountMinor !== undefined) {
						await recordSyntheticCaptureEvent(ctx, provider, orderId, row.currency, {
							captureId: result.captureId,
							amountMinor: capturedAmountMinor,
							raw: result.raw,
						});
					}
					return ctx.json(result);
				} catch (e) {
					if (e instanceof BnplProviderError) {
						if (e.isAlreadyInTargetState) {
							await mutateOrder<OrderRow>(
								ctx,
								() => adminOrderWhere(row),
								() => ({
									status: "authorised",
									authorisedAt: new Date(),
									updatedAt: new Date(),
								}),
							);
							return ctx.json({ orderId, status: "authorised", already: true });
						}
					}
					throwAdminOperationError(ctx, e, "authorise", "AUTHORISE_FAILED");
				}
			},
		),
		bnplAdminReconcile: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/reconcile",
			{ method: "POST", use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, row } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				try {
					const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
					await mutateOrder<OrderRow>(
						ctx,
						() => adminOrderWhere(row),
						(current) => ({
							status: remote.status,
							capturedAmountMinor: remote.capturedAmountMinor ?? current.capturedAmountMinor,
							refundedAmountMinor: remote.refundedAmountMinor ?? current.refundedAmountMinor,
							rawData: JSON.stringify(remote.raw),
							updatedAt: new Date(),
						}),
					);
					return ctx.json({ synced: true, order: remote });
				} catch (e) {
					throwAdminOperationError(ctx, e, "reconcile", "RECONCILE_FAILED");
				}
			},
		),
		bnplAdminVoidCheckout: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/void",
			{ method: "POST", body: voidBodySchema, use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, row } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				if (!provider.voidCheckout || !provider.capabilities.voidCheckout) {
					throw new APIError("BAD_REQUEST", {
						message: `${BNPL_ERROR_CODES.OPERATION_NOT_SUPPORTED.message}: ${provider.id} does not support void`,
						code: "OPERATION_NOT_SUPPORTED",
					});
				}
				const checkoutId = ctx.body.checkoutId ?? row.providerCheckoutId;
				if (!checkoutId) {
					throw new APIError("BAD_REQUEST", {
						message: "checkoutId is required because this order has no providerCheckoutId",
					});
				}
				try {
					await provider.voidCheckout(checkoutId, orderId, { logger: ctx.context.logger });
					return ctx.json({ orderId, voided: true });
				} catch (e) {
					throwAdminOperationError(ctx, e, "void", "VOID_FAILED");
				}
			},
		),
		bnplAdminClosePayment: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/close",
			{ method: "POST", use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, row } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				if (!provider.closePayment || !provider.capabilities.closePayment) {
					throw new APIError("BAD_REQUEST", {
						message: `${BNPL_ERROR_CODES.OPERATION_NOT_SUPPORTED.message}: ${provider.id} does not support close`,
						code: "OPERATION_NOT_SUPPORTED",
					});
				}
				try {
					await provider.closePayment(orderId, { logger: ctx.context.logger });
					await mutateOrder<OrderRow>(
						ctx,
						() => adminOrderWhere(row),
						() => ({
							status: "closed",
							updatedAt: new Date(),
						}),
					);
					return ctx.json({ orderId, closed: true });
				} catch (e) {
					throwAdminOperationError(ctx, e, "close-payment", "CLOSE_PAYMENT_FAILED");
				}
			},
		),
	});
};
