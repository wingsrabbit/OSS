// SPDX-License-Identifier: Apache-2.0

import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  capabilityOperations,
  parseProviderEvent,
  parseProviderManifest,
  parseProviderOperationRequest,
  parseProviderOperationResult,
  providerCapabilities,
  type AntiAbuseChallengeInput,
  type MailInput,
  type PaymentInput,
  type ProviderCapability,
  type ProviderEvent,
  type ProviderManifest,
  type ProviderOperationOutput,
  type ProviderOperationRequest,
  type ProviderOperationResult,
  type ProvisioningInput,
  type TaxInput,
  type VerificationInput,
} from "@opensales/provider-contracts";
import { providerRequestFingerprint } from "@opensales/provider-sdk-typescript";
import { z } from "zod";

export const mockProviderScenarios = [
  "normal",
  "failure",
  "duplicate",
  "out_of_order",
  "timeout",
  "restart",
] as const;

export type MockProviderScenario = (typeof mockProviderScenarios)[number];

const requestFingerprintKeyPattern = /^[A-Za-z0-9_-]{43}$/u;
const passwordRequestFingerprintPattern = /^password-hmac-sha256-v1:([1-9]\d*):[0-9a-f]{64}$/u;

export interface ProviderRequestFingerprintKeyring {
  activeVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

function decodeRequestFingerprintKey(value: string): Buffer {
  if (!requestFingerprintKeyPattern.test(value)) {
    throw new Error("Mock Provider request fingerprint keys must be canonical 32-byte base64url values");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("Mock Provider request fingerprint keys must be canonical 32-byte base64url values");
  }
  return decoded;
}

export function createProviderRequestFingerprintKeyring(
  activeVersion: number,
  activeKey: string,
  previousKeys = "",
): ProviderRequestFingerprintKeyring {
  if (!Number.isSafeInteger(activeVersion) || activeVersion < 1) {
    throw new Error("Mock Provider request fingerprint key version must be a positive safe integer");
  }
  const keys = new Map<number, Buffer>([[activeVersion, decodeRequestFingerprintKey(activeKey)]]);
  const materials = new Set([activeKey]);
  const previousEntries = previousKeys === "" ? [] : previousKeys.split(",");
  if (previousEntries.length > 31) {
    throw new Error("Mock Provider request fingerprint keyring supports at most 32 lifetime versions");
  }
  for (const entry of previousEntries) {
    const separator = entry.indexOf(":");
    const versionText = separator === -1 ? "" : entry.slice(0, separator);
    const keyText = separator === -1 ? "" : entry.slice(separator + 1);
    if (!/^[1-9]\d*$/u.test(versionText)) {
      throw new Error("Mock Provider previous request fingerprint keys must use version:key entries");
    }
    const version = Number(versionText);
    if (!Number.isSafeInteger(version) || version >= activeVersion || keys.has(version)) {
      throw new Error("Mock Provider previous request fingerprint key versions must be unique and older than active");
    }
    if (materials.has(keyText)) {
      throw new Error("Mock Provider request fingerprint key material must be unique across versions");
    }
    keys.set(version, decodeRequestFingerprintKey(keyText));
    materials.add(keyText);
  }
  return { activeVersion, keys };
}

export function passwordRequestFingerprintKeyVersion(fingerprint: string): number | undefined {
  const match = passwordRequestFingerprintPattern.exec(fingerprint);
  if (!match?.[1]) return undefined;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : undefined;
}

const operationParamsSchema = z.object({
  capability: z.enum(providerCapabilities),
  operationId: z.uuid(),
});

const capabilityParamsSchema = z.object({ capability: z.enum(providerCapabilities) });
const eventQuerySchema = z.object({ operationId: z.uuid() });
const scenarioSchema = z.enum(mockProviderScenarios);

interface StoredOperation {
  operation_id: string;
  capability: ProviderCapability;
  request_fingerprint: string;
  scenario: MockProviderScenario;
  result_json: ProviderOperationResult;
  final_result_json: ProviderOperationResult;
}

interface StoredEvent {
  event_json: ProviderEvent;
}

interface PasswordChangeStorageRow {
  operation_id: string;
  request_json: unknown;
  request_fingerprint: string;
  scenario: MockProviderScenario;
}

function passwordChangeRequest(
  request: ProviderOperationRequest,
): request is ProviderOperationRequest & {
  capability: "provisioning";
  action: "resource.change_password";
} {
  return request.capability === "provisioning" && request.action === "resource.change_password";
}

export function redactedStoredRequest(request: ProviderOperationRequest): ProviderOperationRequest {
  if (!passwordChangeRequest(request)) return request;
  const configuration = request.input.configuration;
  if (
    !configuration ||
    Object.keys(configuration).length !== 1 ||
    !Object.hasOwn(configuration, "password")
  ) {
    throw new Error("Mock password change requires exactly one transient password field");
  }
  const password = configuration?.password;
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new Error("Mock password change requires a valid transient password");
  }
  return {
    ...request,
    input: {
      ...request.input,
      configuration: {
        password: "[REDACTED]",
      },
    },
  };
}

