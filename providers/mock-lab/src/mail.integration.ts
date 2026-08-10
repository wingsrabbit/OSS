// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) {
  throw new Error("ADMIN_DATABASE_URL is required for Mock Mail integration");
}

const providerToken = "synthetic-mock-mail-provider-token-0000000000000000";
const databaseName = `oss_mock_mail_${randomUUID().replaceAll("-", "")}`;
const testDatabaseUrl = new URL(adminDatabaseUrl);
testDatabaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: adminDatabaseUrl });
let provider: ChildProcess | null = null;
let providerLogs = "";
let databaseCreated = false;

type MailDeliveryFact = {
  operationId: string;
  status: "delivered" | "bounced" | "failed";
  deliveredAt: string;
};

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "an ephemeral TCP port must be allocated");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForProvider(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (provider?.exitCode !== null) {
      throw new Error(`Mock Provider exited before readiness:\n${providerLogs}`);
    }
    try {
      const response = await fetch(new URL("/health/ready", baseUrl), {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The child may still be initializing its isolated PostgreSQL schema.
    }
    await delay(100);
  }
  throw new Error(`Mock Provider did not become ready:\n${providerLogs}`);
}

async function stopProvider(): Promise<void> {
  if (!provider || provider.exitCode !== null) return;
  provider.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => provider?.once("exit", () => resolve(true))),
    delay(2_000).then(() => false),
  ]);
  if (!exited && provider.exitCode === null) {
    provider.kill("SIGKILL");
    await new Promise<void>((resolve) => provider?.once("exit", () => resolve()));
  }
}

function startProvider(connectionString: string, port: number): void {
  providerLogs = "";
  provider = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PROVIDER_DATABASE_URL: connectionString,
      MOCK_MAIL_PROVIDER_TOKEN: providerToken,
      CORE_CALLBACK_URL: "http://127.0.0.1:1",
      PROVIDER_HOST: "127.0.0.1",
      PROVIDER_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  provider.stdout?.on("data", (chunk: Buffer) => {
    providerLogs += chunk.toString("utf8");
  });
  provider.stderr?.on("data", (chunk: Buffer) => {
    providerLogs += chunk.toString("utf8");
  });
}

