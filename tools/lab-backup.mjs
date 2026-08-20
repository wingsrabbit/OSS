#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  existsSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LAB_WARNING = "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY";
export const MANIFEST_FORMAT = "opensales-lab-rc-backup/v1";
export const RESTORE_PLAN_FORMAT = "opensales-lab-rc-restore-plan/v1";
export const DEMO_LOCAL_RESTORE_FORMAT = "opensales-lab-rc-demo-local-restore/v1";
export const LAB_PROFILE_RESTORE_FORMAT = "opensales-lab-rc-profile-restore/v1";

const DATABASES = Object.freeze({
  core: Object.freeze({
    id: "core",
    envPrefix: "LAB_RC_CORE",
    owner: "TestA",
    contents: ["core PostgreSQL 18", "database-resident support attachments"],
  }),
  "provider-payment": Object.freeze({
    id: "provider-payment",
    envPrefix: "LAB_RC_PROVIDER_PAYMENT",
    owner: "TestB",
    contents: ["Mock payment provider PostgreSQL 18"],
  }),
  "provider-provisioning": Object.freeze({
    id: "provider-provisioning",
    envPrefix: "LAB_RC_PROVIDER_PROVISIONING",
    owner: "TestB",
    contents: ["Mock provisioning provider PostgreSQL 18"],
  }),
  "provider-mail": Object.freeze({
    id: "provider-mail",
    envPrefix: "LAB_RC_PROVIDER_MAIL",
    owner: "TestB",
    contents: ["Mock mail provider and mailbox PostgreSQL 18"],
  }),
  "provider-platform": Object.freeze({
    id: "provider-platform",
    envPrefix: "LAB_RC_PROVIDER_PLATFORM",
    owner: "TestB",
    contents: ["six-capability Mock Provider Platform PostgreSQL 18"],
  }),
});

const PROFILES = Object.freeze({
  TestA: Object.freeze([DATABASES.core]),
  TestB: Object.freeze([
    DATABASES["provider-payment"],
    DATABASES["provider-provisioning"],
    DATABASES["provider-mail"],
    DATABASES["provider-platform"],
  ]),
  local: Object.freeze(Object.values(DATABASES)),
  DemoLocal: Object.freeze([
    DATABASES.core,
    DATABASES["provider-payment"],
    Object.freeze({
      ...DATABASES["provider-provisioning"],
      contents: Object.freeze([
        "Mock provisioning provider PostgreSQL 18",
        "six-capability Mock Provider Platform PostgreSQL 18 (shared Demo-local database)",
      ]),
    }),
    Object.freeze({
      ...DATABASES["provider-mail"],
      contents: Object.freeze([
        "Mock mail provider PostgreSQL 18",
        "Mock mailbox PostgreSQL 18 (shared Demo-local database)",
      ]),
    }),
  ]),
});

const LIBPQ_SUFFIXES = Object.freeze([
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGUSER",
  "PGDATABASE",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSSLMODE",
  "PGSSLROOTCERT",
  "PGSSLCERT",
  "PGSSLKEY",
  "PGCHANNELBINDING",
  "PGCONNECT_TIMEOUT",
]);

const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+@-]{0,127}$/;
const SAFE_RECIPIENT = /^[A-Za-z0-9][A-Za-z0-9+/=:_-]{5,511}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const AGE_HEADER = Buffer.from("age-encryption.org/v1\n", "utf8");
const MAX_SECRET_BUNDLE_BYTES = 64 * 1024 * 1024;
const SCHEMA_024 = "024_stage_c_identity_security";

const SCHEMA_024_NATIVE_EMAIL_CHANGE_CONSTRAINT =
  "CHECK (old_email IS DISTINCT FROM new_email)";
const SCHEMA_024_RESTORED_EMAIL_CHANGE_CONSTRAINT =
  "CHECK (old_email::text IS DISTINCT FROM new_email::text)";
const SCHEMA_024_NATIVE_EMAIL_CHANGE_TRIGGER =
  "CREATE TRIGGER users_record_email_change_event AFTER UPDATE OF email ON users FOR EACH ROW WHEN (new.email IS DISTINCT FROM old.email) EXECUTE FUNCTION opensales_record_email_change_event()";
const SCHEMA_024_RESTORED_EMAIL_CHANGE_TRIGGER =
  "CREATE TRIGGER users_record_email_change_event AFTER UPDATE OF email ON users FOR EACH ROW WHEN (new.email::text IS DISTINCT FROM old.email::text) EXECUTE FUNCTION opensales_record_email_change_event()";

function fail(message) {
  const error = new Error(message);
  error.code = "LAB_RC_ERROR";
  throw error;
}

export function normalizeProfile(value) {
  const normalized = String(value ?? "").toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  if (normalized === "testa") return "TestA";
  if (normalized === "testb") return "TestB";
  if (normalized === "local") return "local";
  if (normalized === "demolocal") return "DemoLocal";
  fail("profile must be TestA, TestB, local, or DemoLocal");
}

function parseIso(value, label) {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) fail(`${label} must be an ISO-8601 timestamp`);
  return new Date(timestamp).toISOString();
}

function safeVersion(value, label) {
  if (!SAFE_VERSION.test(String(value ?? ""))) {
    fail(`${label} must be a non-secret release identifier (1-128 safe characters)`);
  }
  return String(value);
}