function storedPasswordValue(requestJson: unknown): unknown {
  if (!requestJson || typeof requestJson !== "object" || Array.isArray(requestJson)) return undefined;
  const input = (requestJson as Record<string, unknown>).input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const configuration = (input as Record<string, unknown>).configuration;
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return undefined;
  }
  return (configuration as Record<string, unknown>).password;
}

function requestJsonWithPassword(requestJson: unknown, password: string): unknown {
  const root = requestJson as Record<string, unknown>;
  const input = root.input as Record<string, unknown>;
  const configuration = input.configuration as Record<string, unknown>;
  return {
    ...root,
    input: {
      ...input,
      configuration: { ...configuration, password },
    },
  };
}

function parseStoredPasswordChangeRequest(requestJson: unknown): ProviderOperationRequest & {
  capability: "provisioning";
  action: "resource.change_password";
} {
  let request: ProviderOperationRequest;
  try {
    request = parseProviderOperationRequest(requestJson);
  } catch {
    throw new Error("Mock Provider legacy password-change request cannot be upgraded safely");
  }
  if (!passwordChangeRequest(request)) {
    throw new Error("Mock Provider legacy password-change request cannot be upgraded safely");
  }
  return request;
}

export async function upgradeLegacyPasswordChangeRequest(
  requestJson: unknown,
  scenario: MockProviderScenario,
  requestFingerprintKeyring: ProviderRequestFingerprintKeyring,
): Promise<
  | Readonly<{ requestJson: ProviderOperationRequest; requestFingerprint: string }>
  | undefined
> {
  const password = storedPasswordValue(requestJson);
  if (password === "[REDACTED]") {
    const request = parseStoredPasswordChangeRequest(
      requestJsonWithPassword(requestJson, "R".repeat(20)),
    );
    try {
      redactedStoredRequest(request);
    } catch {
      throw new Error("Mock Provider legacy password-change request cannot be upgraded safely");
    }
    return undefined;
  }
  if (typeof password !== "string") {
    throw new Error("Mock Provider legacy password-change request cannot be upgraded safely");
  }
  const request = parseStoredPasswordChangeRequest(requestJson);
  try {
    return {
      requestJson: redactedStoredRequest(request),
      requestFingerprint: await providerPersistenceFingerprint(
        request,
        scenario,
        requestFingerprintKeyring,
      ),
    };
  } catch {
    throw new Error("Mock Provider legacy password-change request cannot be upgraded safely");
  }
}

export interface ProviderPlatformConfig {
  publicBaseUrl: string;
  authoritativeProvisioningResources?: boolean;
  requestFingerprintKeyring: ProviderRequestFingerprintKeyring;
}

export async function providerPersistenceFingerprint(
  request: ProviderOperationRequest,
  scenario: MockProviderScenario,
  requestFingerprintKeyring: ProviderRequestFingerprintKeyring,
  keyVersion = requestFingerprintKeyring.activeVersion,
): Promise<string> {
  const storedRequest = redactedStoredRequest(request);
  const redactedFingerprint = await providerRequestFingerprint(storedRequest);
  if (!passwordChangeRequest(request)) return `${redactedFingerprint}:${scenario}`;

  const requestFingerprintKey = requestFingerprintKeyring.keys.get(keyVersion);
  if (!requestFingerprintKey) {
    throw new Error("Mock Provider stored request fingerprint key version is unavailable");
  }
  const password = request.input.configuration?.password;
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new Error("Mock password change requires a valid transient password");
  }
  return `password-hmac-sha256-v1:${keyVersion}:${createHmac("sha256", requestFingerprintKey)
    .update("opensales-mock-provider-password-request:v1\0", "utf8")
    .update(redactedFingerprint, "utf8")
    .update("\0", "utf8")
    .update(scenario, "utf8")
    .update("\0", "utf8")
    .update(password, "utf8")
    .digest("hex")}`;
}

