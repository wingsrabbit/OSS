-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Schema 019 introduces explicit, session-bound Client Account context.  The
-- migration deliberately refuses to infer an owner or repair ambiguous
-- membership data.  Operators must correct those facts before moving forward.
DO $$
DECLARE
  invalid_account_id uuid;
  invalid_membership_account_id uuid;
  invalid_membership_user_id uuid;
  mismatched_service_id uuid;
  mismatched_invoice_id uuid;
  mismatched_renewal_id uuid;
  mismatched_period_id uuid;
  mismatched_payment_attempt_id uuid;
  mismatched_payment_allocation_id uuid;
BEGIN
  SELECT account.id
  INTO invalid_account_id
  FROM public.client_accounts account
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.client_memberships membership
    WHERE membership.client_account_id = account.id
      AND membership.user_id = account.owner_user_id
      AND membership.role = 'owner'
      AND membership.removed_at IS NULL
  )
  ORDER BY account.id
  LIMIT 1;

  IF invalid_account_id IS NOT NULL THEN
    RAISE EXCEPTION
      'schema 019 requires client account % to have its recorded active owner membership; repair forward before migration',
      invalid_account_id;
  END IF;

  SELECT membership.client_account_id, membership.user_id
  INTO invalid_membership_account_id, invalid_membership_user_id
  FROM public.client_memberships membership
  WHERE pg_catalog.jsonb_typeof(membership.permissions) <> 'array'
     OR pg_catalog.jsonb_path_exists(
          membership.permissions,
          '$[*] ? (@.type() != "string")'::pg_catalog.jsonpath
        )
  ORDER BY membership.client_account_id, membership.user_id
  LIMIT 1;

  IF invalid_membership_account_id IS NOT NULL THEN
    RAISE EXCEPTION
      'schema 019 requires membership permissions to be JSON arrays; account %, user % is invalid',
      invalid_membership_account_id,
      invalid_membership_user_id;
  END IF;

  SELECT service.id
  INTO mismatched_service_id
  FROM public.services service
  JOIN public.order_items item ON item.id = service.order_item_id
  JOIN public.orders original_order ON original_order.id = item.order_id
  WHERE service.client_account_id <> original_order.client_account_id
     OR service.billing_cycle <> item.billing_cycle
  ORDER BY service.id
  LIMIT 1;

  IF mismatched_service_id IS NOT NULL THEN
    RAISE EXCEPTION
      'schema 019 found service % whose Client Account or billing cycle differs from its Order Item; repair forward before migration',
      mismatched_service_id;
  END IF;

  SELECT invoice.id
  INTO mismatched_invoice_id
  FROM public.invoices invoice
  JOIN public.orders original_order ON original_order.id = invoice.order_id
  WHERE invoice.client_account_id <> original_order.client_account_id
     OR invoice.currency <> original_order.currency
  ORDER BY invoice.id
  LIMIT 1;

  IF mismatched_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION
      'schema 019 found invoice % whose Client Account or currency differs from its order; repair forward before migration',
      mismatched_invoice_id;
  END IF;

  SELECT renewal.id
  INTO mismatched_renewal_id
  FROM public.service_renewals renewal
  JOIN public.services service ON service.id = renewal.service_id
  JOIN public.invoices invoice ON invoice.id = renewal.invoice_id
  WHERE service.client_account_id <> invoice.client_account_id
     OR renewal.currency <> invoice.currency
  ORDER BY renewal.id
  LIMIT 1;

  IF mismatched_renewal_id IS NOT NULL THEN
    RAISE EXCEPTION
      'schema 019 found renewal % whose Service, Invoice, Client Account, or currency differs; repair forward before migration',
      mismatched_renewal_id;
  END IF;

  SELECT period.id
  INTO mismatched_period_id
  FROM public.service_periods period
  JOIN public.services service ON service.id = period.service_id
  JOIN public.invoices invoice ON invoice.id = period.invoice_id
  WHERE service.client_account_id <> invoice.client_account_id
  ORDER BY period.id
  LIMIT 1;

  IF mismatched_period_id IS NOT NULL THEN
    RAISE EXCEPTION
      'schema 019 found service period % whose Service and Invoice Client Accounts differ; repair forward before migration',
      mismatched_period_id;
  END IF;

  SELECT attempt.id
  INTO mismatched_payment_attempt_id
  FROM public.payment_attempts attempt
  JOIN public.invoices invoice ON invoice.id = attempt.invoice_id
  WHERE attempt.client_account_id <> invoice.client_account_id
     OR attempt.currency <> invoice.currency
  ORDER BY attempt.id
  LIMIT 1;

  IF mismatched_payment_attempt_id IS NOT NULL THEN
    RAISE EXCEPTION
      'schema 019 found payment attempt % whose Invoice, Client Account, or currency differs; repair forward before migration',
      mismatched_payment_attempt_id;
  END IF;

  SELECT allocation.id
  INTO mismatched_payment_allocation_id
  FROM public.payment_allocations allocation
  JOIN public.payment_attempts attempt ON attempt.id = allocation.payment_attempt_id
  JOIN public.invoices invoice ON invoice.id = allocation.invoice_id
  WHERE allocation.invoice_id <> attempt.invoice_id
     OR attempt.client_account_id <> invoice.client_account_id
  ORDER BY allocation.id
  LIMIT 1;

  IF mismatched_payment_allocation_id IS NOT NULL THEN
    RAISE EXCEPTION
      'schema 019 found payment allocation % whose Payment Attempt and Invoice facts differ; repair forward before migration',
      mismatched_payment_allocation_id;
  END IF;
END;
$$;

ALTER TABLE public.sessions
  ADD COLUMN active_client_account_id uuid,
  ADD COLUMN account_context_version bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT sessions_account_context_version_check
    CHECK (account_context_version >= 0),
  ADD CONSTRAINT sessions_active_client_account_fkey
    FOREIGN KEY (active_client_account_id)
    REFERENCES public.client_accounts(id);

ALTER TABLE public.client_memberships
  ADD COLUMN restricted_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  ADD CONSTRAINT client_memberships_permissions_array_check
    CHECK (
      pg_catalog.jsonb_typeof(permissions) = 'array'
      AND NOT pg_catalog.jsonb_path_exists(
        permissions,
        '$[*] ? (@.type() != "string")'::pg_catalog.jsonpath
      )
    );

ALTER TABLE public.orders
  ADD CONSTRAINT orders_id_client_account_key
    UNIQUE (id, client_account_id),
  ADD CONSTRAINT orders_id_client_account_currency_key
    UNIQUE (id, client_account_id, currency);

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_id_client_account_key
    UNIQUE (id, client_account_id),
  ADD CONSTRAINT invoices_id_client_account_currency_key
    UNIQUE (id, client_account_id, currency),
  ADD CONSTRAINT invoices_order_account_currency_fkey
    FOREIGN KEY (order_id, client_account_id, currency)
    REFERENCES public.orders(id, client_account_id, currency);

ALTER TABLE public.payment_attempts
  ADD CONSTRAINT payment_attempts_id_account_invoice_key
    UNIQUE (id, client_account_id, invoice_id),
  ADD CONSTRAINT payment_attempts_invoice_account_currency_fkey
    FOREIGN KEY (invoice_id, client_account_id, currency)
    REFERENCES public.invoices(id, client_account_id, currency);

ALTER TABLE public.order_items
  ADD COLUMN client_account_id uuid;

UPDATE public.order_items item
SET client_account_id = original_order.client_account_id
FROM public.orders original_order
WHERE original_order.id = item.order_id;

ALTER TABLE public.order_items
  ALTER COLUMN client_account_id SET NOT NULL,
  ADD CONSTRAINT order_items_id_client_account_key
    UNIQUE (id, client_account_id),
  ADD CONSTRAINT order_items_order_account_fkey
    FOREIGN KEY (order_id, client_account_id)
    REFERENCES public.orders(id, client_account_id);

-- Append-only tables keep pre-019 rows as explicitly marked legacy facts.
-- Adding a constant DEFAULT is metadata-only on PostgreSQL 18 and does not
-- fire their immutable UPDATE triggers. Every new INSERT is forced by the
-- relationship trigger to legacy=false plus a derived non-null account id.
ALTER TABLE public.payment_allocations
  ADD COLUMN client_account_id uuid,
  ADD COLUMN schema_019_legacy_relationship boolean NOT NULL DEFAULT true;
ALTER TABLE public.payment_allocations
  ALTER COLUMN schema_019_legacy_relationship SET DEFAULT false,
  ADD CONSTRAINT payment_allocations_schema_019_account_check CHECK (
    (schema_019_legacy_relationship AND client_account_id IS NULL)
    OR (NOT schema_019_legacy_relationship AND client_account_id IS NOT NULL)
  ),
  ADD CONSTRAINT payment_allocations_attempt_invoice_account_fkey
    FOREIGN KEY (payment_attempt_id, client_account_id, invoice_id)
    REFERENCES public.payment_attempts(id, client_account_id, invoice_id),
  ADD CONSTRAINT payment_allocations_invoice_account_fkey
    FOREIGN KEY (invoice_id, client_account_id)
    REFERENCES public.invoices(id, client_account_id);

ALTER TABLE public.service_renewals
  ADD COLUMN client_account_id uuid,
  ADD COLUMN schema_019_legacy_relationship boolean NOT NULL DEFAULT true;
ALTER TABLE public.service_renewals
  ALTER COLUMN schema_019_legacy_relationship SET DEFAULT false,
  ADD CONSTRAINT service_renewals_schema_019_account_check CHECK (
    (schema_019_legacy_relationship AND client_account_id IS NULL)
    OR (NOT schema_019_legacy_relationship AND client_account_id IS NOT NULL)
  ),
  ADD CONSTRAINT service_renewals_service_account_fkey
    FOREIGN KEY (service_id, client_account_id)
    REFERENCES public.services(id, client_account_id),
  ADD CONSTRAINT service_renewals_invoice_account_currency_fkey
    FOREIGN KEY (invoice_id, client_account_id, currency)
    REFERENCES public.invoices(id, client_account_id, currency);

ALTER TABLE public.service_periods
  ADD COLUMN client_account_id uuid,
  ADD COLUMN schema_019_legacy_relationship boolean NOT NULL DEFAULT true;
ALTER TABLE public.service_periods
  ALTER COLUMN schema_019_legacy_relationship SET DEFAULT false,
  ADD CONSTRAINT service_periods_schema_019_account_check CHECK (
    (schema_019_legacy_relationship AND client_account_id IS NULL)
    OR (NOT schema_019_legacy_relationship AND client_account_id IS NOT NULL)
  ),
  ADD CONSTRAINT service_periods_service_account_fkey
    FOREIGN KEY (service_id, client_account_id)
    REFERENCES public.services(id, client_account_id),
  ADD CONSTRAINT service_periods_invoice_account_fkey
    FOREIGN KEY (invoice_id, client_account_id)
    REFERENCES public.invoices(id, client_account_id);

ALTER TABLE public.services
  ADD CONSTRAINT services_order_item_account_fkey
    FOREIGN KEY (order_item_id, client_account_id)
    REFERENCES public.order_items(id, client_account_id);

-- Several relationship tables are intentionally append-only or have immutable
-- financial identity guards in earlier migrations. Backfilling a new column
-- with UPDATE would violate that evidence. Existing rows were validated above;
-- these triggers enforce the same equality for every future INSERT and for any
-- identity UPDATE that an earlier guard permits.
CREATE OR REPLACE FUNCTION public.opensales_validate_account_relationship()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_client_account_id uuid;
  related_client_account_id uuid;
  expected_invoice_id uuid;
  expected_currency text;
  expected_billing_cycle text;
BEGIN
  IF TG_TABLE_NAME = 'order_items' THEN
    SELECT original_order.client_account_id
    INTO expected_client_account_id
    FROM public.orders original_order
    WHERE original_order.id = NEW.order_id;
  ELSIF TG_TABLE_NAME = 'services' THEN
    SELECT original_order.client_account_id, item.billing_cycle
    INTO expected_client_account_id, expected_billing_cycle
    FROM public.order_items item
    JOIN public.orders original_order ON original_order.id = item.order_id
    WHERE item.id = NEW.order_item_id;
  ELSIF TG_TABLE_NAME = 'service_renewals' THEN
    SELECT service.client_account_id, invoice.client_account_id, invoice.currency
    INTO expected_client_account_id, related_client_account_id, expected_currency
    FROM public.services service
    JOIN public.invoices invoice ON invoice.id = NEW.invoice_id
    WHERE service.id = NEW.service_id;
  ELSIF TG_TABLE_NAME = 'service_periods' THEN
    SELECT service.client_account_id, invoice.client_account_id
    INTO expected_client_account_id, related_client_account_id
    FROM public.services service
    JOIN public.invoices invoice ON invoice.id = NEW.invoice_id
    WHERE service.id = NEW.service_id;
  ELSIF TG_TABLE_NAME = 'payment_allocations' THEN
    SELECT attempt.client_account_id, attempt.invoice_id, invoice.client_account_id
    INTO expected_client_account_id, expected_invoice_id, related_client_account_id
    FROM public.payment_attempts attempt
    JOIN public.invoices invoice ON invoice.id = NEW.invoice_id
    WHERE attempt.id = NEW.payment_attempt_id;
  ELSE
    RAISE EXCEPTION 'unsupported account relationship table %', TG_TABLE_NAME;
  END IF;

  IF expected_client_account_id IS NULL THEN
    RAISE EXCEPTION '% source fact was not found', TG_TABLE_NAME;
  END IF;

  IF TG_TABLE_NAME = 'order_items' THEN
    IF NEW.client_account_id IS NULL THEN
      NEW.client_account_id := expected_client_account_id;
    ELSIF NEW.client_account_id <> expected_client_account_id THEN
      RAISE EXCEPTION 'Order Item Client Account does not match its Order';
    END IF;
  ELSIF TG_TABLE_NAME IN (
    'service_renewals', 'service_periods', 'payment_allocations'
  ) THEN
    IF TG_OP = 'INSERT' THEN
      NEW.client_account_id := expected_client_account_id;
      NEW.schema_019_legacy_relationship := false;
    ELSIF NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
       OR NEW.schema_019_legacy_relationship IS DISTINCT FROM
          OLD.schema_019_legacy_relationship THEN
      RAISE EXCEPTION '% Schema 019 account evidence is immutable', TG_TABLE_NAME;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'services' THEN
    IF NEW.client_account_id <> expected_client_account_id
       OR NEW.billing_cycle <> expected_billing_cycle THEN
      RAISE EXCEPTION
        'service Client Account or billing cycle does not match its Order Item and Order';
    END IF;
  ELSIF TG_TABLE_NAME = 'service_renewals' THEN
    IF expected_client_account_id <> related_client_account_id
       OR NEW.currency <> expected_currency
       OR (
         NOT NEW.schema_019_legacy_relationship
         AND NEW.client_account_id <> expected_client_account_id
       ) THEN
      RAISE EXCEPTION 'service renewal Service, Invoice, Client Account, or currency differs';
    END IF;
  ELSIF TG_TABLE_NAME = 'service_periods' THEN
    IF expected_client_account_id <> related_client_account_id
       OR (
         NOT NEW.schema_019_legacy_relationship
         AND NEW.client_account_id <> expected_client_account_id
       ) THEN
      RAISE EXCEPTION 'service period Service and Invoice Client Accounts differ';
    END IF;
  ELSIF TG_TABLE_NAME = 'payment_allocations' THEN
    IF NEW.invoice_id <> expected_invoice_id
       OR expected_client_account_id <> related_client_account_id
       OR (
         NOT NEW.schema_019_legacy_relationship
         AND NEW.client_account_id <> expected_client_account_id
       ) THEN
      RAISE EXCEPTION 'payment allocation Payment Attempt and Invoice facts differ';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_items_fill_client_account ON public.order_items;
CREATE TRIGGER order_items_fill_client_account
BEFORE INSERT OR UPDATE OF order_id, client_account_id ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_account_relationship();

DROP TRIGGER IF EXISTS services_account_relationship_guard ON public.services;
CREATE TRIGGER services_account_relationship_guard
BEFORE INSERT OR UPDATE OF order_item_id, client_account_id, billing_cycle ON public.services
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_account_relationship();

DROP TRIGGER IF EXISTS service_renewals_account_relationship_guard
  ON public.service_renewals;
CREATE TRIGGER service_renewals_account_relationship_guard
BEFORE INSERT OR UPDATE OF
  service_id,
  invoice_id,
  currency,
  client_account_id,
  schema_019_legacy_relationship
ON public.service_renewals
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_account_relationship();

DROP TRIGGER IF EXISTS service_periods_account_relationship_guard
  ON public.service_periods;
CREATE TRIGGER service_periods_account_relationship_guard
BEFORE INSERT OR UPDATE OF
  service_id,
  invoice_id,
  client_account_id,
  schema_019_legacy_relationship
ON public.service_periods
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_account_relationship();

DROP TRIGGER IF EXISTS payment_allocations_account_relationship_guard
  ON public.payment_allocations;
CREATE TRIGGER payment_allocations_account_relationship_guard
BEFORE INSERT OR UPDATE OF
  payment_attempt_id,
  invoice_id,
  client_account_id,
  schema_019_legacy_relationship
ON public.payment_allocations
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_account_relationship();

CREATE OR REPLACE FUNCTION public.opensales_guard_order_item_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Order Item snapshots are immutable; preserve the historical order fact';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.product_name IS DISTINCT FROM OLD.product_name
     OR NEW.fulfillment_mode IS DISTINCT FROM OLD.fulfillment_mode
     OR NEW.billing_cycle IS DISTINCT FROM OLD.billing_cycle
     OR NEW.configuration IS DISTINCT FROM OLD.configuration
     OR NEW.price_snapshot IS DISTINCT FROM OLD.price_snapshot THEN
    RAISE EXCEPTION
      'Order Item identity and product/price snapshot are immutable; use a compensating fact';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_items_snapshot_immutable ON public.order_items;
CREATE TRIGGER order_items_snapshot_immutable
BEFORE UPDATE OR DELETE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_order_item_snapshot();

CREATE OR REPLACE FUNCTION public.opensales_guard_order_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Orders are historical facts and cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.price_snapshot IS DISTINCT FROM OLD.price_snapshot
     OR NEW.one_time_minor IS DISTINCT FROM OLD.one_time_minor
     OR NEW.setup_minor IS DISTINCT FROM OLD.setup_minor
     OR NEW.recurring_minor IS DISTINCT FROM OLD.recurring_minor
     OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION
      'Order identity, actor, idempotency, and price snapshot are immutable; use a compensating fact';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_snapshot_immutable ON public.orders;
CREATE TRIGGER orders_snapshot_immutable
BEFORE UPDATE OR DELETE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_order_snapshot();

CREATE OR REPLACE FUNCTION public.opensales_guard_service_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Services are historical facts and cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
     OR NEW.billing_cycle IS DISTINCT FROM OLD.billing_cycle THEN
    RAISE EXCEPTION
      'Service identity, Client Account, Order Item, and billing cycle are immutable; use a compensating fact';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS services_identity_immutable ON public.services;
CREATE TRIGGER services_identity_immutable
BEFORE UPDATE OR DELETE ON public.services
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_service_identity();

CREATE OR REPLACE FUNCTION public.opensales_guard_payment_attempt_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment Attempts are historical facts and cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION
      'Payment Attempt identity, Invoice, Client Account, and currency are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_attempts_identity_immutable ON public.payment_attempts;
CREATE TRIGGER payment_attempts_identity_immutable
BEFORE UPDATE OR DELETE ON public.payment_attempts
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_payment_attempt_identity();

CREATE OR REPLACE FUNCTION public.opensales_guard_invoice_header_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice headers are immutable; preserve the historical invoice fact';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.due_at IS DISTINCT FROM OLD.due_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'invoice identity, Client Account, order, currency, due time, and creation time are immutable';
  END IF;

  -- total_minor remains mutable only through the existing append-only fee and
  -- allocation workflows.  This guard protects the immutable PDF header while
  -- preserving those reviewed business transitions.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_header_immutable ON public.invoices;
CREATE TRIGGER invoices_header_immutable
BEFORE UPDATE OR DELETE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_invoice_header_mutation();

