// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { ApiError, api } from "./api.js";
import type { Locale } from "./CustomerBusinessHistory.js";

type Action = "start" | "stop" | "reboot";

type OperationsResponse = {
  warning: string;
  service: {
    id: string;
    productName: string;
    status: string;
    version: number;
    resourceState: "running" | "stopped" | "terminated" | null;
    resourceRevision: number;
    availableActions: Action[];
  };
  items: Array<{
    requestId: string;
    action: Action;
    actorType?: "user" | "staff";
    executionMode: "automatic" | "manual";
    status: string;
    revision: number;
    resultingResourceState: "running" | "stopped" | null;
    reasonCode: string | null;
    detail?: string | null;
    updatedAt: string;
  }>;
};

const volatileIntentKeys = new Map<string, string>();

function intentStorageKey(endpoint: string, intent: string): string {
  return `opensales:service-operation-intent:v1:${endpoint}:${intent}`;
}

function stableIntentKey(endpoint: string, intent: string): string {
  const storageKey = intentStorageKey(endpoint, intent);
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored) return stored;
    const created = `${intent}-${crypto.randomUUID()}`;
    window.localStorage.setItem(storageKey, created);
    return created;
  } catch {
    const stored = volatileIntentKeys.get(storageKey);
    if (stored) return stored;
    const created = `${intent}-${crypto.randomUUID()}`;
    volatileIntentKeys.set(storageKey, created);
    return created;
  }
}

function clearIntentKey(endpoint: string, intent: string): void {
  const storageKey = intentStorageKey(endpoint, intent);
  volatileIntentKeys.delete(storageKey);
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Memory fallback was already cleared.
  }
}

function isDefinitiveBusinessRejection(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 &&
    ![408, 425, 429].includes(error.status);
}

