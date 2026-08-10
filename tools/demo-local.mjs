// SPDX-License-Identifier: AGPL-3.0-or-later
// NOT FOR PRODUCTION — MOCK PROVIDERS ONLY

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const lifecycleLockDirectory = join(
  tmpdir(),
  `oss-demo-lifecycle-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
);
const lifecycleSemaphoreFile = join(lifecycleLockDirectory, "lifecycle.lock");
const lifecycleOwnerFile = join(lifecycleLockDirectory, "owner.json");
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
    const detail = truncateDiagnostic(
      [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    );
    throw new Error(
      `${binary} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function commandBufferResult(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    const diagnosticBuffers = options.redactStdout
      ? [result.stderr]
      : [result.stdout, result.stderr];
    const detail = truncateDiagnostic([
      result.error?.message,
      ...diagnosticBuffers
      .filter(Boolean)
      .map((value) => value.toString("utf8")),
      result.signal ? `terminated by signal ${result.signal}` : null,
      result.status === null ? null : `exit status ${result.status}`,
    ]
      .filter(Boolean)
      .join("\n")
      .trim());
    throw new Error(
      `${options.failureLabel ?? `${binary} ${args.join(" ")} failed`}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result.stdout ?? Buffer.alloc(0);
}

function truncateDiagnostic(detail, limit = 4_096) {
  if (detail.length <= limit) return detail;
  const headLength = Math.floor(limit * 0.7);
  const tailLength = limit - headLength;
  return `${detail.slice(0, headLength)}\n...[truncated ${detail.length - limit} characters]...\n${detail.slice(-tailLength)}`;
}

function updateHashFromFile(hash, path) {
  const descriptor = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) return;
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
}

export function repositoryRevision(repositoryRoot = root) {
  const revision = commandResult("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
  });
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`Unable to identify the local Demo source revision: ${revision}`);
  }

  const trackedDiff = commandBufferResult(
    "git",
    ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
    {
      cwd: repositoryRoot,
      redactStdout: true,
      failureLabel: "Unable to fingerprint tracked Demo source changes",
    },
  );
  const untrackedOutput = commandBufferResult(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot },
  );
  const untrackedPaths = untrackedOutput
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (trackedDiff.length === 0 && untrackedPaths.length === 0) return revision;

  const fingerprint = createHash("sha256");
  fingerprint.update("opensales-demo-worktree-v1\0");
  fingerprint.update(revision);
  fingerprint.update("\0tracked-diff\0");
  fingerprint.update(trackedDiff);
  for (const relativePath of untrackedPaths) {
    const absolutePath = join(repositoryRoot, relativePath);
    const metadata = lstatSync(absolutePath);
    fingerprint.update("\0untracked\0");
    fingerprint.update(relativePath);
    fingerprint.update("\0");
    fingerprint.update(String(metadata.mode));
    fingerprint.update("\0");
    if (metadata.isFile()) {
      updateHashFromFile(fingerprint, absolutePath);
    } else if (metadata.isSymbolicLink()) {
      fingerprint.update("symlink\0");
      fingerprint.update(readlinkSync(absolutePath));
    } else {
      throw new Error(
        `Refusing to fingerprint unsupported untracked source entry: ${relativePath}`,
      );
    }
  }
  return `${revision}+worktree.${fingerprint.digest("hex")}`;
}

function executableVersion(binary, args = ["--version"]) {
  try {
    return commandResult(binary, args);
  } catch {
    return null;
  }
}

function resolveExactNode(currentState = null) {
  const trackedExecutables = [
    ...Object.values(currentState?.processes ?? {}),
    ...Object.values(currentState?.pendingProcesses ?? {}),
  ]
    .map((identity) =>
      Number.isInteger(identity)
        ? processCommand(identity)?.split(" ", 1)[0]
        : identity?.executable ?? identity?.argv?.split(" ", 1)[0],
    )
    .filter((candidate) => candidate?.endsWith("/node"));
  const candidates = [
    process.env.OSS_NODE_BIN,
    ...new Set(trackedExecutables),
    process.execPath,
  ];
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

export function recoverAdministratorAccount(current) {
  return (
    current.administratorAccount ??
    current.latestSmoke?.administratorAccount ??
    (current.latestSmoke?.syntheticAccount?.administrator
      ? current.latestSmoke.syntheticAccount
      : null)
  );
}

function state() {
  const current = readJson(stateFile, {
    warning: LAB_WARNING,
    processes: {},
    pendingProcesses: {},
    latestSmoke: null,
  });
  current.processes ??= {};
  current.pendingProcesses ??= {};
  current.administratorAccount ??= recoverAdministratorAccount(current);
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

function assertSourceIdentityUnchanged(expected, phase) {
  const current = repositoryRevision();
  if (current !== expected) {
    throw new Error(
      `Demo source changed ${phase} (${expected} -> ${current}); refusing to label or reuse a build from mixed source content. Run node tools/demo-local.mjs up again after the worktree settles.`,
    );
  }
}

function processSpecifications(config, node, tokens = {}) {
  const withToken = (name, args) => [
    ...(tokens[name] ? [`--conditions=oss-demo-process-${tokens[name]}`] : []),
    ...args,
  ];
  const providerArgs = (name) => withToken(name, ["providers/mock-lab/dist/server.js"]);
  const specifications = [
    ["provider-payment", providerArgs("provider-payment"), root, config.ports.payment],
    ["provider-provisioning", providerArgs("provider-provisioning"), root, config.ports.provisioning],
    ["provider-mail", providerArgs("provider-mail"), root, config.ports.mail],
    ["provider-mailbox", providerArgs("provider-mailbox"), root, config.ports.mailbox],
    ["api", withToken("api", ["apps/api/dist/server.js"]), root, config.ports.api],
    ["worker", withToken("worker", ["apps/worker/dist/worker.js"]), root, null],
    [
      "web",
      withToken("web", [
        "node_modules/vite/bin/vite.js",
        "--host",
        "127.0.0.1",
        "--port",
        String(config.ports.web),
      ]),
      join(root, "apps", "web"),
      config.ports.web,
    ],
  ];
  return Object.fromEntries(
    specifications.map(([name, args, cwd, port]) => [
      name,
      {
        name,
        executable: node,
        args,
        argv: [node, ...args].join(" "),
        cwd,
        host: port === null ? null : "127.0.0.1",
        port,
        token: tokens[name] ?? null,
      },
    ]),
  );
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
      `Unable to inspect tracked Demo PID ${pid}${detail ? `: ${detail}` : ""}`,
    );
  }
  return command || null;
}

function processStartTime(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    cwd: root,
    encoding: "utf8",
  });
  const startedAt = (result.stdout ?? "").trim();
  if (result.status === 1 && startedAt.length === 0) return null;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Unable to inspect start time for tracked Demo PID ${pid}${detail ? `: ${detail}` : ""}`,
    );
  }
  return startedAt || null;
}

