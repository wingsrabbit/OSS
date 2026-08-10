// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertIdentityReadEligible,
  createOpaqueToken,
  digestToken,
  expectedAccountContextVersion,
  lockSessionIdentityForMutation,
  membershipCapabilities,
  passwordHash,
  passwordVerify,
  requireSessionIdentity,
  setAccountContextForRequest,
  setAccountContextHeaders,
  type MembershipRole,
  type SessionIdentity,
} from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabasePool } from "./database.js";
import {
  collectionPage,
  decodeKeysetCursor,
  parsePageQuery,
  type KeysetPosition,
} from "./keyset-pagination.js";
import { enqueueNotification } from "./notification-outbox.js";

const registrationSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(12).max(256),
  clientName: z.string().trim().min(2).max(160),
  locale: z.enum(["en", "zh-CN"]).default("en"),
});

const invitationRegistrationSchema = z.object({
  token: z.string().min(32).max(256),
  email: z.email().max(320),
  password: z.string().min(12).max(256),
  locale: z.enum(["en", "zh-CN"]).default("en"),
});

const loginSchema = z.object({
  email: z.email().max(320),
  password: z.string().max(256),
});

const verificationSchema = z.object({
  token: z.string().min(32).max(256),
});

const reauthSchema = z.object({
  password: z.string().max(256),
});

const bootstrapSchema = z.object({
  bootstrapToken: z.string().min(32).max(256),
});

const accountContextSchema = z.object({
  clientAccountId: z.uuid().transform((value) => value.toLowerCase()),
});

const labMailboxMessageSchema = z
  .object({
    id: z.uuid(),
    template: z.string().min(1).max(120),
    locale: z.enum(["en", "zh-CN"]),
    subject: z.string().max(240),
    body: z.string().max(20_000),
    status: z.string().min(1).max(40),
    deliveredAt: z.iso.datetime(),
  })
  .strict();

type AccountContextItem = Readonly<{
  clientAccountId: string;
  name: string;
  role: MembershipRole;
  permissions: readonly string[];
  capabilities: readonly string[];
  restrictions: Readonly<{ membership: boolean; clientAccount: boolean }>;
  createdAt: string;
}>;

