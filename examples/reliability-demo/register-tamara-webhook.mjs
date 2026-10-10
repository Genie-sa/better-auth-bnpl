import { readFile, writeFile } from "node:fs/promises";
import { TamaraClient } from "../../dist/providers/tamara/index.js";

const metadataPath = new URL("./tamara-webhook.json", import.meta.url);
const endpoint = process.argv[2];
if (process.env.TAMARA_ENVIRONMENT !== "sandbox" || !process.env.TAMARA_API_TOKEN) {
	throw new Error("Registration requires verified Tamara sandbox credentials");
}
if (!endpoint || !endpoint.startsWith("https://") || endpoint.length > 255) {
	throw new Error("Provide a public HTTPS webhook URL of at most 255 characters");
}
const client = new TamaraClient({
	apiToken: process.env.TAMARA_API_TOKEN,
	environment: "sandbox",
});
const events = [
	"order_approved",
	"order_authorised",
	"order_canceled",
	"order_captured",
	"order_refunded",
	"order_expired",
	"order_declined",
];

try {
	let existing;
	try {
		existing = JSON.parse(await readFile(metadataPath, "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (existing && existing.url !== endpoint) {
		throw new Error(
			"Saved registration uses another URL; review it before creating another webhook",
		);
	}
	const registration =
		existing ??
		(await client.registerWebhook({ type: "order", events, url: endpoint, headers: {} }));
	const id = registration.id ?? registration.webhook_id;
	if (!existing) {
		await writeFile(
			metadataPath,
			`${JSON.stringify({ provider: "tamara", id, url: endpoint, verifiedAt: null }, null, 2)}\n`,
			{ flag: "wx" },
		);
	}
	const remote = await client.retrieveWebhook(id);
	if (
		remote.webhook_id !== id ||
		remote.url !== endpoint ||
		events.some((event) => !remote.events.includes(event))
	) {
		throw new Error("Webhook readback did not match the registration");
	}
	const metadata = { provider: "tamara", id, url: endpoint, verifiedAt: new Date().toISOString() };
	await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "w" });
	console.log(JSON.stringify(metadata));
} catch (error) {
	console.error(
		JSON.stringify({
			provider: "tamara",
			registrationFailed: true,
			httpStatus: typeof error.status === "number" ? error.status : undefined,
		}),
	);
	process.exitCode = 1;
}
