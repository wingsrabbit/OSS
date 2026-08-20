// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  capabilityMutationOperations,
  capabilityOperations,
  parseProviderEventPage,
  parseProviderManifest,
  parseProviderOperationResult,
  type ProviderCapability,
  type ProviderManifest,
  type ProviderOperationRequest,
  type ProviderOperationResult,
} from "@opensales/provider-contracts";
import {
  canonicalProviderJson,
  reduceProviderEvents,
  stableProviderOperationId,
} from "@opensales/provider-sdk-typescript";

export const mockReliabilityScenarios = [
  "normal",
  "failure",
  "duplicate",
  "out_of_order",
  "timeout",
  "restart",
] as const;

export type MockReliabilityScenario = (typeof mockReliabilityScenarios)[number];

export interface ConformanceTarget {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export interface RestartOperation {
  capability: ProviderCapability;
  operationId: string;
}

export interface RestartPlan {
  runId: string;
  operations: RestartOperation[];
}

export interface ConformanceReport {
  providerId: string;
  capabilities: ProviderCapability[];
  publicOperations: number;
  reliabilityOperations: number;
  duplicateEventsIgnored: number;
  staleEventsIgnored: number;
  timeoutOperationsReconciled: number;
}

type ProviderMutationAction = ProviderOperationRequest["action"];

const representativeMutationActions: Readonly<Record<ProviderCapability, ProviderMutationAction>> = {
  payment: "payment.capture",
  provisioning: "resource.create",
  mail: "mail.send",
  verification: "verification.evaluate",
  tax: "tax.quote",
  anti_abuse_challenge: "challenge.evaluate",
};

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function authorizedHeaders(target: ConformanceTarget): Record<string, string> {
  return { authorization: `Bearer ${target.token}` };
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function providerManifest(target: ConformanceTarget): Promise<ProviderManifest> {
  const fetch = target.fetch ?? globalThis.fetch;
  const response = await fetch(`${normalizedBaseUrl(target.baseUrl)}/v1/manifest`);
  assert.equal(response.status, 200, "Provider manifest must be readable");
  return parseProviderManifest(await responseJson(response));
}

export function requestFor(
  capability: ProviderCapability,
  operationId: string,
  intentRef: string,
  action: ProviderMutationAction = representativeMutationActions[capability],
): ProviderOperationRequest {
  if (!(capabilityMutationOperations[capability] as readonly string[]).includes(action)) {
    throw new Error(`${action} is not a mutation operation for ${capability}`);
  }
  const base = {
    transportVersion: PROVIDER_TRANSPORT_VERSION,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    operationId,
    requestedAt: new Date().toISOString(),
    intentRef,
  } as const;
  switch (capability) {
    case "payment":
      return {
        ...base,
        capability,
        action: action as "payment.authorize" | "payment.capture" | "payment.refund",
        input: { amountMinor: "1999", currency: "USD", customerRef: "synthetic-customer" },
      };
    case "provisioning":
      return {
        ...base,
        capability,
        action: action as
          | "resource.create"
          | "resource.start"
          | "resource.stop"
          | "resource.reboot"
          | "resource.change_password"
          | "resource.change_plan"
          | "resource.terminate",
        input: {
          serviceRef: "synthetic-service",
          planRef: action === "resource.change_plan" ? "synthetic-plan-v2" : "synthetic-plan",
          ...(action === "resource.create" ? {} : { externalResourceRef: "synthetic-existing-resource" }),
          ...(action === "resource.change_password"
            ? { configuration: { requestedPasswordRef: "synthetic-credential-reference" } }
            : {}),
        },
      };
    case "mail":
      return {
        ...base,
        capability,
        action: action as "mail.send",
        input: {
          recipient: "provider-conformance@example.test",
          templateRef: "synthetic-template-v1",
          locale: "en",
          subject: "Synthetic Provider conformance",
          textBody: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        },
      };
    case "verification":
      return {
        ...base,
        capability,
        action: action as "verification.evaluate",
        input: {
          subjectRef: "synthetic-subject",
          purpose: "account_eligibility",
          checks: ["email_ownership", "identity"],
        },
      };
    case "tax":
      return {
        ...base,
        capability,
        action: action as "tax.quote",
        input: {
          currency: "USD",
          jurisdictionCountry: "US",
          lines: [{ lineRef: "synthetic-line", amountMinor: "1999", taxCode: "general" }],
        },
      };
    case "anti_abuse_challenge":
      return {
        ...base,
        capability,
        action: action as "challenge.evaluate",
        input: {
          subjectRef: "synthetic-subject",
          actionRef: "synthetic-checkout",
          signals: { syntheticDecision: "challenge" },
        },
      };
  }
}

async function operationIdFor(
  capability: ProviderCapability,
  scenario: string,
  runId: string,
  action: ProviderMutationAction = representativeMutationActions[capability],
): Promise<string> {
  return stableProviderOperationId({
    accountRef: `provider-conformance:${runId}`,
    capability,
    action,
    intentRef: scenario,
  });
}

export async function executeOperation(
  target: ConformanceTarget,
  request: ProviderOperationRequest,
  scenario?: MockReliabilityScenario,
): Promise<{ response: Response; body: unknown }> {
  const fetch = target.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    ...authorizedHeaders(target),
    "content-type": "application/json",
    "idempotency-key": request.operationId,
  };
  if (scenario) headers["x-oss-lab-scenario"] = scenario;
  const response = await fetch(
    `${normalizedBaseUrl(target.baseUrl)}/v1alpha1/${request.capability}/operations`,
    { method: "POST", headers, body: canonicalProviderJson(request) },
  );
  return { response, body: await responseJson(response) };
}

export async function reconcileOperation(
  target: ConformanceTarget,
  capability: ProviderCapability,
  operationId: string,
): Promise<ProviderOperationResult> {
  const fetch = target.fetch ?? globalThis.fetch;
  const response = await fetch(
    `${normalizedBaseUrl(target.baseUrl)}/v1alpha1/${capability}/operations/${encodeURIComponent(operationId)}`,
    { headers: authorizedHeaders(target) },
  );
  assert.equal(response.status, 200, `reconciliation failed for ${capability}/${operationId}`);
  return parseProviderOperationResult(await responseJson(response));
}

export async function operationEvents(
  target: ConformanceTarget,
  operationId: string,
) {
  const fetch = target.fetch ?? globalThis.fetch;
  const response = await fetch(
    `${normalizedBaseUrl(target.baseUrl)}/v1/events?operationId=${encodeURIComponent(operationId)}`,
    { headers: authorizedHeaders(target) },
  );
  assert.equal(response.status, 200, `event query failed for ${operationId}`);
  return parseProviderEventPage(await responseJson(response)).events;
}

function assertFunctionalOutput(
  result: ProviderOperationResult,
  action: ProviderMutationAction = representativeMutationActions[result.capability],
): void {
  assert.equal(result.status, "succeeded");
  assert.ok(result.output, `${result.capability} must return a functional output fact`);
  switch (result.capability) {
    case "payment":
      assert.equal(
        "paymentState" in result.output && result.output.paymentState,
        action === "payment.refund" ? "refunded" : action === "payment.authorize" ? "authorized" : "captured",
      );
      break;
    case "provisioning":
      assert.equal(
        "resourceState" in result.output && result.output.resourceState,
        action === "resource.terminate" ? "terminated" : action === "resource.stop" ? "stopped" : "ready",
      );
      break;
    case "mail":
      assert.equal("deliveryState" in result.output && result.output.deliveryState, "delivered");
      break;
    case "verification":
      assert.equal("verdict" in result.output && result.output.verdict, "verified");
      break;
    case "tax":
      assert.equal("totalTaxMinor" in result.output && result.output.totalTaxMinor, "100");
      break;
    case "anti_abuse_challenge":
      assert.equal("decision" in result.output && result.output.decision, "challenge");
      break;
  }
}

export async function runPublicProviderConformance(
  target: ConformanceTarget,
  providedManifest?: ProviderManifest,
): Promise<number> {
  const manifest = providedManifest ?? await providerManifest(target);
  const runId = randomUUID();
  let operations = 0;
  for (const declaration of manifest.capabilities) {
    const capability = declaration.capability;
    assert.equal(declaration.contractVersion, PROVIDER_CONTRACT_VERSION);
    const reconcileAction = capabilityOperations[capability].find((action) => action.endsWith(".reconcile"));
    assert.ok(reconcileAction && declaration.operations.includes(reconcileAction));
    for (const action of capabilityMutationOperations[capability]) {
      assert.ok(declaration.operations.includes(action), `${capability} manifest omitted ${action}`);
      const operationId = await operationIdFor(capability, `public-normal:${action}`, runId, action);
      const request = requestFor(capability, operationId, `public-normal:${action}:${runId}`, action);
      const concurrent = await Promise.all([
        executeOperation(target, request),
        executeOperation(target, request),
      ]);
      const first = concurrent[0];
      const replay = concurrent[1];
      assert.ok(first && replay);
      assert.equal(first.response.status, 202, `${action} normal operation was not accepted`);
      assert.equal(replay.response.status, 202, `${action} concurrent idempotent replay failed`);
      assert.deepEqual(
        new Set(concurrent.map(({ response }) => response.headers.get("x-oss-idempotent-replay"))),
        new Set(["false", "true"]),
        `${action} did not serialize the first request and its concurrent replay`,
      );
      const firstResult = parseProviderOperationResult(first.body);
      assertFunctionalOutput(firstResult, action);
      assert.deepEqual(parseProviderOperationResult(replay.body), firstResult);
      const conflictingRequest: ProviderOperationRequest = {
        ...request,
        intentRef: `${request.intentRef}:conflict`,
      };
      const conflict = await executeOperation(target, conflictingRequest);
      assert.equal(conflict.response.status, 409, `${action} accepted conflicting idempotency reuse`);
      const reconciled = await reconcileOperation(target, capability, operationId);
      assert.deepEqual(reconciled, firstResult);
      const events = await operationEvents(target, operationId);
      assert.equal(reduceProviderEvents(events).latest?.result.status, "succeeded");
      operations += 1;
    }
  }
  return operations;
}

export async function runMockReliabilityConformance(
  target: ConformanceTarget,
  providedManifest?: ProviderManifest,
): Promise<Omit<ConformanceReport, "publicOperations">> {
  const manifest = providedManifest ?? await providerManifest(target);
  const runId = randomUUID();
  let reliabilityOperations = 0;
  let duplicateEventsIgnored = 0;
  let staleEventsIgnored = 0;
  let timeoutOperationsReconciled = 0;
  for (const declaration of manifest.capabilities) {
    const capability = declaration.capability;

    const failureId = await operationIdFor(capability, "failure", runId);
    const failure = await executeOperation(
      target,
      requestFor(capability, failureId, `failure:${runId}`),
      "failure",
    );
    assert.equal(failure.response.status, 202);
    const failureResult = parseProviderOperationResult(failure.body);
    assert.equal(failureResult.status, "failed");
    assert.equal((await reconcileOperation(target, capability, failureId)).status, "failed");
    reliabilityOperations += 1;

    const duplicateId = await operationIdFor(capability, "duplicate", runId);
    const duplicateRequest = requestFor(capability, duplicateId, `duplicate:${runId}`);
    const duplicate = await executeOperation(target, duplicateRequest, "duplicate");
    assert.equal(duplicate.response.status, 202);
    assertFunctionalOutput(parseProviderOperationResult(duplicate.body));
    const duplicateReduction = reduceProviderEvents(await operationEvents(target, duplicateId));
    assert.equal(duplicateReduction.accepted.length, 1);
    assert.equal(duplicateReduction.ignoredDuplicateOrStale.length, 1);
    duplicateEventsIgnored += duplicateReduction.ignoredDuplicateOrStale.length;
    assert.equal((await reconcileOperation(target, capability, duplicateId)).status, "succeeded");
    const exactReplay = await executeOperation(target, duplicateRequest, "duplicate");
    assert.equal(exactReplay.response.headers.get("x-oss-idempotent-replay"), "true");
    reliabilityOperations += 1;

    const outOfOrderId = await operationIdFor(capability, "out-of-order", runId);
    const outOfOrder = await executeOperation(
      target,
      requestFor(capability, outOfOrderId, `out-of-order:${runId}`),
      "out_of_order",
    );
    assert.equal(outOfOrder.response.status, 202);
    const outOfOrderEvents = await operationEvents(target, outOfOrderId);
    assert.deepEqual(outOfOrderEvents.map(({ sequence }) => sequence), [2, 1]);
    const outOfOrderReduction = reduceProviderEvents(outOfOrderEvents);
    assert.equal(outOfOrderReduction.latest?.result.status, "succeeded");
    assert.equal(outOfOrderReduction.ignoredDuplicateOrStale.length, 1);
    staleEventsIgnored += 1;
    assert.equal((await reconcileOperation(target, capability, outOfOrderId)).status, "succeeded");
    reliabilityOperations += 1;

    const timeoutId = await operationIdFor(capability, "timeout", runId);
    const timeout = await executeOperation(
      target,
      requestFor(capability, timeoutId, `timeout:${runId}`),
      "timeout",
    );
    assert.equal(timeout.response.status, 504);
    const timeoutReconciled = await reconcileOperation(target, capability, timeoutId);
    assertFunctionalOutput(timeoutReconciled);
    timeoutOperationsReconciled += 1;
    reliabilityOperations += 1;
  }
  return {
    providerId: manifest.providerId,
    capabilities: manifest.capabilities.map(({ capability }) => capability),
    reliabilityOperations,
    duplicateEventsIgnored,
    staleEventsIgnored,
    timeoutOperationsReconciled,
  };
}

export async function prepareRestartConformance(
  target: ConformanceTarget,
  providedManifest?: ProviderManifest,
): Promise<RestartPlan> {
  const manifest = providedManifest ?? await providerManifest(target);
  const runId = randomUUID();
  const operations: RestartOperation[] = [];
  for (const { capability } of manifest.capabilities) {
    const operationId = await operationIdFor(capability, "restart", runId);
    const response = await executeOperation(
      target,
      requestFor(capability, operationId, `restart:${runId}`),
      "restart",
    );
    assert.equal(response.response.status, 202);
    assert.equal(parseProviderOperationResult(response.body).status, "pending");
    operations.push({ capability, operationId });
  }
  return { runId, operations };
}

export async function verifyRestartConformance(
  target: ConformanceTarget,
  plan: RestartPlan,
): Promise<number> {
  for (const { capability, operationId } of plan.operations) {
    const result = await reconcileOperation(target, capability, operationId);
    assertFunctionalOutput(result);
    const events = await operationEvents(target, operationId);
    assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2]);
    assert.equal(reduceProviderEvents(events).latest?.result.status, "succeeded");
  }
  return plan.operations.length;
}

export async function runCompleteMockConformance(
  target: ConformanceTarget,
): Promise<ConformanceReport> {
  const manifest = await providerManifest(target);
  const publicOperations = await runPublicProviderConformance(target, manifest);
  const reliability = await runMockReliabilityConformance(target, manifest);
  return { ...reliability, publicOperations };
}
