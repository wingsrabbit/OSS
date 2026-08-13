-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Full Support operations remain inside the synthetic Mock-only laboratory.
-- This migration is forward-only: existing Schema 018 tickets are preserved
-- and receive explicit baseline routing/state facts.

CREATE TABLE public.support_departments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  code public.citext NOT NULL UNIQUE,
  current_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (code::text ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

CREATE TABLE public.support_department_revisions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES public.support_departments(id),
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(name)) BETWEEN 2 AND 120),
  description text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(description) <= 2000),
  accepts_authenticated boolean NOT NULL DEFAULT true,
  accepts_presales boolean NOT NULL DEFAULT false,
  created_by_staff_user_id uuid REFERENCES public.staff_members(user_id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (department_id, revision),
  UNIQUE (id, department_id)
);

CREATE TABLE public.support_department_revision_retirements (
  revision_id uuid PRIMARY KEY REFERENCES public.support_department_revisions(id),
  retired_by_staff_user_id uuid NOT NULL REFERENCES public.staff_members(user_id),
  reason text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000
  ),
  retired_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

DO $$
DECLARE
  department_id uuid := pg_catalog.gen_random_uuid();
DECLARE
  revision_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  INSERT INTO public.support_departments(id, code)
  VALUES (department_id, 'general-support');
  INSERT INTO public.support_department_revisions(
    id, department_id, revision, name, description,
    accepts_authenticated, accepts_presales
  ) VALUES (
    revision_id, department_id, 1, 'General Support',
    'Synthetic default department created while upgrading existing tickets.',
    true, true
  );
  UPDATE public.support_departments
  SET current_revision_id = revision_id
  WHERE id = department_id;
END
$$;

ALTER TABLE public.support_departments
  ALTER COLUMN current_revision_id SET NOT NULL,
  ADD CONSTRAINT support_departments_current_revision_fkey
    FOREIGN KEY (current_revision_id, id)
    REFERENCES public.support_department_revisions(id, department_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.support_tickets
  ADD COLUMN department_revision_id uuid,
  ADD COLUMN priority text NOT NULL DEFAULT 'normal'
    CONSTRAINT support_tickets_priority_check
      CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  ADD COLUMN order_id uuid,
  ADD COLUMN authorization_purpose text CONSTRAINT support_tickets_authorization_purpose_check CHECK (
    authorization_purpose IS NULL OR authorization_purpose IN (
      'bgp', 'remote_hands', 'colocation_inbound',
      'colocation_outbound', 'third_party_refund'
    )
  ),
  ADD COLUMN current_status_event_id uuid,
  ADD CONSTRAINT support_tickets_order_account_fkey
    FOREIGN KEY (order_id, client_account_id)
    REFERENCES public.orders(id, client_account_id),
  ADD CONSTRAINT support_tickets_department_revision_fkey
    FOREIGN KEY (department_revision_id)
    REFERENCES public.support_department_revisions(id),
  ADD CONSTRAINT support_tickets_authorization_reference_check
    CHECK (
      authorization_purpose IS NULL
      OR service_id IS NOT NULL
      OR order_id IS NOT NULL
    );

UPDATE public.support_tickets
SET department_revision_id = (
  SELECT revision.id
  FROM public.support_department_revisions revision
  JOIN public.support_departments department ON department.id = revision.department_id
  WHERE department.code = 'general-support'
    AND revision.id = department.current_revision_id
);

ALTER TABLE public.support_tickets
  ALTER COLUMN department_revision_id SET NOT NULL;

CREATE TABLE public.support_ticket_status_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  ticket_id uuid NOT NULL,
  previous_status text CHECK (
    previous_status IS NULL OR
    previous_status IN ('awaiting_staff', 'awaiting_customer', 'closed')
  ),
  status text NOT NULL CHECK (status IN ('awaiting_staff', 'awaiting_customer', 'closed')),
  actor_type text NOT NULL CHECK (actor_type IN ('migration', 'customer', 'staff', 'system')),
  actor_user_id uuid REFERENCES public.users(id),
  reason text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  FOREIGN KEY (ticket_id) REFERENCES public.support_tickets(id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((actor_type = 'migration') = (actor_user_id IS NULL))
);

INSERT INTO public.support_ticket_status_events(
  ticket_id, previous_status, status, actor_type, actor_user_id, reason, occurred_at
)
SELECT id, NULL, status, 'migration', NULL,
       'Schema 021 baseline for a preserved Support ticket', created_at
FROM public.support_tickets;

UPDATE public.support_tickets ticket
SET current_status_event_id = event.id
FROM public.support_ticket_status_events event
WHERE event.ticket_id = ticket.id AND event.previous_status IS NULL;

ALTER TABLE public.support_tickets
  ALTER COLUMN current_status_event_id SET NOT NULL,
  ADD CONSTRAINT support_tickets_current_status_event_fkey
    FOREIGN KEY (current_status_event_id)
    REFERENCES public.support_ticket_status_events(id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.support_ticket_assignment_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id),
  assigned_staff_user_id uuid REFERENCES public.staff_members(user_id),
  actor_staff_user_id uuid NOT NULL REFERENCES public.staff_members(user_id),
  sequence integer NOT NULL CHECK (sequence > 0),
  reason text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (ticket_id, sequence)
);

CREATE INDEX support_ticket_assignment_events_latest_idx
  ON public.support_ticket_assignment_events(ticket_id, occurred_at DESC, id DESC);

CREATE TABLE public.support_ticket_routing_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id),
  department_revision_id uuid NOT NULL REFERENCES public.support_department_revisions(id),
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  actor_staff_user_id uuid NOT NULL REFERENCES public.staff_members(user_id),
  sequence integer NOT NULL CHECK (sequence > 0),
  reason text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (ticket_id, sequence)
);

