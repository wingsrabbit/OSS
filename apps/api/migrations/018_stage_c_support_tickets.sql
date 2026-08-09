-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Stage C support-ticket vertical slice. All records remain inside the
-- synthetic, Mock-only OpenSales laboratory.

ALTER TABLE public.services
  ADD CONSTRAINT services_id_client_account_key UNIQUE (id, client_account_id);

CREATE TABLE public.support_tickets (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES public.client_accounts(id),
  service_id uuid,
  created_by_user_id uuid NOT NULL REFERENCES public.users(id),
  subject text NOT NULL CHECK (pg_catalog.length(subject) BETWEEN 3 AND 160),
  status text NOT NULL DEFAULT 'awaiting_staff'
    CHECK (status IN ('awaiting_staff', 'awaiting_customer', 'closed')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  FOREIGN KEY (service_id, client_account_id)
    REFERENCES public.services(id, client_account_id)
);

CREATE TABLE public.support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES public.users(id),
  author_type text NOT NULL CHECK (author_type IN ('customer', 'staff')),
  visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
  body text NOT NULL CHECK (pg_catalog.length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (visibility = 'public' OR author_type = 'staff')
);

CREATE INDEX support_tickets_client_updated_idx
  ON public.support_tickets(client_account_id, updated_at DESC, id DESC);

CREATE INDEX support_tickets_staff_updated_idx
  ON public.support_tickets(updated_at DESC, id DESC);

CREATE INDEX support_ticket_messages_ticket_created_idx
  ON public.support_ticket_messages(ticket_id, created_at, id);

-- Forward-repair the three Schema 017 trigger functions that dereference an
-- optional RECORD. Early Schema 017 laboratory databases already carry the
-- migration row, so changing only the 017 file would never repair them. These
-- replacements make an existing 017 database converge on the reviewed PG18
-- definitions while remaining a no-op semantic replacement on a fresh install.
CREATE OR REPLACE FUNCTION public.opensales_validate_manual_receipt_outflow_report()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_row record;
DECLARE
  source_row record;
DECLARE
  credit_row record;
DECLARE
  resolution_created_at timestamptz;
BEGIN
  -- Give the optional record a stable tuple descriptor even when this report
  -- is not backed by converted Credit. PostgreSQL cannot dereference an
  -- entirely unassigned RECORD inside the guarded boolean expression below.
  SELECT NULL::uuid AS id, NULL::uuid AS client_account_id, NULL::text AS currency
  INTO credit_row;

  SELECT
    fact.client_account_id AS fact_client_account_id,
    fact.received_at,
    fact.currency AS fact_currency,
    receipt.client_account_id AS receipt_client_account_id,
    receipt.amount_minor,
    receipt.currency AS receipt_currency,
    receipt.disposition
  INTO receipt_row
  FROM public.manual_receipt_facts fact
  JOIN public.fund_receipts receipt
    ON receipt.id = NEW.fund_receipt_id
   AND receipt.reported_manual_receipt_id = fact.id
  WHERE fact.id = NEW.manual_receipt_id
  FOR UPDATE OF receipt;

  SELECT source_context, client_account_id, currency, source_amount_minor,
         confirmed_outflow_minor, capacity_frozen, available_minor
  INTO source_row
  FROM public.manual_receipt_outflow_capacity
  WHERE manual_receipt_id = NEW.manual_receipt_id
    AND fund_receipt_id = NEW.fund_receipt_id
    AND source_context = NEW.source_context
    AND fund_receipt_resolution_id IS NOT DISTINCT FROM NEW.fund_receipt_resolution_id;

  IF NEW.source_context = 'converted_credit' THEN
    SELECT account.id, account.client_account_id, account.currency
    INTO credit_row
    FROM public.fund_receipt_resolutions resolution
    JOIN public.credit_transactions source_credit
      ON source_credit.kind = 'unclaimed_funds'
     AND source_credit.source_type = 'fund_receipt_resolution'
     AND source_credit.source_id = resolution.id
    JOIN public.credit_accounts account
      ON account.id = source_credit.credit_account_id
    WHERE resolution.id = NEW.fund_receipt_resolution_id
      AND resolution.action = 'convert_to_credit'
    FOR UPDATE OF account;
  END IF;

  IF NEW.fund_receipt_resolution_id IS NOT NULL THEN
    SELECT created_at
    INTO resolution_created_at
    FROM public.fund_receipt_resolutions
    WHERE id = NEW.fund_receipt_resolution_id;
  END IF;

  IF receipt_row IS NULL
     OR source_row IS NULL
     OR receipt_row.fact_client_account_id <> NEW.client_account_id
     OR receipt_row.receipt_client_account_id <> NEW.client_account_id
     OR receipt_row.fact_currency <> NEW.currency
     OR receipt_row.receipt_currency <> NEW.currency
     OR source_row.client_account_id <> NEW.client_account_id
     OR source_row.currency <> NEW.currency
     OR (NEW.source_context = 'converted_credit' AND (
       credit_row.id IS NULL
       OR credit_row.client_account_id <> NEW.client_account_id
       OR credit_row.currency <> NEW.currency
     ))
     OR receipt_row.disposition = 'reversed'
     OR (NEW.occurred_at IS NOT NULL
       AND resolution_created_at IS NOT NULL
       AND NEW.occurred_at < resolution_created_at)
     OR source_row.capacity_frozen
     OR NEW.amount_minor > source_row.available_minor
     OR (NEW.occurred_at IS NOT NULL AND NEW.occurred_at < receipt_row.received_at)
     OR (NEW.occurred_at IS NOT NULL
       AND NEW.occurred_at > pg_catalog.now() + interval '5 minutes')
     OR NOT public.opensales_validate_manual_receipt_outflow_authorization(
       NEW.actor_id, NEW.actor_session_id, NEW.reauth_grant_id
     ) THEN
    RAISE EXCEPTION 'manual receipt outflow report exceeds or mismatches its immutable authorized source';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_manual_receipt_outflow_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  report_row record;
DECLARE
  credit_row record;
BEGIN
  -- See the report guard above: unclaimed/allocated paths still evaluate a
  -- boolean expression containing this optional record on PostgreSQL 18.
  SELECT NULL::uuid AS id, NULL::uuid AS client_account_id, NULL::text AS currency
  INTO credit_row;

  SELECT report.*, receipt.id AS locked_receipt_id
  INTO report_row
  FROM public.manual_receipt_outflow_reports report
  JOIN public.fund_receipts receipt ON receipt.id = report.fund_receipt_id
  WHERE report.id = NEW.report_id
  FOR UPDATE OF report, receipt;

  IF report_row.source_context = 'converted_credit' THEN
    SELECT account.id, account.client_account_id, account.currency
    INTO credit_row
    FROM public.credit_transactions source_credit
    JOIN public.credit_accounts account
      ON account.id = source_credit.credit_account_id
    WHERE source_credit.kind = 'unclaimed_funds'
      AND source_credit.source_type = 'fund_receipt_resolution'
      AND source_credit.source_id = report_row.fund_receipt_resolution_id
    FOR UPDATE OF account;
  END IF;

  IF report_row IS NULL
     OR report_row.observed_outcome <> 'unknown'
     OR (report_row.source_context = 'converted_credit' AND (
       credit_row.id IS NULL
       OR credit_row.client_account_id <> report_row.client_account_id
       OR credit_row.currency <> report_row.currency
     ))
     OR NOT public.opensales_validate_manual_receipt_outflow_authorization(
       NEW.actor_id, NEW.actor_session_id, NEW.reauth_grant_id
     )
     OR (NEW.occurred_at IS NOT NULL AND NEW.occurred_at < report_row.created_at)
     OR (NEW.occurred_at IS NOT NULL
       AND NEW.occurred_at > pg_catalog.now() + interval '5 minutes')
  THEN
    RAISE EXCEPTION 'manual receipt outflow reconciliation mismatches its unknown authorized report';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_assert_manual_receipt_outflow_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_debit_account text;
DECLARE
  valid boolean;
DECLARE
  effect_row record;
BEGIN
  -- The aggregate below contains CASE branches for converted Credit. Give the
  -- optional record a tuple descriptor so ordinary unclaimed/allocated facts
  -- do not fail before PostgreSQL selects the non-Credit branch.
  SELECT NULL::uuid AS id,
         NULL::uuid AS credit_account_id,
         NULL::bigint AS credit_recovered_minor,
         NULL::bigint AS debt_minor
  INTO effect_row;

  IF NEW.source_context = 'converted_credit' THEN
    SELECT effect.id, effect.credit_account_id,
           effect.credit_recovered_minor, effect.debt_minor
    INTO effect_row
    FROM public.manual_receipt_credit_outflow_effects effect
    WHERE effect.outflow_id = NEW.id
      AND effect.client_account_id = NEW.client_account_id
      AND effect.currency = NEW.currency;
  END IF;

  expected_debit_account := CASE NEW.source_context
    WHEN 'unclaimed_funds' THEN 'unclaimed_funds_liability'
    WHEN 'allocated_invoice' THEN 'sales_refunds_and_allowances'
    ELSE 'client_credit_liability'
  END;

  SELECT
    journal.sealed_at IS NOT NULL
    AND pg_catalog.count(*) = CASE
      WHEN NEW.source_context = 'converted_credit' THEN
        1
        + (CASE WHEN effect_row.credit_recovered_minor > 0 THEN 1 ELSE 0 END)
        + (CASE WHEN effect_row.debt_minor > 0 THEN 1 ELSE 0 END)
      ELSE 2
    END
    AND COALESCE(pg_catalog.sum(line.debit_minor), 0) = NEW.amount_minor
    AND COALESCE(pg_catalog.sum(line.credit_minor), 0) = NEW.amount_minor
    AND CASE WHEN NEW.source_context = 'converted_credit' THEN
      COALESCE(pg_catalog.sum(line.debit_minor) FILTER (
        WHERE line.account_code = 'client_credit_liability'
          AND line.credit_minor = 0), 0) = effect_row.credit_recovered_minor
      AND COALESCE(pg_catalog.sum(line.debit_minor) FILTER (
        WHERE line.account_code = 'chargeback_receivable'
          AND line.credit_minor = 0), 0) = effect_row.debt_minor
    ELSE
      COALESCE(pg_catalog.sum(line.debit_minor) FILTER (
        WHERE line.account_code = expected_debit_account
          AND line.credit_minor = 0), 0) = NEW.amount_minor
    END
    AND COALESCE(pg_catalog.sum(line.credit_minor) FILTER (
      WHERE line.account_code = 'cash_clearing'
        AND line.debit_minor = 0), 0) = NEW.amount_minor
  INTO valid
  FROM public.ledger_journals journal
  JOIN public.ledger_lines line ON line.journal_id = journal.id
  WHERE journal.source_type = 'manual_receipt_outflow'
    AND journal.source_id = NEW.id
    AND journal.currency = NEW.currency
  GROUP BY journal.id, journal.sealed_at;

  IF NOT COALESCE(valid, false) THEN
    RAISE EXCEPTION 'manual receipt outflow fact ledger is incomplete';
  END IF;

  IF NEW.source_context = 'converted_credit' AND (
    effect_row.id IS NULL
    OR effect_row.credit_recovered_minor + effect_row.debt_minor <> NEW.amount_minor
    OR ((effect_row.credit_recovered_minor > 0) <> EXISTS (
      SELECT 1
      FROM public.credit_transactions transaction_record
      WHERE transaction_record.kind = 'manual_receipt_outflow'
        AND transaction_record.source_type = 'manual_receipt_credit_outflow_effect'
        AND transaction_record.source_id = effect_row.id
        AND transaction_record.credit_account_id = effect_row.credit_account_id
        AND transaction_record.credit_minor = 0
        AND transaction_record.debit_minor = effect_row.credit_recovered_minor
    ))
  ) THEN
    RAISE EXCEPTION 'converted Credit manual receipt outflow is missing its exact compensating Credit debit';
  END IF;
  RETURN NULL;
END
$$;
