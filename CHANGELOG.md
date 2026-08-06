<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Changelog

All notable project changes will be documented here. Project release numbering and independently versioned Provider contracts/SDKs are separate policies and will be frozen during G0/G1.

## [Unreleased]

### Added

- Settled Mock Add Funds Chargebacks now arrive as immutable Provider facts.
  Core recovers the remaining Credit, records already consumed principal as
  explicit Client Account debt, reverses the original fee revenue, books one
  balanced compensating journal, preserves immutable payment facts, and marks
  reversed unclaimed receipts `charged_back` without rewriting amount or identity,
  settlement, paid invoice, order, or service.
- Customers retain read-only access to a Chargeback status page after their
  affected Client Account is restricted. Staff have a permission-checked queue
  showing the external loss, Credit recovery, debt, fee reversal, restriction,
  and mismatched facts that require manual review.
- The Mock Payment Provider can emit successful, duplicate, wrong-amount,
  wrong-currency, and wrong-original-payment Chargebacks through a stable,
  idempotent endpoint. A Chargeback that reaches Core before its source
  settlement remains pending and is resolved atomically when that settlement
  arrives.
- Administrators can return all or part of a still-unclaimed Fund Receipt to
  its immutable original Mock Payment destination from the web queue. The flow
  requires both funds and refund permissions, fixed-window password
  confirmation, a reason, a displayed-capacity snapshot, and supports failure,
  timeout reconciliation, duplicate/out-of-order callbacks, and reloadable
  history without fabricating an invoice.
- Unclaimed-funds returns use the shared refund Provider state machine with an
  explicit source context and liability-aware journals. Failed requests release
  capacity, while unknown results and receipt security holds freeze allocation
  and further returns until reconciliation or human adjudication.
- Administrator manual refunds for fully allocated invoice receipts, including
  full/partial amounts, original-payment or Credit destinations, an explicit
  no-refund decision, and a reference-only remaining-service calculation.
- Refund Provider Operations, timeout reconciliation, duplicate/out-of-order
  callback handling, append-only settlements/events, and balanced refund
  journals without changing the original paid invoice or service.
- A web refund queue showing the maximum refundable amount, advisory reference,
  password confirmation, reason, Provider fault scenario, and live outcome.
- An append-only refund security-hold queue with impact preview, independent
  adjudication permission, fixed-window password confirmation, optimistic
  concurrency, semantic replay, and compensating or reclassification journals.
- Query-only retry and audited no-outflow decisions for refunds whose bounded
  reconciliation exhausted, without replaying the Provider create request.
- Append-only correction of a dismissed Provider success when later evidence
  confirms the cash outflow, restoring discrepancy suspense and same-currency
  receipt capacity without erasing the original decision or posting twice; the
  correction freezes competing requests and records the Provider Operation as
  succeeded without mislabeling the intended Refund as successful.
- Forward migrations `008_stage_b_refund_reconciliation` and
  `009_stage_b_refund_capacity_incidents`, including serialized migration
  execution and API/Worker fail-closed schema compatibility checks.
- Callback-first receipt-capacity incidents retain every established cash or
  Credit compensation and expose the immutable receipt/confirmed/overage amounts in the administrator
  page, and require a reauthenticated, reasoned, idempotent acknowledgement for
  manual financial recovery without changing any financial fact or hiding the
  still-outstanding recovery. Only the latest cumulative snapshot for each
  receipt is actionable, selected by a locked monotonic receipt sequence rather
  than transaction time; older snapshots remain labelled as non-additive history.
- Add Funds settlement and reconciliation, configured limits, external fees,
  unclaimed-funds review, and audited allocation or Credit conversion.
- Append-only per-account Credit movements, invoice Credit allocations, and
  balanced journals for audited administrator adjustments and customer use.
- Versioned payment-method configuration with immutable invoice payment Quotes.
- Credit plus external Mock payment and Credit-only invoice settlement paths.
- Card/Alipay-style percentage fees calculated only from the external non-fee
  amount, with USDT-style zero-fee configuration in the TermRat laboratory seed.

### Security

- Add Funds Chargeback callbacks require the Provider HMAC, the exact started
  Provider Operation and its operation-scoped capability. Core derives the
  Client Account from the immutable operation chain; callback account and
  attempt claims cannot redirect the loss. Capabilities are redacted before
  Inbox persistence.
