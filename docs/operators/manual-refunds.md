<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Manual refunds

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

Open the administrator panel and use **Manual refunds**. Every decision requires
the `billing.refund_manage` permission, an active Session, a password
confirmation no older than 15 minutes, and a reason of at least 10 characters.
The browser erases the entered password as soon as reauthentication succeeds;
it cannot silently reuse a stored password to roll the 15-minute deadline.

The displayed reference amount is advisory. It uses the recurring invoice lines
and the remaining time of exactly one active service term. The server separately
shows and enforces the maximum refundable amount from the settled Fund Receipt.
The browser submits that displayed maximum as the administrator's confirmation
snapshot. If another decision changes the available amount, Core returns a
conflict and requires a refresh and a new confirmation.

The administrator may:

- refund the current maximum or a smaller amount to the original Mock Payment
  Provider;
- refund it to account Credit;
- record an explicit decision not to refund.

The original payment, receipt, allocation, paid invoice, order, service status,
and service term never change. Cancellation, termination, and refund are
separate actions.

An original-payment request progresses through `queued`, `processing`, and then
`succeeded`, `failed`, `unknown`, or `manual`. A timeout means the result is
unknown: Core reserves the amount and queries the Provider using the original
operation identity. Operators must not create another refund to work around an
unknown result.

The idempotency key identifies a transport attempt, while the request
fingerprint identifies the human decision. Reusing either identity returns the
original result. A genuinely new partial refund has a new displayed balance and
decision fingerprint.

Only a confirmed success creates a settlement and balanced journal. For a
refund sourced from one fully allocated invoice receipt (`allocated_invoice`):

```text
Dr sales_refunds_and_allowances
Cr mock_cash
```

For a return of still-unclaimed receipt funds (`unclaimed_funds`), Core does not
invent an invoice or sales refund. It releases the existing liability:

```text
Dr unclaimed_funds_liability
Cr mock_cash
```

The unclaimed-funds action requires both `billing.unclaimed_manage` and
`billing.refund_manage`, recent password confirmation, an operator reason, and
the displayed available-capacity snapshot. It can only return funds to the
immutable original Mock Payment destination. A failed return releases the
reservation; an unknown result freezes the whole receipt until query-only
reconciliation or a human decision resolves it.

Every capability-authorized callback is retained as an immutable Provider fact.
A contradictory success, wrong amount or currency, reused event ID, or late
success creates an append-only receipt security hold. One exact authorized
outflow per Core refund can be isolated automatically; extra, wrong-amount, or
wrong-currency claims remain evidence but cannot make a Provider invent ledger
cash movements. An isolated outflow is booked without pretending that the
intended refund succeeded:

```text
Dr refund_discrepancy_suspense
Cr mock_cash
```

The Provider cannot release this hold. Known-unsent competing refunds are
cancelled; possibly sent competitors move to manual review. The administrator
opens **Provider facts requiring human adjudication**, reviews the immutable
fact, amount, currency, external identity, current settlement and exact impact,
then re-enters their password and supplies a reason. This action requires the
separate `billing.refund_adjudicate` permission.

Accepting an exact authorized outflow creates the normal settlement and only
reclassifies the already-recorded suspense. The debit is
`sales_refunds_and_allowances` for `allocated_invoice`, or
`unclaimed_funds_liability` for `unclaimed_funds`:

```text
Dr source-context liability or refund expense
Cr refund_discrepancy_suspense
```

It does not credit `mock_cash` a second time. Dismissing a claim that had an
isolated outflow posts the compensating entry:

```text
Dr mock_cash
Cr refund_discrepancy_suspense
```

If later authoritative evidence proves that a dismissed success really did move
cash, use **Dismissed Provider facts that can be corrected**. The correction is
not an edit or deletion of the original adjudication. It is a one-time,
fact-bound, reauthenticated and version-checked append-only decision:

```text
Dr refund_discrepancy_suspense
Cr mock_cash
```

This restores the real cash reduction exactly once and reserves only a source
receipt with the same currency. A EUR discrepancy, for example, remains in its
EUR suspense ledger and is not subtracted from a USD refundable balance without
an explicit future FX/allocation fact. Core marks the Provider Operation as a
confirmed success while leaving the intended Refund failed, so the page states
both facts instead of claiming that the Provider failed. Under the same receipt
lock, Core cancels queued known-unsent competitors and moves any possibly-sent
competitor into a recoverable `manual` state without a synthetic security hold.
The operator must query the original Provider operation and may only confirm no
outflow after independent evidence; Core never sends a second create request.
The Worker independently recalculates the
aggregate receipt reservation immediately before every Provider create; a stale
queued request that no longer fits is failed without making an external call.