CREATE TABLE public.client_membership_invitations (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES public.client_accounts(id),
  email public.citext NOT NULL,
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'zh-CN')),
  role text NOT NULL CHECK (role IN ('owner', 'billing', 'technical', 'viewer')),
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      pg_catalog.jsonb_typeof(permissions) = 'array'
      AND NOT pg_catalog.jsonb_path_exists(
        permissions,
        '$[*] ? (@.type() != "string")'::pg_catalog.jsonpath
      )
    ),
  token_digest bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  invited_by_user_id uuid NOT NULL REFERENCES public.users(id),
  accepted_by_user_id uuid REFERENCES public.users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (expires_at > created_at),
  CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX client_membership_invitations_active_email_idx
  ON public.client_membership_invitations(client_account_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX client_membership_invitations_account_created_idx
  ON public.client_membership_invitations(client_account_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.opensales_guard_membership_invitation_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Membership Invitations are historical facts and cannot be deleted';
  END IF;
  IF OLD.accepted_at IS NOT NULL
     AND (
       NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
       OR NEW.accepted_by_user_id IS DISTINCT FROM OLD.accepted_by_user_id
     ) THEN
    RAISE EXCEPTION 'Accepted Membership Invitations cannot be changed or reopened';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'Revoked Membership Invitations cannot be changed or reopened';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.email::text IS DISTINCT FROM OLD.email::text
     OR NEW.locale IS DISTINCT FROM OLD.locale
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.permissions IS DISTINCT FROM OLD.permissions
     OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.invited_by_user_id IS DISTINCT FROM OLD.invited_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Membership Invitation identity and authorization snapshot are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_membership_invitations_identity_immutable
BEFORE UPDATE OR DELETE ON public.client_membership_invitations
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_membership_invitation_identity();

CREATE TABLE public.client_contacts (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES public.client_accounts(id),
  display_name text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(display_name)) BETWEEN 1 AND 160
  ),
  email public.citext NOT NULL,
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'zh-CN')),
  notification_subscriptions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      pg_catalog.jsonb_typeof(notification_subscriptions) = 'array'
      AND notification_subscriptions <@ '["billing", "service", "support"]'::jsonb
    ),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE public.client_contacts IS
  'Non-authenticating notification contacts. A Contact never grants User, Session, or Membership identity.';

CREATE UNIQUE INDEX client_contacts_active_email_idx
  ON public.client_contacts(client_account_id, email)
  WHERE removed_at IS NULL;

CREATE INDEX client_contacts_account_created_idx
  ON public.client_contacts(client_account_id, created_at, id)
  WHERE removed_at IS NULL;

CREATE OR REPLACE FUNCTION public.opensales_guard_client_contact_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Client Contacts are historical facts and cannot be deleted';
  END IF;
  IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    RAISE EXCEPTION 'Removed Client Contacts cannot be reopened';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Client Contact identity and Client Account are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_contacts_identity_immutable
BEFORE UPDATE OR DELETE ON public.client_contacts
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_client_contact_identity();

DO $$
DECLARE
  invalid_delivery_id uuid;
BEGIN
  SELECT id
  INTO invalid_delivery_id
  FROM public.renewal_reminder_delivery_facts
  WHERE provider_message_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ORDER BY id
  LIMIT 1;
  IF invalid_delivery_id IS NOT NULL THEN
    RAISE EXCEPTION
      'schema 019 refused renewal delivery fact % without a UUID Provider operation',
      invalid_delivery_id;
  END IF;
END;
$$;

-- Schema 012 made delivery rows immutable.  Temporarily remove only that exact
-- reviewed trigger while this forward migration adds deterministic attempt
-- identity, then restore the immutable boundary before any application code
-- can observe Schema 019.
DROP TRIGGER IF EXISTS renewal_reminder_delivery_facts_immutable
  ON public.renewal_reminder_delivery_facts;

ALTER TABLE public.renewal_reminder_delivery_facts
  DROP CONSTRAINT renewal_reminder_delivery_facts_intent_id_key,
  ADD COLUMN attempt_number integer,
  ADD COLUMN provider_operation_id uuid,
  ADD COLUMN failure_reason text;

UPDATE public.renewal_reminder_delivery_facts
SET attempt_number = 1,
    provider_operation_id = provider_message_id::uuid,
    failure_reason = CASE status
      WHEN 'bounced' THEN
        'Legacy Mock Mail Provider reported bounced before Schema 019 retained a reason'
      WHEN 'failed' THEN
        'Legacy Mock Mail Provider reported failed before Schema 019 retained a reason'
      ELSE NULL
    END;

ALTER TABLE public.renewal_reminder_delivery_facts
  ALTER COLUMN attempt_number SET NOT NULL,
  ALTER COLUMN provider_operation_id SET NOT NULL,
  ADD CONSTRAINT renewal_reminder_delivery_facts_attempt_number_check
    CHECK (attempt_number > 0),
  ADD CONSTRAINT renewal_reminder_delivery_facts_intent_attempt_key
    UNIQUE (intent_id, attempt_number),
  ADD CONSTRAINT renewal_reminder_delivery_facts_provider_operation_key
    UNIQUE (provider_operation_id),
  ADD CONSTRAINT renewal_reminder_delivery_facts_failure_reason_check CHECK (
    (status = 'delivered' AND failure_reason IS NULL)
    OR
    (status IN ('bounced', 'failed')
      AND NULLIF(pg_catalog.btrim(failure_reason), '') IS NOT NULL)
  );

COMMENT ON TABLE public.renewal_reminder_delivery_facts IS
  'Immutable append-only Mock Mail attempt outcomes; failed may be followed by a later deterministic attempt.';

CREATE TRIGGER renewal_reminder_delivery_facts_immutable
BEFORE UPDATE OR DELETE ON public.renewal_reminder_delivery_facts
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_service_period_mutation();

CREATE OR REPLACE FUNCTION public.opensales_notification_utf16_sort_key(input text)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  character_index integer;
  code_point integer;
  supplementary integer;
  high_surrogate integer;
  low_surrogate integer;
  encoded text := '';
