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
     RETURNING job.id, job.job_type, job.unique_key, job.payload,
               job.payload::text AS payload_snapshot,
               job.attempts,
               EXTRACT(epoch FROM job.locked_at)::numeric::text AS locked_at_epoch,
               job.locked_by`,
    [workerId, [...SCHEMA_016_SUPPORTED_JOB_TYPES]],
  );
  return result.rows[0] ?? null;
}

export type StaleJobIdentity = {
  readonly id: string;
  readonly job_type: string;
  readonly unique_key: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payload_snapshot: string;
  readonly attempts: number;
  readonly locked_at_epoch: string;
  readonly locked_by: string | null;
};

export async function findSchema016GenericRecoveryCandidates<
  T extends pg.QueryResultRow,
>(
  pool: Pick<pg.Pool, "query">,
  lockTimeoutSeconds: number,
  limit = 50,
): Promise<T[]> {
  const result = await pool.query<T>(
    `SELECT id, job_type, unique_key, payload,
            payload::text AS payload_snapshot,
            attempts,
            EXTRACT(epoch FROM locked_at)::numeric::text AS locked_at_epoch,
            locked_by
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
    `SELECT id, job_type, unique_key, payload,
            payload::text AS payload_snapshot,
            attempts,
            EXTRACT(epoch FROM locked_at)::numeric::text AS locked_at_epoch,
            locked_by
     FROM public.durable_jobs
     WHERE id = $1
       AND status = 'running'
       AND attempts = $2
       AND locked_at < now() - make_interval(secs => $3)
       AND job_type = $4
       AND unique_key = $5
       AND payload::text = $6
       AND EXTRACT(epoch FROM locked_at)::numeric::text = $7
       AND locked_by IS NOT DISTINCT FROM $8
       AND job_type = ANY($9::text[])
     FOR UPDATE`,
    [
      candidate.id,
      candidate.attempts,
      lockTimeoutSeconds,
      candidate.job_type,
      candidate.unique_key,
      candidate.payload_snapshot,
      candidate.locked_at_epoch,
      candidate.locked_by,
      [...SCHEMA_016_SUPPORTED_JOB_TYPES],
    ],
  );
  return result.rows[0] ?? null;
}

export async function lockSchema016ActiveJob<T extends pg.QueryResultRow>(
  client: Pick<pg.PoolClient, "query">,
  job: StaleJobIdentity,
): Promise<T | null> {
  const result = await client.query<T>(
    `SELECT id, job_type, unique_key, payload,
            payload::text AS payload_snapshot,
            attempts,
            EXTRACT(epoch FROM locked_at)::numeric::text AS locked_at_epoch,
            locked_by
     FROM public.durable_jobs
     WHERE id = $1
       AND status = 'running'
       AND attempts = $2
       AND job_type = $3
       AND unique_key = $4
       AND payload::text = $5
       AND EXTRACT(epoch FROM locked_at)::numeric::text = $6
       AND locked_by IS NOT DISTINCT FROM $7
       AND job_type = ANY($8::text[])
     FOR UPDATE`,
    [
      job.id,
      job.attempts,
      job.job_type,
      job.unique_key,
      job.payload_snapshot,
      job.locked_at_epoch,
      job.locked_by,
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
