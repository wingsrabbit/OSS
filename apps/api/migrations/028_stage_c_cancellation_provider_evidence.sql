-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Schema 028 preserves the Schema 014/026 cancellation facts and adds the
-- missing immutable boundary around the one Provider mutation, query-only
-- reconciliation, and the terminal Provider observations used by Core.

ALTER TABLE public.service_cancellation_executions
  ADD COLUMN reconciliation_query_count integer NOT NULL DEFAULT 0
    CHECK (reconciliation_query_count BETWEEN 0 AND 3),
  ADD COLUMN last_reconciled_at timestamptz;

ALTER TABLE public.service_cancellation_executions
  ADD CONSTRAINT service_cancellation_execution_reconciliation_time CHECK (
    (reconciliation_query_count = 0 AND last_reconciled_at IS NULL)
    OR (reconciliation_query_count > 0 AND last_reconciled_at IS NOT NULL)
  );

ALTER TABLE public.service_cancellation_manual_actions
  ADD COLUMN completed_at timestamptz;
DROP TRIGGER IF EXISTS service_cancellation_manual_actions_immutable
  ON public.service_cancellation_manual_actions;
UPDATE public.service_cancellation_manual_actions
SET completed_at = created_at
WHERE completed_at IS NULL;
CREATE TRIGGER service_cancellation_manual_actions_immutable
BEFORE UPDATE OR DELETE ON public.service_cancellation_manual_actions
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_service_period_mutation();
ALTER TABLE public.service_cancellation_manual_actions
  ALTER COLUMN completed_at SET NOT NULL;

CREATE TABLE public.service_cancellation_provider_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE
    REFERENCES public.service_cancellation_executions(id),
  cancellation_request_id uuid NOT NULL UNIQUE
    REFERENCES public.service_cancellation_requests(id),
  service_id uuid NOT NULL UNIQUE REFERENCES public.services(id),
  provider_operation_id uuid NOT NULL UNIQUE REFERENCES public.provider_operations(id),
  due_job_id uuid NOT NULL UNIQUE REFERENCES public.durable_jobs(id),
  provider_installation_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number = 1),
  execution_version integer CHECK (execution_version > 0),
  service_version integer CHECK (service_version > 0),
  request_snapshot jsonb NOT NULL CHECK (jsonb_typeof(request_snapshot) = 'object'),
  dispatched_at timestamptz,
  evidence_origin text NOT NULL DEFAULT 'runtime'
    CHECK (evidence_origin IN ('runtime', 'schema027_forward')),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (
      evidence_origin = 'runtime'
      AND execution_version IS NOT NULL
      AND service_version IS NOT NULL
      AND dispatched_at IS NOT NULL
      AND created_at = dispatched_at
    )
    OR (
      evidence_origin = 'schema027_forward'
      AND execution_version IS NULL
      AND service_version IS NULL
      AND dispatched_at IS NULL
    )
  )
);

CREATE TABLE public.service_cancellation_reconciliation_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.service_cancellation_provider_attempts(id),
  execution_id uuid NOT NULL REFERENCES public.service_cancellation_executions(id),
  cancellation_request_id uuid NOT NULL REFERENCES public.service_cancellation_requests(id),
  service_id uuid NOT NULL REFERENCES public.services(id),
  provider_operation_id uuid NOT NULL REFERENCES public.provider_operations(id),
  reconcile_job_id uuid NOT NULL REFERENCES public.durable_jobs(id),
  query_number integer NOT NULL CHECK (query_number BETWEEN 1 AND 3),
  external_event_id text NOT NULL UNIQUE
    CHECK (char_length(external_event_id) BETWEEN 1 AND 160),
  request_snapshot jsonb NOT NULL CHECK (jsonb_typeof(request_snapshot) = 'object'),
  queried_at timestamptz NOT NULL,
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, query_number),
  UNIQUE (reconcile_job_id, query_number),
  CHECK (created_at = queried_at)
);

CREATE TABLE public.service_cancellation_reconciliation_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id uuid NOT NULL UNIQUE
    REFERENCES public.service_cancellation_reconciliation_queries(id),
  attempt_id uuid NOT NULL REFERENCES public.service_cancellation_provider_attempts(id),
  execution_id uuid NOT NULL REFERENCES public.service_cancellation_executions(id),
  cancellation_request_id uuid NOT NULL REFERENCES public.service_cancellation_requests(id),
  service_id uuid NOT NULL REFERENCES public.services(id),
  provider_operation_id uuid NOT NULL REFERENCES public.provider_operations(id),
  reconcile_job_id uuid NOT NULL REFERENCES public.durable_jobs(id),
  disposition text NOT NULL CHECK (disposition = 'unresolved'),
  observation_snapshot jsonb NOT NULL CHECK (jsonb_typeof(observation_snapshot) = 'object'),
  observed_at timestamptz NOT NULL,
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (created_at = observed_at)
);

CREATE TABLE public.service_cancellation_provider_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.service_cancellation_provider_attempts(id),
  execution_id uuid NOT NULL REFERENCES public.service_cancellation_executions(id),
  cancellation_request_id uuid NOT NULL REFERENCES public.service_cancellation_requests(id),
  service_id uuid NOT NULL REFERENCES public.services(id),
  provider_operation_id uuid NOT NULL REFERENCES public.provider_operations(id),
  provider_inbox_id uuid NOT NULL UNIQUE REFERENCES public.provider_inbox(id),
  reconciliation_query_id uuid UNIQUE
    REFERENCES public.service_cancellation_reconciliation_queries(id),
  provider_installation_id text NOT NULL,
  observation_source text NOT NULL
    CHECK (observation_source IN ('callback', 'reconciliation')),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  external_resource_id text NOT NULL CHECK (char_length(external_resource_id) BETWEEN 1 AND 200),
  provider_occurred_at timestamptz NOT NULL,
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  evidence_origin text NOT NULL DEFAULT 'runtime'
    CHECK (evidence_origin IN ('runtime', 'schema027_forward')),
  creation_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, provider_inbox_id),
  CHECK (
    (observation_source = 'callback' AND reconciliation_query_id IS NULL)
    OR observation_source = 'reconciliation'
  )
);

CREATE INDEX service_cancellation_provider_results_effective_idx
  ON public.service_cancellation_provider_results(
    execution_id, provider_occurred_at DESC, created_at DESC, id DESC
  );