function succeededOutput(request: ProviderOperationRequest): ProviderOperationOutput {
  switch (request.capability) {
    case "payment": {
      const input: PaymentInput = request.input;
      return {
        externalPaymentRef: input.externalPaymentRef ?? `mock-payment-${request.operationId}`,
        paymentState: request.action === "payment.refund" ? "refunded" : request.action === "payment.authorize" ? "authorized" : "captured",
        amountMinor: input.amountMinor,
        currency: input.currency,
      };
    }
    case "provisioning": {
      const input: ProvisioningInput = request.input;
      const resourceState = request.action === "resource.terminate"
        ? "terminated"
        : request.action === "resource.stop"
          ? "stopped"
          : "ready";
      return {
        externalResourceRef: input.externalResourceRef ?? `mock-resource-${request.operationId}`,
        resourceState,
        ...(resourceState === "ready" ? { readyAt: new Date().toISOString() } : {}),
      };
    }
    case "mail": {
      const _input: MailInput = request.input;
      return {
        externalDeliveryRef: `mock-delivery-${request.operationId}`,
        deliveryState: "delivered",
      };
    }
    case "verification": {
      const input: VerificationInput = request.input;
      return {
        externalEvidenceRef: `mock-evidence-${request.operationId}`,
        verdict: input.purpose === "manual_review" ? "manual_review" : "verified",
        assurance: input.checks.includes("identity") ? "high" : "medium",
        checked: input.checks,
      };
    }
    case "tax": {
      const input: TaxInput = request.input;
      const lines = input.lines.map((line) => ({
        lineRef: line.lineRef,
        taxMinor: ((BigInt(line.amountMinor) * 500n + 5_000n) / 10_000n).toString(),
        rateBasisPoints: 500,
      }));
      return {
        externalQuoteRef: `mock-tax-${request.operationId}`,
        currency: input.currency,
        totalTaxMinor: lines.reduce((total, line) => total + BigInt(line.taxMinor), 0n).toString(),
        lines,
      };
    }
    case "anti_abuse_challenge": {
      const input: AntiAbuseChallengeInput = request.input;
      const requestedDecision = input.signals.syntheticDecision;
      const decision = requestedDecision === "deny"
        ? "deny"
        : requestedDecision === "challenge"
          ? "challenge"
          : "allow";
      return {
        externalDecisionRef: `mock-decision-${request.operationId}`,
        decision,
        ...(decision === "challenge"
          ? {
              challengeRef: `mock-challenge-${request.operationId}`,
              challengeState: "pending" as const,
            }
          : {}),
      };
    }
  }
}

export function createMockProviderOperationResult(
  request: ProviderOperationRequest,
  status: "pending" | "succeeded" | "failed",
  revision: number,
  observedAt: string,
): ProviderOperationResult {
  const base = {
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    capability: request.capability,
    operationId: request.operationId,
    status,
    revision,
    observedAt,
  } as const;
  if (status === "succeeded") {
    return parseProviderOperationResult({ ...base, output: succeededOutput(request) });
  }
  if (status === "failed") {
    return parseProviderOperationResult({
      ...base,
      error: {
        code: "mock.functional_failure",
        message: "Synthetic functional failure requested by the Mock Lab scenario header.",
        retryable: false,
      },
    });
  }
  return parseProviderOperationResult(base);
}

function providerEvent(
  providerId: string,
  result: ProviderOperationResult,
  sequence: number,
  eventId = randomUUID(),
): ProviderEvent {
  return parseProviderEvent({
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    eventId,
    providerId,
    capability: result.capability,
    operationId: result.operationId,
    sequence,
    eventType: `operation.${result.status}`,
    observedAt: result.observedAt,
    result,
  });
}

