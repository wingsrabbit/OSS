// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSessionIdentity } from "./auth.js";
import type { Config } from "./config.js";
import {
  transaction,
  type DatabaseClient,
  type DatabasePool,
} from "./database.js";
import {
  requireStaffActionLocked,
  requireStaffPermission,
} from "./routes-admin.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const retryParams = z.object({ outboxId: canonicalUuid }).strict();
const postgresTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const retryBody = z
  .object({
    reason: z.string().trim().min(3).max(1_000),
    expectedJobUpdatedAt: postgresTimestamp,
  })
  .strict();

type DeliverySource = "standard" | "identity";
type OperationState =
  | "queued"
  | "dispatching"
  | "unknown"
  | "succeeded"
  | "failed"
  | "skipped"
  | "manual";

type StandardOperationRow = Readonly<{
  source: DeliverySource;
  operation_id: string;
  outbox_id: string;
  attempt_number: number;
  event_type: string;
  template_revision: string;
  category: string;
  recipient_kind: string;
  recipient: string;
  locale: "en" | "zh-CN";
  operation_status: OperationState;
  operation_attempts: number;
  operation_last_error: string | null;
  operation_created_at: string;
  operation_updated_at: string;
  outcome_status: "delivered" | "bounced" | "failed" | "skipped" | null;
  outcome_reason: string | null;
  outcome_recorded_at: string | null;
  job_id: string | null;
  job_status: "pending" | "running" | "completed" | "failed" | "manual" | null;
  job_last_error: string | null;
  job_available_at: string | null;
  job_updated_at: string | null;
  is_latest: boolean;
}>;

type IdentityOperationRow = Readonly<{
  source: DeliverySource;
  operation_id: string;
  outbox_id: string;
  attempt_number: number;
  event_type: string;
  template_revision: null;
  category: "identity";
  recipient_kind: "identity_user";
  recipient: string;
  locale: "en" | "zh-CN";
  operation_status: OperationState;
  operation_attempts: number;
  operation_last_error: string | null;
  operation_created_at: string;
  operation_updated_at: string;
  outcome_status: "delivered" | "bounced" | "failed" | "manual" | null;
  outcome_reason: string | null;
  outcome_recorded_at: string | null;
  job_id: string | null;
  job_status: "pending" | "running" | "completed" | "failed" | "manual" | null;
  job_last_error: string | null;
  job_available_at: string | null;
  job_updated_at: string | null;
  is_latest: boolean;
}>;

type OperationRow = StandardOperationRow | IdentityOperationRow;

type OldestTaskRow = Readonly<{
  id: string;
  job_type: string;
  status: string;
  available_at: string;
  created_at: string;
  updated_at: string;
}>;

type AuditRow = Readonly<{
  id: string;
  actor_id: string;
  target_id: string;
  reason: string | null;
  created_at: string;
}>;

function requestError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function retryDisposition(
  row: OperationRow,
  maximumAttempts: number,
): Readonly<{
  retryable: boolean;
  retryReason: string;
}> {
  if (!row.is_latest) {
    return { retryable: false, retryReason: "A newer delivery attempt already exists" };
  }
  if (row.source === "identity") {
    return {
      retryable: false,
      retryReason: "Identity delivery recovery requires its existing identity workflow",
    };
  }
  if (row.operation_status === "unknown") {
    return {
      retryable: false,
      retryReason: "Unknown delivery outcomes must reconcile the stable Provider operation",
    };
  }
  if (row.operation_status === "manual") {
    return {
      retryable: false,
      retryReason: "A terminal manual delivery operation cannot be reopened",
    };
  }
  if (row.operation_status !== "failed" || row.outcome_status !== "failed") {
    return {
      retryable: false,
      retryReason: "Retry requires an explicit immutable failed Provider outcome",
    };
  }
  if (row.attempt_number >= maximumAttempts) {
    return {
      retryable: false,
      retryReason: `The configured ${maximumAttempts}-attempt delivery budget is exhausted`,
    };
  }
  if (row.job_status !== "manual") {
    return {
      retryable: false,
      retryReason: "The Worker already owns this delivery or has finished it",
    };
  }
  if (!row.job_updated_at) {
    return { retryable: false, retryReason: "The exact durable task is unavailable" };
  }
  return {
    retryable: true,
    retryReason: "The failed attempt can append one Worker-controlled retry",
  };
}

