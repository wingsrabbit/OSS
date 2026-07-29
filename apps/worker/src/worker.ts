// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";

const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    MOCK_PROVIDER_URL: z.url(),
    MOCK_PROVIDER_TOKEN: z.string().min(32),
    MOCK_PROVIDER_WEBHOOK_SECRET: z.string().min(32),
    CORE_INTERNAL_URL: z.url().default("http://api:3000"),
    WORKER_ID: z.string().default(`worker-${process.pid}`),
    WORKER_POLL_MS: z.coerce.number().int().positive().default(500),
    PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
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
     SET status = 'completed', locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
}

async function failJob(job: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 1_000) : "unknown worker error";
  const manual = job.attempts >= 8;
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
  path: string,
  init: RequestInit,
  timeoutMs = config.PROVIDER_TIMEOUT_MS,
): Promise<Response> {
  return fetch(new URL(path, config.MOCK_PROVIDER_URL), {
    ...init,
    headers: {
      Authorization: `Bearer ${config.MOCK_PROVIDER_TOKEN}`,
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
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = 'provider request timed out; reconciliation required',
           updated_at = now()
       WHERE id = $1 AND status <> 'succeeded'`,
      [operationId],
    );
    if (subjectTable === "payment_attempts") {
      await client.query(
        `UPDATE payment_attempts
         SET status = 'unknown', updated_at = now(), version = version + 1
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled', 'expired')`,
        [subjectId],
      );
    } else {
      await client.query(
        `UPDATE services
         SET status = 'confirming', updated_at = now(), version = version + 1
         WHERE id = $1 AND status <> 'active'`,
        [subjectId],
      );
    }
    await client.query(
      `INSERT INTO durable_jobs(job_type, unique_key, payload, available_at)
       VALUES ($1, $2, $3, now() + interval '3 seconds')
       ON CONFLICT (job_type, unique_key) DO UPDATE
         SET status = 'pending', available_at = EXCLUDED.available_at, updated_at = now()`,
      [reconcileType, job.unique_key, { ...job.payload, operationId }],
    );
    await client.query(
      `UPDATE durable_jobs
       SET status = 'completed', locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = $1`,
      [job.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function startPayment(job: Job): Promise<void> {
  const paymentAttemptId = job.payload.paymentAttemptId;
  const providerOperationId = job.payload.providerOperationId;
  if (!paymentAttemptId || !providerOperationId) throw new Error("Invalid payment.start payload");
  const result = await pool.query<{
    amount_minor: string;
    currency: string;
    scenario: string;
  }>(
    `UPDATE payment_attempts
     SET status = 'processing', updated_at = now(), version = version + 1
     WHERE id = $1 AND status IN ('created', 'processing')
     RETURNING amount_minor, currency, scenario`,
    [paymentAttemptId],
  );
  const payment = result.rows[0];
  if (!payment) {
    await completeJob(job.id);
    return;
  }
  await pool.query(
    `UPDATE provider_operations
     SET status = 'running', attempt_count = attempt_count + 1, updated_at = now()
     WHERE id = $1`,
    [providerOperationId],
  );
  try {
    const response = await providerRequest("/v1/payments", {
      method: "POST",
      headers: { "Idempotency-Key": providerOperationId },
      body: JSON.stringify({
        operationId: providerOperationId,
        paymentAttemptId,
        amountMinor: payment.amount_minor,
        currency: payment.currency,
        scenario: payment.scenario,
      }),
    });
    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) {
        await markUnknown(
          job,
          providerOperationId,
          "payment_attempts",
          paymentAttemptId,
          "payment.reconcile",
        );
        return;
      }
      throw new Error(`payment provider rejected request with ${response.status}`);
    }
    await completeJob(job.id);
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      await markUnknown(
        job,
        providerOperationId,
        "payment_attempts",
        paymentAttemptId,
        "payment.reconcile",
      );
      return;
    }
    throw error;
  }
}

async function startProvision(job: Job): Promise<void> {
  const serviceId = job.payload.serviceId;
  const providerOperationId = job.payload.providerOperationId;
  if (!serviceId || !providerOperationId) throw new Error("Invalid provision.start payload");
  const result = await pool.query(
    `UPDATE services
     SET status = 'provisioning', updated_at = now(), version = version + 1
     WHERE id = $1 AND status IN ('pending', 'provisioning')
     RETURNING id`,
    [serviceId],
  );
  if (result.rowCount !== 1) {
    await completeJob(job.id);
    return;
  }
  await pool.query(
    `UPDATE provider_operations
     SET status = 'running', attempt_count = attempt_count + 1, updated_at = now()
     WHERE id = $1`,
    [providerOperationId],
  );
  try {
    const response = await providerRequest("/v1/resources", {
      method: "POST",
      headers: { "Idempotency-Key": providerOperationId },
      body: JSON.stringify({
        operationId: providerOperationId,
        serviceId,
        scenario: config.MOCK_PROVISION_SCENARIO,
      }),
    });
    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) {
        await markUnknown(
          job,
          providerOperationId,
          "services",
          serviceId,
          "provision.reconcile",
        );
        return;
      }
      throw new Error(`provisioning provider rejected request with ${response.status}`);
    }
    await completeJob(job.id);
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      await markUnknown(
        job,
        providerOperationId,
        "services",
        serviceId,
        "provision.reconcile",
      );
      return;
    }
    throw error;
  }
}

