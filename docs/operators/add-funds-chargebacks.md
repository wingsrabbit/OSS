<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Add Funds Chargebacks

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

This laboratory flow handles an external reversal of a previously settled Mock
Add Funds payment. It does not call, emulate, or certify a real card, Alipay, or
cryptocurrency dispute system.

## What the customer sees

The customer can still open **Chargeback account status** after the affected
Client Account becomes restricted. The page shows:

- the immutable external loss and original Mock payment identifiers;
- Credit recovered from the account;
- principal already consumed and therefore recorded as debt;
- the original payment fee reversal;
- whether the Client Account restriction is active; and
- facts held for staff review because they do not match the original payment.

The original payment identity and amount remain immutable. For allocated funds,
the settlement, paid invoice, allocation, order, service and service term remain
unchanged. For unclaimed funds, the receipt disposition moves to `charged_back`
and Core reverses both the unclaimed liability and Mock cash. Restriction blocks new eligible
billing actions; it does not hide the loss status from the signed-in customer.

## Accounting result

Let `P` be the original Add Funds principal, `F` its payment fee and `C` the
available Credit when the Chargeback settles:

```text
Credit recovered = min(C, P)
Debt created     = P - Credit recovered
External loss    = P + F
```

Core posts one balanced compensating journal:

```text
Dr client_credit_liability  Credit recovered
Dr chargeback_receivable    Debt created
Dr payment_fee_revenue      F
Cr mock_cash                 P + F
```

Credit cannot become negative. Consumed principal is a receivable, not a
negative Credit balance. When debt is non-zero, only the affected Client
Account is restricted and its associated users' active password-confirmation
grants are invalidated.

## Provider and failure handling

Core accepts a Mock Chargeback fact only after all of these checks pass:

1. the webhook HMAC and timestamp are valid;
2. the Provider Operation is the exact started Add Funds payment operation;
3. the operation-scoped callback capability matches;
4. the external payment, amount, currency and occurrence time match the
   immutable settled Fund Receipt; and
5. the Credit and debt effects can be committed with a balanced journal.

The Provider does not supply a Client Account identifier. Core derives account
ownership through Provider Operation → Add Funds Attempt → Settlement → Fund
Receipt. The capability is stored as `[REDACTED]` in the Inbox.

Exact duplicate requests and callbacks replay the established result. A
Chargeback received before Core has recorded the Add Funds settlement is kept
as a pending immutable fact; the settlement transaction resolves it before
committing. Wrong amount, currency, payment identity, attempt identity, or a
conflicting external Chargeback identity produces a manual Hold and no
automatic Credit, debt, restriction, or ledger entry. Invalid signatures and
capabilities produce no financial effect.

## Staff procedure

Open **Administrator → Add Funds Chargebacks** and refresh the queue. Confirm
the Client Account, external payment and Chargeback identifiers, external loss,
Credit recovery, debt, fee reversal, restriction state, and any Hold reason.

Do not edit the database, overwrite Credit, or mark an invoice unpaid to make
the numbers look correct. This increment deliberately provides observation and
safe automatic posting only. Debt collection, recovery entries, restriction
release, and adjudication of mismatched Chargeback facts remain later Stage B
work and must not be simulated with direct SQL.
