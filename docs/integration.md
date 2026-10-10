# Integration reference

Start with the [README](../README.md) for server and client setup. Use this guide for endpoint details, provider settings, schema upgrades, and recovery behavior.

## Server-authoritative pricing

Without server-side pricing, a client editing `totalAmount` in DevTools can pay 1 SAR for a 450 SAR order, because the BNPL provider has no knowledge of your catalogue.

```ts
import { z } from "zod";
import { formatAmount } from "better-auth-bnpl";

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
    const price = formatAmount(product.priceCents, "SAR").amount;
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

### Persisted checkout retries

Supply the same `orderReferenceId` for retries of one purchase. With `persistOrders: true`, the plugin reserves that reference before calling the provider. A saved result is replayed without creating another remote checkout. Different input or an uncertain provider outcome returns 409. Pending outcomes never expire into another provider call; verify them upstream before deliberately creating a new purchase.

The database must enforce the unique `bnplOrder.orderReferenceId` constraint, including for concurrent creates. Custom adapters must preserve it; Better Auth's memory adapter is unsuitable for concurrent persisted payment processing. Omitting the reference generates a fresh one and cannot protect a subsequent client retry.

Integration hooks checkpoint separately and use an exclusive five-minute claim. A retry resumes unfinished hooks after an observed failure or expired claim. External effects still require deduplication by order reference and hook name across a crash before checkpointing. Completed checkout references retain their original hosted URL; use a new reference for an intentionally new purchase after expiry or rejection.

### Checkout options

- **Sessions and anonymous users.** Checkout always requires a session. Persistence uses its user ID for ownership; buyer mapping is required when the request omits buyer details. `checkout({ authenticatedUsersOnly: false })` only permits Better Auth *anonymous-plugin* sessions (which still carry a user id); the default (`true`) rejects them with `ANONYMOUS_USER_NOT_ALLOWED`. No session at all is always a 401.
- **Per-checkout redirect URLs.** The `/bnpl/checkout` body accepts `successUrl` / `failureUrl` / `cancelUrl` (absolute http(s), ≤1024 chars). Because these become post-payment redirect targets, they are gated by `checkout({ trustedRedirectOrigins })`: an origin not in the allowlist is rejected with `400 INVALID_URL`. The default allowlist is the origin of your Better Auth `baseURL`. Precedence per URL: body field → plugin-level `successUrl`/`failureUrl`/`cancelUrl` option → default path.
- **Metadata size cap.** `metadata` and `additionalData` are each capped at 8KB when JSON-stringified. `metadata` is persisted to `bnplOrder.metadata`; `additionalData` is forwarded to the provider.
- **Webhook notification URL.** The default notification URL respects a custom Better Auth `basePath`. it is built relative to `ctx.context.baseURL` rather than a hardcoded `/api/auth`. Override with `checkout({ notificationUrlBuilder })`.

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
| `POST` | `/bnpl/admin/orders/:orderId/authorise` | admin | Manual authorise; Tamara only |
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
| `preCheckTimeoutMs` | no | Eligibility-only budget; defaults to `200` ms. Missing phone or upstream failures leave the option available; checkout decides eligibility |
| `replayToleranceSeconds` | no | `number \| false`. Defaults to `300`. Rejects a delivery whose JWT `iat` is older than the window (enforced only when `iat` is present); `false` disables it |
| `timeoutMs` | no | Total upstream request budget, including GET retries and backoff; defaults to `15000` |
| `baseUrl` | no | Override base URL for tests or proxies |
| `defaultLocale` | no | Fallback locale when a checkout omits one |
| `storeCode` | no | Multi-store accounts only |

Tamara's webhook **body is unsigned by design**. The `?tamaraToken=` / `Authorization: Bearer` JWT authenticates the *caller*. its payload is only `{ iss, iat, exp }`, no event data. so the parsed body is trusted once the token verifies. The mitigations are: HS256 pinned (no `alg` confusion), a timing-safe HMAC compare, `exp` enforced, `iss` pinned to `"Tamara"`, and the `replayToleranceSeconds` window bounding how long a leaked token can be replayed with a forged body (query-param tokens leak into access/proxy/CDN logs). Separately, note that Tamara auto-captures orders not captured within 21 days of authorisation (per Tamara's docs). the plugin does not enforce this; capture before then.

### Tabby

| Option | Required | Notes |
|---|---|---|
| `secretKey` | yes | Bearer token. Its type (`sk_test_…` vs `sk_…`) is what selects Tabby's test vs live environment |
| `merchantCode` | yes | Sent in checkout body and `X-Merchant-Code` header |
| `webhookHeader.name` | yes | The static header name configured at webhook registration time |
| `webhookHeader.value` | yes | Shared secret; use a long random value and rotate periodically |
| `country` | no | Host selector only: `"SA"` routes to `api.tabby.sa` (test **and** live); `"AE"`/`"KW"` route to `api.tabby.ai` |
| `environment` | no | Informational only. Tabby has no sandbox host, so this never affects routing. Test vs live is the key type |
| `timeoutMs` | no | Total upstream request budget, including GET retries and backoff; defaults to `15000` |
| `baseUrl` | no | Full host override; wins over `country` |
| `preCheckBounds` | no | Per-currency amount bounds for the `preCheck()` heuristic |

There is **no Tabby sandbox host**: the environment is determined entirely by the secret-key type, and `country: "SA"` always routes to `api.tabby.sa` (including test payments). The `environment` option is retained for config readability but does not affect routing.

Tabby's webhook signing is *static-secret per registered webhook*, not body-HMAC. Use a long random `TABBY_WEBHOOK_HEADER_VALUE` and rotate periodically.

### Timeouts and retries

Every upstream call shares one total request budget (`timeoutMs`, default `15000`) across attempts and backoff. GETs retry up to twice on 429/500/502/503/504, network failures and timeouts. `Retry-After` is respected when its delay fits the remaining budget. POST money operations and checkout creation are sent once because a timed-out request may have succeeded upstream. Tamara eligibility uses a separate 200 ms default budget and fails open as its integration contract specifies.

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

When `persistOrders: true`, verified deliveries are stored in `bnplWebhookEvent`. A guarded claim grants one worker a five-minute lease. Active duplicate deliveries return HTTP 503; processed duplicates return HTTP 200. Expired claims can be retried.

Cancellation amounts reduce the remaining capturable balance without changing the original order total. Native cancellation identities join capture/refund identities in the atomic ledger. Amount-bearing admin cancellations require a stable `merchantReferenceId`. This is a local retry key; Tamara does not document a provider idempotency key. Reusing the reference with changed input returns 409. Tamara cancellation and refund responses can contain cumulative totals; mismatched response amounts are corroborated against the matching native transaction before applying an operation delta.

Cancel, void, and close reserve a durable command before any provider mutation. Completed commands replay saved results. Uncertain retries use GET only: partial cancellation requires one matching new native cancellation and the reserved financial baseline; Tabby cancellation and close require verified payment closure. Void recovery cannot infer success from a paid order. Stale or ambiguous evidence remains blocked with 409. Closing or cancelling an already closed Tabby payment verifies GET state without repeating POST, retaining its capture/refund status.

Capture/refund identities are recorded in `bnplOrder.appliedOperations` in the same atomic write as the balance change. This protects money accounting across concurrent webhooks, admin operations, reconciliation, and retries after database failures. Tabby snapshots apply every native operation before their final lifecycle update. A webhook whose order is missing remains failed and retryable instead of being acknowledged as processed.

Callback completions and original status transitions are persisted. Failed callbacks resume without repeating callbacks already checkpointed. A crash after an external effect but before its checkpoint can still repeat that effect: deduplicate external work using the stable `deliveryId` passed to canonical and status callbacks. Provider-specific legacy callbacks do not receive this ID.

Stateless webhooks dispatch every event in a compound notification, but require application-level deduplication. Tamara cancellation notifications use verified native balances to distinguish partial updates from full cancellation. Persisted cancellation callbacks retain their original kind and status on retries, even if the provider order later changes.

Admin and automatic money operations use the same native operation identities as incoming webhooks. Synthetic event rows are supplemental records; the order ledger is the accounting barrier.

Financial callbacks do not form a complete transaction feed. An operation already recorded by an admin command or reconciliation can suppress its later webhook callback to avoid duplicate effects. Business workflows must also handle their own successful commands and reconciliation results.

For distributed retries, pass stable operation references from your order system: `merchantReferenceId` on capture and `merchantRefundId` on refund. Tabby requires these as `reference_id` idempotency keys. Admin capture/refund endpoints require explicit references and validate the latest available balance before calling the provider. They reserve a durable command before the provider call and replay completed results without another call. Reusing a reference with different input returns 409. A timeout or failed local commit leaves the command pending; retries return 409. Reconciliation does not clear pending command entries. An uncertain command blocks all new mutations on that order, including commands with different references. Reconciliation alone does not release the journal. Pending commands never expire automatically; unresolved commands require deliberate operator recovery after verifying upstream state.

### Status state machine

Order status uses guarded lifecycle transitions and current financial balances, because provider webhooks can arrive out of order:

- **Regressions are ignored.** A late or retried event whose target status is not a legitimate forward transition keeps the current status and logs a warning; `rawData`/`updatedAt` and the cumulative deltas still apply.
- **Tamara `order_updated` never changes status**. it only revises amounts/`rawData`.
- **Currency-mismatched deltas are skipped.** A capture/refund event whose currency differs from the stored order currency logs a warning and applies no delta (a ×1000 KWD delta on a ×100 SAR order would be 10× off).
- **Reconciliation rejects stale snapshots.** A changed local version or lower remote totals requires a retry. Retrieved native operation identities are imported with the totals to prevent later webhook replay from adding them again.
- **Closed payments can be refunded.** Full-refund status compares refunds with captured funds; refund-before-capture deliveries retain their financial effect as later captures arrive.

### Handler time budget

Handlers run **inline, before the endpoint ACKs**. Providers time out slow webhook requests and retry: Tabby times out at 1 minute and retries up to 4 more times over exponential ~1–4 minute intervals, only HTTP 200 acknowledges, delivery order is not guaranteed, and duplicates happen (all per Tabby's official docs). Keep handlers fast and offload slow work to a queue. Processed duplicate deliveries return HTTP 200. A callback that outlasts its lease can overlap a retry; keep callbacks short and deduplicate external effects.

## Admin redelivery

Pass a `redelivery` option to mount two admin-gated recovery endpoints. the path once a provider exhausts its automatic retries:

```ts
webhooks({
  onCaptured, onRefunded,
  redelivery: {
    isAuthorized: ({ session }) => session.user.role === "admin",
  },
});
```

- `GET /bnpl/admin/webhook-events`. list/search events (filter by `status` / `provider` / `providerOrderId`, paginated).
- `POST /bnpl/admin/webhook-events/:id/redeliver`. re-derive the canonical event from the stored `rawData` and re-run persistence + typed dispatch. The atomic operation ledger protects against re-applying a delta.

### Auto-authorise (Tamara)

Tamara requires you to call `POST /orders/{id}/authorise` within 72h of the customer's approval signal. With `autoAuthorise: true` on the umbrella plugin (default), this happens automatically when an `approved` webhook arrives. Handler receives the outcome via `autoAuthoriseResult`. **Tabby providers ignore this flag** because they have no equivalent step.

Automatic authorisation requires `persistOrders: true`. Admin and webhook authorisation share a durable intent before the provider POST. After a timeout or uncertain result, retries only fetch the order: verified authorisation or capture completes recovery with the financial operation ledger; an order still `approved` remains blocked and needs investigation instead of another POST. Tamara's [authorisation API](https://docs.tamara.co/reference/authoriseorder) can auto-capture funds and does not document a merchant idempotency key.

Automatic capture also reserves a durable command before calling the provider. Unknown outcomes, timeouts, rate limits, and server errors remain pending. A confirmed provider rejection may release only its owning reservation for retry. A verified webhook or reconciliation must prove the remaining capturable balance is zero before a pending automatic capture can be treated as complete. Cancellation cannot bypass an earlier pending capture by changing the remaining amount.


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

Admin endpoints are mounted only when the `admin()` sub-plugin is in `use:`. They look up the order's provider from the row, then dispatch to the matching provider method. `admin()` also mounts `GET /bnpl/admin/orders`. a back-office list/search over every order (`provider` / `status` / `userId` filters, paginated), covered by the typed `authClient.bnpl.admin.listOrders()` helper. Order responses omit provider raw payloads and internal operation/transition ledgers.

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

When upgrading an existing database, regenerate and apply your Better Auth schema migration before starting the new version. Required additions include `bnplOrder.appliedOperations`, `webhookTransitions`, `moneyCommands`, `checkoutAttempt`, and `canceledAmountMinor`, plus `bnplWebhookEvent.processingToken`, `processingUntil`, and `deliveryState`.

Backfill existing `canceledAmountMinor` values with `0` and set a database default of `0` before enforcing NOT NULL. Inspect generated migrations because SQLite ALTER migrations may omit that default. Preserve the unique webhook dedup-key constraint and the order `version` column. Custom adapters must implement guarded `incrementOne` atomically.

`persistOrders: true` enables the `bnplOrder` and `bnplWebhookEvent` tables. Run `npx @better-auth/cli generate` to add them. **Existing installs must re-run generate after upgrading to this release**. it adds new columns (below).

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
| `rawData` | string? | Last raw provider response (JSON-stringified). `returned: false` and **stripped from all user-facing reads** (`GET /bnpl/orders*`). the plugin keeps full gateway payloads out of public and admin order responses |
| `metadata` | string? | Application-level metadata |
| `version` | number | Optimistic-concurrency write token, default `0`. Not a counter. every mutation is guarded against concurrent writers so a lost cumulative-amount update can't happen |
| `createdAt`, `updatedAt` | date | |

**`bnplWebhookEvent`**: one row per verified webhook, unique `dedupKey`:

| Column | Type | Notes |
|---|---|---|
| `provider`, `providerOrderId` | string | Discriminator + lookup |
| `eventKind` | string | Canonical (`captured` / `refunded` / etc.) |
| `eventType` | string | Provider's native name (e.g. `order_captured`) |
| `dedupKey` | string (unique) | JSON tuple of configured provider ID and provider delivery key; existing provider-owned keys remain replayable |
| `receivedAt` | date | |
| `rawData` | string? | JSON-stringified payload; `returned: false` |
| `status` | string | Processing lifecycle: `received` → `processed` \| `failed`. Default `received` |
| `attempts` | number | Processing attempts, incremented on each failure. Default `0` |
| `orderApplied` | boolean | Whether this event's money delta has been applied to the order (the re-processing idempotency barrier). Default `false` |
| `processedAt` | date? | When processing succeeded; null while `received`/`failed` |
| `lastError` | string? | Last processing error. diagnostics for redelivery tooling |

Hot lookup columns declare `index: true`, so `npx @better-auth/cli generate` emits the indexes. Server-managed fields are `input: false` (rows are written only by the plugin's endpoints, never from client bodies). One composite the field-level attribute cannot express: a UNIQUE (`provider`, `providerOrderId`) pair. webhook lookups scope by both fields, so add that composite in your own migration.

### Money: minor units

The wire format and your `BnplMoney` inputs are decimal strings (`"99.99"`); the DB stores integer minor units (`9999`) per ISO 4217. KWD/BHD/OMR are 3-decimal currencies (×1000 multiplier). Use the exported helpers when reading or writing:

```ts
import { parseAmount, formatAmount } from "better-auth-bnpl";

parseAmount({ amount: "99.99", currency: "SAR" });
formatAmount(9999, "SAR");
```

The wire `amount` must be a **canonical decimal string**. no thousands separators, sign, or scientific notation. Garbage is rejected at the schema edge (even with `persistOrders` off), and an amount whose minor units would exceed `Number.MAX_SAFE_INTEGER` throws `AMOUNT_TOO_LARGE`.

---

## Error codes

Client requests expose `{ data, error }`; `error.code` narrows to `BnplErrorCode`. See `src/core/errors.ts` for the authoritative list.

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
| `CHECKOUT_CONFLICT` / `MONEY_COMMAND_CONFLICT` | Changed input, concurrent processing, or an uncertain earlier outcome; verify state before retrying |
| `INVALID_CANCEL_REFERENCE` | Amount-bearing cancellation needs a stable `merchantReferenceId` |
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

