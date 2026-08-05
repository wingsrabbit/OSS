<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Manual refunds

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

Open the administrator panel and use **Manual refunds**. Every decision requires
the `billing.refund_manage` permission, an active Session, a password
confirmation no older than 15 minutes, and a reason of at least 10 characters.

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

Only a confirmed success creates a settlement and balanced journal:

```text
Dr sales_refunds_and_allowances
Cr mock_cash
```

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
reclassifies the already-recorded suspense:

```text
Dr sales_refunds_and_allowances
Cr refund_discrepancy_suspense
```

It does not credit `mock_cash` a second time. Dismissing a claim that had an
isolated outflow posts the compensating entry:

```text
Dr mock_cash
Cr refund_discrepancy_suspense
```

Wrong-amount, wrong-currency, or second outflow claims cannot be accepted as the
authorized refund. Holds and adjudications are both append-only. The active hold
is derived from a hold that has no adjudication, so page reloads and retries do
not recreate settlements or journals. Core shows every retained Provider fact,
allows at most one unresolved hold per refund, and enforces a cumulative
settlement cap equal to the immutable source receipt. Once every hold on that
receipt is resolved, possibly sent competing operations resume with a Provider
query, never a second create call.

A Credit refund is confirmed in one local transaction:

```text
Dr sales_refunds_and_allowances
Cr client_credit_liability
```

This initial safe scope accepts only a Fund Receipt fully allocated to one
invoice. It rejects Add Funds and unclaimed receipts. Third-party destinations
are also rejected because authenticated ticket authorization and two-person
review are not implemented yet.
