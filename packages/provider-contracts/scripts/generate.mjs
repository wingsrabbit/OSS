#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_CONTRACT_VERSION,
  capabilityOperations,
  providerCapabilities,
  providerSchemaDocuments,
} from "../dist/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const schemas = Object.fromEntries(
  Object.entries(providerSchemaDocuments).map(([kind, schema]) => [
    kind,
    Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "$id")),
  ]),
);

const paths = {};
for (const capability of providerCapabilities) {
  const segment = `/v1alpha1/${capability}/operations`;
  paths[segment] = {
    post: {
      operationId: `${capability.replaceAll("_", "-")}-execute`,
      summary: `Execute one idempotent ${capability} operation`,
      parameters: [
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "Must equal body.operationId. Reuse with a different request is a conflict.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              allOf: [
                { $ref: "#/components/schemas/OperationRequest" },
                {
                  type: "object",
                  properties: { capability: { const: capability } },
                  required: ["capability"],
                },
              ],
            },
          },
        },
      },
      responses: {
        "202": {
          description: "Accepted Provider fact; status may require reconciliation.",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/OperationResult" },
                  {
                    type: "object",
                    properties: { capability: { const: capability } },
                    required: ["capability"],
                  },
                ],
              },
            },
          },
        },
        "409": { description: "Idempotency key conflict" },
        "504": { description: "Outcome unknown; query the operation before another mutation" },
      },
    },
  };
  paths[`${segment}/{operationId}`] = {
    get: {
      operationId: `${capability.replaceAll("_", "-")}-reconcile`,
      summary: `Reconcile one ${capability} operation without creating a new side effect`,
      parameters: [
        { name: "operationId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      responses: {
        "200": {
          description: "Current Provider fact",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/OperationResult" },
                  {
                    type: "object",
                    properties: { capability: { const: capability } },
                    required: ["capability"],
                  },
                ],
              },
            },
          },
        },
        "404": { description: "Unknown operation" },
      },
    },
  };
}

paths["/v1/manifest"] = {
  get: {
    operationId: "get-provider-manifest",
    summary: "Read declared versions, capabilities, permissions, data, secrets, limits, retention, and lifecycle guards",
    responses: {
      "200": {
        description: "Provider manifest",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Manifest" } } },
      },
    },
  },
};
paths["/v1/events"] = {
  get: {
    operationId: "list-provider-events",
    summary: "Read at-least-once Provider events; consumers deduplicate by eventId and reject stale sequence numbers",
    parameters: [
      { name: "operationId", in: "query", required: true, schema: { type: "string", format: "uuid" } },
      { name: "cursor", in: "query", required: false, schema: { type: "string" } },
    ],
    responses: {
      "200": {
        description: "Event page",
        content: { "application/json": { schema: { $ref: "#/components/schemas/EventPage" } } },
      },
    },
  },
};

const openapi = {
  openapi: "3.1.0",
  info: {
    title: "OpenSales System Provider API",
    version: PROVIDER_CONTRACT_VERSION,
    description: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY. Apache-2.0 public process-boundary contract.",
    license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
  },
  servers: [{ url: "https://provider.example.test/provider" }],
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: {
      Manifest: schemas.manifest,
      OperationRequest: schemas["operation-request"],
      OperationResult: schemas["operation-result"],
      Event: schemas.event,
      EventPage: schemas["event-page"],
    },
  },
};

const reference = `<!-- SPDX-License-Identifier: Apache-2.0 -->

# Generated Provider contract reference

> **NOT FOR PRODUCTION — MOCK PROVIDERS ONLY**

Generated from the normative JSON Schema definitions. Do not edit this file by hand.

- Transport envelope: \`v1\`
- Capability contracts: \`${PROVIDER_CONTRACT_VERSION}\`
- Delivery: at least once; deduplicate \`eventId\` and preserve the greatest accepted \`sequence\`
- Mutation identity: body \`operationId\` equals \`Idempotency-Key\`
- Timeout: unknown outcome; use the GET reconciliation endpoint before another mutation

## Capabilities

${providerCapabilities.map((capability) => `### ${capability}\n\n${capabilityOperations[capability].map((operation) => `- \`${operation}\``).join("\n")}`).join("\n\n")}

## Published artifacts

- \`openapi/provider-api.v1alpha1.openapi.json\`
- \`schemas/manifest.schema.json\`
- \`schemas/operation-request.schema.json\`
- \`schemas/operation-result.schema.json\`
- \`schemas/event.schema.json\`
- \`schemas/event-page.schema.json\`
`;

const outputs = new Map([
  ["generated/openapi/provider-api.v1alpha1.openapi.json", json(openapi)],
  ["generated/REFERENCE.md", reference],
  ...Object.entries(providerSchemaDocuments).map(([kind, schema]) => [
    `generated/schemas/${kind}.schema.json`,
    json(schema),
  ]),
]);

let stale = false;
for (const [relativePath, content] of outputs) {
  const path = resolve(packageRoot, relativePath);
  if (check) {
    const existing = await readFile(path, "utf8").catch(() => undefined);
    if (existing !== content) {
      console.error(`generated artifact is stale: ${relativePath}`);
      stale = true;
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    console.log(`generated ${relativePath}`);
  }
}

if (stale) process.exitCode = 1;
