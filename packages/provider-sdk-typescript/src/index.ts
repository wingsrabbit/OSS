// SPDX-License-Identifier: Apache-2.0

import {
  parseProviderEventPage,
  parseProviderManifest,
  parseProviderOperationRequest,
  parseProviderOperationResult,
  type ProviderCapability,
  type ProviderEvent,
  type ProviderManifest,
  type ProviderOperationRequest,
  type ProviderOperationResult,
} from "@opensales/provider-contracts";

export * from "@opensales/provider-contracts";

export function canonicalProviderJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Provider JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalProviderJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) throw new TypeError("Provider JSON contains undefined");
        return `${JSON.stringify(key)}:${canonicalProviderJson(record[key])}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Provider JSON contains unsupported ${typeof value}`);
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function providerRequestFingerprint(request: ProviderOperationRequest): Promise<string> {
  return bytesToHex(await sha256(`opensales-provider-request:v1\0${canonicalProviderJson(request)}`));
}

export async function stableProviderOperationId(parts: {
  accountRef: string;
  capability: ProviderCapability;
  action: string;
  intentRef: string;
}): Promise<string> {
  const digest = await sha256(`opensales-provider-operation:v1\0${canonicalProviderJson(parts)}`);
  const bytes = digest.slice(0, 16);
  // UUIDv8 explicitly permits application-defined SHA-256 name derivation.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly responseBody: unknown;

  constructor(status: number, responseBody: unknown) {
    super(`Provider returned HTTP ${status}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class ProviderUnknownOutcomeError extends Error {
  readonly capability: ProviderCapability;
  readonly operationId: string;

  constructor(capability: ProviderCapability, operationId: string) {
    super(`Provider outcome for ${capability}/${operationId} is unknown; reconcile before another mutation`);
    this.name = "ProviderUnknownOutcomeError";
    this.capability = capability;
    this.operationId = operationId;
  }
}

export interface ProviderClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export class ProviderClient {
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ProviderClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async manifest(): Promise<ProviderManifest> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/manifest`);
    return parseProviderManifest(await this.#json(response));
  }

  async execute(request: ProviderOperationRequest): Promise<ProviderOperationResult> {
    const validated = parseProviderOperationRequest(request);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": validated.operationId,
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/v1alpha1/${validated.capability}/operations`,
        { method: "POST", headers, body: canonicalProviderJson(validated) },
      );
    } catch {
      throw new ProviderUnknownOutcomeError(validated.capability, validated.operationId);
    }
    if (response.status === 504) {
      throw new ProviderUnknownOutcomeError(validated.capability, validated.operationId);
    }
    return parseProviderOperationResult(await this.#json(response));
  }

  async reconcile(capability: ProviderCapability, operationId: string): Promise<ProviderOperationResult> {
    const headers: Record<string, string> = {};
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    const response = await this.#fetch(
      `${this.#baseUrl}/v1alpha1/${capability}/operations/${encodeURIComponent(operationId)}`,
      { headers },
    );
    return parseProviderOperationResult(await this.#json(response));
  }

  async events(operationId: string): Promise<ProviderEvent[]> {
    const headers: Record<string, string> = {};
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/events?operationId=${encodeURIComponent(operationId)}`,
      { headers },
    );
    return parseProviderEventPage(await this.#json(response)).events;
  }

  async #json(response: Response): Promise<unknown> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) throw new ProviderHttpError(response.status, body);
    return body;
  }
}

export interface ReconcileOptions {
  maxAttempts: number;
  delayMs: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export async function reconcileProviderOperation(
  client: Pick<ProviderClient, "reconcile">,
  capability: ProviderCapability,
  operationId: string,
  options: ReconcileOptions,
): Promise<ProviderOperationResult> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let latest: ProviderOperationResult | undefined;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    latest = await client.reconcile(capability, operationId);
    if (latest.status === "succeeded" || latest.status === "failed") return latest;
    if (attempt < options.maxAttempts) await sleep(options.delayMs * attempt);
  }
  if (!latest) throw new Error("Provider reconciliation produced no result");
  return latest;
}

export interface ProviderEventReduction {
  latest: ProviderEvent | undefined;
  accepted: ProviderEvent[];
  ignoredDuplicateOrStale: ProviderEvent[];
}

export function reduceProviderEvents(events: readonly ProviderEvent[]): ProviderEventReduction {
  const eventIds = new Set<string>();
  const accepted: ProviderEvent[] = [];
  const ignoredDuplicateOrStale: ProviderEvent[] = [];
  let latest: ProviderEvent | undefined;
  for (const event of events) {
    if (eventIds.has(event.eventId) || (latest && event.sequence <= latest.sequence)) {
      ignoredDuplicateOrStale.push(event);
      continue;
    }
    if (latest && (event.operationId !== latest.operationId || event.capability !== latest.capability)) {
      throw new Error("Cannot reduce events from different Provider operations");
    }
    eventIds.add(event.eventId);
    accepted.push(event);
    latest = event;
  }
  return { latest, accepted, ignoredDuplicateOrStale };
}

export type ProviderPermissionExpansionCategory =
  | "identity"
  | "endpoint"
  | "contract_version"
  | "capability"
  | "operation"
  | "event_subscription"
  | "scope"
  | "data_field"
  | "secret"
  | "concurrency_limit"
  | "amount_limit"
  | "resource_limit"
  | "retention"
  | "lifecycle";

export interface ProviderPermissionExpansion {
  category: ProviderPermissionExpansionCategory;
  value: string;
  reason: string;
}

export interface ProviderPermissionExpansionReview {
  requiresFreshApproval: boolean;
  expansions: ProviderPermissionExpansion[];
}

function additions(current: readonly string[], candidate: readonly string[]): string[] {
  const installed = new Set(current);
  return candidate.filter((value) => !installed.has(value));
}

function numericLimitExpanded(current: number | null, candidate: number | null): boolean {
  return current !== null && (candidate === null || candidate > current);
}

function moneyLimitExpanded(current: string | null, candidate: string | null): boolean {
  return current !== null && (candidate === null || BigInt(candidate) > BigInt(current));
}

export function reviewProviderPermissionExpansion(
  installed: ProviderManifest,
  candidate: ProviderManifest,
): ProviderPermissionExpansionReview {
  if (installed.providerId !== candidate.providerId) {
    throw new Error("Cannot compare manifests from different Provider identities");
  }
  const expansions: ProviderPermissionExpansion[] = [];
  const record = (
    category: ProviderPermissionExpansionCategory,
    value: string,
    reason: string,
  ) => expansions.push({ category, value, reason });

  if (installed.endpointBaseUrl !== candidate.endpointBaseUrl) {
    record("endpoint", candidate.endpointBaseUrl, "Provider endpoint identity changed");
  }
  if (
    installed.publisher.name !== candidate.publisher.name ||
    installed.publisher.website !== candidate.publisher.website ||
    installed.license.identifier !== candidate.license.identifier ||
    installed.license.url !== candidate.license.url
  ) {
    record("identity", candidate.publisher.name, "Provider publisher or license identity changed");
  }
  const installedCapabilities = new Map(
    installed.capabilities.map((declaration) => [declaration.capability, declaration]),
  );
  for (const declaration of candidate.capabilities) {
    const current = installedCapabilities.get(declaration.capability);
    if (!current) {
      record("capability", declaration.capability, "Provider requested a new capability");
      continue;
    }
    if (current.contractVersion !== declaration.contractVersion) {
      record(
        "contract_version",
        `${declaration.capability}:${declaration.contractVersion}`,
        "Provider requested a different capability contract version",
      );
    }
    for (const operation of additions(current.operations, declaration.operations)) {
      record("operation", `${declaration.capability}:${operation}`, "Provider requested a new operation");
    }
    for (const subscription of additions(current.eventSubscriptions, declaration.eventSubscriptions)) {
      record(
        "event_subscription",
        `${declaration.capability}:${subscription}`,
        "Provider requested a new event subscription",
      );
    }
  }
  for (const scope of additions(installed.permissions.scopes, candidate.permissions.scopes)) {
    record("scope", scope, "Provider requested a new API scope");
  }
  for (const field of additions(installed.permissions.dataFields, candidate.permissions.dataFields)) {
    record("data_field", field, "Provider requested a new data field");
  }
  const installedSecrets = new Map(installed.permissions.secrets.map((secret) => [secret.name, secret]));
  for (const secret of candidate.permissions.secrets) {
    const current = installedSecrets.get(secret.name);
    if (
      !current ||
      current.purpose !== secret.purpose ||
      current.required !== secret.required ||
      current.rotation !== secret.rotation
    ) {
      record("secret", secret.name, "Provider requested a new or changed injected Secret");
    }
  }
  if (moneyLimitExpanded(installed.limits.maxAmountMinor, candidate.limits.maxAmountMinor)) {
    record("amount_limit", candidate.limits.maxAmountMinor ?? "unlimited", "Provider amount limit increased");
  }
  if (candidate.limits.maxConcurrentOperations > installed.limits.maxConcurrentOperations) {
    record(
      "concurrency_limit",
      String(candidate.limits.maxConcurrentOperations),
      "Provider concurrency limit increased",
    );
  }
  if (numericLimitExpanded(installed.limits.maxOwnedResources, candidate.limits.maxOwnedResources)) {
    record("resource_limit", String(candidate.limits.maxOwnedResources ?? "unlimited"), "Provider resource limit increased");
  }
  for (const key of ["operationDays", "eventDays", "piiDays"] as const) {
    if (candidate.retention[key] > installed.retention[key]) {
      record("retention", `${key}:${candidate.retention[key]}`, "Provider retention period increased");
    }
  }
  for (const key of [
    "uninstallRequiresNoUnknownOperations",
    "uninstallRequiresNoOwnedResources",
    "uninstallRequiresNoPendingFunds",
  ] as const) {
    if (installed.lifecycle[key] && !candidate.lifecycle[key]) {
      record("lifecycle", key, "Provider requested a weaker uninstall guard");
    }
  }
  return { requiresFreshApproval: expansions.length > 0, expansions };
}

export interface ProviderInstallationReview {
  identity: {
    providerId: string;
    displayName: string;
    endpointBaseUrl: string;
    publisher: string;
    license: string;
  };
  versions: Array<{ capability: ProviderCapability; contractVersion: string }>;
  capabilities: Array<{
    capability: ProviderCapability;
    operations: string[];
    eventSubscriptions: string[];
  }>;
  scopes: string[];
  dataFields: string[];
  secrets: Array<{ name: string; purpose: string; required: boolean; rotation: string }>;
  limits: ProviderManifest["limits"];
  retention: ProviderManifest["retention"];
  lifecycle: ProviderManifest["lifecycle"];
}

export function providerInstallationReview(manifest: ProviderManifest): ProviderInstallationReview {
  return {
    identity: {
      providerId: manifest.providerId,
      displayName: manifest.displayName,
      endpointBaseUrl: manifest.endpointBaseUrl,
      publisher: manifest.publisher.name,
      license: manifest.license.identifier,
    },
    versions: manifest.capabilities.map(({ capability, contractVersion }) => ({
      capability,
      contractVersion,
    })),
    capabilities: manifest.capabilities.map(({ capability, operations, eventSubscriptions }) => ({
      capability,
      operations: [...operations],
      eventSubscriptions: [...eventSubscriptions],
    })),
    scopes: [...manifest.permissions.scopes],
    dataFields: [...manifest.permissions.dataFields],
    secrets: manifest.permissions.secrets.map((secret) => ({ ...secret })),
    limits: { ...manifest.limits },
    retention: { ...manifest.retention },
    lifecycle: { ...manifest.lifecycle },
  };
}

export interface ProviderOwnershipFacts {
  unknownOperations: number;
  pendingFunds: number;
  ownedActiveResources: number;
}

export interface ProviderUninstallDecision {
  allowed: boolean;
  blockers: Array<"unknown_operations" | "pending_funds" | "owned_active_resources">;
  requiredNextStep: "uninstall" | "drain_reconcile_export_or_manual_takeover";
}

export function providerUninstallDecision(
  manifest: ProviderManifest,
  facts: ProviderOwnershipFacts,
): ProviderUninstallDecision {
  for (const [key, value] of Object.entries(facts)) {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`${key} must be a non-negative integer`);
  }
  const blockers: ProviderUninstallDecision["blockers"] = [];
  if (manifest.lifecycle.uninstallRequiresNoUnknownOperations && facts.unknownOperations > 0) {
    blockers.push("unknown_operations");
  }
  if (manifest.lifecycle.uninstallRequiresNoPendingFunds && facts.pendingFunds > 0) {
    blockers.push("pending_funds");
  }
  if (manifest.lifecycle.uninstallRequiresNoOwnedResources && facts.ownedActiveResources > 0) {
    blockers.push("owned_active_resources");
  }
  return {
    allowed: blockers.length === 0,
    blockers,
    requiredNextStep: blockers.length === 0
      ? "uninstall"
      : "drain_reconcile_export_or_manual_takeover",
  };
}

export type ProviderInstallationRuntimeStatus = "active" | "paused" | "revoked";
export type ProviderInstallationTransition = "pause" | "resume" | "revoke";

export interface ProviderCredentialWindow {
  currentVersion: number;
  previousVersion: number | null;
  previousValidUntil: string | null;
}

export interface ProviderInstallationRuntimeState {
  providerId: string;
  status: ProviderInstallationRuntimeStatus;
  credentials: ProviderCredentialWindow;
}

export type ProviderOperationAdmissionBlocker =
  | "credential_not_current_or_in_overlap"
  | "installation_paused"
  | "installation_revoked"
  | "concurrency_limit"
  | "amount_limit"
  | "resource_limit";

export interface ProviderOperationAdmissionInput {
  kind: "mutation" | "reconcile";
  credentialVersion: number;
  activeOperations: number;
  ownedActiveResources: number;
  amountMinor?: string;
  createsOwnedResource?: boolean;
  now: string;
}

export interface ProviderOperationAdmissionDecision {
  allowed: boolean;
  blockers: ProviderOperationAdmissionBlocker[];
}

function positiveCredentialVersion(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function instant(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new RangeError(`${label} must be an ISO-8601 instant`);
  return timestamp;
}

function nonNegativeCount(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer`);
  return value;
}

function minorUnits(value: string, label: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new RangeError(`${label} must be non-negative integer minor units`);
  return BigInt(value);
}

export function installProviderRuntime(
  manifest: ProviderManifest,
  credentialVersion: number,
): ProviderInstallationRuntimeState {
  parseProviderManifest(manifest);
  return {
    providerId: manifest.providerId,
    status: "active",
    credentials: {
      currentVersion: positiveCredentialVersion(credentialVersion, "credentialVersion"),
      previousVersion: null,
      previousValidUntil: null,
    },
  };
}

export function transitionProviderInstallation(
  manifest: ProviderManifest,
  state: ProviderInstallationRuntimeState,
  transition: ProviderInstallationTransition,
): ProviderInstallationRuntimeState {
  if (state.providerId !== manifest.providerId) throw new Error("Installation state belongs to a different Provider");
  if (state.status === "revoked") throw new Error("A revoked Provider installation cannot transition again");
  if (transition === "pause") {
    if (!manifest.lifecycle.supportsPause) throw new Error("Provider manifest does not support pause");
    if (state.status !== "active") throw new Error("Only an active Provider installation can be paused");
    return { ...state, status: "paused" };
  }
  if (transition === "resume") {
    if (state.status !== "paused") throw new Error("Only a paused Provider installation can be resumed");
    return { ...state, status: "active" };
  }
  return { ...state, status: "revoked" };
}

export function rotateProviderCredential(
  manifest: ProviderManifest,
  state: ProviderInstallationRuntimeState,
  newVersion: number,
  overlapValidUntil: string,
  now: string,
): ProviderInstallationRuntimeState {
  if (state.providerId !== manifest.providerId) throw new Error("Installation state belongs to a different Provider");
  if (!manifest.lifecycle.supportsCredentialRotation) {
    throw new Error("Provider manifest does not support credential rotation");
  }
  if (state.status === "revoked") throw new Error("A revoked Provider installation cannot rotate credentials");
  const nextVersion = positiveCredentialVersion(newVersion, "newVersion");
  if (nextVersion <= state.credentials.currentVersion) {
    throw new Error("Credential rotation requires a greater new version");
  }
  if (instant(overlapValidUntil, "overlapValidUntil") <= instant(now, "now")) {
    throw new Error("Credential rotation overlap must end after the rotation time");
  }
  return {
    ...state,
    credentials: {
      currentVersion: nextVersion,
      previousVersion: state.credentials.currentVersion,
      previousValidUntil: new Date(overlapValidUntil).toISOString(),
    },
  };
}

export function expireProviderCredentialOverlap(
  state: ProviderInstallationRuntimeState,
  now: string,
): ProviderInstallationRuntimeState {
  const previousValidUntil = state.credentials.previousValidUntil;
  if (previousValidUntil === null || instant(now, "now") < instant(previousValidUntil, "previousValidUntil")) {
    return state;
  }
  return {
    ...state,
    credentials: { ...state.credentials, previousVersion: null, previousValidUntil: null },
  };
}

export function providerOperationAdmissionDecision(
  manifest: ProviderManifest,
  state: ProviderInstallationRuntimeState,
  input: ProviderOperationAdmissionInput,
): ProviderOperationAdmissionDecision {
  if (state.providerId !== manifest.providerId) throw new Error("Installation state belongs to a different Provider");
  const activeOperations = nonNegativeCount(input.activeOperations, "activeOperations");
  const ownedActiveResources = nonNegativeCount(input.ownedActiveResources, "ownedActiveResources");
  const now = instant(input.now, "now");
  const credentialVersion = positiveCredentialVersion(input.credentialVersion, "credentialVersion");
  const previousCredentialAccepted =
    state.credentials.previousVersion === credentialVersion &&
    state.credentials.previousValidUntil !== null &&
    now < instant(state.credentials.previousValidUntil, "previousValidUntil");
  const blockers: ProviderOperationAdmissionBlocker[] = [];
  if (credentialVersion !== state.credentials.currentVersion && !previousCredentialAccepted) {
    blockers.push("credential_not_current_or_in_overlap");
  }
  if (input.kind === "mutation") {
    if (state.status === "paused") blockers.push("installation_paused");
    if (state.status === "revoked") blockers.push("installation_revoked");
    if (activeOperations >= manifest.limits.maxConcurrentOperations) blockers.push("concurrency_limit");
    if (input.amountMinor !== undefined) {
      const amount = minorUnits(input.amountMinor, "amountMinor");
      const limit = manifest.limits.maxAmountMinor;
      if (limit !== null && amount > minorUnits(limit, "manifest maxAmountMinor")) blockers.push("amount_limit");
    }
    const resourceLimit = manifest.limits.maxOwnedResources;
    if (input.createsOwnedResource === true && resourceLimit !== null && ownedActiveResources >= resourceLimit) {
      blockers.push("resource_limit");
    }
  }
  return { allowed: blockers.length === 0, blockers };
}