CREATE INDEX support_ticket_routing_events_latest_idx
  ON public.support_ticket_routing_events(ticket_id, occurred_at DESC, id DESC);

ALTER TABLE public.support_ticket_messages
  ADD CONSTRAINT support_ticket_messages_id_ticket_key UNIQUE (id, ticket_id),
  ADD CONSTRAINT support_ticket_messages_id_ticket_visibility_key
    UNIQUE (id, ticket_id, visibility);

CREATE TABLE public.support_ticket_attachments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  ticket_id uuid NOT NULL,
  message_id uuid NOT NULL,
  uploaded_by_user_id uuid NOT NULL REFERENCES public.users(id),
  uploaded_by_type text NOT NULL CHECK (uploaded_by_type IN ('customer', 'staff')),
  visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
  original_filename text NOT NULL CHECK (
    pg_catalog.char_length(original_filename) BETWEEN 1 AND 180
    AND original_filename !~ '[\\/"[:cntrl:]]'
  ),
  extension text NOT NULL CHECK (
    extension IN ('txt', 'log', 'csv', 'pdf', 'png', 'jpg', 'jpeg')
  ),
  declared_content_type text NOT NULL CHECK (
    declared_content_type IN (
      'text/plain', 'text/csv', 'application/pdf',
      'image/png', 'image/jpeg'
    )
  ),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  sha256 bytea NOT NULL CHECK (pg_catalog.octet_length(sha256) = 32),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  FOREIGN KEY (message_id, ticket_id, visibility)
    REFERENCES public.support_ticket_messages(id, ticket_id, visibility),
  CHECK (visibility = 'public' OR uploaded_by_type = 'staff'),
  CHECK (pg_catalog.octet_length(content) = size_bytes),
  CHECK (public.digest(content, 'sha256') = sha256),
  CHECK (pg_catalog.lower(original_filename) LIKE ('%.' || extension))
);

CREATE INDEX support_ticket_attachments_ticket_idx
  ON public.support_ticket_attachments(ticket_id, created_at, id);

CREATE TABLE public.support_ticket_attachment_scan_facts (
  attachment_id uuid PRIMARY KEY REFERENCES public.support_ticket_attachments(id),
  scanner text NOT NULL CHECK (scanner = 'mock-attachment-scanner-v1'),
  recorded_by_staff_user_id uuid NOT NULL REFERENCES public.staff_members(user_id),
  verdict text NOT NULL CHECK (verdict IN ('clean', 'rejected', 'error')),
  content_sha256 bytea NOT NULL CHECK (pg_catalog.octet_length(content_sha256) = 32),
  reason_code text CHECK (
    reason_code IS NULL OR (
      pg_catalog.char_length(pg_catalog.btrim(reason_code)) BETWEEN 1 AND 120
      AND reason_code ~ '^[a-z0-9_]+$'
    )
  ),
  scanned_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((verdict = 'clean') = (reason_code IS NULL))
);

CREATE TABLE public.support_ticket_attachment_deletions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  attachment_id uuid NOT NULL UNIQUE REFERENCES public.support_ticket_attachments(id),
  deleted_by_user_id uuid NOT NULL REFERENCES public.users(id),
  deleted_by_type text NOT NULL CHECK (deleted_by_type IN ('customer', 'staff')),
  reason text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000),
  deleted_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE public.presales_inquiries (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  access_token_digest bytea NOT NULL UNIQUE CHECK (
    pg_catalog.octet_length(access_token_digest) = 32
  ),
  access_expires_at timestamptz NOT NULL,
  department_revision_id uuid NOT NULL REFERENCES public.support_department_revisions(id),
  visitor_name text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(visitor_name)) BETWEEN 2 AND 120
  ),
  visitor_email public.citext NOT NULL,
  topic text NOT NULL CHECK (topic IN ('general_sales', 'product_question')),
  subject text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(subject)) BETWEEN 3 AND 160),
  status text NOT NULL CHECK (status IN ('awaiting_staff', 'awaiting_visitor', 'closed')),
  current_status_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (access_expires_at > created_at)
);

CREATE TABLE public.presales_inquiry_status_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  inquiry_id uuid NOT NULL,
  previous_status text CHECK (
    previous_status IS NULL OR
    previous_status IN ('awaiting_staff', 'awaiting_visitor', 'closed')
  ),
  status text NOT NULL CHECK (status IN ('awaiting_staff', 'awaiting_visitor', 'closed')),
  actor_type text NOT NULL CHECK (actor_type IN ('visitor', 'staff', 'system')),
  actor_user_id uuid REFERENCES public.users(id),
  reason text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  FOREIGN KEY (inquiry_id) REFERENCES public.presales_inquiries(id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((actor_type = 'visitor') = (actor_user_id IS NULL))
);

ALTER TABLE public.presales_inquiries
  ADD CONSTRAINT presales_inquiries_status_event_fkey
    FOREIGN KEY (current_status_event_id)
    REFERENCES public.presales_inquiry_status_events(id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.presales_inquiry_messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  inquiry_id uuid NOT NULL REFERENCES public.presales_inquiries(id),
  author_type text NOT NULL CHECK (author_type IN ('visitor', 'staff')),
  author_user_id uuid REFERENCES public.users(id),
  visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
  body text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(body)) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK ((author_type = 'visitor') = (author_user_id IS NULL)),
  CHECK (visibility = 'public' OR author_type = 'staff')
);

CREATE TABLE public.presales_inquiry_access_revocations (
  inquiry_id uuid PRIMARY KEY REFERENCES public.presales_inquiries(id),
  revoked_by_staff_user_id uuid NOT NULL REFERENCES public.staff_members(user_id),
  reason text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000
  ),
  revoked_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX presales_inquiries_queue_idx
  ON public.presales_inquiries(updated_at DESC, id DESC);

