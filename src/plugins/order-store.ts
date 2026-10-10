import type { GenericEndpointContext, Where } from "better-auth";
const MAX_ATTEMPTS = 3;
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
	id?: string;
	appliedOperations?: string | null;
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
	if (typeof ctx.context.adapter.incrementOne !== "function")
		throw new Error(
			"bnpl: persisted orders require Better Auth >= 1.6.23 with guarded atomic updates",
		);
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
		const writeToken = readVersion + 1;
		if (!Number.isSafeInteger(writeToken)) throw new Error("bnpl: order version exhausted");
		const guardedUpdate: Record<string, unknown> = { ...update, version: writeToken };
		const affected = await ctx.context.adapter.incrementOne<Row>({
			model: "bnplOrder",
			where: [
				...(row.id ? [{ field: "id", value: row.id }] : where()),
				{ field: "version", value: readVersion },
			],
			increment: { version: 1 },
			set: update,
		});
		if (affected) return { previous: row, applied: guardedUpdate };
		ctx.context.logger.warn(
			`bnpl: optimistic version conflict on bnplOrder (version=${readVersion}, attempt ${attempt + 1}/${MAX_ATTEMPTS}) — retrying`,
		);
	}
	throw new OrderStoreConflictError(
		`bnpl: could not apply bnplOrder update after ${MAX_ATTEMPTS} attempts (last version=${lastConflictVersion})`,
	);
}

export function readAppliedOperations(value?: string | null): string[] {
	if (!value) return [];
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed) || parsed.some((key) => typeof key !== "string")) {
		throw new Error("bnpl: invalid applied operation ledger");
	}
	return parsed;
}

export async function applyOrderOperation<Row extends Versioned>(
	ctx: GenericEndpointContext,
	where: OrderWhere,
	operationKey: string,
	compute: (row: Row) => Record<string, unknown> | null,
): Promise<MutateResult<Row> & { duplicate: boolean }> {
	let duplicate = false;
	const result = await mutateOrder<Row>(ctx, where, (row) => {
		const operations = readAppliedOperations(row.appliedOperations);
		duplicate = operations.includes(operationKey);
		if (duplicate) return null;
		const update = compute(row);
		if (update === null) return null;
		return { ...update, appliedOperations: JSON.stringify([...operations, operationKey]) };
	});
	return { ...result, duplicate };
}
