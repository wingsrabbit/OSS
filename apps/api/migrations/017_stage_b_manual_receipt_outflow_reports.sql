-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Schema 016 reserved manual_receipt_outflows but exposed no supported writer.
-- Refuse to invent report, authorization, source, or reconciliation evidence for
-- an unsupported row. An operator must inspect and repair forward explicitly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.manual_receipt_outflows)
     OR EXISTS (
       SELECT 1 FROM public.ledger_journals
       WHERE source_type = 'manual_receipt_outflow'
     )
     OR EXISTS (
       SELECT 1 FROM public.credit_transactions
       WHERE kind = 'manual_receipt_outflow'
          OR source_type IN (
            'manual_receipt_outflow', 'manual_receipt_credit_outflow_effect'
          )
     )
     OR EXISTS (
       SELECT 1 FROM public.client_account_debt_transactions
       WHERE source_type = 'manual_receipt_credit_outflow_effect'
     )
     OR EXISTS (
       SELECT 1 FROM public.client_account_restrictions
       WHERE source_type = 'manual_receipt_credit_outflow_effect'
     )
     OR EXISTS (
       SELECT 1 FROM public.provider_operations
       WHERE subject_type IN (
         'manual_receipt_outflow_report', 'manual_receipt_outflow'
       )
     )
     OR EXISTS (
       SELECT 1 FROM public.durable_jobs
       WHERE job_type LIKE 'manual_receipt_outflow.%'
          OR payload ? 'manualReceiptOutflowReportId'
          OR payload ? 'manualReceiptOutflowId'
     )
     OR EXISTS (
       SELECT 1 FROM public.provider_inbox
       WHERE payload ? 'manualReceiptOutflowReportId'
          OR payload ? 'manualReceiptOutflowId'
     )
     OR EXISTS (
       SELECT 1 FROM public.outbox
       WHERE event_type LIKE 'manual_receipt_outflow.%'
          OR payload ? 'manualReceiptOutflowReportId'
          OR payload ? 'manualReceiptOutflowId'
     )
     OR EXISTS (
       SELECT 1 FROM public.audit_events
       WHERE target_type IN (
         'manual_receipt_outflow_report', 'manual_receipt_outflow'
       )
     ) THEN
    RAISE EXCEPTION
      'schema 017 cannot attest pre-existing unsupported manual receipt outflow markers; keep financial mutation stopped and repair forward';
  END IF;
END
$$;

-- A future-dated grant could otherwise become valid later for longer than the
-- fixed 15-minute window intended when the operator reauthenticated.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.reauth_grants
    WHERE created_at > pg_catalog.clock_timestamp()
  ) THEN
    RAISE EXCEPTION
      'schema 017 rejects future-dated reauthentication grants; invalidate or repair them before retrying the forward migration';
  END IF;
END
$$;

-- Bridge Workers claim only job types they understand. Give that allowlist a
-- selective pending queue path so older unrelated rows cannot force a scan.
CREATE INDEX durable_jobs_pending_type_available_created_idx
  ON public.durable_jobs(job_type, available_at, created_at)
  WHERE status = 'pending';

CREATE FUNCTION public.opensales_guard_running_durable_job_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'running' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'a running durable job cannot be deleted';
    END IF;
    IF NEW.job_type IS DISTINCT FROM OLD.job_type
       OR NEW.unique_key IS DISTINCT FROM OLD.unique_key
       OR NEW.payload IS DISTINCT FROM OLD.payload THEN
      RAISE EXCEPTION 'a running durable job cannot change type, identity, or payload';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER b_schema_017_running_job_identity_guard
  BEFORE UPDATE OR DELETE ON public.durable_jobs
  FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_running_durable_job_identity();