function observeLifecycleProcess(pid) {
  const initialStartedAt = processStartTime(pid);
  if (initialStartedAt === null) return null;
  const initialArgv = processCommand(pid);
  if (initialArgv === null) return null;
  const finalStartedAt = processStartTime(pid);
  const finalArgv = processCommand(pid);
  if (finalStartedAt === null || finalArgv === null) return null;
  if (initialStartedAt !== finalStartedAt || initialArgv !== finalArgv) {
    return { startedAt: finalStartedAt, argv: finalArgv, unstable: true };
  }
  return { startedAt: initialStartedAt, argv: initialArgv, unstable: false };
}

export function lifecycleLockPaths(repositoryRoot = root) {
  const directory = join(
    tmpdir(),
    `oss-demo-lifecycle-${createHash("sha256").update(resolve(repositoryRoot)).digest("hex").slice(0, 12)}`,
  );
  return {
    directory,
    semaphore: join(directory, "lifecycle.lock"),
    owner: join(directory, "owner.json"),
  };
}

function validateLifecycleLockOwner(owner) {
  if (
    owner?.version !== 1 ||
    typeof owner.command !== "string" ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 1 ||
    typeof owner.startedAt !== "string" ||
    typeof owner.argv !== "string" ||
    typeof owner.token !== "string" ||
    owner.token.length < 16 ||
    typeof owner.acquiredAt !== "string"
  ) {
    throw new Error(
      "Refusing to recover a malformed local Demo lifecycle lock; inspect its owner record manually",
    );
  }
  return owner;
}

export function classifyLifecycleLockOwner(owner, observation) {
  validateLifecycleLockOwner(owner);
  if (observation === null) return "stale";
  if (
    observation.unstable === true ||
    observation.startedAt !== owner.startedAt ||
    observation.argv !== owner.argv
  ) {
    return "stale";
  }
  return "active";
}

function readLifecycleLock(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    throw new Error(
      `Refusing to recover malformed local Demo lifecycle lock JSON at ${path}`,
    );
  }
  validateLifecycleLockOwner(owner);
  return { owner, raw };
}

function lifecycleOwner(command, token = secureToken(24)) {
  const observation = observeLifecycleProcess(process.pid);
  if (!observation || observation.unstable) {
    throw new Error("Unable to record a stable identity for this Demo lifecycle command");
  }
  return {
    version: 1,
    command,
    pid: process.pid,
    startedAt: observation.startedAt,
    argv: observation.argv,
    token,
    acquiredAt: new Date().toISOString(),
  };
}

function resolveAdvisoryLockHelper(descriptor = 3) {
  if (existsSync("/usr/bin/lockf")) {
    return {
      binary: "/usr/bin/lockf",
      args: ["-s", "-t", "0", String(descriptor)],
      kind: "lockf-fd",
    };
  }
  const flock = ["/usr/bin/flock", "/bin/flock"].find((candidate) =>
    existsSync(candidate),
  );
  if (flock) {
    return {
      binary: flock,
      args: ["--nonblock", String(descriptor)],
      kind: "flock-fd",
    };
  }
  throw new Error(
    "Local Demo lifecycle commands require /usr/bin/lockf descriptor mode (macOS) or flock descriptor mode (Linux); neither advisory-lock helper is available",
  );
}

export function advisoryLockInvocation(descriptor = 3) {
  return resolveAdvisoryLockHelper(descriptor);
}

function ensureLifecycleLockFiles() {
  mkdirSync(lifecycleLockDirectory, { recursive: true, mode: 0o700 });
  chmodSync(lifecycleLockDirectory, 0o700);
  const descriptor = openSync(lifecycleSemaphoreFile, "a", 0o600);
  closeSync(descriptor);
  chmodSync(lifecycleSemaphoreFile, 0o600);
}

export function acquireAdvisoryFileLock(path) {
  const descriptor = openSync(path, "a+", 0o600);
  chmodSync(path, 0o600);
  const invocation = resolveAdvisoryLockHelper(3);
  const result = spawnSync(invocation.binary, invocation.args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe", descriptor],
  });
  if (result.status !== 0 || result.error) {
    closeSync(descriptor);
    const detail = truncateDiagnostic(
      [result.error?.message, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim(),
    );
    const error = new Error(
      `Unable to acquire the local Demo advisory lock with ${invocation.kind}${detail ? `: ${detail}` : ""}`,
    );
    error.code = "OSS_DEMO_LOCK_UNAVAILABLE";
    throw error;
  }
  return { descriptor, path, kind: invocation.kind };
}

export function releaseAdvisoryFileLock(lock) {
  closeSync(lock.descriptor);
}

