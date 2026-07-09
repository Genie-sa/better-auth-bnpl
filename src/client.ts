import type { BetterAuthClientPlugin } from "better-auth";
import { type BetterFetchOption, InferPlugin } from "better-auth/client";
import type { BnplErrorCode } from "./core/errors";
import type { BnplProvider } from "./core/provider";
import type {
	BnplAuthorizeResult,
	BnplCancelArgs,
	BnplCaptureArgs,
	BnplCaptureResult,
	BnplOrderState,
	BnplPersistedOrder,
	BnplPersistedOrderWithRemote,
	BnplRefundArgs,
	BnplRefundResult,
	BnplWebhookEventKind,
} from "./core/types";
import type { AbsoluteUrl } from "./core/url";
import type { bnpl } from "./plugin";
import type { CheckoutBodyRelaxedInput } from "./plugins/checkout";
import type { OptionsBodyInput } from "./plugins/options";
import type { BnplProviderOption } from "./plugins/options";
import type { StoredWebhookEvent } from "./plugins/webhook-events";
export type { BnplErrorCode } from "./core/errors";
export type { BnplAuthorizeResult } from "./core/types";
export type { BnplPersistedOrder, BnplPersistedOrderWithRemote } from "./core/types";
export type { BnplProviderOption } from "./plugins/options";
export type { StoredWebhookEvent as BnplStoredWebhookEvent } from "./plugins/webhook-events";
export type BnplStartCheckoutBody<Provider extends string = string> = Omit<
	CheckoutBodyRelaxedInput,
	"provider"
> & {
	provider: Provider;
};
export interface BnplStartCheckoutResult<Provider extends string = string> {
	provider: Provider;
	providerOrderId: string;
	providerCheckoutId: string;
	checkoutUrl: AbsoluteUrl;
	qrCodeUrl?: string;
	status: string;
	orderReferenceId: string;
}
export type BnplOptionsInput = OptionsBodyInput;
export interface BnplOptionsResult {
	options: BnplProviderOption[];
	available: BnplProviderOption[];
	unavailable: BnplProviderOption[];
}
export interface BnplListOrdersQuery {
	limit?: number;
	offset?: number;
	provider?: string;
}
export interface BnplListOrdersResult<T = BnplPersistedOrder> {
	orders: T[];
}
export interface BnplAdminListOrdersQuery {
	provider?: string;
	status?: string;
	userId?: string;
	limit?: number;
	offset?: number;
}
export interface BnplAdminListWebhookEventsQuery {
	status?: string;
	provider?: string;
	providerOrderId?: string;
	limit?: number;
	offset?: number;
}
export interface BnplAdminRedeliverWebhookEventResult {
	redelivered: true;
	status: "processed";
	kind: BnplWebhookEventKind;
}
export type BnplAdminCaptureInput = BnplCaptureArgs;
export type BnplAdminRefundInput = BnplRefundArgs;
export type BnplAdminCancelInput = BnplCancelArgs;
export interface BnplAdminVoidInput {
	checkoutId?: string;
}
export interface BnplAdminCancelResult {
	orderId: string;
	status: "canceled";
}
export type BnplAdminAuthoriseResult =
	| BnplAuthorizeResult
	| {
			orderId: string;
			status: "authorised";
			already: true;
	  };
export interface BnplAdminReconcileResult {
	synced: true;
	order: BnplOrderState;
}
export interface BnplAdminVoidResult {
	orderId: string;
	voided: true;
}
export interface BnplAdminCloseResult {
	orderId: string;
	closed: true;
}
export interface BnplClientError {
	code?: BnplErrorCode | (string & {});
	message?: string;
	status: number;
	statusText: string;
}
export type BnplClientResponse<T> =
	| {
			data: T;
			error: null;
	  }
	| {
			data: null;
			error: BnplClientError;
	  };
