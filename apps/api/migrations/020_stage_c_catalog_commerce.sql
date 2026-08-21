-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Schema 020 makes Catalog and commercial decisions append-only. Existing
-- mutable product rows remain the current projection, while every checkout and
-- Quote points at an immutable product revision and price snapshot.

DO $$
DECLARE
  invalid_product_id text;
BEGIN
  SELECT product.id
  INTO invalid_product_id
  FROM public.products product
  WHERE pg_catalog.jsonb_typeof(product.names) <> 'object'
     OR pg_catalog.jsonb_typeof(product.descriptions) <> 'object'
     OR pg_catalog.jsonb_typeof(product.option_schema) <> 'array'
  ORDER BY product.id
  LIMIT 1;

  IF invalid_product_id IS NOT NULL THEN
    RAISE EXCEPTION
      'schema 020 requires product % to have object names/descriptions and an array option schema; repair forward before migration',
      invalid_product_id;
  END IF;
END
$$;

CREATE TABLE public.catalog_product_revisions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  product_id text NOT NULL REFERENCES public.products(id),
  revision integer NOT NULL CHECK (revision > 0),
  group_id text NOT NULL REFERENCES public.product_groups(id),
  names jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(names) = 'object'),
  descriptions jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(descriptions) = 'object'),
  fulfillment_mode text NOT NULL CHECK (
    fulfillment_mode IN ('automatic', 'review', 'manual', 'quote')
  ),
  active boolean NOT NULL,
  hidden boolean NOT NULL,
  repeatable boolean NOT NULL,
  option_schema jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(option_schema) = 'array'),
  created_by_staff_user_id uuid REFERENCES public.staff_members(user_id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (product_id, revision),
  UNIQUE (id, product_id)
);

INSERT INTO public.catalog_product_revisions(
  product_id,
  revision,
  group_id,
  names,
  descriptions,
  fulfillment_mode,
  active,
  hidden,
  repeatable,
  option_schema
)
SELECT
  product.id,
  1,
  product.group_id,
  product.names,
  product.descriptions,
  product.fulfillment_mode,
  product.active,
  product.hidden,
  product.repeatable,
  product.option_schema
FROM public.products product
ORDER BY product.id;

ALTER TABLE public.product_prices
  ADD COLUMN catalog_product_revision_id uuid;

UPDATE public.product_prices price
SET catalog_product_revision_id = revision.id
FROM public.catalog_product_revisions revision
WHERE revision.product_id = price.product_id
  AND revision.revision = 1;

ALTER TABLE public.product_prices
  ALTER COLUMN catalog_product_revision_id SET NOT NULL,
  ADD CONSTRAINT product_prices_catalog_revision_fkey
    FOREIGN KEY (catalog_product_revision_id, product_id)
    REFERENCES public.catalog_product_revisions(id, product_id),
  ADD CONSTRAINT product_prices_id_product_key UNIQUE (id, product_id);

CREATE TABLE public.promotions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  code public.citext NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL CHECK (pg_catalog.btrim(name) <> ''),
  product_id text REFERENCES public.products(id),
  billing_cycle text CHECK (
    billing_cycle IS NULL OR
    billing_cycle IN ('monthly', 'quarterly', 'semiannual', 'annual', 'one_time')
  ),
  discount_kind text NOT NULL CHECK (discount_kind IN ('fixed', 'percentage')),
  application_scope text NOT NULL CHECK (application_scope IN ('one_time', 'recurring', 'all')),
  fixed_amount_minor bigint,
  percentage_basis_points integer,
  currency text,
  active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT pg_catalog.now(),
  valid_until timestamptz,
  maximum_redemptions bigint CHECK (maximum_redemptions IS NULL OR maximum_redemptions > 0),
  created_by_staff_user_id uuid NOT NULL REFERENCES public.staff_members(user_id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (code, revision),
  CHECK (code::text ~ '^[A-Z0-9][A-Z0-9_-]{2,63}$'),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (
    (
      discount_kind = 'fixed'
      AND fixed_amount_minor IS NOT NULL
      AND fixed_amount_minor > 0
      AND percentage_basis_points IS NULL
      AND currency ~ '^[A-Z]{3}$'
    )
    OR
    (
      discount_kind = 'percentage'
      AND fixed_amount_minor IS NULL
      AND percentage_basis_points BETWEEN 1 AND 10000
      AND currency IS NULL
    )
  )
);

CREATE INDEX promotions_lookup_idx
  ON public.promotions (code, valid_from, id)
  WHERE active;