-- Remove the legacy guard while legitimate Schema 027 rows are normalized.
-- It is recreated below with the Schema 028 evidence transitions.
DROP TRIGGER IF EXISTS service_cancellation_executions_update_guard
  ON public.service_cancellation_executions;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.provider_operations operation
    WHERE operation.subject_type = 'service_cancellation_execution'
      AND operation.kind = 'resource_terminate'
      AND operation.attempt_count NOT BETWEEN 0 AND 1
  ) THEN
    RAISE EXCEPTION
      'Schema 028 requires exactly zero or one Provider mutation attempt per cancellation';
  END IF;
END;
$$;

INSERT INTO public.service_cancellation_provider_attempts(
  execution_id, cancellation_request_id, service_id, provider_operation_id,
  due_job_id, provider_installation_id, attempt_number, execution_version,
  service_version, request_snapshot, dispatched_at, evidence_origin, created_at
)
SELECT execution.id,
       execution.cancellation_request_id,
       execution.service_id,
       operation.id,
       due_job.id,
       operation.provider_installation_id,
       1,
       NULL,
       NULL,
       jsonb_build_object(
         'action', 'terminate',
         'providerOperationId', operation.id::text,
         'serviceId', service.id::text,
         'externalResourceId', service.external_resource_id,
         'legacyDispatchMetadata', 'unavailable'
       ),
       NULL,
       'schema027_forward',
       clock_timestamp()
FROM public.service_cancellation_executions execution
JOIN public.services service ON service.id = execution.service_id
JOIN public.provider_operations operation
  ON operation.subject_type = 'service_cancellation_execution'
 AND operation.subject_id = execution.id
 AND operation.kind = 'resource_terminate'
JOIN public.durable_jobs due_job
  ON due_job.job_type = 'service.cancellation.due'
 AND due_job.unique_key = operation.stable_key
 AND due_job.payload->>'cancellationRequestId' = execution.cancellation_request_id::text
 AND due_job.payload->>'executionId' = execution.id::text
 AND due_job.payload->>'serviceId' = execution.service_id::text
 AND due_job.payload->>'providerOperationId' = operation.id::text
WHERE operation.attempt_count = 1;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.provider_operations operation
    WHERE operation.subject_type = 'service_cancellation_execution'
      AND operation.kind = 'resource_terminate'
      AND operation.attempt_count = 1
      AND NOT EXISTS (
        SELECT 1
        FROM public.service_cancellation_provider_attempts attempt
        WHERE attempt.provider_operation_id = operation.id
      )
  ) THEN
    RAISE EXCEPTION
      'Schema 027 cancellation attempt lacks an exact due-job and Provider-operation binding';
  END IF;
END;
$$;

INSERT INTO public.service_cancellation_provider_results(
  attempt_id, execution_id, cancellation_request_id, service_id,
  provider_operation_id, provider_inbox_id, provider_installation_id,
  observation_source, outcome, external_resource_id, provider_occurred_at,
  result_snapshot, evidence_origin, created_at
)
SELECT attempt.id,
       attempt.execution_id,
       attempt.cancellation_request_id,
       attempt.service_id,
       attempt.provider_operation_id,
       inbox.id,
       inbox.provider_installation_id,
       CASE
         WHEN inbox.external_event_id LIKE
           'reconcile:resource-termination:' || attempt.provider_operation_id::text || ':%'
           THEN 'reconciliation'
         ELSE 'callback'
       END,
       inbox.payload->>'status',
       inbox.payload->>'externalResourceId',
       (inbox.payload->>'occurredAt')::timestamptz,
       jsonb_build_object(
         'status', inbox.payload->>'status',
         'serviceId', inbox.payload->>'serviceId',
         'externalResourceId', inbox.payload->>'externalResourceId',
         'occurredAt', inbox.payload->>'occurredAt'
       ),
       'schema027_forward',
       inbox.received_at
FROM public.service_cancellation_provider_attempts attempt
JOIN public.provider_inbox inbox
  ON inbox.provider_installation_id = attempt.provider_installation_id
 AND inbox.event_type = 'resource.termination'
 AND inbox.payload->>'providerOperationId' = attempt.provider_operation_id::text
 AND inbox.payload->>'serviceId' = attempt.service_id::text
 AND inbox.payload->>'status' IN ('succeeded', 'failed')
 AND inbox.payload->>'externalResourceId' IS NOT NULL
 AND inbox.payload->>'occurredAt' IS NOT NULL;

-- A Schema 027 normal preflight could mark a known-unsent operation failed.
-- Restore the only truthful zero-attempt state; it remains manual intervention
-- and cannot satisfy either Schema 028 automatic Staff takeover branch.
UPDATE public.provider_operations operation
SET status = 'queued',
    provider_occurred_at = NULL,
    last_error = 'Schema 028 preserved a known-unsent cancellation preflight',
    updated_at = now()
WHERE operation.subject_type = 'service_cancellation_execution'
  AND operation.kind = 'resource_terminate'
  AND operation.status = 'failed'
  AND operation.attempt_count = 0;

-- A historical one-attempt failed status without a durable Provider fact is
-- unknown, not a failure fact. Preserve its identity and require GET
-- reconciliation.
UPDATE public.provider_operations operation
SET status = 'unknown',
    provider_occurred_at = NULL,
    last_error = 'Schema 028 requires Provider result evidence; reconcile by GET',
    updated_at = now()
WHERE operation.subject_type = 'service_cancellation_execution'
  AND operation.kind = 'resource_terminate'
  AND operation.status = 'failed'
  AND operation.attempt_count = 1
  AND NOT EXISTS (
    SELECT 1
    FROM public.service_cancellation_provider_results result
    WHERE result.provider_operation_id = operation.id
      AND result.outcome = 'failed'
  );

-- Schema 027 could also leave a legitimate attempted cancellation unknown with
-- its reconcile job completed or manual, but it retained no immutable GET
-- observations.  Normalize a processing execution and restart exact query-only
-- work so Schema 028 can collect its own three bounded observations.
UPDATE public.service_cancellation_executions execution
SET status = 'unknown',
    result = jsonb_build_object('status', 'unknown', 'reconciliation', 'query_only'),
    last_error = 'Schema 028 requires fresh immutable GET reconciliation evidence',
    updated_at = now(),
    version = execution.version + 1
FROM public.provider_operations operation
JOIN public.service_cancellation_provider_attempts attempt
  ON attempt.provider_operation_id = operation.id