function coreSignature(timestamp: string, body: unknown): string {
  return createHmac("sha256", config.MOCK_PROVIDER_WEBHOOK_SECRET)
    .update(`${timestamp}.${JSON.stringify(body)}`, "utf8")
    .digest("hex");
}

async function submitReconciledEvent(path: string, body: unknown): Promise<void> {
  const timestamp = Date.now().toString();
  const response = await fetch(new URL(path, config.CORE_INTERNAL_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OSS-Timestamp": timestamp,
      "X-OSS-Signature": coreSignature(timestamp, body),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Core rejected reconciled provider fact with ${response.status}`);
}

async function reconcilePayment(job: Job): Promise<void> {
  const operationId = job.payload.operationId ?? job.payload.providerOperationId;
  const paymentAttemptId = job.payload.paymentAttemptId;
  if (!operationId || !paymentAttemptId) throw new Error("Invalid payment.reconcile payload");
  const response = await providerRequest(`/v1/payments/${encodeURIComponent(operationId)}`, {
    method: "GET",
  });
  if (response.status === 404) throw new Error("Provider does not yet know this payment operation");
  if (!response.ok) throw new Error(`Payment reconciliation failed with ${response.status}`);
  const fact = z
    .object({
      externalPaymentId: z.string(),
      status: z.enum(["processing", "succeeded", "failed", "cancelled", "expired"]),
      amountMinor: z.string(),
      currency: z.string(),
      occurredAt: z.string(),
    })
    .parse(await response.json());
  await submitReconciledEvent("/api/v1/provider-events/payment", {
    eventId: `reconcile:${operationId}:${fact.status}`,
    paymentAttemptId,
    ...fact,
  });
  await completeJob(job.id);
}

async function reconcileProvision(job: Job): Promise<void> {
  const operationId = job.payload.operationId ?? job.payload.providerOperationId;
  if (!operationId) throw new Error("Invalid provision.reconcile payload");
  const response = await providerRequest(`/v1/resources/${encodeURIComponent(operationId)}`, {
    method: "GET",
  });
  if (response.status === 404) throw new Error("Provider does not yet know this resource operation");
  if (!response.ok) throw new Error(`Provisioning reconciliation failed with ${response.status}`);
  const fact = z
    .object({
      status: z.enum(["succeeded", "failed"]),
      externalResourceId: z.string().optional(),
      readyAt: z.string().optional(),
      occurredAt: z.string(),
    })
    .parse(await response.json());
  await submitReconciledEvent("/api/v1/provider-events/provisioning", {
    eventId: `reconcile:${operationId}:${fact.status}`,
    providerOperationId: operationId,
    ...fact,
  });
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
  const response = await providerRequest("/v1/mail", {
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
  });
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
while (!stopping) {
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
