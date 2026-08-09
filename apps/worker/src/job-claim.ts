// SPDX-License-Identifier: AGPL-3.0-or-later

import type pg from "pg";

export const SCHEMA_016_GENERIC_RECOVERY_JOB_TYPES = Object.freeze([
  "billing.automation.scheduled",
  "notification.send",
  "payment.start",
  "payment.reconcile",
  "add_funds.start",
  "add_funds.reconcile",
  "provision.start",
  "provision.reconcile",
] as const);

export const SCHEMA_016_REFUND_JOB_TYPES = Object.freeze([
  "refund.start",
  "refund.reconcile",
] as const);

export const SCHEMA_016_SERVICE_ACTION_JOB_TYPES = Object.freeze([
  "service.suspend.start",
  "service.suspend.reconcile",
  "service.resume.start",
  "service.resume.reconcile",
] as const);

export const SCHEMA_016_CANCELLATION_JOB_TYPES = Object.freeze([
  "service.cancellation.due",
  "service.cancellation.reconcile",
] as const);

export const SCHEMA_016_SUPPORTED_JOB_TYPES = Object.freeze([
  ...SCHEMA_016_GENERIC_RECOVERY_JOB_TYPES,
  ...SCHEMA_016_REFUND_JOB_TYPES,
  ...SCHEMA_016_SERVICE_ACTION_JOB_TYPES,
  ...SCHEMA_016_CANCELLATION_JOB_TYPES,
] as const);

export type Schema016SupportedJobType =
  (typeof SCHEMA_016_SUPPORTED_JOB_TYPES)[number];

const schema016GenericRecoveryJobTypeSet: ReadonlySet<string> = new Set(
  SCHEMA_016_GENERIC_RECOVERY_JOB_TYPES,
);

export function isSchema016GenericRecoveryJobType(
  jobType: string,
): jobType is (typeof SCHEMA_016_GENERIC_RECOVERY_JOB_TYPES)[number] {
  return schema016GenericRecoveryJobTypeSet.has(jobType);
}

export async function claimSchema016Job<T extends pg.QueryResultRow>(
  pool: Pick<pg.Pool, "query">,
  workerId: string,
): Promise<T | null> {
  const result = await pool.query<T>(
    `WITH candidate AS (
       SELECT id
       FROM public.durable_jobs
       WHERE status = 'pending'
         AND available_at <= now()
         AND job_type = ANY($2::text[])
       ORDER BY available_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE public.durable_jobs job
     SET status = 'running',
         attempts = job.attempts + 1,
         locked_at = now(),
         locked_by = $1,
         updated_at = now()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.id, job.job_type, job.unique_key, job.payload, job.attempts`,
    [workerId, [...SCHEMA_016_SUPPORTED_JOB_TYPES]],
  );
  return result.rows[0] ?? null;
}

export type StaleJobIdentity = {
  readonly id: string;
  readonly job_type: string;
  readonly attempts: number;
};

export async function findSchema016GenericRecoveryCandidates<
  T extends pg.QueryResultRow,
>(
  pool: Pick<pg.Pool, "query">,
  lockTimeoutSeconds: number,
  limit = 50,
): Promise<T[]> {
  const result = await pool.query<T>(
    `SELECT id, job_type, unique_key, payload, attempts
     FROM public.durable_jobs
     WHERE status = 'running'
       AND locked_at < now() - make_interval(secs => $1)
       AND job_type = ANY($2::text[])
     ORDER BY locked_at, created_at
     LIMIT $3`,
    [lockTimeoutSeconds, [...SCHEMA_016_GENERIC_RECOVERY_JOB_TYPES], limit],
  );
  return result.rows;
}

export async function lockSchema016StaleJob<T extends pg.QueryResultRow>(
  client: Pick<pg.PoolClient, "query">,
  candidate: StaleJobIdentity,
  lockTimeoutSeconds: number,
): Promise<T | null> {
  const result = await client.query<T>(
    `SELECT id, job_type, unique_key, payload, attempts
     FROM public.durable_jobs
     WHERE id = $1
       AND status = 'running'
       AND attempts = $2
       AND locked_at < now() - make_interval(secs => $3)
       AND job_type = $4
       AND job_type = ANY($5::text[])
     FOR UPDATE`,
    [
      candidate.id,
      candidate.attempts,
      lockTimeoutSeconds,
      candidate.job_type,
      [...SCHEMA_016_SUPPORTED_JOB_TYPES],
    ],
  );
  return result.rows[0] ?? null;
}

export type JobClaimAttempt<T> =
  | { readonly kind: "claimed"; readonly job: T | null }
  | { readonly kind: "failed"; readonly error: unknown };

export async function attemptJobClaim<T>(
  claim: () => Promise<T | null>,
): Promise<JobClaimAttempt<T>> {
  try {
    return { kind: "claimed", job: await claim() };
  } catch (error) {
    return { kind: "failed", error };
  }
}
