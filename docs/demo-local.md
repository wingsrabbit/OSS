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
3. migrates through schema 017 and runs `seed-termrat.ts`;
4. starts the API, Worker, Vite Web app, and separate Mock payment,
   provisioning, mail, and mailbox processes on loopback;
5. runs `register -> Mock Mail verification -> order -> Mock payment -> Mock
   provisioning -> Ready for Service -> Active`;
6. writes the generated synthetic credentials and journey IDs to
   `.demo/local/state.json` with mode `0600` and prints them in the terminal.

Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/) and sign in with the
printed synthetic account. Customer and administrator views share `/`; when
the printed account is the first administrator, the administrator panels
appear below the customer view after sign-in.

## Repeat, inspect, and stop

```bash
node tools/demo-local.mjs status
node tools/demo-local.mjs smoke
node tools/demo-local.mjs down
```

`smoke` creates another fully synthetic paid/Active customer journey. `down`
stops only the recorded Demo processes and its isolated PostgreSQL cluster; it
preserves `.demo/local`, including the synthetic login and database.

To explicitly delete only that generated Demo runtime:

```bash
node tools/demo-local.mjs reset --yes
```

## Loopback layout

| Component | Local endpoint |
| --- | --- |
| Web | `http://127.0.0.1:5173/` |
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
  suite. `tools/demo-smoke.mjs` is intentionally shorter: it proves one
  user-visible happy path and leaves the stack running for a human Demo.

## Limits

- This is not a deployment, release, backup/restore proof, or production
  configuration.
- PostgreSQL trust authentication is used only inside the generated cluster,
  which listens on loopback and is not reused outside this Demo.
- The launcher does not install or download dependencies. It fails with a
  clear prerequisite error when frozen dependencies are absent.
- Existing Docker Compose behavior is unchanged; its manual secret-generation
  requirements remain appropriate for the Docker alternative.
