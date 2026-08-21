// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  parseProviderOperationResult,
  type ProviderOperationResult,
  type ProvisioningOperationRequest,
} from "@opensales/provider-contracts";
import {
  decryptIdentitySecret,
  type IdentitySecretKeyring,
} from "@opensales/core/identity-security";
import type pg from "pg";

export type ServicePasswordChangeJob = Readonly<{
  id: string;
  job_type: string;
  unique_key: string;
  payload: Record<string, string>;
  payload_snapshot: string;
  attempts: number;
  locked_at_epoch: string;
  locked_by: string | null;
}>;

export type ServicePasswordChangeRuntime = Readonly<{
  workerId: string;
  providerUrl: string;
  providerToken: string;
  providerTimeoutMs: number;
  scenario: "normal" | "failure" | "duplicate" | "out_of_order" | "timeout" | "restart";
  reconcileBaseDelaySeconds: number;
  reconcileMaxAttempts: number;
  staleLockSeconds: number;
  keyring: IdentitySecretKeyring;
}>;

type DispatchState = Readonly<{
  requestId: string;
  serviceId: string;
  operationId: string;
  externalResourceId: string;
  productId: string;
  ciphertext: string;
  keyVersion: number;
}>;

type ReconcileState = Omit<DispatchState, "ciphertext" | "keyVersion">;

type ReconcileDispatchState = ReconcileState & Readonly<{
  queryAttemptId: string;
}>;

export class ServicePasswordChangeLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`service password-change durable job lease was lost: ${jobId}`);
    this.name = "ServicePasswordChangeLeaseLostError";
  }
}

export function isServicePasswordChangeLeaseLostError(
  error: unknown,
): error is ServicePasswordChangeLeaseLostError {
  return error instanceof ServicePasswordChangeLeaseLostError;
}

function nextDelay(attempt: number, base: number): number {
  return Math.min(base * 2 ** Math.max(attempt - 1, 0), 300);
}

async function passwordChangeTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

async function lockJob(
  client: pg.PoolClient,
  job: ServicePasswordChangeJob,
): Promise<void> {
  const result = await client.query(
    `SELECT id
     FROM durable_jobs
     WHERE id = $1
       AND status = 'running'
       AND attempts = $2
       AND locked_by IS NOT DISTINCT FROM $3
       AND job_type = $4
       AND unique_key = $5
       AND payload::text = $6
       AND EXTRACT(epoch FROM locked_at)::numeric::text = $7
     FOR UPDATE`,
    [
      job.id,
      job.attempts,
      job.locked_by,
      job.job_type,
      job.unique_key,
      job.payload_snapshot,
      job.locked_at_epoch,
    ],
  );
  if (result.rowCount !== 1) throw new ServicePasswordChangeLeaseLostError(job.id);
}

async function finishJob(
  client: pg.PoolClient,
  job: ServicePasswordChangeJob,
  status: "completed" | "manual",
  reason: string | null = null,
): Promise<void> {
  const requestId = job.payload.requestId;
  if (!requestId || !job.locked_by) {
    throw new Error("password-change terminal transition lacks its request or Worker lease");
  }
  await client.query(
    `INSERT INTO service_configuration_operation_job_transitions(
       job_id, request_id, from_status, to_status, job_attempts, worker_id
     ) VALUES ($1, $2, 'running', $3, $4, $5)`,
    [job.id, requestId, status, job.attempts, job.locked_by],
  );
  const updated = await client.query(
    `UPDATE durable_jobs
     SET status = $2, locked_at = NULL, locked_by = NULL,
         last_error = $3, updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING id`,
    [job.id, status, reason],
  );
  if (updated.rowCount !== 1) throw new ServicePasswordChangeLeaseLostError(job.id);
}

async function destroyActiveEnvelope(
  client: pg.PoolClient,
  requestId: string,
): Promise<void> {
  const destroyed = await client.query(
    `UPDATE service_configuration_secret_envelopes
     SET ciphertext = NULL, destroyed_at = pg_catalog.clock_timestamp()
     WHERE request_id = $1 AND ciphertext IS NOT NULL`,
    [requestId],
  );
  if (destroyed.rowCount !== 1) {
    throw new Error("password-change active envelope destruction invariant failed");
  }
}

async function assertEnvelopeDestroyed(
  client: pg.PoolClient,
  requestId: string,
): Promise<void> {
  const result = await client.query(
    `SELECT request_id
     FROM service_configuration_secret_envelopes
     WHERE request_id = $1 AND ciphertext IS NULL AND destroyed_at IS NOT NULL
     FOR UPDATE`,
    [requestId],
  );
  if (result.rowCount !== 1) {
    throw new Error("password-change destroyed envelope invariant failed");
  }
}

