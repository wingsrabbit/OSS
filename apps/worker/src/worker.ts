// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac, randomUUID } from "node:crypto";
import { isPaymentBusinessStatePayable } from "@opensales/core";
import {
  providerOperationCapability,
  providerOperationCapabilityMatches,
} from "@opensales/core/provider-capability";
import { assert014RollbackBridgeSafe } from "@opensales/core/schema-rollback-compatibility";
import pg from "pg";
import { z } from "zod";
import { ensureScheduledBillingJob } from "./billing-scheduler.js";
import { attemptJobClaim } from "./job-claim.js";

const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    MOCK_PAYMENT_PROVIDER_URL: z.url(),
    MOCK_PROVISIONING_PROVIDER_URL: z.url(),
    MOCK_MAIL_PROVIDER_URL: z.url(),
    MOCK_PAYMENT_PROVIDER_TOKEN: z.string().min(32),
    MOCK_PROVISIONING_PROVIDER_TOKEN: z.string().min(32),
    MOCK_MAIL_PROVIDER_TOKEN: z.string().min(32),
    PROVIDER_OPERATION_CAPABILITY_SECRET: z.string().min(32),
    OSS_SCHEMA_ROLLBACK_BRIDGE: z.enum(["disabled", "014-to-015"]).optional(),
    MOCK_PAYMENT_WEBHOOK_SECRET: z.string().min(32),
    MOCK_PROVISIONING_WEBHOOK_SECRET: z.string().min(32),
    CORE_INTERNAL_URL: z.url().default("http://api:3000"),
    WORKER_ID: z.string().default(`worker-${process.pid}`),
    WORKER_POLL_MS: z.coerce.number().int().positive().default(500),
    PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
    JOB_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
    MAX_JOB_ATTEMPTS: z.coerce.number().int().positive().default(8),
    RECONCILE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
    RECONCILE_BASE_DELAY_SECONDS: z.coerce.number().int().positive().default(3),
    WATCHDOG_DELAY_SECONDS: z.coerce.number().int().positive().default(10),
    MOCK_PROVISION_SCENARIO: z
      .enum(["success", "failed", "timeout_existing"])
      .default("success"),
    MOCK_RESOURCE_ACTION_SCENARIO: z
      .enum(["success", "failed", "timeout_success", "duplicate_out_of_order"])
      .default("success"),
  })
  .parse(process.env);

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  statement_timeout: 15_000,
  application_name: "opensales-worker",
});

type Job = {
  id: string;
  job_type: string;
  unique_key: string;
  payload: Record<string, string>;
  attempts: number;
};

type DatabaseClient = pg.PoolClient;

class LostJobLeaseError extends Error {
  constructor(jobId: string) {
    super(`durable job lease was lost: ${jobId}`);
    this.name = "LostJobLeaseError";
  }
}

async function transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockProviderOperation(client: DatabaseClient, operationId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `provider-operation:${operationId}`,
  ]);
}

async function assertJobLeaseWithClient(client: DatabaseClient, job: Job): Promise<void> {
  const result = await client.query(
    `SELECT id
     FROM durable_jobs
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $2
       AND attempts = $3
     FOR UPDATE`,
    [job.id, config.WORKER_ID, job.attempts],
  );
  if (result.rowCount !== 1) throw new LostJobLeaseError(job.id);
}

function reconcileDelaySeconds(attempts: number): number {
  return Math.min(
    300,
    config.RECONCILE_BASE_DELAY_SECONDS * 2 ** Math.min(Math.max(attempts - 1, 0), 6),
  );
}

async function completeJobWithClient(client: DatabaseClient, job: Job): Promise<void> {
  const result = await client.query(
    `UPDATE durable_jobs
     SET status = 'completed', locked_at = NULL, locked_by = NULL, last_error = NULL,
         updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $2
       AND attempts = $3
     RETURNING id`,
    [job.id, config.WORKER_ID, job.attempts],
  );
  if (result.rowCount !== 1) throw new LostJobLeaseError(job.id);
}

async function manualJobWithClient(
  client: DatabaseClient,
  job: Job,
  reason: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE durable_jobs
     SET status = 'manual', locked_at = NULL, locked_by = NULL, last_error = $2,
         updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $3
       AND attempts = $4
     RETURNING id`,
    [job.id, reason.slice(0, 1_000), config.WORKER_ID, job.attempts],
  );
  if (result.rowCount !== 1) throw new LostJobLeaseError(job.id);
}

async function enqueueReconcileWithClient(
  client: DatabaseClient,
  jobType:
    | "payment.reconcile"
    | "add_funds.reconcile"
    | "provision.reconcile"
    | "refund.reconcile"
    | "service.suspend.reconcile"
    | "service.resume.reconcile"
    | "service.cancellation.reconcile",
  uniqueKey: string,
  payload: Record<string, string>,
  delaySeconds: number,
): Promise<void> {
  await client.query(
    `INSERT INTO durable_jobs(job_type, unique_key, payload, available_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     ON CONFLICT (job_type, unique_key) DO UPDATE
       SET payload = EXCLUDED.payload,
           status = CASE
             WHEN durable_jobs.status = 'manual' THEN 'manual'
             ELSE 'pending'
           END,
           available_at = CASE
             WHEN durable_jobs.status = 'manual' THEN durable_jobs.available_at
             ELSE EXCLUDED.available_at
           END,
           locked_at = NULL,
           locked_by = NULL,
           updated_at = now()`,
    [jobType, uniqueKey, payload, delaySeconds],
  );
}

async function lockStaleJobWithClient(
  client: DatabaseClient,
  candidate: Job,
): Promise<Job | null> {
  const result = await client.query<Job>(
    `SELECT id, job_type, unique_key, payload, attempts
     FROM durable_jobs
     WHERE id = $1
       AND status = 'running'
       AND attempts = $2
       AND locked_at < now() - make_interval(secs => $3)
     FOR UPDATE`,
    [candidate.id, candidate.attempts, config.JOB_LOCK_TIMEOUT_SECONDS],
  );
  return result.rows[0] ?? null;
}

async function completeRecoveredJobWithClient(client: DatabaseClient, job: Job): Promise<void> {
  await client.query(
    `UPDATE durable_jobs
     SET status = 'completed', locked_at = NULL, locked_by = NULL, last_error = NULL,
         updated_at = now()
     WHERE id = $1 AND status = 'running' AND attempts = $2`,
    [job.id, job.attempts],
  );
}

async function manualRecoveredJobWithClient(
  client: DatabaseClient,
  job: Job,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE durable_jobs
     SET status = 'manual', locked_at = NULL, locked_by = NULL, last_error = $3,
         updated_at = now()
     WHERE id = $1 AND status = 'running' AND attempts = $2`,
    [job.id, job.attempts, reason.slice(0, 1_000)],
  );
}

async function recoverOneStaleJob(candidate: Job): Promise<boolean> {
  const sideEffecting = ["payment.start", "add_funds.start", "provision.start"].includes(
    candidate.job_type,
  );
  if (!sideEffecting) {
    return transaction(async (client) => {
      const job = await lockStaleJobWithClient(client, candidate);
      if (!job) return false;
      const maxAttempts = job.job_type.endsWith(".reconcile")
        ? config.RECONCILE_MAX_ATTEMPTS
        : config.MAX_JOB_ATTEMPTS;
      const manual = job.attempts >= maxAttempts;
      await client.query(
        `UPDATE durable_jobs
         SET status = $3,
             available_at = CASE
               WHEN $3 = 'pending' THEN now() + make_interval(secs => $4)
               ELSE available_at
             END,
             locked_at = NULL,
             locked_by = NULL,
             last_error = 'worker lock expired; job recovered without replaying a create operation',
             updated_at = now()
         WHERE id = $1 AND status = 'running' AND attempts = $2`,
        [job.id, job.attempts, manual ? "manual" : "pending", reconcileDelaySeconds(job.attempts)],
      );
      return true;
    });
  }

  const payment = candidate.job_type === "payment.start";
  const addFunds = candidate.job_type === "add_funds.start";
  const subjectId = payment
    ? candidate.payload.paymentAttemptId
    : addFunds
      ? candidate.payload.addFundsAttemptId
      : candidate.payload.serviceId;
  const operationId = candidate.payload.providerOperationId;
  if (!subjectId || !operationId) {
    return transaction(async (client) => {
      const job = await lockStaleJobWithClient(client, candidate);
      if (!job) return false;
      await manualRecoveredJobWithClient(
        client,
        job,
        "stale side-effecting job has an invalid payload; manual inspection required",
      );
      return true;
    });
  }

  return transaction(async (client) => {
    await lockProviderOperation(client, operationId);
    const operation = await client.query<{ status: string; attempt_count: number }>(
      `SELECT status, attempt_count
       FROM provider_operations
       WHERE id = $1
       FOR UPDATE`,
      [operationId],
    );
    const job = await lockStaleJobWithClient(client, candidate);
    if (!job) return false;
    const operationRecord = operation.rows[0];
    if (!operationRecord) {
      await manualRecoveredJobWithClient(
        client,
        job,
        "stale side-effecting job references a missing provider operation",
      );
      return true;
    }
    if (operationRecord.status === "succeeded" || operationRecord.status === "failed") {
      await completeRecoveredJobWithClient(client, job);
      return true;
    }
    if (operationRecord.status === "queued" && operationRecord.attempt_count === 0) {
      const manual = job.attempts >= config.MAX_JOB_ATTEMPTS;
      await client.query(
        `UPDATE durable_jobs
         SET status = $3,
             available_at = CASE
               WHEN $3 = 'pending' THEN now() + make_interval(secs => $4)
               ELSE available_at
             END,
             locked_at = NULL,
             locked_by = NULL,
             last_error = 'worker lock expired before the provider create attempt began',
             updated_at = now()
         WHERE id = $1 AND status = 'running' AND attempts = $2`,
        [job.id, job.attempts, manual ? "manual" : "pending", reconcileDelaySeconds(job.attempts)],
      );
      return true;
    }

    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown',
           last_error = 'worker lock expired after a possible provider request; reconciliation required',
           updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [operationId],
    );
    if (payment) {
      await client.query(
        `UPDATE payment_attempts
         SET status = 'unknown', updated_at = now(), version = version + 1
         WHERE id = $1
           AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
        [subjectId],
      );
      await client.query(
        `UPDATE invoice_payment_commands
         SET status = 'unknown', result = $2, updated_at = now()
         WHERE payment_attempt_id = $1
           AND status NOT IN ('manual', 'succeeded', 'failed')`,
        [subjectId, { paymentStatus: "unknown", reason: "worker lock expired after a possible Provider request" }],
      );
    } else if (addFunds) {
      await client.query(
        `UPDATE add_funds_attempts
         SET status = 'unknown', updated_at = now(), version = version + 1
         WHERE id = $1
           AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
        [subjectId],
      );
      await client.query(
        `UPDATE add_funds_commands
         SET status = 'unknown', result = $2, updated_at = now()
         WHERE add_funds_attempt_id = $1
           AND status NOT IN ('manual', 'succeeded', 'failed', 'cancelled', 'expired')`,
        [subjectId, { paymentStatus: "unknown", reason: "worker lock expired after a possible Provider request" }],
      );
    } else {
      await client.query(
        `UPDATE services
         SET status = 'confirming', updated_at = now(), version = version + 1
         WHERE id = $1 AND status IN ('pending', 'provisioning', 'confirming')`,
        [subjectId],
      );
    }
    await enqueueReconcileWithClient(
      client,
      payment ? "payment.reconcile" : addFunds ? "add_funds.reconcile" : "provision.reconcile",
      job.unique_key,
      { ...job.payload, operationId },
      config.RECONCILE_BASE_DELAY_SECONDS,
    );
    await completeRecoveredJobWithClient(client, job);
    return true;
  });
}

async function recoverStaleJobs(): Promise<number> {
  const candidates = await pool.query<Job>(
    `SELECT id, job_type, unique_key, payload, attempts
     FROM durable_jobs
     WHERE status = 'running'
       AND locked_at < now() - make_interval(secs => $1)
       AND job_type NOT IN (
         'refund.start', 'refund.reconcile',
         'service.suspend.start', 'service.suspend.reconcile',
         'service.resume.start', 'service.resume.reconcile',
         'service.cancellation.due', 'service.cancellation.reconcile'
       )
     ORDER BY locked_at, created_at
     LIMIT 50`,
    [config.JOB_LOCK_TIMEOUT_SECONDS],
  );
  let recovered = 0;
  for (const candidate of candidates.rows) {
    if (await recoverOneStaleJob(candidate)) recovered += 1;
  }
  return recovered;
}