BEGIN
  IF input = '' THEN
    RETURN ''::bytea;
  END IF;
  FOR character_index IN 1..pg_catalog.char_length(input) LOOP
    code_point := pg_catalog.ascii(
      pg_catalog.substring(input, character_index, 1)
    );
    IF code_point <= 65535 THEN
      encoded := encoded || pg_catalog.lpad(pg_catalog.to_hex(code_point), 4, '0');
    ELSE
      supplementary := code_point - 65536;
      high_surrogate := 55296 + (supplementary >> 10);
      low_surrogate := 56320 + (supplementary & 1023);
      encoded := encoded ||
        pg_catalog.lpad(pg_catalog.to_hex(high_surrogate), 4, '0') ||
        pg_catalog.lpad(pg_catalog.to_hex(low_surrogate), 4, '0');
    END IF;
  END LOOP;
  RETURN pg_catalog.decode(encoded, 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION public.opensales_canonical_notification_jsonb(input jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  result text;
  numeric_value numeric;
BEGIN
  IF pg_catalog.jsonb_typeof(input) = 'object' THEN
    SELECT '{' || COALESCE(
      pg_catalog.string_agg(
        pg_catalog.to_jsonb(item.key)::text || ':' ||
          public.opensales_canonical_notification_jsonb(item.value),
        ',' ORDER BY public.opensales_notification_utf16_sort_key(item.key)
      ),
      ''
    ) || '}'
    INTO result
    FROM pg_catalog.jsonb_each(input) item;
    RETURN result;
  END IF;
  IF pg_catalog.jsonb_typeof(input) = 'array' THEN
    SELECT '[' || COALESCE(
      pg_catalog.string_agg(
        public.opensales_canonical_notification_jsonb(item.value),
        ',' ORDER BY item.ordinality
      ),
      ''
    ) || ']'
    INTO result
    FROM pg_catalog.jsonb_array_elements(input) WITH ORDINALITY item(value, ordinality);
    RETURN result;
  END IF;
  IF pg_catalog.jsonb_typeof(input) = 'number' THEN
    numeric_value := (input #>> '{}')::numeric;
    IF numeric_value <> pg_catalog.trunc(numeric_value)
       OR numeric_value < -9007199254740991
       OR numeric_value > 9007199254740991 THEN
      RAISE EXCEPTION
        'Notification payload numbers must be JavaScript safe integers';
    END IF;
    IF numeric_value = 0 THEN
      RETURN '0';
    END IF;
    RETURN pg_catalog.trim_scale(numeric_value)::text;
  END IF;
  RETURN input::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.opensales_notification_request_fingerprint(
  event_type text,
  template_revision text,
  payload_snapshot jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to('opensales:notification-request:v2', 'UTF8') ||
      pg_catalog.decode('00', 'hex') ||
      pg_catalog.convert_to(event_type, 'UTF8') ||
      pg_catalog.decode('00', 'hex') ||
      pg_catalog.convert_to(template_revision, 'UTF8') ||
      pg_catalog.decode('00', 'hex') ||
      pg_catalog.convert_to(
        public.opensales_canonical_notification_jsonb(payload_snapshot),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION public.opensales_notification_provider_operation_id(
  outbox_id uuid,
  attempt_number integer
)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation_bytes bytea;
  operation_hex text;
BEGIN
  IF attempt_number < 1 THEN
    RAISE EXCEPTION 'Notification attempt number must be positive';
  END IF;
  operation_bytes := pg_catalog.substring(
    public.digest(
      pg_catalog.convert_to(
        'opensales:notification:' || outbox_id::text || ':' || attempt_number::text,
        'UTF8'
      ),
      'sha256'
    ),
    1,
    16
  );
  operation_bytes := pg_catalog.set_byte(
    operation_bytes,
    6,
    (pg_catalog.get_byte(operation_bytes, 6) & 15) | 64
  );
  operation_bytes := pg_catalog.set_byte(
    operation_bytes,
    8,
    (pg_catalog.get_byte(operation_bytes, 8) & 63) | 128
  );
  operation_hex := pg_catalog.encode(operation_bytes, 'hex');
  RETURN (
    pg_catalog.substring(operation_hex, 1, 8) || '-' ||
    pg_catalog.substring(operation_hex, 9, 4) || '-' ||
    pg_catalog.substring(operation_hex, 13, 4) || '-' ||
    pg_catalog.substring(operation_hex, 17, 4) || '-' ||
    pg_catalog.substring(operation_hex, 21, 12)
  )::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION public.opensales_notification_rendered_request_fingerprint(
  rendered_request_snapshot jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to('opensales:mock-mail-rendered-request:v1', 'UTF8') ||
      pg_catalog.decode('00', 'hex') ||
      pg_catalog.convert_to(
        public.opensales_canonical_notification_jsonb(rendered_request_snapshot),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

DO $$
DECLARE
  vector_outbox_id constant uuid := '01234567-89ab-4cde-8f01-23456789abcd';
  vector_payload constant jsonb := pg_catalog.jsonb_build_object(
    'email', 'owner+测试@example.invalid',
    'expiresAt', '2026-01-02T03:04:05.678Z',
    'locale', 'zh-CN',
    'userId', '11111111-2222-4333-8444-555555555555',
    'verificationUrl',
      'https://example.invalid/verify?token=abcdefghijklmnopqrstuvwxyzABCDEFGH123456789'
  );
BEGIN
  IF public.opensales_canonical_notification_jsonb(
       '{"n":1.0,"negativeZero":-0.0}'::jsonb
     ) <> '{"n":1,"negativeZero":0}'
     OR public.opensales_canonical_notification_jsonb(
       pg_catalog.jsonb_build_object('😀', 1, '', 2)
     ) <> '{"😀":1,"":2}' THEN
    RAISE EXCEPTION
      'Schema 019 canonical notification JSON does not match Node number or UTF-16 key ordering';
  END IF;
  IF public.opensales_notification_request_fingerprint(
       'notification.email_verification_requested',
       'email-verification-v1',
       vector_payload
     ) <> '49d71fda6a4fbfb7b8a384ccf3e30e6f34cca5c526ecf2a9bd269ff9adb4adfa' THEN
    RAISE EXCEPTION
      'Schema 019 notification request fingerprint does not match the Node UTF-8 vector';
  END IF;
  IF public.opensales_notification_provider_operation_id(vector_outbox_id, 1)
       <> 'b47cfa74-6b6c-47dd-b34e-cf25aef998cd'::uuid
     OR public.opensales_notification_provider_operation_id(vector_outbox_id, 2)
       <> '3a017c7e-15e3-4274-bec6-178d62173408'::uuid THEN
    RAISE EXCEPTION
      'Schema 019 notification Provider operation ids do not match the Node vectors';
  END IF;
  IF public.opensales_notification_rendered_request_fingerprint(
       pg_catalog.jsonb_build_object(
         'recipient', 'owner+test@example.invalid',
         'template', 'renewal-pre-due-v1',
         'locale', 'zh-CN',
         'subject', '续费发票将在 7 天后到期',
         'body', E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n当前应付：USD 123.45',
         'sensitive', false,
         'scenario', 'bounced'
       )
     ) <> '1712517c53def3a62ff48eaca312b93c8986f54cfa62b90929d95e59c54f6c18' THEN
    RAISE EXCEPTION
      'Schema 019 rendered Mock Mail fingerprint does not match the Node vector';
  END IF;
END;
$$;

CREATE TABLE public.notification_delivery_operations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES public.outbox(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  provider_operation_id uuid NOT NULL UNIQUE,
  provider_installation_id text NOT NULL,
  operation_origin text NOT NULL DEFAULT 'application'
    CHECK (operation_origin IN ('application', 'schema_019_backfill')),
  event_type text NOT NULL CHECK (event_type ~ '^notification\.'),
  template_revision text NOT NULL
    CHECK (template_revision ~ '^[a-z0-9][a-z0-9_-]{2,79}$'),
  payload_snapshot jsonb NOT NULL
    CHECK (pg_catalog.jsonb_typeof(payload_snapshot) = 'object'),
  rendered_request_snapshot jsonb
    CHECK (
      rendered_request_snapshot IS NULL
      OR pg_catalog.jsonb_typeof(rendered_request_snapshot) = 'object'
    ),
  rendered_request_fingerprint text
    CHECK (
      rendered_request_fingerprint IS NULL
      OR rendered_request_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  invitation_id uuid REFERENCES public.client_membership_invitations(id),
  contact_id uuid REFERENCES public.client_contacts(id),
  recipient_user_id uuid REFERENCES public.users(id),
  client_account_id uuid REFERENCES public.client_accounts(id),
  recipient_subject_id uuid NOT NULL,
  recipient_scope_id uuid NOT NULL,
  recipient_kind text NOT NULL
    CHECK (recipient_kind IN ('identity_user', 'invitation', 'contact', 'account_user')),
  category text NOT NULL
    CHECK (category IN ('identity', 'membership_invitation', 'billing', 'service', 'support')),
  recipient citext NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  request_fingerprint text NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'dispatching', 'unknown', 'succeeded', 'failed', 'skipped', 'manual')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  dispatch_started_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (
    (rendered_request_snapshot IS NULL AND rendered_request_fingerprint IS NULL)
    OR
    (rendered_request_snapshot IS NOT NULL
      AND rendered_request_snapshot ?& ARRAY[
        'recipient', 'template', 'locale', 'subject',
        'body', 'sensitive', 'scenario'
      ]
      AND rendered_request_snapshot - ARRAY[
        'recipient', 'template', 'locale', 'subject',
        'body', 'sensitive', 'scenario'
      ] = '{}'::jsonb
      AND pg_catalog.jsonb_typeof(rendered_request_snapshot -> 'recipient') = 'string'
      AND rendered_request_snapshot ->> 'recipient' = recipient::text
      AND pg_catalog.char_length(rendered_request_snapshot ->> 'recipient')
        BETWEEN 3 AND 320
      AND pg_catalog.jsonb_typeof(rendered_request_snapshot -> 'template') = 'string'
      AND pg_catalog.char_length(rendered_request_snapshot ->> 'template')
        BETWEEN 1 AND 120
      AND (
        rendered_request_snapshot ->> 'template' = template_revision
        OR
        (template_revision = 'email-verification-v1'
          AND rendered_request_snapshot ->> 'template' = 'email-verification')
      )
      AND pg_catalog.jsonb_typeof(rendered_request_snapshot -> 'locale') = 'string'
      AND rendered_request_snapshot ->> 'locale' = locale
      AND pg_catalog.jsonb_typeof(rendered_request_snapshot -> 'subject') = 'string'
      AND pg_catalog.char_length(rendered_request_snapshot ->> 'subject')
        BETWEEN 1 AND 240
      AND pg_catalog.jsonb_typeof(rendered_request_snapshot -> 'body') = 'string'
      AND pg_catalog.char_length(rendered_request_snapshot ->> 'body')
        BETWEEN 1 AND 20000
      AND pg_catalog.jsonb_typeof(rendered_request_snapshot -> 'sensitive') = 'boolean'
      AND pg_catalog.jsonb_typeof(rendered_request_snapshot -> 'scenario') = 'string'
      AND rendered_request_snapshot ->> 'scenario'
        IN ('delivered', 'bounced', 'failed')
      AND rendered_request_fingerprint =
        public.opensales_notification_rendered_request_fingerprint(
          rendered_request_snapshot
        ))
  ),
  CHECK (
    (category = 'identity'
      AND recipient_kind = 'identity_user'
      AND invitation_id IS NULL
      AND contact_id IS NULL
      AND recipient_user_id IS NOT NULL
      AND client_account_id IS NULL
      AND recipient_subject_id = recipient_user_id
      AND recipient_scope_id = recipient_user_id)
    OR
    (category = 'membership_invitation'
      AND recipient_kind = 'invitation'
      AND invitation_id IS NOT NULL
      AND contact_id IS NULL
      AND recipient_user_id IS NULL
      AND client_account_id IS NOT NULL
      AND recipient_subject_id = invitation_id
      AND recipient_scope_id = client_account_id)
    OR
    (category IN ('billing', 'service', 'support')
      AND recipient_kind = 'contact'
      AND invitation_id IS NULL
      AND contact_id IS NOT NULL
      AND recipient_user_id IS NULL
      AND client_account_id IS NOT NULL
      AND recipient_subject_id = contact_id
      AND recipient_scope_id = client_account_id)
    OR
    (category IN ('billing', 'service', 'support')
      AND recipient_kind = 'account_user'
      AND invitation_id IS NULL
      AND contact_id IS NULL
      AND recipient_user_id IS NOT NULL
      AND client_account_id IS NOT NULL
      AND recipient_subject_id = recipient_user_id
      AND recipient_scope_id = client_account_id)
  ),
  UNIQUE (outbox_id, attempt_number),
  UNIQUE (
    outbox_id, attempt_number, provider_operation_id,
    recipient_kind, category, recipient_subject_id, recipient_scope_id,
    recipient, locale
  )
);

COMMENT ON TABLE public.notification_delivery_operations IS
  'Mutable Mock Mail dispatch and reconciliation state; provider_operation_id remains stable across unknown-result recovery for one attempt.';

CREATE INDEX notification_delivery_operations_status_updated_idx
  ON public.notification_delivery_operations(status, updated_at, id);
CREATE INDEX notification_delivery_operations_account_created_idx
  ON public.notification_delivery_operations(
    client_account_id,
    created_at DESC,
    id DESC
  )
  WHERE client_account_id IS NOT NULL;
CREATE UNIQUE INDEX notification_delivery_operations_verification_token_key
  ON public.notification_delivery_operations(
    (payload_snapshot ->> 'verificationTokenId')
  )
  WHERE event_type = 'notification.email_verification_requested'
    AND attempt_number = 1
    AND payload_snapshot ? 'verificationTokenId';

CREATE OR REPLACE FUNCTION public.opensales_validate_notification_delivery_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  recipient_is_valid boolean;
  first_snapshot public.notification_delivery_operations%ROWTYPE;
  previous_status text;
  previous_failed_fact boolean;
  outbox_event_type text;
  outbox_payload jsonb;
  legacy_job_potentially_sent boolean;
  legacy_terminal_evidence boolean;
BEGIN
  SELECT event.event_type, event.payload
  INTO outbox_event_type, outbox_payload
  FROM public.outbox event
  WHERE event.id = NEW.outbox_id
  FOR SHARE;
  IF outbox_event_type IS NULL
     OR NEW.event_type IS DISTINCT FROM outbox_event_type
     OR NEW.payload_snapshot IS DISTINCT FROM outbox_payload
     OR NEW.request_fingerprint IS DISTINCT FROM
       public.opensales_notification_request_fingerprint(
         NEW.event_type,
         NEW.template_revision,
         NEW.payload_snapshot
       ) THEN
    RAISE EXCEPTION
      'Notification delivery operation must preserve its exact outbox, template, and request fingerprint';
  END IF;

  IF NEW.attempt_number > 1 THEN
    SELECT operation.*
    INTO first_snapshot
    FROM public.notification_delivery_operations operation
    WHERE operation.outbox_id = NEW.outbox_id
      AND operation.attempt_number = 1
    FOR SHARE;

    SELECT operation.status,
           EXISTS (
             SELECT 1
             FROM public.notification_delivery_facts fact
             WHERE fact.outbox_id = operation.outbox_id
               AND fact.attempt_number = operation.attempt_number
               AND fact.provider_operation_id = operation.provider_operation_id
               AND fact.status = 'failed'
           )
    INTO previous_status, previous_failed_fact
    FROM public.notification_delivery_operations operation
    WHERE operation.outbox_id = NEW.outbox_id
      AND operation.attempt_number = NEW.attempt_number - 1
    FOR SHARE;

    IF first_snapshot.id IS NULL
       OR previous_status IS DISTINCT FROM 'failed'
       OR NOT COALESCE(previous_failed_fact, false) THEN
      RAISE EXCEPTION
        'A later notification attempt requires the same outbox first snapshot and an immutable failed preceding fact';
    END IF;
    IF NEW.operation_origin IS DISTINCT FROM first_snapshot.operation_origin
       OR NEW.event_type IS DISTINCT FROM first_snapshot.event_type
       OR NEW.template_revision IS DISTINCT FROM first_snapshot.template_revision
       OR NEW.payload_snapshot IS DISTINCT FROM first_snapshot.payload_snapshot
       OR NEW.provider_installation_id IS DISTINCT FROM first_snapshot.provider_installation_id
       OR NEW.invitation_id IS DISTINCT FROM first_snapshot.invitation_id
       OR NEW.contact_id IS DISTINCT FROM first_snapshot.contact_id
       OR NEW.recipient_user_id IS DISTINCT FROM first_snapshot.recipient_user_id
       OR NEW.client_account_id IS DISTINCT FROM first_snapshot.client_account_id
       OR NEW.recipient_subject_id IS DISTINCT FROM first_snapshot.recipient_subject_id
       OR NEW.recipient_scope_id IS DISTINCT FROM first_snapshot.recipient_scope_id
       OR NEW.recipient_kind IS DISTINCT FROM first_snapshot.recipient_kind
       OR NEW.category IS DISTINCT FROM first_snapshot.category
       OR NEW.recipient::text IS DISTINCT FROM first_snapshot.recipient::text
       OR NEW.locale IS DISTINCT FROM first_snapshot.locale
       OR NEW.request_fingerprint IS DISTINCT FROM first_snapshot.request_fingerprint THEN
      RAISE EXCEPTION
        'A later notification attempt must preserve the event-time recipient and request snapshot';
    END IF;
  END IF;

  IF NEW.recipient_kind = 'identity_user' THEN
    SELECT principal.email = NEW.recipient AND principal.locale = NEW.locale
    INTO recipient_is_valid
    FROM public.users principal
    WHERE principal.id = NEW.recipient_user_id;
  ELSIF NEW.recipient_kind = 'invitation' THEN
    SELECT invitation.client_account_id = NEW.client_account_id
       AND invitation.email = NEW.recipient
       AND invitation.locale = NEW.locale
       AND invitation.accepted_at IS NULL
       AND invitation.revoked_at IS NULL
       AND invitation.expires_at > pg_catalog.now()
    INTO recipient_is_valid
    FROM public.client_membership_invitations invitation
    WHERE invitation.id = NEW.invitation_id;
  ELSIF NEW.recipient_kind = 'contact' THEN
    SELECT contact.client_account_id = NEW.client_account_id
       AND contact.email = NEW.recipient
       AND contact.locale = NEW.locale
       AND contact.removed_at IS NULL
       AND contact.notification_subscriptions ? NEW.category
    INTO recipient_is_valid
    FROM public.client_contacts contact
    WHERE contact.id = NEW.contact_id;
  ELSIF NEW.recipient_kind = 'account_user' THEN
    SELECT principal.email = NEW.recipient
       AND principal.locale = NEW.locale
       AND principal.email_verified_at IS NOT NULL
       AND principal.restricted_at IS NULL
       AND membership.removed_at IS NULL
       AND membership.restricted_at IS NULL
    INTO recipient_is_valid
    FROM public.users principal
    JOIN public.client_memberships membership
      ON membership.user_id = principal.id
     AND membership.client_account_id = NEW.client_account_id
    WHERE principal.id = NEW.recipient_user_id;
  ELSE
    recipient_is_valid := false;
  END IF;

  IF NEW.attempt_number = 1 THEN
    IF NEW.operation_origin = 'schema_019_backfill' AND NEW.status = 'unknown' THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.durable_jobs job
        JOIN public.outbox event ON event.id = NEW.outbox_id
        WHERE job.job_type = 'notification.send'
          AND job.unique_key = 'outbox:' || NEW.outbox_id::text
          AND job.payload = pg_catalog.jsonb_build_object(
            'outboxId', NEW.outbox_id::text
          )
          AND job.attempts > 0
          AND job.status IN ('pending', 'running', 'manual', 'completed')
          AND (
            (job.status = 'running'
              AND job.locked_at IS NOT NULL AND job.locked_by IS NOT NULL)
            OR
            (job.status <> 'running'
              AND job.locked_at IS NULL AND job.locked_by IS NULL)
          )
          AND (
            (event.event_type IN (
               'notification.email_verification_requested',
               'notification.service_cancellation_scheduled'
             )
             AND (
               (event.published_at IS NULL
                 AND job.status IN ('pending', 'running', 'manual'))
               OR
               (event.published_at IS NOT NULL
                 AND job.status IN ('pending', 'running', 'manual', 'completed'))
             ))
            OR
            (event.event_type = 'notification.renewal_reminder_requested'
             AND event.published_at IS NULL
             AND (
               job.status IN ('pending', 'running', 'manual')
               OR
               (job.status = 'completed' AND EXISTS (
                 SELECT 1
                 FROM public.renewal_reminder_intents reminder
                 JOIN public.renewal_reminder_suppressions suppression
                   ON suppression.intent_id = reminder.id
                 WHERE reminder.outbox_id = event.id
               ))
             )
             AND NOT EXISTS (
               SELECT 1
               FROM public.renewal_reminder_delivery_facts delivery
               WHERE delivery.intent_id = (
                 SELECT reminder.id
                 FROM public.renewal_reminder_intents reminder
                 WHERE reminder.outbox_id = event.id
               )
             )
             -- A suppression may have been recorded only after an earlier
             -- response-lost attempt.  attempts>0 therefore remains unknown
             -- and must reconcile the old outbox Provider operation first.
            )
          )
      )
      INTO legacy_job_potentially_sent;
      IF NOT COALESCE(legacy_job_potentially_sent, false)
         OR NEW.provider_operation_id <> NEW.outbox_id THEN
        RAISE EXCEPTION
          'A migrated unknown notification requires exact potentially-sent legacy job evidence and its old outbox operation id';
      END IF;
    ELSIF NEW.operation_origin = 'schema_019_backfill'
          AND NEW.status = 'queued' THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.durable_jobs job
        JOIN public.outbox event ON event.id = NEW.outbox_id
        WHERE job.job_type = 'notification.send'
          AND job.unique_key = 'outbox:' || NEW.outbox_id::text
          AND job.payload = pg_catalog.jsonb_build_object(
            'outboxId', NEW.outbox_id::text
          )
          AND job.status = 'pending'
          AND job.attempts = 0
          AND job.locked_at IS NULL
          AND job.locked_by IS NULL
          AND event.published_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.renewal_reminder_intents reminder
            JOIN public.renewal_reminder_delivery_facts delivery
              ON delivery.intent_id = reminder.id
            WHERE reminder.outbox_id = event.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.renewal_reminder_intents reminder
            JOIN public.renewal_reminder_suppressions suppression
              ON suppression.intent_id = reminder.id
            WHERE reminder.outbox_id = event.id
          )
      )
      INTO legacy_job_potentially_sent;
      IF NOT COALESCE(legacy_job_potentially_sent, false)
         OR NEW.provider_operation_id <>
           public.opensales_notification_provider_operation_id(NEW.outbox_id, 1)
         OR NOT COALESCE(recipient_is_valid, false) THEN
        RAISE EXCEPTION
          'A migrated queued notification requires exact known-unsent evidence and a live recipient';
      END IF;
    ELSIF NEW.operation_origin = 'schema_019_backfill'
          AND NEW.status = 'skipped' THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.durable_jobs job
        JOIN public.outbox event ON event.id = NEW.outbox_id
        WHERE job.job_type = 'notification.send'
          AND job.unique_key = 'outbox:' || NEW.outbox_id::text
          AND job.payload = pg_catalog.jsonb_build_object(
            'outboxId', NEW.outbox_id::text
          )
          AND event.published_at IS NULL
          AND (
            (job.status = 'pending'
              AND job.attempts = 0
              AND job.locked_at IS NULL
              AND job.locked_by IS NULL
              AND NEW.provider_operation_id =
                public.opensales_notification_provider_operation_id(
                  NEW.outbox_id,
                  1
                )
              AND (
                NOT COALESCE(recipient_is_valid, false)
                OR EXISTS (
                  SELECT 1
                  FROM public.renewal_reminder_intents reminder
                  JOIN public.renewal_reminder_suppressions suppression
                    ON suppression.intent_id = reminder.id
                  WHERE reminder.outbox_id = event.id
                )
                OR (
                  event.event_type = 'notification.email_verification_requested'
                  AND EXISTS (
                    SELECT 1
                    FROM public.users principal
                    JOIN public.email_verification_tokens token
                      ON token.user_id = principal.id
                     AND token.token_digest = public.digest(
                       pg_catalog.convert_to(
                         pg_catalog.substring(
                           event.payload ->> 'verificationUrl',
                           '[?]token=([A-Za-z0-9_-]{43})$'
                         ),
                         'UTF8'
                       ),
                       'sha256'
                     )
                    WHERE principal.id = NEW.recipient_user_id
                      AND principal.email::text = NEW.recipient::text
                      AND principal.locale = NEW.locale
                      AND (
                        principal.email_verified_at IS NOT NULL
                        OR principal.restricted_at IS NOT NULL
                        OR token.used_at IS NOT NULL
                        OR token.invalidated_at IS NOT NULL
                        OR token.expires_at <= pg_catalog.now()
                      )
                  )
                )
              ))
            OR
            (event.event_type = 'notification.renewal_reminder_requested'
              AND job.status = 'completed'
              AND job.attempts > 0
              AND job.locked_at IS NULL
              AND job.locked_by IS NULL
              AND NEW.provider_operation_id = NEW.outbox_id
              AND EXISTS (
                SELECT 1
                FROM public.renewal_reminder_intents reminder
                JOIN public.renewal_reminder_suppressions suppression
                  ON suppression.intent_id = reminder.id
                WHERE reminder.outbox_id = event.id
              ))
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.renewal_reminder_intents reminder
            JOIN public.renewal_reminder_delivery_facts delivery
              ON delivery.intent_id = reminder.id
            WHERE reminder.outbox_id = event.id
          )
      )
      INTO legacy_terminal_evidence;
      IF NOT COALESCE(legacy_terminal_evidence, false) THEN
        RAISE EXCEPTION
          'A migrated skipped notification requires exact known-unsent or renewal suppression evidence';
      END IF;
    ELSIF NEW.operation_origin = 'schema_019_backfill'
          AND NEW.status IN ('succeeded', 'failed') THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.renewal_reminder_intents reminder
        JOIN public.renewal_reminder_delivery_facts delivery
          ON delivery.intent_id = reminder.id
        JOIN public.outbox event ON event.id = reminder.outbox_id
        JOIN public.durable_jobs job
          ON job.job_type = 'notification.send'
         AND job.unique_key = 'outbox:' || event.id::text
         AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
        WHERE event.id = NEW.outbox_id
          AND event.event_type = 'notification.renewal_reminder_requested'
          AND event.published_at IS NOT NULL
          AND job.status = 'completed'
          AND job.attempts > 0
          AND job.locked_at IS NULL
          AND job.locked_by IS NULL
          AND delivery.provider_operation_id = NEW.provider_operation_id
          AND delivery.provider_installation_id = NEW.provider_installation_id
          AND (
            (NEW.status = 'succeeded' AND delivery.status IN ('delivered', 'bounced'))
            OR
            (NEW.status = 'failed' AND delivery.status = 'failed')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.renewal_reminder_suppressions suppression
            WHERE suppression.intent_id = reminder.id
          )
      )
      INTO legacy_terminal_evidence;
      IF NOT COALESCE(legacy_terminal_evidence, false) THEN
        RAISE EXCEPTION
          'A migrated terminal notification requires its exact legacy renewal Provider fact';
      END IF;
    ELSIF NEW.operation_origin = 'application'
          AND (
            (COALESCE(recipient_is_valid, false) AND NEW.status <> 'queued')
            OR
            (NOT COALESCE(recipient_is_valid, false) AND NEW.status <> 'skipped')
          ) THEN
      RAISE EXCEPTION
        'A new notification must queue a live recipient or terminally skip an ineligible recipient';
    ELSIF NEW.operation_origin NOT IN ('application', 'schema_019_backfill') THEN
      RAISE EXCEPTION 'Unknown notification operation origin';
    END IF;
  ELSIF COALESCE(recipient_is_valid, false) AND NEW.status <> 'queued' THEN
    RAISE EXCEPTION
      'A currently eligible notification recipient may begin a later attempt only as queued';
  END IF;
  IF NEW.attempt_number > 1
     AND NOT COALESCE(recipient_is_valid, false)
     AND NEW.status <> 'skipped' THEN
    RAISE EXCEPTION
      'An ineligible notification recipient may create only a terminal skipped attempt';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_delivery_operations_recipient_guard
BEFORE INSERT ON public.notification_delivery_operations
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_notification_delivery_operation();

CREATE OR REPLACE FUNCTION public.opensales_guard_notification_delivery_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Notification delivery operations cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id
     OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
     OR NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id
     OR NEW.provider_installation_id IS DISTINCT FROM OLD.provider_installation_id
     OR NEW.operation_origin IS DISTINCT FROM OLD.operation_origin
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.template_revision IS DISTINCT FROM OLD.template_revision
     OR NEW.payload_snapshot IS DISTINCT FROM OLD.payload_snapshot
     OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
     OR NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.recipient_subject_id IS DISTINCT FROM OLD.recipient_subject_id
     OR NEW.recipient_scope_id IS DISTINCT FROM OLD.recipient_scope_id
     OR NEW.recipient_kind IS DISTINCT FROM OLD.recipient_kind
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.recipient::text IS DISTINCT FROM OLD.recipient::text
     OR NEW.locale IS DISTINCT FROM OLD.locale
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Notification delivery operation identity is immutable';
  END IF;
  IF OLD.rendered_request_snapshot IS NOT NULL
     AND (
       NEW.rendered_request_snapshot IS DISTINCT FROM OLD.rendered_request_snapshot
       OR NEW.rendered_request_fingerprint IS DISTINCT FROM OLD.rendered_request_fingerprint
     ) THEN
    RAISE EXCEPTION
      'Rendered notification Provider request is immutable once recorded';
  END IF;
  IF OLD.rendered_request_snapshot IS NULL
     AND NEW.rendered_request_snapshot IS NOT NULL
     AND NOT (
       OLD.status IN ('queued', 'unknown')
       AND NEW.status = 'dispatching'
     ) THEN
    RAISE EXCEPTION
      'Rendered notification Provider request may be fixed only when dispatch begins';
  END IF;
  IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'Notification delivery attempts must advance at most once per transition';
  END IF;
  IF NEW.attempts = OLD.attempts + 1 AND NEW.status <> 'dispatching' THEN
    RAISE EXCEPTION 'A notification delivery attempt may advance only while dispatching';
  END IF;
  IF NEW.status = 'dispatching'
     AND OLD.status <> 'dispatching'
     AND (
       NEW.attempts <> OLD.attempts + 1
       OR NEW.dispatch_started_at IS NULL
       OR NEW.rendered_request_snapshot IS NULL
     ) THEN
    RAISE EXCEPTION
      'Dispatching requires one new attempt, start time, and immutable rendered request';
  END IF;
  IF NEW.status IN ('succeeded', 'failed')
     AND NEW.rendered_request_snapshot IS NULL
     AND NOT (
       NEW.operation_origin = 'schema_019_backfill'
       AND OLD.status = 'unknown'
     ) THEN
    RAISE EXCEPTION
      'A Provider delivery outcome requires its immutable rendered request';
  END IF;
  IF OLD.dispatch_started_at IS NOT NULL
     AND NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at THEN
    RAISE EXCEPTION 'Notification delivery dispatch start time is immutable once recorded';
  END IF;
  IF OLD.last_checked_at IS NOT NULL
     AND (NEW.last_checked_at IS NULL OR NEW.last_checked_at < OLD.last_checked_at) THEN
    RAISE EXCEPTION 'Notification delivery last checked time cannot move backwards';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Notification delivery updated time cannot move backwards';
  END IF;
  IF OLD.status IN ('succeeded', 'failed', 'skipped', 'manual')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Terminal notification delivery operations cannot be reopened';
  END IF;
  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'queued' AND NEW.status IN ('dispatching', 'skipped', 'manual'))
    OR (OLD.status = 'dispatching' AND NEW.status IN ('unknown', 'succeeded', 'failed', 'manual'))
    OR (OLD.status = 'unknown' AND NEW.status IN ('dispatching', 'succeeded', 'failed', 'skipped', 'manual'))
  ) THEN
    RAISE EXCEPTION 'Invalid notification delivery operation status transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_delivery_operations_guard
BEFORE UPDATE OR DELETE ON public.notification_delivery_operations
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_notification_delivery_operation();

CREATE TABLE public.notification_delivery_facts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES public.outbox(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  invitation_id uuid REFERENCES public.client_membership_invitations(id),
  contact_id uuid REFERENCES public.client_contacts(id),
  recipient_user_id uuid REFERENCES public.users(id),
  client_account_id uuid REFERENCES public.client_accounts(id),
  recipient_subject_id uuid NOT NULL,
  recipient_scope_id uuid NOT NULL,
  recipient_kind text NOT NULL
    CHECK (recipient_kind IN ('identity_user', 'invitation', 'contact', 'account_user')),
  category text NOT NULL
    CHECK (category IN ('identity', 'membership_invitation', 'billing', 'service', 'support')),
  recipient citext NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  provider_installation_id text,
  provider_operation_id uuid NOT NULL UNIQUE,
  provider_message_id text,
  status text NOT NULL CHECK (status IN ('delivered', 'bounced', 'failed', 'skipped')),
  failure_reason text,
  provider_occurred_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (
    (category = 'identity'
      AND recipient_kind = 'identity_user'
      AND invitation_id IS NULL
      AND contact_id IS NULL
      AND recipient_user_id IS NOT NULL
      AND client_account_id IS NULL
      AND recipient_subject_id = recipient_user_id
      AND recipient_scope_id = recipient_user_id)
    OR
    (category = 'membership_invitation'
      AND recipient_kind = 'invitation'
      AND invitation_id IS NOT NULL
      AND contact_id IS NULL
      AND recipient_user_id IS NULL
      AND client_account_id IS NOT NULL
      AND recipient_subject_id = invitation_id
      AND recipient_scope_id = client_account_id)
    OR
    (category IN ('billing', 'service', 'support')
      AND recipient_kind = 'contact'
      AND invitation_id IS NULL
      AND contact_id IS NOT NULL
      AND recipient_user_id IS NULL
      AND client_account_id IS NOT NULL
      AND recipient_subject_id = contact_id
      AND recipient_scope_id = client_account_id)
    OR
    (category IN ('billing', 'service', 'support')
      AND recipient_kind = 'account_user'
      AND invitation_id IS NULL
      AND contact_id IS NULL
      AND recipient_user_id IS NOT NULL
      AND client_account_id IS NOT NULL
      AND recipient_subject_id = recipient_user_id
      AND recipient_scope_id = client_account_id)
  ),
  CHECK (
    (status = 'skipped' AND provider_installation_id IS NULL
      AND provider_message_id IS NULL AND provider_occurred_at IS NULL)
    OR
    (status IN ('delivered', 'bounced', 'failed')
      AND provider_installation_id IS NOT NULL
      AND provider_operation_id IS NOT NULL
      AND provider_message_id IS NOT NULL
      AND provider_occurred_at IS NOT NULL)
  ),
  UNIQUE (outbox_id, attempt_number),
  FOREIGN KEY (
    outbox_id, attempt_number, provider_operation_id,
    recipient_kind, category, recipient_subject_id, recipient_scope_id,
    recipient, locale
  )
    REFERENCES public.notification_delivery_operations(
      outbox_id, attempt_number, provider_operation_id,
      recipient_kind, category, recipient_subject_id, recipient_scope_id,
      recipient, locale
    )
);

COMMENT ON TABLE public.notification_delivery_facts IS
  'Immutable append-only Provider attempt outcomes for invitation, account User, and Contact notifications.';

CREATE INDEX notification_delivery_facts_account_recorded_idx
  ON public.notification_delivery_facts(client_account_id, recorded_at, id);

CREATE OR REPLACE FUNCTION public.opensales_validate_notification_delivery_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation_status text;
  operation_provider_installation_id text;
BEGIN
  SELECT operation.status, operation.provider_installation_id
  INTO operation_status, operation_provider_installation_id
  FROM public.notification_delivery_operations operation
  WHERE operation.outbox_id = NEW.outbox_id
    AND operation.attempt_number = NEW.attempt_number
    AND operation.provider_operation_id = NEW.provider_operation_id
  FOR UPDATE;

  IF operation_status IS NULL THEN
    RAISE EXCEPTION
      'Notification delivery fact requires its exact locked delivery operation';
  END IF;
  IF (NEW.status IN ('delivered', 'bounced') AND operation_status <> 'succeeded')
     OR (NEW.status = 'failed' AND operation_status <> 'failed')
     OR (NEW.status = 'skipped' AND operation_status <> 'skipped') THEN
    RAISE EXCEPTION
      'Notification delivery fact status must match the terminal delivery operation';
  END IF;
  IF NEW.status = 'delivered' AND NEW.failure_reason IS NOT NULL THEN
    RAISE EXCEPTION 'A delivered notification cannot carry a failure reason';
  END IF;
  IF NEW.status IN ('bounced', 'failed', 'skipped')
     AND NULLIF(pg_catalog.btrim(NEW.failure_reason), '') IS NULL THEN
    RAISE EXCEPTION
      'A bounced, failed, or skipped notification requires a failure reason';
  END IF;
  IF NEW.status <> 'skipped'
     AND NEW.provider_installation_id IS DISTINCT FROM operation_provider_installation_id THEN
    RAISE EXCEPTION
      'Notification delivery fact Provider installation must match its operation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_delivery_facts_status_guard
