-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Schema 025 adds the Mock-only Content Operations surface. Published legal
-- and editorial records are immutable facts. Stable channel rows serialize
-- revision allocation and hold the exact current pointer; deferred guards make
-- the pointer and append-only publication/retirement facts agree at commit.

ALTER TABLE public.legal_documents
  ADD COLUMN revision bigint,
  ADD COLUMN created_source text,
  ADD COLUMN created_by_staff_user_id uuid,
  ADD COLUMN created_reauth_grant_id uuid,
  ADD COLUMN creation_reason text;

WITH ranked AS (
  SELECT document.id,
         pg_catalog.row_number() OVER (
           PARTITION BY document.kind, document.locale
           ORDER BY document.published_at, document.id
         )::bigint AS revision
  FROM public.legal_documents document
)
UPDATE public.legal_documents document
SET revision = ranked.revision,
    created_source = 'migration',
    creation_reason = 'Schema 025 preserved the legacy immutable legal revision'
FROM ranked
WHERE ranked.id = document.id;

ALTER TABLE public.legal_documents
  ALTER COLUMN revision SET NOT NULL,
  ALTER COLUMN created_source SET NOT NULL,
  ALTER COLUMN created_source SET DEFAULT 'staff',
  ALTER COLUMN creation_reason SET NOT NULL,
  ADD CONSTRAINT legal_documents_revision_positive_check CHECK (revision > 0),
  ADD CONSTRAINT legal_documents_version_nonblank_check CHECK (
    pg_catalog.char_length(pg_catalog.btrim(version)) BETWEEN 1 AND 64
  ),
  ADD CONSTRAINT legal_documents_title_nonblank_check CHECK (
    pg_catalog.char_length(pg_catalog.btrim(title)) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT legal_documents_body_nonblank_check CHECK (
    pg_catalog.char_length(pg_catalog.btrim(body)) BETWEEN 1 AND 50000
  ),
  ADD CONSTRAINT legal_documents_creation_reason_check CHECK (
    pg_catalog.char_length(pg_catalog.btrim(creation_reason)) BETWEEN 1 AND 1000
  ),
  ADD CONSTRAINT legal_documents_source_check CHECK (
    (created_source = 'staff'
      AND created_by_staff_user_id IS NOT NULL
      AND created_reauth_grant_id IS NOT NULL)
    OR
    (created_source IN ('migration', 'seed')
      AND created_by_staff_user_id IS NULL
      AND created_reauth_grant_id IS NULL)
  ),
  ADD CONSTRAINT legal_documents_staff_fkey
    FOREIGN KEY (created_by_staff_user_id)
    REFERENCES public.staff_members(user_id),
  ADD CONSTRAINT legal_documents_reauth_fkey
    FOREIGN KEY (created_reauth_grant_id)
    REFERENCES public.reauth_grants(id),
  ADD CONSTRAINT legal_documents_kind_locale_revision_key
    UNIQUE (kind, locale, revision),
  ADD CONSTRAINT legal_documents_id_kind_locale_key
    UNIQUE (id, kind, locale);

CREATE TABLE public.legal_document_channels (
  kind text NOT NULL CHECK (kind IN ('terms', 'aup', 'privacy')),
  locale text NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  current_document_id uuid,
  revision_sequence bigint NOT NULL DEFAULT 0 CHECK (revision_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (kind, locale),
  FOREIGN KEY (current_document_id, kind, locale)
    REFERENCES public.legal_documents(id, kind, locale)
    DEFERRABLE INITIALLY DEFERRED
);

INSERT INTO public.legal_document_channels(kind, locale, revision_sequence)
SELECT kind_value.kind, locale_value.locale, 0
FROM (VALUES ('terms'), ('aup'), ('privacy')) AS kind_value(kind)
CROSS JOIN (VALUES ('en'), ('zh-CN')) AS locale_value(locale);

INSERT INTO public.legal_document_channels(kind, locale, revision_sequence)
SELECT document.kind, document.locale, pg_catalog.max(document.revision)
FROM public.legal_documents document
GROUP BY document.kind, document.locale
ON CONFLICT (kind, locale) DO UPDATE
SET revision_sequence = EXCLUDED.revision_sequence;

CREATE TABLE public.legal_document_publications (
  document_id uuid PRIMARY KEY,
  kind text NOT NULL,
  locale text NOT NULL,
  actor_source text NOT NULL CHECK (actor_source IN ('migration', 'seed', 'staff')),
  actor_staff_user_id uuid REFERENCES public.staff_members(user_id),
  reauth_grant_id uuid REFERENCES public.reauth_grants(id),
  reason text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000
  ),
  published_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (document_id, kind, locale)
    REFERENCES public.legal_documents(id, kind, locale),
  CHECK (
    (actor_source = 'staff' AND actor_staff_user_id IS NOT NULL AND reauth_grant_id IS NOT NULL)
    OR
    (actor_source IN ('migration', 'seed') AND actor_staff_user_id IS NULL AND reauth_grant_id IS NULL)
  )
);

CREATE TABLE public.legal_document_retirements (
  document_id uuid PRIMARY KEY REFERENCES public.legal_document_publications(document_id),
  actor_source text NOT NULL CHECK (actor_source IN ('migration', 'seed', 'staff')),
  actor_staff_user_id uuid REFERENCES public.staff_members(user_id),
  reauth_grant_id uuid REFERENCES public.reauth_grants(id),
  reason text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000
  ),
  retired_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (
    (actor_source = 'staff' AND actor_staff_user_id IS NOT NULL AND reauth_grant_id IS NOT NULL)
    OR
    (actor_source IN ('migration', 'seed') AND actor_staff_user_id IS NULL AND reauth_grant_id IS NULL)
  )
);

