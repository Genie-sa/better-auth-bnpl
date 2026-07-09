import type { GenericEndpointContext, Where } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import {
	OrderStoreConflictError,
	OrderStoreMissingError,
	mutateOrder,
} from "../../plugins/order-store";
import { silentLogger } from "../_harness";
interface OrderRow {
	id: string;
	provider: string;
	providerOrderId: string;
	capturedAmountMinor: number;
	version: number;
	[key: string]: unknown;
}
function makeFakeCtx(
	initial: OrderRow,
	opts: {
		onBeforeUpdate?: (row: OrderRow) => void;
		reportZeroOnSuccess?: boolean;
	} = {},
): {
	ctx: GenericEndpointContext;
	row: () => OrderRow;
	updateManyCalls: () => number;
} {
	let row = { ...initial };
	let updateManyCalls = 0;
	function matches(where: Where[]): boolean {
		return where.every((clause) => {
			if (clause.field === "version") return row.version === clause.value;
			if (clause.field === "provider") return row.provider === clause.value;
			if (clause.field === "providerOrderId") return row.providerOrderId === clause.value;
			return true;
		});
	}
	const adapter = {
		async findOne<T>({
			where,
		}: {
			where: Where[];
		}): Promise<T | null> {
			const provider = where.find((w) => w.field === "provider")?.value;
			const id = where.find((w) => w.field === "providerOrderId")?.value;
			if (provider !== undefined && provider !== row.provider) return null;
			if (id !== undefined && id !== row.providerOrderId) return null;
			return { ...row } as T;
		},
		async updateMany({
			where,
			update,
		}: {
			where: Where[];
			update: Record<string, unknown>;
		}) {
			updateManyCalls += 1;
			opts.onBeforeUpdate?.(row);
			if (!matches(where)) return 0;
			row = { ...row, ...update } as OrderRow;
			return opts.reportZeroOnSuccess ? 0 : 1;
		},
	};
	const ctx = {
		context: { adapter, logger: silentLogger },
	} as unknown as GenericEndpointContext;
	return { ctx, row: () => row, updateManyCalls: () => updateManyCalls };
}
function orderWhere(row: OrderRow): () => Where[] {
	return () => [
		{ field: "provider", value: row.provider },
		{ field: "providerOrderId", value: row.providerOrderId },
	];
}
describe("mutateOrder optimistic concurrency", () => {
	const base: OrderRow = {
		id: "row-1",
		provider: "tabby",
		providerOrderId: "ord-1",
		capturedAmountMinor: 0,
		version: 0,
	};
	it("applies an update and rotates the version token with no contention", async () => {
		const { ctx, row, updateManyCalls } = makeFakeCtx(base);
		await mutateOrder<OrderRow>(ctx, orderWhere(base), (current) => ({
			capturedAmountMinor: current.capturedAmountMinor + 5000,
		}));
		expect(row().capturedAmountMinor).toBe(5000);
		expect(row().version).not.toBe(0);
		expect(updateManyCalls()).toBe(1);
	});
	it("retries after a version conflict and lands the correct cumulative amount", async () => {
		let injected = false;
		const { ctx, row, updateManyCalls } = makeFakeCtx(base, {
			onBeforeUpdate: (current) => {
				if (!injected) {
					injected = true;
					current.capturedAmountMinor += 3000;
					current.version += 1;
				}
			},
		});
		await mutateOrder<OrderRow>(ctx, orderWhere(base), (current) => ({
			capturedAmountMinor: current.capturedAmountMinor + 5000,
		}));
		expect(row().capturedAmountMinor).toBe(8000);
		expect(updateManyCalls()).toBe(2);
	});
	it("treats a zero return as success when the re-read shows our token (Kysely/SQLite reality)", async () => {
		const { ctx, row, updateManyCalls } = makeFakeCtx(base, { reportZeroOnSuccess: true });
		await mutateOrder<OrderRow>(ctx, orderWhere(base), (current) => ({
			capturedAmountMinor: current.capturedAmountMinor + 1000,
		}));
		expect(row().capturedAmountMinor).toBe(1000);
		expect(updateManyCalls()).toBe(1);
	});
	it("retries on a zero return when the re-read shows a foreign version", async () => {
		let injected = false;
		const { ctx, row, updateManyCalls } = makeFakeCtx(base, {
			reportZeroOnSuccess: true,
			onBeforeUpdate: (current) => {
				if (!injected) {
					injected = true;
					current.capturedAmountMinor += 3000;
					current.version += 1;
				}
			},
		});
		await mutateOrder<OrderRow>(ctx, orderWhere(base), (current) => ({
			capturedAmountMinor: current.capturedAmountMinor + 5000,
		}));
		expect(row().capturedAmountMinor).toBe(8000);
		expect(updateManyCalls()).toBe(2);
	});
	it("throws OrderStoreConflictError after exhausting retries", async () => {
		const { ctx } = makeFakeCtx(base, {
			onBeforeUpdate: (current) => {
				current.version += 1;
			},
		});
		await expect(
			mutateOrder<OrderRow>(ctx, orderWhere(base), (current) => ({
				capturedAmountMinor: current.capturedAmountMinor + 5000,
			})),
		).rejects.toBeInstanceOf(OrderStoreConflictError);
	});
	it("throws OrderStoreMissingError when the row is absent", async () => {
		const { ctx } = makeFakeCtx(base);
		const missingWhere = (): Where[] => [
			{ field: "provider", value: "tabby" },
			{ field: "providerOrderId", value: "does-not-exist" },
		];
		await expect(
			mutateOrder<OrderRow>(ctx, missingWhere, () => ({ capturedAmountMinor: 1 })),
		).rejects.toBeInstanceOf(OrderStoreMissingError);
	});
	it("skips the write when compute returns null", async () => {
		const { ctx, row, updateManyCalls } = makeFakeCtx(base);
		const compute = vi.fn(() => null);
		const result = await mutateOrder<OrderRow>(ctx, orderWhere(base), compute);
		expect(compute).toHaveBeenCalledOnce();
		expect(updateManyCalls()).toBe(0);
		expect(row().version).toBe(0);
		expect(result.applied).toEqual({});
	});
});
