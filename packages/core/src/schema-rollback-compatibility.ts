// SPDX-License-Identifier: AGPL-3.0-or-later

export const SCHEMA_014 = "014_stage_b_cycle_end_cancellation" as const;
export const SCHEMA_015 = "015_stage_b_saved_payment_auto_renew" as const;

export type SchemaRollbackBlocker = Readonly<{
  code: string;
  count: number;
}>;

export type SchemaRollbackPreflightReport = Readonly<{
  installedSchemaVersion: string;
  applicationSchemaVersion: typeof SCHEMA_014;
  mode: "native" | "rollback_bridge";
  safe: true;
  blockers: readonly SchemaRollbackBlocker[];
}>;

export type RollbackPreflightQueryable = Readonly<{
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<Readonly<{ rows: unknown[] }>>;
}>;

export class SchemaRollbackPreflightError extends Error {
  readonly installedSchemaVersion: string | null;
  readonly blockers: readonly SchemaRollbackBlocker[];

  constructor(
    message: string,
    installedSchemaVersion: string | null,
    blockers: readonly SchemaRollbackBlocker[] = [],
  ) {
    super(message);
    this.name = "SchemaRollbackPreflightError";
    this.installedSchemaVersion = installedSchemaVersion;
    this.blockers = blockers;
  }
}

function rowRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Schema rollback preflight returned an invalid database row");
  }
  return row as Record<string, unknown>;
}

