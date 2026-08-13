<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# OpenSales System

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

OpenSales System (OSS) is an independent, open-source, self-hosted platform for
customer accounts, ordering, billing, support, and service orchestration. The
project is clean-room software: it does not copy or implement compatibility
with WHMCS code, schemas, routes, templates, module interfaces, or plugins.

Current project version: `0.1.1`.

## What a laboratory user can do now

The first runnable vertical slice is implemented:

- a visitor can browse the synthetic TermRat product configuration and see
  one-time, setup, and recurring prices by billing cycle;
- a customer can register, sign in while still unverified, receive a
  one-time verification link through the Mock Mail Provider, and verify the
  account;
- an unverified or restricted account is rejected by the server when it tries
  to order or start a payment;
- an eligible customer can accept versioned laboratory Terms/AUP, submit a
  price-snapshotted order, and receive a distinct invoice and pending service;
- the customer can run Mock payment success, failure, cancellation, timeout,
  duplicate, and out-of-order scenarios;
- a settled payment creates one balanced journal and invoice allocation before
  Core decides whether the order may proceed;
- a customer can combine Credit with an external payment, see the configured
  payment fee, add synthetic funds, and keep late or mismatched money isolated
  for staff review;
- when a settled Mock Add Funds payment is charged back, Core preserves the
  original receipt and paid invoices, recovers only available Credit, records
  consumed principal as explicit Client Account debt, restricts only that
  Client Account, and gives both customer and staff a page-level breakdown;
- an administrator can re-confirm their password, resolve unclaimed funds,
  adjust Credit, and make a full, partial, Credit, original-payment, or explicit
  no-refund decision from the web interface;
- a still-unclaimed receipt can be returned to its immutable original Mock
  Payment destination without inventing an invoice; failure releases capacity,
  while unknown or security-held results block competing allocation and returns;
- confirmed refunds are separate append-only facts: they do not rewrite the
  original payment, paid invoice, order, service, or service term;
- refund confirmation binds the displayed refundable balance, and replaying the
  same human decision returns the original result even with a different
  transport idempotency key;
- contradictory Provider success is retained as an immutable fact, booked to
  refund discrepancy suspense, and freezes the source receipt for human review;
- staff can see the Provider evidence and financial impact, then use a separate
  permission, recent password confirmation, reason, and append-only adjudication
  to accept one exact authorized outflow or dismiss and compensate the claim;
- if a competing refund settles before a dismissed real outflow is corrected,
  staff see the resulting receipt overage and can accept responsibility for
  manual recovery without deleting or reversing either established outflow;
  only the latest cumulative snapshot for a receipt is actionable, while older
  snapshots stay visible as non-additive history;
- automatic products create one stable Provider operation; a timeout becomes
  `unknown`/`confirming` and is reconciled instead of creating a second resource;
- a service becomes Active only after a Ready for Service fact, and its term
  starts at that time.

The React customer and administrator page shows Order, Invoice, Payment,
Provider Operation, Refund, and Service as separate facts. It never presents
payment success as service activation, or a refund as implicit cancellation.

This code is protected by strict TypeScript checks, production builds, and
PostgreSQL exact-money/state journeys. The two-VPS deployment, remaining billing
lifecycle, customer operations, plugin developer journey, and recovery drills
are not yet complete, so this version is not the final Laboratory Release
Candidate.

## Quick start

Use only synthetic identities and data.

### Fast local Demo on macOS (no Docker)

With PostgreSQL 18, the frozen workspace dependencies, and Node 24.18.0
available locally, one command builds the applications, initializes an isolated
PostgreSQL cluster under `.demo/local`, starts API/Worker/Web plus all four Mock
Provider processes on loopback, creates distinct synthetic Staff and customer
accounts with separate authenticated sessions, and proves the Stage A happy
path through an Active service, a service-linked support ticket whose Staff
internal note stays customer-hidden, plus one Provider-free manual
receipt/original-source outflow:

```bash
node tools/demo-local.mjs up
```

The command prints the public `http://127.0.0.1:5173/`, customer
`http://127.0.0.1:5173/customer`, and Staff
`http://127.0.0.1:5173/admin` URLs, generated `.example.invalid` customer and
administrator logins, Client Account IDs, commit/worktree source fingerprint,
and exact order, invoice, service, ticket, internal-note, receipt, and outflow
IDs. Use those printed `127.0.0.1` URLs consistently rather than substituting
`localhost`. Every lifecycle command is serialized by a repository-scoped OS
advisory lock, and a pre-spawn pending record lets the next command safely
recover or reject an interrupted synthetic child start before normal tracked-
process inspection or any action.
Stop the stack without deleting the synthetic data:

```bash
node tools/demo-local.mjs down
```

See [docs/demo-local.md](docs/demo-local.md) for status, repeat-smoke, reset,
ports, reused product components, and limitations.

### Docker Compose alternative

```bash
cp .env.example .env
# Replace every __GENERATE_* placeholder with an independent random value.
docker compose up --build
```

Then open `http://localhost:8080`. The web port is bound to loopback by
default. PostgreSQL and Provider databases have no host port. The Provider
network is separated from the Core data network.

The repository deliberately has no default administrator password and no real
Provider credential. Laboratory deployment secrets belong outside Git.

## Repository layout

- `apps/api`: Fastify API, forward migration, authentication, checkout, finance,
  and Provider fact handling.
- `apps/worker`: PostgreSQL durable job worker and reconciliation flow.
- `apps/web`: React/Vite customer interface with persistent Mock-only warning.
- `packages/core`: exact-money pricing and monotonic state rules.
- `packages/provider-contracts` and `packages/provider-sdk-typescript`: public
  Apache-2.0 schemas, validator, generated OpenAPI, and official SDK.
- `providers/mock-lab`: out-of-process six-capability functional Mock Provider
  with its own database.
- `providers/example-sdk` and `providers/example-schema-only-tax`: official SDK
  and independent public-schema-only Provider examples.
- `compose.yaml`: isolated local laboratory topology.

TermRat names and prices live only in the deployment seed
`apps/api/src/seed-termrat.ts`; they are not platform-core rules.

## Non-production boundary

No real payment, cryptocurrency, provisioning, verification, mail, tax, or
anti-abuse Provider is present. No real customer or legacy WHMCS data is
permitted. See [LAB_LIMITATIONS.md](LAB_LIMITATIONS.md).

Core, Web, Worker, and core administration tools are licensed under
`AGPL-3.0-or-later`. Provider contracts, SDK material, conformance assets, and
Mock Providers use `Apache-2.0` as described in
[LICENSES/README.md](LICENSES/README.md).

Provider developers can start from the generated artifacts, both examples, and
the HTTP-only functional conformance workflow in
[docs/provider-development.md](docs/provider-development.md).

Operators handling synthetic Add Funds losses should read
[docs/operators/add-funds-chargebacks.md](docs/operators/add-funds-chargebacks.md).
