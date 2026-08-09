// SPDX-License-Identifier: AGPL-3.0-or-later
// NOT FOR PRODUCTION — MOCK PROVIDERS ONLY

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAB_WARNING, runDemoSmoke } from "./demo-smoke.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeDir = join(root, ".demo", "local");
const configFile = join(runtimeDir, "config.json");
const stateFile = join(runtimeDir, "state.json");
const postgresData = join(runtimeDir, "postgres");
// PostgreSQL includes the directory in its Unix-socket pathname. Keeping this
// outside a potentially long repository path avoids macOS's 103-byte limit.
const postgresSocket = join(
  tmpdir(),
  `oss-demo-pg-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
);
const logsDir = join(runtimeDir, "logs");
const ownerRole = "oss_demo_owner";
const processNames = Object.freeze([
  "provider-payment",
  "provider-provisioning",
  "provider-mail",
  "provider-mailbox",
  "api",
  "worker",
  "web",
]);

const defaultPorts = Object.freeze({
  postgres: 55_432,
  api: 3_000,
  web: 5_173,
  payment: 4_101,
  provisioning: 4_102,
  mail: 4_103,
  mailbox: 4_104,
});

function demoUrls(config) {
  const baseUrl = `http://127.0.0.1:${config.ports.web}`;
  return {
    public: `${baseUrl}/`,
    customer: `${baseUrl}/customer`,
    admin: `${baseUrl}/admin`,
  };
}

function printDemoUrls(config) {
  const urls = demoUrls(config);
  console.log(`Public URL: ${urls.public}`);
  console.log(`Customer URL: ${urls.customer}`);
  console.log(`Admin URL: ${urls.admin}`);
}

function secureToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function ensureRuntimeDirectories() {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  mkdirSync(postgresSocket, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  chmodSync(postgresSocket, 0o700);
}

function writePrivateJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function createConfig() {
  ensureRuntimeDirectories();
  const existing = readJson(configFile, null);
  if (existing) return existing;
  const config = {
    warning: LAB_WARNING,
    createdAt: new Date().toISOString(),
    ports: defaultPorts,
    secrets: {
      apiDatabasePassword: secureToken(),
      workerDatabasePassword: secureToken(),
      paymentProviderToken: secureToken(),
      provisioningProviderToken: secureToken(),
      mailProviderToken: secureToken(),
      mailboxToken: secureToken(),
      providerOperationCapabilitySecret: secureToken(),
      paymentWebhookSecret: secureToken(),
      provisioningWebhookSecret: secureToken(),
      paymentMethodTokenKey: secureToken(32),
      paymentMethodTokenLookupKey: secureToken(32),
    },
  };
  writePrivateJson(configFile, config);
  return config;
}

function commandResult(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `${binary} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function repositoryRevision() {
  const revision = commandResult("git", ["rev-parse", "--verify", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`Unable to identify the local Demo source revision: ${revision}`);
  }
  return revision;
}

function executableVersion(binary, args = ["--version"]) {
  try {
    return commandResult(binary, args);
  } catch {
    return null;
  }
}

function resolveExactNode() {
  const candidates = [process.env.OSS_NODE_BIN, process.execPath];
  const temporaryRoot = "/private/tmp";
  if (existsSync(temporaryRoot)) {
    for (const entry of readdirSync(temporaryRoot)) {
      if (!entry.startsWith("oss-node24.")) continue;
      candidates.push(
        join(temporaryRoot, entry, "node-v24.18.0-darwin-arm64", "bin", "node"),
        join(temporaryRoot, entry, "node-v24.18.0-darwin-x64", "bin", "node"),
      );
    }
  }
  candidates.push("/opt/homebrew/opt/node@24/bin/node", "/usr/local/opt/node@24/bin/node");
  for (const candidate of candidates.filter(Boolean)) {
    if (existsSync(candidate) && executableVersion(candidate) === "v24.18.0") return candidate;
  }
  throw new Error(
    "Node 24.18.0 is required. Set OSS_NODE_BIN to the exact node executable before starting the demo.",
  );
}

function resolvePostgresBin() {
  const candidates = [
    process.env.OSS_PG_BIN,
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const postgres = join(candidate, "postgres");
    if (existsSync(postgres) && /PostgreSQL\) 18\./.test(executableVersion(postgres) ?? "")) {
      return candidate;
    }
  }
  throw new Error(
    "PostgreSQL 18 is required. Set OSS_PG_BIN to the directory containing postgres, pg_ctl, initdb, psql, and createdb.",
  );
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function state() {
  const current = readJson(stateFile, {
    warning: LAB_WARNING,
    processes: {},
    latestSmoke: null,
  });
  if (
    !current.administratorAccount &&
    current.latestSmoke?.syntheticAccount?.administrator
  ) {
    current.administratorAccount = current.latestSmoke.syntheticAccount;
  }
  return current;
}

function saveState(next) {
  ensureRuntimeDirectories();
  writePrivateJson(stateFile, { warning: LAB_WARNING, ...next });
}

function postgresUrl(config, database, role = ownerRole, password = "") {
  const credentials = password
    ? `${encodeURIComponent(role)}:${encodeURIComponent(password)}`
    : encodeURIComponent(role);
  return `postgresql://${credentials}@127.0.0.1:${config.ports.postgres}/${database}`;
}

function commonCoreEnvironment(config) {
  return {
    OSS_ENV: "development",
    OSS_LOG_LEVEL: "info",
    OSS_PUBLIC_URL: `http://127.0.0.1:${config.ports.web}`,
    WEB_ORIGIN: `http://127.0.0.1:${config.ports.web}`,
    SESSION_COOKIE_NAME: "oss_demo_session",
    LAB_MAILBOX_ENABLED: "true",
    LAB_MAILBOX_TOKEN: config.secrets.mailboxToken,
    MOCK_MAILBOX_URL: `http://127.0.0.1:${config.ports.mailbox}`,
    PROVIDER_OPERATION_CAPABILITY_SECRET: config.secrets.providerOperationCapabilitySecret,
    PAYMENT_METHOD_TOKEN_KEY: config.secrets.paymentMethodTokenKey,
    PAYMENT_METHOD_TOKEN_KEY_VERSION: "1",
    PAYMENT_METHOD_TOKEN_PREVIOUS_KEYS: "",
    PAYMENT_METHOD_TOKEN_LOOKUP_KEY: config.secrets.paymentMethodTokenLookupKey,
    PAYMENT_METHOD_TOKEN_LOOKUP_KEY_VERSION: "1",
    PAYMENT_METHOD_TOKEN_LOOKUP_PREVIOUS_KEYS: "",
    OSS_SCHEMA_ROLLBACK_BRIDGE: "disabled",
    MOCK_PAYMENT_WEBHOOK_SECRET: config.secrets.paymentWebhookSecret,
    MOCK_PROVISIONING_WEBHOOK_SECRET: config.secrets.provisioningWebhookSecret,
  };
}

function apiEnvironment(config) {
  return {
    ...commonCoreEnvironment(config),
    DATABASE_URL: postgresUrl(
      config,
      "oss",
      "oss_api",
      config.secrets.apiDatabasePassword,
    ),
    DATABASE_RUNTIME_ROLE: "oss_api",
    API_HOST: "127.0.0.1",
    API_PORT: String(config.ports.api),
  };
}

function workerEnvironment(config) {
  return {
    DATABASE_URL: postgresUrl(
      config,
      "oss",
      "oss_worker",
      config.secrets.workerDatabasePassword,
    ),
    DATABASE_RUNTIME_ROLE: "oss_worker",
    MOCK_PAYMENT_PROVIDER_URL: `http://127.0.0.1:${config.ports.payment}`,
    MOCK_PROVISIONING_PROVIDER_URL: `http://127.0.0.1:${config.ports.provisioning}`,
    MOCK_MAIL_PROVIDER_URL: `http://127.0.0.1:${config.ports.mail}`,
    MOCK_PAYMENT_PROVIDER_TOKEN: config.secrets.paymentProviderToken,
    MOCK_PROVISIONING_PROVIDER_TOKEN: config.secrets.provisioningProviderToken,
    MOCK_MAIL_PROVIDER_TOKEN: config.secrets.mailProviderToken,
    PROVIDER_OPERATION_CAPABILITY_SECRET: config.secrets.providerOperationCapabilitySecret,
    PAYMENT_METHOD_TOKEN_KEY: config.secrets.paymentMethodTokenKey,
    PAYMENT_METHOD_TOKEN_KEY_VERSION: "1",
    PAYMENT_METHOD_TOKEN_PREVIOUS_KEYS: "",
    OSS_SCHEMA_ROLLBACK_BRIDGE: "disabled",
    MOCK_PAYMENT_WEBHOOK_SECRET: config.secrets.paymentWebhookSecret,
    MOCK_PROVISIONING_WEBHOOK_SECRET: config.secrets.provisioningWebhookSecret,
    CORE_INTERNAL_URL: `http://127.0.0.1:${config.ports.api}`,
    MOCK_PROVISION_SCENARIO: "success",
    MOCK_RESOURCE_ACTION_SCENARIO: "success",
  };
}

function providerEnvironment(config, kind) {
  const base = {
    PROVIDER_HOST: "127.0.0.1",
    CORE_CALLBACK_URL: `http://127.0.0.1:${config.ports.api}`,
  };
  if (kind === "payment") {
    return {
      ...base,
      PROVIDER_PORT: String(config.ports.payment),
      PROVIDER_DATABASE_URL: postgresUrl(config, "payment_provider"),
      MOCK_PAYMENT_PROVIDER_TOKEN: config.secrets.paymentProviderToken,
      MOCK_PAYMENT_WEBHOOK_SECRET: config.secrets.paymentWebhookSecret,
    };
  }
  if (kind === "provisioning") {
    return {
      ...base,
      PROVIDER_PORT: String(config.ports.provisioning),
      PROVIDER_DATABASE_URL: postgresUrl(config, "provisioning_provider"),
      MOCK_PROVISIONING_PROVIDER_TOKEN: config.secrets.provisioningProviderToken,
      MOCK_PROVISIONING_WEBHOOK_SECRET: config.secrets.provisioningWebhookSecret,
    };
  }
  if (kind === "mail") {
    return {
      ...base,
      PROVIDER_PORT: String(config.ports.mail),
      PROVIDER_DATABASE_URL: postgresUrl(config, "mail_provider"),
      MOCK_MAIL_PROVIDER_TOKEN: config.secrets.mailProviderToken,
    };
  }
  return {
    ...base,
    PROVIDER_PORT: String(config.ports.mailbox),
    PROVIDER_DATABASE_URL: postgresUrl(config, "mail_provider"),
    LAB_MAILBOX_TOKEN: config.secrets.mailboxToken,
  };
}

function assertDependenciesPresent() {
  const required = [
    "packages/core/node_modules/typescript/bin/tsc",
    "apps/api/node_modules/typescript/bin/tsc",
    "apps/worker/node_modules/typescript/bin/tsc",
    "providers/mock-lab/node_modules/typescript/bin/tsc",
    "apps/web/node_modules/typescript/bin/tsc",
    "apps/web/node_modules/vite/bin/vite.js",
  ];
  const missing = required.filter((path) => !existsSync(join(root, path)));
  if (missing.length > 0) {
    throw new Error(
      `Local dependencies are missing (${missing.join(", ")}). Install the frozen workspace dependencies before running the demo.`,
    );
  }
}

function buildWorkspace(node) {
  if (process.env.OSS_DEMO_SKIP_BUILD === "1") return;
  assertDependenciesPresent();
  console.log("Building API, Worker, Web, Core, and Mock Provider with Node 24.18.0...");
  commandResult(node, [
    "packages/core/node_modules/typescript/bin/tsc",
    "-p",
    "packages/core/tsconfig.json",
  ]);
  for (const [compiler, project] of [
    ["apps/api/node_modules/typescript/bin/tsc", "apps/api/tsconfig.json"],
    ["apps/worker/node_modules/typescript/bin/tsc", "apps/worker/tsconfig.json"],
    ["providers/mock-lab/node_modules/typescript/bin/tsc", "providers/mock-lab/tsconfig.json"],
  ]) {
    commandResult(node, [compiler, "-p", project]);
  }
  commandResult(node, [
    "apps/web/node_modules/typescript/bin/tsc",
    "-b",
    "apps/web/tsconfig.json",
    "--pretty",
    "false",
  ]);
}

function postgresIsRunning(pgBin) {
  if (!existsSync(join(postgresData, "PG_VERSION"))) return false;
  const result = spawnSync(join(pgBin, "pg_ctl"), ["-D", postgresData, "status"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0;
}

function postmasterPid() {
  const pidFile = join(postgresData, "postmaster.pid");
  if (!existsSync(pidFile)) return null;
  const value = Number.parseInt(readFileSync(pidFile, "utf8").split("\n", 1)[0] ?? "", 10);
  return Number.isInteger(value) && value > 1 ? value : null;
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
    cwd: root,
    encoding: "utf8",
  });
  const command = (result.stdout ?? "").trim();
  if (result.status === 1 && command.length === 0) return null;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Unable to inspect tracked Demo PostgreSQL PID ${pid}${detail ? `: ${detail}` : ""}`,
    );
  }
  return command || null;
}

function commandHasArgument(command, flag, value) {
  const fragment = `${flag} ${value}`;
  return command.includes(` ${fragment} `) || command.endsWith(` ${fragment}`);
}

function commandTargetsDemoPostgres(command, config) {
  const executable = command.split(" ", 1)[0] ?? "";
  return (
    executable.endsWith("/postgres") &&
    commandHasArgument(command, "-D", postgresData) &&
    commandHasArgument(command, "-h", "127.0.0.1") &&
    commandHasArgument(command, "-p", String(config.ports.postgres)) &&
    commandHasArgument(command, "-k", postgresSocket)
  );
}

function processListensOnDemoPostgresPort(pid, config) {
  const endpoint = `127.0.0.1:${config.ports.postgres}`;
  const result = spawnSync(
    "lsof",
    [
      "-nP",
      "-a",
      "-p",
      String(pid),
      `-iTCP@${endpoint}`,
      "-sTCP:LISTEN",
      "-F",
      "pcn",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status === 1 && !(result.stdout ?? "").trim()) return false;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Unable to inspect tracked Demo PostgreSQL listener${detail ? `: ${detail}` : ""}`,
    );
  }
  const fields = (result.stdout ?? "").trim().split("\n");
  return (
    fields.includes(`p${pid}`) &&
    fields.includes("cpostgres") &&
    fields.includes(`n${endpoint}`)
  );
}

