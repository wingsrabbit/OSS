// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { percentageFeeMinor } from "@opensales/core";
import type { DatabaseClient } from "./database.js";

export type DelinquencyAutomationPolicy = {
  policyId: string;
  timezone: string;
  businessDate: string;
  effectiveAt: Date;
  lateFeeEnabled: boolean;
  lateFeeDays: number;
  lateFeeBasisPoints: number;
  overdueSuspensionEnabled: boolean;
  overdueSuspensionDays: number;
};

export type DelinquencyAutomationOutcome = {
  lateFeesAssessed: number;
  lateFeeMinor: bigint;
  suspensionCasesCreated: number;
  delinquencyDeferralsCreated: number;
};

export type RenewalResumeScheduleOutcome =
  | "none"
  | "resolved_before_suspend"
  | "waiting_for_suspend_reconciliation"
  | "resume_queued"
  | "already_queued"
  | "manual";

type SuspensionAction = "automatic" | "manual" | "none";
type SuspensionDelayMode = "policy_calendar_days" | "exact_hours";

const SUSPEND_CAPABILITY = "resource_suspend";
const RESUME_CAPABILITY = "resource_resume";

async function recordUnsettledPaymentDeferrals(
  client: DatabaseClient,
  runId: string,
  policy: DelinquencyAutomationPolicy,
): Promise<number> {
  const candidates = await client.query<{ invoice_id: string; renewal_id: string }>(
    `SELECT renewal.invoice_id, renewal.id AS renewal_id
     FROM service_renewals renewal
     JOIN invoices invoice ON invoice.id = renewal.invoice_id
     JOIN services service ON service.id = renewal.service_id
     JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN product_service_automation_policies product_policy
       ON product_policy.product_id = item.product_id
     WHERE renewal.status IN ('invoiced', 'manual_hold')
       AND EXISTS (
         SELECT 1
         FROM payment_attempts attempt
         WHERE attempt.invoice_id = invoice.id
           AND attempt.status IN ('created', 'processing', 'unknown')
       )
       AND (
         (
           $3::boolean
           AND ($1::timestamptz AT TIME ZONE $2)::date >=
               (invoice.due_at AT TIME ZONE $2)::date + $4::integer
         )
         OR (
           $5::boolean
           AND (
             (
               COALESCE(product_policy.overdue_delay_mode, 'policy_calendar_days') =
                 'policy_calendar_days'
               AND ($1::timestamptz AT TIME ZONE $2)::date >=
                   (invoice.due_at AT TIME ZONE $2)::date
                     + COALESCE(product_policy.overdue_delay_value, $6::integer)
             )
             OR (
               product_policy.overdue_delay_mode = 'exact_hours'
               AND $1::timestamptz >= invoice.due_at
                   + make_interval(hours => product_policy.overdue_delay_value)
             )
           )
         )
       )
     ORDER BY renewal.invoice_id`,
    [
      policy.effectiveAt,
      policy.timezone,
      policy.lateFeeEnabled,
      policy.lateFeeDays,
      policy.overdueSuspensionEnabled,
      policy.overdueSuspensionDays,
    ],
  );
  let created = 0;
  for (const candidate of candidates.rows) {
    await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
      candidate.invoice_id,
    ]);
    await client.query("SELECT id FROM service_renewals WHERE id = $1 FOR UPDATE", [
      candidate.renewal_id,
    ]);
    const attempts = await client.query<{
      id: string;
      status: string;
      amount_minor: string;
      currency: string;
    }>(
      `SELECT id, status, amount_minor::text, currency
       FROM payment_attempts
       WHERE invoice_id = $1
         AND status IN ('created', 'processing', 'unknown')
       ORDER BY id
       FOR UPDATE`,
      [candidate.invoice_id],
    );
    if (!attempts.rowCount) continue;
    const snapshot = attempts.rows.map((attempt) => ({
      paymentAttemptId: attempt.id,
      status: attempt.status,
      amountMinor: attempt.amount_minor,
      currency: attempt.currency,
    }));
    const inserted = await client.query(
      `INSERT INTO invoice_delinquency_deferrals(
         invoice_id, service_renewal_id, automation_run_id,
         reason, pending_payment_snapshot
       ) VALUES ($1, $2, $3, 'unsettled_payment_result', $4)
       ON CONFLICT (automation_run_id, invoice_id) DO NOTHING
       RETURNING id`,
      [candidate.invoice_id, candidate.renewal_id, runId, JSON.stringify(snapshot)],
    );
    if (inserted.rowCount === 1) created += 1;
  }
  return created;
}