async function actorStillAuthorized(
  client: pg.PoolClient,
  pointer: {
    actor_type: "user" | "staff";
    actor_user_id: string;
    actor_session_id: string;
    client_account_id: string;
  },
): Promise<boolean> {
  if (pointer.actor_type === "user") {
    const result = await client.query<{ eligible: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM users user_record
         JOIN sessions session_record
           ON session_record.id = $2
          AND session_record.user_id = user_record.id
         JOIN client_accounts account ON account.id = $3
         JOIN client_memberships membership
           ON membership.client_account_id = account.id
          AND membership.user_id = user_record.id
         WHERE user_record.id = $1
           AND user_record.email_verified_at IS NOT NULL
           AND user_record.restricted_at IS NULL
           AND session_record.revoked_at IS NULL
           AND session_record.expires_at > pg_catalog.clock_timestamp()
           AND session_record.active_client_account_id = account.id
           AND account.restricted_at IS NULL
           AND membership.removed_at IS NULL
           AND membership.restricted_at IS NULL
           AND (
             membership.role IN ('owner', 'technical')
             OR membership.permissions ? '*'
             OR membership.permissions ? 'services.manage'
           )
           AND EXISTS (
             SELECT 1 FROM reauth_grants reauth
             WHERE reauth.user_id = user_record.id
               AND reauth.session_id = session_record.id
               AND reauth.invalidated_at IS NULL
               AND reauth.expires_at > pg_catalog.clock_timestamp()
           )
       ) AS eligible`,
      [pointer.actor_user_id, pointer.actor_session_id, pointer.client_account_id],
    );
    return result.rows[0]?.eligible === true;
  }
  const result = await client.query<{ eligible: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM users user_record
       JOIN sessions session_record
         ON session_record.id = $2
        AND session_record.user_id = user_record.id
       JOIN staff_members staff ON staff.user_id = user_record.id
       WHERE user_record.id = $1
         AND user_record.email_verified_at IS NOT NULL
         AND user_record.restricted_at IS NULL
         AND session_record.revoked_at IS NULL
         AND session_record.expires_at > pg_catalog.clock_timestamp()
         AND staff.active
         AND (staff.permissions ? '*' OR staff.permissions ? 'services.operations_manage')
         AND EXISTS (
           SELECT 1 FROM reauth_grants reauth
           WHERE reauth.user_id = user_record.id
             AND reauth.session_id = session_record.id
             AND reauth.invalidated_at IS NULL
             AND reauth.expires_at > pg_catalog.clock_timestamp()
         )
     ) AS eligible`,
    [pointer.actor_user_id, pointer.actor_session_id],
  );
  return result.rows[0]?.eligible === true;
}

