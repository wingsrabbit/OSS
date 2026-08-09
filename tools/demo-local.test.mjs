// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  recoverAdministratorAccount,
  repositoryRevision,
  verifyStoredProcessIdentity,
} from "./demo-local.mjs";
import {
  assertSeparatedDemoRoles,
  runSupportTicketSmoke,
} from "./demo-smoke.mjs";

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