WITH eligible AS (
  SELECT document.id,
         document.kind,
         document.locale,
         document.published_at,
         pg_catalog.lead(document.published_at) OVER (
           PARTITION BY document.kind, document.locale
           ORDER BY document.published_at, document.id
         ) AS retired_at,
         pg_catalog.row_number() OVER (
           PARTITION BY document.kind, document.locale
           ORDER BY document.published_at DESC, document.id DESC
         ) AS descending_rank
  FROM public.legal_documents document
  WHERE document.published_at <= pg_catalog.clock_timestamp()
)
INSERT INTO public.legal_document_publications(
  document_id, kind, locale, actor_source, reason, published_at
)
SELECT eligible.id, eligible.kind, eligible.locale, 'migration',
       'Schema 025 preserved the legacy published legal revision',
       eligible.published_at
FROM eligible;

WITH eligible AS (
  SELECT document.id,
         pg_catalog.lead(document.published_at) OVER (
           PARTITION BY document.kind, document.locale
           ORDER BY document.published_at, document.id
         ) AS retired_at
  FROM public.legal_documents document
  WHERE document.published_at <= pg_catalog.clock_timestamp()
)
INSERT INTO public.legal_document_retirements(
  document_id, actor_source, reason, retired_at
)
SELECT eligible.id, 'migration',
       'Schema 025 retired a superseded legacy legal revision',
       eligible.retired_at
FROM eligible
WHERE eligible.retired_at IS NOT NULL;

UPDATE public.legal_document_channels channel
SET current_document_id = (
  SELECT document.id
  FROM public.legal_documents document
  JOIN public.legal_document_publications publication
    ON publication.document_id = document.id
  LEFT JOIN public.legal_document_retirements retirement
    ON retirement.document_id = document.id
  WHERE document.kind = channel.kind
    AND document.locale = channel.locale
    AND retirement.document_id IS NULL
  ORDER BY document.revision DESC, document.id DESC
  LIMIT 1
);

CREATE TABLE public.content_entries (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  kind text NOT NULL CHECK (kind IN ('announcement', 'knowledge_base', 'network_status')),
  audience text NOT NULL CHECK (audience IN ('public', 'customer')),
  created_source text NOT NULL DEFAULT 'staff' CHECK (created_source IN ('seed', 'staff')),
  created_by_staff_user_id uuid REFERENCES public.staff_members(user_id),
  created_reauth_grant_id uuid REFERENCES public.reauth_grants(id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (
    (created_source = 'staff'
      AND created_by_staff_user_id IS NOT NULL
      AND created_reauth_grant_id IS NOT NULL)
    OR
    (created_source = 'seed'
      AND created_by_staff_user_id IS NULL
      AND created_reauth_grant_id IS NULL)
  ),
  UNIQUE (id, kind, audience)
);

CREATE TABLE public.content_channels (
  entry_id uuid NOT NULL REFERENCES public.content_entries(id),
  locale text NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  current_revision_id uuid,
  revision_sequence bigint NOT NULL DEFAULT 0 CHECK (revision_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (entry_id, locale)
);

CREATE TABLE public.content_revisions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES public.content_entries(id),
  locale text NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  revision bigint NOT NULL CHECK (revision > 0),
  title text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(title)) BETWEEN 1 AND 200
  ),
  summary text NOT NULL DEFAULT '' CHECK (pg_catalog.char_length(summary) <= 1000),
  body text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(body)) BETWEEN 1 AND 50000
  ),
  status_level text NOT NULL DEFAULT 'information' CHECK (
    status_level IN ('information', 'operational', 'maintenance', 'degraded', 'resolved')
  ),
  created_source text NOT NULL DEFAULT 'staff' CHECK (created_source IN ('seed', 'staff')),
  created_by_staff_user_id uuid REFERENCES public.staff_members(user_id),
  created_reauth_grant_id uuid REFERENCES public.reauth_grants(id),
  creation_reason text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(creation_reason)) BETWEEN 1 AND 1000
  ),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (entry_id, locale, revision),
  UNIQUE (id, entry_id, locale),
  CHECK (
    (created_source = 'staff'
      AND created_by_staff_user_id IS NOT NULL
      AND created_reauth_grant_id IS NOT NULL)
    OR
    (created_source = 'seed'
      AND created_by_staff_user_id IS NULL
      AND created_reauth_grant_id IS NULL)
  )
);

ALTER TABLE public.content_channels
  ADD CONSTRAINT content_channels_current_revision_fkey
    FOREIGN KEY (current_revision_id, entry_id, locale)
    REFERENCES public.content_revisions(id, entry_id, locale)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.content_revision_publications (
  revision_id uuid PRIMARY KEY,
  entry_id uuid NOT NULL,
  locale text NOT NULL,
  actor_source text NOT NULL CHECK (actor_source IN ('seed', 'staff')),
  actor_staff_user_id uuid REFERENCES public.staff_members(user_id),
  reauth_grant_id uuid REFERENCES public.reauth_grants(id),
  reason text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000
  ),
  published_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY (revision_id, entry_id, locale)
    REFERENCES public.content_revisions(id, entry_id, locale),
  CHECK (
    (actor_source = 'staff' AND actor_staff_user_id IS NOT NULL AND reauth_grant_id IS NOT NULL)
    OR
    (actor_source = 'seed' AND actor_staff_user_id IS NULL AND reauth_grant_id IS NULL)
  )
);

