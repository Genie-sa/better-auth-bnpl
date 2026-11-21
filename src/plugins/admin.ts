import type { GenericEndpointContext, Session, User, Where } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	getSessionFromCtx,
	sessionMiddleware,
} from "better-auth/api";
import { z } from "zod";
import { BNPL_ERROR_CODES, BnplPluginError, BnplProviderError } from "../core/errors";
import { type BnplCurrency, parseAmount } from "../core/money";
import type { BnplProvider } from "../core/provider";
import { isAuthorisedState, statusFromBalances } from "../core/status";
import type { BnplMoneyOperation, BnplOrderState } from "../core/types";
import { absoluteUrlMax1024Schema } from "../core/url";
import type { BnplOptions } from "../plugin-types";
import {
	type MoneyCommand,
	type MoneyCommandSpec,
	reportsAlreadyCanceled,
	reportsAlreadyClosed,
	reportsAuthorisedState,
	runMoneyCommand,
	settlePendingMoneyOperation,
} from "./money-command";
import {
	type OrderRecord,
	acceptsCaptures,
	applyAuthorisation,
	applyCancellation,
	applyMoneyOperations,
	attributePendingOperations,
	cancellationKey,
	capturableMinor,
	hasNothingLeftToClose,
	importSnapshot,
	isSettled,
	nextStatus,
	orderWhere,
	readRemoteHistory,
	refundableMinor,
	snapshotIsBehind,
} from "./order";
import { mutateOrder, readAppliedOperations } from "./order-store";
import { assertPersistedOrders } from "./persistence";
import { publicOrder } from "./public-order";
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
	row: OrderRecord,
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
function verificationConflict(message: string): APIError {
	return new APIError("CONFLICT", { message, code: "MONEY_COMMAND_CONFLICT" });
}
/** A pending command stays pending whenever its native evidence cannot be read or trusted. */
async function verifyPending<Result>(verify: () => Promise<Result>): Promise<Result> {
	try {
		return await verify();
	} catch (e) {
		if (e instanceof APIError) throw e;
		throw verificationConflict(
			"Money command outcome is uncertain; verify native history before retrying",
		);
	}
}
/** Closure is proven by an explicit closed status or by a closed payment that settled its balance. */
function confirmsClosure(remote: BnplOrderState): boolean {
	return remote.status === "closed" || (remote.closed === true && isSettled(remote.status));
}
/** Records every native operation a confirmed capture or refund created, checked against the request. */
async function settleMoneyOperation<
	Result extends {
		providerOrderId: string;
		amountMinor: number;
		operations?: BnplMoneyOperation[];
		raw: unknown;
	},
