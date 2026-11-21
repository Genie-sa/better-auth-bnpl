# State machines

This document lists every explicit and implicit state machine in the plugin, the invariants each one must hold, and the transitions the code performs. It also records the invalid states and transitions found in the audit, with code and sandbox evidence, and their fixes.

All persisted state lives on two rows:

- `bnplOrder` has a `status` column plus JSON columns. `checkoutAttempt`, `moneyCommands`, `appliedOperations`, and `webhookTransitions` each hold their own state machine.
- `bnplWebhookEvent` has a `status` column, a processing lease, and a `deliveryState` checkpoint.

| # | Machine | Storage | Kind | Code |
| --- | --- | --- | --- | --- |
| M1 | Order status | `bnplOrder.status` | Explicit table | [`src/core/status.ts`](../src/core/status.ts) |
| M2 | Order version (optimistic concurrency) | `bnplOrder.version` | Implicit | [`src/plugins/order-store.ts`](../src/plugins/order-store.ts) |
| M3 | Checkout attempt | `bnplOrder.checkoutAttempt` | Implicit | [`src/plugins/checkout-attempt.ts`](../src/plugins/checkout-attempt.ts) |
| M4 | Money command journal | `bnplOrder.moneyCommands` | Implicit | [`src/plugins/money-command.ts`](../src/plugins/money-command.ts) `runMoneyCommand` |
| M5 | Operation ledger and delivery markers | `bnplOrder.appliedOperations`, `webhookTransitions` | Implicit | [`src/plugins/order.ts`](../src/plugins/order.ts), [`src/core/ledger.ts`](../src/core/ledger.ts) |
| M6 | Webhook event delivery | `bnplWebhookEvent.status`, `processingToken`, `processingUntil` | Implicit | [`src/plugins/webhook-events.ts`](../src/plugins/webhook-events.ts) |
| M7 | Webhook delivery checkpoint | `bnplWebhookEvent.deliveryState` | Implicit | [`src/plugins/webhooks.ts`](../src/plugins/webhooks.ts) `processDelivery` |
| M8 | Provider native status mapping | Tabby and Tamara responses | Explicit mapping | [`src/providers/tabby/adapter.ts`](../src/providers/tabby/adapter.ts), [`src/providers/tamara/index.ts`](../src/providers/tamara/index.ts) |

## M1. Order status

### States

`new`, `approved`, `authorised`, `partially_captured`, `fully_captured`, `partially_refunded`, `fully_refunded`, `closed`, `declined`, `expired`, `canceled`, `updated`.

`updated` is Tamara's name for a partially canceled order. It is never stored locally: `statusFromBalances` maps it to `authorised` or a capture status.

`TERMINAL_STATUSES` is `declined`, `expired`, `canceled`, `fully_refunded`, and `closed`, kept for compatibility as the statuses conventionally treated as final. They are not all sinks. `fully_refunded` describes the captured portion, so any remaining authorisation can still be captured, and `fully_refunded` and `closed` can still receive refunds.

### Transition table (`STATUS_TRANSITIONS`)

A transition to the current status is always allowed. A transition from a non-canonical (legacy) status to a canonical one is always allowed.

| From \ To | approved | authorised | declined | expired | canceled | partially_captured | fully_captured | partially_refunded | fully_refunded | closed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| new | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| approved | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| authorised | | | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| partially_captured | | | | | ✓ | | ✓ | ✓ | ✓ | ✓ |
| fully_captured | | | | | | | | ✓ | ✓ | ✓ |
| partially_refunded | | | | | | | | | ✓ | ✓ |
| fully_refunded | | | | | | | | ✓ | | |
| closed | | | | | | | | ✓ | ✓ | |
| declined, expired, canceled, updated | | | | | | | | | | |

Out-of-order or missed webhooks are why `new` and `approved` may jump straight to captured, refunded, or closed states. `fully_refunded → partially_refunded` exists because a later capture increases the captured base.

### Status from balances

