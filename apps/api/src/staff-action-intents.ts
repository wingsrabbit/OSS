// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SessionIdentity } from "./auth.js";
import type { DatabaseClient } from "./database.js";
import { requireStaffActionLocked } from "./routes-admin.js";

type JsonObject = Record<string, unknown>;

const REAUTH_CREDENTIAL_FIELD = /password|factorcode|recoverycode|secret|token|totp/iu;

type StoredIntentRow<T extends JsonObject> = Readonly<{
  action: string;
  request_fingerprint: string;
  response_status: number;
  response_body: T;
}>;

export type StaffActionIntentOutcome<T extends JsonObject> = Readonly<{
  statusCode: number;
  body: T;
  replayed: boolean;
}>;

function intentConflict(): Error {
  return Object.assign(
    new Error("The Staff action intent was already used for a different request"),
    { statusCode: 409, code: "STAFF_ACTION_INTENT_CONFLICT" },
  );
}

function assertNoReauthCredentialFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoReauthCredentialFields(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (REAUTH_CREDENTIAL_FIELD.test(key)) {
      throw new Error("Reauthentication credentials cannot enter a Staff action intent result");
    }
    assertNoReauthCredentialFields(child);
  }
}

/**
 * Executes one permission-scoped Staff fact and stores its exact HTTP outcome.
 *
 * Authorization is intentionally checked before replay lookup on every call.
 * The immutable audit row and the business fact commit in the same transaction,
 * while the advisory lock serializes the UUID intent without a schema change.
 */
export async function executeStaffActionIntent<T extends JsonObject>(
  client: DatabaseClient,
  input: Readonly<{
    user: SessionIdentity;
    permission: string;
    intentId: string;
    action: string;
    requestFingerprint: string;
    execute: (reauthGrantId: string) => Promise<Readonly<{
      statusCode: number;
      body: T;
    }>>;
  }>,
): Promise<StaffActionIntentOutcome<T>> {
  if (!/^[0-9a-f]{64}$/u.test(input.requestFingerprint)) {
    throw new Error("Staff action intent request fingerprint must be a SHA-256 digest");
  }
  const reauthGrantId = await requireStaffActionLocked(
    client,
    input.user,
    input.permission,
  );
  await client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
    [`staff-action-intent:${input.user.userId}:${input.intentId}`],
  );

  const prior = await client.query<StoredIntentRow<T>>(
    `SELECT action,
            metadata->>'requestFingerprint' AS request_fingerprint,
            (metadata->>'responseStatus')::integer AS response_status,
            metadata->'responseBody' AS response_body
     FROM public.audit_events
     WHERE actor_type = 'staff'
       AND actor_id = $1
       AND target_type = 'staff_action_intent'
       AND target_id = $2
     ORDER BY created_at, id
     FOR UPDATE`,
    [input.user.userId, input.intentId],
  );
  if (prior.rows.length > 1) {
    throw new Error("Staff action intent history is not unique");
  }
  const replay = prior.rows[0];
  if (replay) {
    if (
      replay.action !== input.action ||
      replay.request_fingerprint !== input.requestFingerprint
    ) {
      throw intentConflict();
    }
    assertNoReauthCredentialFields(replay.response_body);
    return {
      statusCode: replay.response_status,
      body: replay.response_body,
      replayed: true,
    };
  }

  const committed = await input.execute(reauthGrantId);
  assertNoReauthCredentialFields(committed.body);
  const stored = await client.query<StoredIntentRow<T>>(
    `INSERT INTO public.audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES (
       'staff', $1, $2, 'staff_action_intent', $3, $4, $5
     )
     RETURNING action,
               metadata->>'requestFingerprint' AS request_fingerprint,
               (metadata->>'responseStatus')::integer AS response_status,
               metadata->'responseBody' AS response_body`,
    [
      input.user.userId,
      input.action,
      input.intentId,
      "Durable Staff action intent outcome",
      {
        requestFingerprint: input.requestFingerprint,
        responseStatus: committed.statusCode,
        responseBody: committed.body,
      },
    ],
  );
  const persisted = stored.rows[0];
  if (!persisted) throw new Error("Staff action intent outcome was not stored");
  return {
    statusCode: persisted.response_status,
    body: persisted.response_body,
    replayed: false,
  };
}