async function recoverOneStaleRefundJob(candidate: Job): Promise<boolean> {
  const refundId = candidate.payload.refundId;
  const operationId = candidate.payload.operationId ?? candidate.payload.providerOperationId;
  if (!refundId || !operationId) {
    return transaction(async (client) => {
      const job = await lockStaleJobWithClient(client, candidate);
      if (!job) return false;
      await manualRecoveredJobWithClient(
        client,
        job,
        "stale refund job has an invalid payload; manual inspection required",
      );
      return true;
    });
  }

  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `refund:${refundId}`,
    ]);
    const pointer = await client.query<{ source_fund_receipt_id: string }>(
      "SELECT source_fund_receipt_id FROM refunds WHERE id = $1",
      [refundId],
    );
    const receiptId = pointer.rows[0]?.source_fund_receipt_id;
    if (receiptId) {
      await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [receiptId]);
    }
    const state = await client.query<{
      refund_status: string;
      operation_status: string;
      attempt_count: number;
    }>(
      `SELECT
         refund.status AS refund_status,
         operation.status AS operation_status,
         operation.attempt_count
       FROM refunds refund
       JOIN provider_operations operation
         ON operation.id = $2
        AND operation.subject_type = 'refund'
        AND operation.subject_id = refund.id
        AND operation.kind = 'refund_create'
       WHERE refund.id = $1
       FOR UPDATE OF refund, operation`,
      [refundId, operationId],
    );
    const currentJob = await client.query<Job>(
      `SELECT id, job_type, unique_key, payload, attempts
       FROM durable_jobs
       WHERE id = $1
         AND status = 'running'
         AND attempts = $2
         AND locked_at < now() - make_interval(secs => $3)
       FOR UPDATE`,
      [candidate.id, candidate.attempts, config.JOB_LOCK_TIMEOUT_SECONDS],
    );
    const job = currentJob.rows[0];
    if (!job) return false;
    const record = state.rows[0];
    if (!receiptId || !record) {
      await manualRecoveredJobWithClient(
        client,
        job,
        !receiptId
          ? "stale refund job references a missing refund"
          : "stale refund job references a mismatched Provider operation",
      );
      return true;
    }
    if (
      record.refund_status === "succeeded" ||
      record.refund_status === "failed" ||
      record.operation_status === "succeeded" ||
      record.operation_status === "failed"
    ) {
      await completeRecoveredJobWithClient(client, job);
      return true;
    }
    if (job.job_type === "refund.reconcile") {
      const manual = job.attempts >= config.RECONCILE_MAX_ATTEMPTS;
      if (manual) {
        const reason =
          "refund reconciliation exhausted after a stale worker lock; human review is required";
        const changed = await client.query(
          `UPDATE refunds
           SET status = 'manual', last_error = $2,
               result = result || $3::jsonb,
               updated_at = now(), version = version + 1
           WHERE id = $1
             AND status IN ('queued', 'processing', 'unknown')
             AND security_hold = false`,
          [refundId, reason, JSON.stringify({ reconciliationExhausted: true })],
        );
        await client.query(
          `UPDATE provider_operations
           SET status = 'unknown', last_error = $2, updated_at = now()
           WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
          [operationId, reason],
        );
        if ((changed.rowCount ?? 0) > 0) {
          await client.query(
            `INSERT INTO refund_events(
               refund_id, event_type, actor_type, actor_id, reason, metadata
             ) VALUES ($1, 'manual', 'system', $2, $3, $4)`,
            [
              refundId,
              config.WORKER_ID,
              reason,
              { providerOperationId: operationId, reconciliationExhausted: true },
            ],
          );
          await client.query(
            `INSERT INTO audit_events(
               actor_type, actor_id, action, target_type, target_id, reason, metadata
             ) VALUES ('system', $1, 'refund.reconciliation_exhausted', 'refund', $2, $3, $4)`,
            [
              config.WORKER_ID,
              refundId,
              reason,
              { providerOperationId: operationId, attempts: job.attempts },
            ],
          );
        }
        await manualRecoveredJobWithClient(client, job, reason);
        return true;
      }
      await client.query(
        `UPDATE durable_jobs
         SET status = 'pending',
             available_at = now() + make_interval(secs => $2),
             locked_at = NULL,
             locked_by = NULL,
             last_error = 'worker lock expired during refund reconciliation; safe GET may resume',
             updated_at = now()
         WHERE id = $1`,
        [job.id, reconcileDelaySeconds(job.attempts)],
      );
      return true;
    }
    if (record.operation_status === "queued" && record.attempt_count === 0) {
      const manual = job.attempts >= config.MAX_JOB_ATTEMPTS;
      if (manual) {
        await failKnownUnsentRefund(
          client,
          job,
          refundId,
          operationId,
          "refund create never began before stale-lock retry exhaustion; no Provider outflow was sent",
          true,
        );
        return true;
      }
      await client.query(
        `UPDATE durable_jobs
         SET status = 'pending',
             available_at = now() + make_interval(secs => $2),
             locked_at = NULL,
             locked_by = NULL,
             last_error = 'worker lock expired before refund create began',
             updated_at = now()
         WHERE id = $1`,
        [job.id, reconcileDelaySeconds(job.attempts)],
      );
      return true;
    }

    const reason =
      "worker lock expired after a possible refund request; reconciliation required";
    await client.query(
      `UPDATE refunds
       SET status = 'unknown', last_error = $2,
           updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'processing'`,
      [refundId, reason],
    );
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [operationId, reason],
    );
    await client.query(
      `INSERT INTO refund_events(
         refund_id, event_type, actor_type, actor_id, reason, metadata
       ) VALUES ($1, 'unknown', 'system', $2, $3, $4)`,
      [refundId, config.WORKER_ID, reason, { providerOperationId: operationId }],
    );
    await enqueueReconcileWithClient(
      client,
      "refund.reconcile",
      job.unique_key,
      { ...job.payload, operationId },
      config.RECONCILE_BASE_DELAY_SECONDS,
    );
    await completeRecoveredJobWithClient(client, job);
    return true;
  });
}

async function recoverStaleRefundJobs(): Promise<number> {
  const candidates = await pool.query<Job>(
    `SELECT id, job_type, unique_key, payload, attempts
     FROM durable_jobs
     WHERE status = 'running'
       AND job_type IN ('refund.start', 'refund.reconcile')
       AND locked_at < now() - make_interval(secs => $1)
     ORDER BY locked_at, created_at
     LIMIT 50`,
    [config.JOB_LOCK_TIMEOUT_SECONDS],
  );
  let recovered = 0;
  for (const candidate of candidates.rows) {
    if (await recoverOneStaleRefundJob(candidate)) recovered += 1;
  }
  return recovered;
}

async function claimJob(): Promise<Job | null> {
  const result = await pool.query<Job>(
    `WITH candidate AS (
       SELECT id
       FROM durable_jobs
       WHERE status = 'pending' AND available_at <= now()
       ORDER BY available_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE durable_jobs job
     SET status = 'running',
         attempts = job.attempts + 1,
         locked_at = now(),
         locked_by = $1,
         updated_at = now()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.id, job.job_type, job.unique_key, job.payload, job.attempts`,
    [config.WORKER_ID],
  );
  return result.rows[0] ?? null;
}

async function completeJob(job: Job): Promise<void> {
  const result = await pool.query(
    `UPDATE durable_jobs
     SET status = 'completed', locked_at = NULL, locked_by = NULL, last_error = NULL,
         updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $2
       AND attempts = $3
     RETURNING id`,
    [job.id, config.WORKER_ID, job.attempts],
  );
  if (result.rowCount !== 1) throw new LostJobLeaseError(job.id);
}

async function failJob(job: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 1_000) : "unknown worker error";
  const maxAttempts = job.job_type.endsWith(".reconcile")
    ? config.RECONCILE_MAX_ATTEMPTS
    : config.MAX_JOB_ATTEMPTS;
  const manual = job.attempts >= maxAttempts;
  const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
  const result = await pool.query(
    `UPDATE durable_jobs
     SET status = $2,
         available_at = now() + make_interval(secs => $3),
         locked_at = NULL,
         locked_by = NULL,
         last_error = $4,
         updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $5
       AND attempts = $6`,
    [
      job.id,
      manual ? "manual" : "pending",
      delaySeconds,
      message,
      config.WORKER_ID,
      job.attempts,
    ],
  );
  if (result.rowCount !== 1) {
    console.warn("discarded job failure after durable job lease loss", {
      jobId: job.id,
      jobType: job.job_type,
      attempts: job.attempts,
    });
  }
}

async function providerRequest(
  providerUrl: string,
  providerToken: string,
  path: string,
  init: RequestInit,
  timeoutMs = config.PROVIDER_TIMEOUT_MS,
): Promise<Response> {
  return fetch(new URL(path, providerUrl), {
    ...init,
    headers: {
      Authorization: `Bearer ${providerToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
}

async function markUnknown(
  job: Job,
  operationId: string,
  subjectTable: "payment_attempts" | "add_funds_attempts" | "services",
  subjectId: string,
  reconcileType: "payment.reconcile" | "add_funds.reconcile" | "provision.reconcile",
  reason: string,
): Promise<void> {
  await transaction(async (client) => {
    await lockProviderOperation(client, operationId);
    await assertJobLeaseWithClient(client, job);
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2,
           updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [operationId, reason.slice(0, 1_000)],
    );
    if (subjectTable === "payment_attempts") {
      await client.query(
        `UPDATE payment_attempts
         SET status = 'unknown', updated_at = now(), version = version + 1
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
        [subjectId],
      );
      await client.query(
        `UPDATE invoice_payment_commands
         SET status = 'unknown', result = $2, updated_at = now()
         WHERE payment_attempt_id = $1
           AND status NOT IN ('manual', 'succeeded', 'failed')`,
        [subjectId, { paymentStatus: "unknown", reason: reason.slice(0, 1_000) }],
      );
    } else if (subjectTable === "add_funds_attempts") {
      await client.query(
        `UPDATE add_funds_attempts
         SET status = 'unknown', updated_at = now(), version = version + 1
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
        [subjectId],
      );
      await client.query(
        `UPDATE add_funds_commands
         SET status = 'unknown', result = $2, updated_at = now()
         WHERE add_funds_attempt_id = $1
           AND status NOT IN ('manual', 'succeeded', 'failed', 'cancelled', 'expired')`,
        [subjectId, { paymentStatus: "unknown", reason: reason.slice(0, 1_000) }],
      );
    } else {
      await client.query(
        `UPDATE services
         SET status = 'confirming', updated_at = now(), version = version + 1
         WHERE id = $1 AND status IN ('pending', 'provisioning', 'confirming')`,
        [subjectId],
      );
    }
    await enqueueReconcileWithClient(
      client,
      reconcileType,
      job.unique_key,
      { ...job.payload, operationId },
      config.RECONCILE_BASE_DELAY_SECONDS,
    );
    await completeJobWithClient(client, job);
  });
}

type PaymentCall = {
  amountMinor: string;
  currency: string;
  scenario: string;
};

type PreflightResult<T> = { kind: "call"; value: T } | { kind: "halted" };

async function reverseInvoiceCreditApplicationWithClient(
  client: DatabaseClient,
  paymentAttemptId: string,
  reason: string,
): Promise<string> {
  const commandResult = await client.query<{ id: string; invoice_id: string }>(
    `SELECT id, invoice_id
     FROM invoice_payment_commands
     WHERE payment_attempt_id = $1
     FOR UPDATE`,
    [paymentAttemptId],
  );
  const command = commandResult.rows[0];
  if (!command) return "0";
  const originalResult = await client.query<{
    credit_account_id: string;
    debit_minor: string;
    currency: string;
  }>(
    `SELECT ct.credit_account_id, ct.debit_minor::text, ca.currency
     FROM credit_transactions ct
     JOIN credit_accounts ca ON ca.id = ct.credit_account_id
     WHERE ct.kind = 'invoice_application'
       AND ct.source_type = 'invoice_payment_command'
       AND ct.source_id = $1`,
    [command.id],
  );
  const original = originalResult.rows[0];
  if (!original || BigInt(original.debit_minor) === 0n) return "0";
  const priorReversal = await client.query(
    `SELECT id
     FROM credit_transactions
     WHERE kind = 'invoice_application_reversal'
       AND source_type = 'invoice_payment_command_reversal'
       AND source_id = $1`,
    [command.id],
  );
  if (priorReversal.rowCount) return original.debit_minor;

  await client.query("SELECT id FROM credit_accounts WHERE id = $1 FOR UPDATE", [
    original.credit_account_id,
  ]);
  const reversalId = randomUUID();
  await client.query(
    `INSERT INTO credit_transactions(
       id, credit_account_id, kind, credit_minor, debit_minor,
       source_type, source_id, actor_type, actor_id, reason,
       idempotency_key, request_fingerprint
     ) VALUES (
       $1, $2, 'invoice_application_reversal', $3, 0,
       'invoice_payment_command_reversal', $4, 'system', NULL, $5, $6, $7
     )`,
    [
      reversalId,
      original.credit_account_id,
      original.debit_minor,
      command.id,
      reason,
      `invoice-credit-reversal:${command.id}`,
      `invoice-credit-reversal:v1:${paymentAttemptId}`,
    ],
  );
  await client.query(
    `INSERT INTO credit_allocations(credit_transaction_id, invoice_id, amount_minor)
     VALUES ($1, $2, $3)`,
    [reversalId, command.invoice_id, `-${original.debit_minor}`],
  );
  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('invoice_credit_application_reversal', $1, $2, 'Credit restored after payment failure')
     RETURNING id`,
    [reversalId, original.currency],
  );
  const journalId = journal.rows[0]?.id;
  if (!journalId) throw new Error("Unable to create Credit reversal journal");
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'accounts_receivable', $2, 0),
       ($1, 'client_credit_liability', 0, $2)`,
    [journalId, original.debit_minor],
  );
  return original.debit_minor;
}

async function cancelKnownUnsentPaymentWithClient(
  client: DatabaseClient,
  job: Job,
  operationId: string,
  paymentAttemptId: string,
  orderId: string,
  reason: string,
  holdOrder: boolean,
): Promise<PreflightResult<never>> {
  const creditRestoredMinor = await reverseInvoiceCreditApplicationWithClient(
    client,
    paymentAttemptId,
    reason,
  );
  await client.query(
    `UPDATE payment_attempts
     SET status = 'cancelled', updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'created'`,
    [paymentAttemptId],
  );
  await client.query(
    `UPDATE provider_operations
     SET status = 'failed', last_error = $2, updated_at = now()
     WHERE id = $1 AND status <> 'succeeded'`,
    [operationId, reason.slice(0, 1_000)],
  );
  await client.query(
    `UPDATE invoice_payment_commands
     SET status = 'failed', result = $2, updated_at = now()
     WHERE payment_attempt_id = $1`,
    [
      paymentAttemptId,
      { paymentStatus: "cancelled", reason: reason.slice(0, 1_000), creditRestoredMinor },
    ],
  );
  if (holdOrder) {
    await client.query(
      `UPDATE orders
       SET status = 'on_hold', updated_at = now(), version = version + 1
       WHERE id = $1
         AND status IN ('waiting_payment', 'accepted', 'awaiting_manual', 'fulfilling')`,
      [orderId],
    );
  }
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES ('system', $1, 'payment.known_unsent_cancelled', 'payment', $2, $3, $4)`,
    [
      config.WORKER_ID,
      paymentAttemptId,
      reason.slice(0, 1_000),
      { providerOperationId: operationId, orderId, creditRestoredMinor, holdOrder },
    ],
  );
  await completeJobWithClient(client, job);
  return { kind: "halted" };
}

async function holdPaymentWithClient(
  client: DatabaseClient,
  job: Job,
  operationId: string,
  orderId: string,
  reason: string,
): Promise<PreflightResult<never>> {
  await client.query(
    `UPDATE orders
     SET status = 'on_hold', updated_at = now(), version = version + 1
     WHERE id = $1
       AND status IN ('waiting_payment', 'accepted', 'awaiting_manual', 'fulfilling')`,
    [orderId],
  );
  await client.query(
    `UPDATE provider_operations
     SET status = 'unknown', last_error = $2, updated_at = now()
     WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
    [operationId, reason.slice(0, 1_000)],
  );
  await client.query(
    `UPDATE payment_attempts
     SET status = 'unknown', updated_at = now(), version = version + 1
     WHERE id = (
       SELECT subject_id
       FROM provider_operations
       WHERE id = $1 AND subject_type = 'payment'
     )
       AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
    [operationId],
  );
  await client.query(
    `UPDATE invoice_payment_commands
     SET status = 'manual', result = $2, updated_at = now()
     WHERE payment_attempt_id = (
       SELECT subject_id
       FROM provider_operations
       WHERE id = $1 AND subject_type = 'payment'
     )
       AND status NOT IN ('succeeded', 'failed')`,
    [operationId, { paymentStatus: "unknown", reason: reason.slice(0, 1_000) }],
  );
  await manualJobWithClient(client, job, reason);
  return { kind: "halted" };
}

async function preflightPayment(
  job: Job,
  paymentAttemptId: string,
  providerOperationId: string,
  mode: "start" | "reconcile",
): Promise<PreflightResult<PaymentCall>> {
  return transaction(async (client) => {
    await lockProviderOperation(client, providerOperationId);
    await assertJobLeaseWithClient(client, job);
    const paymentPointer = await client.query<{ invoice_id: string }>(
      "SELECT invoice_id FROM payment_attempts WHERE id = $1",
      [paymentAttemptId],
    );
    const invoiceId = paymentPointer.rows[0]?.invoice_id;
    if (!invoiceId) {
      await manualJobWithClient(client, job, "payment job references a missing Payment Attempt");
      return { kind: "halted" };
    }
    await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
    await client.query("SELECT id FROM payment_attempts WHERE id = $1 FOR UPDATE", [
      paymentAttemptId,
    ]);
    await client.query(
      `SELECT id
       FROM provider_operations
       WHERE id = $1
         AND subject_type = 'payment'
         AND subject_id = $2
       FOR UPDATE`,
      [providerOperationId, paymentAttemptId],
    );
    const lockPointers = await client.query<{
      order_id: string;
      service_id: string;
      payer_user_id: string;
      client_account_id: string;
    }>(
      `SELECT order_id, service_id, payer_user_id, client_account_id
       FROM (
         SELECT original_order.id AS order_id,
                service.id AS service_id,
                command.initiated_by_user_id AS payer_user_id,
                original_order.client_account_id
         FROM invoices invoice
         JOIN orders original_order ON original_order.id = invoice.order_id
         JOIN order_items item ON item.order_id = original_order.id
         JOIN services service ON service.order_item_id = item.id
         JOIN invoice_payment_commands command
           ON command.invoice_id = invoice.id
          AND command.payment_attempt_id = $2
          AND command.initiator_type = 'user'
         WHERE invoice.id = $1

         UNION ALL

         SELECT original_order.id AS order_id,
                service.id AS service_id,
                command.initiated_by_user_id AS payer_user_id,
                service.client_account_id
         FROM invoices invoice
         JOIN service_renewals renewal ON renewal.invoice_id = invoice.id
         JOIN services service ON service.id = renewal.service_id
         JOIN order_items item ON item.id = service.order_item_id
         JOIN orders original_order ON original_order.id = item.order_id
         JOIN invoice_payment_commands command
           ON command.invoice_id = invoice.id
          AND command.payment_attempt_id = $2
          AND command.initiator_type = 'user'
         WHERE invoice.id = $1
       ) identity`,
      [invoiceId, paymentAttemptId],
    );
    const lockPointer = lockPointers.rows[0];
    if (lockPointer) {
      await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
        lockPointer.order_id,
      ]);
      await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
        lockPointer.service_id,
      ]);
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
        lockPointer.payer_user_id,
      ]);
      await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
        lockPointer.client_account_id,
      ]);
    }
    const result = await client.query<{
      payment_status: string;
      amount_minor: string;
      principal_minor: string | null;
      fee_minor: string;
      payment_currency: string;
      scenario: string;
      payment_provider_installation_id: string;
      payment_client_account_id: string;
      invoice_id: string;
      invoice_total_minor: string;
      invoice_currency: string;
      invoice_client_account_id: string;
      order_id: string;
      order_status: string;
      order_currency: string;
      order_client_account_id: string;
      payer_user_id: string;
      payment_context: "order" | "renewal";
      service_status: string;
      renewal_status: string | null;
      email_verified_at: Date | null;
      user_restricted_at: Date | null;
      account_restricted_at: Date | null;
      operation_status: string;
      operation_provider_installation_id: string;
      operation_kind: string;
      operation_attempt_count: number;
    }>(
      `WITH payment_identity AS (
         SELECT original_order.id AS order_id,
                original_order.status AS order_status,
                original_order.currency AS order_currency,
                original_order.client_account_id AS order_client_account_id,
                command.initiated_by_user_id AS payer_user_id,
                'order'::text AS payment_context,
                service.status AS service_status,
                NULL::text AS renewal_status
         FROM invoices invoice
         JOIN orders original_order ON original_order.id = invoice.order_id
         JOIN order_items item ON item.order_id = original_order.id
         JOIN services service ON service.order_item_id = item.id
         JOIN invoice_payment_commands command
           ON command.invoice_id = invoice.id
          AND command.payment_attempt_id = $1
          AND command.initiator_type = 'user'
         WHERE invoice.id = $3

         UNION ALL

         SELECT original_order.id AS order_id,
                original_order.status AS order_status,
                original_order.currency AS order_currency,
                service.client_account_id AS order_client_account_id,
                command.initiated_by_user_id AS payer_user_id,
                'renewal'::text AS payment_context,
                service.status AS service_status,
                renewal.status AS renewal_status
         FROM invoices invoice
         JOIN service_renewals renewal ON renewal.invoice_id = invoice.id
         JOIN services service ON service.id = renewal.service_id
         JOIN order_items item ON item.id = service.order_item_id
         JOIN orders original_order ON original_order.id = item.order_id
         JOIN invoice_payment_commands command
           ON command.invoice_id = invoice.id
          AND command.payment_attempt_id = $1
          AND command.initiator_type = 'user'
         WHERE invoice.id = $3
       )
       SELECT
         pa.status AS payment_status, pa.amount_minor::text, pa.principal_minor::text,
         pa.fee_minor::text, pa.currency AS payment_currency,
         pa.scenario, pa.provider_installation_id AS payment_provider_installation_id,
         pa.client_account_id AS payment_client_account_id, pa.invoice_id,
         i.total_minor::text AS invoice_total_minor, i.currency AS invoice_currency,
         i.client_account_id AS invoice_client_account_id,
         identity.order_id, identity.order_status, identity.order_currency,
         identity.order_client_account_id, identity.payer_user_id,
         identity.payment_context, identity.service_status, identity.renewal_status,
         u.email_verified_at, u.restricted_at AS user_restricted_at,
         ca.restricted_at AS account_restricted_at,
         po.status AS operation_status,
         po.provider_installation_id AS operation_provider_installation_id,
         po.kind AS operation_kind,
         po.attempt_count AS operation_attempt_count
       FROM payment_attempts pa
       JOIN invoices i ON i.id = pa.invoice_id
       JOIN payment_identity identity ON true
       JOIN users u ON u.id = identity.payer_user_id
       JOIN client_accounts ca ON ca.id = identity.order_client_account_id
       JOIN provider_operations po
         ON po.id = $2
        AND po.subject_type = 'payment'
        AND po.subject_id = pa.id
       WHERE pa.id = $1`,
      [paymentAttemptId, providerOperationId, invoiceId],
    );
    const payment = result.rows[0];
    if (!payment) {
      await manualJobWithClient(
        client,
        job,
        "payment job references missing or inconsistent Core records",
      );
      return { kind: "halted" };
    }

    if (payment.operation_status === "succeeded" || payment.operation_status === "failed") {
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }
    if (payment.operation_kind !== "payment_create") {
      await manualJobWithClient(
        client,
        job,
        "payment reconciliation references an incompatible provider operation",
      );
      return { kind: "halted" };
    }
    const consistentOwnership =
      payment.payment_client_account_id === payment.invoice_client_account_id &&
      payment.invoice_client_account_id === payment.order_client_account_id;
    const consistentProvider =
      payment.payment_provider_installation_id ===
        payment.operation_provider_installation_id &&
      payment.payment_provider_installation_id === "mock-payment-v1";
    const knownUnsent =
      payment.payment_status === "created" &&
      payment.operation_status === "queued" &&
      payment.operation_attempt_count === 0;

    if (mode === "reconcile") {
      const potentiallySent =
        payment.operation_attempt_count > 0 ||
        payment.operation_status === "running" ||
        payment.operation_status === "unknown" ||
        payment.payment_status === "processing" ||
        payment.payment_status === "unknown";
      if (!consistentOwnership || !consistentProvider) {
        return holdPaymentWithClient(
          client,
          job,
          providerOperationId,
          payment.order_id,
          !consistentOwnership
            ? "payment reconciliation blocked because Core ownership records are inconsistent"
            : "payment reconciliation blocked because Provider ownership records are inconsistent",
        );
      }
      if (!potentiallySent) {
        return cancelKnownUnsentPaymentWithClient(
          client,
          job,
          providerOperationId,
          paymentAttemptId,
          payment.order_id,
          "payment reconciliation has no evidence that a provider create was sent",
          true,
        );
      }
      return {
        kind: "call",
        value: {
          amountMinor: payment.amount_minor,
          currency: payment.payment_currency,
          scenario: payment.scenario,
        },
      };
    }
    if (
      payment.payment_status === "succeeded" ||
      payment.payment_status === "failed" ||
      payment.payment_status === "cancelled" ||
      payment.payment_status === "expired"
    ) {
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }
    if (!knownUnsent) {
      await client.query(
        `UPDATE payment_attempts
         SET status = 'unknown', updated_at = now(), version = version + 1
         WHERE id = $1
           AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
        [paymentAttemptId],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown',
             last_error = 'create operation may already have run; reconciliation required',
             updated_at = now()
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
        [providerOperationId],
      );
      await client.query(
        `UPDATE invoice_payment_commands
         SET status = 'unknown', result = $2, updated_at = now()
         WHERE payment_attempt_id = $1
           AND status NOT IN ('manual', 'succeeded', 'failed')`,
        [
          paymentAttemptId,
          {
            paymentStatus: "unknown",
            reason: "create operation may already have run; reconciliation required",
          },
        ],
      );
      await enqueueReconcileWithClient(
        client,
        "payment.reconcile",
        job.unique_key,
        { ...job.payload, operationId: providerOperationId },
        config.RECONCILE_BASE_DELAY_SECONDS,
      );
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }
    if (!consistentOwnership || !consistentProvider) {
      return cancelKnownUnsentPaymentWithClient(
        client,
        job,
        providerOperationId,
        paymentAttemptId,
        payment.order_id,
        !consistentOwnership
          ? "payment provider call blocked because Core ownership records are inconsistent"
          : "payment provider call blocked because Provider ownership records are inconsistent",
        true,
      );
    }

    const membership = await client.query<{ removed_at: Date | null; role: string }>(
      `SELECT removed_at, role
       FROM client_memberships
       WHERE client_account_id = $1 AND user_id = $2
       FOR UPDATE`,
      [payment.order_client_account_id, payment.payer_user_id],
    );
    const member = membership.rows[0];
    const eligible =
      Boolean(payment.email_verified_at) &&
      !payment.user_restricted_at &&
      !payment.account_restricted_at &&
      Boolean(member) &&
      !member?.removed_at &&
      (member?.role === "owner" || member?.role === "billing");

    if (!eligible) {
      return cancelKnownUnsentPaymentWithClient(
        client,
        job,
        providerOperationId,
        paymentAttemptId,
        payment.order_id,
        "payment provider call blocked because the user, account, or membership is not eligible",
        false,
      );
    }
    const payableBusinessState = isPaymentBusinessStatePayable(
      payment.payment_context === "order"
        ? { paymentContext: "order", orderStatus: payment.order_status }
        : {
            paymentContext: "renewal",
            renewalStatus: payment.renewal_status,
            serviceStatus: payment.service_status,
          },
    );
    if (
      !payableBusinessState ||
      payment.order_currency !== payment.invoice_currency ||
      payment.invoice_currency !== payment.payment_currency
    ) {
      return cancelKnownUnsentPaymentWithClient(
        client,
        job,
        providerOperationId,
        paymentAttemptId,
        payment.order_id,
        "payment provider call blocked because order, currency, or operation state changed",
        true,
      );
    }

    const allocationResult = await client.query<{ allocated_minor: string }>(
      `SELECT allocated_minor::text
       FROM invoice_allocation_totals
       WHERE invoice_id = $1`,
      [payment.invoice_id],
    );
    const dueMinor =
      BigInt(payment.invoice_total_minor) -
      BigInt(allocationResult.rows[0]?.allocated_minor ?? "0");
    if (dueMinor <= 0n) {
      return cancelKnownUnsentPaymentWithClient(
        client,
        job,
        providerOperationId,
        paymentAttemptId,
        payment.order_id,
        "invoice no longer has an allocatable balance before the Provider call",
        false,
      );
    }
    const principalMinor = BigInt(payment.principal_minor ?? payment.amount_minor);
    const feeMinor = BigInt(payment.fee_minor);
    if (
      dueMinor !== principalMinor ||
      BigInt(payment.amount_minor) !== principalMinor + feeMinor
    ) {
      return cancelKnownUnsentPaymentWithClient(
        client,
        job,
        providerOperationId,
        paymentAttemptId,
        payment.order_id,
        "payment provider call blocked because the invoice balance changed",
        true,
      );
    }

    if (mode === "start") {
      await client.query(
        `UPDATE payment_attempts
         SET status = 'processing', updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'created'`,
        [paymentAttemptId],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'running', attempt_count = attempt_count + 1,
             last_error = NULL, updated_at = now()
         WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
        [providerOperationId],
      );
    }

    return {
      kind: "call",
      value: {
        amountMinor: payment.amount_minor,
        currency: payment.payment_currency,
        scenario: payment.scenario,
      },
    };
  });
}

async function holdProvisionWithClient(
  client: DatabaseClient,
  job: Job,
  operationId: string,
  serviceId: string,
  orderId: string,
  potentiallySent: boolean,
  reason: string,
): Promise<PreflightResult<never>> {
  await client.query(
    `UPDATE orders
     SET status = 'on_hold', updated_at = now(), version = version + 1
     WHERE id = $1 AND status IN ('waiting_payment', 'accepted', 'fulfilling')`,
    [orderId],
  );
  if (potentiallySent) {
    await client.query(
      `UPDATE services
       SET status = 'provisioned_hold', updated_at = now(), version = version + 1
       WHERE id = $1 AND status IN ('pending', 'provisioning', 'confirming')`,
      [serviceId],
    );
  }
  await client.query(
    `UPDATE provider_operations
     SET last_error = $2, updated_at = now()
     WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
    [operationId, reason.slice(0, 1_000)],
  );
  await manualJobWithClient(client, job, reason);
  return { kind: "halted" };
}

async function preflightProvision(
  job: Job,
  serviceId: string,
  providerOperationId: string,
  mode: "start" | "reconcile",
): Promise<PreflightResult<undefined>> {
  return transaction(async (client) => {
    await lockProviderOperation(client, providerOperationId);
    await assertJobLeaseWithClient(client, job);
    const lockPointers = await client.query<{
      invoice_id: string;
      order_id: string;
      order_item_id: string;
      submitted_by_user_id: string;
      client_account_id: string;
    }>(
      `SELECT
         i.id AS invoice_id,
         o.id AS order_id,
         oi.id AS order_item_id,
         o.submitted_by_user_id,
         o.client_account_id
       FROM services s
       JOIN order_items oi ON oi.id = s.order_item_id
       JOIN orders o ON o.id = oi.order_id
       JOIN invoices i ON i.order_id = o.id
       WHERE s.id = $1`,
      [serviceId],
    );
    const lockPointer = lockPointers.rows[0];
    if (lockPointer) {
      await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
        lockPointer.invoice_id,
      ]);
      await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
        lockPointer.order_id,
      ]);
      await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
        lockPointer.order_item_id,
      ]);
      await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [serviceId]);
      await client.query(
        `SELECT id
         FROM provider_operations
         WHERE id = $1
           AND subject_type = 'service'
           AND subject_id = $2
         FOR UPDATE`,
        [providerOperationId, serviceId],
      );
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
        lockPointer.submitted_by_user_id,
      ]);
      await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
        lockPointer.client_account_id,
      ]);
    }
    const lockedMembership = lockPointer
      ? await client.query<{
          removed_at: Date | null;
        }>(
          `SELECT removed_at
           FROM client_memberships
           WHERE user_id = $1 AND client_account_id = $2
           FOR UPDATE`,
          [lockPointer.submitted_by_user_id, lockPointer.client_account_id],
        )
      : null;
    const result = await client.query<{
      service_status: string;
      service_client_account_id: string;
      fulfillment_mode: string;
      order_id: string;
      order_status: string;
      order_client_account_id: string;
      submitted_by_user_id: string;
      invoice_id: string;
      invoice_total_minor: string;
      invoice_client_account_id: string;
      email_verified_at: Date | null;
      user_restricted_at: Date | null;
      account_restricted_at: Date | null;
      operation_status: string;
      operation_kind: string;
      operation_attempt_count: number;
      operation_provider_installation_id: string;
    }>(
      `SELECT
         s.status AS service_status, s.client_account_id AS service_client_account_id,
         oi.fulfillment_mode, o.id AS order_id, o.status AS order_status,
         o.client_account_id AS order_client_account_id, o.submitted_by_user_id,
         i.id AS invoice_id, i.total_minor::text AS invoice_total_minor,
         i.client_account_id AS invoice_client_account_id,
         u.email_verified_at, u.restricted_at AS user_restricted_at,
         ca.restricted_at AS account_restricted_at,
         po.status AS operation_status, po.kind AS operation_kind,
         po.attempt_count AS operation_attempt_count,
         po.provider_installation_id AS operation_provider_installation_id
       FROM services s
       JOIN order_items oi ON oi.id = s.order_item_id
       JOIN orders o ON o.id = oi.order_id
       JOIN invoices i ON i.order_id = o.id
       JOIN users u ON u.id = o.submitted_by_user_id
       JOIN client_accounts ca ON ca.id = o.client_account_id
       JOIN provider_operations po
         ON po.id = $2
        AND po.subject_type = 'service'
        AND po.subject_id = s.id
       WHERE s.id = $1`,
      [serviceId, providerOperationId],
    );
    const service = result.rows[0];
    if (!service) {
      await manualJobWithClient(
        client,
        job,
        "provisioning job references missing or inconsistent Core records",
      );
      return { kind: "halted" };
    }

    const potentiallySent =
      service.operation_attempt_count > 0 ||
      service.operation_status === "running" ||
      service.operation_status === "unknown" ||
      service.service_status === "provisioning" ||
      service.service_status === "confirming";

    if (service.operation_status === "succeeded" || service.operation_status === "failed") {
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }
    if (service.operation_kind !== "resource_create") {
      await manualJobWithClient(
        client,
        job,
        "provision reconciliation references an incompatible provider operation",
      );
      return { kind: "halted" };
    }
    if (mode === "reconcile") {
      if (service.operation_provider_installation_id !== "mock-provisioning-v1") {
        return holdProvisionWithClient(
          client,
          job,
          providerOperationId,
          serviceId,
          service.order_id,
          potentiallySent,
          "provision reconciliation blocked because Provider ownership records are inconsistent",
        );
      }
      if (!potentiallySent) {
        await manualJobWithClient(
          client,
          job,
          "provision reconciliation has no evidence that a provider create was sent",
        );
        return { kind: "halted" };
      }
      return { kind: "call", value: undefined };
    }
    if (service.service_status === "active" || service.service_status === "terminated") {
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }

    const member = lockedMembership?.rows[0];
    const eligible =
      Boolean(service.email_verified_at) &&
      !service.user_restricted_at &&
      !service.account_restricted_at &&
      Boolean(member) &&
      !member?.removed_at;
    const consistentOwnership =
      service.service_client_account_id === service.invoice_client_account_id &&
      service.invoice_client_account_id === service.order_client_account_id;
    const consistentProvider =
      service.operation_provider_installation_id === "mock-provisioning-v1";

    const allocationResult = await client.query<{ allocated_minor: string }>(
      `SELECT allocated_minor::text
       FROM invoice_allocation_totals
       WHERE invoice_id = $1`,
      [service.invoice_id],
    );
    const paid =
      BigInt(allocationResult.rows[0]?.allocated_minor ?? "0") >=
      BigInt(service.invoice_total_minor);
    if (
      !eligible ||
      !consistentOwnership ||
      !consistentProvider ||
      !paid ||
      service.fulfillment_mode !== "automatic" ||
      !["accepted", "fulfilling"].includes(service.order_status) ||
      service.service_status === "provisioned_hold" ||
      service.service_status === "provision_failed"
    ) {
      return holdProvisionWithClient(
        client,
        job,
        providerOperationId,
        serviceId,
        service.order_id,
        potentiallySent,
        !eligible
          ? "provisioning provider call blocked because the user, account, or membership is not eligible"
          : !paid
            ? "provisioning provider call blocked because the linked invoice is not fully allocated"
            : !consistentProvider
              ? "provisioning provider call blocked because Provider ownership records are inconsistent"
              : "provisioning provider call blocked because order, ownership, fulfillment, or operation state changed",
      );
    }

    if (mode === "start") {
      const createMayHaveRun =
        service.service_status !== "pending" ||
        service.operation_status !== "queued" ||
        service.operation_attempt_count > 0;
      if (createMayHaveRun) {
        await client.query(
          `UPDATE services
           SET status = 'confirming', updated_at = now(), version = version + 1
           WHERE id = $1 AND status IN ('pending', 'provisioning', 'confirming')`,
          [serviceId],
        );
        await client.query(
          `UPDATE provider_operations
           SET status = 'unknown',
               last_error = 'create operation may already have run; reconciliation required',
               updated_at = now()
           WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
          [providerOperationId],
        );
        await enqueueReconcileWithClient(
          client,
          "provision.reconcile",
          job.unique_key,
          { ...job.payload, operationId: providerOperationId },
          config.RECONCILE_BASE_DELAY_SECONDS,
        );
        await completeJobWithClient(client, job);
        return { kind: "halted" };
      }
      await client.query(
        `UPDATE services
         SET status = 'provisioning', updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'pending'`,
        [serviceId],
      );
      await client.query(
        `UPDATE orders
         SET status = 'fulfilling', updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'accepted'`,
        [service.order_id],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'running', attempt_count = attempt_count + 1,
             last_error = NULL, updated_at = now()
         WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
        [providerOperationId],
      );
    }
    return { kind: "call", value: undefined };
  });
}

type ServiceAction = "suspend" | "resume";

type ServiceActionCall = {
  externalResourceId: string;
};

type ServiceActionState = {
  case_id: string;
  case_status: string;
  case_action: string;
  case_provider_installation_id: string | null;
  resume_required: boolean;
  service_id: string;
  service_status: string;
  external_resource_id: string | null;
  client_account_restricted_at: Date | null;
  renewal_id: string;
  renewal_status: string;
  invoice_id: string;
  invoice_total_minor: string;
  allocated_minor: string;
  product_action: string | null;
  product_provider_installation_id: string | null;
  required_suspend_capability: string | null;
  required_resume_capability: string | null;
  product_policy_version: number | null;
  binding_action: string | null;
  binding_provider_installation_id: string | null;
  binding_capability_snapshot: unknown;
  binding_product_policy_version: number | null;
  provider_enabled: boolean | null;
  current_provider_capabilities: unknown;
  operation_status: string;
  operation_kind: string;
  operation_attempt_count: number;
  operation_provider_installation_id: string;
  operation_stable_key: string;
  other_unpaid_case: boolean;
  pending_payment_result: boolean;
};

