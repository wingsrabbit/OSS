-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Schema 022 hardens Catalog scheduling, Quote expiry, and tracked supply.
-- Schema 020 is already published and must remain byte-for-byte unchanged;
-- every correction here is forward-only.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- Refuse ambiguous saved facts before adding invariants. Never rewrite a
-- published schedule or fabricate a missing supply relationship during an
-- upgrade.
DO $$
DECLARE
  invalid_fact text;
BEGIN
  SELECT price.id::text
  INTO invalid_fact
  FROM public.product_prices price
  WHERE price.valid_until IS NOT NULL
    AND price.valid_until <= price.valid_from
  ORDER BY price.id
  LIMIT 1;
  IF invalid_fact IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 022 refused Product price % with an invalid validity interval; repair forward before migration',
      invalid_fact;
  END IF;

  SELECT left_price.id::text || ':' || right_price.id::text
  INTO invalid_fact
  FROM public.product_prices left_price
  JOIN public.product_prices right_price
    ON right_price.id > left_price.id
   AND right_price.product_id = left_price.product_id
   AND right_price.currency = left_price.currency
   AND right_price.billing_cycle = left_price.billing_cycle
   AND pg_catalog.tstzrange(
         right_price.valid_from,
         right_price.valid_until,
         '[)'
       ) && pg_catalog.tstzrange(
         left_price.valid_from,
         left_price.valid_until,
         '[)'
       )
  ORDER BY left_price.id, right_price.id
  LIMIT 1;
  IF invalid_fact IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 022 refused overlapping Product price facts %; repair forward before migration',
      invalid_fact;
  END IF;

  SELECT left_promotion.id::text || ':' || right_promotion.id::text
  INTO invalid_fact
  FROM public.promotions left_promotion
  JOIN public.promotions right_promotion
    ON right_promotion.id > left_promotion.id
   AND right_promotion.code = left_promotion.code
   AND pg_catalog.tstzrange(
         right_promotion.valid_from,
         right_promotion.valid_until,
         '[)'
       ) && pg_catalog.tstzrange(
         left_promotion.valid_from,
         left_promotion.valid_until,
         '[)'
       )
  ORDER BY left_promotion.id, right_promotion.id
  LIMIT 1;
  IF invalid_fact IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 022 refused overlapping Promotion facts %; repair forward before migration',
      invalid_fact;
  END IF;

  SELECT reservation.id::text
  INTO invalid_fact
  FROM public.supply_capacity_reservations reservation
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.order_items item
    JOIN public.services service ON service.order_item_id = item.id
    WHERE item.order_id = reservation.order_id
      AND service.client_account_id = reservation.client_account_id
      AND item.product_id = reservation.product_id
  )
  ORDER BY reservation.id
  LIMIT 1;
  IF invalid_fact IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 022 refused orphaned supply Reservation %; repair forward before migration',
      invalid_fact;
  END IF;

  SELECT reservation.product_id
  INTO invalid_fact
  FROM public.supply_capacity_reservations reservation
  LEFT JOIN public.product_supply_capacities capacity
    ON capacity.product_id = reservation.product_id
  WHERE capacity.product_id IS NULL OR capacity.mode <> 'tracked'
  ORDER BY reservation.product_id
  LIMIT 1;
  IF invalid_fact IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 022 refused Reservation facts without tracked capacity for Product %; repair forward before migration',
      invalid_fact;
  END IF;

  SELECT capacity.product_id
  INTO invalid_fact
  FROM public.product_supply_capacities capacity
  LEFT JOIN LATERAL (
    SELECT COALESCE(pg_catalog.sum(reservation.units), 0) AS committed_units
    FROM public.supply_capacity_reservations reservation
    WHERE reservation.product_id = capacity.product_id
  ) reservations ON true
  WHERE capacity.committed_units <> reservations.committed_units
     OR (capacity.mode <> 'tracked' AND reservations.committed_units <> 0)
  ORDER BY capacity.product_id
  LIMIT 1;
  IF invalid_fact IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 022 refused a drifted saved supply projection for Product %; repair forward before migration',
      invalid_fact;
  END IF;
END
$$;

-- A price schedule is a half-open interval. Multiple currencies may coexist,
-- but a Product/Currency/Billing Cycle can never have overlapping historical
-- validity facts, even through direct SQL or a mutable active projection.
ALTER TABLE public.product_prices
  ADD CONSTRAINT product_prices_valid_interval_check
    CHECK (valid_until IS NULL OR valid_until > valid_from),
  ADD CONSTRAINT product_prices_validity_excl
  EXCLUDE USING gist (
    product_id WITH =,
    currency WITH =,
    billing_cycle WITH =,
    pg_catalog.tstzrange(valid_from, valid_until, '[)') WITH &&
  ) DEFERRABLE INITIALLY IMMEDIATE;

