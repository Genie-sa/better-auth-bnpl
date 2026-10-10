# better-auth-bnpl

[![npm version](https://img.shields.io/npm/v/better-auth-bnpl.svg)](https://www.npmjs.com/package/better-auth-bnpl)
[![MIT license](https://img.shields.io/npm/l/better-auth-bnpl.svg)](./LICENSE)

Tabby and Tamara payments for [Better Auth](https://better-auth.com). Create hosted checkouts, store orders, verify webhooks, and manage captures, refunds, and cancellations through one typed API.

Use either provider or both.

## Install

```bash
npm install better-auth-bnpl better-auth zod
```

Requires Node.js 18 or later, Better Auth `^1.6.23`, and Zod `^3.24.0` or `^4`.

## Server setup

Add the plugin to your existing Better Auth configuration. Keep your database adapter and authentication settings.

This example uses two application helpers that you implement:

- `getBuyerProfile(userId)` returns the buyer's `firstName`, `lastName`, `email`, and `phone`.
- `getProductForUser(userId, productId)` checks access and returns a product with `sku`, `name`, and an integer `priceMinor` in SAR.

Load credentials from your server environment. The example uses sandbox credentials. Tabby selects test mode through an `sk_test_` key; Tamara uses `environment: "sandbox"`.

```ts
import { betterAuth } from "better-auth";
import { z } from "zod";
import {
  BnplProviders,
  bnpl,
  checkout,
  formatAmount,
  options,
  orders,
  webhooks,
} from "better-auth-bnpl";
import { tabby } from "better-auth-bnpl/tabby";
import { tamara } from "better-auth-bnpl/tamara";
import { database } from "./database";
import { getBuyerProfile, getProductForUser } from "./checkout-data";

export const bnplProviders = BnplProviders({
  tabby: tabby({
    secretKey: process.env.TABBY_SECRET_KEY!,
    merchantCode: process.env.TABBY_MERCHANT_CODE!,
    country: "SA",
    webhookHeader: {
      name: "X-Tabby-Webhook",
      value: process.env.TABBY_WEBHOOK_HEADER_VALUE!,
    },
  }),
  tamara: tamara({
    apiToken: process.env.TAMARA_API_TOKEN!,
    notificationToken: process.env.TAMARA_NOTIFICATION_TOKEN!,
    environment: "sandbox",
  }),
});

const checkoutData = z.object({ productId: z.string().min(1) });

export const auth = betterAuth({
  database,
  plugins: [
    bnpl({
      providers: bnplProviders,
      persistOrders: true,
      mapUserToBuyer: ({ user }) => getBuyerProfile(user.id),
      use: [
        checkout({
          resolveCheckout: async ({ user, input }) => {
            const { productId } = checkoutData.parse(input.additionalData);
            const product = await getProductForUser(user.id, productId);
            if (!product) throw new Error("Product not found");

            const totalAmount = formatAmount(product.priceMinor, "SAR");
            return {
              totalAmount,
              items: [{
                referenceId: product.sku,
                sku: product.sku,
                name: product.name,
                quantity: 1,
                totalAmount,
              }],
            };
          },
        }),
        options(),
        orders(),
        webhooks(),
      ],
    }),
  ],
});
```

Remove a provider from the map if you only need one. Built-in map keys must remain `tabby` and `tamara`.

`resolveCheckout` replaces client-supplied prices and items with your server's values. The checkout endpoint also accepts a `buyer` object, which takes precedence over `mapUserToBuyer`. If buyer identity must match the signed-in user, validate that input in your server integration.

With persistence enabled, generate and apply your Better Auth database schema before serving requests:

```bash
npx @better-auth/cli generate
```

For existing installations, follow the [schema upgrade instructions](./docs/integration.md#persisted-order-schema). Use a database with enforced unique constraints and atomic guarded updates. Better Auth's memory adapter is unsuitable for concurrent persisted payments.

## Client setup

```ts
import { createAuthClient } from "better-auth/react";
import { bnplClient } from "better-auth-bnpl/client";
import type { ProviderIdsOf } from "better-auth-bnpl";
import type { bnplProviders } from "./auth";

type ProviderId = ProviderIdsOf<typeof bnplProviders>;

export const authClient = createAuthClient({
  plugins: [bnplClient<ProviderId>()],
});
```

A signed-in user can start checkout with a product ID. Create the purchase reference once and reuse it when retrying that purchase.

```ts
const { data, error } = await authClient.bnpl.startCheckout({
  provider: "tabby",
  orderReferenceId: purchase.reference,
  description: "Course enrollment",
  countryCode: "SA",
  additionalData: { productId: purchase.productId },
});
```

The client redirects to hosted checkout by default. Pass `{ redirect: false }` as the second argument to handle the checkout URL yourself.

To show a provider picker, request availability for the cart:

```ts
await authClient.bnpl.options({
  country: "SA",
  amount: { amount: "100.00", currency: "SAR" },
});
```

Availability is a pre-check; the provider can still decline checkout.

## Webhooks and fulfillment

Register these public HTTPS URLs with the providers, using your Better Auth API prefix:

| Provider | Default webhook URL | Verification |
|---|---|---|
| Tabby | `/api/auth/bnpl/webhooks/tabby` | The shared header configured above |
| Tamara | `/api/auth/bnpl/webhooks/tamara` | HS256 JWT verified with the notification token |

Tamara approval requires a separate authorisation call. The plugin handles it by default when `persistOrders: true`. Automatic capture is opt-in. Capture physical goods after dispatch; Tamara capture requires shipping information.

Add callbacks to `webhooks()` for application work:

```ts
webhooks({
  onCaptured: async ({ event, deliveryId }) => {
    // Queue fulfillment and deduplicate it with deliveryId.
  },
});
```

Callbacks run before the webhook response. Keep them short. Delivery is at least once, so external effects need deduplication. Financial callbacks are not a complete transaction feed; also handle successful admin commands and reconciliation results in your application.

## Provider differences

| Operation | Tabby | Tamara |
|---|---|---|
| Hosted checkout | Yes | Yes |
| Capture and refund | Full or partial | Full or partial |
| Authorise after approval | Automatic at the provider | Separate call |
| Cancel | Close the payment | Full or partial cancellation |
| Void an abandoned checkout | Unsupported | Supported |
| Close payment | Supported | Unsupported |
| Currencies | SAR, AED, KWD | SAR, AED, KWD, BHD, OMR |

Support depends on your merchant account and market. Unsupported operations return `OPERATION_NOT_SUPPORTED`. See the [provider rules](./docs/integration.md#provider-specific-behavior) before implementing financial operations.

## Admin operations and retries

Add `admin({ isAuthorized })` to `use` to enable financial operations. Supply your application's administrator check. Webhook listing and replay require a separate `webhooks({ redelivery: { isAuthorized } })` configuration.

Use stable `merchantReferenceId` values for capture and amount-bearing cancellation, and `merchantRefundId` values for refund. Reusing a reference with different input returns 409.

With persistence enabled, the plugin saves checkout results and financial commands before retrying them. An uncertain provider outcome can leave a command pending and block new mutations on that order. Verify upstream state before operator recovery; pending commands do not expire automatically, and reconciliation alone does not clear them.

See the [admin examples](./docs/integration.md#admin) and [recovery behavior](./docs/integration.md#at-least-once-processing).

## More documentation

- [Integration reference](./docs/integration.md) for endpoints, configuration, schema upgrades, money formats, and error codes.
- [Sandbox demo](./examples/reliability-demo/README.md) for hosted checkout, admin operations, and webhook replay.
- [Agent integration skill](./skills/better-auth-bnpl-integration/SKILL.md) for an agent-assisted setup.

Install the agent skill with:

```bash
npx skills add Genie-sa/better-auth-bnpl
```

## License

[MIT](./LICENSE) © Ali Dhamen.
