import type { GenericEndpointContext } from "better-auth";
import { betterAuth } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { BnplProviderError } from "../../core/errors";
import { bnpl } from "../../plugin";
import {
	discardRejectedCheckoutReservation,
	reserveCheckoutOrder,
	updateCheckoutAttempt,
} from "../../plugins/checkout-attempt";
import {
	type JournalOperation,
	type MoneyCommandSpec,
	runMoneyCommand,
} from "../../plugins/money-command";
import { type OrderRecord, applyMoneyOperation } from "../../plugins/order";
import { mutateOrder } from "../../plugins/order-store";
import { orders } from "../../plugins/orders";
import { recordWebhookEvent } from "../../plugins/webhook-events";
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
/** Reserves a command and leaves its outcome unknown, as a crash after dispatch would. */
function leavePending(
	ctx: GenericEndpointContext,
	operation: JournalOperation,
	reference: string,
	spec: Partial<MoneyCommandSpec<undefined>> = {},
) {
	return runMoneyCommand(
		ctx,
		{
			where: ORDER_WHERE,
			operation,
			reference,
			input: {},
			onPending: "conflict",
			replay: (saved) => saved,
			...spec,
		},
		async () => ({}),
	);
}
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
	it("keeps equal provider-local webhook keys separate", async () => {
		const { ctx } = await makeSqliteCtx();
		const event = {
			kind: "captured" as const,
			provider: "foo",
			orderId: "order-1",
			captureId: "capture-1",
			amountMinor: 100,
			currency: "SAR" as const,
			raw: null,
		};
		const first = await recordWebhookEvent(ctx, {
			provider: "foo",
			event,
			dedupKey: "event-1",
			rawBody: "{}",
		});
		if (first.outcome !== "inserted") throw new Error("first provider event was not inserted");
		await ctx.context.adapter.incrementOne({
			model: "bnplWebhookEvent",
			where: [{ field: "id", value: first.row.id }],
			increment: {},
			set: { status: "processed", orderApplied: true },
		});
		const replay = await recordWebhookEvent(ctx, {
			provider: "foo",
			event,
			dedupKey: "event-1",
			rawBody: "{}",
		});
		const second = await recordWebhookEvent(ctx, {
			provider: "foo:bar",
			event: { ...event, provider: "foo:bar", orderId: "order-2" },
			dedupKey: "event-1",
			rawBody: "{}",
		});
		expect(first.outcome).toBe("inserted");
		expect(replay.outcome).toBe("duplicate");
		expect(second.outcome).toBe("inserted");
		const rows = await ctx.context.adapter.findMany<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			where: [{ field: "providerOrderId", value: "order-2" }],
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ provider: "foo:bar", providerOrderId: "order-2" });
		const ownerA = await ctx.context.adapter.findOne<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			where: [{ field: "providerOrderId", value: "order-1" }],
		});
		expect(ownerA).toMatchObject({ provider: "foo", providerOrderId: "order-1" });
	});
	it("scopes colon-bearing provider and key pairs without ambiguity", async () => {
		const { ctx } = await makeSqliteCtx();
		const event = {
			kind: "captured" as const,
			provider: "foo",
			orderId: "order-1",
			captureId: "capture-1",
			amountMinor: 100,
			currency: "SAR" as const,
			raw: null,
		};
		const first = await recordWebhookEvent(ctx, {
			provider: "foo",
			event,
			dedupKey: "bar:event-2",
			rawBody: "{}",
		});
		const second = await recordWebhookEvent(ctx, {
			provider: "foo:bar",
			event: { ...event, provider: "foo:bar", orderId: "order-2" },
			dedupKey: "event-2",
			rawBody: "{}",
		});
		expect(first.outcome).toBe("inserted");
		expect(second.outcome).toBe("inserted");
	});
	it("inserts a new provider-scoped event beside a legacy key owned by another provider", async () => {
		const { ctx } = await makeSqliteCtx();
		await ctx.context.adapter.create({
			model: "bnplWebhookEvent",
			data: {
				provider: "foo",
				providerOrderId: "order-1",
				eventKind: "captured",
				eventType: "captured",
				dedupKey: "shared-event",
				receivedAt: new Date(),
				status: "processed",
				attempts: 1,
				orderApplied: true,
			},
		});
		const result = await recordWebhookEvent(ctx, {
			provider: "bar",
			event: {
				kind: "captured",
				provider: "bar",
				orderId: "order-2",
				captureId: "capture-2",
				amountMinor: 200,
				currency: "SAR",
				raw: null,
			},
			dedupKey: "shared-event",
			rawBody: "{}",
		});
		expect(result.outcome).toBe("inserted");
		const foreign = await ctx.context.adapter.findOne<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			where: [{ field: "providerOrderId", value: "order-1" }],
		});
		const owned = await ctx.context.adapter.findOne<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			where: [{ field: "providerOrderId", value: "order-2" }],
		});
		expect(foreign).toMatchObject({ provider: "foo", status: "processed", orderApplied: true });
		expect(owned).toMatchObject({
			provider: "bar",
			providerOrderId: "order-2",
			status: "received",
		});
	});
	it("reprocesses a concurrent same-provider insert instead of creating a second row", async () => {
		const { ctx } = await makeSqliteCtx();
		const input = {
			provider: "foo",
			event: {
				kind: "captured" as const,
				provider: "foo",
				orderId: "order-1",
				captureId: "capture-1",
				amountMinor: 100,
				currency: "SAR" as const,
				raw: null,
			},
			dedupKey: "concurrent-event",
			rawBody: "{}",
		};
		const results = await Promise.all([
			recordWebhookEvent(ctx, input),
			recordWebhookEvent(ctx, input),
		]);
		expect(results.map((result) => result.outcome).sort()).toEqual(["inserted", "reprocess"]);
		const rows = await ctx.context.adapter.findMany<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			where: [{ field: "provider", value: "foo" }],
		});
		expect(rows).toHaveLength(1);
	});
	it("records both events when different kinds race on one dedup key", async () => {
		const { ctx } = await makeSqliteCtx();
		const input = (kind: "approved" | "declined") => ({
			provider: "foo",
			event: { kind, provider: "foo", orderId: "order-1", raw: null },
			dedupKey: "shared-status-key",
			rawBody: JSON.stringify({ kind }),
		});
		const results = await Promise.all([
			recordWebhookEvent(ctx, input("approved")),
			recordWebhookEvent(ctx, input("declined")),
		]);
		expect(results.map((result) => result.outcome)).toEqual(["inserted", "inserted"]);
		const rows = await ctx.context.adapter.findMany<StoredWebhookEvent>({
			model: "bnplWebhookEvent",
			where: [{ field: "provider", value: "foo" }],
		});
		expect(rows.map((row) => row.eventKind).sort()).toEqual(["approved", "declined"]);
	});
	it("still classifies an existing provider-owned legacy key for safe redelivery", async () => {
		const { ctx } = await makeSqliteCtx();
		await ctx.context.adapter.create({
			model: "bnplWebhookEvent",
			data: {
				provider: "foo",
				providerOrderId: "order-1",
				eventKind: "captured",
				eventType: "captured",
				dedupKey: "legacy-event",
				receivedAt: new Date(),
				status: "processed",
				attempts: 1,
				orderApplied: true,
			},
		});
		const result = await recordWebhookEvent(ctx, {
			provider: "foo",
			event: {
				kind: "captured",
				provider: "foo",
				orderId: "order-1",
				captureId: "capture-1",
				amountMinor: 100,
				currency: "SAR",
				raw: null,
			},
			dedupKey: "legacy-event",
			rawBody: "{}",
		});
		expect(result.outcome).toBe("duplicate");
	});
	it("reserves only one concurrent order mutation across cancel and capture", async () => {
		const { ctx, readRow } = await makeSqliteCtx();
		const outcomes = await Promise.allSettled([
			leavePending(ctx, "cancel", "cancel-once", { input: { amountMinor: 2500 } }),
			leavePending(ctx, "capture", "capture-once", { input: { amountMinor: 1000 } }),
		]);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
		const row = (await readRow()) as OrderRow & { moneyCommands: string };
		expect(JSON.parse(row.moneyCommands)).toHaveLength(1);
	});
	it("blocks changed references and every new mutation while another outcome is uncertain", async () => {
		const { ctx } = await makeSqliteCtx();
		await leavePending(ctx, "capture", "unknown");
		for (const operation of ["capture", "refund", "cancel", "void", "close", "authorise"] as const)
			await expect(leavePending(ctx, operation, "new-reference")).rejects.toMatchObject({
				status: "CONFLICT",
			});
	});
	it("releases a provider-rejected reservation so the next mutation can reserve", async () => {
		const { ctx, readRow } = await makeSqliteCtx();
		await expect(
			runMoneyCommand(
				ctx,
				{
					where: ORDER_WHERE,
					operation: "close",
					reference: "ord-sqlite",
					input: {},
					onPending: "verify",
					replay: (saved) => saved,
				},
				(command) =>
					command.send(async () => {
						throw new BnplProviderError("tabby", "only authorized payments can be closed", {
							status: 400,
							rejected: true,
						});
					}),
			),
		).rejects.toThrow("only authorized payments can be closed");
		const row = (await readRow()) as OrderRow & { moneyCommands: string };
		expect(JSON.parse(row.moneyCommands)).toEqual([]);
		await expect(leavePending(ctx, "capture", "next")).resolves.toEqual({});
	});
	it("retains the cancellation baseline across intervening balance changes and retries", async () => {
		const { ctx } = await makeSqliteCtx();
		const baselineSpec = { onPending: "verify", recordBaseline: true } as const;
		await leavePending(ctx, "cancel", "stable", baselineSpec);
		await mutateOrder(ctx, ORDER_WHERE, () => ({ canceledAmountMinor: 2500 }));
		const recovered = await runMoneyCommand(
			ctx,
			{
				where: ORDER_WHERE,
				operation: "cancel",
				reference: "stable",
				input: {},
				replay: (saved) => saved,
				...baselineSpec,
			},
			async (command) => ({ state: command.state, baseline: command.baseline }),
		);
		expect(recovered).toMatchObject({
			state: "pending",
			baseline: { capturedAmountMinor: 0, refundedAmountMinor: 0, canceledAmountMinor: 0 },
		});
	});
	it("frees a definitively rejected reference for one retry and keeps an uncertain one", async () => {
		const { ctx } = await makeSqliteCtx();
		const sendFailing = (error: unknown) =>
			runMoneyCommand(
				ctx,
				{
					where: ORDER_WHERE,
					operation: "capture",
					reference: "retryable",
					input: {},
					onPending: "conflict",
					replay: (saved) => saved,
				},
				(command) =>
					command.send(async () => {
						throw error;
					}),
			);
		const rejected = new BnplProviderError("tabby", "refused", { status: 400, rejected: true });
		await expect(sendFailing(rejected)).rejects.toBe(rejected);
		const uncertain = new BnplProviderError("tabby", "timed out");
		await expect(sendFailing(uncertain)).rejects.toBe(uncertain);
		await expect(sendFailing(rejected)).rejects.toMatchObject({ status: "CONFLICT" });
	});
	it("answers with the winner's saved result when another worker completed the command first", async () => {
		const { ctx, readRow } = await makeSqliteCtx();
		const result = await runMoneyCommand(
			ctx,
			{
				where: ORDER_WHERE,
				operation: "capture",
				reference: "raced",
				input: {},
				onPending: "conflict",
				replay: (saved) => saved,
			},
			async (command) => {
				await mutateOrder<OrderRecord>(ctx, ORDER_WHERE, (order) => ({
					moneyCommands: JSON.stringify(
						JSON.parse(String(order.moneyCommands)).map((entry: { key: string; hash: string }) => ({
							key: entry.key,
							hash: entry.hash,
							state: "completed",
							result: { captureId: "winner" },
						})),
					),
				}));
				return command.settle(() => ({
					response: { captureId: "loser" },
					patch: { capturedAmountMinor: 9999 },
				}));
			},
		);
		expect(result).toEqual({ captureId: "winner" });
		expect((await readRow()).capturedAmountMinor).toBe(0);
	});
	it("refuses to replay a completed command that reused the reference with other input", async () => {
		const { ctx } = await makeSqliteCtx();
		const outcome = runMoneyCommand(
			ctx,
			{
				where: ORDER_WHERE,
				operation: "refund",
				reference: "reused",
				input: { amountMinor: 10000 },
				onPending: "conflict",
				replay: (saved) => saved,
			},
			async (command) => {
				await mutateOrder<OrderRecord>(ctx, ORDER_WHERE, (order) => ({
					moneyCommands: JSON.stringify(
						JSON.parse(String(order.moneyCommands)).map((entry: { key: string }) => ({
							key: entry.key,
							hash: "different-input",
							state: "completed",
							result: { refundId: "other-command" },
						})),
					),
				}));
				return command.settle(() => ({ response: { refundId: "ours" } }));
			},
		);
		await expect(outcome).rejects.toMatchObject({ status: "CONFLICT" });
	});
	it("never resends a command whose earlier outcome is uncertain", async () => {
		const { ctx } = await makeSqliteCtx();
		await leavePending(ctx, "close", "once", { onPending: "verify" });
		const request = vi.fn(async () => ({}));
		await expect(
			runMoneyCommand(
				ctx,
				{
					where: ORDER_WHERE,
					operation: "close",
					reference: "once",
					input: {},
					onPending: "verify",
					replay: (saved) => saved,
				},
				(command) => command.send(request),
			),
		).rejects.toThrow(/must be verified/);
		expect(request).not.toHaveBeenCalled();
	});

	it("counts a provider operation once when two workers apply it concurrently", async () => {
		const { ctx, readRow } = await makeSqliteCtx();
		const provider = stubProvider("tabby");
		const apply = () =>
			mutateOrder<OrderRecord>(ctx, ORDER_WHERE, (current) =>
				applyMoneyOperation(current, provider, {
					kind: "captured",
					id: "shared",
					amountMinor: 4000,
				}),
			);
		const results = await Promise.all([apply(), apply()]);
		const row = (await readRow()) as OrderRow & { appliedOperations: string };
		expect(row.capturedAmountMinor).toBe(4000);
		expect(JSON.parse(row.appliedOperations)).toEqual(["tabby:captured:shared"]);
		expect(results.filter((result) => Object.keys(result.applied).length === 0)).toHaveLength(1);
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
	const checkoutData = (orderReferenceId: string) => ({
		userId: "buyer",
		provider: "tabby",
		orderReferenceId,
		status: "new" as const,
		amountMinor: 10000,
		currency: "SAR",
		capturedAmountMinor: 0,
		refundedAmountMinor: 0,
	});
	const countReference = (ctx: GenericEndpointContext, orderReferenceId: string) =>
		ctx.context.adapter.count({
			model: "bnplOrder",
			where: [{ field: "orderReferenceId", value: orderReferenceId }],
		});
	it("discards a rejected reservation and lets the reference be reserved again", async () => {
		const { ctx } = await makeSqliteCtx();
		const first = await reserveCheckoutOrder(ctx, checkoutData("rejected-checkout"), "hash");
		await discardRejectedCheckoutReservation(ctx, first.row, "hash");
		expect(await countReference(ctx, "rejected-checkout")).toBe(0);
		const second = await reserveCheckoutOrder(ctx, checkoutData("rejected-checkout"), "other");
		expect(second.reserved).toBe(true);
	});
	it("never discards a reservation that already recorded a provider result", async () => {
		const { ctx } = await makeSqliteCtx();
		const first = await reserveCheckoutOrder(ctx, checkoutData("settled-checkout"), "hash");
		await updateCheckoutAttempt(ctx, first.row, "hash", {
			result: {
				providerOrderId: "settled-order",
				providerCheckoutId: "settled-session",
				checkoutUrl: "https://provider.example/checkout",
				status: "new",
			},
		});
		await discardRejectedCheckoutReservation(ctx, first.row, "hash");
		expect(await countReference(ctx, "settled-checkout")).toBe(1);
	});
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
