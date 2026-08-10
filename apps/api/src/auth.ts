// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import {
  customerMembershipCapabilities,
  type CustomerCapability,
} from "@opensales/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { DatabaseClient, DatabasePool } from "./database.js";

export const CLIENT_ACCOUNT_CONTEXT_HEADER = "X-OSS-Client-Account-Id" as const;
export const ACCOUNT_CONTEXT_VERSION_HEADER =
  "X-OSS-Account-Context-Version" as const;

export type MembershipRole = "owner" | "billing" | "technical" | "viewer";
export type { CustomerCapability };

export type SessionIdentity = {
  sessionId: string;
  userId: string;
  email: string;
  locale: "en" | "zh-CN";
  emailVerifiedAt: Date | null;
  userRestrictedAt: Date | null;
  activeClientAccountId: string | null;
  accountContextVersion: string;
};

export type AuthenticatedUser = {
  sessionId: string;
  userId: string;
  email: string;
  locale: "en" | "zh-CN";
  emailVerifiedAt: Date | null;
  userRestrictedAt: Date | null;
  clientAccountId: string;
  clientAccountRestrictedAt: Date | null;
  membershipRole: MembershipRole;
  membershipPermissions: readonly string[];
  membershipRestrictedAt: Date | null;
  accountContextVersion: string;
};

type SessionPrincipalRow = {
  session_id: string;
  user_id: string;
  email: string;
  locale: "en" | "zh-CN";
  email_verified_at: Date | null;
  user_restricted_at: Date | null;
  active_client_account_id: string | null;
  account_context_version: string;
  client_account_restricted_at: Date | null;
  membership_role: MembershipRole | null;
  membership_permissions: unknown;
  membership_restricted_at: Date | null;
};

const requestAccountContexts = new WeakMap<
  FastifyRequest,
  Readonly<{ clientAccountId: string | null; accountContextVersion: string }>
>();

export function accountContextForRequest(
  request: FastifyRequest,
): Readonly<{
  clientAccountId: string | null;
  accountContextVersion: string;
}> | null {
  return requestAccountContexts.get(request) ?? null;
}

export function setAccountContextForRequest(
  request: FastifyRequest,
  context: Readonly<{
    clientAccountId: string | null;
    accountContextVersion: string;
  }>,
): void {
  requestAccountContexts.set(request, context);
}

function accountContextStaleError(
  context: Readonly<{
    activeClientAccountId: string | null;
    accountContextVersion: string;
  }>,
): Error & {
  statusCode: number;
  code: string;
  currentClientAccountId: string | null;
  currentAccountContextVersion: string;
} {
  return Object.assign(
    new Error("The Client Account context changed; reload and retry"),
    {
      statusCode: 409,
      code: "ACCOUNT_CONTEXT_STALE",
      currentClientAccountId: context.activeClientAccountId,
      currentAccountContextVersion: context.accountContextVersion,
    },
  );
}

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

function permissionArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((permission) => typeof permission === "string")) {
    return [];
  }
  return value;
}

async function requireSessionPrincipal(
  request: FastifyRequest,
  pool: DatabasePool,
  config: Config,
): Promise<SessionPrincipalRow> {
  const token = request.cookies[config.SESSION_COOKIE_NAME];
  if (!token) {
    throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  }
  const result = await pool.query<SessionPrincipalRow>(
    `SELECT
       s.id AS session_id,
       u.id AS user_id,
       u.email,
       u.locale,
       u.email_verified_at,
       u.restricted_at AS user_restricted_at,
       s.active_client_account_id,
       s.account_context_version::text,
       ca.restricted_at AS client_account_restricted_at,
       cm.role AS membership_role,
       cm.permissions AS membership_permissions,
       cm.restricted_at AS membership_restricted_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN client_memberships cm
       ON cm.user_id = u.id
      AND cm.client_account_id = s.active_client_account_id
      AND cm.removed_at IS NULL
      AND cm.restricted_at IS NULL
     LEFT JOIN client_accounts ca ON ca.id = s.active_client_account_id
     WHERE s.token_digest = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()`,
    [digestToken(token)],
  );
  const row = result.rows[0];
  if (!row) {
    throw Object.assign(new Error("Session is invalid or expired"), { statusCode: 401 });
  }
  requestAccountContexts.set(request, {
    clientAccountId:
      row.email_verified_at && !row.user_restricted_at
        ? row.active_client_account_id
        : null,
    accountContextVersion: row.account_context_version,
  });
  return row;
}

export async function requireSessionIdentity(
  request: FastifyRequest,
  pool: DatabasePool,
  config: Config,
): Promise<SessionIdentity> {
  const row = await requireSessionPrincipal(request, pool, config);
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    locale: row.locale,
    emailVerifiedAt: row.email_verified_at,
    userRestrictedAt: row.user_restricted_at,
    activeClientAccountId: row.active_client_account_id,
    accountContextVersion: row.account_context_version,
  };
}

