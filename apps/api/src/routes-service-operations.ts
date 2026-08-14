// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertCustomerCapability,
  assertEligible,
  expectedAccountContextVersion,
  lockMembershipAccountForMutation,
  lockSessionContextForMutation,
  requireSessionIdentity,
  requireUser,
  setAccountContextHeaders,
  type LockedAccountContext,
  type SessionIdentity,
} from "./auth.js";
import type { Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import {
  requireRecentReauth,
  requireStaffActionLocked,
  requireStaffPermission,
} from "./routes-admin.js";

const LAB_WARNING = "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY";
const MOCK_PROVISIONING_INSTALLATION_ID = "mock-provisioning-v1";
const STAFF_OPERATION_PERMISSION = "services.operations_manage";

const serviceOperationAction = z.enum(["start", "stop", "reboot"]);
type ServiceOperationAction = z.infer<typeof serviceOperationAction>;
type ResourceState = "running" | "stopped";

const customerOperationSchema = z
  .object({
    action: serviceOperationAction,
    expectedServiceVersion: z.number().int().positive(),
    expectedResourceRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

const staffOperationSchema = customerOperationSchema
  .omit({})
  .extend({ reason: z.string().trim().min(3).max(1_000) })
  .strict();

const manualCompletionSchema = z
  .object({
    expectedServiceVersion: z.number().int().positive(),
    expectedResourceRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(10).max(1_000),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

type CommandBody = z.infer<typeof customerOperationSchema> & { reason?: string };

type ServiceOperationReplay = Readonly<{
  requestId: string;
  serviceId: string;
  action: ServiceOperationAction;
  executionMode: "automatic" | "manual";
  status: "queued" | "running" | "unknown" | "manual" | "succeeded" | "failed";
  serviceVersion: number;
  resourceRevision: number;
  createdAt: string;
}>;

function requestError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function capabilityFor(action: ServiceOperationAction): string {
  return `resource.${action}`;
}

function assertCustomerOperationContext(context: LockedAccountContext): void {
  try {
    assertCustomerCapability(context, "services.manage");
  } catch {
    throw requestError(
      "Account is not eligible to manage this service",
      403,
      "ACCOUNT_NOT_ELIGIBLE",
    );
  }
}

async function serviceOperationActorAuthorizationIsStillFresh(
  client: DatabaseClient,
  input: {
    actorType: "user" | "staff";
    actor: Pick<SessionIdentity, "userId" | "sessionId">;
    clientAccountId: string;
  },
): Promise<boolean> {
  if (input.actorType === "user") {
    const result = await client.query<{ eligible: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM users user_record
           JOIN sessions session_record
             ON session_record.id = $2
            AND session_record.user_id = user_record.id
           JOIN client_accounts account
             ON account.id = $3
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
       ) AS eligible`,
      [input.actor.userId, input.actor.sessionId, input.clientAccountId],
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
         JOIN staff_members staff
           ON staff.user_id = user_record.id
        WHERE user_record.id = $1
          AND user_record.email_verified_at IS NOT NULL
          AND user_record.restricted_at IS NULL
          AND session_record.revoked_at IS NULL
          AND session_record.expires_at > pg_catalog.clock_timestamp()
          AND staff.active
          AND (staff.permissions ? '*' OR staff.permissions ? 'services.operations_manage')
          AND EXISTS (
            SELECT 1
              FROM reauth_grants reauth
             WHERE reauth.user_id = user_record.id
               AND reauth.session_id = session_record.id
               AND reauth.invalidated_at IS NULL
               AND reauth.expires_at > pg_catalog.clock_timestamp()
          )
     ) AS eligible`,
    [input.actor.userId, input.actor.sessionId],
  );
  return result.rows[0]?.eligible === true;
}

async function requireFreshServiceOperationActor(
  client: DatabaseClient,
  input: {
    actorType: "user" | "staff";
    actor: Pick<SessionIdentity, "userId" | "sessionId">;
    clientAccountId: string;
  },
): Promise<void> {
  if (await serviceOperationActorAuthorizationIsStillFresh(client, input)) return;
  throw requestError(
    input.actorType === "staff"
      ? "Current permission and password confirmation are required"
      : "The current Client Account authorization expired while acquiring locks",
    403,
    input.actorType === "staff"
      ? "STAFF_AUTHORIZATION_REQUIRED"
      : "ACCOUNT_NOT_ELIGIBLE",
  );
}

type LockedService = {
  id: string;
  client_account_id: string;
  order_item_id: string;
  status: string;
  version: number;
  product_name: string;
  external_resource_id: string | null;
  provider_installation_id: string | null;
  binding_capabilities: unknown;
  provider_enabled: boolean | null;
  current_capabilities: unknown;
  provider_version: number | null;
  resource_revision: number;
  resource_state: ResourceState | "terminated" | null;
  cancellation_due: boolean;
};

async function lockService(
  client: DatabaseClient,
  serviceId: string,
  clientAccountId: string,
): Promise<LockedService> {
  const pointer = await client.query<{ order_item_id: string }>(
    `SELECT service.order_item_id
     FROM services service
     WHERE service.id = $1 AND service.client_account_id = $2`,
    [serviceId, clientAccountId],
  );
  const orderItemId = pointer.rows[0]?.order_item_id;
  if (!orderItemId) throw requestError("Service not found", 404, "SERVICE_NOT_FOUND");
  await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [orderItemId]);
  const result = await client.query<LockedService>(
    `SELECT service.id,
            service.client_account_id,
            service.order_item_id,
            service.status,
            service.version,
            item.product_name,
            service.external_resource_id,
            binding.provider_installation_id,
            binding.capability_snapshot AS binding_capabilities,
            provider.enabled AS provider_enabled,
            provider.capabilities AS current_capabilities,
            provider.version AS provider_version,
            COALESCE(resource.resource_revision, 0) AS resource_revision,
            resource.state AS resource_state,
            service.cancellation_effective_at IS NOT NULL
              AND service.cancellation_effective_at <= pg_catalog.clock_timestamp()
              AS cancellation_due
     FROM services service
     JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN service_provider_bindings binding ON binding.service_id = service.id
     LEFT JOIN provider_installation_capabilities provider
       ON provider.provider_installation_id = binding.provider_installation_id
     LEFT JOIN LATERAL (
       SELECT fact.resource_revision, fact.state
       FROM service_resource_state_facts fact
       WHERE fact.service_id = service.id
       ORDER BY fact.resource_revision DESC
       LIMIT 1
     ) resource ON true
     WHERE service.id = $1 AND service.client_account_id = $2
     FOR UPDATE OF service`,
    [serviceId, clientAccountId],
  );
  const service = result.rows[0];
  if (!service) throw requestError("Service not found", 404, "SERVICE_NOT_FOUND");
  return service;
}

function assertActionAllowed(
  service: LockedService,
  body: Pick<CommandBody, "action" | "expectedServiceVersion" | "expectedResourceRevision">,
): void {
  if (service.version !== body.expectedServiceVersion) {
    throw requestError("Service changed; refresh before trying again", 409, "VERSION_CONFLICT");
  }
  if (service.resource_revision !== body.expectedResourceRevision) {
    throw requestError(
      "Resource state changed; refresh before trying again",
      409,
      "RESOURCE_VERSION_CONFLICT",
    );
  }
  if (service.status !== "active") {
    throw requestError(
      "Daily operations are available only while the commercial service is active",
      409,
      "SERVICE_OPERATION_NOT_ALLOWED",
    );
  }
  if (service.cancellation_due) {
    throw requestError(
      "The period-end cancellation is already effective",
      409,
      "SERVICE_OPERATION_NOT_ALLOWED",
    );
  }
  const allowed =
    (body.action === "start" && service.resource_state === "stopped") ||
    ((body.action === "stop" || body.action === "reboot") &&
      service.resource_state === "running");
  if (!allowed) {
    throw requestError(
      `Resource state ${service.resource_state ?? "unknown"} does not allow ${body.action}`,
      409,
      "RESOURCE_ACTION_NOT_ALLOWED",
    );
  }
}

async function replayOperation(
  client: DatabaseClient,
  actorType: "user" | "staff",
  actorUserId: string,
  idempotencyKey: string,
  fingerprint: string,
  serviceId: string,
  clientAccountId: string,
): Promise<ServiceOperationReplay | null> {
  const replay = await client.query<{
    service_id: string;
    client_account_id: string;
    request_fingerprint: string;
    result: ServiceOperationReplay;
  }>(
    `SELECT request.service_id,
            request.client_account_id,
            request.request_fingerprint,
            jsonb_build_object(
              'requestId', request.id,
              'serviceId', request.service_id,
              'action', request.action,
              'executionMode', request.execution_mode,
              'status', COALESCE(latest.status, 'queued'),
              'serviceVersion', request.expected_service_version,
              'resourceRevision', request.expected_resource_revision,
              'createdAt', request.created_at
            ) AS result
     FROM service_resource_operation_requests request
     LEFT JOIN LATERAL (
       SELECT result.status
       FROM service_resource_operation_result_facts result
       WHERE result.request_id = request.id
       ORDER BY result.revision DESC
       LIMIT 1
     ) latest ON true
     WHERE request.actor_type = $1
       AND request.actor_user_id = $2
       AND request.idempotency_key = $3`,
    [actorType, actorUserId, idempotencyKey],
  );
  const previous = replay.rows[0];
  if (!previous) return null;
  if (
    previous.request_fingerprint !== fingerprint ||
    previous.service_id !== serviceId ||
    previous.client_account_id !== clientAccountId
  ) {
    throw requestError(
      "This idempotency key was already used for another service operation",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
  return previous.result;
}

async function createOperation(
  client: DatabaseClient,
  input: {
    actorType: "user" | "staff";
    actor: Pick<SessionIdentity, "userId" | "sessionId">;
    clientAccountId: string;
    serviceId: string;
    body: CommandBody;
    fingerprint: string;
  },
): Promise<ServiceOperationReplay & { replayed: boolean }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `service-operation-idempotency:${input.actorType}:${input.actor.userId}:${input.body.idempotencyKey}`,
  ]);
  const replay = await replayOperation(
    client,
    input.actorType,
    input.actor.userId,
    input.body.idempotencyKey,
    input.fingerprint,
    input.serviceId,
    input.clientAccountId,
  );
  if (replay) return { ...replay, replayed: true };

  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `service-daily-operation:${input.serviceId}`,
  ]);
  const service = await lockService(client, input.serviceId, input.clientAccountId);
  assertActionAllowed(service, input.body);
  const unresolved = await client.query(
    `SELECT request.id
     FROM service_resource_operation_requests request
     LEFT JOIN LATERAL (
       SELECT result.status
       FROM service_resource_operation_result_facts result
       WHERE result.request_id = request.id
       ORDER BY result.revision DESC
       LIMIT 1
     ) latest ON true
     WHERE request.service_id = $1
       AND COALESCE(latest.status, 'queued') NOT IN ('succeeded', 'failed')
     LIMIT 1`,
    [service.id],
  );
  if ((unresolved.rowCount ?? 0) > 0) {
    throw requestError(
      "Another daily operation is still unresolved",
      409,
      "SERVICE_OPERATION_IN_PROGRESS",
    );
  }

  const requiredCapability = capabilityFor(input.body.action);
  const atBinding = stringList(service.binding_capabilities);
  const current = stringList(service.current_capabilities);
  const automatic =
    service.provider_installation_id === MOCK_PROVISIONING_INSTALLATION_ID &&
    service.external_resource_id !== null &&
    service.provider_enabled === true &&
    atBinding.includes(requiredCapability) &&
    current.includes(requiredCapability);
  await requireFreshServiceOperationActor(client, input);
  const requestId = randomUUID();
  const providerOperationId = automatic ? randomUUID() : null;
  const createdAtResult = await client.query<{ created_at: Date }>(
    "SELECT pg_catalog.clock_timestamp() AS created_at",
  );
  const createdAt = createdAtResult.rows[0]?.created_at;
  if (!createdAt) {
    throw new Error("Database clock did not return a service operation timestamp");
  }
  const result: ServiceOperationReplay = {
    requestId,
    serviceId: service.id,
    action: input.body.action,
    executionMode: automatic ? "automatic" : "manual",
    status: automatic ? "queued" : "manual",
    serviceVersion: service.version,
    resourceRevision: service.resource_revision,
    createdAt: createdAt.toISOString(),
  };
  await client.query(
    `INSERT INTO service_resource_operation_requests(
       id, service_id, client_account_id, actor_type, actor_user_id,
       actor_session_id, action, expected_service_version,
       expected_resource_revision, execution_mode, provider_installation_id,
       provider_capability_snapshot, reason,
       idempotency_key, request_fingerprint, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16
     )`,
    [
      requestId,
      service.id,
      input.clientAccountId,
      input.actorType,
      input.actor.userId,
      input.actor.sessionId,
      input.body.action,
      input.body.expectedServiceVersion,
      input.body.expectedResourceRevision,
      automatic ? "automatic" : "manual",
      automatic ? service.provider_installation_id : null,
      automatic
        ? {
            atBinding,
            current,
            currentVersion: service.provider_version,
          }
        : {},
      input.actorType === "staff" ? input.body.reason : null,
      input.body.idempotencyKey,
      input.fingerprint,
      createdAt,
    ],
  );
  if (automatic && providerOperationId) {
    const operationKind = capabilityFor(input.body.action);
    await client.query(
      `INSERT INTO provider_operations(
         id, provider_installation_id, kind, subject_type, subject_id,
         stable_key, status
       ) VALUES ($1, $2, $3, 'service_resource_operation', $4, $5, 'queued')`,
      [
        providerOperationId,
        service.provider_installation_id,
        operationKind,
        requestId,
        `service-operation:${requestId}:${input.body.action}`,
      ],
    );
    await client.query(
      `INSERT INTO durable_jobs(job_type, unique_key, payload)
       VALUES ('service.operation.start', $1, $2)`,
      [
        `service-operation:${requestId}:start`,
        {
          requestId,
          serviceId: service.id,
          providerOperationId,
        },
      ],
    );
  } else {
    await client.query(
      `INSERT INTO service_resource_operation_result_facts(
         request_id, revision, status, detail, evidence, created_at
       ) VALUES ($1, 1, 'manual', $2, $3, $4)`,
      [
        requestId,
        "The bound service has no currently approved Mock Provider capability; Staff completion is required",
        { providerCalled: false, requiredCapability },
        createdAt,
      ],
    );
  }
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES ($1, $2, 'service.daily_operation_requested', 'service', $3, $4, $5)`,
    [
      input.actorType,
      input.actor.userId,
      service.id,
      input.body.reason ?? `${input.body.action} requested from the customer service workspace`,
      {
        requestId,
        action: input.body.action,
        executionMode: result.executionMode,
        expectedServiceVersion: service.version,
        expectedResourceRevision: service.resource_revision,
        providerOperationId,
      },
    ],
  );
  return { ...result, replayed: false };
}

async function listOperations(
  pool: DatabasePool,
  serviceId: string,
  clientAccountId: string,
  audience: "customer" | "staff",
) {
  const serviceResult = await pool.query<{
    id: string;
    status: string;
    version: number;
    product_name: string;
    resource_revision: number;
    resource_state: ResourceState | "terminated" | null;
  }>(
    `SELECT service.id, service.status, service.version, item.product_name,
            COALESCE(resource.resource_revision, 0) AS resource_revision,
            resource.state AS resource_state
     FROM services service
     JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN LATERAL (
       SELECT fact.resource_revision, fact.state
       FROM service_resource_state_facts fact
       WHERE fact.service_id = service.id
       ORDER BY fact.resource_revision DESC
       LIMIT 1
     ) resource ON true
     WHERE service.id = $1 AND service.client_account_id = $2`,
    [serviceId, clientAccountId],
  );
  const service = serviceResult.rows[0];
  if (!service) throw requestError("Service not found", 404, "SERVICE_NOT_FOUND");
  const operations = await pool.query<{
    request_id: string;
    action: ServiceOperationAction;
    actor_type: "user" | "staff";
    execution_mode: "automatic" | "manual";
    reason: string | null;
    expected_service_version: number;
    expected_resource_revision: number;
    created_at: Date;
    latest_status: string | null;
    latest_revision: number | null;
    latest_resource_state: ResourceState | null;
    latest_detail: string | null;
    latest_error_code: string | null;
    latest_created_at: Date | null;
    provider_operation_status: string | null;
    provider_attempt_count: number | null;
  }>(
    `SELECT request.id AS request_id,
            request.action,
            request.actor_type,
            request.execution_mode,
            request.reason,
            request.expected_service_version,
            request.expected_resource_revision,
            request.created_at,
            latest.status AS latest_status,
            latest.revision AS latest_revision,
            latest.resource_state AS latest_resource_state,
            latest.detail AS latest_detail,
            latest.error_code AS latest_error_code,
            latest.created_at AS latest_created_at,
            operation.status AS provider_operation_status,
            operation.attempt_count AS provider_attempt_count
     FROM service_resource_operation_requests request
     LEFT JOIN LATERAL (
       SELECT result.status, result.revision, result.resource_state,
              result.detail, result.error_code, result.created_at
       FROM service_resource_operation_result_facts result
       WHERE result.request_id = request.id
       ORDER BY result.revision DESC
       LIMIT 1
     ) latest ON true
     LEFT JOIN provider_operations operation
       ON operation.subject_type = 'service_resource_operation'
      AND operation.subject_id = request.id
     WHERE request.service_id = $1 AND request.client_account_id = $2
     ORDER BY request.created_at DESC, request.id DESC
     LIMIT 50`,
    [serviceId, clientAccountId],
  );
  const unresolved = operations.rows.some(
    (row) => !["succeeded", "failed"].includes(row.latest_status ?? "queued"),
  );
  const availableActions: ServiceOperationAction[] = [];
  if (service.status === "active" && !unresolved) {
    if (service.resource_state === "running") availableActions.push("stop", "reboot");
    if (service.resource_state === "stopped") availableActions.push("start");
  }
  return {
    warning: LAB_WARNING,
    service: {
      id: service.id,
      productName: service.product_name,
      status: service.status,
      version: service.version,
      resourceState: service.resource_state,
      resourceRevision: service.resource_revision,
      availableActions,
    },
    items: operations.rows.map((row) => {
      const publicFact = {
        requestId: row.request_id,
        action: row.action,
        executionMode: row.execution_mode,
        status: row.latest_status ?? "queued",
        revision: row.latest_revision ?? 0,
        resultingResourceState: row.latest_resource_state,
        reasonCode: customerReasonCode(row.latest_status, row.latest_error_code),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.latest_created_at?.toISOString() ?? row.created_at.toISOString(),
      };
      if (audience === "customer") return publicFact;
      return {
        ...publicFact,
        actorType: row.actor_type,
        reason: row.reason,
        expectedServiceVersion: row.expected_service_version,
        expectedResourceRevision: row.expected_resource_revision,
        detail: row.latest_detail,
        errorCode: row.latest_error_code,
        providerOperation: row.provider_operation_status
          ? {
              status: row.provider_operation_status,
              attempts: row.provider_attempt_count ?? 0,
            }
          : null,
      };
    }),
  };
}

function customerReasonCode(status: string | null, errorCode: string | null): string | null {
  if (status === null || status === "queued" || status === "running") return "in_progress";
  if (status === "unknown") return "outcome_reconciling";
  if (status === "manual") return "staff_action_required";
  if (status === "failed") {
    return errorCode === "dispatch_preflight_rejected"
      ? "authorization_or_state_changed"
      : "provider_operation_failed";
  }
  return null;
}

export async function registerServiceOperationRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/services/:serviceId/operations", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertCustomerCapability(user, "account.history.read");
    const params = z.object({ serviceId: z.uuid() }).parse(request.params);
    const result = await listOperations(
      pool,
      params.serviceId,
      user.clientAccountId,
      "customer",
    );
    setAccountContextHeaders(reply, user);
    return result;
  });

  app.post("/api/v1/services/:serviceId/operations", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
    assertCustomerCapability(user, "services.manage");
    const expectedContextVersion = expectedAccountContextVersion(request);
    const params = z.object({ serviceId: z.uuid() }).parse(request.params);
    const body = customerOperationSchema.parse(request.body);
    const fingerprint = requestFingerprint("services.daily-operation:v1", {
      serviceId: params.serviceId,
      action: body.action,
      expectedServiceVersion: body.expectedServiceVersion,
      expectedResourceRevision: body.expectedResourceRevision,
    });
    const outcome = await transaction(pool, async (client) => {
      const session = await lockSessionContextForMutation(client, user, expectedContextVersion);
      const context = await lockMembershipAccountForMutation(client, user, session);
      assertCustomerOperationContext(context);
      return createOperation(client, {
        actorType: "user",
        actor: user,
        clientAccountId: user.clientAccountId,
        serviceId: params.serviceId,
        body,
        fingerprint,
      });
    });
    setAccountContextHeaders(reply, user);
    return reply.code(outcome.replayed ? 200 : 201).send(outcome);
  });

  app.get(
    "/api/v1/admin/client-accounts/:clientAccountId/services/:serviceId/operations",
    async (request) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "services.read");
      const params = z
        .object({ clientAccountId: z.uuid(), serviceId: z.uuid() })
        .parse(request.params);
      return listOperations(pool, params.serviceId, params.clientAccountId, "staff");
    },
  );

  app.post(
    "/api/v1/admin/client-accounts/:clientAccountId/services/:serviceId/operations",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, STAFF_OPERATION_PERMISSION);
      await requireRecentReauth(pool, user);
      const params = z
        .object({ clientAccountId: z.uuid(), serviceId: z.uuid() })
        .parse(request.params);
      const body = staffOperationSchema.parse(request.body);
      const fingerprint = requestFingerprint("admin.services.daily-operation:v1", {
        clientAccountId: params.clientAccountId,
        serviceId: params.serviceId,
        action: body.action,
        expectedServiceVersion: body.expectedServiceVersion,
        expectedResourceRevision: body.expectedResourceRevision,
        reason: body.reason,
      });
      const outcome = await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, STAFF_OPERATION_PERMISSION);
        const account = await client.query(
          "SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE",
          [params.clientAccountId],
        );
        if (account.rowCount !== 1) {
          throw requestError("Client account not found", 404, "CLIENT_ACCOUNT_NOT_FOUND");
        }
        return createOperation(client, {
          actorType: "staff",
          actor: user,
          clientAccountId: params.clientAccountId,
          serviceId: params.serviceId,
          body,
          fingerprint,
        });
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );

  app.get("/api/v1/admin/service-operations", async (request) => {
    const user = await requireSessionIdentity(request, pool, config);
    await requireStaffPermission(pool, user, STAFF_OPERATION_PERMISSION);
    const query = z
      .object({ status: z.enum(["unresolved", "all"]).default("unresolved") })
      .parse(request.query);
    const result = await pool.query<{
      request_id: string;
      service_id: string;
      client_account_id: string;
      client_account_name: string;
      product_name: string;
      action: ServiceOperationAction;
      execution_mode: "automatic" | "manual";
      expected_service_version: number;
      expected_resource_revision: number;
      current_service_version: number;
      current_resource_revision: number;
      status: string;
      result_revision: number;
      detail: string | null;
      created_at: Date;
    }>(
      `SELECT request.id AS request_id,
              request.service_id,
              request.client_account_id,
              account.name AS client_account_name,
              item.product_name,
              request.action,
              request.execution_mode,
              request.expected_service_version,
              request.expected_resource_revision,
              service.version AS current_service_version,
              COALESCE(resource.resource_revision, 0) AS current_resource_revision,
              COALESCE(latest.status, 'queued') AS status,
              COALESCE(latest.revision, 0) AS result_revision,
              latest.detail,
              request.created_at
       FROM service_resource_operation_requests request
       JOIN client_accounts account ON account.id = request.client_account_id
       JOIN services service ON service.id = request.service_id
       JOIN order_items item ON item.id = service.order_item_id
       LEFT JOIN LATERAL (
         SELECT fact.resource_revision
         FROM service_resource_state_facts fact
         WHERE fact.service_id = service.id
         ORDER BY fact.resource_revision DESC
         LIMIT 1
       ) resource ON true
       LEFT JOIN LATERAL (
         SELECT result.status, result.revision, result.detail
         FROM service_resource_operation_result_facts result
         WHERE result.request_id = request.id
         ORDER BY result.revision DESC
         LIMIT 1
       ) latest ON true
       WHERE $1 = 'all'
          OR COALESCE(latest.status, 'queued') NOT IN ('succeeded', 'failed')
       ORDER BY request.created_at, request.id
       LIMIT 100`,
      [query.status],
    );
    return {
      warning: LAB_WARNING,
      items: result.rows.map((row) => ({
        requestId: row.request_id,
        serviceId: row.service_id,
        clientAccountId: row.client_account_id,
        clientAccountName: row.client_account_name,
        productName: row.product_name,
        action: row.action,
        executionMode: row.execution_mode,
        expectedServiceVersion: row.expected_service_version,
        expectedResourceRevision: row.expected_resource_revision,
        currentServiceVersion: row.current_service_version,
        currentResourceRevision: row.current_resource_revision,
        status: row.status,
        resultRevision: row.result_revision,
        detail: row.detail,
        createdAt: row.created_at.toISOString(),
      })),
    };
  });

  app.post(
    "/api/v1/admin/service-operations/:requestId/complete-manual",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, STAFF_OPERATION_PERMISSION);
      await requireRecentReauth(pool, user);
      const params = z.object({ requestId: z.uuid() }).parse(request.params);
      const body = manualCompletionSchema.parse(request.body);
      const fingerprint = requestFingerprint("admin.services.complete-manual-operation:v1", {
        requestId: params.requestId,
        expectedServiceVersion: body.expectedServiceVersion,
        expectedResourceRevision: body.expectedResourceRevision,
        reason: body.reason,
      });
      const outcome = await transaction(pool, async (client) => {
        await requireStaffActionLocked(client, user, STAFF_OPERATION_PERMISSION);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `service-operation-manual:${user.userId}:${body.idempotencyKey}`,
        ]);
        const replay = await client.query<{ request_fingerprint: string; result: unknown }>(
          `SELECT request_fingerprint, result
           FROM service_resource_operation_manual_completions
           WHERE staff_user_id = $1 AND idempotency_key = $2`,
          [user.userId, body.idempotencyKey],
        );
        const previous = replay.rows[0];
        if (previous) {
          if (previous.request_fingerprint !== fingerprint) {
            throw requestError(
              "This idempotency key was already used for another manual completion",
              409,
              "IDEMPOTENCY_CONFLICT",
            );
          }
          return { ...(previous.result as Record<string, unknown>), replayed: true };
        }

        const pointer = await client.query<{
          service_id: string;
          client_account_id: string;
          order_item_id: string;
        }>(
          `SELECT request.service_id, request.client_account_id, service.order_item_id
           FROM service_resource_operation_requests request
           JOIN services service ON service.id = request.service_id
           WHERE request.id = $1`,
          [params.requestId],
        );
        const target = pointer.rows[0];
        if (!target) throw requestError("Service operation not found", 404, "SERVICE_OPERATION_NOT_FOUND");
        await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
          target.client_account_id,
        ]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `service-daily-operation:${target.service_id}`,
        ]);
        await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [
          target.order_item_id,
        ]);
        await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
          target.service_id,
        ]);
        await client.query(
          "SELECT id FROM service_resource_operation_requests WHERE id = $1 FOR UPDATE",
          [params.requestId],
        );
        await requireFreshServiceOperationActor(client, {
          actorType: "staff",
          actor: user,
          clientAccountId: target.client_account_id,
        });
        const state = await client.query<{
          action: ServiceOperationAction;
          execution_mode: "manual" | "automatic";
          service_status: string;
          service_version: number;
          cancellation_eligible: boolean;
          resource_revision: number;
          resource_state: ResourceState | "terminated" | null;
          desired_revision: number;
          attempt_number: number;
          result_status: string;
          result_revision: number;
        }>(
          `SELECT request.action,
                  request.execution_mode,
                  service.status AS service_status,
                  service.version AS service_version,
                  (service.cancellation_effective_at IS NULL
                    OR service.cancellation_effective_at > pg_catalog.clock_timestamp())
                    AS cancellation_eligible,
                  COALESCE(resource.resource_revision, 0) AS resource_revision,
                  resource.state AS resource_state,
                  COALESCE(desired.desired_revision, 0) AS desired_revision,
                  COALESCE(attempt.attempt_number, 0) AS attempt_number,
                  latest.status AS result_status,
                  latest.revision AS result_revision
           FROM service_resource_operation_requests request
           JOIN services service ON service.id = request.service_id
           LEFT JOIN LATERAL (
             SELECT fact.resource_revision, fact.state
             FROM service_resource_state_facts fact
             WHERE fact.service_id = service.id
             ORDER BY fact.resource_revision DESC
             LIMIT 1
           ) resource ON true
           LEFT JOIN LATERAL (
             SELECT fact.desired_revision
             FROM service_resource_desired_state_facts fact
             WHERE fact.service_id = service.id
             ORDER BY fact.desired_revision DESC
             LIMIT 1
           ) desired ON true
           LEFT JOIN LATERAL (
             SELECT fact.attempt_number
             FROM service_resource_operation_attempt_facts fact
             WHERE fact.request_id = request.id
             ORDER BY fact.attempt_number DESC
             LIMIT 1
           ) attempt ON true
           LEFT JOIN LATERAL (
             SELECT result.status, result.revision
             FROM service_resource_operation_result_facts result
             WHERE result.request_id = request.id
             ORDER BY result.revision DESC
             LIMIT 1
           ) latest ON true
           WHERE request.id = $1`,
          [params.requestId],
        );
        const current = state.rows[0];
        if (!current || current.result_status !== "manual") {
          throw requestError(
            "Service operation is not waiting for manual completion",
            409,
            "MANUAL_COMPLETION_NOT_ALLOWED",
          );
        }
        if (
          current.service_status !== "active" ||
          !current.cancellation_eligible ||
          current.service_version !== body.expectedServiceVersion ||
          current.resource_revision !== body.expectedResourceRevision
        ) {
          throw requestError(
            "Service or resource state changed; refresh before completing",
            409,
            "VERSION_CONFLICT",
          );
        }
        const resultingState: ResourceState = current.action === "stop" ? "stopped" : "running";
        const actionId = randomUUID();
        const completedAtResult = await client.query<{ completed_at: Date }>(
          "SELECT pg_catalog.clock_timestamp() AS completed_at",
        );
        const completedAt = completedAtResult.rows[0]?.completed_at;
        if (!completedAt) {
          throw new Error("Database clock did not return a manual completion timestamp");
        }
        const result = {
          actionId,
          requestId: params.requestId,
          serviceId: target.service_id,
          action: current.action,
          status: "succeeded",
          resourceState: resultingState,
          resourceRevision: current.resource_revision + 1,
          completedAt: completedAt.toISOString(),
          providerCalled: false,
        };
        await client.query(
          `INSERT INTO service_resource_operation_manual_completions(
             id, request_id, service_id, client_account_id, staff_user_id,
             staff_session_id, expected_service_version,
             expected_resource_revision, expected_desired_revision,
             reason, idempotency_key,
             request_fingerprint, result, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            actionId,
            params.requestId,
            target.service_id,
            target.client_account_id,
            user.userId,
            user.sessionId,
            body.expectedServiceVersion,
            body.expectedResourceRevision,
            current.desired_revision,
            body.reason,
            body.idempotencyKey,
            fingerprint,
            result,
            completedAt,
          ],
        );
        await client.query(
          `INSERT INTO service_resource_operation_attempt_facts(
             request_id, attempt_number, attempt_kind, actor_id, started_at
           ) VALUES ($1, $2, 'manual', $3, $4)`,
          [params.requestId, current.attempt_number + 1, user.userId, completedAt],
        );
        await client.query(
          `INSERT INTO service_resource_desired_state_facts(
             service_id, operation_request_id, desired_revision, state,
             source, recorded_at
           ) VALUES ($1, $2, $3, $4, 'daily_operation', $5)`,
          [
            target.service_id,
            params.requestId,
            current.desired_revision + 1,
            resultingState,
            completedAt,
          ],
        );
        await client.query(
          `INSERT INTO service_resource_state_facts(
             service_id, operation_request_id, resource_revision, state,
             source, cause, observed_at
           ) VALUES ($1, $2, $3, $4, 'daily_operation', $5, $6)`,
          [
            target.service_id,
            params.requestId,
            current.resource_revision + 1,
            resultingState,
            capabilityFor(current.action),
            completedAt,
          ],
        );
        await client.query(
          `INSERT INTO service_resource_operation_result_facts(
             request_id, revision, status, resource_state, evidence,
             provider_occurred_at, created_at
           ) VALUES ($1, $2, 'succeeded', $3, $4, $5, $5)`,
          [
            params.requestId,
            current.result_revision + 1,
            resultingState,
            { providerCalled: false, completedByStaff: true },
            completedAt,
          ],
        );
        await client.query(
          `INSERT INTO audit_events(
             actor_type, actor_id, action, target_type, target_id, reason, metadata
           ) VALUES ('staff', $1, 'service.daily_operation_manual_completed',
                     'service', $2, $3, $4)`,
          [user.userId, target.service_id, body.reason, result],
        );
        return { ...result, replayed: false };
      });
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );
}