function capabilityList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function serviceActionNames(action: ServiceAction): {
  startStatus: string;
  processingStatus: string;
  unknownStatus: string;
  terminalCaseStatus: string;
  terminalServiceStatus: string;
  operationKind: string;
  capability: "resource_suspend" | "resource_resume";
  reconcileType: "service.suspend.reconcile" | "service.resume.reconcile";
} {
  return action === "suspend"
    ? {
        startStatus: "suspend_queued",
        processingStatus: "suspend_processing",
        unknownStatus: "suspend_unknown",
        terminalCaseStatus: "suspended",
        terminalServiceStatus: "suspended",
        operationKind: "resource_suspend",
        capability: "resource_suspend",
        reconcileType: "service.suspend.reconcile",
      }
    : {
        startStatus: "resume_queued",
        processingStatus: "resume_processing",
        unknownStatus: "resume_unknown",
        terminalCaseStatus: "resolved",
        terminalServiceStatus: "active",
        operationKind: "resource_resume",
        capability: "resource_resume",
        reconcileType: "service.resume.reconcile",
      };
}

async function lockServiceActionState(
  client: DatabaseClient,
  job: Job,
  action: ServiceAction,
  caseId: string,
  serviceId: string,
  providerOperationId: string,
): Promise<ServiceActionState | null> {
  // Resolve the lock targets without taking row locks, then acquire business
  // rows in the same order used by invoice settlement and Provider callbacks.
  // The operation advisory lock serializes this exact external side effect but
  // intentionally does not replace the shared row-lock order.
  await lockProviderOperation(client, providerOperationId);
  const pointer = await client.query<{
    invoice_id: string;
    renewal_id: string;
    service_id: string;
    order_item_id: string;
    product_id: string;
    client_account_id: string;
  }>(
    `SELECT suspension_case.invoice_id,
            suspension_case.service_renewal_id AS renewal_id,
            suspension_case.service_id,
            service.order_item_id,
            item.product_id,
            service.client_account_id
     FROM service_suspension_cases suspension_case
     JOIN services service ON service.id = suspension_case.service_id
     JOIN order_items item ON item.id = service.order_item_id
     WHERE suspension_case.id = $1
       AND suspension_case.service_id = $2`,
    [caseId, serviceId],
  );
  const target = pointer.rows[0];
  if (!target) {
    await assertJobLeaseWithClient(client, job);
    return null;
  }
  await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [target.invoice_id]);
  await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
    target.order_item_id,
  ]);
  await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [target.service_id]);
  await client.query("SELECT id FROM service_renewals WHERE id = $1 FOR UPDATE", [
    target.renewal_id,
  ]);
  await client.query("SELECT id FROM service_suspension_cases WHERE id = $1 FOR UPDATE", [
    caseId,
  ]);
  await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [
    providerOperationId,
  ]);
  // These are the mutable authorization rows. Holding them until this
  // transaction commits makes the commit the dispatch-ownership point: a
  // concurrent account restriction, product-policy change, Provider pause, or
  // capability revocation wins either before this final preflight or after the
  // action has already been durably marked as dispatched. There is no separate
  // provider_installations table in the current schema; the capability row is
  // the authoritative installation/enabled record.
  await client.query("SELECT id FROM products WHERE id = $1 FOR UPDATE", [target.product_id]);
  await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
    target.client_account_id,
  ]);
  const lockedPolicy = await client.query<{ provider_installation_id: string | null }>(
    `SELECT provider_installation_id
     FROM product_service_automation_policies
     WHERE product_id = $1
     FOR UPDATE`,
    [target.product_id],
  );
  const lockedProviderInstallationId = lockedPolicy.rows[0]?.provider_installation_id;
  if (lockedProviderInstallationId) {
    await client.query(
      `SELECT provider_installation_id
       FROM provider_installation_capabilities
       WHERE provider_installation_id = $1
       FOR UPDATE`,
      [lockedProviderInstallationId],
    );
  }
  await assertJobLeaseWithClient(client, job);

  const result = await client.query<ServiceActionState>(
    `SELECT
       suspension_case.id AS case_id,
       suspension_case.status AS case_status,
       suspension_case.action AS case_action,
       suspension_case.provider_installation_id AS case_provider_installation_id,
       suspension_case.resume_required,
       service.id AS service_id,
       service.status AS service_status,
       service.external_resource_id,
       client_account.restricted_at AS client_account_restricted_at,
       renewal.id AS renewal_id,
       renewal.status AS renewal_status,
       invoice.id AS invoice_id,
       invoice.total_minor::text AS invoice_total_minor,
       allocation.allocated_minor::text,
       product_policy.overdue_action AS product_action,
       product_policy.provider_installation_id AS product_provider_installation_id,
       product_policy.required_suspend_capability,
       product_policy.required_resume_capability,
       product_policy.version AS product_policy_version,
       binding.overdue_action_snapshot AS binding_action,
       binding.provider_installation_id AS binding_provider_installation_id,
       binding.capability_snapshot AS binding_capability_snapshot,
       binding.product_policy_version AS binding_product_policy_version,
       provider.enabled AS provider_enabled,
       provider.capabilities AS current_provider_capabilities,
       operation.status AS operation_status,
       operation.kind AS operation_kind,
       operation.attempt_count AS operation_attempt_count,
       operation.provider_installation_id AS operation_provider_installation_id,
       operation.stable_key AS operation_stable_key,
       EXISTS (
         SELECT 1
         FROM payment_attempts pending_payment
         WHERE pending_payment.invoice_id = invoice.id
           AND pending_payment.status IN ('created', 'processing', 'unknown')
       ) AS pending_payment_result,
       EXISTS (
         SELECT 1
         FROM service_suspension_cases other_case
         JOIN service_renewals other_renewal
           ON other_renewal.id = other_case.service_renewal_id
         WHERE other_case.service_id = service.id
           AND other_case.id <> suspension_case.id
           AND other_case.status <> 'resolved'
           AND other_renewal.status <> 'paid'
       ) AS other_unpaid_case
     FROM service_suspension_cases suspension_case
     JOIN services service ON service.id = suspension_case.service_id
     JOIN client_accounts client_account ON client_account.id = service.client_account_id
     JOIN service_renewals renewal ON renewal.id = suspension_case.service_renewal_id
     JOIN invoices invoice ON invoice.id = suspension_case.invoice_id
     JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
     JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN product_service_automation_policies product_policy
       ON product_policy.product_id = item.product_id
     LEFT JOIN service_provider_bindings binding ON binding.service_id = service.id
     LEFT JOIN provider_installation_capabilities provider
       ON provider.provider_installation_id = binding.provider_installation_id
     JOIN provider_operations operation
       ON operation.id = $3
      AND operation.subject_type = 'service_suspension_case'
      AND operation.subject_id = suspension_case.id
     WHERE suspension_case.id = $1
       AND suspension_case.service_id = $2`,
    [caseId, serviceId, providerOperationId],
  );
  const state = result.rows[0] ?? null;
  if (state && state.operation_kind !== serviceActionNames(action).operationKind) return state;
  return state;
}

async function setServiceActionManualWithClient(
  client: DatabaseClient,
  job: Job,
  state: ServiceActionState,
  providerOperationId: string,
  action: ServiceAction,
  reason: string,
  definitivelyRejected = false,
): Promise<void> {
  const potentiallySent = state.operation_attempt_count > 0 ||
    state.operation_status === "running" || state.operation_status === "unknown";
  await client.query(
    `UPDATE provider_operations
     SET status = $2, last_error = $3, updated_at = now()
     WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
    [
      providerOperationId,
      definitivelyRejected || !potentiallySent ? "failed" : "unknown",
      reason.slice(0, 1_000),
    ],
  );
  if (state.case_status !== "resolved") {
    await client.query(
      `UPDATE service_suspension_cases
       SET status = 'manual',
           resume_required = CASE WHEN $2 = 'resume' THEN true ELSE resume_required END,
           last_error = $3, updated_at = now(), version = version + 1
       WHERE id = $1 AND status <> 'resolved'`,
      [state.case_id, action, reason.slice(0, 1_000)],
    );
  }
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES ('system', $1, $2, 'service_suspension_case', $3, $4, $5)`,
    [
      config.WORKER_ID,
      `service.${action}.manual`,
      state.case_id,
      reason.slice(0, 1_000),
      {
        providerOperationId,
        serviceId: state.service_id,
        potentiallySent,
        definitivelyRejected,
      },
    ],
  );
  await manualJobWithClient(client, job, reason);
}

async function preflightServiceAction(
  job: Job,
  action: ServiceAction,
  caseId: string,
  serviceId: string,
  providerOperationId: string,
  mode: "start" | "reconcile",
): Promise<PreflightResult<ServiceActionCall>> {
  return transaction(async (client) => {
    const state = await lockServiceActionState(
      client,
      job,
      action,
      caseId,
      serviceId,
      providerOperationId,
    );
    if (!state) {
      await manualJobWithClient(
        client,
        job,
        "service action job references missing or inconsistent Core records",
      );
      return { kind: "halted" };
    }
    const names = serviceActionNames(action);
    const terminal =
      state.operation_status === "succeeded" &&
      state.case_status === names.terminalCaseStatus &&
      state.service_status === names.terminalServiceStatus;
    const failed = state.operation_status === "failed" && state.case_status === "manual";
    if (terminal || failed) {
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }
    if (
      state.case_status === "resolved" &&
      (state.operation_status === "succeeded" || state.operation_status === "failed")
    ) {
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }

    const bindingCapabilities = capabilityList(state.binding_capability_snapshot);
    const currentCapabilities = capabilityList(state.current_provider_capabilities);
    const requiredCapability = action === "suspend"
      ? state.required_suspend_capability ?? names.capability
      : state.required_resume_capability ?? names.capability;
    const ownershipValid =
      state.case_id === caseId &&
      state.service_id === serviceId &&
      state.operation_kind === names.operationKind &&
      state.operation_stable_key === job.unique_key &&
      state.case_provider_installation_id === "mock-provisioning-v1" &&
      state.operation_provider_installation_id === "mock-provisioning-v1" &&
      state.binding_provider_installation_id === "mock-provisioning-v1";
    const currentlyAuthorized =
      state.case_action === "automatic" &&
      state.product_action === "automatic" &&
      state.product_provider_installation_id === "mock-provisioning-v1" &&
      state.binding_action === "automatic" &&
      state.product_policy_version !== null &&
      state.binding_product_policy_version === state.product_policy_version &&
      state.provider_enabled === true &&
      bindingCapabilities.includes(requiredCapability) &&
      currentCapabilities.includes(requiredCapability) &&
      (action !== "resume" || state.client_account_restricted_at === null);
    if (!ownershipValid || (mode === "start" && !currentlyAuthorized)) {
      await setServiceActionManualWithClient(
        client,
        job,
        state,
        providerOperationId,
        action,
        !ownershipValid
          ? "service action Provider ownership or stable operation identity is inconsistent"
          : "service action is no longer allowed by the current product, binding, or Provider capability policy",
      );
      return { kind: "halted" };
    }
    if (!state.external_resource_id) {
      await setServiceActionManualWithClient(
        client,
        job,
        state,
        providerOperationId,
        action,
        "service action requires an existing external resource id",
      );
      return { kind: "halted" };
    }

    const settled = BigInt(state.allocated_minor) >= BigInt(state.invoice_total_minor);
    if (mode === "start" && action === "suspend" && state.pending_payment_result) {
      const reason =
        "suspension deferred while an external payment result is unresolved";
      await client.query(
        `UPDATE provider_operations
         SET last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
        [providerOperationId, reason],
      );
      await client.query(
        `UPDATE service_suspension_cases
         SET last_error = $2, updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'suspend_queued'`,
        [caseId, reason],
      );
      const deferred = await client.query(
        `UPDATE durable_jobs
         SET status = 'pending', available_at = now() + interval '30 seconds',
             locked_at = NULL, locked_by = NULL, last_error = $2, updated_at = now()
         WHERE id = $1
           AND status = 'running'
           AND locked_by = $3
           AND attempts = $4
         RETURNING id`,
        [job.id, reason, config.WORKER_ID, job.attempts],
      );
      if (deferred.rowCount !== 1) throw new LostJobLeaseError(job.id);
      return { kind: "halted" };
    }
    if (mode === "start" && action === "suspend" && settled) {
      const knownUnsent =
        state.operation_status === "queued" &&
        state.operation_attempt_count === 0 &&
        state.case_status === names.startStatus;
      if (knownUnsent) {
        await client.query(
          `UPDATE provider_operations
           SET status = 'failed',
               last_error = 'renewal settled before the suspension request was sent',
               updated_at = now()
           WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
          [providerOperationId],
        );
        await client.query(
          `UPDATE service_suspension_cases
           SET status = 'resolved', resume_required = false, resolved_at = now(),
               last_error = NULL, updated_at = now(), version = version + 1
           WHERE id = $1 AND status = 'suspend_queued'`,
          [caseId],
        );
      } else {
        const reason =
          "renewal settled after suspension may have been sent; query-only reconciliation required";
        await client.query(
          `UPDATE provider_operations
           SET status = 'unknown', last_error = $2, updated_at = now()
           WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
          [providerOperationId, reason],
        );
        await client.query(
          `UPDATE service_suspension_cases
           SET status = $2, resume_required = true, last_error = $3,
               updated_at = now(), version = version + 1
           WHERE id = $1 AND status IN ($4, $5, $2)`,
          [caseId, names.unknownStatus, reason, names.startStatus, names.processingStatus],
        );
        await enqueueReconcileWithClient(
          client,
          names.reconcileType,
          job.unique_key,
          { caseId, serviceId, providerOperationId },
          config.RECONCILE_BASE_DELAY_SECONDS,
        );
      }
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }
    const businessStateValid = action === "suspend"
      ? state.renewal_status !== "paid" && !settled &&
        (mode === "reconcile" || state.service_status === "active")
      : state.renewal_status === "paid" && settled && !state.other_unpaid_case &&
        (mode === "reconcile" || state.service_status === "suspended");
    if (mode === "start" && !businessStateValid) {
      await setServiceActionManualWithClient(
        client,
        job,
        state,
        providerOperationId,
        action,
        action === "suspend"
          ? "suspension preflight found no eligible unpaid active renewal"
          : "resume preflight requires a settled renewal, suspended service, and no other unpaid case",
      );
      return { kind: "halted" };
    }

    if (mode === "reconcile") {
      const possiblySent = state.operation_attempt_count > 0 ||
        state.operation_status === "running" || state.operation_status === "unknown";
      if (!possiblySent) {
        await setServiceActionManualWithClient(
          client,
          job,
          state,
          providerOperationId,
          action,
          "service action reconciliation has no evidence that the Provider request was sent",
        );
        return { kind: "halted" };
      }
      return { kind: "call", value: { externalResourceId: state.external_resource_id } };
    }

    const actionMayHaveRun =
      state.case_status !== names.startStatus ||
      state.operation_status !== "queued" ||
      state.operation_attempt_count > 0;
    if (actionMayHaveRun) {
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown',
             last_error = 'resource action may already have been sent; reconciliation required',
             updated_at = now()
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
        [providerOperationId],
      );
      await client.query(
        `UPDATE service_suspension_cases
         SET status = $2, last_error = $3, updated_at = now(), version = version + 1
         WHERE id = $1 AND status IN ($4, $5)`,
        [
          caseId,
          names.unknownStatus,
          "resource action may already have been sent; reconciliation required",
          names.startStatus,
          names.processingStatus,
        ],
      );
      await enqueueReconcileWithClient(
        client,
        names.reconcileType,
        job.unique_key,
        { caseId, serviceId, providerOperationId },
        config.RECONCILE_BASE_DELAY_SECONDS,
      );
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }

    const caseUpdated = await client.query(
      `UPDATE service_suspension_cases
       SET status = $2, last_error = NULL, updated_at = now(), version = version + 1
       WHERE id = $1 AND status = $3
       RETURNING id`,
      [caseId, names.processingStatus, names.startStatus],
    );
    const operationUpdated = await client.query(
      `UPDATE provider_operations
       SET status = 'running', attempt_count = attempt_count + 1,
           last_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'queued' AND attempt_count = 0
       RETURNING id`,
      [providerOperationId],
    );
    if (caseUpdated.rowCount !== 1 || operationUpdated.rowCount !== 1) {
      throw new Error("service action state changed while beginning Provider delivery");
    }
    return { kind: "call", value: { externalResourceId: state.external_resource_id } };
  });
}

async function finishStartWithWatchdog(
  job: Job,
  operationId: string,
  reconcileType:
    | "payment.reconcile"
    | "add_funds.reconcile"
    | "provision.reconcile"
    | "refund.reconcile"
    | "service.suspend.reconcile"
    | "service.resume.reconcile",
): Promise<void> {
  await transaction(async (client) => {
    if (reconcileType === "refund.reconcile" && job.payload.refundId) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `refund:${job.payload.refundId}`,
      ]);
    }
    await lockProviderOperation(client, operationId);
    await assertJobLeaseWithClient(client, job);
    const operation = await client.query<{ status: string }>(
      "SELECT status FROM provider_operations WHERE id = $1 FOR UPDATE",
      [operationId],
    );
    const status = operation.rows[0]?.status;
    if (status && status !== "succeeded" && status !== "failed") {
      const reconcilePayload = reconcileType.startsWith("service.")
        ? {
            caseId: job.payload.caseId ?? "",
            serviceId: job.payload.serviceId ?? "",
            providerOperationId: operationId,
          }
        : { ...job.payload, operationId };
      await enqueueReconcileWithClient(
        client,
        reconcileType,
        job.unique_key,
        reconcilePayload,
        config.WATCHDOG_DELAY_SECONDS,
      );
    }
    await completeJobWithClient(client, job);
  });
}

async function rejectPaymentStartManually(
  job: Job,
  operationId: string,
  paymentAttemptId: string,
  reason: string,
): Promise<void> {
  await transaction(async (client) => {
    await lockProviderOperation(client, operationId);
    await assertJobLeaseWithClient(client, job);
    const pointer = await client.query<{ invoice_id: string; order_id: string }>(
      `SELECT i.id AS invoice_id, o.id AS order_id
       FROM payment_attempts pa
       JOIN invoices i ON i.id = pa.invoice_id
       JOIN orders o ON o.id = i.order_id
       WHERE pa.id = $1`,
      [paymentAttemptId],
    );
    const invoiceId = pointer.rows[0]?.invoice_id;
    const orderId = pointer.rows[0]?.order_id;
    if (!invoiceId || !orderId) {
      await manualJobWithClient(
        client,
        job,
        "Payment Provider outcome references inconsistent Core records",
      );
      return;
    }
    await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
    await client.query("SELECT id FROM payment_attempts WHERE id = $1 FOR UPDATE", [
      paymentAttemptId,
    ]);
    await client.query(
      `SELECT id
       FROM provider_operations
       WHERE id = $1
         AND subject_type = 'payment'
         AND subject_id = $2
       FOR UPDATE`,
      [operationId, paymentAttemptId],
    );
    await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    await client.query(
      `SELECT id
       FROM invoice_payment_commands
       WHERE payment_attempt_id = $1
       FOR UPDATE`,
      [paymentAttemptId],
    );
    const currentResult = await client.query<{
      command_status: string;
      payment_status: string;
      operation_status: string;
      has_receipt: boolean;
    }>(
      `SELECT command.status AS command_status,
              attempt.status AS payment_status,
              operation.status AS operation_status,
              EXISTS (
                SELECT 1
                FROM fund_receipts receipt
                WHERE receipt.reported_payment_attempt_id = attempt.id
              ) AS has_receipt
       FROM invoice_payment_commands command
       JOIN payment_attempts attempt ON attempt.id = command.payment_attempt_id
       JOIN provider_operations operation
         ON operation.id = $2
        AND operation.subject_type = 'payment'
        AND operation.subject_id = attempt.id
       WHERE attempt.id = $1`,
      [paymentAttemptId, operationId],
    );
    const current = currentResult.rows[0];
    if (!current) {
      await manualJobWithClient(
        client,
        job,
        "Payment Provider outcome references inconsistent Core records",
      );
      return;
    }
    if (
      current.command_status === "succeeded" ||
      current.payment_status === "succeeded" ||
      current.operation_status === "succeeded"
    ) {
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('system', $1, 'payment.provider_outcome_conflict',
                   'payment', $2, $3, $4)`,
        [
          config.WORKER_ID,
          paymentAttemptId,
          "Provider returned a rejection after Core accepted its successful payment callback; success was preserved",
          { providerOperationId: operationId, orderId, workerReason: reason.slice(0, 1_000) },
        ],
      );
      await completeJobWithClient(client, job);
      return;
    }
    if (current.command_status === "manual" || current.has_receipt) {
      const conflictReason =
        "Provider response contradicted an already-recorded funds receipt; manual review preserved";
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
        [operationId, conflictReason],
      );
      await client.query(
        `UPDATE payment_attempts
         SET status = 'unknown', updated_at = now(), version = version + 1
         WHERE id = $1
           AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'unknown')`,
        [paymentAttemptId],
      );
      await client.query(
        `UPDATE invoice_payment_commands
         SET status = 'manual', result = $2, updated_at = now()
         WHERE payment_attempt_id = $1
           AND status NOT IN ('succeeded', 'failed', 'manual')`,
        [
          paymentAttemptId,
          { paymentStatus: "unknown", reason: conflictReason },
        ],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('system', $1, 'payment.provider_outcome_conflict',
                   'payment', $2, $3, $4)`,
        [
          config.WORKER_ID,
          paymentAttemptId,
          "Provider response arrived after Core recorded funds; original manual result was preserved",
          {
            providerOperationId: operationId,
            orderId,
            workerReason: reason.slice(0, 1_000),
            hasReceipt: current.has_receipt,
          },
        ],
      );
      await completeJobWithClient(client, job);
      return;
    }
    const recordedTerminal =
      ["failed", "cancelled", "expired"].includes(current.payment_status) ||
      current.command_status === "failed" ||
      current.operation_status === "failed";
    if (recordedTerminal) {
      await completeJobWithClient(client, job);
      return;
    }
    const definitiveFailureCanClose =
      ["created", "processing"].includes(current.command_status) &&
      ["created", "processing"].includes(current.payment_status) &&
      ["queued", "running"].includes(current.operation_status);
    if (!definitiveFailureCanClose) {
      const conflictReason =
        "Provider rejection raced with an unknown payment outcome; reconciliation is required";
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
        [operationId, conflictReason],
      );
      await client.query(
        `UPDATE payment_attempts
         SET status = 'unknown', updated_at = now(), version = version + 1
         WHERE id = $1
           AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'unknown')`,
        [paymentAttemptId],
      );
      await client.query(
        `UPDATE invoice_payment_commands
         SET status = 'unknown', result = $2, updated_at = now()
         WHERE payment_attempt_id = $1
           AND status NOT IN ('manual', 'succeeded', 'failed')`,
        [paymentAttemptId, { paymentStatus: "unknown", reason: conflictReason }],
      );
      await enqueueReconcileWithClient(
        client,
        "payment.reconcile",
        job.unique_key,
        { ...job.payload, operationId },
        config.RECONCILE_BASE_DELAY_SECONDS,
      );
      await completeJobWithClient(client, job);
      return;
    }
    const creditRestoredMinor = await reverseInvoiceCreditApplicationWithClient(
      client,
      paymentAttemptId,
      reason,
    );
    await client.query(
      `UPDATE provider_operations
       SET status = 'failed', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [operationId, reason.slice(0, 1_000)],
    );
    await client.query(
      `UPDATE payment_attempts
       SET status = 'failed', updated_at = now(), version = version + 1
       WHERE id = $1 AND status IN ('created', 'processing')`,
      [paymentAttemptId],
    );
    await client.query(
      `UPDATE invoice_payment_commands
       SET status = 'failed', result = $2, updated_at = now()
       WHERE payment_attempt_id = $1`,
      [
        paymentAttemptId,
        { paymentStatus: "failed", reason: reason.slice(0, 1_000), creditRestoredMinor },
      ],
    );
    await client.query(
      `UPDATE orders
       SET status = 'on_hold', updated_at = now(), version = version + 1
       WHERE id = $1
         AND status IN ('waiting_payment', 'accepted', 'awaiting_manual', 'fulfilling')`,
      [orderId],
    );
    await client.query(
      `INSERT INTO audit_events(
         actor_type, actor_id, action, target_type, target_id, reason, metadata
       ) VALUES ('system', $1, 'payment.provider_create_rejected', 'payment', $2, $3, $4)`,
      [
        config.WORKER_ID,
        paymentAttemptId,
        reason.slice(0, 1_000),
        {
          providerOperationId: operationId,
          orderId,
          creditRestoredMinor,
        },
      ],
    );
    await manualJobWithClient(client, job, reason);
  });
}

