// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  parseProviderOperationResult,
  type ProviderOperationResult,
  type ProvisioningAction,
  type ProvisioningOperationRequest,
} from "@opensales/provider-contracts";
import type pg from "pg";

export type ServiceOperationJob = Readonly<{
  id: string;
  job_type: string;
  unique_key: string;
  payload: Record<string, string>;
  payload_snapshot: string;
  attempts: number;
  locked_at_epoch: string;
  locked_by: string | null;
}>;

export type ServiceOperationRuntime = Readonly<{
  workerId: string;
  providerUrl: string;
  providerToken: string;
  providerTimeoutMs: number;
  scenario: "normal" | "failure" | "duplicate" | "out_of_order" | "timeout" | "restart";
  reconcileBaseDelaySeconds: number;
  reconcileMaxAttempts: number;
  staleLockSeconds: number;
}>;

export type ServiceOperationReconcileHooks = Readonly<{
  beforeProviderGet?: () => void | Promise<void>;
}>;

export type ServiceOperationStartHooks = Readonly<{
  beforeDispatchAuthorizationRecheck?: () => void | Promise<void>;
  afterProviderMutation?: () => void | Promise<void>;
}>;

type DailyAction = "start" | "stop" | "reboot";
type ResourceState = "running" | "stopped";

type DispatchState = Readonly<{
  requestId: string;
  serviceId: string;
  operationId: string;
  action: DailyAction;
  externalResourceId: string;
  productId: string;
}>;

export class ServiceOperationLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`service operation durable job lease was lost: ${jobId}`);
    this.name = "ServiceOperationLeaseLostError";
  }
}

export function isServiceOperationLeaseLostError(
  error: unknown,
): error is ServiceOperationLeaseLostError {
  return error instanceof ServiceOperationLeaseLostError;
}

function detail(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown Provider transport error").slice(0, 1_000);
}

function nextDelay(attempt: number, base: number): number {
  return Math.min(base * 2 ** Math.max(attempt - 1, 0), 300);
}

function expectedState(action: DailyAction): ResourceState {
  return action === "stop" ? "stopped" : "running";
}

function actionCapability(action: DailyAction): `resource.${DailyAction}` {
  return `resource.${action}`;
}

export async function serviceOperationTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (originalError) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the operation failure that determines pending versus
      // GET-only reconciliation. A client that cannot roll back is never
      // reusable and must be discarded from the pool.
      discardClient = true;
    }
    throw originalError;
  } finally {
    client.release(discardClient);
  }
}

async function lockJob(client: pg.PoolClient, job: ServiceOperationJob): Promise<void> {
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
  if (result.rowCount !== 1) throw new ServiceOperationLeaseLostError(job.id);
}

async function finishJob(
  client: pg.PoolClient,
  job: ServiceOperationJob,
  status: "completed" | "manual",
  reason: string | null = null,
): Promise<void> {
  const requestId = job.payload.requestId;
  if (!requestId || !job.locked_by) {
    throw new Error("service operation terminal job transition lacks its request or active Worker lease");
  }
  await client.query(
    `INSERT INTO service_operation_job_transition_facts(
       job_id, request_id, from_status, to_status,
       job_attempts, worker_id
     ) VALUES ($1, $2, 'running', $3, $4, $5)`,
    [job.id, requestId, status, job.attempts, job.locked_by],
  );
  const updated = await client.query(
    `UPDATE durable_jobs
     SET status = $2, locked_at = NULL, locked_by = NULL,
         last_error = $3, updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING id`,
    [job.id, status, reason?.slice(0, 1_000) ?? null],
  );
  if (updated.rowCount !== 1) throw new ServiceOperationLeaseLostError(job.id);
}