export function createMockProviderManifest(publicBaseUrl: string): ProviderManifest {
  return parseProviderManifest({
    manifestVersion: "v1",
    providerId: "opensales.mock-lab.all-six",
    displayName: "OpenSales six-capability functional Mock Lab",
    description: "Payment, Provisioning, Mail, Verification, Tax, and Anti-abuse Challenge mocks for synthetic product and reliability testing only.",
    endpointBaseUrl: publicBaseUrl,
    publisher: {
      name: "OpenSales System contributors",
      website: "https://github.com/wingsrabbit/OSS",
      supportUrl: "https://github.com/wingsrabbit/OSS/issues",
    },
    license: {
      identifier: "Apache-2.0",
      url: "https://www.apache.org/licenses/LICENSE-2.0",
    },
    capabilities: providerCapabilities.map((capability) => ({
      capability,
      contractVersion: PROVIDER_CONTRACT_VERSION,
      operations: [...capabilityOperations[capability]],
      eventSubscriptions: [`core.${capability}.requested`],
    })),
    permissions: {
      scopes: providerCapabilities.map((capability) => `${capability}.operate`),
      dataFields: [
        "opaque_subject_ref",
        "minor_units_and_currency",
        "synthetic_mail_recipient",
        "synthetic_resource_configuration",
        "synthetic_tax_jurisdiction",
        "synthetic_challenge_signals",
      ],
      secrets: [
        {
          name: "MOCK_PROVIDER_PLATFORM_TOKEN",
          purpose: "Bearer credential for the functional Mock Provider process boundary",
          required: true,
          rotation: "required",
        },
      ],
    },
    limits: {
      maxConcurrentOperations: 32,
      maxAmountMinor: "100000000",
      maxOwnedResources: 10_000,
    },
    retention: { operationDays: 30, eventDays: 30, piiDays: 7 },
    lifecycle: {
      supportsPause: true,
      supportsCredentialRotation: true,
      supportsManualTakeover: true,
      uninstallRequiresNoUnknownOperations: true,
      uninstallRequiresNoOwnedResources: true,
      uninstallRequiresNoPendingFunds: true,
    },
  });
}

