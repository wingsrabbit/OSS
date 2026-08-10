// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api.js";

export type MembershipRole = "owner" | "billing" | "technical" | "viewer";

export type AccountContextItem = {
  clientAccountId: string;
  name: string;
  role: MembershipRole;
  permissions: string[];
  capabilities: string[];
  restrictions: { membership: boolean; clientAccount: boolean };
};

type AccountContextsResponse = {
  activeClientAccountId: string | null;
  accountContextVersion: string;
  items: AccountContextItem[];
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
};

function customerSurfaceIsActive(): boolean {
  return (window.location.pathname.replace(/\/+$/, "") || "/") === "/customer";
}

export function AccountContextSwitcher({
  active,
  viewerId,
  activeClientAccountId,
  activeContext,
  accountContextVersion,
  locale,
  onSwitched,
  onError,
}: {
  active: boolean;
  viewerId: string;
  activeClientAccountId: string | null;
  activeContext: AccountContextItem | null;
  accountContextVersion: string;
  locale: "en" | "zh-CN";
  onSwitched: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [contexts, setContexts] = useState<AccountContextItem[]>([]);
  const [selectedId, setSelectedId] = useState(activeClientAccountId ?? "");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const onErrorRef = useRef(onError);
  const localeRef = useRef(locale);
  const activeContextRef = useRef(activeContext);
  onErrorRef.current = onError;
  localeRef.current = locale;
  activeContextRef.current = activeContext;

  const loadContexts = useCallback(async (cursor: string | null = null) => {
    if (!active || !customerSurfaceIsActive()) return;
    const generation = ++requestGeneration.current;
    if (cursor === null) setLoading(true);
    else setLoadingMore(true);
    try {
      const query = new URLSearchParams({ limit: "25" });
      if (cursor !== null) query.set("cursor", cursor);
      const result = await api<AccountContextsResponse>(`/api/v1/auth/account-contexts?${query.toString()}`);
      if (generation !== requestGeneration.current || !customerSurfaceIsActive()) return;
      setContexts((current) => {
        const merged = cursor === null ? [] : current;
        const byId = new Map(merged.map((context) => [context.clientAccountId, context]));
        for (const context of result.items) byId.set(context.clientAccountId, context);
        const pinnedActive = activeContextRef.current;
        if (
          cursor === null &&
          pinnedActive &&
          pinnedActive.clientAccountId === result.activeClientAccountId
        ) {
          byId.set(pinnedActive.clientAccountId, pinnedActive);
        }
        return [...byId.values()];
      });
      if (cursor === null) setSelectedId(result.activeClientAccountId ?? "");
      setHasMore(result.hasMore);
      setNextCursor(result.nextCursor);
    } catch (caught) {
      if (generation !== requestGeneration.current || !customerSurfaceIsActive()) return;
      if (cursor === null || (caught instanceof ApiError && caught.status === 403)) {
        setContexts([]);
        setHasMore(false);
        setNextCursor(null);
      }
      onErrorRef.current(
        caught instanceof Error
          ? caught.message
          : localeRef.current === "zh-CN" ? "无法加载客户账户上下文" : "Client Account contexts could not be loaded",
      );
    } finally {
      if (generation === requestGeneration.current && customerSurfaceIsActive()) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [active, viewerId]);

  useEffect(() => {
    requestGeneration.current += 1;
    setContexts([]);
    setHasMore(false);
    setNextCursor(null);
    setSelectedId(activeClientAccountId ?? "");
    setSwitching(false);
    void loadContexts(null);
    return () => {
      requestGeneration.current += 1;
    };
  }, [accountContextVersion, activeClientAccountId, loadContexts, viewerId]);

  async function switchContext() {
    if (
      switching ||
      selectedId.length === 0 ||
      selectedId === activeClientAccountId ||
      !customerSurfaceIsActive()
    ) return;
    const generation = ++requestGeneration.current;
    setSwitching(true);
    try {
      await api("/api/v1/auth/account-context", {
        method: "PUT",
        body: JSON.stringify({ clientAccountId: selectedId }),
      });
      if (generation !== requestGeneration.current || !customerSurfaceIsActive()) return;
      setContexts([]);
      await onSwitched();
    } catch (caught) {
      if (generation !== requestGeneration.current || !customerSurfaceIsActive()) return;
      onErrorRef.current(
        caught instanceof Error
          ? caught.message
          : localeRef.current === "zh-CN" ? "无法切换客户账户上下文" : "Client Account context could not be switched",
      );
    } finally {
      if (generation === requestGeneration.current && customerSurfaceIsActive()) setSwitching(false);
    }
  }

  if (!active || !customerSurfaceIsActive()) return null;

  return (
    <section className="account-context-switcher" aria-label="Active Client Account" data-testid="account-context-switcher">
      <div>
        <p className="eyebrow">{locale === "zh-CN" ? "客户账户上下文" : "Client Account context"}</p>
        <h2>{locale === "zh-CN" ? "选择当前客户账户" : "Choose the active Client Account"}</h2>
        <p>
          {locale === "zh-CN"
            ? "订单、账单、服务与客户管理操作只会作用于这里明确选择的账户。"
            : "Orders, billing, services and customer administration apply only to the explicitly selected account."}
        </p>
      </div>
      {loading ? (
        <p className="muted">{locale === "zh-CN" ? "正在加载账户…" : "Loading account contexts…"}</p>
      ) : contexts.length === 0 ? (
        <p className="notice" data-testid="account-context-empty">
          {locale === "zh-CN" ? "当前用户没有可选择的客户账户成员关系。" : "This user has no selectable Client Account membership."}
        </p>
      ) : (
        <div className="inline-form">
          <label>
            {locale === "zh-CN" ? "当前客户账户" : "Active Client Account"}
            <select
              aria-label="Active Client Account"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">{locale === "zh-CN" ? "请选择…" : "Select an account…"}</option>
              {contexts.map((context) => (
                <option
                  disabled={context.restrictions.membership}
                  key={context.clientAccountId}
                  value={context.clientAccountId}
                >
                  {context.name} · {context.role}
                  {context.restrictions.membership
                    ? locale === "zh-CN" ? " · 成员受限" : " · membership restricted"
                    : context.restrictions.clientAccount
                      ? locale === "zh-CN" ? " · 账户只读" : " · account read-only"
                      : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            disabled={switching || selectedId.length === 0 || selectedId === activeClientAccountId}
            onClick={() => void switchContext()}
          >
            {switching
              ? locale === "zh-CN" ? "切换中…" : "Switching…"
              : locale === "zh-CN" ? "切换账户" : "Switch account"}
          </button>
          <button disabled={loading || loadingMore || switching} onClick={() => void loadContexts(null)}>
            {locale === "zh-CN" ? "刷新列表" : "Refresh list"}
          </button>
          {hasMore && nextCursor && (
            <button disabled={loadingMore || switching} onClick={() => void loadContexts(nextCursor)}>
              {loadingMore
                ? locale === "zh-CN" ? "加载中…" : "Loading more…"
                : locale === "zh-CN" ? "加载更多账户" : "Load more accounts"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