`statusFromBalances(native, balances)` is the single rule for statuses derived from a verified provider snapshot or command result. It applies these rules in order:

1. When refunds exist: `fully_refunded` when refunded ≥ captured, otherwise `partially_refunded`. When a refund arrived before its capture, the base is amount − canceled.
2. Native `closed` (Tabby partial capture then close) stays `closed`.
3. When captures exist: `fully_captured` when captured ≥ amount − canceled, otherwise `partially_captured`.
4. Native `updated` becomes `authorised`.
5. Otherwise the native status.

Tabby `CLOSED` itself maps to `fully_refunded`, `partially_refunded`, `fully_captured`, `closed`, or `canceled` (when nothing was captured).

### Writers

Every writer applies `canTransition` before changing the status. The one exception is the cancellation repair: a stored `canceled` that native history proves was a partial cancellation is restored to its balance-derived status.

| Writer | Trigger | Target |
| --- | --- | --- |
| `updateCheckoutAttempt` | Provider checkout result | Result status (`new` or `declined`) |
| `persistOrderUpdate` (webhooks) | Each canonical event | Event target; cancellation events use `statusFromBalances` on verified native history |
| Automatic and admin authorise (`applyAuthorisation`) | Authorise result | Capture-derived when the response reports a positive capture, otherwise the response status |
| Authorise recovery, void, close, reconcile, admin cancel | Verified GET or provider result | `statusFromBalances` |
| `runAutoCapture`, `persistAdminMoneyOperation` | Capture or refund result | Capture- or refund-derived; `closed` stays `closed` until its first refund |

### Invariants

| ID | Invariant | Enforced by |
| --- | --- | --- |
| I1 | `0 ≤ captured + canceled ≤ amount`, and `amount` never drops below `captured + canceled` | Every money writer, `readRemoteHistory`, and the `updated` webhook total guard |
| I2 | `refunded ≤ captured` | Admin, recovery, and reconcile paths. The webhook refund path only bounds refunds by `amount − canceled`, because a refund can arrive before its capture. |
| I3 | Status agrees with balances | `statusFromBalances` and the capture/refund derivations; zero-amount money notifications are ignored |
| I4 | No status leaves `declined`, `expired`, or `canceled` (apart from the cancellation repair) | `canTransition` at every writer |

## M2. Order version

Every order mutation goes through `mutateOrder`. It reads the row, computes an update, and writes with `incrementOne` guarded by `version = read version`. After three conflicting attempts it throws `OrderStoreConflictError`. The compute step re-validates against the latest row.

| From | Event | To |
| --- | --- | --- |
| `v` | Guarded write succeeds | `v + 1` |
| `v` | Concurrent writer won | Re-read and retry (at most 3 attempts), then error |
| `v` | Compute returns `null` (no-op) | `v` (no write) |

## M3. Checkout attempt

`checkoutAttempt = { hash, result?, createdHook?, persistedHook?, processingToken?, processingUntil? }`. The claim lease lasts 5 minutes.

| State | Shape |
| --- | --- |
| Absent | No row for `orderReferenceId` |
| Reserved | Row `status=new`, `result` unset, token held |
| Result saved, claimed | `result` set, token held, at least one hook pending |
| Result saved, unclaimed | `result` set, no live token (hook failed or lease expired) |
| Declined | `result.status = declined` |
| Delivered | `createdHook` and `persistedHook` both true, token cleared |

| From | Event | To | Response |
| --- | --- | --- | --- |
| Absent | Request; the create wins the unique constraint | Reserved | – |
| Absent | A concurrent request loses the unique constraint | – | 409 |
| Reserved | Provider returns a checkout, even after the lease expired | Result saved, claimed. The owner keeps its token because nobody can reclaim a resultless reservation. | – |
| Reserved | Provider returns declined | Declined | 422 |
| Reserved | **Definitive rejection** | **Absent**: row deleted only if `result` is unset and the token and version are unchanged | Provider or validation error |
| Reserved | Uncertain failure | Reserved (sink) | 409 on every retry |
| Result saved, claimed | `onCheckoutCreated` then `onOrderPersisted` succeed | Delivered | 200 |
| Result saved, claimed | A hook throws | Result saved, unclaimed | Hook error |
| Result saved, unclaimed | Same-hash retry | Claimed again (new token) | Replays the result and runs only the hooks that have not run |
| Any | Different hash, user, or provider | – | 409 |
| Delivered or Declined | Same-hash retry | Unchanged | Replays 200 or 422 |