async function rejectProvisionStartManually(
  job: Job,
  operationId: string,
  serviceId: string,
  reason: string,
): Promise<void> {
  await transaction(async (client) => {
    await lockProviderOperation(client, operationId);
    await assertJobLeaseWithClient(client, job);
    const pointerResult = await client.query<{
      invoice_id: string;
      order_id: string;
      order_item_id: string;
    }>(
      `SELECT i.id AS invoice_id, o.id AS order_id, oi.id AS order_item_id
       FROM services s
       JOIN order_items oi ON oi.id = s.order_item_id
       JOIN orders o ON o.id = oi.order_id
       JOIN invoices i ON i.order_id = o.id
       WHERE s.id = $1
      `,
      [serviceId],
    );
    const pointer = pointerResult.rows[0];
    if (pointer) {
      await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
        pointer.invoice_id,
      ]);
      await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
        pointer.order_id,
      ]);
      await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
        pointer.order_item_id,
      ]);
      await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [serviceId]);
    }
    await client.query(
      `SELECT id
       FROM provider_operations
       WHERE id = $1
         AND subject_type = 'service'
         AND subject_id = $2
         AND kind = 'resource_create'
       FOR UPDATE`,
      [operationId, serviceId],
    );
    const currentResult = await client.query<{
      service_status: string;
      order_id: string;
      order_status: string;
      operation_status: string;
    }>(
      `SELECT s.status AS service_status,
              o.id AS order_id,
              o.status AS order_status,
              operation.status AS operation_status
       FROM services s
       JOIN order_items oi ON oi.id = s.order_item_id
       JOIN orders o ON o.id = oi.order_id
       JOIN provider_operations operation
         ON operation.id = $2
        AND operation.subject_type = 'service'
        AND operation.subject_id = s.id
        AND operation.kind = 'resource_create'
       WHERE s.id = $1`,
      [serviceId, operationId],
    );
    const current = currentResult.rows[0];
    if (!current) {
      await manualJobWithClient(
        client,
        job,
        "Provisioning Provider outcome references inconsistent Core records",
      );
      return;
    }
    const successfulService = ["active", "provisioned_hold"].includes(
      current.service_status,
    );
    if (current.operation_status === "succeeded" && successfulService) {
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('system', $1, 'provision.provider_outcome_conflict',
                   'service', $2, $3, $4)`,
        [
          config.WORKER_ID,
          serviceId,
          "Provider returned a rejection after Core accepted its success callback; success was preserved",
          { providerOperationId: operationId, workerReason: reason.slice(0, 1_000) },
        ],
      );
      await completeJobWithClient(client, job);
      return;
    }
    if (
      current.operation_status === "failed" &&
      current.service_status === "provision_failed"
    ) {
      await completeJobWithClient(client, job);
      return;
    }
    const orderId = current.order_id;
    if (
      current.operation_status !== "running" ||
      current.service_status !== "provisioning" ||
      !["accepted", "fulfilling"].includes(current.order_status)
    ) {
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('system', $1, 'provision.provider_outcome_conflict',
                   'service', $2, $3, $4)`,
        [
          config.WORKER_ID,
          serviceId,
          "Provider rejection contradicted the current provisioning state; manual review preserved",
          {
            providerOperationId: operationId,
            workerReason: reason.slice(0, 1_000),
            operationStatus: current.operation_status,
            serviceStatus: current.service_status,
            orderStatus: current.order_status,
          },
        ],
      );
      await manualJobWithClient(
        client,
        job,
        "Provider rejection contradicted the current provisioning state; manual review required",
      );
      return;
    }
    await client.query(
      `UPDATE provider_operations
       SET status = 'failed', last_error = $2, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [operationId, reason.slice(0, 1_000)],
    );
    await client.query(
      `UPDATE services
       SET status = 'provision_failed', updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'provisioning'`,
      [serviceId],
    );
    if (orderId) {
      await client.query(
        `UPDATE orders
         SET status = 'on_hold', updated_at = now(), version = version + 1
         WHERE id = $1 AND status IN ('accepted', 'fulfilling')`,
        [orderId],
      );
    }
    await client.query(
      `INSERT INTO audit_events(
         actor_type, actor_id, action, target_type, target_id, reason, metadata
       ) VALUES ('system', $1, 'provision.provider_create_rejected', 'service', $2, $3, $4)`,
      [
        config.WORKER_ID,
        serviceId,
        reason.slice(0, 1_000),
        { providerOperationId: operationId, orderId: orderId ?? null },
      ],
    );
    await manualJobWithClient(client, job, reason);
  });
}

async function failKnownUnsentAddFunds(
  client: DatabaseClient,
  job: Job,
  operationId: string,
  addFundsAttemptId: string,
  reason: string,
): Promise<void> {
  await lockProviderOperation(client, operationId);
  await assertJobLeaseWithClient(client, job);
  await client.query("SELECT id FROM add_funds_attempts WHERE id = $1 FOR UPDATE", [
    addFundsAttemptId,
  ]);
  await client.query(
    `SELECT id
     FROM add_funds_commands
     WHERE add_funds_attempt_id = $1
     FOR UPDATE`,
    [addFundsAttemptId],
  );
  await client.query(
    `SELECT id
     FROM provider_operations
     WHERE id = $1
       AND subject_type = 'add_funds'
       AND subject_id = $2
     FOR UPDATE`,
    [operationId, addFundsAttemptId],
  );
  const currentResult = await client.query<{
    command_status: string;
    attempt_status: string;
    operation_status: string;
    has_receipt: boolean;
  }>(
    `SELECT command.status AS command_status,
            attempt.status AS attempt_status,
            operation.status AS operation_status,
            EXISTS (
              SELECT 1
              FROM fund_receipts receipt
              WHERE receipt.reported_add_funds_attempt_id = $1
            ) AS has_receipt
     FROM add_funds_commands command
     JOIN add_funds_attempts attempt
       ON attempt.id = command.add_funds_attempt_id
     JOIN provider_operations operation
       ON operation.id = $2
      AND operation.subject_type = 'add_funds'
     AND operation.subject_id = attempt.id
     WHERE command.add_funds_attempt_id = $1`,
    [addFundsAttemptId, operationId],
  );
  const current = currentResult.rows[0];
  if (!current) {
    await manualJobWithClient(
      client,
      job,
      "Add Funds Provider outcome references inconsistent Core records",
    );
    return;
  }
  if (
    current.command_status === "succeeded" ||
    current.command_status === "manual" ||
    current.has_receipt
  ) {
    if (current.command_status !== "succeeded") {
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1 AND status <> 'succeeded'`,
        [
          operationId,
          "Provider response contradicted an already-recorded funds receipt; manual review preserved",
        ],
      );
    }
    await client.query(
      `INSERT INTO audit_events(
         actor_type, actor_id, action, target_type, target_id, reason, metadata
       ) VALUES ('system', $1, 'add_funds.provider_outcome_conflict',
                 'add_funds_attempt', $2, $3, $4)`,
      [
        config.WORKER_ID,
        addFundsAttemptId,
        "Provider response arrived after Core recorded funds; original manual result was preserved",
        { providerOperationId: operationId, workerReason: reason.slice(0, 1_000) },
      ],
    );
    await completeJobWithClient(client, job);
    return;
  }
  const recordedTerminal =
    ["failed", "cancelled", "expired"].includes(current.command_status) ||
    ["failed", "cancelled", "expired"].includes(current.attempt_status) ||
    current.operation_status === "failed";
  if (recordedTerminal) {
    await completeJobWithClient(client, job);
    return;
  }
  const definitiveFailureCanClose =
    ["created", "processing"].includes(current.command_status) &&
    ["created", "processing"].includes(current.attempt_status) &&
    ["queued", "running"].includes(current.operation_status);
  if (!definitiveFailureCanClose) {
    const conflictReason =
      "Provider rejection raced with an unknown Add Funds outcome; reconciliation is required";
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [operationId, conflictReason],
    );
    await client.query(
      `UPDATE add_funds_attempts
       SET status = 'unknown', updated_at = now(), version = version + 1
       WHERE id = $1
         AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
      [addFundsAttemptId],
    );
    await client.query(
      `UPDATE add_funds_commands
       SET status = 'unknown', result = $2, updated_at = now()
       WHERE add_funds_attempt_id = $1
         AND status NOT IN ('manual', 'succeeded', 'failed', 'cancelled', 'expired')`,
      [
        addFundsAttemptId,
        { paymentStatus: "unknown", reason: conflictReason },
      ],
    );
    await enqueueReconcileWithClient(
      client,
      "add_funds.reconcile",
      job.unique_key,
      { ...job.payload, operationId },
      config.RECONCILE_BASE_DELAY_SECONDS,
    );
    await completeJobWithClient(client, job);
    return;
  }
  await client.query(
    `UPDATE provider_operations
     SET status = 'failed', last_error = $2, updated_at = now()
     WHERE id = $1 AND status IN ('queued', 'running')`,
    [operationId, reason.slice(0, 1_000)],
  );
  await client.query(
     `UPDATE add_funds_attempts
     SET status = 'failed', updated_at = now(), version = version + 1
     WHERE id = $1 AND status IN ('created', 'processing')`,
    [addFundsAttemptId],
  );
  await client.query(
    `UPDATE add_funds_commands
     SET status = 'failed', result = $2, updated_at = now()
     WHERE add_funds_attempt_id = $1
       AND status NOT IN ('manual', 'succeeded', 'failed', 'cancelled', 'expired')`,
    [
      addFundsAttemptId,
      { paymentStatus: "failed", reason: reason.slice(0, 1_000) },
    ],
  );
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES ('system', $1, 'add_funds.known_unsent_rejected',
               'add_funds_attempt', $2, $3, $4)`,
    [
      config.WORKER_ID,
      addFundsAttemptId,
      reason.slice(0, 1_000),
      { providerOperationId: operationId },
    ],
  );
  await completeJobWithClient(client, job);
}

async function preflightAddFunds(
  job: Job,
  addFundsAttemptId: string,
  providerOperationId: string,
  mode: "start" | "reconcile",
): Promise<PreflightResult<PaymentCall>> {
  return transaction(async (client) => {
    await lockProviderOperation(client, providerOperationId);
    await assertJobLeaseWithClient(client, job);
    const lockPointer = await client.query<{
      submitted_by_user_id: string;
      client_account_id: string;
    }>(
      `SELECT submitted_by_user_id, client_account_id
       FROM add_funds_attempts
       WHERE id = $1
       FOR UPDATE`,
      [addFundsAttemptId],
    );
    const pointer = lockPointer.rows[0];
    if (pointer) {
      await client.query(
        `SELECT id
         FROM add_funds_commands
         WHERE add_funds_attempt_id = $1
         FOR UPDATE`,
        [addFundsAttemptId],
      );
      await client.query(
        `SELECT id
         FROM provider_operations
         WHERE id = $1
           AND subject_type = 'add_funds'
           AND subject_id = $2
         FOR UPDATE`,
        [providerOperationId, addFundsAttemptId],
      );
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
        pointer.submitted_by_user_id,
      ]);
      await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
        pointer.client_account_id,
      ]);
    }
    const lockedMembership = pointer
      ? await client.query<{
          role: string;
          removed_at: Date | null;
        }>(
          `SELECT role, removed_at
           FROM client_memberships
           WHERE user_id = $1 AND client_account_id = $2
           FOR UPDATE`,
          [pointer.submitted_by_user_id, pointer.client_account_id],
        )
      : null;
    const result = await client.query<{
      status: string;
      expires_at: Date;
      amount_minor: string;
      principal_minor: string;
      fee_minor: string;
      currency: string;
      scenario: string;
      provider_installation_id: string;
      client_account_id: string;
      submitted_by_user_id: string;
      quote_client_account_id: string;
      quote_provider_installation_id: string;
      quote_currency: string;
      quote_principal_minor: string;
      quote_fee_minor: string;
      quote_external_due_minor: string;
      quote_fee_basis_points: number;
      payment_method_code: string;
      current_provider_installation_id: string;
      current_fee_basis_points: number;
      method_enabled: boolean;
      add_funds_enabled: boolean;
      policy_enabled: boolean;
      min_principal_minor: string;
      max_principal_minor: string;
      balance_cap_minor: string;
      email_verified_at: Date | null;
      user_restricted_at: Date | null;
      account_restricted_at: Date | null;
      removed_at: Date | null;
      membership_role: string | null;
      operation_status: string;
      operation_attempt_count: number;
      operation_provider_installation_id: string;
      operation_kind: string;
      operation_subject_type: string;
      operation_subject_id: string;
    }>(
      `SELECT
         afa.status, afa.expires_at, afa.amount_minor::text, afa.principal_minor::text,
         afa.fee_minor::text, afa.currency, afa.scenario,
         afa.provider_installation_id, afa.client_account_id,
         afa.submitted_by_user_id,
         q.client_account_id AS quote_client_account_id,
         q.provider_installation_id AS quote_provider_installation_id,
         q.currency AS quote_currency, q.principal_minor::text AS quote_principal_minor,
         q.fee_minor::text AS quote_fee_minor,
         q.external_due_minor::text AS quote_external_due_minor,
         q.fee_basis_points AS quote_fee_basis_points,
         afa.payment_method_code,
         pm.provider_installation_id AS current_provider_installation_id,
         pm.fee_basis_points AS current_fee_basis_points,
         pm.enabled AS method_enabled, pm.add_funds_enabled,
         afp.enabled AS policy_enabled,
         afp.min_principal_minor::text, afp.max_principal_minor::text,
         afp.balance_cap_minor::text,
         u.email_verified_at, u.restricted_at AS user_restricted_at,
         ca.restricted_at AS account_restricted_at, cm.removed_at,
         cm.role AS membership_role,
         po.status AS operation_status, po.attempt_count AS operation_attempt_count,
         po.provider_installation_id AS operation_provider_installation_id,
         po.kind AS operation_kind, po.subject_type AS operation_subject_type,
         po.subject_id AS operation_subject_id
       FROM add_funds_attempts afa
       JOIN add_funds_quotes q ON q.id = afa.quote_id
       JOIN add_funds_commands afc ON afc.add_funds_attempt_id = afa.id
       JOIN users u ON u.id = afa.submitted_by_user_id
       LEFT JOIN client_memberships cm
         ON cm.user_id = u.id AND cm.client_account_id = afa.client_account_id
       JOIN client_accounts ca ON ca.id = afa.client_account_id
       JOIN payment_methods pm ON pm.code = afa.payment_method_code
       JOIN add_funds_policies afp ON afp.currency = afa.currency
       JOIN provider_operations po ON po.id = $2
       WHERE afa.id = $1
       FOR SHARE OF pm, afp`,
      [addFundsAttemptId, providerOperationId],
    );
    const attempt = result.rows[0];
    if (!attempt) {
      await manualJobWithClient(
        client,
        job,
        "Add Funds job references missing or inconsistent Core records",
      );
      return { kind: "halted" };
    }
    const membership = lockedMembership?.rows[0];
    if (
      attempt.operation_status === "succeeded" ||
      attempt.operation_status === "failed" ||
      attempt.status === "succeeded"
    ) {
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }
    const ownershipConsistent =
      attempt.client_account_id === attempt.quote_client_account_id &&
      attempt.provider_installation_id === attempt.quote_provider_installation_id &&
      attempt.provider_installation_id === attempt.operation_provider_installation_id &&
      attempt.operation_kind === "payment_create" &&
      attempt.operation_subject_type === "add_funds" &&
      attempt.operation_subject_id === addFundsAttemptId;
    const snapshotConsistent =
      attempt.currency === attempt.quote_currency &&
      attempt.principal_minor === attempt.quote_principal_minor &&
      attempt.fee_minor === attempt.quote_fee_minor &&
      attempt.amount_minor === attempt.quote_external_due_minor &&
      BigInt(attempt.amount_minor) ===
        BigInt(attempt.principal_minor) + BigInt(attempt.fee_minor);
    if (!ownershipConsistent || !snapshotConsistent) {
      const reason = !ownershipConsistent
        ? "Add Funds Provider and account ownership records are inconsistent"
        : "Add Funds immutable amount snapshot is inconsistent";
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
        [providerOperationId, reason],
      );
      await client.query(
        `UPDATE add_funds_commands
         SET status = 'manual', result = $2, updated_at = now()
         WHERE add_funds_attempt_id = $1
           AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
        [addFundsAttemptId, { reason }],
      );
      await manualJobWithClient(client, job, reason);
      return { kind: "halted" };
    }

    const knownUnsent =
      attempt.status === "created" &&
      attempt.operation_status === "queued" &&
      attempt.operation_attempt_count === 0;
    if (mode === "reconcile") {
      if (!knownUnsent) {
        return {
          kind: "call",
          value: {
            amountMinor: attempt.amount_minor,
            currency: attempt.currency,
            scenario: attempt.scenario,
          },
        };
      }
      await failKnownUnsentAddFunds(
        client,
        job,
        providerOperationId,
        addFundsAttemptId,
        "Add Funds reconciliation has no evidence that Provider create was sent",
      );
      return { kind: "halted" };
    }

    if (!knownUnsent) {
      const reason = "Add Funds create may already have run; reconciliation required";
      await client.query(
        `UPDATE add_funds_attempts
         SET status = 'unknown', updated_at = now(), version = version + 1
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
        [addFundsAttemptId],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
        [providerOperationId, reason],
      );
      await client.query(
        `UPDATE add_funds_commands
         SET status = 'unknown', result = $2, updated_at = now()
         WHERE add_funds_attempt_id = $1
           AND status NOT IN ('manual', 'succeeded', 'failed', 'cancelled', 'expired')`,
        [addFundsAttemptId, { paymentStatus: "unknown", reason }],
      );
      await enqueueReconcileWithClient(
        client,
        "add_funds.reconcile",
        job.unique_key,
        { ...job.payload, operationId: providerOperationId },
        config.RECONCILE_BASE_DELAY_SECONDS,
      );
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }

    if (attempt.expires_at.getTime() <= Date.now()) {
      await failKnownUnsentAddFunds(
        client,
        job,
        providerOperationId,
        addFundsAttemptId,
        "Add Funds attempt expired before Provider create left Core",
      );
      return { kind: "halted" };
    }
    const eligible =
      Boolean(attempt.email_verified_at) &&
      !attempt.user_restricted_at &&
      !attempt.account_restricted_at &&
      membership?.removed_at === null &&
      (membership?.role === "owner" || membership?.role === "billing");
    const configurationCurrent =
      attempt.provider_installation_id === "mock-payment-v1" &&
      attempt.method_enabled &&
      attempt.add_funds_enabled &&
      attempt.policy_enabled &&
      attempt.current_provider_installation_id === attempt.provider_installation_id &&
      attempt.current_fee_basis_points === attempt.quote_fee_basis_points &&
      BigInt(attempt.principal_minor) >= BigInt(attempt.min_principal_minor) &&
      BigInt(attempt.principal_minor) <= BigInt(attempt.max_principal_minor);
    if (!eligible || !configurationCurrent) {
      await failKnownUnsentAddFunds(
        client,
        job,
        providerOperationId,
        addFundsAttemptId,
        !eligible
          ? "Customer eligibility was revoked before Add Funds left Core"
          : "Add Funds policy or payment method changed before Provider create",
      );
      return { kind: "halted" };
    }
    const creditAccount = await client.query<{ id: string }>(
      `SELECT id
       FROM credit_accounts
       WHERE client_account_id = $1 AND currency = $2
       FOR UPDATE`,
      [attempt.client_account_id, attempt.currency],
    );
    const creditAccountId = creditAccount.rows[0]?.id;
    if (!creditAccountId) {
      await failKnownUnsentAddFunds(
        client,
        job,
        providerOperationId,
        addFundsAttemptId,
        "Add Funds Credit account disappeared before Provider create",
      );
      return { kind: "halted" };
    }
    const capacity = await client.query<{
      balance_minor: string;
      reserved_minor: string;
    }>(
      `SELECT
         COALESCE((
           SELECT sum(credit_minor - debit_minor)
           FROM credit_transactions
           WHERE credit_account_id = $1
         ), 0)::text AS balance_minor,
         COALESCE((
           SELECT sum(principal_minor)
           FROM add_funds_attempts
           WHERE client_account_id = $2
             AND currency = $3
             AND status IN ('created', 'processing', 'unknown')
         ), 0)::text AS reserved_minor`,
      [creditAccountId, attempt.client_account_id, attempt.currency],
    );
    const available = capacity.rows[0];
    if (
      !available ||
      BigInt(available.balance_minor) + BigInt(available.reserved_minor) >
        BigInt(attempt.balance_cap_minor)
    ) {
      await failKnownUnsentAddFunds(
        client,
        job,
        providerOperationId,
        addFundsAttemptId,
        "Credit balance and in-flight Add Funds would exceed the configured balance cap",
      );
      return { kind: "halted" };
    }

    await client.query(
      `UPDATE add_funds_attempts
       SET status = 'processing', updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'created'`,
      [addFundsAttemptId],
    );
    await client.query(
      `UPDATE add_funds_commands
       SET status = 'processing', updated_at = now()
       WHERE add_funds_attempt_id = $1 AND status = 'created'`,
      [addFundsAttemptId],
    );
    await client.query(
      `UPDATE provider_operations
       SET status = 'running', attempt_count = attempt_count + 1,
           last_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
      [providerOperationId],
    );
    return {
      kind: "call",
      value: {
        amountMinor: attempt.amount_minor,
        currency: attempt.currency,
        scenario: attempt.scenario,
      },
    };
  });
}

type RefundCall = {
  originalExternalPaymentId: string;
  amountMinor: string;
  currency: string;
  scenario: "success" | "failed" | "timeout_success" | "duplicate_out_of_order";
};

async function failKnownUnsentRefund(
  client: DatabaseClient,
  job: Job,
  refundId: string,
  operationId: string,
  reason: string,
  recoveredJob = false,
): Promise<void> {
  await client.query(
    `UPDATE refunds
     SET status = 'failed', last_error = $2, result = result || $3::jsonb,
         updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'queued'`,
    [refundId, reason.slice(0, 1_000), JSON.stringify({ knownUnsent: true })],
  );
  await client.query(
    `UPDATE provider_operations
     SET status = 'failed', last_error = $2, updated_at = now()
     WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
    [operationId, reason.slice(0, 1_000)],
  );
  await client.query(
    `INSERT INTO refund_events(
       refund_id, event_type, actor_type, actor_id, reason, metadata
     ) VALUES ($1, 'failed', 'system', $2, $3, $4)`,
    [
      refundId,
      config.WORKER_ID,
      reason.slice(0, 1_000),
      { providerOperationId: operationId, knownUnsent: true },
    ],
  );
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES ('system', $1, 'refund.known_unsent_rejected', 'refund', $2, $3, $4)`,
    [
      config.WORKER_ID,
      refundId,
      reason.slice(0, 1_000),
      { providerOperationId: operationId },
    ],
  );
  if (recoveredJob) {
    await completeRecoveredJobWithClient(client, job);
  } else {
    await completeJobWithClient(client, job);
  }
}

async function preflightRefund(
  job: Job,
  refundId: string,
  operationId: string,
  mode: "start" | "reconcile",
): Promise<PreflightResult<RefundCall>> {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `refund:${refundId}`,
    ]);
    await assertJobLeaseWithClient(client, job);
    const pointer = await client.query<{
      source_fund_receipt_id: string;
      source_context: "allocated_invoice" | "unclaimed_funds";
      requested_by_user_id: string;
      requested_session_id: string;
      requested_client_account_id: string;
    }>(
      `SELECT
         source_fund_receipt_id,
         source_context,
         requested_by_user_id,
         requested_session_id,
         requested_client_account_id
       FROM refunds
       WHERE id = $1`,
      [refundId],
    );
    const initial = pointer.rows[0];
    if (!initial) {
      await manualJobWithClient(client, job, "refund job references a missing refund");
      return { kind: "halted" };
    }
    let authorizationValid = true;
    if (mode === "start") {
      const authorization = await client.query(
        `SELECT 1
         FROM users user_record
         JOIN staff_members staff ON staff.user_id = user_record.id
         JOIN sessions session_record
           ON session_record.id = $2
          AND session_record.user_id = user_record.id
         JOIN client_memberships membership
           ON membership.user_id = user_record.id
          AND membership.client_account_id = $3
          AND membership.removed_at IS NULL
         JOIN client_accounts account
           ON account.id = membership.client_account_id
         JOIN reauth_grants reauth
           ON reauth.user_id = user_record.id
          AND reauth.session_id = session_record.id
          AND reauth.invalidated_at IS NULL
          AND reauth.expires_at > now()
         WHERE user_record.id = $1
           AND user_record.email_verified_at IS NOT NULL
           AND user_record.restricted_at IS NULL
           AND account.restricted_at IS NULL
           AND staff.active
           AND (staff.permissions ? '*' OR staff.permissions ? 'billing.refund_manage')
           AND (
             $4 <> 'unclaimed_funds'
             OR staff.permissions ? '*'
             OR staff.permissions ? 'billing.unclaimed_manage'
           )
           AND session_record.revoked_at IS NULL
           AND session_record.expires_at > now()
         LIMIT 1
         FOR UPDATE OF user_record, staff, session_record, membership, account, reauth`,
        [
          initial.requested_by_user_id,
          initial.requested_session_id,
          initial.requested_client_account_id,
          initial.source_context,
        ],
      );
      authorizationValid = authorization.rowCount === 1;
    }
    const receiptId = initial.source_fund_receipt_id;
    await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [receiptId]);
    const result = await client.query<{
      id: string;
      status: string;
      source_fund_receipt_id: string;
      source_context: "allocated_invoice" | "unclaimed_funds";
      provider_installation_id: string;
      original_external_payment_id: string;
      amount_minor: string;
      currency: string;
      scenario: RefundCall["scenario"];
      requested_by_user_id: string;
      requested_session_id: string;
      receipt_provider_installation_id: string;
      receipt_external_payment_id: string;
      receipt_amount_minor: string;
      receipt_allocated_minor: string;
      receipt_currency: string;
      operation_status: string;
      operation_attempt_count: number;
      operation_provider_installation_id: string;
      operation_subject_id: string;
      operation_kind: string;
    }>(
      `SELECT
         refund.id,
         refund.status,
         refund.source_fund_receipt_id,
         refund.source_context,
         refund.provider_installation_id,
         refund.original_external_payment_id,
         refund.amount_minor::text,
         refund.currency,
         refund.scenario,
         refund.requested_by_user_id,
         refund.requested_session_id,
         receipt.provider_installation_id AS receipt_provider_installation_id,
         receipt.external_payment_id AS receipt_external_payment_id,
         receipt.amount_minor::text AS receipt_amount_minor,
         receipt.allocated_minor::text AS receipt_allocated_minor,
         receipt.currency AS receipt_currency,
         operation.status AS operation_status,
         operation.attempt_count AS operation_attempt_count,
         operation.provider_installation_id AS operation_provider_installation_id,
         operation.subject_id AS operation_subject_id,
         operation.kind AS operation_kind
       FROM refunds refund
       JOIN fund_receipts receipt ON receipt.id = refund.source_fund_receipt_id
       JOIN provider_operations operation ON operation.id = $2
       WHERE refund.id = $1
       FOR UPDATE OF refund, operation`,
      [refundId, operationId],
    );
    const refund = result.rows[0];
    if (
      !refund ||
      refund.operation_subject_id !== refundId ||
      refund.operation_kind !== "refund_create" ||
      refund.provider_installation_id !== "mock-payment-v1" ||
      refund.operation_provider_installation_id !== refund.provider_installation_id ||
      refund.receipt_provider_installation_id !== refund.provider_installation_id ||
      refund.receipt_external_payment_id !== refund.original_external_payment_id ||
      refund.receipt_currency !== refund.currency ||
      BigInt(refund.amount_minor) <= 0n ||
      BigInt(refund.amount_minor) > BigInt(refund.receipt_amount_minor) ||
      (refund.source_context === "unclaimed_funds" &&
        BigInt(refund.amount_minor) >
          BigInt(refund.receipt_amount_minor) - BigInt(refund.receipt_allocated_minor))
    ) {
      if (mode === "start" && refund?.operation_status === "queued") {
        await failKnownUnsentRefund(
          client,
          job,
          refundId,
          operationId,
          "Refund snapshot or Provider ownership is invalid before Provider create",
        );
      } else {
        await manualJobWithClient(
          client,
          job,
          "Refund snapshot or Provider ownership is invalid during reconciliation",
        );
      }
      return { kind: "halted" };
    }

    if (
      refund.status === "succeeded" ||
      refund.status === "failed" ||
      refund.operation_status === "succeeded" ||
      refund.operation_status === "failed"
    ) {
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }
    if (mode === "reconcile") {
      if (refund.operation_attempt_count === 0) {
        await manualJobWithClient(
          client,
          job,
          "Refund reconciliation cannot run before the Provider create attempt",
        );
        return { kind: "halted" };
      }
      return {
        kind: "call",
        value: {
          originalExternalPaymentId: refund.original_external_payment_id,
          amountMinor: refund.amount_minor,
          currency: refund.currency,
          scenario: refund.scenario,
        },
      };
    }

    if (
      refund.status !== "queued" ||
      refund.operation_status !== "queued" ||
      refund.operation_attempt_count !== 0
    ) {
      await manualJobWithClient(
        client,
        job,
        "Refund create was already attempted; reconciliation is required instead of replay",
      );
      return { kind: "halted" };
    }
    const capacity = await client.query<{
      receipt_allocated_minor: string;
      reserved_other_minor: string;
      capacity_frozen: boolean;
    }>(
      `SELECT
         receipt.allocated_minor::text AS receipt_allocated_minor,
         (
           EXISTS (
             SELECT 1
             FROM refunds competing_unknown
             WHERE competing_unknown.source_fund_receipt_id = receipt.id
               AND competing_unknown.id <> $2
               AND competing_unknown.source_context = 'unclaimed_funds'
               AND competing_unknown.status IN ('unknown', 'manual')
           )
           OR EXISTS (
             SELECT 1
             FROM refund_receipt_security_holds security_hold
             WHERE security_hold.source_fund_receipt_id = receipt.id
               AND NOT EXISTS (
                 SELECT 1
                 FROM refund_security_hold_adjudications adjudication
                 WHERE adjudication.receipt_security_hold_id = security_hold.id
               )
           )
         ) AS capacity_frozen,
         CASE
           WHEN EXISTS (
             SELECT 1
             FROM refund_receipt_security_holds security_hold
             WHERE security_hold.source_fund_receipt_id = receipt.id
               AND NOT EXISTS (
                 SELECT 1
                 FROM refund_security_hold_adjudications adjudication
                 WHERE adjudication.receipt_security_hold_id = security_hold.id
               )
           )
           OR EXISTS (
             SELECT 1
             FROM refunds competing_manual
             WHERE competing_manual.source_fund_receipt_id = receipt.id
               AND competing_manual.id <> $2
               AND competing_manual.status = 'manual'
           )
           THEN receipt.amount_minor
           ELSE COALESCE((
             SELECT sum(reserved_outflow.amount_minor)
             FROM (
               SELECT competing.amount_minor
               FROM refunds competing
               WHERE competing.source_fund_receipt_id = receipt.id
                 AND competing.id <> $2
                 AND competing.status IN ('queued', 'processing', 'unknown', 'succeeded')
               UNION ALL
               SELECT discrepancy.amount_minor
               FROM refunds unexpected_refund
               JOIN refund_discrepancy_settlements discrepancy
                 ON discrepancy.refund_id = unexpected_refund.id
               JOIN refund_security_hold_adjudications adjudication
                 ON adjudication.discrepancy_settlement_id = discrepancy.id
                AND adjudication.decision = 'record_unexpected_outflow'
               WHERE unexpected_refund.source_fund_receipt_id = receipt.id
                 AND discrepancy.currency = receipt.currency
               UNION ALL
               SELECT corrected_discrepancy.amount_minor
               FROM refunds corrected_refund
               JOIN refund_discrepancy_settlements corrected_discrepancy
                 ON corrected_discrepancy.refund_id = corrected_refund.id
               JOIN refund_adjudication_corrections correction
                 ON correction.discrepancy_settlement_id = corrected_discrepancy.id
               WHERE corrected_refund.source_fund_receipt_id = receipt.id
                 AND corrected_discrepancy.currency = receipt.currency
             ) reserved_outflow
           ), 0)
         END::text AS reserved_other_minor
       FROM fund_receipts receipt
       WHERE receipt.id = $1`,
      [receiptId, refundId],
    );
    const reservedOtherMinor = capacity.rows[0]?.reserved_other_minor;
    const receiptAllocatedMinor = capacity.rows[0]?.receipt_allocated_minor;
    if (
      reservedOtherMinor === undefined ||
      receiptAllocatedMinor === undefined ||
      (refund.source_context === "unclaimed_funds" && capacity.rows[0]?.capacity_frozen) ||
      BigInt(reservedOtherMinor) +
        BigInt(refund.amount_minor) +
        (refund.source_context === "unclaimed_funds" ? BigInt(receiptAllocatedMinor) : 0n) >
        BigInt(refund.receipt_amount_minor)
    ) {
      await failKnownUnsentRefund(
        client,
        job,
        refundId,
        operationId,
        "Refund capacity changed before Provider create; request stopped without an external side effect",
      );
      return { kind: "halted" };
    }
    if (!authorizationValid) {
      await failKnownUnsentRefund(
        client,
        job,
        refundId,
        operationId,
        "Staff authorization or password confirmation was revoked before refund left Core",
      );
      return { kind: "halted" };
    }

    await client.query(
      `UPDATE refunds
       SET status = 'processing', last_error = NULL,
           updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'queued'`,
      [refundId],
    );
    await client.query(
      `UPDATE provider_operations
       SET status = 'running', attempt_count = attempt_count + 1,
           last_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
      [operationId],
    );
    await client.query(
      `INSERT INTO refund_events(
         refund_id, event_type, actor_type, actor_id, reason, metadata
       ) VALUES ($1, 'processing', 'system', $2, $3, $4)`,
      [
        refundId,
        config.WORKER_ID,
        "Refund request sent to the approved Mock Payment Provider",
        { providerOperationId: operationId },
      ],
    );
    return {
      kind: "call",
      value: {
        originalExternalPaymentId: refund.original_external_payment_id,
        amountMinor: refund.amount_minor,
        currency: refund.currency,
        scenario: refund.scenario,
      },
    };
  });
}

