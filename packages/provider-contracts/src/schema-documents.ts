// SPDX-License-Identifier: Apache-2.0

import {
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_TRANSPORT_VERSION,
  capabilityMutationOperations,
  capabilityOperations,
  providerCapabilities,
  type ProviderCapability,
} from "./types.js";

type JsonSchema = Readonly<Record<string, unknown>>;

const uuid = { type: "string", format: "uuid" } as const;
const instant = { type: "string", format: "date-time" } as const;
const opaqueRef = { type: "string", minLength: 1, maxLength: 200 } as const;
const minorUnits = { type: "string", pattern: "^(0|[1-9][0-9]*)$" } as const;
const currency = { type: "string", pattern: "^[A-Z]{3}$" } as const;

const inputSchemas: Record<ProviderCapability, JsonSchema> = {
  payment: {
    type: "object",
    additionalProperties: false,
    required: ["amountMinor", "currency"],
    properties: {
      amountMinor: minorUnits,
      currency,
      customerRef: opaqueRef,
      externalPaymentRef: opaqueRef,
    },
  },
  provisioning: {
    type: "object",
    additionalProperties: false,
    required: ["serviceRef", "planRef"],
    properties: {
      serviceRef: opaqueRef,
      planRef: opaqueRef,
      externalResourceRef: opaqueRef,
      configuration: {
        type: "object",
        maxProperties: 100,
        additionalProperties: { type: ["string", "number", "boolean"] },
      },
    },
  },
  mail: {
    type: "object",
    additionalProperties: false,
    required: ["recipient", "templateRef", "locale", "subject", "textBody"],
    properties: {
      recipient: { type: "string", format: "email", maxLength: 320 },
      templateRef: opaqueRef,
      locale: { enum: ["en", "zh-CN"] },
      subject: { type: "string", minLength: 1, maxLength: 240 },
      textBody: { type: "string", minLength: 1, maxLength: 20_000 },
    },
  },
  verification: {
    type: "object",
    additionalProperties: false,
    required: ["subjectRef", "purpose", "checks"],
    properties: {
      subjectRef: opaqueRef,
      purpose: { enum: ["account_eligibility", "manual_review"] },
      checks: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { enum: ["email_ownership", "identity", "business"] },
      },
    },
  },
  tax: {
    type: "object",
    additionalProperties: false,
    required: ["currency", "jurisdictionCountry", "lines"],
    properties: {
      currency,
      jurisdictionCountry: { type: "string", pattern: "^[A-Z]{2}$" },
      jurisdictionRegion: { type: "string", minLength: 1, maxLength: 100 },
      lines: {
        type: "array",
        minItems: 1,
        maxItems: 500,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["lineRef", "amountMinor", "taxCode"],
          properties: {
            lineRef: opaqueRef,
            amountMinor: minorUnits,
            taxCode: opaqueRef,
          },
        },
      },
    },
  },
  anti_abuse_challenge: {
    type: "object",
    additionalProperties: false,
    required: ["subjectRef", "actionRef", "signals"],
    properties: {
      subjectRef: opaqueRef,
      actionRef: opaqueRef,
      signals: {
        type: "object",
        minProperties: 1,
        maxProperties: 100,
        additionalProperties: { type: ["string", "number", "boolean"] },
      },
    },
  },
};

const outputSchemas: Record<ProviderCapability, JsonSchema> = {
  payment: {
    type: "object",
    additionalProperties: false,
    required: ["externalPaymentRef", "paymentState", "amountMinor", "currency"],
    properties: {
      externalPaymentRef: opaqueRef,
      paymentState: { enum: ["authorized", "captured", "refunded", "declined"] },
      amountMinor: minorUnits,
      currency,
    },
  },
  provisioning: {
    type: "object",
    additionalProperties: false,
    required: ["externalResourceRef", "resourceState"],
    properties: {
      externalResourceRef: opaqueRef,
      resourceState: { enum: ["pending", "ready", "stopped", "terminated"] },
      readyAt: instant,
    },
  },
  mail: {
    type: "object",
    additionalProperties: false,
    required: ["externalDeliveryRef", "deliveryState"],
    properties: {
      externalDeliveryRef: opaqueRef,
      deliveryState: { enum: ["delivered", "bounced", "failed"] },
    },
  },
  verification: {
    type: "object",
    additionalProperties: false,
    required: ["externalEvidenceRef", "verdict", "assurance", "checked"],
    properties: {
      externalEvidenceRef: opaqueRef,
      verdict: { enum: ["verified", "rejected", "manual_review"] },
      assurance: { enum: ["low", "medium", "high"] },
      checked: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { enum: ["email_ownership", "identity", "business"] },
      },
    },
  },
  tax: {
    type: "object",
    additionalProperties: false,
    required: ["externalQuoteRef", "currency", "totalTaxMinor", "lines"],
    properties: {
      externalQuoteRef: opaqueRef,
      currency,
      totalTaxMinor: minorUnits,
      lines: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["lineRef", "taxMinor", "rateBasisPoints"],
          properties: {
            lineRef: opaqueRef,
            taxMinor: minorUnits,
            rateBasisPoints: { type: "integer", minimum: 0, maximum: 100_000 },
          },
        },
      },
    },
  },
  anti_abuse_challenge: {
    type: "object",
    additionalProperties: false,
    required: ["externalDecisionRef", "decision"],
    properties: {
      externalDecisionRef: opaqueRef,
      decision: { enum: ["allow", "challenge", "deny"] },
      challengeRef: opaqueRef,
      challengeState: { enum: ["pending", "satisfied", "failed"] },
    },
  },
};

