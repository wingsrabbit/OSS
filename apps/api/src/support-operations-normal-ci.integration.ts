// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import pg from "pg";

const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL;
const apiRolePassword = process.env.DATABASE_API_ROLE_PASSWORD;
const workerRolePassword = process.env.DATABASE_WORKER_ROLE_PASSWORD;
if (!adminDatabaseUrl || !apiRolePassword || !workerRolePassword) {
  throw new Error(
    "ADMIN_DATABASE_URL, DATABASE_API_ROLE_PASSWORD, and DATABASE_WORKER_ROLE_PASSWORD are required",
  );
}
const requiredAdminDatabaseUrl: string = adminDatabaseUrl;

// This setup uses supported migration/bootstrap entry points plus public HTTP.
// It deliberately creates no identity, Session, permission, or reauth row fixtures.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const marker = randomUUID().replaceAll("-", "");
const applicationDatabaseName = `oss_support_normal_${marker}`;
const providerDatabaseName = `provider_support_normal_${marker}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "oss-support-normal-"));
const bootstrapCredentialPath = join(temporaryDirectory, "bootstrap.json");
const children: ManagedChild[] = [];
const createdDatabases: string[] = [];
const admin = new pg.Client({ connectionString: requiredAdminDatabaseUrl });

type JsonObject = Readonly<Record<string, unknown>>;

type ManagedChild = Readonly<{
  label: string;
  process: ChildProcessByStdio<null, Readable, Readable>;
  output: string[];
}>;

type Identity = Readonly<{
  email: string;
  password: string;
  clientName: string;
}>;

function databaseUrl(
  databaseName: string,
  credentials?: Readonly<{ username: string; password: string }>,
): string {
  const url = new URL(requiredAdminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  if (credentials) {
    url.username = credentials.username;
    url.password = credentials.password;
  }
  return url.toString();
}

function quotedDatabaseName(databaseName: string): string {
  assert.match(databaseName, /^(?:oss|provider)_support_normal_[a-f0-9]{32}$/);
  return `"${databaseName}"`;
}

function childEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

function appendTail(lines: string[], chunk: Buffer): void {
  lines.push(chunk.toString("utf8"));
  while (lines.join("").length > 16_000) lines.shift();
}

function startChild(
  label: string,
  modulePath: string,
  environment: Readonly<Record<string, string>>,
): ManagedChild {
  const child = spawn(process.execPath, [modulePath], {
    cwd: repositoryRoot,
    env: childEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => appendTail(output, chunk));
  child.stderr.on("data", (chunk: Buffer) => appendTail(output, chunk));
  child.on("error", (error) => output.push(error.message));
  const managed = { label, process: child, output };
  children.push(managed);
  return managed;
}

async function runChild(
  label: string,
  modulePath: string,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  const child = spawn(process.execPath, [modulePath], {
    cwd: repositoryRoot,
    env: childEnvironment(environment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`${label} exited with ${exitCode}: ${stderr || stdout}`);
  }
  return stdout;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

async function waitForReady(child: ManagedChild, url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "not started";
  while (Date.now() < deadline) {
    if (child.process.exitCode !== null) {
      throw new Error(
        `${child.label} exited before readiness (${child.process.exitCode}): ${child.output.join("")}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${child.label}: ${lastError}`);
}

async function stopChild(child: ManagedChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  child.process.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => child.process.once("exit", () => resolveExit(true))),
    new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
  if (!exited && child.process.exitCode === null) {
    child.process.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.process.once("exit", () => resolveExit()));
  }
}

class HttpSession {
  private readonly cookies = new Map<string, string>();
  accountContextVersion: string | null = null;

  constructor(private readonly baseUrl: string) {}

  get cookie(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async request<T extends JsonObject>(
    path: string,
    input: Readonly<{ method?: "GET" | "POST"; payload?: unknown }> = {},
    expectedStatus = 200,
  ): Promise<T> {
    const method = input.method ?? "GET";
    const headers = new Headers();
    if (input.payload !== undefined) headers.set("content-type", "application/json");
    if (this.cookie) headers.set("cookie", this.cookie);
    if (method !== "GET" && this.accountContextVersion !== null) {
      headers.set("x-oss-account-context-version", this.accountContextVersion);
    }
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers,
      ...(input.payload === undefined ? {} : { body: JSON.stringify(input.payload) }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    const accountContextVersion = response.headers.get("x-oss-account-context-version");
    if (accountContextVersion) this.accountContextVersion = accountContextVersion;
    const raw = await response.text();
    if (response.status !== expectedStatus) {
      throw new Error(
        `${method} ${path} expected ${expectedStatus}, received ${response.status}: ${raw}`,
      );
    }
    return (raw ? JSON.parse(raw) : {}) as T;
  }
}

function syntheticIdentity(label: string): Identity {
  return {
    email: `support-normal-${label}-${marker}@example.invalid`,
    password: `Normal-${label}-${randomUUID()}-Aa1!`,
    clientName: `Support Normal ${label} ${marker.slice(0, 8)}`,
  };
}

async function registerAndVerify(
  baseUrl: string,
  label: string,
): Promise<Readonly<{ session: HttpSession; identity: Identity }>> {
  const session = new HttpSession(baseUrl);
  const identity = syntheticIdentity(label);
  await session.request("/api/v1/auth/register", {
    method: "POST",
    payload: { ...identity, locale: "en" },
  }, 201);
  await session.request("/api/v1/auth/login", {
    method: "POST",
    payload: { email: identity.email, password: identity.password },
  });
  const pending = await session.request<{ eligible: boolean; verification: { email: string } }>(
    "/api/v1/auth/me",
  );
  assert.equal(pending.eligible, false);
  assert.equal(pending.verification.email, "pending");

  const deadline = Date.now() + 60_000;
  let verificationToken: string | null = null;
  while (Date.now() < deadline && !verificationToken) {
    const mailbox = await session.request<{
      messages: Array<{ template: string; body: string }>;
    }>("/api/v1/lab/mailbox");
    const verificationUrl = mailbox.messages
      .filter((message) => message.template === "email-verification")
      .map((message) => message.body.match(/https?:\/\/\S+/)?.[0])
      .find((url): url is string => Boolean(url));
    verificationToken = verificationUrl
      ? new URL(verificationUrl).searchParams.get("token")
      : null;
    if (!verificationToken) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  assert.ok(verificationToken, `Mock Mail did not deliver verification for ${label}`);
  await session.request("/api/v1/auth/verify-email", {
    method: "POST",
    payload: { token: verificationToken },
  });
  const verified = await session.request<{ eligible: boolean }>("/api/v1/auth/me");
  assert.equal(verified.eligible, true);
  assert.ok(session.cookie, `${label} session cookie is missing`);
  assert.ok(session.accountContextVersion, `${label} account context is missing`);
  return { session, identity };
}

await admin.connect();
try {
  for (const databaseName of [applicationDatabaseName, providerDatabaseName]) {
    await admin.query(`CREATE DATABASE ${quotedDatabaseName(databaseName)}`);
    createdDatabases.push(databaseName);
  }

  const applicationMigrationUrl = databaseUrl(applicationDatabaseName);
  const applicationApiUrl = databaseUrl(applicationDatabaseName, {
    username: "oss_api",
    password: apiRolePassword,
  });
  const applicationWorkerUrl = databaseUrl(applicationDatabaseName, {
    username: "oss_worker",
    password: workerRolePassword,
  });
  const providerDatabaseUrl = databaseUrl(providerDatabaseName);

  await runChild("Support normal migration", join(repositoryRoot, "apps/api/dist/migrate.js"), {
    DATABASE_URL: applicationMigrationUrl,
    MIGRATION_DATABASE_URL: applicationMigrationUrl,
  });

  await runChild(
    "Support normal bootstrap credential",
    join(repositoryRoot, "apps/api/dist/create-bootstrap-token.js"),
    {
      DATABASE_URL: applicationApiUrl,
      DATABASE_RUNTIME_ROLE: "oss_api",
      BOOTSTRAP_TOKEN_OUTPUT_FILE: bootstrapCredentialPath,
    },
  );
  const bootstrapCredential = JSON.parse(await readFile(bootstrapCredentialPath, "utf8")) as {
    token?: unknown;
  };
  assert.equal(typeof bootstrapCredential.token, "string");

  const providerPort = await reserveLoopbackPort();
  const apiPort = await reserveLoopbackPort();
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const provider = startChild(
    "Mock Mail Provider",
    join(repositoryRoot, "providers/mock-lab/dist/server.js"),
    {
      PROVIDER_DATABASE_URL: providerDatabaseUrl,
      PROVIDER_HOST: "127.0.0.1",
      PROVIDER_PORT: String(providerPort),
      CORE_CALLBACK_URL: apiBaseUrl,
    },
  );
  await waitForReady(provider, `${providerBaseUrl}/health/ready`);

  const api = startChild("OpenSales API", join(repositoryRoot, "apps/api/dist/server.js"), {
    DATABASE_URL: applicationApiUrl,
    DATABASE_RUNTIME_ROLE: "oss_api",
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    OSS_PUBLIC_URL: apiBaseUrl,
    WEB_ORIGIN: apiBaseUrl,
    MOCK_MAILBOX_URL: providerBaseUrl,
    LAB_MAILBOX_ENABLED: "true",
  });
  await waitForReady(api, `${apiBaseUrl}/health/ready`);

  const worker = startChild("OpenSales Worker", join(repositoryRoot, "apps/worker/dist/worker.js"), {
    DATABASE_URL: applicationWorkerUrl,
    DATABASE_RUNTIME_ROLE: "oss_worker",
    MOCK_PAYMENT_PROVIDER_URL: providerBaseUrl,
    MOCK_PROVISIONING_PROVIDER_URL: providerBaseUrl,
    MOCK_PROVIDER_PLATFORM_URL: providerBaseUrl,
    MOCK_MAIL_PROVIDER_URL: providerBaseUrl,
    CORE_INTERNAL_URL: apiBaseUrl,
    CORE_CALLBACK_URL: apiBaseUrl,
    OSS_PUBLIC_URL: apiBaseUrl,
    WORKER_ID: `support-normal-${marker}`,
    WORKER_POLL_MS: "50",
    MOCK_PROVISION_SCENARIO: "success",
    MOCK_SERVICE_OPERATION_SCENARIO: "normal",
  });

  const administrator = await registerAndVerify(apiBaseUrl, "administrator");
  await administrator.session.request("/api/v1/admin/bootstrap", {
    method: "POST",
    payload: { bootstrapToken: bootstrapCredential.token },
  }, 201);
  await administrator.session.request("/api/v1/auth/reauth", {
    method: "POST",
    payload: { password: administrator.identity.password },
  });
  const customer = await registerAndVerify(apiBaseUrl, "customer");
  const otherCustomer = await registerAndVerify(apiBaseUrl, "other-customer");

  if (worker.process.exitCode !== null) {
    throw new Error(`OpenSales Worker exited early: ${worker.output.join("")}`);
  }
  let journeyOutput: string;
  try {
    journeyOutput = await runChild(
      "Support operations normal public-API journey",
      join(repositoryRoot, "apps/api/dist/support-operations-normal.integration.js"),
      {
        SUPPORT_NORMAL_BASE_URL: apiBaseUrl,
        SUPPORT_NORMAL_CUSTOMER_COOKIE: customer.session.cookie,
        SUPPORT_NORMAL_OTHER_CUSTOMER_COOKIE: otherCustomer.session.cookie,
        SUPPORT_NORMAL_STAFF_COOKIE: administrator.session.cookie,
        SUPPORT_NORMAL_ACCOUNT_CONTEXT_VERSION: customer.session.accountContextVersion ?? "1",
      },
    );
  } catch (error) {
    const diagnostics = children
      .map((child) => `${child.label}:\n${child.output.join("").trim()}`)
      .filter((entry) => !entry.endsWith(":\n"))
      .join("\n");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}` +
        (diagnostics ? `\nService diagnostics:\n${diagnostics}` : ""),
      { cause: error },
    );
  }
  process.stdout.write(journeyOutput);
  process.stdout.write("Support operations normal CI setup: PASS\n");
} finally {
  for (const child of children.reverse()) {
    await stopChild(child).catch(() => undefined);
  }
  for (const databaseName of createdDatabases.reverse()) {
    await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabaseName(databaseName)} WITH (FORCE)`)
      .catch(() => undefined);
  }
  await admin.end().catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
