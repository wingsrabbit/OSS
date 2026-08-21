// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api } from "./api.js";

type Locale = "en" | "zh-CN";

type TemplateLocale = Readonly<{
  locale: Locale;
  currentRevisionId: string | null;
  currentRevisionKey: string | null;
  channelVersion: string;
  fallback: boolean;
}>;

type TemplateRevision = Readonly<{
  id: string;
  locale: Locale;
  revisionKey: string;
  revisionNumber: string;
  status: string;
  subjectTemplate: string;
  bodyTemplate: string;
  createdAt: string;
  publishedAt: string | null;
  retiredAt: string | null;
}>;

type TemplateEvent = Readonly<{
  eventType: string;
  preferenceCategory: string;
  requiredDelivery: boolean;
  sensitive: boolean;
  allowedVariables: string[];
  requiredVariables: string[];
  locales: TemplateLocale[];
  revisions: TemplateRevision[];
}>;

type TemplateRegistrySnapshot = Readonly<{
  events: TemplateEvent[];
}>;

type AccessScopeToken = Readonly<{
  key: string;
  generation: number;
}>;

type AccessScopeState = {
  key: string;
  generation: number;
  mounted: boolean;
};

function displayTime(value: string | null, locale: Locale): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US");
}

function canAdvancePublishedRevision(
  templateEvent: TemplateEvent,
  revision: TemplateRevision,
): boolean {
  if (revision.status !== "draft" || !/^[1-9]\d*$/.test(revision.revisionNumber)) {
    return false;
  }
  const latestPublished = templateEvent.revisions
    .filter((candidate) => candidate.locale === revision.locale && candidate.publishedAt)
    .reduce<bigint>((latest, candidate) => {
      if (!/^[1-9]\d*$/.test(candidate.revisionNumber)) return latest;
      const number = BigInt(candidate.revisionNumber);
      return number > latest ? number : latest;
    }, 0n);
  return BigInt(revision.revisionNumber) > latestPublished;
}

