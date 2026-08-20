// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  enqueueNotification,
  notificationProviderOperationId,
  notificationRequestFingerprint,
} from "./notification-outbox.js";
import type { DatabaseClient } from "./database.js";

function templateRow(
  eventType: string,
  revisionKey: string,
  preferenceCategory: "identity" | "high_risk" | "support",
  requiredDelivery: boolean,
) {
  return {
    revision_id: "00000000-0000-4000-8000-000000000299",
    event_type: eventType,
    revision_key: revisionKey,
    provider_template_ref: revisionKey,
    template_locale: "en",
    preference_category: preferenceCategory,
    required_delivery: requiredDelivery,
    sensitive: preferenceCategory === "identity",
    subject_template: "Synthetic subject",
    body_template: "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY\n\nSynthetic body",
  } as const;
}

test("notification request fingerprints are canonical and scope-bound", () => {
  const first = notificationRequestFingerprint("notification.example", "example-v1", {
    z: [3, { b: true, a: "value" }],
    a: null,
  });
  const reordered = notificationRequestFingerprint("notification.example", "example-v1", {
    a: null,
    z: [3, { a: "value", b: true }],
  });
  assert.equal(first, reordered);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(
    first,
    notificationRequestFingerprint("notification.other", "example-v1", {
      a: null,
      z: [3, { a: "value", b: true }],
    }),
  );
  assert.notEqual(
    first,
    notificationRequestFingerprint("notification.example", "example-v1", {
      a: null,
      z: [3, { a: "changed", b: true }],
    }),
  );
  assert.notEqual(
    first,
    notificationRequestFingerprint("notification.example", "example-v2", {
      a: null,
      z: [3, { a: "value", b: true }],
    }),
  );
  assert.throws(
    () =>
      notificationRequestFingerprint("notification.example", "example-v1", {
        invalid: Infinity,
      }),
    /must be safe integers/,
  );
});

test("notification request fingerprints match the PostgreSQL 19 Unicode vector", () => {
  assert.equal(
    notificationRequestFingerprint(
      "notification.email_verification_requested",
      "email-verification-v1",
      {
        email: "owner+测试@example.invalid",
        expiresAt: "2026-01-02T03:04:05.678Z",
        locale: "zh-CN",
        userId: "11111111-2222-4333-8444-555555555555",
        verificationUrl:
          "https://example.invalid/verify?token=abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
      },
    ),
    "49d71fda6a4fbfb7b8a384ccf3e30e6f34cca5c526ecf2a9bd269ff9adb4adfa",
  );
  assert.equal(
    notificationProviderOperationId("01234567-89ab-4cde-8f01-23456789abcd", 1),
    "b47cfa74-6b6c-47dd-b34e-cf25aef998cd",
  );
});

test("notification Provider operation identity is deterministic per outbox attempt", () => {
  const outboxId = "123e4567-e89b-42d3-a456-426614174000";
  const first = notificationProviderOperationId(outboxId, 1);
  assert.equal(first, notificationProviderOperationId(outboxId, 1));
  assert.notEqual(first, notificationProviderOperationId(outboxId, 2));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => notificationProviderOperationId(outboxId, 0), /positive integer/);
  assert.throws(() => notificationProviderOperationId(outboxId, 1.5), /positive integer/);
});

