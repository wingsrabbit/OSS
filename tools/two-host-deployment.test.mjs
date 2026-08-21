// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

async function readYaml(relativePath) {
  return parse(await read(relativePath), { merge: true });
}

function sorted(values) {
  return [...values].sort();
}

function parseEnvironmentExample(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        assert.notEqual(separator, -1, `invalid environment example line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function assertDigestBoundService(service, variable) {
  assert.match(
    service.image,
    new RegExp(`^\\$\\{${variable}:\\?required_digest_bound_[a-z0-9_]+\\}$`, "u"),
  );
  assert.equal(service.pull_policy, "never");
}

test("Docker build context excludes configuration and runtime targets stay role-separated", async () => {
  const dockerignore = await read(".dockerignore");
  for (const required of [
    ".git",
    ".env",
    ".env.*",
    "node_modules",
    "**/node_modules",
    "dist",
    "**/dist",
    "secrets",
    "private",
    "*.pem",
    "*.key",
  ]) {
    assert.match(dockerignore, new RegExp(`^${required.replaceAll("*", "\\*")}$`, "mu"));
  }

  const dockerfile = await read("Dockerfile");
  assert.match(dockerfile, /^FROM runtime-base AS core-runtime$/mu);
  assert.match(dockerfile, /^FROM runtime-base AS provider-runtime$/mu);
  assert.match(dockerfile, /^FROM core-runtime AS runtime$/mu);

  const coreStage = dockerfile.slice(
    dockerfile.indexOf("FROM runtime-base AS core-runtime"),
    dockerfile.indexOf("FROM runtime-base AS provider-runtime"),
  );
  const providerStage = dockerfile.slice(
    dockerfile.indexOf("FROM runtime-base AS provider-runtime"),
    dockerfile.indexOf("FROM core-runtime AS runtime"),
  );
  assert.doesNotMatch(coreStage, /providers\/mock-lab/u);
  assert.doesNotMatch(providerStage, /apps\/(?:api|worker)|packages\/core/u);
  assert.match(coreStage, /apps\/api\/dist/u);
  assert.match(coreStage, /apps\/worker\/dist/u);
  assert.match(providerStage, /providers\/mock-lab\/dist/u);
});

test("local Compose uses the independent Provider Platform service and database", async () => {
  const compose = await readYaml("compose.yaml");
  const worker = compose.services.worker;
  const provisioning = compose.services["provider-provisioning"];
  const platform = compose.services["provider-platform"];

  assert.equal(worker.environment.MOCK_PROVIDER_PLATFORM_URL, "http://provider-platform:4000");
  assert.ok(worker.depends_on["provider-platform"]);
  assert.ok(worker.networks.includes("provider-platform-app"));
  assert.equal(worker.build.target, "core-runtime");
  assert.equal(provisioning.environment.MOCK_PROVIDER_PLATFORM_TOKEN, undefined);
  assert.equal(provisioning.environment.MOCK_PROVIDER_PUBLIC_BASE_URL, undefined);
  assert.ok(platform.environment.MOCK_PROVIDER_PLATFORM_TOKEN);
  assert.ok(platform.environment.MOCK_PROVIDER_REQUEST_FINGERPRINT_KEY);
  assert.equal(
    platform.environment.MOCK_PROVIDER_REQUEST_FINGERPRINT_KEY_VERSION,
    "${MOCK_PROVIDER_REQUEST_FINGERPRINT_KEY_VERSION:-1}",
  );
  assert.equal(
    platform.environment.MOCK_PROVIDER_REQUEST_FINGERPRINT_PREVIOUS_KEYS,
    "${MOCK_PROVIDER_REQUEST_FINGERPRINT_PREVIOUS_KEYS:-}",
  );
  assert.match(platform.environment.PROVIDER_DATABASE_URL, /@provider-platform-db:5432\/provider_platform$/u);
  assert.equal(
    compose.services["provider-mailbox"].depends_on["provider-mail"].condition,
    "service_healthy",
  );
  assert.match(
    compose.services["provider-mailbox"].command[2],
    /until node -e .*provider-mail:4000\/health\/ready.*exec node providers\/mock-lab\/dist\/server\.js/u,
  );
  for (const name of [
    "provider-payment",
    "provider-provisioning",
    "provider-mail",
    "provider-mailbox",
    "provider-platform",
  ]) {
    assert.equal(compose.services[name].build.target, "provider-runtime");
  }
});

test("TestA Compose contains only Core services and external Provider URLs", async () => {
  const raw = await read("deploy/compose.testa.yaml");
  const compose = parse(raw, { merge: true });
  assert.deepEqual(
    sorted(Object.keys(compose.services)),
    sorted(["core-db", "seed", "api", "worker", "callback-gateway", "web", "core-edge"]),
  );
  assert.doesNotMatch(raw, /^\s*build:/mu);
  assert.doesNotMatch(raw, /PAYMENT_PROVIDER_DATABASE_PASSWORD|PROVISIONING_PROVIDER_DATABASE_PASSWORD|MAIL_PROVIDER_DATABASE_PASSWORD|PROVIDER_PLATFORM_DATABASE_PASSWORD/u);

  for (const name of ["seed", "api", "worker"]) {
    assertDigestBoundService(compose.services[name], "CORE_RUNTIME_IMAGE");
  }
  assertDigestBoundService(compose.services.web, "WEB_RUNTIME_IMAGE");
  assertDigestBoundService(compose.services["core-db"], "POSTGRES_IMAGE");
  assertDigestBoundService(compose.services["callback-gateway"], "CADDY_IMAGE");
  assertDigestBoundService(compose.services["core-edge"], "CADDY_IMAGE");

  assert.deepEqual(Object.keys(compose.services.worker.depends_on), ["api"]);
  assert.deepEqual(compose.services.worker.profiles, ["worker-dispatch"]);
  for (const key of [
    "MOCK_PAYMENT_PROVIDER_URL",
    "MOCK_PROVISIONING_PROVIDER_URL",
    "MOCK_PROVIDER_PLATFORM_URL",
    "MOCK_MAIL_PROVIDER_URL",
  ]) {
    assert.equal(
      compose.services.worker.environment[key],
      "${PROVIDER_BASE_URL:?required_https_provider_base_url}",
    );
  }
  assert.equal(
    compose.services.api.environment.MOCK_MAILBOX_URL,
    "${PROVIDER_BASE_URL:?required_https_provider_base_url}",
  );
  assert.equal(compose.networks["core-data"].internal, true);
  assert.equal(compose.networks["core-app"].internal, true);
  assert.notEqual(compose.networks["core-egress"]?.internal, true);
  assert.match(compose.services["core-db"].ports[0], /^127\.0\.0\.1:/u);
});

test("TestB Compose owns exactly four Provider databases and five isolated Provider processes", async () => {
  const raw = await read("deploy/compose.testb.yaml");
  const compose = parse(raw, { merge: true });
  assert.deepEqual(
    sorted(Object.keys(compose.services)),
    sorted([
      "provider-payment-db",
      "provider-provisioning-db",
      "provider-mail-db",
      "provider-platform-db",
      "provider-payment",
      "provider-provisioning",
      "provider-mail",
      "provider-mailbox",
      "provider-platform",
      "provider-edge",
    ]),
  );
  assert.doesNotMatch(raw, /^\s*build:/mu);
  assert.doesNotMatch(raw, /CORE_DATABASE_(?:MIGRATOR|API|WORKER)_PASSWORD/u);

  for (const name of [
    "provider-payment",
    "provider-provisioning",
    "provider-mail",
    "provider-mailbox",
    "provider-platform",
  ]) {
    const service = compose.services[name];
    assertDigestBoundService(service, "PROVIDER_RUNTIME_IMAGE");
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.ok(service.mem_limit);
    assert.equal(service.logging.driver, "local");
  }
  for (const name of [
    "provider-payment-db",
    "provider-provisioning-db",
    "provider-mail-db",
    "provider-platform-db",
  ]) {
    assertDigestBoundService(compose.services[name], "POSTGRES_IMAGE");
    assert.match(compose.services[name].ports[0], /^127\.0\.0\.1:/u);
  }
  assert.equal(
    compose.services["provider-provisioning"].environment.MOCK_PROVIDER_PLATFORM_TOKEN,
    undefined,
  );
  assert.ok(compose.services["provider-platform"].environment.MOCK_PROVIDER_PLATFORM_TOKEN);
  assert.ok(
    compose.services["provider-platform"].environment.MOCK_PROVIDER_REQUEST_FINGERPRINT_KEY,
  );
  assert.match(
    compose.services["provider-platform"].environment.PROVIDER_DATABASE_URL,
    /@provider-platform-db:5432\/provider_platform$/u,
  );
  assert.equal(
    compose.services["provider-mailbox"].depends_on["provider-mail"].condition,
    "service_healthy",
  );
  assert.match(
    compose.services["provider-mailbox"].command[2],
    /until node -e .*provider-mail:4000\/health\/ready.*exec node providers\/mock-lab\/dist\/server\.js/u,
  );
  assert.equal(compose.networks["payment-data"].internal, true);
  assert.equal(compose.networks["provider-platform-app"].internal, true);
  assert.notEqual(compose.networks["provider-egress"]?.internal, true);
});

test("edge gateways expose only the reviewed Core and Provider routes", async () => {
  const core = await read("deploy/Caddyfile.core-edge");
  const callback = await read("deploy/Caddyfile.callback");
  for (const path of [
    "/api/v1/provider-events/payment",
    "/api/v1/provider-events/refund",
    "/api/v1/provider-events/add-funds-chargeback",
    "/api/v1/provider-events/provisioning",
    "/api/v1/provider-events/resource-action",
    "/api/v1/provider-events/resource-termination",
  ]) {
    assert.match(core, new RegExp(path.replaceAll("/", "\\/"), "u"));
    assert.match(callback, new RegExp(path.replaceAll("/", "\\/"), "u"));
  }
  assert.match(core, /reverse_proxy callback-gateway:8081/u);
  assert.match(core, /reverse_proxy web:8080/u);
  assert.match(callback, /reverse_proxy api:3000/u);

  const provider = await read("deploy/Caddyfile.provider-edge");
  for (const upstream of [
    "provider-payment:4000",
    "provider-provisioning:4000",
    "provider-mail:4000",
    "provider-mailbox:4000",
    "provider-platform:4000",
  ]) {
    assert.match(provider, new RegExp(`reverse_proxy ${upstream}`));
  }
  assert.ok(provider.indexOf("@mailbox path") < provider.indexOf("@mail path"));
  assert.match(provider, /@platform path \/v1\/manifest \/v1\/events \/v1alpha1\/\*/u);
  assert.match(provider, /handle \{\s*respond 404\s*\}/u);
});

test("tracked environment examples contain placeholders, separated database credentials, and digest references", async () => {
  const testA = parseEnvironmentExample(await read("deploy/testa.env.example"));
  const testB = parseEnvironmentExample(await read("deploy/testb.env.example"));

  for (const [name, environment] of [["TestA", testA], ["TestB", testB]]) {
    assert.equal(
      Object.values(environment).some((value) => /sha256:[a-f0-9]{64}/u.test(value)),
      false,
      `${name} example must not contain a usable image digest`,
    );
    for (const [key, value] of Object.entries(environment)) {
      if (/(?:PASSWORD|TOKEN|SECRET|_KEY)$/u.test(key)) {
        assert.match(value, /^__(?:GENERATE|SET)_/u, `${name} ${key} must remain unusable`);
      }
    }
  }

  assert.ok(testA.CORE_RUNTIME_IMAGE.includes("@sha256:__SET_64_HEX_DIGEST__"));
  assert.ok(testB.PROVIDER_RUNTIME_IMAGE.includes("@sha256:__SET_64_HEX_DIGEST__"));
  assert.equal("PAYMENT_PROVIDER_DATABASE_PASSWORD" in testA, false);
  assert.equal("CORE_DATABASE_MIGRATOR_PASSWORD" in testB, false);
  assert.equal(testA.MOCK_PROVIDER_PLATFORM_TOKEN, testB.MOCK_PROVIDER_PLATFORM_TOKEN);
  assert.equal(testA.LAB_MAILBOX_TOKEN, testB.LAB_MAILBOX_TOKEN);
});

test("two-host runbook preserves Provider-first startup and recovery claim boundaries", async () => {
  const runbook = await read("docs/operators/two-host-mock-rc-deployment.md");
  const startTestB = runbook.indexOf("### 1. Start TestB");
  const startTestA = runbook.indexOf("### 2. Initialize and start TestA without Worker");
  const startWorker = runbook.indexOf("### 3. Start Worker last");
  assert.ok(startTestB > 0 && startTestB < startTestA && startTestA < startWorker);
  assert.match(runbook, /linux\/amd64/u);
  assert.match(runbook, /pull_policy: never/u);
  assert.match(runbook, /--profile worker-dispatch up -d worker/u);
  assert.match(runbook, /tools\/lab-backup[.]mjs restore --profile TestA\|TestB/u);
  assert.match(runbook, /Do not call the\s+deployment a completed final RC/u);
  assert.match(runbook, /no production data, real\s+Provider/u);
});

test("Docker Compose renders both projects without pulling or contacting a daemon", async (context) => {
  const composeVersion = spawnSync("docker", ["compose", "version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
    },
  });
  if (composeVersion.status !== 0) {
    context.skip("Docker Compose CLI is unavailable");
    return;
  }

  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "opensales-compose-contract-"));
  const certificate = resolve(temporaryDirectory, "certificate.pem");
  const privateKey = resolve(temporaryDirectory, "private-key.pem");
  await writeFile(certificate, "synthetic compose render certificate\n", { mode: 0o600 });
  await writeFile(privateKey, "synthetic compose render private key\n", { mode: 0o600 });

  const digest = "a".repeat(64);
  const credentialFixture = (label) => ["fixture", label, "x".repeat(48)].join("-");
  const shared = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    POSTGRES_IMAGE: `example.invalid/postgres@sha256:${digest}`,
    CADDY_IMAGE: `example.invalid/caddy@sha256:${digest}`,
    PROVIDER_BASE_URL: "https://provider-lab.example.invalid",
    CORE_CALLBACK_URL: "https://core-lab.example.invalid",
    MOCK_PAYMENT_PROVIDER_TOKEN: credentialFixture("payment-provider"),
    MOCK_PROVISIONING_PROVIDER_TOKEN: credentialFixture("provisioning-provider"),
    MOCK_MAIL_PROVIDER_TOKEN: credentialFixture("mail-provider"),
    MOCK_PROVIDER_PLATFORM_TOKEN: credentialFixture("provider-platform"),
    MOCK_PROVIDER_REQUEST_FINGERPRINT_KEY: Buffer.alloc(32, 4).toString("base64url"),
    MOCK_PROVIDER_REQUEST_FINGERPRINT_KEY_VERSION: "1",
    MOCK_PROVIDER_REQUEST_FINGERPRINT_PREVIOUS_KEYS: "",
    LAB_MAILBOX_TOKEN: credentialFixture("mailbox"),
    MOCK_PAYMENT_WEBHOOK_SECRET: credentialFixture("payment-webhook"),
    MOCK_PROVISIONING_WEBHOOK_SECRET: credentialFixture("provisioning-webhook"),
  };
  const projects = [
    {
      file: "deploy/compose.testa.yaml",
      env: {
        ...shared,
        CORE_RUNTIME_IMAGE: `example.invalid/opensales-core@sha256:${digest}`,
        WEB_RUNTIME_IMAGE: `example.invalid/opensales-web@sha256:${digest}`,
        CORE_PUBLIC_URL: "https://core-lab.example.invalid",
        CORE_EDGE_BIND_ADDRESS: "127.0.0.1",
        CORE_TLS_CERT_FILE: certificate,
        CORE_TLS_KEY_FILE: privateKey,
        CORE_DATABASE_MIGRATOR_PASSWORD: credentialFixture("core-migrator"),
        CORE_DATABASE_API_PASSWORD: credentialFixture("core-api"),
        CORE_DATABASE_WORKER_PASSWORD: credentialFixture("core-worker"),
        PROVIDER_OPERATION_CAPABILITY_SECRET: credentialFixture("operation-capability"),
        PAYMENT_METHOD_TOKEN_KEY: "a".repeat(43),
        PAYMENT_METHOD_TOKEN_LOOKUP_KEY: "b".repeat(43),
        IDENTITY_SECRET_KEY: "c".repeat(43),
      },
    },
    {
      file: "deploy/compose.testb.yaml",
      env: {
        ...shared,
        PROVIDER_RUNTIME_IMAGE: `example.invalid/opensales-provider@sha256:${digest}`,
        PROVIDER_EDGE_BIND_ADDRESS: "127.0.0.1",
        PROVIDER_TLS_CERT_FILE: certificate,
        PROVIDER_TLS_KEY_FILE: privateKey,
        PAYMENT_PROVIDER_DATABASE_PASSWORD: credentialFixture("payment-database"),
        PROVISIONING_PROVIDER_DATABASE_PASSWORD: credentialFixture("provisioning-database"),
        MAIL_PROVIDER_DATABASE_PASSWORD: credentialFixture("mail-database"),
        PROVIDER_PLATFORM_DATABASE_PASSWORD: credentialFixture("platform-database"),
      },
    },
  ];

  try {
    for (const project of projects) {
      const rendered = spawnSync(
        "docker",
        ["compose", "-f", project.file, "config", "--quiet"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: project.env,
          timeout: 10_000,
        },
      );
      assert.equal(
        rendered.status,
        0,
        `${project.file} failed Compose rendering: ${rendered.stderr || rendered.stdout}`,
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