function jsonFile(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function canonicalProspectivePath(path) {
  const suffix = [];
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) fail("cannot resolve an existing parent directory");
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function pathIsWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`));
}

function commandVersion(binary, label, env) {
  const result = spawnSync(binary, ["--version"], {
    env: safeProcessEnvironment(env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  if (result.status !== 0) fail(`${label} is unavailable or did not report a version`);
  const version = String(result.stdout).trim().split("\n", 1)[0];
  if (!version || version.length > 240) fail(`${label} reported an invalid version`);
  return version;
}

function binaryNames(env) {
  return {
    age: env.LAB_RC_AGE_BIN || "age",
    pgDump: env.LAB_RC_PG_DUMP_BIN || "pg_dump",
    pgRestore: env.LAB_RC_PG_RESTORE_BIN || "pg_restore",
    psql: env.LAB_RC_PSQL_BIN || "psql",
  };
}

function safeProcessEnvironment(env = process.env) {
  const child = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SYSTEMROOT",
  ]) {
    if (env[key] !== undefined) child[key] = env[key];
  }
  return child;
}

export function databaseEnvironment(database, env = process.env) {
  const forbidden = `${database.envPrefix}_DATABASE_URL`;
  if (env[forbidden]) {
    fail(`${forbidden} is forbidden: database URLs must never enter argv or manifests`);
  }
  const child = safeProcessEnvironment(env);
  for (const suffix of LIBPQ_SUFFIXES) {
    const value = env[`${database.envPrefix}_${suffix}`];
    if (value !== undefined && value !== "") child[suffix] = value;
  }
  const usesService = Boolean(child.PGSERVICE);
  const usesFields = Boolean(child.PGHOST && child.PGUSER && child.PGDATABASE);
  if (!usesService && !usesFields) {
    fail(
      `${database.envPrefix} must provide PGSERVICE or PGHOST, PGUSER, and PGDATABASE via environment`,
    );
  }
  if (usesService && !child.PGSERVICEFILE) {
    fail(`${database.envPrefix}_PGSERVICEFILE is required with PGSERVICE; implicit home-directory lookup is disabled`);
  }
  return child;
}

function runPsql(binary, database, sql, env, failureLabel = "read-only PostgreSQL inspection") {
  const result = spawnSync(
    binary,
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--field-separator=\t",
      "--set=ON_ERROR_STOP=1",
    ],
    {
      env: databaseEnvironment(database, env),
      input: `${sql.trim()}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 30_000,
    },
  );
  if (result.status !== 0) fail(`${failureLabel} failed for ${database.id}`);
  return String(result.stdout)
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function repairSchema024LogicalRestoreSemantics(binary, database, env) {
  runPsql(
    binary,
    database,
    `BEGIN;
     SET LOCAL search_path TO public, pg_catalog;
     DO $schema024_logical_restore_semantic_repair$
     DECLARE
       constraint_definition text;
       constraint_type text;
       constraint_validated boolean;
       constraint_deferrable boolean;
       constraint_deferred boolean;
       constraint_no_inherit boolean;
       trigger_definition text;
       trigger_enabled text;
       trigger_type text;
       trigger_deferrable boolean;
       trigger_initially_deferred boolean;
       trigger_internal boolean;
       trigger_function_namespace text;
       trigger_function_name text;
     BEGIN
       IF NOT EXISTS (
         SELECT 1
         FROM public.schema_migrations
         WHERE version = '${SCHEMA_024}'
       ) THEN
         RAISE EXCEPTION 'Schema 024 restore repair requires an installed Schema 024 migration';
       END IF;

       EXECUTE 'LOCK TABLE public.users, public.identity_email_change_events IN ACCESS EXCLUSIVE MODE';

       SELECT pg_catalog.pg_get_constraintdef(actual.oid, true),
              actual.contype::text,
              actual.convalidated,
              actual.condeferrable,
              actual.condeferred,
              actual.connoinherit
       INTO constraint_definition,
            constraint_type,
            constraint_validated,
            constraint_deferrable,
            constraint_deferred,
            constraint_no_inherit
       FROM pg_catalog.pg_constraint actual
       WHERE actual.conrelid = 'public.identity_email_change_events'::pg_catalog.regclass
         AND actual.conname = 'identity_email_change_events_check';

       SELECT pg_catalog.pg_get_triggerdef(actual.oid, true),
              actual.tgenabled::text,
              actual.tgtype::text,
              actual.tgdeferrable,
              actual.tginitdeferred,
              actual.tgisinternal,
              procedure_namespace.nspname,
              procedure.proname
       INTO trigger_definition,
            trigger_enabled,
            trigger_type,
            trigger_deferrable,
            trigger_initially_deferred,
            trigger_internal,
            trigger_function_namespace,
            trigger_function_name
       FROM pg_catalog.pg_trigger actual
       JOIN pg_catalog.pg_proc procedure ON procedure.oid = actual.tgfoid
       JOIN pg_catalog.pg_namespace procedure_namespace
         ON procedure_namespace.oid = procedure.pronamespace
       WHERE actual.tgrelid = 'public.users'::pg_catalog.regclass
         AND actual.tgname = 'users_record_email_change_event';

       IF constraint_type IS DISTINCT FROM 'c'
          OR constraint_validated IS DISTINCT FROM true
          OR constraint_deferrable IS DISTINCT FROM false
          OR constraint_deferred IS DISTINCT FROM false
          OR constraint_no_inherit IS DISTINCT FROM false
          OR trigger_enabled IS DISTINCT FROM 'O'
          OR trigger_type IS DISTINCT FROM '17'
          OR trigger_deferrable IS DISTINCT FROM false
          OR trigger_initially_deferred IS DISTINCT FROM false
          OR trigger_internal IS DISTINCT FROM false
          OR trigger_function_namespace IS DISTINCT FROM 'public'
          OR trigger_function_name IS DISTINCT FROM 'opensales_record_email_change_event' THEN
         RAISE EXCEPTION 'Schema 024 logical restore has unexpected email comparison catalog attributes';
       END IF;

       IF constraint_definition = $native_constraint$${SCHEMA_024_NATIVE_EMAIL_CHANGE_CONSTRAINT}$native_constraint$
          AND trigger_definition = $native_trigger$${SCHEMA_024_NATIVE_EMAIL_CHANGE_TRIGGER}$native_trigger$ THEN
         RETURN;
       END IF;

       IF constraint_definition IS DISTINCT FROM $restored_constraint$${SCHEMA_024_RESTORED_EMAIL_CHANGE_CONSTRAINT}$restored_constraint$
          OR trigger_definition IS DISTINCT FROM $restored_trigger$${SCHEMA_024_RESTORED_EMAIL_CHANGE_TRIGGER}$restored_trigger$ THEN
         RAISE EXCEPTION 'Schema 024 logical restore has an unexpected email comparison definition';
       END IF;

       EXECUTE $constraint_ddl$
         ALTER TABLE public.identity_email_change_events
           DROP CONSTRAINT identity_email_change_events_check
       $constraint_ddl$;
       EXECUTE $constraint_ddl$
         ALTER TABLE public.identity_email_change_events
           ADD CONSTRAINT identity_email_change_events_check
           CHECK (old_email IS DISTINCT FROM new_email)
       $constraint_ddl$;
       EXECUTE $trigger_ddl$
         DROP TRIGGER users_record_email_change_event ON public.users
       $trigger_ddl$;
       EXECUTE $trigger_ddl$
         CREATE TRIGGER users_record_email_change_event
         AFTER UPDATE OF email ON public.users FOR EACH ROW
         WHEN (NEW.email IS DISTINCT FROM OLD.email)
         EXECUTE FUNCTION public.opensales_record_email_change_event()
       $trigger_ddl$;

       SELECT pg_catalog.pg_get_constraintdef(actual.oid, true),
              actual.contype::text,
              actual.convalidated,
              actual.condeferrable,
              actual.condeferred,
              actual.connoinherit
       INTO constraint_definition,
            constraint_type,
            constraint_validated,
            constraint_deferrable,
            constraint_deferred,
            constraint_no_inherit
       FROM pg_catalog.pg_constraint actual
       WHERE actual.conrelid = 'public.identity_email_change_events'::pg_catalog.regclass
         AND actual.conname = 'identity_email_change_events_check';

       SELECT pg_catalog.pg_get_triggerdef(actual.oid, true),
              actual.tgenabled::text,
              actual.tgtype::text,
              actual.tgdeferrable,
              actual.tginitdeferred,
              actual.tgisinternal,
              procedure_namespace.nspname,
              procedure.proname
       INTO trigger_definition,
            trigger_enabled,
            trigger_type,
            trigger_deferrable,
            trigger_initially_deferred,
            trigger_internal,
            trigger_function_namespace,
            trigger_function_name
       FROM pg_catalog.pg_trigger actual
       JOIN pg_catalog.pg_proc procedure ON procedure.oid = actual.tgfoid
       JOIN pg_catalog.pg_namespace procedure_namespace
         ON procedure_namespace.oid = procedure.pronamespace
       WHERE actual.tgrelid = 'public.users'::pg_catalog.regclass
         AND actual.tgname = 'users_record_email_change_event';

       IF constraint_definition IS DISTINCT FROM $native_constraint$${SCHEMA_024_NATIVE_EMAIL_CHANGE_CONSTRAINT}$native_constraint$
          OR constraint_type IS DISTINCT FROM 'c'
          OR constraint_validated IS DISTINCT FROM true
          OR constraint_deferrable IS DISTINCT FROM false
          OR constraint_deferred IS DISTINCT FROM false
          OR constraint_no_inherit IS DISTINCT FROM false
          OR trigger_definition IS DISTINCT FROM $native_trigger$${SCHEMA_024_NATIVE_EMAIL_CHANGE_TRIGGER}$native_trigger$
          OR trigger_enabled IS DISTINCT FROM 'O'
          OR trigger_type IS DISTINCT FROM '17'
          OR trigger_deferrable IS DISTINCT FROM false
          OR trigger_initially_deferred IS DISTINCT FROM false
          OR trigger_internal IS DISTINCT FROM false
          OR trigger_function_namespace IS DISTINCT FROM 'public'
          OR trigger_function_name IS DISTINCT FROM 'opensales_record_email_change_event' THEN
         RAISE EXCEPTION 'Schema 024 logical restore email comparison repair did not reach the native definitions';
       END IF;
     END
     $schema024_logical_restore_semantic_repair$;
     COMMIT;`,
    env,
    "Schema 024 logical-restore semantic repair",
  );
}

