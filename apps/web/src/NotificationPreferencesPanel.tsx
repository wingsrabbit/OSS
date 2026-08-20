// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

type Locale = "en" | "zh-CN";

export type NotificationPreferenceCategory = Readonly<{
  category: string;
  label: Readonly<Record<Locale, string>>;
  mandatory: boolean;
  enabled: boolean;
  version: string;
}>;

type NotificationPreferencesSnapshot = Readonly<{
  channel: "email";
  categories: NotificationPreferenceCategory[];
}>;

const REQUIRED_CATEGORIES = new Set(["identity", "transactional", "high_risk"]);
const OPTIONAL_CATEGORIES = new Set(["billing", "service", "support"]);

export function NotificationPreferencesPanel({
  active,
  locale,
  accessFingerprint,
  canRead = true,
  canWrite = true,
  onNotice,
  onError,
}: Readonly<{
  active: boolean;
  locale: Locale;
  accessFingerprint: string;
  canRead?: boolean;
  canWrite?: boolean;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}>) {
  const [snapshot, setSnapshot] = useState<NotificationPreferencesSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingCategory, setPendingCategory] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const fingerprintRef = useRef(accessFingerprint);
  const localeRef = useRef(locale);
  const onNoticeRef = useRef(onNotice);
  const onErrorRef = useRef(onError);
  fingerprintRef.current = accessFingerprint;
  localeRef.current = locale;
  onNoticeRef.current = onNotice;
  onErrorRef.current = onError;

  const requestIsCurrent = useCallback((requestGeneration: number, fingerprint: string) => (
    mounted.current &&
    generation.current === requestGeneration &&
    fingerprintRef.current === fingerprint
  ), []);

  const refresh = useCallback(async () => {
    const requestGeneration = ++generation.current;
    const fingerprint = accessFingerprint;
    if (!active || !canRead) {
      if (mounted.current) {
        setSnapshot(null);
        setLoading(false);
        setPendingCategory(null);
      }
      return;
    }
    setLoading(true);
    try {
      const result = await api<NotificationPreferencesSnapshot>(
        "/api/v1/customer/notification-preferences",
      );
      if (!requestIsCurrent(requestGeneration, fingerprint)) return;
      setSnapshot(result);
    } catch (caught) {
      if (!requestIsCurrent(requestGeneration, fingerprint)) return;
      setSnapshot(null);
      onErrorRef.current(
        caught instanceof Error
          ? caught.message
          : localeRef.current === "zh-CN"
            ? "无法加载通知偏好"
            : "Notification preferences could not be loaded",
      );
    } finally {
      if (requestIsCurrent(requestGeneration, fingerprint)) setLoading(false);
    }
  }, [accessFingerprint, active, canRead, canWrite, requestIsCurrent]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  useEffect(() => {
    generation.current += 1;
    setSnapshot(null);
    setLoading(false);
    setPendingCategory(null);
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  async function updatePreference(
    preference: NotificationPreferenceCategory,
    enabled: boolean,
  ): Promise<void> {
    if (
      !active ||
      !canRead ||
      !canWrite ||
      preference.mandatory ||
      REQUIRED_CATEGORIES.has(preference.category) ||
      !OPTIONAL_CATEGORIES.has(preference.category) ||
      pendingCategory !== null
    ) return;

    const requestGeneration = ++generation.current;
    const fingerprint = accessFingerprint;
    setPendingCategory(preference.category);
    setSnapshot((current) => current ? {
      ...current,
      categories: current.categories.map((item) =>
        item.category === preference.category ? { ...item, enabled } : item
      ),
    } : current);
    try {
      const updated = await api<NotificationPreferenceCategory>(
        `/api/v1/customer/notification-preferences/${encodeURIComponent(preference.category)}/email`,
        {
          method: "PUT",
          body: JSON.stringify({ enabled, expectedVersion: preference.version }),
        },
      );
      if (!requestIsCurrent(requestGeneration, fingerprint)) return;
      if (updated.category !== preference.category) {
        throw new Error(
          locale === "zh-CN"
            ? "通知偏好响应与当前类别不一致"
            : "The notification preference response did not match the selected category",
        );
      }
      setSnapshot((current) => current ? {
        ...current,
        categories: current.categories.map((item) =>
          item.category === updated.category ? updated : item
        ),
      } : current);
      onNoticeRef.current(
        localeRef.current === "zh-CN"
          ? `${updated.label["zh-CN"]}邮件偏好已保存。`
          : `${updated.label.en} email preference saved.`,
      );
    } catch (caught) {
      if (!requestIsCurrent(requestGeneration, fingerprint)) return;
      setSnapshot((current) => current ? {
        ...current,
        categories: current.categories.map((item) =>
          item.category === preference.category ? preference : item
        ),
      } : current);
      onErrorRef.current(
        caught instanceof Error
          ? caught.message
          : localeRef.current === "zh-CN"
            ? "无法保存通知偏好"
            : "Notification preference could not be saved",
      );
    } finally {
      if (requestIsCurrent(requestGeneration, fingerprint)) setPendingCategory(null);
    }
  }

  if (!active || !canRead) return null;
  const zh = locale === "zh-CN";

  return (
    <section
      className="order-panel notification-preferences"
      aria-label={zh ? "通知偏好" : "Notification preferences"}
      data-testid="notification-preferences"
    >
      <div>
        <p className="eyebrow">{zh ? "用户 · 邮件通知" : "User · email notifications"}</p>
        <h2>{zh ? "通知偏好" : "Notification preferences"}</h2>
        <p>
          {zh
            ? "账单、服务和支持通知可自行选择。身份、交易和高风险通知属于必达消息，不能关闭。"
            : "Billing, service and support messages are optional. Identity, transactional and high-risk messages are required and cannot be turned off."}
        </p>
        {!canWrite && (
          <p className="notice" data-testid="notification-preferences-read-only">
            {zh ? "当前用户只能查看已保存的通知偏好。" : "This User can only view saved notification preferences."}
          </p>
        )}
      </div>

      {loading && !snapshot ? (
        <p className="muted">{zh ? "正在加载通知偏好…" : "Loading notification preferences…"}</p>
      ) : snapshot ? (
        <div className="manual-list" data-testid="notification-preference-list">
          {snapshot.categories.map((preference) => {
            const required = preference.mandatory || REQUIRED_CATEGORIES.has(preference.category);
            const optional = OPTIONAL_CATEGORIES.has(preference.category) && !required;
            const disabled = required || !optional || !canWrite || pendingCategory !== null;
            const label = preference.label[locale] || preference.label.en;
            return (
              <article
                className="manual-item"
                data-testid={`notification-preference-${preference.category}`}
                key={preference.category}
              >
                <label>
                  <input
                    type="checkbox"
                    aria-label={`${label} email`}
                    checked={preference.enabled}
                    disabled={disabled}
                    onChange={(event) => void updatePreference(preference, event.target.checked)}
                  />
                  <strong>{label}</strong>
                </label>
                <span>
                  {required
                    ? zh ? "必达邮件，不能关闭" : "Required email; it cannot be turned off"
                    : optional
                      ? zh ? "可选邮件" : "Optional email"
                      : zh ? "此类别仅供查看" : "This category is read-only"}
                  {" · "}{zh ? "版本" : "version"} {preference.version}
                </span>
                {pendingCategory === preference.category && (
                  <span className="muted">{zh ? "正在保存…" : "Saving…"}</span>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="muted">{zh ? "当前没有可显示的通知偏好。" : "No notification preferences are available."}</p>
      )}
    </section>
  );
}
