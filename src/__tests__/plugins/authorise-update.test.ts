import { describe, expect, it } from "vitest";
import { buildAuthoriseOrderUpdate } from "../../plugins/authorise-update";

describe("authorisation response persistence", () => {
	it("preserves a refund committed while the authorisation request was in flight", () => {
		const result = buildAuthoriseOrderUpdate(
			{ providerOrderId: "order-1", status: "authorised", raw: {} },
			{ status: "fully_refunded", amountMinor: 10000, capturedAmountMinor: 10000 },
		);
		expect(result.update.status).toBe("fully_refunded");
		expect(result.update.capturedAmountMinor).toBeUndefined();
	});
});
