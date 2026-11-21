# better-auth-bnpl

## 0.3.2

### Patch Changes

- 95cc8fd: Fix order and checkout state machines that could permanently block an order or burn a checkout reference.

  - Release a money command, or discard a checkout reservation, only when the provider provably refused the request: validation before dispatch, or the mutation's own 4xx response (409 only for documented refusals such as Tamara `transition_not_allowed` and Tabby's lock/dispute errors). Follow-up read errors, redirects and unmarked errors stay pending. Custom providers opt in with the new `rejected` flag on `BnplProviderError` and `BnplPluginError`; `isDefinitiveRejection` is exported.
  - Handle provider refusals that report the order is already in the requested state per operation: close, cancel, void and authorise verify through GET (including Tamara orders already authorised or partially canceled), while capture and refund release their reservation. Recover Tabby amount-bearing cancellation from the closed payment; keep a paid Tamara void verifiable after a failed follow-up read; release verification-only close/cancel commands that sent nothing.
  - Derive order status from verified balances for cancel, reconcile, void, close and recovery, so partially captured orders are never stored as `canceled` and Tamara `updated` snapshots keep a consistent status. Allow capturing the remaining authorisation after a partial capture was refunded, allow `new`/`approved` orders to reach `closed`, and close open Tabby payments whose captured part was refunded.
  - Record a checkout result even when the provider answered after the claim lease expired; rotate the webhook lease token on renewal.
  - Validate money precision per currency at the API boundary; reject `updated` totals below the committed balance; ignore zero-amount money notifications; check auto-captured authorisation currency.
  - Accept Tabby's documented nullable `captures`, `refunds` and `reference_id`; treat Tamara's zero-amount cancellation response as a no-op. Re-vendor the latest Tabby and Tamara OpenAPI specs.

## 0.3.1

### Patch Changes

- 66eae97: Preserve Better Auth server and client endpoint inference when BNPL webhooks are enabled. Keep webhook endpoint keys typed and infer client schema fields without importing an open endpoint dictionary that hides core session and sign-out methods.
- bdba507: Scope webhook deduplication keys by provider while preserving replay of existing deliveries. Reject unsafe minor-unit amounts, invalid Tabby quantities and buyer names, unsupported Tabby currencies, inconsistent Tabby financial histories, and empty Tamara checkout IDs. Simplify the README and include the detailed integration reference in the package.

## 0.3.0

### Minor Changes

- adb5a09: Reserve checkout and payment commands before provider calls, deduplicate native financial operations, and recover uncertain lifecycle operations through verified provider history. Add webhook leases and callback checkpoints, preserve partial Tamara cancellations, validate provider amounts and resource IDs, and reject ambiguous order lookups.

  Requires Better Auth 1.6.23 or newer. Apply the updated database schema before deployment and backfill canceledAmountMinor with a zero default. Capture and refund now require stable operation references; amount-based cancellation requires merchantReferenceId. Callbacks remain at least once, and uncertain commands can require operator recovery.

## 0.2.6

### Patch Changes

- b06350c: Allow digital-only Tabby checkouts and order history to omit shipping addresses while retaining Tamara's shipping requirement.

## 0.2.5

### Patch Changes

- b0316b4: Serialize Tabby checkout attachment bodies as JSON strings so the provider accepts and retains education data.

## 0.2.4

### Patch Changes

- deb4f6e: Send an empty name to Tabby when a buyer has not provided one instead of substituting their email address.

## 0.2.3

### Patch Changes

- 26b346b: Allow trusted server checkout resolvers to supply validated Tabby buyer history, order history, and education attachment data without exposing it through public checkout surfaces.

## 0.2.2

### Patch Changes

- 9843bfb: Accept Tamara's JSON acknowledgement when deleting a webhook.

## 0.2.1

### Patch Changes

- 7c60e68: Accept and normalize Tamara's empty webhook header array in retrieve and update responses.

## 0.2.0

### Minor Changes

- d808059: Make `captureOnAuthorise` cover Tabby authorized webhooks as well as Tamara auto-authorise flows.

### Patch Changes

- a17370d: Supply deterministic operation references when webhook-driven authorization automatically captures a payment.
