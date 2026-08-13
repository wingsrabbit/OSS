// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { runPublicProviderConformance } from "./conformance.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

async function reservePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolveReady, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolveReady);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve an example port");
  await new Promise<void>((resolveClosed, reject) => {
    reservation.close((error) => error ? reject(error) : resolveClosed());
  });
  return address.port;
}

async function start(
  commandPath: string,
  port: number,
  token: string,
  environment: Record<string, string>,
): Promise<{ child: ChildProcess; output: () => string }> {
  let captured = "";
  const child = spawn(process.execPath, [commandPath], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: Buffer) => {
    captured = `${captured}${chunk.toString("utf8")}`.slice(-20_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Example exited before readiness:\n${captured}`);
    try {
      if ((await fetch(`${baseUrl}/health/ready`)).ok) return { child, output: () => captured };
    } catch {
      // The example is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  child.kill("SIGTERM");
  throw new Error(`Example did not become ready:\n${captured}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

const officialPort = await reservePort();
const officialToken = "synthetic-official-example-token-000001";
let running = await start(
  resolve(repositoryRoot, "providers/example-sdk/dist/server.js"),
  officialPort,
  officialToken,
  { EXAMPLE_PROVIDER_PORT: String(officialPort), EXAMPLE_PROVIDER_TOKEN: officialToken },
);
try {
  const operations = await runPublicProviderConformance({
    baseUrl: `http://127.0.0.1:${officialPort}`,
    token: officialToken,
  });
  console.log(`official SDK example: ${operations} capability journeys passed`);
} catch (error) {
  console.error(running.output());
  throw error;
} finally {
  await stop(running.child);
}

const schemaPort = await reservePort();
const schemaToken = "synthetic-schema-only-example-token-0001";
running = await start(
  resolve(repositoryRoot, "providers/example-schema-only-tax/server.mjs"),
  schemaPort,
  schemaToken,
  {
    SCHEMA_ONLY_PROVIDER_PORT: String(schemaPort),
    SCHEMA_ONLY_PROVIDER_TOKEN: schemaToken,
  },
);
try {
  const operations = await runPublicProviderConformance({
    baseUrl: `http://127.0.0.1:${schemaPort}`,
    token: schemaToken,
  });
  console.log(`independent schema-only example: ${operations} capability journey passed`);
} catch (error) {
  console.error(running.output());
  throw error;
} finally {
  await stop(running.child);
}

console.log("NOT FOR PRODUCTION — MOCK PROVIDERS ONLY");
