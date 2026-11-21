export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isMoneyLike(value: unknown): value is {
	amount: number | string;
	currency: string;
} {
	if (!isRecord(value)) return false;
	const amount = value.amount;
	const currency = value.currency;
	return (typeof amount === "string" || typeof amount === "number") && typeof currency === "string";
}
export function readStringField(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const v = value[key];
	return typeof v === "string" ? v : undefined;
}
export function isOneOf<const T extends readonly string[]>(
	value: unknown,
	options: T,
): value is T[number] {
	if (typeof value !== "string") return false;
	for (const opt of options) {
		if (opt === value) return true;
	}
	return false;
}

/**
 * Marks an instance with a registered symbol so `instanceof` also recognises instances created by
 * another bundled copy of this package, such as the separate provider entry points or a CJS copy.
 */
export function brandInstance(instance: object, brand: symbol): void {
	Object.defineProperty(instance, brand, { value: true });
}
export function hasBrand(value: unknown, brand: symbol): boolean {
	return typeof value === "object" && value !== null && Reflect.get(value, brand) === true;
}

/**
 * Makes `instanceof base` recognise instances branded by any bundled copy of the package, while
 * subclasses keep ordinary prototype checks.
 */
export function recogniseBrand(
	base: abstract new (...args: never[]) => unknown,
	brand: symbol,
): void {
	Object.defineProperty(base, Symbol.hasInstance, {
		value(this: unknown, value: unknown): boolean {
			return this === base
				? hasBrand(value, brand)
				: Function.prototype[Symbol.hasInstance].call(this, value);
		},
	});
}
