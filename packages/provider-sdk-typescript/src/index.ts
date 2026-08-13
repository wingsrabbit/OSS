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
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
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
