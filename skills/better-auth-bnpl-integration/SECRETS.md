# Secrets and credentials

Env-var names below follow the plugin's example app; keep them unless the repo already has a different convention. All of these are server-only — never expose any of them with a `NEXT_PUBLIC_` / client-bundle prefix.

## Tamara

| Env var | Provider option | Where it comes from | Notes |
|---|---|---|---|
| `TAMARA_API_TOKEN` | `apiToken` | Tamara Partners portal → API settings | Bearer token for all API calls. Sandbox and production issue different tokens. |
| `TAMARA_NOTIFICATION_TOKEN` | `notificationToken` | Tamara Partners portal → notification settings | HMAC secret that verifies the webhook JWT (HS256). Without it, webhook deliveries fail verification. |
| `TAMARA_ENVIRONMENT` | `environment` | you choose | `"sandbox"` (default) or `"production"`. Unlike Tabby, Tamara has a real sandbox host and this switch selects it. |

Tamara's webhook *body* is unsigned by design — the JWT authenticates the caller, not the payload. The plugin pins HS256 and `iss: "Tamara"`, enforces `exp`, and applies a 300s replay window (`replayToleranceSeconds`). Leave the replay window on in production; the query-param token leaks into proxy/CDN logs, and the window bounds how long a leaked token is useful.

## Tabby

| Env var | Provider option | Where it comes from | Notes |
|---|---|---|---|
| `TABBY_SECRET_KEY` | `secretKey` | Tabby merchant dashboard → API keys | Bearer token. **The key type selects the environment**: `sk_test_…` is test, `sk_…` is live. There is no sandbox host and the `environment` option never affects routing. |
| `TABBY_MERCHANT_CODE` | `merchantCode` | Tabby merchant dashboard / onboarding | Sent in the checkout body and `X-Merchant-Code` header. KSA merchants often have per-country codes. |
| `TABBY_WEBHOOK_SECRET` | `webhookHeader.value` | **you generate it** | Not issued by Tabby. Invent a long random value (e.g. `openssl rand -hex 32`), register it as the header value when creating the webhook in Tabby, and pass the same pair to `webhookHeader`. Rotate periodically — rotation means updating both the Tabby webhook registration and the env var. |

`webhookHeader.name` (e.g. `X-Tabby-Webhook`) is not a secret but must match the registration exactly.

Routing gotcha: `country: "SA"` routes to `api.tabby.sa` for *both* test and live traffic; `AE`/`KW` route to `api.tabby.ai`. A KSA merchant with a test key still needs `country: "SA"`.

## Better Auth baseline

The host app also needs Better Auth's own secrets if not already set: `BETTER_AUTH_SECRET` (≥32 random chars) and `BETTER_AUTH_URL`. The webhook notification URL is derived from `baseURL`, so `BETTER_AUTH_URL` must be the publicly reachable origin in production.

## Handling rules

- Placeholders in `.env.example`, real values only in untracked `.env` / the deploy platform's secret store.
- Sandbox and production credentials are separate sets; never mix them in one environment.
- If a real secret was ever committed, treat it as leaked: rotate it in the provider portal, don't just delete the line.
