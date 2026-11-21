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
	it("derives the capture status when an auto-captured response still reports authorised", () => {
		const result = buildAuthoriseOrderUpdate(
			{
				providerOrderId: "order-1",
				status: "authorised",
				autoCaptured: true,
				captureId: "capture-1",
				capturedAmountMinor: 10000,
				raw: {},
			},
			{ status: "approved", amountMinor: 10000, capturedAmountMinor: 0 },
		);
		expect(result.update).toMatchObject({ status: "fully_captured", capturedAmountMinor: 10000 });
	});
	it("derives a partial capture against the uncanceled balance", () => {
		const result = buildAuthoriseOrderUpdate(
			{ providerOrderId: "order-1", status: "authorised", capturedAmountMinor: 5000, raw: {} },
			{ status: "approved", amountMinor: 10000, canceledAmountMinor: 2500, capturedAmountMinor: 0 },
		);
		expect(result.update.status).toBe("partially_captured");
	});
	it("keeps the authorised status when the response reports a zero capture", () => {
		const result = buildAuthoriseOrderUpdate(
			{ providerOrderId: "order-1", status: "authorised", capturedAmountMinor: 0, raw: {} },
			{ status: "approved", amountMinor: 10000, capturedAmountMinor: 0 },
		);
		expect(result.update.status).toBe("authorised");
		expect(result.update.capturedAt).toBeUndefined();
	});
});
