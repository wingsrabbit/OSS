// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";

type Locale = "en" | "zh-CN";
type Delivery = Readonly<{
  source: "standard" | "identity";
  operationId: string;
  outboxId: string;
  attemptNumber: number;
  eventType: string;
  templateRevision: string | null;
  category: string;
  recipientKind: string;
  recipient: string;
  locale: Locale;
  operationStatus: string;
  operationAttempts: number;
  operationLastError: string | null;
  operationCreatedAt: string;
  operationUpdatedAt: string;
  outcomeStatus: string | null;
  outcomeReason: string | null;
  outcomeRecordedAt: string | null;
  jobId: string | null;
  jobStatus: string | null;
  jobLastError: string | null;
  jobAvailableAt: string | null;
  jobUpdatedAt: string | null;
  isLatest: boolean;
  retryable: boolean;
  retryReason: string;
}>;

type Snapshot = Readonly<{
  summary: Readonly<{
    attentionCount: number;
    failedCount: number;
    unknownCount: number;
    manualCount: number;
    retryableCount: number;
    oldestTask: Readonly<{
      id: string;
      jobType: string;
      status: string;
      availableAt: string;
      createdAt: string;
      updatedAt: string;
    }> | null;
  }>;
  queue: Delivery[];
  history: Delivery[];
  retryAudit: Array<Readonly<{
    id: string;
    actorId: string;
    outboxId: string;
    reason: string | null;
    createdAt: string;
  }>>;
}>;

const emptySnapshot: Snapshot = {
  summary: {
    attentionCount: 0,
    failedCount: 0,
    unknownCount: 0,
    manualCount: 0,
    retryableCount: 0,
    oldestTask: null,
  },
  queue: [],
  history: [],
  retryAudit: [],
};

type AccessScopeToken = Readonly<{
  key: string;
  generation: number;
}>;

type AccessScopeState = {
  key: string;
  generation: number;
  mounted: boolean;
};

function dateTime(value: string | null, locale: Locale): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US");
}

function deliveryLabel(delivery: Delivery): string {
  return `${delivery.eventType} · ${delivery.recipient} · #${delivery.attemptNumber}`;
}