function inspectDatabase(binary, database, env) {
  const versionRows = runPsql(binary, database, "SHOW server_version_num;", env);
  const serverVersionNumber = Number.parseInt(versionRows[0] ?? "", 10);
  if (!Number.isInteger(serverVersionNumber) || serverVersionNumber < 180000 || serverVersionNumber >= 190000) {
    fail(`${database.id} must run PostgreSQL 18`);
  }
  if (database.id === "core") {
    const schemaHistory = runPsql(
      binary,
      database,
      'SELECT version FROM public.schema_migrations ORDER BY version COLLATE "C";',
      env,
    );
    if (schemaHistory.length === 0) fail("core schema history is empty");
    const attachmentRows = runPsql(
      binary,
      database,
      `SELECT pg_catalog.count(*)::text,
              coalesce(pg_catalog.sum(size_bytes), 0)::text,
              pg_catalog.count(*) FILTER (
                WHERE pg_catalog.octet_length(content) <> size_bytes
                   OR public.digest(content, 'sha256') <> sha256
              )::text
       FROM public.support_ticket_attachments;`,
      env,
    );
    const [count, totalBytes, invalid] = (attachmentRows[0] ?? "").split("\t");
    if (![count, totalBytes, invalid].every((part) => /^\d+$/.test(part ?? ""))) {
      fail("core attachment integrity query returned an invalid result");
    }
    if (invalid !== "0") fail("core contains an attachment whose stored digest or size is invalid");
    return {
      serverVersionNumber,
      schemaHistory: { kind: "migration-history", versions: schemaHistory },
      attachmentInventory: { count: Number(count), totalBytes: Number(totalBytes), invalid: 0 },
    };
  }
  const tables = runPsql(
    binary,
    database,
    `SELECT tablename
     FROM pg_catalog.pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename COLLATE "C";`,
    env,
  );
  if (tables.length === 0) fail(`${database.id} public table inventory is empty`);
  return {
    serverVersionNumber,
    schemaHistory: { kind: "table-inventory", versions: tables },
  };
}

function inspectBlankTarget(binary, database, env) {
  const rows = runPsql(
    binary,
    database,
    `SELECT pg_catalog.current_database(),
            pg_catalog.current_setting('server_version_num'),
            (
              SELECT control.system_identifier::text
              FROM pg_catalog.pg_control_system() AS control
            ),
            (
              SELECT database_catalog.oid::text
              FROM pg_catalog.pg_database AS database_catalog
              WHERE database_catalog.datname = pg_catalog.current_database()
            ),
            (
              SELECT pg_catalog.count(*)
              FROM pg_catalog.pg_namespace n
              WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
                AND n.nspname NOT LIKE 'pg_toast%'
            ) + (
              SELECT pg_catalog.count(*)
              FROM pg_catalog.pg_class c
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
            ) + (
              SELECT pg_catalog.count(*)
              FROM pg_catalog.pg_proc p
              JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
            ) + (
              SELECT pg_catalog.count(*)
              FROM pg_catalog.pg_type t
              JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
              WHERE n.nspname = 'public'
            ) AS blank_database_object_count;`,
    env,
  );
  const [databaseName, serverVersion, systemIdentifier, databaseOid, objectCount] =
    (rows[0] ?? "").split("\t");
  const serverVersionNumber = Number.parseInt(serverVersion ?? "", 10);
  if (
    !databaseName ||
    !Number.isInteger(serverVersionNumber) ||
    !/^\d+$/.test(systemIdentifier ?? "") ||
    !/^\d+$/.test(databaseOid ?? "") ||
    !/^\d+$/.test(objectCount ?? "")
  ) {
    fail(`blank target inspection returned an invalid result for ${database.id}`);
  }
  if (serverVersionNumber < 180000 || serverVersionNumber >= 190000) {
    fail(`${database.id} restore target must run PostgreSQL 18`);
  }
  if (objectCount !== "0") fail(`${database.id} restore target is not a blank database`);
  const targetIdentitySha256 = createHash("sha256")
    .update([systemIdentifier, databaseOid, databaseName].join("\0"))
    .digest("hex");
  return { databaseName, serverVersionNumber, targetIdentitySha256 };
}

function waitForExit(child, label) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", () => reject(new Error(`${label} could not start`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} failed (${signal ? "signal" : "exit"})`));
    });
  });
}