WHERE operation.subject_type = 'service_cancellation_execution'
  AND operation.subject_id = execution.id
  AND operation.kind = 'resource_terminate'
  AND operation.status = 'unknown'
  AND operation.attempt_count = 1
  AND execution.status = 'processing';

INSERT INTO public.durable_jobs(
  job_type, unique_key, payload, status, available_at, attempts, last_error
)
SELECT 'service.cancellation.reconcile',
       operation.stable_key,
       jsonb_build_object(
         'cancellationRequestId', execution.cancellation_request_id::text,
         'executionId', execution.id::text,
         'serviceId', execution.service_id::text,
         'providerOperationId', operation.id::text
       ),
       'pending', now(), 0,
       'Schema 028 requires fresh immutable GET reconciliation evidence'
FROM public.provider_operations operation
JOIN public.service_cancellation_executions execution
  ON operation.subject_type = 'service_cancellation_execution'
 AND operation.subject_id = execution.id
JOIN public.service_cancellation_provider_attempts attempt
  ON attempt.provider_operation_id = operation.id
 AND attempt.execution_id = execution.id
WHERE operation.kind = 'resource_terminate'
  AND operation.status = 'unknown'
  AND operation.attempt_count = 1
  AND execution.status <> 'terminated'
ON CONFLICT (job_type, unique_key) DO UPDATE
SET payload = EXCLUDED.payload,
    status = 'pending',
    available_at = now(),
    attempts = 0,
    locked_at = NULL,
    locked_by = NULL,
    last_error = EXCLUDED.last_error,
    updated_at = now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.provider_operations operation
    WHERE operation.subject_type = 'service_cancellation_execution'
      AND operation.kind = 'resource_terminate'
      AND operation.status = 'succeeded'
      AND NOT EXISTS (
        SELECT 1
        FROM public.service_cancellation_provider_results result
        WHERE result.provider_operation_id = operation.id
          AND result.outcome = 'succeeded'
      )
  ) THEN
    RAISE EXCEPTION
      'Schema 028 refuses a succeeded cancellation without immutable Provider result evidence';
  END IF;
END;
$$;

UPDATE public.service_cancellation_executions execution
SET result = execution.result || jsonb_build_object(
      'providerCalled', false,
      'preflightFailure', true,
      'preflightReason', 'provider_automation_unavailable'
    ),
    version = execution.version + 1,
    updated_at = now()
WHERE execution.execution_mode = 'manual'
  AND execution.status = 'manual'
  AND NOT EXISTS (
    SELECT 1
    FROM public.provider_operations operation
    WHERE operation.subject_type = 'service_cancellation_execution'
      AND operation.subject_id = execution.id
      AND operation.kind = 'resource_terminate'
  )
  AND (
    execution.result->'providerCalled' IS DISTINCT FROM 'false'::jsonb
    OR execution.result->'preflightFailure' IS DISTINCT FROM 'true'::jsonb
  );

ALTER TABLE public.provider_operations
  ADD CONSTRAINT provider_operations_cancellation_single_attempt CHECK (
    subject_type <> 'service_cancellation_execution'
    OR kind <> 'resource_terminate'
    OR attempt_count BETWEEN 0 AND 1
  );

CREATE OR REPLACE FUNCTION public.opensales_reject_cancellation_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'service cancellation Provider evidence is append-only';
END;
$$;

CREATE TRIGGER service_cancellation_provider_attempts_append_only
BEFORE UPDATE OR DELETE ON public.service_cancellation_provider_attempts
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_cancellation_evidence_mutation();

CREATE TRIGGER service_cancellation_reconciliation_queries_append_only
BEFORE UPDATE OR DELETE ON public.service_cancellation_reconciliation_queries
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_cancellation_evidence_mutation();

CREATE TRIGGER service_cancellation_reconciliation_observations_append_only
BEFORE UPDATE OR DELETE ON public.service_cancellation_reconciliation_observations
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_cancellation_evidence_mutation();

CREATE TRIGGER service_cancellation_provider_results_append_only
BEFORE UPDATE OR DELETE ON public.service_cancellation_provider_results
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_cancellation_evidence_mutation();

CREATE OR REPLACE FUNCTION public.opensales_validate_cancellation_provider_attempt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_row record;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT execution.execution_mode,
         execution.status AS execution_status,
         execution.version AS execution_version,
         execution.cancellation_request_id,
         execution.service_id,
         execution.provider_installation_id,
         service.version AS service_version,
         service.external_resource_id,
         operation.provider_installation_id AS operation_provider_installation_id,
         operation.kind AS operation_kind,
         operation.subject_type,
         operation.subject_id,
         operation.stable_key,
         operation.status AS operation_status,
         operation.attempt_count,
         job.job_type,
         job.unique_key AS job_unique_key,
         job.payload AS job_payload,
         job.status AS job_status
  INTO source_row
  FROM public.service_cancellation_executions execution
  JOIN public.services service ON service.id = execution.service_id
  JOIN public.provider_operations operation ON operation.id = NEW.provider_operation_id
  JOIN public.durable_jobs job ON job.id = NEW.due_job_id
  WHERE execution.id = NEW.execution_id
  FOR UPDATE OF execution, service, operation, job;

  IF source_row IS NULL
     OR source_row.execution_mode <> 'automatic'
     OR source_row.execution_status <> 'processing'
     OR source_row.execution_version <> NEW.execution_version
     OR source_row.service_version <> NEW.service_version
     OR source_row.cancellation_request_id <> NEW.cancellation_request_id
     OR source_row.service_id <> NEW.service_id
     OR source_row.provider_installation_id <> NEW.provider_installation_id
     OR source_row.operation_provider_installation_id <> NEW.provider_installation_id
     OR source_row.operation_kind <> 'resource_terminate'
     OR source_row.subject_type <> 'service_cancellation_execution'
     OR source_row.subject_id <> NEW.execution_id
     OR source_row.operation_status <> 'running'
     OR source_row.attempt_count <> 1
     OR source_row.job_type <> 'service.cancellation.due'
     OR source_row.job_unique_key <> source_row.stable_key
     OR source_row.job_status <> 'running'
     OR source_row.job_payload->>'cancellationRequestId'
          IS DISTINCT FROM NEW.cancellation_request_id::text
     OR source_row.job_payload->>'executionId' IS DISTINCT FROM NEW.execution_id::text
     OR source_row.job_payload->>'serviceId' IS DISTINCT FROM NEW.service_id::text
     OR source_row.job_payload->>'providerOperationId'
          IS DISTINCT FROM NEW.provider_operation_id::text
     OR NEW.attempt_number <> 1
     OR NEW.evidence_origin <> 'runtime'
     OR NEW.created_at IS DISTINCT FROM NEW.dispatched_at
     OR NEW.request_snapshot IS DISTINCT FROM jsonb_build_object(
          'action', 'terminate',
          'providerOperationId', NEW.provider_operation_id::text,
          'serviceId', NEW.service_id::text,
          'externalResourceId', source_row.external_resource_id
        ) THEN
    RAISE EXCEPTION
      'cancellation Provider attempt does not match its execution, operation, and due job';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_cancellation_provider_attempts_insert_guard
