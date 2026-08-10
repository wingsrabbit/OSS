// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  hasCustomerMembershipCapability,
  percentageFeeMinor,
  type BillingCycle,
  type CustomerMembershipRole,
} from "@opensales/core";
import type { DatabaseClient } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import {
  enqueueNotification,
  enqueueSubscribedContactNotifications,
} from "./notification-outbox.js";
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
    clientAccountId: string;
    recipientUserId: string;
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

  const eventType = "notification.renewal_reminder_requested";
  const templateRevision = `renewal-${input.kind.replaceAll("_", "-")}-v1`;
  const uniqueKey = `renewal:${input.invoiceId}:${input.kind}`;
  const notificationPayload = {
    invoiceId: input.invoiceId,
    serviceId: input.serviceId,
    kind: input.kind,
    offsetDays: input.offsetDays,
    currency: input.currency,
    dueAt: input.dueAt.toISOString(),
    amountDueMinor: input.amountDueMinor.toString(),
  } as const;
  const ownerNotification = await enqueueNotification(client, {
    eventType,
    templateRevision,
    uniqueKey,
    payload: notificationPayload,
    recipient: {
      kind: "account_user",
      category: "billing",
      userId: input.recipientUserId,
      clientAccountId: input.clientAccountId,
      email: input.email,
      locale: input.locale,
    },
  });
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
      ownerNotification.outboxId,
    ],
  );
  if (insertedIntent.rowCount !== 1) return false;
  await enqueueSubscribedContactNotifications(client, {
    eventType,
    templateRevision,
    uniqueKeyPrefix: uniqueKey,
    payload: notificationPayload,
    clientAccountId: input.clientAccountId,
    category: "billing",
    ...(ownerNotification.status === "queued" ? { excludeEmails: [input.email] } : {}),
  });
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