function operationRequestBranch(capability: ProviderCapability): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "transportVersion",
      "contractVersion",
      "operationId",
      "requestedAt",
      "intentRef",
      "capability",
      "action",
      "input",
    ],
    properties: {
      transportVersion: { const: PROVIDER_TRANSPORT_VERSION },
      contractVersion: { const: PROVIDER_CONTRACT_VERSION },
      operationId: uuid,
      requestedAt: instant,
      intentRef: opaqueRef,
      capability: { const: capability },
      action: { enum: capabilityMutationOperations[capability] },
      input: inputSchemas[capability],
    },
  };
}

function operationResultBranch(capability: ProviderCapability): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "transportVersion",
      "contractVersion",
      "capability",
      "operationId",
      "status",
      "revision",
      "observedAt",
    ],
    properties: {
      transportVersion: { const: PROVIDER_TRANSPORT_VERSION },
      contractVersion: { const: PROVIDER_CONTRACT_VERSION },
      capability: { const: capability },
      operationId: uuid,
      status: { enum: ["pending", "succeeded", "failed", "unknown"] },
      revision: { type: "integer", minimum: 1 },
      observedAt: instant,
      output: outputSchemas[capability],
      error: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message", "retryable"],
        properties: {
          code: { type: "string", pattern: "^[a-z][a-z0-9_.-]{1,79}$" },
          message: { type: "string", minLength: 1, maxLength: 500 },
          retryable: { type: "boolean" },
        },
      },
    },
    allOf: [
      {
        if: { properties: { status: { const: "succeeded" } }, required: ["status"] },
        then: {
          properties: { output: outputSchemas[capability] },
          required: ["output"],
          not: { type: "object", properties: { error: {} }, required: ["error"] },
        },
      },
      {
        if: { properties: { status: { const: "failed" } }, required: ["status"] },
        then: {
          properties: {
            error: {
              type: "object",
              additionalProperties: false,
              required: ["code", "message", "retryable"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                retryable: { type: "boolean" },
              },
            },
          },
          required: ["error"],
        },
      },
    ],
  };
}

export const providerManifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.opensales.system/provider/v1/manifest.schema.json",
  $comment: "SPDX-License-Identifier: Apache-2.0",
  title: "OpenSales System Provider Manifest v1",
  description: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY. Public Provider installation declaration.",
  type: "object",
  additionalProperties: false,
  required: [
    "manifestVersion",
    "providerId",
    "displayName",
    "description",
    "endpointBaseUrl",
    "publisher",
    "license",
    "capabilities",
    "permissions",
    "limits",
    "retention",
    "lifecycle",
  ],
  properties: {
    manifestVersion: { const: "v1" },
    providerId: { type: "string", pattern: "^[a-z][a-z0-9.-]{2,99}$" },
    displayName: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", minLength: 1, maxLength: 1000 },
    endpointBaseUrl: { type: "string", format: "uri" },
    publisher: {
      type: "object",
      additionalProperties: false,
      required: ["name", "website", "supportUrl"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 160 },
        website: { type: "string", format: "uri" },
        supportUrl: { type: "string", format: "uri" },
      },
    },
    license: {
      type: "object",
      additionalProperties: false,
      required: ["identifier", "url"],
      properties: {
        identifier: { type: "string", minLength: 1, maxLength: 80 },
        url: { type: "string", format: "uri" },
      },
    },
    capabilities: {
      type: "array",
      minItems: 1,
      maxItems: providerCapabilities.length,
      items: {
        oneOf: providerCapabilities.map((capability) => ({
          type: "object",
          additionalProperties: false,
          required: ["capability", "contractVersion", "operations", "eventSubscriptions"],
          properties: {
            capability: { const: capability },
            contractVersion: { const: PROVIDER_CONTRACT_VERSION },
            operations: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { enum: capabilityOperations[capability] },
            },
            eventSubscriptions: {
              type: "array",
              uniqueItems: true,
              items: { type: "string", pattern: "^[a-z][a-z0-9_.-]{2,119}$" },
            },
          },
        })),
      },
    },
    permissions: {
      type: "object",
      additionalProperties: false,
      required: ["scopes", "dataFields", "secrets"],
      properties: {
        scopes: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z][a-z0-9_.-]{2,119}$" },
        },
        dataFields: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z][a-z0-9_.-]{2,119}$" },
        },
        secrets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "purpose", "required", "rotation"],
            properties: {
              name: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,79}$" },
              purpose: { type: "string", minLength: 1, maxLength: 240 },
              required: { type: "boolean" },
              rotation: { enum: ["supported", "required"] },
            },
          },
        },
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["maxConcurrentOperations", "maxAmountMinor", "maxOwnedResources"],
      properties: {
        maxConcurrentOperations: { type: "integer", minimum: 1 },
        maxAmountMinor: { anyOf: [minorUnits, { type: "null" }] },
        maxOwnedResources: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
      },
    },
    retention: {
      type: "object",
      additionalProperties: false,
      required: ["operationDays", "eventDays", "piiDays"],
      properties: {
        operationDays: { type: "integer", minimum: 1 },
        eventDays: { type: "integer", minimum: 1 },
        piiDays: { type: "integer", minimum: 0 },
      },
    },
    lifecycle: {
      type: "object",
      additionalProperties: false,
      required: [
        "supportsPause",
        "supportsCredentialRotation",
        "supportsManualTakeover",
        "uninstallRequiresNoUnknownOperations",
        "uninstallRequiresNoOwnedResources",
        "uninstallRequiresNoPendingFunds",
      ],
      properties: {
        supportsPause: { type: "boolean" },
        supportsCredentialRotation: { type: "boolean" },
        supportsManualTakeover: { type: "boolean" },
        uninstallRequiresNoUnknownOperations: { type: "boolean" },
        uninstallRequiresNoOwnedResources: { type: "boolean" },
        uninstallRequiresNoPendingFunds: { type: "boolean" },
      },
    },
  },
} as const;