async function rescheduleReconcile(
  client: pg.PoolClient,
  job: ServiceOperationJob,
  runtime: ServiceOperationRuntime,
  reason: string,
): Promise<void> {
  const queryAttempts = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM service_resource_operation_attempt_facts
     WHERE request_id = $1 AND attempt_kind = 'reconcile_query'`,
    [job.payload.requestId],
  );
  const actualQueryCount = queryAttempts.rows[0]?.count ?? 0;
  if (actualQueryCount >= runtime.reconcileMaxAttempts) {
    const latest = await client.query<{ revision: number; status: string }>(
      `SELECT revision, status
       FROM service_resource_operation_result_facts
       WHERE request_id = $1
       ORDER BY revision DESC
       LIMIT 1`,
      [job.payload.requestId],
    );
    const fact = latest.rows[0];
    if (fact?.status === "unknown") {
      await client.query(
        `INSERT INTO service_resource_operation_result_facts(
           request_id, revision, status, detail, error_code, evidence
         ) VALUES ($1, $2, 'manual', $3, 'reconcile_exhausted', $4)`,
        [job.payload.requestId, fact.revision + 1, reason.slice(0, 1_000), { providerCalled: true }],
      );
    }
    await finishJob(client, job, "manual", reason);
    return;
  }
  const updated = await client.query(
    `UPDATE durable_jobs
     SET status = 'pending',
         available_at = now() + make_interval(secs => $2),
         locked_at = NULL, locked_by = NULL,
         last_error = $3, updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING id`,
    [job.id, nextDelay(actualQueryCount + 1, runtime.reconcileBaseDelaySeconds), reason.slice(0, 1_000)],
  );
  if (updated.rowCount !== 1) throw new ServiceOperationLeaseLostError(job.id);
}

async function appendReconcileAttempt(
  client: pg.PoolClient,
  state: DispatchState,
  job: ServiceOperationJob,
): Promise<void> {
  if (!job.locked_by) {
    throw new Error("service operation reconcile attempt lacks an active Worker lease");
  }
  await client.query(
    `INSERT INTO service_resource_operation_attempt_facts(
       request_id, provider_operation_id, durable_job_id, durable_job_attempts, attempt_number,
       attempt_kind, actor_id, started_at
     )
     SELECT $1, $2, $3, $4, COALESCE(max(attempt.attempt_number), 0) + 1,
            'reconcile_query', $5, pg_catalog.clock_timestamp()
     FROM service_resource_operation_attempt_facts attempt
     WHERE attempt.request_id = $1`,
    [state.requestId, state.operationId, job.id, job.attempts, job.locked_by],
  );
}

async function lockActorAtDispatch(
  client: pg.PoolClient,
  pointer: {
    actor_type: "user" | "staff";
    actor_user_id: string;
    actor_session_id: string;
    client_account_id: string;
  },
): Promise<boolean> {
  const identity = await client.query<{ eligible: boolean }>(
    `SELECT email_verified_at IS NOT NULL AND restricted_at IS NULL AS eligible
     FROM users WHERE id = $1 FOR UPDATE`,
    [pointer.actor_user_id],
  );
  if (identity.rows[0]?.eligible !== true) return false;
  const session = await client.query<{ active_client_account_id: string | null }>(
    `SELECT active_client_account_id
     FROM sessions
     WHERE id = $1 AND user_id = $2
       AND revoked_at IS NULL AND expires_at > pg_catalog.clock_timestamp()
     FOR UPDATE`,
    [pointer.actor_session_id, pointer.actor_user_id],
  );
  if (!session.rows[0]) return false;
  if (pointer.actor_type === "user") {
    const account = await client.query<{ eligible: boolean }>(
      `SELECT restricted_at IS NULL AS eligible
       FROM client_accounts WHERE id = $1 FOR UPDATE`,
      [pointer.client_account_id],
    );
    if (
      account.rows[0]?.eligible !== true ||
      session.rows[0].active_client_account_id !== pointer.client_account_id
    ) return false;
    const membership = await client.query<{ eligible: boolean }>(
      `SELECT removed_at IS NULL
              AND restricted_at IS NULL
              AND (
                role IN ('owner', 'technical')
                OR permissions ? '*'
                OR permissions ? 'services.manage'
              ) AS eligible
       FROM client_memberships
       WHERE client_account_id = $1 AND user_id = $2
       FOR UPDATE`,
      [pointer.client_account_id, pointer.actor_user_id],
    );
    return membership.rows[0]?.eligible === true;
  }
  const staff = await client.query<{ eligible: boolean }>(
    `SELECT staff.active
            AND (staff.permissions ? '*' OR staff.permissions ? 'services.operations_manage')
            AS eligible
     FROM staff_members staff
     WHERE staff.user_id = $1
     FOR UPDATE OF staff`,
    [pointer.actor_user_id],
  );
  if (staff.rows[0]?.eligible !== true) return false;
  const grant = await client.query(
    `SELECT id FROM reauth_grants
     WHERE user_id = $1 AND session_id = $2
       AND invalidated_at IS NULL AND expires_at > pg_catalog.clock_timestamp()
     ORDER BY created_at DESC, id DESC
     LIMIT 1 FOR UPDATE`,
    [pointer.actor_user_id, pointer.actor_session_id],
  );
  return grant.rowCount === 1;
}

async function actorAuthorizationIsStillFresh(
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
         JOIN sessions session
           ON session.id = $2 AND session.user_id = user_record.id
         JOIN client_accounts account ON account.id = $3
         JOIN client_memberships membership
           ON membership.client_account_id = account.id
          AND membership.user_id = user_record.id
         WHERE user_record.id = $1
           AND user_record.email_verified_at IS NOT NULL
           AND user_record.restricted_at IS NULL
           AND session.revoked_at IS NULL
           AND session.expires_at > pg_catalog.clock_timestamp()
           AND session.active_client_account_id = account.id
           AND account.restricted_at IS NULL
           AND membership.removed_at IS NULL
           AND membership.restricted_at IS NULL
           AND (
             membership.role IN ('owner', 'technical')
             OR membership.permissions ? '*'
             OR membership.permissions ? 'services.manage'
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
       JOIN sessions session
         ON session.id = $2 AND session.user_id = user_record.id
       JOIN staff_members staff ON staff.user_id = user_record.id
       WHERE user_record.id = $1
         AND user_record.email_verified_at IS NOT NULL
         AND user_record.restricted_at IS NULL
         AND session.revoked_at IS NULL
         AND session.expires_at > pg_catalog.clock_timestamp()
         AND staff.active
         AND (staff.permissions ? '*' OR staff.permissions ? 'services.operations_manage')
         AND EXISTS (
           SELECT 1
           FROM reauth_grants reauth
           WHERE reauth.user_id = user_record.id
             AND reauth.session_id = session.id
             AND reauth.invalidated_at IS NULL
             AND reauth.expires_at > pg_catalog.clock_timestamp()
         )
     ) AS eligible`,
    [pointer.actor_user_id, pointer.actor_session_id],
  );
  return result.rows[0]?.eligible === true;
}

