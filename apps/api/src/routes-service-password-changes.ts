// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  digestIdentitySecret,
  encryptIdentitySecret,
} from "@opensales/core/identity-security";
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
import { identitySecretKeyring, type Config } from "./config.js";
import { transaction, type DatabaseClient, type DatabasePool } from "./database.js";
import { requestFingerprint } from "./idempotency.js";
import {
  requireRecentReauth,
  requireRecentReauthLocked,
  requireStaffActionLocked,
  requireStaffPermission,
} from "./routes-admin.js";

const LAB_WARNING = "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY";
const MOCK_PROVISIONING_INSTALLATION_ID = "mock-provisioning-v1";
const REQUIRED_CAPABILITY = "resource.change_password";
const STAFF_PERMISSION = "services.operations_manage";
const SECRET_PURPOSE = "service-password-change";

const customerCommand = z
  .object({
    expectedServiceVersion: z.number().int().positive(),
    expectedResourceRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(8).max(128),
    newPassword: z.string().min(12).max(128),
  })
  .strict();

const staffCommand = customerCommand
  .extend({ reason: z.string().trim().min(3).max(1_000) })
  .strict();

type CommandBody = z.infer<typeof customerCommand> & { reason?: string };

type PasswordChangeReplay = Readonly<{
  requestId: string;
  serviceId: string;
  action: "change_password";
  status: "queued" | "running" | "unknown" | "manual" | "succeeded" | "failed";
  serviceVersion: number;
  resourceRevision: number;
  createdAt: string;
}>;

