// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import {
  canonicalCustomerApiKeyScopes,
  createCustomerApiKey,
  CUSTOMER_API_KEY_SCOPES,
  encryptIdentitySecret,
  decryptIdentitySecret,
  generateRecoveryCodes,
  generateTotpSecret,
  matchTotpStep,
  digestRecoveryCode,
  type CustomerApiKeyScope,
} from "@opensales/core/identity-security";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  assertApiKeyScopesAllowedForMembership,
  assertCustomerCapability,
  assertIdentityReadEligible,
  createOpaqueToken,
  digestToken,
  passwordHash,
  passwordVerify,
  requireSessionIdentity,
  requireUser,
  setAccountContextForRequest,
  setAccountContextHeaders,
  setAuthorizationEpochForRequest,
  type SessionIdentity,
} from "./auth.js";
import { identitySecretKeyring, type Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { activeTotpCredential, verifyConfiguredFactorLocked } from "./identity-factor.js";
import { resolveCurrentNotificationTemplate } from "./notification-templates.js";
import {
  clearLabIdentityMailboxCapability,
  rotateLabIdentityMailboxCapability,
  setLabIdentityMailboxCapability,
} from "./routes-auth.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const passwordSchema = z.string().min(12).max(256);
const factorCodeSchema = z.string().min(6).max(23).optional();

const recoveryRequestSchema = z.object({ email: z.email().max(320) }).strict();
const recoveryCompleteSchema = z.object({
  token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
  newPassword: passwordSchema,
}).strict();
const passwordChangeSchema = z.object({
  currentPassword: z.string().max(256),
  newPassword: passwordSchema,
  factorCode: factorCodeSchema,
}).strict();
const emailChangeRequestSchema = z.object({
  requestedEmail: z.email().max(320),
  password: z.string().max(256),
  factorCode: factorCodeSchema,
}).strict();
const tokenCompleteSchema = z.object({
  token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
const totpEnrollSchema = z.object({
  password: z.string().max(256),
  idempotencyKey: canonicalUuid,
}).strict();
const totpConfirmSchema = z.object({
  challengeId: canonicalUuid,
  code: z.string().regex(/^\d{6}$/),
}).strict();
const factorMutationSchema = z.object({
  password: z.string().max(256),
  factorCode: z.string().min(6).max(23),
}).strict();
const sessionParamsSchema = z.object({ sessionId: canonicalUuid }).strict();
const apiKeyParamsSchema = z.object({ apiKeyId: canonicalUuid }).strict();
const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(CUSTOMER_API_KEY_SCOPES)).min(1).max(6),
  idempotencyKey: canonicalUuid,
  password: z.string().max(256),
  factorCode: factorCodeSchema,
}).strict();
const apiKeyRevokeSchema = z.object({
  password: z.string().max(256),
  factorCode: factorCodeSchema,
  reason: z.string().trim().min(3).max(240).default("revoked by customer"),
}).strict();

type LockedIdentity = Readonly<{
  passwordHash: string;
  email: string;
  locale: "en" | "zh-CN";
  emailVerifiedAt: Date | null;
  restrictedAt: Date | null;
  authorizationEpoch: string;
  currentSession: Readonly<{
    id: string;
    activeClientAccountId: string | null;
    accountContextVersion: string;
  }>;
}>;

function sessionInvalidError(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error("Session is invalid or expired"), {
    statusCode: 401,
    code: "SESSION_INVALID",
  });
}

function emailUnavailableError(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error("The requested email is unavailable"), {
    statusCode: 409,
    code: "EMAIL_UNAVAILABLE",
  });
}

function isUsersEmailUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" &&
      "code" in error && error.code === "23505" &&
      "constraint" in error && error.constraint === "users_email_key",
  );
}

async function lockIdentityAndSessions(
  client: DatabaseClient,
  identity: Pick<SessionIdentity, "userId" | "sessionId">,
): Promise<LockedIdentity> {
  const principal = await client.query<{
    password_hash: string;
    email: string;
    locale: "en" | "zh-CN";
    email_verified_at: Date | null;
    restricted_at: Date | null;
    authorization_epoch: string;
  }>(
    `SELECT password_hash, email::text, locale, email_verified_at, restricted_at,
            authorization_epoch::text
     FROM public.users WHERE id = $1 FOR UPDATE`,
    [identity.userId],
  );
  const user = principal.rows[0];
  if (!user) throw sessionInvalidError();
  const sessions = await client.query<{
    id: string;
    active_client_account_id: string | null;
    account_context_version: string;
  }>(
    `SELECT id, active_client_account_id, account_context_version::text
     FROM public.sessions
     WHERE user_id = $1 AND revoked_at IS NULL
       AND expires_at > pg_catalog.clock_timestamp()
     ORDER BY id FOR UPDATE`,
    [identity.userId],
  );
  const current = sessions.rows.find((row) => row.id === identity.sessionId);
  if (!current) throw sessionInvalidError();
  return {
    passwordHash: user.password_hash,
    email: user.email,
    locale: user.locale,
    emailVerifiedAt: user.email_verified_at,
    restrictedAt: user.restricted_at,
    authorizationEpoch: user.authorization_epoch,
    currentSession: {
      id: current.id,
      activeClientAccountId: current.active_client_account_id,
      accountContextVersion: current.account_context_version,
    },
  };
}

function assertLockedIdentityEligible(identity: LockedIdentity): void {
  assertIdentityReadEligible({
    emailVerifiedAt: identity.emailVerifiedAt,
    userRestrictedAt: identity.restrictedAt,
  });
}

async function bumpAuthorizationEpoch(
  client: DatabaseClient,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE public.users
     SET authorization_epoch = authorization_epoch + 1,
         updated_at = pg_catalog.now()
     WHERE id = $1`,
    [userId],
  );
  await client.query(
    `UPDATE public.sessions
     SET account_context_version = account_context_version + 1
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  await client.query(
    `UPDATE public.reauth_grants
     SET invalidated_at = pg_catalog.now()
     WHERE user_id = $1 AND invalidated_at IS NULL`,
    [userId],
  );
}