export type BnplClientFetch = <T>(url: string, opts?: object) => Promise<BnplClientResponse<T>>;
type CheckoutOptions = {
	redirect?: boolean;
	fetchOptions?: BetterFetchOption;
};
type RequestOptions = {
	fetchOptions?: BetterFetchOption;
};
export interface ProviderNamespacedClient<Provider extends string> {
	startCheckout: (
		data: Omit<BnplStartCheckoutBody<Provider>, "provider">,
		options?: CheckoutOptions,
	) => Promise<BnplClientResponse<BnplStartCheckoutResult<Provider>>>;
}
export interface BnplAdminClient {
	listOrders: (
		query?: BnplAdminListOrdersQuery,
		options?: RequestOptions,
	) => Promise<BnplClientResponse<BnplListOrdersResult<BnplPersistedOrder>>>;
	listWebhookEvents: (
		query?: BnplAdminListWebhookEventsQuery,
		options?: RequestOptions,
	) => Promise<
		BnplClientResponse<{
			events: StoredWebhookEvent[];
		}>
	>;
	redeliverWebhookEvent: (
		id: string,
		options?: RequestOptions,
	) => Promise<BnplClientResponse<BnplAdminRedeliverWebhookEventResult>>;
	capture: (
		orderId: string,
		data: BnplAdminCaptureInput,
		options?: RequestOptions,
	) => Promise<BnplClientResponse<BnplCaptureResult>>;
	refund: (
		orderId: string,
		data: BnplAdminRefundInput,
		options?: RequestOptions,
	) => Promise<BnplClientResponse<BnplRefundResult>>;
	cancel: (
		orderId: string,
		data: BnplAdminCancelInput,
		options?: RequestOptions,
	) => Promise<BnplClientResponse<BnplAdminCancelResult>>;
	authorise: (
		orderId: string,
		options?: RequestOptions,
	) => Promise<BnplClientResponse<BnplAdminAuthoriseResult>>;
	reconcile: (
		orderId: string,
		options?: RequestOptions,
	) => Promise<BnplClientResponse<BnplAdminReconcileResult>>;
	void: (
		orderId: string,
		data?: BnplAdminVoidInput,
		options?: RequestOptions,
	) => Promise<BnplClientResponse<BnplAdminVoidResult>>;
	close: (
		orderId: string,
		options?: RequestOptions,
	) => Promise<BnplClientResponse<BnplAdminCloseResult>>;
}
function redirectIfBrowser(checkoutUrl: string | undefined, redirect: boolean | undefined): void {
	const shouldRedirect = redirect ?? typeof window !== "undefined";
	if (shouldRedirect && typeof window !== "undefined" && checkoutUrl) {
		window.location.href = checkoutUrl;
	}
}
function makeProviderNamespace<Id extends string>(
	providerId: Id,
	$fetch: BnplClientFetch,
): ProviderNamespacedClient<Id> {
	return {
		startCheckout: async (data, options) => {
			const res = await $fetch<BnplStartCheckoutResult<Id>>("/bnpl/checkout", {
				method: "POST",
				body: { ...data, provider: providerId },
				...options?.fetchOptions,
			});
			if (res.data) redirectIfBrowser(res.data.checkoutUrl, options?.redirect);
			return res;
		},
	};
}
function makeAdminClient($fetch: BnplClientFetch): BnplAdminClient {
	const post = <T>(orderId: string, operation: string, body?: object, options?: RequestOptions) =>
		$fetch<T>(`/bnpl/admin/orders/${encodeURIComponent(orderId)}/${operation}`, {
			method: "POST",
			body,
			...options?.fetchOptions,
		});
	return {
		listOrders: (query, options) =>
			$fetch<BnplListOrdersResult<BnplPersistedOrder>>("/bnpl/admin/orders", {
				method: "GET",
				query,
				...options?.fetchOptions,
			}),
		listWebhookEvents: (query, options) =>
			$fetch<{
				events: StoredWebhookEvent[];
			}>("/bnpl/admin/webhook-events", {
				method: "GET",
				query,
				...options?.fetchOptions,
			}),
		redeliverWebhookEvent: (id, options) =>
			$fetch<BnplAdminRedeliverWebhookEventResult>(
				`/bnpl/admin/webhook-events/${encodeURIComponent(id)}/redeliver`,
				{ method: "POST", ...options?.fetchOptions },
			),
		capture: (orderId, data, options) => post(orderId, "capture", data, options),
		refund: (orderId, data, options) => post(orderId, "refund", data, options),
		cancel: (orderId, data, options) => post(orderId, "cancel", data, options),
		authorise: (orderId, options) => post(orderId, "authorise", undefined, options),
		reconcile: (orderId, options) => post(orderId, "reconcile", undefined, options),
		void: (orderId, data, options) => post(orderId, "void", data, options),
		close: (orderId, options) => post(orderId, "close", undefined, options),
	};
}
export interface BnplClientApi<ConfiguredProvider extends string> {
	options: (
		data: BnplOptionsInput,
		fetchOptions?: BetterFetchOption,
	) => Promise<BnplClientResponse<BnplOptionsResult>>;
	startCheckout: (
		data: BnplStartCheckoutBody<ConfiguredProvider>,
		options?: CheckoutOptions,
	) => Promise<BnplClientResponse<BnplStartCheckoutResult<ConfiguredProvider>>>;
	getOrder: <T = BnplPersistedOrderWithRemote>(
		orderId: string,
		fetchOptions?: BetterFetchOption,
	) => Promise<BnplClientResponse<T>>;
	getOrderByReferenceId: <T = BnplPersistedOrder>(
		referenceId: string,
		fetchOptions?: BetterFetchOption,
	) => Promise<BnplClientResponse<T>>;
	listOrders: <T = BnplPersistedOrder>(
		query?: BnplListOrdersQuery,
		fetchOptions?: BetterFetchOption,
	) => Promise<BnplClientResponse<BnplListOrdersResult<T>>>;
	admin: BnplAdminClient;
	provider: <Id extends ConfiguredProvider>(id: Id) => ProviderNamespacedClient<Id>;
}
type BuiltInProviderId = "tamara" | "tabby";
type BuiltInShortcutIds<ConfiguredProvider extends string> = string extends ConfiguredProvider
	? BuiltInProviderId
	: Extract<ConfiguredProvider, BuiltInProviderId>;