async function dumpEncrypted({ binaries, database, recipient, output, env }) {
  const partial = `${output}.partial`;
  const dump = spawn(
    binaries.pgDump,
    ["--format=custom", "--compress=6", "--no-owner", "--no-privileges"],
    {
      env: databaseEnvironment(database, env),
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const encrypt = spawn(
    binaries.age,
    ["--encrypt", "--recipient", recipient, "--output", partial],
    { env: safeProcessEnvironment(env), stdio: ["pipe", "ignore", "ignore"] },
  );
  encrypt.stdin.on("error", () => {});
  dump.stdout.pipe(encrypt.stdin);
  try {
    await Promise.all([
      waitForExit(dump, `pg_dump for ${database.id}`),
      waitForExit(encrypt, `age encryption for ${database.id}`),
    ]);
    if (!existsSync(partial)) fail(`encrypted dump was not created for ${database.id}`);
    chmodSync(partial, 0o600);
    renameSync(partial, output);
  } catch (error) {
    dump.kill("SIGTERM");
    encrypt.kill("SIGTERM");
    rmSync(partial, { force: true });
    throw error;
  }
}

function encryptBuffer(binary, recipient, buffer, output, env) {
  if (buffer.length === 0) fail("configuration/credential bundle on stdin is empty");
  if (buffer.length > MAX_SECRET_BUNDLE_BYTES) {
    fail("configuration/credential bundle exceeds the 64 MiB safety limit");
  }
  const partial = `${output}.partial`;
  const result = spawnSync(
    binary,
    ["--encrypt", "--recipient", recipient, "--output", partial],
    {
      env: safeProcessEnvironment(env),
      input: buffer,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 60_000,
    },
  );
  if (result.status !== 0 || !existsSync(partial)) {
    rmSync(partial, { force: true });
    fail("age failed to encrypt the configuration/credential bundle");
  }
  chmodSync(partial, 0o600);
  renameSync(partial, output);
}

async function stdinBuffer(stream = process.stdin) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_SECRET_BUNDLE_BYTES) {
      fail("configuration/credential bundle exceeds the 64 MiB safety limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length);
}

export async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function hasAgeHeader(path) {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(AGE_HEADER.length);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    return bytesRead === AGE_HEADER.length && header.equals(AGE_HEADER);
  } finally {
    closeSync(fd);
  }
}

function repositoryCommit(repositoryRoot) {
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: repositoryRoot,
    env: safeProcessEnvironment(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (status.status !== 0) fail("cannot inspect repository status");
  if (status.stdout.trim()) fail("refusing to create release evidence from a dirty worktree");
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    env: safeProcessEnvironment(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const commit = String(revision.stdout).trim();
  if (revision.status !== 0 || !COMMIT.test(commit)) fail("cannot resolve an exact Git commit");
  return commit;
}

function relativeArtifact(path) {
  return `artifacts/${basename(path)}`;
}

function assertArtifactName(value) {
  if (!/^artifacts\/[a-z0-9-]+\.(?:dump|bundle)\.age$/.test(value)) {
    fail("manifest contains an unsafe artifact name");
  }
}

function recursivelyRejectSensitiveFields(value, key = "") {
  if (key && /(?:password|databaseurl|connectionstring|plaintextpath|secretvalue|privatekey|apitoken)/i.test(key)) {
    fail(`manifest contains forbidden sensitive field ${key}`);
  }
  if (typeof value === "string") {
    if (/postgres(?:ql)?:\/\//i.test(value) || value.includes("-----BEGIN ")) {
      fail("manifest contains secret-bearing connection or key material");
    }
    if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
      fail("manifest contains an absolute path");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) recursivelyRejectSensitiveFields(item, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      recursivelyRejectSensitiveFields(child, childKey);
    }
  }
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) fail(`${label} fields do not match the manifest contract`);
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("manifest must be an object");
  recursivelyRejectSensitiveFields(manifest);
  assertExactKeys(
    manifest,
    ["format", "warning", "status", "profile", "release", "consistency", "timing", "tools", "databases", "artifacts"],
    "root",
  );
  if (manifest.format !== MANIFEST_FORMAT) fail("unsupported manifest format");
  if (manifest.warning !== LAB_WARNING) fail("mock-only warning is missing");
  if (manifest.status !== "complete") fail("backup manifest is not complete");
  const profile = normalizeProfile(manifest.profile);
  if (!manifest.release || typeof manifest.release !== "object") fail("manifest release is invalid");
  assertExactKeys(
    manifest.release,
    ["commit", "configurationVersion", "credentialSetVersion", "versionBindingSha256"],
    "release",
  );
  if (!COMMIT.test(String(manifest.release?.commit ?? ""))) fail("manifest commit is invalid");
  safeVersion(manifest.release?.configurationVersion, "configurationVersion");
  safeVersion(manifest.release?.credentialSetVersion, "credentialSetVersion");
  if (!SHA256.test(String(manifest.release?.versionBindingSha256 ?? ""))) {
    fail("manifest version binding is invalid");
  }
  if (
    manifest.release.versionBindingSha256 !==
    versionBinding(
      manifest.release.commit,
      profile,
      manifest.release.configurationVersion,
      manifest.release.credentialSetVersion,
    )
  ) {
    fail("manifest configuration/credential version binding differs from its release fields");
  }
  if (!manifest.consistency || typeof manifest.consistency !== "object") fail("manifest consistency is invalid");
  assertExactKeys(
    manifest.consistency,
    ["operatorAssertion", "sideEffectsPausedAt", "workerDispatchPaused", "providerMutationPaused", "multiDatabaseCapture"],
    "consistency",
  );
  const started = Date.parse(manifest.timing?.startedAt);
  const completed = Date.parse(manifest.timing?.completedAt);
  const paused = Date.parse(manifest.consistency?.sideEffectsPausedAt);
  if (![started, completed, paused].every(Number.isFinite) || paused > started || started > completed) {
    fail("manifest timing or side-effect pause ordering is invalid");
  }
  if (manifest.consistency?.workerDispatchPaused !== true || manifest.consistency?.providerMutationPaused !== true) {
    fail("manifest does not assert both side-effect pauses");
  }
  if (manifest.consistency.operatorAssertion !== "application writers were stopped before capture") {
    fail("manifest writer-pause assertion is invalid");
  }
  if (manifest.consistency.multiDatabaseCapture !== "ordered logical dumps inside the recorded capture window") {
    fail("manifest capture model is invalid");
  }
  if (!manifest.timing || typeof manifest.timing !== "object") fail("manifest timing is invalid");
  assertExactKeys(manifest.timing, ["startedAt", "completedAt", "elapsedMilliseconds"], "timing");
  if (
    !Number.isInteger(manifest.timing.elapsedMilliseconds) ||
    manifest.timing.elapsedMilliseconds < 0 ||
    manifest.timing.elapsedMilliseconds !== completed - started
  ) {
    fail("manifest elapsed timing is invalid");
  }
  if (!manifest.tools || typeof manifest.tools !== "object") fail("manifest tool versions are invalid");
  assertExactKeys(manifest.tools, ["node", "pgDump", "pgRestore", "psql", "age"], "tools");
  if (manifest.tools.node !== "v24.18.0") fail("manifest must be created with Node.js 24.18.0");
  for (const key of ["pgDump", "pgRestore", "psql"]) {
    if (!/^\S.*PostgreSQL\)? 18(?:\.|\s|$)/.test(String(manifest.tools[key] ?? ""))) {
      fail(`manifest ${key} must report PostgreSQL 18`);
    }
  }
  if (typeof manifest.tools.age !== "string" || manifest.tools.age.length < 1 || manifest.tools.age.length > 240) {
    fail("manifest age version is invalid");
  }
  const expectedDatabaseIds = PROFILES[profile].map(({ id }) => id);
  const databases = manifest.databases;
  if (!Array.isArray(databases) || databases.map(({ id }) => id).join("\0") !== expectedDatabaseIds.join("\0")) {
    fail("manifest database inventory does not match its profile");
  }
  for (const database of databases) {
    const databaseKeys = ["id", "ownerProfile", "contents", "artifact", "serverVersionNumber", "schemaHistory"];
    if (database.id === "core") databaseKeys.push("attachmentInventory");
    assertExactKeys(database, databaseKeys, `database ${database.id}`);
    const expectedOwner = database.id === "core" ? "TestA" : "TestB";
    if (database.ownerProfile !== expectedOwner) fail(`manifest database ${database.id} has the wrong owner profile`);
    if (!Number.isInteger(database.serverVersionNumber) || database.serverVersionNumber < 180000 || database.serverVersionNumber >= 190000) {
      fail(`manifest database ${database.id} is not PostgreSQL 18`);
    }
    if (!Array.isArray(database.schemaHistory?.versions) || database.schemaHistory.versions.length === 0) {
      fail(`manifest database ${database.id} lacks schema history or table inventory`);
    }
    const expectedHistoryKind = database.id === "core" ? "migration-history" : "table-inventory";
    if (database.schemaHistory.kind !== expectedHistoryKind) fail(`manifest database ${database.id} history kind is invalid`);
    if (new Set(database.schemaHistory.versions).size !== database.schemaHistory.versions.length) {
      fail(`manifest database ${database.id} history has duplicates`);
    }
    const sortedVersions = [...database.schemaHistory.versions].sort();
    if (sortedVersions.join("\0") !== database.schemaHistory.versions.join("\0")) {
      fail(`manifest database ${database.id} history is not ordered`);
    }
    assertArtifactName(database.artifact);
  }
  if (profile === "TestA" || profile === "local" || profile === "DemoLocal") {
    const core = databases.find(({ id }) => id === "core");
    if (!core?.attachmentInventory || core.attachmentInventory.invalid !== 0) {
      fail("core attachment inventory is absent or invalid");
    }
  }
  const artifacts = manifest.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length !== databases.length + 1) {
    fail("manifest artifact inventory is incomplete");
  }
  for (const artifact of artifacts) {
    assertExactKeys(artifact, ["file", "kind", "component", "encryption", "sha256", "bytes"], `artifact ${artifact.file}`);
    assertArtifactName(artifact.file);
    if (!SHA256.test(String(artifact.sha256 ?? "")) || !Number.isInteger(artifact.bytes) || artifact.bytes <= 0) {
      fail(`manifest artifact metadata is invalid for ${artifact.file}`);
    }
    if (artifact.encryption !== "age-v1") fail(`artifact ${artifact.file} is not marked as age encrypted`);
  }
  const uniqueFiles = new Set(artifacts.map(({ file }) => file));
  if (uniqueFiles.size !== artifacts.length) fail("manifest has duplicate artifact names");
  for (const database of databases) {
    const artifact = artifacts.find(({ file }) => file === database.artifact);
    if (artifact?.kind !== "postgresql-custom-dump" || artifact.component !== database.id) {
      fail(`manifest database artifact binding is invalid for ${database.id}`);
    }
  }
  const configurationArtifacts = artifacts.filter(({ kind }) => kind === "configuration-credential-bundle");
  if (configurationArtifacts.length !== 1 || configurationArtifacts[0].component !== profile) {
    fail("manifest configuration/credential artifact binding is invalid");
  }
  return manifest;
}