Invariants:

- **C1:** At most one provider checkout per reference.
- **C2:** A resultless reservation exists only while its outcome is unknown.
- **C3:** Hooks are checkpointed, so a hook runs again only if its checkpoint write failed.

## M4. Money command journal

`moneyCommands` is a list of `{ key: [operation, reference], hash, state, token?, before?, evidence?, result? }`. Operations are `capture`, `refund`, `cancel`, `void`, `close`, and `authorise`.

| From | Event | To |
| --- | --- | --- |
| Absent | Reserve, when validation passes and no other command is pending | `pending` (token; cancel keeps a `before` balance baseline) |
| Absent | Reserve while another key is `pending` | – (409) |
| `pending` | Provider success, persisted | `completed` (result saved) |
| `pending` | Provider confirmed facts that need verification (a paid void) | `pending` with `evidence` |
| `pending` | **Definitive rejection** of its own request | **Removed** by the owning token |
| `pending` | Verification-only command fails without sending anything. A close, or a Tabby cancel without an amount, is verification-only only when nothing remains authorised (`closed`, `canceled`, or captured + canceled ≥ amount). | **Removed** |
| `pending` | Uncertain failure, or local commit failure after provider success | `pending` |
| `pending` | Same-key retry of `capture`/`refund` | – (409, no provider call) |
| `pending` | Same-key retry of `cancel`/`void`/`close`/`authorise` | GET verification, using `before`/`evidence`. Proven: `completed`. Otherwise `pending` (409). |
| `completed` | Same key and hash | Replays the result |
| Any | Same key, different hash | – (409) |

Invariants:

- **J1:** At most one `pending` command per order.
- **J2:** `pending` means the provider outcome is unknown.
- **J3:** Only the owning token may complete, annotate, or release an entry.

### Definitive rejection

`isDefinitiveRejection` in [`src/core/errors.ts`](../src/core/errors.ts) returns true only for an error explicitly marked `rejected`. A bare HTTP status is never enough, because a provider method can fail on a follow-up read after its mutation succeeded. Markers are set in four places:

- **HTTP layer** ([`src/providers/http.ts`](../src/providers/http.ts)), for a mutation's own response only:
  - a 4xx other than 408, 409, 425, 429, and 499 counts;
  - a 409 counts only when the provider documents it as a refusal: Tamara `transition_not_allowed`, Tabby `could not acquire lock: payment is locked` and `payment is disputed`;
  - reads never count;
  - mutations do not follow redirects, so a redirected read cannot pose as a rejection;
  - request bodies that fail schema validation before dispatch count.
- **Built-in validation before dispatch:** `BnplPluginError` and adapter errors created with `{ rejected: true }`, including invalid provider resource IDs and the Tamara void query.
- **Proven provider no-op:** the Tamara cancel response with `canceled_amount: 0` and a non-cancel status, where the order snapshot explicitly includes `transactions.cancels`, contains no such `cancel_id`, and is not itself `canceled`.
- **Already in target state:** a refusal saying the order is already in the requested state (for example Tabby `{ error: "already closed" }`) is handled per operation:
  - Each operation recognises only a target its GET recovery can prove. These keep the command pending and verify through GET:
    - close: `closed`;
    - Tabby cancel without an amount: `closed`;
    - other providers' cancel without an amount: `canceled`;
    - authorise: `authorised`, or Tamara `transition_not_allowed` with an authorised-or-later `old_state`, including `updated`.
  - Everything else releases, because the refusal means this request moved no money. That covers capture, refund, void, and a cancel with an amount. Tamara reports a void that cannot apply as HTTP 200 `order_was_voided: false`, and void recovery cannot prove a paid order. If someone else already closed the payment, a cancel with an amount did nothing.

