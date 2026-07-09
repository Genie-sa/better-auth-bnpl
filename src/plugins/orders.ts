import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { z } from "zod";
import { BNPL_ERROR_CODES } from "../core/errors";
import type { BnplProvider } from "../core/provider";
import type { BnplOrderState, BnplPersistedOrder } from "../core/types";
import type { BnplOptions } from "../plugin-types";
import { assertPersistedOrders } from "./persistence";
export interface OrdersSubpluginOptions {
	restrictToOwner?: boolean;
}
interface StoredOrderRecord extends BnplPersistedOrder {
	userId: string;
	provider: string;
	providerOrderId: string;
	orderReferenceId: string;
	status: string;
	amountMinor: number;
	currency: string;
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	createdAt: Date;
	updatedAt: Date;
}
function assertReadableOrder(
	record: {
		userId: string;
	},
	userId: string,
	requireOwner: boolean,
): void {
	if (requireOwner && record.userId !== userId) {
		throw new APIError("FORBIDDEN", {
			message: BNPL_ERROR_CODES.ORDER_NOT_OWNED.message,
			code: "ORDER_NOT_OWNED",
		});
	}
}
function toPublicOrder(record: StoredOrderRecord): Omit<StoredOrderRecord, "rawData"> {
	const { rawData: _rawData, ...publicOrder } = record;
	return publicOrder;
}
function toPublicRemote(remote: BnplOrderState): Omit<BnplOrderState, "raw"> {
	const { raw: _raw, ...publicRemote } = remote;
	return publicRemote;
}
export const orders = (ordersOptions: OrdersSubpluginOptions = {}) => {
	const requireOwner = ordersOptions.restrictToOwner ?? true;
	return (providers: Record<string, BnplProvider>, options: BnplOptions) => ({
		bnplGetOrder: createAuthEndpoint(
			"/bnpl/orders/:providerOrderId",
			{ method: "GET", use: [sessionMiddleware] },
			async (ctx) => {
				const providerOrderId = ctx.params?.providerOrderId;
				if (!providerOrderId) {
					throw new APIError("BAD_REQUEST", { message: "providerOrderId is required" });
				}
				assertPersistedOrders(options);
				const record = await ctx.context.adapter.findOne<StoredOrderRecord>({
					model: "bnplOrder",
					where: [{ field: "providerOrderId", value: providerOrderId }],
				});
				if (!record) {
					throw new APIError("NOT_FOUND", {
						message: BNPL_ERROR_CODES.ORDER_NOT_FOUND.message,
						code: "ORDER_NOT_FOUND",
					});
				}
				assertReadableOrder(record, ctx.context.session.user.id, requireOwner);
				const provider = providers[record.provider];
				if (!provider) {
					return ctx.json(toPublicOrder(record));
				}
				try {
					const remote = await provider.fetchOrder(record.providerOrderId, {
						logger: ctx.context.logger,
					});
					return ctx.json({ ...toPublicOrder(record), remote: toPublicRemote(remote) });
				} catch (e) {
					ctx.context.logger.warn(
						`bnpl: getOrder upstream fetch failed for ${record.provider}/${record.providerOrderId}: ${e instanceof Error ? e.message : e}`,
					);
					return ctx.json(toPublicOrder(record));
				}
			},
		),
		bnplGetOrderByReferenceId: createAuthEndpoint(
			"/bnpl/orders/reference-id/:referenceId",
			{ method: "GET", use: [sessionMiddleware] },
			async (ctx) => {
				const referenceId = ctx.params?.referenceId;
				if (!referenceId) {
					throw new APIError("BAD_REQUEST", {
						message: BNPL_ERROR_CODES.REFERENCE_ID_REQUIRED.message,
						code: "REFERENCE_ID_REQUIRED",
					});
				}
				assertPersistedOrders(options);
				const record = await ctx.context.adapter.findOne<StoredOrderRecord>({
					model: "bnplOrder",
					where: [{ field: "orderReferenceId", value: referenceId }],
				});
				if (!record) {
					throw new APIError("NOT_FOUND", {
						message: BNPL_ERROR_CODES.ORDER_NOT_FOUND.message,
						code: "ORDER_NOT_FOUND",
					});
				}
				assertReadableOrder(record, ctx.context.session.user.id, requireOwner);
				return ctx.json(toPublicOrder(record));
			},
		),
		bnplListOrders: createAuthEndpoint(
			"/bnpl/orders",
			{
				method: "GET",
				query: z
					.object({
						limit: z.coerce.number().min(1).max(100).optional(),
						offset: z.coerce.number().min(0).optional(),
						provider: z.string().optional(),
					})
					.optional(),
				use: [sessionMiddleware],
			},
			async (ctx) => {
				assertPersistedOrders(options);
				const where: Array<{
					field: string;
					value: string;
				}> = [{ field: "userId", value: ctx.context.session.user.id }];
				if (ctx.query?.provider) {
					where.push({ field: "provider", value: ctx.query.provider });
				}
				const records = await ctx.context.adapter.findMany<StoredOrderRecord>({
					model: "bnplOrder",
					where,
					limit: ctx.query?.limit ?? 20,
					offset: ctx.query?.offset ?? 0,
					sortBy: { field: "createdAt", direction: "desc" },
				});
				return ctx.json({ orders: records.map(toPublicOrder) });
			},
		),
	});
};