export function registerLifecycleLockOwner(
  command,
  token,
  {
    ownerPath = lifecycleOwnerFile,
    inspectOwner = observeLifecycleProcess,
    owner = lifecycleOwner(command, token),
  } = {},
) {
  const previous = readLifecycleLock(ownerPath);
  if (previous) {
    const status = classifyLifecycleLockOwner(
      previous.owner,
      inspectOwner(previous.owner.pid),
    );
    if (status === "active") {
      throw new Error(
        `The advisory lifecycle lock was acquired but its diagnostic owner is still active: ${previous.owner.command} (pid ${previous.owner.pid}). Refusing to read Demo state.`,
      );
    }
  }
  writePrivateJson(ownerPath, owner);
  return { path: ownerPath, owner };
}

export function releaseLifecycleLockOwner(lock) {
  const recorded = readLifecycleLock(lock.path);
  if (recorded === null) {
    throw new Error(
      `Local Demo lifecycle lock disappeared before ${lock.owner.command} could release it`,
    );
  }
  if (
    recorded.owner.token !== lock.owner.token ||
    recorded.owner.pid !== lock.owner.pid ||
    recorded.owner.startedAt !== lock.owner.startedAt ||
    recorded.owner.argv !== lock.owner.argv
  ) {
    throw new Error(
      "Refusing to release a local Demo lifecycle lock whose owner token or process identity changed",
    );
  }
  // This is diagnostic metadata only. The advisory-lock inode is never
  // removed, so even a diagnostic-file race cannot release the kernel lock.
  unlinkSync(lock.path);
}

function acquireLifecycleLock(command) {
  ensureLifecycleLockFiles();
  let advisory;
  try {
    advisory = acquireAdvisoryFileLock(lifecycleSemaphoreFile);
  } catch (error) {
    const recorded = readLifecycleLock(lifecycleOwnerFile);
    if (
      error?.code === "OSS_DEMO_LOCK_UNAVAILABLE" &&
      recorded &&
      classifyLifecycleLockOwner(
        recorded.owner,
        observeLifecycleProcess(recorded.owner.pid),
      ) === "active"
    ) {
      throw new Error(
        `Another local Demo lifecycle command is active: ${recorded.owner.command} (pid ${recorded.owner.pid}, acquired ${recorded.owner.acquiredAt}). No Demo state was read or changed by ${command}.`,
      );
    }
    throw error;
  }
  try {
    const owner = registerLifecycleLockOwner(command, secureToken(24));
    return { advisory, owner };
  } catch (error) {
    releaseAdvisoryFileLock(advisory);
    throw error;
  }
}

function releaseLifecycleLock(lock) {
  let ownerError = null;
  try {
    releaseLifecycleLockOwner(lock.owner);
  } catch (error) {
    ownerError = error;
  } finally {
    releaseAdvisoryFileLock(lock.advisory);
  }
  if (ownerError) throw ownerError;
}

function processWorkingDirectory(pid) {
  const result = spawnSync(
    "lsof",
    ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-F", "pn"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status === 1 && !(result.stdout ?? "").trim()) return null;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Unable to inspect working directory for tracked Demo PID ${pid}${detail ? `: ${detail}` : ""}`,
    );
  }
  const directory = (result.stdout ?? "")
    .split("\n")
    .find((field) => field.startsWith("n"))
    ?.slice(1);
  return directory || null;
}