-- Promotion codes are canonical uppercase CITEXT facts. A code has exactly
-- one validity fact at an instant; revisions may meet at a half-open boundary
-- without overlapping.
ALTER TABLE public.promotions
  ADD CONSTRAINT promotions_validity_excl
  EXCLUDE USING gist (
    (code::text) WITH =,
    pg_catalog.tstzrange(valid_from, valid_until, '[)') WITH &&
  ) DEFERRABLE INITIALLY IMMEDIATE;

-- Quote expiry is wall-clock truth. transaction_timestamp()/now() would let a
-- transaction begun before expiry commit an Acceptance after expiry.
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
  IF quote_record.expires_at <= pg_catalog.clock_timestamp() THEN
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

-- Reservations remain immutable. A terminal Order or Service appends one
-- compensating release fact; the projection decrements exactly once.
CREATE TABLE public.supply_capacity_releases (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  reservation_id uuid NOT NULL UNIQUE
    REFERENCES public.supply_capacity_reservations(id),
  client_account_id uuid NOT NULL,
  product_id text NOT NULL REFERENCES public.products(id),
  order_id uuid NOT NULL UNIQUE,
  service_id uuid NOT NULL UNIQUE REFERENCES public.services(id),
  reason text NOT NULL CHECK (
    reason IN (
      'order_rejected',
      'order_cancelled',
      'service_terminated'
    )
  ),
  released_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (order_id, client_account_id)
    REFERENCES public.orders(id, client_account_id),
  FOREIGN KEY (service_id, client_account_id)
    REFERENCES public.services(id, client_account_id)
);

CREATE INDEX supply_capacity_reservations_product_idx
  ON public.supply_capacity_reservations(product_id, id);

CREATE INDEX supply_capacity_releases_product_idx
  ON public.supply_capacity_releases(product_id, released_at, id);

CREATE OR REPLACE FUNCTION public.opensales_validate_supply_capacity_release()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  reservation_record public.supply_capacity_reservations%ROWTYPE;
  order_status text;
  service_status text;
  service_account_id uuid;
  service_order_id uuid;
  service_product_id text;
BEGIN
  SELECT reservation.*
  INTO reservation_record
  FROM public.supply_capacity_reservations reservation
  WHERE reservation.id = NEW.reservation_id;

  IF reservation_record.id IS NULL THEN
    RAISE EXCEPTION 'Supply reservation % does not exist', NEW.reservation_id;
  END IF;
  IF reservation_record.client_account_id <> NEW.client_account_id
     OR reservation_record.product_id <> NEW.product_id
     OR reservation_record.order_id <> NEW.order_id THEN
    RAISE EXCEPTION 'Supply release identity does not match its reservation';
  END IF;

  SELECT original_order.status
  INTO order_status
  FROM public.orders original_order
  WHERE original_order.id = NEW.order_id
    AND original_order.client_account_id = NEW.client_account_id;

  SELECT service.status, service.client_account_id, item.order_id, item.product_id
  INTO service_status, service_account_id, service_order_id, service_product_id
  FROM public.services service
  JOIN public.order_items item ON item.id = service.order_item_id
  WHERE service.id = NEW.service_id;

  IF order_status IS NULL
     OR service_status IS NULL
     OR service_account_id <> NEW.client_account_id
     OR service_order_id <> NEW.order_id
     OR service_product_id <> NEW.product_id THEN
    RAISE EXCEPTION 'Supply release Service does not match its Order and Client Account';
  END IF;
  IF (NEW.reason = 'order_rejected' AND order_status <> 'rejected')
     OR (NEW.reason = 'order_cancelled' AND order_status <> 'cancelled')
     OR (NEW.reason = 'service_terminated' AND service_status <> 'terminated') THEN
    RAISE EXCEPTION 'Supply release reason does not match the terminal lifecycle state';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.product_supply_capacities capacity
    WHERE capacity.product_id = NEW.product_id
      AND capacity.mode = 'tracked'
  ) THEN
    RAISE EXCEPTION 'Supply release requires a tracked capacity definition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supply_capacity_releases_projection_guard
BEFORE INSERT ON public.supply_capacity_releases
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_supply_capacity_release();

CREATE OR REPLACE FUNCTION public.opensales_apply_supply_capacity_release()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  updated_product_id text;
BEGIN
  UPDATE public.product_supply_capacities capacity
  SET committed_units = capacity.committed_units - reservation.units,
      version = capacity.version + 1,
      updated_at = pg_catalog.clock_timestamp()
  FROM public.supply_capacity_reservations reservation
  WHERE reservation.id = NEW.reservation_id
    AND capacity.product_id = reservation.product_id
    AND capacity.mode = 'tracked'
    AND capacity.committed_units >= reservation.units
  RETURNING capacity.product_id INTO updated_product_id;

  IF updated_product_id IS NULL THEN
    RAISE EXCEPTION 'Supply release would make committed capacity invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supply_capacity_releases_apply_projection
