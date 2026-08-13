// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createIdentitySecretKeyring,
  encryptIdentitySecret,
} from "@opensales/core/identity-security";
import pg from "pg";
import { claimSchema016Job } from "./job-claim.js";
import {
  persistUnexpectedIdentityNotificationFailure,
  processIdentityNotificationJob,
  type IdentityNotificationJob,
  type IdentityNotificationRuntimeConfig,
} from "./identity-notification-orchestration.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Identity notification integration");
}

const databaseName = `oss_identity_worker_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(adminDatabaseUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let pool: pg.Pool | null = null;

const workerId = `identity-notification-${randomUUID()}`;
const providerToken = `synthetic-identity-provider-${randomUUID()}`;
const publicUrl = "http://127.0.0.1:5173";
const keyring = createIdentitySecretKeyring(
  1,
  Buffer.alloc(32, 131).toString("base64url"),
);

type ProviderMode = "terminal" | "drop_without_store" | "drop_without_store_and_get";
type ProviderFact = Readonly<{
  operationId: string;
  status: "delivered" | "bounced" | "failed";
  deliveredAt: string;
}>;

let providerMode: ProviderMode = "terminal";
const providerFacts = new Map<string, ProviderFact>();
const postOperationIds: string[] = [];
const getOperationIds: string[] = [];
const postBodies = new Map<string, Record<string, unknown>>();

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

const provider = createServer(async (request, response) => {
  try {
    if (request.headers.authorization !== `Bearer ${providerToken}`) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/v1/mail") {
      const body = await readJson(request);
      const operationId = typeof body.operationId === "string" ? body.operationId : "";
      const status = body.scenario;
      if (
        !operationId || request.headers["idempotency-key"] !== operationId ||
        !["delivered", "bounced", "failed"].includes(String(status))
      ) {
        writeJson(response, 400, { error: "invalid_request" });
        return;
      }
      postOperationIds.push(operationId);
      postBodies.set(operationId, body);
      if (providerMode !== "terminal") {
        request.socket.destroy();
        return;
      }
      const fact: ProviderFact = {
        operationId,
        status: status as ProviderFact["status"],
        deliveredAt: new Date().toISOString(),
      };
      providerFacts.set(operationId, fact);
      writeJson(response, 202, fact);
      return;
    }
    const match = request.method === "GET"
      ? /^\/v1\/mail\/([0-9a-f-]+)$/i.exec(url.pathname)
      : null;
    if (match?.[1]) {
      const operationId = match[1];
      getOperationIds.push(operationId);
      if (providerMode === "drop_without_store_and_get") {
        request.socket.destroy();
        return;
      }
      const fact = providerFacts.get(operationId);
      if (!fact) {
        response.writeHead(404);
        response.end();
        return;
      }
      writeJson(response, 200, fact);
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  } catch {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

await new Promise<void>((resolve, reject) => {
  provider.once("error", reject);
  provider.listen(0, "127.0.0.1", () => resolve());
});
const providerAddress = provider.address() as AddressInfo;
const providerUrl = `http://127.0.0.1:${providerAddress.port}`;

function runtime(
  scenario: IdentityNotificationRuntimeConfig["scenario"],
): IdentityNotificationRuntimeConfig {
  return {
    workerId,
    providerUrl,
    providerToken,
    publicUrl,
    providerTimeoutMs: 1_000,
    retryDelaySeconds: 0,
    maxDeliveryAttempts: 3,
    maxReconcileAttempts: 3,
    scenario,
    keyring,
  };
}