async function artifactRecord(root, file, kind, component) {
  const fullPath = join(root, file);
  if (!hasAgeHeader(fullPath)) fail(`artifact ${file} is not an age v1 envelope`);
  return {
    file,
    kind,
    component,
    encryption: "age-v1",
    sha256: await sha256File(fullPath),
    bytes: statSync(fullPath).size,
  };
}

function versionBinding(commit, profile, configurationVersion, credentialSetVersion) {
  return createHash("sha256")
    .update(commit)
    .update("\0")
    .update(profile)
    .update("\0")
    .update(configurationVersion)
    .update("\0")
    .update(credentialSetVersion)
    .digest("hex");
}

export async function createBackup(options) {
  if (process.version !== "v24.18.0") fail("create requires the repository-pinned Node.js 24.18.0");
  const profile = normalizeProfile(options.profile);
  if (!SAFE_RECIPIENT.test(String(options.recipient ?? ""))) fail("an age recipient is required");
  const configurationVersion = safeVersion(options.configurationVersion, "configurationVersion");
  const credentialSetVersion = safeVersion(options.credentialSetVersion, "credentialSetVersion");
  const pausedAt = parseIso(options.pausedAt, "pausedAt");
  const repositoryRoot = resolve(options.repositoryRoot);
  const output = resolve(options.output);
  const canonicalRepositoryRoot = realpathSync(repositoryRoot);
  const canonicalOutput = canonicalProspectivePath(output);
  if (pathIsWithin(canonicalRepositoryRoot, canonicalOutput)) {
    fail("backup output must be outside the repository");
  }
  if (existsSync(output)) fail("backup output must not already exist");
  const commit = repositoryCommit(repositoryRoot);
  const startedAt = new Date().toISOString();
  if (Date.parse(pausedAt) > Date.parse(startedAt)) fail("pausedAt cannot be in the future");
  const binaries = binaryNames(options.env);
  const secretBundle = await stdinBuffer(options.stdin);
  mkdirSync(output, { mode: 0o700 });
  const artifactsDirectory = join(output, "artifacts");
  mkdirSync(artifactsDirectory, { mode: 0o700 });
  try {
    const toolVersions = {
      node: process.version,
      pgDump: commandVersion(binaries.pgDump, "pg_dump", options.env),
      pgRestore: commandVersion(binaries.pgRestore, "pg_restore", options.env),
      psql: commandVersion(binaries.psql, "psql", options.env),
      age: commandVersion(binaries.age, "age", options.env),
    };
    const databases = [];
    const artifacts = [];
    const configPath = join(artifactsDirectory, "configuration-credentials.bundle.age");
    encryptBuffer(binaries.age, options.recipient, secretBundle, configPath, options.env);
    secretBundle.fill(0);
    for (const database of PROFILES[profile]) {
      const inspection = inspectDatabase(binaries.psql, database, options.env);
      const artifactPath = join(artifactsDirectory, `${database.id}.dump.age`);
      await dumpEncrypted({ binaries, database, recipient: options.recipient, output: artifactPath, env: options.env });
      const artifact = relativeArtifact(artifactPath);
      artifacts.push(await artifactRecord(output, artifact, "postgresql-custom-dump", database.id));
      databases.push({
        id: database.id,
        ownerProfile: database.owner,
        contents: database.contents,
        artifact,
        ...inspection,
      });
    }
    artifacts.push(
      await artifactRecord(
        output,
        relativeArtifact(configPath),
        "configuration-credential-bundle",
        profile,
      ),
    );
    const completedAt = new Date().toISOString();
    const manifest = {
      format: MANIFEST_FORMAT,
      warning: LAB_WARNING,
      status: "complete",
      profile,
      release: {
        commit,
        configurationVersion,
        credentialSetVersion,
        versionBindingSha256: versionBinding(commit, profile, configurationVersion, credentialSetVersion),
      },
      consistency: {
        operatorAssertion: "application writers were stopped before capture",
        sideEffectsPausedAt: pausedAt,
        workerDispatchPaused: true,
        providerMutationPaused: true,
        multiDatabaseCapture: "ordered logical dumps inside the recorded capture window",
      },
      timing: {
        startedAt,
        completedAt,
        elapsedMilliseconds: Date.parse(completedAt) - Date.parse(startedAt),
      },
      tools: toolVersions,
      databases,
      artifacts,
    };
    validateManifest(manifest);
    jsonFile(join(output, "manifest.json"), manifest);
    return manifest;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    secretBundle.fill(0);
  }
}

function resolveArtifact(archive, artifact) {
  assertArtifactName(artifact);
  const root = resolve(archive);
  const candidate = resolve(root, artifact);
  if (relative(root, candidate).startsWith(`..${sep}`) || candidate === root) {
    fail("artifact escapes the backup archive");
  }
  const artifactsDirectory = join(root, "artifacts");
  if (
    !existsSync(artifactsDirectory) ||
    !lstatSync(artifactsDirectory).isDirectory() ||
    lstatSync(artifactsDirectory).isSymbolicLink()
  ) {
    fail("backup artifacts must be held in a regular non-symlink directory");
  }
  if (!existsSync(candidate) || !lstatSync(candidate).isFile() || lstatSync(candidate).isSymbolicLink()) {
    fail(`artifact ${artifact} must be a regular non-symlink file`);
  }
  const realRoot = realpathSync(root);
  const realArtifacts = realpathSync(artifactsDirectory);
  const realCandidate = realpathSync(candidate);
  if (realArtifacts !== join(realRoot, "artifacts") || dirname(realCandidate) !== realArtifacts) {
    fail(`artifact ${artifact} resolves outside the backup archive`);
  }
  return candidate;
}