async function markRefundUnknown(
  job: Job,
  refundId: string,
  operationId: string,
  reason: string,
): Promise<void> {
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `refund:${refundId}`,
    ]);
    await assertJobLeaseWithClient(client, job);
    const pointer = await client.query<{ source_fund_receipt_id: string }>(
      "SELECT source_fund_receipt_id FROM refunds WHERE id = $1",
      [refundId],
    );
    const receiptId = pointer.rows[0]?.source_fund_receipt_id;
    if (!receiptId) throw new Error("Refund disappeared while marking an unknown result");
    await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [receiptId]);
    const state = await client.query<{
      refund_status: string;
      operation_status: string;
    }>(
      `SELECT
         refund.status AS refund_status,
         operation.status AS operation_status
       FROM refunds refund
       JOIN provider_operations operation
         ON operation.id = $2
        AND operation.subject_type = 'refund'
        AND operation.subject_id = refund.id
        AND operation.kind = 'refund_create'
       WHERE refund.id = $1
       FOR UPDATE OF refund, operation`,
      [refundId, operationId],
    );
    const current = state.rows[0];
    if (
      !current ||
      current.refund_status === "succeeded" ||
      current.refund_status === "failed" ||
      current.operation_status === "succeeded" ||
      current.operation_status === "failed"
    ) {
      await completeJobWithClient(client, job);
      return;
    }
    await client.query(
      `UPDATE refunds
       SET status = 'unknown', last_error = $2,
           updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'processing'`,
      [refundId, reason.slice(0, 1_000)],
    );
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [operationId, reason.slice(0, 1_000)],
    );
    await client.query(
      `INSERT INTO refund_events(
         refund_id, event_type, actor_type, actor_id, reason, metadata
       ) VALUES ($1, 'unknown', 'system', $2, $3, $4)`,
      [
        refundId,
        config.WORKER_ID,
        reason.slice(0, 1_000),
        { providerOperationId: operationId },
      ],
    );
    await enqueueReconcileWithClient(
      client,
      "refund.reconcile",
      job.unique_key,
      { ...job.payload, operationId },
      config.RECONCILE_BASE_DELAY_SECONDS,
    );
    await completeJobWithClient(client, job);
  });
}

async function finishRefundStartWithWatchdog(
  job: Job,
  refundId: string,
  operationId: string,
): Promise<void> {
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `refund:${refundId}`,
    ]);
    await assertJobLeaseWithClient(client, job);
    const pointer = await client.query<{ source_fund_receipt_id: string }>(
      "SELECT source_fund_receipt_id FROM refunds WHERE id = $1",
      [refundId],
    );
    const receiptId = pointer.rows[0]?.source_fund_receipt_id;
    if (!receiptId) {
      await manualJobWithClient(client, job, "Refund disappeared after Provider create");
      return;
    }
    await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [receiptId]);
    const state = await client.query<{ refund_status: string; operation_status: string }>(
      `SELECT
         refund.status AS refund_status,
         operation.status AS operation_status
       FROM refunds refund
       JOIN provider_operations operation
         ON operation.id = $2
        AND operation.subject_type = 'refund'
        AND operation.subject_id = refund.id
        AND operation.kind = 'refund_create'
       WHERE refund.id = $1
       FOR UPDATE OF refund, operation`,
      [refundId, operationId],
    );
    const current = state.rows[0];
    if (
      current &&
      current.refund_status !== "succeeded" &&
      current.refund_status !== "failed" &&
      current.operation_status !== "succeeded" &&
      current.operation_status !== "failed"
    ) {
      await enqueueReconcileWithClient(
        client,
        "refund.reconcile",
        job.unique_key,
        { ...job.payload, operationId },
        config.WATCHDOG_DELAY_SECONDS,
      );
    }
    await completeJobWithClient(client, job);
  });
}

async function startRefund(job: Job): Promise<void> {
  const refundId = job.payload.refundId;
  const operationId = job.payload.providerOperationId;
  if (!refundId || !operationId) throw new Error("Invalid refund.start payload");
  const preflight = await preflightRefund(job, refundId, operationId, "start");
  if (preflight.kind === "halted") return;
  const callbackCapability = providerOperationCapability(
    config.PROVIDER_OPERATION_CAPABILITY_SECRET,
    "mock-payment-v1",
    operationId,
  );
  try {
    const response = await providerRequest(
      config.MOCK_PAYMENT_PROVIDER_URL,
      config.MOCK_PAYMENT_PROVIDER_TOKEN,
      "/v1/refunds",
      {
        method: "POST",
        headers: { "Idempotency-Key": operationId },
        body: JSON.stringify({
          operationId,
          refundId,
          callbackCapability,
          originalExternalPaymentId: preflight.value.originalExternalPaymentId,
          amountMinor: preflight.value.amountMinor,
          currency: preflight.value.currency,
          scenario: preflight.value.scenario,
        }),
      },
    );
    if (!response.ok) {
      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        await markRefundUnknown(
          job,
          refundId,
          operationId,
          `Refund create returned ambiguous HTTP ${response.status}; reconciliation required`,
        );
        return;
      }
      await transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `refund:${refundId}`,
        ]);
        const pointer = await client.query<{ source_fund_receipt_id: string }>(
          "SELECT source_fund_receipt_id FROM refunds WHERE id = $1",
          [refundId],
        );
        const receiptId = pointer.rows[0]?.source_fund_receipt_id;
        if (receiptId) {
          await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [receiptId]);
        }
        const current = await client.query<{
          refund_status: string;
          operation_status: string;
        }>(
          `SELECT
             refund.status AS refund_status,
             operation.status AS operation_status
           FROM refunds refund
           JOIN provider_operations operation
             ON operation.id = $2
            AND operation.subject_type = 'refund'
            AND operation.subject_id = refund.id
            AND operation.kind = 'refund_create'
           WHERE refund.id = $1
           FOR UPDATE OF refund, operation`,
          [refundId, operationId],
        );
        const terminal = current.rows[0];
        if (
          !terminal ||
          terminal.refund_status === "succeeded" ||
          terminal.refund_status === "failed" ||
          terminal.operation_status === "succeeded" ||
          terminal.operation_status === "failed"
        ) {
          await completeJobWithClient(client, job);
          return;
        }
        await client.query(
          `UPDATE refunds
           SET status = 'failed', last_error = $2,
               updated_at = now(), version = version + 1
           WHERE id = $1 AND status = 'processing'`,
          [refundId, `Provider definitively rejected refund with HTTP ${response.status}`],
        );
        await client.query(
          `UPDATE provider_operations
           SET status = 'failed', last_error = $2, updated_at = now()
           WHERE id = $1 AND status = 'running'`,
          [operationId, `Provider definitively rejected refund with HTTP ${response.status}`],
        );
        await client.query(
          `INSERT INTO refund_events(
             refund_id, event_type, actor_type, actor_id, reason, metadata
           ) VALUES ($1, 'failed', 'system', $2, $3, $4)`,
          [
            refundId,
            config.WORKER_ID,
            "Provider definitively rejected refund before settlement",
            { providerOperationId: operationId, httpStatus: response.status },
          ],
        );
        await completeJobWithClient(client, job);
      });
      return;
    }
    await finishRefundStartWithWatchdog(job, refundId, operationId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await markRefundUnknown(
      job,
      refundId,
      operationId,
      `Refund create transport result is unknown (${message}); reconciliation required`,
    );
  }
}

async function startAddFunds(job: Job): Promise<void> {
  const addFundsAttemptId = job.payload.addFundsAttemptId;
  const providerOperationId = job.payload.providerOperationId;
  if (!addFundsAttemptId || !providerOperationId) {
    throw new Error("Invalid add_funds.start payload");
  }
  const preflight = await preflightAddFunds(
    job,
    addFundsAttemptId,
    providerOperationId,
    "start",
  );
  if (preflight.kind === "halted") return;
  const callbackCapability = providerOperationCapability(
    config.PROVIDER_OPERATION_CAPABILITY_SECRET,
    "mock-payment-v1",
    providerOperationId,
  );
  try {
    const response = await providerRequest(
      config.MOCK_PAYMENT_PROVIDER_URL,
      config.MOCK_PAYMENT_PROVIDER_TOKEN,
      "/v1/payments",
      {
        method: "POST",
        headers: { "Idempotency-Key": providerOperationId },
        body: JSON.stringify({
          operationId: providerOperationId,
          paymentAttemptId: addFundsAttemptId,
          callbackCapability,
          amountMinor: preflight.value.amountMinor,
          currency: preflight.value.currency,
          scenario: preflight.value.scenario,
        }),
      },
      preflight.value.scenario === "delayed_definitive_reject" ? 30_000 : config.PROVIDER_TIMEOUT_MS,
    );
    if (!response.ok) {
      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        await markUnknown(
          job,
          providerOperationId,
          "add_funds_attempts",
          addFundsAttemptId,
          "add_funds.reconcile",
          `Add Funds create returned ambiguous HTTP ${response.status}; reconciliation required`,
        );
        return;
      }
      await transaction(async (client) => {
        await failKnownUnsentAddFunds(
          client,
          job,
          providerOperationId,
          addFundsAttemptId,
          `Payment Provider definitively rejected Add Funds with HTTP ${response.status}`,
        );
      });
      return;
    }
    await finishStartWithWatchdog(job, providerOperationId, "add_funds.reconcile");
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await markUnknown(
      job,
      providerOperationId,
      "add_funds_attempts",
      addFundsAttemptId,
      "add_funds.reconcile",
      `Add Funds create transport result is unknown (${message}); reconciliation required`,
    );
  }
}

async function startPayment(job: Job): Promise<void> {
  const paymentAttemptId = job.payload.paymentAttemptId;
  const providerOperationId = job.payload.providerOperationId;
  if (!paymentAttemptId || !providerOperationId) throw new Error("Invalid payment.start payload");
  const preflight = await preflightPayment(job, paymentAttemptId, providerOperationId, "start");
  if (preflight.kind === "halted") return;
  const payment = preflight.value;
  const callbackCapability = providerOperationCapability(
    config.PROVIDER_OPERATION_CAPABILITY_SECRET,
    "mock-payment-v1",
    providerOperationId,
  );
  try {
    const response = await providerRequest(
      config.MOCK_PAYMENT_PROVIDER_URL,
      config.MOCK_PAYMENT_PROVIDER_TOKEN,
      "/v1/payments",
      {
        method: "POST",
        headers: { "Idempotency-Key": providerOperationId },
        body: JSON.stringify({
          operationId: providerOperationId,
          paymentAttemptId,
          callbackCapability,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          scenario: payment.scenario,
        }),
      },
    );
    if (!response.ok) {
      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        await markUnknown(
          job,
          providerOperationId,
          "payment_attempts",
          paymentAttemptId,
          "payment.reconcile",
          `payment create returned ambiguous HTTP ${response.status}; reconciliation required`,
        );
        return;
      }
      await rejectPaymentStartManually(
        job,
        providerOperationId,
        paymentAttemptId,
        `payment provider definitively rejected create with HTTP ${response.status}`,
      );
      return;
    }
    await finishStartWithWatchdog(job, providerOperationId, "payment.reconcile");
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await markUnknown(
      job,
      providerOperationId,
      "payment_attempts",
      paymentAttemptId,
      "payment.reconcile",
      `payment create transport result is unknown (${message}); reconciliation required`,
    );
  }
}

async function startProvision(job: Job): Promise<void> {
  const serviceId = job.payload.serviceId;
  const providerOperationId = job.payload.providerOperationId;
  if (!serviceId || !providerOperationId) throw new Error("Invalid provision.start payload");
  const preflight = await preflightProvision(job, serviceId, providerOperationId, "start");
  if (preflight.kind === "halted") return;
  const callbackCapability = providerOperationCapability(
    config.PROVIDER_OPERATION_CAPABILITY_SECRET,
    "mock-provisioning-v1",
    providerOperationId,
  );
  try {
    const response = await providerRequest(
      config.MOCK_PROVISIONING_PROVIDER_URL,
      config.MOCK_PROVISIONING_PROVIDER_TOKEN,
      "/v1/resources",
      {
        method: "POST",
        headers: { "Idempotency-Key": providerOperationId },
        body: JSON.stringify({
          operationId: providerOperationId,
          serviceId,
          callbackCapability,
          scenario: config.MOCK_PROVISION_SCENARIO,
        }),
      },
    );
    if (!response.ok) {
      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        await markUnknown(
          job,
          providerOperationId,
          "services",
          serviceId,
          "provision.reconcile",
          `resource create returned ambiguous HTTP ${response.status}; reconciliation required`,
        );
        return;
      }
      await rejectProvisionStartManually(
        job,
        providerOperationId,
        serviceId,
        `provisioning provider definitively rejected create with HTTP ${response.status}`,
      );
      return;
    }
    await finishStartWithWatchdog(job, providerOperationId, "provision.reconcile");
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await markUnknown(
      job,
      providerOperationId,
      "services",
      serviceId,
      "provision.reconcile",
      `resource create transport result is unknown (${message}); reconciliation required`,
    );
  }
}

async function markServiceActionUnknown(
  job: Job,
  action: ServiceAction,
  caseId: string,
  serviceId: string,
  providerOperationId: string,
  reason: string,
): Promise<void> {
  await transaction(async (client) => {
    const state = await lockServiceActionState(
      client,
      job,
      action,
      caseId,
      serviceId,
      providerOperationId,
    );
    if (!state) {
      await manualJobWithClient(
        client,
        job,
        "resource action became inconsistent after Provider delivery",
      );
      return;
    }
    const names = serviceActionNames(action);
    if (
      (state.operation_status === "succeeded" &&
        state.case_status === names.terminalCaseStatus &&
        state.service_status === names.terminalServiceStatus) ||
      (state.operation_status === "failed" && state.case_status === "manual")
    ) {
      await completeJobWithClient(client, job);
      return;
    }
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [providerOperationId, reason.slice(0, 1_000)],
    );
    await client.query(
      `UPDATE service_suspension_cases
       SET status = $2, last_error = $3, updated_at = now(), version = version + 1
       WHERE id = $1 AND status IN ($4, $5)`,
      [
        caseId,
        names.unknownStatus,
        reason.slice(0, 1_000),
        names.startStatus,
        names.processingStatus,
      ],
    );
    await enqueueReconcileWithClient(
      client,
      names.reconcileType,
      job.unique_key,
      { caseId, serviceId, providerOperationId },
      config.RECONCILE_BASE_DELAY_SECONDS,
    );
    await completeJobWithClient(client, job);
  });
}

async function rejectServiceActionStartManually(
  job: Job,
  action: ServiceAction,
  caseId: string,
  serviceId: string,
  providerOperationId: string,
  reason: string,
): Promise<void> {
  await transaction(async (client) => {
    const state = await lockServiceActionState(
      client,
      job,
      action,
      caseId,
      serviceId,
      providerOperationId,
    );
    if (!state) {
      await manualJobWithClient(client, job, reason);
      return;
    }
    const names = serviceActionNames(action);
    if (
      state.operation_status === "succeeded" &&
      state.case_status === names.terminalCaseStatus &&
      state.service_status === names.terminalServiceStatus
    ) {
      await completeJobWithClient(client, job);
      return;
    }
    await setServiceActionManualWithClient(
      client,
      job,
      state,
      providerOperationId,
      action,
      reason,
      true,
    );
  });
}

async function delayServiceActionReconcile(
  job: Job,
  action: ServiceAction,
  caseId: string,
  serviceId: string,
  providerOperationId: string,
  reason: string,
  forceManual = false,
): Promise<void> {
  await transaction(async (client) => {
    const state = await lockServiceActionState(
      client,
      job,
      action,
      caseId,
      serviceId,
      providerOperationId,
    );
    if (!state) {
      await manualJobWithClient(client, job, reason);
      return;
    }
    const names = serviceActionNames(action);
    if (
      (state.operation_status === "succeeded" &&
        state.case_status === names.terminalCaseStatus &&
        state.service_status === names.terminalServiceStatus) ||
      (state.operation_status === "failed" && state.case_status === "manual")
    ) {
      await completeJobWithClient(client, job);
      return;
    }
    const manual = forceManual || job.attempts >= config.RECONCILE_MAX_ATTEMPTS;
    if (manual) {
      await setServiceActionManualWithClient(
        client,
        job,
        state,
        providerOperationId,
        action,
        reason,
      );
      return;
    }
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [providerOperationId, reason.slice(0, 1_000)],
    );
    const updated = await client.query(
      `UPDATE durable_jobs
       SET status = 'pending',
           available_at = now() + make_interval(secs => $2),
           locked_at = NULL, locked_by = NULL, last_error = $3, updated_at = now()
       WHERE id = $1 AND status = 'running' AND locked_by = $4 AND attempts = $5
       RETURNING id`,
      [
        job.id,
        reconcileDelaySeconds(job.attempts),
        reason.slice(0, 1_000),
        config.WORKER_ID,
        job.attempts,
      ],
    );
    if (updated.rowCount !== 1) throw new LostJobLeaseError(job.id);
  });
}

async function startServiceAction(job: Job, action: ServiceAction): Promise<void> {
  const caseId = job.payload.caseId;
  const serviceId = job.payload.serviceId;
  const providerOperationId = job.payload.providerOperationId;
  if (!caseId || !serviceId || !providerOperationId) {
    throw new Error(`Invalid service.${action}.start payload`);
  }
  const preflight = await preflightServiceAction(
    job,
    action,
    caseId,
    serviceId,
    providerOperationId,
    "start",
  );
  if (preflight.kind === "halted") return;
  const callbackCapability = providerOperationCapability(
    config.PROVIDER_OPERATION_CAPABILITY_SECRET,
    "mock-provisioning-v1",
    providerOperationId,
  );
  try {
    const response = await providerRequest(
      config.MOCK_PROVISIONING_PROVIDER_URL,
      config.MOCK_PROVISIONING_PROVIDER_TOKEN,
      "/v1/resource-actions",
      {
        method: "POST",
        headers: { "Idempotency-Key": providerOperationId },
        body: JSON.stringify({
          operationId: providerOperationId,
          serviceId,
          externalResourceId: preflight.value.externalResourceId,
          callbackCapability,
          action,
          scenario: config.MOCK_RESOURCE_ACTION_SCENARIO,
        }),
      },
    );
    if (!response.ok) {
      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        await markServiceActionUnknown(
          job,
          action,
          caseId,
          serviceId,
          providerOperationId,
          `resource ${action} returned ambiguous HTTP ${response.status}; reconciliation required`,
        );
        return;
      }
      await rejectServiceActionStartManually(
        job,
        action,
        caseId,
        serviceId,
        providerOperationId,
        `resource ${action} was definitively rejected with HTTP ${response.status}`,
      );
      return;
    }
    await finishStartWithWatchdog(
      job,
      providerOperationId,
      serviceActionNames(action).reconcileType,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await markServiceActionUnknown(
      job,
      action,
      caseId,
      serviceId,
      providerOperationId,
      `resource ${action} transport result is unknown (${message}); reconciliation required`,
    );
  }
}