CREATE TABLE public.product_supply_capacities (
  product_id text PRIMARY KEY REFERENCES public.products(id),
  mode text NOT NULL CHECK (mode IN ('unlimited', 'tracked', 'manual_review')),
  available_units bigint,
  committed_units bigint NOT NULL DEFAULT 0 CHECK (committed_units >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_staff_user_id uuid NOT NULL REFERENCES public.staff_members(user_id),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (
    (mode = 'tracked' AND available_units IS NOT NULL AND available_units >= 0
      AND committed_units <= available_units)
    OR (mode <> 'tracked' AND available_units IS NULL AND committed_units = 0)
  )
);

CREATE TABLE public.sales_quotes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES public.client_accounts(id),
  created_by_staff_user_id uuid NOT NULL REFERENCES public.staff_members(user_id),
  product_id text NOT NULL REFERENCES public.products(id),
  catalog_product_revision_id uuid NOT NULL,
  product_price_id uuid,
  product_name text NOT NULL CHECK (pg_catalog.btrim(product_name) <> ''),
  fulfillment_mode text NOT NULL CHECK (
    fulfillment_mode IN ('automatic', 'review', 'manual', 'quote')
  ),
  billing_cycle text NOT NULL CHECK (
    billing_cycle IN ('monthly', 'quarterly', 'semiannual', 'annual', 'one_time')
  ),
  configuration jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(configuration) = 'object'),
  price_snapshot jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(price_snapshot) = 'object'),
  promotion_id uuid REFERENCES public.promotions(id),
  promotion_snapshot jsonb CHECK (
    promotion_snapshot IS NULL OR pg_catalog.jsonb_typeof(promotion_snapshot) = 'object'
  ),
  capacity_snapshot jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(capacity_snapshot) = 'object'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  one_time_minor bigint NOT NULL CHECK (one_time_minor >= 0),
  setup_minor bigint NOT NULL CHECK (setup_minor >= 0),
  recurring_minor bigint NOT NULL CHECK (recurring_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  expires_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (
    pg_catalog.char_length(idempotency_key) BETWEEN 8 AND 128
  ),
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (created_by_staff_user_id, idempotency_key),
  UNIQUE (id, client_account_id),
  FOREIGN KEY (catalog_product_revision_id, product_id)
    REFERENCES public.catalog_product_revisions(id, product_id),
  FOREIGN KEY (product_price_id, product_id)
    REFERENCES public.product_prices(id, product_id),
  CHECK (expires_at > created_at),
  CHECK ((promotion_id IS NULL) = (promotion_snapshot IS NULL)),
  CHECK (total_minor = one_time_minor + setup_minor + recurring_minor)
);

CREATE INDEX sales_quotes_account_idx
  ON public.sales_quotes (client_account_id, created_at DESC, id DESC);

CREATE TABLE public.sales_quote_voids (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  quote_id uuid NOT NULL UNIQUE REFERENCES public.sales_quotes(id),
  voided_by_staff_user_id uuid NOT NULL REFERENCES public.staff_members(user_id),
  reason text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 10 AND 1000),
  voided_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.orders
  ADD COLUMN source_quote_id uuid,
  ADD CONSTRAINT orders_source_quote_fkey
    FOREIGN KEY (source_quote_id, client_account_id)
    REFERENCES public.sales_quotes(id, client_account_id),
  ADD CONSTRAINT orders_source_quote_key UNIQUE (source_quote_id);

CREATE TABLE public.order_legal_acceptances (
  order_id uuid NOT NULL,
  client_account_id uuid NOT NULL,
  legal_acceptance_id uuid NOT NULL UNIQUE REFERENCES public.legal_acceptances(id),
  document_kind text NOT NULL CHECK (document_kind IN ('terms', 'aup')),
  PRIMARY KEY (order_id, document_kind),
  FOREIGN KEY (order_id, client_account_id)
    REFERENCES public.orders(id, client_account_id)
);

CREATE TABLE public.sales_quote_acceptances (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  quote_id uuid NOT NULL UNIQUE,
  client_account_id uuid NOT NULL,
  accepted_by_user_id uuid NOT NULL REFERENCES public.users(id),
  order_id uuid NOT NULL UNIQUE,
  invoice_id uuid NOT NULL UNIQUE,
  terms_document_id uuid NOT NULL REFERENCES public.legal_documents(id),
  aup_document_id uuid NOT NULL REFERENCES public.legal_documents(id),
  idempotency_key text NOT NULL CHECK (
    pg_catalog.char_length(idempotency_key) BETWEEN 8 AND 128
  ),
  request_fingerprint text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (client_account_id, idempotency_key),
  FOREIGN KEY (quote_id, client_account_id)
    REFERENCES public.sales_quotes(id, client_account_id),
  FOREIGN KEY (order_id, client_account_id)
    REFERENCES public.orders(id, client_account_id),
  FOREIGN KEY (invoice_id, client_account_id)
    REFERENCES public.invoices(id, client_account_id)
);