async function appendPreflightFailure(
  client: pg.PoolClient,
  job: ServiceOperationJob,
  requestId: string,
  operationId: string,
  reason: string,
): Promise<void> {
  const latest = await client.query<{ revision: number; status: string }>(
    `SELECT revision, status FROM service_resource_operation_result_facts
     WHERE request_id = $1 ORDER BY revision DESC LIMIT 1`,
    [requestId],
  );
  if (!latest.rows[0]) {
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(request_id, revision, status, evidence)
       VALUES ($1, 1, 'running', $2)`,
      [requestId, { providerCalled: false, dispatchPreflight: false }],
    );
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, detail, error_code, evidence
       ) VALUES ($1, 2, 'failed', $2, 'dispatch_preflight_rejected', $3)`,
      [requestId, reason.slice(0, 1_000), { providerCalled: false }],
    );
  }
  await client.query(
    `UPDATE provider_operations
     SET status = 'failed', last_error = $2, updated_at = now()
     WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
    [operationId, reason.slice(0, 1_000)],
  );
  await finishJob(client, job, "completed");
}

async function preflightMutation(
  pool: pg.Pool,
  job: ServiceOperationJob,
  runtime: ServiceOperationRuntime,
  hooks: ServiceOperationStartHooks,
): Promise<DispatchState | null> {
  return serviceOperationTransaction(pool, async (client) => {
    const requestId = job.payload.requestId;
    const serviceId = job.payload.serviceId;
    const operationId = job.payload.providerOperationId;
    if (!requestId || !serviceId || !operationId) {
      await lockJob(client, job);
      await finishJob(client, job, "manual", "invalid service operation start payload");
      return null;
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
       FROM service_resource_operation_requests request
       JOIN services service ON service.id = request.service_id
       WHERE request.id = $1 AND request.service_id = $2`,
      [requestId, serviceId],
    );
    const pointer = pointerResult.rows[0];
    if (!pointer) {
      await lockJob(client, job);
      await finishJob(client, job, "manual", "service operation request disappeared");
      return null;
    }
    const actorAllowed = await lockActorAtDispatch(client, pointer);
    if (pointer.actor_type === "staff") {
      await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
        pointer.client_account_id,
      ]);
    }
    await lockJob(client, job);
    await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [pointer.order_item_id]);
    await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [serviceId]);
    await client.query(
      "SELECT id FROM service_resource_operation_requests WHERE id = $1 FOR UPDATE",
      [requestId],
    );
    await client.query(
      "SELECT provider_installation_id FROM provider_installation_capabilities WHERE provider_installation_id = $1 FOR UPDATE",
      [pointer.provider_installation_id],
    );
    await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [operationId]);
    await hooks.beforeDispatchAuthorizationRecheck?.();
    const state = await client.query<{
      action: DailyAction;
      expected_service_version: number;
      expected_resource_revision: number;
      service_status: string;
      service_version: number;
      cancellation_request_id: string | null;
      cancellation_expected_service_version: number | null;
      cancellation_not_effective: boolean;
      external_resource_id: string | null;
      product_id: string;
      resource_revision: number;
      resource_state: string | null;
      provider_enabled: boolean;
      binding_capabilities: unknown;
      current_capabilities: unknown;
      operation_status: string;
      operation_attempt_count: number;
      operation_kind: string;
      operation_subject_id: string;
      latest_status: string | null;
      attempt_count: number;
    }>(
      `SELECT request.action, request.expected_service_version,
              request.expected_resource_revision,
              service.status AS service_status, service.version AS service_version,
              service.cancellation_request_id,
              cancellation.expected_service_version AS cancellation_expected_service_version,
              (service.cancellation_effective_at IS NULL
                OR service.cancellation_effective_at > pg_catalog.clock_timestamp())
                AS cancellation_not_effective,
              service.external_resource_id,
              item.product_id,
              COALESCE(resource.resource_revision, 0) AS resource_revision,
              resource.state AS resource_state,
              provider.enabled AS provider_enabled,
              binding.capability_snapshot AS binding_capabilities,
              provider.capabilities AS current_capabilities,
              operation.status AS operation_status,
              operation.attempt_count AS operation_attempt_count,
              operation.kind AS operation_kind,
              operation.subject_id::text AS operation_subject_id,
              latest.status AS latest_status,
              COALESCE(attempts.attempt_count, 0) AS attempt_count
       FROM service_resource_operation_requests request
       JOIN services service ON service.id = request.service_id
       JOIN order_items item ON item.id = service.order_item_id
       LEFT JOIN service_cancellation_requests cancellation
         ON cancellation.id = service.cancellation_request_id
       JOIN service_provider_bindings binding ON binding.service_id = service.id
       JOIN provider_installation_capabilities provider
         ON provider.provider_installation_id = request.provider_installation_id
       JOIN provider_operations operation ON operation.id = $3
       LEFT JOIN LATERAL (
         SELECT fact.resource_revision, fact.state
         FROM service_resource_state_facts fact
         WHERE fact.service_id = service.id
         ORDER BY fact.resource_revision DESC LIMIT 1
       ) resource ON true
       LEFT JOIN LATERAL (
         SELECT result.status FROM service_resource_operation_result_facts result
         WHERE result.request_id = request.id
         ORDER BY result.revision DESC LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS attempt_count
         FROM service_resource_operation_attempt_facts fact
         WHERE fact.request_id = request.id
       ) attempts ON true
       WHERE request.id = $1 AND service.id = $2`,
      [requestId, serviceId, operationId],
    );
    const current = state.rows[0];
    const requiredCapability = current ? actionCapability(current.action) : null;
    const bindingCapabilities = Array.isArray(current?.binding_capabilities)
      ? current.binding_capabilities
      : [];
    const currentCapabilities = Array.isArray(current?.current_capabilities)
      ? current.current_capabilities
      : [];
    const allowedPriorState = current?.action === "start"
      ? current.resource_state === "stopped"
      : current?.resource_state === "running";
    const cancellationOnlyVersionDrift =
      current !== undefined &&
      current.cancellation_request_id !== null &&
      current.cancellation_expected_service_version === current.expected_service_version &&
      current.service_version === current.expected_service_version + 1;
    const versionAllowed =
      current !== undefined &&
      (current.service_version === current.expected_service_version ||
        cancellationOnlyVersionDrift);
    const actorStillAllowed = actorAllowed
      ? await actorAuthorizationIsStillFresh(client, pointer)
      : false;
    const dispatchAllowed =
      actorStillAllowed &&
      current !== undefined &&
      current.service_status === "active" &&
      current.cancellation_not_effective &&
      versionAllowed &&
      current.external_resource_id !== null &&
      current.resource_revision === current.expected_resource_revision &&
      allowedPriorState &&
      current.provider_enabled &&
      requiredCapability !== null &&
      bindingCapabilities.includes(requiredCapability) &&
      currentCapabilities.includes(requiredCapability) &&
      current.operation_status === "queued" &&
      current.operation_attempt_count === 0 &&
      current.operation_kind === requiredCapability &&
      current.operation_subject_id === requestId &&
      current.latest_status === null &&
      current.attempt_count === 0;
    if (!dispatchAllowed || !current || !current.external_resource_id) {
      await appendPreflightFailure(
        client,
        job,
        requestId,
        operationId,
        "Fresh dispatch authorization, service state, binding, or Provider capability preflight failed",
      );
      return null;
    }
    await client.query(
      `INSERT INTO service_resource_operation_attempt_facts(
         request_id, provider_operation_id, durable_job_id, durable_job_attempts,
         attempt_number, attempt_kind, actor_id, started_at
       ) VALUES ($1, $2, $3, $4, 1, 'mutation', $5, pg_catalog.clock_timestamp())`,
      [requestId, operationId, job.id, job.attempts, runtime.workerId],
    );
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, evidence
       ) VALUES ($1, 1, 'running', $2)`,
      [requestId, { providerCalled: false, dispatchPreflight: true }],
    );
    await client.query(
      `UPDATE provider_operations
       SET status = 'running', attempt_count = attempt_count + 1,
           last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [operationId],
    );
    return {
      requestId,
      serviceId,
      operationId,
      action: current.action,
      externalResourceId: current.external_resource_id,
      productId: current.product_id,
    };
  });
}

class ServiceOperationProviderBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceOperationProviderBindingError";
  }
}

function parseBoundProvisioningResult(value: unknown, state: DispatchState): ProviderOperationResult {
  const result = parseProviderOperationResult(value);
  if (result.capability !== "provisioning" || result.operationId !== state.operationId) {
    throw new ServiceOperationProviderBindingError(
      "Provider operation result is bound to another capability or operationId",
    );
  }
  return result;
}

async function markProviderBindingFailure(
  pool: pg.Pool,
  job: ServiceOperationJob,
  state: DispatchState,
  reason: string,
  reconcileActorId?: string,
): Promise<void> {
  await serviceOperationTransaction(pool, async (client) => {
    await lockJob(client, job);
    await client.query(
      "SELECT id FROM service_resource_operation_requests WHERE id = $1 FOR UPDATE",
      [state.requestId],
    );
    await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [
      state.operationId,
    ]);
    const latest = await client.query<{ revision: number; status: string }>(
      `SELECT revision, status
       FROM service_resource_operation_result_facts
       WHERE request_id = $1 ORDER BY revision DESC LIMIT 1`,
      [state.requestId],
    );
    const fact = latest.rows[0];
    if (reconcileActorId && fact?.status === "unknown") {
      await appendReconcileAttempt(client, state, job);
    }
    if (fact && ["running", "unknown"].includes(fact.status)) {
      await client.query(
        `INSERT INTO service_resource_operation_result_facts(
           request_id, revision, status, detail, error_code, evidence
         ) VALUES ($1, $2, 'manual', $3, 'provider_result_binding_mismatch', $4)`,
        [state.requestId, fact.revision + 1, reason.slice(0, 1_000), { providerCalled: true }],
      );
    }
    await client.query(
      `UPDATE provider_operations
       SET status = 'unknown', last_error = $2, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [state.operationId, reason.slice(0, 1_000)],
    );
    await finishJob(client, job, "manual", reason);
  });
}

async function enqueueReconcile(
  client: pg.PoolClient,
  state: DispatchState,
  runtime: ServiceOperationRuntime,
): Promise<void> {
  await client.query(
    `INSERT INTO durable_jobs(job_type, unique_key, payload, available_at)
     VALUES ('service.operation.reconcile', $1, $2,
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
      `service-operation:${state.requestId}:reconcile`,
      { requestId: state.requestId, serviceId: state.serviceId, providerOperationId: state.operationId },
      runtime.reconcileBaseDelaySeconds,
    ],
  );
}

async function markUnknown(
  pool: pg.Pool,
  job: ServiceOperationJob,
  state: DispatchState,
  runtime: ServiceOperationRuntime,
  reason: string,
): Promise<void> {
  await serviceOperationTransaction(pool, async (client) => {
    await lockJob(client, job);
    await client.query("SELECT id FROM service_resource_operation_requests WHERE id = $1 FOR UPDATE", [state.requestId]);
    await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [state.operationId]);
    const latest = await client.query<{ revision: number; status: string }>(
      `SELECT revision, status FROM service_resource_operation_result_facts
       WHERE request_id = $1 ORDER BY revision DESC LIMIT 1`,
      [state.requestId],
    );
    const fact = latest.rows[0];
    if (fact?.status === "running") {
      await client.query(
        `INSERT INTO service_resource_operation_result_facts(
           request_id, revision, status, detail, error_code, evidence
         ) VALUES ($1, $2, 'unknown', $3, 'provider_outcome_unknown', $4)`,
        [state.requestId, fact.revision + 1, reason.slice(0, 1_000), { providerCalled: true }],
      );
    }
    if (fact?.status === "running") {
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
        [state.operationId, reason.slice(0, 1_000)],
      );
    }
    if (fact && ["running", "unknown"].includes(fact.status)) {
      await enqueueReconcile(client, state, runtime);
    }
    await finishJob(client, job, "completed");
  });
}

