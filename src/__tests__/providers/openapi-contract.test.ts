import { describe, expectTypeOf, it } from "vitest";
import type {
	OpenApiJsonRequestBody,
	OpenApiJsonResponseBody,
} from "../../providers/openapi-types";
import type {
	paths as TabbyOpenApiPaths,
	operations as TabbyOperations,
} from "../../providers/tabby/openapi";
import type {
	paths as TamaraOpenApiPaths,
	operations as TamaraOperations,
} from "../../providers/tamara/openapi";
type RequirePath<Paths, Path extends keyof Paths> = Path;
describe("generated OpenAPI contracts", () => {
	it("tracks the Tabby paths and payload fields used by the client", () => {
		expectTypeOf<
			RequirePath<TabbyOpenApiPaths, "/api/v2/checkout">
		>().toEqualTypeOf<"/api/v2/checkout">();
		expectTypeOf<
			RequirePath<TabbyOpenApiPaths, "/api/v2/payments/{id}/captures">
		>().toEqualTypeOf<"/api/v2/payments/{id}/captures">();
		expectTypeOf<
			RequirePath<TabbyOpenApiPaths, "/api/v2/payments/{id}/refunds">
		>().toEqualTypeOf<"/api/v2/payments/{id}/refunds">();
		type CheckoutBody = OpenApiJsonRequestBody<TabbyOperations["postCheckoutSession"]>;
		type CaptureBody = OpenApiJsonRequestBody<TabbyOperations["postPaymentCapture"]>;
		type RefundBody = OpenApiJsonRequestBody<TabbyOperations["postPaymentRefund"]>;
		type PaymentResponse = OpenApiJsonResponseBody<TabbyOperations["getPayment"]>;
		expectTypeOf<CheckoutBody>().toMatchTypeOf<{
			payment: {
				amount: string;
				currency: "AED" | "SAR" | "KWD";
				buyer: unknown;
				shipping_address: unknown;
				order: unknown;
			};
			lang: "en" | "ar";
			merchant_code: string;
		}>();
		expectTypeOf<CaptureBody>().toMatchTypeOf<{
			amount: string;
			reference_id: string;
		}>();
		expectTypeOf<RefundBody>().toMatchTypeOf<{
			amount: string;
			reference_id: string;
		}>();
		expectTypeOf<PaymentResponse>().toMatchTypeOf<{
			amount: string;
			currency: "AED" | "SAR" | "KWD";
		}>();
	});
	it("tracks the Tamara paths and payload fields used by the client", () => {
		expectTypeOf<RequirePath<TamaraOpenApiPaths, "/checkout">>().toEqualTypeOf<"/checkout">();
		expectTypeOf<
			RequirePath<TamaraOpenApiPaths, "/orders/{order_id}/reference-id">
		>().toEqualTypeOf<"/orders/{order_id}/reference-id">();
		expectTypeOf<
			RequirePath<TamaraOpenApiPaths, "/pre-checkout/v1/eligibility">
		>().toEqualTypeOf<"/pre-checkout/v1/eligibility">();
		type CaptureBody = OpenApiJsonRequestBody<TamaraOperations["captureOrder"]>;
		type UpdateReferenceBody = OpenApiJsonRequestBody<TamaraOperations["updateOrderReferenceId"]>;
		type EligibilityBody = OpenApiJsonRequestBody<
			TamaraOperations["post_pre-checkout-v1-eligibility"]
		>;
		type EligibilityResponse = OpenApiJsonResponseBody<
			TamaraOperations["post_pre-checkout-v1-eligibility"]
		>;
		expectTypeOf<CaptureBody>().toMatchTypeOf<{
			order_id: string;
			total_amount: {
				amount?: number;
				currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
			};
			shipping_info: {
				shipped_at: string;
				shipping_company: string;
			};
		}>();
		expectTypeOf<UpdateReferenceBody>().toMatchTypeOf<{
			order_reference_id: string;
		}>();
		expectTypeOf<EligibilityBody>().toMatchTypeOf<{
			order: {
				amount?: number;
				currency?: "SAR" | "AED" | "BHD" | "KWD" | "OMR";
			};
			customer: {
				phone?: string;
			};
		}>();
		expectTypeOf<EligibilityResponse>().toMatchTypeOf<{
			is_eligible: boolean;
		}>();
	});
});
