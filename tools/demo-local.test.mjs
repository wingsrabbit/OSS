// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireAdvisoryFileLock,
  apiEnvironment,
  classifyLifecycleLockOwner,
  cleanupExactPendingProcess,
  evaluatePendingProcessRecovery,
  inspectPendingProcess,
  lifecycleLockPaths,
  pendingProcessRecord,
  recoverAdministratorAccount,
  registerLifecycleLockOwner,
  releaseAdvisoryFileLock,
  releaseLifecycleLockOwner,
  repositoryRevision,
  upgradeExistingDemoConfig,
  verifyStoredProcessIdentity,
  workerEnvironment,
} from "./demo-local.mjs";
import {
  assertSeparatedDemoRoles,
  DemoSession,
  runServiceOperationsSmoke,
  runSupportTicketSmoke,
} from "./demo-smoke.mjs";

const demoLocalModuleUrl = new URL("./demo-local.mjs", import.meta.url).href;

function lockedNodeScript(lockFile, body) {
  return `(async()=>{const lifecycle=await import(${JSON.stringify(demoLocalModuleUrl)});let lock=null;try{lock=lifecycle.acquireAdvisoryFileLock(${JSON.stringify(lockFile)});${body}}catch(error){process.stderr.write(String(error?.message??error)+"\\n");process.exitCode=75;}finally{if(lock)lifecycle.releaseAdvisoryFileLock(lock);}})();`;
}

function advisoryRun(lockFile, body) {
  return spawnSync(process.execPath, ["-e", lockedNodeScript(lockFile, body)], {
    encoding: "utf8",
    timeout: 5_000,
  });
}

function spawnAdvisory(lockFile, body, options = {}) {
  return spawn(process.execPath, ["-e", lockedNodeScript(lockFile, body)], {
    stdio: options.stdio ?? "ignore",
  });
}

async function childOutcome(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const [code, signal] = await once(child, "exit");
  return { code, signal };
}

