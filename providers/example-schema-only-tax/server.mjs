// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import Ajv2020 from "ajv/dist/2020.js";

const schemaRoot = new URL("../../packages/provider-contracts/generated/schemas/", import.meta.url);
const readSchema = async (name) => JSON.parse(await readFile(new URL(name, schemaRoot), "utf8"));
const [manifestSchema, requestSchema, resultSchema, eventSchema, eventPageSchema] = await Promise.all([
  readSchema("manifest.schema.json"),
  readSchema("operation-request.schema.json"),
  readSchema("operation-result.schema.json"),
  readSchema("event.schema.json"),
  readSchema("event-page.schema.json"),
]);

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
ajv.addFormat("date-time", (value) => Number.isFinite(Date.parse(value)));
ajv.addFormat("email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
ajv.addFormat("uri", (value) => {
  try { return new URL(value).protocol.length > 1; } catch { return false; }
});

const validateManifest = ajv.compile(manifestSchema);
const validateRequest = ajv.compile(requestSchema);
const validateResult = ajv.compile(resultSchema);
const validateEvent = ajv.compile(eventSchema);
const validateEventPage = ajv.compile(eventPageSchema);

function assertValid(validator, value, label) {
  if (!validator(value)) {
    throw new Error(`${label} does not match the public schema: ${ajv.errorsText(validator.errors)}`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("unsupported JSON value");
}

const port = Number.parseInt(process.env.SCHEMA_ONLY_PROVIDER_PORT ?? "4402", 10);
const token = process.env.SCHEMA_ONLY_PROVIDER_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SCHEMA_ONLY_PROVIDER_PORT is invalid");
if (!token || token.length < 32) throw new Error("SCHEMA_ONLY_PROVIDER_TOKEN must contain at least 32 synthetic characters");
const baseUrl = process.env.SCHEMA_ONLY_PROVIDER_BASE_URL ?? `http://127.0.0.1:${port}`;

const manifest = {
  manifestVersion: "v1",
  providerId: "independent.schema-only.synthetic-tax",
  displayName: "Independent schema-only synthetic Tax example",
  description: "An external-style Tax Provider built without the official SDK or Core imports.",
  endpointBaseUrl: baseUrl,
  publisher: {
    name: "Independent example author",
    website: "https://example.test",
    supportUrl: "https://example.test/support",
  },
  license: { identifier: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
  capabilities: [{
    capability: "tax",
    contractVersion: "v1alpha1",
    operations: ["tax.quote", "tax.reconcile"],
    eventSubscriptions: ["core.tax.requested"],
  }],
  permissions: {
    scopes: ["tax.operate"],
    dataFields: ["minor_units_and_currency", "synthetic_tax_jurisdiction"],
    secrets: [{ name: "SCHEMA_ONLY_PROVIDER_TOKEN", purpose: "Bearer credential", required: true, rotation: "supported" }],
  },
  limits: { maxConcurrentOperations: 4, maxAmountMinor: "1000000", maxOwnedResources: null },
  retention: { operationDays: 1, eventDays: 1, piiDays: 0 },
  lifecycle: {
    supportsPause: true,
    supportsCredentialRotation: true,
    supportsManualTakeover: true,
    uninstallRequiresNoUnknownOperations: true,
    uninstallRequiresNoOwnedResources: false,
    uninstallRequiresNoPendingFunds: false,
  },
};
assertValid(validateManifest, manifest, "manifest");

const operations = new Map();

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error("request exceeds 128 KiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", baseUrl);
    if (request.method === "GET" && url.pathname === "/health/ready") return send(response, 200, { status: "ready" });
    if (request.method === "GET" && url.pathname === "/v1/manifest") return send(response, 200, manifest);
    if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "invalid Provider credential" });

    if (request.method === "POST" && url.pathname === "/v1alpha1/tax/operations") {
      const body = await readBody(request);
      assertValid(validateRequest, body, "operation request");
      if (body.capability !== "tax" || request.headers["idempotency-key"] !== body.operationId) {
        return send(response, 400, { error: "Tax capability or Idempotency-Key mismatch" });
      }
      const fingerprint = createHash("sha256").update(canonicalJson(body)).digest("hex");
      const existing = operations.get(body.operationId);
      if (existing && existing.fingerprint !== fingerprint) return send(response, 409, { error: "idempotency key conflict" });
      if (!existing) {
        const lines = body.input.lines.map((line) => ({
          lineRef: line.lineRef,
          taxMinor: ((BigInt(line.amountMinor) * 500n + 5_000n) / 10_000n).toString(),
          rateBasisPoints: 500,
        }));
        const observedAt = new Date().toISOString();
        const result = {
          transportVersion: "v1",
          contractVersion: "v1alpha1",
          capability: "tax",
          operationId: body.operationId,
          status: "succeeded",
          revision: 1,
          observedAt,
          output: {
            externalQuoteRef: `schema-only-tax-${body.operationId}`,
            currency: body.input.currency,
            totalTaxMinor: lines.reduce((sum, line) => sum + BigInt(line.taxMinor), 0n).toString(),
            lines,
          },
        };
        assertValid(validateResult, result, "operation result");
        const event = {
          transportVersion: "v1",
          contractVersion: "v1alpha1",
          eventId: randomUUID(),
          providerId: manifest.providerId,
          capability: "tax",
          operationId: body.operationId,
          sequence: 1,
          eventType: "operation.succeeded",
          observedAt,
          result,
        };
        assertValid(validateEvent, event, "Provider event");
        operations.set(body.operationId, { fingerprint, result, event });
      }
      const operation = operations.get(body.operationId);
      return send(response, 202, operation.result, { "x-oss-idempotent-replay": existing ? "true" : "false" });
    }

    const reconcileMatch = /^\/v1alpha1\/tax\/operations\/([0-9a-f-]+)$/.exec(url.pathname);
    if (request.method === "GET" && reconcileMatch) {
      const operation = operations.get(reconcileMatch[1]);
      return operation ? send(response, 200, operation.result) : send(response, 404, { error: "operation not found" });
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      const operation = operations.get(url.searchParams.get("operationId"));
      if (!operation) return send(response, 404, { error: "operation not found" });
      const page = { events: [operation.event], nextCursor: null };
      assertValid(validateEventPage, page, "event page");
      return send(response, 200, page);
    }
    return send(response, 404, { error: "route not found" });
  } catch (error) {
    return send(response, 400, { error: error instanceof Error ? error.message : "invalid request" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Independent schema-only Tax example listening on ${baseUrl}`);
  console.log("NOT FOR PRODUCTION — MOCK PROVIDERS ONLY");
});
