import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";
import { admin, bnpl, checkout, options, orders, webhooks } from "../../dist/index.js";
import { tabby } from "../../dist/providers/tabby/index.js";
import { tamara } from "../../dist/providers/tamara/index.js";
const port = 4318;
const baseURL = process.env.DEMO_BASE_URL;
if (!baseURL?.startsWith("https://")) throw new Error("DEMO_BASE_URL must be the HTTPS tunnel URL");
if (!process.env.TABBY_SECRET_KEY?.startsWith("sk_test_"))
	throw new Error("Tabby sandbox credentials required");
if (process.env.TAMARA_ENVIRONMENT !== "sandbox")
	throw new Error("Tamara sandbox environment required");
const directory = fileURLToPath(new URL(".", import.meta.url));
await mkdir(`${directory}.data`, { recursive: true });
const database = new DatabaseSync(`${directory}.data/demo.sqlite`);
database.exec(
	"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS demoTimeline (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, provider TEXT, orderId TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL)",
);
function trace(kind, event = {}, detail = "") {
	database
		.prepare("INSERT INTO demoTimeline(at,provider,orderId,kind,detail) VALUES(?,?,?,?,?)")
		.run(new Date().toISOString(), event.provider ?? "", event.orderId ?? "", kind, String(detail));
}
const adminEmail = `local-admin-${randomUUID()}@example.com`;
const adminPassword = randomBytes(32).toString("base64url");
const bootstrapToken = randomBytes(32).toString("base64url");
const isAuthorized = ({ session }) => session.user.id === adminId;
const providers = {
	tabby: tabby({
		secretKey: process.env.TABBY_SECRET_KEY,
		merchantCode: process.env.TABBY_MERCHANT_CODE,
		country: "SA",
		environment: "sandbox",
		webhookHeader: { name: "X-Tabby-Webhook", value: process.env.TABBY_WEBHOOK_HEADER_VALUE },
	}),
	tamara: tamara({
		apiToken: process.env.TAMARA_API_TOKEN,
		notificationToken: process.env.TAMARA_NOTIFICATION_TOKEN,
		environment: "sandbox",
	}),
};
const auth = betterAuth({
	baseURL,
	secret: randomBytes(48).toString("base64url"),
	database,
	emailAndPassword: { enabled: true },
	trustedOrigins: [baseURL, `http://127.0.0.1:${port}`, `http://localhost:${port}`],
	advanced: { useSecureCookies: false },
	logger: { disabled: true },
	plugins: [
		bnpl({
			providers,
			persistOrders: true,
			captureOnAuthorise: process.env.DEMO_AUTO_CAPTURE !== "false",
			captureOnAuthoriseShippingInfo: () => ({
				shippedAt: new Date().toISOString(),
				shippingCompany: "Sandbox digital delivery",
			}),
			mapUserToBuyer: ({ user, endpointContext }) => ({
				firstName: "Sandbox",
				lastName: "Test",
				email: endpointContext.body?.provider === "tabby" ? "otp.success@tabby.ai" : user.email,
				phone: endpointContext.body?.provider === "tabby" ? "+966500000001" : "+966504591298",
			}),
			use: [
				options({ authenticatedOnly: true }),
				checkout({
					successUrl: `${baseURL}/?result=success`,
					failureUrl: `${baseURL}/?result=failure`,
					cancelUrl: `${baseURL}/?result=cancel`,
					notificationUrlBuilder: (provider) => `${baseURL}/api/auth/bnpl/webhooks/${provider}`,
					resolveCheckout: ({ input, user }) => ({
						totalAmount: { amount: "100.00", currency: "SAR" },
						taxAmount: { amount: "0.00", currency: "SAR" },
						shippingAmount: { amount: "0.00", currency: "SAR" },
						items: [
							{
								referenceId: "sandbox-course",
								sku: "sandbox-course",
								name: "Sandbox reliability course",
								category: "Education",
								quantity: 2,
								totalAmount: { amount: "100.00", currency: "SAR" },
							},
						],
						providerData:
							input.provider === "tabby"
								? { buyer_history: { registered_since: new Date(user.createdAt).toISOString() } }
								: undefined,
					}),
					onOrderPersisted: ({ record }) =>
						trace(
							"checkout_saved",
							{ provider: record.provider, orderId: record.providerOrderId },
							record.status,
						),
				}),
				orders(),
				admin({ isAuthorized }),
				webhooks({
					redelivery: { isAuthorized },
					onPayload: ({ provider, event }) => trace("delivery", { ...event, provider }, event.kind),
					onStatusChange: ({ provider, orderId, from, to }) =>
						trace("status", { provider, orderId }, `${from} → ${to}`),
					onAuthorized: ({ event }) => trace("authorized_callback", event),
					onCaptured: ({ event }) => trace("capture_callback", event, String(event.amountMinor)),
					onRefunded: ({ event }) => trace("refund_callback", event, String(event.amountMinor)),
					tabby: {
						onPaymentClosed: (payload) =>
							trace("closed_callback", { provider: "tabby", orderId: payload.id }),
					},
				}),
			],
		}),
	],
});
// Better Auth's SQLite ALTER migration omits field defaults on existing tables.
const existingColumns = database.prepare('PRAGMA table_info("bnplOrder")').all();
if (existingColumns.length && !existingColumns.some((column) => column.name === "canceledAmountMinor"))
	database.exec('ALTER TABLE "bnplOrder" ADD COLUMN "canceledAmountMinor" INTEGER NOT NULL DEFAULT 0');
