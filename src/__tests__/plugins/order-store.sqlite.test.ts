import type { GenericEndpointContext } from "better-auth";
import { betterAuth } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { bnpl } from "../../plugin";
import { reserveCheckoutOrder } from "../../plugins/checkout-attempt";
import { reserveMoneyCommand } from "../../plugins/money-command";
import { applyOrderOperation, mutateOrder } from "../../plugins/order-store";
import { orders } from "../../plugins/orders";
import {
	type StoredWebhookEvent,
	claimWebhookEvent,
	markWebhookEventProcessed,
} from "../../plugins/webhook-events";
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
		canceledAmountMinor INTEGER NOT NULL DEFAULT 0,
		refundedAmountMinor INTEGER NOT NULL DEFAULT 0,
		rawData TEXT,
		metadata TEXT,
		version INTEGER NOT NULL DEFAULT 0,
		checkoutAttempt TEXT,
		moneyCommands TEXT,
		appliedOperations TEXT,
		webhookTransitions TEXT,
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
	database.exec(
		"CREATE TABLE bnplWebhookEvent (id TEXT PRIMARY KEY, provider TEXT NOT NULL, providerOrderId TEXT NOT NULL, providerOrderReferenceId TEXT, eventKind TEXT NOT NULL, eventType TEXT NOT NULL, dedupKey TEXT NOT NULL UNIQUE, receivedAt DATE NOT NULL, rawData TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, orderApplied INTEGER NOT NULL DEFAULT 0, processedAt DATE, lastError TEXT, processingToken TEXT, processingUntil DATE, deliveryState TEXT)",
	);
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
	it("reserves only one concurrent order mutation across cancel and capture", async () => {
		const { ctx, readRow } = await makeSqliteCtx();
		const outcomes = await Promise.allSettled([
			reserveMoneyCommand(ctx, ORDER_WHERE, "cancel", "cancel-once", { amountMinor: 2500 }),
			reserveMoneyCommand(ctx, ORDER_WHERE, "capture", "capture-once", { amountMinor: 1000 }),
		]);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
		const row = (await readRow()) as OrderRow & { moneyCommands: string };
		expect(JSON.parse(row.moneyCommands)).toHaveLength(1);
	});
	it("blocks changed references and every new mutation while another outcome is uncertain", async () => {
		const { ctx } = await makeSqliteCtx();
		await reserveMoneyCommand(ctx, ORDER_WHERE, "capture", "unknown", {});
		for (const operation of ["capture", "refund", "cancel", "void", "close", "authorise"] as const)
			await expect(
				reserveMoneyCommand(ctx, ORDER_WHERE, operation, "new-reference", {}),
			).rejects.toThrow();
	});
	it("retains the cancellation baseline across intervening balance changes and retries", async () => {
		const { ctx } = await makeSqliteCtx();
		const first = await reserveMoneyCommand(ctx, ORDER_WHERE, "cancel", "stable", {});
		expect(first.kind).toBe("reserved");
		await mutateOrder(ctx, ORDER_WHERE, () => ({ canceledAmountMinor: 2500 }));
		const recovered = await reserveMoneyCommand(
			ctx,
			ORDER_WHERE,
			"cancel",
			"stable",
			{},
			undefined,
			true,
		);
		if (recovered.kind === "completed") throw new Error("Expected pending intent");
		expect(recovered.command.before).toMatchObject({
			capturedAmountMinor: 0,
			refundedAmountMinor: 0,
			canceledAmountMinor: 0,
		});
	});

	it("counts a provider operation once when two workers apply it concurrently", async () => {
		const { ctx, readRow } = await makeSqliteCtx();
		const apply = () =>
			applyOrderOperation<OrderRow>(ctx, ORDER_WHERE, "tabby:captured:shared", (current) => ({
				capturedAmountMinor: current.capturedAmountMinor + 4000,
			}));
		const results = await Promise.all([apply(), apply()]);
		expect((await readRow()).capturedAmountMinor).toBe(4000);
		expect(results.filter((result) => result.duplicate)).toHaveLength(1);
	});
	it("gives only one worker ownership of a stored event", async () => {
		const { ctx } = await makeSqliteCtx();
		const event = await ctx.context.adapter.create<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			data: {
				provider: "tabby",
				providerOrderId: "ord-sqlite",
				eventKind: "captured",
				eventType: "captured",
				dedupKey: "sqlite-claim",
				receivedAt: new Date(),
				status: "received",
				attempts: 0,
				orderApplied: false,
			},
		});
		const results = await Promise.all([
			claimWebhookEvent(ctx, event),
			claimWebhookEvent(ctx, event),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		const stored = await ctx.context.adapter.findOne<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			where: [{ field: "id", value: event.id }],
		});
		expect(stored?.attempts).toBe(1);
		expect(stored?.status).toBe("processing");
	});

	it("rejects a stale worker completion after its lease has been reclaimed", async () => {
		const { ctx } = await makeSqliteCtx();
		const event = await ctx.context.adapter.create<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			data: {
				provider: "tabby",
				providerOrderId: "ord-sqlite",
				eventKind: "captured",
				eventType: "captured",
				dedupKey: "sqlite-reclaim",
				receivedAt: new Date(),
				status: "received",
				attempts: 0,
				orderApplied: false,
			},
		});
		const first = await claimWebhookEvent(ctx, event);
		if (!first) throw new Error("initial claim failed");
		const expired = await ctx.context.adapter.incrementOne<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			where: [{ field: "id", value: first.id }],
			increment: {},
			set: { processingUntil: new Date(0) },
		});
		if (!expired) throw new Error("lease expiry write failed");
		const second = await claimWebhookEvent(ctx, expired);
		if (!second) throw new Error("reclaim failed");
		await expect(markWebhookEventProcessed(ctx, first)).rejects.toThrow("lease was lost");
		await markWebhookEventProcessed(ctx, second);
		const stored = await ctx.context.adapter.findOne<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			where: [{ field: "id", value: first.id }],
		});
		expect(stored?.status).toBe("processed");
		expect(stored?.attempts).toBe(2);
	});

	it("applies a capture delta through the native guarded update", async () => {
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

describe.skipIf(!hasNodeSqlite)("checkout reservations against SQLite", () => {
	it("lets only one worker reserve a new reference when both initial reads miss", async () => {
		const { ctx } = await makeSqliteCtx();
		const adapter = ctx.context.adapter;
		const original = adapter.findOne.bind(adapter);
		let reads = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(adapter, "findOne").mockImplementation(async (args) => {
			const row = await original(args);
			if (!row && args.where?.some((w) => w.value === "race-checkout")) {
				reads++;
				if (reads === 2) release();
				await gate;
			}
			return row;
		});
		const data = {
			userId: "buyer",
			provider: "tabby",
			orderReferenceId: "race-checkout",
			status: "new" as const,
			amountMinor: 10000,
			currency: "SAR",
			capturedAmountMinor: 0,
			refundedAmountMinor: 0,
		};
		const results = await Promise.allSettled([
			reserveCheckoutOrder(ctx, data, "hash"),
			reserveCheckoutOrder(ctx, data, "hash"),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const failure = results.find((r) => r.status === "rejected");
		expect(failure?.status === "rejected" && failure.reason.body.code).toBe("CHECKOUT_CONFLICT");
		expect(
			await adapter.count({
				model: "bnplOrder",
				where: [{ field: "orderReferenceId", value: "race-checkout" }],
			}),
		).toBe(1);
	});
});
