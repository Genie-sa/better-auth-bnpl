---
"better-auth-bnpl": minor
---

Concentrate order money rules in one Order module and every capture, refund, cancel, void, close and authorise in one durable money command, and fix payment bugs found against the Tabby and Tamara sandboxes.

- Fix provider errors being unrecognised across the package's entry points. Errors raised by `better-auth-bnpl/tabby` or `/tamara` now match `BnplProviderError` and `BnplPluginError` in the plugin, so rejection release, recovery and HTTP status mapping work with the published providers. Subclasses keep ordinary `instanceof` behavior.
- Fix Tamara multi-capture orders: a second partial capture no longer fails after Tamara accepted it.
- Record every native refund when Tamara splits one refund across captures, including its undocumented per-capture response.
- Retrying a pending capture or refund completes it from native history instead of staying blocked. Tabby operations are matched by merchant reference; Tamara attribution requires the requested balance to be the only one that changed.
- Pending automatic captures complete from native history even after a capture notification recorded the money.
- A read or request-validation failure before a mutation is sent releases the command instead of leaving it pending.
- When two workers settle one command, both return the first saved result and only it changes the order.
- Checkout returns 400 with the provider's validation code instead of 500.
- Add optional provider fields so the plugin no longer checks provider ids or raw payloads: `capabilities.captureRequiresShipping`, `capabilities.partialCancel`, `capabilities.cancelClosesPayment`, `capabilities.operationReferences`, `BnplOrderState.closed`, canceled event `cancelId`, `BnplRefundResult.operations`, and `BnplMoneyOperation.reference`.
- Type change for direct `TamaraClient` users: `simplifiedRefund` returns either the single-refund shape or `{ order_id, refunds }` for refunds spanning captures.
