// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseClient } from "./database.js";

export async function freezeCompetingRefunds(
  client: DatabaseClient,
  input: {
    heldRefundId: string;
    receiptId: string;
    reason: string;
    cause?: "provider_security_hold" | "dismissal_correction";
    correctionId?: string;
  },
): Promise<string[]> {
  const cause = input.cause ?? "provider_security_hold";
  const candidates = await client.query<{
    id: string;
    status: string;
    operation_id: string | null;
    operation_status: string | null;
    attempt_count: number | null;
  }>(
    `SELECT
       competing.id,
       competing.status,
       operation.id AS operation_id,
       operation.status AS operation_status,
       operation.attempt_count
     FROM refunds competing
     LEFT JOIN provider_operations operation
       ON operation.subject_type = 'refund'
      AND operation.subject_id = competing.id
      AND operation.kind = 'refund_create'
     WHERE competing.source_fund_receipt_id = $1
       AND competing.id <> $2
       AND competing.status IN ('queued', 'processing', 'unknown')
     ORDER BY competing.id
     FOR UPDATE OF competing`,
    [input.receiptId, input.heldRefundId],
  );
  const frozenIds: string[] = [];
  for (const competing of candidates.rows) {
    const knownUnsent =
      competing.status === "queued" &&
      competing.operation_id !== null &&
      competing.operation_status === "queued" &&
      competing.attempt_count === 0;
    const nextStatus = knownUnsent ? "failed" : "manual";
    const ownsSecurityHold = cause === "dismissal_correction" && !knownUnsent;
    const resultMetadata =
      cause === "dismissal_correction"
        ? {
            frozenByCorrectionId: input.correctionId,
            correctedRefundId: input.heldRefundId,
          }
        : { frozenByRefundId: input.heldRefundId };
    await client.query(
      `UPDATE refunds
       SET status = $2,
           security_hold = $3,
           last_error = $4,
           result = result || $5::jsonb,
           updated_at = now(),
           version = version + 1
       WHERE id = $1`,
      [
        competing.id,
        nextStatus,
        ownsSecurityHold,
        input.reason,
        JSON.stringify(resultMetadata),
      ],
    );
    if (competing.operation_id) {
      await client.query(
        `UPDATE provider_operations
         SET status = $2, last_error = $3, updated_at = now()
         WHERE id = $1 AND status NOT IN ('succeeded', 'failed')`,
        [competing.operation_id, knownUnsent ? "failed" : "unknown", input.reason],
      );
    }
    await client.query(
      `UPDATE durable_jobs
       SET status = $2,
           locked_at = NULL,
           locked_by = NULL,
           last_error = $3,
           updated_at = now()
       WHERE payload->>'refundId' = $1
         AND job_type IN ('refund.start', 'refund.reconcile')
         AND status NOT IN ('completed', 'manual')`,
      [competing.id, knownUnsent ? "completed" : "manual", input.reason],
    );
    await client.query(
      `INSERT INTO refund_events(
         refund_id, event_type, actor_type, actor_id, reason, metadata
       ) VALUES ($1, $2, 'system', $3, $4, $5)`,
      [
        competing.id,
        knownUnsent ? "failed" : "manual",
        cause === "dismissal_correction"
          ? "refund-dismissal-correction-freeze"
          : "refund-security-freeze",
        input.reason,
        {
          heldRefundId: input.heldRefundId,
          correctionId: input.correctionId ?? null,
          cause,
          knownUnsent,
        },
      ],
    );
    frozenIds.push(competing.id);
  }
  return frozenIds;
}
