---
"better-auth-bnpl": patch
---

Fix webhook retries and cancellations that could lose money events or block an order.

- Rebuild webhook events from the first delivery's stored payload for every provider, so a Tabby retry that reorders captures or refunds cannot skip one and handlers see one payload per delivery.
- Re-verify a Tamara cancellation against fresh native history until its order write commits, instead of retrying a stale snapshot forever.
- Derive snapshot status from committed balances, so a late older Tabby snapshot cannot reverse a newer refund.
- Require a payment-closing cancellation to cover the local uncaptured balance, and complete a pending one from any verified closure.
- Keep ignored zero-amount or wrong-currency money notifications out of the operation ledger.
- Recover authorisation from balance-derived status (for example a Tamara order captured in part and canceled for the rest), and map recovery failures to `AUTHORISE_FAILED`.
- Treat a webhook event of a different kind under an existing dedup key as a new event, including after a racing insert.
- Reset admin redelivery handler checkpoints in the same write that claims the event.