async function refreshIdentityHeaders(
  pool: DatabasePool,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  sessionId: string,
): Promise<void> {
  const result = await pool.query<{
    authorization_epoch: string;
    active_client_account_id: string | null;
    account_context_version: string;
  }>(
    `SELECT principal.authorization_epoch::text,
            session_record.active_client_account_id,
            session_record.account_context_version::text
     FROM public.users principal
     JOIN public.sessions session_record ON session_record.user_id = principal.id
     WHERE principal.id = $1 AND session_record.id = $2
       AND session_record.revoked_at IS NULL
       AND session_record.expires_at > pg_catalog.clock_timestamp()`,
    [userId, sessionId],
  );
  const row = result.rows[0];
  if (!row) return;
  const context = {
    clientAccountId: row.active_client_account_id,
    accountContextVersion: row.account_context_version,
  };
  setAccountContextForRequest(request, context);
  setAccountContextHeaders(reply, context);
  setAuthorizationEpochForRequest(request, row.authorization_epoch);
}

function passwordRecoveryUrl(config: Config, token: string): string {
  return `${config.OSS_PUBLIC_URL}/password-recovery#token=${token}`;
}

function emailChangeUrl(config: Config, token: string): string {
  return `${config.OSS_PUBLIC_URL}/email-change#token=${token}`;
}

