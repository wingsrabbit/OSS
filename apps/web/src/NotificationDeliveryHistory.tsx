// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export type NotificationDeliverySummary = {
  id: string;
  attemptNumber: number;
  eventType: string;
  templateRevision: string;
  category: string;
  recipientKind: string;
  recipient: string;
  locale: string;
  status: string;
  operationState: string;
  outcomeStatus: string | null;
  reason: string | null;
  requiresAttention: boolean;
  attempts: number;
  dispatchStartedAt: string | null;
  lastCheckedAt: string | null;
  providerOccurredAt: string | null;
  recordedAt: string | null;
  createdAt: string;
};

type NotificationDeliveryPage = {
  warning: string;
  account: { id: string; name: string };
  items: NotificationDeliverySummary[];
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
};

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function displayCode(value: string | null): string {
  return value?.replaceAll("_", " ") ?? "pending";
}

function maskedRecipient(value: string): string {
  return /^.\*{3}@[^@\s]+$/.test(value) ? value : "masked recipient unavailable";
}

export function NotificationDeliveryHistory({
  active,
  endpoint,
  accountId,
  scopeKey,
  refreshKey,
  locale,
  variant,
  onError,
}: {
  active: boolean;
  endpoint: string;
  accountId: string;
  scopeKey: string;
  refreshKey: string | number;
  locale: "en" | "zh-CN";
  variant: "customer" | "admin";
  onError: (message: string) => void;
}) {
  const [page, setPage] = useState<NotificationDeliveryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    if (!active) return;
    const requestGeneration = ++generation.current;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setPage(null);
    }
    try {
      // The cursor is an opaque, signed server value. Keeping it byte-for-byte
      // avoids rounding PostgreSQL microseconds in JavaScript dates.
      const query = `limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const result = await api<NotificationDeliveryPage>(`${endpoint}?${query}`);
      if (requestGeneration !== generation.current) return;
      if (result.account.id !== accountId) {
        throw new Error("Notification delivery history returned a different Client Account");
      }
      setPage((current) => {
        if (!append || !current) return result;
        const items = new Map(current.items.map((item) => [item.id, item]));
        for (const item of result.items) items.set(item.id, item);
        return { ...result, items: [...items.values()] };
      });
    } catch (caught) {
      if (requestGeneration !== generation.current) return;
      onError(
        caught instanceof Error
          ? caught.message
          : locale === "zh-CN"
            ? "无法加载通知投递历史"
            : "Notification delivery history could not be loaded",
      );
    } finally {
      if (requestGeneration === generation.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [accountId, active, endpoint, locale, onError]);

  useEffect(() => {
    generation.current += 1;
    setPage(null);
    setLoading(false);
    setLoadingMore(false);
    if (active) void load(null, false);
    return () => {
      generation.current += 1;
    };
  }, [active, load, refreshKey, scopeKey]);

  if (!active) return null;

  const title = locale === "zh-CN" ? "通知投递历史" : "Notification delivery history";
  const content = (
    <>
      <div className="history-heading">
        <div>
          <p className="eyebrow">
            {variant === "customer" ? "Customer account" : "Staff · selected Client Account"}
            {" · delivery facts"}
          </p>
          <h3>{title}</h3>
          <p>
            {locale === "zh-CN"
              ? "仅显示已脱敏的收件人、尝试、状态、结果、原因和时间；消息正文与 Provider 标识不会显示。"
              : "Only masked recipients, attempts, states, outcomes, reasons and times are shown. Message bodies and Provider identifiers are never exposed."}
          </p>
        </div>
        <button disabled={loading || loadingMore} onClick={() => void load(null, false)}>
          {loading ? (locale === "zh-CN" ? "正在刷新…" : "Refreshing…") : (locale === "zh-CN" ? "刷新" : "Refresh")}
        </button>
      </div>

      {loading && !page && <p className="muted">{locale === "zh-CN" ? "正在加载投递事实…" : "Loading delivery facts…"}</p>}
      {page && page.items.length === 0 && (
        <p className="muted">{locale === "zh-CN" ? "尚无通知投递事实。" : "No notification delivery facts yet."}</p>
      )}
      {page && page.items.length > 0 && (
        <div className="manual-list" data-testid={`${variant}-notification-deliveries`}>
          {page.items.map((item) => (
            <article className="manual-item" data-testid="notification-delivery" key={item.id}>
              <strong>
                {item.eventType.replaceAll("notification.", "")} · {item.category} · {maskedRecipient(item.recipient)}
              </strong>
              <span>
                {item.recipientKind} · attempt {item.attemptNumber} · operation {displayCode(item.operationState)} · outcome {displayCode(item.outcomeStatus)}
              </span>
              <span>
                delivery {displayCode(item.status)} · Provider checks {item.attempts}
                {item.requiresAttention ? " · attention required" : ""}
                {item.reason ? ` · ${displayCode(item.reason)}` : ""}
              </span>
              <span>
                created {when(item.createdAt)} · dispatch {when(item.dispatchStartedAt)} · last checked {when(item.lastCheckedAt)}
              </span>
              <span>
                Provider outcome {when(item.providerOccurredAt)} · recorded {when(item.recordedAt)}
              </span>
            </article>
          ))}
        </div>
      )}
      {page?.hasMore && (
        <button
          data-testid={`${variant}-notification-deliveries-load-more`}
          disabled={loadingMore || page.nextCursor === null}
          onClick={() => page.nextCursor && void load(page.nextCursor, true)}
        >
          {loadingMore
            ? locale === "zh-CN" ? "正在加载更多…" : "Loading more…"
            : locale === "zh-CN" ? "加载更多投递事实" : "Load more delivery facts"}
        </button>
      )}
    </>
  );

  return variant === "admin" ? (
    <section className="account360-panel" aria-label={title} data-testid="admin-notification-history">
      {content}
    </section>
  ) : (
    <section className="order-panel business-history" aria-label={title} data-testid="customer-notification-history">
      {content}
    </section>
  );
}
