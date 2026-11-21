---
"better-auth-bnpl": patch
---

Fix order and checkout state machines that could permanently block an order or burn a checkout reference.

- Release a money command, or discard a checkout reservation, only when the provider provably refused the request: validation before dispatch, or the mutation's own 4xx response (409 only for documented refusals such as Tamara `transition_not_allowed` and Tabby's lock/dispute errors). Follow-up read errors, redirects and unmarked errors stay pending. Custom providers opt in with the new `rejected` flag on `BnplProviderError` and `BnplPluginError`; `isDefinitiveRejection` is exported.
- Handle provider refusals that report the order is already in the requested state per operation: close, cancel, void and authorise verify through GET (including Tamara orders already authorised or partially canceled), while capture and refund release their reservation. Recover Tabby amount-bearing cancellation from the closed payment; keep a paid Tamara void verifiable after a failed follow-up read; release verification-only close/cancel commands that sent nothing.
- Derive order status from verified balances for cancel, reconcile, void, close and recovery, so partially captured orders are never stored as `canceled` and Tamara `updated` snapshots keep a consistent status. Allow capturing the remaining authorisation after a partial capture was refunded, allow `new`/`approved` orders to reach `closed`, and close open Tabby payments whose captured part was refunded.
- Record a checkout result even when the provider answered after the claim lease expired; rotate the webhook lease token on renewal.
- Validate money precision per currency at the API boundary; reject `updated` totals below the committed balance; ignore zero-amount money notifications; check auto-captured authorisation currency.
- Accept Tabby's documented nullable `captures`, `refunds` and `reference_id`; treat Tamara's zero-amount cancellation response as a no-op. Re-vendor the latest Tabby and Tamara OpenAPI specs.
