// SPDX-License-Identifier: AGPL-3.0-or-later

import { isPaymentBusinessStatePayable } from "@opensales/core";
import type { DatabaseClient } from "./database.js";

export async function assertInvoicePaymentBusinessStateLocked(
  client: DatabaseClient,
  invoiceId: string,
  orderId: string | null,
): Promise<void> {
  let payable = false;
  if (orderId) {
    const orderResult = await client.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1 FOR UPDATE",
      [orderId],
    );
    const order = orderResult.rows[0];
    if (!order) throw new Error("Invoice is linked to an invalid order");
    payable = isPaymentBusinessStatePayable({
      paymentContext: "order",
      orderStatus: order.status,
    });
  } else {
    const pointerResult = await client.query<{
      renewal_id: string;
      service_id: string;
      order_id: string;
    }>(
      `SELECT renewal.id AS renewal_id, service.id AS service_id,
              original_order.id AS order_id
       FROM service_renewals renewal
       JOIN services service ON service.id = renewal.service_id
       JOIN order_items item ON item.id = service.order_item_id
       JOIN orders original_order ON original_order.id = item.order_id
       WHERE renewal.invoice_id = $1`,
      [invoiceId],
    );
    const pointer = pointerResult.rows[0];
    if (!pointer) throw new Error("Renewal invoice is linked to an invalid service");
    await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [pointer.order_id]);
    await client.query("SELECT id FROM services WHERE id = $1 FOR UPDATE", [
      pointer.service_id,
    ]);
    await client.query("SELECT id FROM service_renewals WHERE id = $1 FOR UPDATE", [
      pointer.renewal_id,
    ]);
    const renewalResult = await client.query<{
      renewal_status: string;
      service_status: string;
    }>(
      `SELECT renewal.status AS renewal_status, service.status AS service_status
       FROM service_renewals renewal
       JOIN services service ON service.id = renewal.service_id
       WHERE renewal.id = $1`,
      [pointer.renewal_id],
    );
    const renewal = renewalResult.rows[0];
    if (!renewal) throw new Error("Renewal invoice is linked to an invalid service");
    payable = isPaymentBusinessStatePayable({
      paymentContext: "renewal",
      renewalStatus: renewal.renewal_status,
      serviceStatus: renewal.service_status,
    });
  }

  if (!payable) {
    throw Object.assign(
      new Error("Invoice is no longer payable in its current order or service state"),
      { statusCode: 409, code: "INVOICE_NOT_PAYABLE" },
    );
  }
}
