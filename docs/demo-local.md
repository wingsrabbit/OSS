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
5. runs `register -> Mock Mail verification -> order -> Mock payment -> Mock
   provisioning -> Ready for Service -> Active -> service-linked customer
   ticket`; the synthetic administrator adds one internal note, and the
   customer API view proves that note is not visible; the same administrator
   then records one manual receipt and one confirmed `original_source` outflow
   without calling a Provider;
6. proves that `/`, `/customer`, and `/admin` each return the Vite SPA HTML,
   then writes the source revision, generated synthetic credentials, Client
   Account IDs, and exact order, service, ticket, internal-note, receipt, and
   outflow IDs to
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

The state file records the exact Git revision used by the running processes.
When `up` sees a complete or partial stack from another revision, it performs a
controlled `down`, rebuilds, applies forward migrations through the latest
native schema, and starts the stack again. Synthetic data is preserved. A stack
already running at the current revision is reused for another smoke journey.

The launcher never resets the database automatically. Applied migrations are
immutable: a schema correction must use a new numbered forward migration. If a
revision cannot migrate the preserved Demo database safely, startup fails
closed so the migration can be fixed. `reset --yes` remains a separate,
explicit option only for a deliberately disposable synthetic Demo runtime.

The private state file also records the Demo PostgreSQL PID, exact process
arguments, data directory, loopback host/port, and socket directory. If a stale
process survives after its PostgreSQL PID file disappears, `up` or `down` stops
it only when every stored field, the current full process arguments, and the
actual listening endpoint still match. A missing or different identity fails
closed instead of signaling an unrelated process.

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
  SPA entry paths, the main customer journey, Staff-only ticket-note visibility,
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
