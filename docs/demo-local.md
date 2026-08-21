<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Local product Demo

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This is a product demonstration and ordinary functional smoke check. It does
not perform scanning, penetration testing, security testing, or any VPS,
GitHub, real Provider, or other external-system operation. Only generated
`.example.invalid` identities and synthetic laboratory money/service facts are
created.

## One-command start

Prerequisites on macOS:

- PostgreSQL 18 command-line tools (the launcher detects Homebrew
  `postgresql@18`);
- the repository's frozen dependencies already installed;
- Node 24.18.0. The launcher uses the current exact Node or discovers the
  existing local `oss-node24.*` runtime. `OSS_NODE_BIN` can point to another
  exact Node 24.18.0 binary.

Run from the repository root:

```bash
node tools/demo-local.mjs up
```

The command:

1. builds Core, API, Worker, Web, and Mock Provider Lab;
2. initializes a repository-local PostgreSQL 18 cluster at `.demo/local`;
3. migrates through the latest native schema (currently 018) and runs
   `seed-termrat.ts`;
4. starts the API, Worker, Vite Web app, and separate Mock payment,
   provisioning, mail, and mailbox processes on loopback;
5. on a fresh database, registers and Mock-Mail-verifies a dedicated synthetic
   administrator, consumes the one-time Staff bootstrap token, and immediately
   saves that credential; it then uses a different session, user, and Client
   Account for `register -> Mock Mail verification -> order -> Mock payment ->
   Mock provisioning -> Ready for Service -> Active -> service-linked customer
   ticket`; the administrator adds one internal note, and the distinct customer
   API session proves that note is not visible; the same administrator then
   records one manual receipt and one confirmed `original_source` outflow
   without calling a Provider;
6. proves that `/`, `/customer`, and `/admin` each return the Vite SPA HTML,
   then writes the commit/worktree source fingerprint, separate generated
   synthetic credentials, Client Account IDs, and exact order, invoice,
   service, ticket, internal-note, receipt, and outflow IDs to
   `.demo/local/state.json` with mode `0600` and prints them in the terminal.

The launcher prints three product surfaces:

