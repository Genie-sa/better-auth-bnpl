# Sandbox reliability demo

Run `pnpm build`, then inject sandbox credentials and `DEMO_BASE_URL` into `node examples/reliability-demo/server.mjs`. The server listens on `127.0.0.1:4318`. SQLite data lives in the ignored `.data` directory. Never use production keys.

Open `/demo/bootstrap` on localhost to create a local administrator session. Public accounts can inspect only their own orders and cannot run administrative money operations or webhook replay. Sandbox purchases are always SAR 100 for two digital seats; prices come from the server. The checkout reference stays unchanged through retries, failures, reloads and provider returns, stored per provider in browser session storage. Hosted checkout opens in the same tab to preserve that session on return; use the tunnel origin for checkout and return to share the same storage. Use **New purchase** for a separate checkout. Hosted checkout URLs are never stored in browser storage.

Register provider webhooks against the tunnel's `/api/auth/bnpl/webhooks/tabby` and `/api/auth/bnpl/webhooks/tamara` URLs using the matching configured signing secrets. Webhook registration is separate from starting this demo.

The demo requires the updated package schema, including the private money command journal; its startup applies Better Auth migrations to the isolated demo database. Admin capture/refund requests require an explicit reference. Keep the reference unchanged when retrying the same request.

Live sandbox registration on 2026-10-10 verified both webhook URLs. Tamara rejected `order_updated` despite its documentation listing that event; this registration uses its seven accepted lifecycle events. The saved registration files contain webhook IDs and URLs, never credentials. A replacement tunnel requires a new matching webhook URL.

For partial cancellation validation, run the demo with `DEMO_AUTO_CAPTURE=false`. Automatic Tamara authorisation remains enabled, while capture uses the administrator action. Keep a stable operation reference when retrying a cancellation; create a new reference for an intentionally separate cancellation. This switch affects only the isolated demo.