export const providerOperationRequestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.opensales.system/provider/v1alpha1/operation-request.schema.json",
  $comment: "SPDX-License-Identifier: Apache-2.0",
  title: "OpenSales System Provider Operation Request v1alpha1",
  description: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY. Idempotent Provider operation request.",
  oneOf: providerCapabilities.map(operationRequestBranch),
} as const;

export const providerOperationResultSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.opensales.system/provider/v1alpha1/operation-result.schema.json",
  $comment: "SPDX-License-Identifier: Apache-2.0",
  title: "OpenSales System Provider Operation Result v1alpha1",
  description: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY. External result fact; Core retains business decision authority.",
  oneOf: providerCapabilities.map(operationResultBranch),
} as const;

export const providerEventSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.opensales.system/provider/v1alpha1/event.schema.json",
  $comment: "SPDX-License-Identifier: Apache-2.0",
  title: "OpenSales System Provider Event v1alpha1",
  description: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY. At-least-once external Provider fact event.",
  type: "object",
  additionalProperties: false,
  required: [
    "transportVersion",
    "contractVersion",
    "eventId",
    "providerId",
    "capability",
    "operationId",
    "sequence",
    "eventType",
    "observedAt",
    "result",
  ],
  properties: {
    transportVersion: { const: PROVIDER_TRANSPORT_VERSION },
    contractVersion: { const: PROVIDER_CONTRACT_VERSION },
    eventId: uuid,
    providerId: { type: "string", pattern: "^[a-z][a-z0-9.-]{2,99}$" },
    capability: { enum: providerCapabilities },
    operationId: uuid,
    sequence: { type: "integer", minimum: 1 },
    eventType: {
      enum: ["operation.pending", "operation.succeeded", "operation.failed", "operation.unknown"],
    },
    observedAt: instant,
    result: providerOperationResultSchema,
  },
  allOf: [
    ...providerCapabilities.map((capability) => ({
      if: {
        type: "object",
        properties: { capability: { const: capability } },
        required: ["capability"],
      },
      then: {
        type: "object",
        properties: { result: operationResultBranch(capability) },
        required: ["result"],
      },
    })),
    ...(["pending", "succeeded", "failed", "unknown"] as const).map((status) => ({
      if: {
        type: "object",
        properties: { eventType: { const: `operation.${status}` } },
        required: ["eventType"],
      },
      then: {
        type: "object",
        properties: {
          result: {
            type: "object",
            properties: { status: { const: status } },
            required: ["status"],
          },
        },
        required: ["result"],
      },
    })),
  ],
} as const;

export const providerEventPageSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.opensales.system/provider/v1/event-page.schema.json",
  $comment: "SPDX-License-Identifier: Apache-2.0",
  title: "OpenSales System Provider Event Page v1",
  description: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY. Cursor page of external Provider fact events.",
  type: "object",
  additionalProperties: false,
  required: ["events", "nextCursor"],
  properties: {
    events: { type: "array", maxItems: 1000, items: providerEventSchema },
    nextCursor: { anyOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "null" }] },
  },
} as const;

export const providerSchemaDocuments = {
  manifest: providerManifestSchema,
  "operation-request": providerOperationRequestSchema,
  "operation-result": providerOperationResultSchema,
  event: providerEventSchema,
  "event-page": providerEventPageSchema,
} as const;