export function ServiceOperationsPanel({
  endpoint,
  canManage,
  locale,
  staff = false,
  additionalReauthFields,
  onNotice,
  onError,
}: {
  endpoint: string;
  canManage: boolean;
  locale: Locale;
  staff?: boolean;
  additionalReauthFields?: () => Readonly<Record<string, unknown>>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState(
    locale === "zh-CN" ? "已核验的日常资源操作" : "Verified daily resource operation",
  );
  const zh = locale === "zh-CN";
  const actionLabel = (action: Action): string => ({
    start: zh ? "启动" : "Start",
    stop: zh ? "停止" : "Stop",
    reboot: zh ? "重启" : "Reboot",
  })[action];
  const statusLabel = (status: string): string => zh
    ? ({
        queued: "已排队",
        running: "处理中",
        unknown: "结果未知，正在核对",
        manual: "等待人工处理",
        succeeded: "成功",
        failed: "失败",
      } as Record<string, string>)[status] ?? status
    : status.replaceAll("_", " ");
  const stateLabel = (state: string | null): string => zh
    ? ({ running: "运行中", stopped: "已停止", terminated: "已终止" } as Record<string, string>)[state ?? ""] ?? "未知"
    : state ?? "unknown";
  const reasonLabel = (reasonCode: string | null): string | null => {
    if (!reasonCode) return null;
    const labels: Record<string, readonly [string, string]> = {
      in_progress: ["Operation is in progress.", "操作正在进行。"],
      outcome_reconciling: ["The outcome is being reconciled safely.", "正在安全核对操作结果。"],
      staff_action_required: ["Staff action is required.", "需要 Staff 人工处理。"],
      authorization_or_state_changed: ["Authorization or service state changed before dispatch.", "外呼前授权或服务状态已改变。"],
      provider_operation_failed: ["The resource operation failed without changing power state.", "资源操作失败，电源状态未改变。"],
    };
    return labels[reasonCode]?.[zh ? 1 : 0] ?? null;
  };

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      setData(await api<OperationsResponse>(endpoint));
    } catch (caught) {
      onError(
        caught instanceof Error
          ? `${zh ? "无法加载服务操作" : "Service operations could not be loaded"}: ${caught.message}`
          : zh ? "无法加载服务操作" : "Service operations could not be loaded",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [endpoint]);

  async function reauthenticate(): Promise<void> {
    if (!staff) return;
    if (!password) {
      throw new Error(zh ? "Staff 服务操作前请重新输入密码" : "Re-enter your password before a Staff service operation");
    }
    await api("/api/v1/auth/reauth", {
      method: "POST",
      body: JSON.stringify({ password, ...additionalReauthFields?.() }),
    });
  }

  async function run(action: Action): Promise<void> {
    if (!data || pending) return;
    setPending(action);
    const idempotencyKey = stableIntentKey(endpoint, action);
    try {
      await reauthenticate();
      await api(endpoint, {
        method: "POST",
        body: JSON.stringify({
          action,
          expectedServiceVersion: data.service.version,
          expectedResourceRevision: data.service.resourceRevision,
          idempotencyKey,
          ...(staff ? { reason } : {}),
        }),
      });
      clearIntentKey(endpoint, action);
      setPassword("");
      await refresh();
      onNotice(
        zh
          ? `${actionLabel(action)}已持久排队，或已进入 Staff 人工处理。`
          : `${actionLabel(action)} was durably queued or moved to Staff manual fallback.`,
      );
    } catch (caught) {
      if (isDefinitiveBusinessRejection(caught)) clearIntentKey(endpoint, action);
      onError(
        caught instanceof Error
          ? `${zh ? "服务操作失败" : "Service operation failed"}: ${caught.message}`
          : zh ? "服务操作失败" : "Service operation failed",
      );
    } finally {
      setPending(null);
    }
  }

  async function completeManual(requestId: string): Promise<void> {
    if (!data || pending) return;
    setPending(requestId);
    const intent = `manual-${requestId}`;
    const idempotencyKey = stableIntentKey(endpoint, intent);
    try {
      await reauthenticate();
      await api(`/api/v1/admin/service-operations/${requestId}/complete-manual`, {
        method: "POST",
        body: JSON.stringify({
          expectedServiceVersion: data.service.version,
          expectedResourceRevision: data.service.resourceRevision,
          reason,
          idempotencyKey,
        }),
      });
      clearIntentKey(endpoint, intent);
      setPassword("");
      await refresh();
      onNotice(zh ? "已记录服务操作的人工完成事实。" : "Manual service operation completion was recorded.");
    } catch (caught) {
      if (isDefinitiveBusinessRejection(caught)) clearIntentKey(endpoint, intent);
      onError(
        caught instanceof Error
          ? `${zh ? "人工完成失败" : "Manual completion failed"}: ${caught.message}`
          : zh ? "人工完成失败" : "Manual completion failed",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="service-operations" data-testid={staff ? "staff-service-operations" : "customer-service-operations"}>
      <div className="history-heading">
        <div>
          <h4>{zh ? "日常资源操作" : "Daily resource operations"}</h4>
          <p className="muted">
            {zh
              ? "电源状态独立于计费暂停、取消和终止。"
              : "Power state is independent from billing suspension, cancellation and termination."}
          </p>
        </div>
        <button disabled={loading} onClick={() => void refresh()}>
          {loading ? (zh ? "刷新中…" : "Refreshing…") : (zh ? "刷新" : "Refresh")}
        </button>
      </div>
      {data && (
        <>
          <p>
            {zh ? "资源" : "Resource"} <strong>{stateLabel(data.service.resourceState)}</strong>
            {zh
              ? ` · 修订 ${data.service.resourceRevision} · 商业状态 ${statusLabel(data.service.status)}`
              : ` · revision ${data.service.resourceRevision} · commercial ${statusLabel(data.service.status)}`}
          </p>
          {staff && canManage && (
            <div className="manual-fields">
              <label>
                {zh ? "Staff 操作原因" : "Staff reason"}
                <input value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} />
              </label>
              <label>
                {zh ? "密码确认" : "Password confirmation"}
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
              </label>
            </div>
          )}
          {canManage && (
            <div className="workspace-actions" data-testid="service-operation-actions">
              {data.service.availableActions.map((action) => (
                <button key={action} disabled={pending !== null} onClick={() => void run(action)}>
                  {pending === action ? `${actionLabel(action)}…` : actionLabel(action)}
                </button>
              ))}
            </div>
          )}
          <div className="manual-list" data-testid="service-operation-timeline">
            {data.items.length === 0 && <p className="muted">{zh ? "尚无日常操作事实。" : "No daily operation facts yet."}</p>}
            {data.items.map((item) => (
              <div className="manual-item" key={item.requestId}>
                <strong>
                  {actionLabel(item.action)} · {statusLabel(item.status)} · {item.executionMode === "automatic" ? (zh ? "自动" : "automatic") : (zh ? "人工" : "manual")}
                </strong>
                <span>
                  {item.resultingResourceState ? stateLabel(item.resultingResourceState) : (zh ? "状态未变更" : "no state change")}
                  {` · ${new Date(item.updatedAt).toLocaleString(locale)}`}
                </span>
                {staff && item.detail
                  ? <span>{item.detail}</span>
                  : reasonLabel(item.reasonCode) && <span>{reasonLabel(item.reasonCode)}</span>}
                <span className="mono">{item.requestId}</span>
                {staff && canManage && item.status === "manual" && (
                  <button disabled={pending !== null} onClick={() => void completeManual(item.requestId)}>
                    {zh ? "记录人工完成" : "Record manual completion"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