export function NotificationTemplateRegistryPanel({
  active,
  locale,
  canRead,
  canCreate,
  canPublish,
  canRetire,
  accessFingerprint,
  onNotice,
  onError,
}: Readonly<{
  active: boolean;
  locale: Locale;
  canRead: boolean;
  canCreate: boolean;
  canPublish: boolean;
  canRetire: boolean;
  accessFingerprint: string;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}>) {
  const [snapshot, setSnapshot] = useState<TemplateRegistrySnapshot>({ events: [] });
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [factorCode, setFactorCode] = useState("");
  const [actionReason, setActionReason] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const scopeKey = JSON.stringify([
    accessFingerprint,
    active,
    canRead,
    canCreate,
    canPublish,
    canRetire,
  ]);
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
  const refreshGeneration = useRef(0);
  const localeRef = useRef(locale);
  const onNoticeRef = useRef(onNotice);
  const onErrorRef = useRef(onError);
  localeRef.current = locale;
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

  const refresh = useCallback(async (
    scope: AccessScopeToken,
    reportFailure = true,
  ): Promise<boolean> => {
    if (scope.key !== scopeKey || !scopeIsCurrent(scope) || !active || !canRead) return false;
    const requestGeneration = ++refreshGeneration.current;
    setLoading(true);
    try {
      const result = await api<TemplateRegistrySnapshot>(
        "/api/v1/admin/notification-templates",
      );
      if (
        !scopeIsCurrent(scope) ||
        refreshGeneration.current !== requestGeneration
      ) return false;
      setSnapshot(result);
      return true;
    } catch (caught) {
      if (
        !scopeIsCurrent(scope) ||
        refreshGeneration.current !== requestGeneration
      ) return false;
      if (!reportFailure) throw caught;
      setSnapshot({ events: [] });
      onErrorRef.current(
        caught instanceof Error
          ? caught.message
          : localeRef.current === "zh-CN"
            ? "无法加载通知模板注册表"
            : "Notification template registry could not be loaded",
      );
      return false;
    } finally {
      if (
        scopeIsCurrent(scope) &&
        refreshGeneration.current === requestGeneration
      ) setLoading(false);
    }
  }, [
    active,
    canRead,
    scopeIsCurrent,
    scopeKey,
  ]);

  useLayoutEffect(() => {
    accessScope.current.mounted = true;
    refreshGeneration.current += 1;
    setSnapshot({ events: [] });
    setLoading(false);
    setPassword("");
    setFactorCode("");
    setActionReason("");
    setPendingAction(null);
    return () => {
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
    if (scope.key !== scopeKey || !scopeIsCurrent(scope) || !active || !canRead) return;
    void refresh(scope);
  }, [active, canRead, captureScope, refresh, scopeIsCurrent, scopeKey]);

  async function commit(
    actionKey: string,
    path: string,
    body: Record<string, unknown>,
    authorized: boolean,
  ): Promise<boolean> {
    const scope = captureScope();
    if (
      scope.key !== scopeKey ||
      !scopeIsCurrent(scope) ||
      !active ||
      !canRead ||
      !authorized ||
      pendingAction !== null
    ) return false;
    const submittedPassword = password;
    const submittedFactorCode = factorCode.trim();
    if (submittedPassword.length === 0 && submittedFactorCode.length > 0) {
      onErrorRef.current(
        localeRef.current === "zh-CN"
          ? "TOTP 或恢复码必须与当前密码一起提交。"
          : "A TOTP or recovery code must be submitted with the current password.",
      );
      return false;
    }
    setPendingAction(actionKey);
    let committed = false;
    try {
      if (submittedPassword.length > 0) {
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
      }
      if (!scopeIsCurrent(scope)) return false;
      try {
        await api(path, { method: "POST", body: JSON.stringify(body) });
      } catch (caught) {
        if (!scopeIsCurrent(scope)) return false;
        throw caught;
      }
      if (!scopeIsCurrent(scope)) return false;
      committed = true;
      setActionReason("");
      setPendingAction(null);
      onNoticeRef.current(
        localeRef.current === "zh-CN"
          ? "通知模板事实已提交。"
          : "Notification template fact committed.",
      );
      void refresh(scope, false)
        .catch((caught: unknown) => {
          if (!scopeIsCurrent(scope)) return;
          const detail = caught instanceof Error
            ? caught.message
            : localeRef.current === "zh-CN"
              ? "无法加载通知模板注册表"
              : "Notification template registry could not be loaded";
          onErrorRef.current(
            localeRef.current === "zh-CN"
              ? `通知模板事实已提交，但注册表刷新失败：${detail}`
              : `Notification template fact committed, but registry refresh failed: ${detail}`,
          );
        });
      return true;
    } catch (caught) {
      if (!scopeIsCurrent(scope)) return false;
      onErrorRef.current(
        caught instanceof Error
          ? caught.message
          : localeRef.current === "zh-CN"
            ? "无法提交通知模板事实"
            : "Notification template fact could not be committed",
      );
      return false;
    } finally {
      if (!committed && scopeIsCurrent(scope)) setPendingAction(null);
    }
  }

  async function createRevision(event: FormEvent<HTMLFormElement>, templateEvent: TemplateEvent) {
    event.preventDefault();
    if (!canCreate) return;
    const scope = captureScope();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const revisionLocale = String(form.get("locale"));
    const subjectTemplate = String(form.get("subjectTemplate") ?? "").trim();
    const bodyTemplate = String(form.get("bodyTemplate") ?? "").trim();
    const reason = String(form.get("reason") ?? "").trim();
    if (
      (revisionLocale !== "en" && revisionLocale !== "zh-CN") ||
      subjectTemplate.length === 0 ||
      bodyTemplate.length === 0 ||
      !bodyTemplate.startsWith("NOT FOR PRODUCTION — MOCK PROVIDERS ONLY") ||
      reason.length < 3
    ) return;
    const committed = await commit(
      `create:${templateEvent.eventType}`,
      `/api/v1/admin/notification-templates/${encodeURIComponent(templateEvent.eventType)}/revisions`,
      { locale: revisionLocale, subjectTemplate, bodyTemplate, reason },
      canCreate,
    );
    if (committed && scopeIsCurrent(scope)) formElement.reset();
  }

  async function changePublication(
    templateEvent: TemplateEvent,
    revision: TemplateRevision,
    action: "publish" | "retire",
  ) {
    if (
      (action === "publish" && !canPublish) ||
      (action === "retire" && !canRetire) ||
      actionReason.trim().length < 3
    ) return;
    const channel = templateEvent.locales.find((entry) => entry.locale === revision.locale);
    if (!channel || !/^(0|[1-9]\d*)$/.test(channel.channelVersion)) {
      onErrorRef.current(
        localeRef.current === "zh-CN"
          ? "当前模板语言缺少有效的通道版本"
          : "The template locale has no valid channel version",
      );
      return;
    }
    await commit(
      `${action}:${revision.id}`,
      `/api/v1/admin/notification-templates/${encodeURIComponent(templateEvent.eventType)}/revisions/${encodeURIComponent(revision.id)}/${action}`,
      {
        reason: actionReason.trim(),
        expectedChannelVersion: channel.channelVersion,
      },
      action === "publish" ? canPublish : canRetire,
    );
  }

  if (!active || !canRead) return null;
  const zh = locale === "zh-CN";
  const hasPublicationActions = canPublish || canRetire;
  const factorRequiresPassword = password.length === 0 && factorCode.trim().length > 0;

  return (
    <section
      className="order-panel notification-template-registry"
      aria-label={zh ? "通知模板注册表" : "Notification template registry"}
      data-testid="notification-template-registry"
    >
      <div>
        <p className="eyebrow">{zh ? "Staff 通知内容" : "Staff notification content"}</p>
        <h2>{zh ? "版本化通知模板" : "Versioned notification templates"}</h2>
        <p>
          {zh
            ? "草稿、发布和退役均追加新事实；已使用的历史版本不会被编辑。"
            : "Draft, publication and retirement append new facts. Historical revisions already used for delivery are never edited."}
        </p>
      </div>

      {(canCreate || hasPublicationActions) && (
        <fieldset>
          <legend>{zh ? "Staff 重新认证" : "Staff reauthentication"}</legend>
          <p className="muted">
            {zh
              ? "已有有效的 15 分钟授权时可留空；否则输入当前密码，并在已启用时输入 TOTP 或一次性恢复码。"
              : "Leave both fields blank to reuse a current 15-minute grant. Otherwise enter the current password and, when enabled, a TOTP or one-time recovery code."}
          </p>
          <label>
            {zh ? "当前密码确认" : "Current password confirmation"}
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pendingAction !== null}
            />
          </label>
          <label>
            {zh ? "模板操作 TOTP 或恢复码" : "Template TOTP or recovery code"}
            <input
              autoComplete="one-time-code"
              value={factorCode}
              onChange={(event) => setFactorCode(event.target.value)}
              aria-invalid={factorRequiresPassword}
              disabled={pendingAction !== null}
            />
          </label>
          {factorRequiresPassword && (
            <p className="notice error" data-testid="notification-template-factor-requires-password">
              {zh
                ? "请输入当前密码，或清空 TOTP / 恢复码以复用现有授权。"
                : "Enter the current password, or clear the TOTP / recovery code to reuse the current grant."}
            </p>
          )}
        </fieldset>
      )}

      {hasPublicationActions && (
        <label>
          {zh ? "发布或退役原因" : "Publication or retirement reason"}
          <input
            value={actionReason}
            maxLength={1_000}
            onChange={(event) => setActionReason(event.target.value)}
          />
        </label>
      )}

      {loading && snapshot.events.length === 0 ? (
        <p className="muted">{zh ? "正在加载通知模板…" : "Loading notification templates…"}</p>
      ) : snapshot.events.length === 0 ? (
        <p className="muted">{zh ? "当前没有通知模板事件。" : "No notification template events are available."}</p>
      ) : (
        <div className="manual-list" data-testid="notification-template-events">
          {snapshot.events.map((templateEvent) => (
            <article
              className="manual-item"
              data-testid="notification-template-event"
              key={templateEvent.eventType}
            >
              <strong>{templateEvent.eventType}</strong>
              <span>
                {zh ? "偏好类别" : "Preference category"}: {templateEvent.preferenceCategory}
                {" · "}
                {templateEvent.requiredDelivery
                  ? zh ? "必达" : "required delivery"
                  : zh ? "遵循客户偏好" : "customer preference applies"}
                {templateEvent.sensitive ? ` · ${zh ? "敏感内容模板" : "sensitive content template"}` : ""}
              </span>
              <span className="muted">
                {zh ? "必需变量" : "Required variables"}: {templateEvent.requiredVariables.join(", ")}
                {" · "}
                {zh ? "可用变量" : "Available variables"}: {templateEvent.allowedVariables.join(", ")}
              </span>
              <div className="journey">
                {templateEvent.locales.map((entry) => (
                  <span key={entry.locale} data-testid={`notification-template-locale-${entry.locale}`}>
                    {entry.locale}: {entry.currentRevisionKey ?? (zh ? "无当前版本" : "no current revision")}
                    {" · "}{zh ? "通道版本" : "channel version"} {entry.channelVersion}
                    {entry.fallback ? ` · ${zh ? "回退" : "fallback"}` : ""}
                  </span>
                ))}
              </div>

              {canCreate && (
                <form
                  className="inline-form"
                  data-testid="notification-template-create"
                  onSubmit={(formEvent) => void createRevision(formEvent, templateEvent)}
                >
                  <label>
                    {zh ? "模板语言" : "Template locale"}
                    <select name="locale" defaultValue="en">
                      <option value="en">English</option>
                      <option value="zh-CN">简体中文</option>
                    </select>
                  </label>
                  <label>
                    {zh ? "主题模板" : "Subject template"}
                    <input name="subjectTemplate" required maxLength={240} />
                  </label>
                  <label>
                    {zh ? "正文模板" : "Body template"}
                    <textarea name="bodyTemplate" required maxLength={20_000} />
                    <span className="muted">
                      {zh
                        ? "正文必须以 NOT FOR PRODUCTION — MOCK PROVIDERS ONLY 开头。"
                        : "The body must begin with NOT FOR PRODUCTION — MOCK PROVIDERS ONLY."}
                    </span>
                  </label>
                  <label>
                    {zh ? "创建原因" : "Creation reason"}
                    <input name="reason" required minLength={3} maxLength={1_000} />
                  </label>
                  <button
                    type="submit"
                    disabled={pendingAction !== null || factorRequiresPassword}
                  >
                    {pendingAction === `create:${templateEvent.eventType}`
                      ? zh ? "正在创建…" : "Creating…"
                      : zh ? "创建不可变草稿" : "Create immutable draft"}
                  </button>
                </form>
              )}

              <div className="manual-list" data-testid="notification-template-revisions">
                {templateEvent.revisions.map((revision) => {
                  const channel = templateEvent.locales.find((entry) => entry.locale === revision.locale);
                  const current = channel?.currentRevisionId === revision.id;
                  const publishable = canAdvancePublishedRevision(templateEvent, revision);
                  return (
                    <article className="manual-item" data-testid="notification-template-revision" key={revision.id}>
                      <strong>
                        {revision.locale} · #{revision.revisionNumber} · {revision.status}
                        {current ? ` · ${zh ? "当前" : "current"}` : ""}
                      </strong>
                      <span className="mono">{revision.revisionKey}</span>
                      <span>{revision.subjectTemplate}</span>
                      <span className="muted">{revision.bodyTemplate}</span>
                      <span>
                        {zh ? "创建" : "created"} {displayTime(revision.createdAt, locale)}
                        {revision.publishedAt ? ` · ${zh ? "发布" : "published"} ${displayTime(revision.publishedAt, locale)}` : ""}
                        {revision.retiredAt ? ` · ${zh ? "退役" : "retired"} ${displayTime(revision.retiredAt, locale)}` : ""}
                      </span>
                      {canPublish && publishable && (
                        <button
                          type="button"
                          disabled={
                            pendingAction !== null ||
                            factorRequiresPassword ||
                            actionReason.trim().length < 3
                          }
                          onClick={() => void changePublication(templateEvent, revision, "publish")}
                        >
                          {pendingAction === `publish:${revision.id}`
                            ? zh ? "正在发布…" : "Publishing…"
                            : zh ? "发布版本" : "Publish revision"}
                        </button>
                      )}
                      {canPublish && revision.status === "draft" && !publishable && (
                        <span className="muted">
                          {zh
                            ? "已有更新的已发布版本；该草稿不能覆盖当前版本。"
                            : "A newer revision is already published; this draft cannot replace it."}
                        </span>
                      )}
                      {canRetire && current && revision.locale !== "en" &&
                        (revision.status === "published" || revision.status === "current") && (
                        <button
                          type="button"
                          disabled={
                            pendingAction !== null ||
                            factorRequiresPassword ||
                            actionReason.trim().length < 3
                          }
                          onClick={() => void changePublication(templateEvent, revision, "retire")}
                        >
                          {pendingAction === `retire:${revision.id}`
                            ? zh ? "正在退役…" : "Retiring…"
                            : zh ? "退役当前版本" : "Retire current revision"}
                        </button>
                      )}
                      {current && revision.locale === "en" && (
                        <span className="muted">
                          {zh
                            ? "英文 fallback 只能通过发布更新版本来替换。"
                            : "The English fallback can only be replaced by publishing a newer revision."}
                        </span>
                      )}
                    </article>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