test("notification enqueue locks account Users before Account and Membership and writes the v2 snapshot", async () => {
  const userId = "00000000-0000-4000-8000-000000000201";
  const clientAccountId = "00000000-0000-4000-8000-000000000202";
  const outboxId = "00000000-0000-4000-8000-000000000203";
  const statements: string[] = [];
  let operationParameters: readonly unknown[] | undefined;
  const client = {
    query: async (statement: string, parameters?: readonly unknown[]) => {
      const normalized = statement.replaceAll(/\s+/g, " ").trim();
      statements.push(normalized);
      if (normalized.includes("FROM public.users")) {
        return {
          rows: [{
            email: "owner@example.invalid",
            locale: "en",
            email_verified_at: new Date("2029-01-01T00:00:00.000Z"),
            restricted_at: null,
          }],
        };
      }
      if (normalized.includes("FROM public.client_accounts")) {
        return { rows: [{ owner_user_id: userId }] };
      }
      if (normalized.includes("FROM public.client_memberships")) {
        return { rows: [{ removed_at: null, restricted_at: null }] };
      }
      if (normalized.includes("FROM public.current_notification_templates")) {
        return {
          rows: [templateRow(
            "notification.service_cancellation_scheduled",
            "service-cancellation-scheduled-v1",
            "high_risk",
            true,
          )],
        };
      }
      if (normalized.startsWith("SELECT pg_catalog.pg_advisory_xact_lock")) {
        return { rows: [{}] };
      }
      if (normalized.includes("FROM public.outbox")) return { rows: [] };
      if (normalized.startsWith("INSERT INTO public.outbox")) {
        return { rows: [{ id: outboxId }] };
      }
      if (
        normalized.startsWith("SELECT") &&
        normalized.includes("FROM public.notification_delivery_operations")
      ) {
        return { rows: [] };
      }
      if (normalized.startsWith("INSERT INTO public.notification_delivery_operations")) {
        operationParameters = parameters;
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO public.durable_jobs")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected notification SQL: ${normalized}`);
    },
  } as unknown as DatabaseClient;

  const enqueued = await enqueueNotification(client, {
    eventType: "notification.service_cancellation_scheduled",
    uniqueKey: "service-cancellation:synthetic",
    payload: {
      cancellationRequestId: "00000000-0000-4000-8000-000000000204",
      serviceId: "00000000-0000-4000-8000-000000000205",
      productName: "Synthetic VPS",
      effectiveAt: "2030-02-01T00:00:00.000Z",
      executionMode: "automatic",
    },
    recipient: {
      kind: "account_user",
      category: "service",
      userId,
      clientAccountId,
      email: "owner@example.invalid",
      locale: "en",
    },
  });

  assert.ok(statements[0]?.startsWith("SELECT pg_catalog.pg_advisory_xact_lock"));
  const userLock = statements.findIndex((statement) => statement.includes("FROM public.users"));
  const accountLock = statements.findIndex((statement) => statement.includes("FROM public.client_accounts"));
  const membershipLock = statements.findIndex((statement) => statement.includes("FROM public.client_memberships"));
  assert.ok(userLock > 0 && statements[userLock]?.includes("FOR SHARE NOWAIT"));
  assert.ok(accountLock > userLock);
  assert.ok(membershipLock > accountLock);
  assert.equal(operationParameters?.[3], "notification.service_cancellation_scheduled");
  assert.equal(operationParameters?.[4], "service-cancellation-scheduled-v1");
  assert.equal(operationParameters?.[5], "00000000-0000-4000-8000-000000000299");
  assert.equal(operationParameters?.[6], "en");
  assert.deepEqual(operationParameters?.[7], {
    cancellationRequestId: "00000000-0000-4000-8000-000000000204",
    serviceId: "00000000-0000-4000-8000-000000000205",
    productName: "Synthetic VPS",
    effectiveAt: "2030-02-01T00:00:00.000Z",
    executionMode: "automatic",
    email: "owner@example.invalid",
    locale: "en",
    notificationCategory: "service",
    notificationRecipientKind: "account_user",
    notificationRecipientSubjectId: userId,
    notificationRecipientScopeId: clientAccountId,
    userId,
    accountId: clientAccountId,
  });
  assert.equal(enqueued.outboxId, outboxId);
  assert.equal(enqueued.providerOperationId, notificationProviderOperationId(outboxId, 1));
  assert.equal(enqueued.status, "queued");
});

test("a stable ineligible account User records a skipped fact without rolling back the event", async () => {
  const userId = "00000000-0000-4000-8000-000000000206";
  const clientAccountId = "00000000-0000-4000-8000-000000000207";
  const outboxId = "00000000-0000-4000-8000-000000000208";
  let operationStatus: unknown;
  let operationReason: unknown;
  let factWritten = false;
  let published = false;
  let jobParameters: readonly unknown[] | undefined;
  const client = {
    query: async (statement: string, parameters?: readonly unknown[]) => {
      const normalized = statement.replaceAll(/\s+/g, " ").trim();
      if (normalized.includes("FROM public.users")) {
        return {
          rows: [{
            email: "restricted@example.invalid",
            locale: "en",
            email_verified_at: new Date("2029-01-01T00:00:00.000Z"),
            restricted_at: new Date("2030-01-01T00:00:00.000Z"),
          }],
        };
      }
      if (normalized.includes("FROM public.client_accounts")) {
        return { rows: [{ owner_user_id: userId }] };
      }
      if (normalized.includes("FROM public.client_memberships")) {
        return { rows: [{ removed_at: null, restricted_at: null }] };
      }
      if (normalized.includes("FROM public.current_notification_templates")) {
        return {
          rows: [templateRow(
            "notification.service_cancellation_scheduled",
            "service-cancellation-scheduled-v1",
            "high_risk",
            true,
          )],
        };
      }
      if (normalized.startsWith("SELECT pg_catalog.pg_advisory_xact_lock")) {
        return { rows: [{}] };
      }
      if (normalized.includes("FROM public.outbox")) return { rows: [] };
      if (normalized.startsWith("INSERT INTO public.outbox")) {
        return { rows: [{ id: outboxId }] };
      }
      if (
        normalized.startsWith("SELECT") &&
        normalized.includes("FROM public.notification_delivery_operations")
      ) {
        return { rows: [] };
      }
      if (normalized.startsWith("INSERT INTO public.notification_delivery_operations")) {
        operationStatus = parameters?.[19];
        operationReason = parameters?.[20];
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO public.notification_delivery_facts")) {
        factWritten = true;
        assert.equal(parameters?.[1], "ACCOUNT_USER_RECIPIENT_INELIGIBLE");
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE public.outbox")) {
        published = true;
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("INSERT INTO public.durable_jobs")) {
        jobParameters = parameters;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected notification SQL: ${normalized}`);
    },
  } as unknown as DatabaseClient;

  const enqueued = await enqueueNotification(client, {
    eventType: "notification.service_cancellation_scheduled",
    uniqueKey: "service-cancellation:restricted-recipient",
    payload: {
      cancellationRequestId: "00000000-0000-4000-8000-000000000209",
      serviceId: "00000000-0000-4000-8000-000000000210",
      productName: "Synthetic VPS",
      effectiveAt: "2030-02-01T00:00:00.000Z",
      executionMode: "automatic",
    },
    recipient: {
      kind: "account_user",
      category: "service",
      userId,
      clientAccountId,
      email: "restricted@example.invalid",
      locale: "en",
    },
  });

  assert.equal(enqueued.status, "skipped");
  assert.equal(operationStatus, "skipped");
  assert.equal(operationReason, "ACCOUNT_USER_RECIPIENT_INELIGIBLE");
  assert.equal(factWritten, true);
  assert.equal(published, true);
  assert.equal(jobParameters?.[2], "completed");
  assert.equal(jobParameters?.[3], "ACCOUNT_USER_RECIPIENT_INELIGIBLE");
});

test("notification enqueue exposes recipient lock races as a retryable product conflict", async () => {
  const client = {
    query: async () => {
      throw Object.assign(new Error("synthetic lock"), { code: "55P03" });
    },
  } as unknown as DatabaseClient;
  await assert.rejects(
    () =>
      enqueueNotification(client, {
        eventType: "notification.email_verification_requested",
        uniqueKey: "verification:synthetic",
        payload: { verificationUrl: "https://example.invalid/verify?token=synthetic" },
        recipient: {
          kind: "identity_user",
          category: "identity",
          userId: "00000000-0000-4000-8000-000000000211",
          email: "verify@example.invalid",
          locale: "en",
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      "statusCode" in error &&
      error.statusCode === 409 &&
      "code" in error &&
      error.code === "NOTIFICATION_RECIPIENT_CHANGED",
  );
});

test("membership invitation enqueue binds the exact URL token to the locked invitation", async () => {
  const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
  const clientAccountId = "00000000-0000-4000-8000-000000000221";
  const invitationId = "00000000-0000-4000-8000-000000000222";
  const client = {
    query: async (statement: string, parameters?: readonly unknown[]) => {
      const normalized = statement.replaceAll(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT pg_catalog.pg_advisory_xact_lock")) {
        return { rows: [{}] };
      }
      if (normalized.includes("FROM public.outbox")) return { rows: [] };
      if (normalized.includes("FROM public.notification_delivery_operations")) {
        return { rows: [] };
      }
      if (normalized.includes("FROM public.current_notification_templates")) {
        return {
          rows: [templateRow(
            "notification.membership_invitation_requested",
            "membership-invitation-v1",
            "high_risk",
            true,
          )],
        };
      }
      if (normalized.includes("FROM public.client_accounts")) {
        return { rows: [{ id: clientAccountId }] };
      }
      if (normalized.includes("FROM public.client_membership_invitations")) {
        const suppliedDigest = parameters?.[2];
        assert.ok(Buffer.isBuffer(suppliedDigest));
        assert.equal(
          suppliedDigest.toString("hex"),
          createHash("sha256").update(token, "utf8").digest("hex"),
        );
        return { rows: [] };
      }
      throw new Error(`Unexpected notification SQL: ${normalized}`);
    },
  } as unknown as DatabaseClient;

  await assert.rejects(
    () =>
      enqueueNotification(client, {
        eventType: "notification.membership_invitation_requested",
        uniqueKey: `membership-invitation:${invitationId}`,
        payload: {
          accountName: "Synthetic Account",
          role: "viewer",
          invitationUrl:
            `https://example.invalid/membership-invitations/accept?token=${token}`,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        recipient: {
          kind: "invitation",
          category: "membership_invitation",
          invitationId,
          clientAccountId,
          email: "invited@example.invalid",
          locale: "en",
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "NOTIFICATION_RECIPIENT_CHANGED",
  );
});

test("email verification enqueue binds the exact URL token to the locked token row", async () => {
  const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
  const userId = "00000000-0000-4000-8000-000000000231";
  const verificationTokenId = "00000000-0000-4000-8000-000000000232";
  const client = {
    query: async (statement: string, parameters?: readonly unknown[]) => {
      const normalized = statement.replaceAll(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT pg_catalog.pg_advisory_xact_lock")) {
        return { rows: [{}] };
      }
      if (normalized.includes("FROM public.outbox")) return { rows: [] };
      if (normalized.includes("FROM public.notification_delivery_operations")) {
        return { rows: [] };
      }
      if (normalized.includes("FROM public.current_notification_templates")) {
        return {
          rows: [templateRow(
            "notification.email_verification_requested",
            "email-verification-v1",
            "identity",
            true,
          )],
        };
      }
      if (normalized.includes("FROM public.users")) {
        return {
          rows: [{
            email: "verify@example.invalid",
            locale: "en",
            email_verified_at: null,
            restricted_at: null,
          }],
        };
      }
      if (normalized.includes("FROM public.email_verification_tokens")) {
        assert.equal(parameters?.[0], verificationTokenId);
        assert.equal(parameters?.[1], userId);
        const suppliedDigest = parameters?.[2];
        assert.ok(Buffer.isBuffer(suppliedDigest));
        assert.equal(
          suppliedDigest.toString("hex"),
          createHash("sha256").update(token, "utf8").digest("hex"),
        );
        return { rows: [] };
      }
      throw new Error(`Unexpected notification SQL: ${normalized}`);
    },
  } as unknown as DatabaseClient;

  await assert.rejects(
    () =>
      enqueueNotification(client, {
        eventType: "notification.email_verification_requested",
        uniqueKey: `verification:${verificationTokenId}`,
        payload: {
          verificationTokenId,
          verificationUrl: `https://example.invalid/verify?token=${token}`,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        recipient: {
          kind: "identity_user",
          category: "identity",
          userId,
          email: "verify@example.invalid",
          locale: "en",
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "NOTIFICATION_RECIPIENT_CHANGED",
  );
});
