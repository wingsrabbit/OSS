// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { BillingCycle } from "@opensales/core";
import type { DatabaseClient } from "./database.js";
import {
  assessLateFeesAndScheduleSuspensions,
  scheduleResumeAfterRenewalSettlement,
  type RenewalResumeScheduleOutcome,
} from "./delinquency-lifecycle.js";

export type RenewalAutomationOutcome = {
  runId: string;
  businessDate: string;
  invoicesCreated: number;
  remindersCreated: number;
  lateFeesAssessed: number;
  lateFeeMinor: string;
  suspensionCasesCreated: number;
  delinquencyDeferralsCreated: number;
  replayed: boolean;
};

export type RenewalSettlementOutcome = {
  serviceId: string;
  renewalStatus: "paid" | "manual_hold";
  serviceStatus: string;
  resumeSchedule?: RenewalResumeScheduleOutcome;
};

type ReminderKind = "renewal_created" | "pre_due" | "overdue_first";

function historicalRecurringMinor(snapshot: unknown): bigint {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Service price snapshot is invalid");
  }
  const value = (snapshot as Record<string, unknown>).recurringSubtotalMinor;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error("Service price snapshot has no positive recurring amount");
  }
  return BigInt(value);
}

async function enqueueReminder(
  client: DatabaseClient,
  input: {
    invoiceId: string;
    serviceId: string;
    kind: ReminderKind;
    offsetDays: number;
    policySnapshot: Record<string, unknown>;
    email: string;
    locale: "en" | "zh-CN";
    currency: string;
    dueAt: Date;
    amountDueMinor: bigint;
  },
): Promise<boolean> {
  if (input.amountDueMinor <= 0n && input.kind !== "renewal_created") return false;
  const existing = await client.query(
    `SELECT id
     FROM renewal_reminder_intents
     WHERE invoice_id = $1 AND kind = $2`,
    [input.invoiceId, input.kind],
  );
  if (existing.rowCount) return false;

  const outboxResult = await client.query<{ id: string }>(
    `WITH inserted AS (
       INSERT INTO outbox(event_type, unique_key, payload)
       VALUES ('notification.renewal_reminder_requested', $1, $2)
       ON CONFLICT (event_type, unique_key) DO NOTHING
       RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL
     SELECT id
     FROM outbox
     WHERE event_type = 'notification.renewal_reminder_requested'
       AND unique_key = $1
     LIMIT 1`,
    [
      `renewal:${input.invoiceId}:${input.kind}`,
      {
        email: input.email,
        locale: input.locale,
        invoiceId: input.invoiceId,
        serviceId: input.serviceId,
        kind: input.kind,
        offsetDays: input.offsetDays,
        currency: input.currency,
        dueAt: input.dueAt.toISOString(),
        amountDueMinor: input.amountDueMinor.toString(),
      },
    ],
  );
  const outboxId = outboxResult.rows[0]?.id;
  if (!outboxId) throw new Error("Unable to create renewal reminder outbox event");
  const insertedIntent = await client.query(
    `INSERT INTO renewal_reminder_intents(
       invoice_id, service_id, kind, offset_days, policy_snapshot,
       email, locale, due_at, amount_due_minor, outbox_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (invoice_id, kind) DO NOTHING
     RETURNING id`,
    [
      input.invoiceId,
      input.serviceId,
      input.kind,
      input.offsetDays,
      input.policySnapshot,
      input.email,
      input.locale,
      input.dueAt,
      input.amountDueMinor.toString(),
      outboxId,
    ],
  );
  if (insertedIntent.rowCount !== 1) return false;
  await client.query(
    `INSERT INTO durable_jobs(job_type, unique_key, payload)
     VALUES ('notification.send', $1, $2)
     ON CONFLICT (job_type, unique_key) DO NOTHING`,
    [`outbox:${outboxId}`, { outboxId }],
  );
  return true;
}

export async function recordInitialServicePeriod(
  client: DatabaseClient,
  input: {
    serviceId: string;
    invoiceId: string;
    periodStart: Date;
    periodEnd: Date | null;
    grantedAt: Date;
  },
): Promise<void> {
  if (!input.periodEnd) return;
  await client.query(
    `INSERT INTO service_periods(
       service_id, invoice_id, period_kind, period_start, period_end, granted_at
     ) VALUES ($1, $2, 'initial', $3, $4, $5)
     ON CONFLICT (service_id, invoice_id) DO NOTHING`,
    [input.serviceId, input.invoiceId, input.periodStart, input.periodEnd, input.grantedAt],
  );
}

