// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  hasCustomerMembershipCapability,
  type CustomerMembershipRole,
} from "@opensales/core";
import type { DatabaseClient } from "./database.js";
import type { RenewalResumeScheduleOutcome } from "./delinquency-lifecycle.js";
import { settleRenewalInvoice } from "./renewal-lifecycle.js";

export type PaidInvoiceOutcome = {
  invoiceStatus: "partially_paid" | "paid";
  orderStatus?: string;
  renewalStatus?: "paid" | "manual_hold";
  serviceStatus?: string;
  resumeSchedule?: RenewalResumeScheduleOutcome;
};

export type InvoiceSettlementContext =
  | { kind: "user_command"; userId: string }
  | {
      kind: "automatic_renewal";
      authorizationId: string;
    }
  | {
      kind: "staff_manual";
      staffUserId: string;
      reason?: string;
    }
  | {
      kind: "staff_hold_resolution";
      staffUserId: string;
      expectedRenewalVersion: number;
      reason: string;
    };

export async function advancePaidInvoice(
  client: DatabaseClient,
  invoiceId: string,
  context?: InvoiceSettlementContext,
): Promise<PaidInvoiceOutcome> {
  const identityPointerResult = await client.query<{
    client_account_id: string;
    submitted_by_user_id: string | null;
    automatic_user_id: string | null;
  }>(
    `SELECT invoice.client_account_id,
            pg_catalog.coalesce(
              order_record.submitted_by_user_id,
              original_order.submitted_by_user_id
            ) AS submitted_by_user_id,
            authorization.granted_by_user_id AS automatic_user_id
     FROM invoices invoice
     LEFT JOIN orders order_record ON order_record.id = invoice.order_id
     LEFT JOIN service_renewals renewal ON renewal.invoice_id = invoice.id
     LEFT JOIN services service ON service.id = renewal.service_id
     LEFT JOIN order_items item ON item.id = service.order_item_id
     LEFT JOIN orders original_order ON original_order.id = item.order_id
     LEFT JOIN automatic_renewal_authorizations authorization ON authorization.id = $2
     WHERE invoice.id = $1`,
    [
      invoiceId,
      context?.kind === "automatic_renewal" ? context.authorizationId : null,
    ],
  );
  const identityPointer = identityPointerResult.rows[0];
  if (!identityPointer) throw new Error("Invoice does not exist");
  const contextUserId =
    context?.kind === "user_command"
      ? context.userId
      : context?.kind === "staff_manual" || context?.kind === "staff_hold_resolution"
        ? context.staffUserId
        : identityPointer.automatic_user_id;
  const userIds = [identityPointer.submitted_by_user_id, contextUserId]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  if (userIds.length > 0) {
    await client.query(
      `SELECT id FROM users
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [userIds],
    );
  }
  await client.query("SELECT id FROM client_accounts WHERE id = $1 FOR UPDATE", [
    identityPointer.client_account_id,
  ]);
  const membershipUserIds = [
    identityPointer.submitted_by_user_id,
    context?.kind === "user_command" ? context.userId : null,
    identityPointer.automatic_user_id,
  ]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  if (membershipUserIds.length > 0) {
    await client.query(
      `SELECT user_id
       FROM client_memberships
       WHERE client_account_id = $1
         AND user_id = ANY($2::uuid[])
       ORDER BY user_id
       FOR UPDATE`,
      [identityPointer.client_account_id, membershipUserIds],
    );
  }
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
  if (!invoice.order_id) {
    const renewal = await settleRenewalInvoice(client, invoiceId, context);
    if (!renewal) return { invoiceStatus: "paid" };
    return {
      invoiceStatus: "paid",
      renewalStatus: renewal.renewalStatus,
      serviceStatus: renewal.serviceStatus,
      ...(renewal.resumeSchedule ? { resumeSchedule: renewal.resumeSchedule } : {}),
    };
  }

  await client.query(
    `INSERT INTO outbox(event_type, unique_key, payload)
     VALUES ('invoice.paid', $1, $2)
     ON CONFLICT (event_type, unique_key) DO NOTHING`,
    [`invoice:${invoiceId}`, { invoiceId, orderId: invoice.order_id }],
  );
  const lockPointers = await client.query<{
    order_id: string;
    service_id: string;
    submitted_by_user_id: string;
    client_account_id: string;
  }>(
    `SELECT o.id AS order_id, s.id AS service_id,
            o.submitted_by_user_id, o.client_account_id
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN services s ON s.order_item_id = oi.id
     WHERE o.id = $1`,
    [invoice.order_id],
  );
  const lockPointer = lockPointers.rows[0];
  if (!lockPointer) throw new Error("Invoice is linked to an invalid order");
  await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [lockPointer.order_id]);
  await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
    lockPointer.service_id,
  ]);
  const orderResult = await client.query<{
    id: string;
    status: string;
    fulfillment_mode: "automatic" | "review" | "manual" | "quote";
    service_id: string;
    email_verified_at: Date | null;
    user_restricted_at: Date | null;
    account_restricted_at: Date | null;
    membership_role: CustomerMembershipRole;
    membership_permissions: unknown;
    membership_restricted_at: Date | null;
    removed_at: Date | null;
  }>(
    `SELECT
       o.id, o.status, oi.fulfillment_mode, s.id AS service_id,
       u.email_verified_at, u.restricted_at AS user_restricted_at,
       ca.restricted_at AS account_restricted_at,
       cm.role AS membership_role,
       cm.permissions AS membership_permissions,
       cm.restricted_at AS membership_restricted_at,
       cm.removed_at
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN services s ON s.order_item_id = oi.id
     JOIN users u ON u.id = o.submitted_by_user_id
     JOIN client_accounts ca ON ca.id = o.client_account_id
     JOIN client_memberships cm
       ON cm.client_account_id = o.client_account_id
      AND cm.user_id = o.submitted_by_user_id
     WHERE o.id = $1`,
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
    !order.membership_restricted_at &&
    !order.removed_at &&
    hasCustomerMembershipCapability(
      {
        role: order.membership_role,
        permissions:
          Array.isArray(order.membership_permissions) &&
          order.membership_permissions.every(
            (permission): permission is string => typeof permission === "string",
          )
            ? order.membership_permissions
            : [],
      },
      "orders.create",
    );
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
