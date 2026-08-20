// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { providerOperationCapability } from "@opensales/core/provider-capability";
import pg from "pg";
import { digestToken, passwordHash } from "./auth.js";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import {
  assertPaymentMethodTokenKeyringsCompatible,
  assertSchemaCompatible,
  bootstrapPaymentMethodTokenKeyrings,
  runMigrations,
  type DatabaseClient,
} from "./database.js";
import { scheduleResumeAfterRenewalSettlement } from "./delinquency-lifecycle.js";
import { requestFingerprint } from "./idempotency.js";
import { advancePaidInvoice } from "./invoice-settlement.js";
import { assertInvoicePaymentBusinessStateLocked } from "./invoice-payment-eligibility.js";
import { providerSignature } from "./provider-signature.js";
import { runRenewalAutomation } from "./renewal-lifecycle.js";
import {
  AUTOMATIC_RENEWAL_CONSENT_VERSION,
  PAYMENT_METHOD_SAVE_CONSENT_VERSION,
} from "./routes-payment-methods.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for renewal lifecycle integration");

function buildIntegrationConfig(sessionCookieName = "oss_renewal_integration_session"): Config {
  return {
    DATABASE_URL: databaseUrl!,
    OSS_ENV: "test",
    OSS_PUBLIC_URL: "http://127.0.0.1:3000",
    API_HOST: "127.0.0.1",
    API_PORT: 3000,
    GLOBAL_RATE_LIMIT_MAX: 10_000,
    NOTIFICATION_MAX_ATTEMPTS: 3,
    SESSION_COOKIE_NAME: sessionCookieName,
    SESSION_TTL_HOURS: 24,
    VERIFICATION_TTL_MINUTES: 30,
    WEB_ORIGIN: "http://127.0.0.1:5173",
    MOCK_MAILBOX_URL: "http://127.0.0.1:4000",
    LAB_MAILBOX_TOKEN: "manual-action-mailbox-token-0000000000000000",
    PROVIDER_OPERATION_CAPABILITY_SECRET:
      "manual-action-capability-secret-0000000000000000",
    PAYMENT_METHOD_TOKEN_KEY: Buffer.alloc(32, 9).toString("base64url"),
    PAYMENT_METHOD_TOKEN_LOOKUP_KEY: Buffer.alloc(32, 10).toString("base64url"),
    IDENTITY_SECRET_KEY: Buffer.alloc(32, 11).toString("base64url"),
    MOCK_PAYMENT_WEBHOOK_SECRET: "manual-action-payment-secret-000000000000000000",
    MOCK_PROVISIONING_WEBHOOK_SECRET:
      "manual-action-provisioning-secret-0000000000000000",
    LAB_MAILBOX_ENABLED: false,
  };
}

const integrationConfig = buildIntegrationConfig();

const TERM_START = new Date("2001-01-01T01:00:00.000Z");
const TERM_END = new Date("2001-02-01T01:00:00.000Z");
const NEXT_TERM_END = new Date("2001-03-01T01:00:00.000Z");
const AT_MINUS_14 = new Date("2001-01-18T01:00:00.000Z");
const AT_MINUS_7 = new Date("2001-01-25T01:00:00.000Z");
const AT_PLUS_1 = new Date("2001-02-02T01:00:00.000Z");
const CALENDAR_TERM_START = new Date("2001-01-01T15:00:00.000Z");
const CALENDAR_TERM_END = new Date("2001-02-01T15:00:00.000Z");
const CALENDAR_NEXT_TERM_END = new Date("2001-03-01T15:00:00.000Z");

type FixtureAccount = {
  userId: string;
  clientAccountId: string;
};

type FixtureService = FixtureAccount & {
  orderId: string;
  orderItemId: string;
  initialInvoiceId: string;
  serviceId: string;
  recurringMinor: bigint;
};

type RenewalRow = {
  id: string;
  invoice_id: string;
  recurring_minor: string;
  status: "invoiced" | "paid" | "manual_hold";
  funded_at: Date | null;
  settled_at: Date | null;
  period_start: Date;
  period_end: Date;
  total_minor: string;
  allocated_minor: string;
  version: number;
};

async function createFixtureAccount(
  client: DatabaseClient,
  label: string,
): Promise<FixtureAccount> {
  const userId = randomUUID();
  const clientAccountId = randomUUID();
  await client.query(
    `INSERT INTO users(id, email, password_hash, locale, email_verified_at)
     VALUES ($1, $2, 'integration-only-password-hash', 'en', $3)`,
    [userId, `renewal-${label}-${userId}@example.invalid`, TERM_START],
  );
  await client.query(
    `INSERT INTO client_accounts(id, name, owner_user_id)
     VALUES ($1, $2, $3)`,
    [clientAccountId, `Renewal Integration ${label}`, userId],
  );
  await client.query(
    `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
     VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
    [clientAccountId, userId],
  );
  return { userId, clientAccountId };
}

async function createFixtureService(
  client: DatabaseClient,
  account: FixtureAccount,
  input: {
    label: string;
    productId: string;
    recurringMinor: bigint;
    termStart?: Date | string;
    termEnd?: Date | string;
  },
): Promise<FixtureService> {
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const initialInvoiceId = randomUUID();
  const serviceId = randomUUID();
  const termStart = input.termStart ?? TERM_START;
  const termEnd = input.termEnd ?? TERM_END;
  const snapshot = {
    currency: "USD",
    billingCycle: "monthly",
    productId: input.productId,
    productName: `Historical ${input.label}`,
    fulfillmentMode: "automatic",
    components: [
      {
        code: "base",
        label: `Historical ${input.label}`,
        quantity: 1,
        oneTimeMinor: "0",
        recurringMinor: input.recurringMinor.toString(),
      },
    ],
    oneTimeSubtotalMinor: "0",
    setupMinor: "0",
    recurringSubtotalMinor: input.recurringMinor.toString(),
    invoiceTotalMinor: input.recurringMinor.toString(),
  };
  await client.query(
    `INSERT INTO orders(
       id, client_account_id, submitted_by_user_id, status, currency, price_snapshot,
       one_time_minor, setup_minor, recurring_minor, total_minor,
       idempotency_key, request_fingerprint, submitted_at, updated_at
     ) VALUES (
       $1, $2, $3, 'completed', 'USD', $4,
       0, 0, $5, $5, $6, $7, $8, $8
     )`,
    [
      orderId,
      account.clientAccountId,
      account.userId,
      snapshot,
      input.recurringMinor.toString(),
      `renewal-fixture-order:${orderId}`,
      `renewal-fixture-order-fingerprint:${orderId}`,
      termStart,
    ],
  );
  await client.query(
    `INSERT INTO order_items(
       id, order_id, product_id, product_name, fulfillment_mode,
       billing_cycle, configuration, price_snapshot
     ) VALUES ($1, $2, $3, $4, 'automatic', 'monthly', '{}'::jsonb, $5)`,
    [orderItemId, orderId, input.productId, `Historical ${input.label}`, snapshot],
  );
  await client.query(
    `INSERT INTO invoices(id, client_account_id, order_id, currency, total_minor, due_at)
     VALUES ($1, $2, $3, 'USD', 0, $4)`,
    [initialInvoiceId, account.clientAccountId, orderId, termStart],
  );
  await client.query(
    `INSERT INTO services(
       id, client_account_id, order_item_id, status, billing_cycle,
       activated_at, term_start, term_end
     ) VALUES ($1, $2, $3, 'active', 'monthly', $4, $4, $5)`,
    [serviceId, account.clientAccountId, orderItemId, termStart, termEnd],
  );
  await client.query(
    `INSERT INTO service_periods(
       service_id, invoice_id, period_kind, period_start, period_end, granted_at
     ) VALUES ($1, $2, 'initial', $3, $4, $3)`,
    [serviceId, initialInvoiceId, termStart, termEnd],
  );
  return {
    ...account,
    orderId,
    orderItemId,
    initialInvoiceId,
    serviceId,
    recurringMinor: input.recurringMinor,
  };
}

async function grantFixtureCredit(
  client: DatabaseClient,
  account: FixtureAccount,
  amountMinor: bigint,
): Promise<void> {
  const creditAccountId = randomUUID();
  const transactionId = randomUUID();
  await client.query(
    `INSERT INTO credit_accounts(id, client_account_id, currency)
     VALUES ($1, $2, 'USD')`,
    [creditAccountId, account.clientAccountId],
  );
  await client.query(
    `INSERT INTO credit_transactions(
       id, credit_account_id, kind, credit_minor, debit_minor,
       source_type, source_id, actor_type, actor_id, reason,
       idempotency_key, request_fingerprint
     ) VALUES (
       $1, $2, 'manual_adjustment', $3, 0,
       'renewal_integration_fixture', $1, 'system', NULL,
       'Synthetic Credit for renewal lifecycle integration', $4, $5
     )`,
    [
      transactionId,
      creditAccountId,
      amountMinor.toString(),
      `renewal-fixture-credit:${transactionId}`,
      `renewal-fixture-credit-fingerprint:${transactionId}`,
    ],
  );
  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('renewal_integration_credit', $1, 'USD', 'Synthetic integration Credit')
     RETURNING id`,
    [transactionId],
  );
  const journalId = journal.rows[0]?.id;
  assert.ok(journalId);
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'mock_cash', $2, 0),
       ($1, 'client_credit_liability', 0, $2)`,
    [journalId, amountMinor.toString()],
  );
}

async function recordFixturePayment(
  client: DatabaseClient,
  input: {
    clientAccountId: string;
    invoiceId: string;
    amountMinor: bigint;
  },
): Promise<string> {
  const attemptId = randomUUID();
  const receiptId = randomUUID();
  const externalPaymentId = `renewal-integration:${attemptId}`;
  await client.query(
    `INSERT INTO payment_attempts(
       id, client_account_id, invoice_id, provider_installation_id,
       external_payment_id, status, amount_minor, currency, scenario,
       idempotency_key, request_fingerprint
     ) VALUES (
       $1, $2, $3, 'renewal-integration-payment',
       $4, 'succeeded', $5, 'USD', 'success', $6, $7
     )`,
    [
      attemptId,
      input.clientAccountId,
      input.invoiceId,
      externalPaymentId,
      input.amountMinor.toString(),
      `renewal-fixture-payment:${attemptId}`,
      `renewal-fixture-payment-fingerprint:${attemptId}`,
    ],
  );
  await client.query(
    `INSERT INTO fund_receipts(
       id, provider_installation_id, external_payment_id,
       reported_payment_attempt_id, client_account_id,
       amount_minor, allocated_minor, currency, occurred_at, disposition
     ) VALUES (
       $1, 'renewal-integration-payment', $2,
       $3, $4, $5, $5, 'USD', now(), 'allocated'
     )`,
    [
      receiptId,
      externalPaymentId,
      attemptId,
      input.clientAccountId,
      input.amountMinor.toString(),
    ],
  );
  await client.query(
    `INSERT INTO payment_allocations(payment_attempt_id, invoice_id, amount_minor)
     VALUES ($1, $2, $3)`,
    [attemptId, input.invoiceId, input.amountMinor.toString()],
  );
  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('fund_receipt', $1, 'USD', 'Synthetic renewal payment received')
     RETURNING id`,
    [receiptId],
  );
  const journalId = journal.rows[0]?.id;
  assert.ok(journalId);
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'mock_cash', $2, 0),
       ($1, 'accounts_receivable', 0, $2)`,
    [journalId, input.amountMinor.toString()],
  );
  return attemptId;
}

async function recordFixturePaymentWithFee(
  client: DatabaseClient,
  input: {
    clientAccountId: string;
    invoiceId: string;
    principalMinor: bigint;
    feeMinor: bigint;
    feeBasisPoints: number;
    paymentMethodCode: string;
  },
): Promise<string> {
  const attemptId = await recordFixturePayment(client, {
    clientAccountId: input.clientAccountId,
    invoiceId: input.invoiceId,
    amountMinor: input.principalMinor + input.feeMinor,
  });
  await client.query(
    `UPDATE payment_attempts
     SET payment_method_code = $2, principal_minor = $3,
         fee_basis_points = $4, fee_minor = $5
     WHERE id = $1`,
    [
      attemptId,
      input.paymentMethodCode,
      input.principalMinor.toString(),
      input.feeBasisPoints,
      input.feeMinor.toString(),
    ],
  );
  const feeLine = await client.query<{ id: string }>(
    `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
     VALUES ($1, 'payment_fee', 'Synthetic external payment fee', $2)
     RETURNING id`,
    [input.invoiceId, input.feeMinor.toString()],
  );
  const feeLineId = feeLine.rows[0]?.id;
  assert.ok(feeLineId);
  await client.query(
    `INSERT INTO invoice_fee_charges(
       invoice_id, payment_attempt_id, invoice_line_id, payment_method_code,
       basis_minor, basis_points, amount_minor
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.invoiceId,
      attemptId,
      feeLineId,
      input.paymentMethodCode,
      input.principalMinor.toString(),
      input.feeBasisPoints,
      input.feeMinor.toString(),
    ],
  );
  await client.query(
    `UPDATE invoices SET total_minor = total_minor + $2 WHERE id = $1`,
    [input.invoiceId, input.feeMinor.toString()],
  );
  const feeJournal = await client.query<{ id: string }>(
    `INSERT INTO ledger_journals(source_type, source_id, currency, description)
     VALUES ('invoice_payment_fee', $1, 'USD', 'Synthetic external payment fee')
     RETURNING id`,
    [feeLineId],
  );
  const feeJournalId = feeJournal.rows[0]?.id;
  assert.ok(feeJournalId);
  await client.query(
    `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
     VALUES
       ($1, 'accounts_receivable', $2, 0),
       ($1, 'payment_fee_revenue', 0, $2)`,
    [feeJournalId, input.feeMinor.toString()],
  );
  return attemptId;
}

async function loadRenewal(client: DatabaseClient, serviceId: string): Promise<RenewalRow> {
  const result = await client.query<RenewalRow>(
    `SELECT renewal.id, renewal.invoice_id, renewal.recurring_minor::text,
            renewal.status, renewal.funded_at, renewal.settled_at,
            renewal.period_start, renewal.period_end,
            invoice.total_minor::text, allocation.allocated_minor::text,
            renewal.version
     FROM service_renewals renewal
     JOIN invoices invoice ON invoice.id = renewal.invoice_id
     JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
     WHERE renewal.service_id = $1
     ORDER BY renewal.created_at
     LIMIT 1`,
    [serviceId],
  );
  const renewal = result.rows[0];
  assert.ok(renewal, `renewal must exist for service ${serviceId}`);
  return renewal;
}

async function runBillingDay(
  client: DatabaseClient,
  requestedByUserId: string,
  effectiveAt: Date,
  keySuffix: string,
) {
  const idempotencyKey = `renewal-integration-run:${keySuffix}:${randomUUID()}`;
  const reason = `Renewal integration billing day ${keySuffix}`;
  return runRenewalAutomation(client, {
    requestedByUserId,
    reason,
    idempotencyKey,
    requestFingerprint: requestFingerprint("admin.billing-automation-run:v1", {
      reason,
      effectiveAt: effectiveAt.toISOString(),
    }),
    effectiveAt,
  });
}