function processListensOnLoopbackPort(pid, port) {
  const endpoint = `127.0.0.1:${port}`;
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
      "pn",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status === 1 && !(result.stdout ?? "").trim()) return false;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Unable to inspect tracked Demo listener ${endpoint}${detail ? `: ${detail}` : ""}`,
    );
  }
  const fields = (result.stdout ?? "").trim().split("\n");
  return fields.includes(`p${pid}`) && fields.includes(`n${endpoint}`);
}

function observeProcess(pid, spec) {
  const initialStartedAt = processStartTime(pid);
  if (initialStartedAt === null) return null;
  const argv = processCommand(pid);
  if (argv === null) return null;
  const cwd = processWorkingDirectory(pid);
  const listener = spec.port === null ? null : processListensOnLoopbackPort(pid, spec.port);
  const finalStartedAt = processStartTime(pid);
  const finalArgv = processCommand(pid);
  if (finalStartedAt === null || finalArgv === null) return null;
  if (initialStartedAt !== finalStartedAt || argv !== finalArgv) {
    throw new Error(
      `Refusing to trust Demo PID ${pid}: process identity changed during inspection`,
    );
  }
  if (!cwd) {
    throw new Error(`Unable to verify working directory for tracked Demo PID ${pid}`);
  }
  return { pid, startedAt: initialStartedAt, argv, cwd, listener };
}

function listProcessCommands() {
  const result = spawnSync("ps", ["-axww", "-o", "pid=,command="], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = truncateDiagnostic(
      [result.stderr, result.error?.message].filter(Boolean).join("\n").trim(),
    );
    throw new Error(
      `Unable to scan local process identities for pending Demo recovery${detail ? `: ${detail}` : ""}`,
    );
  }
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number.parseInt(match[1], 10), argv: match[2] }));
}

function pendingConditionArgument(token) {
  return `--conditions=oss-demo-process-${token}`;
}

function commandContainsExactArgument(command, argument) {
  return command.split(/\s+/).includes(argument);
}

function validatePendingProcessRecord(pending) {
  if (
    pending?.version !== 1 ||
    !processNames.includes(pending?.name) ||
    typeof pending.token !== "string" ||
    pending.token.length < 16 ||
    typeof pending.executable !== "string" ||
    !Array.isArray(pending.args) ||
    !pending.args.every((argument) => typeof argument === "string") ||
    pending.args[0] !== pendingConditionArgument(pending.token) ||
    typeof pending.argv !== "string" ||
    pending.argv !== [pending.executable, ...pending.args].join(" ") ||
    typeof pending.cwd !== "string" ||
    !((pending.host === "127.0.0.1" && Number.isInteger(pending.port)) ||
      (pending.host === null && pending.port === null)) ||
    ![null, undefined].includes(pending.pid) &&
      (!Number.isInteger(pending.pid) || pending.pid <= 1)
  ) {
    throw new Error("Refusing to recover a malformed pending Demo process record");
  }
  return pending;
}

export function pendingProcessRecord(spec, pid = null) {
  if (typeof spec.token !== "string" || spec.token.length < 16) {
    throw new Error(`${spec.name} cannot enter pending state without a unique argv token`);
  }
  return validatePendingProcessRecord({
    version: 1,
    name: spec.name,
    token: spec.token,
    executable: spec.executable,
    args: [...spec.args],
    argv: spec.argv,
    cwd: spec.cwd,
    host: spec.host,
    port: spec.port,
    pid,
    createdAt: new Date().toISOString(),
  });
}

export function evaluatePendingProcessRecovery(
  pending,
  candidates,
  observeCandidate,
) {
  validatePendingProcessRecord(pending);
  const condition = pendingConditionArgument(pending.token);
  const matchingToken = candidates.filter(
    (candidate) =>
      Number.isInteger(candidate?.pid) &&
      candidate.pid > 1 &&
      typeof candidate.argv === "string" &&
      commandContainsExactArgument(candidate.argv, condition),
  );
  if (matchingToken.length === 0) return { action: "clear" };
  if (matchingToken.length > 1) {
    throw new Error(
      `Refusing to recover pending ${pending.name}: ${matchingToken.length} processes contain its unique argv token`,
    );
  }
  const candidate = matchingToken[0];
  if (pending.pid !== null && pending.pid !== undefined && candidate.pid !== pending.pid) {
    throw new Error(
      `Refusing to recover pending ${pending.name}: its recorded PID ${pending.pid} differs from token-bearing PID ${candidate.pid}`,
    );
  }
  if (candidate.argv !== pending.argv) {
    throw new Error(
      `Refusing to recover pending ${pending.name}: token-bearing process argv does not exactly match`,
    );
  }
  const observation = observeCandidate(candidate.pid, pending);
  if (
    !observation ||
    observation.pid !== candidate.pid ||
    observation.argv !== pending.argv ||
    observation.cwd !== pending.cwd
  ) {
    throw new Error(
      `Refusing to recover pending ${pending.name}: exact PID, argv, and cwd identity could not be verified`,
    );
  }
  if (pending.port !== null && observation.listener !== true) {
    throw new Error(
      `Refusing to recover pending ${pending.name}: PID ${candidate.pid} is not listening on ${pending.host}:${pending.port}; pending evidence is retained`,
    );
  }
  return {
    action: "promote",
    identity: storedProcessIdentity(
      pending,
      observation,
      pending.port === null || observation.listener === true,
    ),
  };
}

export function inspectPendingProcess(pending) {
  return evaluatePendingProcessRecovery(
    pending,
    listProcessCommands(),
    observeProcess,
  );
}

function recoverPendingProcesses(config, node, currentState) {
  currentState.pendingProcesses ??= {};
  currentState.processes ??= {};
  const unexpected = Object.keys(currentState.pendingProcesses).filter(
    (name) => !processNames.includes(name),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing to recover unknown pending Demo processes: ${unexpected.join(", ")}`,
    );
  }
  const candidates = listProcessCommands();
  for (const name of processNames) {
    const pending = currentState.pendingProcesses[name];
    if (!pending) continue;
    if (currentState.processes[name] !== undefined) {
      throw new Error(
        `Refusing to recover ${name}: both pending and formal process identities are recorded`,
      );
    }
    const expected = processSpecifications(config, node, {
      [name]: pending.token,
    })[name];
    if (
      pending.executable !== expected.executable ||
      pending.argv !== expected.argv ||
      pending.cwd !== expected.cwd ||
      pending.host !== expected.host ||
      pending.port !== expected.port
    ) {
      throw new Error(
        `Refusing to recover pending ${name}: its stored specification differs from this Demo source/runtime`,
      );
    }
    const resolution = evaluatePendingProcessRecovery(
      pending,
      candidates,
      observeProcess,
    );
    if (resolution.action === "clear") {
      delete currentState.pendingProcesses[name];
      saveState(currentState);
      continue;
    }
    currentState.processes[name] = resolution.identity;
    delete currentState.pendingProcesses[name];
    saveState(currentState);
  }
}

function storedProcessIdentity(spec, observation, listenerVerified) {
  return {
    name: spec.name,
    pid: observation.pid,
    startedAt: observation.startedAt,
    argv: observation.argv,
    cwd: observation.cwd,
    host: spec.host,
    port: spec.port,
    token: spec.token,
    listenerVerified,
  };
}

export function verifyStoredProcessIdentity(name, stored, spec, observation) {
  const legacy = Number.isInteger(stored);
  const storedPid = legacy ? stored : stored?.pid;
  if (!Number.isInteger(storedPid) || storedPid <= 1) {
    throw new Error(
      `Refusing to trust ${name}: stored Demo process identity has no valid PID`,
    );
  }
  if (observation === null) {
    return { running: false, ready: false, identity: null, migrated: false };
  }
  if (
    observation.pid !== storedPid ||
    observation.argv !== spec.argv ||
    observation.cwd !== spec.cwd
  ) {
    throw new Error(
      `Refusing to trust ${name} PID ${storedPid}: current argv or cwd does not exactly match the Demo process specification`,
    );
  }
  if (legacy && spec.port !== null && observation.listener !== true) {
    throw new Error(
      `Refusing to trust ${name} PID ${storedPid}: it is not listening on ${spec.host}:${spec.port}`,
    );
  }
  if (!legacy) {
    if (
      stored.name !== name ||
      stored.startedAt !== observation.startedAt ||
      stored.argv !== spec.argv ||
      stored.cwd !== spec.cwd ||
      stored.host !== spec.host ||
      stored.port !== spec.port ||
      stored.token !== spec.token ||
      typeof stored.listenerVerified !== "boolean"
    ) {
      throw new Error(
        `Refusing to trust ${name} PID ${storedPid}: stored identity differs from the current exact process identity`,
      );
    }
    if (stored.listenerVerified && spec.port !== null && observation.listener !== true) {
      throw new Error(
        `Refusing to trust ${name} PID ${storedPid}: its previously verified listener is no longer bound to ${spec.host}:${spec.port}`,
      );
    }
  }
  const listenerVerified = spec.port === null || observation.listener === true;
  return {
    running: true,
    ready: listenerVerified,
    identity: storedProcessIdentity(spec, observation, listenerVerified),
    migrated: legacy || stored.listenerVerified !== listenerVerified,
  };
}

