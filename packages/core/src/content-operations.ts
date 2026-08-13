// SPDX-License-Identifier: AGPL-3.0-or-later

export const CONTENT_LOCALES = ["en", "zh-CN"] as const;
export type ContentLocale = (typeof CONTENT_LOCALES)[number];

export const CONTENT_KINDS = [
  "announcement",
  "knowledge_base",
  "network_status",
] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const CONTENT_STATUS_LEVELS = [
  "information",
  "operational",
  "maintenance",
  "degraded",
  "resolved",
] as const;
export type ContentStatusLevel = (typeof CONTENT_STATUS_LEVELS)[number];

export type LocalizedCurrentRevision = Readonly<{
  locale: ContentLocale;
}>;

export function contentLocale(value: unknown): ContentLocale {
  return value === "zh-CN" ? "zh-CN" : "en";
}

/**
 * Resolve one current revision per stable identity. A requested zh-CN
 * revision wins; English is the deterministic fallback. English requests
 * never fall through to another locale.
 */
export function resolveLocalizedCurrent<T extends LocalizedCurrentRevision>(
  requestedLocale: ContentLocale,
  candidates: readonly T[],
): T | null {
  const requested = candidates.find((candidate) => candidate.locale === requestedLocale);
  if (requested) return requested;
  if (requestedLocale === "zh-CN") {
    return candidates.find((candidate) => candidate.locale === "en") ?? null;
  }
  return null;
}
