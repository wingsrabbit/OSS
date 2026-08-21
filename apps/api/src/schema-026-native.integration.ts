// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  SCHEMA_025,
  assertSchema025NativeSafe,
} from "@opensales/core/schema-024-025-native-compatibility";
import {
  EXPECTED_SCHEMA_026_HISTORY,
  SCHEMA_026,
  SCHEMA_026_CATALOG_DIGEST,
  assertSchema026NativeSafe,
  schema026CatalogDigest,
  schema026CatalogFingerprintInput,
} from "@opensales/core/schema-025-026-native-compatibility";
import pg from "pg";
import {
  assertSchemaCompatible,
  holdSchema025ApplicationGuard,
  holdSchema026ApplicationGuard,
  runMigrations,
  type DatabasePool,
} from "./database.js";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Schema 026 native integration");
}

const admin = new pg.Client({ connectionString: adminDatabaseUrl });

async function waitForDatabaseConnectionsToClose(
  databaseName: string,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (true) {
    const connections = await admin.query<{ count: string }>(
      `SELECT pg_catalog.count(*)::text AS count
       FROM pg_catalog.pg_stat_activity
       WHERE datname = $1`,
      [databaseName],
    );
    const count = Number(connections.rows[0]?.count ?? "0");
    if (count === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Schema 026 database ${databaseName} still has ${count} connection(s) after pool shutdown`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function withFreshDatabase(
  label: string,
  run: (pool: DatabasePool) => Promise<void>,
): Promise<void> {
  const databaseName = `oss_schema026_${label}_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(adminDatabaseUrl!);
  databaseUrl.pathname = `/${databaseName}`;
  let pool: DatabasePool | null = null;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  try {
    pool = new pg.Pool({
      connectionString: databaseUrl.toString(),
      max: 8,
      options: "-c search_path=pg_catalog,public",
      statement_timeout: 20_000,
      application_name: `opensales-schema026-${label}`,
    });
    await run(pool);
  } finally {
    await pool?.end();
    await waitForDatabaseConnectionsToClose(databaseName);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  }
}

async function assertCatalogTamperRejected(
  pool: DatabasePool,
  statement: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(statement);
      await assert.rejects(
        assertSchema026NativeSafe({
          query: async (text, values) => client.query(text, values),
        }),
        /Schema 026 is incomplete or counterfeit/,
      );
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
}

type SavedSchema025Cancellation = Readonly<{
  serviceId: string;
  requestId: string;
  executionId: string;
  manualActionId: string;
}>;

async function insertSavedSchema025Cancellation(
  pool: DatabasePool,
): Promise<SavedSchema025Cancellation> {
  const userId = randomUUID();
  const accountId = randomUUID();
  const sessionId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const serviceId = randomUUID();
  const requestId = randomUUID();
  const executionId = randomUUID();
  const manualActionId = randomUUID();
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO public.product_groups(id, sort_order, names)
       VALUES (
         'schema-026-saved-service', 998,
         '{"en":"Saved Schema 025 service","zh-CN":"保存的 Schema 025 服务"}'::jsonb
       )`,
    );
    await client.query(
      `INSERT INTO public.products(
         id, group_id, names, descriptions, fulfillment_mode, active, hidden,
         repeatable, option_schema
       ) VALUES (
         'schema-026-saved-service', 'schema-026-saved-service',
         '{"en":"Saved Schema 025 service","zh-CN":"保存的 Schema 025 服务"}'::jsonb,
         '{"en":"Synthetic saved migration fact","zh-CN":"合成保存迁移事实"}'::jsonb,
         'automatic', true, true, true, '[]'::jsonb
      )`,
    );
    await client.query(
      `INSERT INTO public.product_service_automation_policies(
         product_id, overdue_action, provider_installation_id,
         overdue_delay_mode, overdue_delay_value, version,
         cycle_end_cancellation_mode, cycle_end_cancellation_execution_mode,
         cycle_end_cancellation_min_notice_hours,
         cycle_end_cancellation_requirement_key
       ) VALUES (
         'schema-026-saved-service', 'manual', NULL,
         'policy_calendar_days', 5, 1,
         'self_service', 'manual', 0, NULL
       )`,
    );
    await client.query(
      `INSERT INTO public.users(id, email, password_hash, locale, email_verified_at)
       VALUES ($1, $2, 'synthetic-not-a-password', 'en', '2025-01-01T00:00:00Z')`,
      [userId, `schema-026-saved-${userId}@example.invalid`],
    );
    await client.query(
      `INSERT INTO public.client_accounts(id, name, owner_user_id)
       VALUES ($1, 'Synthetic saved Schema 025 account', $2)`,
      [accountId, userId],
    );
    await client.query(
      `INSERT INTO public.client_memberships(
         client_account_id, user_id, role, permissions
       ) VALUES ($1, $2, 'owner', '[]'::jsonb)`,
      [accountId, userId],
    );
    await client.query(
      `INSERT INTO public.sessions(
         id, user_id, token_digest, expires_at,
         active_client_account_id, account_context_version
       ) VALUES (
         $1, $2, $3,
         pg_catalog.clock_timestamp() + interval '1 hour', $4, 1
       )`,
      [
        sessionId,
        userId,
        createHash("sha256").update(sessionId).digest(),
        accountId,
      ],
    );
    await client.query(
      `INSERT INTO public.staff_members(user_id, roles, permissions)
       VALUES (
         $1, ARRAY['ServiceOperations']::text[],
         '["services.read","services.manual_fulfillment"]'::jsonb
       )`,
      [userId],
    );
    await client.query(
      `INSERT INTO public.reauth_grants(user_id, session_id, expires_at)
       VALUES ($1, $2, pg_catalog.now() + interval '14 minutes')`,
      [userId, sessionId],
    );
    await client.query(
      `INSERT INTO public.orders(
         id, client_account_id, submitted_by_user_id, status, currency,
         price_snapshot, one_time_minor, setup_minor, recurring_minor,
         total_minor, idempotency_key, request_fingerprint
       ) VALUES (
         $1, $2, $3, 'completed', 'USD', '{}'::jsonb,
         0, 0, 100, 100, $4, $5
       )`,
      [
        orderId,
        accountId,
        userId,
        `schema-026-saved-order-${orderId}`,
        createHash("sha256").update(orderId).digest("hex"),
      ],
    );
    await client.query(
      `INSERT INTO public.order_items(
         id, order_id, product_id, product_name, fulfillment_mode,
         billing_cycle, configuration, price_snapshot, client_account_id
       ) VALUES (
         $1, $2, 'schema-026-saved-service', 'Saved Schema 025 service',
         'automatic', 'monthly', '{}'::jsonb, '{}'::jsonb, $3
       )`,
      [orderItemId, orderId, accountId],
    );
    await client.query(
      `INSERT INTO public.services(
         id, client_account_id, order_item_id, status, billing_cycle,
         external_resource_id, activated_at, term_start, term_end
       ) VALUES (
         $1, $2, $3, 'active', 'monthly', $4,
         pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
         pg_catalog.clock_timestamp() + interval '1 second'
       )`,
      [serviceId, accountId, orderItemId, `mock-saved-${serviceId}`],
    );
    await client.query(
      `INSERT INTO public.service_provider_bindings(
         service_id, provider_installation_id, overdue_action_snapshot,
         capability_snapshot, product_policy_version,
         cycle_end_cancellation_mode_snapshot,
         cycle_end_cancellation_execution_mode_snapshot,
         cycle_end_cancellation_min_notice_hours_snapshot,
         cycle_end_cancellation_requirement_key_snapshot
       ) VALUES (
         $1, NULL, 'manual', '[]'::jsonb, 1,
         'self_service', 'manual', 0, NULL
       )`,
      [serviceId],
    );
    const source = await client.query<{ version: number; term_end: Date; requested_at: Date }>(
      `SELECT version, term_end, pg_catalog.clock_timestamp() AS requested_at
       FROM public.services WHERE id = $1 FOR UPDATE`,
      [serviceId],
    );
    const service = source.rows[0];
    assert.ok(service);
    const requestResult = {
      cancellation: { requestId, status: "scheduled", executionMode: "manual" },
      serviceVersion: service.version + 1,
    };
    await client.query(
      `INSERT INTO public.service_cancellation_requests(
         id, service_id, client_account_id, requested_by_user_id,
         requested_session_id, effective_at, expected_service_version,
         product_policy_version, policy_snapshot, notice_qualified_at,
         authorization_ticket_id, reason, idempotency_key,
         request_fingerprint, result, created_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         (SELECT term_end FROM public.services WHERE id = $2), $6, 1,
         '{"schedulingMode":"self_service","executionMode":"manual","minimumNoticeHours":0,"requirementKey":null}'::jsonb,
         $7, NULL, 'Synthetic saved Schema 025 cancellation request',
         $8, $9, $10, $7
       )`,
      [
        requestId,
        serviceId,
        accountId,
        userId,
        sessionId,
        service.version,
        service.requested_at,
        `saved-025-request-${requestId}`,
        createHash("sha256").update(requestId).digest("hex"),
        requestResult,
      ],
    );
    await client.query(
      `UPDATE public.services
       SET cancellation_request_id = $2,
           cancellation_scheduled_at = $3,
           cancellation_effective_at = term_end,
           version = version + 1,
           updated_at = pg_catalog.clock_timestamp()
       WHERE id = $1 AND version = $4`,
      [serviceId, requestId, service.requested_at, service.version],
    );
    await client.query(
      `INSERT INTO public.service_cancellation_executions(
         id, cancellation_request_id, service_id, execution_mode,
         provider_installation_id, provider_capability_snapshot,
         status, result, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'manual', NULL,
         '{"atBinding":[],"current":[]}'::jsonb,
         'scheduled', '{"status":"scheduled"}'::jsonb, $4, $4
       )`,
      [executionId, requestId, serviceId, service.requested_at],
    );
    await client.query(
      `INSERT INTO public.durable_jobs(job_type, unique_key, payload, available_at)
       VALUES (
         'service.cancellation.due', $1,
         pg_catalog.jsonb_build_object(
           'cancellationRequestId', $2::text,
           'executionId', $3::text,
           'serviceId', $4::text
         ), (SELECT term_end FROM public.services WHERE id = $4::uuid)
       )`,
      [
        `service-cancellation:${requestId}:terminate`,
        requestId,
        executionId,
        serviceId,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  await pool.query(
    `SELECT pg_catalog.pg_sleep(
       GREATEST(
         0,
         EXTRACT(EPOCH FROM term_end - pg_catalog.clock_timestamp()) + 0.05
       )
     )
     FROM public.services WHERE id = $1`,
    [serviceId],
  );

  const completion = await pool.connect();
  await completion.query("BEGIN");
  try {
    const manual = await completion.query<{ version: number }>(
      `UPDATE public.service_cancellation_executions
       SET status = 'manual', result = '{"status":"manual"}'::jsonb,
           updated_at = pg_catalog.clock_timestamp(), version = version + 1
       WHERE id = $1 AND status = 'scheduled'
       RETURNING version`,
      [executionId],
    );
    const service = await completion.query<{ version: number }>(
      "SELECT version FROM public.services WHERE id = $1 FOR UPDATE",
      [serviceId],
    );
    assert.equal(manual.rowCount, 1);
    assert.equal(service.rowCount, 1);
    const executionVersion = manual.rows[0]!.version;
    const serviceVersion = service.rows[0]!.version;
    const result = {
      actionId: manualActionId,
      executionId,
      serviceId,
      executionStatus: "terminated",
      serviceStatus: "terminated",
      takeoverKind: "manual_delivery",
      providerCalled: false,
    };
    await completion.query(
      `INSERT INTO public.service_cancellation_manual_actions(
         id, execution_id, service_id, staff_user_id, staff_session_id,
         staff_client_account_id, takeover_kind, expected_execution_version,
         expected_service_version, reason, idempotency_key,
         request_fingerprint, result
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'manual_delivery', $7, $8,
         'Synthetic saved Schema 025 manual cancellation completion',
         $9, $10, $11
       )`,
      [
        manualActionId,
        executionId,
        serviceId,
        userId,
        sessionId,
        accountId,
        executionVersion,
        serviceVersion,
        `saved-025-action-${manualActionId}`,
        createHash("sha256").update(manualActionId).digest("hex"),
        result,
      ],
    );
    await completion.query(
      `UPDATE public.services
       SET status = 'terminated', updated_at = pg_catalog.clock_timestamp(),
           version = version + 1
       WHERE id = $1 AND version = $2`,
      [serviceId, serviceVersion],
    );
    await completion.query(
      `UPDATE public.service_cancellation_executions
       SET status = 'terminated', result = $2, last_error = NULL,
           completed_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp(), version = version + 1
       WHERE id = $1 AND version = $3 AND status = 'manual'`,
      [executionId, result, executionVersion],
    );
    await completion.query("COMMIT");
  } catch (error) {
    await completion.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    completion.release();
  }
  return { serviceId, requestId, executionId, manualActionId };
}

await admin.connect();
try {
  await withFreshDatabase("fresh", async (pool) => {
    await runMigrations(pool, { throughVersion: SCHEMA_025 });
    await assertSchema025NativeSafe(pool);
    await assert.rejects(assertSchema026NativeSafe(pool), new RegExp(SCHEMA_026));

    await runMigrations(pool, { throughVersion: SCHEMA_026 });
    await assert.rejects(
      assertSchema025NativeSafe(pool),
      /026_stage_c_service_cancellation_authority.*025_stage_c_content_operations/,
    );
    const report = await assertSchema026NativeSafe(pool);
    assert.deepEqual(report, {
      installedSchemaVersion: SCHEMA_026,
      applicationSchemaVersion: SCHEMA_026,
      mode: "native",
      safe: true,
      blockers: [],
    });
    const fingerprint = await schema026CatalogFingerprintInput(pool);
    assert.ok(fingerprint, "Schema 026 catalog selector must produce a fingerprint");
    assert.equal(schema026CatalogDigest(fingerprint), SCHEMA_026_CATALOG_DIGEST);
    const catalogKinds = fingerprint.split("\n").reduce<Record<string, number>>(
      (counts, line) => {
        const kind = line.split("|", 1)[0]!;
        counts[kind] = (counts[kind] ?? 0) + 1;
        return counts;
      },
      {},
    );
    assert.deepEqual(catalogKinds, { function: 2, trigger: 2 });

    const history = await pool.query<{ versions: string[] }>(
      `SELECT pg_catalog.array_agg(version ORDER BY version COLLATE "C") AS versions
       FROM public.schema_migrations`,
    );
    assert.deepEqual(history.rows[0]?.versions, [...EXPECTED_SCHEMA_026_HISTORY]);
    await assert.rejects(
      assertSchemaCompatible(pool),
      /026_stage_c_service_cancellation_authority.*029_stage_c_service_password_changes/,
    );

    for (const statement of [
      `CREATE OR REPLACE FUNCTION public.opensales_validate_service_cancellation_request()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
       AS $tampered$ BEGIN RETURN NEW; END; $tampered$`,
      `CREATE OR REPLACE FUNCTION public.opensales_validate_service_cancellation_manual_action()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public
       AS $tampered$ BEGIN RETURN NEW; END; $tampered$`,
      "ALTER TABLE public.service_cancellation_requests DISABLE TRIGGER service_cancellation_requests_insert_guard",
      "DROP TRIGGER service_cancellation_manual_actions_insert_guard ON public.service_cancellation_manual_actions",
    ]) {
      await assertCatalogTamperRejected(pool, statement);
    }

    for (const [statement, message] of [
      ["DROP INDEX public.content_entries_kind_audience_idx", /Schema 025 is incomplete or counterfeit/],
      ["DROP INDEX public.identity_action_facts_transaction_once", /Schema 024 is incomplete or counterfeit/],
    ] as const) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          await client.query(statement);
          await assert.rejects(
            assertSchema026NativeSafe({
              query: async (text, values) => client.query(text, values),
            }),
            message,
          );
        } finally {
          await client.query("ROLLBACK");
        }
      } finally {
        client.release();
      }
    }

    const historyClient = await pool.connect();
    try {
      await historyClient.query("BEGIN");
      try {
        await historyClient.query(
          "DELETE FROM public.schema_migrations WHERE version = '025_stage_c_content_operations'",
        );
        await assert.rejects(
          assertSchema026NativeSafe({
            query: async (text, values) => historyClient.query(text, values),
          }),
          /Schema 026 migration history is incomplete/,
        );
      } finally {
        await historyClient.query("ROLLBACK");
      }
    } finally {
      historyClient.release();
    }
    const extraHistoryClient = await pool.connect();
    try {
      await extraHistoryClient.query("BEGIN");
      try {
        await extraHistoryClient.query(
          "INSERT INTO public.schema_migrations(version) VALUES ('025_unreviewed_schema')",
        );
        await assert.rejects(
          assertSchema026NativeSafe({
            query: async (text, values) => extraHistoryClient.query(text, values),
          }),
          /Schema 026 migration history is incomplete/,
        );
      } finally {
        await extraHistoryClient.query("ROLLBACK");
      }
    } finally {
      extraHistoryClient.release();
    }

    const releaseSchema025Guard = await holdSchema025ApplicationGuard(pool);
    try {
      await assert.rejects(
        runMigrations(pool, { throughVersion: SCHEMA_026 }),
        /running schema-025 API or Worker/,
      );
    } finally {
      await releaseSchema025Guard();
    }
    const releaseSchema026Guard = await holdSchema026ApplicationGuard(pool);
    try {
      await assert.rejects(
        runMigrations(pool, { throughVersion: SCHEMA_026 }),
        /running schema-026 API or Worker/,
      );
    } finally {
      await releaseSchema026Guard();
    }
    await assertSchema026NativeSafe(pool);
  });

  await withFreshDatabase("saved025", async (pool) => {
    await runMigrations(pool, { throughVersion: SCHEMA_025 });
    const saved = await insertSavedSchema025Cancellation(pool);
    const readFacts = async (): Promise<Record<string, unknown>> => {
      const result = await pool.query<{ facts: Record<string, unknown> }>(
        `SELECT pg_catalog.jsonb_build_object(
                  'service', pg_catalog.to_jsonb(service),
                  'request', pg_catalog.to_jsonb(request),
                  'execution', pg_catalog.to_jsonb(execution),
                  'manualAction', pg_catalog.to_jsonb(manual_action)
                ) AS facts
         FROM public.services service
         JOIN public.service_cancellation_requests request
           ON request.id = $2 AND request.service_id = service.id
         JOIN public.service_cancellation_executions execution
           ON execution.id = $3 AND execution.cancellation_request_id = request.id
         JOIN public.service_cancellation_manual_actions manual_action
           ON manual_action.id = $4 AND manual_action.execution_id = execution.id
         WHERE service.id = $1`,
        [saved.serviceId, saved.requestId, saved.executionId, saved.manualActionId],
      );
      assert.equal(result.rowCount, 1);
      return result.rows[0]!.facts;
    };
    const before = await readFacts();

    await runMigrations(pool, { throughVersion: SCHEMA_026 });
    await assertSchema026NativeSafe(pool);
    assert.deepEqual(
      await readFacts(),
      before,
      "saved Schema 025 Service, Request, Execution, and Manual Action facts must remain exact",
    );
  });

  console.log(
    "Schema 026 PostgreSQL 18 native integration: PASS — fresh 001→025→026, saved Service/Request/Execution/Manual Action 025→026, exact missing/extra history and inherited catalogs, two function-body and two trigger-binding mutation classes, and both schema-025/schema-026 application guards fail closed or preserve facts as reviewed.",
  );
} finally {
  await admin.end().catch(() => undefined);
}
