// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  assertIdentityReadEligible,
  assertMembershipPermission,
  createOpaqueToken,
  digestToken,
  expectedAccountContextVersion,
  hasMembershipPermission,
  lockAccountContextForMutation,
  lockMembershipAccountForMutation,
  lockSessionIdentityForMutation,
  lockSessionSetForMembershipMutation,
  membershipCapabilities,
  requireSessionIdentity,
  requireUser,
  setAccountContextHeaders,
  setAuthorizationEpochForRequest,
  type AuthenticatedUser,
  type MembershipRole,
} from "./auth.js";
import type { Config } from "./config.js";
import {
  transaction,
  type DatabaseClient,
  type DatabasePool,
} from "./database.js";
import {
  collectionPage,
  decodeKeysetCursor,
  parsePageQuery,
} from "./keyset-pagination.js";
import { enqueueNotification } from "./notification-outbox.js";
import { requireRecentReauthLocked } from "./routes-admin.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const roleSchema = z.enum(["owner", "billing", "technical", "viewer"]);
const permissionSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^(\*|[a-z][a-z0-9_.:-]*)$/);
const permissionsSchema = z
  .array(permissionSchema)
  .max(64)
  .transform((permissions) => [...new Set(permissions)].sort());
const invitationSchema = z.object({
  email: z.email().max(320),
  locale: z.enum(["en", "zh-CN"]).default("en"),
  role: roleSchema,
  permissions: permissionsSchema.default([]),
});
const invitationAcceptSchema = z.object({
  token: z.string().min(32).max(256),
});
const memberPatchSchema = z
  .object({
    role: roleSchema.optional(),
    permissions: permissionsSchema.optional(),
    restricted: z.boolean().optional(),
    replacementOwnerUserId: canonicalUuid.optional(),
  })
  .refine(
    (body) =>
      body.role !== undefined ||
      body.permissions !== undefined ||
      body.restricted !== undefined,
    { message: "At least one membership field must change" },
  );
const memberRemovalQuerySchema = z.object({
  replacementOwnerUserId: canonicalUuid.optional(),
});
const subscriptionSchema = z.enum(["billing", "service", "support"]);
const contactCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  email: z.email().max(320),
  locale: z.enum(["en", "zh-CN"]).default("en"),
  notificationSubscriptions: z
    .array(subscriptionSchema)
    .max(3)
    .transform((subscriptions) => [...new Set(subscriptions)].sort())
    .default([]),
});
const contactPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160).optional(),
    email: z.email().max(320).optional(),
    locale: z.enum(["en", "zh-CN"]).optional(),
    notificationSubscriptions: z
      .array(subscriptionSchema)
      .max(3)
      .transform((subscriptions) => [...new Set(subscriptions)].sort())
      .optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "At least one Contact field must change",
  });

type SessionContext = Readonly<{
  clientAccountId: string | null;
  accountContextVersion: string;
}>;

