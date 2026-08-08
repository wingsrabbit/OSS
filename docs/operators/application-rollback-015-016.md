# Application rollback from schema 016 to the 015 bridge

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This runbook covers the narrow laboratory rollback from schema
`016_stage_b_manual_receipts` to the reviewed schema-015 compatibility bridge. It never runs a
down migration. An ordinary 015 image must not start on schema 016.

The bridge is usable only before schema 016 has recorded any manual/offline receipt, reversal, or
manual outflow fact. Terminal, fully allocated, reversed, and fully returned facts remain blockers:
schema 015 cannot faithfully display or administer their source and accounting history.

## Required sequence

1. Record the reviewed bridge image source commit, image digest, lockfile hash, and SBOM digest.
2. Pause checkout, staff financial mutation, Provider callback ingress, billing automation, and the
   Worker. Reconcile unknown external operations with the schema-016 application.
3. Stop the schema-016 API and Worker. Do not delete, rewrite, or anonymize facts to make the
   preflight pass.
4. Set this only on the reviewed bridge API and Worker:

   ```dotenv
   OSS_SCHEMA_ROLLBACK_BRIDGE=015-to-016
   ```

5. Run the read-only preflight with the bridge artifact:

   ```sh
   pnpm --filter @opensales/api rollback:preflight
   ```

6. A valid result names schema 016, mode `rollback_bridge`, and an empty blocker list. A blocker or
   catalog mismatch means repair forward with a schema-016-capable image.
7. Start the bridge API and Worker. Each repeats the preflight and holds the schema compatibility
   guard for its entire process lifetime. Schema-016 manual receipt, reversal, and outflow writes
   must take the conflicting transaction lock, so an old process and a new financial write cannot
   run concurrently.
8. Keep all schema-016 functions and new financial mutation disabled. Deploy the corrected
   schema-016 application, reconcile, remove the bridge setting, and only then resume mutation.

## What fails closed

The bridge rejects missing, older, future, or counterfeit schemas; absent or wrong opt-in; missing
or disabled schema-016 constraints, foreign keys, append-only/completeness/refund/resolution
triggers, or refund-capacity semantics; and every historical manual receipt, reversal, outflow,
Fund Receipt marker, downstream allocation/refund, Ledger journal, job, inbox, outbox, or Provider
operation marker. Reports contain counts and stable blocker codes, never customer references or
payment metadata.

## Verification

Use the pinned Node.js and PostgreSQL versions:

```sh
pnpm --filter @opensales/core build
pnpm --filter @opensales/core test
pnpm --filter @opensales/api build
DATABASE_URL=postgresql://... \
  pnpm --filter @opensales/api test:integration:schema-015-016-rollback-preflight
pnpm --filter @opensales/worker typecheck
```

The isolated PostgreSQL test starts from real migrations through schema 015, constructs the exact
catalog contract that migration 016 must later implement, proves the lifetime lock excludes a new
writer, rejects catalog drift and business facts, and rolls the synthetic expansion back. When the
formal migration 016 lands, its PR must replace the synthetic catalog construction with the real
migration and preserve this gate.
