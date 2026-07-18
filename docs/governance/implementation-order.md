<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Implementation order and Gate dependencies

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**
>
> Completion of a laboratory Gate does not authorize real providers, customers,
> money, services, production DNS, or replacement of an existing system.

## Purpose

This document fixes the dependency order for implementation. It prevents code,
Mocks, UI, or deployment work from becoming the accidental source of truth for
state, finance, authorization, or Provider behavior.

The approved specification, frozen G0 artifacts, OpenAPI/JSON Schema, and
independent conformance vectors are normative. Existing implementation behavior
is not an oracle.

## Hard ordering rules

1. Scope, provenance, and product truth precede all domain decisions.
2. Aggregate state/command/guard tables precede repositories and handlers.
3. Financial state tables precede the Ledger Posting Matrix.
4. The Posting Matrix, amount rules, and golden vectors precede ledger code.
5. Transport/trust semantics precede Provider adapters.
6. A capability contract and independent conformance vectors precede its first
   Mock and its first Core consumer.
7. Identity and client-account eligibility precede commercial operations.
8. Ledger settlement semantics precede service activation and provisioning.
9. Stable commands precede Scheduler and automation jobs.
10. Core use cases and security guards precede customer or staff UI.
11. Upgrade, rollback, and recovery tests precede a release candidate.

An implementation may refine internal structure, but it cannot reverse these
dependencies.

## G0 — Independent specification and threat model

No domain implementation begins until G0 exits successfully.

### G0.1 Scope and provenance

- complete the private Scope Confirmation Record outside the public repository;
- commit only its approved redacted digest record;
- freeze evidence source priority and Feature Evidence Cards;
- classify every capability as retained, configuration, excluded, quarantined,
  or unknown;
- draft the fully synthetic declarative deployment seed from the frozen evidence
  set, keeping product values out of Core and marking unresolved inputs;
- record owner-approved deviations and explicit negative scope.

### G0.2 Domain state and authorization

- freeze aggregate state-transition tables, commands, guards, illegal
  transitions, terminal states, concurrency behavior, events, and permissions;
- freeze User, Client Account, Membership, Staff, and Provider guard/RBAC
  matrices;
- prove that authentication state, verification state, client commercial state,
  membership permission, service entitlement, and security restriction are
  independent dimensions.

### G0.3 Financial oracle

- freeze the event-by-event double-entry Ledger Posting Matrix;
- freeze asset precision, amount representation, rounding, idempotency, reversal,
  and balance invariants;
- freeze invoice derivation, allocation, credit, top-up, manual payment,
  surcharge, late-fee, refund, chargeback, and unapplied-funds rules;
- publish independent golden and concurrency vectors.

Every financially relevant transition states either its exact posting or the
explicit reason it produces no posting. State tables and Posting Matrix are
cross-reviewed in both directions.

### G0.4 Transport and Provider oracle

- freeze idempotency scope/hash/replay behavior;
- freeze event, webhook, retry, timeout, reconciliation, and revocation semantics;
- freeze Provider manifest, trust-tier, compromise-containment, and egress rules;
- freeze `v1alpha1` capability drafts needed by later consumers;
- prepare conformance, malicious-input, and mutation vectors independently of
  any Mock.

### G0.5 Security, privacy, and test oracle

- freeze threat model and risk classification;
- freeze Data Classification and Retention Matrix;
- freeze deletion, anonymization, legal-hold, backup-expiry, and Provider
  deletion responsibilities;
- freeze the test strategy and the required
  normal/failure/duplicate/out-of-order/crash/recovery scenario structure;
- freeze G0 financial and transport golden vectors now, and require each later
  capability's vectors to freeze before its Mock or first consumer rather than
  claiming that later-Gate executable tests already ran;
- assign every unknown an owner, fail-safe, impact, and resolving Gate.

### G0 exit

G0 exits only when there is no unexplained P0, an independent Blue/Red review is
recorded, and a reproducible Gate Exit Report identifies every frozen oracle.

## Initial repository bootstrap

The one permitted bootstrap commit for a confirmed-empty repository is a narrow
trust anchor, not an implementation shortcut.

It may contain:

