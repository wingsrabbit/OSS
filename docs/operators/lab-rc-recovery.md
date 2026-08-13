# Laboratory release-candidate backup and recovery

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This runbook covers release-candidate backup evidence and a deliberately non-executing blank-restore
plan for the disposable OpenSales System laboratory. It supports the `TestA` Core/Staging profile,
the `TestB` Provider Lab profile, and a combined `local` fixture profile. It does not authorize a
production deployment, remote-host access, DNS changes, vulnerability scanning, or destructive
recovery against a populated database.

The first recovery slice has three commands:

- `create` makes encrypted logical PostgreSQL 18 dumps and encrypts the configuration/credential
  bundle supplied on stdin. It records an exact clean Git commit, schema history or Provider table
  inventory, Core attachment integrity/counts, tool versions, SHA-256 checksums, and capture timing.
- `verify` checks the manifest, safe relative artifact names, age envelope headers, sizes, and
  checksums. `--deep` decrypts each database only as a stream into `pg_restore --list`; it discards
  the decrypted configuration stream and never creates a plaintext verification artifact.
- `restore-plan` verifies the archive and writes a gate file. It does not connect to PostgreSQL,
  decrypt configuration to disk, run `pg_restore`, start an application, or resume side effects.

An operator must not claim recovery acceptance from `restore-plan`. A later reviewed slice may add
an executing blank-restore command with the same gates. Until then, use the generated plan as the
required ordered checklist and record a real exercise separately.

## What is protected

`TestA` contains the Core PostgreSQL database. Support attachment bytes, their recorded sizes, and
their SHA-256 digests live in that database, so the Core custom-format dump includes them. Before
capture, `create` refuses an attachment row whose database-native size or digest check fails.

`TestB` contains the separate Mock payment, provisioning, mail/mailbox, and six-capability Provider
Platform PostgreSQL databases. `local` contains all five databases. A profile also has one encrypted
configuration/credential bundle. The bundle must contain the revision-matched runtime configuration,
Compose inputs, and credential material required by that profile; do not put a plaintext copy in the
backup directory.

The manifest records only opaque, non-secret configuration and credential-set version identifiers.
It binds those identifiers to the release commit and profile with a SHA-256 digest. It never records
a database URL, password, key, secret value, recipient identity, absolute path, or plaintext source
path. Do not use a secret itself as either version identifier.

## Preconditions

Use the repository-pinned Node.js `24.18.0`, PostgreSQL 18 client tools, and a reviewed `age` build.
The worktree must be clean and at the exact release commit. Keep the archive on encrypted operator
storage outside the repository with mode `0700`; `create` refuses an output inside the repository,
and creates artifact and manifest files with mode `0600`.

Before either profile is captured:

1. Stop all application writers for that profile. For `TestA`, that includes API mutation traffic
   and Worker dispatch. For `TestB`, that includes every Provider mutation endpoint and callback.
2. Record the actual pause time. Multi-database dumps are ordered, not a distributed PostgreSQL
   snapshot; writers must remain stopped until `create` completes.
3. Prepare a public age recipient. Keep its corresponding identity outside the repository and
   archive.
4. Assign non-secret release identifiers such as `test-a-config-2026-08-13.1` and
   `test-a-credentials-2026-08-13.1`.
5. Export connection fields under the component prefix shown below. Do not construct or export a
   database URL. `pg_dump` and `psql` receive libpq fields only in their child environment, never in
   argv or tool output.

| Profile | Component | Environment prefix |
| --- | --- | --- |
| `TestA` | Core | `LAB_RC_CORE_` |
| `TestB` | Mock payment | `LAB_RC_PROVIDER_PAYMENT_` |
| `TestB` | Mock provisioning | `LAB_RC_PROVIDER_PROVISIONING_` |
| `TestB` | Mock mail/mailbox | `LAB_RC_PROVIDER_MAIL_` |
| `TestB` | Mock Provider Platform | `LAB_RC_PROVIDER_PLATFORM_` |

For each prefix, provide either `PGSERVICE` plus an explicit `PGSERVICEFILE`, or `PGHOST`, `PGUSER`,
and `PGDATABASE`. Optional libpq fields include `PGPORT`, `PGPASSWORD`, `PGPASSFILE`, and the
documented TLS fields. Prefer a mode-`0600` `PGPASSFILE` or service file. Disable shell tracing
before exporting credentials; never paste the resulting environment into evidence.

## Create an archive

The configuration source directory below is an operator-chosen private location. `tar` writes only
to the pipe; no plaintext archive is created. The output directory must not already exist.

```sh
set +x
umask 077
tar -C "$LAB_RC_PRIVATE_CONFIG_ROOT" -cf - . | \
  node tools/lab-backup.mjs create \
    --profile TestA \
    --output "$LAB_RC_BACKUP_OUTPUT" \
    --age-recipient "$LAB_RC_AGE_RECIPIENT" \
    --configuration-version test-a-config-2026-08-13.1 \
    --credential-set-version test-a-credentials-2026-08-13.1 \
    --paused-at 2026-08-13T00:00:00Z
```