export async function requireUser(
  request: FastifyRequest,
  pool: DatabasePool,
  config: Config,
): Promise<AuthenticatedUser> {
  const row = await requireSessionPrincipal(request, pool, config);
  if (!row.active_client_account_id) {
    throw Object.assign(new Error("Select an active Client Account before continuing"), {
      statusCode: 409,
      code: "ACCOUNT_CONTEXT_REQUIRED",
    });
  }
  if (!row.membership_role || row.membership_restricted_at) {
    throw Object.assign(new Error("The active Client Account context is no longer valid"), {
      statusCode: 409,
      code: "ACCOUNT_CONTEXT_INVALID",
    });
  }
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    locale: row.locale,
    emailVerifiedAt: row.email_verified_at,
    userRestrictedAt: row.user_restricted_at,
    clientAccountId: row.active_client_account_id,
    clientAccountRestrictedAt: row.client_account_restricted_at,
    membershipRole: row.membership_role,
    membershipPermissions: permissionArray(row.membership_permissions),
    membershipRestrictedAt: row.membership_restricted_at,
    accountContextVersion: row.account_context_version,
  };
}

export function expectedAccountContextVersion(request: FastifyRequest): string {
  const value = request.headers[ACCOUNT_CONTEXT_VERSION_HEADER.toLowerCase()];
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw Object.assign(
      new Error(`${ACCOUNT_CONTEXT_VERSION_HEADER} is required for this mutation`),
      { statusCode: 428, code: "ACCOUNT_CONTEXT_VERSION_REQUIRED" },
    );
  }
  return value;
}

export function setAccountContextHeaders(
  reply: FastifyReply,
  context: Readonly<{
    clientAccountId: string | null;
    accountContextVersion: string;
  }>,
): void {
  reply.header(ACCOUNT_CONTEXT_VERSION_HEADER, context.accountContextVersion);
  if (context.clientAccountId) {
    reply.header(CLIENT_ACCOUNT_CONTEXT_HEADER, context.clientAccountId);
  }
}

export type LockedAccountContext = Readonly<{
  sessionId: string;
  userId: string;
  clientAccountId: string;
  accountName: string;
  accountContextVersion: string;
  membershipRole: MembershipRole;
  membershipPermissions: readonly string[];
}>;

export type LockedSessionContext = Readonly<{
  activeClientAccountId: string;
  accountContextVersion: string;
  emailVerifiedAt: Date | null;
  userRestrictedAt: Date | null;
}>;

export type LockedSessionIdentity = Readonly<{
  activeClientAccountId: string | null;
  accountContextVersion: string;
  emailVerifiedAt: Date | null;
  userRestrictedAt: Date | null;
}>;

/**
 * Lock an authenticated identity in the process-wide order used by every
 * mutating path: User first, then Session.  Keep these as separate statements;
 * PostgreSQL does not promise the relation lock order of a joined FOR UPDATE.
 */
