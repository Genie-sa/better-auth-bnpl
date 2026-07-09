import { isRecord } from "./guards";
import type { BnplMoney } from "./types";
export const BNPL_CURRENCIES = ["SAR", "AED", "KWD", "BHD", "OMR"] as const;
export type BnplCurrency = (typeof BNPL_CURRENCIES)[number];
export const CURRENCY_MINOR_UNIT_EXPONENT = {
	SAR: 2,
	AED: 2,
	KWD: 3,
	BHD: 3,
	OMR: 3,
} as const satisfies Record<BnplCurrency, number>;
export const DECIMAL_PATTERN = /^\d+(\.\d{1,3})?$/;
export type BnplMoneyParseErrorCode =
	| "INVALID_FORMAT"
	| "UNKNOWN_CURRENCY"
	| "TOO_MANY_DECIMALS"
	| "AMOUNT_TOO_LARGE";
export class BnplMoneyParseError extends Error {
	readonly code: BnplMoneyParseErrorCode;
	readonly input: unknown;
	constructor(code: BnplMoneyParseErrorCode, message: string, input: unknown) {
		super(message);
		this.name = "BnplMoneyParseError";
		this.code = code;
		this.input = input;
	}
}
export const isBnplCurrency = (currency: string): currency is BnplCurrency =>
	Object.hasOwn(CURRENCY_MINOR_UNIT_EXPONENT, currency);
export function parseAmount(money: {
	amount: number | string;
	currency: string;
}): number {
	if (!isBnplCurrency(money.currency)) {
		throw new BnplMoneyParseError(
			"UNKNOWN_CURRENCY",
			`Unsupported BNPL currency: ${money.currency}`,
			money.currency,
		);
	}
	const exponent = CURRENCY_MINOR_UNIT_EXPONENT[money.currency];
	const multiplier = 10 ** exponent;
	if (typeof money.amount === "number") {
		if (!Number.isFinite(money.amount) || money.amount < 0) {
			throw new BnplMoneyParseError(
				"INVALID_FORMAT",
				`Amount must be a finite non-negative number, got ${money.amount}`,
				money.amount,
			);
		}
		const minor = Math.round(money.amount * multiplier);
		if (!Number.isSafeInteger(minor)) {
			throw new BnplMoneyParseError(
				"AMOUNT_TOO_LARGE",
				`Amount ${money.amount} in minor units exceeds the safe-integer range for ${money.currency}`,
				money.amount,
			);
		}
		const roundTrip = minor / multiplier;
		if (Math.abs(roundTrip - money.amount) > 1e-9) {
			throw new BnplMoneyParseError(
				"TOO_MANY_DECIMALS",
				`Amount ${money.amount} exceeds ${exponent}-decimal precision for ${money.currency}`,
				money.amount,
			);
		}
		return minor;
	}
	if (typeof money.amount !== "string" || !DECIMAL_PATTERN.test(money.amount)) {
		throw new BnplMoneyParseError(
			"INVALID_FORMAT",
			`Amount ${JSON.stringify(money.amount)} is not a valid decimal string`,
			money.amount,
		);
	}
	const [wholeStr, fraction = ""] = money.amount.split(".");
	const whole = wholeStr ?? "0";
	if (fraction.length > exponent) {
		throw new BnplMoneyParseError(
			"TOO_MANY_DECIMALS",
			`Amount ${money.amount} has ${fraction.length} decimals, but ${money.currency} supports ${exponent}`,
			money.amount,
		);
	}
	const paddedFraction = fraction.padEnd(exponent, "0");
	const minor =
		Number.parseInt(whole, 10) * multiplier + Number.parseInt(paddedFraction || "0", 10);
	if (!Number.isSafeInteger(minor)) {
		throw new BnplMoneyParseError(
			"AMOUNT_TOO_LARGE",
			`Amount ${money.amount} in minor units exceeds the safe-integer range for ${money.currency}`,
			money.amount,
		);
	}
	return minor;
}
export function formatAmount(minor: number, currency: string): BnplMoney {
	if (!isBnplCurrency(currency)) {
		throw new BnplMoneyParseError(
			"UNKNOWN_CURRENCY",
			`Unsupported BNPL currency: ${currency}`,
			currency,
		);
	}
	if (!Number.isInteger(minor) || minor < 0) {
		throw new BnplMoneyParseError(
			"INVALID_FORMAT",
			`Minor-unit amount must be a non-negative integer, got ${minor}`,
			minor,
		);
	}
	const exponent = CURRENCY_MINOR_UNIT_EXPONENT[currency];
	const multiplier = 10 ** exponent;
	const whole = Math.trunc(minor / multiplier);
	const fraction = minor % multiplier;
	return {
		amount: `${whole}.${String(fraction).padStart(exponent, "0")}`,
		currency,
	};
}
export function extractMinorAmount(
	data: unknown,
	key: string,
	expectedCurrency: string,
	logger: {
		warn: (msg: string) => void;
	},
): number | null {
	if (!isRecord(data)) return null;
	const value = data[key];
	if (!isRecord(value)) return null;
	const currency = value.currency;
	if (typeof currency !== "string") {
		logger.warn(`bnpl: ${key} has no currency — skipping`);
		return null;
	}
	if (currency !== expectedCurrency) {
		logger.warn(
			`bnpl: ${key} currency ${currency} differs from order currency ${expectedCurrency} — skipping`,
		);
		return null;
	}
	const amount = value.amount;
	if (amount === undefined) return null;
	if (typeof amount !== "string" && typeof amount !== "number") return null;
	try {
		return parseAmount({ amount, currency });
	} catch (e) {
		logger.warn(`bnpl: ${key} parse failed: ${e instanceof Error ? e.message : e}`);
		return null;
	}
}
