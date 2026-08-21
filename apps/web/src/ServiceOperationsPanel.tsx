// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

type PasswordChangesResponse = {
  warning: string;
  service: {
    id: string;
    productName: string;
    status: string;
    version: number;
    resourceRevision: number;
    canChangePassword: boolean;
  };
  items: Array<{
    requestId: string;
    action: "change_password";
    actorType?: "user" | "staff";
    status: string;
    revision: number;
    detail?: string | null;
    updatedAt: string;
  }>;
};

const volatileIntentKeys = new Map<string, string>();

function intentStorageKey(scopeKey: string, endpoint: string, intent: string): string {
  return `opensales:service-operation-intent:v2:${scopeKey}:${endpoint}:${intent}`;
}

function stableIntentKey(scopeKey: string, endpoint: string, intent: string): string {
  const storageKey = intentStorageKey(scopeKey, endpoint, intent);
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

function clearIntentKey(scopeKey: string, endpoint: string, intent: string, expectedKey: string): void {
  const storageKey = intentStorageKey(scopeKey, endpoint, intent);
  if (volatileIntentKeys.get(storageKey) === expectedKey) {
    volatileIntentKeys.delete(storageKey);
  }
  try {
    if (window.localStorage.getItem(storageKey) === expectedKey) {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // The matching memory fallback was already cleared.
  }
}

function isDefinitiveBusinessRejection(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 &&
    ![408, 425, 429].includes(error.status);
}

type AccessScopeToken = Readonly<{
  key: string;
  generation: number;
}>;

type AccessScopeState = {
  key: string;
  generation: number;
  mounted: boolean;
};

type ActiveIntent = {
  scope: AccessScopeToken;
  endpoint: string;
  intent: string;
  idempotencyKey: string;
  mutationDispatched: boolean;
};

export function ServiceOperationsPanel({
  endpoint,
  canManage,
  locale,
  staff = false,
  accessFingerprint,
  onNotice,
  onError,
}: {
  endpoint: string;
  canManage: boolean;
  locale: Locale;
  staff?: boolean;
  accessFingerprint: string;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [passwordChanges, setPasswordChanges] = useState<PasswordChangesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [factorCode, setFactorCode] = useState("");
  const [newServicePassword, setNewServicePassword] = useState("");
  const [confirmServicePassword, setConfirmServicePassword] = useState("");
  const zh = locale === "zh-CN";
  const defaultReason = zh ? "已核验的日常资源操作" : "Verified daily resource operation";
  const [reason, setReason] = useState(defaultReason);
  const passwordChangeEndpoint = endpoint.replace(/\/operations$/, "/password-changes");
  const scopeKey = JSON.stringify([accessFingerprint, endpoint, canManage, staff]);
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
  const activeIntent = useRef<ActiveIntent | null>(null);
  const refreshGeneration = useRef(0);
  const onNoticeRef = useRef(onNotice);
  const onErrorRef = useRef(onError);
  onNoticeRef.current = onNotice;
  onErrorRef.current = onError;

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

  const refresh = useCallback(async (scope: AccessScopeToken): Promise<boolean> => {
    if (scope.key !== scopeKey || !scopeIsCurrent(scope)) return false;
    const requestGeneration = ++refreshGeneration.current;
    setLoading(true);
    try {
      const [operations, changes] = await Promise.all([
        api<OperationsResponse>(endpoint),
        api<PasswordChangesResponse>(passwordChangeEndpoint),
      ]);
      if (!scopeIsCurrent(scope) || refreshGeneration.current !== requestGeneration) return false;
      setData(operations);
      setPasswordChanges(changes);
      return true;
    } catch (caught) {
      if (!scopeIsCurrent(scope) || refreshGeneration.current !== requestGeneration) return false;
      onErrorRef.current(
        caught instanceof Error
          ? `${zh ? "无法加载服务操作" : "Service operations could not be loaded"}: ${caught.message}`
          : zh ? "无法加载服务操作" : "Service operations could not be loaded",
      );
      return false;
    } finally {
      if (scopeIsCurrent(scope) && refreshGeneration.current === requestGeneration) {
        setLoading(false);
      }
    }
  }, [endpoint, passwordChangeEndpoint, scopeIsCurrent, scopeKey, zh]);

  useLayoutEffect(() => {
    accessScope.current.mounted = true;
    refreshGeneration.current += 1;
    setData(null);
    setPasswordChanges(null);
    setLoading(false);
    setPending(null);
    setPassword("");
    setFactorCode("");
    setNewServicePassword("");
    setConfirmServicePassword("");
    setReason(defaultReason);
    return () => {
      const intent = activeIntent.current;
      if (intent && !intent.mutationDispatched) {
        clearIntentKey(intent.scope.key, intent.endpoint, intent.intent, intent.idempotencyKey);
      }
      activeIntent.current = null;
      refreshGeneration.current += 1;
      accessScope.current = {
        key: accessScope.current.key,
        generation: accessScope.current.generation + 1,
        mounted: false,
      };
    };
  }, [scopeKey]);

  useEffect(() => {
    const scope = captureScope();
    if (scope.key !== scopeKey || !scopeIsCurrent(scope)) return;
    void refresh(scope);
  }, [captureScope, refresh, scopeIsCurrent, scopeKey]);

  function beginIntent(
    scope: AccessScopeToken,
    intentEndpoint: string,
    intent: string,
  ): ActiveIntent {
    const started = {
      scope,
      endpoint: intentEndpoint,
      intent,
      idempotencyKey: stableIntentKey(scope.key, intentEndpoint, intent),
      mutationDispatched: false,
    };
    activeIntent.current = started;
    return started;
  }

  function finishIntent(started: ActiveIntent, clear: boolean): void {
    if (clear) {
      clearIntentKey(started.scope.key, started.endpoint, started.intent, started.idempotencyKey);
    }
    if (activeIntent.current === started) activeIntent.current = null;
  }

  function validateReauthenticationInput(required: boolean): boolean {
    if (!required || password.length > 0 || factorCode.trim().length === 0) return true;
    onErrorRef.current(
      zh
        ? "TOTP 或恢复码必须与当前密码一起提交。"
        : "A TOTP or recovery code must be submitted with the current password.",
    );
    return false;
  }

  async function reauthenticate(
    scope: AccessScopeToken,
    required: boolean,
    submittedPassword: string,
    submittedFactorCode: string,
  ): Promise<boolean> {
    if (!required || submittedPassword.length === 0) return scopeIsCurrent(scope);
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({
          password: submittedPassword,
          ...(submittedFactorCode ? { factorCode: submittedFactorCode } : {}),
        }),
      });
    } catch (caught) {
      if (!scopeIsCurrent(scope)) return false;
      throw caught;
    }
    if (!scopeIsCurrent(scope)) return false;
    setPassword("");
    setFactorCode("");
    return true;
  }

  async function changeServicePassword(): Promise<void> {
    const scope = captureScope();
    if (
      scope.key !== scopeKey ||
      !scopeIsCurrent(scope) ||
      !canManage ||
      !passwordChanges?.service.canChangePassword ||
      pending
    ) return;
    if (!newServicePassword || newServicePassword.length < 12) {
      onErrorRef.current(zh ? "新服务密码至少需要 12 个字符。" : "The new service password must contain at least 12 characters.");
      return;
    }
    if (newServicePassword !== confirmServicePassword) {
      onErrorRef.current(zh ? "两次输入的新服务密码不一致。" : "The new service password confirmation does not match.");
      return;
    }
    if (!validateReauthenticationInput(true)) return;
    const submittedPassword = password;
    const submittedFactorCode = factorCode.trim();
    const submittedServicePassword = newServicePassword;
    const submittedReason = reason;
    const expectedServiceVersion = passwordChanges.service.version;
    const expectedResourceRevision = passwordChanges.service.resourceRevision;
    const intent = "change-password";
    const started = beginIntent(scope, passwordChangeEndpoint, intent);
    setPending(intent);
    try {
      if (!await reauthenticate(scope, true, submittedPassword, submittedFactorCode)) {
        finishIntent(started, true);
        return;
      }
      if (!scopeIsCurrent(scope)) {
        finishIntent(started, true);
        return;
      }
      started.mutationDispatched = true;
      try {
        await api(passwordChangeEndpoint, {
          method: "POST",
          body: JSON.stringify({
            expectedServiceVersion,
            expectedResourceRevision,
            idempotencyKey: started.idempotencyKey,
            newPassword: submittedServicePassword,
            ...(staff ? { reason: submittedReason } : {}),
          }),
        });
      } catch (caught) {
        if (isDefinitiveBusinessRejection(caught)) finishIntent(started, true);
        if (!scopeIsCurrent(scope)) return;
        throw caught;
      }
      finishIntent(started, true);
      if (!scopeIsCurrent(scope)) return;
      setPassword("");
      setFactorCode("");
      setNewServicePassword("");
      setConfirmServicePassword("");
      if (!await refresh(scope) || !scopeIsCurrent(scope)) return;
      onNoticeRef.current(
        zh
          ? "服务密码变更已安全排队；新密码不会出现在历史记录中。"
          : "The service password change was safely queued; the new password will not appear in history.",
      );
    } catch (caught) {
      if (!started.mutationDispatched) finishIntent(started, true);
      if (!scopeIsCurrent(scope)) return;
      onErrorRef.current(
        caught instanceof Error
          ? `${zh ? "服务密码变更失败" : "Service password change failed"}: ${caught.message}`
          : zh ? "服务密码变更失败" : "Service password change failed",
      );
    } finally {
      if (activeIntent.current === started) activeIntent.current = null;
      if (scopeIsCurrent(scope)) setPending(null);
    }
  }

  async function run(action: Action): Promise<void> {
    const scope = captureScope();
    if (scope.key !== scopeKey || !scopeIsCurrent(scope) || !canManage || !data || pending) return;
    if (!validateReauthenticationInput(staff)) return;
    const submittedPassword = password;
    const submittedFactorCode = factorCode.trim();
    const submittedReason = reason;
    const expectedServiceVersion = data.service.version;
    const expectedResourceRevision = data.service.resourceRevision;
    const started = beginIntent(scope, endpoint, action);
    setPending(action);
    try {
      if (!await reauthenticate(scope, staff, submittedPassword, submittedFactorCode)) {
        finishIntent(started, true);
        return;
      }
      if (!scopeIsCurrent(scope)) {
        finishIntent(started, true);
        return;
      }
      started.mutationDispatched = true;
      try {
        await api(endpoint, {
          method: "POST",
          body: JSON.stringify({
            action,
            expectedServiceVersion,
            expectedResourceRevision,
            idempotencyKey: started.idempotencyKey,
            ...(staff ? { reason: submittedReason } : {}),
          }),
        });
      } catch (caught) {
        if (isDefinitiveBusinessRejection(caught)) finishIntent(started, true);
        if (!scopeIsCurrent(scope)) return;
        throw caught;
      }
      finishIntent(started, true);
      if (!scopeIsCurrent(scope)) return;
      setPassword("");
      setFactorCode("");
      if (!await refresh(scope) || !scopeIsCurrent(scope)) return;
      onNoticeRef.current(
        zh
          ? `${actionLabel(action)}已持久排队，或已进入 Staff 人工处理。`
          : `${actionLabel(action)} was durably queued or moved to Staff manual fallback.`,
      );
    } catch (caught) {
      if (!started.mutationDispatched) finishIntent(started, true);
      if (!scopeIsCurrent(scope)) return;
      onErrorRef.current(
        caught instanceof Error
          ? `${zh ? "服务操作失败" : "Service operation failed"}: ${caught.message}`
          : zh ? "服务操作失败" : "Service operation failed",
      );
    } finally {
      if (activeIntent.current === started) activeIntent.current = null;
      if (scopeIsCurrent(scope)) setPending(null);
    }
  }

  async function completeManual(requestId: string): Promise<void> {
    const scope = captureScope();
    if (scope.key !== scopeKey || !scopeIsCurrent(scope) || !staff || !canManage || !data || pending) return;
    if (!validateReauthenticationInput(true)) return;
    const submittedPassword = password;
    const submittedFactorCode = factorCode.trim();
    const submittedReason = reason;
    const expectedServiceVersion = data.service.version;
    const expectedResourceRevision = data.service.resourceRevision;
    const intent = `manual-${requestId}`;
    const started = beginIntent(scope, endpoint, intent);
    setPending(requestId);
    try {
      if (!await reauthenticate(scope, true, submittedPassword, submittedFactorCode)) {
        finishIntent(started, true);
        return;
      }
      if (!scopeIsCurrent(scope)) {
        finishIntent(started, true);
        return;
      }
      started.mutationDispatched = true;
      try {
        await api(`/api/v1/admin/service-operations/${requestId}/complete-manual`, {
          method: "POST",
          body: JSON.stringify({
            expectedServiceVersion,
            expectedResourceRevision,
            reason: submittedReason,
            idempotencyKey: started.idempotencyKey,
          }),
        });
      } catch (caught) {
        if (isDefinitiveBusinessRejection(caught)) finishIntent(started, true);
        if (!scopeIsCurrent(scope)) return;
        throw caught;
      }
      finishIntent(started, true);
      if (!scopeIsCurrent(scope)) return;
      setPassword("");
      setFactorCode("");
      if (!await refresh(scope) || !scopeIsCurrent(scope)) return;
      onNoticeRef.current(zh ? "已记录服务操作的人工完成事实。" : "Manual service operation completion was recorded.");
    } catch (caught) {
      if (!started.mutationDispatched) finishIntent(started, true);
      if (!scopeIsCurrent(scope)) return;
      onErrorRef.current(
        caught instanceof Error
          ? `${zh ? "人工完成失败" : "Manual completion failed"}: ${caught.message}`
          : zh ? "人工完成失败" : "Manual completion failed",
      );
    } finally {
      if (activeIntent.current === started) activeIntent.current = null;
      if (scopeIsCurrent(scope)) setPending(null);
    }
  }

  const factorRequiresPassword = password.length === 0 && factorCode.trim().length > 0;

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
        <button disabled={loading} onClick={() => void refresh(captureScope())}>
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
              <p className="muted">
                {zh
                  ? "已有有效的 15 分钟授权时，密码与 TOTP / 恢复码都可留空；否则输入当前密码，并在已启用时输入 TOTP 或一次性恢复码。"
                  : "Leave both fields blank to reuse a current 15-minute grant. Otherwise enter the current password and, when enabled, a TOTP or one-time recovery code."}
              </p>
              <label>
                {zh ? "Staff 操作原因" : "Staff reason"}
                <input value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} disabled={pending !== null} />
              </label>
              <label>
                {zh ? "Staff 当前密码确认" : "Staff current password"}
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  disabled={pending !== null}
                />
              </label>
              <label>
                {zh ? "Staff TOTP 或恢复码" : "Staff TOTP or recovery code"}
                <input
                  value={factorCode}
                  onChange={(event) => setFactorCode(event.target.value)}
                  autoComplete="one-time-code"
                  aria-invalid={factorRequiresPassword}
                  disabled={pending !== null}
                />
              </label>
              {factorRequiresPassword && (
                <p className="notice error" data-testid="service-operation-factor-requires-password">
                  {zh
                    ? "请输入当前密码，或清空 TOTP / 恢复码以复用现有授权。"
                    : "Enter the current password, or clear the TOTP / recovery code to reuse the current grant."}
                </p>
              )}
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
          {passwordChanges && (
            <div className="manual-list" data-testid="service-password-change-panel">
              <h4>{zh ? "服务密码" : "Service password"}</h4>
              <p className="muted">
                {zh
                  ? "已有有效的 15 分钟授权时可留空重新认证字段；否则输入当前密码，并在已启用时输入 TOTP 或一次性恢复码。新服务密码只会在 Worker 内存中解密并发送给 Mock Provider，不会显示在历史记录。"
                  : "Leave reauthentication fields blank to reuse a current 15-minute grant. Otherwise enter the current password and, when enabled, a TOTP or one-time recovery code. The new service password is decrypted only in Worker memory for the Mock Provider and is never displayed in history."}
              </p>
              {canManage && passwordChanges.service.canChangePassword && (
                <div className="manual-fields">
                  {!staff && (
                    <label>
                      {zh ? "当前账户密码确认" : "Current account password"}
                      <input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="current-password"
                        disabled={pending !== null}
                      />
                    </label>
                  )}
                  {!staff && (
                    <label>
                      {zh ? "TOTP 或恢复码" : "TOTP or recovery code"}
                      <input
                        value={factorCode}
                        onChange={(event) => setFactorCode(event.target.value)}
                        autoComplete="one-time-code"
                        aria-invalid={factorRequiresPassword}
                        disabled={pending !== null}
                      />
                    </label>
                  )}
                  {!staff && factorRequiresPassword && (
                    <p className="notice error" data-testid="service-password-factor-requires-password">
                      {zh
                        ? "请输入当前密码，或清空 TOTP / 恢复码以复用现有授权。"
                        : "Enter the current password, or clear the TOTP / recovery code to reuse the current grant."}
                    </p>
                  )}
                  <label>
                    {zh ? "新服务密码" : "New service password"}
                    <input
                      type="password"
                      value={newServicePassword}
                      onChange={(event) => setNewServicePassword(event.target.value)}
                      minLength={12}
                      maxLength={128}
                      autoComplete="new-password"
                      disabled={pending !== null}
                    />
                  </label>
                  <label>
                    {zh ? "确认新服务密码" : "Confirm new service password"}
                    <input
                      type="password"
                      value={confirmServicePassword}
                      onChange={(event) => setConfirmServicePassword(event.target.value)}
                      minLength={12}
                      maxLength={128}
                      autoComplete="new-password"
                      disabled={pending !== null}
                    />
                  </label>
                  <button disabled={pending !== null} onClick={() => void changeServicePassword()}>
                    {pending === "change-password"
                      ? (zh ? "正在排队…" : "Queueing…")
                      : (zh ? "变更服务密码" : "Change service password")}
                  </button>
                </div>
              )}
              {passwordChanges.items.length === 0 && (
                <p className="muted">{zh ? "尚无密码变更事实。" : "No password-change facts yet."}</p>
              )}
              {passwordChanges.items.map((item) => (
                <div className="manual-item" key={item.requestId}>
                  <strong>{zh ? "变更密码" : "Change password"} · {statusLabel(item.status)}</strong>
                  <span>{new Date(item.updatedAt).toLocaleString(locale)}</span>
                  {staff && item.detail && <span>{item.detail}</span>}
                  <span className="mono">{item.requestId}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