type SuspensionDecision = {
  action: SuspensionAction;
  reason: string;
  providerInstallationId: string | null;
  productPolicySnapshot: Record<string, unknown>;
  providerCapabilitySnapshot: Record<string, unknown>;
};

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function decideSuspension(input: {
  automationEnabled: boolean;
  serviceStatus: string;
  productAction: SuspensionAction | null;
  productProviderInstallationId: string | null;
  overdueDelayMode: SuspensionDelayMode | null;
  overdueDelayValue: number | null;
  requiredSuspendCapability: string | null;
  requiredResumeCapability: string | null;
  productPolicyVersion: number | null;
  bindingAction: SuspensionAction | null;
  bindingProductPolicyVersion: number | null;
  providerInstallationId: string | null;
  bindingCapabilitySnapshot: unknown;
  providerEnabled: boolean | null;
  currentProviderCapabilities: unknown;
  currentProviderVersion: number | null;
}): SuspensionDecision {
  const productPolicySnapshot = {
    overdueAction: input.productAction,
    providerInstallationId: input.productProviderInstallationId,
    overdueDelayMode: input.overdueDelayMode ?? "policy_calendar_days",
    overdueDelayValue: input.overdueDelayValue,
    requiredSuspendCapability: input.requiredSuspendCapability,
    requiredResumeCapability: input.requiredResumeCapability,
    version: input.productPolicyVersion,
    bindingOverdueAction: input.bindingAction,
    bindingProductPolicyVersion: input.bindingProductPolicyVersion,
  };
  const approvedAtBinding = stringArray(input.bindingCapabilitySnapshot);
  const approvedNow = stringArray(input.currentProviderCapabilities);
  const providerCapabilitySnapshot = {
    providerInstallationId: input.providerInstallationId,
    enabled: input.providerEnabled,
    capabilitiesAtBinding: approvedAtBinding,
    currentCapabilities: approvedNow,
    currentVersion: input.currentProviderVersion,
  };
  const decision = (
    action: SuspensionAction,
    reason: string,
    providerInstallationId: string | null = input.providerInstallationId,
  ): SuspensionDecision => ({
    action,
    reason,
    providerInstallationId,
    productPolicySnapshot,
    providerCapabilitySnapshot,
  });

  if (!input.automationEnabled) {
    return decision("none", "global_overdue_suspension_disabled", null);
  }
  if (!input.productAction) {
    return decision("none", "product_has_no_explicit_overdue_policy", null);
  }
  if (input.productAction === "none" || input.bindingAction === "none") {
    return decision("none", "product_policy_disallows_suspension", null);
  }
  if (input.serviceStatus !== "active") {
    return decision("manual", "service_is_not_active");
  }
  if (input.productAction === "manual" || input.bindingAction === "manual") {
    return decision("manual", "product_policy_requires_manual_action");
  }
  if (!input.providerInstallationId || input.bindingAction !== "automatic") {
    return decision("manual", "service_has_no_explicit_automatic_provider_binding");
  }
  if (input.providerInstallationId !== input.productProviderInstallationId) {
    return decision("manual", "service_binding_does_not_match_product_provider");
  }
  if (
    input.requiredSuspendCapability !== SUSPEND_CAPABILITY ||
    input.requiredResumeCapability !== RESUME_CAPABILITY ||
    !approvedAtBinding.includes(SUSPEND_CAPABILITY) ||
    !approvedAtBinding.includes(RESUME_CAPABILITY)
  ) {
    return decision("manual", "service_binding_did_not_approve_suspend_and_resume");
  }
  if (!input.providerEnabled) {
    return decision("manual", "provider_installation_is_disabled");
  }
  if (!approvedNow.includes(SUSPEND_CAPABILITY) || !approvedNow.includes(RESUME_CAPABILITY)) {
    return decision("manual", "provider_currently_lacks_suspend_or_resume_capability");
  }
  return decision("automatic", "product_and_provider_allow_automatic_suspension");
}

