// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  capabilityOperations,
  parseProviderEvent,
  parseProviderManifest,
  parseProviderOperationResult,
  providerCapabilities,
  type ProviderEvent,
  type ProviderManifest,
  type ProviderOperationOutput,
  type ProviderOperationRequest,
  type ProviderOperationResult,
} from "@opensales/provider-contracts";
import { providerRequestFingerprint } from "@opensales/provider-sdk-typescript";

export interface StoredExampleOperation {
  fingerprint: string;
  result: ProviderOperationResult;
  event: ProviderEvent;
}

export function exampleManifest(baseUrl: string): ProviderManifest {
  return parseProviderManifest({
    manifestVersion: "v1",
    providerId: "opensales.example.official-sdk",
    displayName: "Official SDK example Provider",
    description: "Six-capability educational Provider implemented only against public Apache-2.0 packages.",
    endpointBaseUrl: baseUrl,
    publisher: {
      name: "OpenSales System contributors",
      website: "https://github.com/wingsrabbit/OSS",
      supportUrl: "https://github.com/wingsrabbit/OSS/issues",
    },
    license: { identifier: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    capabilities: providerCapabilities.map((capability) => ({
      capability,
      contractVersion: PROVIDER_CONTRACT_VERSION,
      operations: [...capabilityOperations[capability]],
      eventSubscriptions: [`core.${capability}.requested`],
    })),
    permissions: {
      scopes: providerCapabilities.map((capability) => `${capability}.operate`),
      dataFields: ["opaque_refs", "minor_units", "synthetic_recipient", "synthetic_signals"],
      secrets: [{ name: "EXAMPLE_PROVIDER_TOKEN", purpose: "Bearer credential", required: true, rotation: "supported" }],
    },
    limits: { maxConcurrentOperations: 8, maxAmountMinor: "1000000", maxOwnedResources: 100 },
    retention: { operationDays: 1, eventDays: 1, piiDays: 0 },
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

function outputFor(request: ProviderOperationRequest): ProviderOperationOutput {
  switch (request.capability) {
    case "payment":
      return {
        externalPaymentRef: `example-payment-${request.operationId}`,
        paymentState: request.action === "payment.refund"
          ? "refunded"
          : request.action === "payment.authorize"
            ? "authorized"
            : "captured",
        amountMinor: request.input.amountMinor,
        currency: request.input.currency,
      };
    case "provisioning":
      return {
        externalResourceRef: request.input.externalResourceRef ?? `example-resource-${request.operationId}`,
        resourceState: request.action === "resource.terminate"
          ? "terminated"
          : request.action === "resource.stop"
            ? "stopped"
            : "ready",
        ...(request.action === "resource.terminate" ? {} : { readyAt: new Date().toISOString() }),
      };
    case "mail":
      return { externalDeliveryRef: `example-delivery-${request.operationId}`, deliveryState: "delivered" };
    case "verification":
      return {
        externalEvidenceRef: `example-evidence-${request.operationId}`,
        verdict: "verified",
        assurance: "medium",
        checked: request.input.checks,
      };
    case "tax": {
      const lines = request.input.lines.map((line) => ({
        lineRef: line.lineRef,
        taxMinor: ((BigInt(line.amountMinor) * 500n + 5_000n) / 10_000n).toString(),
        rateBasisPoints: 500,
      }));
      return {
        externalQuoteRef: `example-tax-${request.operationId}`,
        currency: request.input.currency,
        totalTaxMinor: lines.reduce((sum, line) => sum + BigInt(line.taxMinor), 0n).toString(),
        lines,
      };
    }
    case "anti_abuse_challenge":
      return {
        externalDecisionRef: `example-decision-${request.operationId}`,
        decision: request.input.signals.syntheticDecision === "challenge" ? "challenge" : "allow",
        ...(request.input.signals.syntheticDecision === "challenge"
          ? {
              challengeRef: `example-challenge-${request.operationId}`,
              challengeState: "pending" as const,
            }
          : {}),
      };
  }
}

export async function createExampleOperation(
  providerId: string,
  request: ProviderOperationRequest,
): Promise<StoredExampleOperation> {
  const observedAt = new Date().toISOString();
  const result = parseProviderOperationResult({
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    capability: request.capability,
    operationId: request.operationId,
    status: "succeeded",
    revision: 1,
    observedAt,
    output: outputFor(request),
  });
  const event = parseProviderEvent({
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    eventId: randomUUID(),
    providerId,
    capability: request.capability,
    operationId: request.operationId,
    sequence: 1,
    eventType: "operation.succeeded",
    observedAt,
    result,
  });
  return { fingerprint: await providerRequestFingerprint(request), result, event };
}
