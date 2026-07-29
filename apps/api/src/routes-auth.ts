// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createOpaqueToken,
  digestToken,
  passwordHash,
  passwordVerify,
  requireUser,
} from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabasePool } from "./database.js";

const registrationSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(12).max(256),
  clientName: z.string().trim().min(2).max(160),
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
        await client.query(
          `INSERT INTO email_verification_tokens(user_id, token_digest, expires_at)
           VALUES ($1, $2, $3)`,
          [userId, digestToken(verificationToken), expiresAt],
        );
        const outboxResult = await client.query<{ id: string }>(
          `INSERT INTO outbox(event_type, unique_key, payload)
           VALUES ('notification.email_verification_requested', $1, $2)
           RETURNING id`,
          [
            `registration:${userId}`,
            {
              userId,
              email: body.email,
              locale: body.locale,
              verificationUrl: `${config.OSS_PUBLIC_URL}/verify?token=${verificationToken}`,
              expiresAt: expiresAt.toISOString(),
            },
          ],
        );
        const outboxId = outboxResult.rows[0]?.id;
        if (!outboxId) throw new Error("Unable to create verification notification");
        await client.query(
          `INSERT INTO durable_jobs(job_type, unique_key, payload)
           VALUES ('notification.send', $1, $2)`,
          [`outbox:${outboxId}`, { outboxId }],
        );
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
    await pool.query(
      `INSERT INTO sessions(user_id, token_digest, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, digestToken(sessionToken), expiresAt],
    );
    reply.setCookie(config.SESSION_COOKIE_NAME, sessionToken, sessionCookieOptions(config));
    return { expiresAt: expiresAt.toISOString() };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    if (token) {
      await pool.query(
        `UPDATE reauth_grants rg
         SET invalidated_at = now()
         FROM sessions s
         WHERE s.token_digest = $1
           AND rg.session_id = s.id
           AND rg.invalidated_at IS NULL`,
        [digestToken(token)],
      );
      await pool.query("UPDATE sessions SET revoked_at = now() WHERE token_digest = $1", [
        digestToken(token),
      ]);
    }
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/me", async (request) => {
    const user = await requireUser(request, pool, config);
    const staffResult = await pool.query<{ roles: string[]; permissions: unknown }>(
      `SELECT roles, permissions
       FROM staff_members
       WHERE user_id = $1 AND active`,
      [user.userId],
    );
    const staff = staffResult.rows[0];
    return {
      id: user.userId,
      email: user.email,
      locale: user.locale,
      clientAccountId: user.clientAccountId,
      membershipRole: user.membershipRole,
      verification: {
        email: user.emailVerifiedAt ? "passed" : "pending",
      },
      eligible:
        Boolean(user.emailVerifiedAt) &&
        !user.userRestrictedAt &&
        !user.clientAccountRestrictedAt,
      staff: staff ? { roles: staff.roles, permissions: staff.permissions } : null,
    };
  });

  app.post("/api/v1/auth/reauth", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const body = reauthSchema.parse(request.body);
    const result = await pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id = $1",
      [user.userId],
    );
    const encoded = result.rows[0]?.password_hash;
    if (!encoded || !(await passwordVerify(encoded, body.password))) {
      return reply.code(401).send({ error: "Password confirmation failed" });
    }
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    await transaction(pool, async (client) => {
      await client.query(
        `UPDATE reauth_grants
         SET invalidated_at = now()
         WHERE user_id = $1 AND session_id = $2 AND invalidated_at IS NULL`,
        [user.userId, user.sessionId],
      );
      await client.query(
        `INSERT INTO reauth_grants(user_id, session_id, expires_at)
         VALUES ($1, $2, $3)`,
        [user.userId, user.sessionId, expiresAt],
      );
    });
    return { expiresAt: expiresAt.toISOString(), fixedWindowMinutes: 15 };
  });

  app.post("/api/v1/admin/bootstrap", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    if (!user.emailVerifiedAt || user.userRestrictedAt || user.clientAccountRestrictedAt) {
      return reply.code(403).send({ error: "A verified, unrestricted account is required" });
    }
    const body = bootstrapSchema.parse(request.body);
    const result = await transaction(pool, async (client) => {
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
      await client.query("UPDATE staff_bootstrap_tokens SET used_at = now() WHERE id = $1", [
        token.id,
      ]);
      await client.query(
        `INSERT INTO staff_members(user_id, roles, permissions)
         VALUES ($1, ARRAY['administrator'], '["*"]'::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET
           roles = EXCLUDED.roles,
           permissions = EXCLUDED.permissions,
           active = true,
           updated_at = now()`,
        [user.userId],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason
         ) VALUES ('user', $1, 'staff.bootstrap_completed', 'staff', $1, $2)`,
        [user.userId, "single-use short-lived bootstrap token"],
      );
      return true;
    });
    if (!result) return reply.code(410).send({ error: "Bootstrap token is invalid or expired" });
    return reply.code(201).send({ roles: ["administrator"] });
  });

  app.post("/api/v1/auth/verify-email", async (request, reply) => {
    const body = verificationSchema.parse(request.body);
    const result = await transaction(pool, async (client) => {
      const tokenResult = await client.query<{
        id: string;
        user_id: string;
        used_at: Date | null;
        expires_at: Date;
        email_verified_at: Date | null;
      }>(
        `SELECT evt.id, evt.user_id, evt.used_at, evt.expires_at, u.email_verified_at
         FROM email_verification_tokens evt
         JOIN users u ON u.id = evt.user_id
         WHERE evt.token_digest = $1
         FOR UPDATE OF evt, u`,
        [digestToken(body.token)],
      );
      const token = tokenResult.rows[0];
      if (!token) return { status: "invalid" as const };
      if (token.email_verified_at || token.used_at) return { status: "already_verified" as const };
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

  app.get("/api/v1/lab/mailbox", async (request, reply) => {
    if (!config.LAB_MAILBOX_ENABLED) {
      return reply.code(404).send({ error: "Laboratory mailbox access is disabled" });
    }
    const user = await requireUser(request, pool, config);
    const response = await fetch(
      new URL(`/v1/mail?recipient=${encodeURIComponent(user.email)}`, config.MOCK_PROVIDER_URL),
      {
        headers: { Authorization: `Bearer ${config.MOCK_PROVIDER_TOKEN}` },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      },
    );
    if (!response.ok) {
      throw Object.assign(new Error("Mock Mail Provider is unavailable"), { statusCode: 503 });
    }
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      messages: await response.json(),
    };
  });
}