Custom providers must set `rejected: true` themselves; unmarked errors stay pending.

## M5. Operation ledger and delivery markers

`appliedOperations` holds native operation keys (`<provider>:captured:<id>`, `…:refunded:<id>`, `<provider>:cancel:<id>`) and `delivery:<eventId>:<index>` markers. `webhookTransitions` maps each delivery key to the status change it produced, so `onStatusChange` replays after a retry.

| From | Event | To |
| --- | --- | --- |
| Key absent | Webhook, admin, or automatic money operation applied | Key present, balance updated in the same guarded write |
| Key present | The same native operation arrives again | Unchanged; the typed callback is suppressed |
| Marker absent | Delivery index processed | Marker present |
| Marker present | Retry or redelivery of that index | No order write; the stored status change replays |

Invariant L1: each native operation affects balances exactly once. `readRemoteHistory` imports totals only when native history is complete and contains every local key.

## M6. Webhook event delivery

| From | Event | To |
| --- | --- | --- |
| Absent | Verified delivery with an order ID | `received` |
| `received`, `failed`, or `processing` with an expired lease | Claim, guarded by status and token (`attempts + 1`, 5-minute lease) | `processing` |
| `processing` with a live lease | Another delivery | – (503) |
| `processing` | Checkpoint save | Lease renewed **and token rotated**, so a worker that read the old lease cannot reclaim it |
| `processing` | All events applied and handlers checkpointed | `processed` |
| `processing` | Any failure, including a missing order | `failed` (provider retries) |
| `processed` | Provider duplicate | – (200 duplicate) |
| `processed` | Admin redelivery | `processing` with handler checkpoints reset; order writes stay deduplicated by markers |
| Absent | Admin or automatic money operation succeeds | A synthetic `processed` event |

Synthetic events make a later Tamara money webhook a duplicate (same dedup key). Tabby webhooks are full snapshots with their own dedup key, so their money events are deduplicated by the M5 ledger instead.

Invariant W1: at most one live processor per event. Handlers run at least once.

## M7. Webhook delivery checkpoint

`deliveryState = { completed: string[], contexts: { [index]: frozen Tamara cancellation context } }`. It is read from the claimed row. When a Tamara `order_canceled` notification arrives, the plugin fetches the native order once and freezes the result per index. Handler keys are added only after the handler succeeds.

## M8. Provider native status mapping

| Tabby | Canonical |
| --- | --- |
| `CREATED` | `new` |
| `AUTHORIZED` | `authorised`, or `partially_captured` when captures exist |
| `CLOSED` | Derived from captures and refunds (see M1) |
| `REJECTED` | `declined` |
| `EXPIRED` | `expired` |

Tabby documents `captures`, `refunds`, and their `reference_id` as nullable. Tabby may capture the remainder itself after 21 days, without our reference.

Tamara statuses are canonical names: `new`, `approved`, `authorised`, `partially_captured`, `fully_captured`, `partially_refunded`, `fully_refunded`, `canceled`, `updated`, `declined`, `expired`.

## Findings

All findings were reviewed by three parties: the original audit, plus independent reviews by Gemini 4 Neon and GPT-6.2 Astra. They were checked against the providers' current documentation and OpenAPI specs (re-vendored on 2026-11-21). The confirmed provider behaviours were reproduced in the live Tabby and Tamara sandboxes. The credentials came from the Railway staging service; the Tabby key prefix `sk_test_` and `TAMARA_ENVIRONMENT=sandbox` were checked first. No credentials, buyer data, or hosted session URLs are recorded here.