function recordPostgresProcess(config, currentState) {
  const pid = postmasterPid();
  if (!pid) throw new Error("Demo PostgreSQL started without a valid postmaster PID");
  const argv = processCommand(pid);
  if (!argv || !commandTargetsDemoPostgres(argv, config)) {
    throw new Error("Demo PostgreSQL process arguments do not match the configured data directory");
  }
  if (!processListensOnDemoPostgresPort(pid, config)) {
    throw new Error("Demo PostgreSQL process is not listening on its configured loopback port");
  }
  currentState.postgresProcess = {
    pid,
    argv,
    dataDir: postgresData,
    host: "127.0.0.1",
    port: config.ports.postgres,
    socketDir: postgresSocket,
  };
  saveState(currentState);
}

function inspectTrackedPostgres(config, currentState) {
  const tracked = currentState.postgresProcess;
  if (!tracked) return { tracked: null, running: false };
  if (
    !Number.isInteger(tracked.pid) ||
    tracked.pid <= 1 ||
    tracked.dataDir !== postgresData ||
    tracked.host !== "127.0.0.1" ||
    tracked.port !== config.ports.postgres ||
    tracked.socketDir !== postgresSocket ||
    typeof tracked.argv !== "string"
  ) {
    throw new Error(
      "Refusing to stop an unverified PostgreSQL process: stored Demo process identity does not match this runtime",
    );
  }
  const pidFromFile = postmasterPid();
  if (pidFromFile !== null && pidFromFile !== tracked.pid) {
    throw new Error(
      "Refusing to stop an unverified PostgreSQL process: postmaster PID differs from the stored Demo PID",
    );
  }
  const argv = processCommand(tracked.pid);
  if (argv === null) return { tracked, running: false };
  if (argv !== tracked.argv || !commandTargetsDemoPostgres(argv, config)) {
    throw new Error(
      "Refusing to stop an unverified PostgreSQL process: current argv does not exactly match the stored Demo process",
    );
  }
  if (!processListensOnDemoPostgresPort(tracked.pid, config)) {
    throw new Error(
      "Refusing to stop an unverified PostgreSQL process: the stored PID is not listening on the Demo PostgreSQL port",
    );
  }
  return { tracked, running: true };
}