async function deepVerifyDatabase({ binaries, archive, artifact, identityFile, env }) {
  const identityFd = openIdentity(identityFile);
  let decrypt;
  try {
    decrypt = spawn(
      binaries.age,
      ["--decrypt", "--identity", "-", resolveArtifact(archive, artifact)],
      { env: safeProcessEnvironment(env), stdio: [identityFd, "pipe", "ignore"] },
    );
  } finally {
    closeSync(identityFd);
  }
  const inspect = spawn(binaries.pgRestore, ["--list"], {
    env: safeProcessEnvironment(env),
    stdio: ["pipe", "ignore", "ignore"],
  });
  inspect.stdin.on("error", () => {});
  decrypt.stdout.pipe(inspect.stdin);
  await Promise.all([
    waitForExit(decrypt, `age decryption for ${artifact}`),
    waitForExit(inspect, `pg_restore inspection for ${artifact}`),
  ]);
}

async function deepVerifyBundle({ binaries, archive, artifact, identityFile, env }) {
  const identityFd = openIdentity(identityFile);
  let decrypt;
  try {
    decrypt = spawn(
      binaries.age,
      ["--decrypt", "--identity", "-", resolveArtifact(archive, artifact)],
      { env: safeProcessEnvironment(env), stdio: [identityFd, "pipe", "ignore"] },
    );
  } finally {
    closeSync(identityFd);
  }
  decrypt.stdout.resume();
  await waitForExit(decrypt, `age decryption for ${artifact}`);
}

function openIdentity(identityFile) {
  const identity = resolve(identityFile);
  if (!existsSync(identity)) fail("age identity file does not exist");
  const metadata = lstatSync(identity);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("age identity must be a regular non-symlink file");
  }
  if ((metadata.mode & 0o077) !== 0) fail("age identity permissions must not allow group or other access");
  return openSync(identity, "r");
}

export async function verifyBackup(options) {
  const archive = resolve(options.archive);
  if (!existsSync(archive) || !lstatSync(archive).isDirectory() || lstatSync(archive).isSymbolicLink()) {
    fail("backup archive must be a regular non-symlink directory");
  }
  const artifactsDirectory = join(archive, "artifacts");
  if (
    !existsSync(artifactsDirectory) ||
    !lstatSync(artifactsDirectory).isDirectory() ||
    lstatSync(artifactsDirectory).isSymbolicLink()
  ) {
    fail("backup artifacts must be held in a regular non-symlink directory");
  }
  if (realpathSync(artifactsDirectory) !== join(realpathSync(archive), "artifacts")) {
    fail("backup artifacts directory resolves outside the backup archive");
  }
  const manifestPath = join(archive, "manifest.json");
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink()) {
    fail("manifest.json must be a regular non-symlink file");
  }
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const checks = [];
  for (const artifact of manifest.artifacts) {
    const path = resolveArtifact(archive, artifact.file);
    if (!hasAgeHeader(path)) fail(`artifact ${artifact.file} is not an age v1 envelope`);
    if (statSync(path).size !== artifact.bytes) fail(`artifact ${artifact.file} size differs from manifest`);
    if ((await sha256File(path)) !== artifact.sha256) fail(`artifact ${artifact.file} checksum differs from manifest`);
    checks.push({ file: artifact.file, checksum: "passed", envelope: "age-v1" });
  }
  let deep = "not-requested";
  if (options.deep) {
    const identityFile = options.env.LAB_RC_AGE_IDENTITY_FILE;
    if (!identityFile) fail("deep verification requires LAB_RC_AGE_IDENTITY_FILE");
    const binaries = binaryNames(options.env);
    for (const artifact of manifest.artifacts) {
      if (artifact.kind === "postgresql-custom-dump") {
        await deepVerifyDatabase({
          binaries,
          archive,
          artifact: artifact.file,
          identityFile,
          env: options.env,
        });
      } else {
        await deepVerifyBundle({
          binaries,
          archive,
          artifact: artifact.file,
          identityFile,
          env: options.env,
        });
      }
    }
    deep = "passed";
  }
  return {
    format: MANIFEST_FORMAT,
    status: "verified",
    profile: manifest.profile,
    manifestSha256: await sha256File(manifestPath),
    deep,
    checks,
  };
}

function restoreJournalDirectory(path, archive, resume) {
  const journal = resolve(path);
  if (pathIsWithin(realpathSync(archive), canonicalProspectivePath(journal))) {
    fail("restore journal must be outside the immutable backup archive");
  }
  if (!resume) {
    if (existsSync(journal)) fail("restore journal must not already exist unless --resume is used");
    mkdirSync(journal, { mode: 0o700 });
    return journal;
  }
  if (!existsSync(journal) || !lstatSync(journal).isDirectory() || lstatSync(journal).isSymbolicLink()) {
    fail("resume requires a regular non-symlink restore journal directory");
  }
  return journal;
}

function writeRestoreState(path, state) {
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, path);
}

function restoreStateFormat(profile) {
  return profile === "DemoLocal" ? DEMO_LOCAL_RESTORE_FORMAT : LAB_PROFILE_RESTORE_FORMAT;
}

function validateRestoreState(state, manifestSha256, profile) {
  if (!state || typeof state !== "object" || Array.isArray(state)) fail("restore journal state is invalid");
  assertExactKeys(
    state,
    ["format", "warning", "manifestSha256", "profile", "status", "dryRun", "startedAt", "updatedAt", "completed", "failed"],
    "restore journal state",
  );
  if (state.format !== restoreStateFormat(profile) || state.warning !== LAB_WARNING) {
    fail("restore journal format or warning is invalid");
  }
  if (state.profile !== profile || state.manifestSha256 !== manifestSha256) {
    fail(`restore journal does not match this verified ${profile} archive`);
  }
  if (!["ready", "running", "failed", "complete", "dry-run-complete"].includes(state.status)) {
    fail("restore journal status is invalid");
  }
  parseIso(state.startedAt, "restore journal startedAt");
  parseIso(state.updatedAt, "restore journal updatedAt");
  if (!Array.isArray(state.completed)) fail("restore journal completed steps are invalid");
  const expectedIds = PROFILES[profile].map(({ id }) => id);
  for (let index = 0; index < state.completed.length; index += 1) {
    const completed = state.completed[index];
    assertExactKeys(completed, ["id", "databaseName", "serverVersionNumber", "targetIdentitySha256", "completedAt", "log"], "completed restore step");
    if (completed.id !== expectedIds[index]) fail("restore journal completed steps are not an ordered prefix");
    if (!completed.databaseName || !Number.isInteger(completed.serverVersionNumber) || !SHA256.test(completed.targetIdentitySha256)) {
      fail("restore journal completed target metadata is invalid");
    }
    if (!/^\d{2}-[a-z0-9-]+[.]log$/.test(completed.log)) fail("restore journal log name is invalid");
    parseIso(completed.completedAt, "restore step completedAt");
  }
  if (state.failed !== null) {
    assertExactKeys(state.failed, ["id", "failedAt", "log"], "failed restore step");
    if (!expectedIds.includes(state.failed.id) || !/^\d{2}-[a-z0-9-]+[.]log$/.test(state.failed.log)) {
      fail("restore journal failed step is invalid");
    }
    parseIso(state.failed.failedAt, "restore step failedAt");
  }
  return state;
}

