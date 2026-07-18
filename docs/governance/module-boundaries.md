<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Core module boundaries

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**
>
> This module map defines a laboratory architecture. It contains no real
> Provider integration and authorizes no production processing.

## Purpose

OpenSales System is a modular monolith. This document identifies the unique
owner of each kind of Core state and the legal direction of dependencies. It is
normative for package imports, repository writes, application orchestration, and
architecture tests.

The guiding rule is:

> One module owns a state transition. Cross-module use cases coordinate owners;
> they do not bypass them.

## Module ownership map

| Module | Owns | May depend on | Must not do |
|---|---|---|---|
| Identity & Verification | Login identity, credentials, sessions, verification policies/assertions, recovery and assertion revocation | Notification port; Provider evidence adapter; Audit port | Own Client Account, inherit another User's verification, or let a Provider activate a User |
| Client Accounts & Memberships | Client Account, Membership, Contact, account commercial restriction and account-scoped permissions | Identity identifiers/status query; Staff authorization; Audit port | Treat Owner identity as the account, grant permission through Contact, or own service entitlement |
| Staff Authorization | Staff roles, permissions, service credentials, step-up decision and break-glass authorization | Identity/session query; Audit port | Mutate another module's state as an authorization shortcut |
| Catalog & Pricing | Product groups, products, SKUs, options, promotion definitions, visibility and fulfillment-policy configuration | Typed configuration; Audit port | Rewrite an accepted quote, order, invoice, or service history |
| Quotes | Versioned quote snapshots, validity and acceptance state | Catalog/Pricing query; Account eligibility; Audit port | Mutate catalog truth or directly mark an invoice paid |
| Cart, Checkout & Orders | Cart, checkout commands, immutable order snapshots, order lifecycle and consent references | Accounts/guard query; Catalog/Pricing; Quotes; Content/Consent; Billing command port | Own payment, invoice, subscription, service, or operation state |
| Billing, Ledger & Credit | Journals/postings, invoice truth, allocations, customer credit liability, unapplied funds and financial projections | Asset/amount primitives; Accounts identifiers; Audit/outbox ports | Accept direct balance updates, use floating-point money, or let another module write ledger data |
| Payments | Payment intents/evidence, independent TopUpIntent lifecycle, stored-payment references, autopay mandates, refund/chargeback workflow and Provider operation references | Billing commands/queries; account eligibility; Provider operation port; Audit port | Set invoice state directly, store raw card/secret material, reuse Invoice or Payment Intent as TopUpIntent, or treat Provider success as a posting |
| Subscription & Service Lifecycle | Subscription, service, entitlement, billing-period anchor, cancellation/suspension/termination lifecycle | Order and billing settlement queries; account guards; Fulfillment command port; Audit port | Call a Provider directly or collapse Invoice, Service, Subscription, and Operation into one state |
| Fulfillment Operations | Durable external operations, attempts, leases, ownership markers, external identifiers, reconciliation and manual intervention | Service command/query port; Provider adapter; outbox/inbox; Staff authorization | Mark Service state by direct table write, perform calls inside a DB transaction, or claim unowned external resources |
| Support | Departments, tickets, replies, internal notes, attachment quarantine/scan state and authenticated authorization references | Account/membership guards; service/order references; Notification port; Audit port | Let an anonymous contact authorize financial or operational action, or expose unscanned attachments |
| Content & Legal Consent | Announcements, knowledge content, versioned legal documents, immutable consent evidence and language variants | Identity/account identifiers; Audit port | Rewrite historical consent or become a general page-builder/CMS |
| Notifications | Versioned templates, delivery tasks/status and redacted delivery errors | Outbox events; Mail Provider adapter; locale query | Decide business state, activate verification, or send from a domain transaction |
| Automation | Schedule definitions, run records and creation of idempotent jobs | Application command ports; durable jobs; Audit port | Execute long-running external work directly or mutate another module's tables |
| Audit | Append-only security/business audit records and protected export metadata | Actor/request context from every application use case | Become editable business state, store secrets, or replace domain history |
| Provider Registry & Webhooks | Provider installations, manifests, credentials metadata, scopes, endpoint identity, delivery/inbox records and normalized evidence provenance | Public contracts; secret-injection port; Audit/outbox ports | Write ledger/lifecycle state, expose global secrets, or accept arbitrary endpoints |

“Depends on” means a stable query/command port or immutable identifier, not
permission to import another module's repository implementation or issue SQL
against its tables.

## Cross-module orchestration

Application use cases own cross-module workflow. A use case may:

