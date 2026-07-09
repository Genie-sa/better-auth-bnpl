import { describe, expect, it } from "vitest";
import {
	BNPL_CURRENCIES,
	BnplMoneyParseError,
	CURRENCY_MINOR_UNIT_EXPONENT,
	extractMinorAmount,
	formatAmount,
	isBnplCurrency,
	parseAmount,
} from "../../core/money";
import { moneySchema } from "../../plugins/shared";
import { silentLogger } from "../_harness";
describe("BNPL money", () => {
	it("covers all five GCC currencies with correct minor-unit exponents", () => {
		expect(BNPL_CURRENCIES).toEqual(["SAR", "AED", "KWD", "BHD", "OMR"]);
		expect(CURRENCY_MINOR_UNIT_EXPONENT).toEqual({
			SAR: 2,
			AED: 2,
			KWD: 3,
			BHD: 3,
			OMR: 3,
		});
	});
	describe("parseAmount", () => {
		it("parses 2-decimal SAR strings", () => {
			expect(parseAmount({ amount: "100", currency: "SAR" })).toBe(10000);
			expect(parseAmount({ amount: "99.99", currency: "SAR" })).toBe(9999);
			expect(parseAmount({ amount: "0.50", currency: "SAR" })).toBe(50);
			expect(parseAmount({ amount: "0", currency: "SAR" })).toBe(0);
		});
		it("parses 3-decimal KWD strings", () => {
			expect(parseAmount({ amount: "100.000", currency: "KWD" })).toBe(100000);
			expect(parseAmount({ amount: "10.123", currency: "KWD" })).toBe(10123);
			expect(parseAmount({ amount: "0.001", currency: "KWD" })).toBe(1);
		});
		it("accepts numbers as well as strings", () => {
			expect(parseAmount({ amount: 99.99, currency: "SAR" })).toBe(9999);
			expect(parseAmount({ amount: 100, currency: "AED" })).toBe(10000);
		});
		it("rejects locale-formatted strings", () => {
			expect(() => parseAmount({ amount: "1,000.00", currency: "SAR" })).toThrow(
				BnplMoneyParseError,
			);
		});
		it("rejects too many decimals for SAR", () => {
			expect(() => parseAmount({ amount: "99.999", currency: "SAR" })).toThrow(BnplMoneyParseError);
		});
		it("rejects unknown currencies", () => {
			expect(() => parseAmount({ amount: "100", currency: "USD" })).toThrow(
				/Unsupported BNPL currency/,
			);
		});
		it("rejects negative amounts", () => {
			expect(() => parseAmount({ amount: -1, currency: "SAR" })).toThrow(BnplMoneyParseError);
		});
		it("rejects NaN/Infinity", () => {
			expect(() => parseAmount({ amount: Number.NaN, currency: "SAR" })).toThrow(
				BnplMoneyParseError,
			);
			expect(() => parseAmount({ amount: Number.POSITIVE_INFINITY, currency: "SAR" })).toThrow();
		});
		it("guards against float drift exceeding the currency exponent", () => {
			expect(() => parseAmount({ amount: 1.005, currency: "SAR" })).toThrow(/decimal/);
		});
		it("rejects scientific notation strings", () => {
			expect(() => parseAmount({ amount: "1e3", currency: "SAR" })).toThrow(BnplMoneyParseError);
		});
		describe("safe-integer overflow guard", () => {
			const LARGEST_SAFE_SAR_STRING = "90071992547409.91";
			it("accepts the largest value whose minor units are still a safe integer", () => {
				expect(parseAmount({ amount: LARGEST_SAFE_SAR_STRING, currency: "SAR" })).toBe(
					Number.MAX_SAFE_INTEGER,
				);
				expect(Number.isSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
			});
			it("rejects one order of magnitude above the safe boundary (string path)", () => {
				expect(() => parseAmount({ amount: "900719925474090.91", currency: "SAR" })).toThrow(
					BnplMoneyParseError,
				);
				try {
					parseAmount({ amount: "900719925474090.91", currency: "SAR" });
				} catch (e) {
					expect(e).toBeInstanceOf(BnplMoneyParseError);
					if (e instanceof BnplMoneyParseError) expect(e.code).toBe("AMOUNT_TOO_LARGE");
				}
			});
			it("rejects the huge decimal string from the security report", () => {
				try {
					parseAmount({ amount: "99999999999999999999.00", currency: "SAR" });
					throw new Error("expected parseAmount to throw");
				} catch (e) {
					expect(e).toBeInstanceOf(BnplMoneyParseError);
					if (e instanceof BnplMoneyParseError) expect(e.code).toBe("AMOUNT_TOO_LARGE");
				}
			});
			it("rejects number-path overflow before precision loss", () => {
				try {
					parseAmount({ amount: 1e21, currency: "SAR" });
					throw new Error("expected parseAmount to throw");
				} catch (e) {
					expect(e).toBeInstanceOf(BnplMoneyParseError);
					if (e instanceof BnplMoneyParseError) expect(e.code).toBe("AMOUNT_TOO_LARGE");
				}
			});
		});
	});
	describe("formatAmount", () => {
		it("round-trips through parseAmount for SAR", () => {
			expect(formatAmount(9999, "SAR")).toEqual({ amount: "99.99", currency: "SAR" });
			expect(formatAmount(0, "SAR")).toEqual({ amount: "0.00", currency: "SAR" });
		});
		it("renders KWD with 3 decimals", () => {
			expect(formatAmount(10123, "KWD")).toEqual({ amount: "10.123", currency: "KWD" });
		});
		it("rejects non-integer minor units", () => {
			expect(() => formatAmount(99.5, "SAR")).toThrow(BnplMoneyParseError);
		});
	});
	describe("isBnplCurrency", () => {
		it("narrows to BnplCurrency for known values", () => {
			expect(isBnplCurrency("SAR")).toBe(true);
			expect(isBnplCurrency("USD")).toBe(false);
		});
	});
	describe("extractMinorAmount", () => {
		it("returns null for missing key", () => {
			expect(extractMinorAmount({}, "captured_amount", "SAR", silentLogger)).toBeNull();
		});
		it("extracts a valid amount with currency match", () => {
			const data = { captured_amount: { amount: "50", currency: "SAR" } };
			expect(extractMinorAmount(data, "captured_amount", "SAR", silentLogger)).toBe(5000);
		});
		it("returns null when currency mismatches", () => {
			const data = { captured_amount: { amount: "50", currency: "AED" } };
			expect(extractMinorAmount(data, "captured_amount", "SAR", silentLogger)).toBeNull();
		});
		it("returns null on parse failure", () => {
			const data = { captured_amount: { amount: "not-a-number", currency: "SAR" } };
			expect(extractMinorAmount(data, "captured_amount", "SAR", silentLogger)).toBeNull();
		});
	});
	describe("moneySchema wire validation", () => {
		it("accepts canonical decimal strings", () => {
			expect(moneySchema.parse({ amount: "100.00", currency: "SAR" })).toEqual({
				amount: "100.00",
				currency: "SAR",
			});
			expect(moneySchema.parse({ amount: "0", currency: "AED" }).amount).toBe("0");
			expect(moneySchema.parse({ amount: "10.123", currency: "KWD" }).amount).toBe("10.123");
		});
		it("coerces finite numbers to canonical decimal strings", () => {
			expect(moneySchema.parse({ amount: 100, currency: "SAR" }).amount).toBe("100");
			expect(moneySchema.parse({ amount: 99.99, currency: "SAR" }).amount).toBe("99.99");
		});
		it("rejects non-numeric garbage strings", () => {
			expect(moneySchema.safeParse({ amount: "abc", currency: "SAR" }).success).toBe(false);
		});
		it("rejects locale-formatted and signed strings", () => {
			expect(moneySchema.safeParse({ amount: "1,000.00", currency: "SAR" }).success).toBe(false);
			expect(moneySchema.safeParse({ amount: "-5.00", currency: "SAR" }).success).toBe(false);
		});
		it("rejects scientific notation, including huge numbers stringified to 1e+21", () => {
			expect(moneySchema.safeParse({ amount: "1e3", currency: "SAR" }).success).toBe(false);
			expect(moneySchema.safeParse({ amount: 1e21, currency: "SAR" }).success).toBe(false);
		});
		it("rejects unknown currencies", () => {
			expect(moneySchema.safeParse({ amount: "100.00", currency: "USD" }).success).toBe(false);
		});
	});
});
