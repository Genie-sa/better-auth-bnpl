import { describe, expect, it } from "vitest";
import {
	BnplPluginError,
	BnplProviderError,
	isDefinitiveRejection,
	rejectedBeforeDispatch,
} from "../../core/errors";
import { BnplMoneyParseError } from "../../core/money";

const providerError = (status?: number, body?: unknown, rejected?: boolean) =>
	new BnplProviderError("tabby", "failed", { status, body, rejected });

describe("isDefinitiveRejection", () => {
	it.each([
		[
			"a plugin error marked rejected",
			new BnplPluginError("INVALID_AMOUNT", undefined, undefined, { rejected: true }),
		],
		["a provider error marked rejected", providerError(400, undefined, true)],
		["a statusless provider error marked rejected", providerError(undefined, undefined, true)],
		["a failure before dispatch", rejectedBeforeDispatch("tabby", new Error("read failed"))],
	])("accepts %s", (_label, error) => {
		expect(isDefinitiveRejection(error)).toBe(true);
	});

	it.each([
		["an unmarked plugin error", new BnplPluginError("INVALID_AMOUNT")],
		["an unmarked 400", providerError(400)],
		["an unmarked 409", providerError(409, { message: "PaymentRefundError" })],
		["a 503", providerError(503)],
		["a statusless provider error", providerError()],
		["a plain error", new Error("network")],
		["a non-error value", "timeout"],
	])("keeps %s uncertain", (_label, error) => {
		expect(isDefinitiveRejection(error)).toBe(false);
	});
});

describe("errors from another bundled copy of the package", () => {
	it.each(["BnplPluginError", "BnplProviderError"] as const)(
		"recognises a %s created by a separately loaded module instance",
		async (name) => {
			const copy = (await import(
				/* @vite-ignore */ `../../core/errors.ts?copy=${name}`
			)) as typeof import("../../core/errors");
			const foreign =
				name === "BnplPluginError"
					? new copy.BnplPluginError("INVALID_AMOUNT", undefined, undefined, { rejected: true })
					: new copy.BnplProviderError("tabby", "refused", { status: 400, rejected: true });
			expect(copy.BnplProviderError).not.toBe(BnplProviderError);
			expect(foreign).toBeInstanceOf(
				name === "BnplPluginError" ? BnplPluginError : BnplProviderError,
			);
			expect(foreign).not.toBeInstanceOf(
				name === "BnplPluginError" ? BnplProviderError : BnplPluginError,
			);
			expect(isDefinitiveRejection(foreign)).toBe(true);
		},
	);
	it("recognises a money parse error created by a separately loaded module instance", async () => {
		const copyPath = "../../core/money.ts?copy=money";
		const copy = (await import(/* @vite-ignore */ copyPath)) as typeof import("../../core/money");
		expect(() => copy.parseAmount({ amount: "1.2345", currency: "SAR" })).toThrow(
			BnplMoneyParseError,
		);
	});
});

describe("subclasses of the branded errors", () => {
	class DeclinedError extends BnplProviderError {}
	it("keep ordinary prototype semantics", () => {
		const declined = new DeclinedError("tabby", "declined", { status: 400 });
		expect(declined).toBeInstanceOf(DeclinedError);
		expect(declined).toBeInstanceOf(BnplProviderError);
		expect(new BnplProviderError("tabby", "timeout")).not.toBeInstanceOf(DeclinedError);
	});
});
