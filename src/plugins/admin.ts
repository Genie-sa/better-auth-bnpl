import type { GenericEndpointContext, Session, User, Where } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	getSessionFromCtx,
	sessionMiddleware,
} from "better-auth/api";
import { z } from "zod";
import { BNPL_ERROR_CODES, BnplPluginError, BnplProviderError } from "../core/errors";
import { isBnplCurrency, parseAmount } from "../core/money";
import type { BnplProvider } from "../core/provider";
import { canTransition, deriveCapturedStatus, deriveRefundedStatus } from "../core/status";
import type { BnplWebhookEvent } from "../core/types";
import { absoluteUrlMax1024Schema } from "../core/url";
import type { BnplOptions } from "../plugin-types";
import { buildAuthoriseOrderUpdate } from "./authorise-update";
import {
	type MoneyCommandReservation,
	completeMoneyCommand,
	isAuthorisedState,
	recoverLocalAuthoriseCommand,
	reserveMoneyCommand,
} from "./money-command";
import type { MoneyOperation } from "./operation-reference";
import { mutateOrder, readAppliedOperations } from "./order-store";
import { assertPersistedOrders } from "./persistence";
import { publicOrder } from "./public-order";
import { readRemoteHistory } from "./remote-history";
import { moneySchema, orderItemSchema } from "./shared";
import { recordSyntheticCaptureEvent, recordSyntheticRefundEvent } from "./webhook-events";
const captureBodySchema = z.object({
	totalAmount: moneySchema,
	shippingAmount: moneySchema.optional(),
	taxAmount: moneySchema.optional(),
	discountAmount: moneySchema.optional(),
	merchantReferenceId: z.string().min(1),
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
	merchantRefundId: z.string().min(1),
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
		limit: z.coerce.number().int().min(1).max(100).optional(),
		offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
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
	moneyCommands?: string | null;
	id?: string;
	appliedOperations?: string | null;
	webhookTransitions?: string | null;
	canceledAmountMinor?: number;
	rawData?: string | null;
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
		const amount = parseAmount(money);
		if (amount <= 0) throw new Error("amount must be positive");
		return amount;
	} catch (e) {
		throw new APIError("BAD_REQUEST", {
			message: `${operation} amount is invalid: ${e instanceof Error ? e.message : e}`,
			code: "INVALID_AMOUNT",
		});
	}
}
function operationKey(
	provider: BnplProvider,
	row: OrderRow,
	operation: MoneyOperation,
	id: string,
	amountMinor: number,
): string {
	if (!isBnplCurrency(row.currency)) throw new Error("bnpl: invalid persisted currency");
	const common = {
		provider: provider.id,
		orderId: row.providerOrderId,
		amountMinor,
		currency: row.currency,
		raw: null,
	};
	const event: BnplWebhookEvent =
		operation === "capture"
			? { ...common, kind: "captured", captureId: id }
			: { ...common, kind: "refunded", refundId: id };
	return provider.webhookDedupKey?.(event) ?? `${provider.id}:${event.kind}:${id}`;
}
async function persistAdminMoneyOperation(
	ctx: GenericEndpointContext,
	row: OrderRow,
	provider: BnplProvider,
	operation: MoneyOperation,
	result: { providerOrderId: string; amountMinor: number; raw: unknown },
	id: string,
	requestedMinor: number,
	command: MoneyCommandReservation,
): Promise<void> {
	if (
		result.providerOrderId !== row.providerOrderId ||
		!id ||
		result.amountMinor !== requestedMinor ||
		!Number.isSafeInteger(result.amountMinor)
	) {
		throw new BnplProviderError(provider.id, "Provider returned an inconsistent money operation");
	}
	const isCapture = operation === "capture";
	await mutateOrder<OrderRow>(
		ctx,
		() => adminOrderWhere(row),
		(current) => {
			const moneyCommands = completeMoneyCommand(current.moneyCommands, command, result);
			const operations = readAppliedOperations(current.appliedOperations);
			const key = operationKey(provider, row, operation, id, result.amountMinor);
			if (operations.includes(key)) return { moneyCommands, updatedAt: new Date() };
			const captured = current.capturedAmountMinor + (isCapture ? result.amountMinor : 0);
			const refunded = current.refundedAmountMinor + (isCapture ? 0 : result.amountMinor);
			if (
				!Number.isSafeInteger(captured) ||
				!Number.isSafeInteger(refunded) ||
				captured > current.amountMinor - (current.canceledAmountMinor ?? 0) ||
				refunded > captured
			) {
				throw new Error("bnpl: operation would exceed the order's financial balance");
			}
			const status =
				refunded > 0
					? deriveRefundedStatus({ totalAmountMinor: captured, cumulativeMinor: refunded })
					: deriveCapturedStatus({
							totalAmountMinor: current.amountMinor - (current.canceledAmountMinor ?? 0),
							cumulativeMinor: captured,
						});
			return {
				moneyCommands,
				appliedOperations: JSON.stringify([...operations, key]),
				status: current.status === "closed" && refunded === 0 ? "closed" : status,
				capturedAmountMinor: captured,
				refundedAmountMinor: refunded,
				...(isCapture ? { capturedAt: new Date() } : {}),
				rawData: JSON.stringify(result.raw),
				updatedAt: new Date(),
			};
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
	const matches = await ctx.context.adapter.findMany<OrderRow>({
		model: "bnplOrder",
		where: [{ field: "providerOrderId", value: orderId }],
		limit: 2,
	});
	if (matches.length > 1)
		throw new APIError("CONFLICT", {
			message: "Order ID matches multiple provider orders",
		});
	const row = matches[0];
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
				const orders = await ctx.context.adapter.findMany<OrderRow>({
					model: "bnplOrder",
					where: where.length > 0 ? where : undefined,
					limit: ctx.query?.limit ?? 20,
					offset: ctx.query?.offset ?? 0,
					sortBy: { field: "createdAt", direction: "desc" },
				});
				return ctx.json({ orders: orders.map(publicOrder) });
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
				const merchantReferenceId = ctx.body.merchantReferenceId;
				const reservation = await reserveMoneyCommand<OrderRow>(
					ctx,
					() => adminOrderWhere(row),
					"capture",
					merchantReferenceId,
					ctx.body,
					(current) => {
						if (
							["closed", "canceled", "expired", "declined", "fully_refunded"].includes(
								current.status,
							)
						)
							throw new APIError("BAD_REQUEST", {
								message: "This order no longer accepts captures",
								code: "INVALID_AMOUNT",
							});

						if (
							amountMinor >
							current.amountMinor - (current.canceledAmountMinor ?? 0) - current.capturedAmountMinor
						)
							throw new APIError("BAD_REQUEST", {
								message: "Capture amount exceeds the remaining order balance",
								code: "INVALID_AMOUNT",
							});
					},
				);
				if (reservation.kind === "completed") return ctx.json(reservation.result);
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
					await persistAdminMoneyOperation(
						ctx,
						row,
						provider,
						"capture",
						result,
						result.captureId,
						amountMinor,
						reservation.command,
					);
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
				const merchantRefundId = ctx.body.merchantRefundId;
				const reservation = await reserveMoneyCommand<OrderRow>(
					ctx,
					() => adminOrderWhere(row),
					"refund",
					merchantRefundId,
					ctx.body,
					(current) => {
						if (amountMinor > current.capturedAmountMinor - current.refundedAmountMinor)
							throw new APIError("BAD_REQUEST", {
								message: "Refund amount exceeds the captured balance available for refund",
								code: "INVALID_AMOUNT",
							});
					},
				);
				if (reservation.kind === "completed") return ctx.json(reservation.result);
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
					await persistAdminMoneyOperation(
						ctx,
						row,
						provider,
						"refund",
						result,
						result.refundId,
						amountMinor,
						reservation.command,
					);
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
				const amountMinor = ctx.body.totalAmount
					? parseOperationAmount(ctx.body.totalAmount, "cancel")
					: undefined;
				if (ctx.body.totalAmount) {
					assertOperationCurrency(row, ctx.body.totalAmount, "cancel");
					if (!ctx.body.merchantReferenceId)
						throw new APIError("BAD_REQUEST", {
							message: "Amount-bearing cancellation requires merchantReferenceId",
							code: "INVALID_CANCEL_REFERENCE",
						});
				}
				let verifyExistingClosure = false;
				const reservation = await reserveMoneyCommand<OrderRow>(
					ctx,
					() => adminOrderWhere(row),
					"cancel",
					ctx.body.merchantReferenceId ?? orderId,
					ctx.body,
					(current) => {
						verifyExistingClosure =
							provider.id === "tabby" &&
							amountMinor === undefined &&
							[
								"closed",
								"canceled",
								"fully_captured",
								"partially_refunded",
								"fully_refunded",
							].includes(current.status);
						if (
							amountMinor !== undefined &&
							amountMinor + current.capturedAmountMinor + (current.canceledAmountMinor ?? 0) >
								current.amountMinor
						)
							throw new APIError("BAD_REQUEST", {
								message: "Cancellation exceeds remaining order balance",
							});
					},
					true,
				);
				if (reservation.kind === "completed") return ctx.json(reservation.result);
				const finish = async (
					status: Awaited<ReturnType<typeof provider.fetchOrder>>["status"],
					cancelId?: string,
					confirmedAmount?: number,
					remote?: Awaited<ReturnType<typeof provider.fetchOrder>>,
				) => {
					const response = { orderId, status };
					await mutateOrder<OrderRow>(
						ctx,
						() => adminOrderWhere(row),
						(current) => {
							const update: Record<string, unknown> = {
								moneyCommands: completeMoneyCommand(
									current.moneyCommands,
									reservation.command,
									response,
								),
								updatedAt: new Date(),
							};
							if (canTransition(current.status, status)) {
								update.status = status;
								if (status === "canceled") update.canceledAt = new Date();
							}
							if (remote) {
								if (
									amountMinor === undefined &&
									(remote.capturedAmountMinor < current.capturedAmountMinor ||
										remote.refundedAmountMinor < current.refundedAmountMinor ||
										(remote.canceledAmountMinor ?? 0) < (current.canceledAmountMinor ?? 0))
								)
									throw new Error("bnpl: remote closure snapshot predates local financial state");
								const history = readRemoteHistory(provider, current, remote);
								Object.assign(update, {
									capturedAmountMinor: history.captured,
									refundedAmountMinor: history.refunded,
									canceledAmountMinor: history.canceled,
									appliedOperations: JSON.stringify(history.keys),
								});
							} else if (cancelId && confirmedAmount !== undefined) {
								const operations = readAppliedOperations(current.appliedOperations);
								const key = `${provider.id}:cancel:${cancelId}`;
								if (!operations.includes(key)) {
									const canceled = (current.canceledAmountMinor ?? 0) + confirmedAmount;
									if (
										!Number.isSafeInteger(canceled) ||
										canceled + current.capturedAmountMinor > current.amountMinor
									)
										throw new Error("bnpl: cancellation exceeds the remaining order balance");
									update.canceledAmountMinor = canceled;
									update.appliedOperations = JSON.stringify([...operations, key]);
								}
							}
							return update;
						},
					);
					return ctx.json(response);
				};
				const recover = async () => {
					const before = reservation.command.before;
					if (!before) throw new Error("bnpl: cancellation reservation lacks recovery evidence");
					const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
					readRemoteHistory(provider, { ...row, ...before }, remote);
					if (amountMinor !== undefined) {
						const prior = new Set(readAppliedOperations(before.appliedOperations));
						const unseen = (remote.operations ?? []).filter(
							(operation) =>
								operation.kind === "canceled" &&
								!prior.has(`${provider.id}:cancel:${operation.id}`),
						);
						if (
							remote.capturedAmountMinor !== before.capturedAmountMinor ||
							remote.refundedAmountMinor !== before.refundedAmountMinor ||
							(remote.canceledAmountMinor ?? 0) !== before.canceledAmountMinor + amountMinor ||
							unseen.length !== 1 ||
							unseen[0]?.amountMinor !== amountMinor
						)
							throw new Error("bnpl: cancellation outcome is not uniquely proven");
					} else {
						const raw = remote.raw as { status?: unknown } | null;
						if (provider.id === "tabby" ? raw?.status !== "CLOSED" : remote.status !== "canceled")
							throw new Error("bnpl: remote order does not confirm cancellation or closure");
					}
					return finish(remote.status, undefined, undefined, remote);
				};
				if (reservation.kind === "pending" || verifyExistingClosure) {
					try {
						return await recover();
					} catch {
						throw new APIError("CONFLICT", {
							message: "Cancellation outcome is uncertain; verify native history before retrying",
							code: "MONEY_COMMAND_CONFLICT",
						});
					}
				}
				try {
					const result = await provider.cancel(
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
					if (result && result.providerOrderId !== orderId)
						throw new Error("bnpl: cancel order identity mismatch");
					if (amountMinor === undefined || !result?.cancelId || result.amountMinor === undefined)
						return await recover();
					if (
						!Number.isSafeInteger(result.amountMinor) ||
						result.amountMinor <= 0 ||
						result.amountMinor !== amountMinor
					)
						throw new Error("bnpl: inconsistent cancellation amount");
					if (
						readAppliedOperations(reservation.command.before?.appliedOperations).includes(
							`${provider.id}:cancel:${result.cancelId}`,
						)
					)
						throw new Error(
							"bnpl: cancellation response repeats an operation predating this command",
						);
					return await finish(result.status, result.cancelId, result.amountMinor);
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
				const reservation = await reserveMoneyCommand<OrderRow>(
					ctx,
					() => adminOrderWhere(row),
					"authorise",
					orderId,
					{},
					undefined,
					true,
				);
				if (reservation.kind === "completed") return ctx.json(reservation.result);
				const recoveryRequested = reservation.kind === "pending" || isAuthorisedState(row.status);
				try {
					const local = await recoverLocalAuthoriseCommand<OrderRow>(
						ctx,
						() => adminOrderWhere(row),
						reservation.command,
						orderId,
					);
					if (local) return ctx.json(local);
					if (recoveryRequested)
						throw new Error("bnpl: authorisation outcome is uncertain; verifying remote state");
					const result = await provider.authorize(orderId, { logger: ctx.context.logger });
					if (result.providerOrderId !== orderId)
						throw new Error("bnpl: authorisation order identity mismatch");
					let capturedAmountMinor: number | undefined;
					await mutateOrder<OrderRow>(
						ctx,
						() => adminOrderWhere(row),
						(current) => {
							const built = buildAuthoriseOrderUpdate(result, {
								amountMinor: current.amountMinor,
								canceledAmountMinor: current.canceledAmountMinor,
								status: current.status,
								capturedAmountMinor: current.capturedAmountMinor,
							});
							capturedAmountMinor = built.capturedAmountMinor;
							if (
								capturedAmountMinor !== undefined &&
								(!Number.isSafeInteger(capturedAmountMinor) ||
									capturedAmountMinor < 0 ||
									capturedAmountMinor > current.amountMinor - (current.canceledAmountMinor ?? 0))
							)
								throw new Error("bnpl: invalid authorised capture amount");
							const keys = readAppliedOperations(current.appliedOperations);
							if (result.captureId && capturedAmountMinor !== undefined)
								keys.push(
									operationKey(provider, current, "capture", result.captureId, capturedAmountMinor),
								);
							return {
								...built.update,
								appliedOperations: JSON.stringify([...new Set(keys)]),
								moneyCommands: completeMoneyCommand(
									current.moneyCommands,
									reservation.command,
									result as unknown as Record<string, unknown>,
								),
							};
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
					if (recoveryRequested || (e instanceof BnplProviderError && e.isAlreadyInTargetState)) {
						const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
						if (remote.providerOrderId === orderId && isAuthorisedState(remote.status)) {
							await mutateOrder<OrderRow>(
								ctx,
								() => adminOrderWhere(row),
								(current) => {
									const { keys, captured, refunded, canceled } = readRemoteHistory(
										provider,
										current,
										remote,
									);
									const candidate =
										refunded > 0
											? deriveRefundedStatus({
													totalAmountMinor: captured,
													cumulativeMinor: refunded,
												})
											: remote.status;
									return {
										status: canTransition(current.status, candidate) ? candidate : current.status,
										capturedAmountMinor: captured,
										refundedAmountMinor: refunded,
										canceledAmountMinor: canceled,
										appliedOperations: JSON.stringify([...new Set(keys)]),
										moneyCommands: completeMoneyCommand(
											current.moneyCommands,
											reservation.command,
											{ orderId, status: remote.status, already: true },
										),
										authorisedAt: new Date(),
										updatedAt: new Date(),
									};
								},
							);
							return ctx.json({ orderId, status: remote.status, already: true });
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
					// Capture the version before the remote read: a newer local write makes this snapshot stale.
					const readVersion = row.version ?? 0;
					const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
					if (
						remote.providerOrderId !== orderId ||
						remote.totalAmount.currency !== row.currency ||
						parseAmount(remote.totalAmount) !== row.amountMinor
					)
						throw new Error("bnpl: reconciliation identity or total mismatch");
					await mutateOrder<OrderRow>(
						ctx,
						() => adminOrderWhere(row),
						(current) => {
							if (
								(current.version ?? 0) !== readVersion ||
								remote.capturedAmountMinor < current.capturedAmountMinor ||
								remote.refundedAmountMinor < current.refundedAmountMinor ||
								(remote.canceledAmountMinor ?? current.canceledAmountMinor ?? 0) <
									(current.canceledAmountMinor ?? 0)
							)
								throw new Error("bnpl: reconciliation snapshot is stale; retry reconciliation");
							const { keys, captured, refunded, canceled } = readRemoteHistory(
								provider,
								current,
								remote,
							);
							return {
								status: canTransition(current.status, remote.status)
									? remote.status
									: current.status,
								capturedAmountMinor: captured,
								refundedAmountMinor: refunded,
								canceledAmountMinor: canceled,
								appliedOperations: JSON.stringify([...new Set(keys)]),
								rawData: JSON.stringify(remote.raw),
								updatedAt: new Date(),
							};
						},
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
				if (row.providerCheckoutId && checkoutId !== row.providerCheckoutId)
					throw new APIError("BAD_REQUEST", {
						message: "checkoutId does not match the persisted order checkout",
					});
				if (!checkoutId) {
					throw new APIError("BAD_REQUEST", {
						message: "checkoutId is required because this order has no providerCheckoutId",
					});
				}
				const reservation = await reserveMoneyCommand<OrderRow>(
					ctx,
					() => adminOrderWhere(row),
					"void",
					orderId,
					{ checkoutId },
					undefined,
					true,
				);
				if (reservation.kind === "completed") return ctx.json(reservation.result);
				let confirmedCapturedAmountMinor: number | undefined;
				try {
					if (reservation.kind === "reserved") {
						const result = await provider.voidCheckout(checkoutId, orderId, {
							logger: ctx.context.logger,
						});
						if (
							result &&
							(typeof result.voided !== "boolean" ||
								(result.capturedCurrency !== undefined &&
									result.capturedCurrency !== row.currency) ||
								(result.capturedAmountMinor !== undefined &&
									(!Number.isSafeInteger(result.capturedAmountMinor) ||
										result.capturedAmountMinor < 0 ||
										result.capturedAmountMinor > row.amountMinor)))
						)
							throw new Error("bnpl: invalid provider void response");
						if (result?.voided === true && result.capturedCurrency === row.currency)
							confirmedCapturedAmountMinor = result.capturedAmountMinor;
						if (result?.voided === false) {
							const response = {
								orderId,
								voided: false,
								capturedAmountMinor: result.capturedAmountMinor,
							};
							await mutateOrder<OrderRow>(
								ctx,
								() => adminOrderWhere(row),
								(current) => ({
									moneyCommands: completeMoneyCommand(
										current.moneyCommands,
										reservation.command,
										response,
									),
									updatedAt: new Date(),
								}),
							);
							return ctx.json(response);
						}
					}
					const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
					const response = {
						orderId,
						voided: true,
						capturedAmountMinor: remote.capturedAmountMinor,
					};
					await mutateOrder<OrderRow>(
						ctx,
						() => adminOrderWhere(row),
						(current) => {
							if (
								remote.capturedAmountMinor < current.capturedAmountMinor ||
								remote.refundedAmountMinor < current.refundedAmountMinor ||
								(remote.canceledAmountMinor ?? 0) < (current.canceledAmountMinor ?? 0)
							)
								throw new APIError("CONFLICT", {
									message: "Void verification snapshot is older than current financial state",
									code: "MONEY_COMMAND_CONFLICT",
								});
							const { captured, refunded, canceled, keys } = readRemoteHistory(
								provider,
								current,
								remote,
							);
							const knownPaidVoid =
								confirmedCapturedAmountMinor !== undefined && confirmedCapturedAmountMinor > 0;
							if (
								knownPaidVoid
									? captured !== confirmedCapturedAmountMinor
									: !["expired", "canceled"].includes(remote.status) ||
										captured !== 0 ||
										refunded !== 0
							)
								throw new APIError("CONFLICT", {
									code: "MONEY_COMMAND_CONFLICT",
									message: "Void outcome is uncertain; verify the checkout before retrying",
								});
							const candidate =
								refunded > 0
									? deriveRefundedStatus({ totalAmountMinor: captured, cumulativeMinor: refunded })
									: remote.status;
							return {
								status: canTransition(current.status, candidate) ? candidate : current.status,
								capturedAmountMinor: captured,
								refundedAmountMinor: refunded,
								canceledAmountMinor: canceled,
								appliedOperations: JSON.stringify(keys),
								moneyCommands: completeMoneyCommand(
									current.moneyCommands,
									reservation.command,
									response,
								),
								updatedAt: new Date(),
							};
						},
					);
					return ctx.json(response);
				} catch (e) {
					if (e instanceof APIError) throw e;
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
				let verifyOnly = false;
				const reservation = await reserveMoneyCommand<OrderRow>(
					ctx,
					() => adminOrderWhere(row),
					"close",
					orderId,
					{},
					(current) => {
						verifyOnly = [
							"closed",
							"canceled",
							"fully_captured",
							"partially_refunded",
							"fully_refunded",
						].includes(current.status);
					},
					true,
				);
				if (reservation.kind === "completed") return ctx.json(reservation.result);
				try {
					if (reservation.kind === "reserved" && !verifyOnly)
						await provider.closePayment(orderId, { logger: ctx.context.logger });
					const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
					const response = { orderId, closed: true };
					await mutateOrder<OrderRow>(
						ctx,
						() => adminOrderWhere(row),
						(current) => {
							if (
								remote.capturedAmountMinor < current.capturedAmountMinor ||
								remote.refundedAmountMinor < current.refundedAmountMinor ||
								(remote.canceledAmountMinor ?? 0) < (current.canceledAmountMinor ?? 0)
							)
								throw new APIError("CONFLICT", {
									message: "Close verification snapshot is older than current financial state",
									code: "MONEY_COMMAND_CONFLICT",
								});
							const { captured, refunded, canceled, keys } = readRemoteHistory(
								provider,
								current,
								remote,
							);
							const rawClosed =
								remote.raw !== null &&
								typeof remote.raw === "object" &&
								"status" in remote.raw &&
								remote.raw.status === "CLOSED";
							if (
								remote.status !== "closed" &&
								!(
									rawClosed &&
									["fully_captured", "partially_refunded", "fully_refunded", "canceled"].includes(
										remote.status,
									)
								)
							)
								throw new APIError("CONFLICT", {
									code: "MONEY_COMMAND_CONFLICT",
									message: "Close outcome is uncertain; verify payment closure before retrying",
								});
							const candidate =
								refunded > 0
									? deriveRefundedStatus({ totalAmountMinor: captured, cumulativeMinor: refunded })
									: remote.status;
							return {
								status: canTransition(current.status, candidate) ? candidate : current.status,
								capturedAmountMinor: captured,
								refundedAmountMinor: refunded,
								canceledAmountMinor: canceled,
								appliedOperations: JSON.stringify(keys),
								moneyCommands: completeMoneyCommand(
									current.moneyCommands,
									reservation.command,
									response,
								),
								updatedAt: new Date(),
							};
						},
					);
					return ctx.json(response);
				} catch (e) {
					if (e instanceof APIError) throw e;
					throwAdminOperationError(ctx, e, "close-payment", "CLOSE_PAYMENT_FAILED");
				}
			},
		),
	});
};