async function startAuthorizedAutomaticRenewalPayment(
  client: DatabaseClient,
  input: {
    renewalId: string;
    invoiceId: string;
    serviceId: string;
    clientAccountId: string;
    currency: string;
    invoiceTotalMinor: bigint;
    creditAppliedMinor: bigint;
  },
): Promise<string | null> {
  const principalMinor = input.invoiceTotalMinor - input.creditAppliedMinor;
  if (principalMinor <= 0n) return null;
  const authorizationResult = await client.query<{
    authorization_id: string;
    saved_payment_method_id: string;
    payment_method_code: string;
    provider_installation_id: string;
    fee_basis_points: number;
  }>(
    `SELECT renewal_authorization.id AS authorization_id,
            saved.id AS saved_payment_method_id,
            saved.payment_method_code,
            saved.provider_installation_id,
            method.fee_basis_points
     FROM automatic_renewal_authorizations renewal_authorization
     JOIN saved_payment_methods saved
       ON saved.id = renewal_authorization.saved_payment_method_id
     JOIN payment_methods method
       ON method.code = saved.payment_method_code
      AND method.provider_installation_id = saved.provider_installation_id
     JOIN provider_installation_capabilities provider
       ON provider.provider_installation_id = saved.provider_installation_id
     JOIN services service ON service.id = renewal_authorization.service_id
     JOIN client_accounts account ON account.id = renewal_authorization.client_account_id
     WHERE renewal_authorization.service_id = $1
       AND renewal_authorization.client_account_id = $2
       AND renewal_authorization.status = 'active'
       AND renewal_authorization.consent_generation =
             service.automatic_renewal_consent_generation
       AND saved.status = 'active'
       AND saved.client_account_id = renewal_authorization.client_account_id
       AND method.enabled
       AND method.automatic_renewal_enabled
       AND provider.provider_type = 'payment'
       AND provider.enabled
       AND provider.capabilities @> '["payment_create","payment_reconcile","payment_off_session"]'::jsonb
       AND account.restricted_at IS NULL
       AND service.status IN ('active', 'suspended')
       AND service.cancellation_request_id IS NULL
     FOR UPDATE OF renewal_authorization, saved, method, provider`,
    [input.serviceId, input.clientAccountId],
  );
  const authorization = authorizationResult.rows[0];
  if (!authorization) return null;

  const availableCreditResult = await client.query<{ balance_minor: string }>(
    `SELECT COALESCE(sum(transaction.credit_minor - transaction.debit_minor), 0)::text AS balance_minor
     FROM credit_accounts account
     LEFT JOIN credit_transactions transaction ON transaction.credit_account_id = account.id
     WHERE account.client_account_id = $1 AND account.currency = $2`,
    [input.clientAccountId, input.currency],
  );
  const availableCreditMinor = availableCreditResult.rows[0]?.balance_minor ?? "0";
  const feeMinor = percentageFeeMinor(principalMinor, authorization.fee_basis_points);
  const externalDueMinor = principalMinor + feeMinor;
  const fingerprint = requestFingerprint("automatic-renewal.payment:v1", {
    renewalId: input.renewalId,
    authorizationId: authorization.authorization_id,
    savedPaymentMethodId: authorization.saved_payment_method_id,
    invoiceTotalMinor: input.invoiceTotalMinor.toString(),
    creditAppliedMinor: input.creditAppliedMinor.toString(),
    principalMinor: principalMinor.toString(),
    feeBasisPoints: authorization.fee_basis_points,
    feeMinor: feeMinor.toString(),
    currency: input.currency,
    attemptNumber: 1,
  });
  const quote = await client.query<{ id: string }>(
    `INSERT INTO invoice_payment_quotes(
       client_account_id, invoice_id, payment_method_code,
       provider_installation_id, currency,
       invoice_total_minor, payment_allocated_minor, credit_allocated_minor,
       available_credit_minor, credit_to_apply_minor, external_non_fee_minor,
       fee_basis_points, fee_minor, external_due_minor, request_fingerprint,
       expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, 0, $9, $10, $11, $12, $13,
               now() + interval '30 minutes')
     RETURNING id`,
    [
      input.clientAccountId,
      input.invoiceId,
      authorization.payment_method_code,
      authorization.provider_installation_id,
      input.currency,
      input.invoiceTotalMinor.toString(),
      input.creditAppliedMinor.toString(),
      availableCreditMinor,
      principalMinor.toString(),
      authorization.fee_basis_points,
      feeMinor.toString(),
      externalDueMinor.toString(),
      fingerprint,
    ],
  );
  const quoteId = quote.rows[0]?.id;
  if (!quoteId) throw new Error("Unable to create automatic-renewal payment quote");
  const commandId = randomUUID();
  const paymentAttemptId = randomUUID();
  await client.query(
    `INSERT INTO invoice_payment_commands(
       id, client_account_id, invoice_id, quote_id,
       status, idempotency_key, request_fingerprint,
       initiator_type, initiated_by_user_id
     ) VALUES ($1, $2, $3, $4, 'created', $5, $6, 'system', NULL)`,
    [
      commandId,
      input.clientAccountId,
      input.invoiceId,
      quoteId,
      `automatic-renewal:${input.renewalId}:1`,
      fingerprint,
    ],
  );
  await client.query(
    `INSERT INTO payment_attempts(
       id, client_account_id, invoice_id, provider_installation_id, status,
       amount_minor, principal_minor, fee_basis_points, fee_minor,
       currency, scenario, idempotency_key, request_fingerprint,
       payment_method_code, payment_quote_id, saved_payment_method_id,
       automatic_renewal_authorization_id, automatic_attempt_number
     ) VALUES ($1, $2, $3, $4, 'created', $5, $6, $7, $8, $9, 'automatic',
               $10, $11, $12, $13, $14, $15, 1)`,
    [
      paymentAttemptId,
      input.clientAccountId,
      input.invoiceId,
      authorization.provider_installation_id,
      externalDueMinor.toString(),
      principalMinor.toString(),
      authorization.fee_basis_points,
      feeMinor.toString(),
      input.currency,
      `automatic-renewal:${input.renewalId}:1`,
      fingerprint,
      authorization.payment_method_code,
      quoteId,
      authorization.saved_payment_method_id,
      authorization.authorization_id,
    ],
  );
  await client.query(
    `UPDATE invoice_payment_commands
     SET payment_attempt_id = $2, status = 'processing',
         result = $3, updated_at = now()
     WHERE id = $1`,
    [
      commandId,
      paymentAttemptId,
      {
        automaticRenewal: true,
        creditAppliedMinor: input.creditAppliedMinor.toString(),
        externalDueMinor: externalDueMinor.toString(),
        feeMinor: feeMinor.toString(),
        maxAttempts: 1,
      },
    ],
  );
  const operation = await client.query<{ id: string }>(
    `INSERT INTO provider_operations(
       provider_installation_id, kind, subject_type, subject_id, stable_key, status
     ) VALUES ($1, 'payment_create', 'payment', $2, $3, 'queued')
     RETURNING id`,
    [
      authorization.provider_installation_id,
      paymentAttemptId,
      `payment:${paymentAttemptId}`,
    ],
  );
  const operationId = operation.rows[0]?.id;
  if (!operationId) throw new Error("Unable to create automatic-renewal Provider operation");
  const run = await client.query<{ id: string }>(
    `INSERT INTO automatic_renewal_runs(
       service_renewal_id, client_account_id,
       automatic_renewal_authorization_id, saved_payment_method_id,
       invoice_payment_command_id, payment_attempt_id, status,
       attempt_count, max_attempts
     ) VALUES ($1, $2, $3, $4, $5, $6, 'processing', 1, 1)
     RETURNING id`,
    [
      input.renewalId,
      input.clientAccountId,
      authorization.authorization_id,
      authorization.saved_payment_method_id,
      commandId,
      paymentAttemptId,
    ],
  );
  const runId = run.rows[0]?.id;
  if (!runId) throw new Error("Unable to create automatic-renewal run");
  await client.query(
    `INSERT INTO durable_jobs(job_type, unique_key, payload)
     VALUES ('payment.start', $1, $2)`,
    [
      `payment:${paymentAttemptId}`,
      { paymentAttemptId, providerOperationId: operationId, automaticRenewalRunId: runId },
    ],
  );
  return runId;
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
    owner_user_id: string;
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
       owner.id AS owner_user_id,
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
    await startAuthorizedAutomaticRenewalPayment(client, {
      renewalId,
      invoiceId,
      serviceId: candidate.service_id,
      clientAccountId: candidate.client_account_id,
      currency: candidate.currency,
      invoiceTotalMinor: recurringMinor,
      creditAppliedMinor: creditApplied,
    });
    invoicesCreated += 1;
    if (
      await enqueueReminder(client, {
        invoiceId,
        serviceId: candidate.service_id,
        clientAccountId: candidate.client_account_id,
        recipientUserId: candidate.owner_user_id,
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
    client_account_id: string;
    owner_user_id: string;
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
       service.client_account_id,
       owner.id AS owner_user_id,
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
        clientAccountId: candidate.client_account_id,
        recipientUserId: candidate.owner_user_id,
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
        kind: "automatic_renewal";
        authorizationId: string;
      }
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

  const commandUserId = context?.kind === "user_command" ? context.userId : null;
  await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [pointer.order_id]);
  await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [pointer.service_id]);
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
    membership_restricted_at: Date | null;
    membership_client_account_id: string | null;
    membership_role: CustomerMembershipRole | null;
    membership_permissions: unknown;
    suspension_case_status: string | null;
    automatic_authorization_status: string | null;
    automatic_authorization_service_id: string | null;
    automatic_authorization_client_account_id: string | null;
    automatic_authorization_consent_generation: string | null;
    service_automatic_renewal_consent_generation: string;
    automatic_method_status: string | null;
    automatic_method_client_account_id: string | null;
    automatic_method_provider_installation_id: string | null;
    automatic_config_provider_installation_id: string | null;
    automatic_method_enabled: boolean | null;
    automatic_provider_enabled: boolean | null;
    automatic_provider_type: string | null;
    automatic_provider_capabilities: unknown;
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
       membership.restricted_at AS membership_restricted_at,
       membership.client_account_id AS membership_client_account_id,
       membership.role AS membership_role,
       membership.permissions AS membership_permissions,
       suspension_case.status AS suspension_case_status,
       automatic_authorization.status AS automatic_authorization_status,
       automatic_authorization.service_id AS automatic_authorization_service_id,
       automatic_authorization.client_account_id AS automatic_authorization_client_account_id,
       automatic_authorization.consent_generation::text AS automatic_authorization_consent_generation,
       service.automatic_renewal_consent_generation::text
         AS service_automatic_renewal_consent_generation,
       automatic_method.status AS automatic_method_status,
       automatic_method.client_account_id AS automatic_method_client_account_id,
       automatic_method.provider_installation_id AS automatic_method_provider_installation_id,
       automatic_method_config.provider_installation_id AS automatic_config_provider_installation_id,
       automatic_method_config.automatic_renewal_enabled AS automatic_method_enabled,
       automatic_provider.enabled AS automatic_provider_enabled,
       automatic_provider.provider_type AS automatic_provider_type,
       automatic_provider.capabilities AS automatic_provider_capabilities,
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
     LEFT JOIN automatic_renewal_authorizations automatic_authorization
       ON automatic_authorization.id = $3
      AND automatic_authorization.service_id = service.id
     LEFT JOIN saved_payment_methods automatic_method
       ON automatic_method.id = automatic_authorization.saved_payment_method_id
     LEFT JOIN payment_methods automatic_method_config
       ON automatic_method_config.code = automatic_method.payment_method_code
     LEFT JOIN provider_installation_capabilities automatic_provider
       ON automatic_provider.provider_installation_id = automatic_method.provider_installation_id
     WHERE renewal.id = $1`,
    [
      pointer.renewal_id,
      commandUserId,
      context?.kind === "automatic_renewal" ? context.authorizationId : null,
    ],
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
    !renewal.membership_restricted_at &&
    Boolean(renewal.membership_role) &&
    hasCustomerMembershipCapability(
      {
        role: renewal.membership_role!,
        permissions:
          Array.isArray(renewal.membership_permissions) &&
          renewal.membership_permissions.every(
            (permission): permission is string => typeof permission === "string",
          )
            ? renewal.membership_permissions
            : [],
      },
      "billing.write",
    );
  const automaticRenewalEligible =
    context?.kind === "automatic_renewal" &&
    renewal.automatic_authorization_status === "active" &&
    renewal.automatic_authorization_service_id === renewal.service_id &&
    renewal.automatic_authorization_client_account_id === renewal.service_client_account_id &&
    renewal.automatic_authorization_consent_generation ===
      renewal.service_automatic_renewal_consent_generation &&
    renewal.automatic_method_status === "active" &&
    renewal.automatic_method_client_account_id === renewal.service_client_account_id &&
    renewal.automatic_method_provider_installation_id ===
      renewal.automatic_config_provider_installation_id &&
    renewal.automatic_method_enabled === true &&
    renewal.automatic_provider_enabled === true &&
    renewal.automatic_provider_type === "payment" &&
    Array.isArray(renewal.automatic_provider_capabilities) &&
    ["payment_create", "payment_reconcile", "payment_off_session"].every((capability) =>
      (renewal.automatic_provider_capabilities as unknown[]).includes(capability),
    );
  const eligible =
    accountAndServiceEligible &&
    (context?.kind === "staff_manual" ||
      context?.kind === "staff_hold_resolution" ||
      userCommandEligible ||
      automaticRenewalEligible);
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