export function NotificationOperationsPanel({
  active,
  locale,
  canRead,
  canRetry,
  accessFingerprint,
  onNotice,
  onError,
}: Readonly<{
  active: boolean;
  locale: Locale;
  canRead: boolean;
  canRetry: boolean;
  accessFingerprint: string;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}>) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const [pendingOutboxId, setPendingOutboxId] = useState<string | null>(null);

  const scopeKey = JSON.stringify([accessFingerprint, active, canRead, canRetry]);
  const accessScope = useRef<AccessScopeState>({
    key: scopeKey,
    generation: 0,
    mounted: false,
  });
  if (accessScope.current.key !== scopeKey) {
    accessScope.current = {
      key: scopeKey,
      generation: accessScope.current.generation + 1,
      mounted: accessScope.current.mounted,
    };
  }

  const captureScope = useCallback(
    (): AccessScopeToken => ({
      key: accessScope.current.key,
      generation: accessScope.current.generation,
    }),
    [],
  );
  const scopeIsCurrent = useCallback(
    (scope: AccessScopeToken): boolean =>
      accessScope.current.mounted &&
      accessScope.current.key === scope.key &&
      accessScope.current.generation === scope.generation,
    [],
  );

  useLayoutEffect(() => {
    accessScope.current.mounted = true;
    setSnapshot(emptySnapshot);
    setPassword("");
    setReason("");
    setPendingOutboxId(null);
    return () => {
      accessScope.current = {
        key: accessScope.current.key,
        generation: accessScope.current.generation + 1,
        mounted: false,
      };
    };
  }, [scopeKey]);

  const refresh = useCallback(async (scope: AccessScopeToken): Promise<boolean> => {
    if (!scopeIsCurrent(scope) || !active || !canRead) return false;
    let nextSnapshot: Snapshot;
    try {
      nextSnapshot = await api<Snapshot>("/api/v1/admin/notification-operations");
    } catch (caught) {
      if (!scopeIsCurrent(scope)) return false;
      throw caught;
    }
    if (!scopeIsCurrent(scope)) return false;
    setSnapshot(nextSnapshot);
    return true;
  }, [active, canRead, scopeIsCurrent]);

  useEffect(() => {
    const scope = captureScope();
    if (!active || !canRead || !scopeIsCurrent(scope)) return;
    void refresh(scope).catch((caught: unknown) => {
      if (!scopeIsCurrent(scope)) return;
      onError(caught instanceof Error ? caught.message : "Notification Operations is unavailable");
    });
  }, [active, canRead, captureScope, onError, refresh, scopeIsCurrent, scopeKey]);

  const templates = useMemo(
    () =>
      [...new Map(
        snapshot.history.map((delivery) => [
          `${delivery.source}:${delivery.eventType}:${delivery.templateRevision ?? "identity-workflow"}`,
          {
            source: delivery.source,
            eventType: delivery.eventType,
            templateRevision: delivery.templateRevision,
          },
        ]),
      ).values()],
    [snapshot.history],
  );

  async function retry(delivery: Delivery): Promise<void> {
    const scope = captureScope();
    if (
      !scopeIsCurrent(scope) ||
      !active ||
      !canRead ||
      !canRetry ||
      !delivery.retryable ||
      !delivery.jobUpdatedAt ||
      password.length === 0 ||
      reason.trim().length < 3 ||
      pendingOutboxId
    ) return;
    const submittedPassword = password;
    const submittedReason = reason.trim();
    setPendingOutboxId(delivery.outboxId);
    try {
      try {
        await api("/api/v1/auth/reauth", {
          method: "POST",
          body: JSON.stringify({ password: submittedPassword }),
        });
      } catch (caught) {
        if (!scopeIsCurrent(scope)) return;
        throw caught;
      }
      if (!scopeIsCurrent(scope)) return;
      try {
        await api(`/api/v1/admin/notification-operations/${delivery.outboxId}/retry`, {
          method: "POST",
          body: JSON.stringify({
            reason: submittedReason,
            expectedJobUpdatedAt: delivery.jobUpdatedAt,
          }),
        });
      } catch (caught) {
        if (!scopeIsCurrent(scope)) return;
        throw caught;
      }
      if (!scopeIsCurrent(scope)) return;
      setPassword("");
      setReason("");
      setPendingOutboxId(null);
      onNotice(
        locale === "zh-CN"
          ? "通知重试事实已提交；Worker 将追加一个新的投递 attempt。"
          : "Notification retry committed; the Worker will append one new delivery attempt.",
      );
      try {
        const refreshed = await refresh(scope);
        if (!refreshed || !scopeIsCurrent(scope)) return;
      } catch (caught) {
        if (!scopeIsCurrent(scope)) return;
        const detail = caught instanceof Error ? caught.message : "Notification Operations is unavailable";
        onError(
          locale === "zh-CN"
            ? `重试已提交，但队列刷新失败：${detail}`
            : `Retry committed, but the queue refresh failed: ${detail}`,
        );
        return;
      }
    } catch (caught) {
      if (!scopeIsCurrent(scope)) return;
      onError(caught instanceof Error ? caught.message : "Notification retry failed");
    } finally {
      if (scopeIsCurrent(scope)) setPendingOutboxId(null);
    }
  }

  if (!active || !canRead) return null;
  const zh = locale === "zh-CN";
  return (
    <section
      className="order-panel notification-operations"
      aria-label={zh ? "通知运营" : "Notification Operations"}
      data-testid="notification-operations"
    >
      <div>
        <p className="eyebrow">{zh ? "Staff 通知运营" : "Staff Notification Operations"}</p>
        <h2>{zh ? "投递队列、attempt 与恢复事实" : "Delivery queue, attempts and recovery facts"}</h2>
        <p>
          {zh
            ? "unknown 只做稳定 Provider operation 对账；只有带失败事实且仍有预算的 manual task 才能人工发起一次重试。"
            : "Unknown results reconcile the stable Provider operation. Staff can retry only a manual task with an explicit failed fact and remaining attempt budget."}
        </p>
      </div>

      <div className="journey" data-testid="notification-summary">
        <span>{zh ? "需关注" : "Attention"}: {snapshot.summary.attentionCount}</span>
        <span>{zh ? "失败" : "Failed"}: {snapshot.summary.failedCount}</span>
        <span>{zh ? "未知" : "Unknown"}: {snapshot.summary.unknownCount}</span>
        <span>{zh ? "人工" : "Manual"}: {snapshot.summary.manualCount}</span>
        <span>{zh ? "可重试" : "Retryable"}: {snapshot.summary.retryableCount}</span>
      </div>

      <div data-testid="notification-oldest-task">
        <h3>{zh ? "最老通知任务" : "Oldest notification task"}</h3>
        {snapshot.summary.oldestTask ? (
          <p>
            <span className="mono">{snapshot.summary.oldestTask.id}</span>{" · "}
            {snapshot.summary.oldestTask.jobType}{" · "}
            {snapshot.summary.oldestTask.status}{" · "}
            {dateTime(snapshot.summary.oldestTask.availableAt, locale)}
          </p>
        ) : (
          <p className="muted">{zh ? "没有 pending、running 或 manual 通知任务。" : "No pending, running or manual notification task."}</p>
        )}
      </div>

      {canRetry && (
        <div className="inline-form" data-testid="notification-retry-controls">
          <label>
            {zh ? "当前密码确认" : "Current password confirmation"}
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label>
            {zh ? "重试原因" : "Retry reason"}
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1_000}
            />
          </label>
        </div>
      )}

      <div data-testid="notification-attention-queue">
        <h3>{zh ? "失败 / unknown / manual 队列" : "Failed / unknown / manual queue"}</h3>
        {snapshot.queue.length === 0 ? (
          <p className="muted">{zh ? "当前没有需人工关注的投递。" : "No delivery currently needs Staff attention."}</p>
        ) : (
          snapshot.queue.map((delivery) => (
            <article className="manual-item" key={`${delivery.source}:${delivery.operationId}`}>
              <strong>{deliveryLabel(delivery)}</strong>
              <span>{delivery.source} · {delivery.category} · {delivery.locale}</span>
              <span>
                {zh ? "operation" : "operation"}: {delivery.operationStatus}{" · "}
                {zh ? "outcome" : "outcome"}: {delivery.outcomeStatus ?? "—"}{" · "}
                {zh ? "task" : "task"}: {delivery.jobStatus ?? "—"}
              </span>
              <span>
                {zh ? "模板版本" : "Template revision"}: {delivery.templateRevision ?? (zh ? "身份工作流" : "identity workflow")}
              </span>
              {(delivery.operationLastError || delivery.outcomeReason || delivery.jobLastError) && (
                <span className="muted">
                  {delivery.outcomeReason ?? delivery.operationLastError ?? delivery.jobLastError}
                </span>
              )}
              <span className="muted">{delivery.retryReason}</span>
              {canRetry && delivery.retryable && (
                <button
                  type="button"
                  disabled={
                    pendingOutboxId !== null || password.length === 0 || reason.trim().length < 3
                  }
                  onClick={() => void retry(delivery)}
                >
                  {pendingOutboxId === delivery.outboxId
                    ? (zh ? "提交中…" : "Committing…")
                    : (zh ? "受控单次重试" : "Controlled single retry")}
                </button>
              )}
            </article>
          ))
        )}
      </div>

      <details data-testid="notification-template-history">
        <summary>{zh ? "已使用的模板版本" : "Observed template revisions"}</summary>
        {templates.length === 0 ? (
          <p className="muted">{zh ? "尚无投递模板历史。" : "No delivery template history yet."}</p>
        ) : (
          templates.map((template) => (
            <p key={`${template.source}:${template.eventType}:${template.templateRevision ?? "identity"}`}>
              {template.eventType}{" · "}
              {template.templateRevision ?? (zh ? "身份工作流（无模板注册表）" : "identity workflow (no template registry)")}
            </p>
          ))
        )}
      </details>

      <details data-testid="notification-attempt-history">
        <summary>{zh ? "不可变投递 attempt 历史" : "Immutable delivery attempt history"}</summary>
        {snapshot.history.map((delivery) => (
          <p key={`${delivery.source}:${delivery.operationId}`}>
            <span className="mono">{delivery.operationId}</span>{" · "}
            {deliveryLabel(delivery)}{" · "}
            {delivery.operationStatus}/{delivery.outcomeStatus ?? "—"}{" · "}
            {dateTime(delivery.operationCreatedAt, locale)}
          </p>
        ))}
      </details>

      <details data-testid="notification-retry-audit">
        <summary>{zh ? "人工重试审计历史" : "Staff retry audit history"}</summary>
        {snapshot.retryAudit.length === 0 ? (
          <p className="muted">{zh ? "尚无人工重试事实。" : "No Staff retry fact yet."}</p>
        ) : (
          snapshot.retryAudit.map((audit) => (
            <p key={audit.id}>
              <span className="mono">{audit.outboxId}</span>{" · "}
              {audit.reason ?? "—"}{" · "}
              {dateTime(audit.createdAt, locale)}
            </p>
          ))
        )}
      </details>
    </section>
  );
}