function inspectTrackedProcesses(config, node, currentState, persist = true) {
  currentState.processes ??= {};
  const unexpected = Object.keys(currentState.processes).filter(
    (name) => !processNames.includes(name),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing to trust unknown recorded Demo processes: ${unexpected.join(", ")}`,
    );
  }
  const tokens = Object.fromEntries(
    processNames
      .map((name) => [name, currentState.processes[name]?.token])
      .filter(([, token]) => typeof token === "string" && token.length > 0),
  );
  const specs = processSpecifications(config, node, tokens);
  const identities = {};
  const readyNames = [];
  let changed = false;
  for (const name of processNames) {
    const stored = currentState.processes[name];
    if (stored === undefined) continue;
    const pid = Number.isInteger(stored) ? stored : stored?.pid;
    const observation = Number.isInteger(pid) && pid > 1
      ? observeProcess(pid, specs[name])
      : null;
    const verified = verifyStoredProcessIdentity(name, stored, specs[name], observation);
    if (!verified.running) {
      delete currentState.processes[name];
      changed = true;
      continue;
    }
    identities[name] = verified.identity;
    if (verified.ready) readyNames.push(name);
    if (verified.migrated) {
      currentState.processes[name] = verified.identity;
      changed = true;
    }
  }
  if (changed && persist) saveState(currentState);
  return {
    specs,
    identities,
    runningNames: Object.keys(identities),
    readyNames,
  };
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
  return processListensOnLoopbackPort(pid, config.ports.postgres);
}

function recordPostgresProcess(config, currentState) {
  const pid = postmasterPid();
  if (!pid) throw new Error("Demo PostgreSQL started without a valid postmaster PID");
  const argv = processCommand(pid);
  const startedAt = processStartTime(pid);
  if (!argv || !commandTargetsDemoPostgres(argv, config)) {
    throw new Error("Demo PostgreSQL process arguments do not match the configured data directory");
  }
  if (!startedAt) throw new Error("Demo PostgreSQL process has no verifiable start time");
  if (!processListensOnDemoPostgresPort(pid, config)) {
    throw new Error("Demo PostgreSQL process is not listening on its configured loopback port");
  }
  if (processCommand(pid) !== argv || processStartTime(pid) !== startedAt) {
    throw new Error("Demo PostgreSQL process identity changed while it was being recorded");
  }
  const existing = currentState.postgresProcess;
  if (
    existing &&
    (existing.pid !== pid ||
      existing.argv !== argv ||
      (existing.startedAt && existing.startedAt !== startedAt) ||
      existing.dataDir !== postgresData ||
      existing.host !== "127.0.0.1" ||
      existing.port !== config.ports.postgres ||
      existing.socketDir !== postgresSocket)
  ) {
    throw new Error(
      "Refusing to replace a mismatched stored Demo PostgreSQL process identity",
    );
  }
  currentState.postgresProcess = {
    pid,
    startedAt,
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
  const startedAt = processStartTime(tracked.pid);
  if (!startedAt) return { tracked, running: false };
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
  if (tracked.startedAt && tracked.startedAt !== startedAt) {
    throw new Error(
      "Refusing to stop an unverified PostgreSQL process: tracked PID was reused by another process",
    );
  }
  if (processCommand(tracked.pid) !== argv || processStartTime(tracked.pid) !== startedAt) {
    throw new Error(
      "Refusing to stop an unverified PostgreSQL process: identity changed during inspection",
    );
  }
  if (!tracked.startedAt) {
    tracked.startedAt = startedAt;
    saveState(currentState);
  }
  return { tracked, running: true };
}

function inspectPostgresRuntime(config, pgBin, currentState) {
  const controlledByPgCtl = postgresIsRunning(pgBin);
  if (controlledByPgCtl) recordPostgresProcess(config, currentState);
  const inspected = inspectTrackedPostgres(config, currentState);
  if (!inspected.running && inspected.tracked) {
    delete currentState.postgresProcess;
    saveState(currentState);
  }
  return {
    controlledByPgCtl,
    orphanRunning: !controlledByPgCtl && inspected.running,
    inspected,
  };
}

function postgresIdentityStillMatches(tracked) {
  const argv = processCommand(tracked.pid);
  const startedAt = processStartTime(tracked.pid);
  if (argv === null || startedAt === null) return false;
  return argv === tracked.argv && startedAt === tracked.startedAt;
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
  if (!inspectTrackedPostgres(config, currentState).running) return false;
  process.kill(inspected.tracked.pid, "SIGINT");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!postgresIdentityStillMatches(inspected.tracked)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (postgresIdentityStillMatches(inspected.tracked)) {
    throw new Error("Verified orphaned Demo PostgreSQL did not stop within 10 seconds");
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

async function waitForSpawnIdentity(spec, pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = observeProcess(pid, spec);
    if (observation) {
      if (observation.argv !== spec.argv || observation.cwd !== spec.cwd) {
        throw new Error(
          `Refusing to record ${spec.name} PID ${pid}: spawned argv or cwd differs from the exact specification`,
        );
      }
      return observation;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`${spec.name} exited before its exact process identity could be recorded`);
}

function savePendingTransition(currentState, pendingProcesses, processes = currentState.processes) {
  const next = { ...currentState, pendingProcesses, processes };
  saveState(next);
  currentState.pendingProcesses = pendingProcesses;
  currentState.processes = processes;
}

export async function cleanupExactPendingProcess(
  pending,
  currentState,
  {
    inspect = inspectPendingProcess,
    identityStillMatches = trackedProcessIdentityStillMatches,
    signal = (pid, signalName) => process.kill(pid, signalName),
    persist = (pendingProcesses) =>
      savePendingTransition(currentState, pendingProcesses),
    now = Date.now,
    wait = (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    termTimeoutMs = 2_000,
    killTimeoutMs = 1_000,
  } = {},
) {
  let resolution;
  try {
    resolution = inspect(pending);
  } catch {
    return "retained";
  }
  if (resolution.action === "clear") {
    const pendingProcesses = { ...currentState.pendingProcesses };
    delete pendingProcesses[pending.name];
    persist(pendingProcesses);
    return "cleared_no_child";
  }
  const identity = resolution.identity;
  const spec = pending;
  if (!identityStillMatches(identity, spec)) return "retained";
  try {
    signal(identity.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") return "retained";
  }
  const deadline = now() + termTimeoutMs;
  while (now() < deadline && identityStillMatches(identity, spec)) {
    await wait(50);
  }
  if (identityStillMatches(identity, spec)) {
    if (!identityStillMatches(identity, spec)) return "retained";
    try {
      signal(identity.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") return "retained";
    }
    const killDeadline = now() + killTimeoutMs;
    while (
      now() < killDeadline &&
      identityStillMatches(identity, spec)
    ) {
      await wait(25);
    }
    if (identityStillMatches(identity, spec)) return "retained";
  }
  const pendingProcesses = { ...currentState.pendingProcesses };
  delete pendingProcesses[pending.name];
  persist(pendingProcesses);
  return "stopped_exact_child";
}

async function startDetached(spec, environment, currentState) {
  if (currentState.processes?.[spec.name] !== undefined) {
    throw new Error(`Refusing to overwrite an existing tracked ${spec.name} process identity`);
  }
  if (currentState.pendingProcesses?.[spec.name] !== undefined) {
    throw new Error(`Refusing to overwrite an existing pending ${spec.name} process identity`);
  }
  const initialPending = pendingProcessRecord(spec);
  savePendingTransition(currentState, {
    ...currentState.pendingProcesses,
    [spec.name]: initialPending,
  });

  let child;
  try {
    const logPath = join(logsDir, `${spec.name}.log`);
    const logFd = openSync(logPath, "a", 0o600);
    try {
      child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...environment },
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } finally {
      closeSync(logFd);
    }
    await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("spawn", resolvePromise);
    });
    child.unref();
    if (!Number.isInteger(child.pid) || child.pid <= 1) {
      throw new Error(`${spec.name} started without a valid PID`);
    }
    const withPid = { ...initialPending, pid: child.pid };
    savePendingTransition(currentState, {
      ...currentState.pendingProcesses,
      [spec.name]: withPid,
    });

    const observation = await waitForSpawnIdentity(spec, child.pid);
    const identity = storedProcessIdentity(
      spec,
      observation,
      spec.port === null || observation.listener === true,
    );
    const pendingProcesses = { ...currentState.pendingProcesses };
    delete pendingProcesses[spec.name];
    savePendingTransition(
      currentState,
      pendingProcesses,
      { ...currentState.processes, [spec.name]: identity },
    );
    return identity;
  } catch (error) {
    const recordedPending = currentState.pendingProcesses?.[spec.name] ?? initialPending;
    const cleanup = await cleanupExactPendingProcess(recordedPending, currentState);
    const detail = error instanceof Error ? error.message : String(error);
    if (cleanup === "stopped_exact_child") {
      throw new Error(`${detail}; the exact failed child was verified and stopped`);
    }
    if (cleanup === "cleared_no_child") {
      throw new Error(`${detail}; no process carried the pending argv token, so the pending record was cleared without signaling`);
    }
    throw new Error(
      `${detail}; pendingProcesses.${spec.name} is retained. The next locked Demo lifecycle command will recover it or fail closed with the exact mismatch.`,
    );
  }
}

function markProcessReady(spec, currentState) {
  const stored = currentState.processes?.[spec.name];
  const observation = observeProcess(stored?.pid, spec);
  const verified = verifyStoredProcessIdentity(spec.name, stored, spec, observation);
  if (!verified.running || !verified.ready) {
    throw new Error(
      `${spec.name} health endpoint responded but its exact loopback listener identity was not verified`,
    );
  }
  currentState.processes[spec.name] = verified.identity;
  saveState(currentState);
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
  const tokens = Object.fromEntries(processNames.map((name) => [name, secureToken(18)]));
  const specs = processSpecifications(config, node, tokens);
  await startDetached(specs["provider-payment"], providerEnvironment(config, "payment"), currentState);
  await startDetached(
    specs["provider-provisioning"],
    providerEnvironment(config, "provisioning"),
    currentState,
  );
  await startDetached(specs["provider-mail"], providerEnvironment(config, "mail"), currentState);
  await Promise.all([
    waitForHttp("provider-payment", `http://127.0.0.1:${config.ports.payment}/health/ready`),
    waitForHttp(
      "provider-provisioning",
      `http://127.0.0.1:${config.ports.provisioning}/health/ready`,
    ),
    waitForHttp("provider-mail", `http://127.0.0.1:${config.ports.mail}/health/ready`),
  ]);
  for (const name of ["provider-payment", "provider-provisioning", "provider-mail"]) {
    markProcessReady(specs[name], currentState);
  }

  // Mail and mailbox intentionally share one Mock-only database. Starting them
  // serially avoids a PostgreSQL CREATE EXTENSION bootstrap race.
  await startDetached(
    specs["provider-mailbox"],
    providerEnvironment(config, "mailbox"),
    currentState,
  );
  await waitForHttp(
    "provider-mailbox",
    `http://127.0.0.1:${config.ports.mailbox}/health/ready`,
  );
  markProcessReady(specs["provider-mailbox"], currentState);

  await startDetached(specs.api, apiEnvironment(config), currentState);
  await waitForHttp("api", `http://127.0.0.1:${config.ports.api}/health/ready`);
  markProcessReady(specs.api, currentState);

  await startDetached(specs.worker, workerEnvironment(config), currentState);
  await startDetached(
    specs.web,
    { OSS_API_PROXY_TARGET: `http://127.0.0.1:${config.ports.api}` },
    currentState,
  );
  await waitForHttp("web", `http://127.0.0.1:${config.ports.web}/`);
  markProcessReady(specs.web, currentState);
}