1. authenticate the actor and evaluate all relevant guards;
2. load aggregates through their owning repository interfaces;
3. invoke domain commands on those aggregates;
4. persist changed aggregates through their owners in one UnitOfWork where
   atomicity is required;
5. append Audit and outbox records in the same transaction; and
6. return only after the transaction commits.

It may not:

- update a table directly to manufacture a state transition;
- call a Provider while a database transaction or row lock is held;
- route internal Core coordination over HTTP;
- assume an asynchronous event is exactly-once;
- use eventual consistency where the frozen financial or authorization oracle
  requires one atomic decision.

Cross-module domain events describe committed facts. They are not privileged
commands and do not grant the consumer permission to skip its own guard.

## Aggregate separation rules

The following are intentionally separate aggregates and cannot be represented by
one shared status:

- User, Client Account, and Membership;
- Quote and Order;
- Order and Invoice;
- Invoice, Payment Intent, Payment, and Allocation;
- TopUpIntent, Invoice, and Payment Intent;
- Stored Payment Method and Autopay Mandate;
- Subscription, Service, and Fulfillment Operation;
- Refund and Chargeback.

Authentication, verification, client commercial status, membership permission,
service entitlement, and abuse/security restrictions are also independent guard
dimensions. A UI convenience status may project them, but it cannot replace the
authoritative states.

## Layer and import direction

```text
domain <- application <- API/Worker composition roots
                      <- database/provider infrastructure adapters

contracts <- SDK <- Provider implementations
contracts <- conformance clients and fixtures
SDK + UI  <- Web application
```

Detailed rules:

- `domain` contains aggregates, value objects, domain services, and invariants;
  it imports no HTTP, OpenAPI, UI, Kysely, or Provider implementation code.
- `application` imports domain and defines use cases plus repository, clock,
  secret, job, audit, and Provider semantic ports.
- `database` implements application repository/UnitOfWork ports and owns
  forward migrations grouped by Core module.
- API and Worker are composition roots; adapters translate public contract
  messages into application commands and results back into contract messages.
- `contracts` is Apache-licensed and imports no AGPL implementation package.
- `sdk-typescript` is derived from public contracts, not from internal domain
  types.
- Provider implementations import only public contracts, SDK, and
  Provider-local code.
- `web` imports SDK and UI packages, never database or application internals.
- conformance tests import public contracts; the schema-only client does not use
  the official SDK, and no conformance oracle imports a Mock implementation.

The intended monorepo mapping is:

```text
apps/{api,worker,web}
packages/{domain,application,database,contracts,sdk-typescript,ui,config}
providers/mock-*
conformance/{vectors,provider-tests,schema-only-client,malicious-provider,mutation-fixtures}
deploy/{compose,caddy,runbooks}
docs/{adr,provenance,threat-model,api,operations,governance}
```

An internal test utility package may provide synthetic clocks, identifiers,
builders, and fixtures. It must not contain a second implementation of a domain
rule used by both production code and its oracle.

## Database ownership

- each table and migration has one owning module;
- only the owner's repository implementation writes that data;
- cross-module identifiers are stable references, not write access;
- reporting joins and read projections are isolated from command repositories;
- a shared Kysely/database handle is infrastructure, not a public escape hatch;
- explicit SQL is encouraged for ledger and concurrency-critical paths, but it
  remains inside the owning repository;
- application transaction coordination does not transfer data ownership.

No concrete database schema is defined by this document.

## Provider boundary

Provider Registry & Webhooks authenticates and normalizes external evidence. The
owning business module independently validates current state, amount/resource
scope, and authorization before accepting that evidence.

Examples of the boundary, without defining business implementation:

- payment evidence flows to a Payments application command, which requests
  postings from Billing/Ledger;
- fulfillment evidence flows to a Fulfillment Operations command, which may
  request a Service transition;
- verification evidence flows to Identity & Verification, whose frozen policy
  determines eligibility;
- delivery evidence updates Notifications delivery status, not the domain event
  that requested the message.

Provider adapters never receive Core repository or database credentials.

## Enforcement

G1 architecture tests and lint rules must fail on:

- forbidden package imports;
- an Apache contract package importing AGPL implementation code;
- a Provider importing Core domain, application, or database packages;
- Web importing application or database internals;
- direct cross-module repository or table writes;
- external network calls within a database transaction;
- conformance code importing Mock implementation logic;
- an unowned state transition performed outside an application command.

Changing these enforcement rules is an oracle/governance change. It must be
reviewed and merged independently of implementation that depends on a relaxed
boundary.
