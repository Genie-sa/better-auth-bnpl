import { BnplPluginError } from "./core/errors";
import type {
	BnplProvider,
	ProviderCancelArgs,
	ProviderCaptureArgs,
	ProviderContext,
	ProviderLogger,
	ProviderRefundArgs,
} from "./core/provider";
import type {
	BnplAuthorizeResult,
	BnplCancelArgs,
	BnplCaptureArgs,
	BnplCaptureResult,
	BnplCheckoutInput,
	BnplCheckoutResult,
	BnplOrderState,
	BnplPreCheckInput,
	BnplPreCheckResult,
	BnplRefundArgs,
	BnplRefundResult,
} from "./core/types";
const DEFAULT_LOGGER: ProviderLogger = {
	info: () => undefined,
	warn: (msg) => console.warn(`[bnpl] ${msg}`),
	error: (msg) => console.error(`[bnpl] ${msg}`),
};
export interface CreateBnplClientOptions<Providers extends Record<string, BnplProvider>> {
	providers: Providers;
	logger?: ProviderLogger;
}
type ProviderId<P extends Record<string, BnplProvider>> = keyof P & string;
type OperationArg<Args> = Record<string, never> extends Args ? [args?: Args] : [args: Args];
interface ProviderNamespace<Provider extends BnplProvider = BnplProvider> {
	createCheckout: (input: BnplCheckoutInput) => Promise<BnplCheckoutResult>;
	fetchOrder: (providerOrderId: string) => Promise<BnplOrderState>;
	capture: (
		providerOrderId: string,
		args: ProviderCaptureArgs<Provider>,
	) => Promise<BnplCaptureResult>;
	refund: (
		providerOrderId: string,
		args: ProviderRefundArgs<Provider>,
	) => Promise<BnplRefundResult>;
	cancel: (
		providerOrderId: string,
		...args: OperationArg<ProviderCancelArgs<Provider>>
	) => Promise<void>;
	preCheck: (input: BnplPreCheckInput) => Promise<BnplPreCheckResult>;
	authorize?: (providerOrderId: string) => Promise<BnplAuthorizeResult>;
	voidCheckout?: (checkoutId: string, providerOrderId: string) => Promise<void>;
	closePayment?: (providerPaymentId: string) => Promise<void>;
}
interface OptionsResultEntry<Id extends string> {
	id: Id;
	displayName: string;
	available: boolean;
	reason?: string;
	availablePaymentTypes?: BnplPreCheckResult["availablePaymentTypes"];
}
export type BnplServerClient<Providers extends Record<string, BnplProvider>> = {
	[Id in ProviderId<Providers>]: ProviderNamespace<Providers[Id]>;
} & {
	options: (input: BnplPreCheckInput) => Promise<Array<OptionsResultEntry<ProviderId<Providers>>>>;
	createCheckout: (
		providerId: ProviderId<Providers>,
		input: BnplCheckoutInput,
	) => Promise<BnplCheckoutResult>;
	fetchOrder: (
		providerId: ProviderId<Providers>,
		providerOrderId: string,
	) => Promise<BnplOrderState>;
	capture: <Id extends ProviderId<Providers>>(
		providerId: Id,
		providerOrderId: string,
		args: ProviderCaptureArgs<Providers[Id]>,
	) => Promise<BnplCaptureResult>;
	refund: <Id extends ProviderId<Providers>>(
		providerId: Id,
		providerOrderId: string,
		args: ProviderRefundArgs<Providers[Id]>,
	) => Promise<BnplRefundResult>;
	cancel: <Id extends ProviderId<Providers>>(
		providerId: Id,
		providerOrderId: string,
		...args: OperationArg<ProviderCancelArgs<Providers[Id]>>
	) => Promise<void>;
	authorize: (
		providerId: ProviderId<Providers>,
		providerOrderId: string,
	) => Promise<BnplAuthorizeResult>;
	preCheck: (
		providerId: ProviderId<Providers>,
		input: BnplPreCheckInput,
	) => Promise<BnplPreCheckResult>;
	provider: <Id extends ProviderId<Providers>>(id: Id) => ProviderNamespace<Providers[Id]>;
};
interface GenericBnplServerClient {
	options: (input: BnplPreCheckInput) => Promise<Array<OptionsResultEntry<string>>>;
	createCheckout: (providerId: string, input: BnplCheckoutInput) => Promise<BnplCheckoutResult>;
	fetchOrder: (providerId: string, providerOrderId: string) => Promise<BnplOrderState>;
	capture: (
		providerId: string,
		providerOrderId: string,
		args: BnplCaptureArgs,
	) => Promise<BnplCaptureResult>;
	refund: (
		providerId: string,
		providerOrderId: string,
		args: BnplRefundArgs,
	) => Promise<BnplRefundResult>;
	cancel: (providerId: string, providerOrderId: string, args?: BnplCancelArgs) => Promise<void>;
	authorize: (providerId: string, providerOrderId: string) => Promise<BnplAuthorizeResult>;
	preCheck: (providerId: string, input: BnplPreCheckInput) => Promise<BnplPreCheckResult>;
	provider: (id: string) => ProviderNamespace;
}
function buildNamespaces(
	providers: Record<string, BnplProvider>,
	ctx: ProviderContext,
): Record<string, ProviderNamespace> {
	const acc: Record<string, ProviderNamespace> = {};
	for (const [id, provider] of Object.entries(providers)) {
		acc[id] = namespaceFor(provider, ctx);
	}
	return acc;
}
function namespaceFor(p: BnplProvider, ctx: ProviderContext): ProviderNamespace {
	return {
		createCheckout: (input) => p.createCheckout(input, ctx),
		fetchOrder: (providerOrderId) => p.fetchOrder(providerOrderId, ctx),
		capture: (providerOrderId, args) => p.capture(providerOrderId, args, ctx),
		refund: (providerOrderId, args) => p.refund(providerOrderId, args, ctx),
		cancel: (providerOrderId, args = {}) => p.cancel(providerOrderId, args, ctx),
		preCheck: (input) => p.preCheck(input, ctx),
		authorize: p.authorize
			? async (providerOrderId) => {
					const result = await p.authorize?.(providerOrderId, ctx);
					if (!result) throw new BnplPluginError("OPERATION_NOT_SUPPORTED");
					return result;
				}
			: undefined,
		voidCheckout: p.voidCheckout
			? (checkoutId, providerOrderId) =>
					p.voidCheckout?.(checkoutId, providerOrderId, ctx) ?? Promise.resolve()
			: undefined,
		closePayment: p.closePayment
			? (providerPaymentId) => p.closePayment?.(providerPaymentId, ctx) ?? Promise.resolve()
			: undefined,
	};
}
export function createBnplClient<Providers extends Record<string, BnplProvider>>(
	opts: CreateBnplClientOptions<Providers>,
): BnplServerClient<Providers>;
export function createBnplClient(
	opts: CreateBnplClientOptions<Record<string, BnplProvider>>,
): GenericBnplServerClient {
	const providers = opts.providers;
	const logger = opts.logger ?? DEFAULT_LOGGER;
	const ctx: ProviderContext = { logger };
	const requireProvider = (id: string): BnplProvider => {
		const p = providers[id];
		if (!p) {
			throw new BnplPluginError(
				"PROVIDER_NOT_CONFIGURED",
				`createBnplClient: provider \`${id}\` is not configured`,
			);
		}
		return p;
	};
	const namespaces = buildNamespaces(providers, ctx);
	const generic = {
		options: async (input: BnplPreCheckInput): Promise<Array<OptionsResultEntry<string>>> => {
			const ids = Object.keys(providers);
			return Promise.all(
				ids.map(async (id) => {
					const p = providers[id];
					if (!p) {
						return {
							id,
							displayName: id,
							available: false,
							reason: "provider_missing",
						};
					}
					try {
						const r = await p.preCheck(input, ctx);
						return {
							id,
							displayName: p.display.displayName,
							available: r.available,
							reason: r.reason,
							availablePaymentTypes: r.availablePaymentTypes,
						};
					} catch (e) {
						logger.warn(`bnpl: ${id} preCheck failed: ${e instanceof Error ? e.message : e}`);
						return {
							id,
							displayName: p.display.displayName,
							available: false,
							reason: "precheck_failed",
						};
					}
				}),
			);
		},
		createCheckout: (id: string, input: BnplCheckoutInput) =>
			requireProvider(id).createCheckout(input, ctx),
		fetchOrder: (id: string, providerOrderId: string) =>
			requireProvider(id).fetchOrder(providerOrderId, ctx),
		capture: (id: string, providerOrderId: string, args: BnplCaptureArgs) =>
			requireProvider(id).capture(providerOrderId, args, ctx),
		refund: (id: string, providerOrderId: string, args: BnplRefundArgs) =>
			requireProvider(id).refund(providerOrderId, args, ctx),
		cancel: (id: string, providerOrderId: string, args: BnplCancelArgs = {}) =>
			requireProvider(id).cancel(providerOrderId, args, ctx),
		preCheck: (id: string, input: BnplPreCheckInput) => requireProvider(id).preCheck(input, ctx),
		authorize: async (id: string, providerOrderId: string) => {
			const p = requireProvider(id);
			if (!p.authorize) {
				throw new BnplPluginError(
					"OPERATION_NOT_SUPPORTED",
					`${id} does not require a separate authorize step`,
				);
			}
			return p.authorize(providerOrderId, ctx);
		},
		provider: (id: string) => {
			const p = requireProvider(id);
			return namespaceFor(p, ctx);
		},
	};
	return { ...namespaces, ...generic };
}