export async function lockSessionIdentityForMutation(
  client: DatabaseClient,
  identity: Readonly<{ userId: string; sessionId: string }>,
  affectedUserIds: readonly string[] = [],
): Promise<LockedSessionIdentity> {
  const userIds = [...new Set([identity.userId, ...affectedUserIds])].sort();
  await client.query(
    `SELECT id
     FROM users
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [userIds],
  );
  const principal = await client.query<{
    email_verified_at: Date | null;
    user_restricted_at: Date | null;
  }>(
    `SELECT email_verified_at,
            restricted_at AS user_restricted_at
     FROM users
     WHERE id = $1`,
    [identity.userId],
  );
  const user = principal.rows[0];
  if (!user) {
    throw Object.assign(new Error("Session is invalid or expired"), { statusCode: 401 });
  }
  const sessionResult = await client.query<{
    active_client_account_id: string | null;
    account_context_version: string;
  }>(
    `SELECT active_client_account_id,
            account_context_version::text
     FROM sessions
     WHERE id = $1
       AND user_id = $2
       AND revoked_at IS NULL
       AND expires_at > pg_catalog.now()
     FOR UPDATE`,
    [identity.sessionId, identity.userId],
  );
  const session = sessionResult.rows[0];
  if (!session) {
    throw Object.assign(new Error("Session is invalid or expired"), { statusCode: 401 });
  }
  return {
    activeClientAccountId: session.active_client_account_id,
    accountContextVersion: session.account_context_version,
    emailVerifiedAt: user.email_verified_at,
    userRestrictedAt: user.user_restricted_at,
  };
}

async function lockAccountMembershipRows(
  client: DatabaseClient,
  clientAccountId: string,
  userId: string,
): Promise<void> {
  await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
    clientAccountId,
  ]);
  await client.query(
    `SELECT client_account_id
     FROM client_memberships
     WHERE client_account_id = $1 AND user_id = $2
     FOR UPDATE`,
    [clientAccountId, userId],
  );
}

export async function lockSessionContextForMutation(
  client: DatabaseClient,
  user: AuthenticatedUser,
  expectedVersion: string,
  affectedUserIds: readonly string[] = [],
): Promise<LockedSessionContext> {
  const session = await lockSessionIdentityForMutation(
    client,
    user,
    affectedUserIds,
  );
  // Identity restrictions take precedence over context mismatch so stale
  // mutation responses cannot disclose the currently selected account.
  assertIdentityReadEligible(session);
  if (
    session.activeClientAccountId !== user.clientAccountId ||
    session.accountContextVersion !== expectedVersion
  ) {
    throw accountContextStaleError(session);
  }
  // Customer mutations always finish the identity lock prefix before taking
  // advisory or business-object locks: User -> Session -> Account -> Membership.
  await lockAccountMembershipRows(client, user.clientAccountId, user.userId);
  return {
    activeClientAccountId: session.activeClientAccountId,
    accountContextVersion: session.accountContextVersion,
    emailVerifiedAt: session.emailVerifiedAt,
    userRestrictedAt: session.userRestrictedAt,
  };
}

export async function lockSessionSetForMembershipMutation(
  client: DatabaseClient,
  user: AuthenticatedUser,
  expectedVersion: string,
  affectedUserIds: readonly string[],
): Promise<LockedSessionContext> {
  const userIds = [...new Set([user.userId, ...affectedUserIds])].sort();
  await client.query(
    `SELECT id
     FROM users
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [userIds],
  );
  const sessionResult = await client.query<{
    id: string;
    user_id: string;
    active_client_account_id: string | null;
    account_context_version: string;
    expires_at: Date;
    email_verified_at: Date | null;
    user_restricted_at: Date | null;
  }>(
    `SELECT
       session_record.id,
       session_record.user_id,
       session_record.active_client_account_id,
       session_record.account_context_version::text,
       session_record.expires_at,
       principal.email_verified_at,
       principal.restricted_at AS user_restricted_at
     FROM sessions session_record
     JOIN users principal ON principal.id = session_record.user_id
     WHERE session_record.user_id = ANY($1::uuid[])
       AND session_record.revoked_at IS NULL
     ORDER BY session_record.id
     FOR UPDATE OF session_record`,
    [userIds],
  );
  const session = sessionResult.rows.find(
    (row) => row.id === user.sessionId && row.user_id === user.userId,
  );
  if (!session || session.expires_at.getTime() <= Date.now()) {
    throw Object.assign(new Error("Session is invalid or expired"), { statusCode: 401 });
  }
  assertIdentityReadEligible({
    emailVerifiedAt: session.email_verified_at,
    userRestrictedAt: session.user_restricted_at,
  });
  if (
    session.active_client_account_id !== user.clientAccountId ||
    session.account_context_version !== expectedVersion
  ) {
    throw accountContextStaleError({
      activeClientAccountId: session.active_client_account_id,
      accountContextVersion: session.account_context_version,
    });
  }
  return {
    activeClientAccountId: session.active_client_account_id,
    accountContextVersion: session.account_context_version,
    emailVerifiedAt: session.email_verified_at,
    userRestrictedAt: session.user_restricted_at,
  };
}

export async function lockMembershipAccountForMutation(
  client: DatabaseClient,
  user: AuthenticatedUser,
  session: LockedSessionContext,
): Promise<LockedAccountContext> {
  await lockAccountMembershipRows(client, user.clientAccountId, user.userId);
  const contextResult = await client.query<{
    account_name: string;
    account_restricted_at: Date | null;
    membership_role: MembershipRole;
    membership_permissions: unknown;
    membership_restricted_at: Date | null;
  }>(
    `SELECT
       account.name AS account_name,
       account.restricted_at AS account_restricted_at,
       membership.role AS membership_role,
       membership.permissions AS membership_permissions,
       membership.restricted_at AS membership_restricted_at
     FROM client_memberships membership
     JOIN client_accounts account ON account.id = membership.client_account_id
     WHERE membership.client_account_id = $1
       AND membership.user_id = $2
       AND membership.removed_at IS NULL`,
    [user.clientAccountId, user.userId],
  );
  const context = contextResult.rows[0];
  if (!context || context.membership_restricted_at) {
    throw Object.assign(new Error("The active Client Account context is no longer valid"), {
      statusCode: 409,
      code: "ACCOUNT_CONTEXT_INVALID",
    });
  }
  if (
    !session.emailVerifiedAt ||
    session.userRestrictedAt ||
    context.account_restricted_at
  ) {
    throw Object.assign(new Error("A verified, unrestricted account is required"), {
      statusCode: 403,
      code: "ACCOUNT_RESTRICTED",
    });
  }
  return {
    sessionId: user.sessionId,
    userId: user.userId,
    clientAccountId: user.clientAccountId,
    accountName: context.account_name,
    accountContextVersion: session.accountContextVersion,
    membershipRole: context.membership_role,
    membershipPermissions: permissionArray(context.membership_permissions),
  };
}

