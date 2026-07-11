import { describe, expect, it } from "vitest";
import { operationReference } from "../../plugins/operation-reference";

describe("operationReference", () => {
	it("builds a new capture reference from zero", () => {
		expect(
			operationReference(
				{ provider: "tabby", providerOrderId: "order-1", capturedAmountMinor: 0 },
				"capture",
				10000,
			),
		).toBe("bnpl:tabby:order-1:capture:10000");
	});

	it("builds a partial capture reference from the cumulative amount", () => {
		expect(
			operationReference(
				{ provider: "tabby", providerOrderId: "order-1", capturedAmountMinor: 2500 },
				"capture",
				7500,
			),
		).toBe("bnpl:tabby:order-1:capture:10000");
	});

	it.each([null, undefined])("treats a %s counter as zero", (capturedAmountMinor) => {
		expect(
			operationReference(
				{ provider: "tabby", providerOrderId: "order-1", capturedAmountMinor },
				"capture",
				10000,
			),
		).toBe("bnpl:tabby:order-1:capture:10000");
	});

	it("uses the refunded counter for refund references", () => {
		expect(
			operationReference(
				{
					provider: "tabby",
					providerOrderId: "order-1",
					capturedAmountMinor: 9000,
					refundedAmountMinor: 2500,
				},
				"refund",
				1000,
			),
		).toBe("bnpl:tabby:order-1:refund:3500");
	});

	it("includes the provider and provider order ID", () => {
		expect(
			operationReference({ provider: "tamara", providerOrderId: "order-2" }, "capture", 10000),
		).toBe("bnpl:tamara:order-2:capture:10000");
	});
});