If a competing refund's real success callback arrives before the correction,
Core preserves that settlement and also posts the later-confirmed corrected
outflow. It then opens **Receipt compensation overages requiring manual recovery**
with the immutable receipt amount, total confirmed cash/Credit compensation, and
overage. This is
not a disputable Provider claim: the only page action acknowledges operational
ownership of manual financial recovery. It requires `billing.refund_adjudicate`,
recent password confirmation, a reason, a displayed amount snapshot, and an
idempotency key. Acknowledgement records ownership but the incident remains
visible as **recovery outstanding**; it does not reverse either compensation,
change a refund settlement, or add a journal. A later same-currency unexpected
outflow creates another append-only cumulative incident instead of changing or
hiding the earlier snapshot. Only the latest snapshot for a receipt is the
current recovery amount. Earlier amounts are marked **superseded history**, are
not actionable, and must never be added to the latest cumulative overage.
Current ordering uses a monotonic per-receipt sequence allocated while the
receipt is locked; transaction timestamps are display evidence only and cannot
select an older snapshot as current.
For an `unclaimed_funds` incident, the displayed confirmed total disposition is
the receipt's immutable allocated amount (including Credit conversion) plus all
confirmed Provider outflows. For an `allocated_invoice` incident it remains the
confirmed refund compensation only. This prevents a dismissed return from being
allocated and later confirmed as cash out without opening a recovery item.
Wrong-currency compensation remains in its own suspense currency and cannot
create or advance a receipt-currency capacity incident without an explicit
future FX/allocation fact.

Provider timestamps are high-water marks. An older fact, or a timestamp outside
the accepted operation window, is retained as immutable evidence and audited,
but cannot move a Refund or Provider Operation backward, replace the high-water
mark, create discrepancy cash entries, or consume refundable capacity.

Wrong-amount, wrong-currency, or second outflow claims cannot be accepted as the
authorized refund. After checking independent Provider evidence, the operator
may instead record a verified unexpected outflow. That action leaves the refund
unsettled and records the cash reduction against discrepancy suspense; if that
cash journal already exists, it is retained rather than posted twice. A later
financial investigation must clear the suspense with a separate compensating
decision. Holds and adjudications are both append-only. The active hold is
derived from a hold that has no adjudication, so page reloads and retries do not
recreate settlements or journals. Core shows every retained Provider fact,
creates a separate unresolved hold for every distinct success claim, and binds
any discrepancy to the exact fact that created that hold. It also enforces a
cumulative settlement cap equal to the immutable source receipt. Once every hold
on that receipt is resolved, possibly sent competing operations resume with a
Provider query, never a second create call.

If bounded Provider queries exhaust without a terminal fact, the refund remains
`manual` and continues reserving its amount. An administrator with the separate
adjudication permission can either schedule another query-only reconciliation,
or record—with password confirmation and a reason—that external evidence shows
no outflow occurred. The latter releases capacity by moving the refund to
`failed`; any later success fact still creates a new sticky receipt hold. Neither
manual action ever sends another Provider create request.

Database upgrades are forward-only. Migration `007_stage_b_manual_refunds` is
immutable; the reconciliation and correction changes are applied by
`008_stage_b_refund_reconciliation`, and callback-first capacity incidents by
`009_stage_b_refund_capacity_incidents`. Migration
`010_stage_b_unclaimed_refunds` adds the unclaimed-funds source context, its
shared receipt-capacity guard, and source-aware incident accounting. API and
Worker refuse to start until the dedicated migration command has installed the
exact required version.

A Credit refund is confirmed in one local transaction:

```text
Dr sales_refunds_and_allowances
Cr client_credit_liability
```

Invoice refunds accept only a Fund Receipt fully allocated to one invoice.
Separately, a still-unclaimed Payment or Add Funds receipt can be returned to
its immutable original Mock Payment destination without fabricating an invoice.
It cannot be converted into an invoice refund, sent to a different destination,
or returned beyond the amount left after allocations and confirmed/unknown
outflows. Third-party destinations remain rejected because authenticated ticket
authorization and two-person review are not implemented yet.
