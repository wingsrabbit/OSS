-- SPDX-License-Identifier: AGPL-3.0-or-later

DO $$
DECLARE
  installed_schema text;
BEGIN
  SELECT pg_catalog.max(version) INTO installed_schema
  FROM public.schema_migrations;
  IF installed_schema IS DISTINCT FROM '026_stage_c_service_cancellation_authority' THEN
    RAISE EXCEPTION
      'Schema 027 requires an exact saved Schema 026 database; found %',
      COALESCE(installed_schema, 'missing');
  END IF;
END;
$$;

CREATE TABLE public.notification_preference_categories (
  category text PRIMARY KEY CHECK (
    category IN ('identity', 'transactional', 'high_risk', 'billing', 'service', 'support')
  ),
  label jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(label) = 'object'
    AND label ?& ARRAY['en', 'zh-CN']
    AND label - ARRAY['en', 'zh-CN'] = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(label -> 'en') = 'string'
    AND pg_catalog.jsonb_typeof(label -> 'zh-CN') = 'string'
    AND pg_catalog.char_length(label ->> 'en') BETWEEN 1 AND 80
    AND pg_catalog.char_length(label ->> 'zh-CN') BETWEEN 1 AND 80
  ),
  required_delivery boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (category, required_delivery),
  CHECK (
    required_delivery = (category IN ('identity', 'transactional', 'high_risk'))
  )
);

INSERT INTO public.notification_preference_categories(category, label, required_delivery)
VALUES
  ('identity', '{"en":"Identity","zh-CN":"身份"}'::jsonb, true),
  ('transactional', '{"en":"Transactional","zh-CN":"交易"}'::jsonb, true),
  ('high_risk', '{"en":"High-risk actions","zh-CN":"高风险操作"}'::jsonb, true),
  ('billing', '{"en":"Billing updates","zh-CN":"账单动态"}'::jsonb, false),
  ('service', '{"en":"Service updates","zh-CN":"服务动态"}'::jsonb, false),
  ('support', '{"en":"Support replies","zh-CN":"支持回复"}'::jsonb, false);

CREATE TABLE public.notification_template_events (
  event_type text PRIMARY KEY CHECK (
    event_type ~ '^(notification|identity[.]notification)[.][a-z0-9_]+$'
  ),
  preference_category text NOT NULL,
  required_delivery boolean NOT NULL,
  sensitive boolean NOT NULL,
  allowed_variables jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(allowed_variables) = 'array'
    AND NOT pg_catalog.jsonb_path_exists(
      allowed_variables,
      '$[*] ? (@.type() != "string")'::pg_catalog.jsonpath
    )
  ),
  required_variables jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(required_variables) = 'array'
    AND NOT pg_catalog.jsonb_path_exists(
      required_variables,
      '$[*] ? (@.type() != "string")'::pg_catalog.jsonpath
    )
    AND required_variables <@ allowed_variables
  ),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  FOREIGN KEY (preference_category, required_delivery)
    REFERENCES public.notification_preference_categories(category, required_delivery)
);

INSERT INTO public.notification_template_events(
  event_type, preference_category, required_delivery, sensitive,
  allowed_variables, required_variables
)
VALUES
  ('notification.email_verification_requested', 'identity', true, true,
   '["verificationUrl","expiresAt"]'::jsonb,
   '["verificationUrl","expiresAt"]'::jsonb),
  ('identity.notification.password_recovery', 'identity', true, true,
   '["actionUrl","expiresAt"]'::jsonb,
   '["actionUrl","expiresAt"]'::jsonb),
  ('identity.notification.email_change', 'high_risk', true, true,
   '["actionUrl","expiresAt"]'::jsonb,
   '["actionUrl","expiresAt"]'::jsonb),
  ('notification.membership_invitation_requested', 'high_risk', true, true,
   '["accountName","accountId","role","invitationUrl","expiresAt"]'::jsonb,
   '["accountName","accountId","role","invitationUrl","expiresAt"]'::jsonb),
  ('notification.renewal_reminder_requested', 'transactional', true, false,
   '["invoiceId","serviceId","kind","offsetDays","dueAt","amountDue","currency"]'::jsonb,
   '["invoiceId","serviceId","dueAt","amountDue","currency"]'::jsonb),
  ('notification.service_cancellation_scheduled', 'high_risk', true, false,
   '["productName","serviceId","effectiveAt","executionMode"]'::jsonb,
   '["productName","serviceId","effectiveAt","executionMode"]'::jsonb),
  ('notification.support_ticket_reply_requested', 'support', false, true,
   '["ticketId","ticketSubject","ticketMessage"]'::jsonb,
   '["ticketId","ticketSubject","ticketMessage"]'::jsonb);