async function preflightStart(
  pool: pg.Pool,
  job: ServicePasswordChangeJob,
  runtime: ServicePasswordChangeRuntime,
): Promise<DispatchState | null> {
  return passwordChangeTransaction(pool, async (client) => {
    const requestId = job.payload.requestId;
    const serviceId = job.payload.serviceId;
    const operationId = job.payload.providerOperationId;
    if (!requestId || !serviceId || !operationId || Object.keys(job.payload).length !== 3) {
      throw new Error("password-change start job payload invariant failed");
    }
    const pointerResult = await client.query<{
      actor_type: "user" | "staff";
      actor_user_id: string;
      actor_session_id: string;
      client_account_id: string;
      order_item_id: string;
      provider_installation_id: string;
    }>(
      `SELECT request.actor_type, request.actor_user_id, request.actor_session_id,
              request.client_account_id, service.order_item_id,
              request.provider_installation_id
       FROM service_configuration_operation_requests request
       JOIN services service ON service.id = request.service_id
       WHERE request.id = $1 AND request.service_id = $2`,
      [requestId, serviceId],
    );
    const pointer = pointerResult.rows[0];
    if (!pointer) {
      throw new Error("password-change request pointer invariant failed");
    }
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [pointer.actor_user_id]);
    await client.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [pointer.actor_session_id]);
    await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [pointer.client_account_id]);
    if (pointer.actor_type === "user") {
      await client.query(
        `SELECT client_account_id FROM client_memberships
         WHERE client_account_id = $1 AND user_id = $2 FOR UPDATE`,
        [pointer.client_account_id, pointer.actor_user_id],
      );
    } else {
      await client.query("SELECT user_id FROM staff_members WHERE user_id = $1 FOR UPDATE", [pointer.actor_user_id]);
    }
    await lockJob(client, job);
    await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [pointer.order_item_id]);
    await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [serviceId]);
    await client.query(
      "SELECT id FROM service_configuration_operation_requests WHERE id = $1 FOR UPDATE",
      [requestId],
    );
    await client.query(
      "SELECT request_id FROM service_configuration_secret_envelopes WHERE request_id = $1 FOR UPDATE",
      [requestId],
    );
    await client.query(
      `SELECT provider_installation_id FROM provider_installation_capabilities
       WHERE provider_installation_id = $1 FOR UPDATE`,
      [pointer.provider_installation_id],
    );
    await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [operationId]);

    const stateResult = await client.query<{
      expected_service_version: number;
      expected_resource_revision: number;
      service_status: string;
      service_version: number;
      cancellation_due: boolean;
      external_resource_id: string | null;
      product_id: string;
      resource_revision: number;
      provider_enabled: boolean;
      binding_capabilities: unknown;
      current_capabilities: unknown;
      operation_status: string;
      operation_attempt_count: number;
      operation_kind: string;
      operation_subject_id: string;
      latest_status: string | null;
      attempt_count: number;
      ciphertext: string | null;
      key_version: number;
    }>(
      `SELECT request.expected_service_version, request.expected_resource_revision,
              service.status AS service_status, service.version AS service_version,
              service.cancellation_effective_at IS NOT NULL
                AND service.cancellation_effective_at <= pg_catalog.clock_timestamp()
                AS cancellation_due,
              service.external_resource_id, item.product_id,
              COALESCE(resource.resource_revision, 0) AS resource_revision,
              provider.enabled AS provider_enabled,
              binding.capability_snapshot AS binding_capabilities,
              provider.capabilities AS current_capabilities,
              operation.status AS operation_status,
              operation.attempt_count AS operation_attempt_count,
              operation.kind AS operation_kind,
              operation.subject_id::text AS operation_subject_id,
              latest.status AS latest_status,
              COALESCE(attempts.attempt_count, 0) AS attempt_count,
              envelope.ciphertext, envelope.key_version
       FROM service_configuration_operation_requests request
       JOIN services service ON service.id = request.service_id
       JOIN order_items item ON item.id = service.order_item_id
       JOIN service_provider_bindings binding ON binding.service_id = service.id
       JOIN provider_installation_capabilities provider
         ON provider.provider_installation_id = request.provider_installation_id
       JOIN provider_operations operation ON operation.id = $3
       JOIN service_configuration_secret_envelopes envelope
         ON envelope.request_id = request.id
       LEFT JOIN LATERAL (
         SELECT fact.resource_revision
         FROM service_resource_state_facts fact
         WHERE fact.service_id = service.id
         ORDER BY fact.resource_revision DESC LIMIT 1
       ) resource ON true
       LEFT JOIN LATERAL (
         SELECT result.status
         FROM service_configuration_operation_result_facts result
         WHERE result.request_id = request.id
         ORDER BY result.revision DESC LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS attempt_count
         FROM service_configuration_operation_attempts fact
         WHERE fact.request_id = request.id
       ) attempts ON true
       WHERE request.id = $1 AND service.id = $2`,
      [requestId, serviceId, operationId],
    );
    const state = stateResult.rows[0];
    const binding = Array.isArray(state?.binding_capabilities) ? state.binding_capabilities : [];
    const current = Array.isArray(state?.current_capabilities) ? state.current_capabilities : [];
    const actorAllowed = await actorStillAuthorized(client, pointer);
    const allowed =
      actorAllowed &&
      state !== undefined &&
      state.service_status === "active" &&
      !state.cancellation_due &&
      state.service_version === state.expected_service_version &&
      state.resource_revision === state.expected_resource_revision &&
      state.external_resource_id !== null &&
      state.provider_enabled &&
      binding.includes("resource.change_password") &&
      current.includes("resource.change_password") &&
      state.operation_status === "queued" &&
      state.operation_attempt_count === 0 &&
      state.operation_kind === "resource.change_password" &&
      state.operation_subject_id === requestId &&
      state.latest_status === null &&
      state.attempt_count === 0 &&
      state.ciphertext !== null;
    if (!allowed || !state || !state.external_resource_id || !state.ciphertext) {
      await client.query(
        `INSERT INTO service_configuration_operation_result_facts(
           request_id, revision, status, detail, error_code, evidence
         ) VALUES ($1, 1, 'failed', $2, 'dispatch_preflight_rejected', $3)`,
        [
          requestId,
          "Fresh authorization, Service, Provider capability, or encrypted-envelope preflight failed",
          { providerCalled: false },
        ],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'failed', last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [operationId, "Password-change dispatch preflight rejected"],
      );
      await destroyActiveEnvelope(client, requestId);
      await finishJob(client, job, "completed");
      return null;
    }
    await client.query(
      `INSERT INTO service_configuration_operation_attempts(
         request_id, provider_operation_id, durable_job_id, durable_job_attempts,
         attempt_number, attempt_kind, actor_id, started_at
       ) VALUES ($1, $2, $3, $4, 1, 'mutation', $5, pg_catalog.clock_timestamp())`,
      [requestId, operationId, job.id, job.attempts, runtime.workerId],
    );
    await client.query(
      `INSERT INTO service_configuration_operation_result_facts(
         request_id, revision, status, evidence
       ) VALUES ($1, 1, 'running', $2)`,
      [requestId, { providerCalled: false, dispatchPreflight: true }],
    );
    await client.query(
      `UPDATE provider_operations
       SET status = 'running', attempt_count = 1, last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [operationId],
    );
    return {
      requestId,
      serviceId,
      operationId,
      externalResourceId: state.external_resource_id,
      productId: state.product_id,
      ciphertext: state.ciphertext,
      keyVersion: state.key_version,
    };
  });
}

async function enqueueReconcile(
  client: pg.PoolClient,
  state: ReconcileState,
  runtime: ServicePasswordChangeRuntime,
): Promise<void> {
  await client.query(
    `INSERT INTO durable_jobs(job_type, unique_key, payload, available_at)
     VALUES ('service.password_change.reconcile', $1, $2,
             now() + make_interval(secs => $3))
     ON CONFLICT (job_type, unique_key) DO UPDATE
       SET payload = EXCLUDED.payload,
           status = CASE WHEN durable_jobs.status = 'manual' THEN 'manual' ELSE 'pending' END,
           available_at = CASE
             WHEN durable_jobs.status = 'manual' THEN durable_jobs.available_at
             ELSE EXCLUDED.available_at
           END,
           locked_at = NULL, locked_by = NULL, updated_at = now()`,
    [
      `service-password-change:${state.requestId}:reconcile`,
      {
        requestId: state.requestId,
        serviceId: state.serviceId,
        providerOperationId: state.operationId,
      },
      runtime.reconcileBaseDelaySeconds,
    ],
  );
}

async function markUnknown(
  pool: pg.Pool,
  job: ServicePasswordChangeJob,
  state: ReconcileState,
  runtime: ServicePasswordChangeRuntime,
  reason: string,
): Promise<void> {
  await passwordChangeTransaction(pool, async (client) => {
    await lockJob(client, job);
    const latest = await client.query<{ revision: number; status: string }>(
      `SELECT revision, status
       FROM service_configuration_operation_result_facts
       WHERE request_id = $1 ORDER BY revision DESC LIMIT 1
       FOR UPDATE`,
      [state.requestId],
    );
    const fact = latest.rows[0];
    if (fact?.status === "running") {
      await client.query(
        `INSERT INTO service_configuration_operation_result_facts(
           request_id, revision, status, detail, error_code, evidence
         ) VALUES ($1, $2, 'unknown', $3, 'provider_outcome_unknown', $4)`,
        [state.requestId, fact.revision + 1, reason, { providerCalled: true }],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'running'`,
        [state.operationId, reason],
      );
      await destroyActiveEnvelope(client, state.requestId);
      await enqueueReconcile(client, state, runtime);
    } else {
      throw new Error("password-change unknown transition lost its running result");
    }
    await finishJob(client, job, "completed");
  });
}

function boundResult(value: unknown, operationId: string): ProviderOperationResult {
  const result = parseProviderOperationResult(value);
  if (result.capability !== "provisioning" || result.operationId !== operationId) {
    throw new Error("Provider result is not bound to this password-change operation");
  }
  return result;
}

