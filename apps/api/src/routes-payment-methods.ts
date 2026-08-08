// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertBillingWriteEligible, assertFinancialReadEligible, requireUser } from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import { requireRecentReauthLocked } from "./routes-admin.js";

export const PAYMENT_METHOD_SAVE_CONSENT_VERSION = "lab-payment-method-save-v1";
export const AUTOMATIC_RENEWAL_CONSENT_VERSION = "lab-automatic-renewal-v2";

const decisionGenerationSchema = z.string().superRefine((value, context) => {
  if (!/^[1-9][0-9]{0,18}$|^0$/.test(value)) {
    context.addIssue({
      code: "custom",
      message: "Expected decision generation must be an unsigned decimal integer",
    });
    return;
  }
  if (BigInt(value) > 9_223_372_036_854_775_807n) {
    context.addIssue({
      code: "custom",
      message: "Expected decision generation exceeds the supported range",
    });
  }
});

const actionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

const automaticRenewalSchema = z
  .object({
    savedPaymentMethodId: z.uuid(),
    consentVersion: z.literal(AUTOMATIC_RENEWAL_CONSENT_VERSION),
    expectedAuthorizationId: z.uuid().nullable().default(null),
    expectedAuthorizationVersion: z.number().int().positive().nullable().default(null),
    expectedDecisionGeneration: decisionGenerationSchema,
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict()
  .refine(
    (value) =>
      (value.expectedAuthorizationId === null) ===
      (value.expectedAuthorizationVersion === null),
    { message: "Expected authorization id and version must both be present or both be null" },
  );

const revokeAutomaticRenewalSchema = z
  .object({
    expectedAuthorizationId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    expectedDecisionGeneration: decisionGenerationSchema,
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

const withdrawPendingAutomaticRenewalSchema = z
  .object({
    expectedPaymentAttemptId: z.uuid(),
    expectedDecisionGeneration: decisionGenerationSchema.refine(
      (value) => value !== "0",
      { message: "Expected pending decision generation must be positive" },
    ),
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

function conflict(message: string, code = "VERSION_CONFLICT"): Error {
  return Object.assign(new Error(message), { statusCode: 409, code });
}

async function lockPaymentMethodTokenReaders(client: DatabaseClient): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended('opensales:payment-method-token-rewrap', 0))",
  );
}

async function assertBillingActorLocked(
  client: DatabaseClient,
  input: { userId: string; clientAccountId: string; sessionId: string },
): Promise<void> {
  await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
  await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
    input.clientAccountId,
  ]);
  const state = await client.query<{
    email_verified_at: Date | null;
    user_restricted_at: Date | null;
    account_restricted_at: Date | null;
    removed_at: Date | null;
    role: string | null;
    session_revoked_at: Date | null;
    session_expires_at: Date | null;
  }>(
    `SELECT user_account.email_verified_at,
            user_account.restricted_at AS user_restricted_at,
            account.restricted_at AS account_restricted_at,
            membership.removed_at, membership.role,
            session.revoked_at AS session_revoked_at,
            session.expires_at AS session_expires_at
     FROM users user_account
     JOIN client_accounts account ON account.id = $2
     JOIN client_memberships membership
       ON membership.user_id = user_account.id
      AND membership.client_account_id = account.id
     JOIN sessions session
       ON session.id = $3 AND session.user_id = user_account.id
     WHERE user_account.id = $1
     FOR UPDATE OF membership, session`,
    [input.userId, input.clientAccountId, input.sessionId],
  );
  const row = state.rows[0];
  if (
    !row?.email_verified_at ||
    row.user_restricted_at ||
    row.account_restricted_at ||
    row.removed_at ||
    (row.role !== "owner" && row.role !== "billing") ||
    row.session_revoked_at ||
    !row.session_expires_at ||
    row.session_expires_at.getTime() <= Date.now()
  ) {
    throw Object.assign(new Error("Account is not eligible to manage payment settings"), {
      statusCode: 403,
      code: "ACCOUNT_NOT_ELIGIBLE",
    });
  }
}

async function replayedConsentResult(
  client: DatabaseClient,
  input: { clientAccountId: string; idempotencyKey: string; fingerprint: string },
): Promise<Record<string, unknown> | null> {
  const existing = await client.query<{
    request_fingerprint: string;
    result: Record<string, unknown>;
  }>(
    `SELECT request_fingerprint, result
     FROM payment_consent_events
     WHERE client_account_id = $1 AND idempotency_key = $2
     FOR UPDATE`,
    [input.clientAccountId, input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.request_fingerprint !== input.fingerprint) {
    throw conflict("The idempotency key was used for a different payment-setting action", "IDEMPOTENCY_CONFLICT");
  }
  return { ...row.result, replayed: true };
}

type AutomaticPaymentStopOutcome = {
  cancelledKnownUnsent: number;
  inflightReconciliationRequired: number;
};

async function stopAutomaticPaymentsForAuthorization(
  client: DatabaseClient,
  authorizationId: string,
): Promise<AutomaticPaymentStopOutcome> {
  const runs = await client.query<{
    run_id: string;
    run_status: string;
    payment_attempt_id: string;
    payment_status: string;
    operation_id: string;
    operation_status: string;
    operation_attempt_count: number;
  }>(
    `SELECT run.id AS run_id, run.status AS run_status,
            attempt.id AS payment_attempt_id, attempt.status AS payment_status,
            operation.id AS operation_id, operation.status AS operation_status,
            operation.attempt_count AS operation_attempt_count
     FROM automatic_renewal_runs run
     JOIN payment_attempts attempt ON attempt.id = run.payment_attempt_id
     JOIN provider_operations operation
       ON operation.subject_type = 'payment'
      AND operation.subject_id = attempt.id
     WHERE run.automatic_renewal_authorization_id = $1
       AND run.status IN ('processing', 'unknown')
     ORDER BY run.created_at, run.id
     FOR UPDATE OF run, attempt, operation`,
    [authorizationId],
  );
  let cancelledKnownUnsent = 0;
  let inflightReconciliationRequired = 0;
  for (const run of runs.rows) {
    const knownUnsent =
      run.run_status === "processing" &&
      run.payment_status === "created" &&
      run.operation_status === "queued" &&
      run.operation_attempt_count === 0;
    if (!knownUnsent) {
      inflightReconciliationRequired += 1;
      continue;
    }
    const reason = "automatic renewal authorization was revoked before Provider dispatch";
    await client.query(
      `UPDATE durable_jobs
       SET status = 'manual', locked_at = NULL, locked_by = NULL,
           last_error = $2, updated_at = now()
       WHERE job_type = 'payment.start'
         AND unique_key = $1
         AND status IN ('pending', 'running')`,
      [`payment:${run.payment_attempt_id}`, reason],
    );
    await client.query(
      `UPDATE provider_operations
       SET status = 'failed', last_error = $2, updated_at = now()
       WHERE id = $1 AND status = 'queued' AND attempt_count = 0`,
      [run.operation_id, reason],
    );
    await client.query(
      `UPDATE payment_attempts
       SET status = 'failed', updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'created'`,
      [run.payment_attempt_id],
    );
    await client.query(
      `UPDATE invoice_payment_commands
       SET status = 'manual', result = $2, updated_at = now()
       WHERE payment_attempt_id = $1
         AND status NOT IN ('succeeded', 'failed')`,
      [run.payment_attempt_id, { paymentStatus: "blocked", reason }],
    );
    await client.query(
      `UPDATE automatic_renewal_runs
       SET status = 'blocked', last_error = $2, updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [run.run_id, reason],
    );
    cancelledKnownUnsent += 1;
  }
  return { cancelledKnownUnsent, inflightReconciliationRequired };
}

export async function registerPaymentMethodRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/billing/payment-settings", async (request) => {
    const user = await requireUser(request, pool, config);
    assertFinancialReadEligible(user);
    const methods = await pool.query<{
      id: string;
      payment_method_code: string;
      instrument_type: string;
      brand: string;
      last_four: string;
      expiry_month: number | null;
      expiry_year: number | null;
      status: "active" | "invalid" | "removed";
      is_default: boolean;
      save_consent_version: string;
      saved_at: Date;
      version: number;
    }>(
      `SELECT id, payment_method_code, instrument_type, brand, last_four,
              expiry_month, expiry_year, status, is_default,
              save_consent_version, saved_at, version
       FROM saved_payment_methods
       WHERE client_account_id = $1 AND status <> 'removed'
       ORDER BY is_default DESC, saved_at DESC, id`,
      [user.clientAccountId],
    );
    const authorizations = await pool.query<{
      id: string;
      service_id: string;
      saved_payment_method_id: string;
      status: "active" | "revoked";
      consent_version: string;
      granted_at: Date;
      revoked_at: Date | null;
      version: number;
      product_name: string;
      latest_automatic_payment_status: string | null;
    }>(
      `SELECT renewal_authorization.id, renewal_authorization.service_id,
              renewal_authorization.saved_payment_method_id, renewal_authorization.status,
              renewal_authorization.consent_version, renewal_authorization.granted_at,
              renewal_authorization.revoked_at, renewal_authorization.version, item.product_name,
              latest_run.status AS latest_automatic_payment_status
       FROM automatic_renewal_authorizations renewal_authorization
       JOIN services service ON service.id = renewal_authorization.service_id
       JOIN order_items item ON item.id = service.order_item_id
       LEFT JOIN LATERAL (
         SELECT run.status
         FROM automatic_renewal_runs run
         WHERE run.automatic_renewal_authorization_id = renewal_authorization.id
         ORDER BY run.created_at DESC, run.id DESC
         LIMIT 1
       ) latest_run ON true
       WHERE renewal_authorization.client_account_id = $1
       ORDER BY renewal_authorization.granted_at DESC, renewal_authorization.id`,
      [user.clientAccountId],
    );
    const pendingAuthorizations = await pool.query<{
      payment_attempt_id: string;
      service_id: string;
      product_name: string;
      payment_status: "created" | "processing" | "unknown";
      consent_version: string;
      decision_generation: string;
      requested_at: Date;
    }>(
      `SELECT attempt.id AS payment_attempt_id,
              attempt.automatic_renewal_service_id AS service_id,
              item.product_name,
              attempt.status AS payment_status,
              attempt.automatic_renewal_consent_version AS consent_version,
              attempt.automatic_renewal_decision_generation::text AS decision_generation,
              attempt.created_at AS requested_at
       FROM payment_attempts attempt
       JOIN services service ON service.id = attempt.automatic_renewal_service_id
       JOIN order_items item ON item.id = service.order_item_id
       WHERE attempt.client_account_id = $1
         AND attempt.automatic_renewal_requested
         AND attempt.automatic_renewal_decision_generation =
               service.automatic_renewal_decision_generation
         AND attempt.created_automatic_renewal_authorization_id IS NULL
         AND attempt.status IN ('created', 'processing', 'unknown')
       ORDER BY attempt.created_at DESC, attempt.id`,
      [user.clientAccountId],
    );
    const serviceDecisions = await pool.query<{
      service_id: string;
      decision_generation: string;
    }>(
      `SELECT id AS service_id,
              automatic_renewal_decision_generation::text AS decision_generation
       FROM services
       WHERE client_account_id = $1
       ORDER BY id`,
      [user.clientAccountId],
    );
    return {
      warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
      defaults: { savePaymentMethod: false, automaticRenewal: false },
      consentVersions: {
        savePaymentMethod: PAYMENT_METHOD_SAVE_CONSENT_VERSION,
        automaticRenewal: AUTOMATIC_RENEWAL_CONSENT_VERSION,
      },
      methods: methods.rows.map((method) => ({
        id: method.id,
        paymentMethod: method.payment_method_code,
        instrumentType: method.instrument_type,
        brand: method.brand,
        lastFour: method.last_four,
        expiryMonth: method.expiry_month,
        expiryYear: method.expiry_year,
        status: method.status,
        default: method.is_default,
        consentVersion: method.save_consent_version,
        savedAt: method.saved_at.toISOString(),
        version: method.version,
      })),
      automaticRenewals: authorizations.rows.map((authorization) => ({
        id: authorization.id,
        serviceId: authorization.service_id,
        productName: authorization.product_name,
        savedPaymentMethodId: authorization.saved_payment_method_id,
        status: authorization.status,
        consentVersion: authorization.consent_version,
        grantedAt: authorization.granted_at.toISOString(),
        revokedAt: authorization.revoked_at?.toISOString() ?? null,
        latestAutomaticPaymentStatus: authorization.latest_automatic_payment_status,
        version: authorization.version,
      })),
      pendingAutomaticRenewals: pendingAuthorizations.rows.map((pending) => ({
        paymentAttemptId: pending.payment_attempt_id,
        serviceId: pending.service_id,
        productName: pending.product_name,
        paymentStatus: pending.payment_status,
        consentVersion: pending.consent_version,
        decisionGeneration: pending.decision_generation,
        requestedAt: pending.requested_at.toISOString(),
      })),
      serviceDecisions: serviceDecisions.rows.map((service) => ({
        serviceId: service.service_id,
        decisionGeneration: service.decision_generation,
      })),
    };
  });

  app.post("/api/v1/billing/payment-methods/:paymentMethodId/default", async (request) => {
    const user = await requireUser(request, pool, config);
    assertBillingWriteEligible(user);
    const params = z.object({ paymentMethodId: z.uuid() }).parse(request.params);
    const body = actionSchema.parse(request.body);
    const fingerprint = requestFingerprint("payment-method.default:v1", {
      paymentMethodId: params.paymentMethodId,
      expectedVersion: body.expectedVersion,
    });
    return transaction(pool, async (client) => {
      await lockPaymentMethodTokenReaders(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `payment-settings:${user.clientAccountId}`,
      ]);
      const replayed = await replayedConsentResult(client, {
        clientAccountId: user.clientAccountId,
        idempotencyKey: body.idempotencyKey,
        fingerprint,
      });
      if (replayed) return replayed;
      await assertBillingActorLocked(client, user);
      await requireRecentReauthLocked(client, user);
      const method = await client.query<{ version: number; status: string }>(
        `SELECT version, status FROM saved_payment_methods
         WHERE id = $1 AND client_account_id = $2 FOR UPDATE`,
        [params.paymentMethodId, user.clientAccountId],
      );
      const row = method.rows[0];
      if (!row) throw Object.assign(new Error("Saved payment method not found"), { statusCode: 404 });
      if (row.status !== "active") throw conflict("Saved payment method is not active", "PAYMENT_METHOD_INACTIVE");
      if (row.version !== body.expectedVersion) throw conflict("Saved payment method changed; refresh and confirm again");
      await client.query(
        `UPDATE saved_payment_methods
         SET is_default = false, updated_at = now(), version = version + 1
         WHERE client_account_id = $1 AND is_default AND id <> $2`,
        [user.clientAccountId, params.paymentMethodId],
      );
      const updated = await client.query<{ version: number }>(
        `UPDATE saved_payment_methods
         SET is_default = true, updated_at = now(), version = version + 1
         WHERE id = $1 RETURNING version`,
        [params.paymentMethodId],
      );
      const result = { paymentMethodId: params.paymentMethodId, default: true, version: updated.rows[0]?.version, replayed: false };
      await client.query(
        `INSERT INTO payment_consent_events(
           client_account_id, saved_payment_method_id, event_type,
           actor_type, actor_id, idempotency_key, request_fingerprint, result
         ) VALUES ($1, $2, 'method_made_default', 'user', $3, $4, $5, $6)`,
        [user.clientAccountId, params.paymentMethodId, user.userId, body.idempotencyKey, fingerprint, result],
      );
      return result;
    });
  });

  app.post("/api/v1/billing/payment-methods/:paymentMethodId/remove", async (request) => {
    const user = await requireUser(request, pool, config);
    assertBillingWriteEligible(user);
    const params = z.object({ paymentMethodId: z.uuid() }).parse(request.params);
    const body = actionSchema.parse(request.body);
    const fingerprint = requestFingerprint("payment-method.remove:v1", {
      paymentMethodId: params.paymentMethodId,
      expectedVersion: body.expectedVersion,
    });
    return transaction(pool, async (client) => {
      await lockPaymentMethodTokenReaders(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `payment-settings:${user.clientAccountId}`,
      ]);
      const replayed = await replayedConsentResult(client, {
        clientAccountId: user.clientAccountId,
        idempotencyKey: body.idempotencyKey,
        fingerprint,
      });
      if (replayed) return replayed;
      // Billing automation locks Service before Authorization/Saved Method.
      // Discover the account-serialized Service set without a row lock, then
      // take Service before User/Account and Saved Method so removal cannot
      // deadlock a billing run's Service -> Account -> Authorization order.
      const authorizationServiceIds = await client.query<{ service_id: string }>(
        `SELECT renewal_authorization.service_id
         FROM automatic_renewal_authorizations renewal_authorization
         WHERE renewal_authorization.saved_payment_method_id = $1
           AND renewal_authorization.client_account_id = $2
           AND renewal_authorization.status = 'active'
         ORDER BY renewal_authorization.service_id`,
        [params.paymentMethodId, user.clientAccountId],
      );
      if (authorizationServiceIds.rows.length > 0) {
        await client.query(
          `SELECT service.id
           FROM services service
           WHERE service.id = ANY($1::uuid[])
             AND service.client_account_id = $2
           ORDER BY service.id
           FOR UPDATE`,
          [
            authorizationServiceIds.rows.map((authorization) => authorization.service_id),
            user.clientAccountId,
          ],
        );
      }
      await assertBillingActorLocked(client, user);
      await requireRecentReauthLocked(client, user);
      const method = await client.query<{ version: number; status: string }>(
        `SELECT version, status FROM saved_payment_methods
         WHERE id = $1 AND client_account_id = $2 FOR UPDATE`,
        [params.paymentMethodId, user.clientAccountId],
      );
      const row = method.rows[0];
      if (!row) throw Object.assign(new Error("Saved payment method not found"), { statusCode: 404 });
      if (row.version !== body.expectedVersion) throw conflict("Saved payment method changed; refresh and confirm again");
      if (row.status !== "active") throw conflict("Saved payment method is already inactive", "PAYMENT_METHOD_INACTIVE");
      const activeAuthorizations = await client.query<{ id: string; service_id: string }>(
        `SELECT id, service_id
         FROM automatic_renewal_authorizations
         WHERE saved_payment_method_id = $1 AND status = 'active'
         ORDER BY id
         FOR UPDATE`,
        [params.paymentMethodId],
      );
      if (activeAuthorizations.rows.length > 0) {
        const pendingReplacement = await client.query<{ id: string }>(
          `SELECT attempt.id
           FROM payment_attempts attempt
           JOIN services service ON service.id = attempt.automatic_renewal_service_id
           WHERE attempt.client_account_id = $1
             AND attempt.automatic_renewal_service_id = ANY($2::uuid[])
             AND attempt.automatic_renewal_requested
             AND attempt.automatic_renewal_decision_generation =
                   service.automatic_renewal_decision_generation
             AND attempt.created_automatic_renewal_authorization_id IS NULL
             AND attempt.status IN ('created', 'processing', 'unknown')
           ORDER BY attempt.created_at, attempt.id
           LIMIT 1
           FOR UPDATE OF attempt`,
          [
            user.clientAccountId,
            activeAuthorizations.rows.map((authorization) => authorization.service_id),
          ],
        );
        if (pendingReplacement.rows[0]) {
          throw Object.assign(
            new Error(
              "A linked service has a newer pending automatic-renewal decision; withdraw it or wait for payment reconciliation before removing this method",
            ),
            { statusCode: 409, code: "PENDING_AUTOMATIC_RENEWAL_DECISION" },
          );
        }
      }
      let cancelledKnownUnsent = 0;
      let inflightReconciliationRequired = 0;
      for (const authorization of activeAuthorizations.rows) {
        const stopped = await stopAutomaticPaymentsForAuthorization(client, authorization.id);
        cancelledKnownUnsent += stopped.cancelledKnownUnsent;
        inflightReconciliationRequired += stopped.inflightReconciliationRequired;
      }
      if (activeAuthorizations.rows.length > 0) {
        await client.query(
          `UPDATE services
           SET automatic_renewal_decision_generation =
                 automatic_renewal_decision_generation + 1,
               automatic_renewal_consent_generation =
                 automatic_renewal_decision_generation + 1,
               updated_at = now(), version = version + 1
           WHERE id = ANY($1::uuid[]) AND client_account_id = $2`,
          [
            activeAuthorizations.rows.map((authorization) => authorization.service_id),
            user.clientAccountId,
          ],
        );
      }
      const revoked = await client.query<{ id: string }>(
        `UPDATE automatic_renewal_authorizations
         SET status = 'revoked', revoked_by_user_id = $2, revoked_at = now(),
             revocation_reason = 'saved payment method removed',
             updated_at = now(), version = version + 1
         WHERE saved_payment_method_id = $1 AND status = 'active'
         RETURNING id`,
        [params.paymentMethodId, user.userId],
      );
      const updated = await client.query<{ version: number }>(
        `UPDATE saved_payment_methods
         SET status = 'removed', is_default = false, removed_at = now(),
             removed_by_user_id = $2, updated_at = now(), version = version + 1
         WHERE id = $1 RETURNING version`,
        [params.paymentMethodId, user.userId],
      );
      const result = {
        paymentMethodId: params.paymentMethodId,
        status: "removed",
        revokedAutomaticRenewals: revoked.rowCount ?? 0,
        cancelledKnownUnsentAutomaticPayments: cancelledKnownUnsent,
        inflightAutomaticPaymentsRequiringReconciliation: inflightReconciliationRequired,
        version: updated.rows[0]?.version,
        replayed: false,
      };
      await client.query(
        `INSERT INTO payment_consent_events(
           client_account_id, saved_payment_method_id, event_type,
           actor_type, actor_id, reason, idempotency_key, request_fingerprint, result
         ) VALUES ($1, $2, 'method_removed', 'user', $3,
                   'customer removed saved payment method', $4, $5, $6)`,
        [user.clientAccountId, params.paymentMethodId, user.userId, body.idempotencyKey, fingerprint, result],
      );
      return result;
    });
  });

  app.post("/api/v1/services/:serviceId/automatic-renewal", async (request) => {
    const user = await requireUser(request, pool, config);
    assertBillingWriteEligible(user);
    const params = z.object({ serviceId: z.uuid() }).parse(request.params);
    const body = automaticRenewalSchema.parse(request.body);
    const fingerprint = requestFingerprint("automatic-renewal.enable:v1", {
      serviceId: params.serviceId,
      savedPaymentMethodId: body.savedPaymentMethodId,
      consentVersion: body.consentVersion,
      expectedAuthorizationId: body.expectedAuthorizationId,
      expectedAuthorizationVersion: body.expectedAuthorizationVersion,
      expectedDecisionGeneration: body.expectedDecisionGeneration,
    });
    return transaction(pool, async (client) => {
      await lockPaymentMethodTokenReaders(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `payment-settings:${user.clientAccountId}`,
      ]);
      const replayed = await replayedConsentResult(client, {
        clientAccountId: user.clientAccountId,
        idempotencyKey: body.idempotencyKey,
        fingerprint,
      });
      if (replayed) return replayed;
      const service = await client.query<{
        status: string;
        billing_cycle: string;
        cancellation_request_id: string | null;
        automatic_renewal_consent_generation: string;
        automatic_renewal_decision_generation: string;
      }>(
        `SELECT status, billing_cycle, cancellation_request_id,
                automatic_renewal_consent_generation::text,
                automatic_renewal_decision_generation::text
         FROM services WHERE id = $1 AND client_account_id = $2 FOR UPDATE`,
        [params.serviceId, user.clientAccountId],
      );
      const serviceRow = service.rows[0];
      if (!serviceRow) throw Object.assign(new Error("Service not found"), { statusCode: 404 });
      if (
        serviceRow.automatic_renewal_decision_generation !==
        body.expectedDecisionGeneration
      ) {
        throw conflict("Automatic-renewal decision changed; refresh and confirm again");
      }
      await assertBillingActorLocked(client, user);
      await requireRecentReauthLocked(client, user);
      if (
        !["active", "suspended"].includes(serviceRow.status) ||
        serviceRow.billing_cycle === "one_time" ||
        serviceRow.cancellation_request_id
      ) {
        throw conflict("Automatic renewal is unavailable for this service state", "SERVICE_NOT_RENEWABLE");
      }
      const method = await client.query<{ id: string }>(
        `SELECT saved.id
         FROM saved_payment_methods saved
         JOIN payment_methods method
           ON method.code = saved.payment_method_code
          AND method.provider_installation_id = saved.provider_installation_id
         JOIN provider_installation_capabilities provider
           ON provider.provider_installation_id = saved.provider_installation_id
         WHERE saved.id = $1 AND saved.client_account_id = $2
           AND saved.status = 'active' AND method.enabled
           AND method.automatic_renewal_enabled
           AND provider.provider_type = 'payment'
           AND provider.enabled
           AND provider.capabilities @> '["payment_create","payment_reconcile","payment_off_session"]'::jsonb
         FOR UPDATE OF saved, method, provider`,
        [body.savedPaymentMethodId, user.clientAccountId],
      );
      if (!method.rows[0]) throw conflict("Saved payment method cannot be used for automatic renewal", "PAYMENT_METHOD_INACTIVE");
      const existing = await client.query<{ id: string; version: number }>(
        `SELECT id, version FROM automatic_renewal_authorizations
         WHERE service_id = $1 AND status = 'active' FOR UPDATE`,
        [params.serviceId],
      );
      const current = existing.rows[0];
      if (
        (current?.id ?? null) !== body.expectedAuthorizationId ||
        (current?.version ?? null) !== body.expectedAuthorizationVersion
      ) {
        throw conflict("Automatic-renewal authorization changed; refresh and confirm again");
      }
      if (current) {
        const stopped = await stopAutomaticPaymentsForAuthorization(client, current.id);
        if (stopped.inflightReconciliationRequired > 0) {
          throw conflict(
            "An automatic payment may already have been sent; wait for reconciliation before replacing this authorization",
            "AUTOMATIC_PAYMENT_INFLIGHT",
          );
        }
        await client.query(
          `UPDATE automatic_renewal_authorizations
           SET status = 'revoked', revoked_by_user_id = $2, revoked_at = now(),
               revocation_reason = 'replaced by a newly consented authorization',
               updated_at = now(), version = version + 1
           WHERE id = $1`,
          [current.id, user.userId],
        );
      }
      const advancedConsent = await client.query<{
        automatic_renewal_consent_generation: string;
      }>(
        `UPDATE services
         SET automatic_renewal_decision_generation =
               automatic_renewal_decision_generation + 1,
             automatic_renewal_consent_generation =
               automatic_renewal_decision_generation + 1,
             updated_at = now(), version = version + 1
         WHERE id = $1
           AND automatic_renewal_decision_generation = $2
         RETURNING automatic_renewal_consent_generation::text`,
        [params.serviceId, serviceRow.automatic_renewal_decision_generation],
      );
      const consentGeneration =
        advancedConsent.rows[0]?.automatic_renewal_consent_generation;
      if (!consentGeneration) {
        throw conflict("Automatic-renewal consent changed; refresh and confirm again");
      }
      const authorizationId = randomUUID();
      const authorization = await client.query<{ version: number; granted_at: Date }>(
         `INSERT INTO automatic_renewal_authorizations(
           id, service_id, client_account_id, saved_payment_method_id,
           consent_version, consent_generation, granted_by_user_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING version, granted_at`,
        [
          authorizationId,
          params.serviceId,
          user.clientAccountId,
          body.savedPaymentMethodId,
          body.consentVersion,
          consentGeneration,
          user.userId,
        ],
      );
      const result = {
        authorizationId,
        serviceId: params.serviceId,
        savedPaymentMethodId: body.savedPaymentMethodId,
        status: "active",
        consentVersion: body.consentVersion,
        grantedAt: authorization.rows[0]?.granted_at.toISOString(),
        version: authorization.rows[0]?.version,
        replayed: false,
      };
      await client.query(
        `INSERT INTO payment_consent_events(
           client_account_id, service_id, saved_payment_method_id,
           automatic_renewal_authorization_id, event_type, consent_version,
           actor_type, actor_id, idempotency_key, request_fingerprint, result
         ) VALUES ($1, $2, $3, $4, 'automatic_renewal_enabled', $5,
                   'user', $6, $7, $8, $9)`,
        [user.clientAccountId, params.serviceId, body.savedPaymentMethodId, authorizationId, body.consentVersion, user.userId, body.idempotencyKey, fingerprint, result],
      );
      return result;
    });
  });

  app.post(
    "/api/v1/services/:serviceId/automatic-renewal/pending-consent/withdraw",
    async (request) => {
      const user = await requireUser(request, pool, config);
      assertBillingWriteEligible(user);
      const params = z.object({ serviceId: z.uuid() }).parse(request.params);
      const body = withdrawPendingAutomaticRenewalSchema.parse(request.body);
      const fingerprint = requestFingerprint("automatic-renewal.pending-withdraw:v1", {
        serviceId: params.serviceId,
        expectedPaymentAttemptId: body.expectedPaymentAttemptId,
        expectedDecisionGeneration: body.expectedDecisionGeneration,
        reason: body.reason,
      });
      return transaction(pool, async (client) => {
        await lockPaymentMethodTokenReaders(client);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `payment-settings:${user.clientAccountId}`,
        ]);
        const replayed = await replayedConsentResult(client, {
          clientAccountId: user.clientAccountId,
          idempotencyKey: body.idempotencyKey,
          fingerprint,
        });
        if (replayed) return replayed;
        const service = await client.query<{ automatic_renewal_decision_generation: string }>(
          `SELECT automatic_renewal_decision_generation::text
           FROM services
           WHERE id = $1 AND client_account_id = $2
           FOR UPDATE`,
          [params.serviceId, user.clientAccountId],
        );
        const serviceRow = service.rows[0];
        if (!serviceRow) {
          throw Object.assign(new Error("Service not found"), { statusCode: 404 });
        }
        if (
          serviceRow.automatic_renewal_decision_generation !==
          body.expectedDecisionGeneration
        ) {
          throw conflict(
            "Pending automatic-renewal consent changed; refresh and confirm again",
          );
        }
        await assertBillingActorLocked(client, user);
        await requireRecentReauthLocked(client, user);
        const pendingConsent = await client.query<{ consent_version: string }>(
          `SELECT automatic_renewal_consent_version AS consent_version
           FROM payment_attempts
           WHERE id = $1
             AND client_account_id = $2
             AND automatic_renewal_service_id = $3
             AND automatic_renewal_requested
             AND automatic_renewal_decision_generation = $4
             AND created_automatic_renewal_authorization_id IS NULL
             AND status IN ('created', 'processing', 'unknown')
           FOR UPDATE`,
          [
            body.expectedPaymentAttemptId,
            user.clientAccountId,
            params.serviceId,
            body.expectedDecisionGeneration,
          ],
        );
        const pending = pendingConsent.rows[0];
        if (!pending) {
          throw conflict(
            "Pending automatic-renewal consent changed; refresh and confirm again",
          );
        }
        const withdrawn = await client.query<{ updated_at: Date }>(
          `UPDATE services
           SET automatic_renewal_decision_generation =
                 automatic_renewal_decision_generation + 1,
               updated_at = now(), version = version + 1
           WHERE id = $1
             AND automatic_renewal_decision_generation = $2
           RETURNING updated_at`,
          [params.serviceId, body.expectedDecisionGeneration],
        );
        const withdrawnAt = withdrawn.rows[0]?.updated_at;
        if (!withdrawnAt) {
          throw conflict(
            "Pending automatic-renewal consent changed; refresh and confirm again",
          );
        }
        const result = {
          paymentAttemptId: body.expectedPaymentAttemptId,
          serviceId: params.serviceId,
          status: "withdrawn",
          activeAuthorizationChanged: false,
          invoicePaymentCancelled: false,
          withdrawnAt: withdrawnAt.toISOString(),
          replayed: false,
        };
        await client.query(
          `INSERT INTO payment_consent_events(
             client_account_id, service_id, event_type, consent_version,
             actor_type, actor_id, reason, idempotency_key, request_fingerprint, result
           ) VALUES ($1, $2, 'automatic_renewal_pending_withdrawn', $3,
                     'user', $4, $5, $6, $7, $8)`,
          [
            user.clientAccountId,
            params.serviceId,
            pending.consent_version,
            user.userId,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            result,
          ],
        );
        return result;
      });
    },
  );

  app.post("/api/v1/services/:serviceId/automatic-renewal/revoke", async (request) => {
    const user = await requireUser(request, pool, config);
    assertBillingWriteEligible(user);
    const params = z.object({ serviceId: z.uuid() }).parse(request.params);
    const body = revokeAutomaticRenewalSchema.parse(request.body);
    const fingerprint = requestFingerprint("automatic-renewal.revoke:v1", {
      serviceId: params.serviceId,
      expectedAuthorizationId: body.expectedAuthorizationId,
      expectedVersion: body.expectedVersion,
      expectedDecisionGeneration: body.expectedDecisionGeneration,
      reason: body.reason,
    });
    return transaction(pool, async (client) => {
      await lockPaymentMethodTokenReaders(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `payment-settings:${user.clientAccountId}`,
      ]);
      const replayed = await replayedConsentResult(client, {
        clientAccountId: user.clientAccountId,
        idempotencyKey: body.idempotencyKey,
        fingerprint,
      });
      if (replayed) return replayed;
      const service = await client.query<{
        automatic_renewal_consent_generation: string;
        automatic_renewal_decision_generation: string;
      }>(
        `SELECT automatic_renewal_consent_generation::text,
                automatic_renewal_decision_generation::text
         FROM services
         WHERE id = $1 AND client_account_id = $2
         FOR UPDATE`,
        [params.serviceId, user.clientAccountId],
      );
      const serviceRow = service.rows[0];
      if (!serviceRow) {
        throw Object.assign(new Error("Service not found"), { statusCode: 404 });
      }
      if (
        serviceRow.automatic_renewal_decision_generation !==
        body.expectedDecisionGeneration
      ) {
        throw conflict("Automatic-renewal decision changed; refresh and confirm again");
      }
      await assertBillingActorLocked(client, user);
      await requireRecentReauthLocked(client, user);
      const authorization = await client.query<{
        id: string;
        version: number;
        saved_payment_method_id: string;
        consent_version: string;
      }>(
        `SELECT id, version, saved_payment_method_id, consent_version
         FROM automatic_renewal_authorizations
         WHERE service_id = $1 AND client_account_id = $2 AND status = 'active'
         FOR UPDATE`,
        [params.serviceId, user.clientAccountId],
      );
      const row = authorization.rows[0];
      if (
        !row ||
        row.id !== body.expectedAuthorizationId ||
        row.version !== body.expectedVersion
      ) {
        throw conflict("Automatic-renewal authorization changed; refresh and confirm again");
      }
      const stopped = await stopAutomaticPaymentsForAuthorization(client, row.id);
      const advancedConsent = await client.query<{
        automatic_renewal_consent_generation: string;
        updated_at: Date;
      }>(
        `UPDATE services
         SET automatic_renewal_decision_generation =
               automatic_renewal_decision_generation + 1,
             automatic_renewal_consent_generation =
               automatic_renewal_decision_generation + 1,
             updated_at = now(), version = version + 1
         WHERE id = $1
           AND automatic_renewal_decision_generation = $2
         RETURNING automatic_renewal_consent_generation::text, updated_at`,
        [params.serviceId, serviceRow.automatic_renewal_decision_generation],
      );
      if (!advancedConsent.rows[0]) {
        throw conflict("Automatic-renewal consent changed; refresh and confirm again");
      }
      const updated = await client.query<{ version: number; revoked_at: Date }>(
        `UPDATE automatic_renewal_authorizations
         SET status = 'revoked', revoked_by_user_id = $2, revoked_at = now(),
             revocation_reason = $3, updated_at = now(), version = version + 1
         WHERE id = $1 RETURNING version, revoked_at`,
        [row.id, user.userId, body.reason],
      );
      const result = {
        authorizationId: row.id,
        serviceId: params.serviceId,
        status: "revoked",
        cancelledKnownUnsentAutomaticPayments: stopped.cancelledKnownUnsent,
        inflightAutomaticPaymentsRequiringReconciliation:
          stopped.inflightReconciliationRequired,
        revokedAt: updated.rows[0]?.revoked_at.toISOString(),
        version: updated.rows[0]?.version,
        replayed: false,
      };
      await client.query(
        `INSERT INTO payment_consent_events(
           client_account_id, service_id, saved_payment_method_id,
           automatic_renewal_authorization_id, event_type,
           consent_version, actor_type, actor_id, reason,
           idempotency_key, request_fingerprint, result
         ) VALUES ($1, $2, $3, $4, 'automatic_renewal_revoked',
                   $5, 'user', $6, $7, $8, $9, $10)`,
        [
          user.clientAccountId,
          params.serviceId,
          row.saved_payment_method_id,
          row.id,
          row.consent_version,
          user.userId,
          body.reason,
          body.idempotencyKey,
          fingerprint,
          result,
        ],
      );
      return result;
    });
  });
}