async function assessLateFees(
  client: DatabaseClient,
  runId: string,
  policy: DelinquencyAutomationPolicy,
): Promise<{ count: number; amountMinor: bigint }> {
  if (!policy.lateFeeEnabled) return { count: 0, amountMinor: 0n };

  const candidates = await client.query<{ invoice_id: string }>(
    `SELECT renewal.invoice_id
     FROM service_renewals renewal
     JOIN invoices invoice ON invoice.id = renewal.invoice_id
     WHERE renewal.status IN ('invoiced', 'manual_hold')
       AND ($1::timestamptz AT TIME ZONE $2)::date >=
           (invoice.due_at AT TIME ZONE $2)::date + $3::integer
       AND NOT EXISTS (
         SELECT 1
         FROM invoice_late_fee_assessments assessment
         WHERE assessment.invoice_id = renewal.invoice_id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM payment_attempts attempt
         WHERE attempt.invoice_id = renewal.invoice_id
           AND attempt.status IN ('created', 'processing', 'unknown')
       )
     ORDER BY renewal.invoice_id`,
    [policy.effectiveAt, policy.timezone, policy.lateFeeDays],
  );

  let count = 0;
  let amountMinor = 0n;
  for (const candidate of candidates.rows) {
    const locked = await client.query<{
      renewal_id: string;
      invoice_id: string;
      currency: string;
      due_business_date: string;
      eligible_gross_minor: string;
      payment_allocated_minor: string;
      credit_allocated_minor: string;
    }>(
      `SELECT
         renewal.id AS renewal_id,
         invoice.id AS invoice_id,
         invoice.currency,
         (invoice.due_at AT TIME ZONE $2)::date::text AS due_business_date,
         COALESCE((
           SELECT sum(line.amount_minor)
           FROM invoice_lines line
           WHERE line.invoice_id = invoice.id
             AND line.kind IN ('one_time', 'setup', 'recurring', 'tax')
             AND line.amount_minor > 0
         ), 0)::text AS eligible_gross_minor,
         allocation.payment_minor::text AS payment_allocated_minor,
         allocation.credit_minor::text AS credit_allocated_minor
       FROM service_renewals renewal
       JOIN invoices invoice ON invoice.id = renewal.invoice_id
       JOIN services service ON service.id = renewal.service_id
       JOIN invoice_delinquency_allocation_totals allocation
         ON allocation.invoice_id = invoice.id
       WHERE renewal.invoice_id = $1
         AND renewal.status IN ('invoiced', 'manual_hold')
         AND ($3::timestamptz AT TIME ZONE $2)::date >=
             (invoice.due_at AT TIME ZONE $2)::date + $4::integer
         AND NOT EXISTS (
           SELECT 1
           FROM invoice_late_fee_assessments assessment
           WHERE assessment.invoice_id = invoice.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM payment_attempts attempt
           WHERE attempt.invoice_id = invoice.id
             AND attempt.status IN ('created', 'processing', 'unknown')
         )
       FOR UPDATE OF invoice, renewal, service`,
      [candidate.invoice_id, policy.timezone, policy.effectiveAt, policy.lateFeeDays],
    );
    const row = locked.rows[0];
    if (!row) continue;

    const eligibleGrossMinor = BigInt(row.eligible_gross_minor);
    const paymentAllocatedMinor = BigInt(row.payment_allocated_minor);
    const creditAllocatedMinor = BigInt(row.credit_allocated_minor);
    const allocatedMinor = paymentAllocatedMinor + creditAllocatedMinor;
    const basisMinor = eligibleGrossMinor > allocatedMinor
      ? eligibleGrossMinor - allocatedMinor
      : 0n;
    const feeMinor = percentageFeeMinor(basisMinor, policy.lateFeeBasisPoints);
    const assessmentId = randomUUID();
    let invoiceLineId: string | null = null;
    let journalId: string | null = null;

    if (feeMinor > 0n) {
      invoiceLineId = randomUUID();
      await client.query(
        `INSERT INTO invoice_lines(id, invoice_id, kind, description, amount_minor)
         VALUES ($1, $2, 'late_fee', $3, $4)`,
        [
          invoiceLineId,
          row.invoice_id,
          `Late Fee (${(policy.lateFeeBasisPoints / 100).toFixed(2)}%)`,
          feeMinor.toString(),
        ],
      );
      await client.query(
        `UPDATE invoices
         SET total_minor = total_minor + $2
         WHERE id = $1`,
        [row.invoice_id, feeMinor.toString()],
      );
      const journal = await client.query<{ id: string }>(
        `INSERT INTO ledger_journals(source_type, source_id, currency, description)
         VALUES ('invoice_late_fee_assessment', $1, $2, 'Overdue invoice Late Fee assessed')
         RETURNING id`,
        [assessmentId, row.currency],
      );
      journalId = journal.rows[0]?.id ?? null;
      if (!journalId) throw new Error("Unable to create Late Fee journal");
      await client.query(
        `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
         VALUES
           ($1, 'accounts_receivable', $2, 0),
           ($1, 'late_fee_revenue', 0, $2)`,
        [journalId, feeMinor.toString()],
      );
    }

    await client.query(
      `INSERT INTO invoice_late_fee_assessments(
         id, invoice_id, service_renewal_id, automation_run_id, policy_id,
         business_date, effective_at, timezone, due_business_date, late_fee_days,
         eligible_gross_minor, payment_allocated_minor, credit_allocated_minor,
         allocated_minor, basis_minor, basis_points, amount_minor, disposition,
         invoice_line_id, ledger_journal_id
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::date, $7, $8, $9::date, $10,
         $11, $12, $13,
         $14, $15, $16, $17, $18,
         $19, $20
       )`,
      [
        assessmentId,
        row.invoice_id,
        row.renewal_id,
        runId,
        policy.policyId,
        policy.businessDate,
        policy.effectiveAt,
        policy.timezone,
        row.due_business_date,
        policy.lateFeeDays,
        eligibleGrossMinor.toString(),
        paymentAllocatedMinor.toString(),
        creditAllocatedMinor.toString(),
        allocatedMinor.toString(),
        basisMinor.toString(),
        policy.lateFeeBasisPoints,
        feeMinor.toString(),
        feeMinor > 0n ? "charged" : "skipped_zero",
        invoiceLineId,
        journalId,
      ],
    );
    count += 1;
    amountMinor += feeMinor;
  }
  return { count, amountMinor };
}