async function reconcileServiceAction(job: Job, action: ServiceAction): Promise<void> {
  const caseId = job.payload.caseId;
  const serviceId = job.payload.serviceId;
  const providerOperationId = job.payload.providerOperationId ?? job.payload.operationId;
  if (!caseId || !serviceId || !providerOperationId) {
    throw new Error(`Invalid service.${action}.reconcile payload`);
  }
  const preflight = await preflightServiceAction(
    job,
    action,
    caseId,
    serviceId,
    providerOperationId,
    "reconcile",
  );
  if (preflight.kind === "halted") return;

  let response: Response;
  try {
    response = await providerRequest(
      config.MOCK_PROVISIONING_PROVIDER_URL,
      config.MOCK_PROVISIONING_PROVIDER_TOKEN,
      `/v1/resource-actions/${encodeURIComponent(providerOperationId)}`,
      { method: "GET" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await delayServiceActionReconcile(
      job,
      action,
      caseId,
      serviceId,
      providerOperationId,
      `resource ${action} reconciliation transport failed: ${message}`,
    );
    return;
  }
  if (
    response.status === 404 ||
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    await delayServiceActionReconcile(
      job,
      action,
      caseId,
      serviceId,
      providerOperationId,
      `resource ${action} is not yet reconcilable at the Provider (HTTP ${response.status})`,
    );
    return;
  }
  if (!response.ok) {
    await delayServiceActionReconcile(
      job,
      action,
      caseId,
      serviceId,
      providerOperationId,
      `resource ${action} reconciliation requires manual intervention (HTTP ${response.status})`,
      true,
    );
    return;
  }

  let fact: {
    callbackCapability: string;
    serviceId: string;
    externalResourceId: string;
    action: ServiceAction;
    status: "succeeded" | "failed";
    occurredAt: string;
  };
  try {
    fact = z
      .object({
        callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        serviceId: z.uuid(),
        externalResourceId: z.string().min(1).max(200),
        action: z.enum(["suspend", "resume"]),
        status: z.enum(["succeeded", "failed"]),
        occurredAt: z.iso.datetime({ offset: true }),
      })
      .parse(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid Provider response";
    await delayServiceActionReconcile(
      job,
      action,
      caseId,
      serviceId,
      providerOperationId,
      `resource ${action} reconciliation response is invalid: ${message}`,
      true,
    );
    return;
  }
  if (
    fact.action !== action ||
    fact.serviceId !== serviceId ||
    fact.externalResourceId !== preflight.value.externalResourceId ||
    !providerOperationCapabilityMatches(
      fact.callbackCapability,
      config.PROVIDER_OPERATION_CAPABILITY_SECRET,
      "mock-provisioning-v1",
      providerOperationId,
    )
  ) {
    await delayServiceActionReconcile(
      job,
      action,
      caseId,
      serviceId,
      providerOperationId,
      `resource ${action} reconciliation returned mismatched ownership or operation capability`,
      true,
    );
    return;
  }

  const coreOutcome = await submitReconciledEvent(
    "/api/v1/provider-events/resource-action",
    {
      eventId: `reconcile:resource-action:${providerOperationId}:${randomUUID()}`,
      providerOperationId,
      ...fact,
    },
    config.MOCK_PROVISIONING_WEBHOOK_SECRET,
  );
  if (coreOutcome.kind === "retry") {
    await delayServiceActionReconcile(
      job,
      action,
      caseId,
      serviceId,
      providerOperationId,
      coreOutcome.reason,
    );
    return;
  }
  await completeJob(job);
}

type CancellationExecutionState = {
  request_id: string;
  effective_at: Date;
  execution_id: string;
  execution_mode: "automatic" | "manual";
  execution_status: "scheduled" | "processing" | "unknown" | "manual" | "terminated";
  execution_provider_installation_id: string | null;
  service_id: string;
  service_status: string;
  service_cancellation_request_id: string | null;
  external_resource_id: string | null;
  binding_cancellation_execution_mode: string | null;
  binding_provider_installation_id: string | null;
  binding_capabilities: unknown;
  provider_enabled: boolean | null;
  current_provider_capabilities: unknown;
  operation_id: string | null;
  operation_provider_installation_id: string | null;
  operation_kind: string | null;
  operation_subject_type: string | null;
  operation_subject_id: string | null;
  operation_stable_key: string | null;
  operation_status: string | null;
  operation_attempt_count: number | null;
};

type CancellationCall = { externalResourceId: string };

async function lockCancellationState(
  client: DatabaseClient,
  job: Job,
  requestId: string,
  executionId: string,
  serviceId: string,
  providerOperationId: string | null,
): Promise<CancellationExecutionState | null> {
  if (providerOperationId) await lockProviderOperation(client, providerOperationId);
  const pointer = await client.query<{ order_item_id: string; service_id: string }>(
    `SELECT service.order_item_id, service.id AS service_id
     FROM service_cancellation_executions execution
     JOIN service_cancellation_requests cancellation_request
       ON cancellation_request.id = execution.cancellation_request_id
     JOIN services service ON service.id = execution.service_id
     WHERE cancellation_request.id = $1
       AND execution.id = $2
       AND service.id = $3`,
    [requestId, executionId, serviceId],
  );
  const target = pointer.rows[0];
  if (!target) {
    await assertJobLeaseWithClient(client, job);
    return null;
  }
  await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
    target.order_item_id,
  ]);
  await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [target.service_id]);
  await client.query(
    "SELECT id FROM service_cancellation_requests WHERE id = $1 FOR UPDATE",
    [requestId],
  );
  await client.query(
    "SELECT id FROM service_cancellation_executions WHERE id = $1 FOR UPDATE",
    [executionId],
  );
  if (providerOperationId) {
    await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [
      providerOperationId,
    ]);
  }
  await assertJobLeaseWithClient(client, job);
  const result = await client.query<CancellationExecutionState>(
    `SELECT cancellation_request.id AS request_id,
            cancellation_request.effective_at,
            execution.id AS execution_id,
            execution.execution_mode,
            execution.status AS execution_status,
            execution.provider_installation_id AS execution_provider_installation_id,
            service.id AS service_id,
            service.status AS service_status,
            service.cancellation_request_id AS service_cancellation_request_id,
            service.external_resource_id,
            binding.cycle_end_cancellation_execution_mode_snapshot
              AS binding_cancellation_execution_mode,
            binding.provider_installation_id AS binding_provider_installation_id,
            binding.capability_snapshot AS binding_capabilities,
            provider.enabled AS provider_enabled,
            provider.capabilities AS current_provider_capabilities,
            operation.id AS operation_id,
            operation.provider_installation_id AS operation_provider_installation_id,
            operation.kind AS operation_kind,
            operation.subject_type AS operation_subject_type,
            operation.subject_id AS operation_subject_id,
            operation.stable_key AS operation_stable_key,
            operation.status AS operation_status,
            operation.attempt_count AS operation_attempt_count
     FROM service_cancellation_requests cancellation_request
     JOIN service_cancellation_executions execution
       ON execution.cancellation_request_id = cancellation_request.id
     JOIN services service ON service.id = execution.service_id
     LEFT JOIN service_provider_bindings binding ON binding.service_id = service.id
     LEFT JOIN provider_installation_capabilities provider
       ON provider.provider_installation_id = binding.provider_installation_id
     LEFT JOIN provider_operations operation
       ON operation.id = $4
      AND operation.subject_type = 'service_cancellation_execution'
      AND operation.subject_id = execution.id
     WHERE cancellation_request.id = $1
       AND execution.id = $2
       AND service.id = $3`,
    [requestId, executionId, serviceId, providerOperationId],
  );
  return result.rows[0] ?? null;
}

async function setCancellationManualWithClient(
  client: DatabaseClient,
  job: Job,
  state: CancellationExecutionState,
  reason: string,
  definitivelyRejected: boolean,
): Promise<void> {
  const potentiallySent =
    (state.operation_attempt_count ?? 0) > 0 ||
    state.operation_status === "running" ||
    state.operation_status === "unknown";
  if (state.operation_id) {
    await client.query(
      `UPDATE provider_operations
       SET status = $2, last_error = $3, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [
        state.operation_id,
        definitivelyRejected || !potentiallySent ? "failed" : "unknown",
        reason.slice(0, 1_000),
      ],
    );
  }
  if (state.execution_status !== "manual" && state.execution_status !== "terminated") {
    await client.query(
      `UPDATE service_cancellation_executions
       SET status = 'manual', result = $2, last_error = $3,
           updated_at = now(), version = version + 1
       WHERE id = $1 AND status NOT IN ('manual', 'terminated')`,
      [
        state.execution_id,
        {
          status: "manual",
          interventionRequired: true,
          potentiallySent,
        },
        reason.slice(0, 1_000),
      ],
    );
  }
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES ('system', $1, 'service.cancellation_manual',
               'service_cancellation_execution', $2, $3, $4)`,
    [
      config.WORKER_ID,
      state.execution_id,
      reason.slice(0, 1_000),
      {
        cancellationRequestId: state.request_id,
        serviceId: state.service_id,
        providerOperationId: state.operation_id,
        potentiallySent,
        definitivelyRejected,
      },
    ],
  );
  await manualJobWithClient(client, job, reason);
}

async function preflightCancellation(
  job: Job,
  requestId: string,
  executionId: string,
  serviceId: string,
  providerOperationId: string | null,
  mode: "start" | "reconcile",
): Promise<PreflightResult<CancellationCall>> {
  return transaction(async (client) => {
    const state = await lockCancellationState(
      client,
      job,
      requestId,
      executionId,
      serviceId,
      providerOperationId,
    );
    if (!state) {
      await manualJobWithClient(
        client,
        job,
        "cancellation job references missing or inconsistent Core records",
      );
      return { kind: "halted" };
    }
    if (state.execution_status === "terminated" && state.service_status === "terminated") {
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }
    if (state.execution_mode === "manual") {
      await setCancellationManualWithClient(
        client,
        job,
        state,
        "Paid-period cancellation reached its due time and requires an administrator to terminate the manually delivered service",
        true,
      );
      return { kind: "halted" };
    }
    if (!providerOperationId || !state.operation_id) {
      await setCancellationManualWithClient(
        client,
        job,
        state,
        "automatic cancellation is missing its stable Provider operation",
        true,
      );
      return { kind: "halted" };
    }

    const stableIdentity =
      state.request_id === requestId &&
      state.execution_id === executionId &&
      state.service_id === serviceId &&
      state.service_cancellation_request_id === requestId &&
      state.operation_id === providerOperationId &&
      state.operation_provider_installation_id === "mock-provisioning-v1" &&
      state.execution_provider_installation_id === "mock-provisioning-v1" &&
      state.operation_kind === "resource_terminate" &&
      state.operation_subject_type === "service_cancellation_execution" &&
      state.operation_subject_id === executionId &&
      state.operation_stable_key === job.unique_key &&
      state.binding_provider_installation_id === "mock-provisioning-v1";
    const currentlyAuthorized =
      state.binding_cancellation_execution_mode === "automatic" &&
      state.provider_enabled === true &&
      capabilityList(state.binding_capabilities).includes("resource_terminate") &&
      capabilityList(state.current_provider_capabilities).includes("resource_terminate");
    if (!stableIdentity || (mode === "start" && !currentlyAuthorized)) {
      await setCancellationManualWithClient(
        client,
        job,
        state,
        !stableIdentity
          ? "cancellation Provider ownership or stable operation identity is inconsistent"
          : "cancellation Provider is paused or no longer authorized for resource termination",
        false,
      );
      return { kind: "halted" };
    }
    if (state.effective_at.getTime() > Date.now()) {
      const deferred = await client.query(
        `UPDATE durable_jobs
         SET status = 'pending', available_at = $2,
             locked_at = NULL, locked_by = NULL,
             last_error = 'cancellation was claimed before its paid period ended',
             updated_at = now()
         WHERE id = $1 AND status = 'running' AND locked_by = $3 AND attempts = $4
         RETURNING id`,
        [job.id, state.effective_at, config.WORKER_ID, job.attempts],
      );
      if (deferred.rowCount !== 1) throw new LostJobLeaseError(job.id);
      return { kind: "halted" };
    }
    if (!state.external_resource_id) {
      await setCancellationManualWithClient(
        client,
        job,
        state,
        "automatic cancellation requires an existing external resource id",
        true,
      );
      return { kind: "halted" };
    }
    if (
      mode === "start" &&
      !["active", "suspended", "provisioned_hold"].includes(state.service_status)
    ) {
      await setCancellationManualWithClient(
        client,
        job,
        state,
        "service is no longer in a state eligible for paid-period termination",
        true,
      );
      return { kind: "halted" };
    }
    if (mode === "reconcile") {
      const possiblySent =
        (state.operation_attempt_count ?? 0) > 0 ||
        state.operation_status === "running" ||
        state.operation_status === "unknown" ||
        state.operation_status === "failed";
      if (!possiblySent) {
        await setCancellationManualWithClient(
          client,
          job,
          state,
          "cancellation reconciliation has no evidence that a terminate request was sent",
          true,
        );
        return { kind: "halted" };
      }
      return { kind: "call", value: { externalResourceId: state.external_resource_id } };
    }

    const mayHaveRun =
      state.execution_status !== "scheduled" ||
      state.operation_status !== "queued" ||
      state.operation_attempt_count !== 0;
    if (mayHaveRun) {
      const reason =
        "terminate may already have been sent; only Provider query reconciliation is allowed";
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
        [providerOperationId, reason],
      );
      if (state.execution_status === "processing") {
        await client.query(
          `UPDATE service_cancellation_executions
           SET status = 'unknown', result = $2, last_error = $3,
               updated_at = now(), version = version + 1
           WHERE id = $1 AND status = 'processing'`,
          [executionId, { status: "unknown", reconciliation: "query_only" }, reason],
        );
      }
      await enqueueReconcileWithClient(
        client,
        "service.cancellation.reconcile",
        job.unique_key,
        { requestId, executionId, serviceId, providerOperationId },
        config.RECONCILE_BASE_DELAY_SECONDS,
      );
      await completeJobWithClient(client, job);
      return { kind: "halted" };
    }

    const executionUpdated = await client.query(
      `UPDATE service_cancellation_executions
       SET status = 'processing', result = $2, last_error = NULL,
           updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'scheduled'
       RETURNING id`,
      [executionId, { status: "processing", providerAction: "terminate" }],
    );
    const operationUpdated = await client.query(
      `UPDATE provider_operations
       SET status = 'running', attempt_count = attempt_count + 1,
           last_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'queued' AND attempt_count = 0
       RETURNING id`,
      [providerOperationId],
    );
    if (executionUpdated.rowCount !== 1 || operationUpdated.rowCount !== 1) {
      throw new Error("cancellation state changed while beginning Provider termination");
    }
    return { kind: "call", value: { externalResourceId: state.external_resource_id } };
  });
}

async function markCancellationUnknown(
  job: Job,
  requestId: string,
  executionId: string,
  serviceId: string,
  providerOperationId: string,
  reason: string,
): Promise<void> {
  await transaction(async (client) => {
    const state = await lockCancellationState(
      client,
      job,
      requestId,
      executionId,
      serviceId,
      providerOperationId,
    );
    if (!state) {
      await manualJobWithClient(client, job, reason);
      return;
    }
    if (state.execution_status === "terminated" && state.service_status === "terminated") {
      await completeJobWithClient(client, job);
      return;
    }
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [providerOperationId, reason.slice(0, 1_000)],
    );
    if (state.execution_status === "processing") {
      await client.query(
        `UPDATE service_cancellation_executions
         SET status = 'unknown', result = $2, last_error = $3,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'processing'`,
        [
          executionId,
          { status: "unknown", reconciliation: "query_only" },
          reason.slice(0, 1_000),
        ],
      );
    }
    await enqueueReconcileWithClient(
      client,
      "service.cancellation.reconcile",
      job.unique_key,
      { requestId, executionId, serviceId, providerOperationId },
      config.RECONCILE_BASE_DELAY_SECONDS,
    );
    await completeJobWithClient(client, job);
  });
}

async function finishCancellationStart(
  job: Job,
  requestId: string,
  executionId: string,
  serviceId: string,
  providerOperationId: string,
): Promise<void> {
  await transaction(async (client) => {
    await lockProviderOperation(client, providerOperationId);
    await assertJobLeaseWithClient(client, job);
    const operation = await client.query<{ status: string }>(
      "SELECT status FROM provider_operations WHERE id = $1 FOR UPDATE",
      [providerOperationId],
    );
    const status = operation.rows[0]?.status;
    if (status && status !== "succeeded" && status !== "failed") {
      await enqueueReconcileWithClient(
        client,
        "service.cancellation.reconcile",
        job.unique_key,
        { requestId, executionId, serviceId, providerOperationId },
        config.WATCHDOG_DELAY_SECONDS,
      );
    }
    await completeJobWithClient(client, job);
  });
}

async function delayCancellationReconcile(
  job: Job,
  requestId: string,
  executionId: string,
  serviceId: string,
  providerOperationId: string,
  reason: string,
  forceManual = false,
): Promise<void> {
  await transaction(async (client) => {
    const state = await lockCancellationState(
      client,
      job,
      requestId,
      executionId,
      serviceId,
      providerOperationId,
    );
    if (!state) {
      await manualJobWithClient(client, job, reason);
      return;
    }
    if (state.execution_status === "terminated" && state.service_status === "terminated") {
      await completeJobWithClient(client, job);
      return;
    }
    if (forceManual || job.attempts >= config.RECONCILE_MAX_ATTEMPTS) {
      await setCancellationManualWithClient(client, job, state, reason, false);
      return;
    }
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [providerOperationId, reason.slice(0, 1_000)],
    );
    if (state.execution_status === "processing") {
      await client.query(
        `UPDATE service_cancellation_executions
         SET status = 'unknown', result = $2, last_error = $3,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'processing'`,
        [executionId, { status: "unknown", reconciliation: "query_only" }, reason.slice(0, 1_000)],
      );
    }
    const delayed = await client.query(
      `UPDATE durable_jobs
       SET status = 'pending',
           available_at = now() + make_interval(secs => $2),
           locked_at = NULL, locked_by = NULL,
           last_error = $3, updated_at = now()
       WHERE id = $1 AND status = 'running' AND locked_by = $4 AND attempts = $5
       RETURNING id`,
      [
        job.id,
        reconcileDelaySeconds(job.attempts),
        reason.slice(0, 1_000),
        config.WORKER_ID,
        job.attempts,
      ],
    );
    if (delayed.rowCount !== 1) throw new LostJobLeaseError(job.id);
  });
}

async function startCancellation(job: Job): Promise<void> {
  const requestId = job.payload.cancellationRequestId ?? job.payload.requestId;
  const executionId = job.payload.executionId;
  const serviceId = job.payload.serviceId;
  const providerOperationId = job.payload.providerOperationId ?? null;
  if (!requestId || !executionId || !serviceId) {
    throw new Error("Invalid service.cancellation.due payload");
  }
  const preflight = await preflightCancellation(
    job,
    requestId,
    executionId,
    serviceId,
    providerOperationId,
    "start",
  );
  if (preflight.kind === "halted") return;
  if (!providerOperationId) throw new Error("Automatic cancellation lacks Provider operation id");
  const configuredScenario = job.payload.scenario;
  const scenario =
    configuredScenario === "success" ||
    configuredScenario === "failed" ||
    configuredScenario === "timeout_success" ||
    configuredScenario === "duplicate_out_of_order"
      ? configuredScenario
      : config.MOCK_RESOURCE_ACTION_SCENARIO;
  const callbackCapability = providerOperationCapability(
    config.PROVIDER_OPERATION_CAPABILITY_SECRET,
    "mock-provisioning-v1",
    providerOperationId,
  );
  try {
    const response = await providerRequest(
      config.MOCK_PROVISIONING_PROVIDER_URL,
      config.MOCK_PROVISIONING_PROVIDER_TOKEN,
      "/v1/resource-actions",
      {
        method: "POST",
        headers: { "Idempotency-Key": providerOperationId },
        body: JSON.stringify({
          operationId: providerOperationId,
          serviceId,
          externalResourceId: preflight.value.externalResourceId,
          callbackCapability,
          action: "terminate",
          scenario,
        }),
      },
    );
    if (!response.ok) {
      if (
        response.status === 408 ||
        response.status === 409 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        await markCancellationUnknown(
          job,
          requestId,
          executionId,
          serviceId,
          providerOperationId,
          `resource terminate returned ambiguous HTTP ${response.status}; query-only reconciliation required`,
        );
        return;
      }
      await transaction(async (client) => {
        const state = await lockCancellationState(
          client,
          job,
          requestId,
          executionId,
          serviceId,
          providerOperationId,
        );
        if (!state) return manualJobWithClient(client, job, "termination request was rejected");
        return setCancellationManualWithClient(
          client,
          job,
          state,
          `resource terminate was definitively rejected with HTTP ${response.status}`,
          true,
        );
      });
      return;
    }
    await finishCancellationStart(
      job,
      requestId,
      executionId,
      serviceId,
      providerOperationId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await markCancellationUnknown(
      job,
      requestId,
      executionId,
      serviceId,
      providerOperationId,
      `resource terminate transport result is unknown (${message}); query-only reconciliation required`,
    );
  }
}

async function reconcileCancellation(job: Job): Promise<void> {
  const requestId = job.payload.cancellationRequestId ?? job.payload.requestId;
  const executionId = job.payload.executionId;
  const serviceId = job.payload.serviceId;
  const providerOperationId = job.payload.providerOperationId ?? job.payload.operationId;
  if (!requestId || !executionId || !serviceId || !providerOperationId) {
    throw new Error("Invalid service.cancellation.reconcile payload");
  }
  const preflight = await preflightCancellation(
    job,
    requestId,
    executionId,
    serviceId,
    providerOperationId,
    "reconcile",
  );
  if (preflight.kind === "halted") return;

  let response: Response;
  try {
    response = await providerRequest(
      config.MOCK_PROVISIONING_PROVIDER_URL,
      config.MOCK_PROVISIONING_PROVIDER_TOKEN,
      `/v1/resource-actions/${encodeURIComponent(providerOperationId)}`,
      { method: "GET" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await delayCancellationReconcile(
      job,
      requestId,
      executionId,
      serviceId,
      providerOperationId,
      `termination reconciliation transport failed: ${message}`,
    );
    return;
  }
  if (
    response.status === 404 ||
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    await delayCancellationReconcile(
      job,
      requestId,
      executionId,
      serviceId,
      providerOperationId,
      `termination is not yet reconcilable at the Provider (HTTP ${response.status})`,
    );
    return;
  }
  if (!response.ok) {
    await delayCancellationReconcile(
      job,
      requestId,
      executionId,
      serviceId,
      providerOperationId,
      `termination reconciliation requires manual intervention (HTTP ${response.status})`,
      true,
    );
    return;
  }

  let fact: {
    callbackCapability: string;
    serviceId: string;
    externalResourceId: string;
    action: "terminate";
    status: "succeeded" | "failed";
    occurredAt: string;
  };
  try {
    fact = z
      .object({
        callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        serviceId: z.uuid(),
        externalResourceId: z.string().min(1).max(200),
        action: z.literal("terminate"),
        status: z.enum(["succeeded", "failed"]),
        occurredAt: z.iso.datetime({ offset: true }),
      })
      .parse(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid Provider response";
    await delayCancellationReconcile(
      job,
      requestId,
      executionId,
      serviceId,
      providerOperationId,
      `termination reconciliation response is invalid: ${message}`,
      true,
    );
    return;
  }
  if (
    fact.serviceId !== serviceId ||
    fact.externalResourceId !== preflight.value.externalResourceId ||
    !providerOperationCapabilityMatches(
      fact.callbackCapability,
      config.PROVIDER_OPERATION_CAPABILITY_SECRET,
      "mock-provisioning-v1",
      providerOperationId,
    )
  ) {
    await delayCancellationReconcile(
      job,
      requestId,
      executionId,
      serviceId,
      providerOperationId,
      "termination reconciliation returned mismatched ownership or operation capability",
      true,
    );
    return;
  }
  const coreOutcome = await submitReconciledEvent(
    "/api/v1/provider-events/resource-termination",
    {
      eventId: `reconcile:resource-termination:${providerOperationId}:${randomUUID()}`,
      providerOperationId,
      ...fact,
    },
    config.MOCK_PROVISIONING_WEBHOOK_SECRET,
  );
  if (coreOutcome.kind === "retry") {
    await delayCancellationReconcile(
      job,
      requestId,
      executionId,
      serviceId,
      providerOperationId,
      coreOutcome.reason,
    );
    return;
  }
  await completeJob(job);
}

async function recoverOneStaleServiceActionJob(candidate: Job): Promise<boolean> {
  const action: ServiceAction | null = candidate.job_type.startsWith("service.suspend.")
    ? "suspend"
    : candidate.job_type.startsWith("service.resume.")
      ? "resume"
      : null;
  if (!action) return false;
  const start = candidate.job_type.endsWith(".start");
  const caseId = candidate.payload.caseId;
  const serviceId = candidate.payload.serviceId;
  const providerOperationId =
    candidate.payload.providerOperationId ?? candidate.payload.operationId;
  if (!caseId || !serviceId || !providerOperationId) {
    return transaction(async (client) => {
      const job = await lockStaleJobWithClient(client, candidate);
      if (!job) return false;
      await manualRecoveredJobWithClient(
        client,
        job,
        "stale service action job has an invalid payload; manual inspection required",
      );
      return true;
    });
  }

  return transaction(async (client) => {
    await lockProviderOperation(client, providerOperationId);
    const pointer = await client.query<{
      invoice_id: string;
      renewal_id: string;
      service_id: string;
      order_item_id: string;
    }>(
      `SELECT suspension_case.invoice_id,
              suspension_case.service_renewal_id AS renewal_id,
              suspension_case.service_id,
              service.order_item_id
       FROM service_suspension_cases suspension_case
       JOIN services service ON service.id = suspension_case.service_id
       WHERE suspension_case.id = $1`,
      [caseId],
    );
    const target = pointer.rows[0];
    if (target) {
      await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [target.invoice_id]);
      await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
        target.order_item_id,
      ]);
      await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
        target.service_id,
      ]);
      await client.query("SELECT id FROM service_renewals WHERE id = $1 FOR UPDATE", [
        target.renewal_id,
      ]);
      await client.query("SELECT id FROM service_suspension_cases WHERE id = $1 FOR UPDATE", [
        caseId,
      ]);
      await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [
        providerOperationId,
      ]);
    }
    const job = await lockStaleJobWithClient(client, candidate);
    if (!job) return false;
    if (!target) {
      await manualRecoveredJobWithClient(
        client,
        job,
        "stale service action job references missing Core records",
      );
      return true;
    }
    const names = serviceActionNames(action);
    const state = await client.query<{
      case_status: string;
      service_id: string;
      service_status: string;
      operation_status: string;
      operation_attempt_count: number;
      operation_kind: string;
      operation_subject_id: string;
    }>(
      `SELECT suspension_case.status AS case_status,
              service.id AS service_id,
              service.status AS service_status,
              operation.status AS operation_status,
              operation.attempt_count AS operation_attempt_count,
              operation.kind AS operation_kind,
              operation.subject_id AS operation_subject_id
       FROM service_suspension_cases suspension_case
       JOIN services service ON service.id = suspension_case.service_id
       JOIN provider_operations operation ON operation.id = $2
       WHERE suspension_case.id = $1`,
      [caseId, providerOperationId],
    );
    const current = state.rows[0];
    if (
      !current ||
      current.service_id !== serviceId ||
      current.operation_kind !== names.operationKind ||
      current.operation_subject_id !== caseId
    ) {
      const reason =
        "stale service action job references a missing or inconsistent Provider operation";
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $3, updated_at = now()
         WHERE id = $1
           AND subject_type = 'service_suspension_case'
           AND subject_id = $2
           AND status NOT IN ('succeeded', 'failed')`,
        [providerOperationId, caseId, reason],
      );
      await client.query(
        `UPDATE service_suspension_cases
         SET status = 'manual',
             resume_required = CASE WHEN $2 = 'resume' THEN true ELSE resume_required END,
             last_error = $3, updated_at = now(), version = version + 1
         WHERE id = $1 AND status <> 'resolved'`,
        [caseId, action, reason],
      );
      await client.query(
        `INSERT INTO audit_events(
           actor_type, actor_id, action, target_type, target_id, reason, metadata
         ) VALUES ('system', $1, 'service.action_stale_recovery_manual',
                   'service_suspension_case', $2, $3, $4)`,
        [
          config.WORKER_ID,
          caseId,
          reason,
          { providerOperationId, payloadServiceId: serviceId },
        ],
      );
      await manualRecoveredJobWithClient(
        client,
        job,
        reason,
      );
      return true;
    }
    if (
      (current.operation_status === "succeeded" &&
        current.case_status === names.terminalCaseStatus &&
        current.service_status === names.terminalServiceStatus) ||
      (current.operation_status === "failed" && current.case_status === "manual") ||
      current.case_status === "resolved"
    ) {
      await completeRecoveredJobWithClient(client, job);
      return true;
    }

    if (
      start &&
      current.operation_status === "queued" &&
      current.operation_attempt_count === 0 &&
      current.case_status === names.startStatus
    ) {
      if (job.attempts >= config.MAX_JOB_ATTEMPTS) {
        const reason =
          "known-unsent resource action repeatedly lost its worker lease; manual intervention required";
        await client.query(
          `UPDATE provider_operations
           SET status = 'failed', last_error = $2, updated_at = now()
           WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
          [providerOperationId, reason],
        );
        await client.query(
          `UPDATE service_suspension_cases
           SET status = 'manual',
               resume_required = CASE WHEN $2 = 'resume' THEN true ELSE resume_required END,
               last_error = $3, updated_at = now(), version = version + 1
           WHERE id = $1 AND status = $4`,
          [caseId, action, reason, names.startStatus],
        );
        await manualRecoveredJobWithClient(client, job, reason);
      } else {
        await client.query(
          `UPDATE durable_jobs
           SET status = 'pending',
               available_at = now() + make_interval(secs => $3),
               locked_at = NULL, locked_by = NULL,
               last_error = 'worker lock expired before the Provider action attempt began',
               updated_at = now()
           WHERE id = $1 AND status = 'running' AND attempts = $2`,
          [job.id, job.attempts, reconcileDelaySeconds(job.attempts)],
        );
      }
      return true;
    }

    if (start) {
      const reason =
        "worker lock expired after a resource action may have been sent; query-only reconciliation required";
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
        [providerOperationId, reason],
      );
      await client.query(
        `UPDATE service_suspension_cases
         SET status = $2, last_error = $3, updated_at = now(), version = version + 1
         WHERE id = $1 AND status IN ($4, $5)`,
        [caseId, names.unknownStatus, reason, names.startStatus, names.processingStatus],
      );
      await enqueueReconcileWithClient(
        client,
        names.reconcileType,
        job.unique_key,
        { caseId, serviceId, providerOperationId },
        config.RECONCILE_BASE_DELAY_SECONDS,
      );
      await completeRecoveredJobWithClient(client, job);
      return true;
    }

    const manual = job.attempts >= config.RECONCILE_MAX_ATTEMPTS;
    const reason = manual
      ? "resource action reconciliation lease repeatedly expired; manual intervention required"
      : "resource action reconciliation lease expired; retrying query only";
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [providerOperationId, reason],
    );
    if (manual && current.case_status !== "resolved") {
      await client.query(
        `UPDATE service_suspension_cases
         SET status = 'manual',
             resume_required = CASE WHEN $2 = 'resume' THEN true ELSE resume_required END,
             last_error = $3, updated_at = now(), version = version + 1
         WHERE id = $1 AND status <> 'resolved'`,
        [caseId, action, reason],
      );
      await manualRecoveredJobWithClient(client, job, reason);
    } else {
      await client.query(
        `UPDATE durable_jobs
         SET status = 'pending',
             available_at = now() + make_interval(secs => $3),
             locked_at = NULL, locked_by = NULL, last_error = $4, updated_at = now()
         WHERE id = $1 AND status = 'running' AND attempts = $2`,
        [job.id, job.attempts, reconcileDelaySeconds(job.attempts), reason],
      );
    }
    return true;
  });
}