CREATE INDEX presales_inquiry_messages_history_idx
  ON public.presales_inquiry_messages(inquiry_id, created_at, id);

CREATE OR REPLACE FUNCTION public.opensales_reject_support_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Support history facts are append-only';
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_ticket_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_row record;
BEGIN
  SELECT event.ticket_id, event.previous_status, event.status
  INTO event_row
  FROM public.support_ticket_status_events event
  WHERE event.id = NEW.current_status_event_id;

  IF event_row IS NULL
     OR event_row.ticket_id <> NEW.id
     OR event_row.status <> NEW.status
     OR (TG_OP = 'INSERT' AND event_row.previous_status IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.status <> OLD.status AND (
       NEW.current_status_event_id = OLD.current_status_event_id
       OR event_row.previous_status IS DISTINCT FROM OLD.status
     ))
     OR (TG_OP = 'UPDATE' AND NEW.status = OLD.status
       AND NEW.current_status_event_id <> OLD.current_status_event_id)
  THEN
    RAISE EXCEPTION 'Support ticket current status must reference its exact append-only transition';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_ticket_status_event_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ticket_row record;
DECLARE
  target_account_id uuid;
DECLARE
  actor_eligible boolean;
BEGIN
  IF NEW.previous_status IS NULL THEN
    IF NEW.status <> 'awaiting_staff' OR NEW.actor_type <> 'customer' THEN
      RAISE EXCEPTION 'Initial Support ticket state must await Staff';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.support_tickets ticket WHERE ticket.id = NEW.ticket_id
    ) THEN
      RAISE EXCEPTION 'A Support ticket can have only one initial status event';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.actor_type = 'staff' THEN
    PERFORM 1 FROM public.users principal
    WHERE principal.id = NEW.actor_user_id
      AND principal.email_verified_at IS NOT NULL
      AND principal.restricted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Support ticket status actor is not eligible';
    END IF;
    SELECT staff.active AND (
      staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage'
    ) INTO actor_eligible
    FROM public.staff_members staff
    WHERE staff.user_id = NEW.actor_user_id
    FOR SHARE;
  ELSIF NEW.actor_type = 'customer' THEN
    PERFORM 1 FROM public.users principal
    WHERE principal.id = NEW.actor_user_id
      AND principal.email_verified_at IS NOT NULL
      AND principal.restricted_at IS NULL
    FOR SHARE;
    SELECT ticket.client_account_id INTO target_account_id
    FROM public.support_tickets ticket
    WHERE ticket.id = NEW.ticket_id;
    PERFORM 1 FROM public.client_accounts account
    WHERE account.id = target_account_id
    FOR SHARE;
    SELECT true INTO actor_eligible
    FROM public.client_memberships membership
    WHERE membership.client_account_id = target_account_id
      AND membership.user_id = NEW.actor_user_id
      AND membership.removed_at IS NULL
      AND membership.restricted_at IS NULL
    FOR SHARE;
  END IF;
  IF actor_eligible IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Support ticket status actor is not eligible';
  END IF;

  SELECT ticket.status, ticket.current_status_event_id
  INTO ticket_row
  FROM public.support_tickets ticket
  WHERE ticket.id = NEW.ticket_id
  FOR UPDATE;

  IF ticket_row IS NULL OR ticket_row.status <> NEW.previous_status
     OR NEW.status = NEW.previous_status
     OR (NEW.actor_type = 'customer' AND NOT (
       (NEW.status = 'awaiting_staff'
        AND NEW.previous_status IN ('awaiting_customer', 'closed'))
       OR (NEW.status = 'closed' AND NEW.previous_status <> 'closed')
     ))
     OR (NEW.actor_type = 'staff' AND NEW.status NOT IN (
       'awaiting_staff', 'awaiting_customer', 'closed'
     ))
  THEN
    RAISE EXCEPTION 'Support ticket status event is not the exact next transition';
  END IF;
  RETURN NEW;
END
$$;

-- Existing Schema 018 tickets were intentionally preserved before the runtime
-- event guard existed; only runtime facts after this point use the live chain.

CREATE OR REPLACE FUNCTION public.opensales_validate_support_ticket_status_event_consumed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ticket_row record;
BEGIN
  SELECT ticket.current_status_event_id, ticket.status
  INTO ticket_row
  FROM public.support_tickets ticket
  WHERE ticket.id = NEW.ticket_id;
  IF ticket_row IS NULL
     OR ticket_row.current_status_event_id <> NEW.id
     OR ticket_row.status <> NEW.status
     OR (NEW.previous_status IS NULL AND NOT EXISTS (
       SELECT 1
       FROM public.support_tickets ticket
       WHERE ticket.id = NEW.ticket_id
         AND ticket.created_by_user_id = NEW.actor_user_id
         AND NEW.actor_type = 'customer'
     ))
  THEN
    RAISE EXCEPTION 'Support ticket status event must be consumed exactly once';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_presales_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_row record;
BEGIN
  SELECT event.inquiry_id, event.previous_status, event.status
  INTO event_row
  FROM public.presales_inquiry_status_events event
  WHERE event.id = NEW.current_status_event_id;

  IF event_row IS NULL
     OR event_row.inquiry_id <> NEW.id
     OR event_row.status <> NEW.status
     OR (TG_OP = 'INSERT' AND event_row.previous_status IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.status <> OLD.status AND (
       NEW.current_status_event_id = OLD.current_status_event_id
       OR event_row.previous_status IS DISTINCT FROM OLD.status
     ))
     OR (TG_OP = 'UPDATE' AND NEW.status = OLD.status
       AND NEW.current_status_event_id <> OLD.current_status_event_id)
  THEN
    RAISE EXCEPTION 'Presales inquiry current status must reference its exact append-only transition';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_presales_status_event_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  inquiry_row record;
