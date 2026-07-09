import { createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { BNPL_ERROR_CODES } from "../core/errors";
import type { BnplProvider } from "../core/provider";
import type { AbsoluteUrl } from "../core/url";
import type { BnplOptions } from "../plugin-types";
import { moneySchema } from "./shared";
const optionsBodySchema = z.object({
	country: z.string().min(2).max(2),
	amount: moneySchema,
	email: z.string().email().optional(),
	phone: z.string().optional(),
	isVip: z.boolean().optional(),
});
export type OptionsBodyInput = z.input<typeof optionsBodySchema>;
export interface OptionsSubpluginOptions {
	authenticatedOnly?: boolean;
}
export interface BnplProviderOption {
	id: string;
	displayName: string;
	logoUrl?: AbsoluteUrl;
	tagline?: string;
	available: boolean;
	reason?: string;
	availablePaymentTypes?: Array<{
		paymentType: string;
		instalments?: number;
		descriptionEn?: string;
		descriptionAr?: string;
	}>;
	capabilities: {
		separateAuthorise: boolean;
		partialCapture: boolean;
		partialRefund: boolean;
		multipleCaptures: boolean;
	};
}
function cloneProviderOption(option: BnplProviderOption): BnplProviderOption {
	return {
		...option,
		availablePaymentTypes: option.availablePaymentTypes?.map((paymentType) => ({ ...paymentType })),
		capabilities: { ...option.capabilities },
	};
}
export const options = (subOptions: OptionsSubpluginOptions = {}) => {
	return (providers: Record<string, BnplProvider>, _options: BnplOptions) => ({
		bnplOptions: createAuthEndpoint(
			"/bnpl/options",
			{ method: "POST", body: optionsBodySchema },
			async (ctx) => {
				if (subOptions.authenticatedOnly) {
					const session = await getSessionFromCtx(ctx);
					if (!session?.user?.id) {
						throw new APIError("UNAUTHORIZED", {
							message: BNPL_ERROR_CODES.AUTH_REQUIRED.message,
							code: "AUTH_REQUIRED",
						});
					}
				}
				const country = ctx.body.country.toUpperCase();
				const amount = ctx.body.amount;
				const email = ctx.body.email;
				const phone = ctx.body.phone;
				const isVip = ctx.body.isVip;
				const logger = ctx.context.logger;
				const entries = Object.entries(providers);
				const results = await Promise.all(
					entries.map(async ([id, provider]): Promise<BnplProviderOption> => {
						const baseInfo = {
							id,
							displayName: provider.display.displayName,
							logoUrl: provider.display.logoUrl,
							tagline: provider.display.tagline,
							capabilities: {
								separateAuthorise: provider.capabilities.separateAuthorise,
								partialCapture: provider.capabilities.partialCapture,
								partialRefund: provider.capabilities.partialRefund,
								multipleCaptures: provider.capabilities.multipleCaptures,
							},
						};
						if (!provider.supportedCountries.includes(country)) {
							return { ...baseInfo, available: false, reason: "country_not_supported" };
						}
						if (!provider.supportedCurrencies.includes(amount.currency)) {
							return { ...baseInfo, available: false, reason: "currency_not_supported" };
						}
						try {
							const result = await provider.preCheck(
								{ countryCode: country, amount, email, phone, isVip },
								{ logger },
							);
							return {
								...baseInfo,
								available: result.available,
								reason: result.reason,
								availablePaymentTypes: result.availablePaymentTypes,
							};
						} catch (e) {
							logger.warn(`bnpl: ${id} preCheck failed: ${e instanceof Error ? e.message : e}`);
							return { ...baseInfo, available: false, reason: "precheck_failed" };
						}
					}),
				);
				const available = results.filter((r) => r.available).map(cloneProviderOption);
				const unavailable = results.filter((r) => !r.available).map(cloneProviderOption);
				return ctx.json({ options: results, available, unavailable });
			},
		),
	});
};
