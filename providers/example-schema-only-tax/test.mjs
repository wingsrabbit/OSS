// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

test("schema-only example runs without the official SDK and reconciles its Tax fact", async () => {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve());
  });
  const token = "synthetic-schema-only-provider-token-0001";
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [new URL("server.mjs", import.meta.url).pathname], {
    env: { ...process.env, SCHEMA_ONLY_PROVIDER_PORT: String(port), SCHEMA_ONLY_PROVIDER_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetch(`${baseUrl}/health/ready`)).ok) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const operationId = "00000000-0000-4000-8000-000000000009";
    const request = {
      transportVersion: "v1",
      contractVersion: "v1alpha1",
      operationId,
      requestedAt: "2026-08-13T00:00:00.000Z",
      intentRef: "independent-tax-example",
      capability: "tax",
      action: "tax.quote",
      input: {
        currency: "USD",
        jurisdictionCountry: "US",
        lines: [{ lineRef: "line-1", amountMinor: "1999", taxCode: "general" }],
      },
    };
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": operationId };
    const created = await fetch(`${baseUrl}/v1alpha1/tax/operations`, { method: "POST", headers, body: JSON.stringify(request) });
    assert.equal(created.status, 202);
    assert.equal((await created.json()).output.totalTaxMinor, "100");
    const replay = await fetch(`${baseUrl}/v1alpha1/tax/operations`, { method: "POST", headers, body: JSON.stringify(request) });
    assert.equal(replay.headers.get("x-oss-idempotent-replay"), "true");
    const reconciled = await fetch(`${baseUrl}/v1alpha1/tax/operations/${operationId}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await reconciled.json()).status, "succeeded");
    const events = await fetch(`${baseUrl}/v1/events?operationId=${operationId}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await events.json()).events.length, 1);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
});