CREATE TABLE public.manual_receipt_outflow_reports(
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  manual_receipt_id uuid NOT NULL REFERENCES public.manual_receipt_facts(id),
  fund_receipt_id uuid NOT NULL REFERENCES public.fund_receipts(id),
  client_account_id uuid NOT NULL REFERENCES public.client_accounts(id),
  source_context text NOT NULL CHECK (
    source_context IN ('unclaimed_funds', 'allocated_invoice', 'converted_credit')
  ),
  fund_receipt_resolution_id uuid REFERENCES public.fund_receipt_resolutions(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  destination text NOT NULL CHECK (destination = 'original_source'),
  destination_reference text NOT NULL CHECK (
    pg_catalog.length(destination_reference) BETWEEN 1 AND 200
  ),
  observed_outcome text NOT NULL CHECK (observed_outcome IN ('confirmed', 'unknown')),
  occurred_at timestamptz,
  actor_id uuid NOT NULL REFERENCES public.users(id),
  actor_session_id uuid NOT NULL REFERENCES public.sessions(id),
  reauth_grant_id uuid NOT NULL REFERENCES public.reauth_grants(id),
  reason text NOT NULL CHECK (pg_catalog.length(reason) BETWEEN 10 AND 1000),
  idempotency_key text NOT NULL UNIQUE CHECK (
    pg_catalog.length(idempotency_key) BETWEEN 8 AND 128
  ),
  request_fingerprint text NOT NULL CHECK (pg_catalog.length(request_fingerprint) > 0),
  result jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (manual_receipt_id, request_fingerprint),
  UNIQUE (manual_receipt_id, destination_reference),
  CHECK (
    (source_context = 'unclaimed_funds' AND fund_receipt_resolution_id IS NULL)
    OR
    (source_context IN ('allocated_invoice', 'converted_credit')
      AND fund_receipt_resolution_id IS NOT NULL)
  ),
  CHECK (
    (observed_outcome = 'confirmed' AND occurred_at IS NOT NULL)
    OR (observed_outcome = 'unknown' AND occurred_at IS NULL)
  )
);

CREATE TABLE public.manual_receipt_outflow_reconciliations(
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  report_id uuid NOT NULL UNIQUE REFERENCES public.manual_receipt_outflow_reports(id),
  outcome text NOT NULL CHECK (outcome IN ('confirm_outflow', 'confirm_no_outflow')),
  occurred_at timestamptz,
  actor_id uuid NOT NULL REFERENCES public.users(id),
  actor_session_id uuid NOT NULL REFERENCES public.sessions(id),
  reauth_grant_id uuid NOT NULL REFERENCES public.reauth_grants(id),
  reason text NOT NULL CHECK (pg_catalog.length(reason) BETWEEN 10 AND 1000),
  idempotency_key text NOT NULL UNIQUE CHECK (
    pg_catalog.length(idempotency_key) BETWEEN 8 AND 128
  ),
  request_fingerprint text NOT NULL CHECK (pg_catalog.length(request_fingerprint) > 0),
  result jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (
    (outcome = 'confirm_outflow' AND occurred_at IS NOT NULL)
    OR (outcome = 'confirm_no_outflow' AND occurred_at IS NULL)
  )
);

CREATE TABLE public.manual_receipt_credit_holds(
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  report_id uuid NOT NULL UNIQUE
    REFERENCES public.manual_receipt_outflow_reports(id),
  credit_account_id uuid NOT NULL REFERENCES public.credit_accounts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE public.manual_receipt_credit_outflow_effects(
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  outflow_id uuid NOT NULL UNIQUE REFERENCES public.manual_receipt_outflows(id)
    DEFERRABLE INITIALLY DEFERRED,
  credit_account_id uuid NOT NULL REFERENCES public.credit_accounts(id),
  client_account_id uuid NOT NULL REFERENCES public.client_accounts(id),
  credit_recovered_minor bigint NOT NULL CHECK (credit_recovered_minor >= 0),
  debt_minor bigint NOT NULL CHECK (debt_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (credit_recovered_minor + debt_minor > 0)
);

CREATE TABLE public.manual_receipt_credit_outflow_restrictions(
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  effect_id uuid NOT NULL UNIQUE
    REFERENCES public.manual_receipt_credit_outflow_effects(id),
  client_account_id uuid NOT NULL REFERENCES public.client_accounts(id),
  reason text NOT NULL CHECK (pg_catalog.length(reason) BETWEEN 10 AND 1000),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

-- The existing account guard protects unresolved Chargeback restrictions.
-- Extend the same projection boundary to the dedicated manual-outflow debt
-- restriction. The BEFORE INSERT source guard sets restricted_at before the
-- new restriction row becomes visible; subsequent direct changes are denied.
CREATE OR REPLACE FUNCTION public.opensales_guard_active_account_restriction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.restricted_at IS DISTINCT FROM OLD.restricted_at
     AND (
       EXISTS (
         SELECT 1
         FROM public.client_account_restrictions restriction
         LEFT JOIN public.client_account_restriction_releases release
           ON release.restriction_id = restriction.id
         WHERE restriction.client_account_id = OLD.id
           AND release.id IS NULL
       )
       OR EXISTS (
         SELECT 1
         FROM public.manual_receipt_credit_outflow_restrictions restriction
         WHERE restriction.client_account_id = OLD.id
       )
     ) THEN
    RAISE EXCEPTION 'an active financial restriction cannot be changed directly';
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE public.manual_receipt_outflows
  ADD COLUMN report_id uuid NOT NULL UNIQUE
    REFERENCES public.manual_receipt_outflow_reports(id),
  ADD COLUMN client_account_id uuid NOT NULL REFERENCES public.client_accounts(id),
  ADD COLUMN source_context text NOT NULL,
  ADD COLUMN fund_receipt_resolution_id uuid
    REFERENCES public.fund_receipt_resolutions(id),
  ADD COLUMN occurred_at timestamptz NOT NULL,
  ADD COLUMN actor_session_id uuid NOT NULL REFERENCES public.sessions(id),
  ADD COLUMN reauth_grant_id uuid NOT NULL REFERENCES public.reauth_grants(id),
  ADD CONSTRAINT manual_receipt_outflows_source_context_value_check CHECK (
    source_context IN ('unclaimed_funds', 'allocated_invoice', 'converted_credit')
  ),
  ADD CONSTRAINT manual_receipt_outflows_source_binding_check CHECK (
    (source_context = 'unclaimed_funds' AND fund_receipt_resolution_id IS NULL)
    OR
    (source_context IN ('allocated_invoice', 'converted_credit')
      AND fund_receipt_resolution_id IS NOT NULL)
  ),
  ADD CONSTRAINT manual_receipt_outflows_manual_fingerprint_key
    UNIQUE (manual_receipt_id, request_fingerprint),
  ADD CONSTRAINT manual_receipt_outflows_manual_destination_key
    UNIQUE (manual_receipt_id, destination_reference),
  ADD CONSTRAINT manual_receipt_outflows_destination_reference_check CHECK (
    pg_catalog.length(destination_reference) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT manual_receipt_outflows_reason_check CHECK (
    pg_catalog.length(reason) BETWEEN 10 AND 1000
  ),
  ADD CONSTRAINT manual_receipt_outflows_idempotency_key_length_check CHECK (
    pg_catalog.length(idempotency_key) BETWEEN 8 AND 128
  ),
  ADD CONSTRAINT manual_receipt_outflows_request_fingerprint_check CHECK (
    pg_catalog.length(request_fingerprint) > 0
  ),
  ADD CONSTRAINT manual_receipt_outflows_result_check CHECK (
    pg_catalog.jsonb_typeof(result) = 'object'
  );

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT credit_transactions_kind_check;
ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_kind_check CHECK (
    kind IN (
      'manual_adjustment',
      'invoice_application',
      'invoice_application_reversal',
      'add_funds',
      'unclaimed_funds',
      'refund',
      'chargeback',
      'manual_receipt_outflow'
    )
  );

ALTER TABLE public.client_account_debt_transactions
  DROP CONSTRAINT client_account_debt_transactions_kind_check;
ALTER TABLE public.client_account_debt_transactions
  ADD CONSTRAINT client_account_debt_transactions_kind_check CHECK (
    kind IN ('chargeback', 'manual_receipt_outflow')
  );

CREATE FUNCTION public.opensales_reject_manual_receipt_outflow_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'manual receipt outflow reports and reconciliations are append-only';
END
$$;

CREATE TRIGGER manual_receipt_outflow_reports_append_only
  BEFORE UPDATE OR DELETE ON public.manual_receipt_outflow_reports
  FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_manual_receipt_outflow_mutation();
CREATE TRIGGER manual_receipt_outflow_reconciliations_append_only
  BEFORE UPDATE OR DELETE ON public.manual_receipt_outflow_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_manual_receipt_outflow_mutation();
CREATE TRIGGER manual_receipt_credit_holds_append_only
  BEFORE UPDATE OR DELETE ON public.manual_receipt_credit_holds
  FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_manual_receipt_outflow_mutation();
CREATE TRIGGER manual_receipt_credit_outflow_effects_append_only
  BEFORE UPDATE OR DELETE ON public.manual_receipt_credit_outflow_effects
  FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_manual_receipt_outflow_mutation();
CREATE TRIGGER manual_receipt_credit_outflow_restrictions_append_only
  BEFORE UPDATE OR DELETE ON public.manual_receipt_credit_outflow_restrictions
  FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_manual_receipt_outflow_mutation();

CREATE FUNCTION public.opensales_schema_017_marker_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_data jsonb := pg_catalog.to_jsonb(NEW);
DECLARE
  old_row_data jsonb := CASE WHEN TG_OP = 'UPDATE'
    THEN pg_catalog.to_jsonb(OLD) ELSE '{}'::jsonb END;
DECLARE
  is_schema_017_marker boolean := false;
BEGIN
  is_schema_017_marker :=
    TG_TABLE_SCHEMA = 'public'
    AND (
      TG_TABLE_NAME IN (
        'manual_receipt_outflow_reports',
        'manual_receipt_outflow_reconciliations',
        'manual_receipt_credit_holds',
        'manual_receipt_credit_outflow_effects',
        'manual_receipt_credit_outflow_restrictions',
        'manual_receipt_outflows'
      )
      OR (TG_TABLE_NAME = 'ledger_journals'
        AND (row_data->>'source_type' = 'manual_receipt_outflow'
          OR old_row_data->>'source_type' = 'manual_receipt_outflow'))
      OR (TG_TABLE_NAME = 'credit_transactions'
        AND (row_data->>'kind' = 'manual_receipt_outflow'
          OR row_data->>'source_type' = 'manual_receipt_credit_outflow_effect'
          OR old_row_data->>'kind' = 'manual_receipt_outflow'
          OR old_row_data->>'source_type' = 'manual_receipt_credit_outflow_effect'))
      OR (TG_TABLE_NAME = 'client_account_debt_transactions'
        AND (row_data->>'source_type' = 'manual_receipt_credit_outflow_effect'
          OR old_row_data->>'source_type' = 'manual_receipt_credit_outflow_effect'))
      OR (TG_TABLE_NAME = 'client_account_restrictions'
        AND (row_data->>'source_type' = 'manual_receipt_credit_outflow_effect'
          OR old_row_data->>'source_type' = 'manual_receipt_credit_outflow_effect'))
      OR (TG_TABLE_NAME = 'provider_operations'
        AND (row_data->>'subject_type' IN (
            'manual_receipt_outflow_report', 'manual_receipt_outflow'
          ) OR old_row_data->>'subject_type' IN (
            'manual_receipt_outflow_report', 'manual_receipt_outflow'
          )))
      OR (TG_TABLE_NAME = 'durable_jobs'
        AND ((row_data->>'job_type') LIKE 'manual_receipt_outflow.%'
          OR row_data->'payload' ? 'manualReceiptOutflowReportId'
          OR row_data->'payload' ? 'manualReceiptOutflowId'
          OR (old_row_data->>'job_type') LIKE 'manual_receipt_outflow.%'
          OR old_row_data->'payload' ? 'manualReceiptOutflowReportId'
          OR old_row_data->'payload' ? 'manualReceiptOutflowId'))
      OR (TG_TABLE_NAME = 'provider_inbox'
        AND (row_data->'payload' ? 'manualReceiptOutflowReportId'
          OR row_data->'payload' ? 'manualReceiptOutflowId'
          OR old_row_data->'payload' ? 'manualReceiptOutflowReportId'
          OR old_row_data->'payload' ? 'manualReceiptOutflowId'))
      OR (TG_TABLE_NAME = 'outbox'
        AND ((row_data->>'event_type') LIKE 'manual_receipt_outflow.%'
          OR row_data->'payload' ? 'manualReceiptOutflowReportId'
          OR row_data->'payload' ? 'manualReceiptOutflowId'
          OR (old_row_data->>'event_type') LIKE 'manual_receipt_outflow.%'
          OR old_row_data->'payload' ? 'manualReceiptOutflowReportId'
          OR old_row_data->'payload' ? 'manualReceiptOutflowId'))
      OR (TG_TABLE_NAME = 'audit_events'
        AND (row_data->>'target_type' IN (
            'manual_receipt_outflow_report', 'manual_receipt_outflow'
          ) OR old_row_data->>'target_type' IN (
            'manual_receipt_outflow_report', 'manual_receipt_outflow'
          )))
    );
  IF is_schema_017_marker THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('opensales:schema-016-017-rollback-bridge', 0)
    );
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER a_schema_017_outflow_report_marker_guard
  BEFORE INSERT OR UPDATE ON public.manual_receipt_outflow_reports
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_outflow_reconciliation_marker_guard
  BEFORE INSERT OR UPDATE ON public.manual_receipt_outflow_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_outflow_fact_marker_guard
  BEFORE INSERT OR UPDATE ON public.manual_receipt_outflows
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_ledger_marker_guard
  BEFORE INSERT OR UPDATE ON public.ledger_journals
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_credit_marker_guard
  BEFORE INSERT OR UPDATE ON public.credit_transactions
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_debt_marker_guard
  BEFORE INSERT OR UPDATE ON public.client_account_debt_transactions
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_existing_restriction_marker_guard
  BEFORE INSERT OR UPDATE ON public.client_account_restrictions
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_provider_operation_marker_guard
  BEFORE INSERT OR UPDATE ON public.provider_operations
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_job_marker_guard
  BEFORE INSERT OR UPDATE ON public.durable_jobs
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_inbox_marker_guard
  BEFORE INSERT OR UPDATE ON public.provider_inbox
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_outbox_marker_guard
  BEFORE INSERT OR UPDATE ON public.outbox
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_audit_marker_guard
  BEFORE INSERT OR UPDATE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_credit_hold_marker_guard
  BEFORE INSERT OR UPDATE ON public.manual_receipt_credit_holds
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_credit_outflow_effect_marker_guard
  BEFORE INSERT OR UPDATE ON public.manual_receipt_credit_outflow_effects
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();
CREATE TRIGGER a_schema_017_credit_outflow_restriction_marker_guard
  BEFORE INSERT OR UPDATE ON public.manual_receipt_credit_outflow_restrictions
  FOR EACH ROW EXECUTE FUNCTION public.opensales_schema_017_marker_guard();

CREATE FUNCTION public.opensales_guard_reauth_grant_time()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_at > pg_catalog.clock_timestamp()
     OR NEW.expires_at <= NEW.created_at
     OR NEW.expires_at > NEW.created_at + interval '15 minutes'
     OR (TG_OP = 'UPDATE' AND (
       NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     )) THEN
    RAISE EXCEPTION 'reauthentication grants must be immutable, current, and valid for at most 15 minutes';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER schema_017_reauth_grant_time_guard
  BEFORE INSERT OR UPDATE ON public.reauth_grants
  FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_reauth_grant_time();

CREATE FUNCTION public.opensales_validate_manual_receipt_outflow_authorization(
  staff_user_id uuid,
  staff_session_id uuid,
  staff_reauth_grant_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  authorized boolean;
BEGIN
  SELECT true
  INTO authorized
  FROM public.users user_record
    JOIN public.sessions session_record
      ON session_record.id = staff_session_id
     AND session_record.user_id = user_record.id
     AND session_record.revoked_at IS NULL
     AND session_record.expires_at > pg_catalog.now()
    JOIN public.reauth_grants reauth
      ON reauth.id = staff_reauth_grant_id
     AND reauth.user_id = user_record.id
     AND reauth.session_id = session_record.id
     AND reauth.invalidated_at IS NULL
     AND reauth.expires_at > pg_catalog.now()
     AND reauth.created_at <= pg_catalog.now()
     AND reauth.created_at > pg_catalog.now() - interval '15 minutes'
     AND reauth.expires_at <= reauth.created_at + interval '15 minutes'
    JOIN public.staff_members staff
      ON staff.user_id = user_record.id
     AND staff.active
    WHERE user_record.id = staff_user_id
      AND user_record.email_verified_at IS NOT NULL
      AND user_record.restricted_at IS NULL
      AND (staff.permissions ? '*' OR (
        staff.permissions ? 'billing.manual_receipt_manage'
        AND staff.permissions ? 'billing.refund_manage'
      ))
  FOR UPDATE OF user_record, session_record, reauth, staff;
  RETURN COALESCE(authorized, false);
END
$$;

CREATE VIEW public.manual_receipt_outflow_capacity AS
WITH source_buckets AS (
  SELECT
    fact.id AS manual_receipt_id,
    receipt.id AS fund_receipt_id,
    fact.client_account_id,
    'unclaimed_funds'::text AS source_context,
    NULL::uuid AS fund_receipt_resolution_id,
    receipt.currency,
    GREATEST(0, receipt.amount_minor - receipt.allocated_minor)::bigint
      AS source_amount_minor
  FROM public.manual_receipt_facts fact
  JOIN public.fund_receipts receipt ON receipt.reported_manual_receipt_id = fact.id
  UNION ALL
  SELECT
    fact.id,
    receipt.id,
    fact.client_account_id,
    CASE resolution.action
      WHEN 'allocate_invoice' THEN 'allocated_invoice'::text
      ELSE 'converted_credit'::text
    END,
    resolution.id,
    receipt.currency,
    resolution.amount_minor
  FROM public.manual_receipt_facts fact
  JOIN public.fund_receipts receipt ON receipt.reported_manual_receipt_id = fact.id
  JOIN public.fund_receipt_resolutions resolution ON resolution.fund_receipt_id = receipt.id
), confirmed AS (
  SELECT
    outflow.manual_receipt_id,
    outflow.fund_receipt_id,
    outflow.source_context,
    outflow.fund_receipt_resolution_id,
    pg_catalog.sum(outflow.amount_minor)::bigint AS amount_minor
  FROM public.manual_receipt_outflows outflow
  GROUP BY
    outflow.manual_receipt_id,
    outflow.fund_receipt_id,
    outflow.source_context,
    outflow.fund_receipt_resolution_id
), blocked AS (
  SELECT
    report.manual_receipt_id,
    report.fund_receipt_id,
    true AS present
  FROM public.manual_receipt_outflow_reports report
  WHERE report.observed_outcome = 'unknown'
    AND NOT EXISTS (
      SELECT 1
      FROM public.manual_receipt_outflow_reconciliations reconciliation
      WHERE reconciliation.report_id = report.id
    )
  GROUP BY report.manual_receipt_id, report.fund_receipt_id
)
SELECT
  source.manual_receipt_id,
  source.fund_receipt_id,
  source.client_account_id,
  source.source_context,
  source.fund_receipt_resolution_id,
  source.currency,
  source.source_amount_minor,
  COALESCE(confirmed.amount_minor, 0)::bigint AS confirmed_outflow_minor,
  (
    COALESCE(blocked.present, false)
    OR EXISTS (
      SELECT 1
      FROM public.manual_receipt_reversals reversal
      WHERE reversal.manual_receipt_id = source.manual_receipt_id
        AND reversal.fund_receipt_id = source.fund_receipt_id
    )
  ) AS capacity_frozen,
  CASE
    WHEN COALESCE(blocked.present, false)
      OR EXISTS (
        SELECT 1
        FROM public.manual_receipt_reversals reversal
        WHERE reversal.manual_receipt_id = source.manual_receipt_id
          AND reversal.fund_receipt_id = source.fund_receipt_id
      )
      THEN 0
    ELSE GREATEST(
      0,
      source.source_amount_minor - COALESCE(confirmed.amount_minor, 0)
    )
  END::bigint AS available_minor
FROM source_buckets source
LEFT JOIN confirmed
  ON confirmed.manual_receipt_id = source.manual_receipt_id
 AND confirmed.fund_receipt_id = source.fund_receipt_id
 AND confirmed.source_context = source.source_context
 AND confirmed.fund_receipt_resolution_id IS NOT DISTINCT FROM
     source.fund_receipt_resolution_id
LEFT JOIN blocked
  ON blocked.manual_receipt_id = source.manual_receipt_id
 AND blocked.fund_receipt_id = source.fund_receipt_id;

CREATE FUNCTION public.opensales_validate_manual_receipt_outflow_report()
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

CREATE TRIGGER manual_receipt_outflow_report_guard
  BEFORE INSERT ON public.manual_receipt_outflow_reports
  FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_manual_receipt_outflow_report();

CREATE FUNCTION public.opensales_validate_manual_receipt_credit_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row record;
BEGIN
  SELECT
    report.observed_outcome,
    report.source_context,
    report.amount_minor,
    report.currency,
    report.client_account_id,
    account.id AS credit_account_id,
    account.client_account_id AS credit_client_account_id,
    account.currency AS credit_currency
  INTO source_row
  FROM public.manual_receipt_outflow_reports report
  JOIN public.credit_transactions source_credit
    ON source_credit.kind = 'unclaimed_funds'
   AND source_credit.source_type = 'fund_receipt_resolution'
   AND source_credit.source_id = report.fund_receipt_resolution_id
  JOIN public.credit_accounts account
    ON account.id = source_credit.credit_account_id
  WHERE report.id = NEW.report_id
  FOR UPDATE OF report, account;

  IF source_row IS NULL
     OR source_row.observed_outcome <> 'unknown'
     OR source_row.source_context <> 'converted_credit'
     OR NEW.credit_account_id <> source_row.credit_account_id
     OR source_row.client_account_id <> source_row.credit_client_account_id
     OR NEW.amount_minor <> source_row.amount_minor
     OR NEW.currency <> source_row.currency
     OR NEW.currency <> source_row.credit_currency THEN
    RAISE EXCEPTION 'manual receipt Credit hold mismatches its unresolved converted Credit report';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER manual_receipt_credit_hold_guard
  BEFORE INSERT ON public.manual_receipt_credit_holds
  FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_manual_receipt_credit_hold();

CREATE OR REPLACE FUNCTION public.opensales_guard_credit_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  available_minor bigint;
DECLARE
  reserved_minor bigint;
DECLARE
  account_currency text;
DECLARE
  cap_minor bigint;
BEGIN
  SELECT currency
  INTO account_currency
  FROM public.credit_accounts
  WHERE id = NEW.credit_account_id
  FOR UPDATE;

  SELECT COALESCE(pg_catalog.sum(credit_minor - debit_minor), 0)
  INTO available_minor
  FROM public.credit_transactions
  WHERE credit_account_id = NEW.credit_account_id;

  SELECT COALESCE(pg_catalog.sum(hold.amount_minor), 0)
  INTO reserved_minor
  FROM public.manual_receipt_credit_holds hold
  JOIN public.manual_receipt_outflow_reports report ON report.id = hold.report_id
  WHERE hold.credit_account_id = NEW.credit_account_id
    AND report.observed_outcome = 'unknown'
    AND NOT EXISTS (
      SELECT 1
      FROM public.manual_receipt_outflow_reconciliations reconciliation
      WHERE reconciliation.report_id = report.id
    );

  IF available_minor + NEW.credit_minor - NEW.debit_minor - reserved_minor < 0 THEN
    RAISE EXCEPTION 'credit balance net of unresolved manual outflow holds cannot become negative';
  END IF;

  IF NEW.kind IN ('add_funds', 'unclaimed_funds') THEN
    SELECT balance_cap_minor
    INTO cap_minor
    FROM public.add_funds_policies
    WHERE currency = account_currency;
    IF cap_minor IS NULL
       OR available_minor + NEW.credit_minor - NEW.debit_minor > cap_minor THEN
      RAISE EXCEPTION 'Credit would exceed the configured balance cap';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION public.opensales_assert_manual_receipt_outflow_report_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.observed_outcome = 'confirmed' AND NOT EXISTS (
    SELECT 1
    FROM public.manual_receipt_outflows outflow
    WHERE outflow.report_id = NEW.id
      AND outflow.manual_receipt_id = NEW.manual_receipt_id
      AND outflow.fund_receipt_id = NEW.fund_receipt_id
      AND outflow.client_account_id = NEW.client_account_id
      AND outflow.source_context = NEW.source_context
      AND outflow.fund_receipt_resolution_id IS NOT DISTINCT FROM
          NEW.fund_receipt_resolution_id
      AND outflow.amount_minor = NEW.amount_minor
      AND outflow.currency = NEW.currency
      AND outflow.destination_reference = NEW.destination_reference
      AND outflow.occurred_at = NEW.occurred_at
  ) THEN
    RAISE EXCEPTION 'confirmed manual receipt outflow report is missing its immutable fact';
  END IF;
  IF NEW.observed_outcome = 'unknown' AND EXISTS (
    SELECT 1 FROM public.manual_receipt_outflows outflow WHERE outflow.report_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'unknown manual receipt outflow report cannot be an actual outflow fact';
  END IF;
  IF (NEW.observed_outcome = 'unknown' AND NEW.source_context = 'converted_credit')
     <> EXISTS (
       SELECT 1
       FROM public.manual_receipt_credit_holds hold
       WHERE hold.report_id = NEW.id
         AND hold.amount_minor = NEW.amount_minor
         AND hold.currency = NEW.currency
     ) THEN
    RAISE EXCEPTION 'unknown converted Credit report must have exactly one immutable Credit hold';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER manual_receipt_outflow_report_completeness_guard
  AFTER INSERT ON public.manual_receipt_outflow_reports
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.opensales_assert_manual_receipt_outflow_report_complete();

CREATE FUNCTION public.opensales_validate_manual_receipt_outflow_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  report_row record;
DECLARE
  credit_row record;
BEGIN
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

CREATE TRIGGER manual_receipt_outflow_reconciliation_guard
  BEFORE INSERT ON public.manual_receipt_outflow_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_manual_receipt_outflow_reconciliation();

CREATE FUNCTION public.opensales_assert_manual_receipt_outflow_reconciliation_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.outcome = 'confirm_outflow' AND NOT EXISTS (
    SELECT 1
    FROM public.manual_receipt_outflows outflow
    WHERE outflow.report_id = NEW.report_id
      AND outflow.occurred_at = NEW.occurred_at
  ) THEN
    RAISE EXCEPTION 'confirmed manual receipt outflow reconciliation is missing its fact';
  END IF;
  IF NEW.outcome = 'confirm_no_outflow' AND EXISTS (
    SELECT 1 FROM public.manual_receipt_outflows outflow WHERE outflow.report_id = NEW.report_id
  ) THEN
    RAISE EXCEPTION 'no-outflow reconciliation cannot have an actual outflow fact';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER manual_receipt_outflow_reconciliation_completeness_guard
  AFTER INSERT ON public.manual_receipt_outflow_reconciliations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.opensales_assert_manual_receipt_outflow_reconciliation_complete();

CREATE FUNCTION public.opensales_validate_manual_receipt_outflow_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  report_row record;
DECLARE
  reconciliation_row record;
DECLARE
  source_row record;
BEGIN
  SELECT report.*, receipt.id AS locked_receipt_id
  INTO report_row
  FROM public.manual_receipt_outflow_reports report
  JOIN public.fund_receipts receipt
    ON receipt.id = report.fund_receipt_id
   AND receipt.reported_manual_receipt_id = report.manual_receipt_id
  WHERE report.id = NEW.report_id
  FOR UPDATE OF report, receipt;

  SELECT reconciliation.*
  INTO reconciliation_row
  FROM public.manual_receipt_outflow_reconciliations reconciliation
  WHERE reconciliation.report_id = NEW.report_id;

  SELECT source_amount_minor, confirmed_outflow_minor, capacity_frozen
  INTO source_row
  FROM public.manual_receipt_outflow_capacity
  WHERE manual_receipt_id = NEW.manual_receipt_id
    AND fund_receipt_id = NEW.fund_receipt_id
    AND source_context = NEW.source_context
    AND fund_receipt_resolution_id IS NOT DISTINCT FROM NEW.fund_receipt_resolution_id;

  IF report_row IS NULL
     OR source_row IS NULL
     OR NEW.manual_receipt_id <> report_row.manual_receipt_id
     OR NEW.fund_receipt_id <> report_row.fund_receipt_id
     OR NEW.client_account_id <> report_row.client_account_id
     OR NEW.source_context <> report_row.source_context
     OR NEW.fund_receipt_resolution_id IS DISTINCT FROM
        report_row.fund_receipt_resolution_id
     OR NEW.amount_minor <> report_row.amount_minor
     OR NEW.currency <> report_row.currency
     OR NEW.destination_reference <> report_row.destination_reference
     OR (
       report_row.observed_outcome = 'confirmed'
       AND (
         reconciliation_row IS NOT NULL
         OR NEW.occurred_at <> report_row.occurred_at
         OR NEW.actor_id <> report_row.actor_id
         OR NEW.actor_session_id <> report_row.actor_session_id
         OR NEW.reauth_grant_id <> report_row.reauth_grant_id
         OR NEW.reason <> report_row.reason
         OR NEW.idempotency_key <> report_row.idempotency_key
         OR NEW.request_fingerprint <> report_row.request_fingerprint
         OR NEW.result <> report_row.result
       )
     )
     OR (
       report_row.observed_outcome = 'unknown'
       AND (
         reconciliation_row IS NULL
         OR reconciliation_row.outcome <> 'confirm_outflow'
         OR NEW.occurred_at <> reconciliation_row.occurred_at
         OR NEW.actor_id <> reconciliation_row.actor_id
         OR NEW.actor_session_id <> reconciliation_row.actor_session_id
         OR NEW.reauth_grant_id <> reconciliation_row.reauth_grant_id
         OR NEW.reason <> reconciliation_row.reason
         OR NEW.idempotency_key <> reconciliation_row.idempotency_key
         OR NEW.request_fingerprint <> reconciliation_row.request_fingerprint
         OR NEW.result <> reconciliation_row.result
       )
     )
     OR source_row.confirmed_outflow_minor + NEW.amount_minor > source_row.source_amount_minor
     OR EXISTS (
       SELECT 1 FROM public.manual_receipt_reversals reversal
       WHERE reversal.manual_receipt_id = NEW.manual_receipt_id
         AND reversal.fund_receipt_id = NEW.fund_receipt_id
     ) THEN
    RAISE EXCEPTION 'manual receipt outflow fact exceeds or mismatches its confirmed report and immutable source';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER manual_receipt_outflow_fact_guard
  BEFORE INSERT ON public.manual_receipt_outflows
  FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_manual_receipt_outflow_fact();

CREATE FUNCTION public.opensales_validate_manual_receipt_credit_outflow_effect()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row record;
DECLARE
  available_credit_minor bigint;
DECLARE
  reserved_credit_minor bigint;
DECLARE
  recoverable_credit_minor bigint;
BEGIN
  SELECT
    outflow.id AS outflow_id,
    outflow.source_context,
    outflow.amount_minor,
    outflow.currency,
    outflow.client_account_id,
    resolution.action,
    resolution.currency AS resolution_currency,
    source_credit.credit_account_id,
    account.client_account_id AS credit_client_account_id,
    account.currency AS credit_currency
  INTO source_row
  FROM public.manual_receipt_outflows outflow
  JOIN public.fund_receipt_resolutions resolution
    ON resolution.id = outflow.fund_receipt_resolution_id
  JOIN public.credit_transactions source_credit
    ON source_credit.kind = 'unclaimed_funds'
   AND source_credit.source_type = 'fund_receipt_resolution'
   AND source_credit.source_id = resolution.id
  JOIN public.credit_accounts account
    ON account.id = source_credit.credit_account_id
  WHERE outflow.id = NEW.outflow_id
  FOR UPDATE OF outflow, account;

  SELECT COALESCE(pg_catalog.sum(credit_minor - debit_minor), 0)::bigint
  INTO available_credit_minor
  FROM public.credit_transactions
  WHERE credit_account_id = NEW.credit_account_id;

  SELECT COALESCE(pg_catalog.sum(hold.amount_minor), 0)::bigint
  INTO reserved_credit_minor
  FROM public.manual_receipt_credit_holds hold
  JOIN public.manual_receipt_outflow_reports report ON report.id = hold.report_id
  WHERE hold.credit_account_id = NEW.credit_account_id
    AND report.observed_outcome = 'unknown'
    AND NOT EXISTS (
      SELECT 1
      FROM public.manual_receipt_outflow_reconciliations reconciliation
      WHERE reconciliation.report_id = report.id
    );

  IF source_row IS NULL
     OR source_row.source_context <> 'converted_credit'
     OR source_row.action <> 'convert_to_credit'
     OR NEW.credit_account_id <> source_row.credit_account_id
     OR NEW.client_account_id <> source_row.client_account_id
     OR NEW.client_account_id <> source_row.credit_client_account_id
     OR NEW.currency <> source_row.currency
     OR NEW.currency <> source_row.resolution_currency
     OR NEW.currency <> source_row.credit_currency THEN
    RAISE EXCEPTION 'manual receipt converted Credit effect mismatches its immutable outflow and available Credit';
  END IF;

  recoverable_credit_minor := LEAST(
    GREATEST(available_credit_minor - reserved_credit_minor, 0),
    source_row.amount_minor
  );
  IF NEW.credit_recovered_minor <> recoverable_credit_minor
     OR NEW.debt_minor <> source_row.amount_minor - recoverable_credit_minor
     OR NEW.credit_recovered_minor + NEW.debt_minor <> source_row.amount_minor THEN
    RAISE EXCEPTION 'manual receipt converted Credit effect mismatches its immutable outflow and available Credit';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER manual_receipt_credit_outflow_effect_guard
  BEFORE INSERT ON public.manual_receipt_credit_outflow_effects
  FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_manual_receipt_credit_outflow_effect();

CREATE FUNCTION public.opensales_validate_manual_receipt_outflow_credit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect_row record;
BEGIN
  IF NEW.kind <> 'manual_receipt_outflow'
     AND NEW.source_type <> 'manual_receipt_credit_outflow_effect' THEN
    RETURN NEW;
  END IF;

  SELECT effect.credit_account_id, effect.credit_recovered_minor
  INTO effect_row
  FROM public.manual_receipt_credit_outflow_effects effect
  WHERE effect.id = NEW.source_id;

  IF NEW.kind <> 'manual_receipt_outflow'
     OR NEW.source_type <> 'manual_receipt_credit_outflow_effect'
     OR effect_row.credit_account_id IS NULL
     OR NEW.credit_account_id <> effect_row.credit_account_id
     OR NEW.credit_minor <> 0
     OR NEW.debit_minor <> effect_row.credit_recovered_minor
     OR NEW.debit_minor <= 0 THEN
    RAISE EXCEPTION 'manual receipt outflow Credit debit mismatches its immutable effect';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER manual_receipt_outflow_credit_source_guard
  BEFORE INSERT ON public.credit_transactions
  FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_manual_receipt_outflow_credit();

CREATE FUNCTION public.opensales_validate_manual_receipt_outflow_debt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row record;
BEGIN
  IF NEW.kind <> 'manual_receipt_outflow'
     AND NEW.source_type <> 'manual_receipt_credit_outflow_effect' THEN
    RETURN NEW;
  END IF;

  SELECT effect.client_account_id, effect.currency, effect.debt_minor,
         account.client_account_id AS debt_client_account_id,
         account.currency AS debt_currency
  INTO source_row
  FROM public.manual_receipt_credit_outflow_effects effect
  JOIN public.client_account_debt_accounts account
    ON account.id = NEW.debt_account_id
  WHERE effect.id = NEW.source_id;

  IF NEW.kind <> 'manual_receipt_outflow'
     OR NEW.source_type <> 'manual_receipt_credit_outflow_effect'
     OR source_row.client_account_id IS NULL
     OR source_row.client_account_id <> source_row.debt_client_account_id
     OR source_row.currency <> source_row.debt_currency
     OR NEW.credit_minor <> 0
     OR NEW.debit_minor <> source_row.debt_minor
     OR NEW.debit_minor <= 0 THEN
    RAISE EXCEPTION 'manual receipt outflow debt does not match its immutable effect';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER manual_receipt_outflow_debt_source_guard
  BEFORE INSERT ON public.client_account_debt_transactions
  FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_manual_receipt_outflow_debt();

CREATE FUNCTION public.opensales_apply_manual_receipt_outflow_restriction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect_row record;
BEGIN
  SELECT client_account_id, debt_minor
  INTO effect_row
  FROM public.manual_receipt_credit_outflow_effects
  WHERE id = NEW.effect_id;

  IF effect_row.client_account_id IS NULL
     OR effect_row.debt_minor <= 0
     OR NEW.client_account_id <> effect_row.client_account_id THEN
    RAISE EXCEPTION 'Client Account restriction does not match manual receipt outflow debt';
  END IF;

  UPDATE public.client_accounts
  SET restricted_at = COALESCE(restricted_at, NEW.created_at)
  WHERE id = NEW.client_account_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER manual_receipt_outflow_restriction_source_guard
  BEFORE INSERT ON public.manual_receipt_credit_outflow_restrictions
  FOR EACH ROW EXECUTE FUNCTION public.opensales_apply_manual_receipt_outflow_restriction();

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

CREATE FUNCTION public.opensales_assert_manual_receipt_credit_outflow_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  effect_row record;
DECLARE
  ledger_valid boolean;
DECLARE
  credit_count integer;
DECLARE
  debt_count integer;
DECLARE
  restriction_count integer;
BEGIN
  IF NEW.source_context <> 'converted_credit' THEN
    RETURN NULL;
  END IF;

  SELECT effect.id, effect.credit_account_id,
         effect.credit_recovered_minor, effect.debt_minor
  INTO effect_row
  FROM public.manual_receipt_credit_outflow_effects effect
  WHERE effect.outflow_id = NEW.id
    AND effect.client_account_id = NEW.client_account_id
    AND effect.currency = NEW.currency;

  SELECT
    journal.sealed_at IS NOT NULL
    AND pg_catalog.count(*) = 1
      + (CASE WHEN effect_row.credit_recovered_minor > 0 THEN 1 ELSE 0 END)
      + (CASE WHEN effect_row.debt_minor > 0 THEN 1 ELSE 0 END)
    AND COALESCE(pg_catalog.sum(line.debit_minor), 0) = NEW.amount_minor
    AND COALESCE(pg_catalog.sum(line.credit_minor), 0) = NEW.amount_minor
    AND COALESCE(pg_catalog.sum(line.debit_minor) FILTER (
      WHERE line.account_code = 'client_credit_liability'
        AND line.credit_minor = 0), 0) = effect_row.credit_recovered_minor
    AND COALESCE(pg_catalog.sum(line.debit_minor) FILTER (
      WHERE line.account_code = 'chargeback_receivable'
        AND line.credit_minor = 0), 0) = effect_row.debt_minor
    AND COALESCE(pg_catalog.sum(line.credit_minor) FILTER (
      WHERE line.account_code = 'cash_clearing'
        AND line.debit_minor = 0), 0) = NEW.amount_minor
  INTO ledger_valid
  FROM public.ledger_journals journal
  JOIN public.ledger_lines line ON line.journal_id = journal.id
  WHERE journal.source_type = 'manual_receipt_outflow'
    AND journal.source_id = NEW.id
    AND journal.currency = NEW.currency
  GROUP BY journal.id, journal.sealed_at;

  SELECT pg_catalog.count(*)
  INTO credit_count
  FROM public.credit_transactions transaction_record
  WHERE transaction_record.kind = 'manual_receipt_outflow'
    AND transaction_record.source_type = 'manual_receipt_credit_outflow_effect'
    AND transaction_record.source_id = effect_row.id
    AND transaction_record.credit_account_id = effect_row.credit_account_id
    AND transaction_record.credit_minor = 0
    AND transaction_record.debit_minor = effect_row.credit_recovered_minor;

  SELECT pg_catalog.count(*)
  INTO debt_count
  FROM public.client_account_debt_transactions transaction_record
  JOIN public.client_account_debt_accounts account
    ON account.id = transaction_record.debt_account_id
  WHERE transaction_record.kind = 'manual_receipt_outflow'
    AND transaction_record.source_type = 'manual_receipt_credit_outflow_effect'
    AND transaction_record.source_id = effect_row.id
    AND transaction_record.credit_minor = 0
    AND transaction_record.debit_minor = effect_row.debt_minor
    AND account.client_account_id = NEW.client_account_id
    AND account.currency = NEW.currency;

  SELECT pg_catalog.count(*)
  INTO restriction_count
  FROM public.manual_receipt_credit_outflow_restrictions restriction
  WHERE restriction.effect_id = effect_row.id
    AND restriction.client_account_id = NEW.client_account_id;

  IF effect_row.id IS NULL
     OR effect_row.credit_recovered_minor + effect_row.debt_minor <> NEW.amount_minor
     OR ledger_valid IS NOT TRUE
     OR credit_count <> (CASE WHEN effect_row.credit_recovered_minor > 0 THEN 1 ELSE 0 END)
     OR debt_count <> (CASE WHEN effect_row.debt_minor > 0 THEN 1 ELSE 0 END)
     OR restriction_count <> (CASE WHEN effect_row.debt_minor > 0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'converted Credit manual receipt outflow is missing its exact ledger, Credit recovery, debt, or restriction';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER manual_receipt_credit_outflow_completeness_guard
  AFTER INSERT ON public.manual_receipt_outflows
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.opensales_assert_manual_receipt_credit_outflow_complete();

CREATE FUNCTION public.opensales_assert_manual_receipt_outflow_marker_bound()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_data jsonb := pg_catalog.to_jsonb(NEW);
BEGIN
  IF TG_TABLE_NAME = 'ledger_journals'
     AND row_data->>'source_type' = 'manual_receipt_outflow'
     AND NOT EXISTS (
       SELECT 1 FROM public.manual_receipt_outflows outflow
       WHERE outflow.id::text = row_data->>'source_id'
     ) THEN
    RAISE EXCEPTION 'manual receipt outflow journal has no immutable outflow fact';
  END IF;

  IF TG_TABLE_NAME = 'credit_transactions'
     AND (row_data->>'kind' = 'manual_receipt_outflow'
       OR row_data->>'source_type' = 'manual_receipt_credit_outflow_effect')
     AND NOT EXISTS (
       SELECT 1 FROM public.manual_receipt_credit_outflow_effects effect
       WHERE effect.id::text = row_data->>'source_id'
         AND row_data->>'kind' = 'manual_receipt_outflow'
         AND row_data->>'source_type' = 'manual_receipt_credit_outflow_effect'
         AND effect.credit_account_id::text = row_data->>'credit_account_id'
         AND (row_data->>'credit_minor')::bigint = 0
         AND (row_data->>'debit_minor')::bigint = effect.credit_recovered_minor
     ) THEN
    RAISE EXCEPTION 'manual receipt outflow Credit marker has no immutable effect';
  END IF;

  IF TG_TABLE_NAME = 'client_account_debt_transactions'
     AND (row_data->>'kind' = 'manual_receipt_outflow'
       OR row_data->>'source_type' = 'manual_receipt_credit_outflow_effect')
     AND NOT EXISTS (
       SELECT 1
       FROM public.manual_receipt_credit_outflow_effects effect
       JOIN public.client_account_debt_accounts account
         ON account.id::text = row_data->>'debt_account_id'
       WHERE effect.id::text = row_data->>'source_id'
         AND row_data->>'kind' = 'manual_receipt_outflow'
         AND row_data->>'source_type' = 'manual_receipt_credit_outflow_effect'
         AND account.client_account_id = effect.client_account_id
         AND account.currency = effect.currency
         AND (row_data->>'credit_minor')::bigint = 0
         AND (row_data->>'debit_minor')::bigint = effect.debt_minor
     ) THEN
    RAISE EXCEPTION 'manual receipt outflow debt marker has no immutable effect';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER manual_receipt_outflow_journal_binding_guard
  AFTER INSERT OR UPDATE ON public.ledger_journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.opensales_assert_manual_receipt_outflow_marker_bound();
CREATE CONSTRAINT TRIGGER manual_receipt_outflow_credit_binding_guard
  AFTER INSERT ON public.credit_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.opensales_assert_manual_receipt_outflow_marker_bound();
CREATE CONSTRAINT TRIGGER manual_receipt_outflow_debt_binding_guard
  AFTER INSERT ON public.client_account_debt_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.opensales_assert_manual_receipt_outflow_marker_bound();

CREATE FUNCTION public.opensales_reject_manual_receipt_provider_artifact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.subject_type IN ('manual_receipt_outflow_report', 'manual_receipt_outflow')
     OR (TG_OP = 'UPDATE' AND OLD.subject_type IN (
       'manual_receipt_outflow_report', 'manual_receipt_outflow'
     )) THEN
    RAISE EXCEPTION 'manual receipt outflows cannot use a Payment Provider operation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER z_schema_017_manual_outflow_provider_rejection
  BEFORE INSERT OR UPDATE ON public.provider_operations
  FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_manual_receipt_provider_artifact();

DROP VIEW public.unclaimed_fund_refund_capacity;
CREATE VIEW public.unclaimed_fund_refund_capacity AS
SELECT
  receipt.id AS fund_receipt_id,
  receipt.amount_minor,
  receipt.allocated_minor,
  COALESCE(reserved.amount_minor, 0)::bigint AS reserved_refund_minor,
  COALESCE(confirmed.amount_minor, 0)::bigint AS confirmed_outflow_minor,
  blocked.present AS capacity_frozen,
  CASE WHEN blocked.present THEN 0
       ELSE GREATEST(
         0,
         receipt.amount_minor - receipt.allocated_minor
           - COALESCE(reserved.amount_minor, 0)
           - COALESCE(confirmed.amount_minor, 0)
       )
  END::bigint AS available_minor
FROM public.fund_receipts receipt
LEFT JOIN LATERAL (
  SELECT COALESCE(pg_catalog.sum(refund.amount_minor), 0)::bigint AS amount_minor
  FROM public.refunds refund
  WHERE refund.source_fund_receipt_id = receipt.id
    AND refund.source_context = 'unclaimed_funds'
    AND refund.status IN ('queued', 'processing')
) reserved ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(pg_catalog.sum(outflow.amount_minor), 0)::bigint AS amount_minor
  FROM (
    SELECT settlement.amount_minor
    FROM public.refunds refund
    JOIN public.refund_settlements settlement ON settlement.refund_id = refund.id
    WHERE refund.source_fund_receipt_id = receipt.id
      AND refund.source_context = 'unclaimed_funds'
    UNION ALL
    SELECT discrepancy.amount_minor
    FROM public.refunds refund
    JOIN public.refund_discrepancy_settlements discrepancy ON discrepancy.refund_id = refund.id
    JOIN public.refund_security_hold_adjudications adjudication
      ON adjudication.discrepancy_settlement_id = discrepancy.id
     AND adjudication.decision = 'record_unexpected_outflow'
    WHERE refund.source_fund_receipt_id = receipt.id
      AND refund.source_context = 'unclaimed_funds'
      AND discrepancy.currency = receipt.currency
    UNION ALL
    SELECT discrepancy.amount_minor
    FROM public.refunds refund
    JOIN public.refund_discrepancy_settlements discrepancy ON discrepancy.refund_id = refund.id
    JOIN public.refund_adjudication_corrections correction
      ON correction.discrepancy_settlement_id = discrepancy.id
    WHERE refund.source_fund_receipt_id = receipt.id
      AND refund.source_context = 'unclaimed_funds'
      AND discrepancy.currency = receipt.currency
    UNION ALL
    SELECT manual.amount_minor
    FROM public.manual_receipt_outflows manual
    WHERE manual.fund_receipt_id = receipt.id
      AND manual.source_context = 'unclaimed_funds'
  ) outflow
) confirmed ON true
LEFT JOIN LATERAL (
  SELECT
    receipt.disposition = 'charged_back'
    OR EXISTS (
      SELECT 1 FROM public.manual_receipt_reversals reversal
      WHERE reversal.fund_receipt_id = receipt.id
    )
    OR EXISTS (
      SELECT 1
      FROM public.manual_receipt_outflow_reports report
      WHERE report.fund_receipt_id = receipt.id
        AND report.observed_outcome = 'unknown'
        AND NOT EXISTS (
          SELECT 1
          FROM public.manual_receipt_outflow_reconciliations reconciliation
          WHERE reconciliation.report_id = report.id
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.refunds refund
      WHERE refund.source_fund_receipt_id = receipt.id
        AND refund.source_context = 'unclaimed_funds'
        AND refund.status IN ('unknown', 'manual')
    )
    OR EXISTS (
      SELECT 1 FROM public.refund_receipt_security_holds security_hold
      WHERE security_hold.source_fund_receipt_id = receipt.id
        AND NOT EXISTS (
          SELECT 1 FROM public.refund_security_hold_adjudications adjudication
          WHERE adjudication.receipt_security_hold_id = security_hold.id
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.add_funds_chargeback_holds chargeback_hold
      JOIN public.add_funds_chargeback_facts chargeback_fact
        ON chargeback_fact.id = chargeback_hold.fact_id
      WHERE chargeback_fact.add_funds_attempt_id = receipt.reported_add_funds_attempt_id
        AND chargeback_fact.original_external_payment_id = receipt.external_payment_id
    ) AS present
) blocked ON true;

CREATE FUNCTION public.opensales_guard_manual_outflow_resolution_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  manual_receipt_id uuid;
DECLARE
  capacity_row record;
BEGIN
  SELECT reported_manual_receipt_id
  INTO manual_receipt_id
  FROM public.fund_receipts
  WHERE id = NEW.fund_receipt_id
  FOR UPDATE;

  IF manual_receipt_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT capacity_frozen, available_minor
  INTO capacity_row
  FROM public.unclaimed_fund_refund_capacity
  WHERE fund_receipt_id = NEW.fund_receipt_id;

  IF capacity_row IS NULL
     OR capacity_row.capacity_frozen
     OR NEW.amount_minor > capacity_row.available_minor THEN
    RAISE EXCEPTION 'manual receipt resolution is frozen or exceeds outflow-adjusted capacity';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER manual_receipt_outflow_resolution_capacity_guard
  BEFORE INSERT ON public.fund_receipt_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_manual_outflow_resolution_capacity();

CREATE FUNCTION public.opensales_validate_manual_receipt_reversal_017()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row record;
DECLARE
  capacity_row record;
BEGIN
  SELECT
    fact.client_account_id,
    fact.gross_amount_minor,
    fact.currency AS fact_currency,
    receipt.amount_minor AS receipt_amount_minor,
    receipt.currency AS receipt_currency,
    receipt.allocated_minor,
    receipt.disposition
  INTO source_row
  FROM public.manual_receipt_facts fact
  JOIN public.fund_receipts receipt
    ON receipt.id = NEW.fund_receipt_id
   AND receipt.reported_manual_receipt_id = fact.id
  WHERE fact.id = NEW.manual_receipt_id
  FOR UPDATE OF fact, receipt;

  SELECT reserved_refund_minor, confirmed_outflow_minor,
         capacity_frozen, available_minor
  INTO capacity_row
  FROM public.unclaimed_fund_refund_capacity
  WHERE fund_receipt_id = NEW.fund_receipt_id;

  IF source_row IS NULL
     OR capacity_row IS NULL
     OR source_row.receipt_amount_minor <> source_row.gross_amount_minor
     OR source_row.receipt_currency <> source_row.fact_currency
     OR source_row.disposition <> 'unclaimed'
     OR source_row.allocated_minor <> 0
     OR capacity_row.reserved_refund_minor <> 0
     OR capacity_row.confirmed_outflow_minor <> 0
     OR capacity_row.capacity_frozen
     OR capacity_row.available_minor <> source_row.gross_amount_minor THEN
    RAISE EXCEPTION 'only a fully untouched manual receipt can be reversed';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER z_schema_017_manual_receipt_reversal_eligibility_guard
  BEFORE INSERT ON public.manual_receipt_reversals
  FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_manual_receipt_reversal_017();