BEFORE INSERT ON public.service_cancellation_provider_attempts
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_cancellation_provider_attempt();

CREATE OR REPLACE FUNCTION public.opensales_validate_cancellation_reconciliation_query()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_row record;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT attempt.execution_id,
         attempt.cancellation_request_id,
         attempt.service_id,
         attempt.provider_operation_id,
         execution.status AS execution_status,
         execution.reconciliation_query_count,
         operation.status AS operation_status,
         job.job_type,
         job.unique_key AS job_unique_key,
         job.payload,
         job.status AS job_status,
         provider_operation.stable_key AS operation_stable_key
  INTO source_row
  FROM public.service_cancellation_provider_attempts attempt
  JOIN public.service_cancellation_executions execution ON execution.id = attempt.execution_id
  JOIN public.provider_operations operation ON operation.id = attempt.provider_operation_id
  JOIN public.durable_jobs job ON job.id = NEW.reconcile_job_id
  JOIN public.provider_operations provider_operation
    ON provider_operation.id = NEW.provider_operation_id
  WHERE attempt.id = NEW.attempt_id
  FOR UPDATE OF execution, operation, job, provider_operation;

  IF source_row IS NULL
     OR source_row.execution_id <> NEW.execution_id
     OR source_row.cancellation_request_id <> NEW.cancellation_request_id
     OR source_row.service_id <> NEW.service_id
     OR source_row.provider_operation_id <> NEW.provider_operation_id
     OR source_row.execution_status NOT IN ('unknown', 'manual')
     OR source_row.operation_status <> 'unknown'
     OR NEW.query_number <> source_row.reconciliation_query_count + 1
     OR NEW.query_number > 3
     OR source_row.job_type <> 'service.cancellation.reconcile'
     OR source_row.job_unique_key <> source_row.operation_stable_key
     OR source_row.job_status <> 'running'
     OR source_row.payload->>'executionId' IS DISTINCT FROM NEW.execution_id::text
     OR source_row.payload->>'cancellationRequestId'
          IS DISTINCT FROM NEW.cancellation_request_id::text
     OR source_row.payload->>'serviceId' IS DISTINCT FROM NEW.service_id::text
     OR source_row.payload->>'providerOperationId'
          IS DISTINCT FROM NEW.provider_operation_id::text
     OR NEW.external_event_id <> 'reconcile:resource-termination:'
          || NEW.provider_operation_id::text || ':' || NEW.id::text
     OR NEW.created_at IS DISTINCT FROM NEW.queried_at
     OR NEW.request_snapshot IS DISTINCT FROM jsonb_build_object(
          'method', 'GET',
          'providerOperationId', NEW.provider_operation_id::text,
          'eventId', NEW.external_event_id
        ) THEN
    RAISE EXCEPTION
      'cancellation reconciliation query does not match its attempt and running job';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_cancellation_reconciliation_queries_insert_guard
BEFORE INSERT ON public.service_cancellation_reconciliation_queries
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_cancellation_reconciliation_query();

CREATE OR REPLACE FUNCTION public.opensales_require_cancellation_reconciliation_attachment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.service_cancellation_executions execution
    WHERE execution.id = NEW.execution_id
      AND execution.reconciliation_query_count = NEW.query_number
      AND execution.last_reconciled_at IS NOT DISTINCT FROM NEW.queried_at
      AND NEW.creation_transaction_id = txid_current()
  ) THEN
    RAISE EXCEPTION
      'cancellation reconciliation query was not atomically attached to its execution';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER service_cancellation_reconciliation_queries_attachment_guard
AFTER INSERT ON public.service_cancellation_reconciliation_queries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_require_cancellation_reconciliation_attachment();

CREATE OR REPLACE FUNCTION public.opensales_validate_cancellation_reconciliation_observation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_row record;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT query_fact.attempt_id,
         query_fact.execution_id,
         query_fact.cancellation_request_id,
         query_fact.service_id,
         query_fact.provider_operation_id,
         query_fact.reconcile_job_id
  INTO source_row
  FROM public.service_cancellation_reconciliation_queries query_fact
  WHERE query_fact.id = NEW.query_id
  FOR UPDATE;

  IF source_row IS NULL
     OR source_row.attempt_id <> NEW.attempt_id
     OR source_row.execution_id <> NEW.execution_id
     OR source_row.cancellation_request_id <> NEW.cancellation_request_id
     OR source_row.service_id <> NEW.service_id
     OR source_row.provider_operation_id <> NEW.provider_operation_id
     OR source_row.reconcile_job_id <> NEW.reconcile_job_id
     OR NEW.disposition <> 'unresolved'
     OR NEW.created_at IS DISTINCT FROM NEW.observed_at
     OR NEW.observation_snapshot - ARRAY['kind', 'detail'] <> '{}'::jsonb
     OR jsonb_typeof(NEW.observation_snapshot->'kind') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW.observation_snapshot->'detail') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION
      'cancellation reconciliation observation does not match its dispatched GET';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_cancellation_reconciliation_observations_insert_guard
BEFORE INSERT ON public.service_cancellation_reconciliation_observations
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_cancellation_reconciliation_observation();

