// SPDX-License-Identifier: Apache-2.0

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  parseProviderOperationRequest,
  type ProviderCapability,
} from "@opensales/provider-contracts";
import { createExampleOperation, exampleManifest, type StoredExampleOperation } from "./provider.js";

const port = Number.parseInt(process.env.EXAMPLE_PROVIDER_PORT ?? "4401", 10);
const token = process.env.EXAMPLE_PROVIDER_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("EXAMPLE_PROVIDER_PORT is invalid");
if (!token || token.length < 32) throw new Error("EXAMPLE_PROVIDER_TOKEN must contain at least 32 synthetic characters");
const baseUrl = process.env.EXAMPLE_PROVIDER_BASE_URL ?? `http://127.0.0.1:${port}`;
const manifest = exampleManifest(baseUrl);
const operations = new Map<string, StoredExampleOperation>();

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 128 * 1024) throw new Error("request body exceeds 128 KiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", baseUrl);
    if (request.method === "GET" && url.pathname === "/health/ready") {
      return send(response, 200, { status: "ready" });
    }
    if (request.method === "GET" && url.pathname === "/v1/manifest") {
      return send(response, 200, manifest);
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      return send(response, 401, { error: "invalid Provider credential" });
    }
    const createMatch = /^\/v1alpha1\/([a-z_]+)\/operations$/.exec(url.pathname);
    if (request.method === "POST" && createMatch) {
      const body = parseProviderOperationRequest(await readJson(request));
      if (createMatch[1] !== body.capability || request.headers["idempotency-key"] !== body.operationId) {
        return send(response, 400, { error: "capability or idempotency key mismatch" });
      }
      const candidate = await createExampleOperation(manifest.providerId, body);
      const existing = operations.get(body.operationId);
      if (existing && existing.fingerprint !== candidate.fingerprint) {
        return send(response, 409, { error: "idempotency key conflict" });
      }
      if (!existing) operations.set(body.operationId, candidate);
      return send(response, 202, (existing ?? candidate).result, {
        "x-oss-idempotent-replay": existing ? "true" : "false",
      });
    }
    const reconcileMatch = /^\/v1alpha1\/([a-z_]+)\/operations\/([0-9a-f-]+)$/.exec(url.pathname);
    if (request.method === "GET" && reconcileMatch) {
      const operation = operations.get(reconcileMatch[2] ?? "");
      if (!operation || operation.result.capability !== (reconcileMatch[1] as ProviderCapability)) {
        return send(response, 404, { error: "operation not found" });
      }
      return send(response, 200, operation.result);
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      const operation = operations.get(url.searchParams.get("operationId") ?? "");
      if (!operation) return send(response, 404, { error: "operation not found" });
      return send(response, 200, { events: [operation.event], nextCursor: null });
    }
    return send(response, 404, { error: "route not found" });
  } catch (error) {
    return send(response, 400, { error: error instanceof Error ? error.message : "invalid request" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Official SDK example Provider listening on ${baseUrl}`);
  console.log("NOT FOR PRODUCTION — MOCK PROVIDERS ONLY");
});