async function scheduleSuspensions(
  client: DatabaseClient,
  runId: string,
  policy: DelinquencyAutomationPolicy,
): Promise<number> {
  const candidates = await client.query<{ invoice_id: string }>(
    `SELECT renewal.invoice_id
     FROM service_renewals renewal
     JOIN invoices invoice ON invoice.id = renewal.invoice_id
     JOIN services service ON service.id = renewal.service_id
     JOIN order_items item ON item.id = service.order_item_id
     JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
     LEFT JOIN product_service_automation_policies product_policy
       ON product_policy.product_id = item.product_id
     WHERE renewal.status IN ('invoiced', 'manual_hold')
       AND allocation.allocated_minor < invoice.total_minor
       AND (
         (
           COALESCE(product_policy.overdue_delay_mode, 'policy_calendar_days') =
             'policy_calendar_days'
           AND ($1::timestamptz AT TIME ZONE $2)::date >=
               (invoice.due_at AT TIME ZONE $2)::date
                 + COALESCE(product_policy.overdue_delay_value, $3::integer)
         )
         OR (
           product_policy.overdue_delay_mode = 'exact_hours'
           AND $1::timestamptz >= invoice.due_at
               + make_interval(hours => product_policy.overdue_delay_value)
         )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM service_suspension_cases suspension_case
         WHERE suspension_case.invoice_id = renewal.invoice_id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM payment_attempts attempt
         WHERE attempt.invoice_id = renewal.invoice_id
           AND attempt.status IN ('created', 'processing', 'unknown')
       )
     ORDER BY renewal.invoice_id`,
    [policy.effectiveAt, policy.timezone, policy.overdueSuspensionDays],
  );

  let created = 0;
  for (const candidate of candidates.rows) {
    const locked = await client.query<{
      renewal_id: string;
      invoice_id: string;
      service_id: string;
      service_status: string;
      due_business_date: string;
      total_minor: string;
      allocated_minor: string;
      late_fee_assessment_id: string | null;
      product_action: SuspensionAction | null;
      product_provider_installation_id: string | null;
      overdue_delay_mode: SuspensionDelayMode | null;
      overdue_delay_value: number | null;
      required_suspend_capability: string | null;
      required_resume_capability: string | null;
      product_policy_version: number | null;
      binding_action: SuspensionAction | null;
      binding_product_policy_version: number | null;
      provider_installation_id: string | null;
      binding_capability_snapshot: unknown;
      provider_enabled: boolean | null;
      current_provider_capabilities: unknown;
      current_provider_version: number | null;
    }>(
      `SELECT
         renewal.id AS renewal_id,
         invoice.id AS invoice_id,
         service.id AS service_id,
         service.status AS service_status,
         (invoice.due_at AT TIME ZONE $2)::date::text AS due_business_date,
         invoice.total_minor::text,
         allocation.allocated_minor::text,
         late_fee.id AS late_fee_assessment_id,
         product_policy.overdue_action AS product_action,
         product_policy.provider_installation_id AS product_provider_installation_id,
         product_policy.overdue_delay_mode,
         product_policy.overdue_delay_value,
         product_policy.required_suspend_capability,
         product_policy.required_resume_capability,
         product_policy.version AS product_policy_version,
         binding.overdue_action_snapshot AS binding_action,
         binding.product_policy_version AS binding_product_policy_version,
         binding.provider_installation_id,
         binding.capability_snapshot AS binding_capability_snapshot,
         provider.enabled AS provider_enabled,
         provider.capabilities AS current_provider_capabilities,
         provider.version AS current_provider_version
       FROM service_renewals renewal
       JOIN invoices invoice ON invoice.id = renewal.invoice_id
       JOIN services service ON service.id = renewal.service_id
       JOIN order_items item ON item.id = service.order_item_id
       JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
       LEFT JOIN invoice_late_fee_assessments late_fee
         ON late_fee.invoice_id = invoice.id
       LEFT JOIN product_service_automation_policies product_policy
         ON product_policy.product_id = item.product_id
       LEFT JOIN service_provider_bindings binding ON binding.service_id = service.id
       LEFT JOIN provider_installation_capabilities provider
         ON provider.provider_installation_id = binding.provider_installation_id
       WHERE renewal.invoice_id = $1
         AND renewal.status IN ('invoiced', 'manual_hold')
         AND allocation.allocated_minor < invoice.total_minor
         AND (
           (
             COALESCE(product_policy.overdue_delay_mode, 'policy_calendar_days') =
               'policy_calendar_days'
             AND ($3::timestamptz AT TIME ZONE $2)::date >=
                 (invoice.due_at AT TIME ZONE $2)::date
                   + COALESCE(product_policy.overdue_delay_value, $4::integer)
           )
           OR (
             product_policy.overdue_delay_mode = 'exact_hours'
             AND $3::timestamptz >= invoice.due_at
                 + make_interval(hours => product_policy.overdue_delay_value)
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM service_suspension_cases suspension_case
           WHERE suspension_case.invoice_id = invoice.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM payment_attempts attempt
           WHERE attempt.invoice_id = invoice.id
             AND attempt.status IN ('created', 'processing', 'unknown')
         )
       FOR UPDATE OF invoice, renewal, service`,
      [
        candidate.invoice_id,
        policy.timezone,
        policy.effectiveAt,
        policy.overdueSuspensionDays,
      ],
    );
    const row = locked.rows[0];
    if (!row || BigInt(row.allocated_minor) >= BigInt(row.total_minor)) continue;

    const decision = decideSuspension({
      automationEnabled: policy.overdueSuspensionEnabled,
      serviceStatus: row.service_status,
      productAction: row.product_action,
      productProviderInstallationId: row.product_provider_installation_id,
      overdueDelayMode: row.overdue_delay_mode,
      overdueDelayValue: row.overdue_delay_value ?? policy.overdueSuspensionDays,
      requiredSuspendCapability: row.required_suspend_capability,
      requiredResumeCapability: row.required_resume_capability,
      productPolicyVersion: row.product_policy_version,
      bindingAction: row.binding_action,
      bindingProductPolicyVersion: row.binding_product_policy_version,
      providerInstallationId: row.provider_installation_id,
      bindingCapabilitySnapshot: row.binding_capability_snapshot,
      providerEnabled: row.provider_enabled,
      currentProviderCapabilities: row.current_provider_capabilities,
      currentProviderVersion: row.current_provider_version,
    });
    const caseId = randomUUID();
    const initialStatus = decision.action === "automatic"
      ? "suspend_queued"
      : decision.action === "manual"
        ? "manual"
        : "resolved";
    await client.query(
      `INSERT INTO service_suspension_cases(
         id, service_id, service_renewal_id, invoice_id, late_fee_assessment_id,
         automation_run_id, policy_id, business_date, effective_at, timezone,
         due_business_date, suspension_delay_mode, suspension_delay_value,
         action, decision_reason,
         provider_installation_id, product_policy_snapshot,
         provider_capability_snapshot, status, resolved_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8::date, $9, $10,
         $11::date, $12, $13,
         $14, $15, $16, $17,
         $18, $19, $20
       )`,
      [
        caseId,
        row.service_id,
        row.renewal_id,
        row.invoice_id,
        row.late_fee_assessment_id,
        runId,
        policy.policyId,
        policy.businessDate,
        policy.effectiveAt,
        policy.timezone,
        row.due_business_date,
        row.overdue_delay_mode ?? "policy_calendar_days",
        row.overdue_delay_value ?? policy.overdueSuspensionDays,
        decision.action,
        decision.reason,
        decision.providerInstallationId,
        decision.productPolicySnapshot,
        decision.providerCapabilitySnapshot,
        initialStatus,
        initialStatus === "resolved" ? policy.effectiveAt : null,
      ],
    );
    created += 1;

    if (decision.action === "automatic") {
      if (!decision.providerInstallationId) {
        throw new Error("Automatic suspension has no Provider installation");
      }
      const providerOperationId = randomUUID();
      const stableKey = `service-suspension-case:${caseId}:suspend`;
      await client.query(
        `INSERT INTO provider_operations(
           id, provider_installation_id, kind, subject_type, subject_id,
           stable_key, status
         ) VALUES (
           $1, $2, 'resource_suspend', 'service_suspension_case', $3,
           $4, 'queued'
         )`,
        [providerOperationId, decision.providerInstallationId, caseId, stableKey],
      );
      await client.query(
        `INSERT INTO durable_jobs(job_type, unique_key, payload)
         VALUES ('service.suspend.start', $1, $2)
         ON CONFLICT (job_type, unique_key) DO NOTHING`,
        [stableKey, { caseId, serviceId: row.service_id, providerOperationId }],
      );
    }
  }
  return created;
}