BEFORE INSERT ON public.notification_delivery_facts
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_notification_delivery_fact();

CREATE OR REPLACE FUNCTION public.opensales_reject_notification_delivery_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Notification delivery facts are immutable';
END;
$$;

CREATE TRIGGER notification_delivery_facts_immutable
BEFORE UPDATE OR DELETE ON public.notification_delivery_facts
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_notification_delivery_fact_mutation();

CREATE OR REPLACE FUNCTION public.opensales_validate_terminal_notification_delivery_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_fact_statuses text[];
BEGIN
  IF NEW.status NOT IN ('succeeded', 'failed', 'skipped') THEN
    RETURN NULL;
  END IF;
  expected_fact_statuses := CASE NEW.status
    WHEN 'succeeded' THEN ARRAY['delivered', 'bounced']::text[]
    WHEN 'failed' THEN ARRAY['failed']::text[]
    ELSE ARRAY['skipped']::text[]
  END;
  IF NOT EXISTS (
    SELECT 1
    FROM public.notification_delivery_facts fact
    WHERE fact.outbox_id = NEW.outbox_id
      AND fact.attempt_number = NEW.attempt_number
      AND fact.provider_operation_id = NEW.provider_operation_id
      AND fact.status = ANY(expected_fact_statuses)
  ) THEN
    RAISE EXCEPTION
      'A terminal notification delivery operation requires its exact immutable fact';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER notification_delivery_operations_terminal_fact_guard
AFTER INSERT OR UPDATE OF status ON public.notification_delivery_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_terminal_notification_delivery_fact();

