import { APIError } from "better-auth/api";
import { BNPL_ERROR_CODES } from "../core/errors";
import type { BnplOptions } from "../plugin-types";
export function assertPersistedOrders(options: BnplOptions): void {
	if (!options.persistOrders) {
		throw new APIError("NOT_IMPLEMENTED", {
			message: BNPL_ERROR_CODES.LIST_REQUIRES_PERSISTENCE.message,
			code: "LIST_REQUIRES_PERSISTENCE",
		});
	}
}
