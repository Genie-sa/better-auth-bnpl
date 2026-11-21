import { betterAuth } from "better-auth";
import { createAuthClient } from "better-auth/react";
import { bnplClient } from "../client";
import { bnpl } from "../plugin";
import { admin } from "../plugins/admin";
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

async function checkAdminResponseInference() {
	const auth = betterAuth({
		plugins: [bnpl({ providers: {}, use: [admin({ isAuthorized: () => true })] })],
	});
	const capture = await auth.api.bnplAdminCapture({
		params: { orderId: "order" },
		body: { totalAmount: { amount: "1.00", currency: "SAR" }, merchantReferenceId: "reference" },
	});
	const captureId: string = capture.captureId;
	const refund = await auth.api.bnplAdminRefund({
		params: { orderId: "order" },
		body: { totalAmount: { amount: "1.00", currency: "SAR" }, merchantRefundId: "reference" },
	});
	const refundId: string = refund.refundId;
	void captureId;
	void refundId;
}
void checkAdminResponseInference;