DECLARE
  actor_eligible boolean;
BEGIN
  IF NEW.previous_status IS NULL THEN
    IF NEW.status <> 'awaiting_staff' OR NEW.actor_type <> 'visitor' THEN
      RAISE EXCEPTION 'Initial Presales inquiry state must await Staff';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.presales_inquiries inquiry WHERE inquiry.id = NEW.inquiry_id
    ) THEN
      RAISE EXCEPTION 'A Presales inquiry can have only one initial status event';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.actor_type = 'staff' THEN
    PERFORM 1 FROM public.users principal
    WHERE principal.id = NEW.actor_user_id
      AND principal.email_verified_at IS NOT NULL
      AND principal.restricted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Presales status actor is not active Staff';
    END IF;
    SELECT staff.active AND (
      staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage'
    ) INTO actor_eligible
    FROM public.staff_members staff
    WHERE staff.user_id = NEW.actor_user_id
    FOR SHARE;
    IF actor_eligible IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Presales status actor is not active Staff';
    END IF;
  END IF;

  SELECT inquiry.status, inquiry.current_status_event_id
  INTO inquiry_row
  FROM public.presales_inquiries inquiry
  WHERE inquiry.id = NEW.inquiry_id
  FOR UPDATE;

  IF inquiry_row IS NULL OR inquiry_row.status <> NEW.previous_status
     OR NEW.status = NEW.previous_status
     OR (NEW.actor_type = 'visitor' AND NOT (
       NEW.status = 'awaiting_staff' AND NEW.previous_status = 'awaiting_visitor'
     ))
     OR (NEW.actor_type = 'staff' AND NEW.status NOT IN (
       'awaiting_staff', 'awaiting_visitor', 'closed'
     ))
  THEN
    RAISE EXCEPTION 'Presales status event is not the exact next transition';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_presales_status_event_consumed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  inquiry_row record;
BEGIN
  SELECT inquiry.current_status_event_id, inquiry.status
  INTO inquiry_row
  FROM public.presales_inquiries inquiry
  WHERE inquiry.id = NEW.inquiry_id;
  IF inquiry_row IS NULL
     OR inquiry_row.current_status_event_id <> NEW.id
     OR inquiry_row.status <> NEW.status
  THEN
    RAISE EXCEPTION 'Presales status event must be consumed exactly once';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_guard_support_ticket_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  service_order_id uuid;
DECLARE
  creator_eligible boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Support ticket identity is immutable';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.id, NEW.client_account_id, NEW.service_id, NEW.order_id,
      NEW.created_by_user_id, NEW.subject, NEW.department_revision_id,
      NEW.priority, NEW.authorization_purpose, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.client_account_id, OLD.service_id, OLD.order_id,
      OLD.created_by_user_id, OLD.subject, OLD.department_revision_id,
      OLD.priority, OLD.authorization_purpose, OLD.created_at
    ) OR NEW.updated_at < OLD.updated_at
    THEN
      RAISE EXCEPTION 'Support ticket identity is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.service_id IS NOT NULL THEN
    SELECT item.order_id INTO service_order_id
    FROM public.services service
    JOIN public.order_items item ON item.id = service.order_item_id
    WHERE service.id = NEW.service_id
      AND service.client_account_id = NEW.client_account_id;
    IF service_order_id IS NULL THEN
      RAISE EXCEPTION 'Support ticket Service does not belong to its Client Account';
    END IF;
  END IF;
  IF NEW.service_id IS NOT NULL AND NEW.order_id IS NOT NULL
     AND service_order_id <> NEW.order_id
  THEN
    RAISE EXCEPTION 'Support ticket Service and Order must describe the same order';
  END IF;
  PERFORM 1 FROM public.users principal
  WHERE principal.id = NEW.created_by_user_id
    AND principal.email_verified_at IS NOT NULL
    AND principal.restricted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support ticket creator is not eligible';
  END IF;
  PERFORM 1 FROM public.client_accounts account
  WHERE account.id = NEW.client_account_id
  FOR SHARE;
  PERFORM 1 FROM public.client_memberships membership
  WHERE membership.client_account_id = NEW.client_account_id
    AND membership.user_id = NEW.created_by_user_id
    AND membership.removed_at IS NULL
    AND membership.restricted_at IS NULL
  FOR SHARE;
  creator_eligible := FOUND;
  IF NOT creator_eligible THEN
    RAISE EXCEPTION 'Support ticket creator must be an active unrestricted Member';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_guard_presales_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Presales inquiry identity is immutable';
  END IF;
  IF ROW(
    NEW.id, NEW.access_token_digest, NEW.access_expires_at,
    NEW.department_revision_id, NEW.visitor_name, NEW.visitor_email::text,
    NEW.topic, NEW.subject, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.access_token_digest, OLD.access_expires_at,
    OLD.department_revision_id, OLD.visitor_name, OLD.visitor_email::text,
    OLD.topic, OLD.subject, OLD.created_at
  ) OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'Presales inquiry identity is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_active boolean;
DECLARE
  assignee_active boolean;