async function recoverStaleServiceActionJobs(): Promise<number> {
  const candidates = await pool.query<Job>(
    `SELECT id, job_type, unique_key, payload, attempts
     FROM durable_jobs
     WHERE status = 'running'
       AND job_type IN (
         'service.suspend.start', 'service.suspend.reconcile',
         'service.resume.start', 'service.resume.reconcile'
       )
       AND locked_at < now() - make_interval(secs => $1)
     ORDER BY locked_at, created_at
     LIMIT 50`,
    [config.JOB_LOCK_TIMEOUT_SECONDS],
  );
  let recovered = 0;
  for (const candidate of candidates.rows) {
    if (await recoverOneStaleServiceActionJob(candidate)) recovered += 1;
  }
  return recovered;
}

async function recoverOneStaleCancellationJob(candidate: Job): Promise<boolean> {
  const requestId = candidate.payload.cancellationRequestId ?? candidate.payload.requestId;
  const executionId = candidate.payload.executionId;
  const serviceId = candidate.payload.serviceId;
  const providerOperationId = candidate.payload.providerOperationId ?? null;
  if (!requestId || !executionId || !serviceId) {
    return transaction(async (client) => {
      const job = await lockStaleJobWithClient(client, candidate);
      if (!job) return false;
      await manualRecoveredJobWithClient(
        client,
        job,
        "stale cancellation job has an invalid payload; manual inspection required",
      );
      return true;
    });
  }

  return transaction(async (client) => {
    if (providerOperationId) await lockProviderOperation(client, providerOperationId);
    const pointer = await client.query<{ order_item_id: string }>(
      `SELECT service.order_item_id
       FROM service_cancellation_executions execution
       JOIN service_cancellation_requests cancellation_request
         ON cancellation_request.id = execution.cancellation_request_id
       JOIN services service ON service.id = execution.service_id
       WHERE cancellation_request.id = $1
         AND execution.id = $2
         AND service.id = $3`,
      [requestId, executionId, serviceId],
    );
    const target = pointer.rows[0];
    if (target) {
      await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
        target.order_item_id,
      ]);
      await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [serviceId]);
      await client.query(
        "SELECT id FROM service_cancellation_requests WHERE id = $1 FOR UPDATE",
        [requestId],
      );
      await client.query(
        "SELECT id FROM service_cancellation_executions WHERE id = $1 FOR UPDATE",
        [executionId],
      );
      if (providerOperationId) {
        await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [
          providerOperationId,
        ]);
      }
    }
    const job = await lockStaleJobWithClient(client, candidate);
    if (!job) return false;
    if (!target) {
      await manualRecoveredJobWithClient(
        client,
        job,
        "stale cancellation job references missing Core records",
      );
      return true;
    }
    const stateResult = await client.query<{
      execution_mode: "automatic" | "manual";
      execution_status: string;
      service_status: string;
      operation_status: string | null;
      operation_attempt_count: number | null;
      operation_kind: string | null;
      operation_subject_id: string | null;
    }>(
      `SELECT execution.execution_mode,
              execution.status AS execution_status,
              service.status AS service_status,
              operation.status AS operation_status,
              operation.attempt_count AS operation_attempt_count,
              operation.kind AS operation_kind,
              operation.subject_id AS operation_subject_id
       FROM service_cancellation_executions execution
       JOIN services service ON service.id = execution.service_id
       LEFT JOIN provider_operations operation ON operation.id = $2
       WHERE execution.id = $1`,
      [executionId, providerOperationId],
    );
    const state = stateResult.rows[0];
    if (!state) {
      await manualRecoveredJobWithClient(client, job, "cancellation execution disappeared");
      return true;
    }
    if (state.execution_status === "terminated" && state.service_status === "terminated") {
      await completeRecoveredJobWithClient(client, job);
      return true;
    }
    if (state.execution_mode === "manual") {
      if (state.execution_status === "scheduled") {
        await client.query(
          `UPDATE service_cancellation_executions
           SET status = 'manual', result = $2, last_error = $3,
               updated_at = now(), version = version + 1
           WHERE id = $1 AND status = 'scheduled'`,
          [
            executionId,
            { status: "manual", interventionRequired: true },
            "worker lease expired while placing the due cancellation into the manual queue",
          ],
        );
      }
      await manualRecoveredJobWithClient(
        client,
        job,
        "manual cancellation remains queued for administrator intervention",
      );
      return true;
    }
    if (
      !providerOperationId ||
      state.operation_kind !== "resource_terminate" ||
      state.operation_subject_id !== executionId
    ) {
      await client.query(
        `UPDATE service_cancellation_executions
         SET status = 'manual', result = $2, last_error = $3,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND status NOT IN ('manual', 'terminated')`,
        [
          executionId,
          { status: "manual", interventionRequired: true },
          "stale automatic cancellation has inconsistent Provider ownership",
        ],
      );
      await manualRecoveredJobWithClient(
        client,
        job,
        "stale automatic cancellation has inconsistent Provider ownership",
      );
      return true;
    }

    const dueJob = job.job_type === "service.cancellation.due";
    const knownUnsent =
      dueJob &&
      state.execution_status === "scheduled" &&
      state.operation_status === "queued" &&
      state.operation_attempt_count === 0;
    if (knownUnsent && job.attempts < config.MAX_JOB_ATTEMPTS) {
      await client.query(
        `UPDATE durable_jobs
         SET status = 'pending',
             available_at = now() + make_interval(secs => $3),
             locked_at = NULL, locked_by = NULL,
             last_error = 'worker lease expired before terminate dispatch began',
             updated_at = now()
         WHERE id = $1 AND status = 'running' AND attempts = $2`,
        [job.id, job.attempts, reconcileDelaySeconds(job.attempts)],
      );
      return true;
    }
    if (knownUnsent) {
      const reason =
        "known-unsent termination repeatedly lost its worker lease; manual intervention required";
      await client.query(
        `UPDATE provider_operations
         SET status = 'failed', last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
        [providerOperationId, reason],
      );
      await client.query(
        `UPDATE service_cancellation_executions
         SET status = 'manual', result = $2, last_error = $3,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'scheduled'`,
        [executionId, { status: "manual", interventionRequired: true }, reason],
      );
      await manualRecoveredJobWithClient(client, job, reason);
      return true;
    }

    if (dueJob) {
      const reason =
        "worker lease expired after terminate may have been sent; query-only reconciliation required";
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
        [providerOperationId, reason],
      );
      if (state.execution_status === "processing") {
        await client.query(
          `UPDATE service_cancellation_executions
           SET status = 'unknown', result = $2, last_error = $3,
               updated_at = now(), version = version + 1
           WHERE id = $1 AND status = 'processing'`,
          [executionId, { status: "unknown", reconciliation: "query_only" }, reason],
        );
      } else if (state.execution_status === "scheduled") {
        await client.query(
          `UPDATE service_cancellation_executions
           SET status = 'manual', result = $2, last_error = $3,
               updated_at = now(), version = version + 1
           WHERE id = $1 AND status = 'scheduled'`,
          [executionId, { status: "manual", interventionRequired: true }, reason],
        );
        await manualRecoveredJobWithClient(client, job, reason);
        return true;
      }
      await enqueueReconcileWithClient(
        client,
        "service.cancellation.reconcile",
        job.unique_key,
        { requestId, executionId, serviceId, providerOperationId },
        config.RECONCILE_BASE_DELAY_SECONDS,
      );
      await completeRecoveredJobWithClient(client, job);
      return true;
    }

    const manual = job.attempts >= config.RECONCILE_MAX_ATTEMPTS;
    const reason = manual
      ? "termination reconciliation lease repeatedly expired; manual intervention required"
      : "termination reconciliation lease expired; retrying Provider query only";
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [providerOperationId, reason],
    );
    if (manual) {
      await client.query(
        `UPDATE service_cancellation_executions
         SET status = 'manual', result = $2, last_error = $3,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND status NOT IN ('manual', 'terminated')`,
        [executionId, { status: "manual", interventionRequired: true }, reason],
      );
      await manualRecoveredJobWithClient(client, job, reason);
    } else {
      await client.query(
        `UPDATE durable_jobs
         SET status = 'pending',
             available_at = now() + make_interval(secs => $3),
             locked_at = NULL, locked_by = NULL, last_error = $4, updated_at = now()
         WHERE id = $1 AND status = 'running' AND attempts = $2`,
        [job.id, job.attempts, reconcileDelaySeconds(job.attempts), reason],
      );
    }
    return true;
  });
}

async function recoverStaleCancellationJobs(): Promise<number> {
  const candidates = await pool.query<Job>(
    `SELECT id, job_type, unique_key, payload, attempts
     FROM durable_jobs
     WHERE status = 'running'
       AND job_type IN ('service.cancellation.due', 'service.cancellation.reconcile')
       AND locked_at < now() - make_interval(secs => $1)
     ORDER BY locked_at, created_at
     LIMIT 50`,
    [config.JOB_LOCK_TIMEOUT_SECONDS],
  );
  let recovered = 0;
  for (const candidate of candidates.rows) {
    if (await recoverOneStaleCancellationJob(candidate)) recovered += 1;
  }
  return recovered;
}

function coreSignature(timestamp: string, body: unknown, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${canonicalProviderJson(body)}`, "utf8")
    .digest("hex");
}

function canonicalProviderJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Provider payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalProviderJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalProviderJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Provider payload contains an unsupported value");
}

type CoreFactSubmission =
  | { kind: "terminal" }
  | { kind: "retry"; reason: string };

