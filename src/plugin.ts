import type { BetterAuthPlugin } from "better-auth";
import { BNPL_ERROR_CODES } from "./core/errors";
import type { BnplProvider } from "./core/provider";
import type {
	BnplPersistedOrder,
	BnplPersistedOrderWithRemote,
	BnplWebhookEvent,
} from "./core/types";
import type { BnplEndpointRecord, BnplEndpoints, BnplOptions, BnplSubPlugin } from "./plugin-types";
import { bnplSchema } from "./schema";
export type BnplComposedEndpoints = BnplEndpointRecord;
type MatchingProviderIds<Providers extends Record<string, BnplProvider>> = {
	[Id in keyof Providers]: Providers[Id] extends BnplProvider<Id & string> ? Providers[Id] : never;
};
function composeSubPluginEndpoints<
	Providers extends Record<string, BnplProvider>,
	Subs extends readonly BnplSubPlugin[],
>(options: BnplOptions<Providers, Subs>): BnplEndpoints<Subs> {
	const acc: BnplEndpointRecord = {};
	for (const sub of options.use) {
		Object.assign(acc, sub(options.providers, options));
	}
	return acc as BnplEndpoints<Subs>;
}
function assertProviderMap<Providers extends Record<string, BnplProvider>>(
	providers: Providers,
): void {
	for (const [key, provider] of Object.entries(providers)) {
		if (provider.id !== key) {
			throw new Error(
				`bnpl: provider map key \`${key}\` must match provider.id \`${provider.id}\`. Use one configured provider instance per provider id.`,
			);
		}
	}
}
export function BnplProviders<const Providers extends Record<string, BnplProvider>>(
	providers: Providers & MatchingProviderIds<Providers>,
): Providers {
	return providers;
}
export const bnpl = <
	Providers extends Record<string, BnplProvider>,
	const Subs extends readonly BnplSubPlugin[],
>(
	options: BnplOptions<Providers, Subs>,
) => {
	const providerIds = Object.keys(options.providers);
	if (providerIds.length === 0) {
		throw new Error("bnpl: at least one provider must be configured");
	}
	assertProviderMap(options.providers);
	const endpoints = composeSubPluginEndpoints(options);
	return {
		id: "bnpl",
		init(ctx) {
			if (options.captureOnAuthorise && !options.persistOrders) {
				ctx.logger.warn(
					"bnpl: `captureOnAuthorise` requires `persistOrders: true` — auto-capture will be skipped",
				);
			}
			if (options.captureOnAuthorise && !options.captureOnAuthoriseShippingInfo) {
				ctx.logger.warn(
					"bnpl: `captureOnAuthorise` without `captureOnAuthoriseShippingInfo` — providers that require shipping provenance (Tamara) will skip auto-capture",
				);
			}
			ctx.logger.info(`bnpl: configured providers — ${providerIds.join(", ")}`);
		},
		options,
		$Infer: {
			BnplOrder: {} as BnplPersistedOrder,
			BnplOrderWithRemote: {} as BnplPersistedOrderWithRemote,
			BnplWebhookEvent: {} as BnplWebhookEvent,
		},
		endpoints,
		schema: options.persistOrders ? bnplSchema : undefined,
		$ERROR_CODES: BNPL_ERROR_CODES,
		rateLimit: [
			{
				window: 60,
				max: 10,
				pathMatcher: (path: string) => path === "/bnpl/checkout",
			},
			{
				window: 60,
				max: 30,
				pathMatcher: (path: string) => path === "/bnpl/options",
			},
			{
				window: 60,
				max: 120,
				pathMatcher: (path: string) => path.startsWith("/bnpl/webhooks/"),
			},
			{
				window: 60,
				max: 30,
				pathMatcher: (path: string) => path.startsWith("/bnpl/admin/"),
			},
		],
	} satisfies BetterAuthPlugin;
};
export type BnplPlugin = ReturnType<typeof bnpl>;
export type ProviderIdsOf<P extends Record<string, BnplProvider>> = keyof P & string;