BEGIN
  PERFORM 1 FROM public.users principal
  WHERE principal.id = ANY(
    pg_catalog.array_remove(
      ARRAY[NEW.actor_staff_user_id, NEW.assigned_staff_user_id], NULL
    )
  )
    AND principal.email_verified_at IS NOT NULL
    AND principal.restricted_at IS NULL
  ORDER BY principal.id
  FOR SHARE;
  IF EXISTS (
    SELECT required.user_id
    FROM pg_catalog.unnest(
      pg_catalog.array_remove(
        ARRAY[NEW.actor_staff_user_id, NEW.assigned_staff_user_id], NULL
      )
    ) AS required(user_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.users principal
      WHERE principal.id = required.user_id
        AND principal.email_verified_at IS NOT NULL
        AND principal.restricted_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'Support assignment requires eligible Staff identities';
  END IF;
  SELECT active AND (
    permissions ? '*' OR permissions ? 'support.tickets.manage'
  ) INTO actor_active
  FROM public.staff_members
  WHERE user_id = NEW.actor_staff_user_id
  FOR SHARE;

  IF NEW.assigned_staff_user_id IS NOT NULL THEN
    SELECT active AND (
      permissions ? '*' OR permissions ? 'support.tickets.manage'
    ) INTO assignee_active
    FROM public.staff_members
    WHERE user_id = NEW.assigned_staff_user_id
    FOR SHARE;
  ELSE
    assignee_active := true;
  END IF;

  IF actor_active IS DISTINCT FROM true OR assignee_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Support assignment requires active Staff identities';
  END IF;
  PERFORM 1 FROM public.support_tickets ticket
  WHERE ticket.id = NEW.ticket_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support assignment requires an existing ticket';
  END IF;
  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO NEW.sequence
  FROM public.support_ticket_assignment_events event
  WHERE event.ticket_id = NEW.ticket_id;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_assign_support_routing_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_active boolean;
BEGIN
  PERFORM 1 FROM public.users principal
  WHERE principal.id = NEW.actor_staff_user_id
    AND principal.email_verified_at IS NOT NULL
    AND principal.restricted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support routing requires active Staff';
  END IF;
  SELECT staff.active AND (
    staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage'
  ) INTO actor_active
  FROM public.staff_members staff
  WHERE staff.user_id = NEW.actor_staff_user_id
  FOR SHARE;
  IF actor_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Support routing requires active Staff';
  END IF;
  PERFORM 1 FROM public.support_tickets ticket
  WHERE ticket.id = NEW.ticket_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support routing requires an existing ticket';
  END IF;
  SELECT COALESCE(pg_catalog.max(event.sequence), 0) + 1
  INTO NEW.sequence
  FROM public.support_ticket_routing_events event
  WHERE event.ticket_id = NEW.ticket_id;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_department_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision_department_id uuid;
DECLARE
  accepts_kind boolean;
BEGIN
  SELECT revision.department_id INTO revision_department_id
  FROM public.support_department_revisions revision
  WHERE revision.id = NEW.department_revision_id;
  IF revision_department_id IS NULL THEN
    RAISE EXCEPTION 'Support department revision does not exist';
  END IF;

  PERFORM 1
  FROM public.support_departments department
  WHERE department.id = revision_department_id
    AND department.current_revision_id = NEW.department_revision_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support department revision is not current';
  END IF;

  SELECT CASE TG_TABLE_NAME
           WHEN 'presales_inquiries' THEN revision.accepts_presales
           ELSE revision.accepts_authenticated
         END
  INTO accepts_kind
  FROM public.support_department_revisions revision
  WHERE revision.id = NEW.department_revision_id;

  IF accepts_kind IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Support department revision is not active for this inquiry type';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_department_revision_creation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_revision integer;
DECLARE
  current_revision_id uuid;
BEGIN
  IF NEW.created_by_staff_user_id IS NULL THEN
    RAISE EXCEPTION 'Support department revision requires active Staff';
  END IF;
  PERFORM 1 FROM public.users principal
  WHERE principal.id = NEW.created_by_staff_user_id
    AND principal.email_verified_at IS NOT NULL
    AND principal.restricted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support department revision requires active Staff';
  END IF;
  PERFORM 1 FROM public.staff_members staff
  WHERE staff.user_id = NEW.created_by_staff_user_id
    AND staff.active
    AND (staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support department revision requires active Staff';
  END IF;
  PERFORM 1
  FROM public.support_departments department
  WHERE department.id = NEW.department_id
  FOR UPDATE;

  SELECT revision.id, revision.revision + 1
  INTO current_revision_id, expected_revision
  FROM public.support_department_revisions revision
  LEFT JOIN public.support_department_revision_retirements retirement
    ON retirement.revision_id = revision.id
  WHERE revision.department_id = NEW.department_id
    AND retirement.revision_id IS NULL
  ORDER BY revision.revision DESC
  LIMIT 1;

  IF current_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'Retire the current Support department revision before adding another';
  END IF;

  SELECT COALESCE(pg_catalog.max(revision.revision), 0) + 1
  INTO expected_revision
  FROM public.support_department_revisions revision
  WHERE revision.department_id = NEW.department_id;

  IF NEW.revision <> expected_revision THEN
    RAISE EXCEPTION 'Support department revisions must be consecutive';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_department_retirement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_active boolean;
DECLARE
  target_department_id uuid;
BEGIN
  PERFORM 1 FROM public.users principal
  WHERE principal.id = NEW.retired_by_staff_user_id
    AND principal.email_verified_at IS NOT NULL
    AND principal.restricted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support department retirement requires active Staff';
  END IF;
  SELECT staff.active AND (
    staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage'
  ) INTO actor_active
  FROM public.staff_members staff
  WHERE staff.user_id = NEW.retired_by_staff_user_id
  FOR SHARE;
  IF actor_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Support department retirement requires active Staff';
  END IF;

  SELECT revision.department_id INTO target_department_id
  FROM public.support_department_revisions revision
  WHERE revision.id = NEW.revision_id;
  PERFORM 1
  FROM public.support_departments department
  WHERE department.id = target_department_id
    AND department.current_revision_id = NEW.revision_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only the current Support department revision can be retired';
  END IF;
  PERFORM 1
  FROM public.support_department_revisions revision
  WHERE revision.id = NEW.revision_id
  FOR UPDATE;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_department_current_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_department_id uuid;
DECLARE
  current_count integer;
DECLARE
  pointer_revision_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'support_departments' THEN
    target_department_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'support_department_revisions' THEN
    target_department_id := NEW.department_id;
  ELSE
    SELECT revision.department_id INTO target_department_id
    FROM public.support_department_revisions revision
    WHERE revision.id = NEW.revision_id;
  END IF;

  SELECT pg_catalog.count(*)::integer INTO current_count
  FROM public.support_department_revisions revision
  LEFT JOIN public.support_department_revision_retirements retirement
    ON retirement.revision_id = revision.id
  WHERE revision.department_id = target_department_id
    AND retirement.revision_id IS NULL;

  SELECT department.current_revision_id INTO pointer_revision_id
  FROM public.support_departments department
  WHERE department.id = target_department_id;

  IF current_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.support_department_revisions revision
    LEFT JOIN public.support_department_revision_retirements retirement
      ON retirement.revision_id = revision.id
    WHERE revision.id = pointer_revision_id
      AND revision.department_id = target_department_id
      AND retirement.revision_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Each Support department must have exactly one current revision';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_guard_support_department_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM 1
    FROM public.support_department_revision_retirements retirement
    JOIN public.support_department_revisions old_revision
      ON old_revision.id = retirement.revision_id
    JOIN public.support_department_revisions new_revision
      ON new_revision.id = NEW.current_revision_id
     AND new_revision.department_id = NEW.id
     AND new_revision.revision = old_revision.revision + 1
     AND new_revision.created_by_staff_user_id = retirement.retired_by_staff_user_id
    LEFT JOIN public.support_department_revision_retirements new_retirement
      ON new_retirement.revision_id = new_revision.id
    WHERE retirement.revision_id = OLD.current_revision_id
      AND old_revision.department_id = NEW.id
      AND new_retirement.revision_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Support department pointer must advance through exact revision facts';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Support department identity is immutable';
  END IF;
  IF ROW(NEW.id, NEW.code::text, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.code::text, OLD.created_at)
  THEN
    RAISE EXCEPTION 'Support department identity is immutable';
  END IF;
  IF NEW.current_revision_id = OLD.current_revision_id THEN
    RAISE EXCEPTION 'Support department update must advance its current revision';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_attachment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  message_row record;
DECLARE
  staff_active boolean;
DECLARE
  target_account_id uuid;
BEGIN
  PERFORM 1 FROM public.users principal
  WHERE principal.id = NEW.uploaded_by_user_id
    AND principal.email_verified_at IS NOT NULL
    AND principal.restricted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support attachment uploader is not eligible';
  END IF;
  IF NEW.uploaded_by_type = 'staff' THEN
    SELECT staff.active AND (
      staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage'
    ) INTO staff_active
    FROM public.staff_members staff
    WHERE staff.user_id = NEW.uploaded_by_user_id
    FOR SHARE;
    IF staff_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Support attachment requires active Staff';
    END IF;
  ELSE
    SELECT ticket.client_account_id INTO target_account_id
    FROM public.support_tickets ticket
    WHERE ticket.id = NEW.ticket_id;
    PERFORM 1 FROM public.client_accounts account
    WHERE account.id = target_account_id
    FOR SHARE;
    PERFORM 1 FROM public.client_memberships membership
    WHERE membership.client_account_id = target_account_id
      AND membership.user_id = NEW.uploaded_by_user_id
      AND membership.removed_at IS NULL
      AND membership.restricted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Support attachment uploader is not an active Member';
    END IF;
  END IF;
  SELECT message.author_user_id, message.author_type, message.visibility,
         ticket.status AS ticket_status
  INTO message_row
  FROM public.support_ticket_messages message
  JOIN public.support_tickets ticket ON ticket.id = message.ticket_id
  WHERE message.id = NEW.message_id AND message.ticket_id = NEW.ticket_id
  FOR SHARE OF message, ticket;
  IF message_row IS NULL
     OR message_row.ticket_status = 'closed'
     OR message_row.visibility <> NEW.visibility
     OR message_row.author_type <> NEW.uploaded_by_type
     OR message_row.author_user_id <> NEW.uploaded_by_user_id
  THEN
    RAISE EXCEPTION 'Support attachment must match its exact parent message and author';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_message_author()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_account_id uuid;
DECLARE
  actor_eligible boolean;
BEGIN
  IF NEW.author_type = 'staff' THEN
    PERFORM 1 FROM public.users principal
    WHERE principal.id = NEW.author_user_id
      AND principal.email_verified_at IS NOT NULL
      AND principal.restricted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Support message author is not eligible';
    END IF;
    SELECT staff.active AND (
      staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage'
    ) INTO actor_eligible
    FROM public.staff_members staff
    WHERE staff.user_id = NEW.author_user_id
    FOR SHARE;
  ELSE
    PERFORM 1 FROM public.users principal
    WHERE principal.id = NEW.author_user_id
      AND principal.email_verified_at IS NOT NULL
      AND principal.restricted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Support message author is not eligible';
    END IF;
    SELECT ticket.client_account_id INTO target_account_id
    FROM public.support_tickets ticket
    WHERE ticket.id = NEW.ticket_id;
    PERFORM 1 FROM public.client_accounts account
    WHERE account.id = target_account_id
    FOR SHARE;
    SELECT true INTO actor_eligible
    FROM public.client_memberships membership
    WHERE membership.client_account_id = target_account_id
      AND membership.user_id = NEW.author_user_id
      AND membership.removed_at IS NULL
      AND membership.restricted_at IS NULL
    FOR SHARE;
  END IF;
  IF actor_eligible IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Support message author is not eligible';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_presales_message_author()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  staff_active boolean;
BEGIN
  IF NEW.author_type = 'staff' THEN
    PERFORM 1 FROM public.users principal
    WHERE principal.id = NEW.author_user_id
      AND principal.email_verified_at IS NOT NULL
      AND principal.restricted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Presales Staff message requires active Staff';
    END IF;
    SELECT staff.active AND (
      staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage'
    ) INTO staff_active
    FROM public.staff_members staff
    WHERE staff.user_id = NEW.author_user_id
    FOR SHARE;
    IF staff_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Presales Staff message requires active Staff';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_presales_access_revocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  staff_active boolean;
BEGIN
  PERFORM 1 FROM public.users principal
  WHERE principal.id = NEW.revoked_by_staff_user_id
    AND principal.email_verified_at IS NOT NULL
    AND principal.restricted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Presales access revocation requires authorized Staff';
  END IF;
  SELECT staff.active AND (
    staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage'
  ) INTO staff_active
  FROM public.staff_members staff
  WHERE staff.user_id = NEW.revoked_by_staff_user_id
  FOR SHARE;
  IF staff_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Presales access revocation requires authorized Staff';
  END IF;
  PERFORM 1 FROM public.presales_inquiries inquiry
  WHERE inquiry.id = NEW.inquiry_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Presales access revocation requires an existing inquiry';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_attachment_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attachment_row record;
DECLARE
  staff_active boolean;
DECLARE
  target_account_id uuid;
BEGIN
  PERFORM 1 FROM public.users principal
  WHERE principal.id = NEW.deleted_by_user_id
    AND principal.email_verified_at IS NOT NULL
    AND principal.restricted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support attachment deletion actor is not eligible';
  END IF;
  IF NEW.deleted_by_type = 'staff' THEN
    SELECT staff.active AND (
      staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage'
    ) INTO staff_active
    FROM public.staff_members staff
    WHERE staff.user_id = NEW.deleted_by_user_id
    FOR SHARE;
    IF staff_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Support attachment deletion requires active Staff';
    END IF;
  ELSE
    SELECT ticket.client_account_id INTO target_account_id
    FROM public.support_ticket_attachments attachment
    JOIN public.support_tickets ticket ON ticket.id = attachment.ticket_id
    WHERE attachment.id = NEW.attachment_id;
    PERFORM 1 FROM public.client_accounts account
    WHERE account.id = target_account_id
    FOR SHARE;
    PERFORM 1 FROM public.client_memberships membership
    WHERE membership.client_account_id = target_account_id
      AND membership.user_id = NEW.deleted_by_user_id
      AND membership.removed_at IS NULL
      AND membership.restricted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Support attachment deletion actor is not an active Member';
    END IF;
  END IF;
  SELECT attachment.uploaded_by_user_id, attachment.uploaded_by_type
  INTO attachment_row
  FROM public.support_ticket_attachments attachment
  WHERE attachment.id = NEW.attachment_id
  FOR SHARE;
  IF attachment_row IS NULL THEN
    RAISE EXCEPTION 'Support attachment deletion requires an attachment';
  END IF;
  IF NEW.deleted_by_type = 'customer' AND (
    attachment_row.uploaded_by_type <> 'customer'
    OR attachment_row.uploaded_by_user_id <> NEW.deleted_by_user_id
  ) THEN
    RAISE EXCEPTION 'Customers can remove only their own Support attachment';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_support_attachment_scan_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attachment_row record;
DECLARE
  staff_active boolean;
BEGIN
  PERFORM 1 FROM public.users principal
  WHERE principal.id = NEW.recorded_by_staff_user_id
    AND principal.email_verified_at IS NOT NULL
    AND principal.restricted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Support attachment scan fact requires authorized Staff';
  END IF;
  SELECT staff.active AND (
    staff.permissions ? '*' OR staff.permissions ? 'support.tickets.manage'
  ) INTO staff_active
  FROM public.staff_members staff
  WHERE staff.user_id = NEW.recorded_by_staff_user_id
  FOR SHARE;
  IF staff_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Support attachment scan fact requires authorized Staff';
  END IF;
  SELECT attachment.sha256, attachment.created_at
  INTO attachment_row
  FROM public.support_ticket_attachments attachment
  WHERE attachment.id = NEW.attachment_id
  FOR SHARE;
  IF attachment_row IS NULL
     OR attachment_row.sha256 <> NEW.content_sha256
     OR NEW.scanned_at < attachment_row.created_at
     OR NEW.scanned_at > pg_catalog.clock_timestamp() + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'Support attachment scan fact must bind the exact quarantined content';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER support_tickets_current_state_guard
AFTER INSERT OR UPDATE OF status, current_status_event_id ON public.support_tickets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_ticket_state();

CREATE TRIGGER support_ticket_status_event_insert_guard
BEFORE INSERT ON public.support_ticket_status_events
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_ticket_status_event_insert();

CREATE CONSTRAINT TRIGGER support_ticket_status_event_consumed_guard
AFTER INSERT ON public.support_ticket_status_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_ticket_status_event_consumed();

CREATE CONSTRAINT TRIGGER presales_inquiries_current_state_guard
AFTER INSERT OR UPDATE OF status, current_status_event_id ON public.presales_inquiries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_presales_state();

CREATE CONSTRAINT TRIGGER support_departments_current_revision_guard
AFTER INSERT OR UPDATE OF current_revision_id ON public.support_departments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_department_current_revision();

CREATE CONSTRAINT TRIGGER support_department_revisions_current_guard
AFTER INSERT ON public.support_department_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_department_current_revision();

CREATE CONSTRAINT TRIGGER support_department_retirements_current_guard
AFTER INSERT ON public.support_department_revision_retirements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_department_current_revision();

CREATE TRIGGER support_ticket_assignment_guard
BEFORE INSERT ON public.support_ticket_assignment_events
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_assignment();

CREATE TRIGGER support_ticket_routing_sequence_guard
BEFORE INSERT ON public.support_ticket_routing_events
FOR EACH ROW EXECUTE FUNCTION public.opensales_assign_support_routing_sequence();

CREATE TRIGGER presales_status_event_insert_guard
BEFORE INSERT ON public.presales_inquiry_status_events
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_presales_status_event_insert();

CREATE CONSTRAINT TRIGGER presales_status_event_consumed_guard
AFTER INSERT ON public.presales_inquiry_status_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_presales_status_event_consumed();

CREATE TRIGGER b_support_tickets_department_guard
BEFORE INSERT OR UPDATE OF department_revision_id ON public.support_tickets
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_department_revision();

CREATE TRIGGER support_ticket_routing_department_guard
BEFORE INSERT ON public.support_ticket_routing_events
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_department_revision();

CREATE TRIGGER presales_inquiries_department_guard
BEFORE INSERT ON public.presales_inquiries
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_department_revision();

CREATE TRIGGER support_department_revision_creation_guard
BEFORE INSERT ON public.support_department_revisions
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_department_revision_creation();

CREATE TRIGGER support_department_retirement_guard
BEFORE INSERT ON public.support_department_revision_retirements
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_department_retirement();

CREATE TRIGGER support_departments_identity_guard
BEFORE UPDATE OR DELETE ON public.support_departments
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_support_department_identity();
CREATE TRIGGER support_department_revisions_immutable
BEFORE UPDATE OR DELETE ON public.support_department_revisions
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();
CREATE TRIGGER support_department_revision_retirements_immutable
BEFORE UPDATE OR DELETE ON public.support_department_revision_retirements
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();

CREATE TRIGGER a_support_tickets_identity_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.support_tickets
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_support_ticket_identity();
CREATE TRIGGER support_ticket_messages_author_guard
BEFORE INSERT ON public.support_ticket_messages
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_message_author();
CREATE TRIGGER support_ticket_messages_immutable
BEFORE UPDATE OR DELETE ON public.support_ticket_messages
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();
CREATE TRIGGER presales_inquiries_identity_guard
BEFORE UPDATE OR DELETE ON public.presales_inquiries
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_presales_identity();
CREATE TRIGGER presales_inquiry_messages_author_guard
BEFORE INSERT ON public.presales_inquiry_messages
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_presales_message_author();
CREATE TRIGGER presales_inquiry_access_revocations_guard
BEFORE INSERT ON public.presales_inquiry_access_revocations
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_presales_access_revocation();
CREATE TRIGGER support_ticket_attachments_guard
BEFORE INSERT ON public.support_ticket_attachments
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_attachment();
CREATE TRIGGER support_ticket_attachment_deletions_guard
BEFORE INSERT ON public.support_ticket_attachment_deletions
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_attachment_deletion();
CREATE TRIGGER support_ticket_attachment_scan_facts_guard
BEFORE INSERT ON public.support_ticket_attachment_scan_facts
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_support_attachment_scan_fact();

CREATE TRIGGER support_ticket_status_events_immutable
BEFORE UPDATE OR DELETE ON public.support_ticket_status_events
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();
CREATE TRIGGER support_ticket_assignment_events_immutable
BEFORE UPDATE OR DELETE ON public.support_ticket_assignment_events
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();
CREATE TRIGGER support_ticket_routing_events_immutable
BEFORE UPDATE OR DELETE ON public.support_ticket_routing_events
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();
CREATE TRIGGER support_ticket_attachments_immutable
BEFORE UPDATE OR DELETE ON public.support_ticket_attachments
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();
CREATE TRIGGER support_ticket_attachment_deletions_immutable
BEFORE UPDATE OR DELETE ON public.support_ticket_attachment_deletions
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();
CREATE TRIGGER support_ticket_attachment_scan_facts_immutable
BEFORE UPDATE OR DELETE ON public.support_ticket_attachment_scan_facts
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();
CREATE TRIGGER presales_inquiry_status_events_immutable
BEFORE UPDATE OR DELETE ON public.presales_inquiry_status_events
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();
CREATE TRIGGER presales_inquiry_messages_immutable
BEFORE UPDATE OR DELETE ON public.presales_inquiry_messages
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();
CREATE TRIGGER presales_inquiry_access_revocations_immutable
BEFORE UPDATE OR DELETE ON public.presales_inquiry_access_revocations
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_support_fact_mutation();

CREATE VIEW public.current_support_ticket_assignments AS
SELECT DISTINCT ON (event.ticket_id)
       event.ticket_id, event.assigned_staff_user_id, event.actor_staff_user_id,
       event.reason, event.occurred_at
FROM public.support_ticket_assignment_events event
ORDER BY event.ticket_id, event.sequence DESC;

CREATE VIEW public.current_support_ticket_routing AS
SELECT ticket.id AS ticket_id,
       COALESCE(event.department_revision_id, ticket.department_revision_id)
         AS department_revision_id,
       COALESCE(event.priority, ticket.priority) AS priority,
       event.actor_staff_user_id, event.reason, event.occurred_at
FROM public.support_tickets ticket
LEFT JOIN LATERAL (
  SELECT routing.department_revision_id, routing.priority,
         routing.actor_staff_user_id, routing.reason, routing.occurred_at
  FROM public.support_ticket_routing_events routing
  WHERE routing.ticket_id = ticket.id
  ORDER BY routing.sequence DESC
  LIMIT 1
) event ON true;

CREATE VIEW public.current_presales_inquiry_status AS
SELECT inquiry.id AS inquiry_id, event.status,
       event.actor_type, event.actor_user_id, event.reason, event.occurred_at
FROM public.presales_inquiries inquiry
JOIN public.presales_inquiry_status_events event
  ON event.id = inquiry.current_status_event_id;