CREATE TABLE public.promotion_redemptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES public.promotions(id),
  client_account_id uuid NOT NULL,
  order_id uuid NOT NULL,
  quote_id uuid,
  one_time_discount_minor bigint NOT NULL CHECK (one_time_discount_minor >= 0),
  recurring_discount_minor bigint NOT NULL CHECK (recurring_discount_minor >= 0),
  snapshot jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(snapshot) = 'object'),
  redeemed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (promotion_id, order_id),
  FOREIGN KEY (order_id, client_account_id)
    REFERENCES public.orders(id, client_account_id),
  FOREIGN KEY (quote_id, client_account_id)
    REFERENCES public.sales_quotes(id, client_account_id),
  CHECK (one_time_discount_minor > 0 OR recurring_discount_minor > 0)
);

CREATE TABLE public.supply_capacity_reservations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  client_account_id uuid NOT NULL,
  product_id text NOT NULL REFERENCES public.products(id),
  order_id uuid NOT NULL UNIQUE,
  units bigint NOT NULL CHECK (units > 0),
  capacity_snapshot jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(capacity_snapshot) = 'object'
  ),
  reserved_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  FOREIGN KEY (order_id, client_account_id)
    REFERENCES public.orders(id, client_account_id)
);

CREATE TABLE public.marketing_consent_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  client_account_id uuid NOT NULL REFERENCES public.client_accounts(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  decision text NOT NULL CHECK (decision IN ('granted', 'revoked')),
  policy_version text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(policy_version)) BETWEEN 1 AND 80
  ),
  source text NOT NULL CHECK (source IN ('checkout', 'quote_acceptance', 'preferences')),
  idempotency_key text NOT NULL CHECK (
    pg_catalog.char_length(idempotency_key) BETWEEN 8 AND 128
  ),
  request_fingerprint text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (client_account_id, user_id, idempotency_key)
);

CREATE INDEX marketing_consent_events_current_idx
  ON public.marketing_consent_events (
    client_account_id,
    user_id,
    recorded_at DESC,
    id DESC
  );

CREATE OR REPLACE VIEW public.current_marketing_consents AS
SELECT DISTINCT ON (client_account_id, user_id)
  client_account_id,
  user_id,
  decision = 'granted' AS granted,
  policy_version,
  recorded_at
FROM public.marketing_consent_events
ORDER BY client_account_id, user_id, recorded_at DESC, id DESC;

CREATE OR REPLACE FUNCTION public.opensales_reject_catalog_commercial_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION
    '% facts are append-only; create a new revision or compensating fact',
    TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER catalog_product_revisions_immutable
BEFORE UPDATE OR DELETE ON public.catalog_product_revisions
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_catalog_commercial_fact_mutation();

CREATE TRIGGER sales_quotes_immutable
BEFORE UPDATE OR DELETE ON public.sales_quotes
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_catalog_commercial_fact_mutation();

CREATE TRIGGER sales_quote_voids_immutable
BEFORE UPDATE OR DELETE ON public.sales_quote_voids
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_catalog_commercial_fact_mutation();

CREATE TRIGGER sales_quote_acceptances_immutable
BEFORE UPDATE OR DELETE ON public.sales_quote_acceptances
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_catalog_commercial_fact_mutation();

CREATE TRIGGER order_legal_acceptances_immutable
BEFORE UPDATE OR DELETE ON public.order_legal_acceptances
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_catalog_commercial_fact_mutation();

CREATE TRIGGER promotion_redemptions_immutable
BEFORE UPDATE OR DELETE ON public.promotion_redemptions
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_catalog_commercial_fact_mutation();

CREATE TRIGGER supply_capacity_reservations_immutable
BEFORE UPDATE OR DELETE ON public.supply_capacity_reservations
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_catalog_commercial_fact_mutation();

CREATE TRIGGER marketing_consent_events_immutable
BEFORE UPDATE OR DELETE ON public.marketing_consent_events
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_catalog_commercial_fact_mutation();

CREATE OR REPLACE FUNCTION public.opensales_guard_product_price_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Product price revisions are historical facts and cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.catalog_product_revision_id IS DISTINCT FROM OLD.catalog_product_revision_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.billing_cycle IS DISTINCT FROM OLD.billing_cycle
     OR NEW.one_time_minor IS DISTINCT FROM OLD.one_time_minor
     OR NEW.setup_minor IS DISTINCT FROM OLD.setup_minor
     OR NEW.recurring_minor IS DISTINCT FROM OLD.recurring_minor
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
    RAISE EXCEPTION 'Product price values are immutable; append a new price revision';
  END IF;
  IF OLD.active = false AND NEW.active = true THEN
    RAISE EXCEPTION 'Retired product price revisions cannot be reactivated';
  END IF;
  IF OLD.valid_until IS NOT NULL
     AND NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
    RAISE EXCEPTION 'A closed product price validity interval cannot be changed';
  END IF;
  IF NEW.valid_until IS NOT NULL AND NEW.valid_until <= NEW.valid_from THEN
    RAISE EXCEPTION 'Product price validity must end after it begins';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_prices_revision_guard
