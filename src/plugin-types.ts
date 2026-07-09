import type {
	BetterAuthPlugin,
	GenericEndpointContext,
	UnionToIntersection,
	User,
} from "better-auth";
import type { BnplProvider } from "./core/provider";
import type { BnplBuyer, BnplCaptureArgs, BnplMoney } from "./core/types";
export interface MapUserToBuyerContext {
	user: User;
	request?: Request;
	endpointContext: GenericEndpointContext;
}
export type MapUserToBuyer = (ctx: MapUserToBuyerContext) => Promise<BnplBuyer> | BnplBuyer;
export interface CaptureOnAuthoriseShippingInfoContext {
	providerId: string;
	orderId: string;
	totalAmount: BnplMoney;
}
export type CaptureOnAuthoriseShippingInfoResolver = (
	ctx: CaptureOnAuthoriseShippingInfoContext,
) => BnplCaptureArgs["shippingInfo"] | Promise<BnplCaptureArgs["shippingInfo"]>;
export interface BnplOptions<
	out Providers extends Record<string, BnplProvider> = Record<string, BnplProvider>,
	out Subs extends readonly BnplSubPlugin[] = readonly BnplSubPlugin[],
> {
	providers: Providers;
	mapUserToBuyer?: MapUserToBuyer;
	persistOrders?: boolean;
	autoAuthorise?: boolean;
	captureOnAuthorise?: boolean;
	captureOnAuthoriseShippingInfo?: CaptureOnAuthoriseShippingInfoResolver;
	use: Subs;
}
export type BnplEndpointRecord = NonNullable<BetterAuthPlugin["endpoints"]>;
export type BnplSubPlugin<Endpoints extends BnplEndpointRecord = BnplEndpointRecord> = (
	providers: Record<string, BnplProvider>,
	options: BnplOptions,
) => Endpoints;
export type BnplEndpoints<Subs extends readonly BnplSubPlugin[]> = UnionToIntersection<
	ReturnType<Subs[number]>
> extends infer Record
	? Record extends BnplEndpointRecord
		? Record
		: BnplEndpointRecord
	: BnplEndpointRecord;