async function waitForOutput(stream, expected, timeoutMs = 3_000) {
  stream.setEncoding("utf8");
  let output = "";
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for child output: ${expected}`)),
      timeoutMs,
    );
    const onData = (chunk) => {
      output += chunk;
      if (!output.includes(expected)) return;
      clearTimeout(timeout);
      stream.off("data", onData);
      resolvePromise();
    };
    stream.on("data", onData);
  });
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function stopTestPid(pid) {
  if (!pidExists(pid)) return;
  process.kill(pid, "SIGTERM");
  let deadline = Date.now() + 1_000;
  while (Date.now() < deadline && pidExists(pid)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (pidExists(pid)) process.kill(pid, "SIGKILL");
  deadline = Date.now() + 1_000;
  while (Date.now() < deadline && pidExists(pid)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.equal(pidExists(pid), false, `test PID ${pid} did not stop`);
}

test("legacy Demo config gains independent identity and Provider platform secrets exactly once", () => {
  const config = { secrets: {} };
  const generated = [];
  const tokenFactory = (bytes) => {
    generated.push(bytes ?? null);
    if (bytes !== 32) return "synthetic-platform-token";
    return generated.length === 2
      ? Buffer.alloc(32, 7).toString("base64url")
      : Buffer.alloc(32, 8).toString("base64url");
  };
  assert.equal(upgradeExistingDemoConfig(config, tokenFactory), true);
  assert.deepEqual(generated, [null, 32, 32]);
  assert.equal(config.secrets.providerPlatformToken, "synthetic-platform-token");
  assert.equal(
    config.secrets.providerRequestFingerprintKey,
    Buffer.alloc(32, 7).toString("base64url"),
  );
  assert.equal(config.secrets.identitySecretKey, Buffer.alloc(32, 8).toString("base64url"));
  assert.equal(upgradeExistingDemoConfig(config, tokenFactory), false);
  assert.deepEqual(generated, [null, 32, 32], "an upgraded config must not rotate any secret");
});

test("Demo API and Worker share the notification budget and Worker receives identity settings", () => {
  const config = {
    ports: {
      api: 30_001,
      web: 51_731,
      payment: 40_001,
      provisioning: 40_002,
      mail: 40_003,
    },
    secrets: {
      workerDatabasePassword: "synthetic-worker-db-password",
      paymentProviderToken: "synthetic-payment-provider-token",
      provisioningProviderToken: "synthetic-provisioning-provider-token",
      providerPlatformToken: "synthetic-provider-platform-token",
      mailProviderToken: "synthetic-mail-provider-token",
      identitySecretKey: "synthetic-identity-secret-key",
      providerOperationCapabilitySecret: "synthetic-operation-capability-secret",
      paymentMethodTokenKey: "synthetic-payment-method-key",
      paymentWebhookSecret: "synthetic-payment-webhook-secret",
      provisioningWebhookSecret: "synthetic-provisioning-webhook-secret",
    },
  };
  const environment = workerEnvironment(config);
  const api = apiEnvironment({
    ...config,
    secrets: {
      ...config.secrets,
      apiDatabasePassword: "synthetic-api-db-password",
      mailboxToken: "synthetic-mailbox-token",
      paymentMethodTokenLookupKey: "synthetic-payment-method-lookup-key",
    },
  });
  assert.equal(environment.OSS_PUBLIC_URL, "http://127.0.0.1:51731");
  assert.equal(environment.IDENTITY_SECRET_KEY, "synthetic-identity-secret-key");
  assert.equal(environment.IDENTITY_SECRET_KEY_VERSION, "1");
  assert.equal(environment.NOTIFICATION_MAX_ATTEMPTS, "3");
  assert.equal(api.NOTIFICATION_MAX_ATTEMPTS, environment.NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(
    environment.MOCK_PROVIDER_PLATFORM_TOKEN,
    "synthetic-provider-platform-token",
  );
});

test("advisory lock keeps one stable semaphore inode across success and failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-demo-lock-inode-"));
  const semaphore = join(directory, "lifecycle.lock");
  let held = null;
  try {
    writeFileSync(semaphore, "", { mode: 0o600 });
    const before = statSync(semaphore);
    held = acquireAdvisoryFileLock(semaphore);
    const busyWhileParentFdIsHeld = advisoryRun(semaphore, "process.exit(0)");
    assert.notEqual(busyWhileParentFdIsHeld.status, 0);
    releaseAdvisoryFileLock(held);
    held = null;

    const success = advisoryRun(semaphore, "process.exit(0)");
    assert.equal(success.status, 0, success.stderr);
    const afterSuccess = statSync(semaphore);
    assert.equal(afterSuccess.dev, before.dev);
    assert.equal(afterSuccess.ino, before.ino);

    const failure = advisoryRun(semaphore, "process.exit(1)");
    assert.equal(failure.status, 1, failure.stderr);
    const afterFailure = statSync(semaphore);
    assert.equal(afterFailure.dev, before.dev);
    assert.equal(afterFailure.ino, before.ino);

    const signaled = advisoryRun(
      semaphore,
      'process.kill(process.pid, "SIGTERM")',
    );
    assert.ok(
      signaled.signal === "SIGTERM" || signaled.status === 143,
      `unexpected signal result: status=${signaled.status} signal=${signaled.signal}`,
    );
    const afterSignal = statSync(semaphore);
    assert.equal(afterSignal.dev, before.dev);
    assert.equal(afterSignal.ino, before.ino);
  } finally {
    if (held) releaseAdvisoryFileLock(held);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ten concurrent advisory-lock contenders execute exactly one inner command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-demo-lock-contenders-"));
  const semaphore = join(directory, "lifecycle.lock");
  const marker = join(directory, "state-marker.txt");
  try {
    writeFileSync(semaphore, "", { mode: 0o600 });
    const before = statSync(semaphore);
    const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(marker)},"entered\\n");await new Promise(resolve=>setTimeout(resolve,300));`;
    const contenders = Array.from({ length: 10 }, () =>
      spawnAdvisory(semaphore, script),
    );
    const outcomes = await Promise.all(contenders.map(childOutcome));
    assert.equal(outcomes.filter(({ code }) => code === 0).length, 1);
    assert.equal(
      readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length,
      1,
    );
    const after = statSync(semaphore);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("active holder blocks state work, SIGKILL releases lock, and another repo remains independent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-demo-lock-crash-"));
  const first = join(directory, "repo-a.lock");
  const second = join(directory, "repo-b.lock");
  const forbiddenMarker = join(directory, "busy-state-marker.txt");
  const independentMarker = join(directory, "independent-marker.txt");
  writeFileSync(first, "", { mode: 0o600 });
  writeFileSync(second, "", { mode: 0o600 });
  const before = statSync(first);
  const holder = spawnAdvisory(
    first,
    'console.log("LOCK_READY");setInterval(()=>{},1000);await new Promise(()=>{})',
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    await waitForOutput(holder.stdout, "LOCK_READY");
    const lockHolder = spawnSync(
      "lsof",
      ["-nP", "-p", String(holder.pid), "-F", "pn"],
      { encoding: "utf8" },
    );
    assert.equal(lockHolder.status, 0, lockHolder.stderr);
    assert.match(lockHolder.stdout, new RegExp(`^p${holder.pid}$`, "m"));
    assert.match(lockHolder.stdout, new RegExp(`^n${realpathSync(first)}$`, "m"));
    const busy = advisoryRun(
      first,
      `require("node:fs").writeFileSync(${JSON.stringify(forbiddenMarker)},"changed")`,
    );
    assert.notEqual(busy.status, 0);
    assert.equal(existsSync(forbiddenMarker), false);
    assert.equal(statSync(first).ino, before.ino);

    const independent = advisoryRun(
      second,
      `require("node:fs").writeFileSync(${JSON.stringify(independentMarker)},"ok")`,
    );
    assert.equal(independent.status, 0, independent.stderr);
    assert.equal(readFileSync(independentMarker, "utf8"), "ok");

    holder.kill("SIGKILL");
    const killed = await childOutcome(holder);
    assert.ok(killed.signal === "SIGKILL" || killed.code === 137);
    assert.throws(() => process.kill(holder.pid, 0), { code: "ESRCH" });
    const recovered = advisoryRun(first, "process.exit(0)");
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(statSync(first).ino, before.ino);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lifecycle descriptor is not inherited by detached service-like children", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-demo-lock-grandchild-"));
  const semaphore = join(directory, "lifecycle.lock");
  writeFileSync(semaphore, "", { mode: 0o600 });
  let grandchildPid = null;
  try {
    const holder = advisoryRun(
      semaphore,
      'const childProcess=await import("node:child_process");const grandchild=childProcess.spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{detached:true,stdio:"ignore"});grandchild.unref();console.log(`GRANDCHILD:${grandchild.pid}`);',
    );
    assert.equal(holder.status, 0, holder.stderr);
    grandchildPid = Number.parseInt(
      holder.stdout.match(/GRANDCHILD:(\d+)/)?.[1] ?? "",
      10,
    );
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1);
    process.kill(grandchildPid, 0);
    const reacquired = advisoryRun(semaphore, "process.exit(0)");
    assert.equal(reacquired.status, 0, reacquired.stderr);
  } finally {
    if (Number.isInteger(grandchildPid)) {
      await stopTestPid(grandchildPid);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repository-specific advisory lock paths do not collide", () => {
  const left = lifecycleLockPaths("/synthetic/repository-a");
  const right = lifecycleLockPaths("/synthetic/repository-b");
  assert.notEqual(left.directory, right.directory);
  assert.notEqual(left.semaphore, right.semaphore);
  assert.equal(left.semaphore, join(left.directory, "lifecycle.lock"));
});