function operationJson(row: OperationRow, maximumAttempts: number) {
  return {
    source: row.source,
    operationId: row.operation_id,
    outboxId: row.outbox_id,
    attemptNumber: row.attempt_number,
    eventType: row.event_type,
    templateRevision: row.template_revision,
    category: row.category,
    recipientKind: row.recipient_kind,
    recipient: row.recipient,
    locale: row.locale,
    operationStatus: row.operation_status,
    operationAttempts: row.operation_attempts,
    operationLastError: row.operation_last_error,
    operationCreatedAt: row.operation_created_at,
    operationUpdatedAt: row.operation_updated_at,
    outcomeStatus: row.outcome_status,
    outcomeReason: row.outcome_reason,
    outcomeRecordedAt: row.outcome_recorded_at,
    jobId: row.job_id,
    jobStatus: row.job_status,
    jobLastError: row.job_last_error,
    jobAvailableAt: row.job_available_at,
    jobUpdatedAt: row.job_updated_at,
    isLatest: row.is_latest,
    ...retryDisposition(row, maximumAttempts),
  };
}

async function standardOperations(
  pool: DatabasePool,
  attentionOnly = false,
): Promise<StandardOperationRow[]> {
  const result = await pool.query<StandardOperationRow>(
    `SELECT 'standard'::text AS source,
            operation.id::text AS operation_id,
            operation.outbox_id::text,
            operation.attempt_number,
            operation.event_type,
            operation.template_revision,
            operation.category,
            operation.recipient_kind,
            operation.recipient::text,
            operation.locale,
            operation.status AS operation_status,
            operation.attempts AS operation_attempts,
            operation.last_error AS operation_last_error,
            pg_catalog.to_char(
              operation.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS operation_created_at,
            pg_catalog.to_char(
              operation.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS operation_updated_at,
            fact.status AS outcome_status,
            fact.failure_reason AS outcome_reason,
            CASE WHEN fact.recorded_at IS NULL THEN NULL ELSE pg_catalog.to_char(
              fact.recorded_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) END AS outcome_recorded_at,
            job.id::text AS job_id,
            job.status AS job_status,
            job.last_error AS job_last_error,
            CASE WHEN job.available_at IS NULL THEN NULL ELSE pg_catalog.to_char(
              job.available_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) END AS job_available_at,
            CASE WHEN job.updated_at IS NULL THEN NULL ELSE pg_catalog.to_char(
              job.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) END AS job_updated_at,
            NOT EXISTS (
              SELECT 1
              FROM public.notification_delivery_operations newer
              WHERE newer.outbox_id = operation.outbox_id
                AND newer.attempt_number > operation.attempt_number
            ) AS is_latest
     FROM public.notification_delivery_operations operation
     LEFT JOIN public.notification_delivery_facts fact
       ON fact.outbox_id = operation.outbox_id
      AND fact.attempt_number = operation.attempt_number
      AND fact.provider_operation_id = operation.provider_operation_id
     LEFT JOIN public.durable_jobs job
       ON job.job_type = 'notification.send'
      AND job.unique_key = 'outbox:' || operation.outbox_id::text
      AND job.payload = pg_catalog.jsonb_build_object(
        'outboxId', operation.outbox_id::text
      )
     ${attentionOnly ? `WHERE NOT EXISTS (
       SELECT 1
       FROM public.notification_delivery_operations newer
       WHERE newer.outbox_id = operation.outbox_id
         AND newer.attempt_number > operation.attempt_number
     ) AND (
       operation.status IN ('failed', 'unknown', 'manual')
       OR job.status = 'manual'
     )` : ""}
     ORDER BY operation.created_at DESC, operation.id DESC
     ${attentionOnly ? "" : "LIMIT 100"}`,
  );
  return result.rows;
}

