# Two-host Mock-only laboratory RC deployment

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This runbook deploys an exact OpenSales System laboratory revision across the dedicated `TestA`
Core/Staging profile and `TestB` Provider Lab profile. It authorizes no production data, real
Provider, DNS mutation, host cleanup, remote access, image publication, or vulnerability testing.
Those actions require their own explicit operating authority.

The two Compose projects never share a Docker network. Core and Provider processes communicate only
through two operator-approved HTTPS origins. Do not replace either origin with an unreviewed address,
disable certificate verification, or widen a bind address merely to make a readiness check pass.

## Topology

| Profile | Containers | Durable databases |
| --- | --- | --- |
| `TestA` | API, Worker, Web, one-shot migrate/seed, callback gateway, Core TLS edge | Core |
| `TestB` | Payment, Provisioning, Mail, Mailbox, Provider Platform, Provider TLS edge | Payment, Provisioning, Mail/Mailbox, Provider Platform |

TestA uses one `PROVIDER_BASE_URL` for Payment, Provisioning, Mail, Mailbox, and Provider Platform.
`Caddyfile.provider-edge` dispatches only the reviewed paths to the corresponding TestB process.
TestB uses one `CORE_CALLBACK_URL`; `Caddyfile.core-edge` sends the six exact Payment/Provisioning
Provider callback paths through the narrow callback gateway and sends other application traffic to Web.

The independent Provider Platform process owns its own TestB database and token. Provisioning does
not receive the Platform token. This differs intentionally from `DemoLocal`, where the launcher
retains the documented four-database shared-process topology.

Mail and Mailbox intentionally share the Mail database. The Mailbox process entrypoint waits for
Mail readiness on every process start (including daemon restarts) before it runs the shared startup
DDL; do not remove that gate or replace it with Compose start ordering alone.

## Immutable deployment bundle

Build outside both VPS hosts from an exact clean release commit. The build environment must target
`linux/amd64` and use the repository-pinned Node.js and pnpm versions. Produce and retain:

1. the `core-runtime` target from the root `Dockerfile`;
2. the `provider-runtime` target from the root `Dockerfile`;
3. the Web image from `apps/web/Dockerfile`;
4. reviewed PostgreSQL 18 and Caddy images;
5. `deploy/compose.testa.yaml`, `deploy/compose.testb.yaml`, and all four referenced Caddyfiles;
6. a manifest binding the Git commit, target platform, image IDs or repository digests, Compose and
   Caddy SHA-256 values, configuration version, and credential-set version.

The image references supplied to Compose must resolve to exact local `sha256:` image IDs or exact
repository `@sha256:` digests. Floating tags are not release evidence. Both Compose files set
`pull_policy: never`; load the reviewed image bundle before deployment through a separately approved
delivery mechanism. Neither VPS needs Git, Node.js, pnpm, PostgreSQL clients, or native Caddy.

The repository `.dockerignore` is part of the release input. Refuse a build if its context contains a
real `.env` file, dependency tree, test artifact, private directory, certificate, or key.

## Private configuration

Use `deploy/testa.env.example` and `deploy/testb.env.example` only as key inventories. Create the real
files outside the repository, restrict them to the operator account, and replace every `__SET_` and
`__GENERATE_` value. Never copy either completed file into an image, release archive, test report, or
Git worktree.

The profiles have separate database credentials:

- TestA receives only Core database passwords and Core-only key material.
- TestB receives only its four Provider database passwords.
- The five Mock bearer credentials, mailbox credential, and two callback signing secrets are paired
  deliberately across the exact consumers on the two hosts.
- The Provider request-fingerprint HMAC key is Provider-only. Rotate its version independently of the
  Platform bearer token and retain every old `version:key` entry for the Provider database and all
  recoverable backups. The bounded keyring permits at most 32 lifetime versions; it has no automatic
  retirement path.

`CORE_PUBLIC_URL`, `PROVIDER_BASE_URL`, and `CORE_CALLBACK_URL` must be reviewed HTTPS origins whose
certificates match the configured names. Mount the certificate and key through the Compose secret
file inputs. Do not place certificate bytes or private keys in either environment file.

## Preflight gates

Stop at the first failed gate. A stopped gate is not deployment evidence.

1. Confirm the deployment bundle is bound to the intended clean Git commit.
2. Confirm the live host fingerprints still match the separately maintained connection inventory.
3. TestA must have no prior OpenSales containers, volumes, or conflicting deployment ports.
4. TestB must first complete a separately authorized cleanup of old test containers/directories.
   Recheck running containers, Docker storage, available memory, free bytes, and inodes afterward.
5. Compare the measured loaded-image footprint plus expected database/log growth with current free
   disk. Do not infer capacity from compressed archive size or reclaimable Docker estimates.
6. Confirm both hosts are the intended Debian 13 x86_64 Docker/Compose systems and their clocks are
   synchronized. Do not install host-native application tooling for this workflow.
7. Confirm the exact Core and Provider HTTPS bind addresses and ports are unused and approved. The
   database host ports remain bound to `127.0.0.1` for operator-side backup tunnels only.