- Operation, attempt, Client Account, Fund Receipt, and Credit Account locks
  serialize Chargeback settlement with Provider callbacks and Credit spending.
  Duplicate or reordered facts cannot debit Credit, create debt, restrict an
  account, or post the compensating journal twice. Wrong facts remain immutable
  and visible on manual Hold without automatic financial effect.
- Client Account restriction invalidates fixed-window reauthentication grants
  for every associated member, including a member removed during callback
  processing. A legitimate external loss is still recorded if customer
  eligibility or membership has changed since the original settlement.
- Fund allocation and original-payment return serialize on the same receipt
  lock. If funds are allocated after a failed or dismissed return and a real
  Provider outflow is later confirmed, Core preserves both facts and creates a
  visible cumulative recovery incident from allocated amount plus confirmed
  outflows. PostgreSQL derives the triggering source context and rejects an
  understated incident snapshot.
- API and Worker both enforce `billing.unclaimed_manage` plus
  `billing.refund_manage`; revocation before the first Provider request fails
  known-unsent work without an external call and releases its reservation.
- Refund capacity serializes on the immutable Fund Receipt; queued, processing,
  unknown, manual, and succeeded refunds reserve capacity, while only a
  definitive Provider failure releases it. The Worker rechecks aggregate
  capacity immediately before a Provider create and rejects stale queued work
  without an external side effect.
- Refund submissions bind the displayed available balance and deduplicate the
  same decision across idempotency-key aliases.
- Capability-authorized refund facts are append-only. Contradictory success is
  booked to discrepancy suspense, places a sticky receipt hold, and freezes
  competing operations without allowing a Provider callback to clear the hold.
- Stale or implausibly timed refund facts remain immutable evidence and produce
  an audit event, but cannot regress terminal state or time high-water marks and
  cannot automatically post a cash outflow.
- Automatic discrepancy posting is limited to one exact authorized outflow per
  refund. Each distinct additional success claim receives its own fact-bound
  hold; wrong, extra, duplicate, or reused identities cannot create arbitrary
  cash entries or reuse a dismissed discrepancy. A separately authorized human
  can record a verified unexpected outflow into suspense without creating a
  normal refund settlement.
- Provider external refund identities are serialized and mutually owned across
  settlements and discrepancies. A dismissed fact can be corrected once with
  reauthentication, version conflict protection, a reason, and an append-only
  compensating journal; wrong-currency suspense is never summed as USD capacity.
- A correction that discovers a competing settlement already consumed the
  receipt creates an append-only overage incident. Its acknowledgement is also
  append-only, remains operationally visible, and cannot erase cash, Credit,
  settlements, discrepancies, or journals. A later unexpected outflow creates a
  new current incident rather than mutating the prior snapshot; the prior
  cumulative amount becomes superseded history and cannot be acknowledged again.
- The web client erases a successfully used password immediately, so repeated
  high-risk actions cannot silently renew the fixed 15-minute reauth window.
- Original-payment refunds use the receipt's Provider and external payment
  identity, call Provider create at most once, and reconcile unknown results by
  query. Third-party destinations are rejected until authenticated ticket
  authorization and two-person approval exist.
- The first refund scope deliberately rejects Add Funds and unclaimed receipts
  so consumed Credit or unassigned liabilities cannot be erased.
- Credit writes serialize on the Client Account and Credit Account, reject
  negative balances, and bind every command to a request fingerprint.
- Payment confirmation rejects expired Quotes and any changed invoice,
  allocation, Credit balance, payment-method policy, or active unknown result.
- Payment fees become invoice and ledger facts only after verified Provider
  settlement; failed and cancelled attempts do not mutate historical invoices.
- Payment and provisioning callbacks bind the authenticated installation, exact
  Provider Operation, a started outbound attempt, and a Core-only-derived
  per-operation capability disclosed only in that outbound request.
  Reconciliation accepts only the same capability echoed from an operation the
  Provider actually stored; invalid provisioning proof enters an audited manual
  Hold without activating or mapping a resource.
- Provider webhook HMACs use recursively key-sorted canonical JSON so equivalent
  payloads cannot fail authentication merely because object keys were reordered.
- Rejected capability and not-started events cannot reserve an inbox event ID
  ahead of the legitimate Provider callback.
- Known-unsent and definitively rejected payments close their commands and
  restore applied Credit through append-only compensating entries; mismatched
  settlements remain visible as manual, unclaimed-funds cases.

### Still planned

- Chargeback debt recovery and audited restriction release, renewal,
  suspension/recovery, cancellation/termination, saved payment methods,
  customer operations, plugin, and two-VPS laboratory stages.

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
