// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertSchemaCompatible, runMigrations, type DatabaseClient } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import { advancePaidInvoice } from "./invoice-settlement.js";
import { runRenewalAutomation } from "./renewal-lifecycle.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for renewal lifecycle integration");

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
    termStart?: Date;
    termEnd?: Date;
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

async function proveConcurrentBillingDay(pool: pg.Pool): Promise<{ runId: string }> {
  const setup = await pool.connect();
  const namespace = randomUUID();
  const productGroupId = `renewal-concurrency-group-${namespace}`;
  const productId = `renewal-concurrency-product-${namespace}`;
  const effectiveAt = new Date("2002-01-18T01:00:00.000Z");
  let account: FixtureAccount;
  let service: FixtureService;
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
  assert.ok(outcomes.every((outcome) => outcome.invoicesCreated === 1));

  const proof = await pool.query<{
    runs: string;
    renewals: string;
    invoice_journals: string;
    reminders: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM billing_automation_runs
        WHERE policy_id = 'default' AND business_date = '2002-01-18') AS runs,
       (SELECT count(*)::text FROM service_renewals renewal
        WHERE renewal.service_id = $1) AS renewals,
       (SELECT count(*)::text
        FROM service_renewals renewal
        JOIN ledger_journals journal
          ON journal.source_type = 'invoice_issuance'
         AND journal.source_id = renewal.invoice_id
        WHERE renewal.service_id = $1) AS invoice_journals,
       (SELECT count(*)::text FROM renewal_reminder_intents reminder
        WHERE reminder.service_id = $1 AND reminder.kind = 'renewal_created') AS reminders`,
    [service.serviceId],
  );
  assert.deepEqual(proof.rows[0], {
    runs: "1",
    renewals: "1",
    invoice_journals: "1",
    reminders: "1",
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

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
await runMigrations(pool);
await assertSchemaCompatible(pool);
const client = await pool.connect();

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

  await grantFixtureCredit(client, partialAccount, 400n);
  await grantFixtureCredit(client, fullAccount, 1000n);

  const firstRun = await runBillingDay(client, mainAccount.userId, AT_MINUS_14, "minus-14");
  assert.equal(firstRun.replayed, false);
  assert.equal(firstRun.invoicesCreated, 5);

  const mainRenewal = await loadRenewal(client, mainService.serviceId);
  const partialRenewal = await loadRenewal(client, partialService.serviceId);
  const fullRenewal = await loadRenewal(client, fullService.serviceId);
  const holdRenewal = await loadRenewal(client, holdService.serviceId);
  const calendarRenewal = await loadRenewal(client, calendarService.serviceId);
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
  assert.equal(
    calendarRenewal.period_start.toISOString(),
    CALENDAR_TERM_END.toISOString(),
    "a term ending late on the fourteenth Shanghai calendar day must be invoiced",
  );
  assert.equal(calendarRenewal.period_end.toISOString(), CALENDAR_NEXT_TERM_END.toISOString());

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
  await expectDatabaseRejection(client, "renewal_cross_account", /inconsistent/i, () =>
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
  await client.query(
    `INSERT INTO staff_members(user_id, roles, permissions)
     VALUES ($1, ARRAY['billing'], '["billing.automation_manage"]'::jsonb)`,
    [mainAccount.userId],
  );
  await expectDatabaseRejection(client, "renewal_hold_stale_version", /changed/i, () =>
    advancePaidInvoice(client, holdRenewal.invoice_id, {
      kind: "staff_manual",
      staffUserId: mainAccount.userId,
      expectedRenewalVersion: heldAfterViewer.version - 1,
      reason: "Synthetic stale operator decision must be rejected",
    }),
  );
  const staffResolution = await advancePaidInvoice(client, holdRenewal.invoice_id, {
    kind: "staff_manual",
    staffUserId: mainAccount.userId,
    expectedRenewalVersion: heldAfterViewer.version,
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
      heldAfterViewer.version,
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
        heldAfterViewer.version,
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
        duplicateSettlementPeriods: mainAfterPayment.rows[0]?.periods,
        restrictedPaymentStatus: held.status,
        resolvedHoldStatus: heldAfterResolution.status,
        overdueReminderServices: overdue.rows.map((row) => row.service_id),
        ledger: "balanced",
      },
      null,
      2,
    ),
  );
  await client.query("ROLLBACK");
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
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
