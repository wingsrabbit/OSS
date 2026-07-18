<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# ADR 0002: Out-of-process Provider boundary

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**
>
> All Provider capabilities in this laboratory are simulated. Passing Mock or
> conformance tests does not authorize or validate a real provider integration.

- Status: Accepted
- Decision date: 2026-07-18
- Scope: Provider contracts, transport, trust, and process isolation

## Context

OpenSales System needs replaceable integrations for payment, provisioning,
verification, mail, tax, and anti-abuse capabilities. These integrations operate
across a trust boundary and may fail, retry, time out, deliver events out of
order, or become compromised.

Loading third-party code inside Core or granting it database access would allow
an integration to bypass authorization, ledger, lifecycle, audit, and recovery
invariants. Treating a Provider response as an instruction to set a Core status
would create the same problem through an API.

## Decision

### Process and network boundary

A Provider is an independent process, container, or remote service. It
communicates with Core only through versioned HTTP APIs and signed webhooks.

A Provider must not:

- import, include, or execute inside the Core process;
- access Core PostgreSQL, internal repository implementations, an internal
  broker, Core files, Core volumes, or global secrets;
- write ledger, invoice, account, service, or operation state directly;
- inject arbitrary HTML or JavaScript into customer or staff interfaces;
- register an arbitrary callback or egress destination at runtime.

Managed Provider containers run without root, with a read-only root filesystem,
dropped capabilities, resource limits, no Docker socket, no Core volume or
database credential, and an enforced egress allowlist.

### Decision authority

Providers report facts, evidence, and external operation outcomes. Core remains
the only decision-maker for eligibility, authorization, financial posting, and
business lifecycle state.

An adapter validates provider identity, scope, schema, signature, timestamp,
idempotency, amount/resource bounds, and current Core state before translating
evidence into an application command. The application command, not the webhook
handler, performs any Core transition.

Provider success is not synonymous with a Core state such as paid, active, or
terminated. A timeout is an unknown result and enters reconciliation; it is not
blindly retried as a new external operation.

### Stable transport and alpha capabilities

The transport/envelope contract is versioned independently from capability
contracts:

- transport/envelope begins at stable `v1` after its G1 conformance evidence is
  complete;
- Payment, Provisioning, Verification, Mail, Tax, and AntiAbuse capability
  contracts remain `v1alpha1` in this Mock-only goal;
- project release versions and contract/SDK SemVer are separate version lines;
- only capabilities declared by an installed Provider manifest are exposed by
  Core or rendered by a UI.

OpenAPI 3.1 and versioned JSON Schema are the contract sources of truth. The
official SDK is generated or validated from those public contracts; it is not
the source of truth.

### Delivery semantics

External delivery is at-least-once. Exactly-once external effects are not
claimed.

- every command with side effects has a scoped idempotency key and request hash;
- reuse of one key with a different request is a conflict;
- state changes and outbox records commit in the same PostgreSQL transaction;
- external calls never occur while holding a Core transaction or row lock;
- inbox, event, operation, and delivery identifiers are unique and replay-safe;
- retries are bounded and use backoff, dead-letter handling, and audited replay;
- stale or out-of-order evidence cannot replace newer aggregate state;
- Worker leases and operations can be safely reclaimed after a crash;
- unknown outcomes reconcile before another mutation is allowed.

Webhook verification uses the original canonical bytes, an explicit algorithm,
timestamp tolerance, replay cache, and payload size limit. Key rotation supports
an overlap window, explicit retirement, audience/provider-instance binding, and
issuer/version/time-range revocation.

### Manifest and trust declaration

Every Provider manifest declares at least:

- provider type, contract version, capabilities, and compatibility range;
- API scopes, event subscriptions, PII fields, secrets, network egress, and
  callback routes;
- configuration schema, health, rate/concurrency limits, retention, export, and
  uninstall constraints;
- publisher, endpoint identity, provenance, support, and license;
- trust tier, provider-account binding, amount/resource limits, revocation, and
  compromise response.

Managed containers additionally declare image digest, signature, SBOM, runtime
limits, and egress policy. Remote services additionally declare endpoint
ownership, TLS identity, key rotation, processing region/data type, and health
metadata.

### Endpoint and egress safety

Provider endpoints are fixed at installation and use only declared HTTPS
schemes and ports. Validation rejects userinfo, ambiguous/encoded addresses,
loopback, link-local, metadata targets, host-local addresses, unauthorized
private networks, IPv6 ULA, mapped-address bypasses, and zone-scoped addresses.

Every resolved address must match an exact allowlist before connection. Core
re-resolves and validates immediately before connection and pins the selected
destination. Redirects are disabled by default; an explicitly permitted redirect
repeats validation at every bounded hop. An egress proxy or host firewall
enforces the decision; application checks alone are not sufficient.

### Compromise containment

A correctly authenticated but compromised high-trust Provider can still send
false evidence. The architecture therefore contains, rather than denies, this
risk:

- provider-account, client, amount, and resource boundaries;
- anomaly holds and emergency kill switches;
- issuer/version/time-range revocation and affected-object lookup;
- reconciliation with separately identified evidence provenance;
- lower automation limits for same-trust reconciliation;
- no automatic release of a compromise hold based only on the same Provider's
  reconcile response;
- drain, reconcile, export, or manual-mode transition before uninstall when
  pending operations or owned resources exist.

### Declarative UI only

Provider-specific actions and forms use Core-defined, versioned declarative
descriptors. A Provider cannot ship or inject executable customer/staff UI code.

## Contract-first verification

For each capability, the normative schema, golden vectors, failure vectors, and
malicious inputs are frozen before the corresponding Mock or consumer is
implemented.

Conformance includes:

- a client written only from published OpenAPI/JSON Schema without the official
  SDK;
- malicious Providers with valid credentials that exceed scope or boundaries;
- signature, clock, replay, idempotency, amount, state, and permission mutation
  fixtures;
- network fault injection for timeout, reset, delay, duplicate, and out-of-order
  delivery;
- proof that mutations are killed rather than shared by Mock and test code.

Conformance code may import public contracts, but it must not import a Mock's
implementation. Providers may import the public contracts or SDK, but never Core
domain, application, or database packages.

## Consequences

- Provider development and licensing remain independent from Core.
- Integration failures become explicit, durable operations rather than hidden
  synchronous side effects.
- More reconciliation and operational tooling is required.
- A Mock-only result cannot be promoted to a stable real-provider claim.
- Adding a capability or permission is a reviewed contract and installation
  change, not an untracked implementation detail.

Changes to transport security, trust rules, or conformance oracles must be
reviewed and merged independently of code that depends on a relaxation.