CREATE TABLE public.renewal_notification_dispatch_suppressions (
  intent_id uuid PRIMARY KEY
    REFERENCES public.renewal_reminder_intents(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (
    NULLIF(pg_catalog.btrim(reason), '') IS NOT NULL
    AND pg_catalog.char_length(reason) <= 1000
  ),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE public.renewal_notification_dispatch_suppressions IS
  'Append-only withdrawal of authorization for future Mock Mail POSTs for one renewal reminder intent; existing Provider delivery facts remain authoritative.';

CREATE OR REPLACE FUNCTION public.opensales_reject_renewal_notification_dispatch_suppression_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION
    'Renewal notification dispatch suppressions are append-only';
END;
$$;

CREATE TRIGGER renewal_notification_dispatch_suppressions_immutable
BEFORE UPDATE OR DELETE ON public.renewal_notification_dispatch_suppressions
FOR EACH ROW EXECUTE FUNCTION
  public.opensales_reject_renewal_notification_dispatch_suppression_mutation();

CREATE TEMPORARY TABLE opensales_schema_019_notification_backfill_plan (
  outbox_id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  event_type text NOT NULL,
  template_revision text NOT NULL,
  payload_snapshot jsonb NOT NULL,
  invitation_id uuid,
  contact_id uuid,
  recipient_user_id uuid,
  client_account_id uuid,
  recipient_subject_id uuid NOT NULL,
  recipient_scope_id uuid NOT NULL,
  recipient_kind text NOT NULL,
  category text NOT NULL,
  recipient citext NOT NULL,
  locale text NOT NULL,
  request_fingerprint text NOT NULL,
  attempt_1_provider_operation_id uuid NOT NULL,
  attempt_1_provider_installation_id text NOT NULL,
  attempt_1_status text NOT NULL,
  attempt_1_dispatch_count integer NOT NULL,
  attempt_1_dispatch_started_at timestamptz,
  attempt_1_fact_status text,
  attempt_1_fact_failure_reason text,
  attempt_1_provider_message_id text,
  attempt_1_provider_occurred_at timestamptz,
  attempt_1_fact_recorded_at timestamptz,
  attempt_2_status text,
  job_target_status text NOT NULL,
  clear_published_at boolean NOT NULL DEFAULT false
) ON COMMIT DROP;

DO $$
DECLARE
  invalid_id uuid;
BEGIN
  SELECT event.id
  INTO invalid_id
  FROM public.outbox event
  WHERE event.event_type LIKE 'notification.%'
    AND event.event_type NOT IN (
      'notification.email_verification_requested',
      'notification.renewal_reminder_requested',
      'notification.service_cancellation_scheduled'
    )
  ORDER BY event.id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 019 refused unsupported legacy notification outbox %', invalid_id;
  END IF;

  SELECT job.id
  INTO invalid_id
  FROM public.durable_jobs job
  LEFT JOIN public.outbox event
    ON event.id::text = job.payload ->> 'outboxId'
  WHERE job.job_type = 'notification.send'
    AND NOT (
      pg_catalog.jsonb_typeof(job.payload) = 'object'
      AND job.payload ? 'outboxId'
      AND pg_catalog.jsonb_typeof(job.payload -> 'outboxId') = 'string'
      AND event.id IS NOT NULL
      AND event.event_type IN (
        'notification.email_verification_requested',
        'notification.renewal_reminder_requested',
        'notification.service_cancellation_scheduled'
      )
      AND job.unique_key = 'outbox:' || event.id::text
      AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
    )
  ORDER BY job.id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 019 refused malformed or cross-linked legacy notification job %',
      invalid_id;
  END IF;

  SELECT event.id
  INTO invalid_id
  FROM public.outbox event
  WHERE event.event_type IN (
      'notification.email_verification_requested',
      'notification.renewal_reminder_requested',
      'notification.service_cancellation_scheduled'
    )
    AND (
      SELECT pg_catalog.count(*)
      FROM public.durable_jobs job
      WHERE job.job_type = 'notification.send'
        AND job.unique_key = 'outbox:' || event.id::text
        AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
    ) <> 1
  ORDER BY event.id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 019 requires exactly one durable job for notification outbox %',
      invalid_id;
  END IF;

  SELECT job.id
  INTO invalid_id
  FROM public.durable_jobs job
  JOIN public.outbox event
    ON job.job_type = 'notification.send'
   AND job.unique_key = 'outbox:' || event.id::text
   AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
  WHERE event.event_type IN (
      'notification.email_verification_requested',
      'notification.renewal_reminder_requested',
      'notification.service_cancellation_scheduled'
    )
    AND (
      job.attempts < 0
      OR (job.status = 'running'
        AND (job.attempts = 0 OR job.locked_at IS NULL OR job.locked_by IS NULL))
      OR (job.status <> 'running'
        AND (job.locked_at IS NOT NULL OR job.locked_by IS NOT NULL))
      OR (job.attempts = 0 AND job.status <> 'pending')
      OR job.status = 'failed'
    )
  ORDER BY job.id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 019 refused an impossible legacy notification job state %',
      invalid_id;
  END IF;
END;
$$;

DO $$
DECLARE
  invalid_id uuid;
BEGIN
  WITH verification AS (
    SELECT
      event.id AS outbox_id,
      event.unique_key,
      event.payload,
      event.published_at,
      job.status AS job_status,
      job.attempts AS job_attempts,
      principal.id AS user_id,
      principal.email::text AS user_email,
      principal.locale AS user_locale,
      token.id AS token_id,
      token.expires_at,
      pg_catalog.substring(
        event.payload ->> 'verificationUrl',
        '[?]token=([A-Za-z0-9_-]{43})$'
      ) AS raw_token
    FROM public.outbox event
    JOIN public.durable_jobs job
      ON job.job_type = 'notification.send'
     AND job.unique_key = 'outbox:' || event.id::text
     AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
    LEFT JOIN public.users principal
      ON principal.id::text = event.payload ->> 'userId'
    LEFT JOIN public.email_verification_tokens token
      ON token.user_id = principal.id
     AND token.token_digest = public.digest(
       pg_catalog.convert_to(
         pg_catalog.substring(
           event.payload ->> 'verificationUrl',
           '[?]token=([A-Za-z0-9_-]{43})$'
         ),
         'UTF8'
       ),
       'sha256'
     )
    WHERE event.event_type = 'notification.email_verification_requested'
  )
  SELECT verification.outbox_id
  INTO invalid_id
  FROM verification
  WHERE NOT (
    pg_catalog.jsonb_typeof(verification.payload) = 'object'
    AND verification.payload ?& ARRAY[
      'userId', 'email', 'locale', 'verificationUrl', 'expiresAt'
    ]
    AND verification.payload - ARRAY[
      'userId', 'email', 'locale', 'verificationUrl', 'expiresAt'
    ] = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(verification.payload -> 'userId') = 'string'
    AND verification.payload ->> 'userId'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND pg_catalog.jsonb_typeof(verification.payload -> 'email') = 'string'
    AND pg_catalog.jsonb_typeof(verification.payload -> 'locale') = 'string'
    AND verification.payload ->> 'locale' IN ('en', 'zh-CN')
    AND pg_catalog.jsonb_typeof(verification.payload -> 'verificationUrl') = 'string'
    AND verification.payload ->> 'verificationUrl'
      ~ '/verify[?]token=[A-Za-z0-9_-]{43}$'
    AND pg_catalog.jsonb_typeof(verification.payload -> 'expiresAt') = 'string'
    AND verification.raw_token IS NOT NULL
    AND verification.user_id IS NOT NULL
    AND verification.token_id IS NOT NULL
    AND verification.payload ->> 'userId' = verification.user_id::text
    AND verification.payload ->> 'email' = verification.user_email
    AND verification.payload ->> 'locale' = verification.user_locale
    AND verification.payload ->> 'expiresAt' = pg_catalog.to_char(
      verification.expires_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
    AND verification.unique_key IN (
      'registration:' || verification.user_id::text,
      'verification:' || verification.token_id::text
    )
    AND (
      (verification.published_at IS NULL
       AND (
         (verification.job_status = 'pending' AND verification.job_attempts = 0)
         OR
         (verification.job_status IN ('pending', 'running', 'manual')
           AND verification.job_attempts > 0)
       ))
      OR
      (verification.published_at IS NOT NULL
       AND verification.job_status IN ('pending', 'running', 'manual', 'completed')
       AND verification.job_attempts > 0)
    )
  )
  ORDER BY verification.outbox_id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 019 refused malformed or unbound legacy verification outbox %',
      invalid_id;
  END IF;
END;
$$;

INSERT INTO opensales_schema_019_notification_backfill_plan(
  outbox_id, job_id, event_type, template_revision, payload_snapshot,
  recipient_user_id, recipient_subject_id, recipient_scope_id,
  recipient_kind, category, recipient, locale, request_fingerprint,
  attempt_1_provider_operation_id, attempt_1_provider_installation_id,
  attempt_1_status, attempt_1_dispatch_count,
  attempt_1_dispatch_started_at, attempt_1_fact_status,
  attempt_1_fact_failure_reason, job_target_status
)
SELECT
  event.id,
  job.id,
  event.event_type,
  'email-verification-v1',
  event.payload,
  principal.id,
  principal.id,
  principal.id,
  'identity_user',
  'identity',
  principal.email,
  principal.locale,
  public.opensales_notification_request_fingerprint(
    event.event_type,
    'email-verification-v1',
    event.payload
  ),
  CASE
    WHEN job.attempts > 0 OR event.published_at IS NOT NULL THEN event.id
    ELSE public.opensales_notification_provider_operation_id(event.id, 1)
  END,
  'mock-mail-v1',
  CASE
    WHEN job.attempts > 0 OR event.published_at IS NOT NULL THEN 'unknown'
    WHEN principal.email_verified_at IS NULL
      AND principal.restricted_at IS NULL
      AND token.used_at IS NULL
      AND token.invalidated_at IS NULL
      AND token.expires_at > pg_catalog.now() THEN 'queued'
    ELSE 'skipped'
  END,
  CASE WHEN job.attempts > 0 OR event.published_at IS NOT NULL THEN 1 ELSE 0 END,
  CASE
    WHEN job.attempts > 0 OR event.published_at IS NOT NULL
      THEN COALESCE(job.locked_at, event.published_at, job.updated_at)
    ELSE NULL
  END,
  CASE
    WHEN job.attempts = 0
      AND event.published_at IS NULL
      AND (
        principal.email_verified_at IS NOT NULL
        OR principal.restricted_at IS NOT NULL
        OR token.used_at IS NOT NULL
        OR token.invalidated_at IS NOT NULL
        OR token.expires_at <= pg_catalog.now()
      ) THEN 'skipped'
    ELSE NULL
  END,
  CASE
    WHEN job.attempts = 0
      AND event.published_at IS NULL
      AND (
        principal.email_verified_at IS NOT NULL
        OR principal.restricted_at IS NOT NULL
        OR token.used_at IS NOT NULL
        OR token.invalidated_at IS NOT NULL
        OR token.expires_at <= pg_catalog.now()
      ) THEN 'Legacy verification request was no longer eligible at Schema 019 upgrade'
    ELSE NULL
  END,
  CASE
    WHEN job.attempts > 0 OR event.published_at IS NOT NULL THEN 'pending'
    WHEN principal.email_verified_at IS NULL
      AND principal.restricted_at IS NULL
      AND token.used_at IS NULL
      AND token.invalidated_at IS NULL
      AND token.expires_at > pg_catalog.now() THEN 'pending'
    ELSE 'completed'
  END
FROM public.outbox event
JOIN public.durable_jobs job
  ON job.job_type = 'notification.send'
 AND job.unique_key = 'outbox:' || event.id::text
 AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
JOIN public.users principal ON principal.id::text = event.payload ->> 'userId'
JOIN public.email_verification_tokens token
  ON token.user_id = principal.id
 AND token.token_digest = public.digest(
   pg_catalog.convert_to(
     pg_catalog.substring(
       event.payload ->> 'verificationUrl',
       '[?]token=([A-Za-z0-9_-]{43})$'
     ),
     'UTF8'
   ),
   'sha256'
 )
WHERE event.event_type = 'notification.email_verification_requested';

DO $$
DECLARE
  invalid_id uuid;
BEGIN
  WITH cancellation AS (
    SELECT
      event.id AS outbox_id,
      event.unique_key,
      event.payload,
      event.published_at,
      job.status AS job_status,
      job.attempts AS job_attempts,
      request.id AS request_id,
      request.service_id AS request_service_id,
      request.client_account_id AS request_account_id,
      request.requested_by_user_id,
      request.effective_at,
      service.id AS service_id,
      service.client_account_id AS service_account_id,
      item.product_name,
      execution.execution_mode,
      principal.email::text AS user_email,
      principal.locale AS user_locale
    FROM public.outbox event
    JOIN public.durable_jobs job
      ON job.job_type = 'notification.send'
     AND job.unique_key = 'outbox:' || event.id::text
     AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
    LEFT JOIN public.service_cancellation_requests request
      ON request.id::text = event.payload ->> 'cancellationRequestId'
    LEFT JOIN public.services service ON service.id = request.service_id
    LEFT JOIN public.order_items item ON item.id = service.order_item_id
    LEFT JOIN public.service_cancellation_executions execution
      ON execution.cancellation_request_id = request.id
     AND execution.service_id = service.id
    LEFT JOIN public.users principal ON principal.id = request.requested_by_user_id
    WHERE event.event_type = 'notification.service_cancellation_scheduled'
  )
  SELECT cancellation.outbox_id
  INTO invalid_id
  FROM cancellation
  WHERE NOT (
    pg_catalog.jsonb_typeof(cancellation.payload) = 'object'
    AND cancellation.payload ?& ARRAY[
      'email', 'locale', 'cancellationRequestId', 'serviceId',
      'productName', 'effectiveAt', 'executionMode'
    ]
    AND cancellation.payload - ARRAY[
      'email', 'locale', 'cancellationRequestId', 'serviceId',
      'productName', 'effectiveAt', 'executionMode'
    ] = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(cancellation.payload -> 'email') = 'string'
    AND pg_catalog.jsonb_typeof(cancellation.payload -> 'locale') = 'string'
    AND cancellation.payload ->> 'locale' IN ('en', 'zh-CN')
    AND pg_catalog.jsonb_typeof(
      cancellation.payload -> 'cancellationRequestId'
    ) = 'string'
    AND cancellation.payload ->> 'cancellationRequestId'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND pg_catalog.jsonb_typeof(cancellation.payload -> 'serviceId') = 'string'
    AND cancellation.payload ->> 'serviceId'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND pg_catalog.jsonb_typeof(cancellation.payload -> 'productName') = 'string'
    AND pg_catalog.jsonb_typeof(cancellation.payload -> 'effectiveAt') = 'string'
    AND pg_catalog.jsonb_typeof(cancellation.payload -> 'executionMode') = 'string'
    AND cancellation.payload ->> 'executionMode' IN ('automatic', 'manual')
    AND cancellation.request_id IS NOT NULL
    AND cancellation.service_id IS NOT NULL
    AND cancellation.request_service_id = cancellation.service_id
    AND cancellation.request_account_id = cancellation.service_account_id
    AND cancellation.requested_by_user_id IS NOT NULL
    AND cancellation.payload ->> 'cancellationRequestId' = cancellation.request_id::text
    AND cancellation.payload ->> 'serviceId' = cancellation.service_id::text
    AND cancellation.payload ->> 'email' = cancellation.user_email
    AND cancellation.payload ->> 'locale' = cancellation.user_locale
    AND cancellation.payload ->> 'productName' = cancellation.product_name
    AND cancellation.payload ->> 'effectiveAt' = pg_catalog.to_char(
      cancellation.effective_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
    AND cancellation.payload ->> 'executionMode' = cancellation.execution_mode
    AND cancellation.unique_key =
      'service-cancellation:' || cancellation.request_id::text
    AND (
      (cancellation.published_at IS NULL
       AND (
         (cancellation.job_status = 'pending' AND cancellation.job_attempts = 0)
         OR
         (cancellation.job_status IN ('pending', 'running', 'manual')
           AND cancellation.job_attempts > 0)
       ))
      OR
      (cancellation.published_at IS NOT NULL
       AND cancellation.job_status IN ('pending', 'running', 'manual', 'completed')
       AND cancellation.job_attempts > 0)
    )
  )
  ORDER BY cancellation.outbox_id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 019 refused malformed or unbound legacy service cancellation outbox %',
      invalid_id;
  END IF;
END;
$$;

INSERT INTO opensales_schema_019_notification_backfill_plan(
  outbox_id, job_id, event_type, template_revision, payload_snapshot,
  recipient_user_id, client_account_id,
  recipient_subject_id, recipient_scope_id,
  recipient_kind, category, recipient, locale, request_fingerprint,
  attempt_1_provider_operation_id, attempt_1_provider_installation_id,
  attempt_1_status, attempt_1_dispatch_count,
  attempt_1_dispatch_started_at, attempt_1_fact_status,
  attempt_1_fact_failure_reason, job_target_status
)
SELECT
  event.id,
  job.id,
  event.event_type,
  'service-cancellation-scheduled-v1',
  event.payload,
  principal.id,
  request.client_account_id,
  principal.id,
  request.client_account_id,
  'account_user',
  'service',
  principal.email,
  principal.locale,
  public.opensales_notification_request_fingerprint(
    event.event_type,
    'service-cancellation-scheduled-v1',
    event.payload
  ),
  CASE
    WHEN job.attempts > 0 OR event.published_at IS NOT NULL THEN event.id
    ELSE public.opensales_notification_provider_operation_id(event.id, 1)
  END,
  'mock-mail-v1',
  CASE
    WHEN job.attempts > 0 OR event.published_at IS NOT NULL THEN 'unknown'
    WHEN principal.email_verified_at IS NOT NULL
      AND principal.restricted_at IS NULL
      AND membership.user_id IS NOT NULL
      AND membership.removed_at IS NULL
      AND membership.restricted_at IS NULL THEN 'queued'
    ELSE 'skipped'
  END,
  CASE WHEN job.attempts > 0 OR event.published_at IS NOT NULL THEN 1 ELSE 0 END,
  CASE
    WHEN job.attempts > 0 OR event.published_at IS NOT NULL
      THEN COALESCE(job.locked_at, event.published_at, job.updated_at)
    ELSE NULL
  END,
  CASE
    WHEN job.attempts = 0
      AND event.published_at IS NULL
      AND (
        principal.email_verified_at IS NULL
        OR principal.restricted_at IS NOT NULL
        OR membership.user_id IS NULL
        OR membership.removed_at IS NOT NULL
        OR membership.restricted_at IS NOT NULL
      ) THEN 'skipped'
    ELSE NULL
  END,
  CASE
    WHEN job.attempts = 0
      AND event.published_at IS NULL
      AND (
        principal.email_verified_at IS NULL
        OR principal.restricted_at IS NOT NULL
        OR membership.user_id IS NULL
        OR membership.removed_at IS NOT NULL
        OR membership.restricted_at IS NOT NULL
      ) THEN 'Legacy service notification recipient was no longer eligible at Schema 019 upgrade'
    ELSE NULL
  END,
  CASE
    WHEN job.attempts > 0 OR event.published_at IS NOT NULL THEN 'pending'
    WHEN principal.email_verified_at IS NOT NULL
      AND principal.restricted_at IS NULL
      AND membership.user_id IS NOT NULL
      AND membership.removed_at IS NULL
      AND membership.restricted_at IS NULL THEN 'pending'
    ELSE 'completed'
  END
FROM public.outbox event
JOIN public.durable_jobs job
  ON job.job_type = 'notification.send'
 AND job.unique_key = 'outbox:' || event.id::text
 AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
JOIN public.service_cancellation_requests request
  ON request.id::text = event.payload ->> 'cancellationRequestId'
JOIN public.services service ON service.id = request.service_id
JOIN public.order_items item ON item.id = service.order_item_id
JOIN public.service_cancellation_executions execution
  ON execution.cancellation_request_id = request.id
 AND execution.service_id = service.id
JOIN public.users principal ON principal.id = request.requested_by_user_id
LEFT JOIN public.client_memberships membership
  ON membership.user_id = principal.id
 AND membership.client_account_id = request.client_account_id
WHERE event.event_type = 'notification.service_cancellation_scheduled';

DO $$
DECLARE
  invalid_id uuid;
BEGIN
  WITH renewal AS (
    SELECT
      event.id AS outbox_id,
      event.unique_key,
      event.payload,
      event.published_at,
      job.status AS job_status,
      job.attempts AS job_attempts,
      reminder.id AS intent_id,
      reminder.invoice_id,
      reminder.service_id,
      reminder.kind,
      reminder.offset_days,
      reminder.email::text AS reminder_email,
      reminder.locale AS reminder_locale,
      reminder.due_at,
      reminder.amount_due_minor,
      service_renewal.id AS service_renewal_id,
      service_renewal.currency AS renewal_currency,
      invoice.currency,
      invoice.client_account_id AS invoice_account_id,
      service.client_account_id AS service_account_id,
      account.owner_user_id,
      owner.email::text AS owner_email,
      owner.locale AS owner_locale,
      owner_membership.role AS owner_role,
      owner_membership.removed_at AS owner_removed_at,
      owner_membership.restricted_at AS owner_restricted_at,
      delivery.id AS delivery_id,
      delivery.provider_operation_id AS delivery_provider_operation_id,
      delivery.provider_installation_id AS delivery_provider_installation_id,
      delivery.status AS delivery_status,
      suppression.id AS suppression_id
    FROM public.outbox event
    JOIN public.durable_jobs job
      ON job.job_type = 'notification.send'
     AND job.unique_key = 'outbox:' || event.id::text
     AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
    LEFT JOIN public.renewal_reminder_intents reminder
      ON reminder.outbox_id = event.id
    LEFT JOIN public.invoices invoice ON invoice.id = reminder.invoice_id
    LEFT JOIN public.services service ON service.id = reminder.service_id
    LEFT JOIN public.service_renewals service_renewal
      ON service_renewal.invoice_id = reminder.invoice_id
     AND service_renewal.service_id = reminder.service_id
    LEFT JOIN public.client_accounts account
      ON account.id = invoice.client_account_id
     AND account.id = service.client_account_id
    LEFT JOIN public.users owner ON owner.id = account.owner_user_id
    LEFT JOIN public.client_memberships owner_membership
      ON owner_membership.client_account_id = account.id
     AND owner_membership.user_id = owner.id
    LEFT JOIN public.renewal_reminder_delivery_facts delivery
      ON delivery.intent_id = reminder.id
    LEFT JOIN public.renewal_reminder_suppressions suppression
      ON suppression.intent_id = reminder.id
    WHERE event.event_type = 'notification.renewal_reminder_requested'
  )
  SELECT renewal.outbox_id
  INTO invalid_id
  FROM renewal
  WHERE NOT (
    pg_catalog.jsonb_typeof(renewal.payload) = 'object'
    AND renewal.payload ?& ARRAY[
      'email', 'locale', 'invoiceId', 'serviceId', 'kind',
      'offsetDays', 'currency', 'dueAt', 'amountDueMinor'
    ]
    AND renewal.payload - ARRAY[
      'email', 'locale', 'invoiceId', 'serviceId', 'kind',
      'offsetDays', 'currency', 'dueAt', 'amountDueMinor'
    ] = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(renewal.payload -> 'email') = 'string'
    AND pg_catalog.jsonb_typeof(renewal.payload -> 'locale') = 'string'
    AND renewal.payload ->> 'locale' IN ('en', 'zh-CN')
    AND pg_catalog.jsonb_typeof(renewal.payload -> 'invoiceId') = 'string'
    AND renewal.payload ->> 'invoiceId'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND pg_catalog.jsonb_typeof(renewal.payload -> 'serviceId') = 'string'
    AND renewal.payload ->> 'serviceId'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND pg_catalog.jsonb_typeof(renewal.payload -> 'kind') = 'string'
    AND renewal.payload ->> 'kind'
      IN ('renewal_created', 'pre_due', 'overdue_first')
    AND pg_catalog.jsonb_typeof(renewal.payload -> 'offsetDays') = 'number'
    AND public.opensales_canonical_notification_jsonb(
      renewal.payload -> 'offsetDays'
    ) = renewal.offset_days::text
    AND renewal.offset_days BETWEEN 0 AND 90
    AND pg_catalog.jsonb_typeof(renewal.payload -> 'currency') = 'string'
    AND renewal.payload ->> 'currency' ~ '^[A-Z]{3}$'
    AND pg_catalog.jsonb_typeof(renewal.payload -> 'dueAt') = 'string'
    AND pg_catalog.jsonb_typeof(renewal.payload -> 'amountDueMinor') = 'string'
    AND renewal.payload ->> 'amountDueMinor' ~ '^\d+$'
    AND renewal.intent_id IS NOT NULL
    AND renewal.invoice_account_id IS NOT NULL
    AND renewal.service_account_id = renewal.invoice_account_id
    AND renewal.service_renewal_id IS NOT NULL
    AND renewal.renewal_currency = renewal.currency
    AND renewal.owner_user_id IS NOT NULL
    AND renewal.owner_role = 'owner'
    AND renewal.owner_removed_at IS NULL
    AND renewal.owner_restricted_at IS NULL
    AND renewal.payload ->> 'invoiceId' = renewal.invoice_id::text
    AND renewal.payload ->> 'serviceId' = renewal.service_id::text
    AND renewal.payload ->> 'kind' = renewal.kind
    AND renewal.payload ->> 'email' = renewal.reminder_email
    AND renewal.payload ->> 'email' = renewal.owner_email
    AND renewal.payload ->> 'locale' = renewal.reminder_locale
    AND renewal.payload ->> 'locale' = renewal.owner_locale
    AND renewal.payload ->> 'currency' = renewal.currency
    AND renewal.payload ->> 'dueAt' = pg_catalog.to_char(
      renewal.due_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
    AND renewal.payload ->> 'amountDueMinor' = renewal.amount_due_minor::text
    AND renewal.unique_key =
      'renewal:' || renewal.invoice_id::text || ':' || renewal.kind
    AND NOT (renewal.delivery_id IS NOT NULL AND renewal.suppression_id IS NOT NULL)
    AND (
      renewal.delivery_id IS NULL
      OR (
        renewal.delivery_provider_operation_id = renewal.outbox_id
        AND renewal.delivery_provider_installation_id = 'mock-mail-v1'
      )
    )
    AND (
      (renewal.delivery_id IS NOT NULL
       AND renewal.published_at IS NOT NULL
       AND renewal.job_status = 'completed'
       AND renewal.job_attempts > 0)
      OR
      (renewal.suppression_id IS NOT NULL
       AND renewal.delivery_id IS NULL
       AND renewal.published_at IS NULL
       AND (
         (renewal.job_status = 'pending' AND renewal.job_attempts = 0)
         OR
         (renewal.job_status IN ('pending', 'running', 'manual', 'completed')
           AND renewal.job_attempts > 0)
       ))
      OR
      (renewal.delivery_id IS NULL
       AND renewal.suppression_id IS NULL
       AND renewal.published_at IS NULL
       AND (
         (renewal.job_status = 'pending' AND renewal.job_attempts = 0)
         OR
         (renewal.job_status IN ('pending', 'running', 'manual')
           AND renewal.job_attempts > 0)
       ))
    )
  )
  ORDER BY renewal.outbox_id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 019 refused malformed, ambiguous, or unbound legacy renewal outbox %',
      invalid_id;
  END IF;
END;
$$;

INSERT INTO opensales_schema_019_notification_backfill_plan(
  outbox_id, job_id, event_type, template_revision, payload_snapshot,
  recipient_user_id, client_account_id,
  recipient_subject_id, recipient_scope_id,
  recipient_kind, category, recipient, locale, request_fingerprint,
  attempt_1_provider_operation_id, attempt_1_provider_installation_id,
  attempt_1_status, attempt_1_dispatch_count,
  attempt_1_dispatch_started_at, attempt_1_fact_status,
  attempt_1_fact_failure_reason, attempt_1_provider_message_id,
  attempt_1_provider_occurred_at, attempt_1_fact_recorded_at,
  attempt_2_status, job_target_status, clear_published_at
)
SELECT
  event.id,
  job.id,
  event.event_type,
  'renewal-' || pg_catalog.replace(reminder.kind, '_', '-') || '-v1',
  event.payload,
  owner.id,
  account.id,
  owner.id,
  account.id,
  'account_user',
  'billing',
  owner.email,
  owner.locale,
  public.opensales_notification_request_fingerprint(
    event.event_type,
    'renewal-' || pg_catalog.replace(reminder.kind, '_', '-') || '-v1',
    event.payload
  ),
  CASE
    WHEN delivery.id IS NOT NULL THEN delivery.provider_operation_id
    WHEN job.attempts > 0 THEN event.id
    ELSE public.opensales_notification_provider_operation_id(event.id, 1)
  END,
  COALESCE(delivery.provider_installation_id, 'mock-mail-v1'),
  CASE
    WHEN delivery.status IN ('delivered', 'bounced') THEN 'succeeded'
    WHEN delivery.status = 'failed' THEN 'failed'
    WHEN job.attempts > 0 THEN 'unknown'
    WHEN suppression.id IS NOT NULL THEN 'skipped'
    WHEN owner.email_verified_at IS NOT NULL
      AND owner.restricted_at IS NULL
      AND owner_membership.removed_at IS NULL
      AND owner_membership.restricted_at IS NULL THEN 'queued'
    ELSE 'skipped'
  END,
  CASE
    WHEN delivery.id IS NOT NULL THEN 1
    WHEN job.attempts > 0 THEN 1
    ELSE 0
  END,
  CASE
    WHEN delivery.id IS NOT NULL THEN delivery.provider_occurred_at
    WHEN job.attempts > 0 THEN COALESCE(job.locked_at, job.updated_at)
    ELSE NULL
  END,
  CASE
    WHEN delivery.id IS NOT NULL THEN delivery.status
    WHEN suppression.id IS NOT NULL AND job.attempts = 0 THEN 'skipped'
    WHEN job.attempts = 0
      AND (
        owner.email_verified_at IS NULL
        OR owner.restricted_at IS NOT NULL
        OR owner_membership.removed_at IS NOT NULL
        OR owner_membership.restricted_at IS NOT NULL
      ) THEN 'skipped'
    ELSE NULL
  END,
  CASE
    WHEN delivery.id IS NOT NULL THEN delivery.failure_reason
    WHEN suppression.id IS NOT NULL AND job.attempts = 0 THEN
      'Legacy renewal reminder was suppressed before Provider dispatch'
    WHEN job.attempts = 0
      AND (
        owner.email_verified_at IS NULL
        OR owner.restricted_at IS NOT NULL
        OR owner_membership.removed_at IS NOT NULL
        OR owner_membership.restricted_at IS NOT NULL
      ) THEN 'Legacy renewal recipient was no longer eligible at Schema 019 upgrade'
    ELSE NULL
  END,
  CASE WHEN delivery.id IS NOT NULL THEN delivery.provider_message_id ELSE NULL END,
  CASE WHEN delivery.id IS NOT NULL THEN delivery.provider_occurred_at ELSE NULL END,
  CASE WHEN delivery.id IS NOT NULL THEN delivery.recorded_at ELSE NULL END,
  CASE
    WHEN delivery.status = 'failed'
      AND owner.email_verified_at IS NOT NULL
      AND owner.restricted_at IS NULL
      AND owner_membership.removed_at IS NULL
      AND owner_membership.restricted_at IS NULL THEN 'queued'
    WHEN delivery.status = 'failed' THEN 'skipped'
    ELSE NULL
  END,
  CASE
    WHEN delivery.status = 'failed'
      AND owner.email_verified_at IS NOT NULL
      AND owner.restricted_at IS NULL
      AND owner_membership.removed_at IS NULL
      AND owner_membership.restricted_at IS NULL THEN 'pending'
    WHEN delivery.status = 'failed' THEN 'completed'
    WHEN delivery.id IS NOT NULL THEN 'completed'
    WHEN job.attempts > 0 THEN 'pending'
    WHEN suppression.id IS NOT NULL THEN 'completed'
    WHEN owner.email_verified_at IS NOT NULL
      AND owner.restricted_at IS NULL
      AND owner_membership.removed_at IS NULL
      AND owner_membership.restricted_at IS NULL THEN 'pending'
    ELSE 'completed'
  END,
  COALESCE(
    delivery.status = 'failed'
      AND owner.email_verified_at IS NOT NULL
      AND owner.restricted_at IS NULL
      AND owner_membership.removed_at IS NULL
      AND owner_membership.restricted_at IS NULL,
    false
  )
FROM public.outbox event
JOIN public.durable_jobs job
  ON job.job_type = 'notification.send'
 AND job.unique_key = 'outbox:' || event.id::text
 AND job.payload = pg_catalog.jsonb_build_object('outboxId', event.id::text)
JOIN public.renewal_reminder_intents reminder ON reminder.outbox_id = event.id
JOIN public.invoices invoice ON invoice.id = reminder.invoice_id
JOIN public.services service ON service.id = reminder.service_id
JOIN public.service_renewals service_renewal
  ON service_renewal.invoice_id = reminder.invoice_id
 AND service_renewal.service_id = reminder.service_id
 AND service_renewal.currency = invoice.currency
JOIN public.client_accounts account
  ON account.id = invoice.client_account_id
 AND account.id = service.client_account_id
JOIN public.users owner ON owner.id = account.owner_user_id
JOIN public.client_memberships owner_membership
  ON owner_membership.client_account_id = account.id
 AND owner_membership.user_id = owner.id
LEFT JOIN public.renewal_reminder_delivery_facts delivery
  ON delivery.intent_id = reminder.id
LEFT JOIN public.renewal_reminder_suppressions suppression
  ON suppression.intent_id = reminder.id
WHERE event.event_type = 'notification.renewal_reminder_requested';

DO $$
DECLARE
  planned_count bigint;
  legacy_count bigint;
BEGIN
  SELECT pg_catalog.count(*) INTO planned_count
  FROM opensales_schema_019_notification_backfill_plan;
  SELECT pg_catalog.count(*) INTO legacy_count
  FROM public.outbox event
  WHERE event.event_type IN (
    'notification.email_verification_requested',
    'notification.renewal_reminder_requested',
    'notification.service_cancellation_scheduled'
  );
  IF planned_count <> legacy_count THEN
    RAISE EXCEPTION
      'Schema 019 notification plan covered % of % legacy outboxes',
      planned_count,
      legacy_count;
  END IF;
END;
$$;

-- The reviewed legacy plan is projected into delivery operations/facts and
-- its durable jobs are normalized here by the migration executor.  The final
-- INSERT guard below deliberately replaces the migration-only evidence gate,
-- so no runtime caller can manufacture another attempt-1 backfill row.

INSERT INTO public.notification_delivery_operations(
  outbox_id, attempt_number, provider_operation_id,
  provider_installation_id, operation_origin,
  event_type, template_revision, payload_snapshot,
  invitation_id, contact_id, recipient_user_id, client_account_id,
  recipient_subject_id, recipient_scope_id,
  recipient_kind, category, recipient, locale, request_fingerprint,
  status, attempts, dispatch_started_at, last_error,
  created_at, updated_at
)
SELECT
  plan.outbox_id,
  1,
  plan.attempt_1_provider_operation_id,
  plan.attempt_1_provider_installation_id,
  'schema_019_backfill',
  plan.event_type,
  plan.template_revision,
  plan.payload_snapshot,
  plan.invitation_id,
  plan.contact_id,
  plan.recipient_user_id,
  plan.client_account_id,
  plan.recipient_subject_id,
  plan.recipient_scope_id,
  plan.recipient_kind,
  plan.category,
  plan.recipient,
  plan.locale,
  plan.request_fingerprint,
  plan.attempt_1_status,
  plan.attempt_1_dispatch_count,
  plan.attempt_1_dispatch_started_at,
  CASE plan.attempt_1_status
    WHEN 'unknown' THEN
      'Schema 019 must reconcile the potentially sent legacy Mock Mail operation'
    WHEN 'failed' THEN plan.attempt_1_fact_failure_reason
    WHEN 'skipped' THEN plan.attempt_1_fact_failure_reason
    ELSE NULL
  END,
  COALESCE(plan.attempt_1_dispatch_started_at, pg_catalog.now()),
  COALESCE(plan.attempt_1_dispatch_started_at, pg_catalog.now())
FROM opensales_schema_019_notification_backfill_plan plan
ORDER BY plan.outbox_id;

INSERT INTO public.notification_delivery_facts(
  outbox_id, attempt_number,
  invitation_id, contact_id, recipient_user_id, client_account_id,
  recipient_subject_id, recipient_scope_id,
  recipient_kind, category, recipient, locale,
  provider_installation_id, provider_operation_id, provider_message_id,
  status, failure_reason, provider_occurred_at, recorded_at
)
SELECT
  plan.outbox_id,
  1,
  plan.invitation_id,
  plan.contact_id,
  plan.recipient_user_id,
  plan.client_account_id,
  plan.recipient_subject_id,
  plan.recipient_scope_id,
  plan.recipient_kind,
  plan.category,
  plan.recipient,
  plan.locale,
  CASE WHEN plan.attempt_1_fact_status = 'skipped'
    THEN NULL ELSE plan.attempt_1_provider_installation_id END,
  plan.attempt_1_provider_operation_id,
  CASE WHEN plan.attempt_1_fact_status = 'skipped'
    THEN NULL ELSE plan.attempt_1_provider_message_id END,
  plan.attempt_1_fact_status,
  plan.attempt_1_fact_failure_reason,
  CASE WHEN plan.attempt_1_fact_status = 'skipped'
    THEN NULL ELSE plan.attempt_1_provider_occurred_at END,
  COALESCE(plan.attempt_1_fact_recorded_at, pg_catalog.now())
FROM opensales_schema_019_notification_backfill_plan plan
WHERE plan.attempt_1_fact_status IS NOT NULL
ORDER BY plan.outbox_id;

INSERT INTO public.notification_delivery_operations(
  outbox_id, attempt_number, provider_operation_id,
  provider_installation_id, operation_origin,
  event_type, template_revision, payload_snapshot,
  invitation_id, contact_id, recipient_user_id, client_account_id,
  recipient_subject_id, recipient_scope_id,
  recipient_kind, category, recipient, locale, request_fingerprint,
  status, attempts, last_error
)
SELECT
  plan.outbox_id,
  2,
  public.opensales_notification_provider_operation_id(plan.outbox_id, 2),
  'mock-mail-v1',
  'schema_019_backfill',
  plan.event_type,
  plan.template_revision,
  plan.payload_snapshot,
  plan.invitation_id,
  plan.contact_id,
  plan.recipient_user_id,
  plan.client_account_id,
  plan.recipient_subject_id,
  plan.recipient_scope_id,
  plan.recipient_kind,
  plan.category,
  plan.recipient,
  plan.locale,
  plan.request_fingerprint,
  plan.attempt_2_status,
  0,
  CASE WHEN plan.attempt_2_status = 'skipped'
    THEN 'Recipient consent was withdrawn before retrying a legacy failed delivery'
    ELSE NULL
  END
FROM opensales_schema_019_notification_backfill_plan plan
WHERE plan.attempt_2_status IS NOT NULL
ORDER BY plan.outbox_id;

INSERT INTO public.notification_delivery_facts(
  outbox_id, attempt_number,
  invitation_id, contact_id, recipient_user_id, client_account_id,
  recipient_subject_id, recipient_scope_id,
  recipient_kind, category, recipient, locale,
  provider_installation_id, provider_operation_id, provider_message_id,
  status, failure_reason, provider_occurred_at
)
SELECT
  plan.outbox_id,
  2,
  plan.invitation_id,
  plan.contact_id,
  plan.recipient_user_id,
  plan.client_account_id,
  plan.recipient_subject_id,
  plan.recipient_scope_id,
  plan.recipient_kind,
  plan.category,
  plan.recipient,
  plan.locale,
  NULL,
  public.opensales_notification_provider_operation_id(plan.outbox_id, 2),
  NULL,
  'skipped',
  'Recipient consent was withdrawn before retrying a legacy failed delivery',
  NULL
FROM opensales_schema_019_notification_backfill_plan plan
WHERE plan.attempt_2_status = 'skipped'
ORDER BY plan.outbox_id;

UPDATE public.durable_jobs job
SET status = plan.job_target_status,
    attempts = CASE WHEN plan.job_target_status = 'pending' THEN 0 ELSE job.attempts END,
    available_at = CASE
      WHEN plan.job_target_status = 'pending' THEN pg_catalog.now()
      ELSE job.available_at
    END,
    locked_at = NULL,
    locked_by = NULL,
    last_error = CASE
      WHEN plan.job_target_status = 'pending'
        AND plan.attempt_1_status = 'unknown'
        THEN 'Schema 019 queued exact legacy Mock Mail reconciliation'
      WHEN plan.job_target_status = 'pending'
        AND plan.attempt_2_status = 'queued'
        THEN 'Schema 019 queued a consent-checked retry after legacy failure'
      ELSE NULL
    END,
    updated_at = pg_catalog.now()
FROM opensales_schema_019_notification_backfill_plan plan
WHERE job.id = plan.job_id;

UPDATE public.outbox event
SET published_at = CASE
  WHEN plan.clear_published_at THEN NULL
  WHEN plan.job_target_status = 'completed'
    AND (
      plan.attempt_1_status IN ('succeeded', 'skipped')
      OR plan.attempt_2_status = 'skipped'
    ) THEN COALESCE(event.published_at, pg_catalog.now())
  ELSE event.published_at
END
FROM opensales_schema_019_notification_backfill_plan plan
WHERE event.id = plan.outbox_id;

DO $$
DECLARE
  invalid_id uuid;
BEGIN
  SELECT plan.outbox_id
  INTO invalid_id
  FROM opensales_schema_019_notification_backfill_plan plan
  LEFT JOIN public.notification_delivery_operations operation_1
    ON operation_1.outbox_id = plan.outbox_id
   AND operation_1.attempt_number = 1
  LEFT JOIN public.notification_delivery_operations operation_2
    ON operation_2.outbox_id = plan.outbox_id
   AND operation_2.attempt_number = 2
  LEFT JOIN public.notification_delivery_facts fact_1
    ON fact_1.outbox_id = plan.outbox_id
   AND fact_1.attempt_number = 1
  LEFT JOIN public.notification_delivery_facts fact_2
    ON fact_2.outbox_id = plan.outbox_id
   AND fact_2.attempt_number = 2
  JOIN public.durable_jobs job ON job.id = plan.job_id
  JOIN public.outbox event ON event.id = plan.outbox_id
  WHERE operation_1.id IS NULL
     OR operation_1.status <> plan.attempt_1_status
     OR operation_1.provider_operation_id <> plan.attempt_1_provider_operation_id
     OR operation_1.operation_origin <> 'schema_019_backfill'
     OR operation_1.payload_snapshot IS DISTINCT FROM plan.payload_snapshot
     OR (plan.attempt_1_fact_status IS NULL AND fact_1.id IS NOT NULL)
     OR (plan.attempt_1_fact_status IS NOT NULL
       AND (fact_1.id IS NULL OR fact_1.status <> plan.attempt_1_fact_status))
     OR (plan.attempt_2_status IS NULL AND operation_2.id IS NOT NULL)
     OR (plan.attempt_2_status IS NOT NULL
       AND (operation_2.id IS NULL OR operation_2.status <> plan.attempt_2_status))
     OR (plan.attempt_2_status = 'skipped'
       AND (fact_2.id IS NULL OR fact_2.status <> 'skipped'))
     OR (plan.attempt_2_status IS DISTINCT FROM 'skipped' AND fact_2.id IS NOT NULL)
     OR job.status <> plan.job_target_status
     OR job.locked_at IS NOT NULL
     OR job.locked_by IS NOT NULL
     OR (plan.job_target_status = 'pending' AND job.attempts <> 0)
     OR (plan.clear_published_at AND event.published_at IS NOT NULL)
     OR (
       plan.job_target_status = 'completed'
       AND (
         plan.attempt_1_status IN ('succeeded', 'skipped')
         OR plan.attempt_2_status = 'skipped'
       )
       AND event.published_at IS NULL
     )
  ORDER BY plan.outbox_id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 019 notification backfill materialization was incomplete for outbox %',
      invalid_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_notification_delivery_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  recipient_is_valid boolean := false;
  recipient_snapshot_is_valid boolean := false;
  principal_email text;
  principal_locale text;
  principal_verified_at timestamptz;
  principal_restricted_at timestamptz;
  account_exists boolean;
  account_name text;
  membership_removed_at timestamptz;
  membership_restricted_at timestamptz;
  membership_exists boolean;
  invitation_email text;
  invitation_locale text;
  invitation_accepted_at timestamptz;
  invitation_revoked_at timestamptz;
  invitation_expires_at timestamptz;
  invitation_token_digest bytea;
  invitation_role text;
  invitation_permissions jsonb;
  contact_email text;
  contact_locale text;
  contact_subscriptions jsonb;
  contact_removed_at timestamptz;
  token_id uuid;
  token_user_id uuid;
  token_digest bytea;
  token_expires_at timestamptz;
  token_used_at timestamptz;
  token_invalidated_at timestamptz;
  raw_verification_token text;
  raw_invitation_token text;
  outbox_event_type text;
  outbox_unique_key text;
  outbox_payload jsonb;
  first_snapshot public.notification_delivery_operations%ROWTYPE;
  previous_status text;
  previous_failed_fact boolean;
  payload_recipient_matches boolean := false;
  business_scope_valid boolean := false;
BEGIN
  IF NOT (
    (NEW.event_type = 'notification.email_verification_requested'
      AND NEW.category = 'identity'
      AND NEW.recipient_kind = 'identity_user')
    OR
    (NEW.event_type = 'notification.membership_invitation_requested'
      AND NEW.category = 'membership_invitation'
      AND NEW.recipient_kind = 'invitation')
    OR
    (NEW.event_type = 'notification.renewal_reminder_requested'
      AND NEW.category = 'billing'
      AND NEW.recipient_kind IN ('account_user', 'contact'))
    OR
    (NEW.event_type = 'notification.service_cancellation_scheduled'
      AND NEW.category = 'service'
      AND NEW.recipient_kind IN ('account_user', 'contact'))
    OR
    (NEW.event_type = 'notification.support_ticket_reply_requested'
      AND NEW.category = 'support'
      AND NEW.recipient_kind IN ('account_user', 'contact'))
  ) THEN
    RAISE EXCEPTION
      'Notification event, category, and recipient kind must use a reviewed mapping';
  END IF;

  -- Lock recipient identity before Outbox/Operation rows.  NOWAIT makes a
  -- concurrent consent withdrawal or authorization change fail this producer
  -- transaction closed instead of creating a lock-order cycle.
  IF NEW.recipient_kind = 'identity_user' THEN
    SELECT principal.email::text, principal.locale,
           principal.email_verified_at, principal.restricted_at
    INTO principal_email, principal_locale,
         principal_verified_at, principal_restricted_at
    FROM public.users principal
    WHERE principal.id = NEW.recipient_user_id
    FOR SHARE NOWAIT;

    IF NEW.event_type = 'notification.email_verification_requested'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot) = 'object'
       AND NEW.payload_snapshot ?& ARRAY[
         'userId', 'email', 'locale', 'verificationUrl',
         'expiresAt', 'verificationTokenId',
         'notificationCategory', 'notificationRecipientKind',
         'notificationRecipientSubjectId', 'notificationRecipientScopeId'
       ]
       AND NEW.payload_snapshot - ARRAY[
         'userId', 'email', 'locale', 'verificationUrl',
         'expiresAt', 'verificationTokenId',
         'notificationCategory', 'notificationRecipientKind',
         'notificationRecipientSubjectId', 'notificationRecipientScopeId'
       ] = '{}'::jsonb
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'userId') = 'string'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'email') = 'string'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'locale') = 'string'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'verificationUrl') = 'string'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'expiresAt') = 'string'
       AND pg_catalog.jsonb_typeof(
         NEW.payload_snapshot -> 'verificationTokenId'
       ) = 'string'
       AND NEW.payload_snapshot ->> 'verificationTokenId'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND NEW.payload_snapshot ->> 'userId' = NEW.recipient_user_id::text
       AND NEW.payload_snapshot ->> 'email' = NEW.recipient::text
       AND NEW.payload_snapshot ->> 'locale' = NEW.locale
       AND NEW.payload_snapshot ->> 'notificationCategory' = NEW.category
       AND NEW.payload_snapshot ->> 'notificationRecipientKind' = NEW.recipient_kind
       AND NEW.payload_snapshot ->> 'notificationRecipientSubjectId' =
         NEW.recipient_subject_id::text
       AND NEW.payload_snapshot ->> 'notificationRecipientScopeId' =
         NEW.recipient_scope_id::text
       AND NEW.payload_snapshot ->> 'verificationUrl'
         ~ '/verify[?]token=[A-Za-z0-9_-]{43}$' THEN
      token_id := (NEW.payload_snapshot ->> 'verificationTokenId')::uuid;
      raw_verification_token := pg_catalog.substring(
        NEW.payload_snapshot ->> 'verificationUrl',
        '[?]token=([A-Za-z0-9_-]{43})$'
      );
      SELECT token.id, token.user_id, token.token_digest, token.expires_at,
             token.used_at, token.invalidated_at
      INTO token_id, token_user_id, token_digest, token_expires_at,
           token_used_at, token_invalidated_at
      FROM public.email_verification_tokens token
      WHERE token.id = token_id
        AND token.user_id = NEW.recipient_user_id
      FOR SHARE NOWAIT;
      payload_recipient_matches := true;
    ELSIF NEW.operation_origin = 'schema_019_backfill'
       AND NEW.event_type = 'notification.email_verification_requested'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot) = 'object'
       AND NEW.payload_snapshot ?& ARRAY[
         'userId', 'email', 'locale', 'verificationUrl', 'expiresAt'
       ]
       AND NEW.payload_snapshot - ARRAY[
         'userId', 'email', 'locale', 'verificationUrl', 'expiresAt'
       ] = '{}'::jsonb
       AND NEW.payload_snapshot ->> 'userId' = NEW.recipient_user_id::text
       AND NEW.payload_snapshot ->> 'email' = NEW.recipient::text
       AND NEW.payload_snapshot ->> 'locale' = NEW.locale
       AND NEW.payload_snapshot ->> 'verificationUrl'
         ~ '/verify[?]token=[A-Za-z0-9_-]{43}$' THEN
      raw_verification_token := pg_catalog.substring(
        NEW.payload_snapshot ->> 'verificationUrl',
        '[?]token=([A-Za-z0-9_-]{43})$'
      );
      SELECT token.id, token.user_id, token.token_digest, token.expires_at,
             token.used_at, token.invalidated_at
      INTO token_id, token_user_id, token_digest, token_expires_at,
           token_used_at, token_invalidated_at
      FROM public.email_verification_tokens token
      WHERE token.user_id = NEW.recipient_user_id
        AND token.token_digest = public.digest(
          pg_catalog.convert_to(raw_verification_token, 'UTF8'),
          'sha256'
      )
      FOR SHARE NOWAIT;
      payload_recipient_matches := true;
    END IF;
    recipient_snapshot_is_valid :=
      payload_recipient_matches
      AND token_user_id = NEW.recipient_user_id
      AND token_digest = public.digest(
        pg_catalog.convert_to(raw_verification_token, 'UTF8'),
        'sha256'
      )
      AND NEW.payload_snapshot ->> 'expiresAt' = pg_catalog.to_char(
        token_expires_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      );
    recipient_is_valid :=
      recipient_snapshot_is_valid
      AND principal_email = NEW.recipient::text
      AND principal_locale = NEW.locale
      AND principal_verified_at IS NULL
      AND principal_restricted_at IS NULL
      AND token_used_at IS NULL
      AND token_invalidated_at IS NULL
      AND token_expires_at > pg_catalog.now();
  ELSIF NEW.recipient_kind = 'account_user' THEN
    SELECT principal.email::text, principal.locale,
           principal.email_verified_at, principal.restricted_at
    INTO principal_email, principal_locale,
         principal_verified_at, principal_restricted_at
    FROM public.users principal
    WHERE principal.id = NEW.recipient_user_id
    FOR SHARE NOWAIT;
    SELECT true, account.name
    INTO account_exists, account_name
    FROM public.client_accounts account
    WHERE account.id = NEW.client_account_id
    FOR SHARE NOWAIT;
    SELECT true, membership.removed_at, membership.restricted_at
    INTO membership_exists, membership_removed_at, membership_restricted_at
    FROM public.client_memberships membership
    WHERE membership.user_id = NEW.recipient_user_id
      AND membership.client_account_id = NEW.client_account_id
    FOR SHARE NOWAIT;
    payload_recipient_matches :=
      (
        NEW.operation_origin = 'application'
        AND pg_catalog.jsonb_typeof(NEW.payload_snapshot) = 'object'
        AND (
          (NEW.event_type = 'notification.renewal_reminder_requested'
            AND NEW.payload_snapshot ?& ARRAY[
              'email', 'locale', 'userId', 'accountId',
              'notificationCategory', 'notificationRecipientKind',
              'notificationRecipientSubjectId', 'notificationRecipientScopeId',
              'invoiceId', 'serviceId', 'kind', 'offsetDays', 'currency',
              'dueAt', 'amountDueMinor'
            ]
            AND NEW.payload_snapshot - ARRAY[
              'email', 'locale', 'userId', 'accountId',
              'notificationCategory', 'notificationRecipientKind',
              'notificationRecipientSubjectId', 'notificationRecipientScopeId',
              'invoiceId', 'serviceId', 'kind', 'offsetDays', 'currency',
              'dueAt', 'amountDueMinor'
            ] = '{}'::jsonb)
          OR
          (NEW.event_type = 'notification.service_cancellation_scheduled'
            AND NEW.payload_snapshot ?& ARRAY[
              'email', 'locale', 'userId', 'accountId',
              'notificationCategory', 'notificationRecipientKind',
              'notificationRecipientSubjectId', 'notificationRecipientScopeId',
              'cancellationRequestId', 'serviceId', 'productName',
              'effectiveAt', 'executionMode'
            ]
            AND NEW.payload_snapshot - ARRAY[
              'email', 'locale', 'userId', 'accountId',
              'notificationCategory', 'notificationRecipientKind',
              'notificationRecipientSubjectId', 'notificationRecipientScopeId',
              'cancellationRequestId', 'serviceId', 'productName',
              'effectiveAt', 'executionMode'
            ] = '{}'::jsonb)
          OR
          (NEW.event_type = 'notification.support_ticket_reply_requested'
            AND NEW.payload_snapshot ?& ARRAY[
              'email', 'locale', 'userId', 'accountId',
              'notificationCategory', 'notificationRecipientKind',
              'notificationRecipientSubjectId', 'notificationRecipientScopeId',
              'ticketId', 'ticketMessageId', 'ticketSubject', 'ticketMessage'
            ]
            AND NEW.payload_snapshot - ARRAY[
              'email', 'locale', 'userId', 'accountId',
              'notificationCategory', 'notificationRecipientKind',
              'notificationRecipientSubjectId', 'notificationRecipientScopeId',
              'ticketId', 'ticketMessageId', 'ticketSubject', 'ticketMessage'
            ] = '{}'::jsonb)
        )
        AND NEW.payload_snapshot ->> 'email' = NEW.recipient::text
        AND NEW.payload_snapshot ->> 'locale' = NEW.locale
        AND NEW.payload_snapshot ->> 'userId' = NEW.recipient_user_id::text
        AND NEW.payload_snapshot ->> 'accountId' = NEW.client_account_id::text
        AND NEW.payload_snapshot ->> 'notificationCategory' = NEW.category
        AND NEW.payload_snapshot ->> 'notificationRecipientKind' = NEW.recipient_kind
        AND NEW.payload_snapshot ->> 'notificationRecipientSubjectId' =
          NEW.recipient_subject_id::text
        AND NEW.payload_snapshot ->> 'notificationRecipientScopeId' =
          NEW.recipient_scope_id::text
      )
      OR
      (
        NEW.operation_origin = 'schema_019_backfill'
        AND pg_catalog.jsonb_typeof(NEW.payload_snapshot) = 'object'
        AND NEW.payload_snapshot ->> 'email' = NEW.recipient::text
        AND NEW.payload_snapshot ->> 'locale' = NEW.locale
        AND (
          (NEW.event_type = 'notification.service_cancellation_scheduled'
            AND NEW.payload_snapshot - ARRAY[
              'email', 'locale', 'cancellationRequestId', 'serviceId',
              'productName', 'effectiveAt', 'executionMode'
            ] = '{}'::jsonb)
          OR
          (NEW.event_type = 'notification.renewal_reminder_requested'
            AND NEW.payload_snapshot - ARRAY[
              'email', 'locale', 'invoiceId', 'serviceId', 'kind',
              'offsetDays', 'currency', 'dueAt', 'amountDueMinor'
            ] = '{}'::jsonb)
        )
      );
    recipient_snapshot_is_valid :=
      payload_recipient_matches
      AND COALESCE(account_exists, false)
      AND COALESCE(membership_exists, false)
      AND principal_email IS NOT NULL
      AND (
        NEW.attempt_number > 1
        OR (
          principal_email = NEW.recipient::text
          AND principal_locale = NEW.locale
        )
      );
    recipient_is_valid :=
      recipient_snapshot_is_valid
      AND principal_email = NEW.recipient::text
      AND principal_locale = NEW.locale
      AND principal_verified_at IS NOT NULL
      AND principal_restricted_at IS NULL
      AND membership_removed_at IS NULL
      AND membership_restricted_at IS NULL;
  ELSIF NEW.recipient_kind = 'invitation' THEN
    SELECT true, account.name
    INTO account_exists, account_name
    FROM public.client_accounts account
    WHERE account.id = NEW.client_account_id
    FOR SHARE NOWAIT;
    SELECT invitation.email::text, invitation.locale,
           invitation.accepted_at, invitation.revoked_at, invitation.expires_at,
           invitation.token_digest, invitation.role, invitation.permissions
    INTO invitation_email, invitation_locale,
         invitation_accepted_at, invitation_revoked_at, invitation_expires_at,
         invitation_token_digest, invitation_role, invitation_permissions
    FROM public.client_membership_invitations invitation
    WHERE invitation.id = NEW.invitation_id
      AND invitation.client_account_id = NEW.client_account_id
    FOR SHARE NOWAIT;
    IF NEW.event_type = 'notification.membership_invitation_requested'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot) = 'object'
       AND NEW.payload_snapshot ?& ARRAY[
         'accountId', 'accountName', 'email', 'locale', 'role', 'permissions',
         'invitationId', 'invitationUrl', 'expiresAt',
         'notificationCategory', 'notificationRecipientKind',
         'notificationRecipientSubjectId', 'notificationRecipientScopeId'
       ]
       AND NEW.payload_snapshot - ARRAY[
         'accountId', 'accountName', 'email', 'locale', 'role', 'permissions',
         'invitationId', 'invitationUrl', 'expiresAt',
         'notificationCategory', 'notificationRecipientKind',
         'notificationRecipientSubjectId', 'notificationRecipientScopeId'
       ] = '{}'::jsonb
       AND NEW.payload_snapshot ->> 'invitationId' = NEW.invitation_id::text
       AND NEW.payload_snapshot ->> 'accountId' = NEW.client_account_id::text
       AND (
         NEW.attempt_number > 1
         OR NEW.payload_snapshot ->> 'accountName' = account_name
       )
       AND NEW.payload_snapshot ->> 'email' = NEW.recipient::text
       AND NEW.payload_snapshot ->> 'locale' = NEW.locale
       AND NEW.payload_snapshot ->> 'role' = invitation_role
       AND NEW.payload_snapshot -> 'permissions' = invitation_permissions
       AND NEW.payload_snapshot ->> 'expiresAt' = pg_catalog.to_char(
         invitation_expires_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       )
       AND NEW.payload_snapshot ->> 'notificationCategory' = NEW.category
       AND NEW.payload_snapshot ->> 'notificationRecipientKind' = NEW.recipient_kind
       AND NEW.payload_snapshot ->> 'notificationRecipientSubjectId' =
         NEW.recipient_subject_id::text
       AND NEW.payload_snapshot ->> 'notificationRecipientScopeId' =
         NEW.recipient_scope_id::text
       AND NEW.payload_snapshot ->> 'invitationUrl'
         ~ '/membership-invitations/accept[?]token=[A-Za-z0-9_-]{43}$' THEN
      raw_invitation_token := pg_catalog.substring(
        NEW.payload_snapshot ->> 'invitationUrl',
        '[?]token=([A-Za-z0-9_-]{43})$'
      );
      payload_recipient_matches := true;
    END IF;
    recipient_snapshot_is_valid :=
      COALESCE(account_exists, false)
      AND payload_recipient_matches
      AND invitation_email = NEW.recipient::text
      AND invitation_locale = NEW.locale
      AND invitation_token_digest = public.digest(
        pg_catalog.convert_to(raw_invitation_token, 'UTF8'),
        'sha256'
      );
    recipient_is_valid :=
      recipient_snapshot_is_valid
      AND invitation_accepted_at IS NULL
      AND invitation_revoked_at IS NULL
      AND invitation_expires_at > pg_catalog.now();
  ELSIF NEW.recipient_kind = 'contact' THEN
    SELECT true, account.name
    INTO account_exists, account_name
    FROM public.client_accounts account
    WHERE account.id = NEW.client_account_id
    FOR SHARE NOWAIT;
    SELECT contact.email::text, contact.locale,
           contact.notification_subscriptions, contact.removed_at
    INTO contact_email, contact_locale,
         contact_subscriptions, contact_removed_at
    FROM public.client_contacts contact
    WHERE contact.id = NEW.contact_id
      AND contact.client_account_id = NEW.client_account_id
    FOR SHARE NOWAIT;
    payload_recipient_matches :=
      NEW.operation_origin = 'application'
      AND pg_catalog.jsonb_typeof(NEW.payload_snapshot) = 'object'
      AND (
        (NEW.event_type = 'notification.renewal_reminder_requested'
          AND NEW.payload_snapshot ?& ARRAY[
            'email', 'locale', 'contactId', 'accountId',
            'notificationCategory', 'notificationRecipientKind',
            'notificationRecipientSubjectId', 'notificationRecipientScopeId',
            'invoiceId', 'serviceId', 'kind', 'offsetDays', 'currency',
            'dueAt', 'amountDueMinor'
          ]
          AND NEW.payload_snapshot - ARRAY[
            'email', 'locale', 'contactId', 'accountId',
            'notificationCategory', 'notificationRecipientKind',
            'notificationRecipientSubjectId', 'notificationRecipientScopeId',
            'invoiceId', 'serviceId', 'kind', 'offsetDays', 'currency',
            'dueAt', 'amountDueMinor'
          ] = '{}'::jsonb)
        OR
        (NEW.event_type = 'notification.service_cancellation_scheduled'
          AND NEW.payload_snapshot ?& ARRAY[
            'email', 'locale', 'contactId', 'accountId',
            'notificationCategory', 'notificationRecipientKind',
            'notificationRecipientSubjectId', 'notificationRecipientScopeId',
            'cancellationRequestId', 'serviceId', 'productName',
            'effectiveAt', 'executionMode'
          ]
          AND NEW.payload_snapshot - ARRAY[
            'email', 'locale', 'contactId', 'accountId',
            'notificationCategory', 'notificationRecipientKind',
            'notificationRecipientSubjectId', 'notificationRecipientScopeId',
            'cancellationRequestId', 'serviceId', 'productName',
            'effectiveAt', 'executionMode'
          ] = '{}'::jsonb)
        OR
        (NEW.event_type = 'notification.support_ticket_reply_requested'
          AND NEW.payload_snapshot ?& ARRAY[
            'email', 'locale', 'contactId', 'accountId',
            'notificationCategory', 'notificationRecipientKind',
            'notificationRecipientSubjectId', 'notificationRecipientScopeId',
            'ticketId', 'ticketMessageId', 'ticketSubject', 'ticketMessage'
          ]
          AND NEW.payload_snapshot - ARRAY[
            'email', 'locale', 'contactId', 'accountId',
            'notificationCategory', 'notificationRecipientKind',
            'notificationRecipientSubjectId', 'notificationRecipientScopeId',
            'ticketId', 'ticketMessageId', 'ticketSubject', 'ticketMessage'
          ] = '{}'::jsonb)
      )
      AND NEW.payload_snapshot ->> 'email' = NEW.recipient::text
      AND NEW.payload_snapshot ->> 'locale' = NEW.locale
      AND NEW.payload_snapshot ->> 'contactId' = NEW.contact_id::text
      AND NEW.payload_snapshot ->> 'accountId' = NEW.client_account_id::text
      AND NEW.payload_snapshot ->> 'notificationCategory' = NEW.category
      AND NEW.payload_snapshot ->> 'notificationRecipientKind' = NEW.recipient_kind
      AND NEW.payload_snapshot ->> 'notificationRecipientSubjectId' =
        NEW.recipient_subject_id::text
      AND NEW.payload_snapshot ->> 'notificationRecipientScopeId' =
        NEW.recipient_scope_id::text;
    recipient_snapshot_is_valid :=
      COALESCE(account_exists, false)
      AND contact_email IS NOT NULL
      AND payload_recipient_matches
      AND (
        NEW.attempt_number > 1
        OR (
          contact_email = NEW.recipient::text
          AND contact_locale = NEW.locale
        )
      );
    recipient_is_valid :=
      recipient_snapshot_is_valid
      AND contact_email = NEW.recipient::text
      AND contact_locale = NEW.locale
      AND contact_removed_at IS NULL
      AND contact_subscriptions ? NEW.category;
  END IF;

  IF NOT COALESCE(recipient_snapshot_is_valid, false) THEN
    RAISE EXCEPTION
      'Notification delivery operation recipient snapshot is malformed or unbound';
  END IF;

  -- Bind every account-scoped notification snapshot to the immutable business
  -- facts that authorize its Client Account scope.  Recipient membership alone
  -- is insufficient: without these joins a raw Outbox/Operation insert could
  -- attach an Invoice, cancellation, or Ticket from another account and make
  -- the resulting immutable delivery history falsely attribute that PII.
  IF NEW.event_type = 'notification.renewal_reminder_requested' THEN
    IF pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'invoiceId') = 'string'
       AND NEW.payload_snapshot ->> 'invoiceId'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'serviceId') = 'string'
       AND NEW.payload_snapshot ->> 'serviceId'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'kind') = 'string'
       AND NEW.payload_snapshot ->> 'kind'
         IN ('renewal_created', 'pre_due', 'overdue_first')
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'offsetDays') = 'number'
       AND public.opensales_canonical_notification_jsonb(
         NEW.payload_snapshot -> 'offsetDays'
       ) ~ '^\d+$'
       AND public.opensales_canonical_notification_jsonb(
         NEW.payload_snapshot -> 'offsetDays'
       )::integer BETWEEN 0 AND 90
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'currency') = 'string'
       AND NEW.payload_snapshot ->> 'currency' ~ '^[A-Z]{3}$'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'dueAt') = 'string'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'amountDueMinor') = 'string'
       AND NEW.payload_snapshot ->> 'amountDueMinor' ~ '^\d+$'
       AND NEW.template_revision =
         'renewal-' || pg_catalog.replace(
           NEW.payload_snapshot ->> 'kind', '_', '-'
         ) || '-v1' THEN
      SELECT true
      INTO business_scope_valid
      FROM public.invoices invoice
      JOIN public.service_renewals renewal
        ON renewal.invoice_id = invoice.id
       AND renewal.service_id =
         (NEW.payload_snapshot ->> 'serviceId')::uuid
      JOIN public.services service ON service.id = renewal.service_id
      JOIN public.client_accounts account
        ON account.id = NEW.client_account_id
      WHERE invoice.id = (NEW.payload_snapshot ->> 'invoiceId')::uuid
        AND invoice.client_account_id = NEW.client_account_id
        AND service.client_account_id = NEW.client_account_id
        AND renewal.currency = invoice.currency
        AND NEW.payload_snapshot ->> 'currency' = invoice.currency
        AND NEW.payload_snapshot ->> 'dueAt' = pg_catalog.to_char(
          invoice.due_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
        AND (
          NEW.recipient_kind = 'contact'
          OR NEW.attempt_number > 1
          OR NEW.recipient_user_id = account.owner_user_id
        )
      FOR SHARE OF account, invoice, renewal, service NOWAIT;
    END IF;
  ELSIF NEW.event_type = 'notification.service_cancellation_scheduled' THEN
    IF pg_catalog.jsonb_typeof(
         NEW.payload_snapshot -> 'cancellationRequestId'
       ) = 'string'
       AND NEW.payload_snapshot ->> 'cancellationRequestId'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'serviceId') = 'string'
       AND NEW.payload_snapshot ->> 'serviceId'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'productName') = 'string'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'effectiveAt') = 'string'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'executionMode') = 'string'
       AND NEW.payload_snapshot ->> 'executionMode' IN ('automatic', 'manual')
       AND NEW.template_revision = 'service-cancellation-scheduled-v1' THEN
      SELECT true
      INTO business_scope_valid
      FROM public.service_cancellation_requests cancellation_request
      JOIN public.services service
        ON service.id = cancellation_request.service_id
      JOIN public.order_items item ON item.id = service.order_item_id
      JOIN public.service_cancellation_executions execution
        ON execution.cancellation_request_id = cancellation_request.id
       AND execution.service_id = service.id
      WHERE cancellation_request.id =
            (NEW.payload_snapshot ->> 'cancellationRequestId')::uuid
        AND service.id = (NEW.payload_snapshot ->> 'serviceId')::uuid
        AND cancellation_request.client_account_id = NEW.client_account_id
        AND service.client_account_id = NEW.client_account_id
        AND NEW.payload_snapshot ->> 'productName' = item.product_name
        AND NEW.payload_snapshot ->> 'effectiveAt' = pg_catalog.to_char(
          cancellation_request.effective_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
        AND NEW.payload_snapshot ->> 'executionMode' = execution.execution_mode
        AND (
          NEW.recipient_kind = 'contact'
          OR NEW.attempt_number > 1
          OR NEW.recipient_user_id = cancellation_request.requested_by_user_id
        )
      FOR SHARE OF cancellation_request, service, item, execution NOWAIT;
    END IF;
  ELSIF NEW.event_type = 'notification.support_ticket_reply_requested' THEN
    IF pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'ticketId') = 'string'
       AND NEW.payload_snapshot ->> 'ticketId'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.jsonb_typeof(
         NEW.payload_snapshot -> 'ticketMessageId'
       ) = 'string'
       AND NEW.payload_snapshot ->> 'ticketMessageId'
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'ticketSubject') = 'string'
       AND pg_catalog.jsonb_typeof(NEW.payload_snapshot -> 'ticketMessage') = 'string'
       AND NEW.template_revision = 'support-ticket-reply-v1' THEN
      SELECT true
      INTO business_scope_valid
      FROM public.support_tickets ticket
      JOIN public.client_accounts account
        ON account.id = ticket.client_account_id
      WHERE ticket.id = (NEW.payload_snapshot ->> 'ticketId')::uuid
        AND ticket.client_account_id = NEW.client_account_id
        AND NEW.payload_snapshot ->> 'ticketSubject' = ticket.subject
        AND (
          NEW.recipient_kind = 'contact'
          OR NEW.attempt_number > 1
          OR NEW.recipient_user_id IN (
            ticket.created_by_user_id,
            account.owner_user_id
          )
        )
      FOR SHARE OF account, ticket NOWAIT;
    END IF;
  ELSE
    business_scope_valid := true;
  END IF;

  IF NOT COALESCE(business_scope_valid, false) THEN
    RAISE EXCEPTION
      'Notification delivery operation business facts do not match its Client Account scope';
  END IF;

  SELECT event.event_type, event.unique_key, event.payload
  INTO outbox_event_type, outbox_unique_key, outbox_payload
  FROM public.outbox event
  WHERE event.id = NEW.outbox_id
  FOR SHARE NOWAIT;
  IF outbox_event_type IS NULL
     OR NEW.event_type IS DISTINCT FROM outbox_event_type
     OR NEW.payload_snapshot IS DISTINCT FROM outbox_payload
     OR NEW.request_fingerprint IS DISTINCT FROM
       public.opensales_notification_request_fingerprint(
         NEW.event_type,
         NEW.template_revision,
         NEW.payload_snapshot
       ) THEN
    RAISE EXCEPTION
      'Notification delivery operation must preserve its exact outbox, template, and request fingerprint';
  END IF;

  IF NOT (
    (NEW.event_type = 'notification.email_verification_requested'
      AND outbox_unique_key IN (
        'registration:' || NEW.recipient_user_id::text,
        'invitation-registration:' || NEW.recipient_user_id::text,
        'verification:' || token_id::text
      ))
    OR
    (NEW.event_type = 'notification.membership_invitation_requested'
      AND outbox_unique_key =
        'membership-invitation:' || NEW.invitation_id::text)
    OR
    (NEW.event_type = 'notification.renewal_reminder_requested'
      AND outbox_unique_key =
        'renewal:' || (NEW.payload_snapshot ->> 'invoiceId') || ':' ||
        (NEW.payload_snapshot ->> 'kind') ||
        CASE WHEN NEW.recipient_kind = 'contact'
          THEN ':contact:' || NEW.contact_id::text ELSE '' END)
    OR
    (NEW.event_type = 'notification.service_cancellation_scheduled'
      AND outbox_unique_key =
        'service-cancellation:' ||
        (NEW.payload_snapshot ->> 'cancellationRequestId') ||
        CASE WHEN NEW.recipient_kind = 'contact'
          THEN ':contact:' || NEW.contact_id::text ELSE '' END)
    OR
    (NEW.event_type = 'notification.support_ticket_reply_requested'
      AND outbox_unique_key =
        'support-ticket-reply:' ||
        (NEW.payload_snapshot ->> 'ticketMessageId') ||
        CASE WHEN NEW.recipient_kind = 'contact'
          THEN ':contact:' || NEW.contact_id::text ELSE '' END)
  ) THEN
    RAISE EXCEPTION
      'Notification Outbox unique key must be the stable reviewed recipient key';
  END IF;

  IF NEW.attempt_number = 1 THEN
    IF NEW.operation_origin <> 'application' THEN
      RAISE EXCEPTION
        'Only Schema 019 itself may create a migrated first notification attempt';
    END IF;
  ELSE
    SELECT operation.*
    INTO first_snapshot
    FROM public.notification_delivery_operations operation
    WHERE operation.outbox_id = NEW.outbox_id
      AND operation.attempt_number = 1
    FOR SHARE NOWAIT;
    SELECT operation.status,
           EXISTS (
             SELECT 1
             FROM public.notification_delivery_facts fact
             WHERE fact.outbox_id = operation.outbox_id
               AND fact.attempt_number = operation.attempt_number
               AND fact.provider_operation_id = operation.provider_operation_id
               AND fact.status = 'failed'
           )
    INTO previous_status, previous_failed_fact
    FROM public.notification_delivery_operations operation
    WHERE operation.outbox_id = NEW.outbox_id
      AND operation.attempt_number = NEW.attempt_number - 1
    FOR SHARE NOWAIT;
    IF first_snapshot.id IS NULL
       OR NEW.operation_origin IS DISTINCT FROM first_snapshot.operation_origin
       OR previous_status IS DISTINCT FROM 'failed'
       OR NOT COALESCE(previous_failed_fact, false) THEN
      RAISE EXCEPTION
        'A later notification attempt requires the same provenance and an immutable failed preceding fact';
    END IF;
    IF NEW.event_type IS DISTINCT FROM first_snapshot.event_type
       OR NEW.template_revision IS DISTINCT FROM first_snapshot.template_revision
       OR NEW.payload_snapshot IS DISTINCT FROM first_snapshot.payload_snapshot
       OR NEW.provider_installation_id IS DISTINCT FROM first_snapshot.provider_installation_id
       OR NEW.invitation_id IS DISTINCT FROM first_snapshot.invitation_id
       OR NEW.contact_id IS DISTINCT FROM first_snapshot.contact_id
       OR NEW.recipient_user_id IS DISTINCT FROM first_snapshot.recipient_user_id
       OR NEW.client_account_id IS DISTINCT FROM first_snapshot.client_account_id
       OR NEW.recipient_subject_id IS DISTINCT FROM first_snapshot.recipient_subject_id
       OR NEW.recipient_scope_id IS DISTINCT FROM first_snapshot.recipient_scope_id
       OR NEW.recipient_kind IS DISTINCT FROM first_snapshot.recipient_kind
       OR NEW.category IS DISTINCT FROM first_snapshot.category
       OR NEW.recipient::text IS DISTINCT FROM first_snapshot.recipient::text
       OR NEW.locale IS DISTINCT FROM first_snapshot.locale
       OR NEW.request_fingerprint IS DISTINCT FROM first_snapshot.request_fingerprint THEN
      RAISE EXCEPTION
        'A later notification attempt must preserve its event-time recipient and request snapshot';
    END IF;
  END IF;

  IF NEW.provider_installation_id <> 'mock-mail-v1'
     OR NEW.provider_operation_id <>
       public.opensales_notification_provider_operation_id(
         NEW.outbox_id,
         NEW.attempt_number
       )
     OR NEW.status NOT IN ('queued', 'skipped')
     OR NEW.attempts <> 0
     OR NEW.dispatch_started_at IS NOT NULL
     OR NEW.last_checked_at IS NOT NULL
     OR NEW.rendered_request_snapshot IS NOT NULL
     OR NEW.rendered_request_fingerprint IS NOT NULL
     OR (NEW.status = 'queued' AND NEW.last_error IS NOT NULL)
     OR (NEW.status = 'skipped'
       AND NULLIF(pg_catalog.btrim(NEW.last_error), '') IS NULL) THEN
    RAISE EXCEPTION
      'A new notification delivery attempt must begin in an exact unsent queued or skipped state';
  END IF;
  IF (COALESCE(recipient_is_valid, false) AND NEW.status <> 'queued')
     OR (NOT COALESCE(recipient_is_valid, false) AND NEW.status <> 'skipped') THEN
    RAISE EXCEPTION
      'A new notification must queue a live recipient or terminally skip an ineligible recipient';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_notification_message()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  message_is_exact boolean := false;