CREATE TABLE public.content_revision_retirements (
  revision_id uuid PRIMARY KEY REFERENCES public.content_revision_publications(revision_id),
  actor_source text NOT NULL CHECK (actor_source IN ('seed', 'staff')),
  actor_staff_user_id uuid REFERENCES public.staff_members(user_id),
  reauth_grant_id uuid REFERENCES public.reauth_grants(id),
  reason text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000
  ),
  retired_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (
    (actor_source = 'staff' AND actor_staff_user_id IS NOT NULL AND reauth_grant_id IS NOT NULL)
    OR
    (actor_source = 'seed' AND actor_staff_user_id IS NULL AND reauth_grant_id IS NULL)
  )
);

CREATE OR REPLACE FUNCTION public.opensales_validate_content_staff_actor(
  actor_source_value text,
  actor_user_id_value uuid,
  reauth_grant_id_value uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_session_id uuid;
  principal_record record;
  session_record record;
  staff_permissions jsonb;
  grant_record record;
BEGIN
  IF actor_source_value <> 'staff' THEN
    RAISE EXCEPTION 'Runtime Content facts require a Staff actor';
  END IF;
  SELECT grant_candidate.session_id
  INTO actor_session_id
  FROM public.reauth_grants grant_candidate
  WHERE grant_candidate.id = reauth_grant_id_value
    AND grant_candidate.user_id = actor_user_id_value;
  IF actor_session_id IS NULL THEN
    RAISE EXCEPTION 'Content mutation requires current Staff permission and reauthentication';
  END IF;

  -- This is the same canonical mutation prefix used by the API. NOWAIT makes
  -- a concurrent authority transition fail closed instead of observing a
  -- partly changed identity.
  SELECT principal.email_verified_at, principal.restricted_at
  INTO principal_record
  FROM public.users principal
  WHERE principal.id = actor_user_id_value
  FOR SHARE NOWAIT;

  SELECT session_candidate.revoked_at, session_candidate.expires_at
  INTO session_record
  FROM public.sessions session_candidate
  WHERE session_candidate.id = actor_session_id
    AND session_candidate.user_id = actor_user_id_value
  FOR SHARE NOWAIT;

  SELECT staff.permissions
  INTO staff_permissions
  FROM public.staff_members staff
  WHERE staff.user_id = actor_user_id_value
    AND staff.active
  FOR SHARE NOWAIT;

  SELECT grant_candidate.id,
         grant_candidate.invalidated_at,
         grant_candidate.expires_at
  INTO grant_record
  FROM public.reauth_grants grant_candidate
  WHERE grant_candidate.user_id = actor_user_id_value
    AND grant_candidate.session_id = actor_session_id
    AND grant_candidate.invalidated_at IS NULL
    AND grant_candidate.expires_at > pg_catalog.clock_timestamp()
  ORDER BY grant_candidate.created_at DESC, grant_candidate.id DESC
  LIMIT 1
  FOR SHARE NOWAIT;

  IF principal_record.email_verified_at IS NULL
     OR principal_record.restricted_at IS NOT NULL
     OR session_record.expires_at IS NULL
     OR session_record.revoked_at IS NOT NULL
     OR session_record.expires_at <= pg_catalog.clock_timestamp()
     OR pg_catalog.jsonb_typeof(staff_permissions) <> 'array'
     OR NOT (staff_permissions ? '*' OR staff_permissions ? 'content.manage')
     OR grant_record.id IS DISTINCT FROM reauth_grant_id_value
     OR grant_record.expires_at IS NULL
     OR grant_record.invalidated_at IS NOT NULL
     OR grant_record.expires_at <= pg_catalog.clock_timestamp()
  THEN
    RAISE EXCEPTION 'Content mutation requires current Staff permission and reauthentication';
  END IF;
END
$$;

-- Install the only non-Staff Content facts before runtime insert guards exist.
-- These strings describe solely this disposable Mock-only laboratory and make
-- no real Seller, service, SLA, network, privacy-compliance, or scan claim.
WITH synthetic(kind, locale, version, title, body) AS (
  VALUES
    ('terms', 'en', 'mock-lab-v1', 'Mock Laboratory Terms', 'Synthetic acceptance terms for this disposable Mock-only laboratory. No real service is offered.'),
    ('aup', 'en', 'mock-lab-v1', 'Mock Laboratory Acceptable Use Policy', 'Synthetic acceptable-use text for Mock Provider workflows only.'),
    ('privacy', 'en', 'mock-lab-v1', 'Mock Laboratory Privacy Notice', 'Only synthetic laboratory identities and data are permitted in this disposable environment.'),
    ('terms', 'zh-CN', 'mock-lab-v1', 'Mock 实验室条款', '仅用于一次性 Mock-only 实验室的合成验收，不提供真实服务。'),
    ('aup', 'zh-CN', 'mock-lab-v1', 'Mock 实验室可接受使用政策', '仅用于 Mock Provider 工作流的合成政策文本。'),
    ('privacy', 'zh-CN', 'mock-lab-v1', 'Mock 实验室隐私说明', '此一次性环境仅允许使用合成身份与合成数据。')
)
INSERT INTO public.legal_documents(
  kind, locale, version, title, body, revision,
  created_source, creation_reason
)
SELECT synthetic.kind, synthetic.locale, synthetic.version,
       synthetic.title, synthetic.body, channel.revision_sequence + 1,
       'migration', 'Schema 025 initial synthetic Mock-only legal revision'
FROM synthetic
JOIN public.legal_document_channels channel
  ON channel.kind = synthetic.kind AND channel.locale = synthetic.locale
WHERE channel.current_document_id IS NULL;

UPDATE public.legal_document_channels channel
SET revision_sequence = document.maximum_revision
FROM (
  SELECT legal.kind, legal.locale, pg_catalog.max(legal.revision) AS maximum_revision
  FROM public.legal_documents legal
  GROUP BY legal.kind, legal.locale
) document
WHERE document.kind = channel.kind
  AND document.locale = channel.locale
  AND channel.revision_sequence IS DISTINCT FROM document.maximum_revision;

INSERT INTO public.legal_document_publications(
  document_id, kind, locale, actor_source, reason, published_at
)
SELECT document.id, document.kind, document.locale, 'migration',
       'Schema 025 initial synthetic Mock-only legal publication',
       document.published_at
FROM public.legal_documents document
JOIN public.legal_document_channels channel
  ON channel.kind = document.kind AND channel.locale = document.locale
WHERE channel.current_document_id IS NULL
  AND document.created_source = 'migration'
  AND document.creation_reason = 'Schema 025 initial synthetic Mock-only legal revision'
  AND document.version = 'mock-lab-v1'
  AND NOT EXISTS (
    SELECT 1 FROM public.legal_document_publications publication
    WHERE publication.document_id = document.id
  );

UPDATE public.legal_document_channels channel
SET current_document_id = document.id
FROM public.legal_documents document
JOIN public.legal_document_publications publication
  ON publication.document_id = document.id
LEFT JOIN public.legal_document_retirements retirement
  ON retirement.document_id = document.id
WHERE document.kind = channel.kind
  AND document.locale = channel.locale
  AND channel.current_document_id IS NULL
  AND retirement.document_id IS NULL;

INSERT INTO public.content_entries(slug, kind, audience, created_source)
VALUES
  ('mock-laboratory-welcome', 'announcement', 'public', 'seed'),
  ('mock-laboratory-guide', 'knowledge_base', 'customer', 'seed'),
  ('mock-laboratory-network', 'network_status', 'public', 'seed');

INSERT INTO public.content_channels(entry_id, locale)
SELECT entry.id, locale_value.locale
FROM public.content_entries entry
CROSS JOIN (VALUES ('en'), ('zh-CN')) locale_value(locale);

WITH synthetic(slug, locale, title, summary, body, status_level) AS (
  VALUES
    ('mock-laboratory-welcome', 'en', 'Welcome to the Mock Laboratory', 'Synthetic product workflow updates.', 'This announcement contains synthetic Mock-only acceptance content.', 'information'),
    ('mock-laboratory-welcome', 'zh-CN', '欢迎使用 Mock 实验室', '合成产品工作流更新。', '此公告仅包含 Mock-only 合成验收内容。', 'information'),
    ('mock-laboratory-guide', 'en', 'Mock Laboratory Guide', 'A customer guide for the disposable lab.', 'Use only synthetic identities, products, payments, and Provider results in this laboratory.', 'information'),
    ('mock-laboratory-guide', 'zh-CN', 'Mock 实验室指南', '一次性实验室的客户指南。', '此实验室仅使用合成身份、产品、支付与 Provider 结果。', 'information'),
    ('mock-laboratory-network', 'en', 'Mock Network Status', 'Synthetic lab components are operational.', 'This status entry reports only the synthetic laboratory demonstration state and makes no real network claim.', 'operational'),
    ('mock-laboratory-network', 'zh-CN', 'Mock 网络状态', '合成实验室组件处于运行状态。', '此状态仅描述合成实验室演示状态，不代表任何真实网络情况。', 'operational')
)
INSERT INTO public.content_revisions(
  entry_id, locale, revision, title, summary, body, status_level,
  created_source, creation_reason
)
SELECT entry.id, synthetic.locale, 1, synthetic.title, synthetic.summary,
       synthetic.body, synthetic.status_level, 'seed',
       'Schema 025 initial synthetic Mock-only Content revision'
FROM synthetic
JOIN public.content_entries entry ON entry.slug = synthetic.slug;

UPDATE public.content_channels channel
SET revision_sequence = 1
WHERE EXISTS (
  SELECT 1 FROM public.content_revisions revision
  WHERE revision.entry_id = channel.entry_id AND revision.locale = channel.locale
);

INSERT INTO public.content_revision_publications(
  revision_id, entry_id, locale, actor_source, reason, published_at
)
SELECT revision.id, revision.entry_id, revision.locale, 'seed',
       'Schema 025 initial synthetic Mock-only Content publication',
       revision.created_at
FROM public.content_revisions revision;

UPDATE public.content_channels channel
SET current_revision_id = revision.id
FROM public.content_revisions revision
WHERE revision.entry_id = channel.entry_id
  AND revision.locale = channel.locale;

CREATE OR REPLACE FUNCTION public.opensales_guard_immutable_content_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_guard_legal_channel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'Legal document channels are fixed by Schema 025';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Legal document channels are immutable identities';
  END IF;
  IF ROW(NEW.kind, NEW.locale, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.kind, OLD.locale, OLD.created_at)
  THEN
    RAISE EXCEPTION 'Legal document channel identity is immutable';
  END IF;
  IF NEW.revision_sequence < OLD.revision_sequence
     OR NEW.revision_sequence > OLD.revision_sequence + 1
  THEN
    RAISE EXCEPTION 'Legal document revision sequence cannot skip or move backward';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_prepare_legal_document_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_revision bigint;
BEGIN
  PERFORM public.opensales_validate_content_staff_actor(
    NEW.created_source, NEW.created_by_staff_user_id, NEW.created_reauth_grant_id
  );
  SELECT channel.revision_sequence + 1
  INTO expected_revision
  FROM public.legal_document_channels channel
  WHERE channel.kind = NEW.kind AND channel.locale = NEW.locale
  FOR UPDATE;
  IF expected_revision IS NULL THEN
    RAISE EXCEPTION 'Legal document channel %/% does not exist', NEW.kind, NEW.locale;
  END IF;
  IF NEW.revision <> expected_revision THEN
    RAISE EXCEPTION 'Legal document revisions must be consecutive';
  END IF;
  UPDATE public.legal_document_channels
  SET revision_sequence = NEW.revision
  WHERE kind = NEW.kind AND locale = NEW.locale;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_prepare_legal_publication()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  document_revision bigint;
  maximum_revision bigint;
BEGIN
  PERFORM public.opensales_validate_content_staff_actor(
    NEW.actor_source, NEW.actor_staff_user_id, NEW.reauth_grant_id
  );
  PERFORM 1
  FROM public.legal_document_channels channel
  WHERE channel.kind = NEW.kind AND channel.locale = NEW.locale
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Legal document channel does not exist';
  END IF;
  SELECT document.revision
  INTO document_revision
  FROM public.legal_documents document
  WHERE document.id = NEW.document_id
    AND document.kind = NEW.kind
    AND document.locale = NEW.locale
  FOR SHARE;
  SELECT pg_catalog.max(document.revision)
  INTO maximum_revision
  FROM public.legal_documents document
  WHERE document.kind = NEW.kind AND document.locale = NEW.locale;
  IF document_revision IS NULL OR document_revision <> maximum_revision THEN
    RAISE EXCEPTION 'Only the latest legal document revision can be published';
  END IF;
  IF NEW.actor_source = 'staff' THEN
    NEW.published_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_prepare_legal_retirement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_kind text;
  target_locale text;
  publication_time timestamptz;
BEGIN
  PERFORM public.opensales_validate_content_staff_actor(
    NEW.actor_source, NEW.actor_staff_user_id, NEW.reauth_grant_id
  );
  SELECT publication.kind, publication.locale, publication.published_at
  INTO target_kind, target_locale, publication_time
  FROM public.legal_document_publications publication
  WHERE publication.document_id = NEW.document_id;
  PERFORM 1
  FROM public.legal_document_channels channel
  WHERE channel.kind = target_kind
    AND channel.locale = target_locale
    AND channel.current_document_id = NEW.document_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only the current legal document can be retired';
  END IF;
  IF NEW.actor_source = 'staff' THEN
    NEW.retired_at := pg_catalog.clock_timestamp();
  END IF;
  IF NEW.retired_at < publication_time THEN
    RAISE EXCEPTION 'Legal document retirement cannot precede publication';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_legal_channel_current()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_kind text;
  target_locale text;
  pointer_id uuid;
  sequence_value bigint;
  maximum_revision bigint;
  active_count bigint;
  pointer_revision bigint;
  latest_published_revision bigint;
BEGIN
  IF TG_TABLE_NAME = 'legal_document_channels' THEN
    target_kind := NEW.kind;
    target_locale := NEW.locale;
  ELSIF TG_TABLE_NAME = 'legal_documents' THEN
    target_kind := NEW.kind;
    target_locale := NEW.locale;
  ELSIF TG_TABLE_NAME = 'legal_document_publications' THEN
    target_kind := NEW.kind;
    target_locale := NEW.locale;
  ELSE
    SELECT publication.kind, publication.locale
    INTO target_kind, target_locale
    FROM public.legal_document_publications publication
    WHERE publication.document_id = NEW.document_id;
  END IF;

  SELECT channel.current_document_id, channel.revision_sequence
  INTO pointer_id, sequence_value
  FROM public.legal_document_channels channel
  WHERE channel.kind = target_kind AND channel.locale = target_locale;

  SELECT COALESCE(pg_catalog.max(document.revision), 0)
  INTO maximum_revision
  FROM public.legal_documents document
  WHERE document.kind = target_kind AND document.locale = target_locale;

  SELECT pg_catalog.count(*)
  INTO active_count
  FROM public.legal_document_publications publication
  LEFT JOIN public.legal_document_retirements retirement
    ON retirement.document_id = publication.document_id
  WHERE publication.kind = target_kind
    AND publication.locale = target_locale
    AND retirement.document_id IS NULL;

  IF sequence_value IS NULL OR sequence_value <> maximum_revision THEN
    RAISE EXCEPTION 'Legal channel revision sequence does not match immutable revisions';
  END IF;
  IF target_locale = 'en' AND (active_count <> 1 OR pointer_id IS NULL) THEN
    RAISE EXCEPTION 'Each legal kind requires one current English fallback publication';
  END IF;
  IF pointer_id IS NOT NULL THEN
    SELECT document.revision INTO pointer_revision
    FROM public.legal_documents document
    WHERE document.id = pointer_id;
    SELECT pg_catalog.max(document.revision) INTO latest_published_revision
    FROM public.legal_documents document
    JOIN public.legal_document_publications publication
      ON publication.document_id = document.id
    WHERE document.kind = target_kind AND document.locale = target_locale;
    IF pointer_revision IS DISTINCT FROM latest_published_revision THEN
      RAISE EXCEPTION 'Legal current pointer must reference the latest published revision';
    END IF;
  END IF;
  IF (active_count = 0 AND pointer_id IS NOT NULL)
     OR (active_count = 1 AND NOT EXISTS (
       SELECT 1
       FROM public.legal_document_publications publication
       LEFT JOIN public.legal_document_retirements retirement
         ON retirement.document_id = publication.document_id
       WHERE publication.document_id = pointer_id
         AND publication.kind = target_kind
         AND publication.locale = target_locale
         AND retirement.document_id IS NULL
     ))
     OR active_count > 1
  THEN
    RAISE EXCEPTION 'Legal channel current pointer must match exactly one active publication';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_guard_content_entry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Content entry identity is immutable';
  END IF;
  IF ROW(NEW.id, NEW.slug, NEW.kind, NEW.audience, NEW.created_source,
         NEW.created_by_staff_user_id, NEW.created_reauth_grant_id, NEW.created_at)
       IS DISTINCT FROM
     ROW(OLD.id, OLD.slug, OLD.kind, OLD.audience, OLD.created_source,
         OLD.created_by_staff_user_id, OLD.created_reauth_grant_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'Content entry identity is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_content_entry_actor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.opensales_validate_content_staff_actor(
    NEW.created_source, NEW.created_by_staff_user_id, NEW.created_reauth_grant_id
  );
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_guard_content_channel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Content channels are immutable identities';
  END IF;
  IF ROW(NEW.entry_id, NEW.locale, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.entry_id, OLD.locale, OLD.created_at)
  THEN
    RAISE EXCEPTION 'Content channel identity is immutable';
  END IF;
  IF NEW.revision_sequence < OLD.revision_sequence
     OR NEW.revision_sequence > OLD.revision_sequence + 1
  THEN
    RAISE EXCEPTION 'Content revision sequence cannot skip or move backward';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_prepare_content_channel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  entry_source text;
  entry_actor uuid;
  entry_grant uuid;
BEGIN
  IF NEW.current_revision_id IS NOT NULL OR NEW.revision_sequence <> 0 THEN
    RAISE EXCEPTION 'A new Content channel must start empty';
  END IF;
  SELECT entry.created_source,
         entry.created_by_staff_user_id,
         entry.created_reauth_grant_id
  INTO entry_source, entry_actor, entry_grant
  FROM public.content_entries entry
  WHERE entry.id = NEW.entry_id
  FOR SHARE;
  IF entry_source IS NULL THEN
    RAISE EXCEPTION 'Content channel requires an immutable entry identity';
  END IF;
  PERFORM public.opensales_validate_content_staff_actor(
    entry_source, entry_actor, entry_grant
  );
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_content_entry_channels()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  locale_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO locale_count
  FROM public.content_channels channel
  WHERE channel.entry_id = NEW.id
    AND channel.locale IN ('en', 'zh-CN');
  IF locale_count <> 2 THEN
    RAISE EXCEPTION 'Each Content entry requires fixed English and zh-CN channels';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_prepare_content_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_revision bigint;
BEGIN
  PERFORM public.opensales_validate_content_staff_actor(
    NEW.created_source, NEW.created_by_staff_user_id, NEW.created_reauth_grant_id
  );
  SELECT channel.revision_sequence + 1
  INTO expected_revision
  FROM public.content_channels channel
  WHERE channel.entry_id = NEW.entry_id AND channel.locale = NEW.locale
  FOR UPDATE;
  IF expected_revision IS NULL THEN
    RAISE EXCEPTION 'Content channel does not exist';
  END IF;
  IF NEW.status_level <> 'information' AND NOT EXISTS (
    SELECT 1
    FROM public.content_entries entry
    WHERE entry.id = NEW.entry_id AND entry.kind = 'network_status'
  ) THEN
    RAISE EXCEPTION 'Only Network Status content can use an operational status level';
  END IF;
  IF NEW.revision <> expected_revision THEN
    RAISE EXCEPTION 'Content revisions must be consecutive';
  END IF;
  UPDATE public.content_channels
  SET revision_sequence = NEW.revision
  WHERE entry_id = NEW.entry_id AND locale = NEW.locale;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_prepare_content_publication()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_revision bigint;
  maximum_revision bigint;
BEGIN
  PERFORM public.opensales_validate_content_staff_actor(
    NEW.actor_source, NEW.actor_staff_user_id, NEW.reauth_grant_id
  );
  PERFORM 1
  FROM public.content_channels channel
  WHERE channel.entry_id = NEW.entry_id AND channel.locale = NEW.locale
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Content channel does not exist';
  END IF;
  SELECT revision.revision
  INTO target_revision
  FROM public.content_revisions revision
  WHERE revision.id = NEW.revision_id
    AND revision.entry_id = NEW.entry_id
    AND revision.locale = NEW.locale
  FOR SHARE;
  SELECT pg_catalog.max(revision.revision)
  INTO maximum_revision
  FROM public.content_revisions revision
  WHERE revision.entry_id = NEW.entry_id AND revision.locale = NEW.locale;
  IF target_revision IS NULL OR target_revision <> maximum_revision THEN
    RAISE EXCEPTION 'Only the latest content revision can be published';
  END IF;
  IF NEW.actor_source = 'staff' THEN
    NEW.published_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_prepare_content_retirement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_entry_id uuid;
  target_locale text;
  publication_time timestamptz;
BEGIN
  PERFORM public.opensales_validate_content_staff_actor(
    NEW.actor_source, NEW.actor_staff_user_id, NEW.reauth_grant_id
  );
  SELECT publication.entry_id, publication.locale, publication.published_at
  INTO target_entry_id, target_locale, publication_time
  FROM public.content_revision_publications publication
  WHERE publication.revision_id = NEW.revision_id;
  PERFORM 1
  FROM public.content_channels channel
  WHERE channel.entry_id = target_entry_id
    AND channel.locale = target_locale
    AND channel.current_revision_id = NEW.revision_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only the current content revision can be retired';
  END IF;
  IF NEW.actor_source = 'staff' THEN
    NEW.retired_at := pg_catalog.clock_timestamp();
  END IF;
  IF NEW.retired_at < publication_time THEN
    RAISE EXCEPTION 'Content retirement cannot precede publication';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.opensales_validate_content_channel_current()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_entry_id uuid;
  target_locale text;
  pointer_id uuid;
  sequence_value bigint;
  maximum_revision bigint;
  active_count bigint;
  pointer_revision bigint;
  latest_published_revision bigint;
BEGIN
  IF TG_TABLE_NAME = 'content_channels' THEN
    target_entry_id := NEW.entry_id;
    target_locale := NEW.locale;
  ELSIF TG_TABLE_NAME = 'content_revisions' THEN
    target_entry_id := NEW.entry_id;
    target_locale := NEW.locale;
  ELSIF TG_TABLE_NAME = 'content_revision_publications' THEN
    target_entry_id := NEW.entry_id;
    target_locale := NEW.locale;
  ELSE
    SELECT publication.entry_id, publication.locale
    INTO target_entry_id, target_locale
    FROM public.content_revision_publications publication
    WHERE publication.revision_id = NEW.revision_id;
  END IF;

  SELECT channel.current_revision_id, channel.revision_sequence
  INTO pointer_id, sequence_value
  FROM public.content_channels channel
  WHERE channel.entry_id = target_entry_id AND channel.locale = target_locale;

  SELECT COALESCE(pg_catalog.max(revision.revision), 0)
  INTO maximum_revision
  FROM public.content_revisions revision
  WHERE revision.entry_id = target_entry_id AND revision.locale = target_locale;

  SELECT pg_catalog.count(*)
  INTO active_count
  FROM public.content_revision_publications publication
  LEFT JOIN public.content_revision_retirements retirement
    ON retirement.revision_id = publication.revision_id
  WHERE publication.entry_id = target_entry_id
    AND publication.locale = target_locale
    AND retirement.revision_id IS NULL;

  IF sequence_value IS NULL OR sequence_value <> maximum_revision THEN
    RAISE EXCEPTION 'Content channel revision sequence does not match immutable revisions';
  END IF;
  IF pointer_id IS NOT NULL THEN
    SELECT revision.revision INTO pointer_revision
    FROM public.content_revisions revision
    WHERE revision.id = pointer_id;
    SELECT pg_catalog.max(revision.revision) INTO latest_published_revision
    FROM public.content_revisions revision
    JOIN public.content_revision_publications publication
      ON publication.revision_id = revision.id
    WHERE revision.entry_id = target_entry_id AND revision.locale = target_locale;
    IF pointer_revision IS DISTINCT FROM latest_published_revision THEN
      RAISE EXCEPTION 'Content current pointer must reference the latest published revision';
    END IF;
  END IF;
  IF (active_count = 0 AND pointer_id IS NOT NULL)
     OR (active_count = 1 AND NOT EXISTS (
       SELECT 1
       FROM public.content_revision_publications publication
       LEFT JOIN public.content_revision_retirements retirement
         ON retirement.revision_id = publication.revision_id
       WHERE publication.revision_id = pointer_id
         AND publication.entry_id = target_entry_id
         AND publication.locale = target_locale
         AND retirement.revision_id IS NULL
     ))
     OR active_count > 1
  THEN
    RAISE EXCEPTION 'Content channel current pointer must match exactly one active publication';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER legal_documents_revision_prepare
BEFORE INSERT ON public.legal_documents
FOR EACH ROW EXECUTE FUNCTION public.opensales_prepare_legal_document_revision();

CREATE TRIGGER legal_documents_immutable
BEFORE UPDATE OR DELETE ON public.legal_documents
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_immutable_content_fact();

CREATE TRIGGER legal_document_channels_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.legal_document_channels
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_legal_channel();

CREATE TRIGGER legal_document_publications_prepare
BEFORE INSERT ON public.legal_document_publications
FOR EACH ROW EXECUTE FUNCTION public.opensales_prepare_legal_publication();

CREATE TRIGGER legal_document_publications_immutable
BEFORE UPDATE OR DELETE ON public.legal_document_publications
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_immutable_content_fact();

CREATE TRIGGER legal_document_retirements_prepare
BEFORE INSERT ON public.legal_document_retirements
FOR EACH ROW EXECUTE FUNCTION public.opensales_prepare_legal_retirement();

CREATE TRIGGER legal_document_retirements_immutable
BEFORE UPDATE OR DELETE ON public.legal_document_retirements
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_immutable_content_fact();

CREATE CONSTRAINT TRIGGER legal_document_channels_current_guard
AFTER INSERT OR UPDATE ON public.legal_document_channels
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_legal_channel_current();

CREATE CONSTRAINT TRIGGER legal_documents_current_guard
AFTER INSERT ON public.legal_documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_legal_channel_current();

CREATE CONSTRAINT TRIGGER legal_document_publications_current_guard
AFTER INSERT ON public.legal_document_publications
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_legal_channel_current();

CREATE CONSTRAINT TRIGGER legal_document_retirements_current_guard
AFTER INSERT ON public.legal_document_retirements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_legal_channel_current();

CREATE TRIGGER content_entries_actor_guard
BEFORE INSERT ON public.content_entries
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_content_entry_actor();

CREATE TRIGGER content_entries_immutable
BEFORE UPDATE OR DELETE ON public.content_entries
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_content_entry();

CREATE TRIGGER content_channels_guard
BEFORE UPDATE OR DELETE ON public.content_channels
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_content_channel();

CREATE TRIGGER content_channels_prepare
BEFORE INSERT ON public.content_channels
FOR EACH ROW EXECUTE FUNCTION public.opensales_prepare_content_channel();

CREATE TRIGGER content_revisions_prepare
BEFORE INSERT ON public.content_revisions
FOR EACH ROW EXECUTE FUNCTION public.opensales_prepare_content_revision();

CREATE TRIGGER content_revisions_immutable
BEFORE UPDATE OR DELETE ON public.content_revisions
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_immutable_content_fact();

CREATE TRIGGER content_revision_publications_prepare
BEFORE INSERT ON public.content_revision_publications
FOR EACH ROW EXECUTE FUNCTION public.opensales_prepare_content_publication();

CREATE TRIGGER content_revision_publications_immutable
BEFORE UPDATE OR DELETE ON public.content_revision_publications
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_immutable_content_fact();

CREATE TRIGGER content_revision_retirements_prepare
BEFORE INSERT ON public.content_revision_retirements
FOR EACH ROW EXECUTE FUNCTION public.opensales_prepare_content_retirement();

CREATE TRIGGER content_revision_retirements_immutable
BEFORE UPDATE OR DELETE ON public.content_revision_retirements
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_immutable_content_fact();

CREATE CONSTRAINT TRIGGER content_channels_current_guard
AFTER INSERT OR UPDATE ON public.content_channels
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_content_channel_current();

CREATE CONSTRAINT TRIGGER content_entries_channels_guard
AFTER INSERT ON public.content_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_content_entry_channels();

CREATE CONSTRAINT TRIGGER content_revisions_current_guard
AFTER INSERT ON public.content_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_content_channel_current();

CREATE CONSTRAINT TRIGGER content_revision_publications_current_guard
AFTER INSERT ON public.content_revision_publications
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_content_channel_current();

CREATE CONSTRAINT TRIGGER content_revision_retirements_current_guard
AFTER INSERT ON public.content_revision_retirements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_content_channel_current();

CREATE VIEW public.current_legal_documents AS
SELECT channel.kind,
       channel.locale,
       document.id AS document_id,
       document.revision,
       document.version,
       document.title,
       document.body,
       publication.published_at
FROM public.legal_document_channels channel
JOIN public.legal_documents document ON document.id = channel.current_document_id
JOIN public.legal_document_publications publication
  ON publication.document_id = document.id
LEFT JOIN public.legal_document_retirements retirement
  ON retirement.document_id = document.id
WHERE retirement.document_id IS NULL;

CREATE VIEW public.current_content_revisions AS
SELECT entry.id AS entry_id,
       entry.slug,
       entry.kind,
       entry.audience,
       channel.locale,
       revision.id AS revision_id,
       revision.revision,
       revision.title,
       revision.summary,
       revision.body,
       revision.status_level,
       publication.published_at
FROM public.content_entries entry
JOIN public.content_channels channel ON channel.entry_id = entry.id
JOIN public.content_revisions revision ON revision.id = channel.current_revision_id
JOIN public.content_revision_publications publication
  ON publication.revision_id = revision.id
LEFT JOIN public.content_revision_retirements retirement
  ON retirement.revision_id = revision.id
WHERE retirement.revision_id IS NULL;

CREATE INDEX legal_document_publications_channel_idx
  ON public.legal_document_publications(kind, locale, published_at DESC, document_id);
CREATE INDEX content_entries_kind_audience_idx
  ON public.content_entries(kind, audience, slug);
CREATE INDEX content_revisions_channel_idx
  ON public.content_revisions(entry_id, locale, revision DESC, id);
CREATE INDEX content_publications_channel_idx
  ON public.content_revision_publications(entry_id, locale, published_at DESC, revision_id);