CREATE TABLE public.notification_template_revisions (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  event_type text NOT NULL REFERENCES public.notification_template_events(event_type),
  locale text NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  revision_key text NOT NULL CHECK (
    revision_key ~ '^[a-z0-9][a-z0-9_-]{2,79}$'
  ),
  revision_number bigint NOT NULL CHECK (revision_number > 0),
  provider_template_ref text NOT NULL CHECK (
    provider_template_ref ~ '^[a-z0-9][a-z0-9_-]{2,119}$'
  ),
  subject_template text NOT NULL CHECK (
    subject_template = pg_catalog.btrim(subject_template)
    AND pg_catalog.char_length(subject_template) BETWEEN 1 AND 240
  ),
  body_template text NOT NULL CHECK (
    pg_catalog.char_length(body_template) BETWEEN 1 AND 20000
    AND body_template LIKE 'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY%'
  ),
  actor_source text NOT NULL CHECK (actor_source IN ('migration', 'staff')),
  created_by_staff_user_id uuid REFERENCES public.staff_members(user_id),
  created_reauth_grant_id uuid REFERENCES public.reauth_grants(id),
  creation_reason text NOT NULL CHECK (
    creation_reason = pg_catalog.btrim(creation_reason)
    AND pg_catalog.char_length(creation_reason) BETWEEN 3 AND 1000
  ),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (event_type, locale, revision_number),
  UNIQUE (event_type, locale, revision_key),
  UNIQUE (id, locale, revision_key),
  UNIQUE (id, event_type, locale, revision_key),
  CHECK (
    (actor_source = 'migration'
      AND created_by_staff_user_id IS NULL
      AND created_reauth_grant_id IS NULL)
    OR
    (actor_source = 'staff'
      AND created_by_staff_user_id IS NOT NULL
      AND created_reauth_grant_id IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION public.opensales_validate_notification_template_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed jsonb;
  required jsonb;
  variable_name text;
  remaining text;
  combined_template text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Notification template revisions are immutable';
  END IF;
  SELECT event.allowed_variables, event.required_variables
  INTO allowed, required
  FROM public.notification_template_events event
  WHERE event.event_type = NEW.event_type
  FOR SHARE;
  IF allowed IS NULL THEN
    RAISE EXCEPTION 'Notification template event is unavailable';
  END IF;
  combined_template := NEW.subject_template || E'\n' || NEW.body_template;
  FOR variable_name IN
    SELECT match[1]
    FROM pg_catalog.regexp_matches(
      combined_template,
      '\{\{([A-Za-z][A-Za-z0-9]*)\}\}',
      'g'
    ) AS match
  LOOP
    IF NOT allowed ? variable_name THEN
      RAISE EXCEPTION 'Notification template variable % is not declared', variable_name;
    END IF;
  END LOOP;
  FOR variable_name IN
    SELECT pg_catalog.jsonb_array_elements_text(required)
  LOOP
    IF pg_catalog.strpos(combined_template, '{{' || variable_name || '}}') = 0 THEN
      RAISE EXCEPTION 'Notification template requires variable %', variable_name;
    END IF;
  END LOOP;
  remaining := pg_catalog.regexp_replace(
    combined_template,
    '\{\{[A-Za-z][A-Za-z0-9]*\}\}',
    '',
    'g'
  );
  IF remaining LIKE '%{{%' OR remaining LIKE '%}}%' THEN
    RAISE EXCEPTION 'Notification template contains an invalid placeholder';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_template_revisions_validate
BEFORE INSERT OR UPDATE OR DELETE ON public.notification_template_revisions
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_notification_template_revision();

CREATE TABLE public.notification_template_publications (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  revision_id uuid NOT NULL UNIQUE REFERENCES public.notification_template_revisions(id),
  actor_source text NOT NULL CHECK (actor_source IN ('migration', 'staff')),
  actor_staff_user_id uuid REFERENCES public.staff_members(user_id),
  reauth_grant_id uuid REFERENCES public.reauth_grants(id),
  reason text NOT NULL CHECK (
    reason = pg_catalog.btrim(reason)
    AND pg_catalog.char_length(reason) BETWEEN 3 AND 1000
  ),
  published_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (
    (actor_source = 'migration'
      AND actor_staff_user_id IS NULL
      AND reauth_grant_id IS NULL)
    OR
    (actor_source = 'staff'
      AND actor_staff_user_id IS NOT NULL
      AND reauth_grant_id IS NOT NULL)
  )
);

CREATE TABLE public.notification_template_retirements (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  revision_id uuid NOT NULL UNIQUE REFERENCES public.notification_template_revisions(id),
  actor_source text NOT NULL CHECK (actor_source IN ('migration', 'staff')),
  actor_staff_user_id uuid REFERENCES public.staff_members(user_id),
  reauth_grant_id uuid REFERENCES public.reauth_grants(id),
  reason text NOT NULL CHECK (
    reason = pg_catalog.btrim(reason)
    AND pg_catalog.char_length(reason) BETWEEN 3 AND 1000
  ),
  retired_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (
    (actor_source = 'migration'
      AND actor_staff_user_id IS NULL
      AND reauth_grant_id IS NULL)
    OR
    (actor_source = 'staff'
      AND actor_staff_user_id IS NOT NULL
      AND reauth_grant_id IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION public.opensales_validate_notification_template_publication()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_event_type text;
  target_locale text;
  target_revision_number bigint;
  latest_published_revision_number bigint;
BEGIN
  SELECT revision.event_type, revision.locale, revision.revision_number
  INTO target_event_type, target_locale, target_revision_number
  FROM public.notification_template_revisions revision
  WHERE revision.id = NEW.revision_id
  FOR SHARE;
  IF target_revision_number IS NULL THEN
    RAISE EXCEPTION 'Notification template publication target is unavailable';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'opensales:notification-template-publication:' ||
      target_event_type || ':' || target_locale,
      0
    )
  );
  SELECT pg_catalog.max(revision.revision_number)
  INTO latest_published_revision_number
  FROM public.notification_template_publications publication
  JOIN public.notification_template_revisions revision
    ON revision.id = publication.revision_id
  WHERE revision.event_type = target_event_type
    AND revision.locale = target_locale;
  IF latest_published_revision_number IS NOT NULL
     AND target_revision_number <= latest_published_revision_number THEN
    RAISE EXCEPTION 'Notification template publication must advance the revision number';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_template_publications_validate
BEFORE INSERT ON public.notification_template_publications
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_notification_template_publication();

CREATE OR REPLACE FUNCTION public.opensales_validate_notification_template_retirement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
  FROM public.notification_template_channels channel
  WHERE channel.current_revision_id = NEW.revision_id
  FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION 'A current notification template revision cannot be retired';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_template_retirements_validate
BEFORE INSERT ON public.notification_template_retirements
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_notification_template_retirement();

CREATE OR REPLACE FUNCTION public.opensales_reject_notification_template_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Notification template publication and retirement facts are immutable';
END;
$$;

CREATE TRIGGER notification_template_publications_immutable
BEFORE UPDATE OR DELETE ON public.notification_template_publications
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_notification_template_fact_mutation();
CREATE TRIGGER notification_template_retirements_immutable
BEFORE UPDATE OR DELETE ON public.notification_template_retirements
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_notification_template_fact_mutation();

CREATE TABLE public.notification_template_channels (
  event_type text NOT NULL REFERENCES public.notification_template_events(event_type),
  locale text NOT NULL CHECK (locale IN ('en', 'zh-CN')),
  current_revision_id uuid REFERENCES public.notification_template_revisions(id),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (event_type, locale)
);

CREATE OR REPLACE FUNCTION public.opensales_validate_notification_template_channel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  revision_matches boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Notification template channels cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version < 0 THEN
      RAISE EXCEPTION 'Notification template channel version is invalid';
    END IF;
  ELSE
    IF NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.locale IS DISTINCT FROM OLD.locale
       OR NEW.version <> OLD.version + 1
       OR NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION 'Notification template channel update is stale or invalid';
    END IF;
  END IF;
  IF NEW.locale = 'en' AND NEW.current_revision_id IS NULL THEN
    RAISE EXCEPTION 'The English notification template fallback cannot be empty';
  END IF;
  IF NEW.current_revision_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.notification_template_revisions revision
      JOIN public.notification_template_publications publication
        ON publication.revision_id = revision.id
      LEFT JOIN public.notification_template_retirements retirement
        ON retirement.revision_id = revision.id
      WHERE revision.id = NEW.current_revision_id
        AND revision.event_type = NEW.event_type
        AND revision.locale = NEW.locale
        AND retirement.id IS NULL
    ) INTO revision_matches;
    IF NOT revision_matches THEN
      RAISE EXCEPTION 'Notification template channel must select a published active revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_template_channels_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.notification_template_channels
FOR EACH ROW EXECUTE FUNCTION public.opensales_validate_notification_template_channel();

INSERT INTO public.notification_template_revisions(
  event_type, locale, revision_key, revision_number, provider_template_ref,
  subject_template, body_template, actor_source, creation_reason
)
VALUES
  ('notification.email_verification_requested', 'en', 'email-verification-v1', 1,
   'email-verification', 'Verify your OpenSales System laboratory account',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n{{verificationUrl}}\n\nExpires: {{expiresAt}}',
   'migration', 'Adopt the reviewed Schema 026 English template'),
  ('notification.email_verification_requested', 'zh-CN', 'email-verification-v1', 1,
   'email-verification', '验证 OpenSales System 实验室账号',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n{{verificationUrl}}\n\n到期时间：{{expiresAt}}',
   'migration', 'Adopt the reviewed Schema 026 Chinese template'),
  ('identity.notification.password_recovery', 'en', 'password-recovery-v1', 1,
   'password-recovery-v1', 'Reset your OpenSales System laboratory password',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nPassword recovery link: {{actionUrl}}\n\nExpires: {{expiresAt}}',
   'migration', 'Adopt the reviewed Schema 026 English template'),
  ('identity.notification.password_recovery', 'zh-CN', 'password-recovery-v1', 1,
   'password-recovery-v1', '重置 OpenSales System 实验室密码',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n密码恢复链接：{{actionUrl}}\n\n到期时间：{{expiresAt}}',
   'migration', 'Adopt the reviewed Schema 026 Chinese template'),
  ('identity.notification.email_change', 'en', 'email-change-v1', 1,
   'email-change-v1', 'Confirm your OpenSales System laboratory email change',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nEmail change confirmation link: {{actionUrl}}\n\nExpires: {{expiresAt}}',
   'migration', 'Adopt the reviewed Schema 026 English template'),
  ('identity.notification.email_change', 'zh-CN', 'email-change-v1', 1,
   'email-change-v1', '确认 OpenSales System 实验室邮箱变更',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n邮箱变更确认链接：{{actionUrl}}\n\n到期时间：{{expiresAt}}',
   'migration', 'Adopt the reviewed Schema 026 Chinese template'),
  ('notification.membership_invitation_requested', 'en', 'membership-invitation-v1', 1,
   'membership-invitation-v1', 'Join an OpenSales System laboratory Client Account',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nClient Account: {{accountName}}\nAccount ID: {{accountId}}\nRole: {{role}}\nInvitation link: {{invitationUrl}}\nExpires: {{expiresAt}}',
   'migration', 'Adopt the reviewed Schema 026 English template'),
  ('notification.membership_invitation_requested', 'zh-CN', 'membership-invitation-v1', 1,
   'membership-invitation-v1', '加入 OpenSales System 实验室客户账户',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n客户账户：{{accountName}}\n账户 ID：{{accountId}}\n角色：{{role}}\n邀请链接：{{invitationUrl}}\n到期时间：{{expiresAt}}',
   'migration', 'Adopt the reviewed Schema 026 Chinese template'),
  ('notification.service_cancellation_scheduled', 'en', 'service-cancellation-scheduled-v1', 1,
   'service-cancellation-scheduled-v1', 'Service cancellation scheduled for period end',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nProduct: {{productName}}\nService: {{serviceId}}\nEffective at: {{effectiveAt}}\nExecution: {{executionMode}}',
   'migration', 'Adopt the reviewed Schema 026 English template'),
  ('notification.service_cancellation_scheduled', 'zh-CN', 'service-cancellation-scheduled-v1', 1,
   'service-cancellation-scheduled-v1', '服务已安排在账期末取消',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n产品：{{productName}}\n服务：{{serviceId}}\n生效时间：{{effectiveAt}}\n执行方式：{{executionMode}}',
   'migration', 'Adopt the reviewed Schema 026 Chinese template'),
  ('notification.renewal_reminder_requested', 'en', 'renewal-created-v1', 1,
   'renewal-created-v1', 'Renewal invoice created',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nInvoice: {{invoiceId}}\nService: {{serviceId}}\nDue: {{dueAt}}\nAmount due: {{currency}} {{amountDue}}',
   'migration', 'Retain the reviewed Schema 026 renewal history'),
  ('notification.renewal_reminder_requested', 'en', 'renewal-pre-due-v1', 2,
   'renewal-pre-due-v1', 'Renewal invoice is due in {{offsetDays}} days',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nInvoice: {{invoiceId}}\nService: {{serviceId}}\nDue: {{dueAt}}\nAmount due: {{currency}} {{amountDue}}',
   'migration', 'Retain the reviewed Schema 026 renewal history'),
  ('notification.renewal_reminder_requested', 'en', 'renewal-overdue-first-v1', 3,
   'renewal-overdue-first-v1', 'Renewal invoice is {{offsetDays}} days overdue',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nInvoice: {{invoiceId}}\nService: {{serviceId}}\nDue: {{dueAt}}\nAmount due: {{currency}} {{amountDue}}',
   'migration', 'Retain the reviewed Schema 026 renewal history'),
  ('notification.renewal_reminder_requested', 'en', 'renewal-reminder-v2', 4,
   'renewal-reminder-v2', 'Renewal billing update',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nKind: {{kind}}\nInvoice: {{invoiceId}}\nService: {{serviceId}}\nDue: {{dueAt}}\nAmount due: {{currency}} {{amountDue}}',
   'migration', 'Publish one versioned English renewal registry template'),
  ('notification.renewal_reminder_requested', 'zh-CN', 'renewal-created-v1', 1,
   'renewal-created-v1', '续费发票已创建',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n发票：{{invoiceId}}\n服务：{{serviceId}}\n到期时间：{{dueAt}}\n当前应付：{{currency}} {{amountDue}}',
   'migration', 'Retain the reviewed Schema 026 renewal history'),
  ('notification.renewal_reminder_requested', 'zh-CN', 'renewal-pre-due-v1', 2,
   'renewal-pre-due-v1', '续费发票将在 {{offsetDays}} 天后到期',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n发票：{{invoiceId}}\n服务：{{serviceId}}\n到期时间：{{dueAt}}\n当前应付：{{currency}} {{amountDue}}',
   'migration', 'Retain the reviewed Schema 026 renewal history'),
  ('notification.renewal_reminder_requested', 'zh-CN', 'renewal-overdue-first-v1', 3,
   'renewal-overdue-first-v1', '续费发票已逾期 {{offsetDays}} 天',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n发票：{{invoiceId}}\n服务：{{serviceId}}\n到期时间：{{dueAt}}\n当前应付：{{currency}} {{amountDue}}',
   'migration', 'Retain the reviewed Schema 026 renewal history'),
  ('notification.renewal_reminder_requested', 'zh-CN', 'renewal-reminder-v2', 4,
   'renewal-reminder-v2', '续费账单动态',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n类型：{{kind}}\n发票：{{invoiceId}}\n服务：{{serviceId}}\n到期时间：{{dueAt}}\n当前应付：{{currency}} {{amountDue}}',
   'migration', 'Publish one versioned Chinese renewal registry template'),
  ('notification.support_ticket_reply_requested', 'en', 'support-ticket-reply-v1', 1,
   'support-ticket-reply-v1', 'Ticket reply: {{ticketSubject}}',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nTicket: {{ticketId}}\n\n{{ticketMessage}}',
   'migration', 'Adopt the reviewed Schema 026 English template'),
  ('notification.support_ticket_reply_requested', 'zh-CN', 'support-ticket-reply-v1', 1,
   'support-ticket-reply-v1', '工单回复：{{ticketSubject}}',
   E'NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n工单：{{ticketId}}\n\n{{ticketMessage}}',
   'migration', 'Adopt the reviewed Schema 026 Chinese template');

INSERT INTO public.notification_template_publications(
  revision_id, actor_source, reason
)
SELECT revision.id, 'migration', 'Adopt reviewed notification template history'
FROM public.notification_template_revisions revision
ORDER BY revision.event_type COLLATE "C", revision.locale COLLATE "C",
         revision.revision_number;

INSERT INTO public.notification_template_retirements(
  revision_id, actor_source, reason
)
SELECT revision.id, 'migration', 'Superseded by the Schema 027 current revision'
FROM public.notification_template_revisions revision
WHERE revision.event_type = 'notification.renewal_reminder_requested'
  AND revision.revision_key <> 'renewal-reminder-v2';

INSERT INTO public.notification_template_channels(
  event_type, locale, current_revision_id, version
)
SELECT event.event_type, requested.locale, current_revision.id, 1
FROM public.notification_template_events event
CROSS JOIN (VALUES ('en'::text), ('zh-CN'::text)) requested(locale)
JOIN public.notification_template_revisions current_revision
  ON current_revision.event_type = event.event_type
 AND current_revision.locale = requested.locale
 AND current_revision.revision_key = CASE event.event_type
       WHEN 'notification.renewal_reminder_requested' THEN 'renewal-reminder-v2'
       WHEN 'notification.email_verification_requested' THEN 'email-verification-v1'
       WHEN 'identity.notification.password_recovery' THEN 'password-recovery-v1'
       WHEN 'identity.notification.email_change' THEN 'email-change-v1'
       WHEN 'notification.membership_invitation_requested' THEN 'membership-invitation-v1'
       WHEN 'notification.service_cancellation_scheduled' THEN 'service-cancellation-scheduled-v1'
       WHEN 'notification.support_ticket_reply_requested' THEN 'support-ticket-reply-v1'
     END;

CREATE VIEW public.current_notification_templates AS
SELECT channel.event_type,
       channel.locale,
       channel.version AS channel_version,
       revision.id AS revision_id,
       revision.revision_key,
       revision.revision_number,
       revision.provider_template_ref,
       revision.subject_template,
       revision.body_template,
       event.preference_category,
       event.required_delivery,
       event.sensitive,
       event.allowed_variables,
       publication.published_at
FROM public.notification_template_channels channel
JOIN public.notification_template_events event
  ON event.event_type = channel.event_type
JOIN public.notification_template_revisions revision
  ON revision.id = channel.current_revision_id
JOIN public.notification_template_publications publication
  ON publication.revision_id = revision.id
LEFT JOIN public.notification_template_retirements retirement
  ON retirement.revision_id = revision.id
WHERE retirement.id IS NULL;

CREATE TABLE public.user_notification_preferences (
  user_id uuid NOT NULL REFERENCES public.users(id),
  category text NOT NULL REFERENCES public.notification_preference_categories(category),
  channel text NOT NULL CHECK (channel = 'email'),
  enabled boolean NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (user_id, category, channel)
);

CREATE OR REPLACE FUNCTION public.opensales_guard_user_notification_preference()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  mandatory boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'User notification preferences retain their current fact';
  END IF;
  SELECT category.required_delivery INTO mandatory
  FROM public.notification_preference_categories category
  WHERE category.category = NEW.category
  FOR SHARE;
  IF mandatory IS NULL OR (mandatory AND NOT NEW.enabled) THEN
    RAISE EXCEPTION 'Required notification categories cannot be disabled';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.updated_at IS DISTINCT FROM NEW.created_at THEN
      RAISE EXCEPTION 'User notification preference must begin at version one';
    END IF;
  ELSIF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.version <> OLD.version + 1
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'User notification preference update is stale or invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_notification_preferences_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.user_notification_preferences
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_user_notification_preference();

CREATE TABLE public.user_notification_preference_changes (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  category text NOT NULL REFERENCES public.notification_preference_categories(category),
  channel text NOT NULL CHECK (channel = 'email'),
  previous_enabled boolean NOT NULL,
  enabled boolean NOT NULL,
  previous_version bigint NOT NULL CHECK (previous_version >= 0),
  version bigint NOT NULL CHECK (version = previous_version + 1),
  changed_by_session_id uuid NOT NULL REFERENCES public.sessions(id),
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (user_id, category, channel, version)
);

CREATE OR REPLACE FUNCTION public.opensales_reject_user_notification_preference_change_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'User notification preference change facts are immutable';
END;
$$;

CREATE TRIGGER user_notification_preference_changes_immutable
BEFORE UPDATE OR DELETE ON public.user_notification_preference_changes
FOR EACH ROW EXECUTE FUNCTION public.opensales_reject_user_notification_preference_change_mutation();

-- Schema 019 bound every account-scoped delivery to immutable business facts
-- and also embedded the then-current template keys in that validator. Schema
-- 027 retains the complete reviewed business binding while moving template
-- identity to the new composite foreign key and immutable revision guard.
-- The exact Schema 026 catalog gate makes these source clauses stable;
-- fail the forward migration if any expected clause is absent.
DO $migration$
DECLARE
  validator_definition text;
  rewritten_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.opensales_validate_notification_delivery_operation()'::pg_catalog.regprocedure
  ) INTO validator_definition;

  rewritten_definition := pg_catalog.replace(
    validator_definition,
$needle$
       AND NEW.template_revision =
         'renewal-' || pg_catalog.replace(
           NEW.payload_snapshot ->> 'kind', '_', '-'
         ) || '-v1'$needle$,
    ''
  );
  IF rewritten_definition = validator_definition THEN
    RAISE EXCEPTION 'Schema 027 could not advance the renewal template binding';
  END IF;
  validator_definition := rewritten_definition;

  rewritten_definition := pg_catalog.replace(
    validator_definition,
$needle$
       AND NEW.template_revision = 'service-cancellation-scheduled-v1'$needle$,
    ''
  );
  IF rewritten_definition = validator_definition THEN
    RAISE EXCEPTION 'Schema 027 could not advance the service template binding';
  END IF;
  validator_definition := rewritten_definition;

  rewritten_definition := pg_catalog.replace(
    validator_definition,
$needle$
       AND NEW.template_revision = 'support-ticket-reply-v1'$needle$,
    ''
  );
  IF rewritten_definition = validator_definition THEN
    RAISE EXCEPTION 'Schema 027 could not advance the Support template binding';
  END IF;
  validator_definition := rewritten_definition;

  rewritten_definition := pg_catalog.replace(
    validator_definition,
$needle$  IF (COALESCE(recipient_is_valid, false) AND NEW.status <> 'queued')
     OR (NOT COALESCE(recipient_is_valid, false) AND NEW.status <> 'skipped') THEN$needle$,
$replacement$  IF (
    COALESCE(recipient_is_valid, false)
    AND NEW.status <> 'queued'
    AND NOT (
      NEW.status = 'skipped'
      AND NEW.last_error = 'USER_NOTIFICATION_PREFERENCE_DISABLED'
      AND NEW.recipient_user_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.notification_template_events template_event
        JOIN public.user_notification_preferences preference
          ON preference.user_id = NEW.recipient_user_id
         AND preference.category = template_event.preference_category
         AND preference.channel = 'email'
        WHERE template_event.event_type = NEW.event_type
          AND NOT template_event.required_delivery
          AND NOT preference.enabled
      )
    )
  )
  OR (NOT COALESCE(recipient_is_valid, false) AND NEW.status <> 'skipped') THEN$replacement$
  );
  IF rewritten_definition = validator_definition THEN
    RAISE EXCEPTION 'Schema 027 could not bind the enqueue-time User preference';
  END IF;

  EXECUTE rewritten_definition;
END;
$migration$;

ALTER TABLE public.notification_delivery_operations
  ADD COLUMN template_revision_id uuid,
  ADD COLUMN template_locale text;

-- Schema 019 intentionally retained legacy terminal Provider outcomes whose
-- pre-019 runtime could not persist a rendered request snapshot.  The normal
-- Schema 027 registry binding below changes only the two newly-added columns,
-- but the inherited UPDATE guard would otherwise reject those legitimate
-- saved terminal rows.  Disable only that exact guard for this deterministic
-- migration-owned backfill, then restore it before any application can observe
-- Schema 027.  PostgreSQL rolls both changes back atomically if the UPDATE or a
-- later migration statement fails.
DO $$
DECLARE
  exact_guard_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO exact_guard_count
  FROM pg_catalog.pg_trigger trigger_row
  JOIN pg_catalog.pg_class relation
    ON relation.oid = trigger_row.tgrelid
  JOIN pg_catalog.pg_namespace relation_namespace
    ON relation_namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_proc function_row
    ON function_row.oid = trigger_row.tgfoid
  JOIN pg_catalog.pg_namespace function_namespace
    ON function_namespace.oid = function_row.pronamespace
  WHERE relation_namespace.nspname = 'public'
    AND relation.relname = 'notification_delivery_operations'
    AND trigger_row.tgname = 'notification_delivery_operations_guard'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgenabled = 'O'
    AND trigger_row.tgtype = 27
    AND NOT trigger_row.tgdeferrable
    AND NOT trigger_row.tginitdeferred
    AND function_namespace.nspname = 'public'
    AND function_row.proname = 'opensales_guard_notification_delivery_operation'
    AND function_row.pronargs = 0;

  IF exact_guard_count <> 1 THEN
    RAISE EXCEPTION
      'Schema 027 requires the exact enabled Schema 019 notification delivery UPDATE guard';
  END IF;
END;
$$;

ALTER TABLE public.notification_delivery_operations
  DISABLE TRIGGER notification_delivery_operations_guard;

UPDATE public.notification_delivery_operations operation
SET template_revision_id = revision.id,
    template_locale = revision.locale
FROM public.notification_template_revisions revision
WHERE revision.event_type = operation.event_type
  AND revision.locale = operation.locale
  AND revision.revision_key = operation.template_revision;

ALTER TABLE public.notification_delivery_operations
  ENABLE TRIGGER notification_delivery_operations_guard;

DO $$
DECLARE
  missing_operation uuid;
BEGIN
  SELECT id INTO missing_operation
  FROM public.notification_delivery_operations
  WHERE template_revision_id IS NULL OR template_locale IS NULL
  ORDER BY id
  LIMIT 1;
  IF missing_operation IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 027 cannot map historical notification operation % to a registry revision',
      missing_operation;
  END IF;
END;
$$;

ALTER TABLE public.notification_delivery_operations
  ALTER COLUMN template_revision_id SET NOT NULL,
  ALTER COLUMN template_locale SET NOT NULL,
  ADD CONSTRAINT notification_delivery_operations_template_locale_check
    CHECK (template_locale IN ('en', 'zh-CN')),
  ADD CONSTRAINT notification_delivery_operations_template_revision_fkey
    FOREIGN KEY (template_revision_id, event_type, template_locale, template_revision)
    REFERENCES public.notification_template_revisions(
      id, event_type, locale, revision_key
    );

CREATE OR REPLACE FUNCTION public.opensales_guard_notification_operation_template_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  first_revision_id uuid;
  first_template_locale text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.template_revision_id IS DISTINCT FROM OLD.template_revision_id
       OR NEW.template_locale IS DISTINCT FROM OLD.template_locale THEN
      RAISE EXCEPTION 'Notification attempt template revision is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.attempt_number > 1 THEN
    SELECT operation.template_revision_id, operation.template_locale
    INTO first_revision_id, first_template_locale
    FROM public.notification_delivery_operations operation
    WHERE operation.outbox_id = NEW.outbox_id
      AND operation.attempt_number = 1
    FOR SHARE;
    IF NEW.template_revision_id IS NULL THEN
      NEW.template_revision_id := first_revision_id;
    END IF;
    IF NEW.template_locale IS NULL THEN
      NEW.template_locale := first_template_locale;
    END IF;
    IF NEW.template_revision_id IS DISTINCT FROM first_revision_id
       OR NEW.template_locale IS DISTINCT FROM first_template_locale THEN
      RAISE EXCEPTION 'Notification retry must retain the first attempt template revision';
    END IF;
  ELSIF NEW.template_revision_id IS NULL OR NEW.template_locale IS NULL THEN
    SELECT revision.id, revision.locale
    INTO NEW.template_revision_id, NEW.template_locale
    FROM public.notification_template_revisions revision
    WHERE revision.event_type = NEW.event_type
      AND revision.revision_key = NEW.template_revision
      AND revision.locale IN (NEW.locale, 'en')
    ORDER BY (revision.locale = NEW.locale) DESC,
             revision.locale COLLATE "C"
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_delivery_operations_template_revision_guard
BEFORE INSERT OR UPDATE ON public.notification_delivery_operations
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_notification_operation_template_revision();

ALTER TABLE public.identity_notification_delivery_operations
  ADD COLUMN template_revision_id uuid,
  ADD COLUMN template_revision text,
  ADD COLUMN template_locale text;

UPDATE public.identity_notification_delivery_operations operation
SET template_revision_id = revision.id,
    template_revision = revision.revision_key,
    template_locale = revision.locale
FROM public.identity_notification_outbox event
JOIN public.notification_template_revisions revision
  ON revision.event_type = 'identity.notification.' || event.kind
 AND revision.locale = event.locale
 AND revision.revision_key = CASE event.kind
       WHEN 'password_recovery' THEN 'password-recovery-v1'
       WHEN 'email_change' THEN 'email-change-v1'
     END
WHERE event.id = operation.outbox_id;

DO $$
DECLARE
  missing_operation uuid;
BEGIN
  SELECT id INTO missing_operation
  FROM public.identity_notification_delivery_operations
  WHERE template_revision_id IS NULL
     OR template_revision IS NULL
     OR template_locale IS NULL
  ORDER BY id
  LIMIT 1;
  IF missing_operation IS NOT NULL THEN
    RAISE EXCEPTION
      'Schema 027 cannot map historical identity operation % to a registry revision',
      missing_operation;
  END IF;
END;
$$;

ALTER TABLE public.identity_notification_delivery_operations
  ALTER COLUMN template_revision_id SET NOT NULL,
  ALTER COLUMN template_revision SET NOT NULL,
  ALTER COLUMN template_locale SET NOT NULL,
  ADD CONSTRAINT identity_notification_operations_template_revision_check
    CHECK (template_revision ~ '^[a-z0-9][a-z0-9_-]{2,79}$'),
  ADD CONSTRAINT identity_notification_operations_template_locale_check
    CHECK (template_locale IN ('en', 'zh-CN')),
  ADD CONSTRAINT identity_notification_operations_template_revision_fkey
    FOREIGN KEY (template_revision_id, template_locale, template_revision)
    REFERENCES public.notification_template_revisions(id, locale, revision_key);

CREATE OR REPLACE FUNCTION public.opensales_guard_identity_operation_template_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_event_type text;
  first_revision_id uuid;
  first_template_revision text;
  first_template_locale text;
BEGIN
  SELECT 'identity.notification.' || event.kind
  INTO expected_event_type
  FROM public.identity_notification_outbox event
  WHERE event.id = NEW.outbox_id
  FOR SHARE;
  IF TG_OP = 'INSERT' AND NEW.attempt_number > 1 THEN
    SELECT operation.template_revision_id, operation.template_revision,
           operation.template_locale
    INTO first_revision_id, first_template_revision, first_template_locale
    FROM public.identity_notification_delivery_operations operation
    WHERE operation.outbox_id = NEW.outbox_id
      AND operation.attempt_number = 1
    FOR SHARE;
    IF NEW.template_revision_id IS NULL THEN
      NEW.template_revision_id := first_revision_id;
    END IF;
    IF NEW.template_revision IS NULL THEN
      NEW.template_revision := first_template_revision;
    END IF;
    IF NEW.template_locale IS NULL THEN
      NEW.template_locale := first_template_locale;
    END IF;
  ELSIF TG_OP = 'INSERT' AND (
    NEW.template_revision_id IS NULL
    OR NEW.template_revision IS NULL
    OR NEW.template_locale IS NULL
  ) THEN
    SELECT template.revision_id, template.revision_key, template.locale
    INTO NEW.template_revision_id, NEW.template_revision, NEW.template_locale
    FROM public.current_notification_templates template
    JOIN public.identity_notification_outbox event ON event.id = NEW.outbox_id
    WHERE template.event_type = expected_event_type
      AND template.locale IN (event.locale, 'en')
    ORDER BY (template.locale = event.locale) DESC,
             template.locale COLLATE "C"
    LIMIT 1;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.notification_template_revisions revision
    WHERE revision.id = NEW.template_revision_id
      AND revision.event_type = expected_event_type
      AND revision.locale = NEW.template_locale
      AND revision.revision_key = NEW.template_revision
  ) THEN
    RAISE EXCEPTION 'Identity notification attempt template does not match its event';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.template_revision_id IS DISTINCT FROM OLD.template_revision_id
       OR NEW.template_revision IS DISTINCT FROM OLD.template_revision
       OR NEW.template_locale IS DISTINCT FROM OLD.template_locale THEN
      RAISE EXCEPTION 'Identity notification attempt template revision is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.attempt_number > 1 THEN
    IF NEW.template_revision_id IS DISTINCT FROM first_revision_id
       OR NEW.template_revision IS DISTINCT FROM first_template_revision
       OR NEW.template_locale IS DISTINCT FROM first_template_locale THEN
      RAISE EXCEPTION 'Identity notification retry must retain the first attempt template revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER identity_notification_operations_template_revision_guard
BEFORE INSERT OR UPDATE ON public.identity_notification_delivery_operations
FOR EACH ROW EXECUTE FUNCTION public.opensales_guard_identity_operation_template_revision();

COMMENT ON TABLE public.notification_template_revisions IS
  'Immutable bilingual notification template revisions. Delivery attempts reference the exact selected revision.';
COMMENT ON TABLE public.user_notification_preferences IS
  'Current per-User, per-category email preferences. Required identity, transactional, and high-risk categories cannot be disabled.';