| Surface | URL | Demo check |
| --- | --- | --- |
| Public | [http://127.0.0.1:5173/](http://127.0.0.1:5173/) | Public laboratory homepage and synthetic catalog |
| Customer | [http://127.0.0.1:5173/customer](http://127.0.0.1:5173/customer) | Sign in with the latest synthetic customer; inspect the Active service and linked ticket |
| Staff | [http://127.0.0.1:5173/admin](http://127.0.0.1:5173/admin) | Sign in with the synthetic administrator; inspect the internal note and confirmed manual outflow |

Use the exact printed `127.0.0.1` host for every surface. Do not switch to
`localhost`: browser cookies are host-scoped, and the Mock Mail verification
link also uses the canonical `127.0.0.1` Demo URL. Use **Sign out** before
switching between the printed customer and Staff identities. On the Staff
page, paste the printed `Manual receipt target Client Account ID` into the
manual-receipt form and choose **Verify account & load history** to display the
stored confirmed `original_source` report.

## Repeat, inspect, and stop

```bash
node tools/demo-local.mjs status
node tools/demo-local.mjs smoke
node tools/demo-local.mjs down
```

`smoke` creates another fully synthetic paid/Active customer journey, linked
ticket with a customer-hidden Staff internal note, and manual
receipt/original-source outflow journey. `down` stops only the recorded Demo
processes and its isolated PostgreSQL cluster; it preserves `.demo/local`,
including the synthetic logins and database.

### Revision-aware upgrades

The state file records the exact source identity used by the running processes:
the Git commit plus a SHA-256 fingerprint of every tracked diff and every
unignored untracked path, mode, and file content. Consequently, an uncommitted
source edit cannot masquerade as the already-built runtime merely because HEAD
did not change. When `up` sees a complete or partial stack from another source
identity, it performs a controlled `down`, rebuilds, applies forward migrations
through the latest native schema, and starts the stack again. Synthetic data is
preserved. Only a complete stack at the same clean or dirty source fingerprint
is reused for another smoke journey.

The launcher never resets the database automatically. Applied migrations are
immutable: a schema correction must use a new numbered forward migration. If a
revision cannot migrate the preserved Demo database safely, startup fails
closed so the migration can be fixed. `reset --yes` remains a separate,
explicit option only for a deliberately disposable synthetic Demo runtime.

Every `up`, `smoke`, `status`, `down`, and `reset` command acquires one
repository-scoped OS advisory lock before it reads or writes config, state, or
source identity. The lock lives in a hashed directory under the operating
system temporary directory, outside both `.demo/local` and the source
fingerprint. The launcher opens the stable semaphore inode itself and retains
the locked file description until command completion or process exit; the
`lockf`/`flock` helper only applies the descriptor lock. A diagnostic owner
record contains the command, PID, process start identity, exact argv, and a
random token. Concurrent commands fail closed without reading Demo state, and
kernel process teardown releases a crashed holder without unlinking the
semaphore inode.

The private state file records a verifiable identity for every process. Each
Node child has its logical name, PID, process start identity, exact argv,
working directory, and (where applicable) exact loopback listener. Newly
started children also receive a random per-process argv token. Before spawn,
the launcher persists a `pendingProcesses` record containing that token and
the exact specification; it saves the PID immediately after spawn and promotes
the record only after exact observation. The next locked command scans for the
unique token before normal inspection: no candidate safely clears the pending
record, one exact argv/cwd/listener candidate is promoted, and multiple or
mismatched candidates retain the evidence and fail closed. The Worker has no
listener, so its independent contract is exact token/PID/start/argv/cwd.
Legacy numeric PIDs are migrated only after their expected name/argv/cwd and
listener all match.

PostgreSQL records its PID, start identity, exact process arguments, data
directory, loopback host/port, and socket directory. Normal `pg_ctl stop` and
orphan recovery both preflight this identity. TERM/KILL escalation repeats the
PID/start/argv/cwd checks immediately before signaling and again while waiting;
the initial preflight also verifies the configured listener. macOS does not
provide this JavaScript launcher an atomic
compare-identity-and-signal primitive, so a very narrow exit/PID-reuse race can
still exist between the final check and the signal syscall; random argv tokens
and repeated fail-closed checks reduce that residual risk but do not claim an
absolute atomic guarantee.

An older preserved database may already contain Staff after the old launcher
has overwritten its only synthetic administrator password. That credential
cannot be reconstructed. The launcher stops with an explicit message instead
of weakening the Staff journey; because this runtime contains synthetic Demo
data only, use `node tools/demo-local.mjs reset --yes` and then `up` when you
deliberately choose to replace that unrecoverable old Demo runtime.

The launcher lifecycle regression suite is independently runnable and is also
part of `product-static` CI:

```bash
node --test tools/demo-local.test.mjs
```

It covers dirty tracked/untracked source fingerprints; real advisory-lock
contention, stable-inode ownership, holder crash release, diagnostic-owner ABA,
and non-inheritance by detached service-like children; pending-process
0/1/multiple candidate and identity-mismatch decisions; a real token-bearing
Node recovery from the pre-PID crash window; failed-spawn cleanup dispositions;
legacy PID migration and PID-reuse refusal; separate Staff/customer identities;
and a negative assertion that fails if a customer ticket response exposes the
Staff internal note.

To explicitly delete only that generated Demo runtime:

```bash
node tools/demo-local.mjs reset --yes
```

## Loopback layout

| Component | Local endpoint |
| --- | --- |
| Public Web | `http://127.0.0.1:5173/` |
| Customer Web | `http://127.0.0.1:5173/customer` |
| Staff Web | `http://127.0.0.1:5173/admin` |
| API | `http://127.0.0.1:3000/` |
| Mock Payment Provider | `http://127.0.0.1:4101/` |
| Mock Provisioning Provider | `http://127.0.0.1:4102/` |
| Mock Mail Provider | `http://127.0.0.1:4103/` |
| Mock Mailbox Provider | `http://127.0.0.1:4104/` |
| Isolated PostgreSQL 18 | `127.0.0.1:55432` |

Logs are under `.demo/local/logs`. Generated configuration, credentials, logs,
and database files are ignored by Git.

## Existing components reused

- `compose.yaml` remains the isolated Docker alternative and documents the
  same Core/Provider database boundaries.
- `apps/api/src/seed-termrat.ts` supplies only synthetic products, prices,
  legal text, and Mock Provider capabilities.
- `providers/mock-lab` remains out of process; the local launcher starts four
  separate loopback instances with separate payment/provisioning databases and
  a deliberately shared Mock mail database.
- `conformance/e2e/tests/stage-a.spec.ts` remains the broad browser acceptance
  suite. `tools/demo-smoke.mjs` is intentionally shorter: it proves all three
  SPA entry paths, the main customer journey, User notification preferences,
  the bilingual Staff template registry, Staff-only ticket-note visibility,
  and one Provider-free manual-receipt outflow, then leaves the stack running
  for a human Demo.

## Limits

- This is not a deployment, release, backup/restore proof, or production
  configuration.
- PostgreSQL trust authentication is used only inside the generated cluster,
  which listens on loopback and is not reused outside this Demo.
- The launcher does not install or download dependencies. It fails with a
  clear prerequisite error when frozen dependencies are absent.
- Existing Docker Compose behavior is unchanged; its manual secret-generation
  requirements remain appropriate for the Docker alternative.
