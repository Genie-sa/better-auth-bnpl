import { writeFile } from "node:fs/promises";
import { TabbyClient } from "../../dist/providers/tabby/index.js";

const baseUrl = process.env.DEMO_BASE_URL;
if (!baseUrl || !baseUrl.startsWith("https://")) throw new Error("Set DEMO_BASE_URL to the HTTPS tunnel URL");
if (!process.env.TABBY_SECRET_KEY?.startsWith("sk_test_")) throw new Error("A Tabby sandbox key is required");
const client = new TabbyClient({
	secretKey: process.env.TABBY_SECRET_KEY,
	merchantCode: process.env.TABBY_MERCHANT_CODE,
	country: "SA",
});
const url = new URL("/api/auth/bnpl/webhooks/tabby", baseUrl).href;
try {
	const listed = await client.listWebhooks();
	const existing = Array.isArray(listed) ? listed : listed ? [listed] : [];
	let webhook = existing.find((entry) => entry.url === url);
	if (!webhook) {
		if (existing.length >= 4) throw new Error("Webhook limit reached; existing registrations were preserved");
		webhook = await client.registerWebhook({
			url,
			is_test: true,
			header: { title: "X-Tabby-Webhook", value: process.env.TABBY_WEBHOOK_HEADER_VALUE },
		});
	}
	await writeFile(new URL("./tabby-webhook.json", import.meta.url), `${JSON.stringify({ provider: "tabby", id: webhook.id, url }, null, 2)}\n`);
	const verified = await client.retrieveWebhook(webhook.id);
	if (verified.url !== url || !verified.is_test) throw new Error("Webhook readback mismatch");
	const metadata = { provider: "tabby", id: verified.id, url, verifiedAt: new Date().toISOString() };
	await writeFile(new URL("./tabby-webhook.json", import.meta.url), `${JSON.stringify(metadata, null, 2)}\n`);
	console.log(JSON.stringify({ provider: "tabby", registered: true, verified: true, existingRegistrationsPreserved: true }));
} catch (error) {
	console.error(JSON.stringify({ provider: "tabby", registered: false, status: error.status ?? null, reason: error.name === "BnplProviderError" ? "Provider rejected registration; credentials and response omitted" : error.message }));
	process.exitCode = 1;
}
