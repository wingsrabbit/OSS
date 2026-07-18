<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# OpenSales System

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

OpenSales System (OSS) is an independent, open-source, self-hosted customer, ordering, billing, support, and service-orchestration platform for a single merchant. It is a clean-room project: it does not copy or implement compatibility with WHMCS code, schemas, routes, templates, module interfaces, or plugins.

Cloud TermRat is the first synthetic deployment profile and laboratory acceptance baseline. It is configuration, not product logic or a hard-coded brand.

## Current status

Current project version: `0.1.0`.

The repository is at bootstrap and G0 specification preparation. It does not yet contain a runnable service, a release candidate, real Provider integration, or production-ready controls. A page opening or a mock happy path will not change that status.

The project may be described as a Mock-only Laboratory Release Candidate only after every G0–G9 gate has machine-reproducible evidence, role-separated review, and an explicit passing exit report.

## Engineering direction

- Strict TypeScript with Fastify for the API and React/Vite for the web application.
- PostgreSQL as the single source of truth, including durable jobs and transactional outbox/inbox delivery.
- A modular monolith with explicit data ownership and application-level orchestration.
- Versioned REST/OpenAPI, JSON Schema, events, webhooks, and Provider contracts.
- Out-of-process Providers with least privilege; Providers never write the Core database, ledger, or business state.
- Append-only double-entry ledger and exact money representations.
- Forward-only database migrations and backup/restore-based recovery.

These constraints are recorded in [architecture decisions](docs/adr/) and the [implementation order](docs/governance/implementation-order.md).

## Explicitly outside this laboratory goal

- Real payment, provisioning, verification, mail, tax, anti-abuse, or vendor integrations.
- WHMCS migration, compatibility, dual-write, or retirement.
- Production DNS, real customers, customer data, or production operations.
- Multi-merchant SaaS tenancy, microservices, a plugin marketplace, or a general-purpose CMS.

See [LAB_LIMITATIONS.md](LAB_LIMITATIONS.md) for the complete release-claim boundary.

## Evidence-first delivery

Requirements are tracked as Feature Evidence Cards. State transitions, authorization guards, ledger postings, transport behavior, Provider trust, data retention, and test vectors are frozen as independent oracles before implementation or Mock behavior. Templates and machine-readable schemas live under [`docs/`](docs/).

## Security and contributions

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability and [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Never include credentials, private infrastructure identifiers, customer data, production logs, or proprietary WHMCS material in an issue, commit, pull request, artifact, screenshot, or fixture.

## License

Core, Web, Worker, and core administration tools are licensed under `AGPL-3.0-or-later`. Contracts, schemas, generators, the official TypeScript SDK, and their conformance assets are licensed under `Apache-2.0`. Reference and Mock Providers use `Apache-2.0`. See [LICENSE](LICENSE), [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt), [LICENSES/README.md](LICENSES/README.md), and [NOTICE](NOTICE).
