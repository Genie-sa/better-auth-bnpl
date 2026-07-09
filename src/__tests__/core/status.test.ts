import { describe, expect, it } from "vitest";
import {
	APPROVED_STATUSES,
	CANONICAL_STATUSES,
	TERMINAL_STATUSES,
	canTransition,
	deriveCapturedStatus,
	deriveRefundedStatus,
	isCanonicalStatus,
} from "../../core/status";
describe("canonical status", () => {
	it("includes all 12 canonical states", () => {
		expect(CANONICAL_STATUSES).toHaveLength(12);
		expect(CANONICAL_STATUSES).toContain("new");
		expect(CANONICAL_STATUSES).toContain("approved");
		expect(CANONICAL_STATUSES).toContain("authorised");
		expect(CANONICAL_STATUSES).toContain("partially_captured");
		expect(CANONICAL_STATUSES).toContain("fully_captured");
		expect(CANONICAL_STATUSES).toContain("partially_refunded");
		expect(CANONICAL_STATUSES).toContain("fully_refunded");
		expect(CANONICAL_STATUSES).toContain("closed");
	});
	describe("isCanonicalStatus", () => {
		it("narrows known statuses", () => {
			expect(isCanonicalStatus("authorised")).toBe(true);
			expect(isCanonicalStatus("fully_captured")).toBe(true);
		});
		it("rejects unknown values", () => {
			expect(isCanonicalStatus("AUTHORIZED")).toBe(false);
			expect(isCanonicalStatus("rejected")).toBe(false);
		});
	});
	describe("APPROVED_STATUSES", () => {
		it("contains approved + authorised — both signal customer agreed to pay", () => {
			expect(APPROVED_STATUSES.has("approved")).toBe(true);
			expect(APPROVED_STATUSES.has("authorised")).toBe(true);
			expect(APPROVED_STATUSES.has("new")).toBe(false);
		});
	});
	describe("TERMINAL_STATUSES", () => {
		it("includes states with no further transitions", () => {
			expect(TERMINAL_STATUSES.has("declined")).toBe(true);
			expect(TERMINAL_STATUSES.has("expired")).toBe(true);
			expect(TERMINAL_STATUSES.has("canceled")).toBe(true);
			expect(TERMINAL_STATUSES.has("fully_refunded")).toBe(true);
			expect(TERMINAL_STATUSES.has("closed")).toBe(true);
		});
		it("does not include intermediate states", () => {
			expect(TERMINAL_STATUSES.has("partially_captured")).toBe(false);
			expect(TERMINAL_STATUSES.has("authorised")).toBe(false);
		});
	});
	describe("deriveCapturedStatus", () => {
		it("returns fully_captured when cumulative >= total", () => {
			expect(deriveCapturedStatus({ totalAmountMinor: 10000, cumulativeMinor: 10000 })).toBe(
				"fully_captured",
			);
			expect(deriveCapturedStatus({ totalAmountMinor: 10000, cumulativeMinor: 12000 })).toBe(
				"fully_captured",
			);
		});
		it("returns partially_captured when cumulative < total", () => {
			expect(deriveCapturedStatus({ totalAmountMinor: 10000, cumulativeMinor: 5000 })).toBe(
				"partially_captured",
			);
		});
		it("falls back to partially_captured when total is unknown", () => {
			expect(deriveCapturedStatus({ totalAmountMinor: null, cumulativeMinor: 10000 })).toBe(
				"partially_captured",
			);
		});
	});
	describe("deriveRefundedStatus", () => {
		it("returns fully_refunded at parity", () => {
			expect(deriveRefundedStatus({ totalAmountMinor: 5000, cumulativeMinor: 5000 })).toBe(
				"fully_refunded",
			);
		});
		it("returns partially_refunded when below total", () => {
			expect(deriveRefundedStatus({ totalAmountMinor: 5000, cumulativeMinor: 1000 })).toBe(
				"partially_refunded",
			);
		});
	});
	describe("canTransition", () => {
		it("allows the forward lifecycle", () => {
			expect(canTransition("new", "authorised")).toBe(true);
			expect(canTransition("approved", "authorised")).toBe(true);
			expect(canTransition("authorised", "partially_captured")).toBe(true);
			expect(canTransition("authorised", "fully_captured")).toBe(true);
			expect(canTransition("partially_captured", "fully_captured")).toBe(true);
			expect(canTransition("fully_captured", "partially_refunded")).toBe(true);
			expect(canTransition("partially_refunded", "fully_refunded")).toBe(true);
			expect(canTransition("fully_captured", "fully_refunded")).toBe(true);
		});
		it("rejects regressions", () => {
			expect(canTransition("fully_captured", "authorised")).toBe(false);
			expect(canTransition("partially_captured", "authorised")).toBe(false);
			expect(canTransition("authorised", "approved")).toBe(false);
			expect(canTransition("fully_refunded", "fully_captured")).toBe(false);
		});
		it("allows self-transitions so re-applied events are not treated as regressions", () => {
			expect(canTransition("fully_captured", "fully_captured")).toBe(true);
			expect(canTransition("partially_captured", "partially_captured")).toBe(true);
		});
		it("keeps terminal states terminal", () => {
			for (const terminal of ["declined", "expired", "canceled"] as const) {
				expect(canTransition(terminal, "authorised")).toBe(false);
				expect(canTransition(terminal, "fully_captured")).toBe(false);
			}
		});
		it("never advances to the legacy `updated` status", () => {
			expect(canTransition("authorised", "updated")).toBe(false);
			expect(canTransition("fully_captured", "updated")).toBe(false);
		});
		it("is permissive from an unknown stored status but strict on unknown targets", () => {
			expect(canTransition("some-legacy-status", "fully_captured")).toBe(true);
			expect(canTransition("authorised", "not-a-real-status")).toBe(false);
		});
	});
});