async function autoApplyRenewalCredit(
  client: DatabaseClient,
  input: {
    renewalId: string;
    invoiceId: string;
    serviceId: string;
    clientAccountId: string;
    currency: string;
    invoiceTotalMinor: bigint;
  },
): Promise<bigint> {
  const account = await client.query<{ restricted_at: Date | null }>(
    `SELECT restricted_at
     FROM client_accounts
     WHERE id = $1
     FOR UPDATE`,
    [input.clientAccountId],
  );
  if (!account.rows[0] || account.rows[0].restricted_at) return 0n;
  const creditAccount = await client.query<{ id: string }>(
    `SELECT id
     FROM credit_accounts
     WHERE client_account_id = $1 AND currency = $2
     FOR UPDATE`,
    [input.clientAccountId, input.currency],
  );
  const creditAccountId = creditAccount.rows[0]?.id;
  if (!creditAccountId) return 0n;
  const balanceResult = await client.query<{ balance_minor: string }>(
    `SELECT COALESCE(sum(credit_minor - debit_minor), 0)::text AS balance_minor
     FROM credit_transactions
     WHERE credit_account_id = $1`,
    [creditAccountId],
  );
  const balance = BigInt(balanceResult.rows[0]?.balance_minor ?? "0");
  const applied = balance < input.invoiceTotalMinor ? balance : input.invoiceTotalMinor;
  if (applied <= 0n) return 0n;

  const creditTransactionId = randomUUID();
  await client.query(
    `INSERT INTO credit_transactions(
       id, credit_account_id, kind, credit_minor, debit_minor,
       source_type, source_id, actor_type, actor_id, reason,
       idempotency_key, request_fingerprint
     ) VALUES (
       $1, $2, 'invoice_application', 0, $3,
       'service_renewal', $4, 'system', NULL,
       'Credit automatically applied to renewal invoice', $5, $6
     )`,
    [
      creditTransactionId,
      creditAccountId,
      applied.toString(),
      input.renewalId,
      `renewal-auto-credit:${input.renewalId}`,
      `renewal-auto-credit-v1:${input.renewalId}:${applied.toString()}`,
    ],
  );
  await client.query(
    `INSERT INTO credit_allocations(credit_transaction_id, invoice_id, amount_minor)
     VALUES ($1, $2, $3)`,
    [creditTransactionId, input.invoiceId, applied.toString()],
  );
  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('invoice_credit_application', $1, $2, 'Credit automatically applied to renewal')
     RETURNING id`,
    [creditTransactionId, input.currency],
  );
  const journalId = journal.rows[0]?.id;
  if (!journalId) throw new Error("Unable to create renewal Credit journal");
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'client_credit_liability', $2, 0),
       ($1, 'accounts_receivable', 0, $2)`,
    [journalId, applied.toString()],
  );

  if (applied === input.invoiceTotalMinor) {
    const grantedAt = new Date();
    await client.query(
      `INSERT INTO service_periods(
         service_id, invoice_id, period_kind, period_start, period_end, granted_at
       )
       SELECT $1, $2, 'renewal', renewal.period_start, renewal.period_end, $3
       FROM service_renewals renewal
       WHERE renewal.id = $4`,
      [input.serviceId, input.invoiceId, grantedAt, input.renewalId],
    );
    const advanced = await client.query(
      `UPDATE services service
       SET term_end = renewal.period_end, updated_at = now(), version = service.version + 1
       FROM service_renewals renewal
       WHERE service.id = $1
         AND renewal.id = $2
         AND service.status = 'active'
         AND service.term_end = renewal.period_start
       RETURNING service.id`,
      [input.serviceId, input.renewalId],
    );
    if (advanced.rowCount !== 1) {
      throw new Error("Service term changed while applying renewal Credit");
    }
    await client.query(
      `UPDATE service_renewals
       SET status = 'paid', funded_at = $2, settled_at = $2,
           updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'invoiced'`,
      [input.renewalId, grantedAt],
    );
    await client.query(
      `INSERT INTO outbox(event_type, unique_key, payload)
       VALUES ('invoice.paid', $1, $2)
       ON CONFLICT (event_type, unique_key) DO NOTHING`,
      [
        `invoice:${input.invoiceId}`,
        { invoiceId: input.invoiceId, serviceId: input.serviceId, renewal: true },
      ],
    );
  }
  return applied;
}

