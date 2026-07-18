<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ADR 0001: Clean-room modular monolith

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**
>
> This repository is a laboratory release candidate foundation. It is not
> authorized to process real customers, money, services, or provider traffic.

- Status: Accepted
- Decision date: 2026-07-18
- Scope: Core architecture and repository foundation

## Context

OpenSales System is an independently designed, open, self-hostable customer and
billing platform. Cloud TermRat is the first deployment profile and acceptance
baseline; it is not the product architecture and must not be embedded in Core
domain logic.

The system needs strong transactional guarantees for money, authorization,
service lifecycle, provider evidence, and audit history. It also needs clear
module ownership without introducing distributed transactions or an
operationally expensive microservice estate before that complexity is justified.

The implementation must remain clean-room. Proprietary source code, database
structures, templates, routes, module signatures, plugin ABIs, and private
fixtures from another billing platform are not valid design inputs.

## Decision

### Clean-room source boundary

The implementation is derived only from:

1. approved independent business specifications and owner decisions;
2. financial, security, authorization, and idempotency invariants;
3. independently audited black-box behavior; and
4. public behavior where its provenance and limitations are recorded.

Feature Evidence Cards keep two independent dimensions. Classification is one
of `retained`, `config`, `excluded`, `quarantined`, or `unknown`; disposition
maps the item separately to Core, a Provider contract, deployment
configuration, or an explicit exclusion. Unknown facts remain unknown; they are
not inferred from a proprietary implementation.

No compatibility layer is provided for proprietary code, database structures,
themes, routes, APIs, modules, hooks, or plugin signatures.

### System shape

OpenSales System is a single-merchant modular monolith:

- one deployment represents one merchant/operator;
- merchant-specific products, prices, text, and policy parameters are validated
  deployment configuration rather than hard-coded domain behavior;
- Core modules execute in one application boundary and use one PostgreSQL
  database as the system of record;
- Web/API and Worker are separate process entry points built from the same
  repository and compatible release;
- cross-module use cases are orchestrated in-process by the application layer;
- modules do not call each other over internal HTTP;
- no distributed transaction is introduced inside Core;
- PostgreSQL-backed durable jobs plus transactional outbox/inbox records bridge
  committed Core state to asynchronous work.

The architecture does not add a placeholder tenant identifier to every table.
Supporting multiple client accounts within one merchant is a domain requirement,
not multi-merchant SaaS tenancy.

### Module ownership

Each Core module owns its domain state, repository interface, and database
migrations. Another module may not mutate its tables directly. A cross-module
application use case may coordinate multiple repositories in a shared database
transaction and must emit its outbox records in that same transaction.

The module map and allowed dependencies are normative in
`docs/governance/module-boundaries.md`.

### Technology baseline

The frozen implementation family is:

- supported Node.js Active LTS, pinned to an exact supported version when G1 is
  executed;
- strict TypeScript and Fastify for the backend;
- React and Vite for the web application;
- PostgreSQL with `pg` and Kysely, or an equivalent SQL-first approach;
- pnpm workspaces;
- REST JSON described by OpenAPI 3.1 and versioned JSON Schema;
- Docker images, Docker Compose, and Caddy for laboratory deployment;
- structured JSON logs, correlation/causation identifiers, health/readiness,
  and metrics.

Exact runtime, package-manager, database, proxy, base-image, and CI action
versions are verified at G1 execution time and then pinned to exact versions,
digests, or commit SHAs. Floating tags and runtime installation of unpinned
dependencies are prohibited.

Redis, Kafka, RabbitMQ, NATS, Temporal, Kubernetes, service mesh, and
Elasticsearch are not required first-release dependencies.

### Contract and license boundary

- Core, Web, Worker, and core administration tools use
  `AGPL-3.0-or-later`.
- OpenAPI, JSON Schema, event schemas, Provider contracts, generators, and the
  official TypeScript SDK use `Apache-2.0`.
- reference and Mock Providers may use `Apache-2.0`.
- each exception directory carries an explicit license and SPDX boundary.
- Apache-licensed contract packages never import AGPL Core implementation code.

## Consequences

### Positive

- Core financial and lifecycle changes can remain transactionally consistent.
- Module boundaries are reviewable without the operational cost of internal
  services.
- Provider implementations can evolve or be proprietary without executing
  inside Core.
- deployment profiles remain portable and do not fork the domain model.
- the clean-room provenance of each retained capability can be audited.

### Costs and constraints

- module boundaries require import rules and database ownership checks; folder
  naming alone is insufficient;
- shared-database transactions must not become permission for arbitrary
  cross-module SQL;
- process entry points must enforce schema and contract compatibility;
- future extraction of a module requires an explicit ADR and cannot weaken
  current ledger, authorization, or idempotency invariants.

## Rejected alternatives

- cloning another billing platform's code, schema, UI, routes, or plugin ABI;
- a multi-merchant SaaS data model in the first release;
- microservices and internal HTTP for Core modules;
- full-system event sourcing or a generic workflow DSL;
- placing deployment-specific product truth in reusable domain code;
- making a Provider implementation part of the Core process.

## Verification

G1 must add automated checks that prove:

- package imports follow the documented dependency direction;
- only a module's repository implementation writes its owned data;
- public contracts build without importing Core implementation packages;
- API and Worker reject incompatible schema versions;
- application state and outbox records commit atomically.

Changes to these checks are governance/oracle changes and must be reviewed and
merged independently of implementation that relies on a relaxation.