function createBootstrapToken(config, node, currentState) {
  if (
    (currentState.administratorAccount?.email &&
      currentState.administratorAccount?.password) ||
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
    if (typeof token !== "string") {
      throw new Error("Staff bootstrap token command produced no credential");
    }
    return token;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("Staff bootstrap is already complete")) {
      throw new Error(
        "This preserved Demo database already has Staff, but no recoverable synthetic administrator credential remains in .demo/local/state.json. Run `node tools/demo-local.mjs reset --yes`, then `node tools/demo-local.mjs up` to create separate synthetic Staff and customer identities.",
      );
    }
    throw error;
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
  console.log(`Runtime source identity: ${currentState.runtimeRevision ?? "unknown"}`);
  if (result?.syntheticAccount) {
    console.log(`Latest synthetic customer login: ${result.syntheticAccount.email}`);
    console.log(`Latest synthetic customer password: ${result.syntheticAccount.password}`);
    console.log(`Latest synthetic customer Client Account ID: ${result.syntheticAccount.clientAccountId}`);
    console.log(`Synthetic order ID: ${result.journey.orderId}`);
    console.log(`Synthetic invoice ID: ${result.journey.invoiceId}`);
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
    result?.administratorAccount ??
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
  let currentState = state();
  const node = resolveExactNode(currentState);
  recoverPendingProcesses(config, node, currentState);
  const pgBin = resolvePostgresBin();
  const sourceRevision = repositoryRevision();
  currentState.processes ??= {};
  let processRuntime = inspectTrackedProcesses(config, node, currentState);
  let runningProcesses = processRuntime.runningNames;
  let postgresRuntime = inspectPostgresRuntime(config, pgBin, currentState);
  if (postgresRuntime.orphanRunning) {
    await down();
    currentState = state();
    currentState.processes ??= {};
    processRuntime = inspectTrackedProcesses(config, node, currentState);
    runningProcesses = processRuntime.runningNames;
    postgresRuntime = inspectPostgresRuntime(config, pgBin, currentState);
  }
  let stackAlreadyRunning =
    postgresRuntime.controlledByPgCtl &&
    processRuntime.readyNames.length === processNames.length;
  if (
    (postgresRuntime.controlledByPgCtl || runningProcesses.length > 0) &&
    currentState.runtimeRevision !== sourceRevision
  ) {
    console.log(
      `The running Demo revision ${currentState.runtimeRevision ?? "unknown"} differs from source ${sourceRevision}; preserving data while restarting and migrating forward.`,
    );
    await down();
    currentState = state();
    currentState.processes ??= {};
    runningProcesses = [];
    postgresRuntime = {
      controlledByPgCtl: false,
      orphanRunning: false,
      inspected: { tracked: null, running: false },
    };
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
    assertSourceIdentityUnchanged(sourceRevision, "while the workspace was building");
    startPostgres(config, pgBin, currentState);
    prepareDatabases(config, pgBin, node);
    bootstrapToken = createBootstrapToken(config, node, currentState);
    assertSourceIdentityUnchanged(sourceRevision, "while the Demo database was preparing");
    currentState.runtimeRevision = sourceRevision;
    saveState(currentState);
    await startProcesses(config, node, currentState);
    assertSourceIdentityUnchanged(
      sourceRevision,
      "while the Demo processes were starting and passing health checks",
    );
  }
  console.log(
    "Running the synthetic customer, service-linked support ticket, and manual receipt → confirmed original-source outflow smoke journeys...",
  );
  const result = await runDemoSmoke({
    baseUrl: `http://127.0.0.1:${config.ports.web}`,
    bootstrapToken,
    administratorAccount: currentState.administratorAccount,
    onAdministratorAccount: (administratorAccount) => {
      const refreshed = state();
      refreshed.administratorAccount = administratorAccount;
      saveState(refreshed);
    },
  });
  assertSourceIdentityUnchanged(sourceRevision, "while the Demo smoke journey was running");
  currentState = state();
  currentState.runtimeRevision = sourceRevision;
  currentState.latestSmoke = result;
  currentState.administratorAccount = result.administratorAccount;
  currentState.lastStartedAt = new Date().toISOString();
  saveState(currentState);
  printResult(config, currentState, true);
}

async function smoke() {
  const config = createConfig();
  const currentState = state();
  const node = resolveExactNode(currentState);
  recoverPendingProcesses(config, node, currentState);
  const sourceRevision = repositoryRevision();
  if (currentState.runtimeRevision !== sourceRevision) {
    throw new Error(
      `The Demo runtime revision ${currentState.runtimeRevision ?? "unknown"} differs from source ${sourceRevision}; run node tools/demo-local.mjs up to rebuild and migrate it first.`,
    );
  }
  const processRuntime = inspectTrackedProcesses(config, node, currentState);
  const pgBin = resolvePostgresBin();
  const postgresRuntime = inspectPostgresRuntime(config, pgBin, currentState);
  if (
    !postgresRuntime.controlledByPgCtl ||
    processRuntime.readyNames.length !== processNames.length
  ) {
    throw new Error("The exact Demo process identities are not fully running; run node tools/demo-local.mjs up");
  }
  const bootstrapToken = createBootstrapToken(config, node, currentState);
  const result = await runDemoSmoke({
    baseUrl: `http://127.0.0.1:${config.ports.web}`,
    bootstrapToken,
    administratorAccount: currentState.administratorAccount,
    onAdministratorAccount: (administratorAccount) => {
      const refreshed = state();
      refreshed.administratorAccount = administratorAccount;
      saveState(refreshed);
    },
  });
  assertSourceIdentityUnchanged(sourceRevision, "while the Demo smoke journey was running");
  const refreshed = state();
  refreshed.latestSmoke = result;
  refreshed.administratorAccount = result.administratorAccount;
  saveState(refreshed);
  printResult(config, refreshed, true);
}

function trackedProcessIdentityStillMatches(identity, spec) {
  const observation = observeProcess(identity.pid, spec);
  return (
    observation !== null &&
    observation.pid === identity.pid &&
    observation.startedAt === identity.startedAt &&
    observation.argv === identity.argv &&
    observation.cwd === identity.cwd
  );
}

async function stopProcess(name, identity, spec, currentState) {
  if (!identity) return;
  const beforeSignal = observeProcess(identity.pid, spec);
  const verified = verifyStoredProcessIdentity(name, identity, spec, beforeSignal);
  if (!verified.running) return;
  process.kill(identity.pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && trackedProcessIdentityStillMatches(identity, spec)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (trackedProcessIdentityStillMatches(identity, spec)) {
    if (trackedProcessIdentityStillMatches(identity, spec)) {
      process.kill(identity.pid, "SIGKILL");
      const killDeadline = Date.now() + 2_000;
      while (
        Date.now() < killDeadline &&
        trackedProcessIdentityStillMatches(identity, spec)
      ) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      if (trackedProcessIdentityStillMatches(identity, spec)) {
        throw new Error(`${name} did not stop after verified SIGKILL`);
      }
    }
  }
  delete currentState.processes[name];
  saveState(currentState);
}

async function down() {
  if (!existsSync(configFile)) {
    console.log("No local Demo runtime exists.");
    return;
  }
  const config = createConfig();
  const currentState = state();
  const node = resolveExactNode(currentState);
  recoverPendingProcesses(config, node, currentState);
  const processRuntime = inspectTrackedProcesses(config, node, currentState);
  const pgBin = resolvePostgresBin();
  const postgresRuntime = inspectPostgresRuntime(config, pgBin, currentState);
  // No signal is sent until every recorded child and PostgreSQL identity has
  // passed the exact preflight above.
  for (const name of [
    "web",
    "worker",
    "api",
    "provider-mailbox",
    "provider-mail",
    "provider-provisioning",
    "provider-payment",
  ]) {
    await stopProcess(
      name,
      processRuntime.identities[name],
      processRuntime.specs[name],
      currentState,
    );
  }
  if (postgresRuntime.controlledByPgCtl) {
    const immediatelyBeforeStop = inspectTrackedPostgres(config, currentState);
    if (!immediatelyBeforeStop.running) {
      throw new Error("Demo PostgreSQL changed identity before pg_ctl stop; refusing further action");
    }
    commandResult(join(pgBin, "pg_ctl"), ["-D", postgresData, "-m", "fast", "-w", "stop"]);
    if (postgresIdentityStillMatches(immediatelyBeforeStop.tracked)) {
      throw new Error("Verified Demo PostgreSQL remained alive after pg_ctl stop");
    }
    delete currentState.postgresProcess;
  } else if (postgresRuntime.orphanRunning) {
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
  const node = resolveExactNode(currentState);
  recoverPendingProcesses(config, node, currentState);
  const pgBin = resolvePostgresBin();
  const processRuntime = inspectTrackedProcesses(config, node, currentState);
  const postgresRuntime = inspectPostgresRuntime(config, pgBin, currentState);
  const stackRunning =
    postgresRuntime.controlledByPgCtl &&
    processRuntime.readyNames.length === processNames.length;
  const sourceRevision = repositoryRevision();
  console.log(LAB_WARNING);
  console.log(`Stack: ${stackRunning ? "running" : "stopped"}`);
  console.log(`Source revision: ${sourceRevision}`);
  console.log(`Runtime revision: ${currentState.runtimeRevision ?? "unknown"}`);
  for (const name of processNames) {
    const identity = processRuntime.identities[name];
    const ready = processRuntime.readyNames.includes(name);
    console.log(
      `${name}: ${identity ? (ready ? "running" : "starting/unready") : "stopped"}${identity ? ` (pid ${identity.pid})` : ""}`,
    );
  }
  console.log(
    `postgres: ${postgresRuntime.controlledByPgCtl ? "running" : postgresRuntime.orphanRunning ? "verified orphan" : "stopped"}`,
  );
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

async function main() {
  const command = process.argv[2] ?? "up";
  const lifecycleCommands = new Set(["up", "smoke", "status", "down", "reset"]);
  let lock = null;
  try {
    if (["help", "--help", "-h"].includes(command)) {
      help();
      return;
    }
    if (!lifecycleCommands.has(command)) {
      throw new Error(`Unknown Demo command: ${command}`);
    }
    // This remains before config, state, source identity, migration, or child
    // inspection. The current Node process keeps the locked descriptor open.
    lock = acquireLifecycleLock(command);
    if (command === "up") await up();
    else if (command === "smoke") await smoke();
    else if (command === "status") await status();
    else if (command === "down") await down();
    else await reset();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    if (lock) {
      try {
        releaseLifecycleLock(lock);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    }
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