| ID | Severity | Finding | Fix | Evidence |
| --- | --- | --- | --- | --- |
| F1 | High | A definitive provider rejection (or validation before dispatch) left the journal `pending`, so every later mutation on the order returned 409 forever. Early Tamara authorise blocked the customer's approval permanently. | `command.send` releases only the owning reservation on an explicitly marked rejection (M4). Tracked in [#22](https://github.com/Genie-sa/better-auth-bnpl/issues/22). | Sandbox: Tabby close of `CREATED` and Tamara capture without shipping info both wedged the order before the fix; afterwards later commands reached the provider and voids succeeded. |
| F2 | High | A rejected checkout left a phantom `new` row and burned the reference (409 forever). | Discard the reservation on a definitive rejection (M3). Tracked in [#23](https://github.com/Genie-sa/better-auth-bnpl/issues/23). | Sandbox: Tamara unsupported country; afterwards no row remained and corrected input under the same reference succeeded. |
| F3 | Medium | A Tamara zero-amount cancel (HTTP 200, `status: "new"`) failed schema validation as "unexpected shape" and stayed pending. | Schema accepts the status; a proven no-op (M4) is rejected; everything else stays uncertain. | Sandbox: before, the cancel wedged and void returned 409; afterwards "did not apply the cancellation" and the void succeeded. |
| F4 | High | A Tabby cancel with an amount closed the payment, then recovery demanded Tamara-style cancel history and wedged the order. | Cancel recovery for providers whose cancel closes the payment (`cancelClosesPayment`) verifies native closure, unchanged captures, and that the amount equals the uncaptured balance. | Code path (Neon); regression test |
| F5 | High | On Tamara merchants with automatic authorisation, our authorise call gets `transition_not_allowed` from an already-authorised order. Releasing it would make the `approved` webhook fail forever. | Authorise keeps that refusal pending and verifies through GET. | Tamara docs (automatic authorisation); regression test |
| F6 | Medium | Tabby's documented 409 lock/dispute refusals on capture and refund stayed pending. | Documented Tabby 409 bodies count as rejections. | Tabby OpenAPI `ConflictError_locked`; regression test |
| F7 | Medium | Tabby nullable `captures`/`refunds`/`reference_id` failed schema parsing, so snapshot webhooks failed until retries ran out, and fetch/reconcile failed. | Accept `null`. | Tabby OpenAPI; regression test |
| F8 | Medium | Status could contradict balances: a Tamara partial capture plus cancel became `canceled` with captured funds; a reconcile of `updated` imported captures but kept `authorised`; a cancellation webhook on a captured order failed forever. | `statusFromBalances` in cancel, reconcile, void, close, recovery, and cancellation webhooks; cancellation history accepts captured orders when the balances are consistent. | Code path (Neon); regression tests |
| F9 | Medium | A paid Tamara void wedged if the follow-up read or commit failed, because the confirmed captured amount was not durable. | Save the void result as journal `evidence` before verification. | Code path (Neon); regression test |
| F10 | Medium | A worker could steal a renewed webhook lease (renewal kept the token) and re-run checkpointed handlers from a stale checkpoint. | Rotate the token on renewal; read the checkpoint from the claimed row. | Code path (Neon); regression test |
| F11 | Medium | A checkout that took longer than the 5-minute lease lost its provider result, and the reference returned 409 forever. | The owning token may record the first result after lease expiry. | Code path (Astra); fake-clock regression test |
| F12 | Medium | After a partial capture was fully refunded, `fully_refunded` blocked capture of the remaining authorisation. | Captures are guarded by balance and final statuses (`closed`, `canceled`, `expired`, `declined`); the provider decides, and a refusal is released. | Code path (Astra, Neon); regression test |
| F13 | Medium | A close or cancel that only verified state (sent no request) and failed verification wedged the order. | Release unsent reservations. | Code path (Neon); regression tests |
| F14 | Low | Validation errors before dispatch (money precision, empty strings, field lengths, resource IDs, void query) stayed pending. | Money precision is validated at the API boundary; the HTTP body schema, resource ID, and void query failures are marked `rejected`. | Code path (Neon); regression tests |
| F15 | Low | Authorise with auto-capture could store full capture under `authorised`, accept a foreign currency, or set `capturedAt` for zero. | Derive the capture status, check the currency, and set `capturedAt` only when the amount is positive. | Tamara OpenAPI example; regression tests |
| F16 | Low | An `updated` webhook could set the order total below captured + canceled. | Reject totals below the committed balance. | Regression test |
| F17 | Low | Zero-amount capture or refund notifications changed the status with no money movement. | Ignore non-positive deltas. | Regression test |
| F18 | Low | Admin capture and refund wrote derived statuses without `canTransition`. | Guarded. | Regression test |
| F19 | High | Tabby reports "already closed/captured" in `error`, not `message`, so it was not recognised as an already-reached state. The rule was also not specific to the operation. | Read `error` as well. Matching is specific to the operation: only an operation's own target state is verified through GET; everything else releases. | Tabby OpenAPI `Error_400_PaymentsClose` (Neon re-review); regression tests |
| F20 | Medium | A Tamara zero-amount cancel could be released when the snapshot had `transactions` but no `cancels` list. | Require an explicit `transactions.cancels` array. | Astra re-review; regression test |
| F21 | Medium | A refunded partial capture made close (and Tabby amountless cancel) verification-only, so an open Tabby payment was never closed. | Verification-only only when nothing remains authorised. | Astra re-review; regression test |
| F22 | Medium | Tamara `updated` was not treated as authorised-or-later, so an authorise conflict or recovery on a partially canceled order failed. | `updated` counts as authorised for recovery; the stored status comes from balances. | Neon re-review; regression test |
| F23 | Low | An authorise response reporting a zero capture stored `partially_captured`. | Derive the capture status only for positive captures. | Neon re-review; regression test |
| F24 | Low | Cancellation events carried `authorised` to handlers for captured orders; a refund that arrived before its capture derived `fully_refunded`; a reconciled closed Tabby payment could not leave `new`/`approved`. | Balance-derived event status; amount base for early refunds; `new`/`approved` → `closed` allowed. | Neon re-review; regression tests |
| F25 | Medium | Target-state refusals for void, amount-bearing cancel, and non-Tabby amountless cancel stayed pending even though recovery could never prove them. The early-refund webhook base also ignored canceled amounts. | Recoverable targets now mirror what each recovery can prove; the early-refund base is amount − canceled. | Neon and Astra confirmation reviews; regression tests |
| F26 | Medium | An uncertain capture or refund blocked the order until manual repair. | Resolved in 0.4.0 by completing a pending capture or refund from native history (Tabby by merchant reference), never by resending. | Round-2 hunts; 0.4.0 regression tests |
| F27 | High | A failed Tabby snapshot retried with its records reordered had the same dedup key but different index meanings, so a capture was skipped permanently. | Rebuild events from the stored first-delivery payload. | Astra round-2 hunt; regression test |
| F28 | High | A Tamara cancellation context frozen before its order write could go stale after a concurrent capture or failed write, failing every retry and redelivery. | Trust the frozen context only after the order write commits; otherwise re-verify. | Astra and Neon round-2 hunts; regression tests |
| F29 | Medium | An older Tabby snapshot (refund or closed) arriving late could set `partially_refunded` or `closed` over newer refund balances. | Snapshot status derives from committed balances. | Astra and Neon round-2 hunts; regression tests |
| F30 | High | A Tabby cancel with an amount that failed while reading the payment (before close) stayed pending. | Resolved in 0.4.0: failures before a mutation is sent release the command. | Neon round-2 hunt; regression test |
| F31 | High | A payment-closing cancel against stale local captures could close the payment and then fail recovery forever, blocking refunds. | Require the amount to equal the local uncaptured balance before reserving; recovery accepts any verified closure. | Neon round-2 hunt; regression tests |
| F32 | Medium | Ignored money notifications (zero amount or wrong currency) still added their operation key, so later history checks failed forever. | Record the key only when a delta was applied. | Neon round-2 hunt; regression test |
| F33 | Medium | Authorise recovery checked the raw native status, so a Tamara order captured in part and canceled for the rest never recovered. | Judge authorisation by balance-derived status; admin recovery errors map to `AUTHORISE_FAILED`. | Neon round-2 hunt; regression tests |
| F34 | Medium | An admin redelivery reset its handler checkpoints only in memory, so a failure or crash before the first handler made the retry run no handlers. | The reset is written in the same conditional claim; checkpoint parsing failures mark the delivery failed. | Neon and Astra round-2 reviews; regression tests |
| F35 | High | Webhook dedup keys could collide across event kinds (for example a Tamara decline and a later approval under the shared authorise key), so the approval was acknowledged as a duplicate. | An existing row of a different event kind, found before or after a racing insert, is not a duplicate; the new event gets a kind-qualified key. Key formats are unchanged. | Astra round-2 review and confirmation; regression tests (including a SQLite race) |
| F36 | Medium | Single-event providers (Tamara) processed retries from the incoming payload, so handlers could see different data under one delivery ID. | Use the stored payload for events, persistence, and handlers for every provider. | Astra round-2 review; regression test |

### Residual risks

| ID | Severity | Risk | Status |
| --- | --- | --- | --- |
| R1 | Design | An uncertain capture or refund that native history cannot uniquely attribute (for example an ambiguous Tamara refund) still blocks the order until an operator verifies the provider. | By design: never resend money without proof |
| R2 | Low | `TERMINAL_STATUSES` keeps its published members; its meaning is now documented. | Changing the set is a breaking change |
| R3 | Low | Tamara's current spec marks `risk_assessment` as required. The sandbox accepted checkouts without it on 2026-11-21; if Tamara enforces it, the checkout is cleanly rejected and its reservation discarded. | Document; pass `providerData.riskAssessment` |
| R4 | Low | Tabby's current spec removed Kuwait/KWD. The plugin still advertises KW/KWD for Tabby. | Follow-up (minor release) |
| R5 | Unverified | Whether Tamara accepts a capture after refunding a partial capture is undocumented. The plugin now lets Tamara decide. | Hosted sandbox flow blocked: the shared Tamara test phone has overdue sandbox instalments |
| R6 | Contract | Custom providers must mark definitive rejections with `rejected: true`; unmarked errors stay pending. | Documented in the changeset |

## Verification log

| Date | Check | Result |
| --- | --- | --- |
| 2026-11-21 | Baseline `pnpm test` | 653 passed |
| 2026-11-21 | Live sandbox before fixes | F1, F2, and F3 reproduced |
| 2026-11-21 | Independent reviews (Gemini 4 Neon high, GPT-6.2 Astra) | F4–F18 and the explicit-rejection design adopted |
| 2026-11-21 | Provider docs and OpenAPI drift review | F5, F6, F7, R3, and R4; specs re-vendored and types regenerated |
| 2026-11-21 | Second independent re-reviews (Neon, Astra) and confirmation | F19–F24 found and fixed; operation-specific target matching added after confirmation |
| 2026-11-21 | Mutation checks (each fix reverted in turn) | All 35 targeted mutations caught by regression tests |
| 2026-11-21 | Live sandbox after fixes | All 6 Tabby/Tamara probe scenarios passed |
| 2026-11-21 | Compatibility (zod 4; Better Auth 1.6.23) | Full suite passes on each |
| 2026-11-21 | Released 0.3.2, then 0.4.0 (Order and Money command modules) | npm and GitHub releases |
| 2026-11-21 | Round-2 independent hunts and reviews (Neon, Astra) | F26–F36; rebased onto 0.4.0, where F26 and F30 were already resolved |
| 2026-11-21 | Mutation checks on the rebased fixes | All 10 ported fixes caught by regression tests |
| 2026-11-21 | `pnpm check` | Lint, typecheck, 864 tests, and builds pass |