BEGIN
  IF NEW.event_type <> 'notification.support_ticket_reply_requested' THEN
    RETURN NULL;
  END IF;

  -- The Staff reply is inserted after its Outbox operation in the same API
  -- transaction, so this relation must be checked at commit.  This preserves
  -- the recipient-first producer lock order while proving that an immutable
  -- delivery operation never cites a fabricated, internal, cross-Ticket, or
  -- rewritten support message.
  SELECT true
  INTO message_is_exact
  FROM public.support_ticket_messages message
  JOIN public.support_tickets ticket ON ticket.id = message.ticket_id
  WHERE message.id = (NEW.payload_snapshot ->> 'ticketMessageId')::uuid
    AND ticket.id = (NEW.payload_snapshot ->> 'ticketId')::uuid
    AND ticket.client_account_id = NEW.client_account_id
    AND message.author_type = 'staff'
    AND message.visibility = 'public'
    AND message.body = NEW.payload_snapshot ->> 'ticketMessage';

  IF NOT COALESCE(message_is_exact, false) THEN
    RAISE EXCEPTION
      'Support notification operation requires its exact committed public Staff message';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS notification_delivery_operations_support_message_guard
  ON public.notification_delivery_operations;
CREATE CONSTRAINT TRIGGER notification_delivery_operations_support_message_guard
AFTER INSERT ON public.notification_delivery_operations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.opensales_validate_support_notification_message();

