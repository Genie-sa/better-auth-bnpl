---
"better-auth-bnpl": minor
---

Reserve checkout and payment commands before provider calls, deduplicate native financial operations, and recover uncertain lifecycle operations through verified provider history. Add webhook leases and callback checkpoints, preserve partial Tamara cancellations, validate provider amounts and resource IDs, and reject ambiguous order lookups.

Requires Better Auth 1.6.23 or newer. Apply the updated database schema before deployment and backfill canceledAmountMinor with a zero default. Capture and refund now require stable operation references; amount-based cancellation requires merchantReferenceId. Callbacks remain at least once, and uncertain commands can require operator recovery.