async function submitReconciledEvent(
  path: string,
  body: unknown,
  secret: string,
): Promise<CoreFactSubmission> {
  const timestamp = Date.now().toString();
  let response: Response;
  try {
    response = await fetch(new URL(path, config.CORE_INTERNAL_URL), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OSS-Timestamp": timestamp,
        "X-OSS-Signature": coreSignature(timestamp, body, secret),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown Core transport error";
    return { kind: "retry", reason: `Core fact submission transport failed: ${message}` };
  }
  if (!response.ok) {
    return {
      kind: "retry",
      reason: `Core fact submission returned HTTP ${response.status}`,
    };
  }

  let outcome: {
    accepted?: boolean | undefined;
    duplicate?: boolean | undefined;
    ignored?: boolean | undefined;
    rejected?: boolean | undefined;
    reason?: string | undefined;
    status?: string | undefined;
  };
  try {
    outcome = z
      .object({
        accepted: z.boolean().optional(),
        duplicate: z.boolean().optional(),
        ignored: z.boolean().optional(),
        rejected: z.boolean().optional(),
        reason: z.string().optional(),
        status: z.string().optional(),
      })
      .parse(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid Core response";
    return { kind: "retry", reason: `Core fact response is invalid: ${message}` };
  }

  if (outcome.duplicate) return { kind: "terminal" };
  if (outcome.rejected) {
    return {
      kind: "retry",
      reason: `Core rejected reconciled provider fact: ${outcome.reason ?? "unspecified reason"}`,
    };
  }
  if (outcome.ignored) {
    if (
      outcome.reason === "already_succeeded" ||
      outcome.reason === "stale_provider_fact" ||
      outcome.reason === "stale_or_backward_transition"
    ) {
      return { kind: "terminal" };
    }
    return {
      kind: "retry",
      reason: `Core ignored a non-terminal provider fact: ${outcome.reason ?? "unspecified reason"}`,
    };
  }
  if (outcome.accepted) {
    return { kind: "terminal" };
  }
  return {
    kind: "retry",
    reason: "Core response did not confirm acceptance, duplication, or a terminal ignore",
  };
}

async function delayReconcile(
  job: Job,
  operationId: string,
  reason: string,
  forceManual = false,
): Promise<void> {
  await transaction(async (client) => {
    await lockProviderOperation(client, operationId);
    await assertJobLeaseWithClient(client, job);
    const manual = forceManual || job.attempts >= config.RECONCILE_MAX_ATTEMPTS;
    await client.query(
      `UPDATE provider_operations
       SET last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [operationId, reason.slice(0, 1_000)],
    );
    const updatedJob = await client.query(
      `UPDATE durable_jobs
       SET status = $2,
           available_at = CASE
             WHEN $2 = 'pending' THEN now() + make_interval(secs => $3)
             ELSE available_at
           END,
           locked_at = NULL,
           locked_by = NULL,
           last_error = $4,
           updated_at = now()
       WHERE id = $1
         AND status = 'running'
         AND locked_by = $5
         AND attempts = $6
       RETURNING id`,
      [
        job.id,
        manual ? "manual" : "pending",
        reconcileDelaySeconds(job.attempts),
        reason.slice(0, 1_000),
        config.WORKER_ID,
        job.attempts,
      ],
    );
    if (updatedJob.rowCount !== 1) throw new LostJobLeaseError(job.id);
    if (manual) {
      await client.query(
        `UPDATE invoice_payment_commands
         SET status = 'manual', result = $2, updated_at = now()
         WHERE payment_attempt_id = (
           SELECT subject_id
           FROM provider_operations
           WHERE id = $1 AND subject_type = 'payment'
         )
           AND status NOT IN ('succeeded', 'failed')`,
        [operationId, { paymentStatus: "unknown", reason: reason.slice(0, 1_000) }],
      );
      await client.query(
        `UPDATE add_funds_commands
         SET status = 'manual', result = $2, updated_at = now()
         WHERE add_funds_attempt_id = (
           SELECT subject_id
           FROM provider_operations
           WHERE id = $1 AND subject_type = 'add_funds'
         )
           AND status NOT IN ('manual', 'succeeded', 'failed', 'cancelled', 'expired')`,
        [operationId, { paymentStatus: "unknown", reason: reason.slice(0, 1_000) }],
      );
    }
  });
}

async function manualProvisionReconcile(
  job: Job,
  operationId: string,
  serviceId: string,
  reason: string,
): Promise<void> {
  await transaction(async (client) => {
    await lockProviderOperation(client, operationId);
    await assertJobLeaseWithClient(client, job);
    const lockPointers = await client.query<{
      invoice_id: string;
      order_id: string;
      order_item_id: string;
    }>(
      `SELECT invoice.id AS invoice_id,
              customer_order.id AS order_id,
              item.id AS order_item_id
       FROM services service
       JOIN order_items item ON item.id = service.order_item_id
       JOIN orders customer_order ON customer_order.id = item.order_id
       JOIN invoices invoice ON invoice.order_id = customer_order.id
       WHERE service.id = $1`,
      [serviceId],
    );
    const lockPointer = lockPointers.rows[0];
    if (lockPointer) {
      await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
        lockPointer.invoice_id,
      ]);
      await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
        lockPointer.order_id,
      ]);
      await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
        lockPointer.order_item_id,
      ]);
      await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [serviceId]);
    }
    await client.query(
      `SELECT id
       FROM provider_operations
       WHERE id = $1
         AND subject_type = 'service'
         AND subject_id = $2
       FOR UPDATE`,
      [operationId, serviceId],
    );
    const result = await client.query<{
      order_id: string;
      service_status: string;
      operation_status: string;
    }>(
      `SELECT
         customer_order.id AS order_id,
         service.status AS service_status,
         operation.status AS operation_status
       FROM services service
       JOIN order_items item ON item.id = service.order_item_id
       JOIN orders customer_order ON customer_order.id = item.order_id
       JOIN provider_operations operation
         ON operation.id = $2
        AND operation.subject_type = 'service'
        AND operation.subject_id = service.id
       WHERE service.id = $1`,
      [serviceId, operationId],
    );
    const current = result.rows[0];
    if (!current) {
      await manualJobWithClient(
        client,
        job,
        "provision reconciliation references missing or inconsistent Core records",
      );
      return;
    }
    if (
      current.operation_status === "succeeded" ||
      current.operation_status === "failed" ||
      current.service_status === "active" ||
      current.service_status === "terminated"
    ) {
      await completeJobWithClient(client, job);
      return;
    }
    const orderId = current.order_id;
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [operationId, reason.slice(0, 1_000)],
    );
    await client.query(
      `UPDATE services
       SET status = 'confirming', updated_at = now(), version = version + 1
       WHERE id = $1 AND status IN ('pending', 'provisioning', 'confirming')`,
      [serviceId],
    );
    await client.query(
      `UPDATE orders
       SET status = 'on_hold', updated_at = now(), version = version + 1
       WHERE id = $1 AND status IN ('accepted', 'fulfilling')`,
      [orderId],
    );
    await client.query(
      `INSERT INTO audit_events(
         actor_type, actor_id, action, target_type, target_id, reason, metadata
       ) VALUES ('system', $1, 'provision.reconcile_proof_rejected', 'service', $2, $3, $4)`,
      [
        config.WORKER_ID,
        serviceId,
        reason.slice(0, 1_000),
        { providerOperationId: operationId, orderId },
      ],
    );
    await manualJobWithClient(client, job, reason);
  });
}

async function delayRefundReconcile(
  job: Job,
  refundId: string,
  operationId: string,
  reason: string,
  forceManual = false,
): Promise<void> {
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `refund:${refundId}`,
    ]);
    await assertJobLeaseWithClient(client, job);
    const pointer = await client.query<{ source_fund_receipt_id: string }>(
      "SELECT source_fund_receipt_id FROM refunds WHERE id = $1",
      [refundId],
    );
    const receiptId = pointer.rows[0]?.source_fund_receipt_id;
    if (!receiptId) {
      await manualJobWithClient(client, job, "Refund disappeared during reconciliation");
      return;
    }
    await client.query("SELECT id FROM fund_receipts WHERE id = $1 FOR UPDATE", [receiptId]);
    const state = await client.query<{
      refund_status: string;
      operation_status: string;
    }>(
      `SELECT
         refund.status AS refund_status,
         operation.status AS operation_status
       FROM refunds refund
       JOIN provider_operations operation
         ON operation.id = $2
        AND operation.subject_type = 'refund'
        AND operation.subject_id = refund.id
        AND operation.kind = 'refund_create'
       WHERE refund.id = $1
       FOR UPDATE OF refund, operation`,
      [refundId, operationId],
    );
    const current = state.rows[0];
    if (
      !current ||
      current.refund_status === "succeeded" ||
      current.refund_status === "failed" ||
      current.operation_status === "succeeded" ||
      current.operation_status === "failed"
    ) {
      await completeJobWithClient(client, job);
      return;
    }
    const manual = forceManual || job.attempts >= config.RECONCILE_MAX_ATTEMPTS;
    if (manual) {
      await client.query(
        `UPDATE refunds
         SET status = 'manual', last_error = $2,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND status IN ('processing', 'unknown', 'manual')`,
        [refundId, reason.slice(0, 1_000)],
      );
      await client.query(
        `INSERT INTO refund_events(
           refund_id, event_type, actor_type, actor_id, reason, metadata
         ) VALUES ($1, 'manual', 'system', $2, $3, $4)`,
        [
          refundId,
          config.WORKER_ID,
          reason.slice(0, 1_000),
          { providerOperationId: operationId },
        ],
      );
    }
    await client.query(
      `UPDATE provider_operations
       SET last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [operationId, reason.slice(0, 1_000)],
    );
    const updatedJob = await client.query(
      `UPDATE durable_jobs
       SET status = $2,
           available_at = CASE
             WHEN $2 = 'pending' THEN now() + make_interval(secs => $3)
             ELSE available_at
           END,
           locked_at = NULL,
           locked_by = NULL,
           last_error = $4,
           updated_at = now()
       WHERE id = $1
         AND status = 'running'
         AND locked_by = $5
         AND attempts = $6
       RETURNING id`,
      [
        job.id,
        manual ? "manual" : "pending",
        reconcileDelaySeconds(job.attempts),
        reason.slice(0, 1_000),
        config.WORKER_ID,
        job.attempts,
      ],
    );
    if (updatedJob.rowCount !== 1) throw new LostJobLeaseError(job.id);
  });
}

async function reconcileRefund(job: Job): Promise<void> {
  const refundId = job.payload.refundId;
  const operationId = job.payload.operationId ?? job.payload.providerOperationId;
  if (!refundId || !operationId) throw new Error("Invalid refund.reconcile payload");
  const preflight = await preflightRefund(job, refundId, operationId, "reconcile");
  if (preflight.kind === "halted") return;

  let response: Response;
  try {
    response = await providerRequest(
      config.MOCK_PAYMENT_PROVIDER_URL,
      config.MOCK_PAYMENT_PROVIDER_TOKEN,
      `/v1/refunds/${encodeURIComponent(operationId)}`,
      { method: "GET" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await delayRefundReconcile(
      job,
      refundId,
      operationId,
      `Refund reconciliation transport failed: ${message}`,
    );
    return;
  }
  if (response.status === 404 || response.status === 408 || response.status === 425) {
    await delayRefundReconcile(
      job,
      refundId,
      operationId,
      `Refund operation is not terminal at Provider (HTTP ${response.status})`,
    );
    return;
  }
  if (response.status === 429 || response.status >= 500) {
    await delayRefundReconcile(
      job,
      refundId,
      operationId,
      `Refund reconciliation is temporarily unavailable (HTTP ${response.status})`,
    );
    return;
  }
  if (!response.ok) {
    await delayRefundReconcile(
      job,
      refundId,
      operationId,
      `Refund reconciliation requires manual intervention (HTTP ${response.status})`,
      true,
    );
    return;
  }
  let fact: {
    callbackCapability: string;
    externalRefundId: string;
    status: "processing" | "succeeded" | "failed";
    amountMinor: string;
    currency: string;
    occurredAt: string;
  };
  try {
    fact = z
      .object({
        callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        externalRefundId: z.string().min(1),
        status: z.enum(["processing", "succeeded", "failed"]),
        amountMinor: z.string().regex(/^[1-9]\d*$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
        occurredAt: z.string(),
      })
      .parse(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid Provider response";
    await delayRefundReconcile(
      job,
      refundId,
      operationId,
      `Refund reconciliation response is invalid: ${message}`,
      true,
    );
    return;
  }
  if (
    !providerOperationCapabilityMatches(
      fact.callbackCapability,
      config.PROVIDER_OPERATION_CAPABILITY_SECRET,
      "mock-payment-v1",
      operationId,
    )
  ) {
    await delayRefundReconcile(
      job,
      refundId,
      operationId,
      "Refund reconciliation returned an invalid operation capability",
      true,
    );
    return;
  }
  if (fact.status === "processing") {
    await delayRefundReconcile(
      job,
      refundId,
      operationId,
      "Refund remains processing at Provider",
    );
    return;
  }
  const coreOutcome = await submitReconciledEvent(
    "/api/v1/provider-events/refund",
    {
      eventId: `reconcile:${operationId}:${randomUUID()}`,
      providerOperationId: operationId,
      refundId,
      ...fact,
    },
    config.MOCK_PAYMENT_WEBHOOK_SECRET,
  );
  if (coreOutcome.kind === "retry") {
    await delayRefundReconcile(job, refundId, operationId, coreOutcome.reason);
    return;
  }
  await completeJob(job);
}

async function reconcileAddFunds(job: Job): Promise<void> {
  const operationId = job.payload.operationId ?? job.payload.providerOperationId;
  const addFundsAttemptId = job.payload.addFundsAttemptId;
  if (!operationId || !addFundsAttemptId) {
    throw new Error("Invalid add_funds.reconcile payload");
  }
  const preflight = await preflightAddFunds(
    job,
    addFundsAttemptId,
    operationId,
    "reconcile",
  );
  if (preflight.kind === "halted") return;

  let response: Response;
  try {
    response = await providerRequest(
      config.MOCK_PAYMENT_PROVIDER_URL,
      config.MOCK_PAYMENT_PROVIDER_TOKEN,
      `/v1/payments/${encodeURIComponent(operationId)}`,
      { method: "GET" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await delayReconcile(
      job,
      operationId,
      `Add Funds reconciliation transport failed: ${message}`,
    );
    return;
  }
  if (response.status === 404 || response.status === 408 || response.status === 425) {
    await delayReconcile(
      job,
      operationId,
      `Add Funds operation is not terminal at Provider (HTTP ${response.status})`,
    );
    return;
  }
  if (response.status === 429 || response.status >= 500) {
    await delayReconcile(
      job,
      operationId,
      `Add Funds reconciliation is temporarily unavailable (HTTP ${response.status})`,
    );
    return;
  }
  if (!response.ok) {
    await delayReconcile(
      job,
      operationId,
      `Add Funds reconciliation requires manual intervention (HTTP ${response.status})`,
      true,
    );
    return;
  }
  let fact: {
    callbackCapability: string;
    externalPaymentId: string;
    status: "processing" | "succeeded" | "failed" | "cancelled" | "expired";
    amountMinor: string;
    currency: string;
    occurredAt: string;
  };
  try {
    fact = z
      .object({
        callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        externalPaymentId: z.string().min(1),
        status: z.enum(["processing", "succeeded", "failed", "cancelled", "expired"]),
        amountMinor: z.string().regex(/^[1-9]\d*$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
        occurredAt: z.string(),
      })
      .parse(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid Provider response";
    await delayReconcile(
      job,
      operationId,
      `Add Funds reconciliation response is invalid: ${message}`,
      true,
    );
    return;
  }
  if (
    !providerOperationCapabilityMatches(
      fact.callbackCapability,
      config.PROVIDER_OPERATION_CAPABILITY_SECRET,
      "mock-payment-v1",
      operationId,
    )
  ) {
    await delayReconcile(
      job,
      operationId,
      "Add Funds reconciliation returned an invalid operation capability",
      true,
    );
    return;
  }
  if (fact.status === "processing") {
    await delayReconcile(
      job,
      operationId,
      "Add Funds operation remains processing at Provider",
    );
    return;
  }
  const coreOutcome = await submitReconciledEvent(
    "/api/v1/provider-events/payment",
    {
      eventId: `reconcile:${operationId}:${randomUUID()}`,
      providerOperationId: operationId,
      paymentAttemptId: addFundsAttemptId,
      ...fact,
    },
    config.MOCK_PAYMENT_WEBHOOK_SECRET,
  );
  if (coreOutcome.kind === "retry") {
    await delayReconcile(job, operationId, coreOutcome.reason);
    return;
  }
  await completeJob(job);
}

async function reconcilePayment(job: Job): Promise<void> {
  const operationId = job.payload.operationId ?? job.payload.providerOperationId;
  const paymentAttemptId = job.payload.paymentAttemptId;
  if (!operationId || !paymentAttemptId) throw new Error("Invalid payment.reconcile payload");
  const preflight = await preflightPayment(job, paymentAttemptId, operationId, "reconcile");
  if (preflight.kind === "halted") return;

  let response: Response;
  try {
    response = await providerRequest(
      config.MOCK_PAYMENT_PROVIDER_URL,
      config.MOCK_PAYMENT_PROVIDER_TOKEN,
      `/v1/payments/${encodeURIComponent(operationId)}`,
      { method: "GET" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await delayReconcile(job, operationId, `payment reconciliation transport failed: ${message}`);
    return;
  }
  if (response.status === 404 || response.status === 408 || response.status === 425) {
    await delayReconcile(
      job,
      operationId,
      `payment operation is not terminal at the provider (HTTP ${response.status})`,
    );
    return;
  }
  if (response.status === 429 || response.status >= 500) {
    await delayReconcile(
      job,
      operationId,
      `payment reconciliation is temporarily unavailable (HTTP ${response.status})`,
    );
    return;
  }
  if (!response.ok) {
    await delayReconcile(
      job,
      operationId,
      `payment reconciliation requires manual intervention (HTTP ${response.status})`,
      true,
    );
    return;
  }
  let fact: {
    callbackCapability: string;
    externalPaymentId: string;
    status: "processing" | "succeeded" | "failed" | "cancelled" | "expired";
    amountMinor: string;
    currency: string;
    occurredAt: string;
  };
  try {
    fact = z
      .object({
        callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        externalPaymentId: z.string(),
        status: z.enum(["processing", "succeeded", "failed", "cancelled", "expired"]),
        amountMinor: z.string(),
        currency: z.string(),
        occurredAt: z.string(),
      })
      .parse(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid provider response";
    await delayReconcile(
      job,
      operationId,
      `payment reconciliation response is invalid: ${message}`,
      true,
    );
    return;
  }
  if (
    !providerOperationCapabilityMatches(
      fact.callbackCapability,
      config.PROVIDER_OPERATION_CAPABILITY_SECRET,
      "mock-payment-v1",
      operationId,
    )
  ) {
    await delayReconcile(
      job,
      operationId,
      "payment reconciliation returned an invalid operation capability",
      true,
    );
    return;
  }
  if (fact.status === "processing") {
    await delayReconcile(job, operationId, "payment operation remains processing at the provider");
    return;
  }
  const coreOutcome = await submitReconciledEvent(
    "/api/v1/provider-events/payment",
    {
      eventId: `reconcile:${operationId}:${randomUUID()}`,
      providerOperationId: operationId,
      paymentAttemptId,
      ...fact,
    },
    config.MOCK_PAYMENT_WEBHOOK_SECRET,
  );
  if (coreOutcome.kind === "retry") {
    await delayReconcile(job, operationId, coreOutcome.reason);
    return;
  }
  await completeJob(job);
}

async function reconcileProvision(job: Job): Promise<void> {
  const operationId = job.payload.operationId ?? job.payload.providerOperationId;
  const serviceId = job.payload.serviceId;
  if (!operationId || !serviceId) throw new Error("Invalid provision.reconcile payload");
  const preflight = await preflightProvision(job, serviceId, operationId, "reconcile");
  if (preflight.kind === "halted") return;

  let response: Response;
  try {
    response = await providerRequest(
      config.MOCK_PROVISIONING_PROVIDER_URL,
      config.MOCK_PROVISIONING_PROVIDER_TOKEN,
      `/v1/resources/${encodeURIComponent(operationId)}`,
      { method: "GET" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown transport error";
    await delayReconcile(job, operationId, `provision reconciliation transport failed: ${message}`);
    return;
  }
  if (response.status === 404 || response.status === 408 || response.status === 425) {
    await delayReconcile(
      job,
      operationId,
      `resource operation is not terminal at the provider (HTTP ${response.status})`,
    );
    return;
  }
  if (response.status === 429 || response.status >= 500) {
    await delayReconcile(
      job,
      operationId,
      `provision reconciliation is temporarily unavailable (HTTP ${response.status})`,
    );
    return;
  }
  if (!response.ok) {
    await delayReconcile(
      job,
      operationId,
      `provision reconciliation requires manual intervention (HTTP ${response.status})`,
      true,
    );
    return;
  }
  let fact: {
    callbackCapability: string;
    status: "processing" | "succeeded" | "failed";
    externalResourceId?: string | undefined;
    readyAt?: string | undefined;
    occurredAt: string;
  };
  try {
    fact = z
      .object({
        callbackCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        status: z.enum(["processing", "succeeded", "failed"]),
        externalResourceId: z.string().optional(),
        readyAt: z.string().optional(),
        occurredAt: z.string(),
      })
      .parse(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid provider response";
    await manualProvisionReconcile(
      job,
      operationId,
      serviceId,
      `provision reconciliation response is invalid: ${message}`,
    );
    return;
  }
  if (
    !providerOperationCapabilityMatches(
      fact.callbackCapability,
      config.PROVIDER_OPERATION_CAPABILITY_SECRET,
      "mock-provisioning-v1",
      operationId,
    )
  ) {
    await manualProvisionReconcile(
      job,
      operationId,
      serviceId,
      "provision reconciliation returned an invalid operation capability",
    );
    return;
  }
  if (fact.status === "processing") {
    await delayReconcile(job, operationId, "resource operation remains processing at the provider");
    return;
  }
  const coreOutcome = await submitReconciledEvent(
    "/api/v1/provider-events/provisioning",
    {
      eventId: `reconcile:${operationId}:${randomUUID()}`,
      providerOperationId: operationId,
      ...fact,
    },
    config.MOCK_PROVISIONING_WEBHOOK_SECRET,
  );
  if (coreOutcome.kind === "retry") {
    await delayReconcile(job, operationId, coreOutcome.reason);
    return;
  }
  await completeJob(job);
}

async function sendRenewalNotificationSerialized(
  job: Job,
  outboxId: string,
  payload: {
    email: string;
    invoiceId: string;
    serviceId: string;
    kind: "renewal_created" | "pre_due" | "overdue_first";
    offsetDays: number;
    dueAt: string;
    currency: string;
  },
  locale: "en" | "zh-CN",
): Promise<void> {
  await transaction(async (client) => {
    await assertJobLeaseWithClient(client, job);
    const state = await client.query<{
      intent_id: string;
      kind: "renewal_created" | "pre_due" | "overdue_first";
      total_minor: string;
      allocated_minor: string;
      has_delivery: boolean;
      has_suppression: boolean;
    }>(
      `SELECT reminder.id AS intent_id, reminder.kind,
              invoice.total_minor::text,
              allocation.allocated_minor::text,
              EXISTS (
                SELECT 1 FROM renewal_reminder_delivery_facts fact
                WHERE fact.intent_id = reminder.id
              ) AS has_delivery,
              EXISTS (
                SELECT 1 FROM renewal_reminder_suppressions suppression
                WHERE suppression.intent_id = reminder.id
              ) AS has_suppression
       FROM renewal_reminder_intents reminder
       JOIN invoices invoice ON invoice.id = reminder.invoice_id
       JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
       WHERE reminder.outbox_id = $1
       FOR UPDATE OF reminder, invoice`,
      [outboxId],
    );
    const reminder = state.rows[0];
    if (!reminder) throw new Error("Renewal reminder intent is unavailable");
    if (reminder.has_delivery || reminder.has_suppression) {
      await completeJobWithClient(client, job);
      return;
    }
    if (
      reminder.kind !== "renewal_created" &&
      BigInt(reminder.allocated_minor) >= BigInt(reminder.total_minor)
    ) {
      await client.query(
        `INSERT INTO renewal_reminder_suppressions(intent_id, reason)
         VALUES ($1, 'invoice was fully settled before reminder dispatch')
         ON CONFLICT (intent_id) DO NOTHING`,
        [reminder.intent_id],
      );
      await completeJobWithClient(client, job);
      return;
    }

    const currentAmountDue = BigInt(reminder.total_minor) - BigInt(reminder.allocated_minor);
    const amountMinor = currentAmountDue > 0n ? currentAmountDue : 0n;
    const amount = `${amountMinor / 100n}.${(amountMinor % 100n).toString().padStart(2, "0")}`;
    const labels =
      locale === "zh-CN"
        ? {
            renewal_created: "续费发票已创建",
            pre_due: `续费发票将在 ${payload.offsetDays} 天后到期`,
            overdue_first: `续费发票已逾期 ${payload.offsetDays} 天`,
          }
        : {
            renewal_created: "Renewal invoice created",
            pre_due: `Renewal invoice is due in ${payload.offsetDays} days`,
            overdue_first: `Renewal invoice is ${payload.offsetDays} days overdue`,
          };
    const subject = labels[payload.kind];
    const body =
      locale === "zh-CN"
        ? `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${subject}\n发票：${payload.invoiceId}\n服务：${payload.serviceId}\n到期时间：${payload.dueAt}\n当前应付：${payload.currency} ${amount}`
        : `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${subject}\nInvoice: ${payload.invoiceId}\nService: ${payload.serviceId}\nDue: ${payload.dueAt}\nAmount due: ${payload.currency} ${amount}`;

    // Keep the invoice row locked through the finite Provider request. A payment
    // allocation therefore commits either before this final check (and is
    // suppressed) or after the reminder dispatch fact; it cannot slip between
    // the check and the actual Mock Mail call.
    const response = await providerRequest(
      config.MOCK_MAIL_PROVIDER_URL,
      config.MOCK_MAIL_PROVIDER_TOKEN,
      "/v1/mail",
      {
        method: "POST",
        headers: { "Idempotency-Key": outboxId },
        body: JSON.stringify({
          operationId: outboxId,
          recipient: payload.email,
          template: `renewal-${payload.kind.replaceAll("_", "-")}-v1`,
          locale,
          subject,
          body,
          sensitive: false,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Mock Mail Provider rejected notification with ${response.status}`);
    }
    const providerFact = z
      .object({
        operationId: z.uuid(),
        status: z.enum(["delivered", "bounced", "failed"]),
        deliveredAt: z.iso.datetime({ offset: true }),
      })
      .parse(await response.json());
    if (providerFact.operationId !== outboxId) {
      throw new Error("Mock Mail Provider returned a mismatched notification operation");
    }
    await client.query(
      `INSERT INTO renewal_reminder_delivery_facts(
         intent_id, provider_installation_id, provider_message_id,
         status, provider_occurred_at
       ) VALUES ($1, 'mock-mail-v1', $2, $3, $4)
       ON CONFLICT (intent_id) DO NOTHING`,
      [reminder.intent_id, providerFact.operationId, providerFact.status, providerFact.deliveredAt],
    );
    await client.query(
      "UPDATE outbox SET published_at = now() WHERE id = $1 AND published_at IS NULL",
      [outboxId],
    );
    await completeJobWithClient(client, job);
  });
}

async function sendNotification(job: Job): Promise<void> {
  const outboxId = job.payload.outboxId;
  if (!outboxId) throw new Error("Invalid notification.send payload");
  const result = await pool.query<{
    event_type: string;
    payload: {
      email?: string;
      locale?: string;
      verificationUrl?: string;
      expiresAt?: string;
      invoiceId?: string;
      serviceId?: string;
      kind?: "renewal_created" | "pre_due" | "overdue_first";
      offsetDays?: number;
      dueAt?: string;
      amountDueMinor?: string;
      currency?: string;
      cancellationRequestId?: string;
      productName?: string;
      effectiveAt?: string;
      executionMode?: "automatic" | "manual";
    };
    published_at: Date | null;
  }>(
    `SELECT event_type, payload, published_at
     FROM outbox
     WHERE id = $1`,
    [outboxId],
  );
  const outbox = result.rows[0];
  if (!outbox || outbox.published_at) {
    await completeJob(job);
    return;
  }
  if (!outbox.payload.email) {
    throw new Error(`Unsupported notification event: ${outbox.event_type}`);
  }
  const locale = outbox.payload.locale === "zh-CN" ? "zh-CN" : "en";
  let template: string;
  let subject: string;
  let body: string;
  let sensitive: boolean;
  if (
    outbox.event_type === "notification.email_verification_requested" &&
    outbox.payload.verificationUrl
  ) {
    template = "email-verification";
    subject =
      locale === "zh-CN"
        ? "验证 OpenSales System 实验室账号"
        : "Verify your OpenSales System laboratory account";
    body = `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${outbox.payload.verificationUrl}\n\nExpires: ${outbox.payload.expiresAt ?? "unknown"}`;
    sensitive = true;
  } else if (
    outbox.event_type === "notification.renewal_reminder_requested" &&
    outbox.payload.invoiceId &&
    outbox.payload.serviceId &&
    outbox.payload.kind &&
    typeof outbox.payload.offsetDays === "number" &&
    Number.isInteger(outbox.payload.offsetDays) &&
    outbox.payload.offsetDays >= 0 &&
    outbox.payload.offsetDays <= 90 &&
    outbox.payload.dueAt &&
    outbox.payload.amountDueMinor &&
    /^\d+$/.test(outbox.payload.amountDueMinor) &&
    outbox.payload.currency &&
    /^[A-Z]{3}$/.test(outbox.payload.currency)
  ) {
    await sendRenewalNotificationSerialized(
      job,
      outboxId,
      {
        email: outbox.payload.email,
        invoiceId: outbox.payload.invoiceId,
        serviceId: outbox.payload.serviceId,
        kind: outbox.payload.kind,
        offsetDays: outbox.payload.offsetDays,
        dueAt: outbox.payload.dueAt,
        currency: outbox.payload.currency,
      },
      locale,
    );
    return;
  } else if (
    outbox.event_type === "notification.service_cancellation_scheduled" &&
    outbox.payload.cancellationRequestId &&
    outbox.payload.serviceId &&
    outbox.payload.productName &&
    outbox.payload.effectiveAt &&
    (outbox.payload.executionMode === "automatic" ||
      outbox.payload.executionMode === "manual")
  ) {
    template = "service-cancellation-scheduled-v1";
    subject =
      locale === "zh-CN"
        ? "服务已安排在账期末取消"
        : "Service cancellation scheduled for period end";
    body =
      locale === "zh-CN"
        ? `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${subject}\n产品：${outbox.payload.productName}\n服务：${outbox.payload.serviceId}\n生效时间：${outbox.payload.effectiveAt}\n执行方式：${outbox.payload.executionMode === "automatic" ? "Mock Provider 自动终止" : "管理员人工终止"}`
        : `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${subject}\nProduct: ${outbox.payload.productName}\nService: ${outbox.payload.serviceId}\nEffective at: ${outbox.payload.effectiveAt}\nExecution: ${outbox.payload.executionMode === "automatic" ? "automatic Mock Provider termination" : "administrator manual termination"}`;
    sensitive = false;
  } else {
    throw new Error(`Unsupported notification event: ${outbox.event_type}`);
  }
  const response = await providerRequest(
    config.MOCK_MAIL_PROVIDER_URL,
    config.MOCK_MAIL_PROVIDER_TOKEN,
    "/v1/mail",
    {
      method: "POST",
      headers: { "Idempotency-Key": outboxId },
      body: JSON.stringify({
        operationId: outboxId,
        recipient: outbox.payload.email,
        template,
        locale,
        subject,
        body,
        sensitive,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Mock Mail Provider rejected notification with ${response.status}`);
  }
  await pool.query("UPDATE outbox SET published_at = now() WHERE id = $1 AND published_at IS NULL", [
    outboxId,
  ]);
  await completeJob(job);
}

async function runScheduledBillingAutomation(job: Job): Promise<void> {
  const body = z
    .object({
      policyId: z.literal("default"),
      businessDate: z.iso.date(),
      effectiveAt: z.iso.datetime({ offset: true }),
    })
    .strict()
    .parse(job.payload);
  const timestamp = Date.now().toString();
  const response = await fetch(
    new URL("/api/v1/internal/billing/automation/run", config.CORE_INTERNAL_URL),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OSS-Timestamp": timestamp,
        "X-OSS-Signature": coreSignature(
          timestamp,
          body,
          config.PROVIDER_OPERATION_CAPABILITY_SECRET,
        ),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `Core scheduled billing automation returned HTTP ${response.status}: ${detail}`,
    );
  }
  await completeJob(job);
}

async function processJob(job: Job): Promise<void> {
  if (job.job_type === "billing.automation.scheduled") {
    return runScheduledBillingAutomation(job);
  }
  if (job.job_type === "notification.send") return sendNotification(job);
  if (job.job_type === "refund.start") return startRefund(job);
  if (job.job_type === "refund.reconcile") return reconcileRefund(job);
  if (job.job_type === "payment.start") return startPayment(job);
  if (job.job_type === "payment.reconcile") return reconcilePayment(job);
  if (job.job_type === "add_funds.start") return startAddFunds(job);
  if (job.job_type === "add_funds.reconcile") return reconcileAddFunds(job);
  if (job.job_type === "provision.start") return startProvision(job);
  if (job.job_type === "provision.reconcile") return reconcileProvision(job);
  if (job.job_type === "service.suspend.start") return startServiceAction(job, "suspend");
  if (job.job_type === "service.suspend.reconcile") {
    return reconcileServiceAction(job, "suspend");
  }
  if (job.job_type === "service.resume.start") return startServiceAction(job, "resume");
  if (job.job_type === "service.resume.reconcile") {
    return reconcileServiceAction(job, "resume");
  }
  if (job.job_type === "service.cancellation.due") return startCancellation(job);
  if (job.job_type === "service.cancellation.reconcile") return reconcileCancellation(job);
  throw new Error(`Unsupported job type: ${job.job_type}`);
}

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

const schemaClient = await pool.connect();
let schemaPreflight;
try {
  await schemaClient.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  schemaPreflight = await assert014RollbackBridgeSafe(
    {
      query: async (text, values) => schemaClient.query(text, values),
    },
    { enable015RollbackBridge: config.OSS_SCHEMA_ROLLBACK_BRIDGE === "014-to-015" },
  );
  await schemaClient.query("COMMIT");
} catch (error) {
  await schemaClient.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  schemaClient.release();
}

console.log(`OpenSales worker ${config.WORKER_ID} started (${randomUUID()}).`, {
  installedSchemaVersion: schemaPreflight.installedSchemaVersion,
  schemaMode: schemaPreflight.mode,
});
let nextRecoveryAt = 0;
let nextBillingScheduleAt = 0;
while (!stopping) {
  if (Date.now() >= nextBillingScheduleAt) {
    try {
      const scheduled = await ensureScheduledBillingJob(pool);
      if (scheduled > 0) {
        console.log("scheduled durable billing automation", { count: scheduled });
      }
    } catch (error) {
      console.error("billing automation scheduling failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
    nextBillingScheduleAt = Date.now() + 60_000;
  }
  if (Date.now() >= nextRecoveryAt) {
    try {
      const recovered =
        (await recoverStaleJobs()) +
        (await recoverStaleRefundJobs()) +
        (await recoverStaleServiceActionJobs()) +
        (await recoverStaleCancellationJobs());
      if (recovered > 0) {
        console.warn("recovered stale durable jobs", { count: recovered });
      }
    } catch (error) {
      console.error("stale durable job recovery failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
    nextRecoveryAt =
      Date.now() + Math.max(5_000, Math.floor((config.JOB_LOCK_TIMEOUT_SECONDS * 1_000) / 2));
  }
  const claim = await attemptJobClaim(claimJob);
  if (claim.kind === "failed") {
    console.error("durable job claim failed", {
      error: claim.error instanceof Error ? claim.error.message : "unknown",
    });
    await new Promise((resolve) => setTimeout(resolve, config.WORKER_POLL_MS));
    continue;
  }
  const job = claim.job;
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, config.WORKER_POLL_MS));
    continue;
  }
  try {
    await processJob(job);
  } catch (error) {
    if (error instanceof LostJobLeaseError) {
      console.warn("discarded stale worker result after durable job lease loss", {
        jobId: job.id,
        jobType: job.job_type,
        attempts: job.attempts,
      });
      continue;
    }
    console.error("job failed", {
      jobId: job.id,
      jobType: job.job_type,
      error: error instanceof Error ? error.message : "unknown",
    });
    try {
      await failJob(job, error);
    } catch (persistenceError) {
      console.error(
        "failed to persist durable job failure; stale-job recovery will reconcile it",
        {
          jobId: job.id,
          jobType: job.job_type,
          error: persistenceError instanceof Error ? persistenceError.message : "unknown",
        },
      );
    }
  }
}
await pool.end();
