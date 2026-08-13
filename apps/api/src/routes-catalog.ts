// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCustomerCapability, assertEligible, requireUser } from "./auth.js";
import {
  buildOfferSnapshot,
  jsonCommercialSnapshot,
  lockCatalogOffer,
  lockPromotion,
  supplyPreflight,
} from "./commerce-service.js";
import type { Config } from "./config.js";
import { transaction, type DatabasePool } from "./database.js";

const catalogPreviewSchema = z
  .object({
    priceId: z.uuid(),
    configuration: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .default({}),
    promotionCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9_-]{2,63}$/)
      .nullable()
      .default(null),
  })
  .strict();

export async function registerCatalogRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
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
      product_revision_id: string;
      product_revision: number;
      supply_mode: "unlimited" | "tracked" | "manual_review";
      available_units: string | null;
      committed_units: string;
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
         current_revision.option_schema,
         current_revision.id AS product_revision_id,
         current_revision.revision AS product_revision,
         COALESCE(capacity.mode, 'unlimited') AS supply_mode,
         capacity.available_units::text,
         COALESCE(capacity.committed_units, 0)::text AS committed_units,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', pp.id,
               'revision', pp.revision,
               'productRevisionId', price_revision.id,
               'productRevision', price_revision.revision,
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
       JOIN LATERAL (
         SELECT revision.id, revision.revision, revision.option_schema
         FROM catalog_product_revisions revision
         WHERE revision.product_id = p.id
         ORDER BY revision.revision DESC
         LIMIT 1
       ) current_revision ON true
       LEFT JOIN product_prices pp
         ON pp.product_id = p.id
        AND pp.catalog_product_revision_id = current_revision.id
        AND pp.active
        AND pp.valid_from <= now()
        AND (pp.valid_until IS NULL OR pp.valid_until > now())
       LEFT JOIN catalog_product_revisions price_revision
         ON price_revision.id = pp.catalog_product_revision_id
       LEFT JOIN product_supply_capacities capacity ON capacity.product_id = p.id
       WHERE p.active AND NOT p.hidden
       GROUP BY p.id, pg.id, current_revision.id, current_revision.revision,
                current_revision.option_schema, capacity.mode,
                capacity.available_units, capacity.committed_units
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
        productRevisionId: row.product_revision_id,
        productRevision: row.product_revision,
        supply: {
          mode: row.supply_mode,
          availableUnits: row.available_units,
          committedUnits: row.committed_units,
        },
        prices: row.prices,
        purchasable: row.fulfillment_mode !== "quote",
      })),
    };
  });

  app.post("/api/v1/catalog/preview", async (request) => {
    const user = await requireUser(request, pool, config);
    assertEligible(user);
    assertCustomerCapability(user, "orders.create");
    const body = catalogPreviewSchema.parse(request.body);
    return transaction(pool, async (client) => {
      const offer = await lockCatalogOffer(client, {
        priceId: body.priceId,
        locale: user.locale,
        allowQuote: false,
      });
      const promotion = await lockPromotion(client, {
        code: body.promotionCode,
        productId: offer.productId,
        billingCycle: offer.billingCycle,
        currency: offer.currency,
      });
      const priced = buildOfferSnapshot(offer, body.configuration, promotion);
      const capacity = await supplyPreflight(client, {
        productId: offer.productId,
        units: priced.capacityUnits,
        commit: false,
      });
      return {
        configuration: priced.configurationSnapshot,
        price: jsonCommercialSnapshot(priced.snapshot, {
          productRevisionId: offer.productRevisionId,
          productRevision: offer.productRevision,
          priceId: offer.priceId,
          priceRevision: offer.priceRevision,
          capacity,
        }),
      };
    });
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
