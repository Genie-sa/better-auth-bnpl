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
