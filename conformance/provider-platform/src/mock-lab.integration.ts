// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import {
  prepareRestartConformance,
  runCompleteMockConformance,
  verifyRestartConformance,
  type ConformanceTarget,
} from "./conformance.js";

const databaseUrl = process.env.PROVIDER_DATABASE_URL;
const token = process.env.MOCK_PROVIDER_PLATFORM_TOKEN;
const expectedDatabaseName = process.env.PROVIDER_CONFORMANCE_DATABASE_NAME;
if (!databaseUrl) throw new Error("PROVIDER_DATABASE_URL is required");
if (!token || token.length < 32) {
  throw new Error("MOCK_PROVIDER_PLATFORM_TOKEN must contain at least 32 synthetic characters");
}
if (expectedDatabaseName) {
  const parsedDatabaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  if (parsedDatabaseName !== expectedDatabaseName) {
    throw new Error(
      `PROVIDER_DATABASE_URL targets ${parsedDatabaseName || "no database"}; expected ${expectedDatabaseName}`,
    );
  }
}

async function reservePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolveReady, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolveReady);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a Provider port");
  await new Promise<void>((resolveClosed, reject) => {
    reservation.close((error) => error ? reject(error) : resolveClosed());
  });
  return address.port;
}

const port = process.env.PROVIDER_CONFORMANCE_PORT
  ? Number.parseInt(process.env.PROVIDER_CONFORMANCE_PORT, 10)
  : await reservePort();
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PROVIDER_CONFORMANCE_PORT must be a valid TCP port");
}
const baseUrl = `http://127.0.0.1:${port}`;
const target: ConformanceTarget = { baseUrl, token };
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const serverPath = resolve(repositoryRoot, "providers/mock-lab/dist/server.js");

async function startProvider(): Promise<{ child: ChildProcess; output: () => string }> {
  let captured = "";
  const child = spawn(process.execPath, [serverPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PROVIDER_DATABASE_URL: databaseUrl,
      MOCK_PROVIDER_PLATFORM_TOKEN: token,
      MOCK_PROVIDER_PUBLIC_BASE_URL: baseUrl,
      CORE_CALLBACK_URL: "http://127.0.0.1:4398",
      PROVIDER_HOST: "127.0.0.1",
      PROVIDER_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: Buffer) => {
    captured = `${captured}${chunk.toString("utf8")}`.slice(-40_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Mock Provider exited before readiness:\n${captured}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return { child, output: () => captured };
    } catch {
      // The child is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  child.kill("SIGTERM");
  throw new Error(`Mock Provider did not become ready:\n${captured}`);
}

async function stopProvider(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  assert.equal(child.kill("SIGTERM"), true);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await once(child, "exit");
  clearTimeout(timeout);
}

let running: Awaited<ReturnType<typeof startProvider>> | undefined;
try {
  running = await startProvider();
  const report = await runCompleteMockConformance(target);
  const restartPlan = await prepareRestartConformance(target);
  await stopProvider(running.child);
  running = undefined;

  running = await startProvider();
  const restarted = await verifyRestartConformance(target, restartPlan);
  console.log(JSON.stringify({
    warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
    ...report,
    restartOperationsReconciled: restarted,
  }, null, 2));
} catch (error) {
  if (running) console.error(running.output());
  throw error;
} finally {
  if (running) await stopProvider(running.child);
}