await (await getMigrations(auth.options)).runMigrations();
const created = await auth.api.signUpEmail({
	body: { name: "Local sandbox administrator", email: adminEmail, password: adminPassword },
});
const adminId = created.user.id;
const handleAuth = toNodeHandler(auth);
function localOnly(request) {
	return (
		["127.0.0.1:4318", "localhost:4318"].includes(request.headers.host) &&
		!request.headers["cf-ray"] &&
		!request.headers["cf-connecting-ip"] &&
		!request.headers["x-forwarded-host"] &&
		!request.headers.forwarded
	);
}
function json(response, status, body) {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}
const server = createServer(async (request, response) => {
	try {
		const path = new URL(request.url, baseURL).pathname;
		if (path.startsWith("/api/auth/")) {
			await handleAuth(request, response);
			return;
		}
		if (path === "/demo/bootstrap" && request.method === "GET") {
			if (!localOnly(request)) {
				json(response, 403, { error: "Local administrator access only" });
				return;
			}
			response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
			response.end(
				`<form method="post" action="/demo/bootstrap"><input type="hidden" name="token" value="${bootstrapToken}"><button>Open local administrator session</button></form>`,
			);
			return;
		}
		if (path === "/demo/bootstrap" && request.method === "POST") {
			if (!localOnly(request) || request.headers.origin !== `http://${request.headers.host}`) {
				json(response, 403, { error: "Local administrator access only" });
				return;
			}
			let body = "";
			for await (const part of request) {
				body += part;
				if (body.length > 1024) throw new Error("request_too_large");
			}
			if (new URLSearchParams(body).get("token") !== bootstrapToken) {
				json(response, 403, { error: "Invalid bootstrap token" });
				return;
			}
			const session = await auth.api.signInEmail({
				body: { email: adminEmail, password: adminPassword },
				asResponse: true,
			});
			response.writeHead(303, {
				location: "/",
				"set-cookie": session.headers.getSetCookie(),
				"cache-control": "no-store",
			});
			response.end();
			return;
		}
		if (path === "/api/demo/state") {
			const headers = new Headers();
			for (const [name, value] of Object.entries(request.headers))
				if (typeof value === "string") headers.set(name, value);
			const session = await auth.api.getSession({ headers });
			if (!session) {
				json(response, 401, { error: "Sign in to inspect your orders" });
				return;
			}
			const administrator = session.user.id === adminId;
			const orderRows = administrator
				? database
						.prepare(
							"SELECT id,provider,providerOrderId,orderReferenceId,status,amountMinor,currency,capturedAmountMinor,refundedAmountMinor,createdAt,version FROM bnplOrder ORDER BY createdAt DESC LIMIT 50",
						)
						.all()
				: database
						.prepare(
							"SELECT id,provider,providerOrderId,orderReferenceId,status,amountMinor,currency,capturedAmountMinor,refundedAmountMinor,createdAt,version FROM bnplOrder WHERE userId=? ORDER BY createdAt DESC LIMIT 50",
						)
						.all(session.user.id);
			const allowed = new Set(orderRows.map((row) => row.providerOrderId));
			const eventRows = database
				.prepare(
					"SELECT id,provider,providerOrderId,eventKind,status,attempts,receivedAt,orderApplied FROM bnplWebhookEvent ORDER BY receivedAt DESC LIMIT 100",
				)
				.all()
				.filter((row) => administrator || allowed.has(row.providerOrderId));
			const timeline = database
				.prepare("SELECT * FROM demoTimeline ORDER BY id DESC LIMIT 100")
				.all()
				.filter((row) => administrator || allowed.has(row.orderId));
			json(response, 200, {
				user: { name: session.user.name, email: session.user.email },
				administrator,
				orders: orderRows,
				events: eventRows,
				timeline,
			});
			return;
		}
		if (path === "/" && request.method === "GET") {
			response.writeHead(200, {
				"content-type": "text/html",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
			response.end(await readFile(`${directory}index.html`, "utf8"));
			return;
		}
		json(response, 404, { error: "Not found" });
	} catch (error) {
		trace("server_error", {}, error.name);
		json(response, 500, { error: "Request failed. Check the local timeline." });
	}
});
server.listen(port, "127.0.0.1", () =>
	console.log(`Sandbox reliability demo ready at http://127.0.0.1:${port}`),
);