async function stopTrackedPostgresOrphan(config, currentState) {
  const inspected = inspectTrackedPostgres(config, currentState);
  if (!inspected.tracked) return false;
  if (!inspected.running) {
    delete currentState.postgresProcess;
    saveState(currentState);
    return false;
  }
  console.log(
    `Stopping verified orphaned Demo PostgreSQL process (pid ${inspected.tracked.pid})...`,
  );
  process.kill(inspected.tracked.pid, "SIGINT");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const argv = processCommand(inspected.tracked.pid);
    if (argv === null) break;
    if (argv !== inspected.tracked.argv) {
      throw new Error(
        "Tracked Demo PostgreSQL PID changed identity while waiting for shutdown; refusing further action",
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (processCommand(inspected.tracked.pid) !== null) {
    throw new Error("Verified orphaned Demo PostgreSQL did not stop within 10 seconds");
  }
  if (processListensOnDemoPostgresPort(inspected.tracked.pid, config)) {
    throw new Error("Verified orphaned Demo PostgreSQL stopped but its loopback listener remains");
  }
  delete currentState.postgresProcess;
  saveState(currentState);
  return true;
}

function startPostgres(config, pgBin, currentState) {
  ensureRuntimeDirectories();
  if (!existsSync(join(postgresData, "PG_VERSION"))) {
    console.log("Initializing an isolated synthetic PostgreSQL 18 cluster...");
    commandResult(join(pgBin, "initdb"), [
      "-D",
      postgresData,
      "--username",
      ownerRole,
      "--auth",
      "trust",
      "--encoding",
      "UTF8",
      "--no-locale",
    ]);
  }
  if (postgresIsRunning(pgBin)) {
    recordPostgresProcess(config, currentState);
    return;
  }
  commandResult(join(pgBin, "pg_ctl"), [
    "-D",
    postgresData,
    "-l",
    join(logsDir, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${config.ports.postgres} -k ${postgresSocket} -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
    "-w",
    "start",
  ]);
  recordPostgresProcess(config, currentState);
}

function createDatabase(config, pgBin, database) {
  const query = commandResult(join(pgBin, "psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(config.ports.postgres),
    "-U",
    ownerRole,
    "-d",
    "postgres",
    "-Atc",
    `SELECT 1 FROM pg_database WHERE datname = '${database}'`,
  ]);
  if (query === "1") return;
  commandResult(join(pgBin, "createdb"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(config.ports.postgres),
    "-U",
    ownerRole,
    database,
  ]);
}

function prepareDatabases(config, pgBin, node) {
  for (const database of ["oss", "payment_provider", "provisioning_provider", "mail_provider"]) {
    createDatabase(config, pgBin, database);
  }
  const migrationEnvironment = {
    ...apiEnvironment(config),
    MIGRATION_DATABASE_URL: postgresUrl(config, "oss"),
    DATABASE_API_ROLE_PASSWORD: config.secrets.apiDatabasePassword,
    DATABASE_WORKER_ROLE_PASSWORD: config.secrets.workerDatabasePassword,
  };
  console.log("Applying the latest native schema (018) and synthetic catalog seed...");
  commandResult(node, ["apps/api/dist/migrate.js"], { env: migrationEnvironment });
  commandResult(node, ["apps/api/dist/seed-termrat.js"], { env: apiEnvironment(config) });
}

function tailLog(name, lineCount = 24) {
  const path = join(logsDir, `${name}.log`);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").split("\n").slice(-lineCount).join("\n").trim();
}

function startDetached(name, node, args, environment, currentState) {
  const existingPid = currentState.processes?.[name];
  if (processIsAlive(existingPid)) return existingPid;
  const logPath = join(logsDir, `${name}.log`);
  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(node, args, {
    cwd: name === "web" ? join(root, "apps", "web") : root,
    env: { ...process.env, ...environment },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  currentState.processes = { ...currentState.processes, [name]: child.pid };
  saveState(currentState);
  return child.pid;
}

async function waitForHttp(name, url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
  const log = tailLog(name);
  throw new Error(
    `${name} did not become ready at ${url}: ${lastError}${log ? `\n${log}` : ""}`,
  );
}

async function startProcesses(config, node, currentState) {
  const mockServer = ["providers/mock-lab/dist/server.js"];
  startDetached("provider-payment", node, mockServer, providerEnvironment(config, "payment"), currentState);
  startDetached(
    "provider-provisioning",
    node,
    mockServer,
    providerEnvironment(config, "provisioning"),
    currentState,
  );
  startDetached("provider-mail", node, mockServer, providerEnvironment(config, "mail"), currentState);
  await Promise.all([
    waitForHttp("provider-payment", `http://127.0.0.1:${config.ports.payment}/health/ready`),
    waitForHttp(
      "provider-provisioning",
      `http://127.0.0.1:${config.ports.provisioning}/health/ready`,
    ),
    waitForHttp("provider-mail", `http://127.0.0.1:${config.ports.mail}/health/ready`),
  ]);

  // Mail and mailbox intentionally share one Mock-only database. Starting them
  // serially avoids a PostgreSQL CREATE EXTENSION bootstrap race.
  startDetached("provider-mailbox", node, mockServer, providerEnvironment(config, "mailbox"), currentState);
  await waitForHttp(
    "provider-mailbox",
    `http://127.0.0.1:${config.ports.mailbox}/health/ready`,
  );

  startDetached("api", node, ["apps/api/dist/server.js"], apiEnvironment(config), currentState);
  await waitForHttp("api", `http://127.0.0.1:${config.ports.api}/health/ready`);

  startDetached("worker", node, ["apps/worker/dist/worker.js"], workerEnvironment(config), currentState);
  startDetached(
    "web",
    node,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(config.ports.web)],
    { OSS_API_PROXY_TARGET: `http://127.0.0.1:${config.ports.api}` },
    currentState,
  );
  await waitForHttp("web", `http://127.0.0.1:${config.ports.web}/`);
}

function createBootstrapToken(config, node, currentState) {
  if (
    currentState.administratorAccount?.administrator ||
    currentState.latestSmoke?.syntheticAccount?.administrator
  ) {
    return undefined;
  }
  const outputFile = join(runtimeDir, `bootstrap-${process.pid}-${secureToken(6)}.json`);
  try {
    commandResult(node, ["apps/api/dist/create-bootstrap-token.js"], {
      env: { ...apiEnvironment(config), BOOTSTRAP_TOKEN_OUTPUT_FILE: outputFile },
    });
    const token = readJson(outputFile, null)?.token;
    return typeof token === "string" ? token : undefined;
  } catch (error) {
    console.warn(
      "Administrator bootstrap was skipped; the database may already contain a first administrator.",
    );
    return undefined;
  } finally {
    if (existsSync(outputFile)) rmSync(outputFile);
  }
}

function printResult(config, currentState, stackRunning = true) {
  const result = currentState.latestSmoke;
  console.log(
    stackRunning
      ? "\nOpenSales System local demo is ready."
      : "\nOpenSales System local demo is stopped; latest verified synthetic result:",
  );
  console.log(LAB_WARNING);
  printDemoUrls(config);
  console.log(`Code revision: ${currentState.runtimeRevision ?? "unknown"}`);
  if (result?.syntheticAccount) {
    console.log(`Latest synthetic customer login: ${result.syntheticAccount.email}`);
    console.log(`Latest synthetic customer password: ${result.syntheticAccount.password}`);
    console.log(`Latest synthetic customer Client Account ID: ${result.syntheticAccount.clientAccountId}`);
    console.log(
      `Smoke: order ${result.journey.orderStatus}, invoice ${result.journey.invoiceStatus}, payment ${result.journey.paymentStatus}, service ${result.journey.serviceStatus}`,
    );
  }
  if (result?.supportTicket) {
    console.log(`Synthetic support ticket ID: ${result.supportTicket.ticketId}`);
    console.log(`Synthetic Staff internal note ID: ${result.supportTicket.internalNoteId}`);
    console.log(
      `Support smoke: service linked ${result.supportTicket.serviceId}, internal note customer visible ${result.supportTicket.internalNoteCustomerVisible}`,
    );
  } else {
    console.log("Support smoke: unavailable in the latest stored result");
  }
  const administrator =
    currentState.administratorAccount ??
    (result?.syntheticAccount?.administrator ? result.syntheticAccount : null);
  if (administrator) {
    console.log(`Synthetic administrator login: ${administrator.email}`);
    console.log(`Synthetic administrator password: ${administrator.password}`);
    console.log(`Synthetic administrator Client Account ID: ${administrator.clientAccountId}`);
  } else {
    console.log("Synthetic administrator: unavailable (an administrator may already exist in this Demo database)");
  }
  if (result?.manualReceiptOutflow) {
    console.log(`Manual receipt target Client Account ID: ${result.manualReceiptOutflow.clientAccountId}`);
    console.log(`Synthetic manual receipt ID: ${result.manualReceiptOutflow.manualReceiptId}`);
    console.log(`Synthetic fund receipt ID: ${result.manualReceiptOutflow.fundReceiptId}`);
    console.log(`Synthetic outflow report ID: ${result.manualReceiptOutflow.outflowReportId}`);
    console.log(`Synthetic confirmed outflow ID: ${result.manualReceiptOutflow.outflowId}`);
    console.log(
      `Manual receipt smoke: status ${result.manualReceiptOutflow.status}, Provider used ${result.manualReceiptOutflow.providerUsed}`,
    );
  } else {
    console.log("Manual receipt smoke: skipped because no synthetic administrator credential was available");
  }
  console.log(`Credentials/state: ${stateFile}`);
  console.log(`Logs: ${logsDir}`);
  console.log(
    stackRunning
      ? "Stop: node tools/demo-local.mjs down"
      : "Start: node tools/demo-local.mjs up",
  );
}

async function up() {
  const config = createConfig();
  const node = resolveExactNode();
  const pgBin = resolvePostgresBin();
  const sourceRevision = repositoryRevision();
  let currentState = state();
  currentState.processes ??= {};
  let runningProcesses = processNames.filter((name) =>
    processIsAlive(currentState.processes[name]),
  );
  let postgresRunning = postgresIsRunning(pgBin);
  if (!postgresRunning && currentState.postgresProcess) {
    await down();
    currentState = state();
    currentState.processes ??= {};
    runningProcesses = processNames.filter((name) =>
      processIsAlive(currentState.processes[name]),
    );
    postgresRunning = false;
  }
  let stackAlreadyRunning =
    postgresRunning && runningProcesses.length === processNames.length;
  if (
    (postgresRunning || runningProcesses.length > 0) &&
    currentState.runtimeRevision !== sourceRevision
  ) {
    console.log(
      `The running Demo revision ${currentState.runtimeRevision ?? "unknown"} differs from source ${sourceRevision}; preserving data while restarting and migrating forward.`,
    );
    await down();
    currentState = state();
    currentState.processes ??= {};
    runningProcesses = [];
    postgresRunning = false;
    stackAlreadyRunning = false;
  }
  if (runningProcesses.length > 0 && !stackAlreadyRunning) {
    throw new Error(
      `The local Demo is only partially running (${runningProcesses.join(", ")}). Run node tools/demo-local.mjs down, then run up again.`,
    );
  }

  let bootstrapToken;
  if (stackAlreadyRunning) {
    console.log(
      `The complete loopback Demo stack is already running at ${sourceRevision}; reusing it for a fresh smoke journey.`,
    );
  } else {
    buildWorkspace(node);
    startPostgres(config, pgBin, currentState);
    prepareDatabases(config, pgBin, node);
    bootstrapToken = createBootstrapToken(config, node, currentState);
    currentState.runtimeRevision = sourceRevision;
    saveState(currentState);
    await startProcesses(config, node, currentState);
  }
  console.log(
    "Running the synthetic customer, service-linked support ticket, and manual receipt → confirmed original-source outflow smoke journeys...",
  );
  const result = await runDemoSmoke({
    baseUrl: `http://127.0.0.1:${config.ports.web}`,
    bootstrapToken,
    administratorAccount: currentState.administratorAccount,
  });
  currentState = state();
  currentState.runtimeRevision = sourceRevision;
  currentState.latestSmoke = result;
  if (result.syntheticAccount.administrator) {
    currentState.administratorAccount = result.syntheticAccount;
  }
  currentState.lastStartedAt = new Date().toISOString();
  saveState(currentState);
  printResult(config, currentState, true);
}

async function smoke() {
  const config = createConfig();
  const node = resolveExactNode();
  const currentState = state();
  const sourceRevision = repositoryRevision();
  if (currentState.runtimeRevision !== sourceRevision) {
    throw new Error(
      `The Demo runtime revision ${currentState.runtimeRevision ?? "unknown"} differs from source ${sourceRevision}; run node tools/demo-local.mjs up to rebuild and migrate it first.`,
    );
  }
  const bootstrapToken = createBootstrapToken(config, node, currentState);
  const result = await runDemoSmoke({
    baseUrl: `http://127.0.0.1:${config.ports.web}`,
    bootstrapToken,
    administratorAccount: currentState.administratorAccount,
  });
  const refreshed = state();
  refreshed.latestSmoke = result;
  if (result.syntheticAccount.administrator) {
    refreshed.administratorAccount = result.syntheticAccount;
  }
  saveState(refreshed);
  printResult(config, refreshed, true);
}

async function stopProcess(pid) {
  if (!processIsAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processIsAlive(pid)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
}

async function down() {
  if (!existsSync(configFile)) {
    console.log("No local Demo runtime exists.");
    return;
  }
  const config = createConfig();
  const currentState = state();
  for (const name of [
    "web",
    "worker",
    "api",
    "provider-mailbox",
    "provider-mail",
    "provider-provisioning",
    "provider-payment",
  ]) {
    await stopProcess(currentState.processes?.[name]);
  }
  const pgBin = resolvePostgresBin();
  if (postgresIsRunning(pgBin)) {
    commandResult(join(pgBin, "pg_ctl"), ["-D", postgresData, "-m", "fast", "-w", "stop"]);
    delete currentState.postgresProcess;
  } else {
    await stopTrackedPostgresOrphan(config, currentState);
  }
  currentState.processes = {};
  currentState.lastStoppedAt = new Date().toISOString();
  saveState(currentState);
  console.log(`Stopped the loopback Demo stack. Synthetic data remains in ${runtimeDir}.`);
  console.log(`Restart: node tools/demo-local.mjs up`);
  printDemoUrls(config);
}

async function status() {
  if (!existsSync(configFile)) {
    console.log("No local Demo runtime exists.");
    return;
  }
  const config = createConfig();
  const currentState = state();
  const pgBin = resolvePostgresBin();
  const stackRunning =
    postgresIsRunning(pgBin) &&
    processNames.every((name) => processIsAlive(currentState.processes?.[name]));
  const sourceRevision = repositoryRevision();
  console.log(LAB_WARNING);
  console.log(`Stack: ${stackRunning ? "running" : "stopped"}`);
  console.log(`Source revision: ${sourceRevision}`);
  console.log(`Runtime revision: ${currentState.runtimeRevision ?? "unknown"}`);
  for (const name of processNames) {
    const pid = currentState.processes?.[name];
    console.log(
      `${name}: ${processIsAlive(pid) ? "running" : "stopped"}${pid ? ` (pid ${pid})` : ""}`,
    );
  }
  console.log(`postgres: ${postgresIsRunning(pgBin) ? "running" : "stopped"}`);
  printResult(config, currentState, stackRunning);
}

async function reset() {
  if (!process.argv.includes("--yes")) {
    throw new Error(
      "Reset deletes only the generated synthetic Demo cluster and credentials. Re-run with: node tools/demo-local.mjs reset --yes",
    );
  }
  await down();
  if (existsSync(runtimeDir)) rmSync(runtimeDir, { recursive: true });
  if (existsSync(postgresSocket)) rmSync(postgresSocket, { recursive: true });
  console.log("Deleted the generated local Demo runtime. Repository files were not removed.");
}

function help() {
  console.log(`${LAB_WARNING}\n\nUsage:\n  node tools/demo-local.mjs up       Build, start, seed, and smoke-test the three-page local Demo\n  node tools/demo-local.mjs smoke    Create another synthetic paid/Active, ticket, and outflow journey\n  node tools/demo-local.mjs status   Show loopback services and the latest synthetic logins and IDs\n  node tools/demo-local.mjs down     Stop services and preserve synthetic Demo data\n  node tools/demo-local.mjs reset --yes\n                                     Stop and delete only .demo/local\n\nSurfaces:\n  http://127.0.0.1:5173/\n  http://127.0.0.1:5173/customer\n  http://127.0.0.1:5173/admin\n\nNo Docker, VPS, GitHub, real Provider, real credential, or real customer data is used.`);
}

const command = process.argv[2] ?? "up";
try {
  if (command === "up") await up();
  else if (command === "smoke") await smoke();
  else if (command === "status") await status();
  else if (command === "down") await down();
  else if (command === "reset") await reset();
  else if (["help", "--help", "-h"].includes(command)) help();
  else throw new Error(`Unknown Demo command: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