BEFORE UPDATE OR DELETE ON public.product_prices
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_product_price_revision();

CREATE OR REPLACE FUNCTION public.opensales_guard_promotion_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Promotion revisions are historical facts and cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.billing_cycle IS DISTINCT FROM OLD.billing_cycle
     OR NEW.discount_kind IS DISTINCT FROM OLD.discount_kind
     OR NEW.application_scope IS DISTINCT FROM OLD.application_scope
     OR NEW.fixed_amount_minor IS DISTINCT FROM OLD.fixed_amount_minor
     OR NEW.percentage_basis_points IS DISTINCT FROM OLD.percentage_basis_points
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.maximum_redemptions IS DISTINCT FROM OLD.maximum_redemptions
     OR NEW.created_by_staff_user_id IS DISTINCT FROM OLD.created_by_staff_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Promotion revision values are immutable; append a new revision';
  END IF;
  IF OLD.active = false AND NEW.active = true THEN
    RAISE EXCEPTION 'Retired Promotion revisions cannot be reactivated';
  END IF;
  IF OLD.valid_until IS NOT NULL
     AND NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
    RAISE EXCEPTION 'A closed Promotion validity interval cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER promotions_revision_guard
BEFORE UPDATE OR DELETE ON public.promotions
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_promotion_revision();

CREATE OR REPLACE FUNCTION public.opensales_validate_quote_terminal_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  quote_record public.sales_quotes%ROWTYPE;
  related_account_id uuid;
BEGIN
  SELECT quote.*
  INTO quote_record
  FROM public.sales_quotes quote
  WHERE quote.id = NEW.quote_id
  FOR UPDATE;

  IF quote_record.id IS NULL THEN
    RAISE EXCEPTION 'Quote % does not exist', NEW.quote_id;
  END IF;

  IF TG_TABLE_NAME = 'sales_quote_voids' THEN
    IF EXISTS (
      SELECT 1 FROM public.sales_quote_acceptances acceptance
      WHERE acceptance.quote_id = NEW.quote_id
    ) THEN
      RAISE EXCEPTION 'Accepted Quotes cannot be voided';
    END IF;
    RETURN NEW;
  END IF;

  IF quote_record.client_account_id <> NEW.client_account_id THEN
    RAISE EXCEPTION 'Quote acceptance Client Account does not match the Quote';
  END IF;
  IF quote_record.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'Expired Quotes cannot be accepted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sales_quote_voids void_fact
    WHERE void_fact.quote_id = NEW.quote_id
  ) THEN
    RAISE EXCEPTION 'Voided Quotes cannot be accepted';
  END IF;

  SELECT original_order.client_account_id
  INTO related_account_id
  FROM public.orders original_order
  WHERE original_order.id = NEW.order_id
    AND original_order.source_quote_id = NEW.quote_id;
  IF related_account_id IS DISTINCT FROM NEW.client_account_id THEN
    RAISE EXCEPTION 'Quote acceptance Order does not match the Quote and Client Account';
  END IF;

  SELECT invoice.client_account_id
  INTO related_account_id
  FROM public.invoices invoice
  WHERE invoice.id = NEW.invoice_id
    AND invoice.order_id = NEW.order_id;
  IF related_account_id IS DISTINCT FROM NEW.client_account_id THEN
    RAISE EXCEPTION 'Quote acceptance Invoice does not match the Order and Client Account';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_quote_voids_terminal_guard
BEFORE INSERT ON public.sales_quote_voids
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_quote_terminal_fact();

CREATE TRIGGER sales_quote_acceptances_terminal_guard
BEFORE INSERT ON public.sales_quote_acceptances
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_quote_terminal_fact();

CREATE OR REPLACE FUNCTION public.opensales_guard_order_source_quote()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.source_quote_id IS DISTINCT FROM OLD.source_quote_id THEN
    RAISE EXCEPTION 'Order source Quote is immutable; use a compensating fact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_source_quote_immutable
BEFORE UPDATE OF source_quote_id ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_order_source_quote();

CREATE OR REPLACE FUNCTION public.opensales_validate_marketing_consent_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.client_memberships membership
    WHERE membership.client_account_id = NEW.client_account_id
      AND membership.user_id = NEW.user_id
      AND membership.removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Marketing Consent actor must be an active Client Account member';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER marketing_consent_events_membership_guard
BEFORE INSERT ON public.marketing_consent_events
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_marketing_consent_event();
