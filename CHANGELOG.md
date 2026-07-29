<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Changelog

All notable project changes will be documented here. Project release numbering and independently versioned Provider contracts/SDKs are separate policies and will be frozen during G0/G1.

## [Unreleased]

### Added

- Append-only per-account Credit movements, invoice Credit allocations, and
  balanced journals for audited administrator adjustments and customer use.
- Versioned payment-method configuration with immutable invoice payment Quotes.
- Credit plus external Mock payment and Credit-only invoice settlement paths.
- Card/Alipay-style percentage fees calculated only from the external non-fee
  amount, with USDT-style zero-fee configuration in the TermRat laboratory seed.

### Security

- Credit writes serialize on the Client Account and Credit Account, reject
  negative balances, and bind every command to a request fingerprint.
- Payment confirmation rejects expired Quotes and any changed invoice,
  allocation, Credit balance, payment-method policy, or active unknown result.
- Payment fees become invoice and ledger facts only after verified Provider
  settlement; failed and cancelled attempts do not mutate historical invoices.
- Payment callbacks bind the authenticated installation, exact Provider
  Operation, and a Core-only-derived per-operation capability that is disclosed
  only in the outbound request. Reconciliation accepts only the same capability
  echoed from an operation the Provider actually stored.
- Provider webhook HMACs use recursively key-sorted canonical JSON so equivalent
  payloads cannot fail authentication merely because object keys were reordered.
- Known-unsent and definitively rejected payments close their commands and
  restore applied Credit through append-only compensating entries; mismatched
  settlements remain visible as manual, unclaimed-funds cases.

### Still planned

- Remaining Add Funds, renewal, suspension, cancellation, refund, customer
  operations, plugin, and two-VPS laboratory stages.

## [0.1.1] - 2026-07-29

### Added

- Runnable Strict TypeScript workspace with Fastify API, React/Vite customer
  interface, PostgreSQL durable Worker, and an out-of-process Mock Provider Lab.
- Registration, opaque Sessions, one-time email verification, Client Account
  ownership, versioned legal acceptance, configured catalog, exact price
  snapshots, orders, invoice lines, payment attempts, allocations, balanced
  journals, services, durable jobs, outbox/inbox, and audit events.
- Mock payment success, failure, cancellation, timeout-success, duplicate, and
  out-of-order scenarios.
- Mock provisioning success, failure, and timeout-with-existing-resource
  reconciliation using stable Provider operation keys.
- Mock Mail delivery and a laboratory-only, authenticated self-mailbox for the
  synthetic verification journey.
- Container build, isolated Compose networks, Caddy security headers, and
  persistent Mock-only/noindex warnings.

### Security

- Server-side eligibility checks are repeated at checkout, payment creation,
  payment settlement, and service activation.
- Provider callbacks require HMAC timestamps, inbox deduplication, amount and
  currency matching, monotonic transitions, stable external identifiers, and
  Core-owned state decisions.
- Dependencies use exact versions, a 24-hour release-age policy, lockfile
  supply-chain verification, and an explicit install-script allowlist.

## [0.1.0] - 2026-07-18

### Changed

- G0 policy now requires a source- and scope-bound Evidence Inventory before a Gate can claim complete feature coverage.
- Project package versions are validated against the repository `VERSION` file while bootstrap scripts, dependencies, runtime, and workflow identities remain pinned.
- Scope deviations now accept only the two explicit Goal Owner decisions, with immutable typed records bound to exact authorization lines, Feature closure, Scope, repository bytes, and Gate commits; future deviations require a separately reviewed registry change.
- Frozen Evidence Card decision and review metadata is immutable while review, implementation, and acceptance references may advance only append-only.
- Normative history validation now traverses every Git DAG parent edge, rejects shallow, replaced, custom replace-base, or grafted history, validates the full VERSION/package/README/changelog bundle, and keeps historical Gate approvals isolated from future deviation records.
- Evidence and Inventory narratives reject invisible or punctuation-only content, canonicalize review roles, enforce chronology, and bind frozen semantic-decomposition review coverage to every Requirement and Feature.

## [0.0.0] - 2026-07-18

### Added

- Intentional public-repository bootstrap with clean-room governance, license boundaries, non-production limitations, evidence schemas, architecture decisions, and safe CI policy.
