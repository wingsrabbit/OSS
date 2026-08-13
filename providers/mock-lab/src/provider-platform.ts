// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
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

export interface ProviderPlatformConfig {
  publicBaseUrl: string;
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
  `);

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
    const fingerprint = `${await providerRequestFingerprint(body)}:${scenario}`;
    const client = await pool.connect();
    let operation: StoredOperation | undefined;
    let replayed = false;
    try {
      await client.query("BEGIN");
      const existing = await client.query<StoredOperation>(
        `SELECT operation_id, capability, request_fingerprint, scenario,
                result_json, final_result_json
         FROM mock_contract_operations
         WHERE operation_id = $1
         FOR UPDATE`,
        [body.operationId],
      );
      operation = existing.rows[0];
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
            JSON.stringify(body),
            fingerprint,
            scenario,
            JSON.stringify(initialResult),
            JSON.stringify(finalResult),
          ],
        );
        operation = inserted.rows[0];
        if (!operation) throw new Error("Mock Provider operation insert returned no row");

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