async function expectDatabaseRejection(
  client: DatabaseClient,
  label: string,
  expectedMessage: RegExp,
  operation: () => Promise<unknown>,
): Promise<void> {
  const savepoint = `renewal_integration_${label.replaceAll(/[^a-z0-9]/gi, "_")}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  assert.ok(caught instanceof Error, `${label} must be rejected by PostgreSQL`);
  assert.match(caught.message, expectedMessage, `${label} must fail for the expected invariant`);
}

async function proveSavedPaymentAuthorizationGuards(
  client: DatabaseClient,
  input: {
    account: FixtureAccount;
    service: FixtureService;
    otherAccount: FixtureAccount;
    otherService: FixtureService;
  },
): Promise<void> {
  const namespace = randomBytes(6).toString("hex");
  const paymentMethodCode = `saved_card_${namespace}`;
  const providerInstallationId = `saved-payment-provider-${namespace}`;
  const savedPaymentMethodId = randomUUID();

  await client.query(
    `INSERT INTO provider_installation_capabilities(
       provider_installation_id, provider_type, enabled, capabilities
     ) VALUES (
       $1, 'payment', true,
       '["payment_create","payment_reconcile","payment_method_setup","payment_off_session"]'::jsonb
     )`,
    [providerInstallationId],
  );
  await client.query(
    `INSERT INTO payment_methods(
       code, display_name, provider_installation_id, fee_basis_points,
       saved_method_enabled, automatic_renewal_enabled
     ) VALUES ($1, '{"en":"Synthetic saved card"}'::jsonb, $2, 350, true, true)`,
    [paymentMethodCode, providerInstallationId],
  );
  await client.query(
    `INSERT INTO saved_payment_methods(
       id, client_account_id, provider_installation_id, payment_method_code,
       provider_token_ciphertext, provider_token_digest, instrument_type,
       brand, last_four, expiry_month, expiry_year, is_default,
       save_consent_version, saved_by_user_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'card',
       'Synthetic Card', '4242', 12, 2099, false,
       'saved-method-consent-v1', $7
     )`,
    [
      savedPaymentMethodId,
      input.account.clientAccountId,
      providerInstallationId,
      paymentMethodCode,
      `integration-only-ciphertext-${"x".repeat(64)}`,
      randomBytes(32),
      input.account.userId,
    ],
  );
  await client.query(
    `UPDATE services
     SET automatic_renewal_consent_generation = 1,
         automatic_renewal_decision_generation = 1,
         version = version + 1
     WHERE id = $1`,
    [input.service.serviceId],
  );
  await expectDatabaseRejection(
    client,
    "payment_automatic_consent_cross_account_service",
    /payment automatic-renewal consent ownership or generation is invalid/i,
    () =>
      client.query(
        `INSERT INTO payment_attempts(
           client_account_id, invoice_id, provider_installation_id,
           status, amount_minor, currency, scenario, idempotency_key,
           request_fingerprint, save_payment_method_requested, save_consent_version,
           automatic_renewal_requested, automatic_renewal_consent_version,
           automatic_renewal_service_id, automatic_renewal_decision_generation
         ) VALUES (
           $1, $2, $3, 'created', 1, 'USD', 'success', $4, $5,
           true, 'saved-method-consent-v1', true, 'automatic-renewal-consent-v1',
           $6, 1
         )`,
        [
          input.otherAccount.clientAccountId,
          input.otherService.initialInvoiceId,
          providerInstallationId,
          `cross-account-auto-consent:${randomUUID()}`,
          "d".repeat(64),
          input.service.serviceId,
        ],
      ),
  );

  await expectDatabaseRejection(
    client,
    "saved_payment_provider_binding",
    /does not support saved Provider tokens/i,
    () =>
      client.query(
        `INSERT INTO saved_payment_methods(
           client_account_id, provider_installation_id, payment_method_code,
           provider_token_ciphertext, provider_token_digest, instrument_type,
           brand, last_four, expiry_month, expiry_year,
           save_consent_version, saved_by_user_id
         ) VALUES (
           $1, $2, $3, $4, $5, 'card',
           'Synthetic Card', '5252', 12, 2099,
           'saved-method-consent-v1', $6
         )`,
        [
          input.account.clientAccountId,
          `${providerInstallationId}-forged`,
          paymentMethodCode,
          `integration-only-ciphertext-${"y".repeat(64)}`,
          randomBytes(32),
          input.account.userId,
        ],
      ),
  );
  await expectDatabaseRejection(
    client,
    "automatic_renewal_generation_monotonic",
    /automatic-renewal generations cannot move backward/i,
    () =>
      client.query(
        `UPDATE services
         SET automatic_renewal_consent_generation = 0,
             automatic_renewal_decision_generation = 0,
             version = version + 1
         WHERE id = $1`,
        [input.service.serviceId],
      ),
  );

  await expectDatabaseRejection(
    client,
    "automatic_renewal_cross_account_binding",
    /automatic renewal ownership or payment method capability is invalid/i,
    () =>
      client.query(
        `INSERT INTO automatic_renewal_authorizations(
           service_id, client_account_id, saved_payment_method_id,
           consent_version, consent_generation, granted_by_user_id
         ) VALUES ($1, $2, $3, 'automatic-renewal-consent-v1', 1, $4)`,
        [
          input.otherService.serviceId,
          input.otherAccount.clientAccountId,
          savedPaymentMethodId,
          input.otherAccount.userId,
        ],
      ),
  );

  const authorization = await client.query<{ id: string }>(
    `INSERT INTO automatic_renewal_authorizations(
       service_id, client_account_id, saved_payment_method_id,
       consent_version, consent_generation, granted_by_user_id
     ) VALUES ($1, $2, $3, 'automatic-renewal-consent-v1', 1, $4)
     RETURNING id`,
    [
      input.service.serviceId,
      input.account.clientAccountId,
      savedPaymentMethodId,
      input.account.userId,
    ],
  );
  assert.ok(authorization.rows[0]?.id);
  await expectDatabaseRejection(
    client,
    "automatic_renewal_one_active_authorization",
    /duplicate key/i,
    () =>
      client.query(
        `INSERT INTO automatic_renewal_authorizations(
           service_id, client_account_id, saved_payment_method_id,
           consent_version, consent_generation, granted_by_user_id
         ) VALUES ($1, $2, $3, 'automatic-renewal-consent-v1', 1, $4)`,
        [
          input.service.serviceId,
          input.account.clientAccountId,
          savedPaymentMethodId,
          input.account.userId,
        ],
      ),
  );

  await client.query(
    `UPDATE payment_methods
     SET automatic_renewal_enabled = false
     WHERE code = $1`,
    [paymentMethodCode],
  );
  await client.query(
    `UPDATE automatic_renewal_authorizations
     SET status = 'revoked', revoked_by_user_id = $2, revoked_at = now(),
         revocation_reason = 'synthetic capability-disabled revocation',
         updated_at = now(), version = version + 1
     WHERE id = $1`,
    [authorization.rows[0]!.id, input.account.userId],
  );
  await client.query(
    `UPDATE payment_methods
     SET automatic_renewal_enabled = true
     WHERE code = $1`,
    [paymentMethodCode],
  );
  const revokedAfterReenable = await client.query<{ status: string }>(
    `SELECT status FROM automatic_renewal_authorizations WHERE id = $1`,
    [authorization.rows[0]!.id],
  );
  assert.equal(
    revokedAfterReenable.rows[0]?.status,
    "revoked",
    "disabling a method must not block revocation or revive consent when re-enabled",
  );

  await client.query(
    `UPDATE services
     SET automatic_renewal_consent_generation = 2,
         automatic_renewal_decision_generation = 2,
         version = version + 1
     WHERE id = $1`,
    [input.service.serviceId],
  );
  await expectDatabaseRejection(
    client,
    "automatic_renewal_stale_consent_generation",
    /automatic renewal ownership or payment method capability is invalid/i,
    () =>
      client.query(
        `INSERT INTO automatic_renewal_authorizations(
           service_id, client_account_id, saved_payment_method_id,
           consent_version, consent_generation, granted_by_user_id
         ) VALUES ($1, $2, $3, 'automatic-renewal-consent-v1', 1, $4)`,
        [
          input.service.serviceId,
          input.account.clientAccountId,
          savedPaymentMethodId,
          input.account.userId,
        ],
      ),
  );

  const consentEventId = randomUUID();
  const consentIdempotencyKey = `saved-method-consent:${randomUUID()}`;
  await client.query(
    `INSERT INTO payment_consent_events(
       id, client_account_id, saved_payment_method_id, event_type,
       consent_version, actor_type, actor_id, reason,
       idempotency_key, request_fingerprint, result
     ) VALUES (
       $1, $2, $3, 'method_saved',
       'saved-method-consent-v1', 'user', $4, 'Synthetic explicit save consent',
       $5, $6, '{"saved":true}'::jsonb
     )`,
    [
      consentEventId,
      input.account.clientAccountId,
      savedPaymentMethodId,
      input.account.userId,
      consentIdempotencyKey,
      "a".repeat(64),
    ],
  );
  await expectDatabaseRejection(client, "payment_consent_idempotency", /duplicate key/i, () =>
    client.query(
      `INSERT INTO payment_consent_events(
         client_account_id, saved_payment_method_id, event_type,
         consent_version, actor_type, actor_id, reason,
         idempotency_key, request_fingerprint, result
       ) VALUES (
         $1, $2, 'method_saved',
         'different-consent-version', 'user', $3, 'Conflicting synthetic replay',
         $4, $5, '{"saved":false}'::jsonb
       )`,
      [
        input.account.clientAccountId,
        savedPaymentMethodId,
        input.account.userId,
        consentIdempotencyKey,
        "b".repeat(64),
      ],
    ),
  );
  await expectDatabaseRejection(client, "payment_consent_append_only", /append-only/i, () =>
    client.query("UPDATE payment_consent_events SET reason = 'forged' WHERE id = $1", [
      consentEventId,
    ]),
  );

  const defaultAttemptId = randomUUID();
  await client.query(
    `INSERT INTO payment_attempts(
       id, client_account_id, invoice_id, provider_installation_id,
       status, amount_minor, currency, scenario, idempotency_key,
       request_fingerprint
     ) VALUES ($1, $2, $3, $4, 'created', 1, 'USD', 'success', $5, $6)`,
    [
      defaultAttemptId,
      input.account.clientAccountId,
      input.service.initialInvoiceId,
      providerInstallationId,
      `saved-payment-defaults:${randomUUID()}`,
      "c".repeat(64),
    ],
  );
  const defaultConsent = await client.query<{
    save_payment_method_requested: boolean;
    save_consent_version: string | null;
    automatic_renewal_requested: boolean;
    automatic_renewal_consent_version: string | null;
    automatic_renewal_decision_generation: string | null;
  }>(
    `SELECT save_payment_method_requested, save_consent_version,
            automatic_renewal_requested, automatic_renewal_consent_version,
            automatic_renewal_decision_generation::text
     FROM payment_attempts WHERE id = $1`,
    [defaultAttemptId],
  );
  assert.deepEqual(defaultConsent.rows[0], {
    save_payment_method_requested: false,
    save_consent_version: null,
    automatic_renewal_requested: false,
    automatic_renewal_consent_version: null,
    automatic_renewal_decision_generation: null,
  });
  await expectDatabaseRejection(
    client,
    "automatic_renewal_requires_explicit_save_consent",
    /payment_attempts_automatic_consent_check/i,
    () =>
      client.query(
        `INSERT INTO payment_attempts(
           client_account_id, invoice_id, provider_installation_id,
           status, amount_minor, currency, scenario, idempotency_key,
           request_fingerprint, automatic_renewal_requested,
           automatic_renewal_consent_version, automatic_renewal_service_id,
           automatic_renewal_decision_generation
         ) VALUES (
           $1, $2, $3, 'created', 1, 'USD', 'success', $4,
           $5, true, 'automatic-renewal-consent-v1', $6, 2
         )`,
        [
          input.account.clientAccountId,
          input.service.initialInvoiceId,
          providerInstallationId,
          `automatic-without-save:${randomUUID()}`,
          "d".repeat(64),
          input.service.serviceId,
        ],
      ),
  );
}

async function createFixtureProduct(
  client: DatabaseClient,
  input: {
    groupId: string;
    productId: string;
    label: string;
    overdueAction: "automatic" | "manual" | "none";
    providerInstallationId?: string;
    delayMode?: "policy_calendar_days" | "exact_hours";
    delayValue?: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO products(
       id, group_id, names, descriptions, fulfillment_mode,
       active, hidden, repeatable, option_schema
     ) VALUES (
       $1, $2, jsonb_build_object('en', $3::text),
       jsonb_build_object('en', $4::text),
       'automatic', true, false, false, '[]'::jsonb
     )`,
    [
      input.productId,
      input.groupId,
      input.label,
      `Synthetic delinquency fixture for ${input.label}`,
    ],
  );
  await client.query(
    `INSERT INTO product_service_automation_policies(
       product_id, overdue_action, provider_installation_id,
       overdue_delay_mode, overdue_delay_value
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      input.productId,
      input.overdueAction,
      input.providerInstallationId ?? null,
      input.delayMode ?? "policy_calendar_days",
      input.delayValue ?? 5,
    ],
  );
}

async function bindFixtureService(
  client: DatabaseClient,
  serviceId: string,
  input: {
    providerInstallationId: string;
    overdueAction?: "automatic" | "manual" | "none";
    capabilities?: string[];
  },
): Promise<void> {
  await client.query(
    `INSERT INTO service_provider_bindings(
       service_id, provider_installation_id, overdue_action_snapshot,
       capability_snapshot, product_policy_version
     ) VALUES ($1, $2, $3, $4, 1)`,
    [
      serviceId,
      input.providerInstallationId,
      input.overdueAction ?? "automatic",
      JSON.stringify(
        input.capabilities ?? [
          "resource_create",
          "resource_reconcile",
          "resource_suspend",
          "resource_resume",
        ],
      ),
    ],
  );
}

async function recordUnsettledFixturePayment(
  client: DatabaseClient,
  input: {
    clientAccountId: string;
    invoiceId: string;
    status: "created" | "processing" | "unknown";
    amountMinor: bigint;
  },
): Promise<string> {
  const attemptId = randomUUID();
  await client.query(
    `INSERT INTO payment_attempts(
       id, client_account_id, invoice_id, provider_installation_id,
       external_payment_id, status, amount_minor, currency, scenario,
       idempotency_key, request_fingerprint
     ) VALUES (
       $1, $2, $3, 'renewal-integration-payment',
       $4, $5, $6, 'USD', 'timeout_success', $7, $8
     )`,
    [
      attemptId,
      input.clientAccountId,
      input.invoiceId,
      `renewal-integration-unsettled:${attemptId}`,
      input.status,
      input.amountMinor.toString(),
      `renewal-fixture-unsettled:${attemptId}`,
      `renewal-fixture-unsettled-fingerprint:${attemptId}`,
    ],
  );
  return attemptId;
}

async function proveLateFeeAssessmentGuards(
  client: DatabaseClient,
  input: {
    invoiceId: string;
    renewalId: string;
    automationRunId: string;
    effectiveAt: Date;
    businessDate: string;
    expectedAmountMinor: bigint;
  },
): Promise<void> {
  const attemptForgery = async (currency: "USD" | "EUR", invoiceTotalDelta: bigint) => {
    const assessmentId = randomUUID();
    const invoiceLineId = randomUUID();
    const journalId = randomUUID();
    await client.query(
      `INSERT INTO invoice_lines(id, invoice_id, kind, description, amount_minor)
       VALUES ($1, $2, 'late_fee', 'Synthetic forged Late Fee', $3)`,
      [invoiceLineId, input.invoiceId, input.expectedAmountMinor.toString()],
    );
    await client.query(
      `UPDATE invoices SET total_minor = total_minor + $2 WHERE id = $1`,
      [input.invoiceId, invoiceTotalDelta.toString()],
    );
    await client.query(
      `INSERT INTO ledger_journals(id, source_type, source_id, currency, description)
       VALUES ($1, 'invoice_late_fee_assessment', $2, $3, 'Synthetic forged Late Fee')`,
      [journalId, assessmentId, currency],
    );
    await client.query(
      `INSERT INTO ledger_lines(journal_id, account_code, debit_minor, credit_minor)
       VALUES
         ($1, 'accounts_receivable', $2, 0),
         ($1, 'late_fee_revenue', 0, $2)`,
      [journalId, input.expectedAmountMinor.toString()],
    );
    await client.query(
      `INSERT INTO invoice_late_fee_assessments(
         id, invoice_id, service_renewal_id, automation_run_id, policy_id,
         business_date, effective_at, timezone, due_business_date, late_fee_days,
         eligible_gross_minor, payment_allocated_minor, credit_allocated_minor,
         allocated_minor, basis_minor, basis_points, amount_minor, disposition,
         invoice_line_id, ledger_journal_id
       ) VALUES (
         $1, $2, $3, $4, 'default',
         $5::date, $6, 'Asia/Shanghai', '2003-02-01'::date, 5,
         800, 0, 0,
         0, 800, 1000, $7, 'charged',
         $8, $9
       )`,
      [
        assessmentId,
        input.invoiceId,
        input.renewalId,
        input.automationRunId,
        input.businessDate,
        input.effectiveAt,
        input.expectedAmountMinor.toString(),
        invoiceLineId,
        journalId,
      ],
    );
  };

  await expectDatabaseRejection(client, "late_fee_wrong_journal_currency", /journal is inconsistent/i, () =>
    attemptForgery("EUR", input.expectedAmountMinor),
  );
  await expectDatabaseRejection(client, "late_fee_wrong_invoice_total", /invoice total/i, () =>
    attemptForgery("USD", input.expectedAmountMinor + 1n),
  );
}

async function proveDelinquencyLifecycle(client: DatabaseClient): Promise<{
  automaticServiceId: string;
  automaticInvoiceId: string;
  lateFeeMinor: string;
  deferralStatuses: string[];
  resumeStatus: string;
}> {
  // The original renewal fixtures have already proven their business outcomes.
  // Remove them from future synthetic billing dates so this cohort is isolated.
  await client.query(
    `UPDATE services
     SET status = 'terminated', updated_at = now(), version = version + 1
     WHERE status = 'active'`,
  );

  const namespace = randomUUID();
  const groupId = `delinquency-integration-group-${namespace}`;
  const providerAutomatic = `delinquency-provider-automatic-${namespace}`;
  const providerAlternate = `delinquency-provider-alternate-${namespace}`;
  const providerDegraded = `delinquency-provider-degraded-${namespace}`;
  const allCapabilities = [
    "resource_create",
    "resource_reconcile",
    "resource_suspend",
    "resource_resume",
  ];
  await client.query(
    `INSERT INTO product_groups(id, sort_order, names)
     VALUES ($1, 9997, '{"en":"Delinquency Integration"}'::jsonb)`,
    [groupId],
  );
  await client.query(
    `INSERT INTO payment_methods(
       code, display_name, provider_installation_id, fee_basis_points
     ) VALUES (
       'renewal_fee_card', '{"en":"Synthetic renewal fee card"}'::jsonb,
       'renewal-integration-payment', 350
     )`,
  );
  for (const providerInstallationId of [
    providerAutomatic,
    providerAlternate,
    providerDegraded,
  ]) {
    await client.query(
      `INSERT INTO provider_installation_capabilities(
         provider_installation_id, provider_type, enabled, capabilities
       ) VALUES ($1, 'provisioning', true, $2::jsonb)`,
      [providerInstallationId, JSON.stringify(allCapabilities)],
    );
  }

  await client.query(
    `UPDATE billing_automation_policies
     SET late_fee_enabled = true,
         late_fee_days = 5,
         late_fee_basis_points = 1000,
         overdue_suspension_enabled = true,
         overdue_suspension_days = 5,
         updated_at = now()
     WHERE id = 'default'`,
  );

  const automaticProductId = `delinquency-auto-${namespace}`;
  const pendingProductId = `delinquency-pending-${namespace}`;
  const colocationProductId = `delinquency-colocation-${namespace}`;
  const capabilityMismatchProductId = `delinquency-capability-mismatch-${namespace}`;
  const policyMismatchProductId = `delinquency-policy-mismatch-${namespace}`;
  await createFixtureProduct(client, {
    groupId,
    productId: automaticProductId,
    label: "Automatic VPS Suspension",
    overdueAction: "automatic",
    providerInstallationId: providerAutomatic,
  });
  await createFixtureProduct(client, {
    groupId,
    productId: pendingProductId,
    label: "Pending Payment Deferral",
    overdueAction: "manual",
  });
  await createFixtureProduct(client, {
    groupId,
    productId: colocationProductId,
    label: "Colocation 72 Hour Grace",
    overdueAction: "manual",
    delayMode: "exact_hours",
    delayValue: 72,
  });
  await createFixtureProduct(client, {
    groupId,
    productId: capabilityMismatchProductId,
    label: "Capability Mismatch",
    overdueAction: "automatic",
    providerInstallationId: providerDegraded,
  });
  await createFixtureProduct(client, {
    groupId,
    productId: policyMismatchProductId,
    label: "Policy Provider Mismatch",
    overdueAction: "automatic",
    providerInstallationId: providerAutomatic,
  });

  const automaticAccount = await createFixtureAccount(client, "delinquency-auto");
  const pendingAccount = await createFixtureAccount(client, "delinquency-pending");
  const colocationAccount = await createFixtureAccount(client, "delinquency-colocation");
  const capabilityMismatchAccount = await createFixtureAccount(
    client,
    "delinquency-capability-mismatch",
  );
  const policyMismatchAccount = await createFixtureAccount(client, "delinquency-policy-mismatch");
  const cohortTermStart = new Date("2003-01-01T15:00:00.000Z");
  const cohortTermEnd = new Date("2003-02-01T15:00:00.000Z");
  const automaticService = await createFixtureService(client, automaticAccount, {
    label: "Automatic VPS Suspension",
    productId: automaticProductId,
    recurringMinor: 1000n,
    termStart: cohortTermStart,
    termEnd: cohortTermEnd,
  });
  const pendingService = await createFixtureService(client, pendingAccount, {
    label: "Pending Payment Deferral",
    productId: pendingProductId,
    recurringMinor: 800n,
    termStart: cohortTermStart,
    termEnd: cohortTermEnd,
  });
  const colocationService = await createFixtureService(client, colocationAccount, {
    label: "Colocation 72 Hour Grace",
    productId: colocationProductId,
    recurringMinor: 1200n,
    termStart: cohortTermStart,
    termEnd: cohortTermEnd,
  });
  const capabilityMismatchService = await createFixtureService(
    client,
    capabilityMismatchAccount,
    {
      label: "Capability Mismatch",
      productId: capabilityMismatchProductId,
      recurringMinor: 900n,
      termStart: cohortTermStart,
      termEnd: cohortTermEnd,
    },
  );
  const policyMismatchService = await createFixtureService(client, policyMismatchAccount, {
    label: "Policy Provider Mismatch",
    productId: policyMismatchProductId,
    recurringMinor: 950n,
    termStart: cohortTermStart,
    termEnd: cohortTermEnd,
  });
  await bindFixtureService(client, automaticService.serviceId, {
    providerInstallationId: providerAutomatic,
  });
  await bindFixtureService(client, capabilityMismatchService.serviceId, {
    providerInstallationId: providerDegraded,
  });
  await bindFixtureService(client, policyMismatchService.serviceId, {
    providerInstallationId: providerAutomatic,
  });
  await client.query(
    `UPDATE services SET external_resource_id = $2 WHERE id = $1`,
    [automaticService.serviceId, `delinquency-resource-${automaticService.serviceId}`],
  );

  // A binding is historical. Losing a currently approved capability or changing
  // the product's Provider later must downgrade automation to a manual case.
  await client.query(
    `UPDATE provider_installation_capabilities
     SET capabilities = '["resource_create","resource_reconcile","resource_suspend"]'::jsonb,
         version = version + 1, updated_at = now()
     WHERE provider_installation_id = $1`,
    [providerDegraded],
  );
  await client.query(
    `UPDATE product_service_automation_policies
     SET provider_installation_id = $2, version = version + 1, updated_at = now()
     WHERE product_id = $1`,
    [policyMismatchProductId, providerAlternate],
  );

  await grantFixtureCredit(client, automaticAccount, 300n);
  const creationRun = await runBillingDay(
    client,
    automaticAccount.userId,
    new Date("2003-01-18T15:00:00.000Z"),
    "delinquency-create",
  );
  assert.equal(creationRun.invoicesCreated, 5);
  const automaticRenewal = await loadRenewal(client, automaticService.serviceId);
  const pendingRenewal = await loadRenewal(client, pendingService.serviceId);
  const colocationRenewal = await loadRenewal(client, colocationService.serviceId);
  const capabilityMismatchRenewal = await loadRenewal(
    client,
    capabilityMismatchService.serviceId,
  );
  const policyMismatchRenewal = await loadRenewal(client, policyMismatchService.serviceId);
  assert.equal(automaticRenewal.allocated_minor, "300");
  await recordFixturePaymentWithFee(client, {
    clientAccountId: automaticAccount.clientAccountId,
    invoiceId: automaticRenewal.invoice_id,
    principalMinor: 200n,
    feeMinor: 7n,
    feeBasisPoints: 350,
    paymentMethodCode: "renewal_fee_card",
  });

  const pendingAttemptIds: string[] = [];
  for (const status of ["created", "processing", "unknown"] as const) {
    pendingAttemptIds.push(
      await recordUnsettledFixturePayment(client, {
        clientAccountId: pendingAccount.clientAccountId,
        invoiceId: pendingRenewal.invoice_id,
        status,
        amountMinor: 800n,
      }),
    );
  }

  const beforeColocationGrace = await runBillingDay(
    client,
    automaticAccount.userId,
    new Date("2003-02-04T14:59:00.000Z"),
    "colocation-before-72-hours",
  );
  assert.equal(beforeColocationGrace.suspensionCasesCreated, 0);
  const colocationBefore = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM service_suspension_cases WHERE service_id = $1`,
    [colocationService.serviceId],
  );
  assert.equal(colocationBefore.rows[0]?.count, "0");

  await runBillingDay(
    client,
    automaticAccount.userId,
    new Date("2003-02-04T16:00:00.000Z"),
    "colocation-after-72-hours",
  );
  const colocationAfter = await client.query<{
    action: string;
    status: string;
    suspension_delay_mode: string;
    suspension_delay_value: number;
    operations: string;
  }>(
    `SELECT suspension_case.action, suspension_case.status,
            suspension_case.suspension_delay_mode,
            suspension_case.suspension_delay_value,
            (SELECT count(*)::text FROM provider_operations operation
             WHERE operation.subject_type = 'service_suspension_case'
               AND operation.subject_id = suspension_case.id) AS operations
     FROM service_suspension_cases suspension_case
     WHERE suspension_case.service_id = $1`,
    [colocationService.serviceId],
  );
  assert.deepEqual(colocationAfter.rows[0], {
    action: "manual",
    status: "manual",
    suspension_delay_mode: "exact_hours",
    suspension_delay_value: 72,
    operations: "0",
  });

  const dayFiveAt = new Date("2003-02-05T16:00:00.000Z");
  const dayFive = await runBillingDay(
    client,
    automaticAccount.userId,
    dayFiveAt,
    "delinquency-day-five",
  );
  assert.equal(dayFive.replayed, false);
  const automaticFee = await client.query<{
    eligible_gross_minor: string;
    payment_allocated_minor: string;
    credit_allocated_minor: string;
    allocated_minor: string;
    basis_minor: string;
    basis_points: number;
    amount_minor: string;
    disposition: string;
    invoice_total_minor: string;
    fee_lines: string;
    journal_currency: string;
    journal_debits: string;
    journal_credits: string;
  }>(
    `SELECT assessment.eligible_gross_minor::text,
            assessment.payment_allocated_minor::text,
            assessment.credit_allocated_minor::text,
            assessment.allocated_minor::text,
            assessment.basis_minor::text,
            assessment.basis_points,
            assessment.amount_minor::text,
            assessment.disposition,
            invoice.total_minor::text AS invoice_total_minor,
            (SELECT count(*)::text FROM invoice_lines line
             WHERE line.invoice_id = invoice.id AND line.kind = 'late_fee') AS fee_lines,
            journal.currency AS journal_currency,
            sum(line.debit_minor)::text AS journal_debits,
            sum(line.credit_minor)::text AS journal_credits
     FROM invoice_late_fee_assessments assessment
     JOIN invoices invoice ON invoice.id = assessment.invoice_id
     JOIN ledger_journals journal ON journal.id = assessment.ledger_journal_id
     JOIN ledger_lines line ON line.journal_id = journal.id
     WHERE assessment.invoice_id = $1
     GROUP BY assessment.id, invoice.id, journal.id`,
    [automaticRenewal.invoice_id],
  );
  assert.deepEqual(automaticFee.rows[0], {
    eligible_gross_minor: "1000",
    payment_allocated_minor: "200",
    credit_allocated_minor: "300",
    allocated_minor: "500",
    basis_minor: "500",
    basis_points: 1000,
    amount_minor: "50",
    disposition: "charged",
    invoice_total_minor: "1057",
    fee_lines: "1",
    journal_currency: "USD",
    journal_debits: "50",
    journal_credits: "50",
  });

  const automaticAction = await client.query<{
    case_id: string;
    renewal_id: string;
    case_status: string;
    action: string;
    operation_id: string;
    operation_status: string;
    stable_key: string;
    jobs: string;
  }>(
    `SELECT suspension_case.id AS case_id,
            suspension_case.service_renewal_id AS renewal_id,
            suspension_case.status AS case_status,
            suspension_case.action,
            operation.id AS operation_id,
            operation.status AS operation_status,
            operation.stable_key,
            (SELECT count(*)::text FROM durable_jobs job
             WHERE job.job_type = 'service.suspend.start'
               AND job.unique_key = operation.stable_key) AS jobs
     FROM service_suspension_cases suspension_case
     JOIN provider_operations operation
       ON operation.subject_type = 'service_suspension_case'
      AND operation.subject_id = suspension_case.id
      AND operation.kind = 'resource_suspend'
     WHERE suspension_case.service_id = $1`,
    [automaticService.serviceId],
  );
  assert.equal(automaticAction.rows.length, 1);
  assert.deepEqual(
    {
      caseStatus: automaticAction.rows[0]?.case_status,
      action: automaticAction.rows[0]?.action,
      operationStatus: automaticAction.rows[0]?.operation_status,
      jobs: automaticAction.rows[0]?.jobs,
    },
    { caseStatus: "suspend_queued", action: "automatic", operationStatus: "queued", jobs: "1" },
  );

  for (const [serviceId, expectedReason] of [
    [capabilityMismatchService.serviceId, "provider_currently_lacks_suspend_or_resume_capability"],
    [policyMismatchService.serviceId, "service_binding_does_not_match_product_provider"],
  ] as const) {
    const mismatch = await client.query<{
      action: string;
      status: string;
      decision_reason: string;
      operations: string;
    }>(
      `SELECT suspension_case.action, suspension_case.status,
              suspension_case.decision_reason,
              (SELECT count(*)::text FROM provider_operations operation
               WHERE operation.subject_type = 'service_suspension_case'
                 AND operation.subject_id = suspension_case.id) AS operations
       FROM service_suspension_cases suspension_case
       WHERE suspension_case.service_id = $1`,
      [serviceId],
    );
    assert.deepEqual(mismatch.rows[0], {
      action: "manual",
      status: "manual",
      decision_reason: expectedReason,
      operations: "0",
    });
  }

  const pendingDeferral = await client.query<{
    pending_payment_snapshot: Array<{ paymentAttemptId: string; status: string }>;
    fees: string;
    cases: string;
  }>(
    `SELECT deferral.pending_payment_snapshot,
            (SELECT count(*)::text FROM invoice_late_fee_assessments assessment
             WHERE assessment.invoice_id = deferral.invoice_id) AS fees,
            (SELECT count(*)::text FROM service_suspension_cases suspension_case
             WHERE suspension_case.invoice_id = deferral.invoice_id) AS cases
     FROM invoice_delinquency_deferrals deferral
     WHERE deferral.invoice_id = $1 AND deferral.automation_run_id = $2`,
    [pendingRenewal.invoice_id, dayFive.runId],
  );
  assert.ok(pendingDeferral.rows[0]);
  const deferralStatuses = pendingDeferral.rows[0].pending_payment_snapshot
    .map((attempt) => attempt.status)
    .sort();
  assert.deepEqual(deferralStatuses, ["created", "processing", "unknown"]);
  assert.equal(pendingDeferral.rows[0].fees, "0");
  assert.equal(pendingDeferral.rows[0].cases, "0");

  const replay = await runBillingDay(
    client,
    automaticAccount.userId,
    dayFiveAt,
    "delinquency-day-five-replay",
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.runId, dayFive.runId);
  const uniqueAutomaticFacts = await client.query<{
    assessments: string;
    cases: string;
    suspend_operations: string;
    suspend_jobs: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM invoice_late_fee_assessments
        WHERE invoice_id = $1) AS assessments,
       (SELECT count(*)::text FROM service_suspension_cases
        WHERE service_id = $2) AS cases,
       (SELECT count(*)::text FROM provider_operations operation
        JOIN service_suspension_cases suspension_case
          ON suspension_case.id = operation.subject_id
         AND operation.subject_type = 'service_suspension_case'
        WHERE suspension_case.service_id = $2
          AND operation.kind = 'resource_suspend') AS suspend_operations,
       (SELECT count(*)::text FROM durable_jobs
        WHERE job_type = 'service.suspend.start'
          AND unique_key = $3) AS suspend_jobs`,
    [automaticRenewal.invoice_id, automaticService.serviceId, automaticAction.rows[0]?.stable_key],
  );
  assert.deepEqual(uniqueAutomaticFacts.rows[0], {
    assessments: "1",
    cases: "1",
    suspend_operations: "1",
    suspend_jobs: "1",
  });

  await proveLateFeeAssessmentGuards(client, {
    invoiceId: pendingRenewal.invoice_id,
    renewalId: pendingRenewal.id,
    automationRunId: dayFive.runId,
    effectiveAt: dayFiveAt,
    businessDate: dayFive.businessDate,
    expectedAmountMinor: 80n,
  });
  await client.query(
    `UPDATE payment_attempts
     SET status = 'failed', updated_at = now(), version = version + 1
     WHERE id = ANY($1::uuid[])`,
    [pendingAttemptIds],
  );
  await runBillingDay(
    client,
    automaticAccount.userId,
    new Date("2003-02-06T16:00:00.000Z"),
    "delinquency-after-payment-failed",
  );
  const pendingAfterFailure = await client.query<{
    fee_minor: string;
    action: string;
    status: string;
  }>(
    `SELECT assessment.amount_minor::text AS fee_minor,
            suspension_case.action, suspension_case.status
     FROM invoice_late_fee_assessments assessment
     JOIN service_suspension_cases suspension_case
       ON suspension_case.invoice_id = assessment.invoice_id
     WHERE assessment.invoice_id = $1`,
    [pendingRenewal.invoice_id],
  );
  assert.deepEqual(pendingAfterFailure.rows[0], {
    fee_minor: "80",
    action: "manual",
    status: "manual",
  });

  const automaticOperation = automaticAction.rows[0];
  assert.ok(automaticOperation);
  await client.query(
    `UPDATE provider_operations
     SET status = 'unknown', attempt_count = 1,
         last_error = 'Synthetic timeout with unknown external outcome', updated_at = now()
     WHERE id = $1`,
    [automaticOperation.operation_id],
  );
  await client.query(
    `UPDATE service_suspension_cases
     SET status = 'suspend_unknown', last_error = 'Synthetic timeout',
         updated_at = now(), version = version + 1
     WHERE id = $1`,
    [automaticOperation.case_id],
  );
  await recordFixturePayment(client, {
    clientAccountId: automaticAccount.clientAccountId,
    invoiceId: automaticRenewal.invoice_id,
    amountMinor: 550n,
  });
  const settledWhileUnknown = await advancePaidInvoice(client, automaticRenewal.invoice_id, {
    kind: "user_command",
    userId: automaticAccount.userId,
  });
  assert.equal(settledWhileUnknown.renewalStatus, "paid");
  assert.equal(settledWhileUnknown.resumeSchedule, "waiting_for_suspend_reconciliation");

  const providerOccurredAt = new Date("2003-02-06T16:05:00.000Z");
  await client.query(
    `UPDATE services
     SET status = 'suspended', updated_at = now(), version = version + 1
     WHERE id = $1`,
    [automaticService.serviceId],
  );
  await client.query(
    `UPDATE provider_operations
     SET status = 'succeeded', provider_occurred_at = $2,
         last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [automaticOperation.operation_id, providerOccurredAt],
  );
  await client.query(
    `UPDATE service_suspension_cases
     SET status = 'suspended', resume_required = true,
         provider_occurred_at = $2, last_error = NULL,
         updated_at = now(), version = version + 1
     WHERE id = $1`,
    [automaticOperation.case_id, providerOccurredAt],
  );
  const resumeStatus = await scheduleResumeAfterRenewalSettlement(client, {
    renewalId: automaticOperation.renewal_id,
    serviceId: automaticService.serviceId,
  });
  assert.equal(resumeStatus, "resume_queued");
  const resumeProof = await client.query<{
    case_status: string;
    resume_required: boolean;
    operations: string;
    jobs: string;
  }>(
    `SELECT suspension_case.status AS case_status,
            suspension_case.resume_required,
            (SELECT count(*)::text FROM provider_operations operation
             WHERE operation.subject_type = 'service_suspension_case'
               AND operation.subject_id = suspension_case.id
               AND operation.kind = 'resource_resume') AS operations,
            (SELECT count(*)::text FROM durable_jobs job
             WHERE job.job_type = 'service.resume.start'
               AND job.unique_key = 'service-suspension-case:' || suspension_case.id || ':resume') AS jobs
     FROM service_suspension_cases suspension_case
     WHERE suspension_case.id = $1`,
    [automaticOperation.case_id],
  );
  assert.deepEqual(resumeProof.rows[0], {
    case_status: "resume_queued",
    resume_required: false,
    operations: "1",
    jobs: "1",
  });

  const mismatchedInvoices = await client.query<{
    id: string;
    total_minor: string;
    line_total_minor: string;
  }>(
    `SELECT invoice.id, invoice.total_minor::text,
            COALESCE(sum(line.amount_minor), 0)::bigint::text AS line_total_minor
     FROM invoices invoice
     LEFT JOIN invoice_lines line ON line.invoice_id = invoice.id
     GROUP BY invoice.id
     HAVING invoice.total_minor <> COALESCE(sum(line.amount_minor), 0)::bigint
     ORDER BY invoice.id`,
  );
  assert.deepEqual(
    mismatchedInvoices.rows,
    [],
    "every invoice total must remain reconstructable from immutable invoice lines",
  );
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  const unbalanced = await client.query<{ id: string }>(
    `SELECT journal.id
     FROM ledger_journals journal
     JOIN ledger_lines line ON line.journal_id = journal.id
     GROUP BY journal.id
     HAVING sum(line.debit_minor - line.credit_minor) <> 0`,
  );
  assert.deepEqual(unbalanced.rows, [], "Late Fee and settlement journals must remain balanced");

  // Keep references live so a product/provider mismatch cannot silently be
  // optimized out of this fixture without changing the assertions above.
  assert.ok(colocationRenewal.id);
  assert.ok(capabilityMismatchRenewal.id);
  assert.ok(policyMismatchRenewal.id);
  return {
    automaticServiceId: automaticService.serviceId,
    automaticInvoiceId: automaticRenewal.invoice_id,
    lateFeeMinor: automaticFee.rows[0]?.amount_minor ?? "",
    deferralStatuses,
    resumeStatus,
  };
}