CREATE OR REPLACE FUNCTION public.opensales_guard_notification_outbox()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Notification Outbox facts cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.unique_key IS DISTINCT FROM OLD.unique_key
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Notification Outbox identity, unique key, and payload snapshot are immutable';
  END IF;
  IF OLD.published_at IS NOT NULL
     AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'Published notification Outbox time is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_outbox_immutable
BEFORE UPDATE OR DELETE ON public.outbox
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_notification_outbox();

-- A forward upgrade may initialize a context only when the choice is
-- unambiguous.  Sessions for users with zero or multiple active memberships
-- remain context-free and must use the explicit switch API.
WITH unambiguous_membership AS (
  SELECT
    membership.user_id,
    pg_catalog.min(membership.client_account_id::text)::uuid AS client_account_id
  FROM public.client_memberships membership
  WHERE membership.removed_at IS NULL
  GROUP BY membership.user_id
  -- A restricted Membership still makes this a multi-Membership identity; it
  -- must not be silently ignored to manufacture an "unambiguous" fallback.
  -- Automatic upgrade is allowed only for exactly one total active
  -- Membership and that one Membership must itself be unrestricted.
  HAVING pg_catalog.count(*) = 1
     AND pg_catalog.count(*) FILTER (WHERE membership.restricted_at IS NULL) = 1
)
UPDATE public.sessions session_record
SET active_client_account_id = membership.client_account_id,
    account_context_version = 1
FROM unambiguous_membership membership
WHERE membership.user_id = session_record.user_id
  AND session_record.active_client_account_id IS NULL;

DO $$
DECLARE
  invalid_session_id uuid;
BEGIN
  SELECT session_record.id
  INTO invalid_session_id
  FROM public.sessions session_record
  WHERE session_record.active_client_account_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.client_memberships membership
      WHERE membership.client_account_id = session_record.active_client_account_id
        AND membership.user_id = session_record.user_id
        AND membership.removed_at IS NULL
        AND membership.restricted_at IS NULL
    )
  ORDER BY session_record.id
  LIMIT 1;

  IF invalid_session_id IS NOT NULL THEN
    RAISE EXCEPTION
      'schema 019 refused invalid active Client Account context for session %',
      invalid_session_id;
  END IF;
END;
$$;

