<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ADR 0003: Forward-only database migrations

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**
>
> The migration and recovery process described here is for the isolated
> laboratory release candidate. It is not a production disaster-recovery claim.

- Status: Accepted
- Decision date: 2026-07-18
- Scope: PostgreSQL schema evolution, application compatibility, and recovery

## Context

OpenSales System stores financial, authorization, lifecycle, operation, outbox,
inbox, and audit truth in PostgreSQL. Concurrent application startup must not
race to mutate that schema. Destructive rollback migrations could erase valid
state created by a newer release and would make recovery claims difficult to
audit.

Application rollback and data recovery are different operations and require
different controls.

## Decision

### Migration execution

Database migrations are forward-only and run through a dedicated `migrate`
command.

- the migration command acquires a PostgreSQL advisory lock before changing the
  schema;
- API and Worker startup never run migrations;
- API and Worker check schema compatibility and refuse unsafe startup;
- every migration has a stable identifier and an append-only execution record;
- migration execution is observable and audited without logging secrets or
  sensitive payloads;
- a failed migration produces a non-zero result and leaves evidence sufficient
  for diagnosis and a safe forward repair.

Down migrations are not a recovery mechanism and are not shipped as an automatic
rollback path.

### Compatible change sequence

Schema evolution follows:

```text
expand -> backfill -> constraint -> later contract
```

The steps are separate, observable release operations:

1. **Expand:** add structures that old and new compatible application versions
   can tolerate.
2. **Backfill:** migrate existing data using bounded, restartable, idempotent
   work with progress evidence.
3. **Constraint:** enforce the invariant only after validation proves all rows
   satisfy it.
4. **Later contract:** remove obsolete structures no earlier than a later
   compatible release.

Destructive contraction spans at least two releases. A release cannot both make
an old representation obsolete and remove it.

This ADR defines the migration protocol only. It does not define a database
schema or authorize a business migration.

### Application rollback

An application image may be rolled back only when its declared schema
compatibility range includes the currently installed schema.

Release metadata binds:

- source commit;
- lockfile hash;
- application image digest;
- SBOM digest;
- schema version and compatibility range; and
- contract version and compatibility range.

Deploy tooling verifies this metadata before starting API or Worker. A rollback
that falls outside the compatibility range is blocked rather than attempted.

### Data recovery

When no compatible image rollback exists, recovery uses a verified backup and
restore procedure, not a destructive down migration.

The recovery record states:

- selected recovery point;
- components restored and their compatible versions;
- measured data-loss boundary;
- integrity checks and ledger reconstruction results;
- outbox/inbox/operation consistency checks; and
- the decision that authorizes external mutation to resume.

After restore, Provider mutation and normal Worker dispatch remain disabled.
Core first verifies schema, ledger balance, operation ownership, inbox/outbox
state, and audit continuity, then reconciles external operations. Only an
explicit, audited release decision re-enables mutation.

### Migration ownership

Each Core module owns migrations for its data. Another module cannot silently
change that representation. Cross-module changes require one reviewed migration
plan that lists compatibility and repository impacts without bypassing module
ownership.

A financial or authorization invariant must never be split across pull requests
into a deployable state where neither the old nor new invariant is enforced.

## Required verification

CI and Gate evidence cover:

- migration of an empty PostgreSQL database;
- migration from the previous stable release;
- interruption at each migration phase and safe rerun/forward repair;
- concurrent migrate commands proving advisory-lock serialization;
- API and Worker behavior on compatible, too-old, and too-new schemas;
- expand/backfill/constraint behavior on representative synthetic data;
- compatible application rollback;
- restore into a blank environment followed by integrity and reconciliation
  checks.

SQLite or an in-memory substitute is not acceptable for these tests.

Migration tests, schema compatibility policy, and recovery oracles are governance
controls. A change to them must be reviewed and merged independently of an
implementation that would otherwise fail.

## Consequences

- routine deployments cannot rely on automatic down migration;
- releases require explicit compatibility ranges and multi-release planning;
- backfills require resumability and operational visibility;
- recovery is slower but preserves an auditable data-loss boundary;
- API and Worker startup are deterministic and cannot race to migrate;
- schema ownership reinforces the modular-monolith boundary.

## Rejected alternatives

- migration-on-application-startup;
- competing API/Worker migration runners;
- automatic down migration during image rollback;
- same-release destructive replacement of a live representation;
- treating an unverified database snapshot as a successful recovery.