Use `--profile TestB` with the four Provider prefixes for the Provider Lab. Use `local` only for a
combined local fixture exercise. If any inspection, dump, or encryption process fails, `create`
removes the newly created incomplete output directory and reports only the affected logical
component; it does not print child stderr.

`--paused-at` is an operator assertion, not proof. The manifest records the start, completion, and
elapsed capture time. Keep the writers paused until the command reports success, then verify the
archive before deciding whether normal laboratory activity may continue.

## Verify an archive

Run the cheap verification after every copy and before planning a restore:

```sh
node tools/lab-backup.mjs verify --archive "$LAB_RC_BACKUP_OUTPUT"
```

For a deep offline verification, make the age identity path available only in the process
environment. Deep verification never contacts a database:

```sh
set +x
export LAB_RC_AGE_IDENTITY_FILE="$LAB_RC_PRIVATE_AGE_IDENTITY"
node tools/lab-backup.mjs verify --archive "$LAB_RC_BACKUP_OUTPUT" --deep
unset LAB_RC_AGE_IDENTITY_FILE
```

The parent process opens that mode-`0600`, non-symlink regular file. The `age` child receives the
identity bytes on stdin with `--identity -`; the private identity path is not copied into child argv,
environment, output, or the manifest.

A checksum-only pass proves that the encrypted bytes match the manifest, not that the identity can
decrypt them. A deep pass proves decryption and PostgreSQL archive readability, not successful
recovery or application correctness.

## Generate the blank-restore gate

Generate a new plan file; it must not already exist:

```sh
node tools/lab-backup.mjs restore-plan \
  --archive "$LAB_RC_BACKUP_OUTPUT" \
  --output "$LAB_RC_RESTORE_PLAN"
```

The resulting file always says:

- Worker dispatch is disabled.
- Provider mutation is disabled.
- automatic resume is false.
- blank PostgreSQL 18 databases are required.
- exact-release native integrity and reconciliation precede any explicit resume.

This command is intentionally dry-run only. Never aim an improvised `pg_restore --clean`,
`dropdb`, or schema-reset command at an existing database. Provision disposable blank databases,
prove they have no user tables, and keep every API, Worker, Provider, callback, and scheduled job
stopped before an executing restore workflow is introduced and reviewed.

## Native integrity and reconciliation acceptance

After an authorized blank restore implementation has completed, acceptance must compare the
restored state with the manifest rather than merely observing healthy processes:

1. PostgreSQL reports major version 18 for every restored database.
2. Core `public.schema_migrations` exactly matches the ordered manifest history. Do not edit that
   table or bypass a digest/catalog gate.
3. Core attachment count and total bytes match; every row satisfies its native
   `octet_length(content) = size_bytes` and `digest(content, 'sha256') = sha256` invariants.
4. Each Provider public-table inventory matches the manifest, then its stored operations/events are
   reconciled through the application's native query behavior.
5. Core jobs, outbox rows, callbacks, and unknown external outcomes are reconciled without sending
   new side effects. Provider mutation and Worker dispatch remain stopped.
6. Record page/API behavior, native checks, reconciliation results, and measured recovery timing in
   `lab-rc-recovery-evidence.template.json`. Only an explicit operator action after all gates pass
   may start side-effecting processes.

## Forward upgrade and application rollback boundary

Restore the exact manifest commit first. Run its native checks and reconcile at its current schema.
Only then stop all application processes again, run reviewed forward-only migrations with the
migration-owner role, run the upgraded build's native checks, and start the upgraded application.
There is no down migration.

An application rollback after a forward migration is allowed only when the target build explicitly
declares the current schema native-compatible or contains the reviewed compatibility bridge for
that exact boundary. A prior image existing is not compatibility evidence. Never delete business
facts, edit `schema_migrations`, disable triggers, or use `session_replication_role` to force an old
application to start.

## RPO and RTO evidence

The laboratory objectives are RPO at most 15 minutes and RTO at most 2 hours. Do not infer either
from a successful dump or a generated plan. For each real disposable exercise, record the failure
time, newest durable source fact included in the restored state, recovery-declared time, calculation
method, and raw evidence references. Leave `measuredSeconds` as `null` and status as `not-measured`
until those observations exist. If an objective is missed, record `missed`; do not change the
measurement or report a pass. Evidence references must be non-secret relative labels or public CI
links; do not paste credentials, database URLs, identity locations, or private filesystem paths.

## Local and CI verification

No VPS or DNS access is needed for this slice:

```sh
node --test tools/lab-backup.test.mjs
pnpm check
git diff --check
```

The fixture tests use fake `psql`, `pg_dump`, `pg_restore`, and `age` executables. They exercise
TestA/TestB inventory validation, encrypted artifact creation, shallow/deep verification, sensitive
manifest rejection, and the non-resumable restore gate without opening a network connection.
