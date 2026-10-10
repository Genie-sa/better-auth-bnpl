import { describe, expect, it, vi } from "vitest";
import { createOpenApiPathBuilder } from "../../providers/openapi-path";
import { TabbyClient } from "../../providers/tabby/client";
import { TamaraClient } from "../../providers/tamara/client";

describe("provider resource path boundaries", () => {
	it.each(["", ".", ".."])('rejects resource ID "%s" before any provider request', async (id) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}, { status: 404 }));
		const tabby = new TabbyClient({ secretKey: "sandbox", merchantCode: "sandbox", fetch });
		const tamara = new TamaraClient({ apiToken: "sandbox", fetch });
		for (const call of [
			() => tabby.getPayment(id),
			() => tabby.closePayment(id),
			() => tamara.authoriseOrder(id),
			() => tamara.getOrderByReferenceId(id),
			() => tamara.retrieveWebhook(id),
		]) {
			await expect(call()).rejects.toThrow();
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("keeps separators and URL syntax inside the resource ID", () => {
		const path = createOpenApiPathBuilder<{ "/orders/{id}/authorise": unknown }>();
		const rendered = path("/orders/{id}/authorise", { id: "one/two?query#fragment" });
		expect(new URL(rendered, "https://sandbox.example").pathname).toBe(
			"/orders/one%2Ftwo%3Fquery%23fragment/authorise",
		);
	});
});