function appendRestoreLog(path, message) {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
    fail("restore log must be a regular non-symlink file");
  }
  writeFileSync(path, `${new Date().toISOString()} ${message}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
}

async function restoreEncryptedDatabase({ binaries, archive, database, identityFile, env }) {
  const identityFd = openIdentity(identityFile);
  let decrypt;
  let restore;
  try {
    decrypt = spawn(
      binaries.age,
      ["--decrypt", "--identity", "-", resolveArtifact(archive, database.artifact)],
      { env: safeProcessEnvironment(env), stdio: [identityFd, "pipe", "ignore"] },
    );
    restore = spawn(
      binaries.pgRestore,
      ["--dbname=", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--no-tablespaces", "--no-password"],
      { env: databaseEnvironment(DATABASES[database.id], env), stdio: ["pipe", "ignore", "ignore"] },
    );
  } finally {
    closeSync(identityFd);
  }
  restore.stdin.on("error", () => {});
  decrypt.stdout.pipe(restore.stdin);
  const results = await Promise.allSettled([
    waitForExit(decrypt, `age decryption for ${database.id}`),
    waitForExit(restore, `pg_restore for ${database.id}`),
  ]);
  const failure = results.find(({ status }) => status === "rejected");
  if (failure) throw failure.reason;
}

function assertRestoredInspection(expected, actual) {
  if (actual.schemaHistory.kind !== expected.schemaHistory.kind ||
      actual.schemaHistory.versions.join("\0") !== expected.schemaHistory.versions.join("\0")) {
    fail(`${expected.id} restored schema history differs from the manifest`);
  }
  if (expected.id === "core") {
    const expectedAttachments = expected.attachmentInventory;
    const actualAttachments = actual.attachmentInventory;
    if (actualAttachments.count !== expectedAttachments.count ||
        actualAttachments.totalBytes !== expectedAttachments.totalBytes ||
        actualAttachments.invalid !== 0) {
      fail("core restored attachment inventory differs from the manifest");
    }
  }
}

export async function restoreProfile(options) {
  const profile = normalizeProfile(options.profile);
  if (!["TestA", "TestB", "DemoLocal"].includes(profile)) {
    fail("blank restore executor accepts only TestA, TestB, or DemoLocal");
  }
  if (process.version !== "v24.18.0") fail(`${profile} restore requires the repository-pinned Node.js 24.18.0`);
  const archive = resolve(options.archive);
  const verification = await verifyBackup({ archive, deep: true, env: options.env });
  const manifest = validateManifest(JSON.parse(readFileSync(join(archive, "manifest.json"), "utf8")));
  if (manifest.profile !== profile || manifest.databases.length !== PROFILES[profile].length) {
    fail(`blank restore executor requires a verified ${profile} manifest`);
  }
  if (verification.status !== "verified" || verification.deep !== "passed") {
    fail("blank restore executor requires deep verification to pass");
  }
  const journal = restoreJournalDirectory(options.journal, archive, options.resume === true);
  const statePath = join(journal, "restore-state.json");
  const startedAt = new Date().toISOString();
  let state;
  if (options.resume === true) {
    if (!existsSync(statePath) || !lstatSync(statePath).isFile() || lstatSync(statePath).isSymbolicLink()) {
      fail("resume requires a regular non-symlink restore-state.json");
    }
    state = validateRestoreState(
      JSON.parse(readFileSync(statePath, "utf8")),
      verification.manifestSha256,
      profile,
    );
    if (state.dryRun || state.status === "dry-run-complete") fail("a dry-run journal cannot be resumed as a restore");
    if (state.status === "complete") return state;
  } else {
    state = {
      format: restoreStateFormat(profile),
      warning: LAB_WARNING,
      manifestSha256: verification.manifestSha256,
      profile,
      status: "ready",
      dryRun: options.dryRun === true,
      startedAt,
      updatedAt: startedAt,
      completed: [],
      failed: null,
    };
    writeRestoreState(statePath, state);
  }

  const binaries = binaryNames(options.env);
  for (const [binary, label] of [[binaries.psql, "psql"], [binaries.pgRestore, "pg_restore"]]) {
    if (!/^\S.*PostgreSQL\)? 18(?:\.|\s|$)/.test(commandVersion(binary, label, options.env))) {
      fail(`${label} must be PostgreSQL 18 for ${profile} restore`);
    }
  }
  commandVersion(binaries.age, "age", options.env);

  const completedIds = new Set(state.completed.map(({ id }) => id));
  const completedTargets = new Set(state.completed.map(({ targetIdentitySha256 }) => targetIdentitySha256));
  const pending = manifest.databases.filter(({ id }) => !completedIds.has(id));
  const targets = [];
  for (const database of pending) {
    const target = inspectBlankTarget(binaries.psql, DATABASES[database.id], options.env);
    if (completedTargets.has(target.targetIdentitySha256) || targets.some(({ targetIdentitySha256 }) => targetIdentitySha256 === target.targetIdentitySha256)) {
      fail(`each ${profile} component requires a distinct blank target database`);
    }
    targets.push({ id: database.id, ...target });
  }

  if (options.dryRun === true) {
    state.status = "dry-run-complete";
    state.updatedAt = new Date().toISOString();
    writeRestoreState(statePath, state);
    return state;
  }

  state.status = "running";
  state.failed = null;
  state.updatedAt = new Date().toISOString();
  writeRestoreState(statePath, state);
  for (const database of pending) {
    const index = manifest.databases.findIndex(({ id }) => id === database.id);
    const target = targets.find(({ id }) => id === database.id);
    const log = `${String(index + 1).padStart(2, "0")}-${database.id}.log`;
    const logPath = join(journal, log);
    appendRestoreLog(logPath, `starting ${database.id} single-transaction restore`);
    try {
      await restoreEncryptedDatabase({
        binaries,
        archive,
        database,
        identityFile: options.env.LAB_RC_AGE_IDENTITY_FILE,
        env: options.env,
      });
      const restoredInspection = inspectDatabase(
        binaries.psql,
        DATABASES[database.id],
        options.env,
      );
      assertRestoredInspection(database, restoredInspection);
      if (
        database.id === "core" &&
        restoredInspection.schemaHistory.versions.includes(SCHEMA_024)
      ) {
        repairSchema024LogicalRestoreSemantics(
          binaries.psql,
          DATABASES.core,
          options.env,
        );
        assertRestoredInspection(
          database,
          inspectDatabase(binaries.psql, DATABASES.core, options.env),
        );
        appendRestoreLog(logPath, "completed exact Schema 024 logical-restore semantic repair gate");
      }
      const completedAt = new Date().toISOString();
      appendRestoreLog(logPath, `completed ${database.id} restore and manifest comparison`);
      state.completed.push({
        id: database.id,
        databaseName: target.databaseName,
        serverVersionNumber: target.serverVersionNumber,
        targetIdentitySha256: target.targetIdentitySha256,
        completedAt,
        log,
      });
      state.updatedAt = completedAt;
      state.failed = null;
      writeRestoreState(statePath, state);
    } catch (error) {
      const failedAt = new Date().toISOString();
      const reason = error instanceof Error ? error.message : "unknown restore failure";
      appendRestoreLog(logPath, `failed ${database.id} restore; execution stopped: ${reason}`);
      state.status = "failed";
      state.updatedAt = failedAt;
      state.failed = { id: database.id, failedAt, log };
      writeRestoreState(statePath, state);
      fail(`${database.id} restore failed; execution stopped and the journal was preserved`);
    }
  }
  state.status = "complete";
  state.updatedAt = new Date().toISOString();
  state.failed = null;
  writeRestoreState(statePath, state);
  return state;
}

export async function restoreDemoLocal(options) {
  return restoreProfile({ ...options, profile: "DemoLocal" });
}

export function buildRestorePlan(manifest, verifiedAt = new Date().toISOString(), manifestSha256) {
  validateManifest(manifest);
  const manifestDigest = manifestSha256 ?? createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  if (!SHA256.test(manifestDigest)) fail("restore plan manifest checksum is invalid");
  return {
    format: RESTORE_PLAN_FORMAT,
    warning: LAB_WARNING,
    status: "paused-awaiting-native-integrity-and-reconciliation",
    generatedAt: parseIso(verifiedAt, "verifiedAt"),
    manifestSha256: manifestDigest,
    release: manifest.release,
    profile: manifest.profile,
    safetyGate: {
      workerDispatch: "disabled",
      providerMutation: "disabled",
      automaticResume: false,
      resumeRequirement: "record native integrity and reconciliation evidence, then perform an explicit operator resume",
    },
    orderedSteps: [
      {
        id: "provision-blank-pg18",
        action: "provision blank PostgreSQL 18 databases with no application or provider processes running",
        components: manifest.databases.map(({ id }) => id),
      },
      {
        id: "restore-encrypted-databases",
        action: "stream age decryption into pg_restore; pass libpq fields only through the process environment",
        artifacts: manifest.databases.map(({ id, artifact }) => ({ id, artifact })),
      },
      {
        id: "restore-version-bound-configuration",
        action: "restore the encrypted configuration/credential bundle to a private operator-selected location",
        artifact: manifest.artifacts.find(({ kind }) => kind === "configuration-credential-bundle")?.file,
        configurationVersion: manifest.release.configurationVersion,
        credentialSetVersion: manifest.release.credentialSetVersion,
      },
      {
        id: "native-integrity",
        action: "start only the exact release's read-only native checks; compare schema history, Provider table inventory, and attachment digests to the manifest",
      },
      {
        id: "reconcile",
        action: "reconcile Core outbox/jobs and Mock Provider operations without dispatching new side effects",
      },
      {
        id: "measure-and-explicitly-resume",
        action: "record measured RPO/RTO and reconciliation evidence; only then explicitly start Provider mutation and Worker dispatch",
      },
    ],
    upgradeBoundary: {
      forwardOnlyDatabaseMigration: true,
      requiredOrder: ["restore exact manifest commit", "native integrity", "reconcile", "forward migrate", "start upgraded application"],
    },
    rollbackBoundary: {
      downMigrationAllowed: false,
      applicationRollbackOnlyWhen: "the target build explicitly declares the restored/current schema native-compatible or provides its reviewed compatibility bridge",
    },
  };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (["--deep", "--dry-run", "--resume"].includes(argument)) {
      values[argument.slice(2)] = true;
      continue;
    }
    if (!argument.startsWith("--")) fail("unexpected positional argument");
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${argument} requires a value`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  return { command, values };
}

