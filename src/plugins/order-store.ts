import type { GenericEndpointContext, Where } from "better-auth";
const MAX_ATTEMPTS = 3;
type WriteSignal = "confirmed" | "ambiguous";
function interpretUpdateResult(result: unknown): WriteSignal {
	if (typeof result === "number" && result > 0) return "confirmed";
	if (Array.isArray(result)) return result.length > 0 ? "confirmed" : "ambiguous";
	if (typeof result === "object" && result !== null) return "confirmed";
	return "ambiguous";
}
function nextWriteToken(readVersion: number): number {
	let token = readVersion;
	while (token === readVersion) {
		token = Math.floor(Math.random() * 0x7fffffff);
	}
	return token;
}
export class OrderStoreConflictError extends Error {
	readonly model = "bnplOrder";
	constructor(message: string) {
		super(message);
		this.name = "OrderStoreConflictError";
	}
}
export class OrderStoreMissingError extends Error {
	readonly model = "bnplOrder";
	constructor(message: string) {
		super(message);
		this.name = "OrderStoreMissingError";
	}
}
interface Versioned {
	version?: number | null;
}
export type OrderWhere = () => Where[];
export type OrderUpdatePayload = Record<string, unknown>;
export interface MutateResult<Row> {
	previous: Row;
	applied: OrderUpdatePayload;
}
export async function mutateOrder<Row extends Versioned>(
	ctx: GenericEndpointContext,
	where: OrderWhere,
	compute: (row: Row) => Record<string, unknown> | null,
): Promise<MutateResult<Row>> {
	let lastConflictVersion: number | null = null;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const row = await ctx.context.adapter.findOne<Row>({
			model: "bnplOrder",
			where: where(),
		});
		if (!row) {
			throw new OrderStoreMissingError(
				"bnpl: order row not found while applying a versioned update",
			);
		}
		const update = compute(row);
		if (update === null) {
			return { previous: row, applied: {} };
		}
		const readVersion = row.version ?? 0;
		lastConflictVersion = readVersion;
		const writeToken = nextWriteToken(readVersion);
		const guardedUpdate: Record<string, unknown> = { ...update, version: writeToken };
		const affected: unknown = await ctx.context.adapter.updateMany({
			model: "bnplOrder",
			where: [...where(), { field: "version", value: readVersion }],
			update: guardedUpdate,
		});
		if (interpretUpdateResult(affected) === "confirmed") {
			return { previous: row, applied: guardedUpdate };
		}
		const verified = await ctx.context.adapter.findOne<Row>({
			model: "bnplOrder",
			where: where(),
		});
		if (!verified) {
			throw new OrderStoreMissingError(
				"bnpl: order row disappeared while verifying a versioned update",
			);
		}
		if ((verified.version ?? 0) === writeToken) {
			return { previous: row, applied: guardedUpdate };
		}
		ctx.context.logger.warn(
			`bnpl: optimistic version conflict on bnplOrder (version=${readVersion}, attempt ${attempt + 1}/${MAX_ATTEMPTS}) — retrying`,
		);
	}
	throw new OrderStoreConflictError(
		`bnpl: could not apply bnplOrder update after ${MAX_ATTEMPTS} attempts (last version=${lastConflictVersion})`,
	);
}
