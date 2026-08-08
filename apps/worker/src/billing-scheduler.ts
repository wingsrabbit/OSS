// SPDX-License-Identifier: AGPL-3.0-or-later

type BillingSchedulerDatabase = {
  query: (text: string) => Promise<{ rowCount: number | null }>;
};

export const SCHEDULE_BILLING_JOB_SQL = `WITH policy_clock AS (
   SELECT
     policy.id,
     policy.timezone,
     policy.run_local_time,
     (now() AT TIME ZONE policy.timezone)::date AS local_date,
     (now() AT TIME ZONE policy.timezone)::time AS local_time
   FROM billing_automation_policies policy
   WHERE policy.enabled
   FOR UPDATE OF policy SKIP LOCKED
 ), due_policy AS (
   SELECT
     policy_clock.id,
     policy_clock.timezone,
     policy_clock.run_local_time,
     CASE
       WHEN policy_clock.local_time >= policy_clock.run_local_time
         THEN policy_clock.local_date
       ELSE policy_clock.local_date - 1
     END AS business_date
   FROM policy_clock
 ), missing_policy AS (
   SELECT
     due_policy.id,
     due_policy.business_date::text AS business_date,
     ((due_policy.business_date + due_policy.run_local_time)
       AT TIME ZONE due_policy.timezone) AS effective_at
   FROM due_policy
   WHERE NOT EXISTS (
       SELECT 1
       FROM billing_automation_runs run
       WHERE run.policy_id = due_policy.id
         AND run.business_date = due_policy.business_date
     )
 )
 INSERT INTO durable_jobs(job_type, unique_key, payload)
 SELECT
   'billing.automation.scheduled',
   'billing-automation:' || missing_policy.id || ':' || missing_policy.business_date,
   jsonb_build_object(
     'policyId', missing_policy.id,
     'businessDate', missing_policy.business_date,
     'effectiveAt', to_char(missing_policy.effective_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   )
 FROM missing_policy
 ON CONFLICT (job_type, unique_key) DO NOTHING
 RETURNING id`;

export async function ensureScheduledBillingJob(
  database: BillingSchedulerDatabase,
): Promise<number> {
  const result = await database.query(SCHEDULE_BILLING_JOB_SQL);
  return result.rowCount ?? 0;
}