function stringPermissions(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((permission) => typeof permission === "string")
    ? value
    : [];
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function assertReadPermission(
  user: AuthenticatedUser,
  readPermission: string,
  managePermission: string,
): void {
  if (
    !hasMembershipPermission(user, readPermission) &&
    !hasMembershipPermission(user, managePermission)
  ) {
    assertMembershipPermission(user, readPermission);
  }
}

function grantWithinCeiling(
  actor: Pick<AuthenticatedUser, "membershipRole" | "membershipPermissions">,
  proposed: Readonly<{ role: MembershipRole; permissions: readonly string[] }>,
): boolean {
  if (
    proposed.role === "owner" ||
    proposed.permissions.includes("*")
  ) {
    if (actor.membershipRole !== "owner") {
      return false;
    }
    return true;
  }
  if (actor.membershipRole === "owner") return true;
  const actorCapabilities = new Set(membershipCapabilities(actor));
  const proposedCapabilities = membershipCapabilities({
    membershipRole: proposed.role,
    membershipPermissions: proposed.permissions,
  });
  const exceedsCapabilityCeiling = proposedCapabilities.some(
    (capability) => !actorCapabilities.has(capability),
  );
  const exceedsRawPermissionCeiling = proposed.permissions.some(
    (permission) =>
      !actorCapabilities.has(permission) &&
      !actor.membershipPermissions.includes(permission),
  );
  return !exceedsCapabilityCeiling && !exceedsRawPermissionCeiling;
}

function assertGrantWithinCeiling(
  actor: Pick<AuthenticatedUser, "membershipRole" | "membershipPermissions">,
  proposed: Readonly<{ role: MembershipRole; permissions: readonly string[] }>,
): void {
  if (!grantWithinCeiling(actor, proposed)) {
    throw Object.assign(
      new Error("Membership grant exceeds the caller's current authority"),
      { statusCode: 403, code: "MEMBERSHIP_GRANT_CEILING_EXCEEDED" },
    );
  }
}

async function loadSessionContext(
  client: DatabaseClient,
  sessionId: string,
): Promise<SessionContext> {
  const result = await client.query<{
    active_client_account_id: string | null;
    account_context_version: string;
  }>(
    `SELECT active_client_account_id, account_context_version::text
     FROM sessions
     WHERE id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Session disappeared during account mutation");
  return {
    clientAccountId: row.active_client_account_id,
    accountContextVersion: row.account_context_version,
  };
}

function applyContextHeaders(reply: FastifyReply, context: SessionContext): void {
  setAccountContextHeaders(reply, context);
}

async function lockActiveOwnerIds(
  client: DatabaseClient,
  clientAccountId: string,
): Promise<string[]> {
  const result = await client.query<{ user_id: string }>(
    `SELECT user_id
     FROM client_memberships
     WHERE client_account_id = $1
       AND role = 'owner'
       AND removed_at IS NULL
       AND restricted_at IS NULL
     ORDER BY user_id
     FOR UPDATE`,
    [clientAccountId],
  );
  return result.rows.map((row) => row.user_id);
}

async function requireReplacementOwner(
  client: DatabaseClient,
  input: Readonly<{
    clientAccountId: string;
    targetUserId: string;
    replacementOwnerUserId?: string;
    actorUserId: string;
    sourceAction: "membership.patch" | "membership.delete";
    reason: string;
  }>,
): Promise<
  Readonly<{
    oldOwnerUserId: string;
    newOwnerUserId: string;
    sourceAction: "membership.patch" | "membership.delete";
    reason: string;
  }> | null
> {
  const account = await client.query<{ owner_user_id: string }>(
    `SELECT owner_user_id
     FROM client_accounts
     WHERE id = $1
     FOR UPDATE`,
    [input.clientAccountId],
  );
  if (account.rows[0]?.owner_user_id !== input.targetUserId) return null;
  if (!input.replacementOwnerUserId) {
    throw Object.assign(
      new Error("Transfer the recorded owner before changing this membership"),
      { statusCode: 409, code: "PRIMARY_OWNER_TRANSFER_REQUIRED" },
    );
  }
  const replacement = await client.query(
    `SELECT 1
     FROM client_memberships
     WHERE client_account_id = $1
       AND user_id = $2
       AND user_id <> $3
       AND role = 'owner'
       AND removed_at IS NULL
       AND restricted_at IS NULL
     FOR UPDATE`,
    [
      input.clientAccountId,
      input.replacementOwnerUserId,
      input.targetUserId,
    ],
  );
  if (replacement.rowCount !== 1) {
    throw Object.assign(new Error("Replacement owner is not an active owner"), {
      statusCode: 409,
      code: "REPLACEMENT_OWNER_REQUIRED",
    });
  }
  await client.query(
    "UPDATE client_accounts SET owner_user_id = $2 WHERE id = $1",
    [input.clientAccountId, input.replacementOwnerUserId],
  );
  const transfer = {
    oldOwnerUserId: input.targetUserId,
    newOwnerUserId: input.replacementOwnerUserId,
    sourceAction: input.sourceAction,
    reason: input.reason,
  } as const;
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES (
       'user', $1, 'client_account.owner_transferred',
       'client_account', $2, $3, $4
     )`,
    [
      input.actorUserId,
      input.clientAccountId,
      input.reason,
      {
        clientAccountId: input.clientAccountId,
        ...transfer,
      },
    ],
  );
  return transfer;
}

export async function registerAccountContextRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/account/members", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertIdentityReadEligible(user);
    assertReadPermission(user, "account.members.read", "account.members.manage");
    const query = parsePageQuery(request.query);
    const scope = "account.members";
    const cursor = decodeKeysetCursor(
      query.cursor,
      scope,
      user.clientAccountId,
    );
    const result = await pool.query<{
      user_id: string;
      email: string;
      role: MembershipRole;
      permissions: unknown;
      membership_restricted_at: Date | null;
      user_restricted_at: Date | null;
      created_at_cursor: string;
      updated_at: Date;
      is_recorded_owner: boolean;
    }>(
      `SELECT
         membership.user_id,
         principal.email,
         membership.role,
         membership.permissions,
         membership.restricted_at AS membership_restricted_at,
         principal.restricted_at AS user_restricted_at,
         to_char(
           membership.created_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS created_at_cursor,
         membership.updated_at,
         account.owner_user_id = membership.user_id AS is_recorded_owner
       FROM client_memberships membership
       JOIN users principal ON principal.id = membership.user_id
       JOIN client_accounts account ON account.id = membership.client_account_id
       WHERE membership.client_account_id = $1
         AND membership.removed_at IS NULL
         AND (
           $2::timestamptz IS NULL OR
           (membership.created_at, membership.user_id) >
           ($2::timestamptz, $3::uuid)
         )
       ORDER BY membership.created_at, membership.user_id
       LIMIT $4`,
      [
        user.clientAccountId,
        cursor?.at ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      ],
    );
    const items = result.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      role: row.role,
      permissions: stringPermissions(row.permissions),
      restrictions: {
        membership: Boolean(row.membership_restricted_at),
        user: Boolean(row.user_restricted_at),
      },
      isRecordedOwner: row.is_recorded_owner,
      createdAt: row.created_at_cursor,
      updatedAt: row.updated_at.toISOString(),
    }));
    setAccountContextHeaders(reply, user);
    return collectionPage(items, query.limit, scope, user.clientAccountId, (member) => ({
      at: member.createdAt,
      id: member.userId,
    }));
  });

  app.get("/api/v1/account/membership-invitations", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertIdentityReadEligible(user);
    assertReadPermission(user, "account.members.read", "account.members.manage");
    const query = parsePageQuery(request.query);
    const scope = "account.membership-invitations";
    const cursor = decodeKeysetCursor(
      query.cursor,
      scope,
      user.clientAccountId,
    );
    const result = await pool.query<{
      id: string;
      email: string;
      locale: "en" | "zh-CN";
      role: MembershipRole;
      permissions: unknown;
      status: "accepted" | "revoked" | "expired" | "pending";
      expires_at: Date;
      created_at_cursor: string;
    }>(
      `SELECT id, email, locale, role, permissions,
              CASE
                WHEN accepted_at IS NOT NULL THEN 'accepted'
                WHEN expires_at <= pg_catalog.clock_timestamp() THEN 'expired'
                WHEN revoked_at IS NOT NULL THEN 'revoked'
                ELSE 'pending'
              END AS status,
              expires_at,
              to_char(
                created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ) AS created_at_cursor
       FROM client_membership_invitations
       WHERE client_account_id = $1
         AND (
           $2::timestamptz IS NULL OR
           (created_at, id) < ($2::timestamptz, $3::uuid)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
      [
        user.clientAccountId,
        cursor?.at ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      ],
    );
    const items = result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      locale: row.locale,
      role: row.role,
      permissions: stringPermissions(row.permissions),
      status: row.status,
      expiresAt: row.expires_at.toISOString(),
      createdAt: row.created_at_cursor,
    }));
    setAccountContextHeaders(reply, user);
    return collectionPage(
      items,
      query.limit,
      scope,
      user.clientAccountId,
      (invitation) => ({ at: invitation.createdAt, id: invitation.id }),
    );
  });

  app.post("/api/v1/account/membership-invitations", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedVersion = expectedAccountContextVersion(request);
    const body = invitationSchema.parse(request.body);
    const token = createOpaqueToken();
    let outcome:
      | Readonly<{ kind: "created"; invitation: Record<string, unknown>; context: SessionContext }>
      | Readonly<{ kind: "existing_member" }>;
    try {
      outcome = await transaction(pool, async (client) => {
        const context = await lockAccountContextForMutation(
          client,
          user,
          expectedVersion,
        );
        assertMembershipPermission(context, "account.members.manage");
        await requireRecentReauthLocked(client, user);
        assertGrantWithinCeiling(context, {
          role: body.role,
          permissions: body.permissions,
        });
        const databaseClock = await client.query<{ expires_at: Date }>(
          `SELECT pg_catalog.clock_timestamp() +
                  pg_catalog.make_interval(mins => $1::integer) AS expires_at`,
          [config.VERIFICATION_TTL_MINUTES],
        );
        const expiresAt = databaseClock.rows[0]!.expires_at;
        const existingMember = await client.query(
          `SELECT 1
           FROM client_memberships membership
           JOIN users principal ON principal.id = membership.user_id
           WHERE membership.client_account_id = $1
             AND principal.email = $2
             AND membership.removed_at IS NULL`,
          [context.clientAccountId, body.email],
        );
        if (existingMember.rowCount !== 0) return { kind: "existing_member" as const };
        await client.query(
          `UPDATE client_membership_invitations
           SET revoked_at = pg_catalog.now(), updated_at = pg_catalog.now()
           WHERE client_account_id = $1
             AND email = $2
             AND accepted_at IS NULL
             AND revoked_at IS NULL
             AND expires_at <= pg_catalog.clock_timestamp()`,
          [context.clientAccountId, body.email],
        );
        const inserted = await client.query<{
          id: string;
          created_at: Date;
        }>(
          `INSERT INTO client_membership_invitations(
             client_account_id, email, locale, role, permissions, token_digest,
             expires_at, invited_by_user_id
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
           RETURNING id, created_at`,
          [
            context.clientAccountId,
            body.email,
            body.locale,
            body.role,
            JSON.stringify(body.permissions),
            digestToken(token),
            expiresAt,
            user.userId,
          ],
        );
        const invitation = inserted.rows[0];
        if (!invitation) throw new Error("Unable to create membership invitation");
        await enqueueNotification(client, {
          eventType: "notification.membership_invitation_requested",
          uniqueKey: `membership-invitation:${invitation.id}`,
          payload: {
            accountName: context.accountName,
            role: body.role,
            permissions: body.permissions,
            invitationUrl: `${config.OSS_PUBLIC_URL}/membership-invitations/accept?token=${token}`,
            expiresAt: expiresAt.toISOString(),
          },
          recipient: {
            kind: "invitation",
            category: "membership_invitation",
            invitationId: invitation.id,
            clientAccountId: context.clientAccountId,
            email: body.email,
            locale: body.locale,
          },
        });
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, metadata
           ) VALUES ('user', $1, 'membership.invited', 'membership_invitation', $2, $3)`,
          [
            user.userId,
            invitation.id,
            {
              clientAccountId: context.clientAccountId,
              email: body.email,
              locale: body.locale,
              role: body.role,
              permissions: body.permissions,
            },
          ],
        );
        return {
          kind: "created" as const,
          invitation: {
            id: invitation.id,
            email: body.email,
            locale: body.locale,
            role: body.role,
            permissions: body.permissions,
            status: "pending",
            expiresAt: expiresAt.toISOString(),
            createdAt: invitation.created_at.toISOString(),
          },
          context: await loadSessionContext(client, user.sessionId),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          error: "A pending invitation already exists for this email",
          code: "MEMBERSHIP_INVITATION_EXISTS",
        });
      }
      throw error;
    }
    if (outcome.kind === "existing_member") {
      return reply.code(409).send({
        error: "This email already has an active membership",
        code: "MEMBERSHIP_EXISTS",
      });
    }
    applyContextHeaders(reply, outcome.context);
    return reply.code(201).send({ invitation: outcome.invitation });
  });

  app.delete(
    "/api/v1/account/membership-invitations/:invitationId",
    async (request, reply) => {
      const user = await requireUser(request, pool, config);
      const expectedVersion = expectedAccountContextVersion(request);
      const params = z.object({ invitationId: canonicalUuid }).parse(request.params);
      const result = await transaction(pool, async (client) => {
        const context = await lockAccountContextForMutation(
          client,
          user,
          expectedVersion,
        );
        assertMembershipPermission(context, "account.members.manage");
        await requireRecentReauthLocked(client, user);
        const revoked = await client.query(
          `UPDATE client_membership_invitations
           SET revoked_at = pg_catalog.now(), updated_at = pg_catalog.now()
           WHERE id = $1
             AND client_account_id = $2
             AND accepted_at IS NULL
             AND revoked_at IS NULL
           RETURNING id`,
          [params.invitationId, context.clientAccountId],
        );
        if (revoked.rowCount !== 1) {
          throw Object.assign(new Error("Pending membership invitation was not found"), {
            statusCode: 404,
          });
        }
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, metadata
           ) VALUES ('user', $1, 'membership.invitation_revoked',
             'membership_invitation', $2, $3)`,
          [
            user.userId,
            params.invitationId,
            { clientAccountId: context.clientAccountId },
          ],
        );
        return loadSessionContext(client, user.sessionId);
      });
      applyContextHeaders(reply, result);
      return { revoked: true, invitationId: params.invitationId };
    },
  );

  app.post("/api/v1/membership-invitations/accept", async (request, reply) => {
    const identity = await requireSessionIdentity(request, pool, config);
    const body = invitationAcceptSchema.parse(request.body);
    const invitationPointer = await pool.query<{
      id: string;
      client_account_id: string;
      invited_by_user_id: string;
    }>(
      `SELECT id, client_account_id, invited_by_user_id
       FROM client_membership_invitations
       WHERE token_digest = $1`,
      [digestToken(body.token)],
    );
    const pointer = invitationPointer.rows[0];
    if (!pointer) {
      return reply.code(400).send({ error: "Membership invitation is invalid" });
    }
    const result = await transaction(pool, async (client) => {
      const session = await lockSessionIdentityForMutation(client, identity, [
        pointer.invited_by_user_id,
      ]);
      const principalResult = await client.query<{
        email: string;
      }>(
        `SELECT email FROM users WHERE id = $1`,
        [identity.userId],
      );
      const principal = principalResult.rows[0];
      if (!principal) return { status: "invalid_session" as const };
      if (!session.emailVerifiedAt || session.userRestrictedAt) {
        return { status: "ineligible" as const };
      }
      const accountResult = await client.query<{ restricted_at: Date | null }>(
        `SELECT restricted_at
         FROM client_accounts
         WHERE id = $1
         FOR UPDATE`,
        [pointer.client_account_id],
      );
      const invitationResult = await client.query<{
        id: string;
        client_account_id: string;
        email_matches: boolean;
        role: MembershipRole;
        permissions: unknown;
        expires_at: Date;
        accepted_by_user_id: string | null;
        accepted_at: Date | null;
        revoked_at: Date | null;
        expired: boolean;
        invited_by_user_id: string;
      }>(
        `SELECT
           invitation.id,
           invitation.client_account_id,
           invitation.email = $3 AS email_matches,
           invitation.role,
           invitation.permissions,
           invitation.expires_at,
           invitation.accepted_by_user_id,
           invitation.accepted_at,
           invitation.revoked_at,
           invitation.invited_by_user_id,
           invitation.expires_at <= pg_catalog.clock_timestamp() AS expired
         FROM client_membership_invitations invitation
         WHERE invitation.id = $1
           AND invitation.token_digest = $2
         FOR UPDATE`,
        [pointer.id, digestToken(body.token), principal.email],
      );
      const invitation = invitationResult.rows[0];
      if (!invitation) return { status: "invalid" as const };
      if (!invitation.accepted_at) {
        if (invitation.expired) {
          return { status: "expired" as const };
        }
        if (invitation.revoked_at) {
          return { status: "used" as const };
        }
      }

      const membershipRows = await client.query<{
        user_id: string;
        role: MembershipRole;
        permissions: unknown;
        email_verified_at: Date | null;
        user_restricted_at: Date | null;
        restricted_at: Date | null;
        removed_at: Date | null;
      }>(
        `SELECT membership.user_id,
                membership.role,
                membership.permissions,
                principal.email_verified_at,
                principal.restricted_at AS user_restricted_at,
                membership.restricted_at,
                membership.removed_at
         FROM client_memberships membership
         JOIN users principal ON principal.id = membership.user_id
         WHERE membership.client_account_id = $1
           AND membership.user_id = ANY($2::uuid[])
         ORDER BY membership.user_id
         FOR UPDATE OF membership`,
        [
          invitation.client_account_id,
          [identity.userId, invitation.invited_by_user_id].sort(),
        ],
      );
      const inviter = membershipRows.rows.find(
        (membership) => membership.user_id === invitation.invited_by_user_id,
      );
      const invitationPermissions = stringPermissions(invitation.permissions);
      const existing = membershipRows.rows.find(
        (membership) => membership.user_id === identity.userId,
      );
      if (invitation.accepted_at) {
        if (
          invitation.accepted_by_user_id === identity.userId &&
          existing &&
          !existing.removed_at &&
          !existing.restricted_at
        ) {
          return {
            status: "accepted" as const,
            replayed: true,
            membership: {
              clientAccountId: invitation.client_account_id,
              userId: identity.userId,
              role: existing.role,
              permissions: stringPermissions(existing.permissions),
            },
            context: await loadSessionContext(client, identity.sessionId),
          };
        }
        return { status: "used" as const };
      }
      const inviterAuthority = inviter
        ? {
            membershipRole: inviter.role,
            membershipPermissions: stringPermissions(inviter.permissions),
          }
        : null;
      const inviterStillAuthorized =
        Boolean(inviterAuthority) &&
        Boolean(inviter?.email_verified_at) &&
        !inviter?.user_restricted_at &&
        !inviter?.removed_at &&
        !inviter?.restricted_at &&
        hasMembershipPermission(inviterAuthority!, "account.members.manage") &&
        grantWithinCeiling(inviterAuthority!, {
          role: invitation.role,
          permissions: invitationPermissions,
        });
      if (!inviterStillAuthorized) {
        await client.query(
          `UPDATE client_membership_invitations
           SET revoked_at = pg_catalog.now(), updated_at = pg_catalog.now()
           WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [invitation.id],
        );
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, metadata
           ) VALUES ('system', 'core', 'membership.invitation_authorization_expired',
             'membership_invitation', $1, $2)`,
          [
            invitation.id,
            {
              clientAccountId: invitation.client_account_id,
              invitedByUserId: invitation.invited_by_user_id,
            },
          ],
        );
        return { status: "authorization_changed" as const };
      }
      if (!invitation.email_matches) return { status: "wrong_user" as const };
      if (accountResult.rows[0]?.restricted_at) return { status: "ineligible" as const };
      if (existing && !existing.removed_at) {
        return { status: "already_member" as const };
      }
      await client.query(
        `INSERT INTO client_memberships(
           client_account_id, user_id, role, permissions, restricted_at, removed_at
         ) VALUES ($1, $2, $3, $4::jsonb, NULL, NULL)
         ON CONFLICT (client_account_id, user_id) DO UPDATE SET
           role = EXCLUDED.role,
           permissions = EXCLUDED.permissions,
           restricted_at = NULL,
           removed_at = NULL,
           updated_at = pg_catalog.now()`,
        [
          invitation.client_account_id,
          identity.userId,
          invitation.role,
          JSON.stringify(invitationPermissions),
        ],
      );
      await client.query(
        `UPDATE client_membership_invitations
         SET accepted_by_user_id = $2,
             accepted_at = pg_catalog.now(),
             updated_at = pg_catalog.now()
         WHERE id = $1`,
        [invitation.id, identity.userId],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, metadata
         ) VALUES ('user', $1, 'membership.invitation_accepted',
           'membership', $1, $2)`,
        [
          identity.userId,
          {
            clientAccountId: invitation.client_account_id,
            invitationId: invitation.id,
            role: invitation.role,
          },
        ],
      );
      return {
        status: "accepted" as const,
        replayed: false,
        membership: {
          clientAccountId: invitation.client_account_id,
          userId: identity.userId,
          role: invitation.role,
          permissions: invitationPermissions,
        },
        context: await loadSessionContext(client, identity.sessionId),
      };
    });
    if (result.status === "invalid_session") {
      return reply.code(401).send({ error: "Session is invalid or expired" });
    }
    if (result.status === "invalid") {
      return reply.code(400).send({ error: "Membership invitation is invalid" });
    }
    if (result.status === "used" || result.status === "already_member") {
      return reply.code(409).send({ error: "Membership invitation was already used" });
    }
    if (result.status === "authorization_changed") {
      return reply.code(409).send({
        error: "Membership invitation authorization is no longer valid",
        code: "MEMBERSHIP_INVITATION_AUTHORIZATION_CHANGED",
      });
    }
    if (result.status === "expired") {
      return reply.code(410).send({ error: "Membership invitation expired" });
    }
    if (result.status === "wrong_user") {
      return reply.code(403).send({ error: "Membership invitation belongs to another email" });
    }
    if (result.status === "ineligible") {
      return reply.code(403).send({ error: "A verified, unrestricted account is required" });
    }
    applyContextHeaders(reply, result.context);
    return reply.code(201).send({
      membership: result.membership,
      replayed: result.replayed,
    });
  });

  app.patch("/api/v1/account/members/:userId", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedVersion = expectedAccountContextVersion(request);
    const params = z.object({ userId: canonicalUuid }).parse(request.params);
    const body = memberPatchSchema.parse(request.body);
    const result = await transaction(pool, async (client) => {
      // Lock caller and target Sessions together in stable id order before
      // Account/Membership. The AFTER membership trigger then cannot deadlock
      // a target customer's Session -> Account mutation.
      const session = await lockSessionSetForMembershipMutation(
        client,
        user,
        expectedVersion,
        [params.userId],
      );
      const context = await lockMembershipAccountForMutation(client, user, session);
      assertMembershipPermission(context, "account.members.manage");
      await requireRecentReauthLocked(client, user);
      const targetResult = await client.query<{
        role: MembershipRole;
        permissions: unknown;
        restricted_at: Date | null;
      }>(
        `SELECT role, permissions, restricted_at
         FROM client_memberships
         WHERE client_account_id = $1
           AND user_id = $2
           AND removed_at IS NULL
         FOR UPDATE`,
        [context.clientAccountId, params.userId],
      );
      const target = targetResult.rows[0];
      if (!target) {
        throw Object.assign(new Error("Client Account member was not found"), {
          statusCode: 404,
        });
      }
      if (target.role === "owner" && context.membershipRole !== "owner") {
        throw Object.assign(new Error("Only an Owner may change an Owner membership"), {
          statusCode: 403,
          code: "MEMBERSHIP_GRANT_CEILING_EXCEEDED",
        });
      }
      const nextRole = body.role ?? target.role;
      const nextPermissions = body.permissions ?? stringPermissions(target.permissions);
      const nextRestricted =
        body.restricted === undefined
          ? Boolean(target.restricted_at)
          : body.restricted;
      const authorizationChanged =
        nextRole !== target.role ||
        JSON.stringify(nextPermissions) !== JSON.stringify(stringPermissions(target.permissions)) ||
        nextRestricted !== Boolean(target.restricted_at);
      assertGrantWithinCeiling(context, {
        role: nextRole,
        permissions: nextPermissions,
      });
      const removesActiveOwner =
        target.role === "owner" &&
        !target.restricted_at &&
        (nextRole !== "owner" || nextRestricted);
      let ownerTransfer: Awaited<ReturnType<typeof requireReplacementOwner>> = null;
      if (removesActiveOwner) {
        const owners = await lockActiveOwnerIds(client, context.clientAccountId);
        if (owners.length <= 1) {
          throw Object.assign(
            new Error("Client Account must retain at least one active owner"),
            { statusCode: 409, code: "LAST_OWNER_REQUIRED" },
          );
        }
        ownerTransfer = await requireReplacementOwner(client, {
          clientAccountId: context.clientAccountId,
          targetUserId: params.userId,
          actorUserId: user.userId,
          sourceAction: "membership.patch",
          reason: "recorded owner membership role or restriction changed",
          ...(body.replacementOwnerUserId
            ? { replacementOwnerUserId: body.replacementOwnerUserId }
            : {}),
        });
      }
      const updated = await client.query<{
        role: MembershipRole;
        permissions: unknown;
        restricted_at: Date | null;
        updated_at: Date;
      }>(
        `UPDATE client_memberships
         SET role = $3,
             permissions = $4::jsonb,
             restricted_at = CASE
               WHEN $5::boolean THEN COALESCE(restricted_at, pg_catalog.now())
               ELSE NULL
             END,
             updated_at = pg_catalog.now()
         WHERE client_account_id = $1 AND user_id = $2
         RETURNING role, permissions, restricted_at, updated_at`,
        [
          context.clientAccountId,
          params.userId,
          nextRole,
          JSON.stringify(nextPermissions),
          nextRestricted,
        ],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, metadata
         ) VALUES ('user', $1, 'membership.updated', 'membership', $2, $3)`,
        [
          user.userId,
          params.userId,
          {
            clientAccountId: context.clientAccountId,
            role: nextRole,
            permissions: nextPermissions,
            restricted: nextRestricted,
          },
        ],
      );
      const row = updated.rows[0];
      if (!row) throw new Error("Unable to update Client Account member");
      const epoch = authorizationChanged
        ? await client.query<{ authorization_epoch: string }>(
          `SELECT authorization_epoch::text
           FROM users WHERE id = $1`,
          [params.userId],
        )
        : null;
      return {
        member: {
          userId: params.userId,
          role: row.role,
          permissions: stringPermissions(row.permissions),
          restrictions: { membership: Boolean(row.restricted_at) },
          updatedAt: row.updated_at.toISOString(),
        },
        ownerTransfer,
        context: await loadSessionContext(client, user.sessionId),
        targetAuthorizationEpoch: epoch?.rows[0]?.authorization_epoch ?? null,
      };
    });
    if (params.userId === user.userId && result.targetAuthorizationEpoch) {
      setAuthorizationEpochForRequest(request, result.targetAuthorizationEpoch);
    }
    applyContextHeaders(reply, result.context);
    return { member: result.member, ownerTransfer: result.ownerTransfer };
  });

  app.delete("/api/v1/account/members/:userId", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedVersion = expectedAccountContextVersion(request);
    const params = z.object({ userId: canonicalUuid }).parse(request.params);
    const query = memberRemovalQuerySchema.parse(request.query);
    const result = await transaction(pool, async (client) => {
      const session = await lockSessionSetForMembershipMutation(
        client,
        user,
        expectedVersion,
        [params.userId],
      );
      const context = await lockMembershipAccountForMutation(client, user, session);
      assertMembershipPermission(context, "account.members.manage");
      await requireRecentReauthLocked(client, user);
      const targetResult = await client.query<{ role: MembershipRole; restricted_at: Date | null }>(
        `SELECT role, restricted_at
         FROM client_memberships
         WHERE client_account_id = $1
           AND user_id = $2
           AND removed_at IS NULL
         FOR UPDATE`,
        [context.clientAccountId, params.userId],
      );
      const target = targetResult.rows[0];
      if (!target) {
        throw Object.assign(new Error("Client Account member was not found"), {
          statusCode: 404,
        });
      }
      if (target.role === "owner" && context.membershipRole !== "owner") {
        throw Object.assign(new Error("Only an Owner may remove an Owner membership"), {
          statusCode: 403,
          code: "MEMBERSHIP_GRANT_CEILING_EXCEEDED",
        });
      }
      let ownerTransfer: Awaited<ReturnType<typeof requireReplacementOwner>> = null;
      if (target.role === "owner" && !target.restricted_at) {
        const owners = await lockActiveOwnerIds(client, context.clientAccountId);
        if (owners.length <= 1) {
          throw Object.assign(
            new Error("Client Account must retain at least one active owner"),
            { statusCode: 409, code: "LAST_OWNER_REQUIRED" },
          );
        }
        ownerTransfer = await requireReplacementOwner(client, {
          clientAccountId: context.clientAccountId,
          targetUserId: params.userId,
          actorUserId: user.userId,
          sourceAction: "membership.delete",
          reason: "recorded owner membership removed",
          ...(query.replacementOwnerUserId
            ? { replacementOwnerUserId: query.replacementOwnerUserId }
            : {}),
        });
      }
      await client.query(
        `UPDATE client_memberships
         SET removed_at = pg_catalog.now(), updated_at = pg_catalog.now()
         WHERE client_account_id = $1 AND user_id = $2`,
        [context.clientAccountId, params.userId],
      );
      const epoch = await client.query<{ authorization_epoch: string }>(
        `SELECT authorization_epoch::text
         FROM users WHERE id = $1`,
        [params.userId],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, metadata
         ) VALUES ('user', $1, 'membership.removed', 'membership', $2, $3)`,
        [
          user.userId,
          params.userId,
          { clientAccountId: context.clientAccountId },
        ],
      );
      return {
        context: await loadSessionContext(client, user.sessionId),
        ownerTransfer,
        targetAuthorizationEpoch: epoch.rows[0]?.authorization_epoch ?? null,
      };
    });
    if (params.userId === user.userId && result.targetAuthorizationEpoch) {
      setAuthorizationEpochForRequest(request, result.targetAuthorizationEpoch);
    }
    applyContextHeaders(reply, result.context);
    return { removed: true, userId: params.userId, ownerTransfer: result.ownerTransfer };
  });

  app.get("/api/v1/account/contacts", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertIdentityReadEligible(user);
    assertReadPermission(user, "account.contacts.read", "account.contacts.manage");
    const query = parsePageQuery(request.query);
    const scope = "account.contacts";
    const cursor = decodeKeysetCursor(
      query.cursor,
      scope,
      user.clientAccountId,
    );
    const result = await pool.query<{
      id: string;
      display_name: string;
      email: string;
      locale: "en" | "zh-CN";
      notification_subscriptions: unknown;
      created_at_cursor: string;
      updated_at: Date;
    }>(
      `SELECT id, display_name, email, locale, notification_subscriptions,
              to_char(
                created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ) AS created_at_cursor,
              updated_at
       FROM client_contacts
       WHERE client_account_id = $1 AND removed_at IS NULL
         AND (
           $2::timestamptz IS NULL OR
           (created_at, id) > ($2::timestamptz, $3::uuid)
         )
       ORDER BY created_at, id
       LIMIT $4`,
      [
        user.clientAccountId,
        cursor?.at ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      ],
    );
    const items = result.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      locale: row.locale,
      notificationSubscriptions: stringPermissions(row.notification_subscriptions),
      createdAt: row.created_at_cursor,
      updatedAt: row.updated_at.toISOString(),
    }));
    setAccountContextHeaders(reply, user);
    return collectionPage(items, query.limit, scope, user.clientAccountId, (contact) => ({
      at: contact.createdAt,
      id: contact.id,
    }));
  });

  app.post("/api/v1/account/contacts", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedVersion = expectedAccountContextVersion(request);
    const body = contactCreateSchema.parse(request.body);
    try {
      const result = await transaction(pool, async (client) => {
        const context = await lockAccountContextForMutation(
          client,
          user,
          expectedVersion,
        );
        assertMembershipPermission(context, "account.contacts.manage");
        const inserted = await client.query<{
          id: string;
          created_at: Date;
          updated_at: Date;
        }>(
          `INSERT INTO client_contacts(
             client_account_id, display_name, email, locale,
             notification_subscriptions
           ) VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING id, created_at, updated_at`,
          [
            context.clientAccountId,
            body.displayName,
            body.email,
            body.locale,
            JSON.stringify(body.notificationSubscriptions),
          ],
        );
        const contact = inserted.rows[0];
        if (!contact) throw new Error("Unable to create Contact");
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, metadata
           ) VALUES ('user', $1, 'contact.created', 'contact', $2, $3)`,
          [
            user.userId,
            contact.id,
            { clientAccountId: context.clientAccountId, email: body.email },
          ],
        );
        return {
          contact: {
            id: contact.id,
            displayName: body.displayName,
            email: body.email,
            locale: body.locale,
            notificationSubscriptions: body.notificationSubscriptions,
            createdAt: contact.created_at.toISOString(),
            updatedAt: contact.updated_at.toISOString(),
          },
          context: await loadSessionContext(client, user.sessionId),
        };
      });
      applyContextHeaders(reply, result.context);
      return reply.code(201).send({ contact: result.contact });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          error: "An active Contact already uses this email",
          code: "CONTACT_EMAIL_EXISTS",
        });
      }
      throw error;
    }
  });

  app.patch("/api/v1/account/contacts/:contactId", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedVersion = expectedAccountContextVersion(request);
    const params = z.object({ contactId: canonicalUuid }).parse(request.params);
    const body = contactPatchSchema.parse(request.body);
    try {
      const result = await transaction(pool, async (client) => {
        const context = await lockAccountContextForMutation(
          client,
          user,
          expectedVersion,
        );
        assertMembershipPermission(context, "account.contacts.manage");
        const existing = await client.query<{
          display_name: string;
          email: string;
          locale: "en" | "zh-CN";
          notification_subscriptions: unknown;
        }>(
          `SELECT display_name, email, locale, notification_subscriptions
           FROM client_contacts
           WHERE id = $1 AND client_account_id = $2 AND removed_at IS NULL
           FOR UPDATE`,
          [params.contactId, context.clientAccountId],
        );
        const current = existing.rows[0];
        if (!current) {
          throw Object.assign(new Error("Contact was not found"), { statusCode: 404 });
        }
        const updated = await client.query<{ updated_at: Date }>(
          `UPDATE client_contacts
           SET display_name = $3,
               email = $4,
               locale = $5,
               notification_subscriptions = $6::jsonb,
               updated_at = pg_catalog.now()
           WHERE id = $1 AND client_account_id = $2
           RETURNING updated_at`,
          [
            params.contactId,
            context.clientAccountId,
            body.displayName ?? current.display_name,
            body.email ?? current.email,
            body.locale ?? current.locale,
            JSON.stringify(
              body.notificationSubscriptions ??
                stringPermissions(current.notification_subscriptions),
            ),
          ],
        );
        const row = updated.rows[0];
        if (!row) throw new Error("Unable to update Contact");
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, metadata
           ) VALUES ('user', $1, 'contact.updated', 'contact', $2, $3)`,
          [
            user.userId,
            params.contactId,
            { clientAccountId: context.clientAccountId },
          ],
        );
        return {
          contact: {
            id: params.contactId,
            displayName: body.displayName ?? current.display_name,
            email: body.email ?? current.email,
            locale: body.locale ?? current.locale,
            notificationSubscriptions:
              body.notificationSubscriptions ??
              stringPermissions(current.notification_subscriptions),
            updatedAt: row.updated_at.toISOString(),
          },
          context: await loadSessionContext(client, user.sessionId),
        };
      });
      applyContextHeaders(reply, result.context);
      return { contact: result.contact };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          error: "An active Contact already uses this email",
          code: "CONTACT_EMAIL_EXISTS",
        });
      }
      throw error;
    }
  });

  app.delete("/api/v1/account/contacts/:contactId", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    const expectedVersion = expectedAccountContextVersion(request);
    const params = z.object({ contactId: canonicalUuid }).parse(request.params);
    const result = await transaction(pool, async (client) => {
      const context = await lockAccountContextForMutation(client, user, expectedVersion);
      assertMembershipPermission(context, "account.contacts.manage");
      const removed = await client.query(
        `UPDATE client_contacts
         SET removed_at = pg_catalog.now(), updated_at = pg_catalog.now()
         WHERE id = $1 AND client_account_id = $2 AND removed_at IS NULL
         RETURNING id`,
        [params.contactId, context.clientAccountId],
      );
      if (removed.rowCount !== 1) {
        throw Object.assign(new Error("Contact was not found"), { statusCode: 404 });
      }
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, metadata
         ) VALUES ('user', $1, 'contact.removed', 'contact', $2, $3)`,
        [
          user.userId,
          params.contactId,
          { clientAccountId: context.clientAccountId },
        ],
      );
      return loadSessionContext(client, user.sessionId);
    });
    applyContextHeaders(reply, result);
    return { removed: true, contactId: params.contactId };
  });
}