type BuiltInProviderShortcuts<ConfiguredProvider extends string> = {
	[Id in BuiltInShortcutIds<ConfiguredProvider>]: ProviderNamespacedClient<Id>;
};
export type BnplClientActions<ConfiguredProvider extends string> = {
	bnpl: BnplClientApi<ConfiguredProvider> & BuiltInProviderShortcuts<ConfiguredProvider>;
};
export type BnplClientProviderInput = Record<string, BnplProvider> | string;
export type BnplClientProviderIds<Input extends BnplClientProviderInput> = Input extends string
	? Input
	: keyof Input & string;
export type BnplClientPlugin<Providers extends BnplClientProviderInput> = BetterAuthClientPlugin & {
	id: "bnpl-client";
	$InferServerPlugin: ReturnType<typeof bnpl>;
	getActions: ($fetch: BnplClientFetch) => BnplClientActions<BnplClientProviderIds<Providers>>;
};
export function bnplClient<
	Providers extends BnplClientProviderInput = string,
>(): BnplClientPlugin<Providers>;
export function bnplClient() {
	return {
		id: "bnpl-client",
		$InferServerPlugin: InferPlugin<ReturnType<typeof bnpl>>().$InferServerPlugin,
		getActions: ($fetch: BnplClientFetch) => {
			const provider = <Id extends string>(id: Id) => makeProviderNamespace(id, $fetch);
			const admin = makeAdminClient($fetch);
			const actions = {
				options: (data, fetchOptions) =>
					$fetch<BnplOptionsResult>("/bnpl/options", {
						method: "POST",
						body: data,
						...fetchOptions,
					}),
				startCheckout: async (data, options) => {
					const res = await $fetch<BnplStartCheckoutResult>("/bnpl/checkout", {
						method: "POST",
						body: data,
						...options?.fetchOptions,
					});
					if (res.data) redirectIfBrowser(res.data.checkoutUrl, options?.redirect);
					return res;
				},
				getOrder: <T = BnplPersistedOrderWithRemote>(
					orderId: string,
					fetchOptions?: BetterFetchOption,
				) =>
					$fetch<T>(`/bnpl/orders/${encodeURIComponent(orderId)}`, {
						method: "GET",
						...fetchOptions,
					}),
				getOrderByReferenceId: <T = BnplPersistedOrder>(
					referenceId: string,
					fetchOptions?: BetterFetchOption,
				) =>
					$fetch<T>(`/bnpl/orders/reference-id/${encodeURIComponent(referenceId)}`, {
						method: "GET",
						...fetchOptions,
					}),
				listOrders: <T = BnplPersistedOrder>(
					query?: BnplListOrdersQuery,
					fetchOptions?: BetterFetchOption,
				) =>
					$fetch<BnplListOrdersResult<T>>("/bnpl/orders", {
						method: "GET",
						query,
						...fetchOptions,
					}),
				admin,
				provider,
				tamara: makeProviderNamespace("tamara", $fetch),
				tabby: makeProviderNamespace("tabby", $fetch),
			} satisfies BnplClientApi<string> & {
				tamara: ProviderNamespacedClient<"tamara">;
				tabby: ProviderNamespacedClient<"tabby">;
			};
			return {
				bnpl: {
					...actions,
				},
			};
		},
	} satisfies BetterAuthClientPlugin;
}
