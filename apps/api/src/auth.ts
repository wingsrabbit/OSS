// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { DatabasePool } from "./database.js";

export type AuthenticatedUser = {
  sessionId: string;
  userId: string;
  email: string;
  locale: "en" | "zh-CN";
  emailVerifiedAt: Date | null;
  userRestrictedAt: Date | null;
  clientAccountId: string;
  clientAccountRestrictedAt: Date | null;
  membershipRole: "owner" | "billing" | "technical" | "viewer";
};

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function passwordHash(password: string): Promise<string> {
  return hash(password, {
    algorithm: 2,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32,
  });
}

export function passwordVerify(encoded: string, password: string): Promise<boolean> {
  return verify(encoded, password);
}

export async function requireUser(
  request: FastifyRequest,
  pool: DatabasePool,
  config: Config,
): Promise<AuthenticatedUser> {
  const token = request.cookies[config.SESSION_COOKIE_NAME];
  if (!token) {
    throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  }
  const result = await pool.query<{
    session_id: string;
    user_id: string;
    email: string;
    locale: "en" | "zh-CN";
    email_verified_at: Date | null;
    user_restricted_at: Date | null;
    client_account_id: string;
    client_account_restricted_at: Date | null;
    membership_role: AuthenticatedUser["membershipRole"];
  }>(
    `SELECT
       s.id AS session_id,
       u.id AS user_id,
       u.email,
       u.locale,
       u.email_verified_at,
       u.restricted_at AS user_restricted_at,
       ca.id AS client_account_id,
       ca.restricted_at AS client_account_restricted_at,
       cm.role AS membership_role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN client_memberships cm ON cm.user_id = u.id AND cm.removed_at IS NULL
     JOIN client_accounts ca ON ca.id = cm.client_account_id
     WHERE s.token_digest = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
     ORDER BY (cm.role = 'owner') DESC, cm.created_at
     LIMIT 1`,
    [digestToken(token)],
  );
  const row = result.rows[0];
  if (!row) {
    throw Object.assign(new Error("Session is invalid or expired"), { statusCode: 401 });
  }
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    locale: row.locale,
    emailVerifiedAt: row.email_verified_at,
    userRestrictedAt: row.user_restricted_at,
    clientAccountId: row.client_account_id,
    clientAccountRestrictedAt: row.client_account_restricted_at,
    membershipRole: row.membership_role,
  };
}

export function assertEligible(user: AuthenticatedUser): void {
  if (!user.emailVerifiedAt) {
    throw Object.assign(new Error("Email verification is required"), {
      statusCode: 403,
      code: "EMAIL_VERIFICATION_REQUIRED",
    });
  }
  if (user.userRestrictedAt || user.clientAccountRestrictedAt) {
    throw Object.assign(new Error("Account is restricted"), {
      statusCode: 403,
      code: "ACCOUNT_RESTRICTED",
    });
  }
}

export function assertBillingWriteEligible(user: AuthenticatedUser): void {
  assertEligible(user);
  if (user.membershipRole !== "owner" && user.membershipRole !== "billing") {
    throw Object.assign(new Error("Owner or Billing permission is required"), {
      statusCode: 403,
      code: "BILLING_PERMISSION_REQUIRED",
    });
  }
}

export function assertFinancialReadEligible(user: AuthenticatedUser): void {
  if (!user.emailVerifiedAt) {
    throw Object.assign(new Error("Email verification is required"), {
      statusCode: 403,
      code: "EMAIL_VERIFICATION_REQUIRED",
    });
  }
  if (user.userRestrictedAt) {
    throw Object.assign(new Error("User is restricted"), {
      statusCode: 403,
      code: "ACCOUNT_RESTRICTED",
    });
  }
}