- accepted G0 artifacts and ADRs;
- license/SPDX boundaries and repository governance;
- warning labels and contribution/security policy;
- inert workspace structure and exact toolchain pins;
- minimal CI for formatting, specification/schema checks, import boundaries,
  provenance, and secret scanning.

It does not contain:

- business implementation or business database migrations;
- Mock behavior that could define a contract;
- real Provider adapters or credentials;
- deployment execution against a host or DNS service;
- non-public deployment metadata or credential material.

After bootstrap, every implementation change uses a scoped pull request.

## G1 — Repository and runtime foundation

Implement G1 in this order:

1. pin supported runtime, package-manager, database, proxy, base-image, and CI
   dependencies;
2. enforce license and package import boundaries;
3. establish API/Worker/Web composition roots, typed configuration, structured
   logs, health, readiness, and metrics;
4. add the dedicated forward-only migration command, advisory locking, and
   schema compatibility checks;
5. add the minimal UnitOfWork, durable job, outbox, inbox, and dead-letter
   primitives needed to prove atomicity and crash recovery;
6. implement Provider Registry, manifest validation, machine authentication,
   scope enforcement, signed-webhook transport, idempotency, and egress guards;
7. verify transport with a non-business smoke fixture and an intentionally
   failing fixture; neither defines a seventh Provider capability;
8. add Mock-only Compose/Caddy, backup skeleton, hardening, deployment, rollback,
   and recovery runbooks;
9. pass independent review and the G1 Gate Exit Report.

G1 freezes and publishes transport/envelope `v1`. G0 already fixed its normative
semantics; G1 encodes and proves those semantics. G1 jobs are foundation
primitives, while G5 delivers the complete scheduler and operations behavior.

## Later Gate dependency map

| Gate | Scope | Must already exist |
|---|---|---|
| G2 | Identity, verification, accounts, memberships, Staff RBAC | G0 guards; G1 runtime/transport; Mail and Verification alpha contracts before their consumers |
| G3 | Ledger, invoice, payment, allocation, credit, top-up, refund, chargeback | G0 financial oracle; G2 eligibility; Payment and disabled Tax alpha contracts before their consumers |
| G4 | Catalog, quote, order, subscription, service, operation | G0 lifecycle states; G3 settlement semantics; Provisioning alpha contract before its consumer |
| G5 | Jobs, automation, reconciliation, replay, kill switch | Stable G2–G4 commands and G1 durable primitives |
| G6 | Portal, staff UI, support, content, consent, i18n | Stable use cases and guards; AntiAbuse alpha contract before its consumer |
| G7 | SDK, skeletons, six complete Mocks, Provider hardening and conformance | Every capability contract already used by an earlier Gate; independent vectors frozen before each Mock |
| G8 | Synthetic deployment-profile replay | Frozen G0 evidence set and completed retained-capability tests |
| G9 | Two-host Mock-only laboratory release candidate | G0–G8 reports, upgrade/rollback/fault/recovery evidence, release manifest and limitations |

No later Gate may make an earlier Gate pass by silently changing its oracle.

## Critical dependency chains

### State to ledger to payment

```text
financial aggregate state tables
  -> Ledger Posting Matrix and golden vectors
  -> ledger and invoice implementation
  -> Payment evidence adapter
  -> allocation and settlement decision
```

A Provider reports evidence; it never defines a posting or invoice state.

### Settlement to service to provisioning

```text
account eligibility + accepted order + settlement authorization
  -> service lifecycle command
  -> durable external operation
  -> Provider fact/reconciliation
  -> Core service transition
```

An external success cannot skip account, order, or financial guards.

### Contract to conformance to Mock

```text
OpenAPI/JSON Schema
  -> independent golden/malicious vectors
  -> schema-only client and mutation fixtures
  -> Mock implementation
  -> Core consumer and cross-boundary tests
```

The Mock and its tests must not share implementation logic that could reproduce
the same mistake.

## Oracle and policy changes

CI/security policy, state/guard oracles, ledger invariants, and conformance
oracles change in a dedicated pull request. That pull request must demonstrate
that it does not relax a Gate and must merge before any implementation relying
on it. An implementation and the oracle relaxation needed to make it pass never
share one pull request.

Reviewers of ledger, payment, refund, account activation, authorization, service
termination, Provider permissions, migrations, and recovery must be independent
from the author and record reproducible commands and results.