async function persistTerminal(
  pool: pg.Pool,
  job: ServicePasswordChangeJob,
  state: ReconcileState,
  result: ProviderOperationResult,
  queryAttemptId: string | null = null,
): Promise<void> {
  await passwordChangeTransaction(pool, async (client) => {
    await lockJob(client, job);
    await client.query(
      "SELECT id FROM service_configuration_operation_requests WHERE id = $1 FOR UPDATE",
      [state.requestId],
    );
    await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [state.operationId]);
    const latestResult = await client.query<{ revision: number; status: string }>(
      `SELECT revision, status
       FROM service_configuration_operation_result_facts
       WHERE request_id = $1 ORDER BY revision DESC LIMIT 1`,
      [state.requestId],
    );
    const latest = latestResult.rows[0];
    if (!latest || ["succeeded", "failed", "manual"].includes(latest.status)) {
      throw new Error("password-change terminal persistence found an invalid prior result");
    }
    if (queryAttemptId) {
      const outstanding = await client.query(
        `SELECT attempt.id
         FROM service_configuration_operation_attempts attempt
         LEFT JOIN service_configuration_operation_result_facts observation
           ON observation.reconcile_attempt_id = attempt.id
         WHERE attempt.id = $1
           AND attempt.request_id = $2
           AND attempt.provider_operation_id = $3
           AND attempt.durable_job_id = $4
           AND attempt.attempt_kind = 'reconcile_query'
           AND observation.id IS NULL
         FOR UPDATE OF attempt`,
        [queryAttemptId, state.requestId, state.operationId, job.id],
      );
      if (outstanding.rowCount !== 1) {
        throw new Error("password-change reconcile result lost its outstanding query identity");
      }
      await assertEnvelopeDestroyed(client, state.requestId);
    } else {
      await client.query(
        `SELECT request_id
         FROM service_configuration_secret_envelopes
         WHERE request_id = $1
         FOR UPDATE`,
        [state.requestId],
      );
    }
    const queryEvidence = queryAttemptId
      ? {
          attemptId: queryAttemptId,
          queryIdentity: `service-password-change-query:${queryAttemptId}`,
        }
      : {};
    if (result.status === "failed") {
      const reason = "Mock Provider rejected the password change";
      await client.query(
        `INSERT INTO service_configuration_operation_result_facts(
           request_id, reconcile_attempt_id, revision, status, detail, error_code,
           provider_occurred_at, evidence
         ) VALUES ($1, $2, $3, 'failed', $4, $5, $6, $7)`,
        [
          state.requestId,
          queryAttemptId,
          latest.revision + 1,
          reason,
          (result.error?.code ?? "provider_failed").slice(0, 100),
          result.observedAt,
          { providerCalled: true, providerRevision: result.revision, ...queryEvidence },
        ],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'failed', last_error = $2, updated_at = now()
         WHERE id = $1`,
        [state.operationId, reason],
      );
      if (queryAttemptId) await assertEnvelopeDestroyed(client, state.requestId);
      else await destroyActiveEnvelope(client, state.requestId);
      await finishJob(client, job, "completed");
      return;
    }
    if (result.status !== "succeeded") {
      throw new Error("password-change terminal persistence received a non-terminal result");
    }
    const output = result.output as { externalResourceRef?: unknown } | undefined;
    if (output?.externalResourceRef !== state.externalResourceId) {
      const reason = "Provider success result does not match the requested resource";
      await client.query(
        `INSERT INTO service_configuration_operation_result_facts(
           request_id, reconcile_attempt_id, revision, status, detail, error_code,
           provider_occurred_at, evidence
         ) VALUES ($1, $2, $3, 'manual', $4, 'provider_contract_mismatch', $5, $6)`,
        [
          state.requestId,
          queryAttemptId,
          latest.revision + 1,
          reason,
          result.observedAt,
          { providerCalled: true, providerRevision: result.revision, ...queryEvidence },
        ],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1`,
        [state.operationId, reason],
      );
      if (queryAttemptId) await assertEnvelopeDestroyed(client, state.requestId);
      else await destroyActiveEnvelope(client, state.requestId);
      await finishJob(client, job, "manual", reason);
      return;
    }
    await client.query(
      `INSERT INTO service_configuration_operation_result_facts(
         request_id, reconcile_attempt_id, revision, status, provider_occurred_at, evidence
       ) VALUES ($1, $2, $3, 'succeeded', $4, $5)`,
      [
        state.requestId,
        queryAttemptId,
        latest.revision + 1,
        result.observedAt,
        { providerCalled: true, providerRevision: result.revision, ...queryEvidence },
      ],
    );
    await client.query(
      `UPDATE provider_operations
       SET status = 'succeeded', external_reference = $2,
           last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [state.operationId, state.externalResourceId],
    );
    if (queryAttemptId) await assertEnvelopeDestroyed(client, state.requestId);
    else await destroyActiveEnvelope(client, state.requestId);
    await client.query(
      `INSERT INTO audit_events(
         actor_type, actor_id, action, target_type, target_id, reason, metadata
       ) VALUES ('system', $1, 'service.password_change_succeeded',
                 'service', $2, $3, $4)`,
      [
        "worker",
        state.serviceId,
        "Password change completed through the Mock Provider contract",
        { requestId: state.requestId, providerOperationId: state.operationId },
      ],
    );
    await finishJob(client, job, "completed");
  });
}

async function providerFetch(
  runtime: ServicePasswordChangeRuntime,
  path: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(new URL(path, runtime.providerUrl), {
    ...init,
    headers: {
      Authorization: `Bearer ${runtime.providerToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(runtime.providerTimeoutMs),
    redirect: "error",
  });
}

export async function processServicePasswordChangeStart(
  pool: pg.Pool,
  job: ServicePasswordChangeJob,
  runtime: ServicePasswordChangeRuntime,
): Promise<void> {
  const state = await preflightStart(pool, job, runtime);
  if (!state) return;
  let password = "";
  try {
    password = decryptIdentitySecret(
      state.ciphertext,
      state.keyVersion,
      "service-password-change",
      state.requestId,
      runtime.keyring,
    );
  } catch {
    await passwordChangeTransaction(pool, async (client) => {
      await lockJob(client, job);
      await client.query(
        `INSERT INTO service_configuration_operation_result_facts(
           request_id, revision, status, detail, error_code, evidence
         ) VALUES ($1, 2, 'failed', $2, 'secret_envelope_unavailable', $3)`,
        [state.requestId, "Encrypted password envelope could not be opened", { providerCalled: false }],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'failed', last_error = 'Encrypted password envelope unavailable', updated_at = now()
         WHERE id = $1`,
        [state.operationId],
      );
      await destroyActiveEnvelope(client, state.requestId);
      await finishJob(client, job, "completed");
    });
    return;
  }
  const operation: ProvisioningOperationRequest = {
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    operationId: state.operationId,
    requestedAt: new Date().toISOString(),
    intentRef: state.requestId,
    capability: "provisioning",
    action: "resource.change_password",
    input: {
      serviceRef: state.serviceId,
      planRef: state.productId,
      externalResourceRef: state.externalResourceId,
      configuration: { password },
    },
  };
  let serialized = JSON.stringify(operation);
  let response: Response;
  try {
    response = await providerFetch(runtime, "/v1alpha1/provisioning/operations", {
      method: "POST",
      headers: {
        "Idempotency-Key": state.operationId,
        "X-OSS-Lab-Scenario": runtime.scenario,
      },
      body: serialized,
    });
  } catch {
    password = "";
    serialized = "";
    await markUnknown(
      pool,
      job,
      state,
      runtime,
      "Provider mutation transport outcome is unknown; the password was not retained",
    );
    return;
  }
  password = "";
  serialized = "";
  if (!response.ok) {
    await markUnknown(
      pool,
      job,
      state,
      runtime,
      `Provider mutation returned HTTP ${response.status}; mutation will not be replayed`,
    );
    return;
  }
  let result: ProviderOperationResult;
  try {
    result = boundResult(await response.json(), state.operationId);
  } catch {
    await markUnknown(
      pool,
      job,
      state,
      runtime,
      "Provider mutation response was invalid; GET-only reconciliation is required",
    );
    return;
  }
  if (result.status === "succeeded" || result.status === "failed") {
    await persistTerminal(pool, job, state, result);
    return;
  }
  await markUnknown(
    pool,
    job,
    state,
    runtime,
    "Provider mutation is non-terminal; GET-only reconciliation is required",
  );
}

async function preflightReconcile(
  pool: pg.Pool,
  job: ServicePasswordChangeJob,
  runtime: ServicePasswordChangeRuntime,
): Promise<ReconcileDispatchState | null> {
  return passwordChangeTransaction(pool, async (client) => {
    await lockJob(client, job);
    const requestId = job.payload.requestId;
    const serviceId = job.payload.serviceId;
    const operationId = job.payload.providerOperationId;
    if (!requestId || !serviceId || !operationId || Object.keys(job.payload).length !== 3) {
      throw new Error("password-change reconcile payload invariant failed");
    }
    const selected = await client.query<{
      external_resource_id: string;
      product_id: string;
      result_status: string;
      operation_status: string;
      reconcile_count: number;
      outstanding_attempt_id: string | null;
    }>(
      `SELECT service.external_resource_id, item.product_id,
              latest.status AS result_status,
              operation.status AS operation_status,
              COALESCE(attempt.reconcile_count, 0) AS reconcile_count,
              attempt.outstanding_attempt_id
       FROM service_configuration_operation_requests request
       JOIN services service ON service.id = request.service_id
       JOIN order_items item ON item.id = service.order_item_id
       JOIN provider_operations operation
         ON operation.id = $3
        AND operation.subject_type = 'service_configuration_operation'
        AND operation.subject_id = request.id
       LEFT JOIN LATERAL (
         SELECT result.status
         FROM service_configuration_operation_result_facts result
         WHERE result.request_id = request.id
         ORDER BY result.revision DESC LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (
                  WHERE attempt.attempt_kind = 'reconcile_query'
                )::integer AS reconcile_count,
                min(attempt.id::text) FILTER (
                  WHERE attempt.attempt_kind = 'reconcile_query'
                    AND observation.reconcile_attempt_id IS NULL
                ) AS outstanding_attempt_id
         FROM service_configuration_operation_attempts attempt
         LEFT JOIN service_configuration_operation_result_facts observation
           ON observation.reconcile_attempt_id = attempt.id
         WHERE attempt.request_id = request.id
       ) attempt ON true
       WHERE request.id = $1 AND service.id = $2
       FOR UPDATE OF service, operation`,
      [requestId, serviceId, operationId],
    );
    const current = selected.rows[0];
    if (!current) {
      throw new Error("password-change reconcile target invariant failed");
    }
    if (["succeeded", "failed", "manual"].includes(current.result_status)) {
      throw new Error("password-change reconcile job was claimed after a terminal result");
    }
    if (current.result_status !== "unknown" || current.operation_status !== "unknown") {
      throw new Error("password-change reconcile projection invariant failed");
    }
    await assertEnvelopeDestroyed(client, requestId);
    if (current.outstanding_attempt_id) {
      return {
        requestId,
        serviceId,
        operationId,
        externalResourceId: current.external_resource_id,
        productId: current.product_id,
        queryAttemptId: current.outstanding_attempt_id,
      };
    }
    if (current.reconcile_count >= runtime.reconcileMaxAttempts) {
      await client.query(
        `INSERT INTO service_configuration_operation_result_facts(
           request_id, revision, status, detail, error_code, evidence
         )
         SELECT $1, latest.revision + 1, 'manual', $2, 'reconcile_exhausted', $3
         FROM LATERAL (
           SELECT revision FROM service_configuration_operation_result_facts
           WHERE request_id = $1 ORDER BY revision DESC LIMIT 1
         ) latest`,
        [requestId, "GET-only password-change reconciliation attempts exhausted", { providerCalled: true }],
      );
      await finishJob(client, job, "manual", "GET-only reconciliation attempts exhausted");
      return null;
    }
    if (!job.locked_by) {
      throw new Error("password-change reconcile dispatch lacks a Worker identity");
    }
    const attempt = await client.query<{ id: string }>(
      `INSERT INTO service_configuration_operation_attempts(
         request_id, provider_operation_id, durable_job_id, durable_job_attempts,
         attempt_number, attempt_kind, actor_id, started_at
       ) VALUES ($1, $2, $3, $4, $5, 'reconcile_query', $6,
                 pg_catalog.clock_timestamp())
       RETURNING id`,
      [
        requestId,
        operationId,
        job.id,
        job.attempts,
        current.reconcile_count + 2,
        job.locked_by,
      ],
    );
    const queryAttemptId = attempt.rows[0]?.id;
    if (!queryAttemptId) {
      throw new Error("password-change reconcile query dispatch was not persisted");
    }
    return {
      requestId,
      serviceId,
      operationId,
      externalResourceId: current.external_resource_id,
      productId: current.product_id,
      queryAttemptId,
    };
  });
}

async function rescheduleReconcile(
  pool: pg.Pool,
  job: ServicePasswordChangeJob,
  state: ReconcileDispatchState,
  runtime: ServicePasswordChangeRuntime,
  observation: Readonly<{
    reason: string;
    errorCode: string;
    kind: "transport_error" | "http_error" | "invalid_result" | "non_terminal" | "worker_error";
    providerRevision?: number;
    providerOccurredAt?: string;
  }>,
): Promise<void> {
  await passwordChangeTransaction(pool, async (client) => {
    await lockJob(client, job);
    const outstanding = await client.query<{ attempt_number: number }>(
      `SELECT attempt.attempt_number
       FROM service_configuration_operation_attempts attempt
       LEFT JOIN service_configuration_operation_result_facts result
         ON result.reconcile_attempt_id = attempt.id
       WHERE attempt.id = $1
         AND attempt.request_id = $2
         AND attempt.provider_operation_id = $3
         AND attempt.durable_job_id = $4
         AND attempt.attempt_kind = 'reconcile_query'
         AND result.id IS NULL
       FOR UPDATE OF attempt`,
      [state.queryAttemptId, state.requestId, state.operationId, job.id],
    );
    const attemptNumber = outstanding.rows[0]?.attempt_number;
    if (!attemptNumber) {
      throw new Error("password-change reconcile observation lost its query dispatch");
    }
    await assertEnvelopeDestroyed(client, state.requestId);
    const latest = await client.query<{ revision: number; status: string }>(
      `SELECT revision, status
       FROM service_configuration_operation_result_facts
       WHERE request_id = $1
       ORDER BY revision DESC
       LIMIT 1
       FOR UPDATE`,
      [state.requestId],
    );
    if (latest.rows[0]?.status !== "unknown") {
      throw new Error("password-change reconcile observation lost its unknown result");
    }
    await client.query(
      `INSERT INTO service_configuration_operation_result_facts(
         request_id, reconcile_attempt_id, revision, status, provider_occurred_at,
         detail, error_code, evidence
       ) VALUES ($1, $2, $3, 'unknown', $4, $5, $6, $7)`,
      [
        state.requestId,
        state.queryAttemptId,
        latest.rows[0].revision + 1,
        observation.providerOccurredAt ?? null,
        observation.reason,
        observation.errorCode,
        {
          providerCalled: true,
          attemptId: state.queryAttemptId,
          queryIdentity: `service-password-change-query:${state.queryAttemptId}`,
          observation: observation.kind,
          ...(observation.providerRevision === undefined
            ? {}
            : { providerRevision: observation.providerRevision }),
        },
      ],
    );
    const updated = await client.query(
      `UPDATE durable_jobs
       SET status = 'pending',
           available_at = now() + make_interval(secs => $2),
           locked_at = NULL, locked_by = NULL, last_error = $3, updated_at = now()
       WHERE id = $1 AND status = 'running' RETURNING id`,
      [
        job.id,
        nextDelay(attemptNumber - 1, runtime.reconcileBaseDelaySeconds),
        observation.reason,
      ],
    );
    if (updated.rowCount !== 1) throw new ServicePasswordChangeLeaseLostError(job.id);
  });
}

export async function processServicePasswordChangeReconcile(
  pool: pg.Pool,
  job: ServicePasswordChangeJob,
  runtime: ServicePasswordChangeRuntime,
): Promise<void> {
  const state = await preflightReconcile(pool, job, runtime);
  if (!state) return;
  let response: Response;
  try {
    response = await providerFetch(
      runtime,
      `/v1alpha1/provisioning/operations/${encodeURIComponent(state.operationId)}`,
      {
        method: "GET",
        headers: {
          "X-OSS-Reconcile-Query-Id":
            `service-password-change-query:${state.queryAttemptId}`,
        },
      },
    );
  } catch {
    await rescheduleReconcile(
      pool,
      job,
      state,
      runtime,
      {
        reason: "Provider GET reconciliation transport failed",
        errorCode: "provider_reconcile_transport",
        kind: "transport_error",
      },
    );
    return;
  }
  if (!response.ok) {
    await rescheduleReconcile(
      pool,
      job,
      state,
      runtime,
      {
        reason: `Provider GET reconciliation returned HTTP ${response.status}`,
        errorCode: "provider_reconcile_http",
        kind: "http_error",
      },
    );
    return;
  }
  let result: ProviderOperationResult;
  try {
    result = boundResult(await response.json(), state.operationId);
  } catch {
    await rescheduleReconcile(
      pool,
      job,
      state,
      runtime,
      {
        reason: "Provider GET reconciliation result was invalid",
        errorCode: "provider_reconcile_invalid",
        kind: "invalid_result",
      },
    );
    return;
  }
  if (result.status === "succeeded" || result.status === "failed") {
    await persistTerminal(pool, job, state, result, state.queryAttemptId);
    return;
  }
  await rescheduleReconcile(
    pool,
    job,
    state,
    runtime,
    {
      reason: "Provider GET reconciliation remains non-terminal",
      errorCode: "provider_reconcile_non_terminal",
      kind: "non_terminal",
      providerRevision: result.revision,
      providerOccurredAt: result.observedAt,
    },
  );
}

export async function persistUnexpectedServicePasswordChangeFailure(
  pool: pg.Pool,
  job: ServicePasswordChangeJob,
  runtime: ServicePasswordChangeRuntime,
  error: unknown,
): Promise<void> {
  if (isServicePasswordChangeLeaseLostError(error)) throw error;
  await passwordChangeTransaction(pool, async (client) => {
    await lockJob(client, job);
    const requestId = job.payload.requestId;
    const serviceId = job.payload.serviceId;
    const operationId = job.payload.providerOperationId;
    if (!requestId || !serviceId || !operationId) {
      throw new Error("password-change failure reconciler payload invariant failed");
    }
    const currentResult = await client.query<{
      revision: number | null;
      status: string | null;
      operation_status: string;
      mutation_count: number;
      outstanding_attempt_id: string | null;
    }>(
      `SELECT latest.revision, latest.status,
              operation.status AS operation_status,
              COALESCE(attempt.mutation_count, 0) AS mutation_count,
              attempt.outstanding_attempt_id
       FROM provider_operations operation
       LEFT JOIN LATERAL (
         SELECT revision, status
         FROM service_configuration_operation_result_facts
         WHERE request_id = $1 ORDER BY revision DESC LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (
                  WHERE attempt.attempt_kind = 'mutation'
                )::integer AS mutation_count,
                min(attempt.id::text) FILTER (
                  WHERE attempt.attempt_kind = 'reconcile_query'
                    AND observation.reconcile_attempt_id IS NULL
                ) AS outstanding_attempt_id
         FROM service_configuration_operation_attempts attempt
         LEFT JOIN service_configuration_operation_result_facts observation
           ON observation.reconcile_attempt_id = attempt.id
         WHERE attempt.request_id = $1
       ) attempt ON true
       WHERE operation.id = $2
         AND operation.subject_type = 'service_configuration_operation'
         AND operation.subject_id = $1
       FOR UPDATE OF operation`,
      [requestId, operationId],
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new Error("password-change failure reconciler fact invariant failed");
    }
    if (job.job_type === "service.password_change.reconcile") {
      if (
        current.status !== "unknown" ||
        current.operation_status !== "unknown"
      ) {
        throw new Error("password-change failure reconciler found an invalid reconcile projection");
      }
      await assertEnvelopeDestroyed(client, requestId);
      if (current.outstanding_attempt_id) {
        await client.query(
          `INSERT INTO service_configuration_operation_result_facts(
             request_id, reconcile_attempt_id, revision, status, detail,
             error_code, evidence
           ) VALUES ($1, $2, $3, 'unknown', $4,
                     'provider_reconcile_worker', $5)`,
          [
            requestId,
            current.outstanding_attempt_id,
            (current.revision ?? 0) + 1,
            "GET-only password-change reconciliation failed inside the Worker",
            {
              providerCalled: true,
              attemptId: current.outstanding_attempt_id,
              queryIdentity:
                `service-password-change-query:${current.outstanding_attempt_id}`,
              observation: "worker_error",
            },
          ],
        );
      }
      const updated = await client.query(
        `UPDATE durable_jobs
         SET status = 'pending', available_at = now() + make_interval(secs => $2),
             locked_at = NULL, locked_by = NULL,
             last_error = 'unexpected password-change reconciliation failure', updated_at = now()
         WHERE id = $1 AND status = 'running' RETURNING id`,
        [job.id, runtime.reconcileBaseDelaySeconds],
      );
      if (updated.rowCount !== 1) throw new ServicePasswordChangeLeaseLostError(job.id);
      return;
    }
    if (current.mutation_count === 0 && current.status === null && current.operation_status === "queued") {
      const updated = await client.query(
        `UPDATE durable_jobs
         SET status = 'pending', available_at = now() + make_interval(secs => $2),
             locked_at = NULL, locked_by = NULL,
             last_error = 'unexpected password-change pre-dispatch failure', updated_at = now()
         WHERE id = $1 AND status = 'running' RETURNING id`,
        [job.id, runtime.reconcileBaseDelaySeconds],
      );
      if (updated.rowCount !== 1) throw new ServicePasswordChangeLeaseLostError(job.id);
      return;
    }
    if (current.status === "running" && current.operation_status === "running") {
      await client.query(
        `INSERT INTO service_configuration_operation_result_facts(
           request_id, revision, status, detail, error_code, evidence
         ) VALUES ($1, $2, 'unknown', $3, 'worker_persistence_unknown', $4)`,
        [
          requestId,
          (current.revision ?? 0) + 1,
          "Worker failed after a possible Provider password mutation",
          { providerCalled: true },
        ],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = 'Worker failed after possible password mutation',
             updated_at = now()
         WHERE id = $1 AND status = 'running'`,
        [operationId],
      );
      await destroyActiveEnvelope(client, requestId);
      await enqueueReconcile(
        client,
        { requestId, serviceId, operationId, externalResourceId: "", productId: "" },
        runtime,
      );
      await finishJob(client, job, "completed");
      return;
    }
    throw new Error("password-change failure reconciler found an invalid start projection");
  });
}

export async function recoverStaleServicePasswordChangeJobs(
  pool: pg.Pool,
  runtime: ServicePasswordChangeRuntime,
): Promise<number> {
  const candidates = await pool.query<{ id: string; attempts: number }>(
    `SELECT id, attempts
     FROM durable_jobs
     WHERE status = 'running'
       AND job_type IN ('service.password_change.start', 'service.password_change.reconcile')
       AND locked_at < now() - make_interval(secs => $1)
     ORDER BY locked_at, created_at
     LIMIT 50`,
    [runtime.staleLockSeconds],
  );
  let recovered = 0;
  for (const candidate of candidates.rows) {
    const changed = await passwordChangeTransaction(pool, async (client) => {
      const selected = await client.query<{
        payload: Record<string, string>;
        job_type: string;
        attempts: number;
        locked_by: string;
      }>(
        `SELECT payload, job_type, attempts, locked_by
         FROM durable_jobs
         WHERE id = $1 AND status = 'running' AND attempts = $2
           AND locked_at < now() - make_interval(secs => $3)
         FOR UPDATE`,
        [candidate.id, candidate.attempts, runtime.staleLockSeconds],
      );
      const job = selected.rows[0];
      if (!job) return false;
      const requestId = job.payload.requestId;
      const serviceId = job.payload.serviceId;
      const operationId = job.payload.providerOperationId;
      if (
        !requestId ||
        !serviceId ||
        !operationId ||
        Object.keys(job.payload).length !== 3
      ) {
        throw new Error("stale password-change job payload invariant failed");
      }
      const currentResult = await client.query<{
        result_status: string | null;
        result_revision: number;
        attempt_count: number;
        operation_status: string;
      }>(
        `SELECT latest.status AS result_status,
                COALESCE(latest.revision, 0) AS result_revision,
                COALESCE(attempt.attempt_count, 0) AS attempt_count,
                operation.status AS operation_status
         FROM provider_operations operation
         JOIN service_configuration_operation_requests request
           ON request.id = $1
          AND request.service_id = $3
          AND operation.subject_type = 'service_configuration_operation'
          AND operation.subject_id = request.id
         LEFT JOIN LATERAL (
           SELECT status, revision
           FROM service_configuration_operation_result_facts
           WHERE request_id = $1 ORDER BY revision DESC LIMIT 1
         ) latest ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::integer AS attempt_count
           FROM service_configuration_operation_attempts
           WHERE request_id = $1
         ) attempt ON true
         WHERE operation.id = $2
         FOR UPDATE OF operation`,
        [requestId, operationId, serviceId],
      );
      const current = currentResult.rows[0];
      if (!current) {
        throw new Error("stale password-change fact invariant failed");
      }
      if (["succeeded", "failed", "manual"].includes(current.result_status ?? "")) {
        throw new Error("stale running password-change job already has a terminal result");
      }
      if (job.job_type === "service.password_change.start" && current.attempt_count === 0) {
        await client.query(
          `UPDATE durable_jobs SET status = 'pending', locked_at = NULL, locked_by = NULL,
                   available_at = now(), last_error = 'recovered before password mutation began',
                   updated_at = now() WHERE id = $1`,
          [candidate.id],
        );
        return true;
      }
      if (job.job_type === "service.password_change.start" && current.result_status === "running") {
        await client.query(
          `INSERT INTO service_configuration_operation_result_facts(
             request_id, revision, status, detail, error_code, evidence
           ) VALUES ($1, $2, 'unknown', $3, 'worker_restart', $4)`,
          [
            requestId,
            current.result_revision + 1,
            "Worker restarted after a possible Provider password mutation",
            { providerCalled: true },
          ],
        );
        await client.query(
          `UPDATE provider_operations SET status = 'unknown',
                   last_error = 'Worker restarted after possible password mutation', updated_at = now()
           WHERE id = $1 AND status = 'running'`,
          [operationId],
        );
        await destroyActiveEnvelope(client, requestId);
        await client.query(
          `INSERT INTO durable_jobs(job_type, unique_key, payload, available_at)
           VALUES ('service.password_change.reconcile', $1, $2, now())
           ON CONFLICT (job_type, unique_key) DO UPDATE
             SET status = CASE WHEN durable_jobs.status = 'manual' THEN 'manual' ELSE 'pending' END,
                 available_at = now(), locked_at = NULL, locked_by = NULL, updated_at = now()`,
          [`service-password-change:${requestId}:reconcile`, job.payload],
        );
        await client.query(
          `INSERT INTO service_configuration_operation_job_transitions(
             job_id, request_id, from_status, to_status, job_attempts, worker_id
           ) VALUES ($1, $2, 'running', 'completed', $3, $4)`,
          [candidate.id, requestId, job.attempts, job.locked_by],
        );
        await client.query(
          `UPDATE durable_jobs SET status = 'completed', locked_at = NULL, locked_by = NULL,
                   updated_at = now() WHERE id = $1`,
          [candidate.id],
        );
        return true;
      }
      if (
        job.job_type !== "service.password_change.reconcile" ||
        current.result_status !== "unknown" ||
        current.operation_status !== "unknown"
      ) {
        throw new Error("stale password-change job has an invalid recovery projection");
      }
      await assertEnvelopeDestroyed(client, requestId);
      await client.query(
        `UPDATE durable_jobs SET status = 'pending', locked_at = NULL, locked_by = NULL,
                 available_at = now(), last_error = 'recovered stale GET-only password reconciliation',
                 updated_at = now() WHERE id = $1`,
        [candidate.id],
      );
      return true;
    });
    if (changed) recovered += 1;
  }
  return recovered;
}
