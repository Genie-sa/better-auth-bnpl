import { describe, expect, expectTypeOf, it } from "vitest";
import { type OpenApiPathParamNames, createOpenApiPathBuilder } from "../../providers/openapi-path";

interface ExampleOpenApiPaths {
	"/checkout": unknown;
	"/payments/{id}": unknown;
	"/orders/{order_id}/reference-id": unknown;
	"/customers/{customer_id}/orders/{order_id}": unknown;
}

const examplePath = createOpenApiPathBuilder<ExampleOpenApiPaths>();

function assertCompileTimeFailures(): void {
	// @ts-expect-error params are not accepted for paths without placeholders
	examplePath("/checkout", { id: "pay_1" });
	// @ts-expect-error params are required for placeholder paths
	examplePath("/payments/{id}");
	// @ts-expect-error param names must match the OpenAPI path placeholders
	examplePath("/payments/{id}", { payment_id: "pay_1" });
	// @ts-expect-error extra params should fail instead of being silently ignored
	examplePath("/payments/{id}", { id: "pay_1", extra: "unexpected" });
	// @ts-expect-error path literals must come from the generated OpenAPI paths map
	examplePath("/missing/{id}", { id: "pay_1" });
}

describe("createOpenApiPathBuilder", () => {
	it("renders OpenAPI path templates and URL-encodes path params", () => {
		expect(examplePath("/checkout")).toBe("/checkout");
		expect(examplePath("/payments/{id}", { id: "pay/1" })).toBe("/payments/pay%2F1");
		expect(
			examplePath("/customers/{customer_id}/orders/{order_id}", {
				customer_id: "customer 1",
				order_id: "order/1",
			}),
		).toBe("/customers/customer%201/orders/order%2F1");
	});

	it("infers placeholder names from OpenAPI path literals", () => {
		expect(assertCompileTimeFailures).toBeTypeOf("function");
		expectTypeOf<
			OpenApiPathParamNames<"/orders/{order_id}/reference-id">
		>().toEqualTypeOf<"order_id">();
		expectTypeOf<
			OpenApiPathParamNames<"/customers/{customer_id}/orders/{order_id}">
		>().toEqualTypeOf<"customer_id" | "order_id">();
	});
});
