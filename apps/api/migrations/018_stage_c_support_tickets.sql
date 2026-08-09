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