function requestError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function assertSecretIsNotCopiedIntoDurableFields(body: CommandBody): void {
  const durableFields = [body.idempotencyKey, body.reason].filter(
    (candidate): candidate is string => typeof candidate === "string",
  );
  if (
    durableFields.some(
      (candidate) =>
        candidate.includes(body.newPassword) || body.newPassword.includes(candidate),
    )
  ) {
    throw requestError(
      "The service password must be different from persistent request fields",
      400,
      "SERVICE_PASSWORD_DURABLE_FIELD_CONFLICT",
    );
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function assertCustomerContext(context: LockedAccountContext): void {
  try {
    assertCustomerCapability(context, "services.manage");
  } catch {
    throw requestError(
      "Account is not eligible to change this service password",
      403,
      "ACCOUNT_NOT_ELIGIBLE",
    );
  }
}

type LockedService = Readonly<{
  id: string;
  order_item_id: string;
  status: string;
  version: number;
  product_id: string;
  product_name: string;
  external_resource_id: string | null;
  provider_installation_id: string | null;
  binding_capabilities: unknown;
  provider_enabled: boolean | null;
  current_capabilities: unknown;
  provider_version: number | null;
  resource_revision: number;
  cancellation_due: boolean;
}>;

async function lockService(
  client: DatabaseClient,
  serviceId: string,
  clientAccountId: string,
): Promise<LockedService> {
  const pointer = await client.query<{ order_item_id: string }>(
    `SELECT order_item_id
     FROM services
     WHERE id = $1 AND client_account_id = $2`,
    [serviceId, clientAccountId],
  );
  const orderItemId = pointer.rows[0]?.order_item_id;
  if (!orderItemId) throw requestError("Service not found", 404, "SERVICE_NOT_FOUND");
  await client.query("SELECT id FROM order_items WHERE id = $1 FOR UPDATE", [orderItemId]);
  const result = await client.query<LockedService>(
    `SELECT service.id, service.order_item_id, service.status, service.version,
            item.product_id, item.product_name, service.external_resource_id,
            binding.provider_installation_id,
            binding.capability_snapshot AS binding_capabilities,
            provider.enabled AS provider_enabled,
            provider.capabilities AS current_capabilities,
            provider.version AS provider_version,
            COALESCE(resource.resource_revision, 0) AS resource_revision,
            service.cancellation_effective_at IS NOT NULL
              AND service.cancellation_effective_at <= pg_catalog.clock_timestamp()
              AS cancellation_due
     FROM services service
     JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN service_provider_bindings binding ON binding.service_id = service.id
     LEFT JOIN provider_installation_capabilities provider
       ON provider.provider_installation_id = binding.provider_installation_id
     LEFT JOIN LATERAL (
       SELECT fact.resource_revision
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

function assertServiceEligible(
  service: LockedService,
  body: Pick<CommandBody, "expectedServiceVersion" | "expectedResourceRevision">,
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
  if (service.status !== "active" || service.cancellation_due) {
    throw requestError(
      "Password changes are available only while the service is active",
      409,
      "SERVICE_PASSWORD_CHANGE_NOT_ALLOWED",
    );
  }
  const binding = stringList(service.binding_capabilities);
  const current = stringList(service.current_capabilities);
  if (
    service.provider_installation_id !== MOCK_PROVISIONING_INSTALLATION_ID ||
    service.external_resource_id === null ||
    service.provider_enabled !== true ||
    !binding.includes(REQUIRED_CAPABILITY) ||
    !current.includes(REQUIRED_CAPABILITY)
  ) {
    throw requestError(
      "This service has no currently approved Mock Provider password-change capability",
      409,
      "SERVICE_PASSWORD_CHANGE_UNAVAILABLE",
    );
  }
}

function intentFingerprint(
  actorType: "user" | "staff",
  clientAccountId: string,
  serviceId: string,
  body: CommandBody,
  secretDigest: string,
  secretDigestKeyVersion: number,
): string {
  const shared = {
    serviceId,
    action: "change_password",
    expectedServiceVersion: body.expectedServiceVersion,
    expectedResourceRevision: body.expectedResourceRevision,
    secretDigest,
    secretDigestKeyVersion,
  };
  return requestFingerprint(
    actorType === "user" ? "services.change-password:v1" : "admin.services.change-password:v1",
    actorType === "user"
      ? shared
      : { clientAccountId, ...shared, reason: body.reason },
  );
}

async function replayPasswordChange(
  client: DatabaseClient,
  input: {
    actorType: "user" | "staff";
    actorUserId: string;
    clientAccountId: string;
    serviceId: string;
    body: CommandBody;
    config: Config;
  },
): Promise<PasswordChangeReplay | null> {
  const replay = await client.query<{
    service_id: string;
    client_account_id: string;
    request_fingerprint: string;
    secret_digest: string;
    secret_digest_key_version: number;
    result: PasswordChangeReplay;
  }>(
    `SELECT request.service_id, request.client_account_id,
            request.request_fingerprint, request.secret_digest,
            request.secret_digest_key_version,
            jsonb_build_object(
              'requestId', request.id,
              'serviceId', request.service_id,
              'action', request.action,
              'status', COALESCE(latest.status, 'queued'),
              'serviceVersion', request.expected_service_version,
              'resourceRevision', request.expected_resource_revision,
              'createdAt', request.created_at
            ) AS result
     FROM service_configuration_operation_requests request
     LEFT JOIN LATERAL (
       SELECT result.status
       FROM service_configuration_operation_result_facts result
       WHERE result.request_id = request.id
       ORDER BY result.revision DESC
       LIMIT 1
     ) latest ON true
     WHERE request.actor_type = $1
       AND request.actor_user_id = $2
       AND request.idempotency_key = $3`,
    [input.actorType, input.actorUserId, input.body.idempotencyKey],
  );
  const previous = replay.rows[0];
  if (!previous) return null;
  let digest: Readonly<{ digest: string; keyVersion: number }>;
  try {
    digest = digestIdentitySecret(
      input.body.newPassword,
      SECRET_PURPOSE,
      input.serviceId,
      identitySecretKeyring(input.config),
      previous.secret_digest_key_version,
    );
  } catch {
    throw requestError(
      "This idempotency key belongs to a password change encrypted with an unavailable key version",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
  const fingerprint = intentFingerprint(
    input.actorType,
    input.clientAccountId,
    input.serviceId,
    input.body,
    digest.digest,
    digest.keyVersion,
  );
  if (
    previous.request_fingerprint !== fingerprint ||
    previous.secret_digest !== digest.digest ||
    previous.service_id !== input.serviceId ||
    previous.client_account_id !== input.clientAccountId
  ) {
    throw requestError(
      "This idempotency key was already used for another service password change",
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  }
  return previous.result;
}

async function createPasswordChange(
  client: DatabaseClient,
  input: {
    actorType: "user" | "staff";
    actor: Pick<SessionIdentity, "userId" | "sessionId">;
    staffIdentity?: SessionIdentity;
    clientAccountId: string;
    serviceId: string;
    body: CommandBody;
    config: Config;
  },
): Promise<PasswordChangeReplay & { replayed: boolean }> {
  if (input.actorType === "staff") {
    if (!input.staffIdentity) throw new Error("Staff password change lacks Staff identity");
    await requireStaffActionLocked(client, input.staffIdentity, STAFF_PERMISSION);
  } else {
    await requireRecentReauthLocked(client, input.actor);
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `service-password-change-idempotency:${input.actorType}:${input.actor.userId}:${input.body.idempotencyKey}`,
  ]);
  const replay = await replayPasswordChange(client, {
    ...input,
    actorUserId: input.actor.userId,
  });
  if (replay) return { ...replay, replayed: true };

  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `service-configuration-operation:${input.serviceId}`,
  ]);
  const service = await lockService(client, input.serviceId, input.clientAccountId);
  assertServiceEligible(service, input.body);
  const unresolved = await client.query(
    `SELECT request.id
     FROM service_configuration_operation_requests request
     LEFT JOIN LATERAL (
       SELECT result.status
       FROM service_configuration_operation_result_facts result
       WHERE result.request_id = request.id
       ORDER BY result.revision DESC
       LIMIT 1
     ) latest ON true
     WHERE request.service_id = $1
       AND COALESCE(latest.status, 'queued') NOT IN ('succeeded', 'failed', 'manual')
     LIMIT 1`,
    [service.id],
  );
  if ((unresolved.rowCount ?? 0) > 0) {
    throw requestError(
      "Another service password change is still unresolved",
      409,
      "SERVICE_PASSWORD_CHANGE_IN_PROGRESS",
    );
  }

  const requestId = randomUUID();
  const providerOperationId = randomUUID();
  const keyring = identitySecretKeyring(input.config);
  const digest = digestIdentitySecret(
    input.body.newPassword,
    SECRET_PURPOSE,
    service.id,
    keyring,
  );
  const encrypted = encryptIdentitySecret(
    input.body.newPassword,
    SECRET_PURPOSE,
    requestId,
    keyring,
  );
  const fingerprint = intentFingerprint(
    input.actorType,
    input.clientAccountId,
    service.id,
    input.body,
    digest.digest,
    digest.keyVersion,
  );
  const createdAtResult = await client.query<{ created_at: Date }>(
    "SELECT pg_catalog.clock_timestamp() AS created_at",
  );
  const createdAt = createdAtResult.rows[0]?.created_at;
  if (!createdAt) throw new Error("Database clock did not return a password-change timestamp");
  const providerSnapshot = {
    atBinding: stringList(service.binding_capabilities),
    current: stringList(service.current_capabilities),
    currentVersion: service.provider_version,
  };

  await client.query(
    `INSERT INTO service_configuration_operation_requests(
       id, service_id, client_account_id, actor_type, actor_user_id,
       actor_session_id, action, expected_service_version,
       expected_resource_revision, provider_installation_id,
       provider_capability_snapshot, reason, secret_digest,
       secret_digest_key_version, idempotency_key, request_fingerprint, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'change_password', $7, $8,
       $9, $10, $11, $12, $13, $14, $15, $16
     )`,
    [
      requestId,
      service.id,
      input.clientAccountId,
      input.actorType,
      input.actor.userId,
      input.actor.sessionId,
      service.version,
      service.resource_revision,
      service.provider_installation_id,
      providerSnapshot,
      input.actorType === "staff" ? input.body.reason : null,
      digest.digest,
      digest.keyVersion,
      input.body.idempotencyKey,
      fingerprint,
      createdAt,
    ],
  );
  await client.query(
    `INSERT INTO service_configuration_secret_envelopes(
       request_id, ciphertext, key_version, created_at
     ) VALUES ($1, $2, $3, $4)`,
    [requestId, encrypted.ciphertext, encrypted.keyVersion, createdAt],
  );
  await client.query(
    `INSERT INTO provider_operations(
       id, provider_installation_id, kind, subject_type, subject_id,
       stable_key, status
     ) VALUES (
       $1, $2, 'resource.change_password', 'service_configuration_operation',
       $3, $4, 'queued'
     )`,
    [
      providerOperationId,
      service.provider_installation_id,
      requestId,
      `service-password-change:${requestId}`,
    ],
  );
  await client.query(
    `INSERT INTO durable_jobs(job_type, unique_key, payload)
     VALUES ('service.password_change.start', $1, $2)`,
    [
      `service-password-change:${requestId}:start`,
      { requestId, serviceId: service.id, providerOperationId },
    ],
  );
  await client.query(
    `INSERT INTO audit_events(
       actor_type, actor_id, action, target_type, target_id, reason, metadata
     ) VALUES ($1, $2, 'service.password_change_requested', 'service', $3, $4, $5)`,
    [
      input.actorType,
      input.actor.userId,
      service.id,
      input.body.reason ?? "Password change requested from the customer service workspace",
      {
        requestId,
        providerOperationId,
        expectedServiceVersion: service.version,
        expectedResourceRevision: service.resource_revision,
      },
    ],
  );

  return {
    requestId,
    serviceId: service.id,
    action: "change_password",
    status: "queued",
    serviceVersion: service.version,
    resourceRevision: service.resource_revision,
    createdAt: createdAt.toISOString(),
    replayed: false,
  };
}

async function listPasswordChanges(
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
    provider_installation_id: string | null;
    provider_enabled: boolean | null;
    binding_capabilities: unknown;
    current_capabilities: unknown;
  }>(
    `SELECT service.id, service.status, service.version, item.product_name,
            COALESCE(resource.resource_revision, 0) AS resource_revision,
            binding.provider_installation_id,
            provider.enabled AS provider_enabled,
            binding.capability_snapshot AS binding_capabilities,
            provider.capabilities AS current_capabilities
     FROM services service
     JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN service_provider_bindings binding ON binding.service_id = service.id
     LEFT JOIN provider_installation_capabilities provider
       ON provider.provider_installation_id = binding.provider_installation_id
     LEFT JOIN LATERAL (
       SELECT fact.resource_revision
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
    actor_type: "user" | "staff";
    reason: string | null;
    created_at: Date;
    latest_status: string | null;
    latest_revision: number | null;
    latest_detail: string | null;
    latest_error_code: string | null;
    latest_created_at: Date | null;
  }>(
    `SELECT request.id AS request_id, request.actor_type, request.reason,
            request.created_at, latest.status AS latest_status,
            latest.revision AS latest_revision, latest.detail AS latest_detail,
            latest.error_code AS latest_error_code,
            latest.created_at AS latest_created_at
     FROM service_configuration_operation_requests request
     LEFT JOIN LATERAL (
       SELECT result.status, result.revision, result.detail,
              result.error_code, result.created_at
       FROM service_configuration_operation_result_facts result
       WHERE result.request_id = request.id
       ORDER BY result.revision DESC
       LIMIT 1
     ) latest ON true
     WHERE request.service_id = $1 AND request.client_account_id = $2
     ORDER BY request.created_at DESC, request.id DESC
     LIMIT 20`,
    [serviceId, clientAccountId],
  );
  const unresolved = operations.rows.some(
    (row) => !["succeeded", "failed", "manual"].includes(row.latest_status ?? "queued"),
  );
  const binding = stringList(service.binding_capabilities);
  const current = stringList(service.current_capabilities);
  const canChangePassword =
    service.status === "active" &&
    !unresolved &&
    service.provider_installation_id === MOCK_PROVISIONING_INSTALLATION_ID &&
    service.provider_enabled === true &&
    binding.includes(REQUIRED_CAPABILITY) &&
    current.includes(REQUIRED_CAPABILITY);
  return {
    warning: LAB_WARNING,
    service: {
      id: service.id,
      productName: service.product_name,
      status: service.status,
      version: service.version,
      resourceRevision: service.resource_revision,
      canChangePassword,
    },
    items: operations.rows.map((row) => {
      const shared = {
        requestId: row.request_id,
        action: "change_password" as const,
        status: row.latest_status ?? "queued",
        revision: row.latest_revision ?? 0,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.latest_created_at?.toISOString() ?? row.created_at.toISOString(),
      };
      return audience === "customer"
        ? shared
        : {
            ...shared,
            actorType: row.actor_type,
            reason: row.reason,
            detail: row.latest_detail,
            errorCode: row.latest_error_code,
          };
    }),
  };
}

export async function registerServicePasswordChangeRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/services/:serviceId/password-changes", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertCustomerCapability(user, "account.history.read");
    const params = z.object({ serviceId: z.uuid() }).parse(request.params);
    const result = await listPasswordChanges(
      pool,
      params.serviceId,
      user.clientAccountId,
      "customer",
    );
    setAccountContextHeaders(reply, user);
    return result;
  });

  app.post("/api/v1/services/:serviceId/password-changes", async (request, reply) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
    assertCustomerCapability(user, "services.manage");
    const contextVersion = expectedAccountContextVersion(request);
    const params = z.object({ serviceId: z.uuid() }).parse(request.params);
    const body = customerCommand.parse(request.body);
    assertSecretIsNotCopiedIntoDurableFields(body);
    await requireRecentReauth(pool, user);
    const outcome = await transaction(pool, async (client) => {
      const session = await lockSessionContextForMutation(client, user, contextVersion);
      const context = await lockMembershipAccountForMutation(client, user, session);
      assertCustomerContext(context);
      return createPasswordChange(client, {
        actorType: "user",
        actor: user,
        clientAccountId: user.clientAccountId,
        serviceId: params.serviceId,
        body,
        config,
      });
    });
    setAccountContextHeaders(reply, user);
    return reply.code(outcome.replayed ? 200 : 201).send(outcome);
  });

  app.get(
    "/api/v1/admin/client-accounts/:clientAccountId/services/:serviceId/password-changes",
    async (request) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, "services.read");
      const params = z
        .object({ clientAccountId: z.uuid(), serviceId: z.uuid() })
        .parse(request.params);
      return listPasswordChanges(pool, params.serviceId, params.clientAccountId, "staff");
    },
  );

  app.post(
    "/api/v1/admin/client-accounts/:clientAccountId/services/:serviceId/password-changes",
    async (request, reply) => {
      const user = await requireSessionIdentity(request, pool, config);
      await requireStaffPermission(pool, user, STAFF_PERMISSION);
      const params = z
        .object({ clientAccountId: z.uuid(), serviceId: z.uuid() })
        .parse(request.params);
      const body = staffCommand.parse(request.body);
      assertSecretIsNotCopiedIntoDurableFields(body);
      await requireRecentReauth(pool, user);
      const outcome = await transaction(pool, async (client) =>
        createPasswordChange(client, {
          actorType: "staff",
          actor: user,
          staffIdentity: user,
          clientAccountId: params.clientAccountId,
          serviceId: params.serviceId,
          body,
          config,
        }),
      );
      return reply.code(outcome.replayed ? 200 : 201).send(outcome);
    },
  );
}
