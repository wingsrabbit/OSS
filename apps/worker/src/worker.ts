// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac, randomUUID } from "node:crypto";
import {
  providerOperationCapability,
  providerOperationCapabilityMatches,
} from "@opensales/core/provider-capability";
import pg from "pg";
import { z } from "zod";

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

function reconcileDelaySeconds(attempts: number): number {
  return Math.min(
    300,
    config.RECONCILE_BASE_DELAY_SECONDS * 2 ** Math.min(Math.max(attempts - 1, 0), 6),
  );
}

async function completeJobWithClient(client: DatabaseClient, jobId: string): Promise<void> {
  await client.query(
    `UPDATE durable_jobs
     SET status = 'completed', locked_at = NULL, locked_by = NULL, last_error = NULL,
         updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
}

async function manualJobWithClient(
  client: DatabaseClient,
  jobId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE durable_jobs
     SET status = 'manual', locked_at = NULL, locked_by = NULL, last_error = $2,
         updated_at = now()
     WHERE id = $1`,
    [jobId, reason.slice(0, 1_000)],
  );
}

async function enqueueReconcileWithClient(
  client: DatabaseClient,
  jobType: "payment.reconcile" | "provision.reconcile",
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

async function recoverStaleJobs(): Promise<number> {
  return transaction(async (client) => {
    const result = await client.query<Job>(
      `SELECT id, job_type, unique_key, payload, attempts
       FROM durable_jobs
       WHERE status = 'running'
         AND locked_at < now() - make_interval(secs => $1)
       ORDER BY locked_at, created_at
       LIMIT 50
       FOR UPDATE SKIP LOCKED`,
      [config.JOB_LOCK_TIMEOUT_SECONDS],
    );

    for (const job of result.rows) {
      if (job.job_type === "payment.start" || job.job_type === "provision.start") {
        const payment = job.job_type === "payment.start";
        const subjectId = payment ? job.payload.paymentAttemptId : job.payload.serviceId;
        const operationId = job.payload.providerOperationId;
        if (!subjectId || !operationId) {
          await manualJobWithClient(
            client,
            job.id,
            "stale side-effecting job has an invalid payload; manual inspection required",
          );
          continue;
        }

        const operation = await client.query<{ status: string; attempt_count: number }>(
          `SELECT status, attempt_count
           FROM provider_operations
           WHERE id = $1
           FOR UPDATE`,
          [operationId],
        );
        const operationRecord = operation.rows[0];
        if (!operationRecord) {
          await manualJobWithClient(
            client,
            job.id,
            "stale side-effecting job references a missing provider operation",
          );
          continue;
        }
        if (operationRecord.status === "succeeded" || operationRecord.status === "failed") {
          await completeJobWithClient(client, job.id);
          continue;
        }
        if (operationRecord.status === "queued" && operationRecord.attempt_count === 0) {
          const manual = job.attempts >= config.MAX_JOB_ATTEMPTS;
          await client.query(
            `UPDATE durable_jobs
             SET status = $2,
                 available_at = CASE
                   WHEN $2 = 'pending' THEN now() + make_interval(secs => $3)
                   ELSE available_at
                 END,
                 locked_at = NULL,
                 locked_by = NULL,
                 last_error = 'worker lock expired before the provider create attempt began',
                 updated_at = now()
             WHERE id = $1`,
            [
              job.id,
              manual ? "manual" : "pending",
              reconcileDelaySeconds(job.attempts),
            ],
          );
          continue;
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
               AND status NOT IN ('succeeded', 'failed')`,
            [
              subjectId,
              {
                paymentStatus: "unknown",
                reason: "worker lock expired after a possible Provider request",
              },
            ],
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
          payment ? "payment.reconcile" : "provision.reconcile",
          job.unique_key,
          { ...job.payload, operationId },
          config.RECONCILE_BASE_DELAY_SECONDS,
        );
        await completeJobWithClient(client, job.id);
        continue;
      }

      const maxAttempts = job.job_type.endsWith(".reconcile")
        ? config.RECONCILE_MAX_ATTEMPTS
        : config.MAX_JOB_ATTEMPTS;
      const manual = job.attempts >= maxAttempts;
      await client.query(
        `UPDATE durable_jobs
         SET status = $2,
             available_at = CASE
               WHEN $2 = 'pending' THEN now() + make_interval(secs => $3)
               ELSE available_at
             END,
             locked_at = NULL,
             locked_by = NULL,
             last_error = 'worker lock expired; job recovered without replaying a create operation',
             updated_at = now()
         WHERE id = $1`,
        [job.id, manual ? "manual" : "pending", reconcileDelaySeconds(job.attempts)],
      );
    }
    return result.rowCount ?? 0;
  });
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

async function completeJob(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE durable_jobs
     SET status = 'completed', locked_at = NULL, locked_by = NULL, last_error = NULL,
         updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
}

async function failJob(job: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 1_000) : "unknown worker error";
  const maxAttempts = job.job_type.endsWith(".reconcile")
    ? config.RECONCILE_MAX_ATTEMPTS
    : config.MAX_JOB_ATTEMPTS;
  const manual = job.attempts >= maxAttempts;
  const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
  await pool.query(
    `UPDATE durable_jobs
     SET status = $2,
         available_at = now() + make_interval(secs => $3),
         locked_at = NULL,
         locked_by = NULL,
         last_error = $4,
         updated_at = now()
     WHERE id = $1`,
    [job.id, manual ? "manual" : "pending", delaySeconds, message],
  );
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
  subjectTable: "payment_attempts" | "services",
  subjectId: string,
  reconcileType: "payment.reconcile" | "provision.reconcile",
  reason: string,
): Promise<void> {
  await transaction(async (client) => {
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
           AND status NOT IN ('succeeded', 'failed')`,
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
    await completeJobWithClient(client, job.id);
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
     WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
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
  await completeJobWithClient(client, job.id);
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
  await manualJobWithClient(client, job.id, reason);
  return { kind: "halted" };
}

async function preflightPayment(
  job: Job,
  paymentAttemptId: string,
  providerOperationId: string,
  mode: "start" | "reconcile",
): Promise<PreflightResult<PaymentCall>> {
  return transaction(async (client) => {
    const paymentPointer = await client.query<{ invoice_id: string }>(
      "SELECT invoice_id FROM payment_attempts WHERE id = $1",
      [paymentAttemptId],
    );
    const invoiceId = paymentPointer.rows[0]?.invoice_id;
    if (!invoiceId) {
      await manualJobWithClient(client, job.id, "payment job references a missing Payment Attempt");
      return { kind: "halted" };
    }
    await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
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
      submitted_by_user_id: string;
      email_verified_at: Date | null;
      user_restricted_at: Date | null;
      account_restricted_at: Date | null;
      operation_status: string;
      operation_provider_installation_id: string;
      operation_kind: string;
      operation_attempt_count: number;
    }>(
      `SELECT
         pa.status AS payment_status, pa.amount_minor::text, pa.principal_minor::text,
         pa.fee_minor::text, pa.currency AS payment_currency,
         pa.scenario, pa.provider_installation_id AS payment_provider_installation_id,
         pa.client_account_id AS payment_client_account_id, pa.invoice_id,
         i.total_minor::text AS invoice_total_minor, i.currency AS invoice_currency,
         i.client_account_id AS invoice_client_account_id,
         o.id AS order_id, o.status AS order_status, o.currency AS order_currency,
         o.client_account_id AS order_client_account_id, o.submitted_by_user_id,
         u.email_verified_at, u.restricted_at AS user_restricted_at,
         ca.restricted_at AS account_restricted_at,
         po.status AS operation_status,
         po.provider_installation_id AS operation_provider_installation_id,
         po.kind AS operation_kind,
         po.attempt_count AS operation_attempt_count
       FROM payment_attempts pa
       JOIN invoices i ON i.id = pa.invoice_id
       JOIN orders o ON o.id = i.order_id
       JOIN users u ON u.id = o.submitted_by_user_id
       JOIN client_accounts ca ON ca.id = o.client_account_id
       JOIN provider_operations po
         ON po.id = $2
        AND po.subject_type = 'payment'
        AND po.subject_id = pa.id
       WHERE pa.id = $1
       FOR UPDATE OF pa, i, o, u, ca, po`,
      [paymentAttemptId, providerOperationId],
    );
    const payment = result.rows[0];
    if (!payment) {
      await manualJobWithClient(
        client,
        job.id,
        "payment job references missing or inconsistent Core records",
      );
      return { kind: "halted" };
    }

    if (payment.operation_status === "succeeded" || payment.operation_status === "failed") {
      await completeJobWithClient(client, job.id);
      return { kind: "halted" };
    }
    if (payment.operation_kind !== "payment_create") {
      await manualJobWithClient(
        client,
        job.id,
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
      await completeJobWithClient(client, job.id);
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
           AND status NOT IN ('succeeded', 'failed')`,
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
      await completeJobWithClient(client, job.id);
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

    const membership = await client.query<{ removed_at: Date | null }>(
      `SELECT removed_at
       FROM client_memberships
       WHERE client_account_id = $1 AND user_id = $2
       FOR UPDATE`,
      [payment.order_client_account_id, payment.submitted_by_user_id],
    );
    const member = membership.rows[0];
    const eligible =
      Boolean(payment.email_verified_at) &&
      !payment.user_restricted_at &&
      !payment.account_restricted_at &&
      Boolean(member) &&
      !member?.removed_at;

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
    if (
      payment.order_status !== "waiting_payment" ||
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
  await manualJobWithClient(client, job.id, reason);
  return { kind: "halted" };
}

async function preflightProvision(
  job: Job,
  serviceId: string,
  providerOperationId: string,
  mode: "start" | "reconcile",
): Promise<PreflightResult<undefined>> {
  return transaction(async (client) => {
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
       WHERE s.id = $1
       FOR UPDATE OF s, oi, o, i, u, ca, po`,
      [serviceId, providerOperationId],
    );
    const service = result.rows[0];
    if (!service) {
      await manualJobWithClient(
        client,
        job.id,
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
      await completeJobWithClient(client, job.id);
      return { kind: "halted" };
    }
    if (service.operation_kind !== "resource_create") {
      await manualJobWithClient(
        client,
        job.id,
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
          job.id,
          "provision reconciliation has no evidence that a provider create was sent",
        );
        return { kind: "halted" };
      }
      return { kind: "call", value: undefined };
    }
    if (service.service_status === "active" || service.service_status === "terminated") {
      await completeJobWithClient(client, job.id);
      return { kind: "halted" };
    }

    const membership = await client.query<{ removed_at: Date | null }>(
      `SELECT removed_at
       FROM client_memberships
       WHERE client_account_id = $1 AND user_id = $2
       FOR UPDATE`,
      [service.order_client_account_id, service.submitted_by_user_id],
    );
    const member = membership.rows[0];
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
        await completeJobWithClient(client, job.id);
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

async function finishStartWithWatchdog(
  job: Job,
  operationId: string,
  reconcileType: "payment.reconcile" | "provision.reconcile",
): Promise<void> {
  await transaction(async (client) => {
    const operation = await client.query<{ status: string }>(
      "SELECT status FROM provider_operations WHERE id = $1 FOR UPDATE",
      [operationId],
    );
    const status = operation.rows[0]?.status;
    if (status && status !== "succeeded" && status !== "failed") {
      await enqueueReconcileWithClient(
        client,
        reconcileType,
        job.unique_key,
        { ...job.payload, operationId },
        config.WATCHDOG_DELAY_SECONDS,
      );
    }
    await completeJobWithClient(client, job.id);
  });
}

async function rejectPaymentStartManually(
  job: Job,
  operationId: string,
  paymentAttemptId: string,
  reason: string,
): Promise<void> {
  await transaction(async (client) => {
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
    if (invoiceId) {
      await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
    }
    const locked = await client.query<{
      payment_status: string;
      operation_status: string;
    }>(
      `SELECT pa.status AS payment_status, po.status AS operation_status
       FROM payment_attempts pa
       JOIN orders o ON o.id = $2
       JOIN provider_operations po ON po.id = $3
       WHERE pa.id = $1
         AND po.subject_type = 'payment'
         AND po.subject_id = pa.id
       FOR UPDATE OF pa, o, po`,
      [paymentAttemptId, orderId, operationId],
    );
    const current = locked.rows[0];
    if (
      !current ||
      current.payment_status === "succeeded" ||
      current.operation_status === "succeeded"
    ) {
      await completeJobWithClient(client, job.id);
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
    if (orderId) {
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
       ) VALUES ('system', $1, 'payment.provider_create_rejected', 'payment', $2, $3, $4)`,
      [
        config.WORKER_ID,
        paymentAttemptId,
        reason.slice(0, 1_000),
        {
          providerOperationId: operationId,
          orderId: orderId ?? null,
          creditRestoredMinor,
        },
      ],
    );
    await manualJobWithClient(client, job.id, reason);
  });
}

async function rejectProvisionStartManually(
  job: Job,
  operationId: string,
  serviceId: string,
  reason: string,
): Promise<void> {
  await transaction(async (client) => {
    const result = await client.query<{ order_id: string }>(
      `SELECT o.id AS order_id
       FROM services s
       JOIN order_items oi ON oi.id = s.order_item_id
       JOIN orders o ON o.id = oi.order_id
       WHERE s.id = $1
       FOR UPDATE OF s, o`,
      [serviceId],
    );
    const orderId = result.rows[0]?.order_id;
    await client.query(
      `UPDATE provider_operations
       SET status = 'failed', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
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
    await manualJobWithClient(client, job.id, reason);
  });
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
    const manual = forceManual || job.attempts >= config.RECONCILE_MAX_ATTEMPTS;
    await client.query(
      `UPDATE provider_operations
       SET last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [operationId, reason.slice(0, 1_000)],
    );
    await client.query(
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
       WHERE id = $1`,
      [
        job.id,
        manual ? "manual" : "pending",
        reconcileDelaySeconds(job.attempts),
        reason.slice(0, 1_000),
      ],
    );
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
       WHERE service.id = $1
       FOR UPDATE OF service, customer_order, operation`,
      [serviceId, operationId],
    );
    const current = result.rows[0];
    if (!current) {
      await manualJobWithClient(
        client,
        job.id,
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
      await completeJobWithClient(client, job.id);
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
    await manualJobWithClient(client, job.id, reason);
  });
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
      eventId: `reconcile:${operationId}:${fact.status}:attempt:${job.attempts}`,
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
  await completeJob(job.id);
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
      eventId: `reconcile:${operationId}:${fact.status}:attempt:${job.attempts}`,
      providerOperationId: operationId,
      ...fact,
    },
    config.MOCK_PROVISIONING_WEBHOOK_SECRET,
  );
  if (coreOutcome.kind === "retry") {
    await delayReconcile(job, operationId, coreOutcome.reason);
    return;
  }
  await completeJob(job.id);
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
    await completeJob(job.id);
    return;
  }
  if (
    outbox.event_type !== "notification.email_verification_requested" ||
    !outbox.payload.email ||
    !outbox.payload.verificationUrl
  ) {
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
        template: "email-verification",
        locale: outbox.payload.locale ?? "en",
        subject:
          outbox.payload.locale === "zh-CN"
            ? "验证 OpenSales System 实验室账号"
            : "Verify your OpenSales System laboratory account",
        body: `NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\n${outbox.payload.verificationUrl}\n\nExpires: ${outbox.payload.expiresAt ?? "unknown"}`,
        sensitive: true,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Mock Mail Provider rejected notification with ${response.status}`);
  }
  await pool.query("UPDATE outbox SET published_at = now() WHERE id = $1 AND published_at IS NULL", [
    outboxId,
  ]);
  await completeJob(job.id);
}

async function processJob(job: Job): Promise<void> {
  if (job.job_type === "notification.send") return sendNotification(job);
  if (job.job_type === "payment.start") return startPayment(job);
  if (job.job_type === "payment.reconcile") return reconcilePayment(job);
  if (job.job_type === "provision.start") return startProvision(job);
  if (job.job_type === "provision.reconcile") return reconcileProvision(job);
  throw new Error(`Unsupported job type: ${job.job_type}`);
}

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

console.log(`OpenSales worker ${config.WORKER_ID} started (${randomUUID()}).`);
let nextRecoveryAt = 0;
while (!stopping) {
  if (Date.now() >= nextRecoveryAt) {
    try {
      const recovered = await recoverStaleJobs();
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
  const job = await claimJob();
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, config.WORKER_POLL_MS));
    continue;
  }
  try {
    await processJob(job);
  } catch (error) {
    console.error("job failed", {
      jobId: job.id,
      jobType: job.job_type,
      error: error instanceof Error ? error.message : "unknown",
    });
    await failJob(job, error);
  }
}
await pool.end();
