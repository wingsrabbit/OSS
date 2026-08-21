// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 50;

const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());

const pageQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_LIMIT)
      .default(DEFAULT_PAGE_LIMIT),
    cursor: z.string().min(1).max(4_096).optional(),
  })
  .strict();

const initialPageQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_LIMIT)
      .default(DEFAULT_PAGE_LIMIT),
  })
  .strict();

const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().min(1).max(100),
    clientAccountId: canonicalUuid,
    at: z.iso.datetime({ offset: true }),
    id: canonicalUuid,
    rank: z.number().int().min(0).max(1).optional(),
  })
  .strict();

export type PageQuery = z.infer<typeof pageQuerySchema>;

export type KeysetPosition = {
  at: string;
  id: string;
  rank?: number;
};

export type CollectionPage<T> = {
  items: T[];
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
};

function requestError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function parsePageQuery(value: unknown): PageQuery {
  return pageQuerySchema.parse(value);
}

export function parseInitialPageQuery(value: unknown): PageQuery {
  return initialPageQuerySchema.parse(value);
}

export function decodeKeysetCursor(
  cursor: string | undefined,
  scope: string,
  clientAccountId: string,
  ranked = false,
): KeysetPosition | null {
  if (!cursor) return null;
  try {
    const decoded = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (
      decoded.scope !== scope ||
      decoded.clientAccountId !== clientAccountId.toLowerCase() ||
      (ranked ? decoded.rank === undefined : decoded.rank !== undefined)
    ) {
      throw requestError("Pagination cursor does not match this account and facet");
    }
    return {
      at: decoded.at,
      id: decoded.id,
      ...(decoded.rank === undefined ? {} : { rank: decoded.rank }),
    };
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error;
    throw requestError("Invalid pagination cursor");
  }
}

export function collectionPage<T>(
  values: T[],
  limit: number,
  scope: string,
  clientAccountId: string,
  position: (value: T) => KeysetPosition,
): CollectionPage<T> {
  const hasMore = values.length > limit;
  const items = values.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    limit,
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              scope,
              clientAccountId: clientAccountId.toLowerCase(),
              ...position(last),
            }),
            "utf8",
          ).toString("base64url")
        : null,
  };
}
