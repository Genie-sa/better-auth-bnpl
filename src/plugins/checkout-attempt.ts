import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import { type CanonicalStatus, canTransition } from "../core/status";
import type { BnplApprovedCheckoutResult, BnplDeclinedCheckoutResult } from "../core/types";
import { mutateOrder } from "./order-store";

export interface CheckoutAttempt {
	hash: string;
	result?: Omit<BnplApprovedCheckoutResult, "raw"> | Omit<BnplDeclinedCheckoutResult, "raw">;
	createdHook?: boolean;
	persistedHook?: boolean;
	processingToken?: string;
	processingUntil?: number;
}
const CLAIM_MS = 5 * 60 * 1000;
export interface CheckoutOrder {
	id: string;
	userId: string;
	provider: string;
	orderReferenceId: string;
	version?: number | null;
	checkoutAttempt?: string | null;
	status: CanonicalStatus;
	amountMinor: number;
	currency: string;
	paymentType?: string;
	capturedAmountMinor: number;
	refundedAmountMinor: number;
	metadata?: string;
	createdAt: Date;
	updatedAt: Date;
}
function conflict(message: string): never {
	throw new APIError("CONFLICT", { code: "CHECKOUT_CONFLICT", message });
}
export function readCheckoutAttempt(row: CheckoutOrder, hash: string): CheckoutAttempt {
	if (!row.checkoutAttempt) conflict("This order reference already belongs to another checkout");
	const attempt = JSON.parse(row.checkoutAttempt) as CheckoutAttempt;
	if (
		!attempt ||
		typeof attempt.hash !== "string" ||
		(attempt.processingToken !== undefined && typeof attempt.processingToken !== "string") ||
		(attempt.processingUntil !== undefined && !Number.isFinite(attempt.processingUntil)) ||
		(attempt.createdHook !== undefined && typeof attempt.createdHook !== "boolean") ||
		(attempt.persistedHook !== undefined && typeof attempt.persistedHook !== "boolean") ||
		(attempt.result !== undefined &&
			(!attempt.result ||
				typeof attempt.result.providerOrderId !== "string" ||
				typeof attempt.result.providerCheckoutId !== "string" ||
				typeof attempt.result.status !== "string"))
	)
		throw new Error("bnpl: invalid checkout attempt journal");
	if (attempt.hash !== hash) conflict("Checkout reference was already used with different input");
	return attempt;
}
export async function reserveCheckoutOrder(
	ctx: GenericEndpointContext,
	data: Omit<CheckoutOrder, "id" | "createdAt" | "updatedAt">,
	hash: string,
): Promise<{ row: CheckoutOrder; attempt: CheckoutAttempt; reserved: boolean }> {
	const where = [{ field: "orderReferenceId", value: data.orderReferenceId }];
	let existing = await ctx.context.adapter.findOne<CheckoutOrder>({ model: "bnplOrder", where });
	if (!existing) {
		try {
			const attempt: CheckoutAttempt = {
				hash,
				processingToken: crypto.randomUUID(),
				processingUntil: Date.now() + CLAIM_MS,
			};
			const row = await ctx.context.adapter.create<CheckoutOrder>({
				model: "bnplOrder",
				data: {
					...data,
					checkoutAttempt: JSON.stringify(attempt),
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			return { row: { ...row }, attempt, reserved: true };
		} catch (error) {
			existing = await ctx.context.adapter.findOne<CheckoutOrder>({ model: "bnplOrder", where });
			if (!existing) throw error;
		}
	}
	if (existing.userId !== data.userId || existing.provider !== data.provider)
		conflict("This order reference already belongs to another checkout");
	const attempt = readCheckoutAttempt(existing, hash);
	if (!attempt.result)
		conflict("Checkout outcome is uncertain; verify it before starting another purchase");
	if (attempt.result.status === "declined" || (attempt.createdHook && attempt.persistedHook))
		return { row: { ...existing }, attempt, reserved: false };
	let claimed = attempt;
	const token = crypto.randomUUID();
	const mutation = await mutateOrder<CheckoutOrder>(
		ctx,
		() => [{ field: "id", value: existing.id }],
		(current) => {
			const latest = readCheckoutAttempt(current, hash);
			if (!latest.result)
				conflict("Checkout outcome is uncertain; verify it before starting another purchase");
			if (latest.createdHook && latest.persistedHook) {
				claimed = latest;
				return null;
			}
			if (latest.processingToken && (latest.processingUntil ?? 0) > Date.now())
				conflict("Checkout integration delivery is already in progress");
			claimed = { ...latest, processingToken: token, processingUntil: Date.now() + CLAIM_MS };
			return { checkoutAttempt: JSON.stringify(claimed), updatedAt: new Date() };
		},
	);
	return { row: { ...mutation.previous, ...mutation.applied }, attempt: claimed, reserved: false };
}
export async function updateCheckoutAttempt(
	ctx: GenericEndpointContext,
	row: CheckoutOrder,
	hash: string,
	update: Partial<CheckoutAttempt>,
	orderUpdate: Record<string, unknown> & { status?: CanonicalStatus } = {},
): Promise<void> {
	const token = readCheckoutAttempt(row, hash).processingToken;
	await mutateOrder<CheckoutOrder>(
		ctx,
		() => [{ field: "id", value: row.id }],
		(current) => {
			const attempt = readCheckoutAttempt(current, hash);
			if (
				!token ||
				attempt.processingToken !== token ||
				(attempt.processingUntil ?? 0) <= Date.now()
			)
				conflict("Checkout integration claim was lost");
			return {
				...orderUpdate,
				...(orderUpdate.status
					? {
							status: canTransition(current.status, orderUpdate.status)
								? orderUpdate.status
								: current.status,
						}
					: {}),
				checkoutAttempt: JSON.stringify({
					...attempt,
					...update,
					processingToken: update.persistedHook ? undefined : token,
					processingUntil: update.persistedHook ? undefined : Date.now() + CLAIM_MS,
				}),
				updatedAt: new Date(),
			};
		},
	);
}

export async function releaseCheckoutClaim(
	ctx: GenericEndpointContext,
	row: CheckoutOrder,
	hash: string,
): Promise<void> {
	const token = readCheckoutAttempt(row, hash).processingToken;
	await mutateOrder<CheckoutOrder>(
		ctx,
		() => [{ field: "id", value: row.id }],
		(current) => {
			const attempt = readCheckoutAttempt(current, hash);
			if (!token || attempt.processingToken !== token || !attempt.result) return null;
			return {
				checkoutAttempt: JSON.stringify({
					...attempt,
					processingToken: undefined,
					processingUntil: undefined,
				}),
				updatedAt: new Date(),
			};
		},
	);
}
