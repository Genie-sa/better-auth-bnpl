import { describe, expect, it } from "vitest";
import { type LedgerOperation, ledgerKey } from "../../core/ledger";
import { tabby } from "../../providers/tabby";
import { tamara } from "../../providers/tamara";
import { stubProvider } from "../_harness";

const providers = {
	tabby: tabby({
		secretKey: "sk_test_example",
		merchantCode: "merchant",
		webhookHeader: { name: "X-Auth", value: "secret" },
	}),
	tamara: tamara({ apiToken: "token", notificationToken: "notification" }),
	custom: stubProvider("custom"),
};
const operation = (kind: LedgerOperation["kind"]): LedgerOperation => ({
	kind,
	id: "op-1",
	orderId: "order-1",
	amountMinor: 2500,
	currency: "SAR",
});

describe("ledgerKey keeps persisted operation identities byte-stable", () => {
	it.each([
		["tabby", "captured", "tabby:captured:op-1"],
		["tabby", "refunded", "tabby:refunded:op-1"],
		["tabby", "canceled", "tabby:cancel:op-1"],
		["tamara", "captured", "tamara:order_captured:op-1"],
		["tamara", "refunded", "tamara:order_refunded:op-1"],
		["tamara", "canceled", "tamara:cancel:op-1"],
		["custom", "captured", "custom:captured:op-1"],
		["custom", "refunded", "custom:refunded:op-1"],
		["custom", "canceled", "custom:cancel:op-1"],
	] as const)("%s %s → %s", (provider, kind, expected) => {
		expect(ledgerKey(providers[provider], operation(kind))).toBe(expected);
	});

	it("ignores amount and currency so a replayed operation keeps its identity", () => {
		const first = ledgerKey(providers.tamara, operation("captured"));
		const replay = ledgerKey(providers.tamara, {
			...operation("captured"),
			amountMinor: 1,
			currency: "AED",
		});
		expect(replay).toBe(first);
	});
});
