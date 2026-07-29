// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseClient } from "./database.js";

export type PaidInvoiceOutcome = {
  invoiceStatus: "partially_paid" | "paid";
  orderStatus?: string;
};

export async function advancePaidInvoice(
  client: DatabaseClient,
  invoiceId: string,
): Promise<PaidInvoiceOutcome> {
  const invoiceResult = await client.query<{
    total_minor: string;
    order_id: string | null;
  }>(
    `SELECT total_minor::text, order_id
     FROM invoices
     WHERE id = $1
     FOR UPDATE`,
    [invoiceId],
  );
  const invoice = invoiceResult.rows[0];
  if (!invoice) throw new Error("Invoice does not exist");
  const allocationResult = await client.query<{ allocated_minor: string }>(
    `SELECT allocated_minor::text
     FROM invoice_allocation_totals
     WHERE invoice_id = $1`,
    [invoiceId],
  );
  const allocated = BigInt(allocationResult.rows[0]?.allocated_minor ?? "0");
  if (allocated < BigInt(invoice.total_minor)) {
    return { invoiceStatus: "partially_paid" };
  }
  if (!invoice.order_id) return { invoiceStatus: "paid" };

  await client.query(
    `INSERT INTO outbox(event_type, unique_key, payload)
     VALUES ('invoice.paid', $1, $2)
     ON CONFLICT (event_type, unique_key) DO NOTHING`,
    [`invoice:${invoiceId}`, { invoiceId, orderId: invoice.order_id }],
  );
  const orderResult = await client.query<{
    id: string;
    status: string;
    fulfillment_mode: "automatic" | "review" | "manual" | "quote";
    service_id: string;
    email_verified_at: Date | null;
    user_restricted_at: Date | null;
    account_restricted_at: Date | null;
    removed_at: Date | null;
  }>(
    `SELECT
       o.id, o.status, oi.fulfillment_mode, s.id AS service_id,
       u.email_verified_at, u.restricted_at AS user_restricted_at,
       ca.restricted_at AS account_restricted_at, cm.removed_at
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN services s ON s.order_item_id = oi.id
     JOIN users u ON u.id = o.submitted_by_user_id
     JOIN client_accounts ca ON ca.id = o.client_account_id
     JOIN client_memberships cm
       ON cm.client_account_id = o.client_account_id
      AND cm.user_id = o.submitted_by_user_id
     WHERE o.id = $1
     FOR UPDATE OF o, s, u, ca, cm`,
    [invoice.order_id],
  );
  const order = orderResult.rows[0];
  if (!order) throw new Error("Invoice is linked to an invalid order");
  if (["completed", "cancelled", "rejected"].includes(order.status)) {
    await client.query(
      `INSERT INTO audit_events(
         actor_type, actor_id, action, target_type, target_id, reason, metadata
       ) VALUES ('system', 'core', 'billing.paid_order_terminal', 'order', $1, $2, $3)`,
      [
        order.id,
        "invoice became paid after the order entered a terminal state",
        { status: order.status, invoiceId },
      ],
    );
    return { invoiceStatus: "paid", orderStatus: order.status };
  }

  const eligible =
    Boolean(order.email_verified_at) &&
    !order.user_restricted_at &&
    !order.account_restricted_at &&
    !order.removed_at;
  if (!eligible) {
    await client.query(
      `UPDATE orders
       SET status = 'on_hold', updated_at = now(), version = version + 1
       WHERE id = $1
         AND status IN ('waiting_payment', 'accepted', 'awaiting_manual', 'fulfilling')`,
      [order.id],
    );
    return { invoiceStatus: "paid", orderStatus: "on_hold" };
  }

  if (order.fulfillment_mode === "manual" || order.fulfillment_mode === "review") {
    await client.query(
      `UPDATE orders
       SET status = 'awaiting_manual', updated_at = now(), version = version + 1
       WHERE id = $1 AND status = 'waiting_payment'`,
      [order.id],
    );
    return { invoiceStatus: "paid", orderStatus: "awaiting_manual" };
  }

  const accepted = await client.query(
    `UPDATE orders
     SET status = 'accepted', updated_at = now(), version = version + 1
     WHERE id = $1 AND status = 'waiting_payment'
     RETURNING id`,
    [order.id],
  );
  if (accepted.rowCount !== 1) {
    return { invoiceStatus: "paid", orderStatus: order.status };
  }
  const operationResult = await client.query<{ id: string }>(
    `INSERT INTO provider_operations(
       provider_installation_id, kind, subject_type, subject_id, stable_key, status
     ) VALUES ('mock-provisioning-v1', 'resource_create', 'service', $1, $2, 'queued')
     ON CONFLICT (provider_installation_id, kind, stable_key) DO UPDATE
       SET updated_at = provider_operations.updated_at
     RETURNING id`,
    [order.service_id, `service:${order.service_id}`],
  );
  const operationId = operationResult.rows[0]?.id;
  if (!operationId) throw new Error("Unable to create provisioning operation");
  await client.query(
    `INSERT INTO durable_jobs(job_type, unique_key, payload)
     VALUES ('provision.start', $1, $2)
     ON CONFLICT (job_type, unique_key) DO NOTHING`,
    [
      `service:${order.service_id}`,
      { serviceId: order.service_id, providerOperationId: operationId },
    ],
  );
  return { invoiceStatus: "paid", orderStatus: "accepted" };
}
