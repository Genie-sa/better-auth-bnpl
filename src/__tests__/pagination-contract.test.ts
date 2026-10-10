import { describe, expect, it } from "vitest";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
import { orders } from "../plugins/orders";
import { webhooks } from "../plugins/webhooks";
import { makeBnplTestInstance, stubProvider } from "./_harness";

const paths = ["/bnpl/orders", "/bnpl/admin/orders", "/bnpl/admin/webhook-events"];

async function makeInstance() {
	const instance = await makeBnplTestInstance([
		bnpl({
			providers: { tabby: stubProvider("tabby") },
			persistOrders: true,
			use: [
				orders(),
				admin({ isAuthorized: () => true }),
				webhooks({ redelivery: { isAuthorized: () => true } }),
			],
		}),
	]);
	const { headers } = await instance.signInWithTestUser();
	return { instance, headers };
}

describe.each(paths)("pagination contract for %s", (path) => {
	it.each(["limit=1.5", "offset=0.5", "offset=9007199254740992"])(
		"rejects invalid integer pagination %s before querying orders",
		async (query) => {
			const { instance, headers } = await makeInstance();
			const response = await instance.client.$fetch(`${path}?${query}`, {
				method: "GET",
				headers,
			});
			expect(response.error?.status).toBe(400);
			expect(response.data).toBeNull();
		},
	);

	it("accepts integer pagination encoded in URL query strings", async () => {
		const { instance, headers } = await makeInstance();
		const response = await instance.client.$fetch(`${path}?limit=1&offset=0`, {
			method: "GET",
			headers,
		});
		expect(response.error).toBeNull();
		expect(response.data).toEqual(
			path.endsWith("webhook-events") ? { events: [] } : { orders: [] },
		);
	});
});