CREATE INDEX sessions_user_active_context_idx
  ON public.sessions(user_id, active_client_account_id, account_context_version)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION public.opensales_validate_session_account_context()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  membership_is_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_context_version < OLD.account_context_version THEN
      RAISE EXCEPTION 'session account context version cannot move backwards';
    END IF;
    IF NEW.active_client_account_id IS DISTINCT FROM OLD.active_client_account_id
       AND NEW.account_context_version <= OLD.account_context_version THEN
      RAISE EXCEPTION 'changing session account context requires a newer context version';
    END IF;
  END IF;

  IF NEW.active_client_account_id IS NOT NULL THEN
    -- This row lock is the database-level serialization point between a
    -- Session context insert/switch and a direct membership revoke/restrict.
    -- NOWAIT makes the Session side fail closed instead of waiting while it
    -- already owns the Session row, which would invert the Membership trigger's
    -- Membership -> Session order.  The caller can retry the explicit switch.
    SELECT membership.removed_at IS NULL AND membership.restricted_at IS NULL
    INTO membership_is_active
    FROM public.client_memberships membership
    WHERE membership.client_account_id = NEW.active_client_account_id
      AND membership.user_id = NEW.user_id
    FOR SHARE NOWAIT;

    IF NOT COALESCE(membership_is_active, false) THEN
      RAISE EXCEPTION
        'session account context requires an active, unrestricted membership';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sessions_validate_account_context ON public.sessions;
CREATE TRIGGER sessions_validate_account_context
BEFORE INSERT OR UPDATE OF user_id, active_client_account_id, account_context_version
ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_session_account_context();

CREATE OR REPLACE FUNCTION public.opensales_guard_session_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Session identity, bearer digest, creation, and expiry facts are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sessions_identity_immutable ON public.sessions;
CREATE TRIGGER sessions_identity_immutable
BEFORE UPDATE OF id, user_id, token_digest, expires_at, created_at ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_session_identity();

CREATE OR REPLACE FUNCTION public.opensales_bump_user_identity_context_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at
     OR NEW.restricted_at IS DISTINCT FROM OLD.restricted_at THEN
    -- The User row is the universal serialization point for identity changes.
    -- Lock every surviving Session in stable order before changing the version
    -- consumed by Web stale-response protection.  The active Account pointer
    -- remains intact so verification or restriction recovery can reveal the
    -- same explicitly selected context under a strictly newer version.
    PERFORM session_record.id
    FROM public.sessions session_record
    WHERE session_record.user_id = NEW.id
      AND session_record.revoked_at IS NULL
    ORDER BY session_record.id
    FOR UPDATE NOWAIT;

    UPDATE public.sessions session_record
    SET account_context_version = account_context_version + 1
    WHERE session_record.user_id = NEW.id
      AND session_record.revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_bump_identity_context_version ON public.users;
CREATE TRIGGER users_bump_identity_context_version
AFTER UPDATE OF email_verified_at, restricted_at ON public.users
FOR EACH ROW
WHEN (
  NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at
  OR NEW.restricted_at IS DISTINCT FROM OLD.restricted_at
)
EXECUTE FUNCTION public.opensales_bump_user_identity_context_version();

CREATE OR REPLACE FUNCTION public.opensales_guard_membership_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.client_account_id IS DISTINCT FROM OLD.client_account_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'client membership account and user identity are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_memberships_identity_immutable ON public.client_memberships;
CREATE TRIGGER client_memberships_identity_immutable
BEFORE UPDATE OF client_account_id, user_id ON public.client_memberships
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_membership_identity();

CREATE OR REPLACE FUNCTION public.opensales_invalidate_membership_reauth()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_account_id uuid;
  affected_user_id uuid;
  clear_context boolean;
  authorization_changed boolean;
  affected_session_ids uuid[];
BEGIN
  affected_account_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.client_account_id ELSE NEW.client_account_id END;
  affected_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  IF TG_OP = 'DELETE' THEN
    clear_context := true;
    authorization_changed := true;
  ELSE
    clear_context := NEW.removed_at IS NOT NULL OR NEW.restricted_at IS NOT NULL;
    authorization_changed := NEW.role IS DISTINCT FROM OLD.role
      OR NEW.permissions IS DISTINCT FROM OLD.permissions
      OR NEW.removed_at IS DISTINCT FROM OLD.removed_at
      OR NEW.restricted_at IS DISTINCT FROM OLD.restricted_at;
  END IF;

  IF authorization_changed THEN
    -- A direct SQL caller already holds the Membership row.  It must not wait
    -- on a Session that may itself be waiting on this Membership.  Fail closed
    -- with 55P03 and let the caller retry through the reviewed universal lock
    -- order used by the API.
    PERFORM session_record.id
    FROM public.sessions session_record
    WHERE session_record.user_id = affected_user_id
      AND session_record.active_client_account_id = affected_account_id
      AND session_record.revoked_at IS NULL
    ORDER BY session_record.id
    FOR UPDATE NOWAIT;

    SELECT COALESCE(
      pg_catalog.array_agg(session_record.id ORDER BY session_record.id),
      ARRAY[]::uuid[]
    )
    INTO affected_session_ids
    FROM public.sessions session_record
    WHERE session_record.user_id = affected_user_id
      AND session_record.active_client_account_id = affected_account_id
      AND session_record.revoked_at IS NULL;

    UPDATE public.reauth_grants grant_record
    SET invalidated_at = pg_catalog.now()
    WHERE grant_record.session_id = ANY(affected_session_ids)
      AND grant_record.invalidated_at IS NULL;

    UPDATE public.sessions session_record
    SET active_client_account_id = CASE WHEN clear_context THEN NULL ELSE active_client_account_id END,
        account_context_version = account_context_version + 1
    WHERE session_record.id = ANY(affected_session_ids);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_memberships_invalidate_reauth ON public.client_memberships;
CREATE TRIGGER client_memberships_invalidate_reauth
AFTER UPDATE OF role, permissions, removed_at, restricted_at OR DELETE
ON public.client_memberships
FOR EACH ROW EXECUTE FUNCTION public.opensales_invalidate_membership_reauth();

-- Schema 011's AFTER trigger invalidates grants while already holding the
-- Client Account row.  Preserve that historical function and trigger exactly
-- for the inherited catalog gate, but add a BEFORE serialization point.  A
-- conflicting Staff action therefore makes the Account mutation fail closed
-- before the new restriction is written instead of entering Account -> Grant.
CREATE OR REPLACE FUNCTION public.opensales_prelock_client_account_reauth()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.restricted_at IS DISTINCT FROM OLD.restricted_at THEN
    PERFORM grant_record.id
    FROM public.reauth_grants grant_record
    JOIN public.client_memberships membership
      ON membership.user_id = grant_record.user_id
     AND membership.client_account_id = NEW.id
    WHERE grant_record.invalidated_at IS NULL
    ORDER BY grant_record.id
    FOR UPDATE OF grant_record NOWAIT;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_accounts_prelock_reauth
BEFORE UPDATE OF restricted_at ON public.client_accounts
FOR EACH ROW EXECUTE FUNCTION public.opensales_prelock_client_account_reauth();

CREATE OR REPLACE FUNCTION public.opensales_assert_client_account_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_account_id uuid;
  recorded_owner_user_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'client_accounts' THEN
    affected_account_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    affected_account_id := CASE
      WHEN TG_OP = 'DELETE' THEN OLD.client_account_id
      ELSE NEW.client_account_id
    END;
  END IF;

  SELECT account.owner_user_id
  INTO recorded_owner_user_id
  FROM public.client_accounts account
  WHERE account.id = affected_account_id
  FOR UPDATE NOWAIT;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.client_memberships membership
    WHERE membership.client_account_id = affected_account_id
      AND membership.role = 'owner'
      AND membership.removed_at IS NULL
      AND membership.restricted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'client account % must retain at least one active, unrestricted owner',
      affected_account_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.client_memberships membership
    WHERE membership.client_account_id = affected_account_id
      AND membership.user_id = recorded_owner_user_id
      AND membership.role = 'owner'
      AND membership.removed_at IS NULL
      AND membership.restricted_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'client account % recorded owner % must have an active, unrestricted owner membership',
      affected_account_id,
      recorded_owner_user_id;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS client_memberships_owner_invariant ON public.client_memberships;
CREATE CONSTRAINT TRIGGER client_memberships_owner_invariant
AFTER INSERT OR UPDATE OR DELETE ON public.client_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_assert_client_account_owner_membership();

DROP TRIGGER IF EXISTS client_accounts_owner_invariant ON public.client_accounts;
CREATE CONSTRAINT TRIGGER client_accounts_owner_invariant
AFTER INSERT OR UPDATE OF owner_user_id ON public.client_accounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_assert_client_account_owner_membership();

CREATE TABLE public.client_account_owner_transfer_facts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES public.client_accounts(id),
  previous_owner_user_id uuid REFERENCES public.users(id),
  new_owner_user_id uuid NOT NULL REFERENCES public.users(id),
  source text NOT NULL CHECK (source IN ('schema_019_baseline', 'database_update')),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (
    (source = 'schema_019_baseline' AND previous_owner_user_id IS NULL)
    OR
    (source = 'database_update'
      AND previous_owner_user_id IS NOT NULL
      AND previous_owner_user_id <> new_owner_user_id)
  )
);

COMMENT ON TABLE public.client_account_owner_transfer_facts IS
  'Append-only database evidence for the baseline recorded owner and every owner pointer transfer.';

CREATE INDEX client_account_owner_transfer_facts_account_recorded_idx
  ON public.client_account_owner_transfer_facts(client_account_id, recorded_at, id);

INSERT INTO public.client_account_owner_transfer_facts(
  client_account_id, previous_owner_user_id, new_owner_user_id, source
)
SELECT account.id, NULL, account.owner_user_id, 'schema_019_baseline'
FROM public.client_accounts account
ORDER BY account.id;

CREATE OR REPLACE FUNCTION public.opensales_record_client_account_owner_transfer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    INSERT INTO public.client_account_owner_transfer_facts(
      client_account_id,
      previous_owner_user_id,
      new_owner_user_id,
      source
    ) VALUES (
      NEW.id,
      OLD.owner_user_id,
      NEW.owner_user_id,
      'database_update'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_accounts_record_owner_transfer
AFTER UPDATE OF owner_user_id ON public.client_accounts
FOR EACH ROW EXECUTE FUNCTION public.opensales_record_client_account_owner_transfer();

CREATE OR REPLACE FUNCTION public.opensales_reject_client_account_owner_transfer_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Client Account owner transfer facts are immutable';
END;
$$;

CREATE TRIGGER client_account_owner_transfer_facts_immutable
BEFORE UPDATE OR DELETE ON public.client_account_owner_transfer_facts
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_client_account_owner_transfer_fact_mutation();

-- Renewal delivery used to have a dedicated owner-recipient fact table.  The
-- generic Schema 019 notification history must remain an exact projection of
-- that evidence, never a second mutable interpretation of the same Provider
-- result.  Both deferred triggers permit the Worker to insert the pair in
-- either order inside one transaction while rejecting either single-sided
-- fact at commit.
CREATE OR REPLACE FUNCTION public.opensales_validate_renewal_notification_delivery_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  renewal_outbox_id uuid;
  renewal_intent_id uuid;
  renewal_email text;
  renewal_locale text;
  renewal_client_account_id uuid;
  renewal_owner_user_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'renewal_reminder_delivery_facts' THEN
    SELECT reminder.outbox_id, reminder.id, reminder.email::text,
           reminder.locale, owner_operation.client_account_id,
           owner_operation.recipient_user_id
    INTO renewal_outbox_id, renewal_intent_id, renewal_email,
         renewal_locale, renewal_client_account_id, renewal_owner_user_id
    FROM public.renewal_reminder_intents reminder
    JOIN public.invoices invoice ON invoice.id = reminder.invoice_id
    JOIN public.notification_delivery_operations owner_operation
      ON owner_operation.outbox_id = reminder.outbox_id
     AND owner_operation.attempt_number = 1
     AND owner_operation.recipient_kind = 'account_user'
     AND owner_operation.category = 'billing'
     AND owner_operation.client_account_id = invoice.client_account_id
     AND owner_operation.recipient::text = reminder.email::text
     AND owner_operation.locale = reminder.locale
    WHERE reminder.id = NEW.intent_id;

    IF renewal_outbox_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.notification_delivery_facts fact
      WHERE fact.outbox_id = renewal_outbox_id
        AND fact.attempt_number = NEW.attempt_number
        AND fact.recipient_kind = 'account_user'
        AND fact.category = 'billing'
        AND fact.recipient_user_id = renewal_owner_user_id
        AND fact.recipient_subject_id = renewal_owner_user_id
        AND fact.client_account_id = renewal_client_account_id
        AND fact.recipient_scope_id = renewal_client_account_id
        AND fact.recipient::text = renewal_email
        AND fact.locale = renewal_locale
        AND fact.provider_installation_id = NEW.provider_installation_id
        AND fact.provider_operation_id = NEW.provider_operation_id
        AND fact.provider_message_id = NEW.provider_message_id
        AND fact.status = NEW.status
        AND fact.failure_reason IS NOT DISTINCT FROM NEW.failure_reason
        AND fact.provider_occurred_at = NEW.provider_occurred_at
        AND fact.recorded_at = NEW.recorded_at
    ) THEN
      RAISE EXCEPTION
        'A renewal delivery fact requires its exact generic notification projection';
    END IF;
    RETURN NULL;
  END IF;

  -- Contact fanout has its own per-recipient outbox/fact lifecycle.  The
  -- specialized legacy table represents only the recorded-owner account User
  -- delivery, so Contact facts are deliberately outside this projection.
  IF NEW.recipient_kind <> 'account_user'
     OR NEW.category <> 'billing'
     OR NEW.status = 'skipped' THEN
    RETURN NULL;
  END IF;

  SELECT reminder.outbox_id, reminder.id, reminder.email::text,
         reminder.locale, owner_operation.client_account_id,
         owner_operation.recipient_user_id
  INTO renewal_outbox_id, renewal_intent_id, renewal_email,
       renewal_locale, renewal_client_account_id, renewal_owner_user_id
  FROM public.outbox event
  LEFT JOIN public.renewal_reminder_intents reminder
    ON reminder.outbox_id = event.id
  LEFT JOIN public.invoices invoice ON invoice.id = reminder.invoice_id
  LEFT JOIN public.notification_delivery_operations owner_operation
    ON owner_operation.outbox_id = reminder.outbox_id
   AND owner_operation.attempt_number = 1
   AND owner_operation.recipient_kind = 'account_user'
   AND owner_operation.category = 'billing'
   AND owner_operation.client_account_id = invoice.client_account_id
   AND owner_operation.recipient::text = reminder.email::text
   AND owner_operation.locale = reminder.locale
  WHERE event.id = NEW.outbox_id
    AND event.event_type = 'notification.renewal_reminder_requested';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF renewal_intent_id IS NULL
     OR NEW.recipient_kind <> 'account_user'
     OR NEW.category <> 'billing'
     OR NEW.recipient_user_id IS DISTINCT FROM renewal_owner_user_id
     OR NEW.recipient_subject_id IS DISTINCT FROM renewal_owner_user_id
     OR NEW.client_account_id IS DISTINCT FROM renewal_client_account_id
     OR NEW.recipient_scope_id IS DISTINCT FROM renewal_client_account_id
     OR NEW.recipient::text IS DISTINCT FROM renewal_email
     OR NEW.locale IS DISTINCT FROM renewal_locale
     OR NOT EXISTS (
       SELECT 1
       FROM public.renewal_reminder_delivery_facts renewal_fact
       WHERE renewal_fact.intent_id = renewal_intent_id
         AND renewal_fact.attempt_number = NEW.attempt_number
         AND renewal_fact.provider_installation_id = NEW.provider_installation_id
         AND renewal_fact.provider_operation_id = NEW.provider_operation_id
         AND renewal_fact.provider_message_id = NEW.provider_message_id
         AND renewal_fact.status = NEW.status
         AND renewal_fact.failure_reason IS NOT DISTINCT FROM NEW.failure_reason
         AND renewal_fact.provider_occurred_at = NEW.provider_occurred_at
         AND renewal_fact.recorded_at = NEW.recorded_at
     ) THEN
    RAISE EXCEPTION
      'A renewal notification delivery fact requires its exact specialized projection';
  END IF;
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  invalid_id uuid;
BEGIN
  SELECT renewal_fact.id
  INTO invalid_id
  FROM public.renewal_reminder_delivery_facts renewal_fact
  JOIN public.renewal_reminder_intents reminder
    ON reminder.id = renewal_fact.intent_id
  JOIN public.invoices invoice ON invoice.id = reminder.invoice_id
  JOIN public.notification_delivery_operations owner_operation
    ON owner_operation.outbox_id = reminder.outbox_id
   AND owner_operation.attempt_number = 1
   AND owner_operation.recipient_kind = 'account_user'
   AND owner_operation.category = 'billing'
   AND owner_operation.client_account_id = invoice.client_account_id
   AND owner_operation.recipient::text = reminder.email::text
   AND owner_operation.locale = reminder.locale
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.notification_delivery_facts fact
    WHERE fact.outbox_id = reminder.outbox_id
      AND fact.attempt_number = renewal_fact.attempt_number
      AND fact.recipient_kind = 'account_user'
      AND fact.category = 'billing'
      AND fact.recipient_user_id = owner_operation.recipient_user_id
      AND fact.recipient_subject_id = owner_operation.recipient_user_id
      AND fact.client_account_id = owner_operation.client_account_id
      AND fact.recipient_scope_id = owner_operation.client_account_id
      AND fact.recipient::text = reminder.email::text
      AND fact.locale = reminder.locale
      AND fact.provider_installation_id = renewal_fact.provider_installation_id
      AND fact.provider_operation_id = renewal_fact.provider_operation_id
      AND fact.provider_message_id = renewal_fact.provider_message_id
      AND fact.status = renewal_fact.status
      AND fact.failure_reason IS NOT DISTINCT FROM renewal_fact.failure_reason
      AND fact.provider_occurred_at = renewal_fact.provider_occurred_at
      AND fact.recorded_at = renewal_fact.recorded_at
  )
  ORDER BY renewal_fact.id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 019 renewal delivery fact % lacks its exact generic projection',
      invalid_id;
  END IF;

  SELECT fact.id
  INTO invalid_id
  FROM public.notification_delivery_facts fact
  JOIN public.outbox event ON event.id = fact.outbox_id
  LEFT JOIN public.renewal_reminder_intents reminder
    ON reminder.outbox_id = event.id
  LEFT JOIN public.invoices invoice ON invoice.id = reminder.invoice_id
  LEFT JOIN public.notification_delivery_operations owner_operation
    ON owner_operation.outbox_id = reminder.outbox_id
   AND owner_operation.attempt_number = 1
   AND owner_operation.recipient_kind = 'account_user'
   AND owner_operation.category = 'billing'
   AND owner_operation.client_account_id = invoice.client_account_id
   AND owner_operation.recipient::text = reminder.email::text
   AND owner_operation.locale = reminder.locale
  WHERE event.event_type = 'notification.renewal_reminder_requested'
    AND fact.recipient_kind = 'account_user'
    AND fact.category = 'billing'
    AND fact.status IN ('delivered', 'bounced', 'failed')
    AND (
      reminder.id IS NULL
      OR owner_operation.id IS NULL
      OR fact.recipient_user_id IS DISTINCT FROM owner_operation.recipient_user_id
      OR fact.recipient_subject_id IS DISTINCT FROM owner_operation.recipient_user_id
      OR fact.client_account_id IS DISTINCT FROM owner_operation.client_account_id
      OR fact.recipient_scope_id IS DISTINCT FROM owner_operation.client_account_id
      OR fact.recipient::text IS DISTINCT FROM reminder.email::text
      OR fact.locale IS DISTINCT FROM reminder.locale
      OR NOT EXISTS (
        SELECT 1
        FROM public.renewal_reminder_delivery_facts renewal_fact
        WHERE renewal_fact.intent_id = reminder.id
          AND renewal_fact.attempt_number = fact.attempt_number
          AND renewal_fact.provider_installation_id = fact.provider_installation_id
          AND renewal_fact.provider_operation_id = fact.provider_operation_id
          AND renewal_fact.provider_message_id = fact.provider_message_id
          AND renewal_fact.status = fact.status
          AND renewal_fact.failure_reason IS NOT DISTINCT FROM fact.failure_reason
          AND renewal_fact.provider_occurred_at = fact.provider_occurred_at
          AND renewal_fact.recorded_at = fact.recorded_at
      )
    )
  ORDER BY fact.id
  LIMIT 1;
  IF invalid_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 019 renewal notification fact % lacks its exact specialized projection',
      invalid_id;
  END IF;
END;
$$;

CREATE CONSTRAINT TRIGGER renewal_reminder_delivery_facts_projection_guard
AFTER INSERT ON public.renewal_reminder_delivery_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_renewal_notification_delivery_projection();

CREATE CONSTRAINT TRIGGER notification_delivery_facts_renewal_projection_guard
AFTER INSERT ON public.notification_delivery_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_renewal_notification_delivery_projection();