async function listAccountContexts(
  pool: DatabasePool,
  identity: SessionIdentity,
  limit: number,
  cursor: KeysetPosition | null,
): Promise<AccountContextItem[]> {
  const result = await pool.query<{
    client_account_id: string;
    account_name: string;
    role: MembershipRole;
    permissions: unknown;
    membership_restricted_at: Date | null;
    account_restricted_at: Date | null;
    created_at_cursor: string;
  }>(
    `SELECT
       membership.client_account_id,
       account.name AS account_name,
       membership.role,
       membership.permissions,
       membership.restricted_at AS membership_restricted_at,
       account.restricted_at AS account_restricted_at,
       to_char(
         membership.created_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS created_at_cursor
     FROM client_memberships membership
     JOIN client_accounts account ON account.id = membership.client_account_id
     WHERE membership.user_id = $1
       AND membership.removed_at IS NULL
       AND (
         $2::timestamptz IS NULL
         OR (membership.created_at, membership.client_account_id)
              < ($2::timestamptz, $3::uuid)
       )
     ORDER BY membership.created_at DESC, membership.client_account_id DESC
     LIMIT $4`,
    [identity.userId, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  return result.rows.map((row) => {
    const permissions =
      Array.isArray(row.permissions) &&
      row.permissions.every((permission) => typeof permission === "string")
        ? row.permissions
        : [];
    return {
      clientAccountId: row.client_account_id,
      name: row.account_name,
      role: row.role,
      permissions,
      capabilities: membershipCapabilities({
        membershipRole: row.role,
        membershipPermissions: permissions,
      }),
      restrictions: {
        membership: Boolean(row.membership_restricted_at),
        clientAccount: Boolean(row.account_restricted_at),
      },
      createdAt: row.created_at_cursor,
    };
  });
}

async function loadActiveAccountContext(
  pool: DatabasePool,
  identity: SessionIdentity,
): Promise<AccountContextItem | null> {
  if (!identity.activeClientAccountId) return null;
  const result = await pool.query<{
    client_account_id: string;
    account_name: string;
    role: MembershipRole;
    permissions: unknown;
    membership_restricted_at: Date | null;
    account_restricted_at: Date | null;
    created_at_cursor: string;
  }>(
    `SELECT membership.client_account_id,
            account.name AS account_name,
            membership.role,
            membership.permissions,
            membership.restricted_at AS membership_restricted_at,
            account.restricted_at AS account_restricted_at,
            to_char(
              membership.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at_cursor
     FROM client_memberships membership
     JOIN client_accounts account ON account.id = membership.client_account_id
     WHERE membership.user_id = $1
       AND membership.client_account_id = $2
       AND membership.removed_at IS NULL`,
    [identity.userId, identity.activeClientAccountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const permissions =
    Array.isArray(row.permissions) &&
    row.permissions.every((permission) => typeof permission === "string")
      ? row.permissions
      : [];
  return {
    clientAccountId: row.client_account_id,
    name: row.account_name,
    role: row.role,
    permissions,
    capabilities: membershipCapabilities({
      membershipRole: row.role,
      membershipPermissions: permissions,
    }),
    restrictions: {
      membership: Boolean(row.membership_restricted_at),
      clientAccount: Boolean(row.account_restricted_at),
    },
    createdAt: row.created_at_cursor,
  };
}

function sessionCookieOptions(config: Config) {
  return {
    httpOnly: true,
    secure: config.OSS_ENV === "laboratory",
    sameSite: "strict" as const,
    path: "/",
    maxAge: config.SESSION_TTL_HOURS * 60 * 60,
  };
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.post("/api/v1/auth/register", async (request, reply) => {
    const body = registrationSchema.parse(request.body);
    const encodedPassword = await passwordHash(body.password);
    const verificationToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + config.VERIFICATION_TTL_MINUTES * 60_000);

    try {
      const user = await transaction(pool, async (client) => {
        const userResult = await client.query<{ id: string }>(
          `INSERT INTO users(email, password_hash, locale)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [body.email, encodedPassword, body.locale],
        );
        const userId = userResult.rows[0]?.id;
        if (!userId) throw new Error("Unable to create user");
        const accountResult = await client.query<{ id: string }>(
          `INSERT INTO client_accounts(name, owner_user_id)
           VALUES ($1, $2)
           RETURNING id`,
          [body.clientName, userId],
        );
        const clientAccountId = accountResult.rows[0]?.id;
        if (!clientAccountId) throw new Error("Unable to create client account");
        await client.query(
          `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
           VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
          [clientAccountId, userId],
        );
        await client.query(
          `INSERT INTO verification_policy_snapshots(user_id, policy)
           VALUES ($1, '{"all":[{"requirement":"email"}]}'::jsonb)`,
          [userId],
        );
        const tokenResult = await client.query<{ id: string }>(
          `INSERT INTO email_verification_tokens(user_id, token_digest, expires_at)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [userId, digestToken(verificationToken), expiresAt],
        );
        const verificationTokenId = tokenResult.rows[0]?.id;
        if (!verificationTokenId) throw new Error("Unable to create verification token");
        await enqueueNotification(client, {
          eventType: "notification.email_verification_requested",
          templateRevision: "email-verification-v1",
          uniqueKey: `registration:${userId}`,
          payload: {
            verificationTokenId,
            verificationUrl: `${config.OSS_PUBLIC_URL}/verify?token=${verificationToken}`,
            expiresAt: expiresAt.toISOString(),
          },
          recipient: {
            kind: "identity_user",
            category: "identity",
            userId,
            email: body.email,
            locale: body.locale,
          },
        });
        return { userId, clientAccountId };
      });
      return reply.code(201).send({
        ...user,
        verification: {
          status: "pending",
          expiresAt: expiresAt.toISOString(),
        },
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        return reply.code(202).send({
          verification: { status: "pending" },
          message: "If the account can be registered, verification instructions will be delivered.",
        });
      }
      throw error;
    }
  });

  app.post("/api/v1/auth/invitation-registrations", async (request, reply) => {
    const body = invitationRegistrationSchema.parse(request.body);
    const tokenDigest = digestToken(body.token);
    const pointer = await pool.query<{ id: string }>(
      `SELECT id
       FROM client_membership_invitations
       WHERE token_digest = $1`,
      [tokenDigest],
    );
    if (!pointer.rows[0]) {
      return reply.code(400).send({
        error: "Membership invitation is invalid",
        code: "MEMBERSHIP_INVITATION_INVALID",
      });
    }
    const encodedPassword = await passwordHash(body.password);
    const verificationToken = createOpaqueToken();
    const verificationExpiresAt = new Date(
      Date.now() + config.VERIFICATION_TTL_MINUTES * 60_000,
    );
    try {
      const result = await transaction(pool, async (client) => {
        const invitationResult = await client.query<{
          email_matches: boolean;
          expired: boolean;
          accepted_at: Date | null;
          revoked_at: Date | null;
        }>(
          `SELECT email = $3 AS email_matches,
                  expires_at <= pg_catalog.now() AS expired,
                  accepted_at,
                  revoked_at
           FROM client_membership_invitations
           WHERE id = $1 AND token_digest = $2
           FOR UPDATE`,
          [pointer.rows[0]!.id, tokenDigest, body.email],
        );
        const invitation = invitationResult.rows[0];
        if (!invitation) return { status: "invalid" as const };
        if (invitation.expired) return { status: "expired" as const };
        if (invitation.accepted_at || invitation.revoked_at) {
          return { status: "not_pending" as const };
        }
        if (!invitation.email_matches) return { status: "wrong_email" as const };
        const existing = await client.query("SELECT 1 FROM users WHERE email = $1", [
          body.email,
        ]);
        if (existing.rowCount !== 0) return { status: "identity_exists" as const };
        const userResult = await client.query<{ id: string }>(
          `INSERT INTO users(email, password_hash, locale)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [body.email, encodedPassword, body.locale],
        );
        const userId = userResult.rows[0]?.id;
        if (!userId) throw new Error("Unable to create invited identity");
        await client.query(
          `INSERT INTO verification_policy_snapshots(user_id, policy)
           VALUES ($1, '{"all":[{"requirement":"email"}]}'::jsonb)`,
          [userId],
        );
        const tokenResult = await client.query<{ id: string }>(
          `INSERT INTO email_verification_tokens(user_id, token_digest, expires_at)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [userId, digestToken(verificationToken), verificationExpiresAt],
        );
        const verificationTokenId = tokenResult.rows[0]?.id;
        if (!verificationTokenId) throw new Error("Unable to create verification token");
        await enqueueNotification(client, {
          eventType: "notification.email_verification_requested",
          templateRevision: "email-verification-v1",
          uniqueKey: `invitation-registration:${userId}`,
          payload: {
            verificationTokenId,
            verificationUrl: `${config.OSS_PUBLIC_URL}/verify?token=${verificationToken}`,
            expiresAt: verificationExpiresAt.toISOString(),
          },
          recipient: {
            kind: "identity_user",
            category: "identity",
            userId,
            email: body.email,
            locale: body.locale,
          },
        });
        return { status: "created" as const, userId };
      });
      if (result.status === "invalid") {
        return reply.code(400).send({
          error: "Membership invitation is invalid",
          code: "MEMBERSHIP_INVITATION_INVALID",
        });
      }
      if (result.status === "expired") {
        return reply.code(410).send({
          error: "Membership invitation expired",
          code: "MEMBERSHIP_INVITATION_EXPIRED",
        });
      }
      if (result.status === "not_pending") {
        return reply.code(409).send({
          error: "Membership invitation is not pending",
          code: "MEMBERSHIP_INVITATION_NOT_PENDING",
        });
      }
      if (result.status === "wrong_email") {
        return reply.code(403).send({
          error: "Membership invitation belongs to another email",
          code: "MEMBERSHIP_INVITATION_EMAIL_MISMATCH",
        });
      }
      if (result.status === "identity_exists") {
        return reply.code(409).send({
          error: "An identity already exists for this email",
          code: "IDENTITY_ALREADY_EXISTS",
        });
      }
      return reply.code(201).send({
        userId: result.userId,
        registrationMode: "membership_invitation",
        verification: {
          status: "pending",
          expiresAt: verificationExpiresAt.toISOString(),
        },
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        return reply.code(409).send({
          error: "An identity already exists for this email",
          code: "IDENTITY_ALREADY_EXISTS",
        });
      }
      throw error;
    }
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await pool.query<{ id: string; password_hash: string }>(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [body.email],
    );
    const user = result.rows[0];
    const valid = user ? await passwordVerify(user.password_hash, body.password) : false;
    if (!user || !valid) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    const sessionToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 60 * 60_000);
    const createdSession = await transaction(pool, async (client) => {
      // Membership authorization changes take this same User lock before
      // scanning Sessions, so the membership snapshot and Session insert are
      // one serialized decision.
      const lockedPrincipal = await client.query<{
        password_hash: string;
        email_verified_at: Date | null;
        user_restricted_at: Date | null;
      }>(
        `SELECT password_hash, email_verified_at,
                restricted_at AS user_restricted_at
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [user.id],
      );
      const principal = lockedPrincipal.rows[0];
      if (!principal || principal.password_hash !== user.password_hash) {
        throw Object.assign(new Error("Invalid email or password"), { statusCode: 401 });
      }
      const sessionResult = await client.query<{
        active_client_account_id: string | null;
        account_context_version: string;
      }>(
        `WITH active_memberships AS (
         SELECT
           pg_catalog.count(*) AS membership_count,
           pg_catalog.count(*) FILTER (WHERE restricted_at IS NULL)
             AS unrestricted_membership_count,
           (pg_catalog.min(client_account_id::text)
             FILTER (WHERE restricted_at IS NULL))::uuid AS only_client_account_id
         FROM client_memberships
         WHERE user_id = $1
           AND removed_at IS NULL
       )
       INSERT INTO sessions(
         user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       )
       SELECT
         $1, $2, $3,
         CASE
           WHEN membership_count = 1 AND unrestricted_membership_count = 1
             THEN only_client_account_id
           ELSE NULL
         END,
         CASE
           WHEN membership_count = 1 AND unrestricted_membership_count = 1
             THEN 1
           ELSE 0
         END
       FROM active_memberships
       RETURNING active_client_account_id, account_context_version::text`,
        [user.id, digestToken(sessionToken), expiresAt],
      );
      const context = sessionResult.rows[0];
      if (!context) throw new Error("Unable to create session");
      return {
        context,
        identityEligible:
          Boolean(principal.email_verified_at) && !principal.user_restricted_at,
      };
    });
    reply.setCookie(config.SESSION_COOKIE_NAME, sessionToken, sessionCookieOptions(config));
    const context = createdSession.context;
    setAccountContextHeaders(reply, {
      clientAccountId: createdSession.identityEligible
        ? context.active_client_account_id
        : null,
      accountContextVersion: context.account_context_version,
    });
    if (!context.active_client_account_id) {
      return reply.code(409).send({
        error: "Select an active Client Account before continuing",
        code: "ACCOUNT_CONTEXT_REQUIRED",
        expiresAt: expiresAt.toISOString(),
        context: null,
        requiresAccountContext: true,
      });
    }
    return {
      expiresAt: expiresAt.toISOString(),
      context: createdSession.identityEligible
        ? {
            clientAccountId: context.active_client_account_id,
            version: context.account_context_version,
          }
        : null,
      requiresAccountContext: false,
    };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    if (token) {
      const pointer = await pool.query<{ session_id: string; user_id: string }>(
        `SELECT id AS session_id, user_id
         FROM sessions
         WHERE token_digest = $1
         LIMIT 1`,
        [digestToken(token)],
      );
      const identity = pointer.rows[0];
      if (identity) {
        await transaction(pool, async (client) => {
          await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
            identity.user_id,
          ]);
          const lockedSession = await client.query<{ id: string }>(
            `SELECT id
             FROM sessions
             WHERE id = $1 AND user_id = $2
             FOR UPDATE`,
            [identity.session_id, identity.user_id],
          );
          if (!lockedSession.rows[0]) return;
          await client.query(
            `UPDATE reauth_grants
             SET invalidated_at = pg_catalog.now()
             WHERE session_id = $1 AND invalidated_at IS NULL`,
            [identity.session_id],
          );
          await client.query(
            `UPDATE sessions
             SET revoked_at = pg_catalog.now()
             WHERE id = $1 AND revoked_at IS NULL`,
            [identity.session_id],
          );
        });
      }
    }
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    const identityEligible =
      Boolean(identity.emailVerifiedAt) && !identity.userRestrictedAt;
    const active = identityEligible
      ? await loadActiveAccountContext(pool, identity)
      : null;
    const staff = identityEligible
      ? (
          await pool.query<{ roles: string[]; permissions: unknown }>(
            `SELECT roles, permissions
             FROM staff_members
             WHERE user_id = $1 AND active`,
            [identity.userId],
          )
        ).rows[0]
      : undefined;
    if (!identityEligible) {
      setAccountContextForRequest(request, {
        clientAccountId: null,
        accountContextVersion: identity.accountContextVersion,
      });
    }
    setAccountContextHeaders(reply, {
      clientAccountId: active?.clientAccountId ?? null,
      accountContextVersion: identity.accountContextVersion,
    });
    return {
      id: identity.userId,
      email: identity.email,
      locale: identity.locale,
      clientAccountId: active?.clientAccountId ?? null,
      membershipRole: active?.role ?? null,
      accountContextVersion: identity.accountContextVersion,
      context: active
        ? {
            clientAccountId: active.clientAccountId,
            name: active.name,
            role: active.role,
            permissions: active.permissions,
            capabilities: active.capabilities,
            version: identity.accountContextVersion,
          }
        : null,
      restrictions: {
        user: Boolean(identity.userRestrictedAt),
        clientAccount: active?.restrictions.clientAccount ?? false,
      },
      verification: {
        email: identity.emailVerifiedAt ? "passed" : "pending",
      },
      eligible:
        identityEligible &&
        Boolean(active) &&
        !active?.restrictions.membership &&
        !active?.restrictions.clientAccount,
      staff: staff ? { roles: staff.roles, permissions: staff.permissions } : null,
    };
  });

  app.get("/api/v1/auth/account-contexts", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    assertIdentityReadEligible(identity);
    const query = parsePageQuery(request.query);
    const scope = "auth.account-contexts";
    const cursor = decodeKeysetCursor(query.cursor, scope, identity.userId);
    const values = await listAccountContexts(pool, identity, query.limit, cursor);
    const page = collectionPage(
      values,
      query.limit,
      scope,
      identity.userId,
      (item) => ({ at: item.createdAt, id: item.clientAccountId }),
    );
    setAccountContextHeaders(reply, {
      clientAccountId: identity.activeClientAccountId,
      accountContextVersion: identity.accountContextVersion,
    });
    return {
      activeClientAccountId: identity.activeClientAccountId,
      accountContextVersion: identity.accountContextVersion,
      ...page,
    };
  });

  app.put("/api/v1/auth/account-context", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    const expectedVersion = expectedAccountContextVersion(request);
    const body = accountContextSchema.parse(request.body);
    const switched = await transaction(pool, async (client) => {
      const session = await lockSessionIdentityForMutation(client, identity);
      assertIdentityReadEligible(session);
      if (session.accountContextVersion !== expectedVersion) {
        throw Object.assign(new Error("The Client Account context changed; reload and retry"), {
          statusCode: 409,
          code: "ACCOUNT_CONTEXT_STALE",
          currentClientAccountId: session.activeClientAccountId,
          currentAccountContextVersion: session.accountContextVersion,
        });
      }
      const accountResult = await client.query<{
        account_name: string;
        account_restricted_at: Date | null;
      }>(
        `SELECT name AS account_name,
                restricted_at AS account_restricted_at
         FROM client_accounts
         WHERE id = $1
         FOR UPDATE`,
        [body.clientAccountId],
      );
      const membershipResult = await client.query<{
        role: MembershipRole;
        permissions: unknown;
      }>(
        `SELECT role, permissions
         FROM client_memberships
         WHERE client_account_id = $1
           AND user_id = $2
           AND removed_at IS NULL
           AND restricted_at IS NULL
         FOR UPDATE`,
        [body.clientAccountId, identity.userId],
      );
      const account = accountResult.rows[0];
      const membership = membershipResult.rows[0];
      if (!account || !membership) {
        throw Object.assign(new Error("Client Account membership was not found"), {
          statusCode: 404,
        });
      }
      await client.query(
        `UPDATE reauth_grants
         SET invalidated_at = pg_catalog.now()
         WHERE session_id = $1 AND invalidated_at IS NULL`,
        [identity.sessionId],
      );
      const updated = await client.query<{ account_context_version: string }>(
        `UPDATE sessions
         SET active_client_account_id = $2,
             account_context_version = account_context_version + 1
         WHERE id = $1
         RETURNING account_context_version::text`,
        [identity.sessionId, body.clientAccountId],
      );
      const version = updated.rows[0]?.account_context_version;
      if (!version) throw new Error("Unable to switch Client Account context");
      return {
        clientAccountId: body.clientAccountId,
        name: account.account_name,
        role: membership.role,
        permissions:
          Array.isArray(membership.permissions) &&
          membership.permissions.every((permission) => typeof permission === "string")
            ? membership.permissions
            : [],
        restrictions: { clientAccount: Boolean(account.account_restricted_at) },
        version,
      };
    });
    setAccountContextHeaders(reply, {
      clientAccountId: switched.clientAccountId,
      accountContextVersion: switched.version,
    });
    return { context: switched };
  });

  app.post("/api/v1/auth/reauth", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    const body = reauthSchema.parse(request.body);
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const granted = await transaction(pool, async (client) => {
      const session = await lockSessionIdentityForMutation(client, identity);
      const principal = await client.query<{
        password_hash: string;
      }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [identity.userId],
      );
      const current = principal.rows[0];
      if (
        !current ||
        !session.emailVerifiedAt ||
        session.userRestrictedAt
      ) return "ineligible" as const;
      if (!(await passwordVerify(current.password_hash, body.password))) {
        return "invalid_password" as const;
      }
      await client.query(
        `UPDATE reauth_grants
         SET invalidated_at = now()
         WHERE user_id = $1 AND session_id = $2 AND invalidated_at IS NULL`,
        [identity.userId, identity.sessionId],
      );
      await client.query(
        `INSERT INTO reauth_grants(user_id, session_id, expires_at)
         VALUES ($1, $2, $3)`,
        [identity.userId, identity.sessionId, expiresAt],
      );
      return "granted" as const;
    });
    if (granted === "invalid_password") {
      return reply.code(401).send({ error: "Password confirmation failed" });
    }
    if (granted === "ineligible") {
      return reply.code(403).send({ error: "Account is not eligible for password confirmation" });
    }
    setAccountContextHeaders(reply, {
      clientAccountId: identity.activeClientAccountId,
      accountContextVersion: identity.accountContextVersion,
    });
    return { expiresAt: expiresAt.toISOString(), fixedWindowMinutes: 15 };
  });

  app.post("/api/v1/admin/bootstrap", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    if (!identity.emailVerifiedAt || identity.userRestrictedAt) {
      return reply.code(403).send({ error: "A verified, unrestricted User is required" });
    }
    const body = bootstrapSchema.parse(request.body);
    const result = await transaction(pool, async (client) => {
      const session = await lockSessionIdentityForMutation(client, identity);
      if (!session.emailVerifiedAt || session.userRestrictedAt) return false;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        "opensales:staff-bootstrap",
      ]);
      const existingStaff = await client.query("SELECT 1 FROM staff_members LIMIT 1");
      if (existingStaff.rowCount !== 0) return false;
      const tokenResult = await client.query<{
        id: string;
        used_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT id, used_at, expires_at
         FROM staff_bootstrap_tokens
         WHERE token_digest = $1
         FOR UPDATE`,
        [digestToken(body.bootstrapToken)],
      );
      const token = tokenResult.rows[0];
      if (!token || token.used_at || token.expires_at.getTime() <= Date.now()) {
        return false;
      }
      await client.query(
        "UPDATE staff_bootstrap_tokens SET used_at = now() WHERE used_at IS NULL",
      );
      await client.query(
        `INSERT INTO staff_members(user_id, roles, permissions)
         VALUES ($1, ARRAY['administrator'], '["*"]'::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET
           roles = EXCLUDED.roles,
           permissions = EXCLUDED.permissions,
           active = true,
           updated_at = now()`,
        [identity.userId],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason
         ) VALUES ('user', $1, 'staff.bootstrap_completed', 'staff', $1, $2)`,
        [identity.userId, "single-use short-lived bootstrap token"],
      );
      return true;
    });
    if (!result) return reply.code(410).send({ error: "Bootstrap token is invalid or expired" });
    return reply.code(201).send({ roles: ["administrator"] });
  });

  app.post("/api/v1/auth/verify-email", async (request, reply) => {
    const body = verificationSchema.parse(request.body);
    const result = await transaction(pool, async (client) => {
      const tokenDigest = digestToken(body.token);
      const pointerResult = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id
         FROM email_verification_tokens
         WHERE token_digest = $1
           AND invalidated_at IS NULL`,
        [tokenDigest],
      );
      const pointer = pointerResult.rows[0];
      if (!pointer) return { status: "invalid" as const };
      const principalResult = await client.query<{ email_verified_at: Date | null }>(
        `SELECT email_verified_at
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [pointer.user_id],
      );
      // Identity eligibility changes bump every surviving Session context
      // version.  Finish the universal User -> Sessions prefix before locking
      // the verification token so a concurrent Session mutation fails closed
      // instead of introducing a Token <-> Session lock inversion.
      await client.query(
        `SELECT id
         FROM sessions
         WHERE user_id = $1
           AND revoked_at IS NULL
         ORDER BY id
         FOR UPDATE NOWAIT`,
        [pointer.user_id],
      );
      const tokenResult = await client.query<{
        id: string;
        user_id: string;
        used_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT id, user_id, used_at, expires_at
         FROM email_verification_tokens
         WHERE id = $1
           AND user_id = $2
           AND token_digest = $3
           AND invalidated_at IS NULL
         FOR UPDATE`,
        [pointer.id, pointer.user_id, tokenDigest],
      );
      const token = tokenResult.rows[0];
      if (!token) return { status: "invalid" as const };
      if (principalResult.rows[0]?.email_verified_at || token.used_at) {
        return { status: "already_verified" as const };
      }
      if (token.expires_at.getTime() <= Date.now()) return { status: "expired" as const };
      await client.query("UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1", [
        token.user_id,
      ]);
      await client.query("UPDATE email_verification_tokens SET used_at = now() WHERE id = $1", [
        token.id,
      ]);
      await client.query(
        `INSERT INTO audit_events(actor_type, actor_id, action, target_type, target_id)
         VALUES ('user', $1, 'email.verified', 'user', $1)`,
        [token.user_id],
      );
      return { status: "verified" as const };
    });
    if (result.status === "invalid") return reply.code(400).send(result);
    if (result.status === "expired") return reply.code(410).send(result);
    return result;
  });

  app.post("/api/v1/auth/resend-verification", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    if (identity.emailVerifiedAt) {
      return reply.code(200).send({ status: "already_verified" });
    }
    const verificationToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + config.VERIFICATION_TTL_MINUTES * 60_000);
    const outcome = await transaction(pool, async (client) => {
      const session = await lockSessionIdentityForMutation(client, identity);
      const current = await client.query<{
        email: string;
        locale: string;
        email_verified_at: Date | null;
        restricted_at: Date | null;
        last_created_at: Date | null;
      }>(
        `SELECT
           u.email,
           u.locale,
           u.email_verified_at,
           u.restricted_at,
           latest.last_created_at
         FROM users u
         LEFT JOIN LATERAL (
           SELECT max(created_at) AS last_created_at
           FROM email_verification_tokens
           WHERE user_id = u.id
         ) latest ON true
         WHERE u.id = $1
        `,
        [identity.userId],
      );
      const principal = current.rows[0];
      if (!principal || !session || principal.restricted_at) {
        return { status: "ineligible" as const };
      }
      if (principal.email_verified_at) return { status: "already_verified" as const };
      if (
        principal.last_created_at &&
        principal.last_created_at.getTime() > Date.now() - 60_000
      ) {
        return { status: "rate_limited" as const };
      }
      await client.query(
        `UPDATE email_verification_tokens
         SET invalidated_at = now()
         WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [identity.userId],
      );
      const tokenResult = await client.query<{ id: string }>(
        `INSERT INTO email_verification_tokens(user_id, token_digest, expires_at)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [identity.userId, digestToken(verificationToken), expiresAt],
      );
      const tokenId = tokenResult.rows[0]?.id;
      if (!tokenId) throw new Error("Unable to create verification token");
      await enqueueNotification(client, {
        eventType: "notification.email_verification_requested",
        templateRevision: "email-verification-v1",
        uniqueKey: `verification:${tokenId}`,
        payload: {
          verificationTokenId: tokenId,
          verificationUrl: `${config.OSS_PUBLIC_URL}/verify?token=${verificationToken}`,
          expiresAt: expiresAt.toISOString(),
        },
        recipient: {
          kind: "identity_user",
          category: "identity",
          userId: identity.userId,
          email: principal.email,
          locale: principal.locale === "zh-CN" ? "zh-CN" : "en",
        },
      });
      return { status: "resent" as const };
    });
    if (outcome.status === "rate_limited") {
      return reply.code(429).send({ error: "Please wait before requesting another email" });
    }
    if (outcome.status === "ineligible") {
      return reply.code(403).send({ error: "Account is restricted" });
    }
    return reply.code(200).send({
      status: outcome.status,
      ...(outcome.status === "resent" ? { expiresAt: expiresAt.toISOString() } : {}),
    });
  });

  app.get("/api/v1/lab/mailbox", async (request, reply) => {
    if (!config.LAB_MAILBOX_ENABLED) {
      return reply.code(404).send({ error: "Laboratory mailbox access is disabled" });
    }
    const identity = await requireSessionIdentity(request, pool, config);
    if (identity.userRestrictedAt) {
      throw Object.assign(new Error("This User is restricted"), {
        statusCode: 403,
        code: "ACCOUNT_RESTRICTED",
      });
    }
    const response = await fetch(new URL("/v1/mailbox/query", config.MOCK_MAILBOX_URL), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.LAB_MAILBOX_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient: identity.email }),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (!response.ok) {
      throw Object.assign(new Error("Mock Mail Provider is unavailable"), { statusCode: 503 });
    }
    const providerMessages = z.array(labMailboxMessageSchema).parse(await response.json());
    const messages = identity.emailVerifiedAt
      ? providerMessages
      : providerMessages.filter((message) => message.template === "email-verification");
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      messages,
    };
  });
}