export async function assessLateFeesAndScheduleSuspensions(
  client: DatabaseClient,
  input: { runId: string; policy: DelinquencyAutomationPolicy },
): Promise<DelinquencyAutomationOutcome> {
  const delinquencyDeferralsCreated = await recordUnsettledPaymentDeferrals(
    client,
    input.runId,
    input.policy,
  );
  const lateFees = await assessLateFees(client, input.runId, input.policy);
  const suspensionCasesCreated = await scheduleSuspensions(client, input.runId, input.policy);
  return {
    lateFeesAssessed: lateFees.count,
    lateFeeMinor: lateFees.amountMinor,
    suspensionCasesCreated,
    delinquencyDeferralsCreated,
  };
}

export async function scheduleResumeAfterRenewalSettlement(
  client: DatabaseClient,
  input: { renewalId: string; serviceId: string },
): Promise<RenewalResumeScheduleOutcome> {
  const caseResult = await client.query<{
    id: string;
    status: string;
    action: SuspensionAction;
    resume_required: boolean;
    provider_installation_id: string | null;
    service_status: string;
    required_resume_capability: string | null;
    binding_capabilities: unknown;
    provider_enabled: boolean | null;
    current_capabilities: unknown;
    account_restricted_at: Date | null;
    version: number;
  }>(
    `SELECT
       suspension_case.id,
       suspension_case.status,
       suspension_case.action,
       suspension_case.resume_required,
       suspension_case.provider_installation_id,
       service.status AS service_status,
       product_policy.required_resume_capability,
       binding.capability_snapshot AS binding_capabilities,
       provider.enabled AS provider_enabled,
       provider.capabilities AS current_capabilities,
       account.restricted_at AS account_restricted_at,
       suspension_case.version
     FROM service_suspension_cases suspension_case
     JOIN services service ON service.id = suspension_case.service_id
     JOIN client_accounts account ON account.id = service.client_account_id
     JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN product_service_automation_policies product_policy
       ON product_policy.product_id = item.product_id
     LEFT JOIN service_provider_bindings binding ON binding.service_id = service.id
     LEFT JOIN provider_installation_capabilities provider
       ON provider.provider_installation_id = suspension_case.provider_installation_id
     WHERE suspension_case.service_renewal_id = $1
       AND suspension_case.service_id = $2
     FOR UPDATE OF suspension_case, service, account`,
    [input.renewalId, input.serviceId],
  );
  const suspensionCase = caseResult.rows[0];
  if (!suspensionCase || suspensionCase.status === "resolved") return "none";

  if (suspensionCase.action !== "automatic") {
    if (suspensionCase.service_status === "active" && suspensionCase.status === "manual") {
      await client.query(
        `UPDATE service_suspension_cases
         SET status = 'resolved', resolved_at = now(), resume_required = false,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'manual' AND version = $2`,
        [suspensionCase.id, suspensionCase.version],
      );
      return "resolved_before_suspend";
    }
    return "manual";
  }

  const suspendOperation = await client.query<{
    id: string;
    status: string;
    attempt_count: number;
    stable_key: string;
  }>(
    `SELECT id, status, attempt_count, stable_key
     FROM provider_operations
     WHERE subject_type = 'service_suspension_case'
       AND subject_id = $1
       AND kind = 'resource_suspend'
     FOR UPDATE`,
    [suspensionCase.id],
  );
  const suspend = suspendOperation.rows[0];
  if (suspensionCase.status === "suspend_queued") {
    if (suspend?.status === "queued" && suspend.attempt_count === 0) {
      await client.query(
        `UPDATE durable_jobs
         SET status = 'completed', last_error = $2, updated_at = now()
         WHERE job_type = 'service.suspend.start'
           AND unique_key = $1
           AND status = 'pending'`,
        [suspend.stable_key, "renewal settled before the suspension request was sent"],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'failed', last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
        [suspend.id, "superseded by renewal settlement before Provider delivery"],
      );
      await client.query(
        `UPDATE service_suspension_cases
         SET status = 'resolved', resolved_at = now(), resume_required = false,
             updated_at = now(), version = version + 1
         WHERE id = $1`,
        [suspensionCase.id],
      );
      return "resolved_before_suspend";
    }
    if (!suspensionCase.resume_required) {
      await client.query(
        `UPDATE service_suspension_cases
         SET resume_required = true, updated_at = now(), version = version + 1
         WHERE id = $1`,
        [suspensionCase.id],
      );
    }
    return "waiting_for_suspend_reconciliation";
  }
  if (suspensionCase.status === "suspend_processing" || suspensionCase.status === "suspend_unknown") {
    if (!suspensionCase.resume_required) {
      await client.query(
        `UPDATE service_suspension_cases
         SET resume_required = true, updated_at = now(), version = version + 1
         WHERE id = $1`,
        [suspensionCase.id],
      );
    }
    return "waiting_for_suspend_reconciliation";
  }
  if (
    suspensionCase.status === "resume_queued" ||
    suspensionCase.status === "resume_processing" ||
    suspensionCase.status === "resume_unknown"
  ) {
    return "already_queued";
  }
  if (suspensionCase.status === "manual") {
    if (suspensionCase.service_status === "suspended") {
      // A verified late suspend fact may arrive after reconciliation exhaustion.
      // Treat the Provider fact as authoritative and continue to the normal
      // resume eligibility checks below.
    } else if (suspend && suspend.attempt_count > 0) {
      if (!suspensionCase.resume_required) {
        await client.query(
          `UPDATE service_suspension_cases
           SET resume_required = true, updated_at = now(), version = version + 1
           WHERE id = $1`,
          [suspensionCase.id],
        );
      }
      return "waiting_for_suspend_reconciliation";
    } else {
      return "manual";
    }
  } else if (suspensionCase.status !== "suspended") {
    return "manual";
  }

  const otherBlocking = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM service_suspension_cases other_case
       JOIN service_renewals other_renewal ON other_renewal.id = other_case.service_renewal_id
       WHERE other_case.service_id = $1
         AND other_case.id <> $2
         AND other_case.status <> 'resolved'
         AND other_renewal.status <> 'paid'
     ) AS exists`,
    [input.serviceId, suspensionCase.id],
  );
  if (otherBlocking.rows[0]?.exists) {
    if (!suspensionCase.resume_required) {
      await client.query(
        `UPDATE service_suspension_cases
         SET resume_required = true, updated_at = now(), version = version + 1
         WHERE id = $1`,
        [suspensionCase.id],
      );
    }
    return "waiting_for_suspend_reconciliation";
  }

  const approvedAtBinding = stringArray(suspensionCase.binding_capabilities);
  const approvedNow = stringArray(suspensionCase.current_capabilities);
  if (
    suspensionCase.account_restricted_at ||
    !suspensionCase.provider_installation_id ||
    !suspensionCase.provider_enabled ||
    suspensionCase.required_resume_capability !== RESUME_CAPABILITY ||
    !approvedAtBinding.includes(RESUME_CAPABILITY) ||
    !approvedNow.includes(RESUME_CAPABILITY)
  ) {
    await client.query(
      `UPDATE service_suspension_cases
       SET status = 'manual', resume_required = true,
           last_error = $2,
           updated_at = now(), version = version + 1
       WHERE id = $1`,
      [
        suspensionCase.id,
        suspensionCase.account_restricted_at
          ? "Client Account is restricted; automatic resume is blocked"
          : "Provider is not currently approved to resume this service",
      ],
    );
    return "manual";
  }

  const existingResume = await client.query<{ id: string }>(
    `SELECT id
     FROM provider_operations
     WHERE subject_type = 'service_suspension_case'
       AND subject_id = $1
       AND kind = 'resource_resume'`,
    [suspensionCase.id],
  );
  if (existingResume.rowCount) return "already_queued";

  const providerOperationId = randomUUID();
  const stableKey = `service-suspension-case:${suspensionCase.id}:resume`;
  await client.query(
    `INSERT INTO provider_operations(
       id, provider_installation_id, kind, subject_type, subject_id,
       stable_key, status
     ) VALUES (
       $1, $2, 'resource_resume', 'service_suspension_case', $3,
       $4, 'queued'
     )`,
    [
      providerOperationId,
      suspensionCase.provider_installation_id,
      suspensionCase.id,
      stableKey,
    ],
  );
  await client.query(
    `UPDATE service_suspension_cases
     SET status = 'resume_queued', resume_required = false,
         updated_at = now(), version = version + 1
     WHERE id = $1`,
    [suspensionCase.id],
  );
  await client.query(
    `INSERT INTO durable_jobs(job_type, unique_key, payload)
     VALUES ('service.resume.start', $1, $2)
     ON CONFLICT (job_type, unique_key) DO NOTHING`,
    [
      stableKey,
      { caseId: suspensionCase.id, serviceId: input.serviceId, providerOperationId },
    ],
  );
  return "resume_queued";
}
