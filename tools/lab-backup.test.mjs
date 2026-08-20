// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  LAB_WARNING,
  MANIFEST_FORMAT,
  DEMO_LOCAL_RESTORE_FORMAT,
  buildRestorePlan,
  createBackup,
  databaseEnvironment,
  normalizeProfile,
  restoreDemoLocal,
  validateManifest,
  verifyBackup,
} from "./lab-backup.mjs";

const COMMIT = "603c77c9c211bace23f1ac2a0286f4c1e7e13df6";
const DIGEST = "a".repeat(64);

const manifestSchema = JSON.parse(
  readFileSync(new URL("../docs/operators/lab-rc-release-manifest.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validateManifestSchema = ajv.compile(manifestSchema);

function assertSchemaValid(document) {
  assert.equal(validateManifestSchema(document), true, ajv.errorsText(validateManifestSchema.errors));
}

function executable(path, body) {
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fakeTools(directory, options = {}) {
  const bin = join(directory, "bin");
  const psqlTrace = join(directory, "psql-trace.jsonl");
  mkdirSync(bin);
  executable(
    join(bin, "psql"),
    `const fs=require("node:fs");let sql="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>sql+=c);process.stdin.on("end",()=>{
      if(Object.keys(process.env).some(k=>k.includes("DATABASE_URL")||k.startsWith("LAB_RC_")))process.exit(12);
      if(process.argv.includes("--version")){console.log("psql (PostgreSQL) 18.2");return;}
      const repair=sql.includes("schema024_logical_restore_semantic_repair");
      fs.appendFileSync(${JSON.stringify(psqlTrace)},JSON.stringify({database:process.env.PGDATABASE||"",repair})+"\\n");
      if(repair){
        const required=[
          "024_stage_c_identity_security",
          "SET LOCAL search_path TO public, pg_catalog",
          "LOCK TABLE public.users, public.identity_email_change_events IN ACCESS EXCLUSIVE MODE",
          "CHECK (old_email IS DISTINCT FROM new_email)",
          "CHECK (old_email::text IS DISTINCT FROM new_email::text)",
          "WHEN (new.email IS DISTINCT FROM old.email)",
          "WHEN (new.email::text IS DISTINCT FROM old.email::text)",
          "constraint_definition IS DISTINCT FROM",
          "trigger_definition IS DISTINCT FROM",
          "actual.contype::text",
          "actual.convalidated",
          "actual.condeferrable",
          "actual.condeferred",
          "actual.connoinherit",
          "actual.tgenabled::text",
          "actual.tgtype::text",
          "actual.tgdeferrable",
          "actual.tginitdeferred",
          "actual.tgisinternal",
          "procedure_namespace.nspname",
          "procedure.proname"
        ];
        const requiredBeforeAndAfter=[
          "constraint_type IS DISTINCT FROM 'c'",
          "constraint_validated IS DISTINCT FROM true",
          "constraint_deferrable IS DISTINCT FROM false",
          "constraint_deferred IS DISTINCT FROM false",
          "constraint_no_inherit IS DISTINCT FROM false",
          "trigger_enabled IS DISTINCT FROM 'O'",
          "trigger_type IS DISTINCT FROM '17'",
          "trigger_deferrable IS DISTINCT FROM false",
          "trigger_initially_deferred IS DISTINCT FROM false",
          "trigger_internal IS DISTINCT FROM false",
          "trigger_function_namespace IS DISTINCT FROM 'public'",
          "trigger_function_name IS DISTINCT FROM 'opensales_record_email_change_event'"
        ];
        if(required.some(value=>!sql.includes(value))||requiredBeforeAndAfter.some(value=>sql.split(value).length<3))process.exit(15);
        if(${JSON.stringify(options.failSchema024Repair ?? false)})process.exit(16);
        return;
      }
      if(sql.includes("blank_database_object_count"))console.log((process.env.PGDATABASE||"fixture")+"\\t180002\\t"+(${JSON.stringify(options.nonBlankDatabase ?? "")}===(process.env.PGDATABASE||"")?"1":"0"));
      else if(sql.includes("server_version_num"))console.log("180002");
      else if(sql.includes("schema_migrations"))console.log("021_stage_c_support_operations\\n022_stage_c_catalog_commerce_hardening\\n024_stage_c_identity_security");
      else if(sql.includes("support_ticket_attachments"))console.log(${JSON.stringify(options.invalidAttachment ? "2\t9\t1" : "2\t9\t0")});
      else if(sql.includes("pg_catalog.pg_tables"))console.log("mock_events\\nmock_operations");
      else process.exitCode=2;
    });`,
  );
  executable(
    join(bin, "pg_dump"),
    `if(Object.keys(process.env).some(k=>k.includes("DATABASE_URL")||k.startsWith("LAB_RC_")))process.exit(11);
     if(process.argv.includes("--version")){console.log("pg_dump (PostgreSQL) 18.2");process.exit(0);}
     if(process.argv.some(v=>v.includes("postgresql://")||v.includes("password")))process.exit(9);
     process.stdout.write("PGDMP:"+(process.env.PGDATABASE||process.env.PGSERVICE));`,
  );
  executable(
    join(bin, "pg_restore"),
    `const restoring=process.argv.includes("--dbname=");
     if(Object.keys(process.env).some(k=>k.includes("DATABASE_URL")||k.startsWith("LAB_RC_")||(!restoring&&(k==="PGPASSWORD"||k==="PGPASSFILE"))))process.exit(12);
     if(process.argv.includes("--version")){console.log("pg_restore (PostgreSQL) 18.2");process.exit(0);}
     let data="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{
       if(!data.startsWith("PGDMP:"))process.exitCode=8;
       if(restoring&&${JSON.stringify(options.failRestoreDatabase ?? "")}===(process.env.PGDATABASE||"")){console.error("fixture restore failed");process.exitCode=7;}
     });`,
  );
  executable(
    join(bin, "age"),
    `const fs=require("node:fs");
     if(Object.keys(process.env).some(k=>k.includes("DATABASE_URL")||k.startsWith("LAB_RC_")||k==="PGPASSWORD"||k==="PGPASSFILE"))process.exit(14);
     if(process.argv.includes("--version")){console.log("v1.2.1");process.exit(0);}
     if(process.argv.some(value=>value.includes("fixture-identity")))process.exit(13);
     if(process.argv.includes("--decrypt")){
       const input=fs.readFileSync(process.argv.at(-1));
       process.stdout.write(input.subarray(Buffer.from("age-encryption.org/v1\\n").length));
     }else{
       const output=process.argv[process.argv.indexOf("--output")+1];let chunks=[];
       process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",()=>fs.writeFileSync(output,Buffer.concat([Buffer.from("age-encryption.org/v1\\n"),...chunks])));
     }`,
  );
  return {
    LAB_RC_AGE_BIN: join(bin, "age"),
    LAB_RC_PG_DUMP_BIN: join(bin, "pg_dump"),
    LAB_RC_PG_RESTORE_BIN: join(bin, "pg_restore"),
    LAB_RC_PSQL_BIN: join(bin, "psql"),
  };
}

function cleanRepository(directory) {
  const repository = join(directory, "repository");
  mkdirSync(repository);
  writeFileSync(join(repository, "fixture.txt"), "release fixture\n");
  for (const args of [
    ["init", "--quiet"],
    ["add", "fixture.txt"],
    [
      "-c", "user.name=OpenSales Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--quiet", "-m", "fixture release",
    ],
  ]) {
    const result = spawnSync("git", args, { cwd: repository, stdio: "ignore" });
    assert.equal(result.status, 0);
  }
  return repository;
}

function databaseEnv(prefix, database) {
  return {
    [`${prefix}_PGHOST`]: "fixture-db",
    [`${prefix}_PGUSER`]: "fixture-user",
    [`${prefix}_PGDATABASE`]: database,
    [`${prefix}_PGPASSWORD`]: "fixture-password-never-recorded",
  };
}

async function demoLocalBackupFixture(directory, toolOptions = {}) {
  const archive = join(directory, "backup");
  const identity = join(directory, "fixture-identity");
  const toolEnv = fakeTools(directory, toolOptions);
  const repositoryRoot = cleanRepository(directory);
  const env = {
    ...process.env,
    ...toolEnv,
    ...databaseEnv("LAB_RC_CORE", "oss_restore_fixture"),
    ...databaseEnv("LAB_RC_PROVIDER_PAYMENT", "payment_restore_fixture"),
    ...databaseEnv("LAB_RC_PROVIDER_PROVISIONING", "provisioning_restore_fixture"),
    ...databaseEnv("LAB_RC_PROVIDER_MAIL", "mail_restore_fixture"),
    LAB_RC_AGE_IDENTITY_FILE: identity,
  };
  writeFileSync(identity, "AGE-SECRET-KEY-DEMO-LOCAL-FIXTURE\n", { mode: 0o600 });
  await createBackup({
    profile: "DemoLocal",
    output: archive,
    recipient: "age1fixturefixturefixturefixturefixturefixturefixture",
    configurationVersion: "demo-local-restore-config-fixture-1",
    credentialSetVersion: "demo-local-restore-credential-fixture-1",
    pausedAt: new Date(Date.now() - 1_000).toISOString(),
    repositoryRoot,
    env,
    stdin: [Buffer.from("private Demo-local restore fixture configuration")],
  });
  return { archive, env };
}

function manifest(profile = "TestA") {
  const databaseIds = profile === "TestB"
    ? ["provider-payment", "provider-provisioning", "provider-mail", "provider-platform"]
    : profile === "local"
      ? ["core", "provider-payment", "provider-provisioning", "provider-mail", "provider-platform"]
      : profile === "DemoLocal"
        ? ["core", "provider-payment", "provider-provisioning", "provider-mail"]
        : ["core"];
  const databases = databaseIds.map((id) => ({
    id,
    ownerProfile: id === "core" ? "TestA" : "TestB",
    contents: profile === "DemoLocal" && id === "provider-provisioning"
      ? ["provider-provisioning", "provider-platform-shared"]
      : profile === "DemoLocal" && id === "provider-mail"
        ? ["provider-mail", "provider-mailbox-shared"]
        : [id],
    artifact: `artifacts/${id}.dump.age`,
    serverVersionNumber: 180002,
    schemaHistory: { kind: id === "core" ? "migration-history" : "table-inventory", versions: ["fixture"] },
    ...(id === "core" ? { attachmentInventory: { count: 0, totalBytes: 0, invalid: 0 } } : {}),
  }));
  const configurationVersion = "config-v1";
  const credentialSetVersion = "credentials-v1";
  const versionBindingSha256 = createHash("sha256")
    .update(COMMIT)
    .update("\0")
    .update(profile)
    .update("\0")
    .update(configurationVersion)
    .update("\0")
    .update(credentialSetVersion)
    .digest("hex");
  return {
    format: MANIFEST_FORMAT,
    warning: LAB_WARNING,
    status: "complete",
    profile,
    release: {
      commit: COMMIT,
      configurationVersion,
      credentialSetVersion,
      versionBindingSha256,
    },
    consistency: {
      operatorAssertion: "application writers were stopped before capture",
      sideEffectsPausedAt: "2026-08-13T00:00:00.000Z",
      workerDispatchPaused: true,
      providerMutationPaused: true,
      multiDatabaseCapture: "ordered logical dumps inside the recorded capture window",
    },
    timing: {
      startedAt: "2026-08-13T00:01:00.000Z",
      completedAt: "2026-08-13T00:02:00.000Z",
      elapsedMilliseconds: 60_000,
    },
    tools: {
      node: "v24.18.0",
      pgDump: "pg_dump (PostgreSQL) 18.2",
      pgRestore: "pg_restore (PostgreSQL) 18.2",
      psql: "psql (PostgreSQL) 18.2",
      age: "v1.2.1",
    },
    databases,
    artifacts: [
      ...databaseIds.map((id) => ({
        file: `artifacts/${id}.dump.age`, kind: "postgresql-custom-dump", component: id,
        encryption: "age-v1", sha256: DIGEST, bytes: 100,
      })),
      {
        file: "artifacts/configuration-credentials.bundle.age", kind: "configuration-credential-bundle",
        component: profile, encryption: "age-v1", sha256: DIGEST, bytes: 100,
      },
    ],
  };
}

test("profiles normalize to exact reviewed database inventories", () => {
  assert.equal(normalizeProfile("test-a"), "TestA");
  assert.equal(normalizeProfile("TestB"), "TestB");
  assert.equal(normalizeProfile("demo-local"), "DemoLocal");
  assert.throws(() => normalizeProfile("production"), /profile must be/);
  assert.equal(validateManifest(manifest("TestB")).databases.length, 4);
  assertSchemaValid(manifest("TestA"));
  assertSchemaValid(manifest("TestB"));
  assertSchemaValid(manifest("local"));
  assertSchemaValid(manifest("DemoLocal"));
  const extraField = structuredClone(manifest("TestA"));
  extraField.release.unreviewed = true;
  assert.equal(validateManifestSchema(extraField), false);
  const missingAttachments = structuredClone(manifest("TestA"));
  delete missingAttachments.databases[0].attachmentInventory;
  assert.equal(validateManifestSchema(missingAttachments), false);
  const providerWithAttachments = structuredClone(manifest("TestB"));
  providerWithAttachments.databases[0].attachmentInventory = { count: 0, totalBytes: 0, invalid: 0 };
  assert.equal(validateManifestSchema(providerWithAttachments), false);
});

test("DemoLocal profile records the launcher's four physical databases and shared Provider contents", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-lab-backup-demo-local-"));
  const output = join(directory, "backup");
  try {
    const toolEnv = fakeTools(directory);
    const repositoryRoot = cleanRepository(directory);
    const env = {
      ...process.env,
      ...toolEnv,
      ...databaseEnv("LAB_RC_CORE", "oss_fixture"),
      ...databaseEnv("LAB_RC_PROVIDER_PAYMENT", "payment_fixture"),
      ...databaseEnv("LAB_RC_PROVIDER_PROVISIONING", "provisioning_fixture"),
      ...databaseEnv("LAB_RC_PROVIDER_MAIL", "mail_fixture"),
    };
    const result = await createBackup({
      profile: "DemoLocal",
      output,
      recipient: "age1fixturefixturefixturefixturefixturefixturefixture",
      configurationVersion: "demo-local-config-fixture-1",
      credentialSetVersion: "demo-local-credential-fixture-1",
      pausedAt: new Date(Date.now() - 1_000).toISOString(),
      repositoryRoot,
      env,
      stdin: [Buffer.from("private Demo-local fixture configuration")],
    });
    assert.deepEqual(
      result.databases.map(({ id }) => id),
      ["core", "provider-payment", "provider-provisioning", "provider-mail"],
    );
    assert.match(
      result.databases.find(({ id }) => id === "provider-provisioning").contents.join(" "),
      /Provider Platform/,
    );
    assert.match(
      result.databases.find(({ id }) => id === "provider-mail").contents.join(" "),
      /mailbox/,
    );
    assert.equal(result.artifacts.length, 5);
    assertSchemaValid(result);
    assert.equal((await verifyBackup({ archive: output, deep: false, env })).status, "verified");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("DemoLocal blank restore dry-run deep-verifies all four distinct blank targets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-demo-local-restore-dry-run-"));
  try {
    const { archive, env } = await demoLocalBackupFixture(directory);
    const journal = join(directory, "restore-journal");
    const state = await restoreDemoLocal({ archive, journal, dryRun: true, resume: false, env });
    assert.equal(state.format, DEMO_LOCAL_RESTORE_FORMAT);
    assert.equal(state.status, "dry-run-complete");
    assert.equal(state.dryRun, true);
    assert.deepEqual(state.completed, []);
    assert.equal(existsSync(join(journal, "restore-state.json")), true);
    assert.equal(existsSync(join(journal, "01-core.log")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("DemoLocal blank restore runs in order and completed resume performs no database restore", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-demo-local-restore-complete-"));
  try {
    const { archive, env } = await demoLocalBackupFixture(directory);
    const journal = join(directory, "restore-journal");
    const state = await restoreDemoLocal({ archive, journal, dryRun: false, resume: false, env });
    assert.equal(state.status, "complete");
    assert.deepEqual(
      state.completed.map(({ id }) => id),
      ["core", "provider-payment", "provider-provisioning", "provider-mail"],
    );
    for (const completed of state.completed) {
      assert.equal(existsSync(join(journal, completed.log)), true);
      assert.match(readFileSync(join(journal, completed.log), "utf8"), /completed .* manifest comparison/);
    }
    const repairCalls = readFileSync(join(directory, "psql-trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(({ repair }) => repair);
    assert.deepEqual(repairCalls, [{ database: "oss_restore_fixture", repair: true }]);
    assert.match(
      readFileSync(join(journal, "01-core.log"), "utf8"),
      /completed exact Schema 024 logical-restore semantic repair gate/,
    );
    const beforeResume = readFileSync(join(journal, "restore-state.json"), "utf8");
    const resumed = await restoreDemoLocal({ archive, journal, dryRun: false, resume: true, env });
    assert.equal(resumed.status, "complete");
    assert.equal(readFileSync(join(journal, "restore-state.json"), "utf8"), beforeResume);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("DemoLocal blank restore stops before Provider databases when the exact Schema 024 repair gate fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-demo-local-restore-schema024-repair-"));
  try {
    const { archive, env } = await demoLocalBackupFixture(directory, {
      failSchema024Repair: true,
    });
    const journal = join(directory, "restore-journal");
    await assert.rejects(
      restoreDemoLocal({ archive, journal, dryRun: false, resume: false, env }),
      /core restore failed; execution stopped and the journal was preserved/,
    );
    const state = JSON.parse(readFileSync(join(journal, "restore-state.json"), "utf8"));
    assert.equal(state.status, "failed");
    assert.deepEqual(state.completed, []);
    assert.equal(state.failed.id, "core");
    assert.match(
      readFileSync(join(journal, state.failed.log), "utf8"),
      /Schema 024 logical-restore semantic repair failed for core/,
    );
    assert.equal(existsSync(join(journal, "02-provider-payment.log")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("DemoLocal blank restore stops on first fixture failure and preserves its journal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-demo-local-restore-failure-"));
  try {
    const { archive, env } = await demoLocalBackupFixture(directory, { failRestoreDatabase: "oss_restore_fixture" });
    const journal = join(directory, "restore-journal");
    await assert.rejects(
      restoreDemoLocal({ archive, journal, dryRun: false, resume: false, env }),
      /core restore failed; execution stopped and the journal was preserved/,
    );
    const state = JSON.parse(readFileSync(join(journal, "restore-state.json"), "utf8"));
    assert.equal(state.status, "failed");
    assert.deepEqual(state.completed, []);
    assert.equal(state.failed.id, "core");
    assert.match(readFileSync(join(journal, state.failed.log), "utf8"), /fixture restore failed/);
    assert.equal(existsSync(join(journal, "02-provider-payment.log")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("DemoLocal blank restore refuses a nonblank target before starting any restore", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-demo-local-restore-nonblank-"));
  try {
    const { archive, env } = await demoLocalBackupFixture(directory, { nonBlankDatabase: "payment_restore_fixture" });
    const journal = join(directory, "restore-journal");
    await assert.rejects(
      restoreDemoLocal({ archive, journal, dryRun: true, resume: false, env }),
      /provider-payment restore target is not a blank database/,
    );
    assert.equal(existsSync(join(journal, "01-core.log")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database environment rejects URLs and maps only component-scoped libpq fields", () => {
  const database = { id: "core", envPrefix: "LAB_RC_CORE" };
  assert.throws(
    () => databaseEnvironment(database, { LAB_RC_CORE_DATABASE_URL: "postgresql://example" }),
    /forbidden/,
  );
  const result = databaseEnvironment(database, {
    PGDATABASE: "ambient-must-not-leak",
    LAB_RC_CORE_PGHOST: "db",
    LAB_RC_CORE_PGUSER: "role",
    LAB_RC_CORE_PGDATABASE: "oss",
    LAB_RC_CORE_PGPASSWORD: "not-in-argv",
  });
  assert.equal(result.PGDATABASE, "oss");
  assert.equal(result.PGPASSWORD, "not-in-argv");
  assert.equal(result.PGHOST, "db");
});

test("manifest validation rejects sensitive values, absolute paths, and traversal", () => {
  const withUrl = structuredClone(manifest());
  withUrl.release.databaseUrl = "postgresql://user:value@example/db";
  assert.throws(() => validateManifest(withUrl), /forbidden sensitive field/);
  const withPath = structuredClone(manifest());
  withPath.artifacts[0].file = "/private/backup.dump.age";
  assert.throws(() => validateManifest(withPath), /absolute path|unsafe artifact/);
  const traversal = structuredClone(manifest());
  traversal.artifacts[0].file = "artifacts/../escape.dump.age";
  assert.throws(() => validateManifest(traversal), /unsafe artifact/);
});

test("restore plan remains paused and encodes forward-only migration and rollback boundaries", () => {
  const plan = buildRestorePlan(manifest(), "2026-08-13T00:03:00.000Z");
  assert.equal(plan.status, "paused-awaiting-native-integrity-and-reconciliation");
  assert.equal(plan.safetyGate.workerDispatch, "disabled");
  assert.equal(plan.safetyGate.providerMutation, "disabled");
  assert.equal(plan.safetyGate.automaticResume, false);
  assert.equal(plan.upgradeBoundary.forwardOnlyDatabaseMigration, true);
  assert.equal(plan.rollbackBoundary.downMigrationAllowed, false);
});

test("create, verify, and deep verify use encrypted fixture artifacts without leaking connection data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-lab-backup-"));
  const output = join(directory, "backup");
  try {
    const toolEnv = fakeTools(directory);
    const repositoryRoot = cleanRepository(directory);
    const env = {
      ...process.env,
      ...toolEnv,
      ...databaseEnv("LAB_RC_CORE", "oss_fixture"),
      LAB_RC_AGE_IDENTITY_FILE: join(directory, "fixture-identity"),
    };
    writeFileSync(env.LAB_RC_AGE_IDENTITY_FILE, "AGE-SECRET-KEY-FIXTURE\n", { mode: 0o600 });
    const result = await createBackup({
      profile: "TestA",
      output,
      recipient: "age1fixturefixturefixturefixturefixturefixturefixture",
      configurationVersion: "config-fixture-1",
      credentialSetVersion: "credential-fixture-1",
      pausedAt: new Date(Date.now() - 1_000).toISOString(),
      repositoryRoot,
      env,
      stdin: [Buffer.from("private fixture configuration")],
    });
    assert.equal(result.databases[0].attachmentInventory.count, 2);
    assert.equal(result.databases[0].attachmentInventory.totalBytes, 9);
    const serialized = readFileSync(join(output, "manifest.json"), "utf8");
    assertSchemaValid(JSON.parse(serialized));
    assert.doesNotMatch(serialized, /fixture-password-never-recorded|postgresql:\/\//);
    assert.doesNotMatch(serialized, new RegExp(directory.replaceAll("/", "\\/")));

    const repositoryBackupDirectory = join(repositoryRoot, "operator-backups");
    mkdirSync(repositoryBackupDirectory);
    writeFileSync(join(repositoryRoot, ".git", "info", "exclude"), "/operator-backups/\n", { flag: "a" });
    const repositoryBackupAlias = join(directory, "lexically-outside-repository");
    symlinkSync(repositoryBackupDirectory, repositoryBackupAlias);
    await assert.rejects(
      createBackup({
        profile: "TestA",
        output: join(repositoryBackupAlias, "escaped-backup"),
        recipient: "age1fixturefixturefixturefixturefixturefixturefixture",
        configurationVersion: "config-fixture-1",
        credentialSetVersion: "credential-fixture-1",
        pausedAt: new Date(Date.now() - 1_000).toISOString(),
        repositoryRoot,
        env,
        stdin: [Buffer.from("private fixture configuration")],
      }),
      /backup output must be outside the repository/,
    );
    assert.equal(existsSync(join(repositoryBackupDirectory, "escaped-backup")), false);

    const shallow = await verifyBackup({ archive: output, deep: false, env });
    assert.equal(shallow.deep, "not-requested");
    const deep = await verifyBackup({ archive: output, deep: true, env });
    assert.equal(deep.deep, "passed");

    const archiveAlias = join(directory, "lexically-outside-archive");
    symlinkSync(output, archiveAlias);
    const restorePlanResult = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./lab-backup.mjs", import.meta.url)),
        "restore-plan",
        "--archive",
        output,
        "--output",
        join(archiveAlias, "escaped-restore-plan.json"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(restorePlanResult.status, 1);
    assert.match(restorePlanResult.stderr, /restore plan output must be outside the immutable backup archive/);
    assert.equal(existsSync(join(output, "escaped-restore-plan.json")), false);

    const archiveLink = join(directory, "backup-link");
    symlinkSync(output, archiveLink);
    await assert.rejects(
      verifyBackup({ archive: archiveLink, deep: false, env }),
      /non-symlink directory/,
    );

    const movedArtifacts = join(directory, "moved-artifacts");
    renameSync(join(output, "artifacts"), movedArtifacts);
    symlinkSync(movedArtifacts, join(output, "artifacts"));
    await assert.rejects(
      verifyBackup({ archive: output, deep: false, env }),
      /artifacts.*non-symlink directory/,
    );
    rmSync(join(output, "artifacts"));
    renameSync(movedArtifacts, join(output, "artifacts"));

    const artifactPath = join(output, result.databases[0].artifact);
    const movedArtifact = join(directory, "moved-core.dump.age");
    renameSync(artifactPath, movedArtifact);
    symlinkSync(movedArtifact, artifactPath);
    await assert.rejects(
      verifyBackup({ archive: output, deep: false, env }),
      /artifact.*non-symlink file/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TestB creation captures all four isolated Provider PostgreSQL 18 databases", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-lab-backup-test-b-"));
  const output = join(directory, "backup");
  try {
    const toolEnv = fakeTools(directory);
    const repositoryRoot = cleanRepository(directory);
    const env = {
      ...process.env,
      ...toolEnv,
      ...databaseEnv("LAB_RC_PROVIDER_PAYMENT", "payment_fixture"),
      ...databaseEnv("LAB_RC_PROVIDER_PROVISIONING", "provisioning_fixture"),
      ...databaseEnv("LAB_RC_PROVIDER_MAIL", "mail_fixture"),
      ...databaseEnv("LAB_RC_PROVIDER_PLATFORM", "platform_fixture"),
      LAB_RC_AGE_IDENTITY_FILE: join(directory, "provider-fixture-identity"),
    };
    writeFileSync(env.LAB_RC_AGE_IDENTITY_FILE, "AGE-SECRET-KEY-PROVIDER-FIXTURE\n", { mode: 0o600 });
    const result = await createBackup({
      profile: "TestB",
      output,
      recipient: "age1fixturefixturefixturefixturefixturefixturefixture",
      configurationVersion: "provider-config-fixture-1",
      credentialSetVersion: "provider-credential-fixture-1",
      pausedAt: new Date(Date.now() - 1_000).toISOString(),
      repositoryRoot,
      env,
      stdin: [Buffer.from("private Provider fixture configuration")],
    });
    assert.deepEqual(
      result.databases.map(({ id }) => id),
      ["provider-payment", "provider-provisioning", "provider-mail", "provider-platform"],
    );
    assert.equal(result.artifacts.length, 5);
    assertSchemaValid(result);
    assert.equal((await verifyBackup({ archive: output, deep: false, env })).status, "verified");
    assert.equal((await verifyBackup({ archive: output, deep: true, env })).deep, "passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TestA creation rejects a nonzero database-native attachment integrity violation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oss-lab-backup-invalid-attachment-"));
  const output = join(directory, "backup");
  try {
    const toolEnv = fakeTools(directory, { invalidAttachment: true });
    const repositoryRoot = cleanRepository(directory);
    const env = {
      ...process.env,
      ...toolEnv,
      ...databaseEnv("LAB_RC_CORE", "oss_invalid_attachment_fixture"),
    };
    await assert.rejects(
      createBackup({
        profile: "TestA",
        output,
        recipient: "age1fixturefixturefixturefixturefixturefixturefixture",
        configurationVersion: "invalid-attachment-config-fixture-1",
        credentialSetVersion: "invalid-attachment-credential-fixture-1",
        pausedAt: new Date(Date.now() - 1_000).toISOString(),
        repositoryRoot,
        env,
        stdin: [Buffer.from("private invalid-attachment fixture configuration")],
      }),
      /attachment whose stored digest or size is invalid/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