export async function registerProviderPlatformRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ProviderPlatformConfig,
): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mock_contract_operations (
      operation_id uuid PRIMARY KEY,
      capability text NOT NULL CHECK (
        capability IN ('payment', 'provisioning', 'mail', 'verification', 'tax', 'anti_abuse_challenge')
      ),
      action text NOT NULL,
      request_json jsonb NOT NULL,
      request_fingerprint text NOT NULL,
      scenario text NOT NULL CHECK (
        scenario IN ('normal', 'failure', 'duplicate', 'out_of_order', 'timeout', 'restart')
      ),
      result_json jsonb NOT NULL,
      final_result_json jsonb NOT NULL,
      create_calls integer NOT NULL DEFAULT 1 CHECK (create_calls > 0),
      reconcile_calls integer NOT NULL DEFAULT 0 CHECK (reconcile_calls >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mock_contract_events (
      event_row_id bigserial PRIMARY KEY,
      operation_id uuid NOT NULL REFERENCES mock_contract_operations(operation_id),
      response_order integer NOT NULL CHECK (response_order > 0),
      event_json jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS mock_contract_events_operation_order_idx
      ON mock_contract_events (operation_id, response_order, event_row_id);
    CREATE TABLE IF NOT EXISTS mock_contract_resource_states (
      external_resource_ref text PRIMARY KEY,
      resource_state text NOT NULL CHECK (resource_state IN ('ready', 'stopped', 'terminated')),
      revision integer NOT NULL CHECK (revision > 0),
      last_action text NOT NULL,
      last_operation_id uuid NOT NULL UNIQUE REFERENCES mock_contract_operations(operation_id),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mock_contract_password_change_facts (
      operation_id uuid PRIMARY KEY REFERENCES mock_contract_operations(operation_id),
      service_ref text NOT NULL,
      external_resource_ref text NOT NULL,
      changed_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const storageClient = await pool.connect();
  try {
    await storageClient.query("BEGIN");
    await storageClient.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('mock-provider-platform-storage-v1', 0))",
    );
    const passwordRows = await storageClient.query<PasswordChangeStorageRow>(`
      SELECT operation_id, request_json, request_fingerprint, scenario
      FROM mock_contract_operations
      WHERE capability = 'provisioning'
        AND action = 'resource.change_password'
      ORDER BY operation_id
      FOR UPDATE
    `);
    for (const row of passwordRows.rows) {
      const upgraded = await upgradeLegacyPasswordChangeRequest(
        row.request_json,
        row.scenario,
        config.requestFingerprintKeyring,
      );
      if (upgraded) {
        await storageClient.query(
          `UPDATE mock_contract_operations
           SET request_json = $2::jsonb,
               request_fingerprint = $3,
               updated_at = now()
           WHERE operation_id = $1`,
          [
            row.operation_id,
            JSON.stringify(upgraded.requestJson),
            upgraded.requestFingerprint,
          ],
        );
        continue;
      }
      const keyVersion = passwordRequestFingerprintKeyVersion(row.request_fingerprint);
      if (keyVersion === undefined || !config.requestFingerprintKeyring.keys.has(keyVersion)) {
        throw new Error(
          `Mock Provider stored password-change fingerprint for operation ${row.operation_id} cannot be verified`,
        );
      }
    }
    await storageClient.query("COMMIT");
  } catch (error) {
    try {
      await storageClient.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Mock Provider password-change storage upgrade and rollback both failed",
      );
    }
    throw error;
  } finally {
    storageClient.release();
  }

  const manifest = createMockProviderManifest(config.publicBaseUrl);

  app.get("/v1/manifest", async () => manifest);

  app.post("/v1alpha1/:capability/operations", async (request, reply) => {
    const params = capabilityParamsSchema.parse(request.params);
    const body = parseProviderOperationRequest(request.body);
    if (params.capability !== body.capability) {
      return reply.code(400).send({ error: "path capability does not match the operation body" });
    }
    if (request.headers["idempotency-key"] !== body.operationId) {
      return reply.code(400).send({ error: "Idempotency-Key must equal body.operationId" });
    }
    const scenario = scenarioSchema.parse(request.headers["x-oss-lab-scenario"] ?? "normal");
    let storedRequest: ProviderOperationRequest;
    try {
      storedRequest = redactedStoredRequest(body);
    } catch {
      return reply.code(400).send({
        error: "resource.change_password requires exactly one valid transient password field",
      });
    }
    const client = await pool.connect();
    let operation: StoredOperation | undefined;
    let replayed = false;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`mock-contract-operation:${body.operationId}`],
      );
      const existing = await client.query<StoredOperation>(
        `SELECT operation_id, capability, request_fingerprint, scenario,
                result_json, final_result_json
         FROM mock_contract_operations
         WHERE operation_id = $1
         FOR UPDATE`,
        [body.operationId],
      );
      operation = existing.rows[0];
      const storedPasswordKeyVersion = operation && passwordChangeRequest(body)
        ? passwordRequestFingerprintKeyVersion(operation.request_fingerprint)
        : undefined;
      if (
        storedPasswordKeyVersion !== undefined &&
        !config.requestFingerprintKeyring.keys.has(storedPasswordKeyVersion)
      ) {
        await client.query("ROLLBACK");
        return reply.code(503).send({
          error: "stored request fingerprint key version is unavailable",
        });
      }
      const fingerprint = await providerPersistenceFingerprint(
        body,
        scenario,
        config.requestFingerprintKeyring,
        storedPasswordKeyVersion ?? config.requestFingerprintKeyring.activeVersion,
      );
      if (operation) {
        if (operation.request_fingerprint !== fingerprint) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: "idempotency key was reused with a different request or Mock scenario",
          });
        }
        const repeated = await client.query<StoredOperation>(
          `UPDATE mock_contract_operations
           SET create_calls = create_calls + 1,
               updated_at = now()
           WHERE operation_id = $1
           RETURNING operation_id, capability, request_fingerprint, scenario,
                     result_json, final_result_json`,
          [body.operationId],
        );
        operation = repeated.rows[0];
        replayed = true;
      } else {
        let authoritativeResource:
          | {
              service_id: string;
              external_resource_id: string;
              resource_state: "active" | "suspended" | "terminated";
              power_state: "running" | "stopped" | "terminated";
              desired_power_state: "running" | "stopped" | "terminated";
            }
          | undefined;
        if (
          config.authoritativeProvisioningResources === true &&
          body.capability === "provisioning" &&
          ["resource.start", "resource.stop", "resource.reboot", "resource.change_password"].includes(body.action)
        ) {
          const input: ProvisioningInput = body.input;
          if (!input.externalResourceRef) {
            await client.query("ROLLBACK");
            return reply.code(400).send({ error: "daily resource operation requires externalResourceRef" });
          }
          const resource = await client.query<{
            service_id: string;
            external_resource_id: string;
            resource_state: "active" | "suspended" | "terminated";
            power_state: "running" | "stopped" | "terminated";
            desired_power_state: "running" | "stopped" | "terminated";
          }>(
            `SELECT service_id::text, external_resource_id, resource_state,
                    power_state, desired_power_state
             FROM mock_resource_operations
             WHERE service_id::text = $1
               AND external_resource_id = $2
               AND status = 'succeeded'
             FOR UPDATE`,
            [input.serviceRef, input.externalResourceRef],
          );
          authoritativeResource = resource.rows[0];
          if (!authoritativeResource) {
            await client.query("ROLLBACK");
            return reply.code(404).send({ error: "authoritative Mock resource not found" });
          }
          const eligible = authoritativeResource.resource_state === "active" && (
            body.action === "resource.change_password"
              ? true
              : body.action === "resource.start"
                ? authoritativeResource.power_state === "stopped"
                : authoritativeResource.power_state === "running"
          );
          if (!eligible) {
            await client.query("ROLLBACK");
            return reply.code(409).send({
              error: `resource is ${authoritativeResource.resource_state}/${authoritativeResource.power_state}; ${body.action} is not allowed`,
            });
          }
        }
        const observedAt = new Date().toISOString();
        const finalResult = createMockProviderOperationResult(
          body,
          scenario === "failure" ? "failed" : "succeeded",
          scenario === "out_of_order" || scenario === "restart" ? 2 : 1,
          observedAt,
        );
        const initialResult = scenario === "restart"
          ? createMockProviderOperationResult(body, "pending", 1, observedAt)
          : finalResult;
        const inserted = await client.query<StoredOperation>(
          `INSERT INTO mock_contract_operations(
             operation_id, capability, action, request_json, request_fingerprint,
             scenario, result_json, final_result_json
           ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb)
           RETURNING operation_id, capability, request_fingerprint, scenario,
                     result_json, final_result_json`,
          [
            body.operationId,
            body.capability,
            body.action,
            JSON.stringify(storedRequest),
            fingerprint,
            scenario,
            JSON.stringify(initialResult),
            JSON.stringify(finalResult),
          ],
        );
        operation = inserted.rows[0];
        if (!operation) throw new Error("Mock Provider operation insert returned no row");

        if (
          body.capability === "provisioning" &&
          body.action === "resource.change_password" &&
          finalResult.status === "succeeded"
        ) {
          const input: ProvisioningInput = body.input;
          if (!input.externalResourceRef) {
            throw new Error("Mock password change lost its external resource binding");
          }
          await client.query(
            `INSERT INTO mock_contract_password_change_facts(
               operation_id, service_ref, external_resource_ref, changed_at
             ) VALUES ($1, $2, $3, $4)`,
            [body.operationId, input.serviceRef, input.externalResourceRef, finalResult.observedAt],
          );
        }

        if (
          authoritativeResource &&
          finalResult.status === "succeeded" &&
          body.action !== "resource.change_password"
        ) {
          await client.query(
            `UPDATE mock_resource_operations
             SET power_state = $3,
                 desired_power_state = $3
             WHERE service_id::text = $1
               AND external_resource_id = $2`,
            [
              authoritativeResource.service_id,
              authoritativeResource.external_resource_id,
              body.action === "resource.stop" ? "stopped" : "running",
            ],
          );
        } else if (
          config.authoritativeProvisioningResources !== true &&
          body.capability === "provisioning" &&
          finalResult.status === "succeeded" &&
          [
            "resource.create",
            "resource.start",
            "resource.stop",
            "resource.reboot",
            "resource.change_password",
            "resource.terminate",
          ].includes(body.action) &&
          body.action !== "resource.change_password"
        ) {
          const output = finalResult.output as {
            externalResourceRef: string;
            resourceState: "ready" | "stopped" | "terminated";
          };
          await client.query(
            `INSERT INTO mock_contract_resource_states(
               external_resource_ref, resource_state, revision,
               last_action, last_operation_id
             ) VALUES ($1, $2, 1, $3, $4)
             ON CONFLICT (external_resource_ref) DO UPDATE
               SET resource_state = EXCLUDED.resource_state,
                   revision = mock_contract_resource_states.revision + 1,
                   last_action = EXCLUDED.last_action,
                   last_operation_id = EXCLUDED.last_operation_id,
                   updated_at = now()`,
            [output.externalResourceRef, output.resourceState, body.action, body.operationId],
          );
        }

        const finalEvent = providerEvent(manifest.providerId, finalResult, finalResult.revision);
        const events: ProviderEvent[] = scenario === "out_of_order"
          ? [
              finalEvent,
              providerEvent(
                manifest.providerId,
                createMockProviderOperationResult(
                  body,
                  "pending",
                  1,
                  new Date(Date.parse(observedAt) - 1_000).toISOString(),
                ),
                1,
              ),
            ]
          : scenario === "duplicate"
            ? [finalEvent, finalEvent]
            : scenario === "restart"
              ? [providerEvent(manifest.providerId, initialResult, 1)]
              : [finalEvent];
        for (const [index, event] of events.entries()) {
          await client.query(
            `INSERT INTO mock_contract_events(operation_id, response_order, event_json)
             VALUES ($1, $2, $3::jsonb)`,
            [body.operationId, index + 1, JSON.stringify(event)],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!operation) throw new Error("Mock Provider operation was not recorded");
    if (scenario === "timeout") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return reply.code(504).send({
        error: "synthetic timeout after the Provider persisted its result; reconcile by operationId",
      });
    }
    reply.header("x-oss-idempotent-replay", replayed ? "true" : "false");
    return reply.code(202).send(parseProviderOperationResult(operation.result_json));
  });

  app.get("/v1alpha1/:capability/operations/:operationId", async (request, reply) => {
    const params = operationParamsSchema.parse(request.params);
    const client = await pool.connect();
    let result: ProviderOperationResult | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`mock-contract-operation:${params.operationId}`],
      );
      const selected = await client.query<StoredOperation>(
        `SELECT operation_id, capability, request_fingerprint, scenario,
                result_json, final_result_json
         FROM mock_contract_operations
         WHERE operation_id = $1
         FOR UPDATE`,
        [params.operationId],
      );
      const operation = selected.rows[0];
      if (!operation || operation.capability !== params.capability) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "operation not found" });
      }
      result = operation.result_json;
      if (operation.scenario === "restart" && result.status === "pending") {
        result = operation.final_result_json;
        await client.query(
          `UPDATE mock_contract_operations
           SET result_json = $2::jsonb,
               reconcile_calls = reconcile_calls + 1,
               updated_at = now()
           WHERE operation_id = $1`,
          [params.operationId, JSON.stringify(result)],
        );
        const event = providerEvent(manifest.providerId, result, result.revision);
        await client.query(
          `INSERT INTO mock_contract_events(operation_id, response_order, event_json)
           SELECT $1, COALESCE(max(response_order), 0) + 1, $2::jsonb
           FROM mock_contract_events
           WHERE operation_id = $1`,
          [params.operationId, JSON.stringify(event)],
        );
      } else {
        await client.query(
          `UPDATE mock_contract_operations
           SET reconcile_calls = reconcile_calls + 1,
               updated_at = now()
           WHERE operation_id = $1`,
          [params.operationId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!result) throw new Error("Mock Provider reconciliation returned no result");
    return parseProviderOperationResult(result);
  });

  app.get("/v1/events", async (request, reply) => {
    const query = eventQuerySchema.parse(request.query);
    const events = await pool.query<StoredEvent>(
      `SELECT event_json
       FROM mock_contract_events
       WHERE operation_id = $1
       ORDER BY response_order, event_row_id`,
      [query.operationId],
    );
    if (events.rows.length === 0) {
      const operation = await pool.query(
        `SELECT 1 FROM mock_contract_operations WHERE operation_id = $1`,
        [query.operationId],
      );
      if (operation.rowCount === 0) return reply.code(404).send({ error: "operation not found" });
    }
    return {
      events: events.rows.map(({ event_json }) => parseProviderEvent(event_json)),
      nextCursor: null,
    };
  });
}