async function identityOperations(
  pool: DatabasePool,
  attentionOnly = false,
): Promise<IdentityOperationRow[]> {
  const result = await pool.query<IdentityOperationRow>(
    `SELECT 'identity'::text AS source,
            operation.id::text AS operation_id,
            operation.outbox_id::text,
            operation.attempt_number,
            'identity.notification.' || event.kind AS event_type,
            NULL::text AS template_revision,
            'identity'::text AS category,
            'identity_user'::text AS recipient_kind,
            event.recipient::text,
            event.locale,
            operation.status AS operation_status,
            operation.reconcile_query_count AS operation_attempts,
            operation.last_error AS operation_last_error,
            pg_catalog.to_char(
              operation.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS operation_created_at,
            pg_catalog.to_char(
              operation.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS operation_updated_at,
            fact.status AS outcome_status,
            fact.failure_reason AS outcome_reason,
            CASE WHEN fact.recorded_at IS NULL THEN NULL ELSE pg_catalog.to_char(
              fact.recorded_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) END AS outcome_recorded_at,
            job.id::text AS job_id,
            job.status AS job_status,
            job.last_error AS job_last_error,
            CASE WHEN job.available_at IS NULL THEN NULL ELSE pg_catalog.to_char(
              job.available_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) END AS job_available_at,
            CASE WHEN job.updated_at IS NULL THEN NULL ELSE pg_catalog.to_char(
              job.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) END AS job_updated_at,
            NOT EXISTS (
              SELECT 1
              FROM public.identity_notification_delivery_operations newer
              WHERE newer.outbox_id = operation.outbox_id
                AND newer.attempt_number > operation.attempt_number
            ) AS is_latest
     FROM public.identity_notification_delivery_operations operation
     JOIN public.identity_notification_outbox event ON event.id = operation.outbox_id
     LEFT JOIN public.identity_notification_delivery_facts fact
       ON fact.outbox_id = operation.outbox_id
      AND fact.attempt_number = operation.attempt_number
      AND fact.provider_operation_id = operation.provider_operation_id
     LEFT JOIN public.durable_jobs job
       ON job.job_type = 'identity.notification.send'
      AND job.unique_key =
        'identity-notification:' || operation.outbox_id::text ||
        ':attempt:' || operation.attempt_number::text
      AND job.payload = pg_catalog.jsonb_build_object(
        'outboxId', operation.outbox_id::text,
        'operationId', operation.id::text,
        'attemptNumber', operation.attempt_number
      )
     ${attentionOnly ? `WHERE NOT EXISTS (
       SELECT 1
       FROM public.identity_notification_delivery_operations newer
       WHERE newer.outbox_id = operation.outbox_id
         AND newer.attempt_number > operation.attempt_number
     ) AND (
       operation.status IN ('failed', 'unknown', 'manual')
       OR job.status = 'manual'
     )` : ""}
     ORDER BY operation.created_at DESC, operation.id DESC
     ${attentionOnly ? "" : "LIMIT 100"}`,
  );
  return result.rows;
}

async function oldestNotificationTask(pool: DatabasePool): Promise<OldestTaskRow | null> {
  const result = await pool.query<OldestTaskRow>(
    `SELECT id::text, job_type, status,
            pg_catalog.to_char(
              available_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS available_at,
            pg_catalog.to_char(
              created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at,
            pg_catalog.to_char(
              updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS updated_at
     FROM public.durable_jobs
     WHERE job_type IN ('notification.send', 'identity.notification.send')
       AND status IN ('pending', 'running', 'manual')
     ORDER BY available_at, created_at, id
     LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

async function retryAudit(pool: DatabasePool): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    `SELECT id::text, actor_id, target_id, reason,
            pg_catalog.to_char(
              created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS created_at
     FROM public.audit_events
     WHERE action = 'notification.retry_requested'
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
  );
  return result.rows;
}

async function snapshot(pool: DatabasePool, maximumAttempts: number) {
  const [standard, identity, standardQueue, identityQueue, oldestTask, audit] = await Promise.all([
    standardOperations(pool),
    identityOperations(pool),
    standardOperations(pool, true),
    identityOperations(pool, true),
    oldestNotificationTask(pool),
    retryAudit(pool),
  ]);
  const history = [...standard, ...identity]
    .sort((left, right) =>
      right.operation_created_at.localeCompare(left.operation_created_at) ||
      right.operation_id.localeCompare(left.operation_id),
    )
    .slice(0, 100)
    .map((row) => operationJson(row, maximumAttempts));
  const queue = [...standardQueue, ...identityQueue]
    .sort((left, right) =>
      right.operation_updated_at.localeCompare(left.operation_updated_at) ||
      right.operation_id.localeCompare(left.operation_id),
    )
    .map((row) => operationJson(row, maximumAttempts));
  return {
    summary: {
      attentionCount: queue.length,
      failedCount: queue.filter((item) => item.operationStatus === "failed").length,
      unknownCount: queue.filter((item) => item.operationStatus === "unknown").length,
      manualCount: queue.filter(
        (item) => item.operationStatus === "manual" || item.jobStatus === "manual",
      ).length,
      retryableCount: queue.filter((item) => item.retryable).length,
      oldestTask: oldestTask
        ? {
            id: oldestTask.id,
            jobType: oldestTask.job_type,
            status: oldestTask.status,
            availableAt: oldestTask.available_at,
            createdAt: oldestTask.created_at,
            updatedAt: oldestTask.updated_at,
          }
        : null,
    },
    queue,
    history,
    retryAudit: audit.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      outboxId: row.target_id,
      reason: row.reason,
      createdAt: row.created_at,
    })),
  };
}

type LockedRetryRow = Readonly<{
  operation_id: string;
  outbox_id: string;
  attempt_number: number;
  operation_status: string;
  fact_status: string | null;
  job_id: string;
  job_status: string;
  job_updated_at: string;
}>;