async function runMigrations(client: pg.Client): Promise<void> {
  const directory = new URL("../../api/migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  await client.query("BEGIN");
  try {
    await client.query(
      `CREATE TABLE public.schema_migrations(
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT pg_catalog.now()
       )`,
    );
    for (const file of files) {
      await client.query(await readFile(new URL(file, directory), "utf8"));
      await client.query(
        "INSERT INTO public.schema_migrations(version) VALUES ($1)",
        [file.replace(/\.sql$/, "")],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

type Bundle = Readonly<{
  outboxId: string;
  operationId: string;
  durableJobId: string;
  providerOperationId: string;
  rawToken: string;
}>;

async function createBundle(input: Readonly<{
  kind: "password_recovery" | "email_change";
  label: string;
  wrongPayloadToken?: boolean;
}>): Promise<Bundle> {
  if (!pool) throw new Error("Database unavailable");
  const userId = randomUUID();
  const subjectId = randomUUID();
  const rawToken = randomBytes(32).toString("base64url");
  const payloadToken = input.wrongPayloadToken
    ? randomBytes(32).toString("base64url")
    : rawToken;
  const email = `${input.label}-${databaseName}@example.invalid`;
  const recipient = input.kind === "email_change"
    ? `changed-${input.label}-${databaseName}@example.invalid`
    : email;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', 'en', pg_catalog.now())`,
      [userId, email],
    );
    const clock = await client.query<{ expires_at: Date }>(
      `SELECT pg_catalog.clock_timestamp() + interval '30 minutes' AS expires_at`,
    );
    const expiresAt = clock.rows[0]!.expires_at;
    const digest = createHash("sha256").update(rawToken, "utf8").digest();
    if (input.kind === "password_recovery") {
      await client.query(
        `INSERT INTO password_reset_tokens(
           id, user_id, token_digest, expires_at
         ) VALUES ($1, $2, $3, $4)`,
        [subjectId, userId, digest, expiresAt],
      );
    } else {
      await client.query(
        `INSERT INTO email_change_tokens(
           id, user_id, requested_email, token_digest, expires_at
         ) VALUES ($1, $2, $3, $4, $5)`,
        [subjectId, userId, recipient, digest, expiresAt],
      );
    }
    const path = input.kind === "password_recovery" ? "/password-recovery" : "/email-change";
    const encrypted = encryptIdentitySecret(
      JSON.stringify({
        url: `${publicUrl}${path}#token=${payloadToken}`,
        expiresAt: expiresAt.toISOString(),
      }),
      `identity-notification:${input.kind}`,
      subjectId,
      keyring,
    );
    const outbox = await client.query<{ id: string }>(
      `INSERT INTO identity_notification_outbox(
         user_id, kind, recipient, locale, subject_id,
         encrypted_payload, encryption_key_version, expires_at
       ) VALUES ($1, $2, $3, 'en', $4, $5, $6, $7)
       RETURNING id`,
      [
        userId,
        input.kind,
        recipient,
        subjectId,
        encrypted.ciphertext,
        encrypted.keyVersion,
        expiresAt,
      ],
    );
    const outboxId = outbox.rows[0]!.id;
    const operation = await client.query<{
      id: string;
      provider_operation_id: string;
    }>(
      `INSERT INTO identity_notification_delivery_operations(
         outbox_id, attempt_number, provider_operation_id,
         request_fingerprint, status
       )
       SELECT event.id, 1,
              public.opensales_notification_provider_operation_id(event.id, 1),
              public.opensales_identity_notification_request_fingerprint(
                event.id, event.user_id, event.kind, event.recipient, event.locale,
                event.subject_id, event.encrypted_payload,
                event.encryption_key_version, event.expires_at
              ),
              'queued'
       FROM identity_notification_outbox event WHERE event.id = $1
       RETURNING id, provider_operation_id`,
      [outboxId],
    );
    const operationId = operation.rows[0]!.id;
    const durableJob = await client.query<{ id: string }>(
      `INSERT INTO durable_jobs(job_type, unique_key, payload)
       VALUES (
         'identity.notification.send',
         'identity-notification:' || $1::text || ':attempt:1',
         pg_catalog.jsonb_build_object(
           'outboxId', $1::text,
           'operationId', $2::text,
           'attemptNumber', 1
         )
       ) RETURNING id`,
      [outboxId, operationId],
    );
    await client.query("COMMIT");
    return {
      outboxId,
      operationId,
      durableJobId: durableJob.rows[0]!.id,
      providerOperationId: operation.rows[0]!.provider_operation_id,
      rawToken,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function claim(): Promise<IdentityNotificationJob> {
  if (!pool) throw new Error("Database unavailable");
  const job = await claimSchema016Job<IdentityNotificationJob & pg.QueryResultRow>(pool, workerId);
  assert.ok(job, "expected an identity notification job");
  assert.equal(job.job_type, "identity.notification.send");
  return job;
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const migrationClient = new pg.Client({ connectionString: databaseUrl.toString() });
  await migrationClient.connect();
  try {
    await runMigrations(migrationClient);
  } finally {
    await migrationClient.end();
  }
  pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 8,
    options: "-c search_path=pg_catalog,public",
    statement_timeout: 20_000,
    application_name: "opensales-identity-notification-integration",
  });

  const leaseGuardBundle = await createBundle({
    kind: "password_recovery",
    label: "lease-guard",
  });
  await assert.rejects(pool.query(
    "DELETE FROM durable_jobs WHERE id = $1",
    [leaseGuardBundle.durableJobId],
  ));
  await assert.rejects(pool.query(
    `UPDATE durable_jobs
     SET status = 'running', attempts = 99,
         locked_at = pg_catalog.clock_timestamp(), locked_by = 'raw-forgery',
         updated_at = pg_catalog.clock_timestamp()
     WHERE id = $1`,
    [leaseGuardBundle.durableJobId],
  ));
  const leaseGuardJob = await claim();
  assert.equal(
    (leaseGuardJob.payload as { operationId?: unknown }).operationId,
    leaseGuardBundle.operationId,
  );
  await assert.rejects(pool.query(
    `UPDATE durable_jobs
     SET locked_by = 'swapped-worker',
         updated_at = pg_catalog.clock_timestamp()
     WHERE id = $1`,
    [leaseGuardBundle.durableJobId],
  ));
  await assert.rejects(pool.query(
    `UPDATE durable_jobs
     SET status = 'completed', locked_at = NULL, locked_by = NULL,
         last_error = NULL, updated_at = pg_catalog.clock_timestamp()
     WHERE id = $1`,
    [leaseGuardBundle.durableJobId],
  ));
  await processIdentityNotificationJob(pool, leaseGuardJob, runtime("delivered"));
  await assert.rejects(pool.query(
    "DELETE FROM durable_jobs WHERE id = $1",
    [leaseGuardBundle.durableJobId],
  ));

  const rawProjectionBundle = await createBundle({
    kind: "password_recovery",
    label: "raw-projection",
  });
  await assert.rejects(pool.query(
    `INSERT INTO identity_notification_delivery_facts(
       outbox_id, attempt_number, provider_operation_id, status, failure_reason
     ) VALUES ($1, 1, $2, 'manual', 'raw fact without terminal operation')`,
    [rawProjectionBundle.outboxId, rawProjectionBundle.providerOperationId],
  ));
  await assert.rejects(pool.query(
    `UPDATE identity_notification_delivery_operations
     SET status = 'manual', last_error = 'raw terminal without fact or job transition',
         updated_at = GREATEST(
           pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond'
         )
     WHERE id = $1`,
    [rawProjectionBundle.operationId],
  ));
  await processIdentityNotificationJob(pool, await claim(), runtime("delivered"));

  providerMode = "terminal";
  const failedBundle = await createBundle({ kind: "password_recovery", label: "failed" });
  const postsBeforeFailed = postOperationIds.length;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await processIdentityNotificationJob(pool, await claim(), runtime("failed"));
  }
  const failedProjection = await pool.query<{
    operation_count: string;
    fact_count: string;
    job_count: string;
    max_attempt: number;
  }>(
    `SELECT
       (SELECT pg_catalog.count(*)::text
        FROM identity_notification_delivery_operations
        WHERE outbox_id = $1) AS operation_count,
       (SELECT pg_catalog.count(*)::text
        FROM identity_notification_delivery_facts
        WHERE outbox_id = $1 AND status = 'failed') AS fact_count,
       (SELECT pg_catalog.count(*)::text
        FROM durable_jobs
        WHERE job_type = 'identity.notification.send'
          AND payload ->> 'outboxId' = $1::text
          AND status = 'completed') AS job_count,
       (SELECT pg_catalog.max(attempt_number)
        FROM identity_notification_delivery_operations
        WHERE outbox_id = $1) AS max_attempt`,
    [failedBundle.outboxId],
  );
  assert.deepEqual(failedProjection.rows[0], {
    operation_count: "3",
    fact_count: "3",
    job_count: "3",
    max_attempt: 3,
  });
  assert.equal(postOperationIds.length, postsBeforeFailed + 3);
  assert.equal(
    new Set(postOperationIds.slice(postsBeforeFailed)).size,
    3,
    "each retry must have a new deterministic operation",
  );

  const emailBundle = await createBundle({ kind: "email_change", label: "email-change" });
  await processIdentityNotificationJob(pool, await claim(), runtime("delivered"));
  const emailBody = postBodies.get(emailBundle.providerOperationId);
  assert.ok(emailBody);
  assert.equal(
    emailBody.recipient,
    `changed-email-change-${databaseName}@example.invalid`,
  );
  assert.match(String(emailBody.body), /\/email-change#token=/);

  providerMode = "drop_without_store_and_get";
  const budgetBundle = await createBundle({
    kind: "password_recovery",
    label: "get-budget",
  });
  const postsBeforeBudget = postOperationIds.length;
  const getsBeforeBudget = getOperationIds.length;
  await processIdentityNotificationJob(pool, await claim(), runtime("delivered"));
  assert.equal(postOperationIds.length, postsBeforeBudget + 1);
  const interruptedReconcile = await claim();
  await persistUnexpectedIdentityNotificationFailure(
    pool,
    interruptedReconcile,
    runtime("delivered"),
  );
  const noQueryConsumed = await pool.query<{
    status: string;
    reconcile_query_count: number;
  }>(
    `SELECT status, reconcile_query_count
     FROM identity_notification_delivery_operations WHERE id = $1`,
    [budgetBundle.operationId],
  );
  assert.deepEqual(noQueryConsumed.rows[0], {
    status: "unknown",
    reconcile_query_count: 0,
  });
  assert.equal(getOperationIds.length, getsBeforeBudget);
  for (let queryAttempt = 1; queryAttempt <= 3; queryAttempt += 1) {
    await processIdentityNotificationJob(pool, await claim(), runtime("delivered"));
    const queryProjection: pg.QueryResult<{
      status: string;
      reconcile_query_count: number;
    }> = await pool.query(
      `SELECT status, reconcile_query_count
       FROM identity_notification_delivery_operations WHERE id = $1`,
      [budgetBundle.operationId],
    );
    assert.deepEqual(queryProjection.rows[0], {
      status: queryAttempt === 3 ? "manual" : "unknown",
      reconcile_query_count: queryAttempt,
    });
  }
  assert.equal(postOperationIds.length, postsBeforeBudget + 1, "GET budget must never retry POST");
  assert.equal(getOperationIds.length, getsBeforeBudget + 3, "only completed GET queries consume budget");

  providerMode = "drop_without_store";
  const unknownBundle = await createBundle({ kind: "password_recovery", label: "unknown" });
  const postsBeforeUnknown = postOperationIds.length;
  await processIdentityNotificationJob(pool, await claim(), runtime("delivered"));
  assert.equal(postOperationIds.length, postsBeforeUnknown + 1);
  const unknownAfterPost = await pool.query<{
    status: string;
    reconcile_query_count: number;
  }>(
    `SELECT status, reconcile_query_count
     FROM identity_notification_delivery_operations WHERE id = $1`,
    [unknownBundle.operationId],
  );
  assert.deepEqual(unknownAfterPost.rows[0], {
    status: "unknown",
    reconcile_query_count: 0,
  });
  await processIdentityNotificationJob(pool, await claim(), runtime("delivered"));
  assert.equal(postOperationIds.length, postsBeforeUnknown + 1, "unknown reconciliation must never POST");
  assert.deepEqual(getOperationIds.slice(-1), [unknownBundle.providerOperationId]);
  const unknownTerminal = await pool.query<{
    operation_status: string;
    reconcile_query_count: number;
    job_status: string;
    fact_status: string;
    failure_reason: string;
  }>(
    `SELECT operation.status AS operation_status,
            operation.reconcile_query_count,
            job.status AS job_status,
            fact.status AS fact_status,
            fact.failure_reason
     FROM identity_notification_delivery_operations operation
     JOIN durable_jobs job ON job.payload ->> 'operationId' = operation.id::text
     JOIN identity_notification_delivery_facts fact
       ON fact.outbox_id = operation.outbox_id
      AND fact.attempt_number = operation.attempt_number
     WHERE operation.id = $1`,
    [unknownBundle.operationId],
  );
  assert.deepEqual(unknownTerminal.rows[0], {
    operation_status: "manual",
    reconcile_query_count: 1,
    job_status: "manual",
    fact_status: "manual",
    failure_reason: "MOCK_MAIL_GET_NOT_FOUND_AFTER_UNKNOWN_POST",
  });

  providerMode = "terminal";
  const postsBeforeWrongToken = postOperationIds.length;
  const wrongToken = await createBundle({
    kind: "password_recovery",
    label: "wrong-token",
    wrongPayloadToken: true,
  });
  await processIdentityNotificationJob(pool, await claim(), runtime("delivered"));
  assert.equal(postOperationIds.length, postsBeforeWrongToken, "wrong token payload must not POST");
  const wrongTokenProjection = await pool.query<{
    operation_status: string;
    job_status: string;
    failure_reason: string;
  }>(
    `SELECT operation.status AS operation_status,
            job.status AS job_status,
            fact.failure_reason
     FROM identity_notification_delivery_operations operation
     JOIN durable_jobs job ON job.payload ->> 'operationId' = operation.id::text
     JOIN identity_notification_delivery_facts fact
       ON fact.outbox_id = operation.outbox_id
      AND fact.attempt_number = operation.attempt_number
     WHERE operation.id = $1`,
    [wrongToken.operationId],
  );
  assert.deepEqual(wrongTokenProjection.rows[0], {
    operation_status: "manual",
    job_status: "manual",
    failure_reason: "IDENTITY_NOTIFICATION_PAYLOAD_CONTRACT_MISMATCH",
  });

  console.log(
    "Identity notification PostgreSQL 18/Mock Mail integration: PASS — exact raw-DML lease/job/operation/fact guards, failed attempt1→2→3 append-only retry, email-change delivery to requested address, interrupted reconciliation without budget loss, three actual GET-only queries to exhaustion, unknown POST 404 manual, and wrong-token no-POST barrier.",
  );
} finally {
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await pool?.end().catch(() => undefined);
  pool = null;
  try {
    await admin.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`,
      [databaseName],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
  } finally {
    await admin.end().catch(() => undefined);
  }
}