async function persistTerminal(
  pool: pg.Pool,
  job: ServiceOperationJob,
  state: DispatchState,
  result: ProviderOperationResult,
  reconcileActorId?: string,
): Promise<void> {
  await serviceOperationTransaction(pool, async (client) => {
    await lockJob(client, job);
    const pointer = await client.query<{ order_item_id: string }>(
      `SELECT service.order_item_id
       FROM services service
       JOIN service_resource_operation_requests request ON request.service_id = service.id
       WHERE request.id = $1 AND service.id = $2`,
      [state.requestId, state.serviceId],
    );
    const orderItemId = pointer.rows[0]?.order_item_id;
    if (orderItemId) await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [orderItemId]);
    await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [state.serviceId]);
    await client.query("SELECT id FROM service_resource_operation_requests WHERE id = $1 FOR UPDATE", [state.requestId]);
    await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [state.operationId]);
    const currentResult = await client.query<{ revision: number; status: string }>(
      `SELECT revision, status FROM service_resource_operation_result_facts
       WHERE request_id = $1 ORDER BY revision DESC LIMIT 1`,
      [state.requestId],
    );
    const latest = currentResult.rows[0];
    if (!latest || ["succeeded", "failed", "manual"].includes(latest.status)) {
      await finishJob(client, job, "completed");
      return;
    }
    if (reconcileActorId && latest.status === "unknown") {
      await appendReconcileAttempt(client, state, job);
    }
    if (result.status === "failed") {
      await client.query(
        `INSERT INTO service_resource_operation_result_facts(
           request_id, revision, status, detail, error_code,
           provider_occurred_at, evidence
         ) VALUES ($1, $2, 'failed', $3, $4, $5, $6)`,
        [
          state.requestId,
          latest.revision + 1,
          (result.error?.message ?? "Mock Provider rejected the operation").slice(0, 1_000),
          (result.error?.code ?? "provider_failed").slice(0, 100),
          result.observedAt,
          { providerCalled: true, providerRevision: result.revision },
        ],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'failed', last_error = $2, updated_at = now()
         WHERE id = $1`,
        [state.operationId, result.error?.message?.slice(0, 1_000) ?? "Provider failed"],
      );
      await finishJob(client, job, "completed");
      return;
    }
    if (result.status !== "succeeded") throw new Error("terminal persistence requires a terminal Provider result");
    const output = result.output as
      | { externalResourceRef?: unknown; resourceState?: unknown }
      | undefined;
    const providerState = output?.resourceState === "stopped"
      ? "stopped"
      : output?.resourceState === "ready"
        ? "running"
        : null;
    if (output?.externalResourceRef !== state.externalResourceId || providerState !== expectedState(state.action)) {
      const reason = "Provider success result does not match the requested resource and state";
      await client.query(
        `INSERT INTO service_resource_operation_result_facts(
           request_id, revision, status, detail, error_code,
           provider_occurred_at, evidence
         ) VALUES ($1, $2, 'manual', $3, 'provider_contract_mismatch', $4, $5)`,
        [
          state.requestId,
          latest.revision + 1,
          reason,
          result.observedAt,
          {
            providerCalled: true,
            providerRevision: result.revision,
            returnedExternalResourceRef: output?.externalResourceRef ?? null,
            returnedResourceState: output?.resourceState ?? null,
          },
        ],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', external_reference = NULL,
             last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'running'`,
        [state.operationId, reason],
      );
      await finishJob(client, job, "manual", reason);
      return;
    }
    const core = await client.query<{
      status: string;
      version: number;
      cancellation_request_id: string | null;
      cancellation_expected_service_version: number | null;
      expected_service_version: number;
      expected_resource_revision: number;
      resource_revision: number;
      resource_state: string | null;
      desired_revision: number;
    }>(
      `SELECT service.status, service.version, service.cancellation_request_id,
              cancellation.expected_service_version AS cancellation_expected_service_version,
              request.expected_service_version, request.expected_resource_revision,
              COALESCE(resource.resource_revision, 0) AS resource_revision,
              resource.state AS resource_state,
              COALESCE(desired.desired_revision, 0) AS desired_revision
       FROM service_resource_operation_requests request
       JOIN services service ON service.id = request.service_id
       LEFT JOIN service_cancellation_requests cancellation
         ON cancellation.id = service.cancellation_request_id
       LEFT JOIN LATERAL (
         SELECT fact.resource_revision, fact.state
         FROM service_resource_state_facts fact WHERE fact.service_id = service.id
         ORDER BY fact.resource_revision DESC LIMIT 1
       ) resource ON true
       LEFT JOIN LATERAL (
         SELECT fact.desired_revision
         FROM service_resource_desired_state_facts fact WHERE fact.service_id = service.id
         ORDER BY fact.desired_revision DESC LIMIT 1
       ) desired ON true
       WHERE request.id = $1`,
      [state.requestId],
    );
    const service = core.rows[0];
    const priorStateAllowed = state.action === "start"
      ? service?.resource_state === "stopped"
      : service?.resource_state === "running";
    const cancellationOnlyVersionDrift =
      service !== undefined &&
      service.cancellation_request_id !== null &&
      service.cancellation_expected_service_version === service.expected_service_version &&
      service.version === service.expected_service_version + 1;
    const versionAllowed =
      service !== undefined &&
      (service.version === service.expected_service_version || cancellationOnlyVersionDrift);
    if (
      !service ||
      service.status !== "active" ||
      !versionAllowed ||
      service.resource_revision !== service.expected_resource_revision ||
      !priorStateAllowed
    ) {
      await client.query(
        `INSERT INTO service_resource_operation_result_facts(
           request_id, revision, status, detail, error_code,
           provider_occurred_at, evidence
         ) VALUES ($1, $2, 'manual', $3, 'stale_provider_result', $4, $5)`,
        [
          state.requestId,
          latest.revision + 1,
          "Provider succeeded, but current Core service/resource revisions changed; Staff reconciliation is required",
          result.observedAt,
          { providerCalled: true, providerRevision: result.revision },
        ],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'succeeded', external_reference = $2,
             last_error = 'Core state changed before Provider success was applied', updated_at = now()
         WHERE id = $1`,
        [state.operationId, state.externalResourceId],
      );
      await finishJob(client, job, "manual", "Provider success requires manual reconciliation");
      return;
    }
    const occurredAt = new Date(result.observedAt);
    await client.query(
      `INSERT INTO service_resource_desired_state_facts(
         service_id, operation_request_id, desired_revision, state,
         source, recorded_at
       ) VALUES ($1, $2, $3, $4, 'daily_operation', $5)`,
      [state.serviceId, state.requestId, service.desired_revision + 1, providerState, occurredAt],
    );
    await client.query(
      `INSERT INTO service_resource_state_facts(
         service_id, operation_request_id, provider_operation_id,
         resource_revision, state, source, cause, observed_at
       ) VALUES ($1, $2, $3, $4, $5, 'daily_operation', $6, $7)`,
      [
        state.serviceId,
        state.requestId,
        state.operationId,
        service.resource_revision + 1,
        providerState,
        actionCapability(state.action),
        occurredAt,
      ],
    );
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, resource_state,
         provider_occurred_at, evidence
       ) VALUES ($1, $2, 'succeeded', $3, $4, $5)`,
      [
        state.requestId,
        latest.revision + 1,
        providerState,
        occurredAt,
        { providerCalled: true, providerRevision: result.revision },
      ],
    );
    await client.query(
      `UPDATE provider_operations
       SET status = 'succeeded', external_reference = $2,
           last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [state.operationId, state.externalResourceId],
    );
    await client.query(
      `INSERT INTO audit_events(
         actor_type, actor_id, action, target_type, target_id, reason, metadata
       ) VALUES ('system', $1, 'service.daily_operation_succeeded',
                 'service', $2, $3, $4)`,
      [
        "worker",
        state.serviceId,
        `${actionCapability(state.action)} completed through the Mock Provider contract`,
        { requestId: state.requestId, providerOperationId: state.operationId, resourceState: providerState },
      ],
    );
    await finishJob(client, job, "completed");
  });
}

async function providerFetch(
  runtime: ServiceOperationRuntime,
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

export async function processServiceOperationStart(
  pool: pg.Pool,
  job: ServiceOperationJob,
  runtime: ServiceOperationRuntime,
  hooks: ServiceOperationStartHooks = {},
): Promise<void> {
  const state = await preflightMutation(pool, job, runtime, hooks);
  if (!state) return;
  const request: ProvisioningOperationRequest = {
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    operationId: state.operationId,
    requestedAt: new Date().toISOString(),
    intentRef: state.requestId,
    capability: "provisioning",
    action: actionCapability(state.action) as ProvisioningAction,
    input: {
      serviceRef: state.serviceId,
      planRef: state.productId,
      externalResourceRef: state.externalResourceId,
    },
  };
  let response: Response;
  try {
    response = await providerFetch(runtime, "/v1alpha1/provisioning/operations", {
      method: "POST",
      headers: {
        "Idempotency-Key": state.operationId,
        "X-OSS-Lab-Scenario": runtime.scenario,
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    await markUnknown(pool, job, state, runtime, `Provider mutation transport outcome is unknown: ${detail(error)}`);
    return;
  }
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
  await hooks.afterProviderMutation?.();
  let result: ProviderOperationResult;
  try {
    result = parseBoundProvisioningResult(await response.json(), state);
  } catch (error) {
    if (error instanceof ServiceOperationProviderBindingError) {
      await markProviderBindingFailure(pool, job, state, error.message);
      return;
    }
    await markUnknown(pool, job, state, runtime, `Provider mutation response is invalid: ${detail(error)}`);
    return;
  }
  if (result.status === "succeeded" || result.status === "failed") {
    await persistTerminal(pool, job, state, result);
    return;
  }
  await markUnknown(pool, job, state, runtime, "Provider mutation is non-terminal; GET-only reconciliation required");
}

async function preflightReconcile(
  pool: pg.Pool,
  job: ServiceOperationJob,
  runtime: ServiceOperationRuntime,
): Promise<DispatchState | null> {
  return serviceOperationTransaction(pool, async (client) => {
    const requestId = job.payload.requestId;
    const serviceId = job.payload.serviceId;
    const operationId = job.payload.providerOperationId;
    await lockJob(client, job);
    if (!requestId || !serviceId || !operationId) {
      await finishJob(client, job, "manual", "invalid service operation reconcile payload");
      return null;
    }
    const pointer = await client.query<{
      order_item_id: string;
      action: DailyAction;
      external_resource_id: string;
      product_id: string;
      result_status: string;
      reconcile_count: number;
      operation_status: string;
    }>(
      `SELECT service.order_item_id, request.action,
              service.external_resource_id, item.product_id,
              latest.status AS result_status,
              COALESCE(attempt.reconcile_count, 0) AS reconcile_count,
              operation.status AS operation_status
       FROM service_resource_operation_requests request
       JOIN services service ON service.id = request.service_id
       JOIN order_items item ON item.id = service.order_item_id
       JOIN provider_operations operation
         ON operation.id = $3
        AND operation.subject_type = 'service_resource_operation'
        AND operation.subject_id = request.id
       LEFT JOIN LATERAL (
         SELECT result.status FROM service_resource_operation_result_facts result
         WHERE result.request_id = request.id ORDER BY result.revision DESC LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE fact.attempt_kind = 'reconcile_query')::integer
                  AS reconcile_count
         FROM service_resource_operation_attempt_facts fact
         WHERE fact.request_id = request.id
       ) attempt ON true
       WHERE request.id = $1 AND service.id = $2`,
      [requestId, serviceId, operationId],
    );
    const current = pointer.rows[0];
    if (!current) {
      await finishJob(client, job, "manual", "reconcile target disappeared");
      return null;
    }
    await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [current.order_item_id]);
    await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [serviceId]);
    await client.query("SELECT id FROM service_resource_operation_requests WHERE id = $1 FOR UPDATE", [requestId]);
    await client.query("SELECT id FROM provider_operations WHERE id = $1 FOR UPDATE", [operationId]);
    if (["succeeded", "failed", "manual"].includes(current.result_status)) {
      await finishJob(client, job, "completed");
      return null;
    }
    if (current.result_status !== "unknown" || !["running", "unknown"].includes(current.operation_status)) {
      await finishJob(client, job, "manual", "reconcile is not bound to an unknown Provider operation");
      return null;
    }
    if (current.reconcile_count >= runtime.reconcileMaxAttempts) {
      await rescheduleReconcile(client, job, runtime, "GET-only reconciliation attempts exhausted");
      return null;
    }
    return {
      requestId,
      serviceId,
      operationId,
      action: current.action,
      externalResourceId: current.external_resource_id,
      productId: current.product_id,
    };
  });
}

export async function processServiceOperationReconcile(
  pool: pg.Pool,
  job: ServiceOperationJob,
  runtime: ServiceOperationRuntime,
  hooks: ServiceOperationReconcileHooks = {},
): Promise<void> {
  const state = await preflightReconcile(pool, job, runtime);
  if (!state) return;
  await hooks.beforeProviderGet?.();
  let response: Response;
  try {
    response = await providerFetch(
      runtime,
      `/v1alpha1/provisioning/operations/${encodeURIComponent(state.operationId)}`,
      { method: "GET" },
    );
  } catch (error) {
    await serviceOperationTransaction(pool, async (client) => {
      await lockJob(client, job);
      await appendReconcileAttempt(client, state, job);
      await rescheduleReconcile(client, job, runtime, `Provider GET reconciliation failed: ${detail(error)}`);
    });
    return;
  }
  if (!response.ok) {
    await serviceOperationTransaction(pool, async (client) => {
      await lockJob(client, job);
      await appendReconcileAttempt(client, state, job);
      await rescheduleReconcile(client, job, runtime, `Provider GET reconciliation returned HTTP ${response.status}`);
    });
    return;
  }
  let result: ProviderOperationResult;
  try {
    result = parseBoundProvisioningResult(await response.json(), state);
  } catch (error) {
    if (error instanceof ServiceOperationProviderBindingError) {
      await markProviderBindingFailure(pool, job, state, error.message, runtime.workerId);
      return;
    }
    await serviceOperationTransaction(pool, async (client) => {
      await lockJob(client, job);
      await appendReconcileAttempt(client, state, job);
      await rescheduleReconcile(client, job, runtime, `Provider GET result is invalid: ${detail(error)}`);
    });
    return;
  }
  if (result.status === "succeeded" || result.status === "failed") {
    await persistTerminal(pool, job, state, result, runtime.workerId);
    return;
  }
  await serviceOperationTransaction(pool, async (client) => {
    await lockJob(client, job);
    await appendReconcileAttempt(client, state, job);
    await rescheduleReconcile(client, job, runtime, "Provider GET result remains non-terminal");
  });
}

export async function persistUnexpectedServiceOperationFailure(
  pool: pg.Pool,
  job: ServiceOperationJob,
  runtime: ServiceOperationRuntime,
  error: unknown,
): Promise<void> {
  if (isServiceOperationLeaseLostError(error)) throw error;
  const reason = `Unexpected service operation worker failure: ${detail(error)}`;
  await serviceOperationTransaction(pool, async (client) => {
    await lockJob(client, job);
    const requestId = job.payload.requestId;
    const serviceId = job.payload.serviceId;
    const operationId = job.payload.providerOperationId;
    if (!requestId || !serviceId || !operationId) {
      await finishJob(client, job, "manual", "invalid service operation payload after worker failure");
      return;
    }
    const currentResult = await client.query<{
      revision: number | null;
      status: string | null;
      operation_status: string;
      mutation_count: number;
    }>(
      `SELECT latest.revision, latest.status,
              operation.status AS operation_status,
              COALESCE(attempt.mutation_count, 0) AS mutation_count
       FROM provider_operations operation
       LEFT JOIN LATERAL (
         SELECT result.revision, result.status
         FROM service_resource_operation_result_facts result
         WHERE result.request_id = $1
         ORDER BY result.revision DESC LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE fact.attempt_kind = 'mutation')::integer
                  AS mutation_count
         FROM service_resource_operation_attempt_facts fact
         WHERE fact.request_id = $1
       ) attempt ON true
       WHERE operation.id = $2
         AND operation.subject_type = 'service_resource_operation'
         AND operation.subject_id = $1
       FOR UPDATE OF operation`,
      [requestId, operationId],
    );
    const current = currentResult.rows[0];
    if (!current) {
      await finishJob(client, job, "manual", "service operation facts disappeared after worker failure");
      return;
    }
    if (job.job_type === "service.operation.reconcile") {
      if (current.status === "unknown" && current.operation_status === "unknown") {
        await rescheduleReconcile(client, job, runtime, reason);
      } else {
        await finishJob(client, job, "completed");
      }
      return;
    }
    if (
      current.mutation_count === 0 &&
      current.status === null &&
      current.operation_status === "queued"
    ) {
      const updated = await client.query(
        `UPDATE durable_jobs
         SET status = 'pending',
             available_at = now() + make_interval(secs => $2),
             locked_at = NULL, locked_by = NULL,
             last_error = $3, updated_at = now()
         WHERE id = $1 AND status = 'running'
         RETURNING id`,
        [job.id, nextDelay(1, runtime.reconcileBaseDelaySeconds), reason],
      );
      if (updated.rowCount !== 1) throw new ServiceOperationLeaseLostError(job.id);
      return;
    }
    const state: DispatchState = {
      requestId,
      serviceId,
      operationId,
      action: "reboot",
      externalResourceId: "unavailable-after-worker-failure",
      productId: "unavailable-after-worker-failure",
    };
    if (current.status === "running" && current.operation_status === "running") {
      await client.query(
        `INSERT INTO service_resource_operation_result_facts(
           request_id, revision, status, detail, error_code, evidence
         ) VALUES ($1, $2, 'unknown', $3, 'worker_persistence_unknown', $4)`,
        [requestId, (current.revision ?? 0) + 1, reason, { providerCalled: true }],
      );
      await client.query(
        `UPDATE provider_operations
         SET status = 'unknown', last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'running'`,
        [operationId, reason],
      );
      await enqueueReconcile(client, state, runtime);
      await finishJob(client, job, "completed");
      return;
    }
    if (current.status === "unknown" && current.operation_status === "unknown") {
      await enqueueReconcile(client, state, runtime);
      await finishJob(client, job, "completed");
      return;
    }
    await finishJob(client, job, "completed");
  });
}

export async function recoverStaleServiceOperationJobs(
  pool: pg.Pool,
  runtime: ServiceOperationRuntime,
): Promise<number> {
  const candidates = await pool.query<{
    id: string;
    job_type: string;
    attempts: number;
  }>(
    `SELECT id, job_type, attempts
     FROM durable_jobs
     WHERE status = 'running'
       AND job_type IN ('service.operation.start', 'service.operation.reconcile')
       AND locked_at < now() - make_interval(secs => $1)
     ORDER BY locked_at, created_at
     LIMIT 50`,
    [runtime.staleLockSeconds],
  );
  let recovered = 0;
  for (const candidate of candidates.rows) {
    const changed = await serviceOperationTransaction(pool, async (client) => {
      const locked = await client.query<{
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
      const job = locked.rows[0];
      if (!job) return false;
      const requestId = job.payload.requestId;
      const operationId = job.payload.providerOperationId;
      if (!requestId || !operationId) {
        await client.query(
          `UPDATE durable_jobs SET status = 'manual', locked_at = NULL, locked_by = NULL,
                   last_error = 'stale service operation job has invalid payload', updated_at = now()
           WHERE id = $1`,
          [candidate.id],
        );
        return true;
      }
      const state = await client.query<{
        result_status: string | null;
        result_revision: number;
        attempt_count: number;
        reconcile_count: number;
        operation_status: string;
      }>(
        `SELECT latest.status AS result_status,
                COALESCE(latest.revision, 0) AS result_revision,
                COALESCE(attempt.attempt_count, 0) AS attempt_count,
                COALESCE(attempt.reconcile_count, 0) AS reconcile_count,
                operation.status AS operation_status
         FROM provider_operations operation
         LEFT JOIN LATERAL (
           SELECT result.status, result.revision
           FROM service_resource_operation_result_facts result
           WHERE result.request_id = $1 ORDER BY result.revision DESC LIMIT 1
         ) latest ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::integer AS attempt_count,
                  count(*) FILTER (WHERE fact.attempt_kind = 'reconcile_query')::integer
                    AS reconcile_count
           FROM service_resource_operation_attempt_facts fact
           WHERE fact.request_id = $1
         ) attempt ON true
         WHERE operation.id = $2
         FOR UPDATE OF operation`,
        [requestId, operationId],
      );
      const current = state.rows[0];
      if (!current) {
        await client.query(
          `UPDATE durable_jobs SET status = 'manual', locked_at = NULL, locked_by = NULL,
                   last_error = 'stale service operation references missing facts', updated_at = now()
           WHERE id = $1`,
          [candidate.id],
        );
        return true;
      }
      if (["succeeded", "failed"].includes(current.result_status ?? "")) {
        await client.query(
          `INSERT INTO service_operation_job_transition_facts(
             job_id, request_id, from_status, to_status, job_attempts, worker_id
           ) VALUES ($1, $2, 'running', 'completed', $3, $4)`,
          [candidate.id, requestId, job.attempts, job.locked_by],
        );
        await client.query(
          `UPDATE durable_jobs
           SET status = 'completed', locked_at = NULL, locked_by = NULL,
               last_error = NULL, updated_at = now()
           WHERE id = $1`,
          [candidate.id],
        );
        return true;
      }
      if (current.result_status === "manual") {
        await client.query(
          `INSERT INTO service_operation_job_transition_facts(
             job_id, request_id, from_status, to_status, job_attempts, worker_id
           ) VALUES ($1, $2, 'running', 'manual', $3, $4)`,
          [candidate.id, requestId, job.attempts, job.locked_by],
        );
        await client.query(
          `UPDATE durable_jobs
           SET status = 'manual', locked_at = NULL, locked_by = NULL,
               last_error = COALESCE(last_error, 'service operation requires Staff attention'),
               updated_at = now()
           WHERE id = $1`,
          [candidate.id],
        );
        return true;
      }
      if (job.job_type === "service.operation.start") {
        if (current.attempt_count === 0 && current.result_status === null && current.operation_status === "queued") {
          await client.query(
            `UPDATE durable_jobs SET status = 'pending', locked_at = NULL, locked_by = NULL,
                     available_at = now(), last_error = 'recovered before Provider mutation began', updated_at = now()
             WHERE id = $1`,
            [candidate.id],
          );
          return true;
        }
        if (current.result_status === "running") {
          await client.query(
            `INSERT INTO service_resource_operation_result_facts(
               request_id, revision, status, detail, error_code, evidence
             ) VALUES ($1, $2, 'unknown', $3, 'worker_restart', $4)`,
            [requestId, current.result_revision + 1, "Worker restarted after a possible Provider mutation", { providerCalled: true }],
          );
        }
        if (current.result_status === "running") {
          await client.query(
            `UPDATE provider_operations SET status = 'unknown',
                     last_error = 'worker restarted after possible Provider mutation', updated_at = now()
             WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
            [operationId],
          );
        }
        if (["running", "unknown"].includes(current.result_status ?? "")) {
          await client.query(
            `INSERT INTO durable_jobs(job_type, unique_key, payload, available_at)
             VALUES ('service.operation.reconcile', $1, $2, now())
             ON CONFLICT (job_type, unique_key) DO UPDATE
               SET status = CASE WHEN durable_jobs.status = 'manual' THEN 'manual' ELSE 'pending' END,
                   available_at = now(), locked_at = NULL, locked_by = NULL, updated_at = now()`,
            [`service-operation:${requestId}:reconcile`, job.payload],
          );
        }
        await client.query(
          `INSERT INTO service_operation_job_transition_facts(
             job_id, request_id, from_status, to_status, job_attempts, worker_id
           ) VALUES ($1, $2, 'running', 'completed', $3, $4)`,
          [candidate.id, requestId, job.attempts, job.locked_by],
        );
        await client.query(
          `UPDATE durable_jobs SET status = 'completed', locked_at = NULL, locked_by = NULL,
                   last_error = NULL, updated_at = now() WHERE id = $1`,
          [candidate.id],
        );
        return true;
      }
      const manual = current.reconcile_count >= runtime.reconcileMaxAttempts;
      if (manual && current.result_status === "unknown") {
        await client.query(
          `INSERT INTO service_resource_operation_result_facts(
             request_id, revision, status, detail, error_code, evidence
           ) VALUES ($1, $2, 'manual', $3, 'reconcile_exhausted', $4)`,
          [requestId, current.result_revision + 1, "GET-only reconciliation exhausted after Worker restarts", { providerCalled: true }],
        );
      }
      if (manual) {
        await client.query(
          `INSERT INTO service_operation_job_transition_facts(
             job_id, request_id, from_status, to_status, job_attempts, worker_id
           ) VALUES ($1, $2, 'running', 'manual', $3, $4)`,
          [candidate.id, requestId, job.attempts, job.locked_by],
        );
      }
      await client.query(
        `UPDATE durable_jobs
         SET status = $2, locked_at = NULL, locked_by = NULL,
             available_at = CASE WHEN $2 = 'pending' THEN now() ELSE available_at END,
             last_error = 'recovered stale GET-only reconciliation', updated_at = now()
         WHERE id = $1`,
        [candidate.id, manual ? "manual" : "pending"],
      );
      return true;
    });
    if (changed) recovered += 1;
  }
  return recovered;
}
