// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.js";
import type { Config } from "./config.js";
import type { DatabasePool } from "./database.js";
import {
  LAB_WARNING,
  listCancellations,
  listInvoices,
  listOrders,
  listPayments,
  listRefunds,
  listRenewals,
  listServices,
  listTickets,
  loadCreditHistory,
  withReadSnapshot,
} from "./routes-customer-history.js";
import { requireStaffPermission } from "./routes-admin.js";

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());

type AccountIdentity = {
  id: string;
  name: string;
};

type Queryable = Pick<DatabasePool, "query">;

const accountSearchCursorSchema = z
  .object({
    version: z.literal(1),
    query: z.string().min(1).max(200),
    rank: z.number().int().min(0).max(1),
    name: z.string(),
    id: canonicalUuid,
  })
  .strict();

type AccountSearchCursor = z.infer<typeof accountSearchCursorSchema>;

function requestError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

async function loadAccountIdentity(
  queryable: Queryable,
  clientAccountId: string,
): Promise<AccountIdentity> {
  const result = await queryable.query<AccountIdentity>(
    "SELECT id, name FROM client_accounts WHERE id = $1",
    [clientAccountId],
  );
  const account = result.rows[0];
  if (!account) throw requestError("Client account not found", 404);
  return account;
}

function encodeAccountSearchCursor(cursor: AccountSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAccountSearchCursor(
  value: string | undefined,
  expectedQuery: string,
): AccountSearchCursor | null {
  if (!value) return null;
  try {
    const decoded = accountSearchCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (decoded.query !== expectedQuery) {
      throw requestError("Search cursor does not match this query", 400);
    }
    return decoded;
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error;
    throw requestError("Invalid search cursor", 400);
  }
}

function stringPermissions(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : [];
}

export async function registerClientAccountRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  config: Config,
): Promise<void> {
  app.get("/api/v1/admin/client-accounts", async (request) => {
    const user = await requireUser(request, pool, config);
    await requireStaffPermission(pool, user, "accounts.view");
    const query = z
      .object({
        query: z.string().trim().min(1).max(200),
        limit: z.coerce.number().int().min(1).max(50).default(25),
        cursor: z.string().min(1).max(4_096).optional(),
      })
      .strict()
      .parse(request.query);
    const uuidSearch = canonicalUuid.safeParse(query.query);
    const cursor = decodeAccountSearchCursor(query.cursor, query.query);
    const result = await pool.query<{
      id: string;
      name: string;
      owner_user_id: string;
      owner_email: string;
      owner_email_verified_at: Date | null;
      restricted_at: Date | null;
      active_member_count: string;
      created_at: Date;
      sort_rank: number;
      sort_name: string;
    }>(
      `SELECT account.id,
              account.name,
              owner.id AS owner_user_id,
              owner.email::text AS owner_email,
              owner.email_verified_at AS owner_email_verified_at,
              account.restricted_at,
              count(membership.user_id) FILTER (WHERE membership.removed_at IS NULL)::text
                AS active_member_count,
              account.created_at,
              CASE WHEN account.id = $2::uuid THEN 0 ELSE 1 END AS sort_rank,
              pg_catalog.lower(account.name) AS sort_name
       FROM client_accounts account
       JOIN users owner ON owner.id = account.owner_user_id
       LEFT JOIN client_memberships membership
         ON membership.client_account_id = account.id
       WHERE (
         ($2::uuid IS NOT NULL AND account.id = $2::uuid)
         OR pg_catalog.strpos(
              pg_catalog.lower(account.name), pg_catalog.lower($1)
            ) > 0
         OR EXISTS (
              SELECT 1
              FROM client_memberships searchable_membership
              JOIN users searchable_user
                ON searchable_user.id = searchable_membership.user_id
              WHERE searchable_membership.client_account_id = account.id
                AND searchable_membership.removed_at IS NULL
                AND pg_catalog.strpos(
                      pg_catalog.lower(searchable_user.email::text),
                      pg_catalog.lower($1)
                    ) > 0
            )
       )
       AND (
         $4::integer IS NULL
         OR CASE WHEN account.id = $2::uuid THEN 0 ELSE 1 END > $4::integer
         OR (
           CASE WHEN account.id = $2::uuid THEN 0 ELSE 1 END = $4::integer
           AND pg_catalog.lower(account.name) > $5::text
         )
         OR (
           CASE WHEN account.id = $2::uuid THEN 0 ELSE 1 END = $4::integer
           AND pg_catalog.lower(account.name) = $5::text
           AND account.id > $6::uuid
         )
       )
       GROUP BY account.id, owner.id
       ORDER BY
         CASE WHEN account.id = $2::uuid THEN 0 ELSE 1 END,
         pg_catalog.lower(account.name),
         account.id
       LIMIT $3`,
      [
        query.query,
        uuidSearch.success ? uuidSearch.data : null,
        query.limit + 1,
        cursor?.rank ?? null,
        cursor?.name ?? null,
        cursor?.id ?? null,
      ],
    );
    const hasMore = result.rows.length > query.limit;
    const visibleRows = result.rows.slice(0, query.limit);
    const lastVisible = visibleRows.at(-1);
    return {
      warning: LAB_WARNING,
      items: visibleRows.map((row) => ({
        id: row.id,
        name: row.name,
        owner: {
          userId: row.owner_user_id,
          email: row.owner_email,
          emailVerifiedAt: row.owner_email_verified_at?.toISOString() ?? null,
        },
        restrictedAt: row.restricted_at?.toISOString() ?? null,
        activeMemberCount: Number(row.active_member_count),
        createdAt: row.created_at.toISOString(),
      })),
      hasMore,
      nextCursor:
        hasMore && lastVisible
          ? encodeAccountSearchCursor({
              version: 1,
              query: query.query,
              rank: lastVisible.sort_rank,
              name: lastVisible.sort_name,
              id: lastVisible.id,
            })
          : null,
    };
  });

  app.get(
    "/api/v1/admin/client-accounts/:clientAccountId/summary",
    async (request) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "accounts.view");
      const params = z.object({ clientAccountId: canonicalUuid }).parse(request.params);
      return withReadSnapshot(pool, async (client) => {
        const accountResult = await client.query<{
          id: string;
          name: string;
          created_at: Date;
          restricted_at: Date | null;
          owner_user_id: string;
          owner_email: string;
          owner_email_verified_at: Date | null;
          owner_restricted_at: Date | null;
        }>(
          `SELECT account.id,
                  account.name,
                  account.created_at,
                  account.restricted_at,
                  owner.id AS owner_user_id,
                  owner.email::text AS owner_email,
                  owner.email_verified_at AS owner_email_verified_at,
                  owner.restricted_at AS owner_restricted_at
           FROM client_accounts account
           JOIN users owner ON owner.id = account.owner_user_id
           WHERE account.id = $1`,
          [params.clientAccountId],
        );
        const account = accountResult.rows[0];
        if (!account) throw requestError("Client account not found", 404);
        const memberships = await client.query<{
          user_id: string;
          email: string;
          role: string;
          permissions: unknown;
          email_verified_at: Date | null;
          user_restricted_at: Date | null;
          created_at: Date;
          removed_at: Date | null;
        }>(
          `SELECT membership.user_id,
                  user_account.email::text,
                  membership.role,
                  membership.permissions,
                  user_account.email_verified_at,
                  user_account.restricted_at AS user_restricted_at,
                  membership.created_at,
                  membership.removed_at
           FROM client_memberships membership
           JOIN users user_account ON user_account.id = membership.user_id
           WHERE membership.client_account_id = $1
           ORDER BY membership.removed_at NULLS FIRST,
                    membership.created_at,
                    membership.user_id`,
          [params.clientAccountId],
        );
        const restrictions = await client.query<{
          id: string;
          kind: string;
          source_type: string;
          source_id: string;
          reason: string;
          created_at: Date;
          released_at: Date | null;
          release_reason: string | null;
        }>(
          `SELECT restriction.id,
                  restriction.kind,
                  restriction.source_type,
                  restriction.source_id,
                  restriction.reason,
                  restriction.created_at,
                  release.created_at AS released_at,
                  release.reason AS release_reason
           FROM client_account_restrictions restriction
           LEFT JOIN client_account_restriction_releases release
             ON release.restriction_id = restriction.id
           WHERE restriction.client_account_id = $1
           ORDER BY restriction.created_at DESC, restriction.id DESC`,
          [params.clientAccountId],
        );
        return {
          warning: LAB_WARNING,
          account: {
            id: account.id,
            name: account.name,
            createdAt: account.created_at.toISOString(),
            restrictedAt: account.restricted_at?.toISOString() ?? null,
          },
          owner: {
            userId: account.owner_user_id,
            email: account.owner_email,
            emailVerifiedAt: account.owner_email_verified_at?.toISOString() ?? null,
            restrictedAt: account.owner_restricted_at?.toISOString() ?? null,
          },
          memberships: memberships.rows.map((membership) => ({
            userId: membership.user_id,
            email: membership.email,
            role: membership.role,
            permissions: stringPermissions(membership.permissions),
            emailVerifiedAt: membership.email_verified_at?.toISOString() ?? null,
            userRestrictedAt: membership.user_restricted_at?.toISOString() ?? null,
            createdAt: membership.created_at.toISOString(),
            removedAt: membership.removed_at?.toISOString() ?? null,
          })),
          restrictions: restrictions.rows.map((restriction) => ({
            id: restriction.id,
            kind: restriction.kind,
            sourceType: restriction.source_type,
            sourceId: restriction.source_id,
            reason: restriction.reason,
            createdAt: restriction.created_at.toISOString(),
            releasedAt: restriction.released_at?.toISOString() ?? null,
            releaseReason: restriction.release_reason,
            active: !restriction.released_at,
          })),
        };
      });
    },
  );

  app.get(
    "/api/v1/admin/client-accounts/:clientAccountId/orders",
    async (request) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "orders.read");
      const params = z.object({ clientAccountId: canonicalUuid }).parse(request.params);
      return withReadSnapshot(pool, async (client) => {
        const account = await loadAccountIdentity(client, params.clientAccountId);
        return {
          warning: LAB_WARNING,
          account,
          items: await listOrders(client, account.id),
        };
      });
    },
  );

  app.get(
    "/api/v1/admin/client-accounts/:clientAccountId/billing",
    async (request) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "billing.read");
      const params = z.object({ clientAccountId: canonicalUuid }).parse(request.params);
      return withReadSnapshot(pool, async (client) => {
        const account = await loadAccountIdentity(client, params.clientAccountId);
        const invoices = await listInvoices(client, account.id);
        const payments = await listPayments(client, account.id);
        const credit = await loadCreditHistory(client, account.id);
        const refunds = await listRefunds(client, account.id);
        const receipts = await client.query<{
          id: string;
          amount_minor: string;
          allocated_minor: string;
          available_minor: string;
          currency: string;
          disposition: string;
          reason: string | null;
          occurred_at: Date;
          capacity_frozen: boolean;
        }>(
          `SELECT receipt.id,
                  receipt.amount_minor::text,
                  receipt.allocated_minor::text,
                  COALESCE(capacity.available_minor, 0)::text AS available_minor,
                  receipt.currency,
                  receipt.disposition,
                  receipt.reason,
                  receipt.occurred_at,
                  COALESCE(capacity.capacity_frozen, false) AS capacity_frozen
           FROM fund_receipts receipt
           LEFT JOIN unclaimed_fund_refund_capacity capacity
             ON capacity.fund_receipt_id = receipt.id
           WHERE receipt.client_account_id = $1
           ORDER BY receipt.occurred_at DESC, receipt.id DESC`,
          [account.id],
        );
        const chargebacks = await client.query<{
          id: string;
          principal_minor: string;
          fee_minor: string;
          external_amount_minor: string;
          credit_recovered_minor: string;
          debt_minor: string;
          currency: string;
          occurred_at: Date;
        }>(
          `SELECT id,
                  principal_minor::text,
                  fee_minor::text,
                  external_amount_minor::text,
                  credit_recovered_minor::text,
                  debt_minor::text,
                  currency,
                  occurred_at
           FROM add_funds_chargeback_effects
           WHERE client_account_id = $1
           ORDER BY occurred_at DESC, id DESC`,
          [account.id],
        );
        const debt = await client.query<{ currency: string; balance_minor: string }>(
          `SELECT debt_account.currency,
                  COALESCE(sum(transaction.debit_minor - transaction.credit_minor), 0)::text
                    AS balance_minor
           FROM client_account_debt_accounts debt_account
           LEFT JOIN client_account_debt_transactions transaction
             ON transaction.debt_account_id = debt_account.id
           WHERE debt_account.client_account_id = $1
             AND debt_account.currency = 'USD'
           GROUP BY debt_account.id`,
          [account.id],
        );
        return {
          warning: LAB_WARNING,
          account,
          invoices,
          payments,
          credit,
          fundReceipts: receipts.rows.map((receipt) => ({
            id: receipt.id,
            amountMinor: receipt.amount_minor,
            allocatedMinor: receipt.allocated_minor,
            availableMinor: receipt.available_minor,
            currency: receipt.currency,
            disposition: receipt.disposition,
            reason: receipt.reason,
            occurredAt: receipt.occurred_at.toISOString(),
            capacityFrozen: receipt.capacity_frozen,
          })),
          refunds,
          chargebacks: chargebacks.rows.map((chargeback) => ({
            id: chargeback.id,
            principalMinor: chargeback.principal_minor,
            feeMinor: chargeback.fee_minor,
            externalAmountMinor: chargeback.external_amount_minor,
            creditRecoveredMinor: chargeback.credit_recovered_minor,
            debtMinor: chargeback.debt_minor,
            currency: chargeback.currency,
            occurredAt: chargeback.occurred_at.toISOString(),
          })),
          debt: debt.rows[0]
            ? { currency: debt.rows[0].currency, balanceMinor: debt.rows[0].balance_minor }
            : { currency: "USD", balanceMinor: "0" },
        };
      });
    },
  );

  app.get(
    "/api/v1/admin/client-accounts/:clientAccountId/services",
    async (request) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "services.read");
      const params = z.object({ clientAccountId: canonicalUuid }).parse(request.params);
      return withReadSnapshot(pool, async (client) => {
        const account = await loadAccountIdentity(client, params.clientAccountId);
        return {
          warning: LAB_WARNING,
          account,
          items: await listServices(client, account.id),
        };
      });
    },
  );

  app.get(
    "/api/v1/admin/client-accounts/:clientAccountId/renewals",
    async (request) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "billing.read");
      const params = z.object({ clientAccountId: canonicalUuid }).parse(request.params);
      return withReadSnapshot(pool, async (client) => {
        const account = await loadAccountIdentity(client, params.clientAccountId);
        return {
          warning: LAB_WARNING,
          account,
          items: await listRenewals(client, account.id),
        };
      });
    },
  );

  app.get(
    "/api/v1/admin/client-accounts/:clientAccountId/cancellations",
    async (request) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "services.read");
      const params = z.object({ clientAccountId: canonicalUuid }).parse(request.params);
      return withReadSnapshot(pool, async (client) => {
        const account = await loadAccountIdentity(client, params.clientAccountId);
        return {
          warning: LAB_WARNING,
          account,
          items: await listCancellations(client, account.id),
        };
      });
    },
  );

  app.get(
    "/api/v1/admin/client-accounts/:clientAccountId/tickets",
    async (request) => {
      const user = await requireUser(request, pool, config);
      await requireStaffPermission(pool, user, "support.tickets.manage");
      const params = z.object({ clientAccountId: canonicalUuid }).parse(request.params);
      return withReadSnapshot(pool, async (client) => {
        const account = await loadAccountIdentity(client, params.clientAccountId);
        const items = await listTickets(client, account.id);
        const internalCounts = await client.query<{
          ticket_id: string;
          internal_count: string;
        }>(
          `SELECT ticket.id AS ticket_id,
                  count(message.id) FILTER (WHERE message.visibility = 'internal')::text
                    AS internal_count
           FROM support_tickets ticket
           LEFT JOIN support_ticket_messages message ON message.ticket_id = ticket.id
           WHERE ticket.client_account_id = $1
           GROUP BY ticket.id`,
          [account.id],
        );
        const counts = new Map(
          internalCounts.rows.map((row) => [row.ticket_id, Number(row.internal_count)]),
        );
        return {
          warning: LAB_WARNING,
          account,
          items: items.map((item) => ({
            ...item,
            internalMessageCount: counts.get(item.id) ?? 0,
          })),
        };
      });
    },
  );
}
