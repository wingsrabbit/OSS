# Application rollback from schema 017 to the 016 bridge

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This runbook covers the narrow laboratory application rollback between schema
`016_stage_b_manual_receipts` and `017_stage_b_manual_receipt_outflow_reports`. It never runs a
down migration. The default build is native schema 017 and refuses schema 016. The same reviewed
source commit becomes the schema-016 bridge artifact only with the explicit setting below.

Schema 017 adds append-only reports for manual money returned to its original source. A report
records either a confirmed outflow or an unknown outcome. Unknown outcomes freeze capacity until
an audited reconciliation confirms an outflow or confirms that no outflow occurred. Confirmed
facts bind the manual receipt, Fund Receipt, Client Account, currency, source bucket, destination,
current staff permission, Session, 15-minute reauthentication grant, and reason. An invoice claim
gets an allocation reversal; a Credit claim gets a compensating Credit debit. No Payment Provider
operation is allowed for this administrator-recorded external fact.

## Forward rollout

1. Record the reviewed source commit, image digest, lockfile hash, and SBOM digest. Pause staff
   financial mutation and reconcile existing unknown operations.
2. While the database is still schema 016, start this exact build with:

   ```dotenv
   OSS_SCHEMA_ROLLBACK_BRIDGE=016-to-017
   ```

   Run `pnpm --filter @opensales/api rollback:preflight`. It must report native schema 016.
3. Stop every API and Worker. The migration runner requires exclusive access to the schema-015/016
   bridge lock, schema-016 application lock, schema-016/017 bridge lock, and schema-017 application
   lock. It refuses to race any live application process.
4. Run the forward migration with the migration-owner connection. Do not use runtime application
   credentials for DDL.
5. Remove `OSS_SCHEMA_ROLLBACK_BRIDGE`, run the read-only preflight again, then start the default
   native-017 API and Worker. Each holds the schema-017 application guard for its entire lifetime.

## Application rollback after migration

1. Pause staff financial mutation, background dispatch, and callback ingress. Reconcile external
   unknowns with the native-017 application. Stop every native-017 API and Worker.
2. Set `OSS_SCHEMA_ROLLBACK_BRIDGE=016-to-017` only on the reviewed bridge artifact and run the
   preflight. A valid result names schema 017, mode `rollback_bridge`, and an empty blocker list.
3. Any manual outflow report, reconciliation, confirmed fact, allocation reversal, Ledger/Credit
   marker, job, inbox, outbox, or Provider-operation marker blocks the rollback. Do not delete or
   rewrite facts to make it pass. Repair forward or place the affected funds under manual control.
4. Start the bridge API and Worker. Both hold the schema-016/017 bridge guard for their entire
   lifetime. Every INSERT or UPDATE that introduces or removes a schema-017 marker first takes the
   conflicting transaction lock, closing the gap after preflight.
5. Keep schema-017 business writers disabled. Before migrating or returning to native 017, stop
   every bridge process. There is no down migration.

## Failure and cleanup

Catalog checks use an exact Node SHA-256 digest over explicitly public relations, columns,
constraints, indexes, enabled triggers, functions, and affected views, ordered with `COLLATE "C"`.
Read-only checks use `pg_catalog,public`; the migration runner keeps `public` as the creation target
while qualifying lock and business objects. A role schema or public function shadow cannot replace
PostgreSQL built-ins used by the check.

If startup, migration, or advisory-lock cleanup fails, keep financial mutation stopped. Treat a
cleanup failure as a failed release even if the primary operation also failed; discard that database
session, verify live lock holders, and rerun preflight from a fresh process. Never disable triggers,
edit `public.schema_migrations`, or use `session_replication_role` to force startup.

## Verification

Use Node.js 24.18.0 and PostgreSQL 18:

```sh
pnpm --filter @opensales/core build
pnpm --filter @opensales/core test
pnpm --filter @opensales/api build
DATABASE_URL=postgresql://... \
  pnpm --filter @opensales/api test:integration:schema-016-017-rollback-preflight
pnpm --filter @opensales/worker typecheck
```

The PostgreSQL test database must be disposable and prepared from the real migration files through
schema 016. The integration executes the checked-in migration 017 file itself, verifies the exact
catalog, INSERT and UPDATE marker locks, catalog drift, business blockers, and both native and
explicit bridge modes.