async function enqueueIdentityNotification(
  client: DatabaseClient,
  config: Config,
  input: Readonly<{
    userId: string;
    kind: "password_recovery" | "email_change";
    recipient: string;
    locale: "en" | "zh-CN";
    subjectId: string;
    url: string;
    expiresAt: Date;
  }>,
): Promise<void> {
  const template = await resolveCurrentNotificationTemplate(
    client,
    `identity.notification.${input.kind}`,
    input.locale,
  );
  const encrypted = encryptIdentitySecret(
    JSON.stringify({ url: input.url, expiresAt: input.expiresAt.toISOString() }),
    `identity-notification:${input.kind}`,
    input.subjectId,
    identitySecretKeyring(config),
  );
  const outbox = await client.query<{ id: string }>(
    `INSERT INTO public.identity_notification_outbox(
       user_id, kind, recipient, locale, subject_id,
       encrypted_payload, encryption_key_version, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.userId,
      input.kind,
      input.recipient,
      input.locale,
      input.subjectId,
      encrypted.ciphertext,
      encrypted.keyVersion,
      input.expiresAt,
    ],
  );
  const outboxId = outbox.rows[0]?.id;
  if (!outboxId) throw new Error("Unable to create identity notification");
  const operation = await client.query<{ id: string; attempt_number: number }>(
    `INSERT INTO public.identity_notification_delivery_operations(
       outbox_id, attempt_number, provider_operation_id, request_fingerprint,
       template_revision_id, template_revision, template_locale, status
     )
     SELECT event.id, 1,
            public.opensales_notification_provider_operation_id(event.id, 1),
            public.opensales_identity_notification_request_fingerprint(
              event.id, event.user_id, event.kind, event.recipient, event.locale,
              event.subject_id, event.encrypted_payload,
              event.encryption_key_version, event.expires_at
            ),
            $2, $3, $4, 'queued'
     FROM public.identity_notification_outbox event
     WHERE event.id = $1
     RETURNING id, attempt_number`,
    [outboxId, template.revisionId, template.revisionKey, template.templateLocale],
  );
  const delivery = operation.rows[0];
  if (!delivery) throw new Error("Unable to create identity delivery operation");
  await client.query(
    `INSERT INTO public.durable_jobs(job_type, unique_key, payload)
     VALUES ('identity.notification.send', $1, $2)`,
    [
      `identity-notification:${outboxId}:attempt:1`,
      {
        outboxId,
        operationId: delivery.id,
        attemptNumber: delivery.attempt_number,
      },
    ],
  );
}

async function confirmPasswordAndConfiguredFactor(
  client: DatabaseClient,
  config: Config,
  identity: Pick<SessionIdentity, "userId">,
  locked: LockedIdentity,
  password: string,
  factorCode: string | undefined,
): Promise<void> {
  if (!(await passwordVerify(locked.passwordHash, password))) {
    throw Object.assign(new Error("Password confirmation failed"), { statusCode: 401 });
  }
  const factor = await verifyConfiguredFactorLocked(
    client,
    config,
    identity.userId,
    factorCode,
    "reauth",
  );
  if (!factor) {
    throw Object.assign(new Error("Authentication factor confirmation failed"), {
      statusCode: 401,
      code: "FACTOR_REQUIRED",
    });
  }
}

type LockedApiKeyMembership = Readonly<{
  role: "owner" | "billing" | "technical" | "viewer";
  permissions: readonly string[];
}>;

async function lockApiKeyAccountMembership(
  client: DatabaseClient,
  userId: string,
  clientAccountId: string,
): Promise<LockedApiKeyMembership> {
  const account = await client.query<{ restricted_at: Date | null }>(
    `SELECT restricted_at
     FROM public.client_accounts
     WHERE id = $1
     FOR UPDATE`,
    [clientAccountId],
  );
  const membership = await client.query<{
    role: "owner" | "billing" | "technical" | "viewer";
    permissions: unknown;
    removed_at: Date | null;
    restricted_at: Date | null;
  }>(
    `SELECT role, permissions, removed_at, restricted_at
     FROM public.client_memberships
     WHERE client_account_id = $1 AND user_id = $2
     FOR UPDATE`,
    [clientAccountId, userId],
  );
  const member = membership.rows[0];
  if (
    !account.rows[0] || account.rows[0].restricted_at || !member ||
    member.removed_at || member.restricted_at
  ) {
    throw Object.assign(new Error("The active Client Account is unavailable"), {
      statusCode: 403,
      code: "ACCOUNT_RESTRICTED",
    });
  }
  return {
    role: member.role,
    permissions:
      Array.isArray(member.permissions) &&
        member.permissions.every((permission) => typeof permission === "string")
        ? member.permissions
        : [],
  };
}

export async function registerIdentitySecurityRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.post("/api/v1/auth/password-recovery/request", async (request, reply) => {
    const body = recoveryRequestSchema.parse(request.body);
    const token = createOpaqueToken();
    const tokenId = randomUUID();
    const pointer = await pool.query<{
      id: string;
      email: string;
      locale: "en" | "zh-CN";
      restricted_at: Date | null;
    }>(
      `SELECT id, email::text, locale, restricted_at
       FROM users WHERE email = $1`,
      [body.email],
    );
    const user = pointer.rows[0];
    if (user && !user.restricted_at) {
      await transaction(pool, async (client) => {
        const locked = await client.query<{
          email: string;
          locale: "en" | "zh-CN";
          restricted_at: Date | null;
          authorization_epoch: string;
          expires_at: Date;
        }>(
          `SELECT email::text, locale, restricted_at,
                  authorization_epoch::text,
                  pg_catalog.clock_timestamp() + interval '30 minutes' AS expires_at
           FROM users WHERE id = $1 FOR UPDATE`,
          [user.id],
        );
        const principal = locked.rows[0];
        if (!principal || principal.email !== user.email || principal.restricted_at) return;
        const expiresAt = principal.expires_at;
        await client.query(
          `SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL
           ORDER BY id FOR UPDATE`,
          [user.id],
        );
        const recent = await client.query(
          `SELECT token.id
           FROM password_reset_tokens token
           LEFT JOIN identity_notification_outbox event
             ON event.kind = 'password_recovery' AND event.subject_id = token.id
           LEFT JOIN LATERAL (
             SELECT operation.attempt_number, operation.status
             FROM identity_notification_delivery_operations operation
             WHERE operation.outbox_id = event.id
             ORDER BY operation.attempt_number DESC
             LIMIT 1
           ) latest ON true
           WHERE token.user_id = $1
             AND token.authorization_epoch = $2
             AND token.used_at IS NULL
             AND token.invalidated_at IS NULL
             AND token.expires_at > pg_catalog.clock_timestamp()
             AND NOT (
               latest.status = 'manual'
               OR (latest.status = 'failed' AND latest.attempt_number = 3)
             )
           ORDER BY token.created_at DESC, token.id DESC
           LIMIT 1
           FOR UPDATE OF token`,
          [user.id, principal.authorization_epoch],
        );
        if (recent.rows[0]) return;
        await client.query(
          `UPDATE password_reset_tokens
           SET invalidated_at = pg_catalog.now()
           WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
          [user.id],
        );
        await client.query(
          `INSERT INTO password_reset_tokens(
             id, user_id, authorization_epoch, token_digest, expires_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [tokenId, user.id, principal.authorization_epoch, digestToken(token), expiresAt],
        );
        await enqueueIdentityNotification(client, config, {
          userId: user.id,
          kind: "password_recovery",
          recipient: principal.email,
          locale: principal.locale,
          subjectId: tokenId,
          url: passwordRecoveryUrl(config, token),
          expiresAt,
        });
      });
    }
    return reply.code(202).send({
      message: "If the identity is eligible, password recovery instructions will be delivered.",
    });
  });

  app.post("/api/v1/auth/password-recovery/complete", async (request, reply) => {
    const body = recoveryCompleteSchema.parse(request.body);
    const encodedPassword = await passwordHash(body.newPassword);
    const pointer = await pool.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_digest = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
      [digestToken(body.token)],
    );
    const tokenPointer = pointer.rows[0];
    if (!tokenPointer) return reply.code(400).send({ error: "Recovery token is invalid" });
    const completed = await transaction(pool, async (client) => {
      const user = await client.query<{
        restricted_at: Date | null;
        authorization_epoch: string;
      }>(
        `SELECT restricted_at, authorization_epoch::text
         FROM users WHERE id = $1 FOR UPDATE`,
        [tokenPointer.user_id],
      );
      const principal = user.rows[0];
      if (!principal || principal.restricted_at) return false;
      await client.query(
        `SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL
         ORDER BY id FOR UPDATE`,
        [tokenPointer.user_id],
      );
      await activeTotpCredential(client, tokenPointer.user_id);
      const token = await client.query<{ id: string }>(
        `SELECT id FROM password_reset_tokens
         WHERE id = $1 AND user_id = $2 AND token_digest = $3
           AND authorization_epoch = $4
           AND used_at IS NULL AND invalidated_at IS NULL
           AND expires_at > pg_catalog.clock_timestamp()
         FOR UPDATE`,
        [
          tokenPointer.id,
          tokenPointer.user_id,
          digestToken(body.token),
          principal.authorization_epoch,
        ],
      );
      if (!token.rows[0]) return false;
      const apiKeys = await client.query<{ id: string }>(
        `SELECT api_key.id FROM customer_api_keys api_key
         LEFT JOIN customer_api_key_revocations revocation
           ON revocation.api_key_id = api_key.id
         WHERE api_key.user_id = $1 AND revocation.api_key_id IS NULL
         ORDER BY api_key.id FOR UPDATE OF api_key`,
        [tokenPointer.user_id],
      );
      await client.query(
        `INSERT INTO customer_api_key_revocations(api_key_id, revoked_by_user_id, reason)
         SELECT id, $1, 'password recovery revoked the customer API key'
         FROM unnest($2::uuid[]) AS keys(id)`,
        [tokenPointer.user_id, apiKeys.rows.map((row) => row.id)],
      );
      await client.query(
        `UPDATE password_reset_tokens SET used_at = pg_catalog.now() WHERE id = $1`,
        [tokenPointer.id],
      );
      await client.query(
        `UPDATE password_reset_tokens SET invalidated_at = pg_catalog.now()
         WHERE user_id = $1 AND id <> $2 AND used_at IS NULL AND invalidated_at IS NULL`,
        [tokenPointer.user_id, tokenPointer.id],
      );
      await client.query(
        `UPDATE login_challenges SET invalidated_at = pg_catalog.now()
         WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [tokenPointer.user_id],
      );
      await client.query(
        `UPDATE sessions SET revoked_at = pg_catalog.now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [tokenPointer.user_id],
      );
      await client.query(
        `UPDATE users SET password_hash = $2, updated_at = pg_catalog.now()
         WHERE id = $1`,
        [tokenPointer.user_id, encodedPassword],
      );
      const passwordEvent = await client.query<{ id: string }>(
        `SELECT id FROM identity_password_change_events
         WHERE user_id = $1 AND transaction_id = pg_catalog.txid_current()
         ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [tokenPointer.user_id],
      );
      if (!passwordEvent.rows[0]) throw new Error("Password recovery transition event is missing");
      await client.query(
        `INSERT INTO identity_action_facts(user_id, action, target_id, metadata)
         VALUES ($1, 'password.recovered', $2,
                 pg_catalog.jsonb_build_object(
                   'revokedApiKeyCount', $3::integer,
                   'revokedAllSessions', true,
                   'passwordChangeEventId', $4::text
                 ))`,
        [
          tokenPointer.user_id,
          tokenPointer.id,
          apiKeys.rows.length,
          passwordEvent.rows[0].id,
        ],
      );
      return true;
    });
    if (!completed) return reply.code(410).send({ error: "Recovery token is expired" });
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
    clearLabIdentityMailboxCapability(reply);
    return reply.code(200).send({ sessionEnded: true });
  });

  app.get("/api/v1/security", async (request) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const result = await pool.query<{
      totp_enabled: boolean;
      recovery_codes_remaining: string;
      active_sessions: string;
      active_api_keys: string;
    }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM user_totp_credentials
           WHERE user_id = $1 AND disabled_at IS NULL
         ) AS totp_enabled,
         (SELECT pg_catalog.count(*)::text
          FROM totp_recovery_codes recovery
          JOIN user_totp_credentials credential ON credential.id = recovery.credential_id
          WHERE credential.user_id = $1 AND credential.disabled_at IS NULL
            AND recovery.used_at IS NULL AND recovery.invalidated_at IS NULL)
           AS recovery_codes_remaining,
         (SELECT pg_catalog.count(*)::text FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL
            AND expires_at > pg_catalog.clock_timestamp())
           AS active_sessions,
         (SELECT pg_catalog.count(*)::text FROM customer_api_keys api_key
          LEFT JOIN customer_api_key_revocations revocation ON revocation.api_key_id = api_key.id
          WHERE api_key.user_id = $1 AND revocation.api_key_id IS NULL)
           AS active_api_keys`,
      [identity.userId],
    );
    const row = result.rows[0]!;
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      email: identity.email,
      authorizationEpoch: identity.authorizationEpoch,
      totp: { enabled: row.totp_enabled, recoveryCodesRemaining: row.recovery_codes_remaining },
      activeSessions: row.active_sessions,
      activeApiKeys: row.active_api_keys,
      later: ["WebAuthn", "SSO", "SMS", "device and IP policy", "Staff-assisted recovery"],
    };
  });

  app.post("/api/v1/security/password", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const body = passwordChangeSchema.parse(request.body);
    const encodedPassword = await passwordHash(body.newPassword);
    const mailboxCapability = await transaction(pool, async (client) => {
      const locked = await lockIdentityAndSessions(client, identity);
      assertLockedIdentityEligible(locked);
      await confirmPasswordAndConfiguredFactor(
        client, config, identity, locked, body.currentPassword, body.factorCode,
      );
      await client.query(
        `UPDATE sessions SET revoked_at = pg_catalog.now()
         WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [identity.userId, identity.sessionId],
      );
      await client.query(
        `UPDATE users SET password_hash = $2, updated_at = pg_catalog.now()
         WHERE id = $1`,
        [identity.userId, encodedPassword],
      );
      const passwordEvent = await client.query<{ id: string }>(
        `SELECT id FROM identity_password_change_events
         WHERE user_id = $1 AND transaction_id = pg_catalog.txid_current()
         ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [identity.userId],
      );
      if (!passwordEvent.rows[0]) throw new Error("Password change transition event is missing");
      await client.query(
        `INSERT INTO identity_action_facts(user_id, actor_session_id, action, target_id)
         VALUES ($1, $2, 'password.changed', $3)`,
        [identity.userId, identity.sessionId, passwordEvent.rows[0].id],
      );
      return rotateLabIdentityMailboxCapability(
        client,
        identity.userId,
        locked.email,
        identity.sessionId,
        config.LAB_MAILBOX_ENABLED,
      );
    });
    setLabIdentityMailboxCapability(reply, config, mailboxCapability);
    await refreshIdentityHeaders(pool, request, reply, identity.userId, identity.sessionId);
    return reply.code(204).send();
  });

  app.post("/api/v1/security/email-change/request", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const body = emailChangeRequestSchema.parse(request.body);
    const token = createOpaqueToken();
    const tokenId = randomUUID();
    const expiresAt = await transaction(pool, async (client) => {
      const locked = await lockIdentityAndSessions(client, identity);
      assertLockedIdentityEligible(locked);
      await confirmPasswordAndConfiguredFactor(
        client, config, identity, locked, body.password, body.factorCode,
      );
      if (body.requestedEmail.toLowerCase() === locked.email.toLowerCase()) {
        throw Object.assign(new Error("The requested email is already in use by this identity"), {
          statusCode: 409,
          code: "EMAIL_UNCHANGED",
        });
      }
      const existing = await client.query(
        `SELECT 1 FROM users WHERE email = $1 AND id <> $2`,
        [body.requestedEmail, identity.userId],
      );
      if (existing.rows[0]) {
        throw emailUnavailableError();
      }
      await client.query(
        `UPDATE email_change_tokens SET invalidated_at = pg_catalog.now()
         WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [identity.userId],
      );
      const databaseClock = await client.query<{ expires_at: Date }>(
        `SELECT pg_catalog.clock_timestamp() + interval '30 minutes' AS expires_at`,
      );
      const expiresAt = databaseClock.rows[0]!.expires_at;
      await client.query(
        `INSERT INTO email_change_tokens(
           id, user_id, authorization_epoch, requested_email, token_digest, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tokenId,
          identity.userId,
          locked.authorizationEpoch,
          body.requestedEmail,
          digestToken(token),
          expiresAt,
        ],
      );
      await enqueueIdentityNotification(client, config, {
        userId: identity.userId,
        kind: "email_change",
        recipient: body.requestedEmail,
        locale: locked.locale,
        subjectId: tokenId,
        url: emailChangeUrl(config, token),
        expiresAt,
      });
      await client.query(
        `INSERT INTO identity_action_facts(
           user_id, actor_session_id, action, target_id, metadata
         ) VALUES ($1, $2, 'email.change_requested', $3,
                   pg_catalog.jsonb_build_object('requestedEmail', $4::text))`,
        [identity.userId, identity.sessionId, tokenId, body.requestedEmail],
      );
      return expiresAt;
    });
    return reply.code(202).send({ expiresAt: expiresAt.toISOString() });
  });

  app.post("/api/v1/security/email-change/inspect", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const body = tokenCompleteSchema.parse(request.body);
    const requestedEmail = await transaction(pool, async (client) => {
      const locked = await lockIdentityAndSessions(client, identity);
      assertLockedIdentityEligible(locked);
      const token = await client.query<{ requested_email: string }>(
        `SELECT requested_email::text
         FROM email_change_tokens
         WHERE user_id = $1 AND token_digest = $2
           AND authorization_epoch = $3
           AND used_at IS NULL AND invalidated_at IS NULL
           AND expires_at > pg_catalog.clock_timestamp()
         FOR SHARE`,
        [identity.userId, digestToken(body.token), locked.authorizationEpoch],
      );
      return token.rows[0]?.requested_email ?? null;
    });
    if (!requestedEmail) {
      return reply.code(410).send({ error: "Email change token is expired" });
    }
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      requestedEmail,
    };
  });

  app.post("/api/v1/security/email-change/complete", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const body = tokenCompleteSchema.parse(request.body);
    let outcome: Readonly<{ mailboxCapability: string | null }> | null;
    try {
      outcome = await transaction(pool, async (client) => {
        const locked = await lockIdentityAndSessions(client, identity);
        assertLockedIdentityEligible(locked);
        await activeTotpCredential(client, identity.userId);
        const token = await client.query<{
          id: string;
          requested_email: string;
        }>(
          `SELECT id, requested_email::text
           FROM email_change_tokens
           WHERE user_id = $1 AND token_digest = $2
             AND authorization_epoch = $3
             AND used_at IS NULL AND invalidated_at IS NULL
             AND expires_at > pg_catalog.clock_timestamp()
           FOR UPDATE`,
          [identity.userId, digestToken(body.token), locked.authorizationEpoch],
        );
        const row = token.rows[0];
        if (!row) return null;
        const conflict = await client.query(
          `SELECT 1 FROM users WHERE email = $1 AND id <> $2`,
          [row.requested_email, identity.userId],
        );
        if (conflict.rows[0]) throw emailUnavailableError();
        await client.query(
          `UPDATE email_change_tokens SET used_at = pg_catalog.now() WHERE id = $1`,
          [row.id],
        );
        await client.query(
          `UPDATE users SET email = $2, email_verified_at = pg_catalog.now(),
                            updated_at = pg_catalog.now()
           WHERE id = $1`,
          [identity.userId, row.requested_email],
        );
        await client.query(
          `UPDATE sessions SET revoked_at = pg_catalog.now()
           WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
          [identity.userId, identity.sessionId],
        );
        await client.query(
          `INSERT INTO identity_action_facts(
             user_id, actor_session_id, action, target_id
           ) VALUES ($1, $2, 'email.changed', $3)`,
          [identity.userId, identity.sessionId, row.id],
        );
        return {
          mailboxCapability: await rotateLabIdentityMailboxCapability(
            client,
            identity.userId,
            row.requested_email,
            identity.sessionId,
            config.LAB_MAILBOX_ENABLED,
          ),
        };
      });
    } catch (error) {
      if (isUsersEmailUniqueViolation(error)) throw emailUnavailableError();
      throw error;
    }
    if (!outcome) return reply.code(410).send({ error: "Email change token is expired" });
    setLabIdentityMailboxCapability(reply, config, outcome.mailboxCapability);
    await refreshIdentityHeaders(pool, request, reply, identity.userId, identity.sessionId);
    return reply.code(204).send();
  });

  app.post("/api/v1/security/totp/enroll", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const body = totpEnrollSchema.parse(request.body);
    const challengeId = randomUUID();
    const secret = generateTotpSecret();
    const encrypted = encryptIdentitySecret(
      secret,
      "totp-enrollment",
      challengeId,
      identitySecretKeyring(config),
    );
    const outcome = await transaction(pool, async (client) => {
      const locked = await lockIdentityAndSessions(client, identity);
      assertLockedIdentityEligible(locked);
      if (!(await passwordVerify(locked.passwordHash, body.password))) return "password" as const;
      const credential = await activeTotpCredential(client, identity.userId);
      if (credential) return "enabled" as const;
      const replay = await client.query(
        `SELECT 1 FROM totp_enrollment_challenges
         WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [identity.userId, body.idempotencyKey],
      );
      if (replay.rows[0]) return "replay" as const;
      await client.query(
        `UPDATE totp_enrollment_challenges SET invalidated_at = pg_catalog.now()
         WHERE user_id = $1 AND confirmed_at IS NULL AND invalidated_at IS NULL`,
        [identity.userId],
      );
      await client.query(
        `INSERT INTO totp_enrollment_challenges(
           id, user_id, seed_ciphertext, seed_key_version,
           idempotency_key, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           pg_catalog.clock_timestamp() + interval '10 minutes'
         )`,
        [
          challengeId,
          identity.userId,
          encrypted.ciphertext,
          encrypted.keyVersion,
          body.idempotencyKey,
        ],
      );
      return "created" as const;
    });
    if (outcome === "password") return reply.code(401).send({ error: "Password confirmation failed" });
    if (outcome === "enabled") return reply.code(409).send({ error: "TOTP is already enabled" });
    if (outcome === "replay") {
      return reply.code(409).send({
        error: "This enrollment response was already issued; start a new enrollment",
        code: "SECRET_ALREADY_ISSUED",
      });
    }
    const issuer = encodeURIComponent("OpenSales System Mock Laboratory");
    const label = encodeURIComponent(`OpenSales System:${identity.email}`);
    return reply.code(201).send({
      challengeId,
      secret,
      provisioningUri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
      expiresInSeconds: 600,
      displayOnce: true,
    });
  });

  app.post("/api/v1/security/totp/confirm", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const body = totpConfirmSchema.parse(request.body);
    const recoveryCodes = generateRecoveryCodes();
    const outcome = await transaction(pool, async (client) => {
      const locked = await lockIdentityAndSessions(client, identity);
      assertLockedIdentityEligible(locked);
      if (await activeTotpCredential(client, identity.userId)) return "enabled" as const;
      const challenge = await client.query<{
        seed_ciphertext: string;
        seed_key_version: number;
      }>(
        `SELECT seed_ciphertext, seed_key_version
         FROM totp_enrollment_challenges
         WHERE id = $1 AND user_id = $2
           AND confirmed_at IS NULL AND invalidated_at IS NULL
           AND expires_at > pg_catalog.clock_timestamp()
         FOR UPDATE`,
        [body.challengeId, identity.userId],
      );
      const row = challenge.rows[0];
      if (!row) return "expired" as const;
      const secret = decryptIdentitySecret(
        row.seed_ciphertext,
        row.seed_key_version,
        "totp-enrollment",
        body.challengeId,
        identitySecretKeyring(config),
      );
      const databaseClock = await client.query<{ now_ms: string }>(
        `SELECT pg_catalog.floor(
           extract(epoch FROM pg_catalog.clock_timestamp()) * 1000
         )::bigint::text AS now_ms`,
      );
      const step = matchTotpStep(secret, body.code, Number(databaseClock.rows[0]!.now_ms));
      if (step === null) return "invalid" as const;
      const credential = await client.query<{ id: string }>(
        `INSERT INTO user_totp_credentials(
           user_id, seed_ciphertext, seed_key_version
         ) VALUES ($1, $2, $3) RETURNING id`,
        [
          identity.userId,
          encryptIdentitySecret(
            secret,
            "totp",
            identity.userId,
            identitySecretKeyring(config),
          ).ciphertext,
          identitySecretKeyring(config).activeVersion,
        ],
      );
      const credentialId = credential.rows[0]!.id;
      const recoveryBatchId = randomUUID();
      await client.query(
        `INSERT INTO totp_recovery_code_batches(
           id, credential_id, kind, code_count
         ) VALUES ($1, $2, 'initial', $3)`,
        [recoveryBatchId, credentialId, recoveryCodes.length],
      );
      await client.query(
        `INSERT INTO totp_step_use_facts(credential_id, timestep, purpose)
         VALUES ($1, $2, 'enrollment')`,
        [credentialId, step.toString()],
      );
      for (const code of recoveryCodes) {
        await client.query(
          `INSERT INTO totp_recovery_codes(credential_id, batch_id, code_digest)
           VALUES ($1, $2, $3)`,
          [credentialId, recoveryBatchId, digestRecoveryCode(code)],
        );
      }
      await client.query(
        `UPDATE totp_enrollment_challenges SET confirmed_at = pg_catalog.now()
         WHERE id = $1`,
        [body.challengeId],
      );
      await bumpAuthorizationEpoch(client, identity.userId);
      await client.query(
        `INSERT INTO identity_action_facts(
           user_id, actor_session_id, action, target_id
         ) VALUES ($1, $2, 'totp.enabled', $3)`,
        [identity.userId, identity.sessionId, credentialId],
      );
      return {
        kind: "enabled_now" as const,
        mailboxCapability: await rotateLabIdentityMailboxCapability(
          client,
          identity.userId,
          locked.email,
          identity.sessionId,
          config.LAB_MAILBOX_ENABLED,
        ),
      };
    });
    if (outcome === "expired") return reply.code(410).send({ error: "TOTP enrollment expired" });
    if (outcome === "invalid") return reply.code(401).send({ error: "TOTP code is invalid" });
    if (outcome === "enabled") {
      return reply.code(409).send({
        error: "TOTP is already enabled; recovery codes cannot be shown again",
        code: "SECRET_ALREADY_ISSUED",
      });
    }
    setLabIdentityMailboxCapability(reply, config, outcome.mailboxCapability);
    await refreshIdentityHeaders(pool, request, reply, identity.userId, identity.sessionId);
    return reply.code(201).send({ recoveryCodes, displayOnce: true });
  });

  app.post("/api/v1/security/totp/disable", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const body = factorMutationSchema.parse(request.body);
    const disabled = await transaction(pool, async (client) => {
      const locked = await lockIdentityAndSessions(client, identity);
      assertLockedIdentityEligible(locked);
      if (!(await passwordVerify(locked.passwordHash, body.password))) return false;
      const credential = await activeTotpCredential(client, identity.userId);
      if (!credential) return false;
      const factor = await verifyConfiguredFactorLocked(
        client, config, identity.userId, body.factorCode, "reauth", { credential, required: true },
      );
      if (!factor || factor === "password") return false;
      await client.query(
        `UPDATE user_totp_credentials SET disabled_at = pg_catalog.now()
         WHERE id = $1 AND disabled_at IS NULL`,
        [credential.id],
      );
      await client.query(
        `UPDATE totp_recovery_codes SET invalidated_at = pg_catalog.now()
         WHERE credential_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [credential.id],
      );
      await bumpAuthorizationEpoch(client, identity.userId);
      await client.query(
        `INSERT INTO identity_action_facts(
           user_id, actor_session_id, action, target_id
         ) VALUES ($1, $2, 'totp.disabled', $3)`,
        [identity.userId, identity.sessionId, credential.id],
      );
      return {
        mailboxCapability: await rotateLabIdentityMailboxCapability(
          client,
          identity.userId,
          locked.email,
          identity.sessionId,
          config.LAB_MAILBOX_ENABLED,
        ),
      };
    });
    if (!disabled) return reply.code(401).send({ error: "Password or factor confirmation failed" });
    setLabIdentityMailboxCapability(reply, config, disabled.mailboxCapability);
    await refreshIdentityHeaders(pool, request, reply, identity.userId, identity.sessionId);
    return reply.code(204).send();
  });

  app.post("/api/v1/security/totp/recovery-codes", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const body = factorMutationSchema.parse(request.body);
    const recoveryCodes = generateRecoveryCodes();
    const regenerated = await transaction(pool, async (client) => {
      const locked = await lockIdentityAndSessions(client, identity);
      assertLockedIdentityEligible(locked);
      if (!(await passwordVerify(locked.passwordHash, body.password))) return false;
      const credential = await activeTotpCredential(client, identity.userId);
      if (!credential) return false;
      const factor = await verifyConfiguredFactorLocked(
        client, config, identity.userId, body.factorCode, "reauth", { credential, required: true },
      );
      // Recovery-code rotation must retain a known authentication path even
      // if the one-time response is lost after commit. Require the live TOTP
      // factor here; a recovery code remains available for login/reauth but
      // cannot be consumed while simultaneously replacing every known code.
      if (factor !== "totp") return false;
      await client.query(
        `UPDATE totp_recovery_codes SET invalidated_at = pg_catalog.now()
         WHERE credential_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [credential.id],
      );
      const recoveryBatchId = randomUUID();
      await client.query(
        `INSERT INTO totp_recovery_code_batches(
           id, credential_id, kind, code_count
         ) VALUES ($1, $2, 'regenerated', $3)`,
        [recoveryBatchId, credential.id, recoveryCodes.length],
      );
      for (const code of recoveryCodes) {
        await client.query(
          `INSERT INTO totp_recovery_codes(credential_id, batch_id, code_digest)
           VALUES ($1, $2, $3)`,
          [credential.id, recoveryBatchId, digestRecoveryCode(code)],
        );
      }
      await bumpAuthorizationEpoch(client, identity.userId);
      await client.query(
        `INSERT INTO identity_action_facts(
           user_id, actor_session_id, action, target_id, metadata
         ) VALUES (
           $1, $2, 'totp.recovery_codes_regenerated', $3,
           pg_catalog.jsonb_build_object('count', $4::integer)
         )`,
        [identity.userId, identity.sessionId, recoveryBatchId, recoveryCodes.length],
      );
      return {
        mailboxCapability: await rotateLabIdentityMailboxCapability(
          client,
          identity.userId,
          locked.email,
          identity.sessionId,
          config.LAB_MAILBOX_ENABLED,
        ),
      };
    });
    if (!regenerated) return reply.code(401).send({ error: "Password or factor confirmation failed" });
    setLabIdentityMailboxCapability(reply, config, regenerated.mailboxCapability);
    await refreshIdentityHeaders(pool, request, reply, identity.userId, identity.sessionId);
    return reply.code(201).send({ recoveryCodes, displayOnce: true });
  });

  app.post("/api/v1/security/api-keys", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertIdentityReadEligible(user);
    const body = apiKeyCreateSchema.parse(request.body);
    const scopes = canonicalCustomerApiKeyScopes(body.scopes);
    const requestFingerprint = createHash("sha256")
      .update("opensales:customer-api-key-request:v1\0", "utf8")
      .update(JSON.stringify({ name: body.name, scopes }), "utf8")
      .digest();
    const outcome = await transaction(pool, async (client) => {
      const locked = await lockIdentityAndSessions(client, user);
      assertLockedIdentityEligible(locked);
      if (locked.currentSession.activeClientAccountId !== user.clientAccountId) {
        throw Object.assign(new Error("The Client Account context changed; reload and retry"), {
          statusCode: 409,
          code: "ACCOUNT_CONTEXT_STALE",
        });
      }
      await confirmPasswordAndConfiguredFactor(
        client, config, user, locked, body.password, body.factorCode,
      );
      await client.query(
        `SELECT id FROM public.customer_api_keys
         WHERE user_id = $1
         ORDER BY id FOR UPDATE`,
        [user.userId],
      );
      const membership = await lockApiKeyAccountMembership(
        client,
        user.userId,
        user.clientAccountId,
      );
      assertApiKeyScopesAllowedForMembership(scopes, {
        membershipRole: membership.role,
        membershipPermissions: membership.permissions,
      });
      const replay = await client.query<{ request_fingerprint: Buffer }>(
        `SELECT request_fingerprint
         FROM public.customer_api_keys
         WHERE user_id = $1 AND client_account_id = $2 AND idempotency_key = $3`,
        [user.userId, user.clientAccountId, body.idempotencyKey],
      );
      if (replay.rows[0]) {
        return replay.rows[0].request_fingerprint.equals(requestFingerprint)
          ? ({ kind: "replay" } as const)
          : ({ kind: "conflict" } as const);
      }
      const keyId = randomUUID();
      const generated = createCustomerApiKey(keyId);
      await client.query(
        `INSERT INTO public.customer_api_keys(
           id, user_id, client_account_id, name, scopes, token_digest,
           idempotency_key, request_fingerprint
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          keyId,
          user.userId,
          user.clientAccountId,
          body.name,
          scopes,
          generated.digest,
          body.idempotencyKey,
          requestFingerprint,
        ],
      );
      await client.query(
        `INSERT INTO public.identity_action_facts(
           user_id, actor_session_id, action, target_id, metadata
         ) VALUES ($1, $2, 'api_key.created', $3,
                   pg_catalog.jsonb_build_object('name', $4::text, 'scopes', $5::text[]))`,
        [user.userId, user.sessionId, keyId, body.name, scopes],
      );
      return { kind: "created" as const, keyId, rawKey: generated.rawKey };
    });
    if (outcome.kind === "replay") {
      return reply.code(409).send({
        error: "This API key response was already issued and its secret cannot be shown again",
        code: "SECRET_ALREADY_ISSUED",
      });
    }
    if (outcome.kind === "conflict") {
      return reply.code(409).send({
        error: "The idempotency key was already used with a different request",
        code: "IDEMPOTENCY_KEY_REUSED",
      });
    }
    return reply.code(201).send({
      id: outcome.keyId,
      apiKey: outcome.rawKey,
      displayOnce: true,
      scopes,
    });
  });

  app.get("/api/v1/security/api-keys", async (request) => {
    const user = await requireUser(request, pool, config);
    assertIdentityReadEligible(user);
    assertCustomerCapability(user, "account.history.read");
    const keys = await pool.query<{
      id: string;
      name: string;
      scopes: string[];
      created_at: Date;
      revoked_at: Date | null;
      reason: string | null;
    }>(
      `SELECT api_key.id, api_key.name, api_key.scopes, api_key.created_at,
              revocation.revoked_at, revocation.reason
       FROM public.customer_api_keys api_key
       LEFT JOIN public.customer_api_key_revocations revocation
         ON revocation.api_key_id = api_key.id
       WHERE api_key.user_id = $1 AND api_key.client_account_id = $2
       ORDER BY api_key.created_at DESC, api_key.id DESC`,
      [user.userId, user.clientAccountId],
    );
    return {
      items: keys.rows.map((row) => ({
        id: row.id,
        name: row.name,
        scopes: row.scopes,
        status: row.revoked_at ? "revoked" : "active",
        createdAt: row.created_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
        revocationReason: row.reason,
      })),
    };
  });

  app.post("/api/v1/security/api-keys/:apiKeyId/revoke", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertIdentityReadEligible(user);
    const params = apiKeyParamsSchema.parse(request.params);
    const body = apiKeyRevokeSchema.parse(request.body);
    const outcome = await transaction(pool, async (client) => {
      const locked = await lockIdentityAndSessions(client, user);
      assertLockedIdentityEligible(locked);
      await confirmPasswordAndConfiguredFactor(
        client, config, user, locked, body.password, body.factorCode,
      );
      const key = await client.query<{ id: string }>(
        `SELECT id FROM public.customer_api_keys
         WHERE id = $1 AND user_id = $2 AND client_account_id = $3
         FOR UPDATE`,
        [params.apiKeyId, user.userId, user.clientAccountId],
      );
      if (!key.rows[0]) return "missing" as const;
      await lockApiKeyAccountMembership(client, user.userId, user.clientAccountId);
      const inserted = await client.query(
        `INSERT INTO public.customer_api_key_revocations(
           api_key_id, revoked_by_user_id, reason
         ) VALUES ($1, $2, $3)
         ON CONFLICT (api_key_id) DO NOTHING
         RETURNING api_key_id`,
        [params.apiKeyId, user.userId, body.reason],
      );
      if (!inserted.rows[0]) return "revoked" as const;
      await client.query(
        `INSERT INTO public.identity_action_facts(
           user_id, actor_session_id, action, target_id
         ) VALUES ($1, $2, 'api_key.revoked', $3)`,
        [user.userId, user.sessionId, params.apiKeyId],
      );
      return "revoked" as const;
    });
    if (outcome === "missing") return reply.code(404).send({ error: "API key not found" });
    return reply.code(204).send();
  });

  app.get("/api/v1/security/sessions", async (request) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const sessions = await pool.query<{
      id: string;
      expires_at: Date;
      revoked_at: Date | null;
      created_at: Date;
      expired: boolean;
    }>(
      `SELECT id, expires_at, revoked_at, created_at,
              expires_at <= pg_catalog.clock_timestamp() AS expired
       FROM sessions WHERE user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [identity.userId],
    );
    return {
      items: sessions.rows.map((row) => ({
        id: row.id,
        current: row.id === identity.sessionId,
        status: row.revoked_at ? "revoked" : row.expired ? "expired" : "active",
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
      })),
    };
  });

  app.delete("/api/v1/security/sessions/:sessionId", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const params = sessionParamsSchema.parse(request.params);
    const revoked = await transaction(pool, async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [identity.userId]);
      const sessions = await client.query<{
        id: string;
        revoked_at: Date | null;
        actor_active: boolean;
      }>(
        `SELECT id, revoked_at,
                revoked_at IS NULL AND expires_at > pg_catalog.clock_timestamp()
                  AS actor_active
         FROM sessions WHERE user_id = $1 ORDER BY id FOR UPDATE`,
        [identity.userId],
      );
      const actor = sessions.rows.find((row) => row.id === identity.sessionId);
      if (!actor?.actor_active) throw sessionInvalidError();
      const target = sessions.rows.find((row) => row.id === params.sessionId);
      if (!target) return false;
      if (target.revoked_at !== null) return true;
      const changed = await client.query(
        `UPDATE sessions SET revoked_at = pg_catalog.now()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
         RETURNING id`,
        [params.sessionId, identity.userId],
      );
      if (changed.rowCount !== 1) return true;
      await client.query(
        `INSERT INTO identity_action_facts(
           user_id, actor_session_id, action, target_id
         ) VALUES ($1, $2, 'session.revoked', $3)`,
        [identity.userId, identity.sessionId, params.sessionId],
      );
      return true;
    });
    if (!revoked) return reply.code(404).send({ error: "Session not found" });
    if (params.sessionId === identity.sessionId) {
      reply.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
      clearLabIdentityMailboxCapability(reply);
      return reply.code(200).send({ sessionEnded: true });
    }
    return reply.code(204).send();
  });

  app.post("/api/v1/security/sessions/revoke-others", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const count = await transaction(pool, async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [identity.userId]);
      const sessions = await client.query<{ id: string }>(
        `SELECT id FROM sessions
         WHERE user_id = $1 AND revoked_at IS NULL
           AND expires_at > pg_catalog.clock_timestamp()
         ORDER BY id FOR UPDATE`,
        [identity.userId],
      );
      if (!sessions.rows.some((row) => row.id === identity.sessionId)) {
        throw sessionInvalidError();
      }
      const result = await client.query(
        `UPDATE sessions SET revoked_at = pg_catalog.now()
         WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id`,
        [identity.userId, identity.sessionId],
      );
      await client.query(
        `INSERT INTO identity_action_facts(
           user_id, actor_session_id, action, metadata
         ) VALUES ($1, $2, 'sessions.others_revoked',
                   pg_catalog.jsonb_build_object('count', $3::integer))`,
        [identity.userId, identity.sessionId, result.rowCount],
      );
      return result.rowCount ?? 0;
    });
    return reply.send({ revokedCount: count });
  });

  app.post("/api/v1/security/sessions/revoke-all", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const count = await transaction(pool, async (client) => {
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [identity.userId]);
      const sessions = await client.query<{ id: string }>(
        `SELECT id FROM sessions
         WHERE user_id = $1 AND revoked_at IS NULL
           AND expires_at > pg_catalog.clock_timestamp()
         ORDER BY id FOR UPDATE`,
        [identity.userId],
      );
      if (!sessions.rows.some((row) => row.id === identity.sessionId)) {
        throw sessionInvalidError();
      }
      const result = await client.query(
        `UPDATE sessions SET revoked_at = pg_catalog.now()
         WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
        [identity.userId],
      );
      await client.query(
        `INSERT INTO identity_action_facts(
           user_id, actor_session_id, action, metadata
         ) VALUES ($1, $2, 'sessions.all_revoked',
                   pg_catalog.jsonb_build_object('count', $3::integer))`,
        [identity.userId, identity.sessionId, result.rowCount],
      );
      return result.rowCount ?? 0;
    });
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
    clearLabIdentityMailboxCapability(reply);
    return reply.send({ revokedCount: count, sessionEnded: true });
  });
}