8. Confirm every configured image exists locally at the exact expected ID/digest and that its
   reported platform is `linux/amd64`.
9. Confirm the private environment and TLS files exist with restrictive permissions, contain no
   placeholder, and match the recorded configuration/credential versions.

Render each project before creating a container. These commands only parse configuration and must not
pull or start anything:

```sh
docker compose --env-file "$LAB_TESTB_ENV_FILE" -f deploy/compose.testb.yaml config --quiet
docker compose --env-file "$LAB_TESTA_ENV_FILE" -f deploy/compose.testa.yaml config --quiet
```

Review the rendered service names, image digests, mounts, loopback database ports, edge bind, and
network membership without saving rendered secret-bearing environment data to disk or logs.

## Start order

Use the exact release copies of the Compose and Caddy files. TestB starts first so no Core worker can
create an operation against an unavailable Mock Provider.

### 1. Start TestB

```sh
docker compose --env-file "$LAB_TESTB_ENV_FILE" -f deploy/compose.testb.yaml up -d
```

Wait until all four databases, all five Provider processes, and `provider-edge` are healthy/running.
From the authorized TestA-to-TestB path, request only these exact readiness endpoints:

- `/health/payment`
- `/health/provisioning`
- `/health/mail`
- `/health/mailbox`
- `/health/platform`

Then request `GET /v1/manifest` with the expected Mock Platform credential and confirm the returned
base URL and six-capability declaration match this release. Do not enumerate other paths or ports.

### 2. Initialize and start TestA without Worker

```sh
docker compose --env-file "$LAB_TESTA_ENV_FILE" -f deploy/compose.testa.yaml up -d core-db
docker compose --env-file "$LAB_TESTA_ENV_FILE" -f deploy/compose.testa.yaml up seed
docker compose --env-file "$LAB_TESTA_ENV_FILE" -f deploy/compose.testa.yaml up -d api callback-gateway web core-edge
```

The one-shot `seed` container must exit successfully before API starts. Confirm Core
`/health/ready`, the Mock-only banner, and the exact schema history through the reviewed application
or native check. Do not bypass a migration error or rerun seed against an uncertain database.

### 3. Start Worker last

Repeat the five exact TestB readiness requests from TestA. Only after they all pass:

```sh
docker compose --env-file "$LAB_TESTA_ENV_FILE" -f deploy/compose.testa.yaml --profile worker-dispatch up -d worker
```

Record container image identities, health state, start time, and configuration version without
recording environment values. Worker belongs to the `worker-dispatch` Compose profile, so a generic
`docker compose up` excludes it. Continue to start Worker only with the explicit command above after
the cross-host readiness gate.

## Functional acceptance

Use synthetic identities and ordinary product flows only. At minimum, verify:

1. registration, mailbox lookup, and email verification cross TestA to TestB Mail/Mailbox;
2. one automatic Mock payment and provisioning path with the same operation identities retained by
   Core and their owning Provider databases;
3. one Provider Platform operation proving the independent `provider_platform` database is used and
   the provisioning process has no Platform capability;
4. all six signed Payment/Provisioning callback endpoints enter through the TestA callback gateway;
5. API and Worker use only the Core runtime role, and no Provider database is reachable through a
   Core database credential;
6. restart of an application container retains database facts and creates no duplicate operation.

Do not use a Cyber, malicious-provider, port-scanning, or raw tamper suite as release evidence for
this normal-only deployment.

## Backup and recovery boundary

The Compose files publish every PostgreSQL port only on host loopback. Run
`tools/lab-backup.mjs create` from the exact clean operator checkout using approved SSH tunnels and the
documented `TestA` or `TestB` connection-field prefixes; never expose a database port publicly.
Capture the two profile archives while the corresponding writers are stopped as required by
`docs/operators/lab-rc-recovery.md`.

The reviewed blank-only executor accepts the exact host archive through
`tools/lab-backup.mjs restore --profile TestA|TestB`. It deep-verifies the archive, preflights every
profile target before writing, restores in manifest order, and records resumable per-component
evidence. A generated restore plan alone is not two-host restore acceptance. Do not call the
deployment a completed final RC until both blank TestA and TestB restore exercises, native checks,
Provider inventory comparison, reconciliation, RPO, and RTO evidence have completed.

## Update and rollback

Every update receives new digest-bound image references and a new configuration version. Start
TestB replacements first, keep Provider mutation dormant, migrate TestA only with the migration-owner
container, and start Worker last after compatibility/readiness gates.

For rollback, stop Worker before API or Provider mutation. Retain all named volumes and unknown
operation evidence. An older image may run only when it explicitly declares the current schema
native-compatible or provides the reviewed bridge for that exact boundary. Never use a down
migration, delete business facts, edit `schema_migrations`, or remove volumes to make an image start.

Host cleanup, container removal, volume removal, image pruning, certificate replacement, DNS change,
and release publication are deliberately outside this runbook and require separate authorization.