>(
	command: MoneyCommand<unknown>,
	provider: BnplProvider,
	row: OrderRecord,
	kind: "captured" | "refunded",
	result: Result,
	id: string,
	requestedMinor: number,
): Promise<{ response: Result; operations: BnplMoneyOperation[] }> {
	const operations = result.operations ?? [
		{ id, kind, amountMinor: result.amountMinor, currency: row.currency as BnplCurrency },
	];
	if (
		result.providerOrderId !== row.providerOrderId ||
		!id ||
		result.amountMinor !== requestedMinor ||
		!operations.some((operation) => operation.id === id) ||
		new Set(operations.map((operation) => operation.id)).size !== operations.length ||
		operations.some(
			(operation) =>
				!operation.id ||
				operation.kind !== kind ||
				operation.currency !== row.currency ||
				!Number.isSafeInteger(operation.amountMinor) ||
				operation.amountMinor <= 0,
		) ||
		operations.reduce((sum, operation) => sum + operation.amountMinor, 0) !== requestedMinor
	) {
		throw new BnplProviderError(provider.id, "Provider returned an inconsistent money operation");
	}
	const response = await command.settle((order) => {
		const applied = applyMoneyOperations(order, provider, kind, operations);
		return {
			response: result,
			patch: applied ? { ...applied, rawData: JSON.stringify(result.raw) } : undefined,
		};
	});
	return { response, operations };
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
	row: OrderRecord;
	provider: BnplProvider;
}> {
	const matches = await ctx.context.adapter.findMany<OrderRecord>({
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
	row: OrderRecord;
	provider: BnplProvider;
	where: () => Where[];
}> {
	await assertAdmin(adminOptions.isAuthorized, ctx);
	const orderId = requireOrderId(ctx);
	assertPersistedOrders(options);
	const { row, provider } = await loadOrder(ctx, providers, orderId);
	return { orderId, row, provider, where: () => orderWhere(row.provider, row.providerOrderId) };
}
/** An admin command answers a retry with exactly the response its first completion saved. */
async function runAdminCommand<Response extends object, Checked = undefined>(
	ctx: GenericEndpointContext,
	spec: MoneyCommandSpec<Checked>,
	execute: (command: MoneyCommand<Checked>) => Promise<Response>,
) {
	// The journal saves exactly the response this command returned, so its replay has the same type.
	const replay = (saved: Record<string, unknown>) => saved as Response;
	return ctx.json(await runMoneyCommand<Response, Checked>(ctx, { ...spec, replay }, execute));
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
				const orders = await ctx.context.adapter.findMany<OrderRecord>({
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
				const { orderId, provider, row, where } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				assertOperationCurrency(row, ctx.body.totalAmount, "capture");
				const amountMinor = parseOperationAmount(ctx.body.totalAmount, "capture");
				const merchantReferenceId = ctx.body.merchantReferenceId;
				return runAdminCommand(
					ctx,
					{
						where,
						operation: "capture",
						reference: merchantReferenceId,
						input: ctx.body,
						onPending: "verify",
						recordBaseline: true,
						check: (order) => {
							if (!acceptsCaptures(order.status))
								throw new APIError("BAD_REQUEST", {
									message: "This order no longer accepts captures",
									code: "INVALID_AMOUNT",
								});
							if (amountMinor > capturableMinor(order))
								throw new APIError("BAD_REQUEST", {
									message: "Capture amount exceeds the remaining order balance",
									code: "INVALID_AMOUNT",
								});
						},
					},
					async (command) => {
						if (command.state === "pending") {
							const result = await verifyPending(() =>
								settlePendingMoneyOperation(ctx, command, provider, row, "captured", amountMinor),
							);
							await recordSyntheticCaptureEvent(ctx, provider, orderId, row.currency, result);
							return result;
						}
						try {
							const result = await command.send(() =>
								provider.capture(
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
								),
							);
							const { response } = await settleMoneyOperation(
								command,
								provider,
								row,
								"captured",
								result,
								result.captureId,
								amountMinor,
							);
							await recordSyntheticCaptureEvent(ctx, provider, orderId, row.currency, result);
							return response;
						} catch (e) {
							if (e instanceof APIError) throw e;
							throwAdminOperationError(ctx, e, "capture", "CAPTURE_FAILED");
						}
					},
				);
			},
		),
		bnplAdminRefund: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/refund",
			{ method: "POST", body: refundBodySchema, use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, row, where } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				assertOperationCurrency(row, ctx.body.totalAmount, "refund");
				const amountMinor = parseOperationAmount(ctx.body.totalAmount, "refund");
				const merchantRefundId = ctx.body.merchantRefundId;
				return runAdminCommand(
					ctx,
					{
						where,
						operation: "refund",
						reference: merchantRefundId,
						input: ctx.body,
						onPending: "verify",
						recordBaseline: true,
						check: (order) => {
							if (amountMinor > refundableMinor(order))
								throw new APIError("BAD_REQUEST", {
									message: "Refund amount exceeds the captured balance available for refund",
									code: "INVALID_AMOUNT",
								});
						},
					},
					async (command) => {
						if (command.state === "pending") {
							const result = await verifyPending(() =>
								settlePendingMoneyOperation(ctx, command, provider, row, "refunded", amountMinor),
							);
							for (const operation of result.operations ?? [])
								await recordSyntheticRefundEvent(ctx, provider, orderId, row.currency, {
									refundId: operation.id,
									amountMinor: operation.amountMinor,
									raw: null,
								});
							return result;
						}
						try {
							const result = await command.send(() =>
								provider.refund(
									orderId,
									{
										totalAmount: ctx.body.totalAmount,
										items: ctx.body.items,
										comment: ctx.body.comment,
										merchantRefundId,
									},
									{ logger: ctx.context.logger },
								),
							);
							const { response, operations } = await settleMoneyOperation(
								command,
								provider,
								row,
								"refunded",
								result,
								result.refundId,
								amountMinor,
							);
							for (const operation of operations)
								await recordSyntheticRefundEvent(ctx, provider, orderId, row.currency, {
									refundId: operation.id,
									amountMinor: operation.amountMinor,
									raw: result.raw,
								});
							return response;
						} catch (e) {
							if (e instanceof APIError) throw e;
							throwAdminOperationError(ctx, e, "refund", "REFUND_FAILED");
						}
					},
				);
			},
		),
		bnplAdminCancel: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/cancel",
			{ method: "POST", body: cancelBodySchema, use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, row, where } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				const amountMinor = ctx.body.totalAmount
					? parseOperationAmount(ctx.body.totalAmount, "cancel")
					: undefined;
				const closesPayment = provider.capabilities.cancelClosesPayment === true;
				if (ctx.body.totalAmount) {
					assertOperationCurrency(row, ctx.body.totalAmount, "cancel");
					if (!ctx.body.merchantReferenceId)
						throw new APIError("BAD_REQUEST", {
							message: "Amount-bearing cancellation requires merchantReferenceId",
							code: "INVALID_CANCEL_REFERENCE",
						});
				}
				return runAdminCommand(
					ctx,
					{
						where,
						operation: "cancel",
						reference: ctx.body.merchantReferenceId ?? orderId,
						input: ctx.body,
						onPending: "verify",
						recordBaseline: true,
						check: (order) => {
							if (
								amountMinor !== undefined &&
								amountMinor + order.capturedAmountMinor + (order.canceledAmountMinor ?? 0) >
									order.amountMinor
							)
								throw new APIError("BAD_REQUEST", {
									message: "Cancellation exceeds remaining order balance",
								});
							return {
								verifyClosure:
									closesPayment && amountMinor === undefined && hasNothingLeftToClose(order),
							};
						},
					},
					async (command) => {
						const finish = async (
							status: BnplOrderState["status"],
							evidence:
								| { remote: BnplOrderState }
								| { cancelId: string; amountMinor: number }
								| undefined,
						) => {
							const response = { orderId, status };
							return await command.settle((order) => {
								const patch: Record<string, unknown> = {};
								if (evidence && "remote" in evidence) {
									if (amountMinor === undefined && snapshotIsBehind(order, evidence.remote))
										throw new Error("bnpl: remote closure snapshot predates local financial state");
									Object.assign(patch, importSnapshot(order, provider, evidence.remote));
								} else if (evidence) {
									Object.assign(
										patch,
										applyCancellation(order, provider, evidence.cancelId, evidence.amountMinor),
									);
								}
								const merged = { ...order, ...patch } as OrderRecord;
								patch.status = nextStatus(
									order.status,
									statusFromBalances(status, {
										amountMinor: order.amountMinor,
										captured: merged.capturedAmountMinor,
										refunded: merged.refundedAmountMinor,
										canceled: merged.canceledAmountMinor ?? 0,
									}),
								);
								if (patch.status === "canceled" && order.status !== "canceled")
									patch.canceledAt = new Date();
								return { response, patch };
							});
						};
						const recover = async () => {
							const before = command.baseline;
							if (!before)
								throw new Error("bnpl: cancellation reservation lacks recovery evidence");
							const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
							if (closesPayment) {
								readRemoteHistory(provider, { ...row, ...before }, remote);
								if (
									!(remote.closed === true || confirmsClosure(remote)) ||
									(amountMinor !== undefined &&
										(remote.capturedAmountMinor !== before.capturedAmountMinor ||
											amountMinor !==
												row.amountMinor - before.capturedAmountMinor - before.canceledAmountMinor))
								)
									throw new Error(
										"bnpl: remote payment does not confirm closure of the remaining balance",
									);
							} else if (amountMinor !== undefined) {
								if (
									!attributePendingOperations(
										provider,
										row,
										before,
										remote,
										"canceled",
										amountMinor,
									)
								)
									throw new Error("bnpl: cancellation outcome is not uniquely proven");
							} else {
								readRemoteHistory(provider, { ...row, ...before }, remote);
								if (remote.status !== "canceled")
									throw new Error("bnpl: remote order does not confirm cancellation");
							}
							return finish(remote.status, { remote });
						};
						if (command.state === "pending" || command.checked?.verifyClosure) {
							try {
								return await recover();
							} catch {
								await command.release();
								throw verificationConflict(
									"Cancellation outcome is uncertain; verify native history before retrying",
								);
							}
						}
						try {
							const result = await command.send(
								() =>
									provider.cancel(
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
									),
								amountMinor !== undefined
									? undefined
									: closesPayment
										? reportsAlreadyClosed
										: reportsAlreadyCanceled,
							);
							if (result && result.providerOrderId !== orderId)
								throw new Error("bnpl: cancel order identity mismatch");
							if (
								amountMinor === undefined ||
								!result?.cancelId ||
								result.amountMinor === undefined
							)
								return await recover();
							if (
								!Number.isSafeInteger(result.amountMinor) ||
								result.amountMinor <= 0 ||
								result.amountMinor !== amountMinor
							)
								throw new Error("bnpl: inconsistent cancellation amount");
							if (
								readAppliedOperations(command.baseline?.appliedOperations).includes(
									cancellationKey(provider, row, result.cancelId),
								)
							)
								throw new Error(
									"bnpl: cancellation response repeats an operation predating this command",
								);
							return await finish(result.status, {
								cancelId: result.cancelId,
								amountMinor: result.amountMinor,
							});
						} catch (e) {
							throwAdminOperationError(ctx, e, "cancel", "CANCEL_FAILED");
						}
					},
				);
			},
		),
		bnplAdminAuthorise: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/authorise",
			{ method: "POST", use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, row, where } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				const authorize = provider.authorize?.bind(provider);
				if (!authorize || !provider.capabilities.separateAuthorise) {
					throw new APIError("BAD_REQUEST", {
						message: `${BNPL_ERROR_CODES.OPERATION_NOT_SUPPORTED.message}: ${provider.id} does not require a separate authorise call`,
						code: "OPERATION_NOT_SUPPORTED",
					});
				}
				return runAdminCommand(
					ctx,
					{ where, operation: "authorise", reference: orderId, input: {}, onPending: "verify" },
					async (command) => {
						const recoveryRequested = command.state === "pending" || isAuthorisedState(row.status);
						try {
							const local = await command.settleIf((order) =>
								isAuthorisedState(order.status)
									? { response: { orderId, status: order.status, already: true } }
									: null,
							);
							if (local) return local;
							if (recoveryRequested)
								throw new Error("bnpl: authorisation outcome is uncertain; verifying remote state");
							const result = await command.send(
								() => authorize(orderId, { logger: ctx.context.logger }),
								reportsAuthorisedState,
							);
							if (result.providerOrderId !== orderId)
								throw new Error("bnpl: authorisation order identity mismatch");
							let capturedAmountMinor: number | undefined;
							const settled = await command.settle((order) => {
								const applied = applyAuthorisation(order, provider, result);
								capturedAmountMinor = applied.capturedAmountMinor;
								return { response: result, patch: applied.patch };
							});
							if (result.captureId && capturedAmountMinor !== undefined) {
								await recordSyntheticCaptureEvent(ctx, provider, orderId, row.currency, {
									captureId: result.captureId,
									amountMinor: capturedAmountMinor,
									raw: result.raw,
								});
							}
							return settled;
						} catch (e) {
							if (recoveryRequested || reportsAuthorisedState(e)) {
								const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
								if (remote.providerOrderId === orderId && isAuthorisedState(remote.status)) {
									const response = { orderId, status: remote.status, already: true };
									return await command.settle((order) => ({
										response,
										patch: { ...importSnapshot(order, provider, remote), authorisedAt: new Date() },
									}));
								}
							}
							throwAdminOperationError(ctx, e, "authorise", "AUTHORISE_FAILED");
						}
					},
				);
			},
		),
		bnplAdminReconcile: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/reconcile",
			{ method: "POST", use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, row, where } = await loadAdminOrder(
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
					await mutateOrder<OrderRecord>(ctx, where, (current) => {
						if ((current.version ?? 0) !== readVersion || snapshotIsBehind(current, remote))
							throw new Error("bnpl: reconciliation snapshot is stale; retry reconciliation");
						return {
							...importSnapshot(current, provider, remote),
							rawData: JSON.stringify(remote.raw),
							updatedAt: new Date(),
						};
					});
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
				const { orderId, provider, row, where } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				const voidCheckout = provider.voidCheckout?.bind(provider);
				if (!voidCheckout || !provider.capabilities.voidCheckout) {
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
				return runAdminCommand(
					ctx,
					{
						where,
						operation: "void",
						reference: orderId,
						input: { checkoutId },
						onPending: "verify",
					},
					async (command) => {
						let confirmedCapturedAmountMinor = command.evidence?.voidedCapturedAmountMinor;
						try {
							if (command.state === "reserved") {
								const result = await command.send(() =>
									voidCheckout(checkoutId, orderId, { logger: ctx.context.logger }),
								);
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
								if (
									result?.voided === true &&
									result.capturedCurrency === row.currency &&
									result.capturedAmountMinor !== undefined
								) {
									confirmedCapturedAmountMinor = result.capturedAmountMinor;
									await command.recordEvidence({
										voidedCapturedAmountMinor: result.capturedAmountMinor,
									});
								}
								if (result?.voided === false) {
									const response = {
										orderId,
										voided: false,
										capturedAmountMinor: result.capturedAmountMinor,
									};
									return await command.settle(() => ({ response }));
								}
							}
							const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
							const response = {
								orderId,
								voided: true,
								capturedAmountMinor: remote.capturedAmountMinor,
							};
							return await command.settle((order) => {
								if (snapshotIsBehind(order, remote))
									throw verificationConflict(
										"Void verification snapshot is older than current financial state",
									);
								const imported = importSnapshot(order, provider, remote);
								const knownPaidVoid =
									confirmedCapturedAmountMinor !== undefined && confirmedCapturedAmountMinor > 0;
								if (
									knownPaidVoid
										? imported.capturedAmountMinor !== confirmedCapturedAmountMinor
										: !["expired", "canceled"].includes(remote.status) ||
											imported.capturedAmountMinor !== 0 ||
											imported.refundedAmountMinor !== 0
								)
									throw verificationConflict(
										"Void outcome is uncertain; verify the checkout before retrying",
									);
								return { response, patch: imported };
							});
						} catch (e) {
							if (e instanceof APIError) throw e;
							throwAdminOperationError(ctx, e, "void", "VOID_FAILED");
						}
					},
				);
			},
		),
		bnplAdminClosePayment: createAuthEndpoint(
			"/bnpl/admin/orders/:orderId/close",
			{ method: "POST", use: [sessionMiddleware] },
			async (ctx) => {
				const { orderId, provider, where } = await loadAdminOrder(
					adminOptions,
					options,
					ctx,
					providers,
				);
				const closePayment = provider.closePayment?.bind(provider);
				if (!closePayment || !provider.capabilities.closePayment) {
					throw new APIError("BAD_REQUEST", {
						message: `${BNPL_ERROR_CODES.OPERATION_NOT_SUPPORTED.message}: ${provider.id} does not support close`,
						code: "OPERATION_NOT_SUPPORTED",
					});
				}
				return runAdminCommand(
					ctx,
					{
						where,
						operation: "close",
						reference: orderId,
						input: {},
						onPending: "verify",
						check: (order) => ({ alreadySettled: hasNothingLeftToClose(order) }),
					},
					async (command) => {
						try {
							if (command.state === "reserved" && !command.checked?.alreadySettled)
								await command.send(
									() => closePayment(orderId, { logger: ctx.context.logger }),
									reportsAlreadyClosed,
								);
							const remote = await provider.fetchOrder(orderId, { logger: ctx.context.logger });
							const response = { orderId, closed: true };
							return await command.settle((order) => {
								if (snapshotIsBehind(order, remote))
									throw verificationConflict(
										"Close verification snapshot is older than current financial state",
									);
								const imported = importSnapshot(order, provider, remote);
								if (!confirmsClosure(remote))
									throw verificationConflict(
										"Close outcome is uncertain; verify payment closure before retrying",
									);
								return { response, patch: imported };
							});
						} catch (e) {
							if (command.checked?.alreadySettled) await command.release();
							if (e instanceof APIError) throw e;
							throwAdminOperationError(ctx, e, "close-payment", "CLOSE_PAYMENT_FAILED");
						}
					},
				);
			},
		),
	});
};