CREATE OR REPLACE FUNCTION public.opensales_validate_cancellation_provider_result()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_row record;
BEGIN
  NEW.creation_transaction_id := txid_current();
  SELECT attempt.execution_id,
         attempt.cancellation_request_id,
         attempt.service_id,
         attempt.provider_operation_id,
         attempt.provider_installation_id,
         service.external_resource_id,
         inbox.provider_installation_id AS inbox_provider_installation_id,
         inbox.external_event_id,
         inbox.event_type,
         inbox.payload,
         query_fact.id AS query_id,
         query_fact.attempt_id AS query_attempt_id,
         query_fact.execution_id AS query_execution_id,
         query_fact.cancellation_request_id AS query_request_id,
         query_fact.service_id AS query_service_id,
         query_fact.provider_operation_id AS query_operation_id,
         query_fact.external_event_id AS query_external_event_id
  INTO source_row
  FROM public.service_cancellation_provider_attempts attempt
  JOIN public.services service ON service.id = attempt.service_id
  JOIN public.provider_inbox inbox ON inbox.id = NEW.provider_inbox_id
  LEFT JOIN public.service_cancellation_reconciliation_queries query_fact
    ON query_fact.id = NEW.reconciliation_query_id
  WHERE attempt.id = NEW.attempt_id
  FOR UPDATE OF service, inbox;

  IF source_row IS NULL
     OR source_row.execution_id <> NEW.execution_id
     OR source_row.cancellation_request_id <> NEW.cancellation_request_id
     OR source_row.service_id <> NEW.service_id
     OR source_row.provider_operation_id <> NEW.provider_operation_id
     OR source_row.provider_installation_id <> NEW.provider_installation_id
     OR source_row.inbox_provider_installation_id <> NEW.provider_installation_id
     OR source_row.event_type <> 'resource.termination'
     OR source_row.payload->>'providerOperationId'
          IS DISTINCT FROM NEW.provider_operation_id::text
     OR source_row.payload->>'serviceId' IS DISTINCT FROM NEW.service_id::text
     OR source_row.payload->>'externalResourceId' IS DISTINCT FROM NEW.external_resource_id
     OR source_row.external_resource_id IS DISTINCT FROM NEW.external_resource_id
     OR source_row.payload->>'status' IS DISTINCT FROM NEW.outcome
     OR (source_row.payload->>'occurredAt')::timestamptz
          IS DISTINCT FROM NEW.provider_occurred_at
     OR NEW.evidence_origin <> 'runtime'
     OR NEW.result_snapshot IS DISTINCT FROM jsonb_build_object(
          'status', NEW.outcome,
          'serviceId', NEW.service_id::text,
          'externalResourceId', NEW.external_resource_id,
          'occurredAt', source_row.payload->>'occurredAt',
          'reconciliationQueryId', NEW.reconciliation_query_id
        )
     OR (
       NEW.observation_source = 'reconciliation'
       AND (
         NEW.reconciliation_query_id IS NULL
         OR source_row.query_id IS NULL
         OR source_row.query_attempt_id IS DISTINCT FROM NEW.attempt_id
         OR source_row.query_execution_id IS DISTINCT FROM NEW.execution_id
         OR source_row.query_request_id IS DISTINCT FROM NEW.cancellation_request_id
         OR source_row.query_service_id IS DISTINCT FROM NEW.service_id
         OR source_row.query_operation_id IS DISTINCT FROM NEW.provider_operation_id
         OR source_row.query_external_event_id IS DISTINCT FROM source_row.external_event_id
         OR source_row.payload->>'reconciliationQueryId'
              IS DISTINCT FROM NEW.reconciliation_query_id::text
       )
     )
     OR (
       NEW.observation_source = 'callback'
       AND (
         NEW.reconciliation_query_id IS NOT NULL
         OR source_row.external_event_id LIKE
              'reconcile:resource-termination:' || NEW.provider_operation_id::text || ':%'
         OR source_row.payload ? 'reconciliationQueryId'
       )
     ) THEN
    RAISE EXCEPTION
      'cancellation Provider result does not match its attempt and inbox fact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_cancellation_provider_results_insert_guard
BEFORE INSERT ON public.service_cancellation_provider_results
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_cancellation_provider_result();

CREATE OR REPLACE FUNCTION public.opensales_require_cancellation_operation_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.subject_type <> 'service_cancellation_execution'
     OR NEW.kind <> 'resource_terminate' THEN
    RETURN NEW;
  END IF;
  IF NEW.attempt_count = 0 THEN
    IF NEW.status <> 'queued' THEN
      RAISE EXCEPTION 'an unattempted cancellation operation must remain queued';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.attempt_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.service_cancellation_provider_attempts attempt
    WHERE attempt.provider_operation_id = NEW.id
      AND attempt.execution_id = NEW.subject_id
      AND attempt.provider_installation_id = NEW.provider_installation_id
  ) THEN
    RAISE EXCEPTION 'cancellation operation lacks its one immutable Provider attempt';
  END IF;
  IF NEW.status IN ('succeeded', 'failed') AND NOT EXISTS (
    SELECT 1
    FROM public.service_cancellation_provider_results result
    WHERE result.provider_operation_id = NEW.id
      AND result.outcome = NEW.status
      AND result.provider_occurred_at IS NOT DISTINCT FROM NEW.provider_occurred_at
  ) THEN
    RAISE EXCEPTION 'terminal cancellation operation lacks matching Provider result evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER provider_operations_cancellation_evidence_guard
AFTER INSERT OR UPDATE ON public.provider_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_require_cancellation_operation_evidence();

CREATE OR REPLACE FUNCTION public.opensales_guard_service_cancellation_execution_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  transition_allowed boolean := false;
  reconciliation_step boolean := false;
