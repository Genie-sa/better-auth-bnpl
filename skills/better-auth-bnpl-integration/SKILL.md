---
name: better-auth-bnpl-integration
description: Wires the better-auth-bnpl plugin (Tabby + Tamara buy-now-pay-later for Better Auth) into an app — provider map, checkout, options picker, orders, webhooks, admin, schema generation, and the secrets each provider needs. Use when the user asks to add BNPL / Tabby / Tamara to a Better Auth app, install or upgrade better-auth-bnpl, configure BNPL credentials or webhooks, or debug an existing install.
---

# Integrate better-auth-bnpl

You are wiring the `better-auth-bnpl` plugin into the user's Better Auth app. The **provider map** — a single `BnplProviders({ tabby: ..., tamara: ... })` declaration — is the spine of every install: the plugin, client types, webhooks, and admin routes all derive from it. One provider or both, the rest of the code is identical.

Authoritative reference for anything not covered here: after install, read `node_modules/better-auth-bnpl/README.md` (endpoint table, error codes, webhook event shapes, provider-specific rules). Prefer it over memory — it matches the installed version.

## 1. Detect

Read the user's repo before asking anything:

- Better Auth server config file (`auth.ts` or similar) and client file (`auth-client.ts`).
- `better-auth` version — the plugin requires `^1.5.0`. Below that, plan the upgrade as part of this work.
- Database adapter (persistence needs one) and framework (route handlers for webhooks differ).
- Existing env handling (`.env.example`, config module) so secrets follow the repo's convention.
- Whether `better-auth-bnpl` is already installed — if so, this is an upgrade/repair, not a fresh install; diff their config against the current README's breaking-changes section.

Done when: you know the framework, auth file locations, adapter, Better Auth version, and whether this is fresh or existing.

## 2. Interview

Ask only what detection can't answer:

- **Providers**: Tabby, Tamara, or both? (Both enables the end-user picker.)
- **Country and currency**: Tabby serves SA/AE/KW; Tamara serves SA/AE/BH/KW/OM. Tabby's `country` also selects the API host (`SA` → `api.tabby.sa`).
- **Goods type**: physical goods → capture from admin after dispatch with `shippingInfo`; digital goods → `captureOnAuthorise: true` (requires `persistOrders` and `captureOnAuthoriseShippingInfo`).
- **Admin gating**: how the app decides who is an admin (drives `admin({ isAuthorized })` and `redelivery.isAuthorized`).
- **Pricing source**: where the server can look up the real price for a cart/product (drives `resolveCheckout`).

Done when: each answer maps to a concrete config option.

## 3. Install and wire the server

```bash
npm i better-auth-bnpl
```

In the auth config:

1. Declare the provider map once and **export it** (the client types need it):

```ts
export const bnplProviders = BnplProviders({
  tabby: tabby({
    secretKey: env.TABBY_SECRET_KEY,
    merchantCode: env.TABBY_MERCHANT_CODE,
    webhookHeader: { name: "X-Tabby-Webhook", value: env.TABBY_WEBHOOK_SECRET },
    country: "SA",
  }),
  tamara: tamara({
    apiToken: env.TAMARA_API_TOKEN,
    notificationToken: env.TAMARA_NOTIFICATION_TOKEN,
    environment: env.TAMARA_ENVIRONMENT,
  }),
});
```

Map keys must equal each provider's `provider.id` (`tabby`, `tamara`) — no aliases; the plugin validates this at startup.

2. Add the plugin with the sub-plugins the app needs:

```ts
bnpl({
  providers: bnplProviders,
  persistOrders: true,
  mapUserToBuyer: ({ user }) => ({ firstName, lastName, email, phone }),
  use: [
    checkout({ resolveCheckout, trustedRedirectOrigins }),
    options(),
    orders(),
    webhooks({ onAuthorized, onCaptured, onRefunded, redelivery: { isAuthorized } }),
    admin({ isAuthorized }),
  ],
})
```

3. **Server-authoritative pricing is non-negotiable.** Always implement `checkout({ resolveCheckout })` to look up prices server-side and return the canonical money fields; without it a client can edit `totalAmount` in DevTools and pay 1 SAR for a 450 SAR order. Client-sent amounts are discarded once the resolver exists.

Done when: the provider map is exported, the plugin compiles with `resolveCheckout` implemented against the app's real catalogue, and every credential is read from env — none inline.

## 4. Wire the client

```ts
import type { ProviderIdsOf } from "better-auth-bnpl";
import { bnplClient } from "better-auth-bnpl/client";
import type { bnplProviders } from "@/server/auth";

export const authClient = createAuthClient({
  plugins: [bnplClient<ProviderIdsOf<typeof bnplProviders>>()],
});
```

Every `authClient.bnpl.*` action resolves to `{ data, error }` and never throws. For the picker UI, call `authClient.bnpl.options({ country, amount, email?, phone? })` and render `data.available`; each entry carries `logoUrl`, `tagline`, and `availablePaymentTypes`. `startCheckout({ provider: opt.id, ... })` redirects to the hosted checkout.

Done when: the client compiles with provider ids type-narrowed (passing `provider: "stripe"` is a type error).

## 5. Generate the schema

`persistOrders: true` adds the `bnplOrder` and `bnplWebhookEvent` models:

```bash
npx @better-auth/cli generate
```

Upgrades must re-run this too — recent releases added columns. Add one composite the CLI cannot express: a UNIQUE index on (`provider`, `providerOrderId`) in the app's own migration.

Done when: the migration runs and both tables exist with the composite index.

## 6. Secrets

Read [`SECRETS.md`](SECRETS.md) and set up every credential the chosen providers need: which portal issues it, its env-var name, and its gotchas (Tabby's key *type* selects test vs live — there is no sandbox host; Tamara's `notificationToken` verifies webhook JWTs; Tabby's `webhookHeader.value` is a secret **you** invent).

Update the repo's `.env.example` with placeholder values for every variable, and tell the user exactly which portal page issues each real value. Never write a real secret into any tracked file.

Done when: `.env.example` lists every required variable for the chosen providers and the user knows where to obtain each real value.

## 7. Webhooks

The plugin mounts one endpoint: `POST {basePath}/bnpl/webhooks/:provider` (typically `/api/auth/bnpl/webhooks/tamara`). Register that URL in each provider's dashboard:

- **Tabby**: register the webhook with your chosen header name/value — the same pair passed to `webhookHeader`.
- **Tamara**: register the URL; verification uses the `notificationToken` JWT.

Handlers run inline before the ACK; providers time out and retry non-200s, so keep handlers fast and queue slow work. Duplicates and out-of-order deliveries are already handled (dedup keys, `orderApplied` barrier, forward-only status machine) — do not add your own dedup on top.

For local development, use a tunnel (e.g. `ngrok`) to receive sandbox webhooks and test the full provider lifecycle.

Done when: webhook URLs are registered (or the user has the exact URL and dashboard steps to do it), and any slow handler work is queued.

## 8. Verify

- `tsc --noEmit` passes, including the narrowed client provider ids.
- Boot the app: the plugin's `init()` logs the configured providers and warns on misconfiguration (e.g. `captureOnAuthorise` without `persistOrders`).
- Hit `POST /bnpl/options` with a valid `(country, amount)` and confirm each configured provider appears in the response.
- With sandbox credentials: run one full checkout → webhook → capture cycle and confirm the `bnplOrder` row advances (`new` → `approved`/`authorised` → `fully_captured`).

Done when: every configured provider shows up in `/bnpl/options` and either a sandbox lifecycle round-trip succeeded or the user has explicitly deferred it.