function requireOption(values, name) {
  const value = values[name];
  if (!value) fail(`--${name} is required`);
  return value;
}

function usage() {
  return `OpenSales laboratory RC backup (mock-only)

create --profile TestA|TestB|local|DemoLocal --output DIR --age-recipient RECIPIENT \\
  --configuration-version ID --credential-set-version ID --paused-at ISO8601
  Reads the configuration/credential bundle from stdin. Database libpq fields come from
  LAB_RC_<COMPONENT>_PG* environment variables; database URLs are rejected.

verify --archive DIR [--deep]
  Checks manifest shape, safe paths, age envelopes, sizes, and SHA-256 checksums.
  --deep also requires LAB_RC_AGE_IDENTITY_FILE and runs pg_restore --list in a stream.

restore-plan --archive DIR --output FILE
  Writes a non-executing restore plan whose Worker and Provider side effects remain disabled.

restore --profile TestA|TestB --archive DIR --journal DIR [--dry-run|--resume]
  Deep-verifies the matching host-profile archive, requires distinct blank PostgreSQL 18 targets,
  and restores them sequentially with single-transaction pg_restore. Target libpq fields come from
  the matching LAB_RC_<COMPONENT>_PG* environment variables. LAB_RC_AGE_IDENTITY_FILE is required.

restore-demo-local --archive DIR --journal DIR [--dry-run|--resume]
  Deep-verifies one four-database DemoLocal archive, requires distinct blank PostgreSQL 18 targets,
  and restores them sequentially with single-transaction pg_restore. Target libpq fields come from
  the DemoLocal LAB_RC_<COMPONENT>_PG* environment variables. LAB_RC_AGE_IDENTITY_FILE is required.
`;
}

async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArguments(argv);
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (command === "create") {
    const manifest = await createBackup({
      profile: requireOption(values, "profile"),
      output: requireOption(values, "output"),
      recipient: requireOption(values, "age-recipient"),
      configurationVersion: requireOption(values, "configuration-version"),
      credentialSetVersion: requireOption(values, "credential-set-version"),
      pausedAt: requireOption(values, "paused-at"),
      repositoryRoot,
      env: process.env,
      stdin: process.stdin,
    });
    process.stdout.write(`backup complete: ${manifest.profile}, ${manifest.artifacts.length} encrypted artifacts\n`);
    return;
  }
  if (command === "verify") {
    const result = await verifyBackup({
      archive: requireOption(values, "archive"),
      deep: values.deep === true,
      env: process.env,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "restore-plan") {
    const archive = resolve(requireOption(values, "archive"));
    const verification = await verifyBackup({ archive, deep: false, env: process.env });
    const output = resolve(requireOption(values, "output"));
    if (pathIsWithin(realpathSync(archive), canonicalProspectivePath(output))) {
      fail("restore plan output must be outside the immutable backup archive");
    }
    if (existsSync(output)) fail("restore plan output must not already exist");
    const manifest = JSON.parse(readFileSync(join(archive, "manifest.json"), "utf8"));
    jsonFile(output, buildRestorePlan(manifest, new Date().toISOString(), verification.manifestSha256));
    process.stdout.write("restore plan written; Worker dispatch and Provider mutation remain disabled\n");
    return;
  }
  if (command === "restore") {
    if (values["dry-run"] === true && values.resume === true) fail("--dry-run and --resume are mutually exclusive");
    const profile = normalizeProfile(requireOption(values, "profile"));
    if (profile !== "TestA" && profile !== "TestB") {
      fail("restore --profile accepts only TestA or TestB");
    }
    const state = await restoreProfile({
      profile,
      archive: requireOption(values, "archive"),
      journal: requireOption(values, "journal"),
      dryRun: values["dry-run"] === true,
      resume: values.resume === true,
      env: process.env,
    });
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  if (command === "restore-demo-local") {
    if (values["dry-run"] === true && values.resume === true) fail("--dry-run and --resume are mutually exclusive");
    const state = await restoreDemoLocal({
      archive: requireOption(values, "archive"),
      journal: requireOption(values, "journal"),
      dryRun: values["dry-run"] === true,
      resume: values.resume === true,
      env: process.env,
    });
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  process.stdout.write(usage());
  if (command && command !== "help" && command !== "--help") process.exitCode = 64;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`lab backup failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