BEGIN
  IF NEW.cancellation_request_id IS DISTINCT FROM OLD.cancellation_request_id
     OR NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.execution_mode IS DISTINCT FROM OLD.execution_mode
     OR NEW.provider_installation_id IS DISTINCT FROM OLD.provider_installation_id
     OR NEW.provider_capability_snapshot IS DISTINCT FROM OLD.provider_capability_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'cancellation execution business identity is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'cancellation execution version must advance exactly once';
  END IF;
  IF OLD.provider_occurred_at IS NOT NULL
     AND NEW.provider_occurred_at IS DISTINCT FROM OLD.provider_occurred_at
     AND (NEW.provider_occurred_at IS NULL OR NEW.provider_occurred_at < OLD.provider_occurred_at) THEN
    RAISE EXCEPTION 'cancellation Provider time cannot move backwards';
  END IF;

  reconciliation_step :=
    NEW.status = OLD.status
    AND NEW.execution_mode = 'automatic'
    AND OLD.status IN ('unknown', 'manual')
    AND NEW.reconciliation_query_count = OLD.reconciliation_query_count + 1
    AND NEW.reconciliation_query_count <= 3
    AND NEW.last_reconciled_at IS NOT NULL
    AND (OLD.last_reconciled_at IS NULL OR NEW.last_reconciled_at > OLD.last_reconciled_at)
    AND EXISTS (
      SELECT 1
      FROM public.service_cancellation_reconciliation_queries query_fact
      WHERE query_fact.execution_id = NEW.id
        AND query_fact.query_number = NEW.reconciliation_query_count
        AND query_fact.queried_at IS NOT DISTINCT FROM NEW.last_reconciled_at
        AND query_fact.creation_transaction_id = txid_current()
    );

  IF NOT reconciliation_step AND (
       NEW.reconciliation_query_count IS DISTINCT FROM OLD.reconciliation_query_count
       OR NEW.last_reconciled_at IS DISTINCT FROM OLD.last_reconciled_at
     ) THEN
    RAISE EXCEPTION 'cancellation reconciliation may only advance by one attached GET query';
  END IF;

  transition_allowed := reconciliation_step OR CASE OLD.status
    WHEN 'scheduled' THEN NEW.status IN ('processing', 'manual', 'terminated')
    WHEN 'processing' THEN NEW.status IN ('unknown', 'manual', 'terminated')
    WHEN 'unknown' THEN NEW.status IN ('manual', 'terminated')
    WHEN 'manual' THEN NEW.status = 'terminated'
    WHEN 'terminated' THEN false
    ELSE false
  END;
  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'cancellation execution status transition is invalid';
  END IF;

  IF OLD.status <> 'manual' AND NEW.status = 'manual' AND NEW.execution_mode = 'manual' THEN
    IF NEW.result->'providerCalled' IS DISTINCT FROM 'false'::jsonb
       OR NEW.result->'preflightFailure' IS DISTINCT FROM 'true'::jsonb
       OR NEW.result->>'preflightReason'
            IS DISTINCT FROM 'provider_automation_unavailable'
       OR EXISTS (
         SELECT 1 FROM public.provider_operations operation
         WHERE operation.subject_type = 'service_cancellation_execution'
           AND operation.subject_id = NEW.id
           AND operation.kind = 'resource_terminate'
       ) THEN
      RAISE EXCEPTION 'manual delivery requires a normal no-Provider preflight result';
    END IF;
  END IF;

  IF OLD.status <> 'manual' AND NEW.status = 'manual' AND NEW.execution_mode = 'automatic' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.provider_operations operation
      JOIN public.service_cancellation_provider_attempts attempt
        ON attempt.provider_operation_id = operation.id
       AND attempt.execution_id = NEW.id
      WHERE operation.subject_type = 'service_cancellation_execution'
        AND operation.subject_id = NEW.id
        AND operation.kind = 'resource_terminate'
        AND operation.status IN ('unknown', 'failed')
        AND (
          (
            operation.status = 'unknown'
            AND NEW.reconciliation_query_count = 3
            AND (
              SELECT count(*)
              FROM public.service_cancellation_reconciliation_observations observation
              WHERE observation.execution_id = NEW.id
            ) = 3
          )
          OR (
            operation.status = 'failed'
            AND EXISTS (
              SELECT 1 FROM public.service_cancellation_provider_results result
              WHERE result.provider_operation_id = operation.id
                AND result.outcome = 'failed'
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.service_cancellation_provider_results result
              WHERE result.provider_operation_id = operation.id
                AND result.outcome = 'succeeded'
            )
          )
        )
    ) THEN
      RAISE EXCEPTION 'automatic cancellation manual state lacks exact unknown or failed evidence';
    END IF;
  END IF;

  IF OLD.status <> 'terminated' AND NEW.status = 'terminated' AND NEW.execution_mode = 'automatic'
     AND NOT EXISTS (
       SELECT 1
       FROM public.provider_operations operation
       JOIN public.service_cancellation_provider_results result
         ON result.provider_operation_id = operation.id
        AND result.execution_id = NEW.id
        AND result.outcome = 'succeeded'
        AND result.provider_occurred_at IS NOT DISTINCT FROM NEW.provider_occurred_at
       WHERE operation.subject_type = 'service_cancellation_execution'
         AND operation.subject_id = NEW.id
         AND operation.kind = 'resource_terminate'
         AND operation.status = 'succeeded'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.service_cancellation_manual_actions manual_action
       WHERE manual_action.execution_id = NEW.id
         AND manual_action.creation_transaction_id = txid_current()
         AND manual_action.takeover_kind = 'provider_reconciliation_takeover'
     ) THEN
    RAISE EXCEPTION 'automatic cancellation execution requires Provider result or exact takeover';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_cancellation_executions_update_guard
BEFORE UPDATE ON public.service_cancellation_executions
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_service_cancellation_execution_update();

CREATE OR REPLACE FUNCTION public.opensales_guard_automatic_cancellation_service_termination()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.cancellation_request_id IS NOT NULL
     AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a cancellation-bound service version must advance exactly once';
  END IF;
  IF OLD.cancellation_request_id IS NOT NULL
     AND OLD.status = 'terminated'
     AND NEW.status <> 'terminated' THEN
    RAISE EXCEPTION 'a service terminated by cycle-end cancellation cannot move backwards';
  END IF;
  IF OLD.status <> 'terminated' AND NEW.status = 'terminated'
     AND EXISTS (
       SELECT 1 FROM public.service_cancellation_executions execution
       WHERE execution.service_id = NEW.id
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.service_cancellation_executions execution
       JOIN public.provider_operations operation
         ON operation.subject_type = 'service_cancellation_execution'
        AND operation.subject_id = execution.id
        AND operation.kind = 'resource_terminate'
        AND operation.status = 'succeeded'
       JOIN public.service_cancellation_provider_results result
         ON result.provider_operation_id = operation.id
        AND result.execution_id = execution.id
        AND result.outcome = 'succeeded'
       WHERE execution.service_id = NEW.id
         AND execution.execution_mode = 'automatic'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.service_cancellation_manual_actions manual_action
       WHERE manual_action.service_id = NEW.id
         AND manual_action.creation_transaction_id = txid_current()
     ) THEN
    RAISE EXCEPTION 'cancellation cannot terminate a service without exact completion evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_service_cancellation_manual_action()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_row record;
  source_found boolean := false;
  reauth_invalidated_at timestamptz;
  reauth_expires_at timestamptz;
  authorization_checked_at timestamptz;
  staff_permissions_valid boolean := false;
  expected_outcome text;
  expected_attempt_id uuid;