AFTER INSERT ON public.supply_capacity_releases
FOR EACH ROW EXECUTE FUNCTION public.opensales_apply_supply_capacity_release();

CREATE TRIGGER supply_capacity_releases_immutable
BEFORE UPDATE OR DELETE ON public.supply_capacity_releases
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_catalog_commercial_fact_mutation();

CREATE OR REPLACE FUNCTION public.opensales_release_supply_for_terminal_service()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  reservation_record public.supply_capacity_reservations%ROWTYPE;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     OR NEW.status <> 'terminated' THEN
    RETURN NEW;
  END IF;

  SELECT reservation.*
  INTO reservation_record
  FROM public.supply_capacity_reservations reservation
  JOIN public.order_items item ON item.order_id = reservation.order_id
  WHERE item.id = NEW.order_item_id
    AND item.product_id = reservation.product_id
    AND NEW.client_account_id = reservation.client_account_id;

  IF reservation_record.id IS NOT NULL THEN
    INSERT INTO public.supply_capacity_releases(
      reservation_id,
      client_account_id,
      product_id,
      order_id,
      service_id,
      reason
    ) VALUES (
      reservation_record.id,
      reservation_record.client_account_id,
      reservation_record.product_id,
      reservation_record.order_id,
      NEW.id,
      'service_terminated'
    )
    ON CONFLICT (reservation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER services_release_supply_on_terminal
AFTER UPDATE OF status ON public.services
FOR EACH ROW EXECUTE FUNCTION public.opensales_release_supply_for_terminal_service();

CREATE OR REPLACE FUNCTION public.opensales_release_supply_for_terminal_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  reservation_record public.supply_capacity_reservations%ROWTYPE;
  service_id_value uuid;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     OR NEW.status NOT IN ('rejected', 'cancelled') THEN
    RETURN NEW;
  END IF;

  SELECT reservation.*
  INTO reservation_record
  FROM public.supply_capacity_reservations reservation
  WHERE reservation.order_id = NEW.id;

  IF reservation_record.id IS NOT NULL THEN
    SELECT service.id
    INTO service_id_value
    FROM public.order_items item
    JOIN public.services service ON service.order_item_id = item.id
    WHERE item.order_id = NEW.id
      AND item.product_id = reservation_record.product_id
      AND service.client_account_id = reservation_record.client_account_id
    ORDER BY service.id
    LIMIT 1;

    IF service_id_value IS NULL THEN
      RAISE EXCEPTION 'Tracked supply Order % has no Service to bind its release', NEW.id;
    END IF;

    INSERT INTO public.supply_capacity_releases(
      reservation_id,
      client_account_id,
      product_id,
      order_id,
      service_id,
      reason
    ) VALUES (
      reservation_record.id,
      reservation_record.client_account_id,
      reservation_record.product_id,
      reservation_record.order_id,
      service_id_value,
      CASE NEW.status
        WHEN 'rejected' THEN 'order_rejected'
        ELSE 'order_cancelled'
      END
    )
    ON CONFLICT (reservation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_release_supply_on_terminal
AFTER UPDATE OF status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.opensales_release_supply_for_terminal_order();

-- Once a terminal lifecycle fact has released tracked capacity, that exact
-- source cannot move backwards and silently create an active object outside
-- the committed projection. A new allocation would require a new Order and a
-- new Reservation fact.
CREATE OR REPLACE FUNCTION public.opensales_guard_released_supply_terminal_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'orders'
     AND OLD.status IN ('rejected', 'cancelled')
     AND NEW.status NOT IN ('rejected', 'cancelled')
     AND EXISTS (
       SELECT 1
       FROM public.supply_capacity_releases release_fact
       WHERE release_fact.order_id = OLD.id
     ) THEN
    RAISE EXCEPTION
      'An Order that released tracked supply cannot leave its terminal state';
  END IF;
  IF TG_TABLE_NAME = 'services'
     AND OLD.status = 'terminated'
     AND NEW.status <> 'terminated'
     AND EXISTS (
       SELECT 1
       FROM public.supply_capacity_releases release_fact
       WHERE release_fact.service_id = OLD.id
     ) THEN
    RAISE EXCEPTION
      'A Service that released tracked supply cannot leave terminated state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_released_supply_terminal_guard
BEFORE UPDATE OF status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_released_supply_terminal_state();

CREATE TRIGGER services_released_supply_terminal_guard
BEFORE UPDATE OF status ON public.services
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_released_supply_terminal_state();

-- The mutable committed_units column is a projection, never an independent
-- business fact. Validate it at transaction end so creation can increment the
-- projection before appending its Reservation, and release can decrement it
-- before appending its compensating fact, while no transaction may commit a
-- mismatched aggregate.
CREATE OR REPLACE FUNCTION public.opensales_validate_supply_capacity_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  product_id_value text;
  capacity_mode text;
  capacity_committed bigint;
  expected_committed bigint;
BEGIN
  product_id_value := COALESCE(NEW.product_id, OLD.product_id);

  SELECT capacity.mode, capacity.committed_units
  INTO capacity_mode, capacity_committed
  FROM public.product_supply_capacities capacity
  WHERE capacity.product_id = product_id_value;

  SELECT COALESCE(pg_catalog.sum(reservation.units), 0)
  INTO expected_committed
  FROM public.supply_capacity_reservations reservation
  WHERE reservation.product_id = product_id_value
    AND NOT EXISTS (
      SELECT 1
      FROM public.supply_capacity_releases release_fact
      WHERE release_fact.reservation_id = reservation.id
    );

  IF capacity_mode IS NULL THEN
    IF expected_committed <> 0 THEN
      RAISE EXCEPTION
        'Tracked supply projection for Product % is missing with % committed units',
        product_id_value,
        expected_committed;
    END IF;
    RETURN NULL;
  END IF;
  IF capacity_mode <> 'tracked' AND expected_committed <> 0 THEN
    RAISE EXCEPTION
      'Untracked supply projection for Product % has % committed units',
      product_id_value,
      expected_committed;
  END IF;
  IF capacity_committed <> expected_committed THEN
    RAISE EXCEPTION
      'Supply projection for Product % is %, expected % from active Reservations',
      product_id_value,
      capacity_committed,
      expected_committed;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER product_supply_capacities_projection_invariant
AFTER INSERT OR UPDATE OR DELETE ON public.product_supply_capacities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_supply_capacity_projection();

CREATE CONSTRAINT TRIGGER supply_capacity_reservations_projection_invariant
AFTER INSERT OR UPDATE OR DELETE ON public.supply_capacity_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_supply_capacity_projection();

CREATE CONSTRAINT TRIGGER supply_capacity_releases_projection_invariant
AFTER INSERT OR UPDATE OR DELETE ON public.supply_capacity_releases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_supply_capacity_projection();

-- Repair any saved terminal lifecycle facts created between Schema 020 and
-- this forward migration. The guarded INSERT is idempotent and serialized per
-- Reservation.
INSERT INTO public.supply_capacity_releases(
  reservation_id,
  client_account_id,
  product_id,
  order_id,
  service_id,
  reason,
  released_at
)
SELECT
  reservation.id,
  reservation.client_account_id,
  reservation.product_id,
  reservation.order_id,
  linked_service.id,
  CASE
    WHEN original_order.status = 'rejected' THEN 'order_rejected'
    WHEN original_order.status = 'cancelled' THEN 'order_cancelled'
    ELSE 'service_terminated'
  END,
  pg_catalog.clock_timestamp()
FROM public.supply_capacity_reservations reservation
JOIN public.orders original_order ON original_order.id = reservation.order_id
JOIN LATERAL (
  SELECT service.id, service.status
  FROM public.order_items item
  JOIN public.services service ON service.order_item_id = item.id
  WHERE item.order_id = reservation.order_id
    AND item.product_id = reservation.product_id
    AND service.client_account_id = reservation.client_account_id
  ORDER BY
    CASE
      WHEN service.status = 'terminated' THEN 0
      ELSE 1
    END,
    service.id
  LIMIT 1
) linked_service ON true
WHERE original_order.status IN ('rejected', 'cancelled')
   OR linked_service.status = 'terminated'
ORDER BY reservation.id;

DO $$
DECLARE
  invalid_product_id text;
BEGIN
  SELECT capacity.product_id
  INTO invalid_product_id
  FROM public.product_supply_capacities capacity
  LEFT JOIN LATERAL (
    SELECT COALESCE(pg_catalog.sum(reservation.units), 0) AS committed_units
    FROM public.supply_capacity_reservations reservation
    WHERE reservation.product_id = capacity.product_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.supply_capacity_releases release_fact
        WHERE release_fact.reservation_id = reservation.id
      )
  ) active_reservations ON true
  WHERE capacity.committed_units <> active_reservations.committed_units
     OR (capacity.mode <> 'tracked' AND active_reservations.committed_units <> 0)
  ORDER BY capacity.product_id
  LIMIT 1;

  IF invalid_product_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 022 refused a drifted supply projection for Product %; repair forward before migration',
      invalid_product_id;
  END IF;
END
$$;
