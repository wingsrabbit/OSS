// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api.js";
import type { Locale } from "./CustomerBusinessHistory.js";

type QueueItem = Readonly<{
  requestId: string;
  serviceId: string;
  clientAccountId: string;
  clientAccountName: string;
  productName: string;
  action: "start" | "stop" | "reboot";
  executionMode: "automatic" | "manual";
  expectedServiceVersion: number;
  expectedResourceRevision: number;
  currentServiceVersion: number;
  currentResourceRevision: number;
  status: string;
  detail: string | null;
  createdAt: string;
}>;

type QueueResponse = Readonly<{ warning: string; items: QueueItem[] }>;

function stableCompletionKey(requestId: string): string {
  const key = `opensales:service-operation-queue:v1:${requestId}`;
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = `manual-${requestId}-${crypto.randomUUID()}`;
  window.localStorage.setItem(key, created);
  return created;
}

function clearCompletionKey(requestId: string): void {
  window.localStorage.removeItem(`opensales:service-operation-queue:v1:${requestId}`);
}

export function AdminServiceOperationsQueue({
  active,
  locale,
  onNotice,
  onError,
}: {
  active: boolean;
  locale: Locale;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("Verified manual daily resource operation");
  const [pending, setPending] = useState<string | null>(null);
  const zh = locale === "zh-CN";

  const refresh = useCallback(async () => {
    if (!active) return;
    try {
      const response = await api<QueueResponse>("/api/v1/admin/service-operations?status=unresolved");
      setItems(response.items);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Service operations queue could not be loaded");
    }
  }, [active, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function complete(item: QueueItem): Promise<void> {
    if (pending || item.status !== "manual") return;
    if (!password || reason.trim().length < 10) {
      onError(zh ? "请输入重新认证密码和至少 10 个字符的原因。" : "Enter your reauthentication password and a reason of at least 10 characters.");
      return;
    }
    setPending(item.requestId);
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      await api(`/api/v1/admin/service-operations/${item.requestId}/complete-manual`, {
        method: "POST",
        body: JSON.stringify({
          expectedServiceVersion: item.currentServiceVersion,
          expectedResourceRevision: item.currentResourceRevision,
          reason: reason.trim(),
          idempotencyKey: stableCompletionKey(item.requestId),
        }),
      });
      clearCompletionKey(item.requestId);
      setPassword("");
      await refresh();
      onNotice(zh ? "已记录服务操作的人工完成事实。" : "Manual service operation completion was recorded.");
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        clearCompletionKey(item.requestId);
      }
      onError(error instanceof Error ? error.message : "Manual service operation completion failed");
    } finally {
      setPending(null);
    }
  }

  if (!active) return null;
  return (
    <section className="order-panel" data-testid="admin-service-operations-queue">
      <p className="eyebrow">Staff · services.operations_manage</p>
      <h2>{zh ? "服务操作队列" : "Service operations queue"}</h2>
      <p className="muted">
        {zh ? "此队列独立于 Account360，展示需要 Staff 处理的日常资源操作。" : "This queue is independent of Account360 and exposes daily resource operations that need Staff action."}
      </p>
      <label>
        {zh ? "重新认证密码" : "Reauthentication password"}
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label>
        {zh ? "完成原因" : "Completion reason"}
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button onClick={() => void refresh()}>{zh ? "刷新队列" : "Refresh queue"}</button>
      <div className="manual-list">
        {items.length === 0 && <p className="muted">{zh ? "没有待处理服务操作。" : "No unresolved service operations."}</p>}
        {items.map((item) => (
          <article className="manual-item" data-testid="admin-service-operation-item" key={item.requestId}>
            <strong>{item.productName} · {item.action} · {item.status}</strong>
            <span>{item.clientAccountName} · {item.executionMode}</span>
            <span className="mono">{item.requestId}</span>
            {item.detail && <span>{item.detail}</span>}
            {item.status === "manual" && (
              <button disabled={pending !== null} onClick={() => void complete(item)}>
                {pending === item.requestId
                  ? (zh ? "正在记录…" : "Recording…")
                  : (zh ? "完成人工操作" : "Complete manual operation")}
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
