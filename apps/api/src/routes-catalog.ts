// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from "fastify";
import type { DatabasePool } from "./database.js";

export async function registerCatalogRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
): Promise<void> {
  app.get("/api/v1/catalog", async (request) => {
    const locale =
      typeof request.query === "object" &&
      request.query !== null &&
      "locale" in request.query &&
      request.query.locale === "zh-CN"
        ? "zh-CN"
        : "en";
    const result = await pool.query<{
      id: string;
      group_id: string;
      group_name: string;
      name: string;
      description: string;
      fulfillment_mode: string;
      repeatable: boolean;
      option_schema: unknown;
      prices: unknown;
    }>(
      `SELECT
         p.id,
         p.group_id,
         COALESCE(pg.names ->> $1, pg.names ->> 'en') AS group_name,
         COALESCE(p.names ->> $1, p.names ->> 'en') AS name,
         COALESCE(p.descriptions ->> $1, p.descriptions ->> 'en') AS description,
         p.fulfillment_mode,
         p.repeatable,
         p.option_schema,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', pp.id,
               'revision', pp.revision,
               'currency', pp.currency,
               'billingCycle', pp.billing_cycle,
               'oneTimeMinor', pp.one_time_minor::text,
               'setupMinor', pp.setup_minor::text,
               'recurringMinor', pp.recurring_minor::text
             ) ORDER BY pp.recurring_minor, pp.one_time_minor
           ) FILTER (WHERE pp.id IS NOT NULL),
           '[]'::jsonb
         ) AS prices
       FROM products p
       JOIN product_groups pg ON pg.id = p.group_id
       LEFT JOIN product_prices pp
         ON pp.product_id = p.id
        AND pp.active
        AND pp.valid_from <= now()
        AND (pp.valid_until IS NULL OR pp.valid_until > now())
       WHERE p.active AND NOT p.hidden
       GROUP BY p.id, pg.id
       ORDER BY pg.sort_order, p.id`,
      [locale],
    );
    return {
      locale,
      currency: "USD",
      products: result.rows.map((row) => ({
        id: row.id,
        groupId: row.group_id,
        groupName: row.group_name,
        name: row.name,
        description: row.description,
        fulfillmentMode: row.fulfillment_mode,
        repeatable: row.repeatable,
        optionSchema: row.option_schema,
        prices: row.prices,
        purchasable: row.fulfillment_mode !== "quote",
      })),
    };
  });

  app.get("/api/v1/legal/current", async (request) => {
    const locale =
      typeof request.query === "object" &&
      request.query !== null &&
      "locale" in request.query &&
      request.query.locale === "zh-CN"
        ? "zh-CN"
        : "en";
    const result = await pool.query<{
      id: string;
      kind: "terms" | "aup" | "privacy";
      version: string;
      title: string;
      body: string;
    }>(
      `SELECT DISTINCT ON (kind) id, kind, version, title, body
       FROM legal_documents
       WHERE locale = $1 AND published_at <= now()
       ORDER BY kind, published_at DESC`,
      [locale],
    );
    return {
      locale,
      documents: Object.fromEntries(result.rows.map((document) => [document.kind, document])),
    };
  });
}