async function lockRetryCandidate(
  client: DatabaseClient,
  outboxId: string,
): Promise<LockedRetryRow | null> {
  const result = await client.query<LockedRetryRow>(
    `SELECT operation.id::text AS operation_id,
            operation.outbox_id::text,
            operation.attempt_number,
            operation.status AS operation_status,
            fact.status AS fact_status,
            job.id::text AS job_id,
            job.status AS job_status,
            pg_catalog.to_char(
              job.updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS job_updated_at
     FROM public.notification_delivery_operations operation
     JOIN public.durable_jobs job
       ON job.job_type = 'notification.send'
      AND job.unique_key = 'outbox:' || operation.outbox_id::text
      AND job.payload = pg_catalog.jsonb_build_object(
        'outboxId', operation.outbox_id::text
      )
     LEFT JOIN public.notification_delivery_facts fact
       ON fact.outbox_id = operation.outbox_id
      AND fact.attempt_number = operation.attempt_number
      AND fact.provider_operation_id = operation.provider_operation_id
     WHERE operation.outbox_id = $1
     ORDER BY operation.attempt_number DESC
     LIMIT 1
     FOR UPDATE OF operation, job`,
    [outboxId],
  );
  return result.rows[0] ?? null;
}

export async function registerNotificationOperationRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/admin/notification-operations", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, "notifications.read");
    return snapshot(pool, config.NOTIFICATION_MAX_ATTEMPTS);
  });

  app.post(
    "/api/v1/admin/notification-operations/:outboxId/retry",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      const params = retryParams.parse(request.params);
      const body = retryBody.parse(request.body);
      const result = await transaction(pool, async (client) => {
        const reauthGrantId = await requireStaffActionLocked(
          client,
          user,
          "notifications.retry",
        );
        const outbox = await client.query(
          `SELECT id FROM public.outbox WHERE id = $1 FOR UPDATE`,
          [params.outboxId],
        );
        if (outbox.rowCount !== 1) {
          throw requestError("Notification delivery was not found", 404, "NOTIFICATION_NOT_FOUND");
        }
        const candidate = await lockRetryCandidate(client, params.outboxId);
        if (!candidate) {
          throw requestError(
            "Notification delivery task is unavailable",
            409,
            "NOTIFICATION_RETRY_UNAVAILABLE",
          );
        }
        if (candidate.job_updated_at !== body.expectedJobUpdatedAt) {
          throw requestError(
            "Notification delivery changed; refresh before retrying",
            409,
            "NOTIFICATION_RETRY_STALE",
          );
        }
        if (
          candidate.operation_status !== "failed" ||
          candidate.fact_status !== "failed" ||
          candidate.job_status !== "manual" ||
          candidate.attempt_number >= config.NOTIFICATION_MAX_ATTEMPTS
        ) {
          throw requestError(
            "Only a manual task with an explicit failed outcome and remaining attempt budget can retry",
            409,
            "NOTIFICATION_RETRY_NOT_ALLOWED",
          );
        }
        const updated = await client.query<{ updated_at: string }>(
          `UPDATE public.durable_jobs
           SET status = 'pending',
               attempts = 0,
               available_at = pg_catalog.clock_timestamp(),
               locked_at = NULL,
               locked_by = NULL,
               last_error = 'STAFF_NOTIFICATION_RETRY_REQUESTED',
               updated_at = GREATEST(
                 updated_at + interval '1 microsecond',
                 pg_catalog.clock_timestamp()
               )
           WHERE id = $1
             AND status = 'manual'
             AND pg_catalog.to_char(
               updated_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) = $2
           RETURNING pg_catalog.to_char(
             updated_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) AS updated_at`,
          [candidate.job_id, body.expectedJobUpdatedAt],
        );
        const updatedAt = updated.rows[0]?.updated_at;
        if (!updatedAt) {
          throw requestError(
            "Notification delivery changed; refresh before retrying",
            409,
            "NOTIFICATION_RETRY_STALE",
          );
        }
        await client.query(
          `INSERT INTO public.audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES (
             'staff', $1, 'notification.retry_requested',
             'notification_outbox', $2, $3, $4
           )`,
          [
            user.userId,
            params.outboxId,
            body.reason,
            {
              operationId: candidate.operation_id,
              failedAttemptNumber: candidate.attempt_number,
              durableJobId: candidate.job_id,
              previousJobUpdatedAt: candidate.job_updated_at,
              reauthGrantId,
            },
          ],
        );
        return {
          outboxId: params.outboxId,
          failedAttemptNumber: candidate.attempt_number,
          jobStatus: "pending" as const,
          jobUpdatedAt: updatedAt,
        };
      });
      return reply.code(201).send(result);
    },
  );
}