export async function lockAccountContextForMutation(
  client: DatabaseClient,
  user: AuthenticatedUser,
  expectedVersion: string,
  affectedUserIds: readonly string[] = [],
): Promise<LockedAccountContext> {
  const session = await lockSessionContextForMutation(
    client,
    user,
    expectedVersion,
    affectedUserIds,
  );
  return lockMembershipAccountForMutation(client, user, session);
}

export async function lockSupportAccountContextForMutation(
  client: DatabaseClient,
  user: AuthenticatedUser,
  expectedVersion: string,
): Promise<LockedAccountContext> {
  const session = await lockSessionContextForMutation(
    client,
    user,
    expectedVersion,
  );
  const contextResult = await client.query<{
    account_name: string;
    membership_role: MembershipRole;
    membership_permissions: unknown;
    membership_restricted_at: Date | null;
  }>(
    `SELECT account.name AS account_name,
            membership.role AS membership_role,
            membership.permissions AS membership_permissions,
            membership.restricted_at AS membership_restricted_at
     FROM client_memberships membership
     JOIN client_accounts account ON account.id = membership.client_account_id
     WHERE membership.client_account_id = $1
       AND membership.user_id = $2
       AND membership.removed_at IS NULL`,
    [user.clientAccountId, user.userId],
  );
  const context = contextResult.rows[0];
  if (!context || context.membership_restricted_at) {
    throw Object.assign(new Error("The active Client Account context is no longer valid"), {
      statusCode: 409,
      code: "ACCOUNT_CONTEXT_INVALID",
    });
  }
  assertIdentityReadEligible(session);
  return {
    sessionId: user.sessionId,
    userId: user.userId,
    clientAccountId: user.clientAccountId,
    accountName: context.account_name,
    accountContextVersion: session.accountContextVersion,
    membershipRole: context.membership_role,
    membershipPermissions: permissionArray(context.membership_permissions),
  };
}

export function hasMembershipPermission(
  context: Pick<LockedAccountContext, "membershipRole" | "membershipPermissions">,
  permission: string,
): boolean {
  return membershipCapabilities(context).includes(permission);
}

export function membershipCapabilities(
  context: Pick<LockedAccountContext, "membershipRole" | "membershipPermissions">,
): readonly string[] {
  if (
    context.membershipRole === "owner" ||
    context.membershipPermissions.includes("*")
  ) {
    return customerMembershipCapabilities({
      role: context.membershipRole,
      permissions: context.membershipPermissions,
    });
  }
  return customerMembershipCapabilities({
    role: context.membershipRole,
    permissions: context.membershipPermissions,
  });
}

export function assertCustomerCapability(
  context: Pick<LockedAccountContext, "membershipRole" | "membershipPermissions">,
  capability: CustomerCapability,
): void {
  if (!membershipCapabilities(context).includes(capability)) {
    throw Object.assign(new Error(`Customer capability ${capability} is required`), {
      statusCode: 403,
      code: "CUSTOMER_CAPABILITY_REQUIRED",
      capability,
    });
  }
}

export function assertMembershipPermission(
  context: Pick<LockedAccountContext, "membershipRole" | "membershipPermissions">,
  permission: string,
): void {
  if (!hasMembershipPermission(context, permission)) {
    throw Object.assign(new Error(`Membership permission ${permission} is required`), {
      statusCode: 403,
      code: "MEMBERSHIP_PERMISSION_REQUIRED",
    });
  }
}

export function assertIdentityReadEligible(
  identity: Readonly<{
    emailVerifiedAt: Date | null;
    userRestrictedAt: Date | null;
  }>,
): void {
  if (!identity.emailVerifiedAt) {
    throw Object.assign(new Error("Email verification is required"), {
      statusCode: 403,
      code: "EMAIL_VERIFICATION_REQUIRED",
    });
  }
  if (identity.userRestrictedAt) {
    throw Object.assign(new Error("This User is restricted"), {
      statusCode: 403,
      code: "ACCOUNT_RESTRICTED",
    });
  }
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
  assertCustomerCapability(user, "billing.write");
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
