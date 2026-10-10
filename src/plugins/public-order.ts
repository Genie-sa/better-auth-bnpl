export interface PrivateOrderFields {
	rawData?: string | null;
	appliedOperations?: string | null;
	webhookTransitions?: string | null;
	checkoutAttempt?: string | null;
	moneyCommands?: string | null;
}

export function publicOrder<Row extends PrivateOrderFields>(
	row: Row,
): Omit<Row, keyof PrivateOrderFields> {
	const {
		rawData: _raw,
		appliedOperations: _operations,
		webhookTransitions: _transitions,
		moneyCommands: _commands,
		checkoutAttempt: _checkout,
		...result
	} = row;
	return result;
}