export async function runRenewalAutomation(
  client: DatabaseClient,
  input: {
    requestedByUserId: string | null;
    reason: string;
    idempotencyKey?: string;
    requestFingerprint?: string;
    scheduledBusinessDate?: string;
    effectiveAt: Date;
  },
): Promise<RenewalAutomationOutcome> {
  const isScheduled = input.requestedByUserId === null;
  if (!isScheduled && (!input.idempotencyKey || !input.requestFingerprint)) {
    throw new Error("Staff billing automation requires an idempotency key and fingerprint");
  }
  const staffIdempotencyKey = isScheduled ? null : input.idempotencyKey!;
  const staffRequestFingerprint = isScheduled ? null : input.requestFingerprint!;
  if (!isScheduled) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `billing-automation-request:${input.requestedByUserId}:${staffIdempotencyKey}`,
    ]);
  }
  const requestReplayResult = await client.query<{
    request_fingerprint: string;
    run_id: string;
    business_date: string;
    invoices_created: number;
    reminders_created: number;
    late_fees_assessed: number;
    late_fee_minor: string;
    suspension_cases_created: number;
    delinquency_deferrals_created: number;
  }>(
    `SELECT request.request_fingerprint, run.id AS run_id,
            run.business_date::text, run.invoices_created, run.reminders_created,
            run.late_fees_assessed, run.late_fee_minor::text,
            run.suspension_cases_created, run.delinquency_deferrals_created
     FROM billing_automation_run_requests request
     JOIN billing_automation_runs run ON run.id = request.run_id
     WHERE request.requested_by_user_id = $1 AND request.idempotency_key = $2
     FOR UPDATE OF request, run`,
    [input.requestedByUserId, staffIdempotencyKey],
  );
  const requestReplay = requestReplayResult.rows[0];
  if (!isScheduled && requestReplay) {
    if (requestReplay.request_fingerprint !== staffRequestFingerprint) {
      throw Object.assign(new Error("The idempotency key was used for a different automation run"), {
        statusCode: 409,
        code: "IDEMPOTENCY_CONFLICT",
      });
    }
    return {
      runId: requestReplay.run_id,
      businessDate: requestReplay.business_date,
      invoicesCreated: requestReplay.invoices_created,
      remindersCreated: requestReplay.reminders_created,
      lateFeesAssessed: requestReplay.late_fees_assessed,
      lateFeeMinor: requestReplay.late_fee_minor,
      suspensionCasesCreated: requestReplay.suspension_cases_created,
      delinquencyDeferralsCreated: requestReplay.delinquency_deferrals_created,
      replayed: true,
    };
  }

  const policyResult = await client.query<{
    id: string;
    enabled: boolean;
    timezone: string;
    renewal_lead_days: number;
    pre_due_reminder_days: number;
    overdue_reminder_days: number;
    late_fee_enabled: boolean;
    late_fee_days: number;
    late_fee_basis_points: number;
    overdue_suspension_enabled: boolean;
    overdue_suspension_days: number;
    run_local_time: string;
    business_date: string;
    scheduled_time_reached: boolean;
  }>(
    `SELECT id, enabled, timezone, renewal_lead_days,
            pre_due_reminder_days, overdue_reminder_days,
            late_fee_enabled, late_fee_days, late_fee_basis_points,
            overdue_suspension_enabled, overdue_suspension_days,
            run_local_time::text,
            ($1::timestamptz AT TIME ZONE timezone)::date::text AS business_date,
            (($1::timestamptz AT TIME ZONE timezone)::time >= run_local_time)
              AS scheduled_time_reached
     FROM billing_automation_policies
     WHERE id = 'default'
     FOR UPDATE`,
    [input.effectiveAt],
  );
  const policy = policyResult.rows[0];
  if (!policy) throw new Error("Billing automation policy is unavailable");
  if (!policy.enabled) {
    throw Object.assign(new Error("Billing automation is paused"), {
      statusCode: 409,
      code: "AUTOMATION_PAUSED",
    });
  }
  if (isScheduled) {
    if (!input.scheduledBusinessDate || input.scheduledBusinessDate !== policy.business_date) {
      throw Object.assign(
        new Error("Scheduled billing business date does not match the signed effective time"),
        { statusCode: 409, code: "SCHEDULED_DATE_CONFLICT" },
      );
    }
    if (!policy.scheduled_time_reached) {
      throw Object.assign(
        new Error(
          `Scheduled billing is not due before ${policy.run_local_time} in ${policy.timezone}`,
        ),
        { statusCode: 409, code: "SCHEDULE_NOT_DUE" },
      );
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `billing-automation-scheduled:${policy.id}:${policy.business_date}`,
    ]);
  }

  const businessReplayResult = await client.query<{
    id: string;
    invoices_created: number;
    reminders_created: number;
    late_fees_assessed: number;
    late_fee_minor: string;
    suspension_cases_created: number;
    delinquency_deferrals_created: number;
  }>(
    `SELECT id, invoices_created, reminders_created,
            late_fees_assessed, late_fee_minor::text, suspension_cases_created,
            delinquency_deferrals_created
     FROM billing_automation_runs
     WHERE policy_id = $1 AND business_date = $2::date
     FOR UPDATE`,
    [policy.id, policy.business_date],
  );
  const businessReplay = businessReplayResult.rows[0];
  if (businessReplay) {
    if (!isScheduled) {
      await client.query(
        `INSERT INTO billing_automation_run_requests(
           requested_by_user_id, idempotency_key, request_fingerprint, run_id
         ) VALUES ($1, $2, $3, $4)`,
        [
          input.requestedByUserId,
          staffIdempotencyKey,
          staffRequestFingerprint,
          businessReplay.id,
        ],
      );
    }
    return {
      runId: businessReplay.id,
      businessDate: policy.business_date,
      invoicesCreated: businessReplay.invoices_created,
      remindersCreated: businessReplay.reminders_created,
      lateFeesAssessed: businessReplay.late_fees_assessed,
      lateFeeMinor: businessReplay.late_fee_minor,
      suspensionCasesCreated: businessReplay.suspension_cases_created,
      delinquencyDeferralsCreated: businessReplay.delinquency_deferrals_created,
      replayed: true,
    };
  }

  const runResult = await client.query<{ id: string }>(
    `INSERT INTO billing_automation_runs(
       policy_id, business_date, effective_at, requested_by_user_id, trigger_kind, reason
     ) VALUES ($1, $2::date, $3, $4, $5, $6)
     RETURNING id`,
    [
      policy.id,
      policy.business_date,
      input.effectiveAt,
      input.requestedByUserId,
      isScheduled ? "scheduled" : "staff",
      input.reason,
    ],
  );
  const runId = runResult.rows[0]?.id;
  if (!runId) throw new Error("Unable to record billing automation run");
  if (!isScheduled) {
    await client.query(
      `INSERT INTO billing_automation_run_requests(
         requested_by_user_id, idempotency_key, request_fingerprint, run_id
       ) VALUES ($1, $2, $3, $4)`,
      [input.requestedByUserId, staffIdempotencyKey, staffRequestFingerprint, runId],
    );
  }

  const candidates = await client.query<{
    service_id: string;
    client_account_id: string;
    billing_cycle: BillingCycle;
    term_end: Date;
    order_item_id: string;
    product_name: string;
    price_snapshot: unknown;
    currency: string;
    email: string;
    locale: "en" | "zh-CN";
  }>(
    `SELECT
       service.id AS service_id,
       service.client_account_id,
       service.billing_cycle,
       service.term_end,
       item.id AS order_item_id,
       item.product_name,
       item.price_snapshot,
       original_order.currency,
       owner.email,
       owner.locale
     FROM services service
     JOIN order_items item ON item.id = service.order_item_id
     JOIN orders original_order ON original_order.id = item.order_id
     JOIN client_accounts account ON account.id = service.client_account_id
     JOIN users owner ON owner.id = account.owner_user_id
     WHERE service.status = 'active'
       AND service.cancellation_request_id IS NULL
       AND service.billing_cycle <> 'one_time'
       AND service.term_end IS NOT NULL
       AND (service.term_end AT TIME ZONE $3)::date
             <= ($1::timestamptz AT TIME ZONE $3)::date + $2::integer
       AND NOT EXISTS (
         SELECT 1
         FROM service_renewals existing
         WHERE existing.service_id = service.id
           AND existing.status IN ('invoiced', 'manual_hold')
       )
     ORDER BY service.id
     FOR UPDATE OF service`,
    [input.effectiveAt, policy.renewal_lead_days, policy.timezone],
  );

  let invoicesCreated = 0;
  let remindersCreated = 0;
  for (const candidate of candidates.rows) {
    const recurringMinor = historicalRecurringMinor(candidate.price_snapshot);
    const invoiceResult = await client.query<{ id: string }>(
      `INSERT INTO invoices(client_account_id, order_id, currency, total_minor, due_at)
       VALUES (
         $1, NULL, $2, $3,
         (SELECT term_end FROM services WHERE id = $4)
       )
       RETURNING id`,
      [
        candidate.client_account_id,
        candidate.currency,
        recurringMinor.toString(),
        candidate.service_id,
      ],
    );
    const invoiceId = invoiceResult.rows[0]?.id;
    if (!invoiceId) throw new Error("Unable to create renewal invoice");
    await client.query(
      `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
       VALUES ($1, 'recurring', $2, $3)`,
      [
        invoiceId,
        `${candidate.product_name} ${candidate.billing_cycle} renewal`,
        recurringMinor.toString(),
      ],
    );
    const journalResult = await client.query<{ id: string }>(
      `INSERT INTO ledger_journals(source_type, source_id, currency, description)
       VALUES ('invoice_issuance', $1, $2, 'Renewal invoice issued')
       RETURNING id`,
      [invoiceId, candidate.currency],
    );
    const journalId = journalResult.rows[0]?.id;
    if (!journalId) throw new Error("Unable to create renewal invoice journal");
    await client.query(
      `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'accounts_receivable', $2, 0),
         ($1, 'deferred_service_revenue', 0, $2)`,
      [journalId, recurringMinor.toString()],
    );
    const renewalResult = await client.query<{ id: string }>(
      `INSERT INTO service_renewals(
         service_id, invoice_id, automation_run_id, period_start, period_end,
         recurring_minor, currency, price_snapshot
       )
       SELECT
         $1, $2, $3, service.term_end,
         (
           (service.term_end AT TIME ZONE 'UTC')
           + CASE service.billing_cycle
               WHEN 'monthly' THEN interval '1 month'
               WHEN 'quarterly' THEN interval '3 months'
               WHEN 'semiannual' THEN interval '6 months'
               WHEN 'annual' THEN interval '12 months'
               ELSE interval '0 months'
             END
         ) AT TIME ZONE 'UTC',
         $4, $5, $6
       FROM services service
       WHERE service.id = $1
       RETURNING id`,
      [
        candidate.service_id,
        invoiceId,
        runId,
        recurringMinor.toString(),
        candidate.currency,
        candidate.price_snapshot,
      ],
    );
    const renewalId = renewalResult.rows[0]?.id;
    if (!renewalId) throw new Error("Unable to create service renewal");
    const creditApplied = await autoApplyRenewalCredit(client, {
      renewalId,
      invoiceId,
      serviceId: candidate.service_id,
      clientAccountId: candidate.client_account_id,
      currency: candidate.currency,
      invoiceTotalMinor: recurringMinor,
    });
    invoicesCreated += 1;
    if (
      await enqueueReminder(client, {
        invoiceId,
        serviceId: candidate.service_id,
        kind: "renewal_created",
        offsetDays: 0,
        policySnapshot: {
          policyId: policy.id,
          timezone: policy.timezone,
          renewalLeadDays: policy.renewal_lead_days,
        },
        email: candidate.email,
        locale: candidate.locale,
        currency: candidate.currency,
        dueAt: candidate.term_end,
        amountDueMinor: recurringMinor - creditApplied,
      })
    ) {
      remindersCreated += 1;
    }
  }

  const delinquency = await assessLateFeesAndScheduleSuspensions(client, {
    runId,
    policy: {
      policyId: policy.id,
      timezone: policy.timezone,
      businessDate: policy.business_date,
      effectiveAt: input.effectiveAt,
      lateFeeEnabled: policy.late_fee_enabled,
      lateFeeDays: policy.late_fee_days,
      lateFeeBasisPoints: policy.late_fee_basis_points,
      overdueSuspensionEnabled: policy.overdue_suspension_enabled,
      overdueSuspensionDays: policy.overdue_suspension_days,
    },
  });

  const reminderCandidates = await client.query<{
    invoice_id: string;
    service_id: string;
    due_at: Date;
    total_minor: string;
    allocated_minor: string;
    email: string;
    locale: "en" | "zh-CN";
    currency: string;
    pre_due_reached: boolean;
    overdue_reached: boolean;
    before_due: boolean;
  }>(
    `SELECT
       renewal.invoice_id,
       renewal.service_id,
       invoice.due_at,
       invoice.total_minor::text,
       allocation.allocated_minor::text,
       owner.email,
       owner.locale,
       invoice.currency,
       (($1::timestamptz AT TIME ZONE $2)::date >=
         (invoice.due_at AT TIME ZONE $2)::date - $3::integer) AS pre_due_reached,
       (($1::timestamptz AT TIME ZONE $2)::date >=
         (invoice.due_at AT TIME ZONE $2)::date + $4::integer) AS overdue_reached,
       (($1::timestamptz AT TIME ZONE $2)::date <
         (invoice.due_at AT TIME ZONE $2)::date) AS before_due
     FROM service_renewals renewal
     JOIN invoices invoice ON invoice.id = renewal.invoice_id
     JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
     JOIN services service ON service.id = renewal.service_id
     JOIN client_accounts account ON account.id = service.client_account_id
     JOIN users owner ON owner.id = account.owner_user_id
     WHERE renewal.status IN ('invoiced', 'manual_hold')
       AND renewal.automation_run_id <> $5
       AND allocation.allocated_minor < invoice.total_minor
     ORDER BY renewal.invoice_id`,
    [
      input.effectiveAt,
      policy.timezone,
      policy.pre_due_reminder_days,
      policy.overdue_reminder_days,
      runId,
    ],
  );
  for (const candidate of reminderCandidates.rows) {
    const amountDue = BigInt(candidate.total_minor) - BigInt(candidate.allocated_minor);
    let kind: ReminderKind | null = null;
    let offsetDays = 0;
    if (candidate.overdue_reached) {
      kind = "overdue_first";
      offsetDays = policy.overdue_reminder_days;
    } else if (candidate.pre_due_reached && candidate.before_due) {
      kind = "pre_due";
      offsetDays = policy.pre_due_reminder_days;
    }
    if (
      kind &&
      (await enqueueReminder(client, {
        invoiceId: candidate.invoice_id,
        serviceId: candidate.service_id,
        kind,
        offsetDays,
        policySnapshot: {
          policyId: policy.id,
          timezone: policy.timezone,
          offsetDays,
        },
        email: candidate.email,
        locale: candidate.locale,
        currency: candidate.currency,
        dueAt: candidate.due_at,
        amountDueMinor: amountDue,
      }))
    ) {
      remindersCreated += 1;
    }
  }

  await client.query(
    `UPDATE billing_automation_runs
     SET invoices_created = $2, reminders_created = $3,
         late_fees_assessed = $4, late_fee_minor = $5,
         suspension_cases_created = $6, delinquency_deferrals_created = $7,
         completed_at = now()
     WHERE id = $1`,
    [
      runId,
      invoicesCreated,
      remindersCreated,
      delinquency.lateFeesAssessed,
      delinquency.lateFeeMinor.toString(),
      delinquency.suspensionCasesCreated,
      delinquency.delinquencyDeferralsCreated,
    ],
  );
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES ($1, $2, 'billing.automation_run', 'billing_automation_run', $3, $4, $5)`,
    [
      isScheduled ? "system" : "staff",
      input.requestedByUserId ?? "billing-worker",
      runId,
      input.reason,
      {
        businessDate: policy.business_date,
        effectiveAt: input.effectiveAt.toISOString(),
        timezone: policy.timezone,
        invoicesCreated,
        remindersCreated,
        lateFeesAssessed: delinquency.lateFeesAssessed,
        lateFeeMinor: delinquency.lateFeeMinor.toString(),
        suspensionCasesCreated: delinquency.suspensionCasesCreated,
        delinquencyDeferralsCreated: delinquency.delinquencyDeferralsCreated,
      },
    ],
  );
  return {
    runId,
    businessDate: policy.business_date,
    invoicesCreated,
    remindersCreated,
    lateFeesAssessed: delinquency.lateFeesAssessed,
    lateFeeMinor: delinquency.lateFeeMinor.toString(),
    suspensionCasesCreated: delinquency.suspensionCasesCreated,
    delinquencyDeferralsCreated: delinquency.delinquencyDeferralsCreated,
    replayed: false,
  };
}

export async function settleRenewalInvoice(
  client: DatabaseClient,
  invoiceId: string,
  context?:
    | { kind: "user_command"; userId: string }
    | {
        kind: "staff_manual";
        staffUserId: string;
        reason?: string;
      }
    | {
        kind: "staff_hold_resolution";
        staffUserId: string;
        expectedRenewalVersion: number;
        reason: string;
      },
): Promise<RenewalSettlementOutcome | null> {
  const pointerResult = await client.query<{
    renewal_id: string;
    service_id: string;
    order_id: string;
    client_account_id: string;
  }>(
    `SELECT renewal.id AS renewal_id, service.id AS service_id,
            original_order.id AS order_id,
            service.client_account_id
     FROM service_renewals renewal
     JOIN services service ON service.id = renewal.service_id
     JOIN order_items item ON item.id = service.order_item_id
     JOIN orders original_order ON original_order.id = item.order_id
     WHERE renewal.invoice_id = $1`,
    [invoiceId],
  );
  const pointer = pointerResult.rows[0];
  if (!pointer) return null;

  await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [pointer.order_id]);
  await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [pointer.service_id]);
  const commandUserId = context?.kind === "user_command" ? context.userId : null;
  if (commandUserId) {
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
      commandUserId,
    ]);
  }
  await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
    pointer.client_account_id,
  ]);
  if (commandUserId) {
    await client.query(
      `SELECT client_account_id
       FROM client_memberships
       WHERE client_account_id = $1 AND user_id = $2
       FOR UPDATE`,
      [pointer.client_account_id, commandUserId],
    );
  }
  await client.query("SELECT id FROM service_renewals WHERE id = $1 FOR UPDATE", [
    pointer.renewal_id,
  ]);
  await client.query(
    `SELECT id
     FROM service_suspension_cases
     WHERE service_renewal_id = $1
     FOR UPDATE`,
    [pointer.renewal_id],
  );

  const renewalResult = await client.query<{
    id: string;
    status: "invoiced" | "paid" | "manual_hold";
    service_id: string;
    invoice_client_account_id: string;
    service_client_account_id: string;
    service_status: string;
    current_term_end: Date | null;
    period_start: Date;
    period_end: Date;
    email_verified_at: Date | null;
    user_restricted_at: Date | null;
    account_restricted_at: Date | null;
    removed_at: Date | null;
    membership_client_account_id: string | null;
    membership_role: "owner" | "billing" | "technical" | "viewer" | null;
    suspension_case_status: string | null;
    version: number;
  }>(
    `SELECT
       renewal.id,
       renewal.status,
       renewal.service_id,
       invoice.client_account_id AS invoice_client_account_id,
       service.client_account_id AS service_client_account_id,
       service.status AS service_status,
       service.term_end AS current_term_end,
       renewal.period_start,
       renewal.period_end,
       customer.email_verified_at,
       customer.restricted_at AS user_restricted_at,
       account.restricted_at AS account_restricted_at,
       membership.removed_at,
       membership.client_account_id AS membership_client_account_id,
       membership.role AS membership_role,
       suspension_case.status AS suspension_case_status,
       renewal.version
     FROM service_renewals renewal
     JOIN invoices invoice ON invoice.id = renewal.invoice_id
     JOIN services service ON service.id = renewal.service_id
     JOIN order_items item ON item.id = service.order_item_id
     JOIN orders original_order ON original_order.id = item.order_id
     JOIN client_accounts account ON account.id = service.client_account_id
     LEFT JOIN users customer ON customer.id = $2
     LEFT JOIN client_memberships membership
       ON membership.client_account_id = service.client_account_id
      AND membership.user_id = customer.id
     LEFT JOIN service_suspension_cases suspension_case
       ON suspension_case.service_renewal_id = renewal.id
     WHERE renewal.id = $1`,
    [pointer.renewal_id, commandUserId],
  );
  const renewal = renewalResult.rows[0];
  if (!renewal) throw new Error("Renewal invoice points to an invalid service");
  if (
    renewal.invoice_client_account_id !== renewal.service_client_account_id ||
    renewal.service_client_account_id !== pointer.client_account_id
  ) {
    throw new Error("Renewal invoice ownership is inconsistent");
  }
  if (
    context?.kind === "staff_hold_resolution" &&
    renewal.version !== context.expectedRenewalVersion
  ) {
    throw Object.assign(new Error("Renewal changed; refresh and confirm the hold again"), {
      statusCode: 409,
      code: "VERSION_CONFLICT",
    });
  }
  if (renewal.status === "paid") {
    return {
      serviceId: renewal.service_id,
      renewalStatus: "paid",
      serviceStatus: renewal.service_status,
    };
  }
  const authorizedHoldResolution =
    renewal.status === "manual_hold" &&
    context?.kind === "staff_hold_resolution";
  if (renewal.status === "manual_hold" && !authorizedHoldResolution) {
    return {
      serviceId: renewal.service_id,
      renewalStatus: "manual_hold",
      serviceStatus: renewal.service_status,
    };
  }

  await client.query(
    `INSERT INTO outbox(event_type, unique_key, payload)
     VALUES ('invoice.paid', $1, $2)
     ON CONFLICT (event_type, unique_key) DO NOTHING`,
    [`invoice:${invoiceId}`, { invoiceId, serviceId: renewal.service_id, renewal: true }],
  );
  const delinquencySuspended =
    renewal.service_status === "suspended" &&
    ["suspended", "resume_queued", "resume_processing", "resume_unknown"].includes(
      renewal.suspension_case_status ?? "",
    );
  const accountAndServiceEligible =
    !renewal.account_restricted_at &&
    (renewal.service_status === "active" || delinquencySuspended);
  const userCommandEligible =
    context?.kind === "user_command" &&
    Boolean(renewal.membership_client_account_id) &&
    Boolean(renewal.email_verified_at) &&
    !renewal.user_restricted_at &&
    !renewal.removed_at &&
    (renewal.membership_role === "owner" || renewal.membership_role === "billing");
  const eligible =
    accountAndServiceEligible &&
    (context?.kind === "staff_manual" ||
      context?.kind === "staff_hold_resolution" ||
      userCommandEligible);
  const fundedAt = new Date();
  if (!eligible) {
    await client.query(
      `UPDATE service_renewals
       SET status = 'manual_hold', funded_at = COALESCE(funded_at, $2),
           updated_at = now(), version = version + 1
       WHERE id = $1 AND status <> 'paid'`,
      [renewal.id, fundedAt],
    );
    await client.query(
      `INSERT INTO audit_events(
         actor_type, actor_id, action, target_type, target_id, reason, metadata
       ) VALUES ('system', 'core', 'billing.renewal_payment_held', 'service_renewal', $1, $2, $3)`,
      [
        renewal.id,
        "renewal funds settled after customer or service eligibility changed",
        {
          invoiceId,
          serviceId: renewal.service_id,
          serviceStatus: renewal.service_status,
          settlementContext: context?.kind ?? "missing",
        },
      ],
    );
    return {
      serviceId: renewal.service_id,
      renewalStatus: "manual_hold",
      serviceStatus: renewal.service_status,
    };
  }

  if (
    !renewal.current_term_end ||
    renewal.current_term_end.getTime() !== renewal.period_start.getTime()
  ) {
    await client.query(
      `UPDATE service_renewals
       SET status = 'manual_hold', funded_at = COALESCE(funded_at, $2),
           updated_at = now(), version = version + 1
       WHERE id = $1 AND status <> 'paid'`,
      [renewal.id, fundedAt],
    );
    await client.query(
      `INSERT INTO audit_events(
         actor_type, actor_id, action, target_type, target_id, reason, metadata
       ) VALUES ('system', 'core', 'billing.renewal_period_conflict', 'service_renewal', $1, $2, $3)`,
      [
        renewal.id,
        "service term changed before renewal settlement; manual reconciliation is required",
        {
          invoiceId,
          serviceId: renewal.service_id,
          currentTermEnd: renewal.current_term_end?.toISOString() ?? null,
          expectedTermEnd: renewal.period_start.toISOString(),
        },
      ],
    );
    return {
      serviceId: renewal.service_id,
      renewalStatus: "manual_hold",
      serviceStatus: renewal.service_status,
    };
  }

  const settledAt = new Date();
  await client.query(
    `INSERT INTO service_periods(
       service_id, invoice_id, period_kind, period_start, period_end, granted_at
     )
     SELECT renewal.service_id, $2, 'renewal',
            renewal.period_start, renewal.period_end, $3
     FROM service_renewals renewal
     WHERE renewal.id = $1`,
    [renewal.id, invoiceId, settledAt],
  );
  const advanced = await client.query(
    `UPDATE services service
     SET term_end = renewal.period_end, updated_at = now(), version = service.version + 1
     FROM service_renewals renewal
     WHERE service.id = $1
       AND renewal.id = $2
       AND service.status IN ('active', 'suspended')
       AND service.term_end = renewal.period_start
     RETURNING service.id`,
    [renewal.service_id, renewal.id],
  );
  if (advanced.rowCount !== 1) {
    throw new Error("Service term changed while settling renewal");
  }
  await client.query(
    `UPDATE service_renewals
     SET status = 'paid', funded_at = COALESCE(funded_at, $2), settled_at = $2,
         updated_at = now(), version = version + 1
     WHERE id = $1 AND status <> 'paid'`,
    [renewal.id, settledAt],
  );
  const resumeSchedule = await scheduleResumeAfterRenewalSettlement(client, {
    renewalId: renewal.id,
    serviceId: renewal.service_id,
  });
  if (context?.kind === "staff_manual" || context?.kind === "staff_hold_resolution") {
    await client.query(
      `INSERT INTO audit_events(
         actor_type, actor_id, action, target_type, target_id, reason, metadata
       ) VALUES ('staff', $1, 'billing.renewal_staff_manual_grant', 'service_renewal', $2, $3, $4)`,
      [
        context.staffUserId,
        renewal.id,
        context.reason ?? "authorized staff allocation completed the renewal invoice",
        { invoiceId, serviceId: renewal.service_id, periodEnd: renewal.period_end.toISOString() },
      ],
    );
  }
  return {
    serviceId: renewal.service_id,
    renewalStatus: "paid",
    serviceStatus: renewal.service_status,
    resumeSchedule,
  };
}
