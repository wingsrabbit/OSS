-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Schema 014 predated the Core customer-capability model introduced for
-- multi-account membership context.  Replace only the trigger functions: the
-- immutable cancellation facts and their historical migration stay intact.
CREATE OR REPLACE FUNCTION public.opensales_validate_service_cancellation_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_row record;
  authorization_checked_at timestamptz;
BEGIN
  -- The caller cannot manufacture the same-transaction marker used when the
  -- service accepts this request.
  NEW.creation_transaction_id := pg_catalog.txid_current();

  SELECT
    service.client_account_id,
    service.status AS service_status,
    service.billing_cycle,
    service.term_end,
    service.version AS service_version,
    service.cancellation_request_id,
    account.restricted_at AS account_restricted_at,
    request_user.email_verified_at,
    request_user.restricted_at AS user_restricted_at,
    membership.role AS membership_role,
    membership.permissions AS membership_permissions,
    membership.removed_at AS membership_removed_at,
    membership.restricted_at AS membership_restricted_at,
    session_record.active_client_account_id AS session_active_client_account_id,
    session_record.expires_at AS session_expires_at,
    session_record.revoked_at AS session_revoked_at,
    binding.product_policy_version,
    binding.cycle_end_cancellation_mode_snapshot,
    binding.cycle_end_cancellation_execution_mode_snapshot,
    binding.cycle_end_cancellation_min_notice_hours_snapshot,
    binding.cycle_end_cancellation_requirement_key_snapshot
  INTO source_row
  FROM public.services service
  JOIN public.client_accounts account
    ON account.id = service.client_account_id
   AND account.id = NEW.client_account_id
  JOIN public.users request_user
    ON request_user.id = NEW.requested_by_user_id
  JOIN public.client_memberships membership
    ON membership.client_account_id = account.id
   AND membership.user_id = request_user.id
  JOIN public.sessions session_record
    ON session_record.id = NEW.requested_session_id
   AND session_record.user_id = request_user.id
  JOIN public.service_provider_bindings binding
    ON binding.service_id = service.id
  WHERE service.id = NEW.service_id
  FOR UPDATE OF service, account, request_user, membership, session_record;

  -- clock_timestamp(), deliberately sampled only after every authorization and
  -- target row above is locked, prevents a transaction that waited on the
  -- Service from retaining a stale transaction-start `now()` authorization.
  authorization_checked_at := pg_catalog.clock_timestamp();

  IF source_row IS NULL
     OR source_row.client_account_id <> NEW.client_account_id
     OR source_row.service_status NOT IN ('active', 'suspended')
     OR source_row.billing_cycle = 'one_time'
     OR source_row.term_end IS NULL
     OR source_row.term_end <= authorization_checked_at
     OR NEW.effective_at IS DISTINCT FROM source_row.term_end
     OR source_row.service_version <> NEW.expected_service_version
     OR source_row.cancellation_request_id IS NOT NULL
     OR source_row.email_verified_at IS NULL
     OR source_row.user_restricted_at IS NOT NULL
     OR source_row.account_restricted_at IS NOT NULL
     OR source_row.membership_removed_at IS NOT NULL
     OR source_row.membership_restricted_at IS NOT NULL
     OR NOT (
       source_row.membership_role IN ('owner', 'technical')
       OR source_row.membership_permissions ? '*'
       OR source_row.membership_permissions ? 'services.manage'
     )
     OR source_row.session_active_client_account_id IS DISTINCT FROM NEW.client_account_id
     OR source_row.session_revoked_at IS NOT NULL
     OR source_row.session_expires_at <= authorization_checked_at
     OR source_row.cycle_end_cancellation_mode_snapshot <> 'self_service'
     OR source_row.cycle_end_cancellation_requirement_key_snapshot IS NOT NULL
     OR NEW.authorization_ticket_id IS NOT NULL
     OR NEW.product_policy_version <> source_row.product_policy_version
     OR NEW.notice_qualified_at IS DISTINCT FROM NEW.created_at
     -- Notice qualification is based on the trusted post-lock database clock,
     -- never on the application-provided fact timestamp.
     OR authorization_checked_at > source_row.term_end
          - pg_catalog.make_interval(
              hours => source_row.cycle_end_cancellation_min_notice_hours_snapshot
            )
     OR NEW.policy_snapshot IS DISTINCT FROM pg_catalog.jsonb_build_object(
          'schedulingMode', source_row.cycle_end_cancellation_mode_snapshot,
          'executionMode', source_row.cycle_end_cancellation_execution_mode_snapshot,
          'minimumNoticeHours', source_row.cycle_end_cancellation_min_notice_hours_snapshot,
          'requirementKey', source_row.cycle_end_cancellation_requirement_key_snapshot
        ) THEN
    RAISE EXCEPTION
      'cycle-end cancellation request is not eligible for this service and session';
  END IF;

  RETURN NEW;