function countValue(value: unknown, code: string): number {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Schema rollback preflight returned an invalid count for ${code}`);
  }
  return count;
}

async function installedSchemaVersion(database: RollbackPreflightQueryable): Promise<string | null> {
  let result: Readonly<{ rows: unknown[] }>;
  try {
    result = await database.query("SELECT max(version) AS version FROM schema_migrations");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "42P01") return null;
    throw error;
  }
  const value = result.rows[0] ? rowRecord(result.rows[0]).version : null;
  return typeof value === "string" ? value : null;
}

async function assertExpandedSchemaShape(database: RollbackPreflightQueryable): Promise<void> {
  const result = await database.query(
    `SELECT
       to_regclass('public.payment_method_token_key_materials') IS NOT NULL
         AND (
           SELECT count(*) = 4
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'payment_method_token_key_materials'
             AND column_name IN (
               'material_fingerprint', 'key_kind', 'key_version', 'registered_at'
             )
         ) AS has_token_key_materials,
       to_regclass('public.payment_method_token_encryption_keys') IS NOT NULL
         AND (
           SELECT count(*) = 3
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'payment_method_token_encryption_keys'
             AND column_name IN ('version', 'key_fingerprint', 'registered_at')
         ) AS has_token_encryption_keys,
       to_regclass('public.payment_method_token_lookup_keys') IS NOT NULL
         AND (
           SELECT count(*) = 3
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'payment_method_token_lookup_keys'
             AND column_name IN ('version', 'key_fingerprint', 'registered_at')
         ) AS has_token_lookup_keys,
       to_regclass('public.saved_payment_methods') IS NOT NULL AS has_saved_methods,
       to_regclass('public.automatic_renewal_authorizations') IS NOT NULL AS has_authorizations,
       to_regclass('public.payment_consent_events') IS NOT NULL AS has_consent_events,
       to_regclass('public.automatic_renewal_runs') IS NOT NULL AS has_automatic_runs,
       (
         SELECT count(*) = 2
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'payment_methods'
           AND column_name IN (
             'saved_method_enabled',
             'automatic_renewal_enabled'
           )
       ) AS has_payment_method_columns,
       (
         SELECT count(*) = 2
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'services'
           AND column_name IN (
             'automatic_renewal_consent_generation',
             'automatic_renewal_decision_generation'
           )
       ) AS has_service_generation_columns,
       (
         SELECT count(*) = 10
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'payment_attempts'
           AND column_name IN (
             'save_payment_method_requested',
             'save_consent_version',
             'automatic_renewal_requested',
             'automatic_renewal_consent_version',
             'automatic_renewal_service_id',
             'automatic_renewal_decision_generation',
             'saved_payment_method_id',
             'automatic_renewal_authorization_id',
             'created_automatic_renewal_authorization_id',
             'automatic_attempt_number'
           )
       ) AS has_payment_attempt_columns`,
  );
  const shape = rowRecord(result.rows[0]);
  const valid = [
    "has_token_key_materials",
    "has_token_encryption_keys",
    "has_token_lookup_keys",
    "has_saved_methods",
    "has_authorizations",
    "has_consent_events",
    "has_automatic_runs",
    "has_payment_method_columns",
    "has_service_generation_columns",
    "has_payment_attempt_columns",
  ].every((key) => shape[key] === true);
  if (!valid) {
    throw new SchemaRollbackPreflightError(
      "Schema 015 is incomplete or counterfeit; do not start the 014 rollback bridge. Deploy a compatible application and repair forward without a down migration.",
      SCHEMA_015,
    );
  }
}

async function expandedSchemaBlockers(
  database: RollbackPreflightQueryable,
): Promise<readonly SchemaRollbackBlocker[]> {
  const result = await database.query(
    `WITH blocker_counts(code, count) AS (
       SELECT 'saved_payment_methods', count(*)::bigint
       FROM saved_payment_methods
       UNION ALL
       SELECT 'automatic_renewal_authorizations', count(*)::bigint
       FROM automatic_renewal_authorizations
       UNION ALL
       SELECT 'payment_consent_events', count(*)::bigint
       FROM payment_consent_events
       UNION ALL
       SELECT 'automatic_renewal_runs', count(*)::bigint
       FROM automatic_renewal_runs
       UNION ALL
       SELECT 'automatic_renewal_service_generations', count(*)::bigint
       FROM services service
       WHERE service.automatic_renewal_consent_generation <> 0
          OR service.automatic_renewal_decision_generation <> 0
       UNION ALL
       SELECT 'saved_payment_attempts', count(*)::bigint
       FROM payment_attempts attempt
       WHERE attempt.save_payment_method_requested
          OR attempt.save_consent_version IS NOT NULL
          OR attempt.automatic_renewal_requested
          OR attempt.automatic_renewal_consent_version IS NOT NULL
          OR attempt.automatic_renewal_service_id IS NOT NULL
          OR attempt.automatic_renewal_decision_generation IS NOT NULL
          OR attempt.saved_payment_method_id IS NOT NULL
          OR attempt.automatic_renewal_authorization_id IS NOT NULL
          OR attempt.created_automatic_renewal_authorization_id IS NOT NULL
          OR attempt.automatic_attempt_number <> 0
          OR attempt.status = 'requires_action'
       UNION ALL
       SELECT 'automatic_provider_operations', count(*)::bigint
       FROM provider_operations operation
       WHERE operation.status IN ('queued', 'running', 'unknown')
         AND (
           EXISTS (
             SELECT 1 FROM automatic_renewal_runs run
             WHERE run.payment_attempt_id = operation.subject_id
           )
           OR EXISTS (
             SELECT 1 FROM payment_attempts attempt
             WHERE attempt.id = operation.subject_id
               AND (
                 attempt.save_payment_method_requested
                 OR attempt.save_consent_version IS NOT NULL
                 OR attempt.automatic_renewal_requested
                 OR attempt.automatic_renewal_consent_version IS NOT NULL
                 OR attempt.automatic_renewal_service_id IS NOT NULL
                 OR attempt.automatic_renewal_decision_generation IS NOT NULL
                 OR attempt.saved_payment_method_id IS NOT NULL
                 OR attempt.automatic_renewal_authorization_id IS NOT NULL
                 OR attempt.created_automatic_renewal_authorization_id IS NOT NULL
                 OR attempt.automatic_attempt_number <> 0
                 OR attempt.status = 'requires_action'
               )
           )
         )
       UNION ALL
       SELECT 'automatic_durable_jobs', count(*)::bigint
       FROM durable_jobs job
       WHERE job.status IN ('pending', 'running', 'manual')
         AND (
           job.payload ? 'automaticRenewalRunId'
           OR EXISTS (
             SELECT 1 FROM payment_attempts attempt
             WHERE attempt.id::text = job.payload->>'paymentAttemptId'
               AND (
                 attempt.save_payment_method_requested
                 OR attempt.save_consent_version IS NOT NULL
                 OR attempt.automatic_renewal_requested
                 OR attempt.automatic_renewal_consent_version IS NOT NULL
                 OR attempt.automatic_renewal_service_id IS NOT NULL
                 OR attempt.automatic_renewal_decision_generation IS NOT NULL
                 OR attempt.saved_payment_method_id IS NOT NULL
                 OR attempt.automatic_renewal_authorization_id IS NOT NULL
                 OR attempt.created_automatic_renewal_authorization_id IS NOT NULL
                 OR attempt.automatic_attempt_number <> 0
                 OR attempt.status = 'requires_action'
               )
           )
         )
       UNION ALL
       SELECT 'saved_payment_provider_inbox', count(*)::bigint
       FROM provider_inbox inbox
       WHERE inbox.payload ? 'savedPaymentMethod'
          OR inbox.payload->>'status' = 'requires_action'
       UNION ALL
       SELECT 'automatic_outbox', count(*)::bigint
       FROM outbox event
       WHERE event.published_at IS NULL
         AND (
           event.payload ? 'automaticRenewalRunId'
           OR event.payload ? 'savedPaymentMethodId'
           OR event.payload ? 'automaticRenewalAuthorizationId'
           OR event.event_type LIKE 'automatic_renewal.%'
         )
     )
     SELECT code, count::text AS count
     FROM blocker_counts
     WHERE count > 0
     ORDER BY code`,
  );
  return result.rows.map((row) => {
    const record = rowRecord(row);
    if (typeof record.code !== "string") {
      throw new Error("Schema rollback preflight returned an invalid blocker code");
    }
    return Object.freeze({
      code: record.code,
      count: countValue(record.count, record.code),
    });
  });
}

export async function assert014RollbackBridgeSafe(
  database: RollbackPreflightQueryable,
  input: Readonly<{ enable015RollbackBridge: boolean }>,
): Promise<SchemaRollbackPreflightReport> {
  const installed = await installedSchemaVersion(database);
  if (!installed) {
    throw new SchemaRollbackPreflightError(
      "OpenSales schema is missing. Initialize it with the dedicated migrate command before starting the application.",
      null,
    );
  }
  if (installed === SCHEMA_014) {
    return Object.freeze({
      installedSchemaVersion: installed,
      applicationSchemaVersion: SCHEMA_014,
      mode: "native",
      safe: true,
      blockers: Object.freeze([]),
    });
  }
  if (installed !== SCHEMA_015) {
    const direction = installed < SCHEMA_014 ? "older" : "newer";
    throw new SchemaRollbackPreflightError(
      `OpenSales schema ${installed} is ${direction} than this bridge supports. ${
        direction === "older"
          ? "Run the dedicated forward migration command."
          : "Deploy an application that explicitly supports that schema; do not run a down migration."
      }`,
      installed,
    );
  }
  if (!input.enable015RollbackBridge) {
    throw new SchemaRollbackPreflightError(
      "Schema 015 requires the reviewed 014 rollback bridge and explicit OSS_SCHEMA_ROLLBACK_BRIDGE=014-to-015 after the rollback runbook preflight. Ordinary 014 images must remain stopped.",
      installed,
    );
  }

  await assertExpandedSchemaShape(database);
  const blockers = await expandedSchemaBlockers(database);
  if (blockers.length > 0) {
    throw new SchemaRollbackPreflightError(
      `Rollback to the 014 bridge is blocked by 015-only business facts: ${blockers
        .map(({ code, count }) => `${code}=${count}`)
        .join(", ")}. Keep dispatch and callback ingress paused, reconcile or drain with the 015 application, then repair forward. This bridge never deletes or rewrites these facts.`,
      installed,
      blockers,
    );
  }

  return Object.freeze({
    installedSchemaVersion: installed,
    applicationSchemaVersion: SCHEMA_014,
    mode: "rollback_bridge",
    safe: true,
    blockers: Object.freeze([]),
  });
}
