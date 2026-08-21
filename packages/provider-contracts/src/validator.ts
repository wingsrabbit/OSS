// SPDX-License-Identifier: Apache-2.0

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { providerSchemaDocuments } from "./schema-documents.js";
import type {
  ProviderDocumentKind,
  ProviderEvent,
  ProviderEventPage,
  ProviderManifest,
  ProviderOperationRequest,
  ProviderOperationResult,
} from "./types.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
  allowUnionTypes: true,
});
ajv.addFormat("uuid", {
  type: "string",
  validate: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)),
});
ajv.addFormat("email", {
  type: "string",
  validate: (value: string) =>
    value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
});
ajv.addFormat("uri", {
  type: "string",
  validate: (value: string) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol.length > 1;
    } catch {
      return false;
    }
  },
});

const validators = Object.fromEntries(
  Object.entries(providerSchemaDocuments).map(([kind, schema]) => [kind, ajv.compile(schema)]),
) as Record<ProviderDocumentKind, ValidateFunction>;

function errorText(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export class ProviderContractValidationError extends Error {
  readonly kind: ProviderDocumentKind;
  readonly validationErrors: readonly ErrorObject[];

  constructor(kind: ProviderDocumentKind, errors: ErrorObject[] | null | undefined) {
    super(`Invalid Provider ${kind}: ${errorText(errors)}`);
    this.name = "ProviderContractValidationError";
    this.kind = kind;
    this.validationErrors = [...(errors ?? [])];
  }
}

export function isProviderDocument(kind: ProviderDocumentKind, value: unknown): boolean {
  return validators[kind](value) as boolean;
}

export function assertProviderDocument(kind: ProviderDocumentKind, value: unknown): void {
  const validator = validators[kind];
  if (!validator(value)) throw new ProviderContractValidationError(kind, validator.errors);
}

export function parseProviderManifest(value: unknown): ProviderManifest {
  assertProviderDocument("manifest", value);
  const manifest = value as ProviderManifest;
  const capabilities = new Set(manifest.capabilities.map(({ capability }) => capability));
  if (capabilities.size !== manifest.capabilities.length) {
    throw new ProviderContractValidationError("manifest", [
      {
        instancePath: "/capabilities",
        schemaPath: "#/semantic/unique-capability",
        keyword: "uniqueCapability",
        params: {},
        message: "must declare each capability at most once",
      },
    ]);
  }
  return manifest;
}

export function parseProviderOperationRequest(value: unknown): ProviderOperationRequest {
  assertProviderDocument("operation-request", value);
  return value as ProviderOperationRequest;
}

export function parseProviderOperationResult(value: unknown): ProviderOperationResult {
  assertProviderDocument("operation-result", value);
  return value as ProviderOperationResult;
}

export function parseProviderEvent(value: unknown): ProviderEvent {
  assertProviderDocument("event", value);
  const event = value as ProviderEvent;
  const expectedEventType = `operation.${event.result.status}`;
  if (
    event.result.operationId !== event.operationId ||
    event.result.capability !== event.capability ||
    event.eventType !== expectedEventType
  ) {
    throw new ProviderContractValidationError("event", [
      {
        instancePath: "/result",
        schemaPath: "#/semantic/event-result-binding",
        keyword: "eventResultBinding",
        params: {},
        message: "must match the outer capability, operationId, and eventType",
      },
    ]);
  }
  return event;
}

export function parseProviderEventPage(value: unknown): ProviderEventPage {
  assertProviderDocument("event-page", value);
  const page = value as ProviderEventPage;
  for (const event of page.events) parseProviderEvent(event);
  return page;
}