function lockOwner(overrides = {}) {
  return {
    version: 1,
    command: "status",
    pid: 7_070,
    startedAt: "Mon Aug 10 01:02:03 2026",
    argv: "/synthetic/node tools/demo-local.mjs status",
    token: "owner-token-0123456789abcdef",
    acquiredAt: "2026-08-10T01:02:03.000Z",
    ...overrides,
  };
}

test("diagnostic owner blocks active identity, replaces stale identity, and resists ABA release", () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-demo-lock-owner-"));
  const ownerPath = join(directory, "owner.json");
  try {
    const previous = lockOwner();
    writeFileSync(ownerPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });
    assert.equal(
      classifyLifecycleLockOwner(previous, {
        startedAt: previous.startedAt,
        argv: previous.argv,
        unstable: false,
      }),
      "active",
    );
    assert.throws(
      () =>
        registerLifecycleLockOwner("status", "new-owner-token-0123456789", {
          ownerPath,
          owner: lockOwner({
            pid: 7_071,
            token: "new-owner-token-0123456789",
          }),
          inspectOwner: () => ({
            startedAt: previous.startedAt,
            argv: previous.argv,
            unstable: false,
          }),
        }),
      /diagnostic owner is still active/,
    );
    assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).token, previous.token);

    const replacement = lockOwner({
      pid: 7_071,
      token: "replacement-token-0123456789",
    });
    const registered = registerLifecycleLockOwner(
      "status",
      replacement.token,
      {
        ownerPath,
        owner: replacement,
        inspectOwner: () => ({
          startedAt: "Mon Aug 10 01:02:04 2026",
          argv: "/different/process",
          unstable: false,
        }),
      },
    );
    assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).token, replacement.token);

    const abaOwner = lockOwner({
      pid: 7_072,
      token: "aba-owner-token-0123456789",
    });
    writeFileSync(ownerPath, `${JSON.stringify(abaOwner)}\n`, { mode: 0o600 });
    assert.throws(
      () => releaseLifecycleLockOwner(registered),
      /owner token or process identity changed/,
    );
    assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).token, abaOwner.token);

    const current = registerLifecycleLockOwner("status", replacement.token, {
      ownerPath,
      owner: replacement,
      inspectOwner: () => null,
    });
    releaseLifecycleLockOwner(current);
    assert.equal(existsSync(ownerPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function pendingFixture({
  name = "worker",
  port = null,
  token = "pending-recovery-unit-token-0001",
  executable = "/synthetic/node",
  cwd = "/synthetic/repository",
} = {}) {
  const condition = `--conditions=oss-demo-process-${token}`;
  const entry = name === "worker" ? "apps/worker/dist/worker.js" : "apps/api/dist/server.js";
  return {
    name,
    token,
    executable,
    args: [condition, entry],
    argv: `${executable} ${condition} ${entry}`,
    cwd,
    host: port === null ? null : "127.0.0.1",
    port,
  };
}

test("pending recovery handles 0/1/>1 candidates and fails closed on every identity mismatch", () => {
  const spec = pendingFixture();
  const pending = pendingProcessRecord(spec);
  const exactCandidate = { pid: 8_080, argv: spec.argv };
  const exactObservation = {
    pid: 8_080,
    startedAt: "Mon Aug 10 01:02:03 2026",
    argv: spec.argv,
    cwd: spec.cwd,
    listener: null,
  };

  assert.deepEqual(
    evaluatePendingProcessRecovery(pending, [], () => null),
    { action: "clear" },
  );
  const promoted = evaluatePendingProcessRecovery(
    pending,
    [exactCandidate],
    () => exactObservation,
  );
  assert.equal(promoted.action, "promote");
  assert.equal(promoted.identity.pid, 8_080);
  assert.equal(promoted.identity.listenerVerified, true);
  assert.equal(promoted.identity.token, spec.token);

  assert.throws(
    () =>
      evaluatePendingProcessRecovery(
        pending,
        [exactCandidate, { ...exactCandidate, pid: 8_081 }],
        () => exactObservation,
      ),
    /2 processes contain its unique argv token/,
  );
  assert.throws(
    () =>
      evaluatePendingProcessRecovery(
        pendingProcessRecord(spec, 8_082),
        [exactCandidate],
        () => exactObservation,
      ),
    /recorded PID 8082 differs/,
  );
  assert.throws(
    () =>
      evaluatePendingProcessRecovery(
        pending,
        [{ pid: 8_080, argv: `${spec.executable} ${spec.args[0]} other.js` }],
        () => exactObservation,
      ),
    /argv does not exactly match/,
  );
  assert.throws(
    () =>
      evaluatePendingProcessRecovery(pending, [exactCandidate], () => ({
        ...exactObservation,
        cwd: "/synthetic/different-repository",
      })),
    /exact PID, argv, and cwd identity could not be verified/,
  );
  assert.throws(
    () =>
      evaluatePendingProcessRecovery(pending, [exactCandidate], () => null),
    /exact PID, argv, and cwd identity could not be verified/,
  );

  const apiSpec = pendingFixture({ name: "api", port: 3_000 });
  const apiPending = pendingProcessRecord(apiSpec, 9_090);
  assert.throws(
    () =>
      evaluatePendingProcessRecovery(
        apiPending,
        [{ pid: 9_090, argv: apiSpec.argv }],
        () => ({
          pid: 9_090,
          startedAt: "Mon Aug 10 01:02:04 2026",
          argv: apiSpec.argv,
          cwd: apiSpec.cwd,
          listener: false,
        }),
      ),
    /not listening on 127\.0\.0\.1:3000/,
  );
});

test("failed-spawn cleanup clears no-child state, escalates only exact identity, and retains mismatches", async () => {
  const spec = pendingFixture();
  const pending = pendingProcessRecord(spec, 8_080);
  const makeState = () => ({
    processes: {},
    pendingProcesses: { worker: pending },
  });

  const clearedState = makeState();
  const clearedSignals = [];
  const cleared = await cleanupExactPendingProcess(pending, clearedState, {
    inspect: () => ({ action: "clear" }),
    signal: (...args) => clearedSignals.push(args),
    persist: (next) => {
      clearedState.pendingProcesses = next;
    },
  });
  assert.equal(cleared, "cleared_no_child");
  assert.deepEqual(clearedSignals, []);
  assert.equal(clearedState.pendingProcesses.worker, undefined);

  const exactState = makeState();
  const exactSignals = [];
  let killed = false;
  let clock = 0;
  const stopped = await cleanupExactPendingProcess(pending, exactState, {
    inspect: () => ({
      action: "promote",
      identity: {
        ...spec,
        pid: 8_080,
        startedAt: "Mon Aug 10 01:02:03 2026",
        listenerVerified: true,
      },
    }),
    identityStillMatches: () => !killed,
    signal: (pid, signalName) => {
      exactSignals.push([pid, signalName]);
      if (signalName === "SIGKILL") killed = true;
    },
    persist: (next) => {
      exactState.pendingProcesses = next;
    },
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
    termTimeoutMs: 100,
    killTimeoutMs: 100,
  });
  assert.equal(stopped, "stopped_exact_child");
  assert.deepEqual(exactSignals, [
    [8_080, "SIGTERM"],
    [8_080, "SIGKILL"],
  ]);
  assert.equal(exactState.pendingProcesses.worker, undefined);

  const retainedState = makeState();
  let retainedPersisted = false;
  const retainedSignals = [];
  const retained = await cleanupExactPendingProcess(pending, retainedState, {
    inspect: () => {
      throw new Error("argv mismatch");
    },
    signal: (...args) => retainedSignals.push(args),
    persist: () => {
      retainedPersisted = true;
    },
  });
  assert.equal(retained, "retained");
  assert.deepEqual(retainedSignals, []);
  assert.equal(retainedPersisted, false);
  assert.equal(retainedState.pendingProcesses.worker, pending);
});

test("real detached token-bearing Node child recovers from the pre-PID crash window", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-demo-pending-real-"));
  const fixture = join(directory, "pending-child.mjs");
  const token = `real-pending-${process.pid}-${Date.now()}`;
  writeFileSync(fixture, "setInterval(() => {}, 1000);\n");
  const spec = pendingFixture({
    token,
    executable: process.execPath,
    cwd: process.cwd(),
  });
  spec.args = [spec.args[0], fixture];
  spec.argv = [spec.executable, ...spec.args].join(" ");
  const pending = pendingProcessRecord(spec);
  const child = spawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    detached: true,
    stdio: "ignore",
  });
  try {
    if (!child.pid) await once(child, "spawn");
    let recovered = null;
    let lastError = null;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && recovered?.action !== "promote") {
      try {
        const resolution = inspectPendingProcess(pending);
        if (resolution.action === "promote") recovered = resolution;
      } catch (error) {
        lastError = error;
      }
      if (recovered?.action !== "promote") {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    assert.equal(recovered?.action, "promote", lastError?.message);
    assert.equal(recovered.identity.pid, child.pid);
    assert.equal(recovered.identity.argv, spec.argv);
    assert.equal(recovered.identity.cwd, spec.cwd);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await childOutcome(child);
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(repository, args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${(result.stderr ?? result.stdout).trim()}`,
  );
  return (result.stdout ?? "").trim();
}

test("source revision fingerprints tracked and untracked worktree content", () => {
  const repository = mkdtempSync(join(tmpdir(), "oss-demo-revision-"));
  try {
    git(repository, ["init", "--quiet"]);
    git(repository, ["config", "user.email", "demo-test@example.invalid"]);
    git(repository, ["config", "user.name", "Synthetic Demo Test"]);
    git(repository, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repository, "tracked.txt"), "clean\n");
    git(repository, ["add", "tracked.txt"]);
    git(repository, ["commit", "--quiet", "-m", "test fixture"]);

    const clean = repositoryRevision(repository);
    assert.match(clean, /^[0-9a-f]{40}$/);

    writeFileSync(join(repository, "tracked.txt"), "dirty tracked\n");
    const trackedDirty = repositoryRevision(repository);
    assert.match(trackedDirty, /^[0-9a-f]{40}\+worktree\.[0-9a-f]{64}$/);
    assert.notEqual(trackedDirty, clean);

    writeFileSync(join(repository, "untracked.txt"), "dirty untracked\n");
    const untrackedDirty = repositoryRevision(repository);
    assert.notEqual(untrackedDirty, trackedDirty);
    writeFileSync(join(repository, "untracked.txt"), "changed untracked\n");
    assert.notEqual(repositoryRevision(repository), untrackedDirty);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("legacy numeric child state migrates only after exact identity verification", () => {
  const spec = {
    name: "api",
    argv: "/synthetic/node apps/api/dist/server.js",
    cwd: "/synthetic/repository",
    host: "127.0.0.1",
    port: 3000,
    token: null,
  };
  const observation = {
    pid: 4242,
    startedAt: "Sun Aug  9 23:56:45 2026",
    argv: spec.argv,
    cwd: spec.cwd,
    listener: true,
  };
  const migrated = verifyStoredProcessIdentity("api", 4242, spec, observation);
  assert.equal(migrated.running, true);
  assert.equal(migrated.migrated, true);
  assert.deepEqual(migrated.identity, {
    name: "api",
    pid: 4242,
    startedAt: observation.startedAt,
    argv: spec.argv,
    cwd: spec.cwd,
    host: "127.0.0.1",
    port: 3000,
    token: null,
    listenerVerified: true,
  });

  assert.throws(
    () =>
      verifyStoredProcessIdentity("api", 4242, spec, {
        ...observation,
        argv: "/synthetic/node another-program.js",
      }),
    /argv or cwd does not exactly match/,
  );
  assert.throws(
    () =>
      verifyStoredProcessIdentity("api", 4242, spec, {
        ...observation,
        listener: false,
      }),
    /not listening on 127\.0\.0\.1:3000/,
  );
});

test("stored start identity rejects PID reuse even when argv, cwd, and listener match", () => {
  const spec = {
    name: "web",
    argv:
      "/synthetic/node --conditions=oss-demo-process-unique node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173",
    cwd: "/synthetic/repository/apps/web",
    host: "127.0.0.1",
    port: 5173,
    token: "unique",
  };
  const stored = {
    ...spec,
    pid: 5151,
    startedAt: "Sun Aug  9 23:56:45 2026",
    listenerVerified: true,
  };
  assert.throws(
    () =>
      verifyStoredProcessIdentity("web", stored, spec, {
        pid: 5151,
        startedAt: "Sun Aug  9 23:57:01 2026",
        argv: spec.argv,
        cwd: spec.cwd,
        listener: true,
      }),
    /stored identity differs/,
  );
});

test("administrator credentials recover from both current and legacy smoke state shapes", () => {
  const current = { email: "current-admin@example.invalid", administrator: true };
  assert.equal(recoverAdministratorAccount({ administratorAccount: current }), current);

  const resultLevel = { email: "result-admin@example.invalid", administrator: true };
  assert.equal(
    recoverAdministratorAccount({ latestSmoke: { administratorAccount: resultLevel } }),
    resultLevel,
  );

  const legacy = { email: "legacy-admin@example.invalid", administrator: true };
  assert.equal(
    recoverAdministratorAccount({ latestSmoke: { syntheticAccount: legacy } }),
    legacy,
  );
  assert.equal(
    recoverAdministratorAccount({
      latestSmoke: { syntheticAccount: { administrator: false } },
    }),
    null,
  );
});

test("Demo session carries the exact account-context version across customer mutations", async () => {
  const requests = [];
  const responses = [
    new Response(JSON.stringify({ id: "customer-user" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "oss_session=session-id; Path=/; HttpOnly",
        "X-OSS-Account-Context-Version": "17",
        "X-OSS-Client-Account-Id": "account-a",
      },
    }),
    new Response(JSON.stringify({ created: true }), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "X-OSS-Account-Context-Version": "18",
        "X-OSS-Client-Account-Id": "account-a",
      },
    }),
    new Response(JSON.stringify({ created: true }), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "X-OSS-Account-Context-Version": "18",
      },
    }),
  ];
  const session = new DemoSession("http://127.0.0.1:3000", async (url, init) => {
    requests.push({ url: String(url), init });
    return responses.shift();
  });

  await session.request("/api/v1/auth/me");
  await session.request(
    "/api/v1/orders",
    { method: "POST", body: JSON.stringify({ synthetic: true }) },
    201,
  );
  await session.request(
    "/api/v1/tickets",
    {
      method: "POST",
      headers: { "X-OSS-Account-Context-Version": "99" },
      body: JSON.stringify({ synthetic: true }),
    },
    201,
  );

  assert.equal(requests[0].init.headers.get("X-OSS-Account-Context-Version"), null);
  assert.equal(requests[1].init.headers.get("X-OSS-Account-Context-Version"), "17");
  assert.equal(requests[1].init.headers.get("Cookie"), "oss_session=session-id");
  assert.equal(
    requests[2].init.headers.get("X-OSS-Account-Context-Version"),
    "99",
    "An explicit test version must not be overwritten",
  );
  assert.equal(session.accountContextVersion, "18");
  assert.equal(
    session.clientAccountId,
    null,
    "An authenticated response without an active-account header must clear the cached account ID",
  );
});

test("Demo session records a newer context version before reporting an API error", async () => {
  const session = new DemoSession("http://127.0.0.1:3000", async () =>
    new Response(JSON.stringify({ code: "ACCOUNT_CONTEXT_STALE" }), {
      status: 409,
      headers: {
        "Content-Type": "application/json",
        "X-OSS-Account-Context-Version": "23",
      },
    }),
  );

  await assert.rejects(
    session.request("/api/v1/orders", { method: "POST", body: "{}" }, 201),
    /ACCOUNT_CONTEXT_STALE/,
  );
  assert.equal(session.accountContextVersion, "23");
});

test("Demo session ignores an older context response that arrives after a newer response", async () => {
  let releaseOlder;
  let releaseNewer;
  const olderResponse = new Promise((resolve) => {
    releaseOlder = resolve;
  });
  const newerResponse = new Promise((resolve) => {
    releaseNewer = resolve;
  });
  const session = new DemoSession("http://127.0.0.1:3000", async (url) => {
    if (url.pathname === "/api/v1/auth/me") {
      return new Response("{}", {
        headers: {
          "Set-Cookie": "oss_session=session-id; Path=/; HttpOnly",
          "X-OSS-Account-Context-Version": "16",
          "X-OSS-Client-Account-Id": "account-a",
        },
      });
    }
    if (url.pathname === "/api/v1/older") return olderResponse;
    if (url.pathname === "/api/v1/newer") return newerResponse;
    throw new Error(`Unexpected Demo request ${url.pathname}`);
  });

  await session.request("/api/v1/auth/me");
  const older = session.request("/api/v1/older");
  const newer = session.request("/api/v1/newer");
  releaseNewer(
    new Response("{}", {
      headers: {
        "X-OSS-Account-Context-Version": "18",
        "X-OSS-Client-Account-Id": "account-b",
      },
    }),
  );
  await newer;
  releaseOlder(
    new Response("{}", {
      headers: {
        "X-OSS-Account-Context-Version": "17",
        "X-OSS-Client-Account-Id": "account-a",
      },
    }),
  );
  await older;

  assert.equal(session.accountContextVersion, "18");
  assert.equal(session.clientAccountId, "account-b");
});

test("Demo session preserves context on public responses and rejects old-session responses", async () => {
  let releaseOldSessionResponse;
  const oldSessionResponse = new Promise((resolve) => {
    releaseOldSessionResponse = resolve;
  });
  const session = new DemoSession("http://127.0.0.1:3000", async (url) => {
    if (url.pathname === "/api/v1/auth/me") {
      return new Response("{}", {
        headers: {
          "Set-Cookie": "oss_session=old-session; Path=/; HttpOnly",
          "X-OSS-Account-Context-Version": "17",
          "X-OSS-Client-Account-Id": "account-a",
        },
      });
    }
    if (url.pathname === "/api/v1/catalog") return new Response("{}");
    if (url.pathname === "/api/v1/old-session") return oldSessionResponse;
    if (url.pathname === "/api/v1/auth/login") {
      return new Response("{}", {
        headers: {
          "Set-Cookie": "oss_session=new-session; Path=/; HttpOnly",
          "X-OSS-Account-Context-Version": "0",
        },
      });
    }
    throw new Error(`Unexpected Demo request ${url.pathname}`);
  });

  await session.request("/api/v1/auth/me");
  await session.request("/api/v1/catalog");
  assert.equal(session.accountContextVersion, "17");
  assert.equal(session.clientAccountId, "account-a");

  const oldRequest = session.request("/api/v1/old-session");
  await session.request("/api/v1/auth/login", { method: "POST", body: "{}" });
  releaseOldSessionResponse(
    new Response("{}", {
      headers: {
        "X-OSS-Account-Context-Version": "18",
        "X-OSS-Client-Account-Id": "account-a",
      },
    }),
  );
  await oldRequest;

  assert.equal(session.cookie, "oss_session=new-session");
  assert.equal(session.accountContextVersion, "0");
  assert.equal(session.clientAccountId, null);
});

test("Demo session treats a logout clear-cookie as terminal and ignores stale context headers", async () => {
  const requests = [];
  const responses = [
    new Response("{}", {
      headers: {
        "Set-Cookie": "oss_session=session-id; Path=/; HttpOnly",
        "X-OSS-Account-Context-Version": "17",
        "X-OSS-Client-Account-Id": "account-a",
      },
    }),
    new Response(null, {
      status: 204,
      headers: {
        "Set-Cookie": "oss_session=; Path=/; HttpOnly; Max-Age=0",
        "X-OSS-Account-Context-Version": "17",
        "X-OSS-Client-Account-Id": "account-a",
      },
    }),
    new Response("{}"),
  ];
  const session = new DemoSession("http://127.0.0.1:3000", async (url, init) => {
    requests.push({ url: String(url), init });
    return responses.shift();
  });

  await session.request("/api/v1/auth/me");
  const epochBeforeLogout = session.sessionEpoch;
  await session.request("/api/v1/auth/logout", { method: "POST", body: "{}" }, 204);

  assert.equal(session.cookie, "");
  assert.equal(session.sessionEpoch, epochBeforeLogout + 1);
  assert.equal(session.accountContextVersion, null);
  assert.equal(session.clientAccountId, null);

  await session.request("/api/v1/catalog");
  assert.equal(requests[2].init.headers.get("Cookie"), null);
  assert.equal(requests[2].init.headers.get("X-OSS-Account-Context-Version"), null);
});

function ticketSessions({ leakInternalNote = false } = {}) {
  const clientAccountId = "customer-account";
  const serviceId = "active-service";
  let internalNoteBody;
  const administratorSession = {
    async request(path, init, expectedStatus) {
      assert.equal(path, "/api/v1/admin/tickets/ticket-id/messages");
      assert.equal(expectedStatus, 201);
      const body = JSON.parse(init.body);
      assert.equal(body.kind, "internal_note");
      internalNoteBody = body.message;
      return {
        ticket: {
          clientAccount: { id: clientAccountId },
          service: { id: serviceId },
        },
        messages: [
          { id: "internal-note-id", visibility: "internal", body: internalNoteBody },
        ],
      };
    },
  };
  const customerSession = {
    async request(path, init, expectedStatus) {
      if (init?.method === "POST") {
        assert.equal(path, "/api/v1/tickets");
        assert.equal(expectedStatus, 201);
        return {
          ticket: {
            id: "ticket-id",
            subject: JSON.parse(init.body).subject,
            service: { id: serviceId },
          },
        };
      }
      assert.equal(path, "/api/v1/tickets/ticket-id");
      return {
        ticket: { id: "ticket-id", status: "open", service: { id: serviceId } },
        messages: leakInternalNote
          ? [{ id: "internal-note-id", visibility: "internal", body: internalNoteBody }]
          : [{ id: "public-message-id", visibility: "public", body: "Synthetic customer message" }],
      };
    },
  };
  return {
    customerSession,
    administrator: {
      session: administratorSession,
      account: {
        userId: "administrator-user",
        clientAccountId: "administrator-account",
      },
    },
    clientAccountId,
    serviceId,
  };
}

test("ticket smoke uses separate Staff/customer identities and proves note invisibility", async () => {
  const fixture = ticketSessions();
  const result = await runSupportTicketSmoke({
    ...fixture,
    customerUserId: "customer-user",
  });
  assert.equal(result.ticketId, "ticket-id");
  assert.equal(result.internalNoteId, "internal-note-id");
  assert.equal(result.internalNoteCustomerVisible, false);

  assert.throws(
    () =>
      assertSeparatedDemoRoles({
        customerSession: fixture.customerSession,
        customerUserId: "customer-user",
        clientAccountId: fixture.clientAccountId,
        administrator: {
          ...fixture.administrator,
          session: fixture.customerSession,
        },
      }),
    /different authenticated sessions/,
  );
  assert.throws(
    () =>
      assertSeparatedDemoRoles({
        customerSession: fixture.customerSession,
        customerUserId: "customer-user",
        clientAccountId: fixture.clientAccountId,
        administrator: {
          ...fixture.administrator,
          account: {
            ...fixture.administrator.account,
            userId: "customer-user",
          },
        },
      }),
    /different users/,
  );
  assert.throws(
    () =>
      assertSeparatedDemoRoles({
        customerSession: fixture.customerSession,
        customerUserId: "customer-user",
        clientAccountId: fixture.clientAccountId,
        administrator: {
          ...fixture.administrator,
          account: {
            ...fixture.administrator.account,
            clientAccountId: fixture.clientAccountId,
          },
        },
      }),
    /different Client Accounts/,
  );
});

test("ticket smoke fails if the customer response exposes the internal note", async () => {
  await assert.rejects(
    runSupportTicketSmoke({
      ...ticketSessions({ leakInternalNote: true }),
      customerUserId: "customer-user",
    }),
    /internal note leaked into the customer ticket view/,
  );
});

test("service operation smoke records Stop, Start, and Reboot terminal facts", async () => {
  const serviceId = "10000000-0000-4000-8000-000000000001";
  const requestIds = [
    "20000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
    "20000000-0000-4000-8000-000000000003",
  ];
  const facts = [];
  let resourceState = "running";
  let resourceRevision = 1;
  const requestedActions = [];
  const customerSession = {
    async request(path, init, expectedStatus) {
      assert.equal(path, `/api/v1/services/${serviceId}/operations`);
      if (init?.method === "POST") {
        assert.equal(expectedStatus, 201);
        const body = JSON.parse(init.body);
        const expectedAction = ["stop", "start", "reboot"][requestedActions.length];
        assert.equal(body.action, expectedAction);
        assert.equal(body.expectedServiceVersion, 1);
        assert.equal(body.expectedResourceRevision, resourceRevision);
        requestedActions.push(body.action);
        resourceState = body.action === "stop" ? "stopped" : "running";
        resourceRevision += 1;
        const requestId = requestIds[facts.length];
        facts.unshift({
          requestId,
          action: body.action,
          executionMode: "automatic",
          status: "succeeded",
          resultingResourceState: resourceState,
          revision: 2,
        });
        return {
          requestId,
          serviceId,
          action: body.action,
          executionMode: "automatic",
          status: "queued",
          replayed: false,
        };
      }
      return {
        warning: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY",
        service: {
          id: serviceId,
          status: "active",
          version: 1,
          resourceState,
          resourceRevision,
          availableActions: resourceState === "stopped" ? ["start"] : ["stop", "reboot"],
        },
        items: facts,
      };
    },
  };

  const result = await runServiceOperationsSmoke({
    customerSession,
    serviceId,
    timeoutMs: 1_000,
  });
  assert.deepEqual(requestedActions, ["stop", "start", "reboot"]);
  assert.deepEqual(result.requests.map((request) => request.requestId), requestIds);
  assert.deepEqual(result.requests.map((request) => request.status), [
    "succeeded",
    "succeeded",
    "succeeded",
  ]);
  assert.equal(result.finalServiceStatus, "active");
  assert.equal(result.finalResourceState, "running");
  assert.equal(result.finalResourceRevision, 4);
});
