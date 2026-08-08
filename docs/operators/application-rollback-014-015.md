# Application rollback from schema 015 to the 014 bridge

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This runbook covers one narrow laboratory rollback: schema
`015_stage_b_saved_payment_auto_renew` to the reviewed 014 compatibility bridge application. It
does not run a down migration and it does not authorize the ordinary 014 image from `main` to start
on schema 015.

The bridge is a valid rollback target only while schema 015 has not recorded any Saved Payment
Method, payment-consent, or automatic-renewal business fact. Once those features have been used,
their history is intentionally retained and the bridge refuses to start. The correct recovery is to
repair forward with a 015-capable application.

This strict rule also closes the unbounded late-callback problem. A request that could later return a
Saved Method or automatic-renewal result leaves an immutable 015 marker on its Payment Attempt,
Provider inbox, job, operation, consent, or automatic run. The operator never guesses that a quiet
timer means the callback can no longer arrive.

## Required sequence

1. Confirm the rollback target is the reviewed bridge image built from this branch and record its
   source commit, image digest, lockfile hash, and SBOM digest. Do not use the original 014 image at
   commit `6ef3c81`; it has no schema-015 preflight.
2. Pause billing automation and stop new Provider dispatch. Stop the Worker and put checkout/payment
   mutation into laboratory maintenance mode. Block callback ingress at the callback gateway while
   the application processes are being replaced.
3. With the 015-capable application, reconcile every already-dispatched Provider operation. Drain
   ordinary outbox and durable-job work, and resolve every `running` or `unknown` result. Never mark
   an unknown external result failed merely to make this preflight green.
4. Stop the 015 API and Worker. Keep Provider mutation and callback ingress paused. Set this only on
   the bridge API and Worker:

   ```dotenv
   OSS_SCHEMA_ROLLBACK_BRIDGE=014-to-015
   ```

5. Run the read-only preflight using the bridge artifact:

   ```sh
   pnpm --filter @opensales/api rollback:preflight
   ```

   A successful result names schema 015, `rollback_bridge`, and an empty blocker list. It contains
   no customer identifiers or Provider payloads.
6. If any blocker is reported, do not delete, rewrite, or anonymize it. Keep the bridge stopped and
   roll forward. Historical Saved Methods, consent events, authorizations, or automatic runs remain
   blockers even when their status is terminal; the 014 application cannot faithfully administer
   them.
7. If the preflight passes, start the bridge API and Worker. Both repeat the same preflight in a
   read-only, repeatable-read transaction before accepting work. Keep Saved Method, automatic
   renewal, and external Provider side effects disabled. This is a degraded laboratory rollback,
   not restoration of schema-015 features.
8. Deploy the corrected 015-capable image, run its reconciliation checks, then explicitly re-enable
   callback ingress and Provider dispatch. Remove `OSS_SCHEMA_ROLLBACK_BRIDGE` from normal
   configuration.

## What the preflight rejects

The bridge fails closed for:

- a missing `schema_migrations` table or no applied migration;
- schema 013 or any other version older than 014;
- schema 016 or any unknown future version;
- a schema claiming to be 015 without the expected tables and Payment Attempt columns;
- any Saved Payment Method, automatic-renewal authorization, consent event, or automatic run;
- any Payment Attempt carrying a Saved Method, automatic-renewal, or `requires_action` marker;
- unresolved automatic-payment Provider operations or durable jobs;
- Provider inbox facts containing Saved Method or `requires_action` results;
- unpublished automatic-renewal outbox facts.

Schema 014 starts normally without bridge mode. Schema 015 always requires the exact bridge setting,
even when the database contains no blocker facts. Down migrations are never part of this procedure.

## Verification

Use Node `24.18.0` and a fresh PostgreSQL database migrated through schema 014:

```sh
pnpm --filter @opensales/core build
pnpm --filter @opensales/core test
pnpm --filter @opensales/api build
DATABASE_URL=postgresql://... \
  pnpm --filter @opensales/api test:integration:schema-rollback-preflight
pnpm --filter @opensales/worker typecheck
```

The PostgreSQL integration test performs its temporary schema-015 expansion and blocker inserts in a
transaction and rolls it back. It verifies missing, 013, 014, incomplete 015, empty 015, blocked 015,
and future-schema behavior without persisting synthetic facts.