BEGIN
  NEW.creation_transaction_id := txid_current();

  SELECT execution.service_id AS execution_service_id,
         execution.execution_mode,
         execution.status AS execution_status,
         execution.version AS execution_version,
         execution.result AS execution_result,
         execution.reconciliation_query_count,
         (
           SELECT count(*)::integer
           FROM public.service_cancellation_reconciliation_observations observation
           WHERE observation.execution_id = execution.id
         ) AS unresolved_reconciliation_count,
         request.service_id AS request_service_id,
         request.client_account_id AS request_client_account_id,
         request.effective_at,
         service.client_account_id AS service_client_account_id,
         service.status AS service_status,
         service.version AS service_version,
         target_account.restricted_at AS target_account_restricted_at,
         operation.id AS provider_operation_id,
         operation.status AS provider_operation_status,
         operation.attempt_count AS provider_attempt_count,
         attempt.id AS provider_attempt_id,
         EXISTS (
           SELECT 1 FROM public.service_cancellation_provider_results result
           WHERE result.provider_operation_id = operation.id AND result.outcome = 'failed'
         ) AS has_failed_result,
         EXISTS (
           SELECT 1 FROM public.service_cancellation_provider_results result
           WHERE result.provider_operation_id = operation.id AND result.outcome = 'succeeded'
         ) AS has_succeeded_result,
         staff.permissions,
         staff.active AS staff_active,
         staff_user.email_verified_at,
         staff_user.restricted_at AS staff_restricted_at,
         session_record.revoked_at AS session_revoked_at,
         session_record.expires_at AS session_expires_at,
         reauth_pointer.id AS reauth_grant_id
  INTO source_row
  FROM public.service_cancellation_executions execution
  JOIN public.service_cancellation_requests request
    ON request.id = execution.cancellation_request_id
  JOIN public.services service ON service.id = execution.service_id
  JOIN public.client_accounts target_account ON target_account.id = NEW.staff_client_account_id
  JOIN public.staff_members staff ON staff.user_id = NEW.staff_user_id
  JOIN public.users staff_user ON staff_user.id = staff.user_id
  JOIN public.sessions session_record
    ON session_record.id = NEW.staff_session_id
   AND session_record.user_id = staff.user_id
  LEFT JOIN LATERAL (
    SELECT grant_record.id
    FROM public.reauth_grants grant_record
    WHERE grant_record.user_id = staff.user_id
      AND grant_record.session_id = session_record.id
      AND grant_record.invalidated_at IS NULL
      AND grant_record.expires_at > clock_timestamp()
    ORDER BY grant_record.created_at DESC, grant_record.id DESC
    LIMIT 1
  ) reauth_pointer ON true
  LEFT JOIN public.provider_operations operation
    ON operation.subject_type = 'service_cancellation_execution'
   AND operation.subject_id = execution.id
   AND operation.kind = 'resource_terminate'
  LEFT JOIN public.service_cancellation_provider_attempts attempt
    ON attempt.provider_operation_id = operation.id
   AND attempt.execution_id = execution.id
  WHERE execution.id = NEW.execution_id
  FOR UPDATE OF execution, request, service, target_account, staff, staff_user,
    session_record;

  source_found := FOUND;
  IF source_found AND source_row.provider_operation_id IS NOT NULL THEN
    PERFORM 1
    FROM public.provider_operations operation
    WHERE operation.id = source_row.provider_operation_id
    FOR UPDATE;
  END IF;
  IF source_found AND source_row.provider_attempt_id IS NOT NULL THEN
    PERFORM 1
    FROM public.service_cancellation_provider_attempts attempt
    WHERE attempt.id = source_row.provider_attempt_id
    FOR UPDATE;
  END IF;
  IF source_found THEN
    SELECT operation.id,
           operation.status,
           operation.attempt_count,
           attempt.id,
           EXISTS (
             SELECT 1 FROM public.service_cancellation_provider_results result
             WHERE result.provider_operation_id = operation.id AND result.outcome = 'failed'
           ),
           EXISTS (
             SELECT 1 FROM public.service_cancellation_provider_results result
             WHERE result.provider_operation_id = operation.id AND result.outcome = 'succeeded'
           )
    INTO source_row.provider_operation_id,
         source_row.provider_operation_status,
         source_row.provider_attempt_count,
         source_row.provider_attempt_id,
         source_row.has_failed_result,
         source_row.has_succeeded_result
    FROM public.service_cancellation_executions execution
    LEFT JOIN public.provider_operations operation
      ON operation.subject_type = 'service_cancellation_execution'
     AND operation.subject_id = execution.id
     AND operation.kind = 'resource_terminate'
    LEFT JOIN public.service_cancellation_provider_attempts attempt
      ON attempt.provider_operation_id = operation.id
     AND attempt.execution_id = execution.id
    WHERE execution.id = NEW.execution_id;
  END IF;
  IF source_found AND source_row.reauth_grant_id IS NOT NULL THEN
    SELECT grant_record.invalidated_at, grant_record.expires_at
    INTO reauth_invalidated_at, reauth_expires_at
    FROM public.reauth_grants grant_record
    WHERE grant_record.id = source_row.reauth_grant_id
    FOR UPDATE;
  END IF;
  authorization_checked_at := clock_timestamp();

  IF source_found
     AND jsonb_typeof(source_row.permissions) = 'array'
     AND NOT jsonb_path_exists(
       source_row.permissions,
       '$[*] ? (@.type() != "string")'::jsonpath
     ) THEN
    SELECT NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(source_row.permissions) candidate(value)
      WHERE candidate.value = ''
         OR pg_catalog.btrim(
              candidate.value,
              U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
            ) <> candidate.value
    ) AND (
      source_row.permissions ? '*'
      OR source_row.permissions ? 'services.manual_fulfillment'
    ) INTO staff_permissions_valid;
  END IF;

  IF NOT source_found
     OR source_row.execution_service_id <> NEW.service_id
     OR source_row.request_service_id <> NEW.service_id
     OR source_row.request_client_account_id <> NEW.staff_client_account_id
     OR source_row.service_client_account_id <> NEW.staff_client_account_id
     OR source_row.execution_status <> 'manual'
     OR source_row.execution_version <> NEW.expected_execution_version
     OR source_row.service_version <> NEW.expected_service_version
     OR source_row.service_status NOT IN ('active', 'suspended', 'provisioned_hold')
     OR source_row.effective_at > authorization_checked_at
     OR source_row.target_account_restricted_at IS NOT NULL
     OR NOT source_row.staff_active
     OR source_row.email_verified_at IS NULL
     OR source_row.staff_restricted_at IS NOT NULL
     OR source_row.session_revoked_at IS NOT NULL
     OR source_row.session_expires_at <= authorization_checked_at
     OR reauth_expires_at IS NULL
     OR reauth_invalidated_at IS NOT NULL
     OR reauth_expires_at <= authorization_checked_at
     OR NOT staff_permissions_valid
     OR NEW.completed_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION
      'manual cancellation completion lacks current authority or eligible state';
  END IF;

  IF source_row.execution_mode = 'manual' THEN
    expected_outcome := NULL;
    expected_attempt_id := NULL;
    IF NEW.takeover_kind <> 'manual_delivery'
       OR source_row.provider_operation_id IS NOT NULL
       OR source_row.provider_attempt_id IS NOT NULL
       OR source_row.execution_result->'providerCalled' IS DISTINCT FROM 'false'::jsonb
       OR source_row.execution_result->'preflightFailure' IS DISTINCT FROM 'true'::jsonb
       OR source_row.execution_result->>'preflightReason'
            IS DISTINCT FROM 'provider_automation_unavailable' THEN
      RAISE EXCEPTION 'manual cancellation completion does not match normal manual delivery';
    END IF;
  ELSE
    expected_outcome := source_row.provider_operation_status;
    expected_attempt_id := source_row.provider_attempt_id;
    IF NEW.takeover_kind <> 'provider_reconciliation_takeover'
       OR source_row.provider_attempt_id IS NULL
       OR source_row.provider_attempt_count <> 1
       OR source_row.provider_operation_status NOT IN ('unknown', 'failed')
       OR source_row.has_succeeded_result
       OR (
         source_row.provider_operation_status = 'unknown'
         AND (
           source_row.reconciliation_query_count <> 3
           OR source_row.unresolved_reconciliation_count <> 3
         )
       )
       OR (
         source_row.provider_operation_status = 'failed'
         AND NOT source_row.has_failed_result
       ) THEN
      RAISE EXCEPTION 'automatic cancellation takeover lacks exact unknown or failed evidence';
    END IF;
  END IF;

  IF jsonb_typeof(NEW.result) IS DISTINCT FROM 'object'
     OR NOT NEW.result ?& ARRAY[
       'actionId', 'executionId', 'serviceId', 'targetClientAccountId',
       'executionStatus', 'serviceStatus', 'takeoverKind', 'providerCalled',
       'providerOutcome', 'providerAttemptId', 'reconcileQueries',
       'unresolvedReconcileQueries',
       'expectedExecutionVersion', 'expectedServiceVersion', 'completedAt'
     ]
     OR NEW.result - ARRAY[
       'actionId', 'executionId', 'serviceId', 'targetClientAccountId',
       'executionStatus', 'serviceStatus', 'takeoverKind', 'providerCalled',
       'providerOutcome', 'providerAttemptId', 'reconcileQueries',
       'unresolvedReconcileQueries',
       'expectedExecutionVersion', 'expectedServiceVersion', 'completedAt'
     ] <> '{}'::jsonb
     OR NEW.result->>'actionId' IS DISTINCT FROM NEW.id::text
     OR NEW.result->>'executionId' IS DISTINCT FROM NEW.execution_id::text
     OR NEW.result->>'serviceId' IS DISTINCT FROM NEW.service_id::text
     OR NEW.result->>'targetClientAccountId'
          IS DISTINCT FROM NEW.staff_client_account_id::text
     OR NEW.result->>'executionStatus' IS DISTINCT FROM 'terminated'
     OR NEW.result->>'serviceStatus' IS DISTINCT FROM 'terminated'
     OR NEW.result->>'takeoverKind' IS DISTINCT FROM NEW.takeover_kind
     OR NEW.result->'providerCalled' IS DISTINCT FROM 'false'::jsonb
     OR NEW.result->>'providerOutcome' IS DISTINCT FROM expected_outcome
     OR NEW.result->>'providerAttemptId' IS DISTINCT FROM expected_attempt_id::text
     OR (NEW.result->>'reconcileQueries')::integer
          IS DISTINCT FROM source_row.reconciliation_query_count
     OR (NEW.result->>'unresolvedReconcileQueries')::integer
          IS DISTINCT FROM source_row.unresolved_reconciliation_count
     OR (NEW.result->>'expectedExecutionVersion')::integer
          IS DISTINCT FROM NEW.expected_execution_version
     OR (NEW.result->>'expectedServiceVersion')::integer
          IS DISTINCT FROM NEW.expected_service_version
     OR (NEW.result->>'completedAt')::timestamptz IS DISTINCT FROM NEW.completed_at THEN
    RAISE EXCEPTION 'manual cancellation result does not match the completed action';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.opensales_require_service_cancellation_manual_completion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.service_cancellation_executions execution
    JOIN public.services service ON service.id = execution.service_id
    WHERE execution.id = NEW.execution_id
      AND execution.service_id = NEW.service_id
      AND execution.status = 'terminated'
      AND execution.version = NEW.expected_execution_version + 1
      AND execution.completed_at IS NOT DISTINCT FROM NEW.completed_at
      AND execution.result IS NOT DISTINCT FROM NEW.result
      AND service.client_account_id = NEW.staff_client_account_id
      AND service.status = 'terminated'
      AND service.version = NEW.expected_service_version + 1
      AND service.updated_at IS NOT DISTINCT FROM NEW.completed_at
      AND NEW.creation_transaction_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'manual cancellation action was not atomically and exactly completed';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE public.service_cancellation_provider_attempts IS
  'Exactly one immutable Mock Provider termination attempt per automatic cancellation; Schema 027 origin is explicit when exact dispatch time and versions were never stored.';
COMMENT ON TABLE public.service_cancellation_reconciliation_queries IS
  'At most three immutable GET-only reconciliation dispatch facts for one cancellation attempt.';
COMMENT ON TABLE public.service_cancellation_reconciliation_observations IS
  'Immutable completed unresolved observations; only three such GET outcomes permit an unknown-result Staff takeover.';
COMMENT ON TABLE public.service_cancellation_provider_results IS
  'Immutable, inbox-bound Mock Provider termination observations reduced by Core.';
