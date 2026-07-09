import type { GenericEndpointContext } from "better-auth";
import { betterAuth } from "better-auth";
import { describe, expect, it } from "vitest";
import { bnpl } from "../../plugin";
import { mutateOrder } from "../../plugins/order-store";
import { orders } from "../../plugins/orders";
import { stubProvider } from "../_harness";
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
const hasNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
interface SqliteDatabase {
	exec(sql: string): void;
}
const CREATE_BNPL_ORDER = `
	CREATE TABLE bnplOrder (
		id TEXT PRIMARY KEY,
		userId TEXT,
		provider TEXT NOT NULL,
		orderReferenceId TEXT NOT NULL UNIQUE,
		providerOrderId TEXT,
		providerCheckoutId TEXT,
		status TEXT NOT NULL,
		amountMinor INTEGER NOT NULL,
		currency TEXT NOT NULL,
		paymentType TEXT,
		authorisedAt DATE,
		capturedAt DATE,
		capturedAmountMinor INTEGER NOT NULL DEFAULT 0,
		canceledAt DATE,
		refundedAmountMinor INTEGER NOT NULL DEFAULT 0,
		rawData TEXT,
		metadata TEXT,
		version INTEGER NOT NULL DEFAULT 0,
		createdAt DATE NOT NULL,
		updatedAt DATE NOT NULL
	)`;
interface OrderRow {
	id: string;
	provider: string;
	providerOrderId: string;
	capturedAmountMinor: number;
	version: number;
}
const ORDER_WHERE = () => [
	{ field: "provider", value: "tabby" },
	{ field: "providerOrderId", value: "ord-sqlite" },
];
async function makeSqliteCtx(): Promise<{
	ctx: GenericEndpointContext;
	readRow: () => Promise<OrderRow>;
	execRaw: (sql: string) => void;
}> {
	const getBuiltinModule = (
		process as unknown as {
			getBuiltinModule?: (id: string) => unknown;
		}
	).getBuiltinModule;
	if (!getBuiltinModule) throw new Error("process.getBuiltinModule unavailable on this Node");
	const sqlite = getBuiltinModule("node:sqlite") as {
		DatabaseSync: new (path: string) => SqliteDatabase;
	};
	const database = new sqlite.DatabaseSync(":memory:");
	database.exec(CREATE_BNPL_ORDER);
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: "sqlite-adapter-secret-that-is-long-enough-for-validation",
		database: database as unknown as Parameters<typeof betterAuth>[0]["database"],
		plugins: [
			bnpl({
				providers: { tabby: stubProvider("tabby") },
				persistOrders: true,
				use: [orders()],
			}),
		],
	});
	const authContext = await auth.$context;
	const adapter = authContext.adapter;
	await adapter.create({
		model: "bnplOrder",
		data: {
			provider: "tabby",
			orderReferenceId: "ref-sqlite",
			providerOrderId: "ord-sqlite",
			providerCheckoutId: "co-sqlite",
			status: "authorised",
			amountMinor: 10000,
			currency: "SAR",
			capturedAmountMinor: 0,
			refundedAmountMinor: 0,
			version: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	const ctx = {
		context: { adapter, logger: authContext.logger },
	} as unknown as GenericEndpointContext;
	const readRow = async (): Promise<OrderRow> => {
		const row = await adapter.findOne<OrderRow>({ model: "bnplOrder", where: ORDER_WHERE() });
		if (!row) throw new Error("seeded bnplOrder row missing");
		return row;
	};
	return { ctx, readRow, execRaw: (sql) => database.exec(sql) };
}
describe.skipIf(!hasNodeSqlite)("mutateOrder against the real SQLite adapter", () => {
	it("applies a capture delta exactly once despite the adapter's zero updateMany return", async () => {
		const { ctx, readRow } = await makeSqliteCtx();
		await mutateOrder<OrderRow>(ctx, ORDER_WHERE, (current) => ({
			capturedAmountMinor: current.capturedAmountMinor + 1000,
			updatedAt: new Date(),
		}));
		const row = await readRow();
		expect(row.capturedAmountMinor).toBe(1000);
		expect(row.version).not.toBe(0);
	});
	it("recovers from a genuine version conflict without losing or duplicating deltas", async () => {
		const { ctx, readRow, execRaw } = await makeSqliteCtx();
		let injected = false;
		await mutateOrder<OrderRow>(ctx, ORDER_WHERE, (current) => {
			if (!injected) {
				injected = true;
				execRaw(
					"UPDATE bnplOrder SET capturedAmountMinor = capturedAmountMinor + 3000, version = 999999 WHERE providerOrderId = 'ord-sqlite'",
				);
			}
			return {
				capturedAmountMinor: current.capturedAmountMinor + 5000,
				updatedAt: new Date(),
			};
		});
		const row = await readRow();
		expect(row.capturedAmountMinor).toBe(8000);
	});
	it("applies three sequential captures with exact cumulative amounts", async () => {
		const { ctx, readRow } = await makeSqliteCtx();
		for (const delta of [1000, 2500, 500]) {
			await mutateOrder<OrderRow>(ctx, ORDER_WHERE, (current) => ({
				capturedAmountMinor: current.capturedAmountMinor + delta,
				updatedAt: new Date(),
			}));
		}
		const row = await readRow();
		expect(row.capturedAmountMinor).toBe(4000);
	});
});
