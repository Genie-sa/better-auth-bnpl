# better-auth-bnpl

[![npm version](https://img.shields.io/npm/v/better-auth-bnpl.svg)](https://www.npmjs.com/package/better-auth-bnpl)
[![MIT License](https://img.shields.io/npm/l/better-auth-bnpl.svg)](./LICENSE)

Buy-Now-Pay-Later for [Better Auth](https://better-auth.com): one plugin, two MENA providers ([**Tabby**](https://tabby.ai) and [**Tamara**](https://tamara.co)), one typed order lifecycle.

Use Tabby, Tamara, or both. Your app talks to one canonical API for checkout, options, order reads, admin capture/refund/cancel, webhook verification, persistence, and typed client helpers.

```bash
npm i better-auth-bnpl
```

## Agent skill

The package ships a [skill](./skills/better-auth-bnpl-integration/SKILL.md) that walks an agent through the full integration: provider map, server-authoritative pricing, client wiring, schema generation, webhook registration, and provider secrets.

Install it via [skills.sh](https://www.skills.sh/):

```bash
npx skills add Genie-sa/better-auth-bnpl
```

## What you get

| Area | Included |
|---|---|
| Checkout | Hosted checkout creation for Tabby and Tamara |
| Picker | One `/bnpl/options` endpoint that returns available providers for the cart |
| Lifecycle | Authorise, capture, refund, cancel, void, close, and reconcile where each provider supports them |
| Webhooks | Provider-specific signature verification, canonical events, at-least-once processing with an idempotency barrier, typed handlers, admin redelivery |
| Persistence | `bnplOrder` and `bnplWebhookEvent` models with canonical status, optimistic-concurrency writes, and minor-unit money |
| Typed API | Provider ids, endpoint payloads, money, statuses, and webhook event kinds are checked at compile time |
| Provider clients | Raw Tabby and Tamara HTTP clients backed by generated OpenAPI contracts and Zod validation |
| Example app | TanStack Start + shadcn demo with user checkout, admin actions, webhook replay, provider modes, and browser verification logs |

---

## Why this plugin

BNPL gateways in MENA expose similar merchant workflows:

1. Create a hosted-checkout session
2. Optionally pre-check eligibility
3. Authorise → capture → refund → cancel
4. Send signed webhooks for state changes
5. Provide an admin API to do the above server-side

Each provider uses different request bodies, status names, required fields, idempotency rules, region routing, and webhook signing. `better-auth-bnpl` keeps those differences behind one application-facing contract.

You can start with one provider and add the other later without rewriting checkout, webhook, order, or admin code.

---

## Supported surface

The plugin targets the online merchant BNPL lifecycle, not every auxiliary product each provider offers.

| Capability | Tabby | Tamara |
|---|---|---|
| Countries | SA, AE, KW | SA, AE, BH, KW, OM |
| Currencies | SAR, AED, KWD | SAR, AED, KWD, BHD, OMR |
| Hosted checkout | Yes | Yes |
| Pre-check / eligibility | Heuristic plus checkout pre-scoring | Dedicated `/pre-checkout/v1/eligibility` |
| Authorise step | N/A | Yes; auto-handled from the approved webhook unless `autoAuthorise: false` |
| Capture | Full, partial, multiple | Full, partial, multiple |
| Refund | Full, partial | Full, partial |
| Cancel | Via close payment | Yes |
| Void abandoned checkout | N/A | Yes |
| Close payment | Yes | N/A |
| Webhook receive/verify | Static shared header | HS256 JWT |
| Webhook CRUD clients | Yes, raw client | Yes, raw client |
| Disputes | Tabby raw APIs only; no Better Auth route yet | N/A |
| In-store/offline flows | Not the plugin target | Raw-client/OpenAPI surface only where present |

Provider-specific operations return `OPERATION_NOT_SUPPORTED` when called for the wrong provider. For example, `/bnpl/admin/orders/:id/void` works for Tamara rows and fails cleanly for Tabby rows.

---

## Quick setup

Declare the provider map once with `BnplProviders()`. The same plugin, client, admin routes, and webhook routes work whether the map contains one provider or both.

```ts
import { betterAuth } from "better-auth";
import {
  BnplProviders,
  admin,
  bnpl,
  checkout,
  options,
  orders,
  webhooks,
} from "better-auth-bnpl";
import { tabby } from "better-auth-bnpl/tabby";
import { tamara } from "better-auth-bnpl/tamara";

export const bnplProviders = BnplProviders({
  tabby: tabby({
    secretKey: "tabby_secret_key",
    merchantCode: "merchant_code",
    webhookHeader: {
      name: "X-Tabby-Webhook",
      value: "long_random_shared_secret",
    },
    environment: "production",
    country: "SA",
  }),
  tamara: tamara({
    apiToken: "tamara_api_token",
    notificationToken: "tamara_notification_token",
    environment: "production",
  }),
});

export const auth = betterAuth({
  plugins: [
    bnpl({
      providers: bnplProviders,
      persistOrders: true,
      autoAuthorise: true,
      captureOnAuthorise: true,
      captureOnAuthoriseShippingInfo: () => ({
        shippedAt: new Date().toISOString(),
        shippingCompany: "Digital delivery",
      }),
      mapUserToBuyer: ({ user }) => ({
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phoneNumber,
      }),
      use: [
        checkout({ resolveCheckout: ... }),
        options(),
        orders(),
        webhooks({ onAuthorized, onCaptured, onRefunded }),
        admin({ isAuthorized: ({ session }) => session.user.role === "admin" }),
      ],
    }),
  ],
});
```

---

## Three setups, one API

The library exports the same `bnpl()` plugin and `bnplClient()` regardless of how many providers you use. The provider map is the only part that changes.

### Tabby only

```ts
import { betterAuth } from "better-auth";
import {
  admin,
  bnpl,
  checkout,
  BnplProviders,
  options,
  orders,
  webhooks,
} from "better-auth-bnpl";
import { tabby } from "better-auth-bnpl/tabby";

export const bnplProviders = BnplProviders({
  tabby: tabby({
    secretKey:    "tabby_secret_key",
    merchantCode: "merchant_code",
    webhookHeader: {
      name:  "X-Tabby-Webhook",
      value: "long_random_shared_secret",
    },
    environment: "production",
    country: "SA",
  }),
});

export const auth = betterAuth({
  plugins: [
    bnpl({
      providers: bnplProviders,
      persistOrders: true,
      mapUserToBuyer: ({ user }) => ({
        firstName: user.firstName,
        lastName:  user.lastName,
        email:     user.email,
        phone:     user.phoneNumber,
      }),
      use: [checkout(), options(), orders(), webhooks(), admin({ isAuthorized: ... })],
    }),
  ],
});
```

### Tamara only

```ts
import { BnplProviders } from "better-auth-bnpl";
import { tamara } from "better-auth-bnpl/tamara";

export const bnplProviders = BnplProviders({
  tamara: tamara({
    apiToken:          "tamara_api_token",
    notificationToken: "tamara_notification_token",
    environment:       "production",
  }),
});

bnpl({
  providers: bnplProviders,
})
```

### Both: the end-user picks

```ts
import { BnplProviders } from "better-auth-bnpl";
import { tamara } from "better-auth-bnpl/tamara";
import { tabby }  from "better-auth-bnpl/tabby";

export const bnplProviders = BnplProviders({
  tamara: tamara({ {} }),
  tabby:  tabby({ {} }),
});

bnpl({
  providers: bnplProviders,
  autoAuthorise: true,
  persistOrders: true,
  mapUserToBuyer: ...,
  use: [checkout(), options(), orders(), webhooks(), admin({ ... })],
});
```

That's the entire server-side change to add a second provider. Webhooks, admin, orders, and the picker all just work.

Provider map keys are part of the public API and must match each provider's stable `provider.id`:

```ts
BnplProviders({
  tamara: tamara({ {} }),
  tabby:  tabby({ {} }),
});
```

Do not alias built-in providers as `tamaraKsa`, `tabbyAe`, etc. Persisted orders route back to providers by `provider.id`, and the plugin validates this at startup so checkout, admin, and webhook dispatch stay deterministic.

---

## The end-user picker

Show your customer **only the BNPL options that work for their cart**, with provider logos and terms, no separate Tabby/Tamara branches in your UI.

### Server side

`POST /bnpl/options` runs `preCheck` against every configured provider in parallel and returns a typed list. Failures degrade gracefully, so a flaky provider doesn't take down the picker. Pass `email` and `phone` when they are known at checkout so Tabby can run its documented background pre-scoring against the Checkout API; cart/product pages can omit them and still receive the local amount/country availability check.

### Client side

```tsx
"use client";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

export function BnplPicker({
  priceSar,
  productId,
  buyer,
}: {
  priceSar: number;
  productId: string;
  buyer?: { email?: string; phone?: string };
}) {
  const [options, setOptions] = useState<Array<{
    id: string; displayName: string; logoUrl?: string; tagline?: string;
    available: boolean; reason?: string;
  }>>([]);

  useEffect(() => {
    authClient.bnpl.options({
      country: "SA",
      amount:  { amount: priceSar.toFixed(2), currency: "SAR" },
      email: buyer?.email,
      phone: buyer?.phone,
    }).then(({ data }) => setOptions(data?.options ?? []));
  }, [priceSar, buyer?.email, buyer?.phone]);

  const usable = options.filter((o) => o.available);

  return (
    <div className="bnpl-picker">
      {usable.length === 0 && <p>No BNPL options available for this order.</p>}
      {usable.map((opt) => (
        <button
          key={opt.id}
          onClick={() =>
            authClient.bnpl.startCheckout({
              provider: opt.id,
              description: "Order",
              countryCode: "SA",
              shippingAddress: { line1: "X", city: "Riyadh", countryCode: "SA" },
              additionalData: { productId },
            })
          }
        >
          {opt.logoUrl && <img src={opt.logoUrl} alt={opt.displayName} />}
          <strong>{opt.displayName}</strong>
          <span>{opt.tagline}</span>
        </button>
      ))}
    </div>
  );
}
```

`startCheckout()` redirects the browser to the hosted-checkout URL on success. Like every client action it resolves to `{ data, error }` and never throws; pass `{ redirect: false }` to skip the redirect and inspect the result yourself (analytics pre-flight, in-app webview wrappers, non-browser environments, or reading `error.code`).

### What `options` returns

```ts
{
  options:     [tamara, tabby, ...],
  available:   [tamara],
  unavailable: [tabby],

}
```

### Caching eligibility

`/bnpl/options` is deliberately **not** cached by the plugin: eligibility is a per-customer, time-sensitive credit decision, and an in-process cache is useless in serverless anyway. Cache at the app layer instead — e.g. a React Query `staleTime` around `authClient.bnpl.options()` — so repeated cart renders don't re-hit both providers.

### Provider-namespaced shortcuts

If you don't want a picker because your UI hardcodes one provider, use the namespaced helpers. The `provider` field is preset for you:

```ts
await authClient.bnpl.tabby.startCheckout({});
await authClient.bnpl.tamara.startCheckout({});
```

For custom or future providers, use the same namespaced shape without waiting
for this package to add a hardcoded shortcut:

```ts
await authClient.bnpl.provider("my-provider").startCheckout({ {} });
```

---

## TypeScript Usage

Declare your providers map with `BnplProviders()` once. The client then knows which provider ids are valid for checkout, order filters, and provider-specific shortcuts.

```ts
import { bnpl, BnplProviders } from "better-auth-bnpl";
import { tamara } from "better-auth-bnpl/tamara";
import { tabby } from "better-auth-bnpl/tabby";

export const bnplProviders = BnplProviders({
  tamara: tamara({ ... }),
  tabby:  tabby({ ... }),
});

export const auth = betterAuth({
  plugins: [bnpl({ providers: bnplProviders, use: [...] })],
});

import { createAuthClient } from "better-auth/react";
import type { ProviderIdsOf } from "better-auth-bnpl";
import { bnplClient } from "better-auth-bnpl/client";
import type { bnplProviders } from "@/server/auth";

type BnplProviderId = ProviderIdsOf<typeof bnplProviders>;

export const authClient = createAuthClient({
  plugins: [bnplClient<BnplProviderId>()],
});

await authClient.bnpl.startCheckout({ provider: "tabby",  ... });
await authClient.bnpl.startCheckout({ provider: "tamara", ... });
```

Webhook handlers receive the fields that match the event kind:

```ts
webhooks({
  onCaptured: async ({ event }) => {
    event.captureId;
    event.amountMinor;
    event.currency;
    event.orderId;
  },
  onRefunded: async ({ event }) => {
    event.refundId;
    event.amountMinor;
  },
});
```

### Server-side usage

The same endpoints are reachable server-side through `auth.api.bnpl*`, fully typed when the `use: [...]` tuple is passed inline (the composed endpoint types flow through `BnplEndpoints`). `auth.$Infer` exposes `BnplOrder`, `BnplOrderWithRemote`, and `BnplWebhookEvent` for typing your own reads. At startup, `init()` logs the configured providers and warns if `captureOnAuthorise` is set without `persistOrders` (or without `captureOnAuthoriseShippingInfo`).

For code paths outside the request lifecycle — cron jobs, queue workers, scripts — `createBnplClient({ providers })` wraps the same providers with a namespaced, fully-inferred API. Its `authorize()` returns the full `BnplAuthorizeResult` (`autoCaptured` / `captureId` / `capturedAmountMinor` / `raw`):

```ts
import { createBnplClient, BnplProviders } from "better-auth-bnpl";

const bnplServer = createBnplClient({ providers: bnplProviders });

await bnplServer.tamara.capture("ord_abc", {
  totalAmount: { amount: "450", currency: "SAR" },
  shippingInfo: { shippedAt: new Date().toISOString(), shippingCompany: "Aramex" },
});
```

---

## Server-authoritative pricing

**The most important security feature.** Without it, a client editing `totalAmount` in DevTools can pay 1 SAR for a 450 SAR order, because the BNPL provider has no knowledge of your catalogue.

```ts
import { z } from "zod";

const checkoutDataSchema = z.object({
  productId: z.string(),
});

checkout({
  resolveCheckout: async ({ user, input, endpointContext }) => {
    const { productId } = checkoutDataSchema.parse(input.additionalData);
    const product = await endpointContext.context.adapter.findOne<{
      sku: string; name: string; priceCents: number;
    }>({ model: "product", where: [{ field: "id", value: productId }] });
    if (!product) throw new Error("Product not found");
    const price = (product.priceCents / 100).toFixed(2);
    return {
      totalAmount: { amount: price, currency: "SAR" },
      taxAmount:    { amount: "0", currency: "SAR" },
      shippingAmount: { amount: "0", currency: "SAR" },
      items: [{
        referenceId: product.sku,
        name: product.name,
        sku:  product.sku,
        quantity: 1,
        totalAmount: { amount: price, currency: "SAR" },
      }],
    };
  },
}),
```

When `resolveCheckout` is set, the `/bnpl/checkout` body becomes **relaxed**: money fields are optional. Any client-sent amounts are discarded; your resolver's return value is canonical. Same pattern, all providers.

For Tabby merchants that need buyer/order history or an education attachment, return a typed
`TabbyCheckoutData` as `providerData` from `resolveCheckout`. This value is server-only: public
checkout bodies cannot supply it, and it is not included in checkout responses, persisted order
metadata, or checkout callback contexts. The Tabby adapter validates it before mapping it to
`payment.buyer_history`, `payment.order_history`, and `payment.attachment`.

```ts
import type { TabbyCheckoutData } from "better-auth-bnpl/tabby";

const providerData = {
  buyer_history: {
    registered_since: "2024-01-15T12:00:00Z",
    loyalty_level: 1,
  },
  order_history: [],
  attachment: {
    body: {
      education_details: {
        merchant_subtype: "courses_training",
        program: { payment_tenure_months: 0, months_to_completion: 0 },
        student_history: { late_payments_count: 0, avg_overdue_duration_days: 0 },
      },
    },
    content_type: "application/vnd.tabby.v1+json",
  },
} satisfies TabbyCheckoutData;
```

### Checkout options

- **Sessions and anonymous users.** A session is always required — persistence and buyer mapping need a user id, so there is no guest checkout. `checkout({ authenticatedUsersOnly: false })` only permits Better Auth *anonymous-plugin* sessions (which still carry a user id); the default (`true`) rejects them with `ANONYMOUS_USER_NOT_ALLOWED`. No session at all is always a 401.
- **Per-checkout redirect URLs.** The `/bnpl/checkout` body accepts `successUrl` / `failureUrl` / `cancelUrl` (absolute http(s), ≤1024 chars). Because these become post-payment redirect targets, they are gated by `checkout({ trustedRedirectOrigins })`: an origin not in the allowlist is rejected with `400 INVALID_URL`. The default allowlist is the origin of your Better Auth `baseURL`. Precedence per URL: body field → plugin-level `successUrl`/`failureUrl`/`cancelUrl` option → default path.
- **Metadata size cap.** `metadata` and `additionalData` are each capped at 8KB when JSON-stringified. `metadata` is persisted to `bnplOrder.metadata`; `additionalData` is forwarded to the provider.
- **Webhook notification URL.** The default notification URL respects a custom Better Auth `basePath` — it is built relative to `ctx.context.baseURL` rather than a hardcoded `/api/auth`. Override with `checkout({ notificationUrlBuilder })`.

---

## Endpoint reference

All paths mount under Better Auth's API prefix (typically `/api/auth`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/bnpl/checkout` | session | Create a hosted-checkout session; body's `provider` selects gateway |
| `POST` | `/bnpl/options` | optional | Return per-provider availability for `(country, amount, email, phone)`; the picker |
| `GET` | `/bnpl/orders` | session | List the user's BNPL orders, filterable by `provider` |
| `GET` | `/bnpl/orders/:providerOrderId` | session | Get one order by the provider's order id; includes live `remote` payload |
| `GET` | `/bnpl/orders/reference-id/:ref` | session | Lookup by merchant reference id |
| `POST` | `/bnpl/webhooks/:provider` | provider sig | Single endpoint, dispatches to the right verifier by URL param |
| `GET` | `/bnpl/admin/orders` | admin | List/search all orders (`provider`/`status`/`userId` filters, paginated) |
| `POST` | `/bnpl/admin/orders/:orderId/capture` | admin | Capture, full or partial; provider auto-detected |
| `POST` | `/bnpl/admin/orders/:orderId/refund` | admin | Refund; provider auto-detected |
| `POST` | `/bnpl/admin/orders/:orderId/cancel` | admin | Cancel; provider auto-detected |
| `POST` | `/bnpl/admin/orders/:orderId/authorise` | admin | Manual authorise; Tamara only, 400 for other providers |
| `POST` | `/bnpl/admin/orders/:orderId/reconcile` | admin | Re-fetch upstream + sync local row (authoritative-remote) |
| `POST` | `/bnpl/admin/orders/:orderId/void` | admin | Void abandoned checkout; Tamara only |
| `POST` | `/bnpl/admin/orders/:orderId/close` | admin | Close payment + auto-refund remainder; Tabby only |
| `GET` | `/bnpl/admin/webhook-events` | admin | List/search webhook events (`status`/`provider`/`providerOrderId`, paginated); needs `webhooks({ redelivery })` |
| `POST` | `/bnpl/admin/webhook-events/:id/redeliver` | admin | Re-drive a failed event through persistence + dispatch; needs `webhooks({ redelivery })` |

Admin order routes resolve the order by its provider order id. The `/bnpl/admin/webhook-events*` routes are mounted only when `webhooks()` is passed a `redelivery` option (see [Webhooks](#webhooks)).

Provider-specific endpoints (authorise / void / close) return `400 OPERATION_NOT_SUPPORTED` when called against a row whose provider doesn't support that operation.

Tabby product selection follows the canonical `paymentType` field: `PAY_BY_INSTALMENTS` and `SPLIT_IN_3` select Tabby's `installments`, `PAY_BY_LATER` selects `pay_later`, and `PAY_NOW` selects `pay_in_full` (`installments` is the default when `paymentType` is omitted). `installments` is the only product key Tabby documents; there is no cross-product fallback. If the requested product has no hosted-checkout URL in Tabby's response, checkout fails rather than silently switching the payment terms.

---

## Provider options

Pass provider credentials and webhook settings directly to `tabby()` and `tamara()`. Keep secret loading in your application config; the plugin API stays a typed provider-options object.

```ts
import { BnplProviders } from "better-auth-bnpl";
import { tamara } from "better-auth-bnpl/tamara";
import { tabby }  from "better-auth-bnpl/tabby";

const bnplProviders = BnplProviders({
  tamara: tamara({
    apiToken: "tamara_api_token",
    notificationToken: "tamara_notification_token",
    environment: "production",
  }),
  tabby: tabby({
    secretKey: "tabby_secret_key",
    merchantCode: "merchant_code",
    webhookHeader: {
      name: "X-Tabby-Webhook",
      value: "long_random_shared_secret",
    },
    environment: "production",
    country: "SA",
  }),
});

bnpl({
  providers: bnplProviders,
});
```

### Tamara

| Option | Required | Notes |
|---|---|---|
| `apiToken` | yes | Bearer token from the Tamara merchant portal |
| `notificationToken` | yes | HMAC secret used to verify the webhook JWT |
| `environment` | no | `"sandbox"` \| `"production"`; defaults to `"sandbox"` |
| `replayToleranceSeconds` | no | `number \| false`. Defaults to `300`. Rejects a delivery whose JWT `iat` is older than the window (enforced only when `iat` is present); `false` disables it |
| `timeoutMs` | no | Per-request upstream timeout in ms; defaults to `15000` |
| `baseUrl` | no | Override base URL for tests or proxies |
| `defaultLocale` | no | Fallback locale when a checkout omits one |
| `storeCode` | no | Multi-store accounts only |

Tamara's webhook **body is unsigned by design**. The `?tamaraToken=` / `Authorization: Bearer` JWT authenticates the *caller* — its payload is only `{ iss, iat, exp }`, no event data — so the parsed body is trusted once the token verifies. The mitigations are: HS256 pinned (no `alg` confusion), a timing-safe HMAC compare, `exp` enforced, `iss` pinned to `"Tamara"`, and the `replayToleranceSeconds` window bounding how long a leaked token can be replayed with a forged body (query-param tokens leak into access/proxy/CDN logs). Separately, note that Tamara auto-captures orders not captured within 21 days of authorisation (per Tamara's docs) — the plugin does not enforce this; capture before then.

### Tabby

| Option | Required | Notes |
|---|---|---|
| `secretKey` | yes | Bearer token. Its type (`sk_test_…` vs `sk_…`) is what selects Tabby's test vs live environment |
| `merchantCode` | yes | Sent in checkout body and `X-Merchant-Code` header |
| `webhookHeader.name` | yes | The static header name configured at webhook registration time |
| `webhookHeader.value` | yes | Shared secret; use a long random value and rotate periodically |
| `country` | no | Host selector only: `"SA"` routes to `api.tabby.sa` (test **and** live); `"AE"`/`"KW"` route to `api.tabby.ai` |
| `environment` | no | Informational only — Tabby has no sandbox host, so this never affects routing. Test vs live is the key type |
| `timeoutMs` | no | Per-request upstream timeout in ms; defaults to `15000` |
| `baseUrl` | no | Full host override; wins over `country` |
| `preCheckBounds` | no | Per-currency amount bounds for the `preCheck()` heuristic |

There is **no Tabby sandbox host**: the environment is determined entirely by the secret-key type, and `country: "SA"` always routes to `api.tabby.sa` (including test payments). The `environment` option is retained for config readability but does not affect routing.

Tabby's webhook signing is *static-secret per registered webhook*, not body-HMAC. Use a long random `TABBY_WEBHOOK_HEADER_VALUE` and rotate periodically.

### Timeouts and retries

Every upstream call to either provider is timeout-bounded (`timeoutMs`, default `15000`). Idempotent GETs retry up to twice with exponential backoff plus jitter on transient failures (429/502/503/504 and timeouts); money mutations (capture/refund/close) never blind-retry — a POST that times out may have succeeded upstream, so retrying it risks a double charge.

---

## Webhooks

`POST /bnpl/webhooks/:provider` is a single endpoint where the URL parameter selects the provider's verifier. Tabby and Tamara use entirely different signing schemes (Tabby: static header secret; Tamara: HS256 JWT in `?tamaraToken=` or `Authorization: Bearer`); the umbrella plugin keeps them isolated.

Each handler receives a **narrowed** event type, so runtime `if (event.kind === "captured")` checks are not needed. `event.captureId` and `event.amountMinor` are present and typed inside `onCaptured`; `event.refundId` is typed inside `onRefunded`; etc.

```ts
webhooks({
  onApproved: async ({ provider, event, autoAuthoriseResult }) => {},

  onAuthorized: async ({ provider, event }) => {},

  onCaptured: async ({ provider, event }) => {
    console.log(event.captureId, event.amountMinor, event.currency);
  },

  onRefunded: async ({ provider, event }) => {
    console.log(event.refundId, event.amountMinor);
  },

  onCanceled: async ({ provider, event }) => {},

  onExpired: async ({ provider, event }) => {},

  onDeclined: async ({ provider, event }) => {},

  onUpdated: async ({ provider, event }) => {},

  onStatusChange: async ({ provider, orderId, from, to, event }) => {},

  onPayload: async ({ provider, event }) => {},

  tamara: {
    onAuthoriseNotification: async (rawPayload, { autoAuthoriseResult }) => {
      switch (autoAuthoriseResult.status) {
        case "authorised": break;
        case "already-authorised": break;
        case "disabled": break;
        case "failed": break;
      }
    },
  },
  tabby: {
    onPaymentClosed: async (raw) => {},
  },
}),
```

### At-least-once processing

When `persistOrders: true`, every verified webhook gets a `bnplWebhookEvent` row keyed by a provider-prefixed dedup key (`{provider}:{eventType}:{capture_id|refund_id|...}`). Each row moves through a lifecycle: `received` → `processed` (persistence + typed dispatch succeeded) or `failed` (any step threw). The row also tracks `attempts`, `orderApplied`, `processedAt`, and `lastError`.

- **Failures retry, and the same event re-processes.** If a handler or persistence step throws, the row is marked `failed` and the endpoint returns HTTP 500. Providers retry non-200 deliveries, and the retry re-processes the *same* row rather than treating it as a duplicate.
- **Money is never double-counted.** The `orderApplied` flag is the idempotency barrier: it is set the moment a capture/refund delta commits to the order row. A retry after a mid-pipeline failure skips the delta (status and `rawData` still refresh) so the cumulative amount is never applied twice.
- **Duplicates of already-processed events are cheap.** A redelivery of a `processed` event ACKs `{ received: true, duplicate: true }` without re-running any handlers.

Admin capture/refund calls and `captureOnAuthorise` pre-seed the same provider-native dedup keys before the matching provider webhook arrives, so a merchant-initiated capture followed by `order_captured` / a Tabby capture delivery does not double-count `capturedAmountMinor` or re-fire typed handlers.

For distributed retries, pass stable operation references from your order system: `merchantReferenceId` on capture and `merchantRefundId` on refund. Tabby requires these as `reference_id` idempotency keys. Admin endpoints derive deterministic references from the persisted order state when omitted, but explicit references are the strongest contract when jobs may be retried across processes.

### Status state machine

Order status advances along a forward-only transition table, because provider webhooks are at-least-once and unordered:

- **Regressions are ignored.** A late or retried event whose target status is not a legitimate forward transition keeps the current status and logs a warning; `rawData`/`updatedAt` and the cumulative deltas still apply.
- **Tamara `order_updated` never changes status** — it only revises amounts/`rawData`.
- **Currency-mismatched deltas are skipped.** A capture/refund event whose currency differs from the stored order currency logs a warning and applies no delta (a ×1000 KWD delta on a ×100 SAR order would be 10× off).
- **Admin reconcile is authoritative-remote** and bypasses the transition guard, writing the provider's own status directly (optimistic versioning still guards against a concurrent webhook clobbering it).

### Handler time budget

Handlers run **inline, before the endpoint ACKs**. Providers time out slow webhook requests and retry: Tabby times out at 1 minute and retries up to 4 more times over exponential ~1–4 minute intervals, only HTTP 200 acknowledges, delivery order is not guaranteed, and duplicates happen (all per Tabby's official docs). Keep handlers fast and offload slow work to a queue. The dedup + lifecycle machinery makes such a retry safe (already-processed events ACK without re-running), but a slow handler still burns a provider retry.

### Admin redelivery

Pass a `redelivery` option to mount two admin-gated recovery endpoints — the path once a provider exhausts its automatic retries:

```ts
webhooks({
  onCaptured, onRefunded,
  redelivery: {
    isAuthorized: ({ session }) => session.user.role === "admin",
  },
});
```

- `GET /bnpl/admin/webhook-events` — list/search events (filter by `status` / `provider` / `providerOrderId`, paginated).
- `POST /bnpl/admin/webhook-events/:id/redeliver` — re-derive the canonical event from the stored `rawData` and re-run persistence + typed dispatch. The `orderApplied` barrier still protects against re-applying a delta.

### Auto-authorise (Tamara)

Tamara requires you to call `POST /orders/{id}/authorise` within 72h of the customer's approval signal. With `autoAuthorise: true` on the umbrella plugin (default), this happens automatically when an `approved` webhook arrives. Handler receives the outcome via `autoAuthoriseResult`. **Tabby providers ignore this flag** because they have no equivalent step.

`captureOnAuthorise` is intentionally opt-in for digital-goods flows and requires `persistOrders: true`; without a persisted row the plugin cannot know the authoritative captured amount/currency, so it logs and skips auto-capture. Tamara capture also requires shipping provenance, so provide `captureOnAuthoriseShippingInfo` when enabling this mode. Physical-goods flows should keep it off and use admin capture after dispatch with `shippingInfo`.

```ts
bnpl({
  providers: bnplProviders,
  persistOrders: true,
  captureOnAuthorise: true,
  captureOnAuthoriseShippingInfo: () => ({
    shippedAt: new Date().toISOString(),
    shippingCompany: "Digital delivery",
  }),
  use: [checkout(), orders(), webhooks()],
});
```

---

## Admin

Admin endpoints are mounted only when the `admin()` sub-plugin is in `use:`. They look up the order's provider from the row, then dispatch to the matching provider method. `admin()` also mounts `GET /bnpl/admin/orders` — a back-office list/search over every order (`provider` / `status` / `userId` filters, paginated), covered by the typed `authClient.bnpl.admin.listOrders()` helper. Admin rows are FULL persisted orders, `rawData` included (only user-facing reads strip it).

```ts
import { authClient } from "@/lib/auth-client";

await authClient.bnpl.admin.listOrders({ status: "partially_captured" });

await authClient.bnpl.admin.capture(orderId, {
  totalAmount: { amount: "450", currency: "SAR" },
  merchantReferenceId: `capture:${orderId}:shipment-1`,
  shippingInfo: {
    shippedAt: new Date().toISOString(),
    shippingCompany: "Aramex",
    trackingNumber: "TRK123",
  },
});

await authClient.bnpl.admin.refund(orderId, {
  totalAmount: { amount: "100", currency: "SAR" },
  merchantRefundId: `refund:${orderId}:rma-1`,
  comment: "Customer returned item",
});

await authClient.bnpl.admin.reconcile(orderId);
```

The webhook-event helpers are mounted only when the server configures `webhooks({ redelivery })` (see [Admin redelivery](#admin-redelivery)); calling them without it returns a 404.

```ts
const { data } = await authClient.bnpl.admin.listWebhookEvents({ status: "failed" });

await authClient.bnpl.admin.redeliverWebhookEvent(eventId);
```

---

## Persisted order schema

`persistOrders: true` enables the `bnplOrder` and `bnplWebhookEvent` tables. Run `npx @better-auth/cli generate` to add them. **Existing installs must re-run generate after upgrading to this release** — it adds new columns (below).

**`bnplOrder`**: one row per checkout, **discriminated by `provider`**:

| Column | Type | Notes |
|---|---|---|
| `id` | string | PK |
| `userId` | string? | FK → `user.id`, `onDelete: "set null"`. Nullable: financial records are retained for audit/compliance when a user deletes their account. An orphaned (null-owner) row never matches any owner-scoped read |
| `provider` | string | `"tabby"` \| `"tamara"` \| ... |
| `orderReferenceId` | string (unique) | Your reference id |
| `providerOrderId` | string | Provider's id (Tamara: `order_id`, Tabby: `payment.id`) |
| `providerCheckoutId` | string | Provider's checkout-session id |
| `status` | string | Canonical: `new`, `approved`, `authorised`, `partially_captured`, `fully_captured`, `partially_refunded`, `fully_refunded`, `canceled`, `declined`, `expired`, `closed`, `updated` |
| `amountMinor` | number | Integer minor units (halalat for SAR, fils for AED/KWD/BHD, baisa for OMR) |
| `currency` | string | ISO 4217: SAR, AED, KWD, BHD, OMR |
| `paymentType` | string? | `PAY_BY_INSTALMENTS` etc. |
| `authorisedAt`, `capturedAt`, `canceledAt` | date? | Lifecycle timestamps |
| `capturedAmountMinor` | number | Running total, default `0` |
| `refundedAmountMinor` | number | Running total, default `0` |
| `rawData` | string? | Last raw provider response (JSON-stringified). `returned: false` and **stripped from all user-facing reads** (`GET /bnpl/orders*`) — full gateway payloads (buyer PII, wire details) stay on the admin surface |
| `metadata` | string? | Application-level metadata |
| `version` | number | Optimistic-concurrency write token, default `0`. Not a counter — every mutation is guarded against concurrent writers so a lost cumulative-amount update can't happen |
| `createdAt`, `updatedAt` | date | |

**`bnplWebhookEvent`**: one row per verified webhook, unique `dedupKey`:

| Column | Type | Notes |
|---|---|---|
| `provider`, `providerOrderId` | string | Discriminator + lookup |
| `eventKind` | string | Canonical (`captured` / `refunded` / etc.) |
| `eventType` | string | Provider's native name (e.g. `order_captured`) |
| `dedupKey` | string (unique) | `"{provider}:{eventType}:{id}"` |
| `receivedAt` | date | |
| `rawData` | string? | JSON-stringified payload; `returned: false` |
| `status` | string | Processing lifecycle: `received` → `processed` \| `failed`. Default `received` |
| `attempts` | number | Processing attempts, incremented on each failure. Default `0` |
| `orderApplied` | boolean | Whether this event's money delta has been applied to the order (the re-processing idempotency barrier). Default `false` |
| `processedAt` | date? | When processing succeeded; null while `received`/`failed` |
| `lastError` | string? | Last processing error — diagnostics for redelivery tooling |

Hot lookup columns declare `index: true`, so `npx @better-auth/cli generate` emits the indexes. Server-managed fields are `input: false` (rows are written only by the plugin's endpoints, never from client bodies). One composite the field-level attribute cannot express: a UNIQUE (`provider`, `providerOrderId`) pair — webhook lookups scope by both fields, so add that composite in your own migration.

### Money: minor units

The wire format and your `BnplMoney` inputs are decimal strings (`"99.99"`); the DB stores integer minor units (`9999`) per ISO 4217. KWD/BHD/OMR are 3-decimal currencies (×1000 multiplier). Use the exported helpers when reading or writing:

```ts
import { parseAmount, formatAmount } from "better-auth-bnpl";

parseAmount({ amount: "99.99", currency: "SAR" });
formatAmount(9999, "SAR");
```

The wire `amount` must be a **canonical decimal string** — no thousands separators, sign, or scientific notation. Garbage is rejected at the schema edge (even with `persistOrders` off), and an amount whose minor units would exceed `Number.MAX_SAFE_INTEGER` throws `AMOUNT_TOO_LARGE`.

---

## Error codes

Every client action resolves to `{ data, error }`; `error.code` narrows to `BnplErrorCode`. See `src/core/errors.ts` for the authoritative list.

```ts
import { BNPL_ERROR_CODES } from "better-auth-bnpl";

const { error } = await authClient.bnpl.startCheckout(body, { redirect: false });
if (error?.code === "CHECKOUT_REJECTED") {}
```

| Code | Meaning |
|---|---|
| `AUTH_REQUIRED` | Session required |
| `ANONYMOUS_USER_NOT_ALLOWED` | Session is anonymous |
| `BUYER_MAPPER_MISSING` | `mapUserToBuyer` not provided |
| `PROVIDER_NOT_CONFIGURED` | Requested provider id is not in `providers` map |
| `CURRENCY_NOT_SUPPORTED_BY_PROVIDER` | Provider doesn't support this currency |
| `CHECKOUT_CREATION_FAILED` | Upstream rejected the request |
| `CHECKOUT_REJECTED` | Pre-scoring rejected at create time (Tabby) |
| `INVALID_URL` | A checkout redirect URL is not absolute http(s) or its origin isn't in `trustedRedirectOrigins` |
| `RESOLVE_CHECKOUT_INCOMPLETE` | `resolveCheckout` returned without the canonical money fields |
| `OPERATION_NOT_SUPPORTED` | Admin op called against a provider that doesn't support it |
| `ORDER_NOT_FOUND` / `ORDER_NOT_OWNED` | Order lookup / ownership |
| `LIST_REQUIRES_PERSISTENCE` | Listing orders needs `persistOrders: true` |
| `INVALID_AMOUNT` / `UNKNOWN_CURRENCY` | Money validation (`INVALID_AMOUNT` also covers out-of-range / non-canonical amounts) |
| `WEBHOOK_PROVIDER_UNKNOWN` / `WEBHOOK_MISSING_TOKEN` / `WEBHOOK_INVALID_SIGNATURE` / `WEBHOOK_MALFORMED_BODY` / `WEBHOOK_UNKNOWN_SHAPE` | Webhook verification / parsing |
| `WEBHOOK_HANDLER_FAILED` / `WEBHOOK_PERSIST_FAILED` | Webhook processing failed (row marked `failed`, 500 returned, provider retries) |
| `WEBHOOK_EVENT_NOT_FOUND` / `WEBHOOK_EVENT_NOT_REPLAYABLE` / `WEBHOOK_REDELIVERY_FAILED` | Admin redelivery tooling |
| `CAPTURE_FAILED` / `REFUND_FAILED` / `CANCEL_FAILED` / `VOID_FAILED` / `AUTHORISE_FAILED` / `RECONCILE_FAILED` / `CLOSE_PAYMENT_FAILED` | Provider-side rejection |

---

## Provider-specific behavior

The common lifecycle is canonical, but provider rules are still enforced where they matter.

| Rule | Enforcement |
|---|---|
| Tamara requires `shipping_info.shipped_at` and `shipping_info.shipping_company` on capture | `tamara.capture(...)` and admin capture reject missing shipping provenance before calling Tamara |
| Tamara requires a separate authorise call after approval | The plugin calls authorise automatically on `approved` unless `autoAuthorise: false` |
| Tamara cancel requires `totalAmount` | Typed `TamaraCancelArgs` and runtime validation enforce it |
| Tabby capture requires `reference_id` | Typed `TabbyCaptureArgs.merchantReferenceId` and runtime validation enforce it |
| Tabby refund requires `reference_id` | Typed `TabbyRefundArgs.merchantRefundId` and runtime validation enforce it |
| Tabby KSA merchants use the Saudi API host | `country: "SA"` routes to `https://api.tabby.sa` (test and live); AE/KW route to `https://api.tabby.ai` |
| Tabby sandbox vs live is key-based | The `secretKey` type (`sk_test_…` vs `sk_…`) determines environment; there is no sandbox host and `environment` is informational only |
| Tabby has no `CAPTURED` status | Its lifecycle is `CREATED → AUTHORIZED → CLOSED` (`REJECTED`/`EXPIRED` terminal). A partial capture stays `AUTHORIZED` (→ `partially_captured`); a full capture closes the payment (→ `fully_captured`); the plugin disambiguates `CLOSED` by captured/refunded amounts (`fully_captured` / refund states / `canceled` when closed with zero captures). Webhook payloads use lowercase statuses and carry no `event` field |
| Provider-specific admin operations are not interchangeable | Unsupported operations return `OPERATION_NOT_SUPPORTED` |

## License

MIT © Ali Dhamen.
