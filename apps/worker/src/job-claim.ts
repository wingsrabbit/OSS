// SPDX-License-Identifier: AGPL-3.0-or-later

import type pg from "pg";

export const SCHEMA_016_SUPPORTED_JOB_TYPES = Object.freeze([
  "billing.automation.scheduled",
  "notification.send",
  "refund.start",
  "refund.reconcile",
  "payment.start",
  "payment.reconcile",
  "add_funds.start",
  "add_funds.reconcile",
  "provision.start",
  "provision.reconcile",
  "service.suspend.start",
  "service.suspend.reconcile",
  "service.resume.start",
  "service.resume.reconcile",
  "service.cancellation.due",
  "service.cancellation.reconcile",
] as const);

export type Schema016SupportedJobType =
  (typeof SCHEMA_016_SUPPORTED_JOB_TYPES)[number];

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