async function proveManualSuspensionApi(pool: pg.Pool): Promise<void> {
  const setup = await pool.connect();
  const namespace = randomUUID();
  const groupId = `manual-action-group-${namespace}`;
  const manualProductId = `manual-action-colocation-${namespace}`;
  const automaticProductId = `manual-action-vps-${namespace}`;
  // The signed resource-action route is scoped to the configured laboratory
  // Provider installation, so this journey must exercise that exact ownership
  // boundary rather than a fixture-only alias.
  const providerInstallationId = "mock-provisioning-v1";
  const password = "Synthetic-manual-action-password-2026";
  const sessionToken = randomBytes(32).toString("base64url");
  let manualAccount!: FixtureAccount;
  let automaticAccount!: FixtureAccount;
  let staffAccount!: FixtureAccount;
  let manualService!: FixtureService;
  let automaticService!: FixtureService;
  let manualRenewal!: RenewalRow;
  let automaticRenewal!: RenewalRow;
  let manualCaseId = "";
  let automaticCaseId = "";
  let sessionId = "";
  try {
    await setup.query("BEGIN");
    await setup.query(
      `UPDATE billing_automation_policies
       SET late_fee_enabled = true, late_fee_days = 5, late_fee_basis_points = 1000,
           overdue_suspension_enabled = true, overdue_suspension_days = 5,
           updated_at = now()
       WHERE id = 'default'`,
    );
    await setup.query(
      `INSERT INTO product_groups(id, sort_order, names)
       VALUES ($1, 9996, '{"en":"Manual Action API"}'::jsonb)`,
      [groupId],
    );
    await setup.query(
      `INSERT INTO provider_installation_capabilities(
         provider_installation_id, provider_type, enabled, capabilities
       ) VALUES (
         $1, 'provisioning', true,
         '["resource_create","resource_reconcile","resource_suspend","resource_resume"]'::jsonb
       )`,
      [providerInstallationId],
    );
    await createFixtureProduct(setup, {
      groupId,
      productId: manualProductId,
      label: "Colocation Manual Suspension API",
      overdueAction: "manual",
      delayMode: "exact_hours",
      delayValue: 72,
    });
    await createFixtureProduct(setup, {
      groupId,
      productId: automaticProductId,
      label: "Automatic VPS Manual Takeover API",
      overdueAction: "automatic",
      providerInstallationId,
    });
    manualAccount = await createFixtureAccount(setup, "manual-action-colocation");
    automaticAccount = await createFixtureAccount(setup, "manual-action-automatic");
    staffAccount = await createFixtureAccount(setup, "manual-action-staff");
    const termStart = new Date("2004-01-01T15:00:00.000Z");
    const termEnd = new Date("2004-02-01T15:00:00.000Z");
    manualService = await createFixtureService(setup, manualAccount, {
      label: "Colocation Manual Suspension API",
      productId: manualProductId,
      recurringMinor: 1200n,
      termStart,
      termEnd,
    });
    automaticService = await createFixtureService(setup, automaticAccount, {
      label: "Automatic VPS Manual Takeover API",
      productId: automaticProductId,
      recurringMinor: 1000n,
      termStart,
      termEnd,
    });
    await bindFixtureService(setup, automaticService.serviceId, { providerInstallationId });
    await setup.query(
      `UPDATE services SET external_resource_id = $2 WHERE id = $1`,
      [automaticService.serviceId, `manual-action-resource-${automaticService.serviceId}`],
    );
    await runBillingDay(
      setup,
      staffAccount.userId,
      new Date("2004-01-18T15:00:00.000Z"),
      "manual-action-create",
    );
    manualRenewal = await loadRenewal(setup, manualService.serviceId);
    automaticRenewal = await loadRenewal(setup, automaticService.serviceId);
    await runBillingDay(
      setup,
      staffAccount.userId,
      new Date("2004-02-04T16:00:00.000Z"),
      "manual-action-colocation-after-72-hours",
    );
    await runBillingDay(
      setup,
      staffAccount.userId,
      new Date("2004-02-05T16:00:00.000Z"),
      "manual-action-day-five",
    );
    const cases = await setup.query<{
      id: string;
      service_id: string;
      status: string;
      version: number;
    }>(
      `SELECT id, service_id, status, version
       FROM service_suspension_cases
       WHERE service_id = ANY($1::uuid[])`,
      [[manualService.serviceId, automaticService.serviceId]],
    );
    const manualCase = cases.rows.find((row) => row.service_id === manualService.serviceId);
    const automaticCase = cases.rows.find((row) => row.service_id === automaticService.serviceId);
    assert.equal(manualCase?.status, "manual");
    assert.equal(automaticCase?.status, "suspend_queued");
    manualCaseId = manualCase?.id ?? "";
    automaticCaseId = automaticCase?.id ?? "";
    assert.ok(manualCaseId);
    assert.ok(automaticCaseId);
    const providerOccurredAt = new Date("2004-02-05T16:05:00.000Z");
    await setup.query(
      `UPDATE provider_operations
       SET status = 'unknown', attempt_count = 1, provider_occurred_at = $2,
           last_error = 'Synthetic reconciliation exhaustion', updated_at = now()
       WHERE subject_type = 'service_suspension_case'
         AND subject_id = $1 AND kind = 'resource_suspend'`,
      [automaticCaseId, providerOccurredAt],
    );
    await setup.query(
      `UPDATE service_suspension_cases
       SET status = 'manual', provider_occurred_at = $2,
           last_error = 'Synthetic reconciliation exhaustion',
           updated_at = now(), version = version + 1
       WHERE id = $1`,
      [automaticCaseId, providerOccurredAt],
    );

    const passwordDigest = await passwordHash(password);
    await setup.query("UPDATE users SET password_hash = $2 WHERE id = $1", [
      staffAccount.userId,
      passwordDigest,
    ]);
    await setup.query(
      `INSERT INTO staff_members(user_id, roles, permissions)
       VALUES ($1, ARRAY['billing'], '["billing.automation_manage"]'::jsonb)`,
      [staffAccount.userId],
    );
    const session = await setup.query<{ id: string }>(
      `INSERT INTO sessions(user_id, token_digest, expires_at)
       VALUES ($1, $2, now() + interval '1 hour')
       RETURNING id`,
      [staffAccount.userId, digestToken(sessionToken)],
    );
    sessionId = session.rows[0]?.id ?? "";
    assert.ok(sessionId);
    await setup.query("COMMIT");
  } catch (error) {
    await setup.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    setup.release();
  }

  const config = buildIntegrationConfig("oss_manual_action_session");
  const { app } = await buildApp(config, pool);
  await app.ready();
  const request = async (
    path: string,
    input: { method?: string; body?: Record<string, unknown> } = {},
  ) => {
    const response = await app.inject({
      method: input.method ?? "GET",
      url: path,
      headers: { cookie: `${config.SESSION_COOKIE_NAME}=${sessionToken}` },
      ...(input.body ? { payload: input.body } : {}),
    });
    return {
      statusCode: response.statusCode,
      body: response.json() as Record<string, unknown>,
    };
  };
  const actionBody = (
    action: "confirm_suspended" | "confirm_restored",
    reason: string,
    expectedVersion: number,
    idempotencyKey = randomUUID(),
  ) => ({ action, reason, expectedVersion, idempotencyKey });

  try {
    const firstReauth = await request("/api/v1/auth/reauth", {
      method: "POST",
      body: { password },
    });
    assert.equal(firstReauth.statusCode, 200);
    assert.equal(firstReauth.body.fixedWindowMinutes, 15);
    const billingDiscovery = await request("/api/v1/admin/billing/renewals");
    assert.equal(
      billingDiscovery.statusCode,
      200,
      "Billing staff can discover renewal cases but cannot mutate service state",
    );
    const forbidden = await request(
      `/api/v1/admin/billing/delinquency-cases/${manualCaseId}/manual-actions`,
      {
        method: "POST",
        body: actionBody(
          "confirm_suspended",
          "Permission negative test for manual suspension",
          1,
        ),
      },
    );
    assert.equal(forbidden.statusCode, 403);

    await pool.query(
      `UPDATE staff_members
       SET permissions = '["services.suspension_manage"]'::jsonb,
           updated_at = now()
       WHERE user_id = $1`,
      [staffAccount.userId],
    );
    const invalidatedReauth = await request(
      `/api/v1/admin/billing/delinquency-cases/${manualCaseId}/manual-actions`,
      {
        method: "POST",
        body: actionBody(
          "confirm_suspended",
          "Permission change must invalidate password confirmation",
          1,
        ),
      },
    );
    assert.equal(invalidatedReauth.statusCode, 403);
    assert.equal(invalidatedReauth.body.code, "REAUTH_REQUIRED");
    const reauth = await request("/api/v1/auth/reauth", {
      method: "POST",
      body: { password },
    });
    assert.equal(reauth.statusCode, 200);
    assert.equal(reauth.body.fixedWindowMinutes, 15);

    const adminList = await request("/api/v1/admin/billing/renewals");
    assert.equal(adminList.statusCode, 200);
    const listItems = adminList.body.items as Array<{
      serviceId: string;
      delinquency: {
        version: number;
        manualControl: { allowedActions: string[]; impact: Record<string, string> } | null;
      } | null;
    }>;
    const listedManual = listItems.find((item) => item.serviceId === manualService.serviceId);
    const listedAutomatic = listItems.find((item) => item.serviceId === automaticService.serviceId);
    assert.deepEqual(listedManual?.delinquency?.manualControl?.allowedActions, [
      "confirm_suspended",
    ]);
    assert.deepEqual(listedAutomatic?.delinquency?.manualControl?.allowedActions, [
      "confirm_suspended",
    ]);
    assert.match(
      listedManual?.delinquency?.manualControl?.impact.confirmSuspended ?? "",
      /No Provider request is sent/i,
    );

    const manualSuspendKey = randomUUID();
    const manualSuspendBody = actionBody(
      "confirm_suspended",
      "Colocation operator confirmed network and power suspension",
      listedManual?.delinquency?.version ?? 0,
      manualSuspendKey,
    );
    const deadlocksBeforeManualAction = await pool.query<{ deadlocks: string }>(
      `SELECT deadlocks::text
       FROM pg_stat_database
       WHERE datname = current_database()`,
    );
    const settlementBarrier = await pool.connect();
    let manualSuspended!: Awaited<ReturnType<typeof request>>;
    let manualSuspensionPromise: ReturnType<typeof request> | null = null;
    try {
      await settlementBarrier.query("BEGIN");
      await settlementBarrier.query("SET LOCAL lock_timeout = '2s'");
      await settlementBarrier.query(
        "SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE",
        [manualAccount.clientAccountId],
      );
      manualSuspensionPromise = request(
        `/api/v1/admin/billing/delinquency-cases/${manualCaseId}/manual-actions`,
        { method: "POST", body: manualSuspendBody },
      );
      let observedAccountWait = false;
      for (let poll = 0; poll < 150 && !observedAccountWait; poll += 1) {
        const waiting = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query LIKE '%FROM client_accounts WHERE id = $1 FOR UPDATE%'`,
        );
        observedAccountWait = waiting.rows[0]?.count !== "0";
        if (!observedAccountWait) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(
        observedAccountWait,
        true,
        "Staff manual action must wait at Account before taking the renewal Invoice lock",
      );
      await settlementBarrier.query(
        "SELECT id FROM invoices WHERE id = $1 FOR UPDATE",
        [manualRenewal.invoice_id],
      );
      await settlementBarrier.query("COMMIT");
      manualSuspended = await manualSuspensionPromise;
    } catch (error) {
      await settlementBarrier.query("ROLLBACK").catch(() => undefined);
      await manualSuspensionPromise?.catch(() => undefined);
      throw error;
    } finally {
      settlementBarrier.release();
    }
    const deadlocksAfterManualAction = await pool.query<{ deadlocks: string }>(
      `SELECT deadlocks::text
       FROM pg_stat_database
       WHERE datname = current_database()`,
    );
    assert.equal(
      deadlocksAfterManualAction.rows[0]?.deadlocks,
      deadlocksBeforeManualAction.rows[0]?.deadlocks,
    );
    assert.equal(manualSuspended.statusCode, 201);
    assert.equal(manualSuspended.body.serviceStatus, "suspended");
    assert.equal(manualSuspended.body.providerCalled, false);
    const manualSuspendReplay = await request(
      `/api/v1/admin/billing/delinquency-cases/${manualCaseId}/manual-actions`,
      { method: "POST", body: manualSuspendBody },
    );
    assert.equal(manualSuspendReplay.statusCode, 200);
    assert.equal(manualSuspendReplay.body.manualActionId, manualSuspended.body.manualActionId);
    assert.equal(manualSuspendReplay.body.recordedAt, manualSuspended.body.recordedAt);
    assert.equal(manualSuspendReplay.body.replayed, true);
    const manualSuspendConflict = await request(
      `/api/v1/admin/billing/delinquency-cases/${manualCaseId}/manual-actions`,
      {
        method: "POST",
        body: { ...manualSuspendBody, reason: "A materially different operator decision reason" },
      },
    );
    assert.equal(manualSuspendConflict.statusCode, 409);
    assert.equal(manualSuspendConflict.body.code, "IDEMPOTENCY_CONFLICT");
    const staleManualSuspend = await request(
      `/api/v1/admin/billing/delinquency-cases/${manualCaseId}/manual-actions`,
      {
        method: "POST",
        body: actionBody(
          "confirm_suspended",
          "A stale second confirmation must not overwrite the first",
          listedManual?.delinquency?.version ?? 0,
        ),
      },
    );
    assert.equal(staleManualSuspend.statusCode, 409);
    assert.equal(staleManualSuspend.body.code, "VERSION_CONFLICT");

    const automaticVersion = listedAutomatic?.delinquency?.version ?? 0;
    const workerBarrier = await pool.connect();
    let blockedTakeoverPromise:
      | Promise<{ statusCode: number; body: Record<string, unknown> }>
      | null = null;
    try {
      await workerBarrier.query("BEGIN");
      const runningJob = await workerBarrier.query<{ id: string }>(
        `UPDATE durable_jobs job
         SET status = 'running', updated_at = now()
         FROM provider_operations operation
         WHERE operation.subject_type = 'service_suspension_case'
           AND operation.subject_id = $1
           AND operation.kind = 'resource_suspend'
           AND job.job_type = 'service.suspend.start'
           AND job.unique_key = operation.stable_key
           AND job.status = 'pending'
         RETURNING job.id`,
        [automaticCaseId],
      );
      assert.equal(runningJob.rowCount, 1);
      blockedTakeoverPromise = request(
        `/api/v1/admin/billing/delinquency-cases/${automaticCaseId}/manual-actions`,
        {
          method: "POST",
          body: actionBody(
            "confirm_suspended",
            "Concurrent Worker claim must block manual takeover",
            automaticVersion,
          ),
        },
      );
      let requestSettled = false;
      void blockedTakeoverPromise.finally(() => {
        requestSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(requestSettled, false, "manual takeover must wait on the Worker job lock");
      await workerBarrier.query("COMMIT");
      const blockedTakeover = await blockedTakeoverPromise;
      assert.equal(blockedTakeover.statusCode, 409);
      assert.equal(blockedTakeover.body.code, "PROVIDER_JOB_RUNNING");
    } catch (error) {
      await workerBarrier.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      workerBarrier.release();
    }
    await pool.query(
      `UPDATE durable_jobs job
       SET status = 'pending', updated_at = now()
       FROM provider_operations operation
       WHERE operation.subject_type = 'service_suspension_case'
         AND operation.subject_id = $1
         AND operation.kind = 'resource_suspend'
         AND job.job_type = 'service.suspend.start'
         AND job.unique_key = operation.stable_key
         AND job.status = 'running'`,
      [automaticCaseId],
    );
    const automaticSuspendBody = actionBody(
      "confirm_suspended",
      "Operator confirmed the timed-out Provider left the resource suspended",
      automaticVersion,
    );
    const automaticSuspended = await request(
      `/api/v1/admin/billing/delinquency-cases/${automaticCaseId}/manual-actions`,
      {
        method: "POST",
        body: automaticSuspendBody,
      },
    );
    assert.equal(automaticSuspended.statusCode, 201);
    assert.equal(automaticSuspended.body.providerCalled, false);
    assert.equal(automaticSuspended.body.stoppedProviderJobCount, 1);
    const automaticEvidence = automaticSuspended.body.providerOperationEvidence as {
      status: string;
      attemptCount: number;
    };
    assert.equal(automaticEvidence.status, "unknown");
    assert.equal(automaticEvidence.attemptCount, 1);
    const providerTimeAfterTakeover = await pool.query<{
      provider_occurred_at: Date;
      job_status: string;
    }>(
      `SELECT suspension_case.provider_occurred_at,
              job.status AS job_status
       FROM service_suspension_cases suspension_case
       JOIN provider_operations operation
         ON operation.subject_type = 'service_suspension_case'
        AND operation.subject_id = suspension_case.id
        AND operation.kind = 'resource_suspend'
       JOIN durable_jobs job
         ON job.job_type = 'service.suspend.start'
        AND job.unique_key = operation.stable_key
       WHERE suspension_case.id = $1`,
      [automaticCaseId],
    );
    assert.equal(
      providerTimeAfterTakeover.rows[0]?.provider_occurred_at.toISOString(),
      "2004-02-05T16:05:00.000Z",
    );
    assert.equal(providerTimeAfterTakeover.rows[0]?.job_status, "manual");

    const settle = await pool.connect();
    try {
      await settle.query("BEGIN");
      for (const input of [
        { account: manualAccount, renewal: manualRenewal },
        { account: automaticAccount, renewal: automaticRenewal },
      ]) {
        const total = await settle.query<{ due_minor: string }>(
          `SELECT (invoice.total_minor - allocation.allocated_minor)::text AS due_minor
           FROM invoices invoice
           JOIN invoice_allocation_totals allocation ON allocation.invoice_id = invoice.id
           WHERE invoice.id = $1`,
          [input.renewal.invoice_id],
        );
        await recordFixturePayment(settle, {
          clientAccountId: input.account.clientAccountId,
          invoiceId: input.renewal.invoice_id,
          amountMinor: BigInt(total.rows[0]?.due_minor ?? "0"),
        });
        const settlement = await advancePaidInvoice(settle, input.renewal.invoice_id, {
          kind: "user_command",
          userId: input.account.userId,
        });
        assert.equal(settlement.renewalStatus, "paid");
      }
      await settle.query("COMMIT");
    } catch (error) {
      await settle.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      settle.release();
    }

    await pool.query("UPDATE client_accounts SET restricted_at = now() WHERE id = $1", [
      manualAccount.clientAccountId,
    ]);
    const manualRestoreVersion = Number(manualSuspended.body.version);
    const restrictedRestore = await request(
      `/api/v1/admin/billing/delinquency-cases/${manualCaseId}/manual-actions`,
      {
        method: "POST",
        body: actionBody(
          "confirm_restored",
          "Restricted Client Account must block manual restoration",
          manualRestoreVersion,
        ),
      },
    );
    assert.equal(restrictedRestore.statusCode, 409);
    assert.equal(restrictedRestore.body.code, "MANUAL_RESTORATION_BLOCKED");
    await pool.query("UPDATE client_accounts SET restricted_at = NULL WHERE id = $1", [
      manualAccount.clientAccountId,
    ]);
    const manualRestored = await request(
      `/api/v1/admin/billing/delinquency-cases/${manualCaseId}/manual-actions`,
      {
        method: "POST",
        body: actionBody(
          "confirm_restored",
          "Colocation operator confirmed network and power restoration",
          manualRestoreVersion,
        ),
      },
    );
    assert.equal(manualRestored.statusCode, 201);
    assert.equal(manualRestored.body.serviceStatus, "active");
    assert.equal(manualRestored.body.caseStatus, "resolved");

    const automaticResume = await pool.query<{
      operation_id: string;
      case_version: number;
    }>(
      `SELECT operation.id AS operation_id, suspension_case.version AS case_version
       FROM service_suspension_cases suspension_case
       JOIN provider_operations operation
         ON operation.subject_type = 'service_suspension_case'
        AND operation.subject_id = suspension_case.id
        AND operation.kind = 'resource_resume'
       WHERE suspension_case.id = $1`,
      [automaticCaseId],
    );
    const automaticResumeRow = automaticResume.rows[0];
    assert.ok(automaticResumeRow);
    const resumeJobBeforeReplay = await pool.query<{ status: string }>(
      `SELECT job.status
       FROM durable_jobs job
       JOIN provider_operations operation ON operation.stable_key = job.unique_key
       WHERE operation.id = $1 AND job.job_type = 'service.resume.start'`,
      [automaticResumeRow.operation_id],
    );
    assert.equal(resumeJobBeforeReplay.rows[0]?.status, "pending");
    const oldSuspendReplayAfterSettlement = await request(
      `/api/v1/admin/billing/delinquency-cases/${automaticCaseId}/manual-actions`,
      { method: "POST", body: automaticSuspendBody },
    );
    assert.equal(oldSuspendReplayAfterSettlement.statusCode, 200);
    assert.equal(oldSuspendReplayAfterSettlement.body.replayed, true);
    const resumeJobAfterReplay = await pool.query<{ status: string }>(
      `SELECT job.status
       FROM durable_jobs job
       JOIN provider_operations operation ON operation.stable_key = job.unique_key
       WHERE operation.id = $1 AND job.job_type = 'service.resume.start'`,
      [automaticResumeRow.operation_id],
    );
    assert.equal(
      resumeJobAfterReplay.rows[0]?.status,
      "pending",
      "an old suspension replay must not stop the later resume job",
    );
    const resumeOccurredAt = new Date(Date.now() + 1_000);
    await pool.query("UPDATE client_accounts SET restricted_at = now() WHERE id = $1", [
      automaticAccount.clientAccountId,
    ]);
    const startedResumeOperation = await pool.query(
      `UPDATE provider_operations
       SET status = 'running', attempt_count = 1, updated_at = now()
       WHERE id = $1 AND status = 'queued'`,
      [automaticResumeRow.operation_id],
    );
    assert.equal(startedResumeOperation.rowCount, 1);
    const runningResumeJob = await pool.query(
      `UPDATE durable_jobs job
       SET status = 'running', attempts = attempts + 1,
           locked_at = now(), locked_by = 'integration-resource-action-callback',
           updated_at = now()
       FROM provider_operations operation
       WHERE operation.id = $1
         AND job.job_type = 'service.resume.start'
         AND job.unique_key = operation.stable_key
         AND job.status = 'pending'`,
      [automaticResumeRow.operation_id],
    );
    assert.equal(runningResumeJob.rowCount, 1);
    const externalResourceId = `manual-action-resource-${automaticService.serviceId}`;
    const resumeCallbackBody = {
      eventId: `resume-restricted-${automaticCaseId}`,
      providerOperationId: automaticResumeRow.operation_id,
      callbackCapability: providerOperationCapability(
        config.PROVIDER_OPERATION_CAPABILITY_SECRET,
        "mock-provisioning-v1",
        automaticResumeRow.operation_id,
      ),
      serviceId: automaticService.serviceId,
      externalResourceId,
      action: "resume",
      status: "succeeded",
      occurredAt: resumeOccurredAt.toISOString(),
    };
    const resumeCallbackTimestamp = Date.now().toString();
    const injectResumeCallback = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/provider-events/resource-action",
        headers: {
          "x-oss-timestamp": resumeCallbackTimestamp,
          "x-oss-signature": providerSignature(
            config.MOCK_PROVISIONING_WEBHOOK_SECRET,
            resumeCallbackTimestamp,
            resumeCallbackBody,
          ),
        },
        payload: resumeCallbackBody,
      });
    const deadlocksBeforeCallbackBarrier = await pool.query<{ deadlocks: string }>(
      `SELECT deadlocks::text
       FROM pg_stat_database
       WHERE datname = current_database()`,
    );
    const invoiceBarrier = await pool.connect();
    const workerFirst = await pool.connect();
    const workerFollower = await pool.connect();
    let resumeCallbackPromise: ReturnType<typeof injectResumeCallback> | null = null;
    let workerFollowerPromise: Promise<void> | null = null;
    let resumeCallback!: Awaited<ReturnType<typeof injectResumeCallback>>;
    try {
      await invoiceBarrier.query("BEGIN");
      await invoiceBarrier.query("SET LOCAL lock_timeout = '2s'");
      await invoiceBarrier.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
        automaticRenewal.invoice_id,
      ]);

      await workerFirst.query("BEGIN");
      await workerFirst.query("SET LOCAL lock_timeout = '2s'");
      await workerFirst.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
        automaticAccount.userId,
      ]);
      await workerFirst.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
        automaticAccount.clientAccountId,
      ]);
      await workerFirst.query(
        `SELECT user_id
         FROM client_memberships
         WHERE client_account_id = $1 AND user_id = $2
         FOR UPDATE`,
        [automaticAccount.clientAccountId, automaticAccount.userId],
      );

      resumeCallbackPromise = injectResumeCallback();
      let callbackWaitedOnIdentity = false;
      for (let poll = 0; poll < 150 && !callbackWaitedOnIdentity; poll += 1) {
        const waiting = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query LIKE '%SELECT id FROM users WHERE id = $1 FOR UPDATE%'`,
        );
        callbackWaitedOnIdentity = waiting.rows[0]?.count !== "0";
        if (!callbackWaitedOnIdentity) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(
        callbackWaitedOnIdentity,
        true,
        "Provider callback must wait on the submitted User before taking the Provider advisory lock",
      );
      await workerFirst.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`provider-operation:${automaticResumeRow.operation_id}`],
      );
      await workerFirst.query("COMMIT");

      let callbackWaitedOnInvoice = false;
      for (let poll = 0; poll < 150 && !callbackWaitedOnInvoice; poll += 1) {
        const waiting = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query LIKE '%SELECT id FROM invoices WHERE id = $1 FOR UPDATE%'`,
        );
        callbackWaitedOnInvoice = waiting.rows[0]?.count !== "0";
        if (!callbackWaitedOnInvoice) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(
        callbackWaitedOnInvoice,
        true,
        "Provider callback must hold User and Account before waiting on the renewal Invoice",
      );

      workerFollowerPromise = (async () => {
        await workerFollower.query("BEGIN");
        await workerFollower.query("SET LOCAL lock_timeout = '2s'");
        await workerFollower.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
          automaticAccount.userId,
        ]);
        await workerFollower.query(
          "SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE",
          [automaticAccount.clientAccountId],
        );
        await workerFollower.query(
          `SELECT user_id
           FROM client_memberships
           WHERE client_account_id = $1 AND user_id = $2
           FOR UPDATE`,
          [automaticAccount.clientAccountId, automaticAccount.userId],
        );
        await workerFollower.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`provider-operation:${automaticResumeRow.operation_id}`],
        );
        await workerFollower.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
          automaticRenewal.invoice_id,
        ]);
        await workerFollower.query("COMMIT");
      })();
      let workerWaitedOnIdentity = false;
      for (let poll = 0; poll < 150 && !workerWaitedOnIdentity; poll += 1) {
        const waiting = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query LIKE '%SELECT id FROM users WHERE id = $1 FOR UPDATE%'`,
        );
        workerWaitedOnIdentity = waiting.rows[0]?.count !== "0";
        if (!workerWaitedOnIdentity) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(
        workerWaitedOnIdentity,
        true,
        "Worker preflight must wait at User while the callback owns the canonical lock prefix",
      );
      await invoiceBarrier.query("COMMIT");
      resumeCallback = await resumeCallbackPromise;
      await workerFollowerPromise;
    } catch (error) {
      await Promise.all([
        invoiceBarrier.query("ROLLBACK").catch(() => undefined),
        workerFirst.query("ROLLBACK").catch(() => undefined),
        workerFollower.query("ROLLBACK").catch(() => undefined),
      ]);
      await resumeCallbackPromise?.catch(() => undefined);
      await workerFollowerPromise?.catch(() => undefined);
      throw error;
    } finally {
      invoiceBarrier.release();
      workerFirst.release();
      workerFollower.release();
    }
    const deadlocksAfterCallbackBarrier = await pool.query<{ deadlocks: string }>(
      `SELECT deadlocks::text
       FROM pg_stat_database
       WHERE datname = current_database()`,
    );
    assert.equal(
      deadlocksAfterCallbackBarrier.rows[0]?.deadlocks,
      deadlocksBeforeCallbackBarrier.rows[0]?.deadlocks,
    );
    assert.equal(resumeCallback.statusCode, 202);
    assert.deepEqual(resumeCallback.json(), {
      accepted: true,
      status: "manual",
      eligibilityHold: true,
    });
    const completedResumeJob = await pool.query(
      `UPDATE durable_jobs job
       SET status = 'completed', locked_at = NULL, locked_by = NULL, updated_at = now()
       FROM provider_operations operation
       WHERE operation.id = $1
         AND job.job_type = 'service.resume.start'
         AND job.unique_key = operation.stable_key
         AND job.status = 'running'`,
      [automaticResumeRow.operation_id],
    );
    assert.equal(completedResumeJob.rowCount, 1);
    const automaticManualVersion = automaticResumeRow.case_version + 1;
    const blockedEligibilityHoldList = await request("/api/v1/admin/billing/renewals");
    assert.equal(blockedEligibilityHoldList.statusCode, 200);
    const blockedEligibilityHoldItems = blockedEligibilityHoldList.body.items as typeof listItems;
    const blockedEligibilityHold = blockedEligibilityHoldItems.find(
      (item) => item.serviceId === automaticService.serviceId,
    );
    assert.deepEqual(blockedEligibilityHold?.delinquency?.manualControl?.allowedActions, []);
    const restrictedEligibilityRestore = await request(
      `/api/v1/admin/billing/delinquency-cases/${automaticCaseId}/manual-actions`,
      {
        method: "POST",
        body: actionBody(
          "confirm_restored",
          "Restricted account must keep the Provider-restored service on hold",
          automaticManualVersion,
        ),
      },
    );
    assert.equal(restrictedEligibilityRestore.statusCode, 409);
    assert.equal(restrictedEligibilityRestore.body.code, "MANUAL_RESTORATION_BLOCKED");
    await pool.query("UPDATE client_accounts SET restricted_at = NULL WHERE id = $1", [
      automaticAccount.clientAccountId,
    ]);
    const eligibleHoldList = await request("/api/v1/admin/billing/renewals");
    assert.equal(eligibleHoldList.statusCode, 200);
    const eligibleHoldItems = eligibleHoldList.body.items as typeof listItems;
    const eligibleHold = eligibleHoldItems.find(
      (item) => item.serviceId === automaticService.serviceId,
    );
    assert.deepEqual(eligibleHold?.delinquency?.manualControl?.allowedActions, [
      "confirm_restored",
    ]);
    const automaticRestoreBody = actionBody(
      "confirm_restored",
      "Operator confirmed the Provider-restored eligibility Hold is safe to release",
      automaticManualVersion,
    );
    const automaticRestored = await request(
      `/api/v1/admin/billing/delinquency-cases/${automaticCaseId}/manual-actions`,
      {
        method: "POST",
        body: automaticRestoreBody,
      },
    );
    assert.equal(automaticRestored.statusCode, 201);
    assert.equal(automaticRestored.body.serviceStatus, "active");
    assert.equal(automaticRestored.body.providerCalled, false);
    const resumeEvidence = automaticRestored.body.providerOperationEvidence as {
      kind: string;
      status: string;
    };
    assert.deepEqual(resumeEvidence, {
      ...resumeEvidence,
      kind: "resource_resume",
      status: "succeeded",
    });
    const restoredEligibilityFacts = await pool.query<{
      provider_occurred_at: Date;
      previous_service_status: string;
      provider_operation_status: string;
      result_evidence_status: string;
    }>(
      `SELECT suspension_case.provider_occurred_at,
              manual_action.previous_service_status,
              manual_action.provider_operation_status,
              manual_action.result->'providerOperationEvidence'->>'status'
                AS result_evidence_status
       FROM service_suspension_cases suspension_case
       JOIN service_suspension_manual_actions manual_action
         ON manual_action.service_suspension_case_id = suspension_case.id
        AND manual_action.action = 'confirm_restored'
       WHERE suspension_case.id = $1`,
      [automaticCaseId],
    );
    assert.equal(
      restoredEligibilityFacts.rows[0]?.provider_occurred_at.toISOString(),
      resumeOccurredAt.toISOString(),
    );
    assert.equal(restoredEligibilityFacts.rows[0]?.previous_service_status, "provisioned_hold");
    assert.equal(restoredEligibilityFacts.rows[0]?.provider_operation_status, "succeeded");
    assert.equal(restoredEligibilityFacts.rows[0]?.result_evidence_status, "succeeded");
    const automaticRestoreReplay = await request(
      `/api/v1/admin/billing/delinquency-cases/${automaticCaseId}/manual-actions`,
      { method: "POST", body: automaticRestoreBody },
    );
    assert.equal(automaticRestoreReplay.statusCode, 200);
    assert.equal(automaticRestoreReplay.body.replayed, true);
    assert.equal(automaticRestoreReplay.body.providerCalled, false);
    assert.equal(automaticRestoreReplay.body.manualActionId, automaticRestored.body.manualActionId);

    const actionFacts = await pool.query<{
      count: string;
      audits: string;
      provider_called: string;
    }>(
      `SELECT
         count(*)::text AS count,
         (SELECT count(*)::text FROM audit_events audit
          WHERE audit.target_type = 'service_suspension_case'
            AND audit.target_id = ANY($1::text[])
            AND audit.action IN (
              'service.manual_suspension_confirmed',
              'service.manual_restoration_confirmed'
            )) AS audits,
         count(*) FILTER (WHERE result->>'providerCalled' <> 'false')::text AS provider_called
       FROM service_suspension_manual_actions
       WHERE service_suspension_case_id::text = ANY($1::text[])`,
      [[manualCaseId, automaticCaseId]],
    );
    assert.deepEqual(actionFacts.rows[0], { count: "4", audits: "4", provider_called: "0" });
    await assert.rejects(
      pool.query(
        `UPDATE service_suspension_manual_actions
         SET reason = 'forged mutable operator record'
         WHERE service_suspension_case_id = $1`,
        [manualCaseId],
      ),
      /immutable|append-only|financial facts/i,
    );
  } finally {
    await app.close();
  }
}