END;
$$;

-- A platform Staff member operates across Client Accounts.  The historical
-- column name staff_client_account_id is retained for compatibility, but the
-- fact is the exact target Client Account; it is not a Staff membership claim.
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
BEGIN
  NEW.creation_transaction_id := pg_catalog.txid_current();

  SELECT
    execution.service_id AS execution_service_id,
    execution.execution_mode,
    execution.status AS execution_status,
    execution.version AS execution_version,
    request.service_id AS request_service_id,
    request.client_account_id AS request_client_account_id,
    request.effective_at,
    service.client_account_id AS service_client_account_id,
    service.status AS service_status,
    service.version AS service_version,
    target_account.restricted_at AS target_account_restricted_at,
    operation.status AS provider_operation_status,
    operation.attempt_count AS provider_attempt_count,
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
  JOIN public.services service
    ON service.id = execution.service_id
  JOIN public.client_accounts target_account
    ON target_account.id = NEW.staff_client_account_id
  JOIN public.staff_members staff
    ON staff.user_id = NEW.staff_user_id
  JOIN public.users staff_user
    ON staff_user.id = staff.user_id
  JOIN public.sessions session_record
    ON session_record.id = NEW.staff_session_id
   AND session_record.user_id = staff.user_id
  LEFT JOIN LATERAL (
    SELECT grant_record.id
    FROM public.reauth_grants grant_record
    WHERE grant_record.user_id = staff.user_id
      AND grant_record.session_id = session_record.id
      AND grant_record.invalidated_at IS NULL
      AND grant_record.expires_at > pg_catalog.clock_timestamp()
    ORDER BY grant_record.created_at DESC, grant_record.id DESC
    LIMIT 1
  ) reauth_pointer ON true
  LEFT JOIN public.provider_operations operation
    ON operation.subject_type = 'service_cancellation_execution'
   AND operation.subject_id = execution.id
   AND operation.kind = 'resource_terminate'
  WHERE execution.id = NEW.execution_id
  FOR UPDATE OF execution, request, service, target_account, staff, staff_user,
    session_record;

  source_found := FOUND;
  IF source_found AND source_row.reauth_grant_id IS NOT NULL THEN
    SELECT grant_record.invalidated_at, grant_record.expires_at
    INTO reauth_invalidated_at, reauth_expires_at
    FROM public.reauth_grants grant_record
    WHERE grant_record.id = source_row.reauth_grant_id
    FOR UPDATE;
  END IF;

  -- Re-sample only after the target, Staff identity, Session, and selected
  -- reauthentication grant are locked.  Expiry during lock acquisition must
  -- fail this transaction even though transaction-start now() is still old.
  authorization_checked_at := pg_catalog.clock_timestamp();

  -- Match requireStaffPermission()/requireStaffActionLocked(): malformed JSON
  -- is never an authority source, even when the jsonb `?` operator happens to
  -- find the requested key or array element.
  IF source_found
     AND pg_catalog.jsonb_typeof(source_row.permissions) = 'array'
     AND NOT pg_catalog.jsonb_path_exists(
       source_row.permissions,
       '$[*] ? (@.type() != "string")'::pg_catalog.jsonpath
     ) THEN
    SELECT
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements_text(source_row.permissions) candidate(value)
        WHERE candidate.value = ''
           -- ECMAScript String.prototype.trim whitespace/line terminators,
           -- kept explicit so the native guard matches the API parser.
           OR pg_catalog.btrim(
             candidate.value,
             U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
           ) <> candidate.value
      )
      AND (
        source_row.permissions ? '*'
        OR source_row.permissions ? 'services.manual_fulfillment'
      )
    INTO staff_permissions_valid;
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
     OR NOT staff_permissions_valid THEN
    RAISE EXCEPTION
      'manual cancellation completion lacks current authority or eligible state';
  END IF;

  IF source_row.execution_mode = 'manual' AND (
       NEW.takeover_kind <> 'manual_delivery'
       OR source_row.provider_operation_status IS NOT NULL
     ) THEN
    RAISE EXCEPTION
      'manual cancellation completion does not match manual delivery';
  END IF;
  IF source_row.execution_mode = 'automatic' AND (
       NEW.takeover_kind <> 'provider_reconciliation_takeover'
       OR source_row.provider_operation_status NOT IN ('unknown', 'failed', 'succeeded')
       OR COALESCE(source_row.provider_attempt_count, 0) < 1
     ) THEN
    RAISE EXCEPTION
      'automatic cancellation takeover lacks prior Provider evidence';
  END IF;
  RETURN NEW;
END;
$$;