function providerHeaders(operationId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${providerToken}`,
    ...(operationId ? { "Idempotency-Key": operationId } : {}),
    "Content-Type": "application/json",
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;

  const providerPort = await reservePort();
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;
  startProvider(testDatabaseUrl.toString(), providerPort);
  await waitForProvider(providerBaseUrl);

  const operationId = randomUUID();
  const missingOperationId = randomUUID();
  const privateRecipient = `private-${operationId}@example.invalid`;
  const privateSubject = `private subject ${operationId}`;
  const privateBody = `private body ${operationId}`;
  const message = {
    operationId,
    recipient: privateRecipient,
    template: "integration.mail",
    locale: "en" as const,
    subject: privateSubject,
    body: privateBody,
    sensitive: true,
  };

  const unauthenticated = await fetch(
    new URL(`/v1/mail/${missingOperationId}`, providerBaseUrl),
  );
  assert.equal(unauthenticated.status, 401);

  const wrongCredential = await fetch(
    new URL(`/v1/mail/${missingOperationId}`, providerBaseUrl),
    { headers: { Authorization: `Bearer ${"x".repeat(providerToken.length)}` } },
  );
  assert.equal(wrongCredential.status, 401);

  const invalidUuid = await fetch(new URL("/v1/mail/not-a-uuid", providerBaseUrl), {
    headers: providerHeaders(),
  });
  assert.equal(invalidUuid.status, 400);
  assert.deepEqual(await responseJson(invalidUuid), { error: "operationId must be a UUID" });

  const missing = await fetch(
    new URL(`/v1/mail/${missingOperationId}`, providerBaseUrl),
    { headers: providerHeaders() },
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(await responseJson(missing), { error: "operation not found" });

  const created = await fetch(new URL("/v1/mail", providerBaseUrl), {
    method: "POST",
    headers: providerHeaders(operationId),
    body: JSON.stringify(message),
  });
  assert.equal(created.status, 202);
  const createdFact = await responseJson<MailDeliveryFact>(created);
  assert.deepEqual(Object.keys(createdFact).sort(), ["deliveredAt", "operationId", "status"]);
  assert.equal(createdFact.operationId, operationId);
  assert.equal(createdFact.status, "delivered");
  assert.ok(!Number.isNaN(Date.parse(createdFact.deliveredAt)));

  const found = await fetch(new URL(`/v1/mail/${operationId}?source=reconcile`, providerBaseUrl), {
    headers: providerHeaders(),
  });
  assert.equal(found.status, 200);
  const foundText = await found.text();
  const foundFact = JSON.parse(foundText) as MailDeliveryFact;
  assert.deepEqual(foundFact, createdFact);
  assert.deepEqual(Object.keys(foundFact).sort(), ["deliveredAt", "operationId", "status"]);
  for (const secret of [privateRecipient, privateSubject, privateBody, providerToken]) {
    assert.equal(foundText.includes(secret), false, "delivery result must not expose PII or secrets");
  }

  const replay = await fetch(new URL("/v1/mail", providerBaseUrl), {
    method: "POST",
    headers: providerHeaders(operationId),
    body: JSON.stringify(message),
  });
  assert.equal(replay.status, 202);
  assert.deepEqual(await responseJson<MailDeliveryFact>(replay), createdFact);

  const explicitDefaultReplay = await fetch(
    new URL("/v1/mail?source=idempotent-replay", providerBaseUrl),
    {
      method: "POST",
      headers: providerHeaders(operationId),
      body: JSON.stringify({ ...message, scenario: "delivered" }),
    },
  );
  assert.equal(explicitDefaultReplay.status, 202);
  assert.deepEqual(await responseJson<MailDeliveryFact>(explicitDefaultReplay), createdFact);

  const concurrentReplays = await Promise.all(
    [undefined, "delivered" as const].map((scenario) =>
      fetch(new URL("/v1/mail", providerBaseUrl), {
        method: "POST",
        headers: providerHeaders(operationId),
        body: JSON.stringify({ ...message, ...(scenario ? { scenario } : {}) }),
      }),
    ),
  );
  for (const concurrentReplay of concurrentReplays) {
    assert.equal(concurrentReplay.status, 202);
    assert.deepEqual(await responseJson<MailDeliveryFact>(concurrentReplay), createdFact);
  }

  const conflicting = await fetch(new URL("/v1/mail", providerBaseUrl), {
    method: "POST",
    headers: providerHeaders(operationId),
    body: JSON.stringify({ ...message, subject: `${privateSubject} changed` }),
  });
  assert.equal(conflicting.status, 409);
  assert.deepEqual(await responseJson(conflicting), {
    error: "idempotency key was reused with a different message",
  });

  const afterConflict = await fetch(new URL(`/v1/mail/${operationId}`, providerBaseUrl), {
    headers: providerHeaders(),
  });
  assert.equal(afterConflict.status, 200);
  assert.deepEqual(await responseJson<MailDeliveryFact>(afterConflict), createdFact);

  const verification = new pg.Client({ connectionString: testDatabaseUrl.toString() });
  await verification.connect();
  try {
    const stored = await verification.query<{
      recipient: string;
      subject: string;
      body: string;
      status: string;
      delivery_calls: number;
    }>(
      `SELECT recipient::text, subject, body, status, delivery_calls
       FROM mock_mail_messages
       WHERE operation_id = $1`,
      [operationId],
    );
    assert.deepEqual(stored.rows[0], {
      recipient: privateRecipient,
      subject: privateSubject,
      body: privateBody,
      status: "delivered",
      delivery_calls: 5,
    });
    await assert.rejects(
      verification.query(
        `UPDATE mock_mail_messages
         SET recipient = upper(recipient::text)::citext,
             delivery_calls = delivery_calls + 1
         WHERE operation_id = $1`,
        [operationId],
      ),
      /Mock mail messages are append-only except for idempotent delivery call counting/,
    );
  } finally {
    await verification.end();
  }

  for (const scenario of ["bounced", "failed"] as const) {
    const scenarioOperationId = randomUUID();
    const scenarioMessage = {
      ...message,
      operationId: scenarioOperationId,
      recipient: `${scenario}-${scenarioOperationId}@example.invalid`,
      scenario,
    };
    const scenarioCreated = await fetch(new URL("/v1/mail", providerBaseUrl), {
      method: "POST",
      headers: providerHeaders(scenarioOperationId),
      body: JSON.stringify(scenarioMessage),
    });
    assert.equal(scenarioCreated.status, 202);
    const scenarioFact = await responseJson<MailDeliveryFact>(scenarioCreated);
    assert.equal(scenarioFact.status, scenario);
    const scenarioFound = await fetch(
      new URL(`/v1/mail/${scenarioOperationId}`, providerBaseUrl),
      { headers: providerHeaders() },
    );
    assert.equal(scenarioFound.status, 200);
    assert.deepEqual(await responseJson<MailDeliveryFact>(scenarioFound), scenarioFact);
  }

  await stopProvider();
  provider = null;
  startProvider(testDatabaseUrl.toString(), providerPort);
  await waitForProvider(providerBaseUrl);
  const afterExistingDatabaseRestart = await fetch(
    new URL(`/v1/mail/${operationId}`, providerBaseUrl),
    { headers: providerHeaders() },
  );
  assert.equal(afterExistingDatabaseRestart.status, 200);
  assert.deepEqual(
    await responseJson<MailDeliveryFact>(afterExistingDatabaseRestart),
    createdFact,
    "Provider initialization must preserve existing immutable Mock Mail facts",
  );

  console.log("Mock Mail result query integration: PASS");
} finally {
  await stopProvider();
  if (databaseCreated) {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  }
  await admin.end().catch(() => undefined);
}