async function provePaymentSettingsDecisionConflicts(pool: pg.Pool): Promise<void> {
  const setup = await pool.connect();
  const namespace = randomUUID();
  const groupId = `payment-settings-group-${namespace}`;
  const productId = `payment-settings-product-${namespace}`;
  const ownerSessionToken = randomBytes(32).toString("base64url");
  const billingSessionToken = randomBytes(32).toString("base64url");
  const ownerPassword = `Synthetic-Owner-${namespace}!`;
  const billingPassword = `Synthetic-Billing-${namespace}!`;
  let owner!: FixtureAccount;
  let billingUserId = "";
  let service!: FixtureService;
  let callbackService!: FixtureService;
  let renewalInvoiceId = "";
  let callbackRenewalInvoiceId = "";
  let methodAId = "";
  let methodCId = "";
  let authorizationAId = "";
  let callbackAuthorizationAId = "";
  try {
    await setup.query("BEGIN");
    await setup.query(
      `INSERT INTO product_groups(id, sort_order, names)
       VALUES ($1, 9996, '{"en":"Payment Settings Integration"}'::jsonb)`,
      [groupId],
    );
    await createFixtureProduct(setup, {
      groupId,
      productId,
      label: "Payment Settings Concurrency Product",
      overdueAction: "none",
    });
    owner = await createFixtureAccount(setup, "payment-settings-owner");
    const ownerHash = await passwordHash(ownerPassword);
    await setup.query("UPDATE users SET password_hash = $2 WHERE id = $1", [
      owner.userId,
      ownerHash,
    ]);
    const billingUser = await setup.query<{ id: string }>(
      `INSERT INTO users(email, password_hash, locale, email_verified_at)
       VALUES ($1, $2, 'en', now())
       RETURNING id`,
      [`billing-${namespace}@example.invalid`, await passwordHash(billingPassword)],
    );
    billingUserId = billingUser.rows[0]?.id ?? "";
    assert.ok(billingUserId);
    await setup.query(
      `INSERT INTO client_memberships(client_account_id, user_id, role, permissions)
       VALUES ($1, $2, 'billing', '["billing.read","billing.write"]'::jsonb)`,
      [owner.clientAccountId, billingUserId],
    );
    const ownerSession = await setup.query<{ id: string }>(
      `INSERT INTO sessions(
         user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES ($1, $2, now() + interval '1 hour', $3, 1)
       RETURNING id`,
      [owner.userId, digestToken(ownerSessionToken), owner.clientAccountId],
    );
    const billingSession = await setup.query<{ id: string }>(
      `INSERT INTO sessions(
         user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES ($1, $2, now() + interval '1 hour', $3, 1)
       RETURNING id`,
      [billingUserId, digestToken(billingSessionToken), owner.clientAccountId],
    );
    await setup.query(
      `INSERT INTO reauth_grants(user_id, session_id, expires_at)
       VALUES
         ($1, $2, now() + interval '15 minutes'),
         ($3, $4, now() + interval '15 minutes')`,
      [
        owner.userId,
        ownerSession.rows[0]!.id,
        billingUserId,
        billingSession.rows[0]!.id,
      ],
    );
    service = await createFixtureService(setup, owner, {
      label: "Payment Settings Service",
      productId,
      recurringMinor: 1_000n,
      termStart: new Date("2012-01-01T01:00:00.000Z"),
      termEnd: new Date("2012-02-01T01:00:00.000Z"),
    });
    callbackService = await createFixtureService(setup, owner, {
      label: "Payment Callback Reconciliation Service",
      productId,
      recurringMinor: 1_500n,
      termStart: new Date("2013-01-01T01:00:00.000Z"),
      termEnd: new Date("2013-02-01T01:00:00.000Z"),
    });
    const automationRun = await setup.query<{ id: string }>(
      `INSERT INTO billing_automation_runs(
         policy_id, business_date, effective_at, requested_by_user_id,
         reason, invoices_created, reminders_created
       ) VALUES (
         'default', '2012-01-18', '2012-01-18T01:00:00.000Z', $1,
         'Synthetic payment settings decision conflict fixture', 1, 0
       ) RETURNING id`,
      [owner.userId],
    );
    const renewalInvoice = await setup.query<{ id: string }>(
      `INSERT INTO invoices(client_account_id, currency, total_minor, due_at)
       VALUES ($1, 'USD', 1000, '2012-02-01T01:00:00.000Z')
       RETURNING id`,
      [owner.clientAccountId],
    );
    renewalInvoiceId = renewalInvoice.rows[0]?.id ?? "";
    assert.ok(renewalInvoiceId);
    const callbackRenewalInvoice = await setup.query<{ id: string }>(
      `INSERT INTO invoices(client_account_id, currency, total_minor, due_at)
       VALUES ($1, 'USD', 1500, '2013-02-01T01:00:00.000Z')
       RETURNING id`,
      [owner.clientAccountId],
    );
    callbackRenewalInvoiceId = callbackRenewalInvoice.rows[0]?.id ?? "";
    assert.ok(callbackRenewalInvoiceId);
    await setup.query(
      `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
       VALUES
         ($1, 'recurring', 'Synthetic renewal for payment settings', 1000),
         ($2, 'recurring', 'Synthetic renewal for callback reconciliation', 1500)`,
      [renewalInvoiceId, callbackRenewalInvoiceId],
    );
    await setup.query(
      `INSERT INTO service_renewals(
         service_id, invoice_id, automation_run_id, period_start, period_end,
         recurring_minor, currency, price_snapshot
       ) VALUES (
         $1, $2, $3, '2012-02-01T01:00:00.000Z', '2012-03-01T01:00:00.000Z',
         1000, 'USD', $4
       )`,
      [
        service.serviceId,
        renewalInvoiceId,
        automationRun.rows[0]!.id,
        {
          currency: "USD",
          billingCycle: "monthly",
          productId,
          productName: "Payment Settings Concurrency Product",
          recurringSubtotalMinor: "1000",
        },
      ],
    );
    await setup.query(
      `INSERT INTO service_renewals(
         service_id, invoice_id, automation_run_id, period_start, period_end,
         recurring_minor, currency, price_snapshot
       ) VALUES (
         $1, $2, $3, '2013-02-01T01:00:00.000Z', '2013-03-01T01:00:00.000Z',
         1500, 'USD', $4
       )`,
      [
        callbackService.serviceId,
        callbackRenewalInvoiceId,
        automationRun.rows[0]!.id,
        {
          currency: "USD",
          billingCycle: "monthly",
          productId,
          productName: "Payment Callback Reconciliation Product",
          recurringSubtotalMinor: "1500",
        },
      ],
    );
    await setup.query(
      `INSERT INTO provider_installation_capabilities(
         provider_installation_id, provider_type, enabled, capabilities
       ) VALUES (
         'mock-payment-v1', 'payment', true,
         '["payment_create","payment_reconcile","payment_method_setup","payment_off_session"]'::jsonb
       )
       ON CONFLICT (provider_installation_id) DO UPDATE SET
         provider_type = EXCLUDED.provider_type,
         enabled = EXCLUDED.enabled,
         capabilities = EXCLUDED.capabilities`,
    );
    await setup.query(
      `INSERT INTO payment_methods(
         code, display_name, provider_installation_id, fee_basis_points,
         enabled, saved_method_enabled, automatic_renewal_enabled
       ) VALUES (
         'card', '{"en":"Card (Mock)"}'::jsonb, 'mock-payment-v1', 350,
         true, true, true
       )
       ON CONFLICT (code) DO UPDATE SET
         provider_installation_id = EXCLUDED.provider_installation_id,
         enabled = true, saved_method_enabled = true,
         automatic_renewal_enabled = true`,
    );
    const savedMethods = await setup.query<{ id: string; last_four: string }>(
      `INSERT INTO saved_payment_methods(
         client_account_id, provider_installation_id, payment_method_code,
         provider_token_ciphertext, provider_token_digest, instrument_type,
         brand, last_four, expiry_month, expiry_year, is_default,
         save_consent_version, saved_by_user_id
       ) VALUES
         ($1, 'mock-payment-v1', 'card', $2, $3, 'card', 'Mock A', '1111', 12, 2099,
          true, $4, $5),
         ($1, 'mock-payment-v1', 'card', $6, $7, 'card', 'Mock C', '3333', 12, 2099,
          false, $4, $5)
       RETURNING id, last_four`,
      [
        owner.clientAccountId,
        `integration-only-ciphertext-${"a".repeat(64)}`,
        randomBytes(32),
        PAYMENT_METHOD_SAVE_CONSENT_VERSION,
        owner.userId,
        `integration-only-ciphertext-${"c".repeat(64)}`,
        randomBytes(32),
      ],
    );
    methodAId = savedMethods.rows.find((row) => row.last_four === "1111")?.id ?? "";
    methodCId = savedMethods.rows.find((row) => row.last_four === "3333")?.id ?? "";
    assert.ok(methodAId && methodCId);
    await setup.query(
      `UPDATE services
       SET automatic_renewal_consent_generation = 1,
           automatic_renewal_decision_generation = 1,
           version = version + 1
       WHERE id = ANY($1::uuid[])`,
      [[service.serviceId, callbackService.serviceId]],
    );
    const authorizations = await setup.query<{ id: string; service_id: string }>(
      `INSERT INTO automatic_renewal_authorizations(
         service_id, client_account_id, saved_payment_method_id,
         consent_version, consent_generation, granted_by_user_id
       ) VALUES
         ($1, $3, $4, $5, 1, $6),
         ($2, $3, $4, $5, 1, $6)
       RETURNING id, service_id`,
      [
        service.serviceId,
        callbackService.serviceId,
        owner.clientAccountId,
        methodAId,
        AUTOMATIC_RENEWAL_CONSENT_VERSION,
        owner.userId,
      ],
    );
    authorizationAId =
      authorizations.rows.find((row) => row.service_id === service.serviceId)?.id ?? "";
    callbackAuthorizationAId =
      authorizations.rows.find((row) => row.service_id === callbackService.serviceId)?.id ?? "";
    assert.ok(authorizationAId && callbackAuthorizationAId);
    await setup.query("COMMIT");
  } catch (error) {
    await setup.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    setup.release();
  }

  const config = buildIntegrationConfig("oss_payment_settings_integration");
  const { app } = await buildApp(config, pool);
  await app.ready();
  const request = async (
    sessionToken: string,
    path: string,
    input: { method?: string; body?: Record<string, unknown> } = {},
  ) => {
    const response = await app.inject({
      method: input.method ?? "GET",
      url: path,
      headers: {
        cookie: `${config.SESSION_COOKIE_NAME}=${sessionToken}`,
        "x-oss-account-context-version": "1",
      },
      ...(input.body ? { payload: input.body } : {}),
    });
    return {
      statusCode: response.statusCode,
      body: response.json() as Record<string, any>,
    };
  };
  try {
    const staleSettings = await request(
      billingSessionToken,
      "/api/v1/billing/payment-settings",
    );
    assert.equal(staleSettings.statusCode, 200);
    assert.equal(
      staleSettings.body.serviceDecisions.find(
        (row: { serviceId: string }) => row.serviceId === service.serviceId,
      )?.decisionGeneration,
      "1",
    );
    const quote = await request(
      ownerSessionToken,
      `/api/v1/invoices/${renewalInvoiceId}/payment-quotes`,
      { method: "POST", body: { paymentMethod: "card", applyCredit: false } },
    );
    assert.equal(quote.statusCode, 201);
    const pendingPayment = await request(
      ownerSessionToken,
      `/api/v1/invoices/${renewalInvoiceId}/payments`,
      {
        method: "POST",
        body: {
          quoteId: quote.body.quoteId,
          scenario: "success",
          savePaymentMethod: true,
          saveConsentVersion: PAYMENT_METHOD_SAVE_CONSENT_VERSION,
          enableAutomaticRenewal: true,
          automaticRenewalConsentVersion: AUTOMATIC_RENEWAL_CONSENT_VERSION,
          idempotencyKey: `pending-payment-${namespace}`,
        },
      },
    );
    assert.equal(pendingPayment.statusCode, 202);
    const currentSettings = await request(
      ownerSessionToken,
      "/api/v1/billing/payment-settings",
    );
    const pending = currentSettings.body.pendingAutomaticRenewals[0] as {
      paymentAttemptId: string;
      decisionGeneration: string;
    };
    assert.equal(pending.decisionGeneration, "2");

    const callbackQuote = await request(
      ownerSessionToken,
      `/api/v1/invoices/${callbackRenewalInvoiceId}/payment-quotes`,
      { method: "POST", body: { paymentMethod: "card", applyCredit: false } },
    );
    assert.equal(callbackQuote.statusCode, 201);
    const callbackPayment = await request(
      ownerSessionToken,
      `/api/v1/invoices/${callbackRenewalInvoiceId}/payments`,
      {
        method: "POST",
        body: {
          quoteId: callbackQuote.body.quoteId,
          scenario: "timeout_success",
          savePaymentMethod: true,
          saveConsentVersion: PAYMENT_METHOD_SAVE_CONSENT_VERSION,
          enableAutomaticRenewal: true,
          automaticRenewalConsentVersion: AUTOMATIC_RENEWAL_CONSENT_VERSION,
          idempotencyKey: `callback-payment-${namespace}`,
        },
      },
    );
    assert.equal(callbackPayment.statusCode, 202);
    const callbackAttemptId = String(callbackPayment.body.paymentAttemptId);
    const callbackPointer = await pool.query<{
      operation_id: string;
      amount_minor: string;
      currency: string;
      command_id: string;
    }>(
      `SELECT operation.id AS operation_id,
              attempt.amount_minor::text,
              attempt.currency,
              command.id AS command_id
       FROM payment_attempts attempt
       JOIN provider_operations operation
         ON operation.subject_type = 'payment'
        AND operation.subject_id = attempt.id
        AND operation.kind = 'payment_create'
       JOIN invoice_payment_commands command
         ON command.payment_attempt_id = attempt.id
       WHERE attempt.id = $1`,
      [callbackAttemptId],
    );
    const callback = callbackPointer.rows[0];
    assert.ok(callback);
    await pool.query(
      `UPDATE durable_jobs
       SET status = 'completed', locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE job_type = 'payment.start' AND unique_key = $1`,
      [`payment:${callbackAttemptId}`],
    );
    await pool.query(
      `UPDATE payment_attempts
       SET status = 'processing', updated_at = now(), version = version + 1
       WHERE id = $1`,
      [callbackAttemptId],
    );
    await pool.query(
      `UPDATE provider_operations
       SET status = 'running', attempt_count = 1, updated_at = now()
       WHERE id = $1`,
      [callback.operation_id],
    );
    await pool.query(
      `INSERT INTO durable_jobs(
         job_type, unique_key, payload, status, attempts, locked_at, locked_by
       ) VALUES (
         'payment.reconcile', $1, $2, 'running', 1, now(),
         'integration-live-payment-reconcile'
       )`,
      [
        `payment:${callbackAttemptId}`,
        {
          paymentAttemptId: callbackAttemptId,
          providerOperationId: callback.operation_id,
          operationId: callback.operation_id,
        },
      ],
    );
    const callbackCapability = providerOperationCapability(
      config.PROVIDER_OPERATION_CAPABILITY_SECRET,
      "mock-payment-v1",
      callback.operation_id,
    );
    const externalPaymentId = `callback-reconcile-${namespace}`;
    const submitPaymentCallback = async (body: {
      eventId: string;
      status:
        | "processing"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "expired"
        | "requires_action";
      occurredAt: string;
    }) => {
      const payload = {
        eventId: body.eventId,
        providerOperationId: callback.operation_id,
        paymentAttemptId: callbackAttemptId,
        callbackCapability,
        externalPaymentId,
        status: body.status,
        amountMinor: callback.amount_minor,
        currency: callback.currency,
        occurredAt: body.occurredAt,
      };
      const timestamp = Date.now().toString();
      return app.inject({
        method: "POST",
        url: "/api/v1/provider-events/payment",
        headers: {
          "x-oss-timestamp": timestamp,
          "x-oss-signature": providerSignature(
            config.MOCK_PAYMENT_WEBHOOK_SECRET,
            timestamp,
            payload,
          ),
        },
        payload,
      });
    };
    const futureFact = await submitPaymentCallback({
      eventId: `future-payment-${namespace}`,
      status: "succeeded",
      occurredAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    assert.equal(futureFact.statusCode, 202);
    assert.deepEqual(futureFact.json(), {
      accepted: true,
      status: "unknown",
      reconciliationRequired: true,
    });
    const futureState = await pool.query<{
      attempt_status: string;
      operation_status: string;
      command_status: string;
      job_status: string;
      locked_by: string | null;
      locked_at: Date | null;
    }>(
      `SELECT attempt.status AS attempt_status,
              operation.status AS operation_status,
              command.status AS command_status,
              job.status AS job_status,
              job.locked_by,
              job.locked_at
       FROM payment_attempts attempt
       JOIN provider_operations operation ON operation.id = $2
       JOIN invoice_payment_commands command ON command.id = $3
       JOIN durable_jobs job
         ON job.job_type = 'payment.reconcile' AND job.unique_key = $4
       WHERE attempt.id = $1`,
      [
        callbackAttemptId,
        callback.operation_id,
        callback.command_id,
        `payment:${callbackAttemptId}`,
      ],
    );
    assert.equal(futureState.rows[0]?.attempt_status, "unknown");
    assert.equal(futureState.rows[0]?.operation_status, "unknown");
    assert.equal(futureState.rows[0]?.command_status, "unknown");
    assert.equal(futureState.rows[0]?.job_status, "running");
    assert.equal(
      futureState.rows[0]?.locked_by,
      "integration-live-payment-reconcile",
    );
    assert.ok(futureState.rows[0]?.locked_at);

    const releasedToManual = await pool.query(
      `UPDATE durable_jobs
       SET status = 'manual', locked_at = NULL, locked_by = NULL,
           last_error = 'Synthetic query-only review', updated_at = now()
       WHERE job_type = 'payment.reconcile'
         AND unique_key = $1
         AND status = 'running'`,
      [`payment:${callbackAttemptId}`],
    );
    assert.equal(releasedToManual.rowCount, 1);
    const actionRequiredAt = new Date();
    const actionRequired = await submitPaymentCallback({
      eventId: `requires-action-${namespace}`,
      status: "requires_action",
      occurredAt: actionRequiredAt.toISOString(),
    });
    assert.equal(actionRequired.statusCode, 202);
    assert.deepEqual(actionRequired.json(), {
      accepted: true,
      status: "requires_action",
    });
    const completedManualJob = await pool.query<{
      status: string;
      locked_by: string | null;
      locked_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT status, locked_by, locked_at, last_error
       FROM durable_jobs
       WHERE job_type = 'payment.reconcile' AND unique_key = $1`,
      [`payment:${callbackAttemptId}`],
    );
    assert.deepEqual(completedManualJob.rows[0], {
      status: "completed",
      locked_by: null,
      locked_at: null,
      last_error: null,
    });

    const rearmedLease = await pool.query(
      `UPDATE durable_jobs
       SET status = 'running', attempts = attempts + 1,
           locked_at = now(), locked_by = 'integration-late-success-reconcile',
           updated_at = now()
       WHERE job_type = 'payment.reconcile'
         AND unique_key = $1
         AND status = 'completed'`,
      [`payment:${callbackAttemptId}`],
    );
    assert.equal(rearmedLease.rowCount, 1);
    const lateSuccessBody = {
      eventId: `late-success-${namespace}`,
      status: "succeeded" as const,
      occurredAt: new Date(actionRequiredAt.getTime() + 1_000).toISOString(),
    };
    const lateSuccess = await submitPaymentCallback(lateSuccessBody);
    assert.equal(lateSuccess.statusCode, 202);
    assert.equal(lateSuccess.json().status, "unclaimed");
    assert.ok(lateSuccess.json().receiptId);
    const lateSuccessState = await pool.query<{
      attempt_status: string;
      command_status: string;
      job_status: string;
      locked_by: string | null;
      receipt_count: string;
      receipt_disposition: string;
      receipt_allocated_minor: string;
      allocations: string;
      fee_charges: string;
      invoice_status: string;
      invoice_total_minor: string;
      service_status: string;
      term_start: Date;
      term_end: Date;
      decision_generation: string;
      consent_generation: string;
      active_authorization_id: string;
      saved_method_count: string;
      created_authorization_id: string | null;
      created_saved_method_id: string | null;
      ledger_debit_minor: string;
      ledger_credit_minor: string;
    }>(
      `SELECT attempt.status AS attempt_status,
              command.status AS command_status,
              job.status AS job_status,
              job.locked_by,
              (SELECT count(*)::text
                 FROM fund_receipts receipt
                WHERE receipt.reported_payment_attempt_id = attempt.id) AS receipt_count,
              receipt.disposition AS receipt_disposition,
              receipt.allocated_minor::text AS receipt_allocated_minor,
              (SELECT count(*)::text
                 FROM payment_allocations allocation
                WHERE allocation.payment_attempt_id = attempt.id) AS allocations,
              (SELECT count(*)::text
                 FROM invoice_fee_charges fee
                WHERE fee.payment_attempt_id = attempt.id) AS fee_charges,
              CASE
                WHEN allocation_total.allocated_minor >= invoice.total_minor THEN 'paid'
                WHEN allocation_total.allocated_minor > 0 THEN 'partially_paid'
                ELSE 'unpaid'
              END AS invoice_status,
              invoice.total_minor::text AS invoice_total_minor,
              service.status AS service_status,
              service.term_start,
              service.term_end,
              service.automatic_renewal_decision_generation::text AS decision_generation,
              service.automatic_renewal_consent_generation::text AS consent_generation,
              renewal_authorization.id AS active_authorization_id,
              (SELECT count(*)::text
                 FROM saved_payment_methods saved
                WHERE saved.client_account_id = attempt.client_account_id) AS saved_method_count,
              attempt.created_automatic_renewal_authorization_id AS created_authorization_id,
              attempt.saved_payment_method_id AS created_saved_method_id,
              coalesce(sum(line.debit_minor), 0)::text AS ledger_debit_minor,
              coalesce(sum(line.credit_minor), 0)::text AS ledger_credit_minor
       FROM payment_attempts attempt
       JOIN invoice_payment_commands command ON command.id = $2
       JOIN invoices invoice ON invoice.id = attempt.invoice_id
       JOIN invoice_allocation_totals allocation_total
         ON allocation_total.invoice_id = invoice.id
       JOIN service_renewals renewal ON renewal.invoice_id = invoice.id
       JOIN services service ON service.id = renewal.service_id
       JOIN automatic_renewal_authorizations renewal_authorization
         ON renewal_authorization.service_id = service.id
        AND renewal_authorization.status = 'active'
       JOIN fund_receipts receipt
         ON receipt.reported_payment_attempt_id = attempt.id
       JOIN ledger_journals journal
         ON journal.source_type = 'fund_receipt'
        AND journal.source_id = receipt.id
       JOIN ledger_lines line ON line.journal_id = journal.id
       JOIN durable_jobs job
         ON job.job_type = 'payment.reconcile' AND job.unique_key = $3
       WHERE attempt.id = $1
       GROUP BY attempt.id, command.status, job.status, job.locked_by,
                receipt.id, invoice.id, allocation_total.allocated_minor,
                service.id, renewal_authorization.id`,
      [callbackAttemptId, callback.command_id, `payment:${callbackAttemptId}`],
    );
    const late = lateSuccessState.rows[0];
    assert.ok(late);
    assert.deepEqual(
      {
        attemptStatus: late.attempt_status,
        commandStatus: late.command_status,
        jobStatus: late.job_status,
        lockedBy: late.locked_by,
        receipts: late.receipt_count,
        receiptDisposition: late.receipt_disposition,
        receiptAllocatedMinor: late.receipt_allocated_minor,
        allocations: late.allocations,
        feeCharges: late.fee_charges,
        invoiceStatus: late.invoice_status,
        invoiceTotalMinor: late.invoice_total_minor,
        serviceStatus: late.service_status,
        termStart: late.term_start.toISOString(),
        termEnd: late.term_end.toISOString(),
        decisionGeneration: late.decision_generation,
        consentGeneration: late.consent_generation,
        activeAuthorizationId: late.active_authorization_id,
        savedMethodCount: late.saved_method_count,
        createdAuthorizationId: late.created_authorization_id,
        createdSavedMethodId: late.created_saved_method_id,
        ledgerDebitMinor: late.ledger_debit_minor,
        ledgerCreditMinor: late.ledger_credit_minor,
      },
      {
        attemptStatus: "requires_action",
        commandStatus: "manual",
        jobStatus: "running",
        lockedBy: "integration-late-success-reconcile",
        receipts: "1",
        receiptDisposition: "unclaimed",
        receiptAllocatedMinor: "0",
        allocations: "0",
        feeCharges: "0",
        invoiceStatus: "unpaid",
        invoiceTotalMinor: "1500",
        serviceStatus: "active",
        termStart: "2013-01-01T01:00:00.000Z",
        termEnd: "2013-02-01T01:00:00.000Z",
        decisionGeneration: "2",
        consentGeneration: "1",
        activeAuthorizationId: callbackAuthorizationAId,
        savedMethodCount: "2",
        createdAuthorizationId: null,
        createdSavedMethodId: null,
        ledgerDebitMinor: callback.amount_minor,
        ledgerCreditMinor: callback.amount_minor,
      },
    );
    const duplicateLateSuccess = await submitPaymentCallback(lateSuccessBody);
    assert.equal(duplicateLateSuccess.statusCode, 200);
    assert.equal(duplicateLateSuccess.json().duplicate, true);
    const duplicateFacts = await pool.query<{
      receipts: string;
      receipt_journals: string;
      consent_events: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM fund_receipts
           WHERE reported_payment_attempt_id = $1) AS receipts,
         (SELECT count(*)::text
            FROM ledger_journals journal
            JOIN fund_receipts receipt ON receipt.id = journal.source_id
           WHERE journal.source_type = 'fund_receipt'
             AND receipt.reported_payment_attempt_id = $1) AS receipt_journals,
         (SELECT count(*)::text FROM payment_consent_events
           WHERE metadata->>'paymentAttemptId' = $1::text) AS consent_events`,
      [callbackAttemptId],
    );
    assert.deepEqual(duplicateFacts.rows[0], {
      receipts: "1",
      receipt_journals: "1",
      consent_events: "0",
    });
    const workerCompletedLease = await pool.query(
      `UPDATE durable_jobs
       SET status = 'completed', locked_at = NULL, locked_by = NULL,
           last_error = NULL, updated_at = now()
       WHERE job_type = 'payment.reconcile'
         AND unique_key = $1
         AND status = 'running'
         AND locked_by = 'integration-late-success-reconcile'`,
      [`payment:${callbackAttemptId}`],
    );
    assert.equal(workerCompletedLease.rowCount, 1);

    const staleReplacement = await request(
      billingSessionToken,
      `/api/v1/services/${service.serviceId}/automatic-renewal`,
      {
        method: "POST",
        body: {
          savedPaymentMethodId: methodCId,
          consentVersion: AUTOMATIC_RENEWAL_CONSENT_VERSION,
          expectedAuthorizationId: authorizationAId,
          expectedAuthorizationVersion: 1,
          expectedDecisionGeneration: "1",
          idempotencyKey: `stale-replacement-${namespace}`,
        },
      },
    );
    assert.equal(staleReplacement.statusCode, 409);
    const blockedRemoval = await request(
      billingSessionToken,
      `/api/v1/billing/payment-methods/${methodAId}/remove`,
      {
        method: "POST",
        body: { expectedVersion: 1, idempotencyKey: `blocked-remove-${namespace}` },
      },
    );
    assert.equal(blockedRemoval.statusCode, 409);
    assert.equal(blockedRemoval.body.code, "PENDING_AUTOMATIC_RENEWAL_DECISION");
    const unchanged = await pool.query<{
      decision_generation: string;
      consent_generation: string;
      method_status: string;
      authorization_status: string;
    }>(
      `SELECT service.automatic_renewal_decision_generation::text AS decision_generation,
              service.automatic_renewal_consent_generation::text AS consent_generation,
              method.status AS method_status,
              renewal_authorization.status AS authorization_status
       FROM services service
       JOIN saved_payment_methods method ON method.id = $2
       JOIN automatic_renewal_authorizations renewal_authorization
         ON renewal_authorization.id = $3
       WHERE service.id = $1`,
      [service.serviceId, methodAId, authorizationAId],
    );
    assert.deepEqual(unchanged.rows[0], {
      decision_generation: "2",
      consent_generation: "1",
      method_status: "active",
      authorization_status: "active",
    });

    const oversized = await request(
      ownerSessionToken,
      `/api/v1/services/${service.serviceId}/automatic-renewal/pending-consent/withdraw`,
      {
        method: "POST",
        body: {
          expectedPaymentAttemptId: pending.paymentAttemptId,
          expectedDecisionGeneration: "9999999999999999999",
          reason: "Synthetic oversized stale generation",
          idempotencyKey: `oversized-generation-${namespace}`,
        },
      },
    );
    assert.equal(oversized.statusCode, 400);
    for (const [caseName, invalidGeneration] of [
      ["alphabetic", "abc"],
      ["negative", "-1"],
      ["object", { forged: "2" }],
    ] as const) {
      const malformed = await request(
        ownerSessionToken,
        `/api/v1/services/${service.serviceId}/automatic-renewal/pending-consent/withdraw`,
        {
          method: "POST",
          body: {
            expectedPaymentAttemptId: pending.paymentAttemptId,
            expectedDecisionGeneration: invalidGeneration,
            reason: `Synthetic malformed ${caseName} generation`,
            idempotencyKey: `malformed-generation-${caseName}-${namespace}`,
          },
        },
      );
      assert.equal(
        malformed.statusCode,
        400,
        `${caseName} decision generation must be rejected without throwing`,
      );
    }
    const withdrawBody = {
      expectedPaymentAttemptId: pending.paymentAttemptId,
      expectedDecisionGeneration: "2",
      reason: "Synthetic owner withdrew pending consent",
      idempotencyKey: `withdraw-pending-${namespace}`,
    };
    const withdrawn = await request(
      ownerSessionToken,
      `/api/v1/services/${service.serviceId}/automatic-renewal/pending-consent/withdraw`,
      { method: "POST", body: withdrawBody },
    );
    assert.equal(withdrawn.statusCode, 200);
    const withdrawnReplay = await request(
      ownerSessionToken,
      `/api/v1/services/${service.serviceId}/automatic-renewal/pending-consent/withdraw`,
      { method: "POST", body: withdrawBody },
    );
    assert.equal(withdrawnReplay.statusCode, 200);
    assert.equal(withdrawnReplay.body.replayed, true);

    const staleAfterWithdraw = await request(
      billingSessionToken,
      `/api/v1/services/${service.serviceId}/automatic-renewal`,
      {
        method: "POST",
        body: {
          savedPaymentMethodId: methodCId,
          consentVersion: AUTOMATIC_RENEWAL_CONSENT_VERSION,
          expectedAuthorizationId: authorizationAId,
          expectedAuthorizationVersion: 1,
          expectedDecisionGeneration: "2",
          idempotencyKey: `stale-after-withdraw-${namespace}`,
        },
      },
    );
    assert.equal(staleAfterWithdraw.statusCode, 409);
    const refreshed = await request(
      billingSessionToken,
      "/api/v1/billing/payment-settings",
    );
    const refreshedDecision = refreshed.body.serviceDecisions.find(
      (row: { serviceId: string }) => row.serviceId === service.serviceId,
    )?.decisionGeneration;
    assert.equal(refreshedDecision, "3");
    const deadlocksBefore = await pool.query<{ deadlocks: string }>(
      `SELECT deadlocks::text
       FROM pg_stat_database
       WHERE datname = current_database()`,
    );
    const serviceGate = await pool.connect();
    let replaced!: Awaited<ReturnType<typeof request>>;
    try {
      await serviceGate.query("BEGIN");
      await serviceGate.query("SET LOCAL lock_timeout = '1s'");
      await serviceGate.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
        service.serviceId,
      ]);
      const replacementPromise = request(
        billingSessionToken,
        `/api/v1/services/${service.serviceId}/automatic-renewal`,
        {
          method: "POST",
          body: {
            savedPaymentMethodId: methodCId,
            consentVersion: AUTOMATIC_RENEWAL_CONSENT_VERSION,
            expectedAuthorizationId: authorizationAId,
            expectedAuthorizationVersion: 1,
            expectedDecisionGeneration: refreshedDecision,
            idempotencyKey: `confirmed-replacement-${namespace}`,
          },
        },
      );
      let observedServiceLockWait = false;
      for (let poll = 0; poll < 100 && !observedServiceLockWait; poll += 1) {
        const waiting = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query LIKE '%FROM services WHERE id = $1 AND client_account_id = $2 FOR UPDATE%'`,
        );
        observedServiceLockWait = waiting.rows[0]?.count !== "0";
        if (!observedServiceLockWait) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(
        observedServiceLockWait,
        true,
        "real HTTP replacement must be observed waiting on the held Service row",
      );
      await serviceGate.query(
        "SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE",
        [owner.clientAccountId],
      );
      await serviceGate.query("COMMIT");
      replaced = await replacementPromise;
    } catch (error) {
      await serviceGate.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      serviceGate.release();
    }
    assert.equal(replaced.statusCode, 200);
    const deadlocksAfter = await pool.query<{ deadlocks: string }>(
      `SELECT deadlocks::text
       FROM pg_stat_database
       WHERE datname = current_database()`,
    );
    assert.equal(deadlocksAfter.rows[0]?.deadlocks, deadlocksBefore.rows[0]?.deadlocks);
    const staleRevoke = await request(
      billingSessionToken,
      `/api/v1/services/${service.serviceId}/automatic-renewal/revoke`,
      {
        method: "POST",
        body: {
          expectedAuthorizationId: replaced.body.authorizationId,
          expectedVersion: replaced.body.version,
          expectedDecisionGeneration: "3",
          reason: "Synthetic stale revoke",
          idempotencyKey: `stale-revoke-${namespace}`,
        },
      },
    );
    assert.equal(staleRevoke.statusCode, 409);
    const finalSettings = await request(
      billingSessionToken,
      "/api/v1/billing/payment-settings",
    );
    const finalDecision = finalSettings.body.serviceDecisions.find(
      (row: { serviceId: string }) => row.serviceId === service.serviceId,
    )?.decisionGeneration;
    assert.equal(finalDecision, "4");
    const revoked = await request(
      billingSessionToken,
      `/api/v1/services/${service.serviceId}/automatic-renewal/revoke`,
      {
        method: "POST",
        body: {
          expectedAuthorizationId: replaced.body.authorizationId,
          expectedVersion: replaced.body.version,
          expectedDecisionGeneration: finalDecision,
          reason: "Synthetic confirmed revoke",
          idempotencyKey: `confirmed-revoke-${namespace}`,
        },
      },
    );
    assert.equal(revoked.statusCode, 200);
  } finally {
    await app.close();
  }
}

async function proveConcurrentBillingDay(pool: pg.Pool): Promise<{ runId: string }> {
  const setup = await pool.connect();
  const namespace = randomUUID();
  const productGroupId = `renewal-concurrency-group-${namespace}`;
  const productId = `renewal-concurrency-product-${namespace}`;
  const effectiveAt = new Date("2002-01-18T01:00:00.000Z");
  let account: FixtureAccount;
  let eligibleAccount: FixtureAccount;
  let service: FixtureService;
  let eligibleService: FixtureService;
  try {
    await setup.query("BEGIN");
    await setup.query(
      `INSERT INTO product_groups(id, sort_order, names)
       VALUES ($1, 9998, '{"en":"Renewal Concurrency"}'::jsonb)`,
      [productGroupId],
    );
    await setup.query(
      `INSERT INTO products(
         id, group_id, names, descriptions, fulfillment_mode,
         active, hidden, repeatable, option_schema
       ) VALUES (
         $1, $2, '{"en":"Concurrent Renewal Product"}'::jsonb,
         '{"en":"Synthetic concurrent automation fixture"}'::jsonb,
         'automatic', true, false, false, '[]'::jsonb
       )`,
      [productId, productGroupId],
    );
    account = await createFixtureAccount(setup, "concurrent-run");
    service = await createFixtureService(setup, account, {
      label: "Concurrent Billing Day Service",
      productId,
      recurringMinor: 777n,
      termStart: new Date("2002-01-01T15:00:00.000Z"),
      termEnd: new Date("2002-02-01T15:00:00.000Z"),
    });
    eligibleAccount = await createFixtureAccount(setup, "concurrent-eligible");
    eligibleService = await createFixtureService(setup, eligibleAccount, {
      label: "Concurrent Eligible Renewal Service",
      productId,
      recurringMinor: 888n,
      termStart: new Date("2002-01-01T15:00:00.000Z"),
      termEnd: new Date("2002-02-01T15:00:00.000Z"),
    });
    await setup.query(
      `INSERT INTO client_contacts(
         client_account_id, display_name, email, locale,
         notification_subscriptions
       )
       SELECT $1, 'Same-email billing Contact', email, locale,
              '["billing"]'::jsonb
       FROM users
       WHERE id = $2`,
      [account.clientAccountId, account.userId],
    );
    await setup.query(
      `UPDATE users SET restricted_at = pg_catalog.now() WHERE id = $1`,
      [account.userId],
    );
    await setup.query("COMMIT");
  } catch (error) {
    await setup.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    setup.release();
  }

  const committedRun = async (suffix: string) => {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const outcome = await runBillingDay(connection, account.userId, effectiveAt, suffix);
      await connection.query("COMMIT");
      return outcome;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  };
  const outcomes = await Promise.all([
    committedRun("concurrent-a"),
    committedRun("concurrent-b"),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.replayed).length, 1);
  assert.equal(outcomes.filter((outcome) => !outcome.replayed).length, 1);
  assert.equal(outcomes[0]?.runId, outcomes[1]?.runId);
  assert.ok(outcomes.every((outcome) => outcome.invoicesCreated === 2));

  const proof = await pool.query<{
    runs: string;
    renewals: string;
    invoice_journals: string;
    reminders: string;
    notification_operations: string;
    restricted_owner_skipped_operations: string;
    restricted_owner_skipped_facts: string;
    restricted_owner_terminal_projection: string;
    same_email_contact_queued_operations: string;
    eligible_owner_queued_operations: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM billing_automation_runs
        WHERE policy_id = 'default' AND business_date = '2002-01-18') AS runs,
       (SELECT count(*)::text FROM service_renewals renewal
        WHERE renewal.service_id = ANY($1::uuid[])) AS renewals,
       (SELECT count(*)::text
        FROM service_renewals renewal
        JOIN ledger_journals journal
          ON journal.source_type = 'invoice_issuance'
         AND journal.source_id = renewal.invoice_id
        WHERE renewal.service_id = ANY($1::uuid[])) AS invoice_journals,
       (SELECT count(*)::text FROM renewal_reminder_intents reminder
        WHERE reminder.service_id = ANY($1::uuid[])
          AND reminder.kind = 'renewal_created') AS reminders,
       (SELECT count(*)::text
        FROM renewal_reminder_intents reminder
        JOIN notification_delivery_operations operation
          ON operation.outbox_id = reminder.outbox_id
         AND operation.attempt_number = 1
         AND operation.recipient_kind = 'account_user'
        WHERE reminder.service_id = ANY($1::uuid[])
          AND reminder.kind = 'renewal_created') AS notification_operations,
       (SELECT count(*)::text
        FROM notification_delivery_operations operation
        WHERE operation.payload_snapshot ->> 'serviceId' = $2
          AND operation.recipient_kind = 'account_user'
          AND operation.status = 'skipped') AS restricted_owner_skipped_operations,
       (SELECT count(*)::text
        FROM notification_delivery_facts fact
        JOIN notification_delivery_operations operation
          ON operation.outbox_id = fact.outbox_id
         AND operation.attempt_number = fact.attempt_number
        WHERE operation.payload_snapshot ->> 'serviceId' = $2
          AND operation.recipient_kind = 'account_user'
          AND fact.status = 'skipped') AS restricted_owner_skipped_facts,
       (SELECT count(*)::text
        FROM notification_delivery_operations operation
        JOIN outbox event ON event.id = operation.outbox_id
        JOIN durable_jobs job
          ON job.job_type = 'notification.send'
         AND job.unique_key = 'outbox:' || event.id::text
        WHERE operation.payload_snapshot ->> 'serviceId' = $2
          AND operation.recipient_kind = 'account_user'
          AND operation.status = 'skipped'
          AND operation.last_error = 'ACCOUNT_USER_RECIPIENT_INELIGIBLE'
          AND event.published_at IS NOT NULL
          AND job.status = 'completed'
          AND job.attempts = 0
          AND job.last_error = operation.last_error)
         AS restricted_owner_terminal_projection,
       (SELECT count(*)::text
        FROM notification_delivery_operations operation
        WHERE operation.payload_snapshot ->> 'serviceId' = $2
          AND operation.recipient_kind = 'contact'
          AND operation.status = 'queued') AS same_email_contact_queued_operations,
       (SELECT count(*)::text
        FROM notification_delivery_operations operation
        WHERE operation.payload_snapshot ->> 'serviceId' = $3
          AND operation.recipient_kind = 'account_user'
          AND operation.status = 'queued') AS eligible_owner_queued_operations`,
    [[service.serviceId, eligibleService.serviceId], service.serviceId, eligibleService.serviceId],
  );
  assert.deepEqual(proof.rows[0], {
    runs: "1",
    renewals: "2",
    invoice_journals: "2",
    reminders: "2",
    notification_operations: "2",
    restricted_owner_skipped_operations: "1",
    restricted_owner_skipped_facts: "1",
    restricted_owner_terminal_projection: "1",
    same_email_contact_queued_operations: "1",
    eligible_owner_queued_operations: "1",
  });
  await assert.rejects(
    pool.query(
      `UPDATE service_renewals
       SET creation_transaction_id = txid_current(),
           version = version + 1,
           updated_at = now()
       WHERE service_id = $1`,
      [service.serviceId],
    ),
    /financial facts are immutable/i,
    "a later transaction must not rewrite the renewal creation marker to authorize Credit",
  );
  const runId = outcomes[0]?.runId;
  assert.ok(runId);
  return { runId };
}

async function proveScheduledBillingDay(pool: pg.Pool): Promise<{ runId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const effectiveAt = new Date("2004-01-01T01:00:00.000Z");
    const first = await runRenewalAutomation(client, {
      requestedByUserId: null,
      reason: "Scheduled Asia/Shanghai billing automation",
      scheduledBusinessDate: "2004-01-01",
      effectiveAt,
    });
    const replay = await runRenewalAutomation(client, {
      requestedByUserId: null,
      reason: "Scheduled Asia/Shanghai billing automation",
      scheduledBusinessDate: "2004-01-01",
      effectiveAt,
    });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    const recorded = await client.query<{
      trigger_kind: string;
      requested_by_user_id: string | null;
      runs: string;
    }>(
      `SELECT min(trigger_kind) AS trigger_kind,
              min(requested_by_user_id::text) AS requested_by_user_id,
              count(*)::text AS runs
       FROM billing_automation_runs
       WHERE policy_id = 'default' AND business_date = '2004-01-01'`,
    );
    assert.equal(recorded.rows[0]?.trigger_kind, "scheduled");
    assert.equal(recorded.rows[0]?.requested_by_user_id, null);
    assert.equal(recorded.rows[0]?.runs, "1");
    await assert.rejects(
      runRenewalAutomation(client, {
        requestedByUserId: null,
        reason: "Scheduled Asia/Shanghai billing automation",
        scheduledBusinessDate: "2004-01-02",
        effectiveAt: new Date("2004-01-02T00:59:00.000Z"),
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "SCHEDULE_NOT_DUE",
    );
    await client.query("ROLLBACK");
    return { runId: first.runId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  connectionTimeoutMillis: 5_000,
});
await runMigrations(pool);
await assertSchemaCompatible(pool);
await bootstrapPaymentMethodTokenKeyrings(pool, integrationConfig);
await assertPaymentMethodTokenKeyringsCompatible(pool, integrationConfig);
const client = await pool.connect();
let clientReleased = false;

try {
  await client.query("BEGIN");

  const fixtureNamespace = randomUUID();
  const productGroupId = `renewal-integration-group-${fixtureNamespace}`;
  const productId = `renewal-integration-product-${fixtureNamespace}`;
  await client.query(
    `INSERT INTO product_groups(id, sort_order, names)
     VALUES ($1, 9999, '{"en":"Renewal Integration"}'::jsonb)`,
    [productGroupId],
  );
  await client.query(
    `INSERT INTO products(
       id, group_id, names, descriptions, fulfillment_mode,
       active, hidden, repeatable, option_schema
     ) VALUES (
       $1, $2, '{"en":"Current Catalog Product"}'::jsonb,
       '{"en":"Synthetic integration product"}'::jsonb,
       'automatic', true, false, false, '[]'::jsonb
     )`,
    [productId, productGroupId],
  );
  await client.query(
    `INSERT INTO product_prices(
       product_id, revision, currency, billing_cycle,
       one_time_minor, setup_minor, recurring_minor, valid_from
     ) VALUES ($1, 99, 'USD', 'monthly', 0, 0, 9999, $2)`,
    [productId, TERM_START],
  );

  const mainAccount = await createFixtureAccount(client, "main");
  const partialAccount = await createFixtureAccount(client, "partial-credit");
  const fullAccount = await createFixtureAccount(client, "full-credit");
  const holdAccount = await createFixtureAccount(client, "restricted-at-payment");
  const guardAccount = await createFixtureAccount(client, "database-guards");
  const calendarAccount = await createFixtureAccount(client, "calendar-day-cutoff");
  const microsecondCreditAccount = await createFixtureAccount(client, "microsecond-full-credit");
  const microsecondPaymentAccount = await createFixtureAccount(client, "microsecond-payment");

  const mainService = await createFixtureService(client, mainAccount, {
    label: "Main Service",
    productId,
    recurringMinor: 1234n,
  });
  const partialService = await createFixtureService(client, partialAccount, {
    label: "Partial Credit Service",
    productId,
    recurringMinor: 1000n,
  });
  const fullService = await createFixtureService(client, fullAccount, {
    label: "Full Credit Service",
    productId,
    recurringMinor: 1000n,
  });
  const holdService = await createFixtureService(client, holdAccount, {
    label: "Restricted Payment Service",
    productId,
    recurringMinor: 700n,
  });
  const guardService = await createFixtureService(client, guardAccount, {
    label: "Database Guard Service",
    productId,
    recurringMinor: 555n,
    termStart: new Date("2001-02-01T01:00:00.000Z"),
    termEnd: NEXT_TERM_END,
  });
  const calendarService = await createFixtureService(client, calendarAccount, {
    label: "Shanghai Calendar Cutoff Service",
    productId,
    recurringMinor: 900n,
    termStart: CALENDAR_TERM_START,
    termEnd: CALENDAR_TERM_END,
  });
  const microsecondCreditService = await createFixtureService(client, microsecondCreditAccount, {
    label: "Microsecond Full Credit Service",
    productId,
    recurringMinor: 800n,
    termStart: "2001-01-01T01:00:00.123456Z",
    termEnd: "2001-02-01T01:00:00.123456Z",
  });
  const microsecondPaymentService = await createFixtureService(client, microsecondPaymentAccount, {
    label: "Microsecond Payment Service",
    productId,
    recurringMinor: 600n,
    termStart: "2001-01-01T01:00:00.654321Z",
    termEnd: "2001-02-01T01:00:00.654321Z",
  });

  await proveSavedPaymentAuthorizationGuards(client, {
    account: guardAccount,
    service: guardService,
    otherAccount: mainAccount,
    otherService: mainService,
  });

  await grantFixtureCredit(client, partialAccount, 400n);
  await grantFixtureCredit(client, fullAccount, 1000n);
  await grantFixtureCredit(client, microsecondCreditAccount, 800n);

  const firstRun = await runBillingDay(client, mainAccount.userId, AT_MINUS_14, "minus-14");
  assert.equal(firstRun.replayed, false);
  assert.equal(firstRun.invoicesCreated, 7);

  const mainRenewal = await loadRenewal(client, mainService.serviceId);
  const partialRenewal = await loadRenewal(client, partialService.serviceId);
  const fullRenewal = await loadRenewal(client, fullService.serviceId);
  const holdRenewal = await loadRenewal(client, holdService.serviceId);
  const calendarRenewal = await loadRenewal(client, calendarService.serviceId);
  const microsecondCreditRenewal = await loadRenewal(
    client,
    microsecondCreditService.serviceId,
  );
  const microsecondPaymentRenewal = await loadRenewal(
    client,
    microsecondPaymentService.serviceId,
  );
  assert.equal(mainRenewal.recurring_minor, "1234");
  assert.equal(mainRenewal.total_minor, "1234");
  assert.notEqual(mainRenewal.total_minor, "9999", "current catalog price must not rewrite history");
  assert.equal(mainRenewal.period_start.toISOString(), TERM_END.toISOString());
  assert.equal(mainRenewal.period_end.toISOString(), NEXT_TERM_END.toISOString());
  assert.equal(partialRenewal.allocated_minor, "400");
  assert.equal(partialRenewal.status, "invoiced");
  assert.equal(fullRenewal.allocated_minor, "1000");
  assert.equal(fullRenewal.status, "paid");
  assert.ok(fullRenewal.funded_at);
  assert.ok(fullRenewal.settled_at);
  await assertInvoicePaymentBusinessStateLocked(client, holdRenewal.invoice_id, null);
  await client.query(
    "UPDATE services SET status = 'terminated', updated_at = now() WHERE id = $1",
    [holdService.serviceId],
  );
  await expectDatabaseRejection(
    client,
    "terminated_renewal_payment_business_state",
    /no longer payable/i,
    () => assertInvoicePaymentBusinessStateLocked(client, holdRenewal.invoice_id, null),
  );
  await client.query("UPDATE services SET status = 'active', updated_at = now() WHERE id = $1", [
    holdService.serviceId,
  ]);
  assert.equal(
    calendarRenewal.period_start.toISOString(),
    CALENDAR_TERM_END.toISOString(),
    "a term ending late on the fourteenth Shanghai calendar day must be invoiced",
  );
  assert.equal(calendarRenewal.period_end.toISOString(), CALENDAR_NEXT_TERM_END.toISOString());

  const microsecondCreationProof = await client.query<{
    credit_due_exact: boolean;
    credit_start_exact: boolean;
    credit_end_exact: boolean;
    credit_service_advanced_exact: boolean;
    credit_period_exact: boolean;
    payment_due_exact: boolean;
    payment_start_exact: boolean;
    payment_end_exact: boolean;
  }>(
    `SELECT
       credit_invoice.due_at = '2001-02-01 01:00:00.123456+00'::timestamptz
         AS credit_due_exact,
       credit_renewal.period_start = '2001-02-01 01:00:00.123456+00'::timestamptz
         AS credit_start_exact,
       credit_renewal.period_end = '2001-03-01 01:00:00.123456+00'::timestamptz
         AS credit_end_exact,
       credit_service.term_end = credit_renewal.period_end
         AS credit_service_advanced_exact,
       credit_period.period_start = credit_renewal.period_start
         AND credit_period.period_end = credit_renewal.period_end
         AS credit_period_exact,
       payment_invoice.due_at = '2001-02-01 01:00:00.654321+00'::timestamptz
         AS payment_due_exact,
       payment_renewal.period_start = '2001-02-01 01:00:00.654321+00'::timestamptz
         AS payment_start_exact,
       payment_renewal.period_end = '2001-03-01 01:00:00.654321+00'::timestamptz
         AS payment_end_exact
     FROM service_renewals credit_renewal
     JOIN invoices credit_invoice ON credit_invoice.id = credit_renewal.invoice_id
     JOIN services credit_service ON credit_service.id = credit_renewal.service_id
     JOIN service_periods credit_period
       ON credit_period.service_id = credit_service.id
      AND credit_period.invoice_id = credit_invoice.id
      AND credit_period.period_kind = 'renewal'
     JOIN service_renewals payment_renewal ON payment_renewal.service_id = $2
     JOIN invoices payment_invoice ON payment_invoice.id = payment_renewal.invoice_id
     WHERE credit_renewal.service_id = $1`,
    [microsecondCreditService.serviceId, microsecondPaymentService.serviceId],
  );
  assert.deepEqual(microsecondCreationProof.rows[0], {
    credit_due_exact: true,
    credit_start_exact: true,
    credit_end_exact: true,
    credit_service_advanced_exact: true,
    credit_period_exact: true,
    payment_due_exact: true,
    payment_start_exact: true,
    payment_end_exact: true,
  });
  assert.equal(microsecondCreditRenewal.status, "paid");
  assert.equal(microsecondPaymentRenewal.status, "invoiced");

  await recordFixturePayment(client, {
    clientAccountId: microsecondPaymentAccount.clientAccountId,
    invoiceId: microsecondPaymentRenewal.invoice_id,
    amountMinor: 600n,
  });
  const microsecondPaymentSettlement = await advancePaidInvoice(
    client,
    microsecondPaymentRenewal.invoice_id,
    {
      kind: "user_command",
      userId: microsecondPaymentAccount.userId,
    },
  );
  assert.equal(microsecondPaymentSettlement.renewalStatus, "paid");
  const microsecondSettlementProof = await client.query<{
    service_advanced_exact: boolean;
    period_exact: boolean;
    periods: string;
  }>(
    `SELECT
       service.term_end = renewal.period_end AS service_advanced_exact,
       bool_and(period.period_start = renewal.period_start
                AND period.period_end = renewal.period_end) AS period_exact,
       count(period.id)::text AS periods
     FROM service_renewals renewal
     JOIN services service ON service.id = renewal.service_id
     JOIN service_periods period
       ON period.service_id = service.id
      AND period.invoice_id = renewal.invoice_id
      AND period.period_kind = 'renewal'
     WHERE renewal.service_id = $1
     GROUP BY service.term_end, renewal.period_end`,
    [microsecondPaymentService.serviceId],
  );
  assert.deepEqual(microsecondSettlementProof.rows[0], {
    service_advanced_exact: true,
    period_exact: true,
    periods: "1",
  });

  const fullTermAfterCredit = await client.query<{ term_end: Date; periods: string }>(
    `SELECT service.term_end,
            (SELECT count(*)::text FROM service_periods period
             WHERE period.service_id = service.id AND period.period_kind = 'renewal') AS periods
     FROM services service
     WHERE service.id = $1`,
    [fullService.serviceId],
  );
  assert.equal(fullTermAfterCredit.rows[0]?.term_end.toISOString(), NEXT_TERM_END.toISOString());
  assert.equal(fullTermAfterCredit.rows[0]?.periods, "1");

  await recordFixturePayment(client, {
    clientAccountId: calendarAccount.clientAccountId,
    invoiceId: calendarRenewal.invoice_id,
    amountMinor: 900n,
  });
  const calendarSettlement = await advancePaidInvoice(client, calendarRenewal.invoice_id, {
    kind: "user_command",
    userId: calendarAccount.userId,
  });
  assert.equal(calendarSettlement.renewalStatus, "paid");

  const replay = await runBillingDay(client, mainAccount.userId, AT_MINUS_14, "same-business-day");
  assert.equal(replay.replayed, true);
  const renewalCounts = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM service_renewals
     WHERE service_id = ANY($1::uuid[])`,
    [[
      mainService.serviceId,
      partialService.serviceId,
      fullService.serviceId,
      holdService.serviceId,
      calendarService.serviceId,
    ]],
  );
  assert.equal(renewalCounts.rows[0]?.count, "5");

  const minusSevenRun = await runBillingDay(
    client,
    mainAccount.userId,
    AT_MINUS_7,
    "minus-7",
  );
  assert.equal(minusSevenRun.replayed, false);
  const preDue = await client.query<{ service_id: string; offset_days: number; amount: string }>(
    `SELECT service_id, offset_days, amount_due_minor::text AS amount
     FROM renewal_reminder_intents
     WHERE kind = 'pre_due'
       AND service_id = ANY($1::uuid[])
     ORDER BY service_id`,
    [[mainService.serviceId, partialService.serviceId, fullService.serviceId, holdService.serviceId]],
  );
  assert.equal(preDue.rows.length, 3, "fully Credit-paid renewal must not get a pre-due reminder");
  assert.ok(preDue.rows.every((row) => row.offset_days === 7));
  assert.equal(
    preDue.rows.find((row) => row.service_id === partialService.serviceId)?.amount,
    "600",
  );

  const overlappingInvoiceId = randomUUID();
  await client.query(
    `INSERT INTO invoices(id, client_account_id, order_id, currency, total_minor, due_at)
     VALUES ($1, $2, NULL, 'USD', 1234, $3)`,
    [overlappingInvoiceId, mainAccount.clientAccountId, TERM_END],
  );
  await client.query(
    `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
     VALUES ($1, 'recurring', 'Synthetic overlapping renewal guard', 1234)`,
    [overlappingInvoiceId],
  );
  await expectDatabaseRejection(client, "renewal_overlap", /overlap/i, () =>
    client.query(
      `INSERT INTO service_renewals(
         service_id, invoice_id, automation_run_id, period_start, period_end,
         recurring_minor, currency, price_snapshot
       ) VALUES ($1, $2, $3, $4, $5, 1234, 'USD', $6)`,
      [
        mainService.serviceId,
        overlappingInvoiceId,
        firstRun.runId,
        TERM_END,
        NEXT_TERM_END,
        { recurringSubtotalMinor: "1234" },
      ],
    ),
  );

  const wrongOwnerInvoiceId = randomUUID();
  await client.query(
    `INSERT INTO invoices(id, client_account_id, order_id, currency, total_minor, due_at)
     VALUES ($1, $2, NULL, 'USD', 555, $3)`,
    [wrongOwnerInvoiceId, partialAccount.clientAccountId, NEXT_TERM_END],
  );
  await client.query(
    `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
     VALUES ($1, 'recurring', 'Synthetic cross-account renewal guard', 555)`,
    [wrongOwnerInvoiceId],
  );
  await expectDatabaseRejection(client, "renewal_cross_account", /differs/i, () =>
    client.query(
      `INSERT INTO service_renewals(
         service_id, invoice_id, automation_run_id, period_start, period_end,
         recurring_minor, currency, price_snapshot
       ) VALUES ($1, $2, $3, $4, $5, 555, 'USD', $6)`,
      [
        guardService.serviceId,
        wrongOwnerInvoiceId,
        firstRun.runId,
        NEXT_TERM_END,
        new Date("2001-04-01T01:00:00.000Z"),
        { recurringSubtotalMinor: "555" },
      ],
    ),
  );

  const wrongPeriodInvoiceId = randomUUID();
  await client.query(
    `INSERT INTO invoices(id, client_account_id, order_id, currency, total_minor, due_at)
     VALUES ($1, $2, NULL, 'USD', 555, $3)`,
    [wrongPeriodInvoiceId, guardAccount.clientAccountId, NEXT_TERM_END],
  );
  await client.query(
    `INSERT INTO invoice_lines(invoice_id, kind, description, amount_minor)
     VALUES ($1, 'recurring', 'Synthetic billing-cycle renewal guard', 555)`,
    [wrongPeriodInvoiceId],
  );
  await expectDatabaseRejection(client, "renewal_wrong_cycle", /billing cycle/i, () =>
    client.query(
      `INSERT INTO service_renewals(
         service_id, invoice_id, automation_run_id, period_start, period_end,
         recurring_minor, currency, price_snapshot
       ) VALUES ($1, $2, $3, $4, $5, 555, 'USD', $6)`,
      [
        guardService.serviceId,
        wrongPeriodInvoiceId,
        firstRun.runId,
        NEXT_TERM_END,
        new Date("2011-03-01T01:00:00.000Z"),
        { recurringSubtotalMinor: "555" },
      ],
    ),
  );

  await grantFixtureCredit(client, mainAccount, 1500n);
  const forgedCreditAccount = await client.query<{ id: string }>(
    `SELECT id FROM credit_accounts
     WHERE client_account_id = $1 AND currency = 'USD'`,
    [mainAccount.clientAccountId],
  );
  const forgedCreditAccountId = forgedCreditAccount.rows[0]?.id;
  assert.ok(forgedCreditAccountId);
  const insertForgedRenewalAllocation = async (input: {
    actorType: "provider" | "system";
    actorId: string | null;
    amountMinor: bigint;
  }) => {
    const transactionId = randomUUID();
    await client.query(
      `INSERT INTO credit_transactions(
         id, credit_account_id, kind, credit_minor, debit_minor,
         source_type, source_id, actor_type, actor_id, reason,
         idempotency_key, request_fingerprint
       ) VALUES (
         $1, $2, 'invoice_application', 0, $3,
         'service_renewal', $4, $5, $6,
         'Synthetic forged renewal allocation', $7, $8
       )`,
      [
        transactionId,
        forgedCreditAccountId,
        input.amountMinor.toString(),
        mainRenewal.id,
        input.actorType,
        input.actorId,
        `renewal-forged-credit:${transactionId}`,
        `renewal-forged-credit-fingerprint:${transactionId}`,
      ],
    );
    await client.query(
      `INSERT INTO credit_allocations(credit_transaction_id, invoice_id, amount_minor)
       VALUES ($1, $2, $3)`,
      [transactionId, mainRenewal.invoice_id, input.amountMinor.toString()],
    );
  };
  await expectDatabaseRejection(client, "renewal_credit_provider_actor", /does not match/i, () =>
    insertForgedRenewalAllocation({
      actorType: "provider",
      actorId: randomUUID(),
      amountMinor: 100n,
    }),
  );
  await expectDatabaseRejection(client, "renewal_credit_overallocation", /does not match/i, () =>
    insertForgedRenewalAllocation({
      actorType: "system",
      actorId: null,
      amountMinor: 1500n,
    }),
  );

  await recordFixturePayment(client, {
    clientAccountId: mainAccount.clientAccountId,
    invoiceId: mainRenewal.invoice_id,
    amountMinor: 1234n,
  });
  const firstSettlement = await advancePaidInvoice(client, mainRenewal.invoice_id, {
    kind: "user_command",
    userId: mainAccount.userId,
  });
  const duplicateSettlement = await advancePaidInvoice(client, mainRenewal.invoice_id, {
    kind: "user_command",
    userId: mainAccount.userId,
  });
  assert.equal(firstSettlement.renewalStatus, "paid");
  assert.equal(duplicateSettlement.renewalStatus, "paid");
  const mainAfterPayment = await client.query<{
    term_end: Date;
    periods: string;
    resource_creates: string;
  }>(
    `SELECT service.term_end,
            (SELECT count(*)::text FROM service_periods period
             WHERE period.service_id = service.id AND period.period_kind = 'renewal') AS periods,
            (SELECT count(*)::text FROM provider_operations operation
             WHERE operation.subject_type = 'service'
               AND operation.subject_id = service.id
               AND operation.kind = 'resource_create') AS resource_creates
     FROM services service
     WHERE service.id = $1`,
    [mainService.serviceId],
  );
  assert.equal(mainAfterPayment.rows[0]?.term_end.toISOString(), NEXT_TERM_END.toISOString());
  assert.equal(mainAfterPayment.rows[0]?.periods, "1");
  assert.equal(mainAfterPayment.rows[0]?.resource_creates, "0");

  await client.query("UPDATE client_accounts SET restricted_at = now() WHERE id = $1", [
    holdAccount.clientAccountId,
  ]);
  await recordFixturePayment(client, {
    clientAccountId: holdAccount.clientAccountId,
    invoiceId: holdRenewal.invoice_id,
    amountMinor: 700n,
  });
  const heldSettlement = await advancePaidInvoice(client, holdRenewal.invoice_id, {
    kind: "user_command",
    userId: holdAccount.userId,
  });
  assert.equal(heldSettlement.renewalStatus, "manual_hold");
  const held = await loadRenewal(client, holdService.serviceId);
  assert.equal(held.status, "manual_hold");
  assert.ok(held.funded_at, "full funds must remain recorded while eligibility is on Hold");
  assert.equal(held.settled_at, null);
  const heldTerm = await client.query<{ term_end: Date }>(
    "SELECT term_end FROM services WHERE id = $1",
    [holdService.serviceId],
  );
  assert.equal(heldTerm.rows[0]?.term_end.toISOString(), TERM_END.toISOString());

  await client.query(
    `UPDATE client_accounts SET restricted_at = NULL WHERE id = $1`,
    [holdAccount.clientAccountId],
  );
  await client.query(
    `UPDATE client_memberships SET role = 'viewer'
     WHERE client_account_id = $1 AND user_id = $2`,
    [holdAccount.clientAccountId, holdAccount.userId],
  );
  const viewerSettlement = await advancePaidInvoice(client, holdRenewal.invoice_id, {
    kind: "user_command",
    userId: holdAccount.userId,
  });
  assert.equal(
    viewerSettlement.renewalStatus,
    "manual_hold",
    "a payer downgraded to Viewer must not grant the funded service period",
  );
  const heldAfterViewer = await loadRenewal(client, holdService.serviceId);
  await client.query(
    `UPDATE client_memberships SET role = 'owner'
     WHERE client_account_id = $1 AND user_id = $2`,
    [holdAccount.clientAccountId, holdAccount.userId],
  );
  const lateUserSettlement = await advancePaidInvoice(client, holdRenewal.invoice_id, {
    kind: "user_command",
    userId: holdAccount.userId,
  });
  assert.equal(
    lateUserSettlement.renewalStatus,
    "manual_hold",
    "a later user or Provider settlement must not bypass a sticky renewal Hold",
  );
  const genericStaffSettlement = await advancePaidInvoice(client, holdRenewal.invoice_id, {
    kind: "staff_manual",
    staffUserId: mainAccount.userId,
    reason: "Synthetic generic allocation must not replace the dedicated Hold decision",
  });
  assert.equal(
    genericStaffSettlement.renewalStatus,
    "manual_hold",
    "a generic staff allocation must not bypass expected-version Hold resolution",
  );
  const heldBeforeResolution = await loadRenewal(client, holdService.serviceId);
  assert.equal(heldBeforeResolution.version, heldAfterViewer.version);
  const heldPeriodBeforeResolution = await client.query<{ periods: string }>(
    `SELECT count(*)::text AS periods
     FROM service_periods
     WHERE service_id = $1 AND period_kind = 'renewal'`,
    [holdService.serviceId],
  );
  assert.equal(heldPeriodBeforeResolution.rows[0]?.periods, "0");
  await client.query(
    `INSERT INTO staff_members(user_id, roles, permissions)
     VALUES ($1, ARRAY['billing'], '["billing.automation_manage"]'::jsonb)`,
    [mainAccount.userId],
  );
  await expectDatabaseRejection(client, "renewal_hold_stale_version", /changed/i, () =>
    advancePaidInvoice(client, holdRenewal.invoice_id, {
      kind: "staff_hold_resolution",
      staffUserId: mainAccount.userId,
      expectedRenewalVersion: heldBeforeResolution.version - 1,
      reason: "Synthetic stale operator decision must be rejected",
    }),
  );
  const staffResolution = await advancePaidInvoice(client, holdRenewal.invoice_id, {
    kind: "staff_hold_resolution",
    staffUserId: mainAccount.userId,
    expectedRenewalVersion: heldBeforeResolution.version,
    reason: "Synthetic staff reviewed eligibility and granted the exact funded period",
  });
  assert.equal(staffResolution.renewalStatus, "paid");
  const heldAfterResolution = await loadRenewal(client, holdService.serviceId);
  assert.equal(heldAfterResolution.status, "paid");
  const resolvedHoldTerm = await client.query<{ term_end: Date; periods: string }>(
    `SELECT service.term_end,
            (SELECT count(*)::text FROM service_periods period
             WHERE period.service_id = service.id AND period.period_kind = 'renewal') AS periods
     FROM services service WHERE service.id = $1`,
    [holdService.serviceId],
  );
  assert.equal(resolvedHoldTerm.rows[0]?.term_end.toISOString(), NEXT_TERM_END.toISOString());
  assert.equal(resolvedHoldTerm.rows[0]?.periods, "1");
  const holdResolutionIdempotencyKey = `renewal-hold-resolution:${randomUUID()}`;
  await client.query(
    `INSERT INTO service_renewal_hold_resolutions(
       renewal_id, staff_user_id, action, reason, expected_version,
       idempotency_key, request_fingerprint, result
     ) VALUES ($1, $2, 'grant_period', $3, $4, $5, $6, $7)`,
    [
      holdRenewal.id,
      mainAccount.userId,
      "Synthetic staff reviewed eligibility and granted the exact funded period",
      heldBeforeResolution.version,
      holdResolutionIdempotencyKey,
      `renewal-hold-resolution-fingerprint:${holdRenewal.id}`,
      { renewalStatus: "paid", serviceId: holdService.serviceId },
    ],
  );
  await expectDatabaseRejection(client, "renewal_hold_idempotency", /duplicate/i, () =>
    client.query(
      `INSERT INTO service_renewal_hold_resolutions(
         renewal_id, staff_user_id, action, reason, expected_version,
         idempotency_key, request_fingerprint, result
       ) VALUES ($1, $2, 'grant_period', $3, $4, $5, $6, $7)`,
      [
        holdRenewal.id,
        mainAccount.userId,
        "A different synthetic decision must conflict on the stable key",
        heldBeforeResolution.version,
        holdResolutionIdempotencyKey,
        `different-renewal-hold-resolution-fingerprint:${holdRenewal.id}`,
        { renewalStatus: "paid", serviceId: holdService.serviceId },
      ],
    ),
  );

  const plusOneRun = await runBillingDay(client, mainAccount.userId, AT_PLUS_1, "plus-1");
  assert.equal(plusOneRun.replayed, false);
  const overdue = await client.query<{ service_id: string; offset_days: number; amount: string }>(
    `SELECT service_id, offset_days, amount_due_minor::text AS amount
     FROM renewal_reminder_intents
     WHERE kind = 'overdue_first'
       AND service_id = ANY($1::uuid[])
     ORDER BY service_id`,
    [[mainService.serviceId, partialService.serviceId, fullService.serviceId, holdService.serviceId]],
  );
  assert.deepEqual(
    overdue.rows,
    [{ service_id: partialService.serviceId, offset_days: 1, amount: "600" }],
    "paid and fully funded Hold renewals must not enqueue post-payment overdue reminders",
  );

  const mainReminderKinds = await client.query<{ kind: string }>(
    `SELECT kind
     FROM renewal_reminder_intents
     WHERE service_id = $1
     ORDER BY created_at, id`,
    [mainService.serviceId],
  );
  assert.deepEqual(
    mainReminderKinds.rows.map((row) => row.kind).sort(),
    ["pre_due", "renewal_created"],
    "settlement must suppress creation of later overdue reminder intents",
  );

  const crossAccountVisibility = await client.query<{ client_account_id: string; count: string }>(
    `SELECT service.client_account_id, count(*)::text AS count
     FROM service_renewals renewal
     JOIN services service ON service.id = renewal.service_id
     WHERE service.client_account_id = ANY($1::uuid[])
     GROUP BY service.client_account_id
     ORDER BY service.client_account_id`,
    [[mainAccount.clientAccountId, partialAccount.clientAccountId]],
  );
  assert.deepEqual(
    new Map(crossAccountVisibility.rows.map((row) => [row.client_account_id, row.count])),
    new Map([
      [mainAccount.clientAccountId, "1"],
      [partialAccount.clientAccountId, "1"],
    ]),
  );

  const overlappingPeriodInvoiceId = randomUUID();
  await client.query(
    `INSERT INTO invoices(id, client_account_id, order_id, currency, total_minor, due_at)
     VALUES ($1, $2, NULL, 'USD', 0, $3)`,
    [overlappingPeriodInvoiceId, mainAccount.clientAccountId, TERM_END],
  );
  await expectDatabaseRejection(
    client,
    "service_period_forged_renewal",
    /renewal service period does not match/i,
    () =>
      client.query(
        `INSERT INTO service_periods(
           service_id, invoice_id, period_kind, period_start, period_end, granted_at
         ) VALUES ($1, $2, 'renewal', $3, $4, now())`,
        [
          mainService.serviceId,
          overlappingPeriodInvoiceId,
          new Date("2001-01-15T01:00:00.000Z"),
          new Date("2001-02-15T01:00:00.000Z"),
        ],
      ),
  );

  const delinquencyProof = await proveDelinquencyLifecycle(client);

  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  const unbalanced = await client.query<{ id: string; imbalance: string }>(
    `SELECT journal.id, sum(line.debit_minor - line.credit_minor)::text AS imbalance
     FROM ledger_journals journal
     JOIN ledger_lines line ON line.journal_id = journal.id
     GROUP BY journal.id
     HAVING sum(line.debit_minor - line.credit_minor) <> 0`,
  );
  assert.deepEqual(unbalanced.rows, [], "every ledger journal must remain balanced");

  console.log(
    JSON.stringify(
      {
        result: "renewal lifecycle PostgreSQL integration passed",
        invoicesCreated: firstRun.invoicesCreated,
        historicalRecurringMinor: mainRenewal.recurring_minor,
        partialCreditAppliedMinor: partialRenewal.allocated_minor,
        fullCreditStatus: fullRenewal.status,
        microsecondPrecision: "preserved across invoice, renewal, Credit and payment settlement",
        duplicateSettlementPeriods: mainAfterPayment.rows[0]?.periods,
        restrictedPaymentStatus: held.status,
        resolvedHoldStatus: heldAfterResolution.status,
        overdueReminderServices: overdue.rows.map((row) => row.service_id),
        delinquency: {
          automaticServiceId: delinquencyProof.automaticServiceId,
          automaticInvoiceId: delinquencyProof.automaticInvoiceId,
          lateFeeMinor: delinquencyProof.lateFeeMinor,
          deferralStatuses: delinquencyProof.deferralStatuses,
          lateSuspendResumeStatus: delinquencyProof.resumeStatus,
        },
        ledger: "balanced",
      },
      null,
      2,
    ),
  );
  await client.query("ROLLBACK");
  client.release();
  clientReleased = true;
  await proveManualSuspensionApi(pool);
  console.log(
    JSON.stringify(
      {
        result: "manual suspension and restoration API journey passed",
        colocation: "manual suspend and restore",
        automaticProviderTakeover: "terminal or unknown evidence retained without Provider POST",
        authorization: "permission, fixed-window reauth, version and idempotency enforced",
      },
      null,
      2,
    ),
  );
  await provePaymentSettingsDecisionConflicts(pool);
  console.log(
    JSON.stringify(
      {
        result: "two-user payment-settings decision conflict journey passed",
        staleReplacement: "409 without invalidating pending consent",
        pendingMethodRemoval: "409 without revoking active authorization",
        pendingWithdrawal: "bounded generation, exact replay and ABA conflict enforced",
        confirmedReplacementAndRevoke: "fresh decision generation required",
        lockOrder: "real HTTP waited on Service while Service-first transaction locked Account; no deadlock",
        futureProviderTime: "query-only reconciliation retained the running Worker lease",
        terminalCallback: "completed the released manual reconciliation job",
        lateSuccessAfterActionRequired:
          "one balanced unclaimed receipt; invoice, service term and prior authorization unchanged",
        duplicateLateSuccess: "no duplicate receipt, journal, allocation or consent",
      },
      null,
      2,
    ),
  );
  const scheduledProof = await proveScheduledBillingDay(pool);
  console.log(
    JSON.stringify(
      {
        result: "scheduled billing day authentication and replay passed",
        runId: scheduledProof.runId,
        runs: 1,
        actor: "billing-worker",
      },
      null,
      2,
    ),
  );
  const concurrencyProof = await proveConcurrentBillingDay(pool);
  console.log(
    JSON.stringify(
      {
        result: "concurrent billing day serialization passed",
        runId: concurrencyProof.runId,
        runs: 1,
        renewals: 1,
        invoiceJournals: 1,
        renewalCreatedReminders: 1,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (!clientReleased) {
    await client.query("ROLLBACK").catch(() => undefined);
  }
  throw error;
} finally {
  if (!clientReleased) client.release();
  await pool.end();
}
