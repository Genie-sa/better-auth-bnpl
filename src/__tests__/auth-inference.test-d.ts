import { betterAuth } from "better-auth";
import { createAuthClient } from "better-auth/react";
import { bnplClient } from "../client";
import { bnpl } from "../plugin";
import { checkout } from "../plugins/checkout";
import { webhooks } from "../plugins/webhooks";

function checkAuthInference() {
	const auth = betterAuth({
		plugins: [bnpl({ providers: {}, use: [checkout(), webhooks()] })],
	});
	const client = createAuthClient({ plugins: [bnplClient<"tabby">()] });
	auth.api.getSession({ headers: new Headers() });
	client.getSession();
	client.signOut();
	client.bnpl.startCheckout({ provider: "tabby", description: "Course", countryCode: "SA" });
}
void checkAuthInference;
