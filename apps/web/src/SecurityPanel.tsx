// SPDX-License-Identifier: AGPL-3.0-or-later

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, hardResetSession } from "./api.js";

type Locale = "en" | "zh-CN";

type SecuritySummary = Readonly<{
  warning: string;
  email: string;
  authorizationEpoch: string;
  totp: { enabled: boolean; recoveryCodesRemaining: string };
  activeSessions: string;
  activeApiKeys: string;
  later: string[];
}>;

type SecuritySession = Readonly<{
  id: string;
  current: boolean;
  status: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}>;

type CustomerApiKey = Readonly<{
  id: string;
  name: string;
  scopes: string[];
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
}>;

const API_KEY_SCOPES = [
  "account.read",
  "orders.read",
  "billing.read",
  "services.read",
  "support.read",
  "support.write",
] as const;

function randomId(): string {
  return crypto.randomUUID();
}

export function SecurityPanel(props: Readonly<{
  active: boolean;
  authenticated: boolean;
  customerApiEligible: boolean;
  locale: Locale;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}>): React.JSX.Element | null {
  const { active, authenticated, customerApiEligible, locale, onNotice, onError } = props;
  const zh = locale === "zh-CN";
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [sessions, setSessions] = useState<SecuritySession[]>([]);
  const [apiKeys, setApiKeys] = useState<CustomerApiKey[]>([]);
  const [pending, setPending] = useState(false);
  const [enrollment, setEnrollment] = useState<{
    challengeId: string;
    secret: string;
    provisioningUri: string;
  } | null>(null);
  const [oneTimeRecoveryCodes, setOneTimeRecoveryCodes] = useState<string[]>([]);
  const [oneTimeApiKey, setOneTimeApiKey] = useState("");
  const [apiKeyName, setApiKeyName] = useState("");
  const [apiKeyScopes, setApiKeyScopes] = useState<Set<string>>(
    () => new Set(["account.read"]),
  );
  const apiKeyIntent = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!active || !authenticated) return;
    const [nextSummary, nextSessions, nextKeys] = await Promise.all([
      api<SecuritySummary>("/api/v1/security"),
      api<{ items: SecuritySession[] }>("/api/v1/security/sessions"),
      customerApiEligible
        ? api<{ items: CustomerApiKey[] }>("/api/v1/security/api-keys")
        : Promise.resolve({ items: [] as CustomerApiKey[] }),
    ]);
    setSummary(nextSummary);
    setSessions(nextSessions.items);
    setApiKeys(nextKeys.items);
  }, [active, authenticated, customerApiEligible]);

  useEffect(() => {
    if (!active || !authenticated) {
      setSummary(null);
      setSessions([]);
      setApiKeys([]);
      setEnrollment(null);
      setOneTimeRecoveryCodes([]);
      setOneTimeApiKey("");
      return;
    }
    void refresh().catch((caught: unknown) =>
      onError(caught instanceof Error ? caught.message : "Unable to load Security"),
    );
  }, [active, authenticated, onError, refresh]);

  const run = useCallback(async (work: () => Promise<void>) => {
    setPending(true);
    try {
      await work();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Security action failed");
    } finally {
      setPending(false);
    }
  }, [onError]);

  if (!active) return null;
  if (!authenticated) {
    return (
      <section className="route-access" aria-label="Security access" data-testid="security-guest">
        <p className="eyebrow">{zh ? "共享身份安全" : "Shared identity security"}</p>
        <h2>{zh ? "请先登录" : "Sign in required"}</h2>
        <p>
          {zh
            ? "客户与员工使用同一个用户安全页面；请先在客户或员工工作区登录。"
            : "Customer and Staff identities use this same Security page. Sign in from either workspace first."}
        </p>
      </section>
    );
  }

  const passwordChange = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await api("/api/v1/security/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: data.get("currentPassword"),
          newPassword: data.get("newPassword"),
          factorCode: data.get("factorCode") || undefined,
        }),
      });
      form.reset();
      await refresh();
      onNotice(zh ? "密码已更新，其他会话已撤销。" : "Password updated; other sessions were revoked.");
    });
  };

  const requestEmailChange = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await api("/api/v1/security/email-change/request", {
        method: "POST",
        body: JSON.stringify({
          requestedEmail: data.get("requestedEmail"),
          password: data.get("password"),
          factorCode: data.get("factorCode") || undefined,
        }),
      });
      form.reset();
      onNotice(
        zh
          ? "确认链接已发送到新邮箱的 Mock Mail 收件箱。"
          : "A confirmation link was sent to the new address in Mock Mail.",
      );
    });
  };

  const beginTotp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      const result = await api<{
        challengeId: string;
        secret: string;
        provisioningUri: string;
      }>("/api/v1/security/totp/enroll", {
        method: "POST",
        body: JSON.stringify({ password: data.get("password"), idempotencyKey: randomId() }),
      });
      form.reset();
      setEnrollment(result);
      setOneTimeRecoveryCodes([]);
    });
  };

  const confirmTotp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enrollment) return;
    const data = new FormData(event.currentTarget);
    void run(async () => {
      const result = await api<{ recoveryCodes: string[] }>("/api/v1/security/totp/confirm", {
        method: "POST",
        body: JSON.stringify({ challengeId: enrollment.challengeId, code: data.get("code") }),
      });
      setEnrollment(null);
      setOneTimeRecoveryCodes(result.recoveryCodes);
      await refresh();
      onNotice(zh ? "TOTP 已启用。请立即保存恢复码。" : "TOTP enabled. Save the recovery codes now.");
    });
  };

  const factorMutation = (
    event: FormEvent<HTMLFormElement>,
    path: "/api/v1/security/totp/disable" | "/api/v1/security/totp/recovery-codes",
  ) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      const result = await api<{ recoveryCodes?: string[] }>(path, {
        method: "POST",
        body: JSON.stringify({ password: data.get("password"), factorCode: data.get("factorCode") }),
      });
      form.reset();
      setOneTimeRecoveryCodes(result?.recoveryCodes ?? []);
      await refresh();
      onNotice(path.endsWith("disable")
        ? zh ? "TOTP 已停用。" : "TOTP disabled."
        : zh ? "恢复码已轮换；旧恢复码已失效。" : "Recovery codes rotated; old codes are invalid.");
    });
  };

  const createApiKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const intent = apiKeyIntent.current ?? randomId();
    apiKeyIntent.current = intent;
    void run(async () => {
      const result = await api<{ apiKey: string }>("/api/v1/security/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: apiKeyName,
          scopes: [...apiKeyScopes].sort(),
          idempotencyKey: intent,
          password: data.get("password"),
          factorCode: data.get("factorCode") || undefined,
        }),
      });
      apiKeyIntent.current = null;
      setOneTimeApiKey(result.apiKey);
      setApiKeyName("");
      setApiKeyScopes(new Set(["account.read"]));
      form.reset();
      await refresh();
      onNotice(zh ? "API Key 已创建；密钥只显示这一次。" : "API key created; its secret is shown only once.");
    });
  };

  const revokeApiKey = (event: FormEvent<HTMLFormElement>, id: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await api(`/api/v1/security/api-keys/${id}/revoke`, {
        method: "POST",
        body: JSON.stringify({
          password: data.get("password"),
          factorCode: data.get("factorCode") || undefined,
          reason: "revoked from shared Security page",
        }),
      });
      form.reset();
      await refresh();
      onNotice(zh ? "API Key 已撤销。" : "API key revoked.");
    });
  };

  const revokeSession = (session: SecuritySession) => void run(async () => {
    await api(`/api/v1/security/sessions/${session.id}`, { method: "DELETE" });
    if (session.current) {
      hardResetSession();
      return;
    }
    await refresh();
  });

  return (
    <section className="security-page" aria-label="Shared User Security" data-testid="security-page">
      <div className="panel security-overview">
        <p className="eyebrow">{zh ? "客户与员工共享" : "Shared by Customer and Staff"}</p>
        <h2>{zh ? "用户安全" : "User Security"}</h2>
        <p className="notice">{summary?.warning ?? "NOT FOR PRODUCTION — MOCK PROVIDERS ONLY"}</p>
        <div className="status-grid">
          <span>{zh ? "邮箱" : "Email"}<strong>{summary?.email ?? "…"}</strong></span>
          <span>TOTP<strong>{summary?.totp.enabled ? (zh ? "已启用" : "enabled") : (zh ? "未启用" : "disabled")}</strong></span>
          <span>{zh ? "活动会话" : "Active sessions"}<strong>{summary?.activeSessions ?? "…"}</strong></span>
          <span>{zh ? "活动 API Key" : "Active API keys"}<strong>{summary?.activeApiKeys ?? "…"}</strong></span>
        </div>
      </div>

      <div className="security-grid">
        <section className="panel" aria-label="Password and email security">
          <h3>{zh ? "密码与邮箱" : "Password and email"}</h3>
          <form onSubmit={passwordChange}>
            <label>{zh ? "当前密码" : "Current password"}<input name="currentPassword" type="password" required /></label>
            <label>{zh ? "新密码" : "New password"}<input name="newPassword" type="password" minLength={12} required /></label>
            <label>{zh ? "TOTP / 恢复码（如已启用）" : "TOTP / recovery code (when enabled)"}<input name="factorCode" autoComplete="one-time-code" /></label>
            <button className="primary" disabled={pending}>{zh ? "更改密码" : "Change password"}</button>
          </form>
          <form onSubmit={requestEmailChange}>
            <label>{zh ? "新邮箱" : "New email"}<input name="requestedEmail" type="email" required /></label>
            <label>{zh ? "密码" : "Password"}<input name="password" type="password" required /></label>
            <label>{zh ? "TOTP / 恢复码（如已启用）" : "TOTP / recovery code (when enabled)"}<input name="factorCode" autoComplete="one-time-code" /></label>
            <button disabled={pending}>{zh ? "发送邮箱确认" : "Send email confirmation"}</button>
          </form>
        </section>

        <section className="panel" aria-label="Two factor authentication">
          <h3>{zh ? "双因素认证" : "Two-factor authentication"}</h3>
          {!summary?.totp.enabled && !enrollment && (
            <form onSubmit={beginTotp}>
              <label>{zh ? "密码" : "Password"}<input name="password" type="password" required /></label>
              <button className="primary" disabled={pending}>{zh ? "开始启用 TOTP" : "Begin TOTP enrollment"}</button>
            </form>
          )}
          {enrollment && (
            <div className="one-time-secret" data-testid="totp-enrollment-secret">
              <strong>{zh ? "仅显示一次" : "Shown once"}</strong>
              <code>{enrollment.secret}</code>
              <details><summary>{zh ? "配置 URI" : "Provisioning URI"}</summary><code>{enrollment.provisioningUri}</code></details>
              <form onSubmit={confirmTotp}>
                <label>{zh ? "验证器中的 6 位代码" : "6-digit authenticator code"}<input name="code" inputMode="numeric" pattern="[0-9]{6}" required /></label>
                <button className="primary" disabled={pending}>{zh ? "确认启用" : "Confirm enrollment"}</button>
              </form>
            </div>
          )}
          {summary?.totp.enabled && (
            <>
              <p>{zh ? `剩余恢复码：${summary.totp.recoveryCodesRemaining}` : `Recovery codes remaining: ${summary.totp.recoveryCodesRemaining}`}</p>
              <form onSubmit={(event) => factorMutation(event, "/api/v1/security/totp/recovery-codes")}>
                <label>{zh ? "密码" : "Password"}<input name="password" type="password" required /></label>
                <label>{zh ? "当前 TOTP / 恢复码" : "Current TOTP / recovery code"}<input name="factorCode" required /></label>
                <button disabled={pending}>{zh ? "轮换恢复码" : "Rotate recovery codes"}</button>
              </form>
              <form onSubmit={(event) => factorMutation(event, "/api/v1/security/totp/disable")}>
                <label>{zh ? "密码" : "Password"}<input name="password" type="password" required /></label>
                <label>{zh ? "当前 TOTP / 恢复码" : "Current TOTP / recovery code"}<input name="factorCode" required /></label>
                <button className="danger" disabled={pending}>{zh ? "停用 TOTP" : "Disable TOTP"}</button>
              </form>
            </>
          )}
          {oneTimeRecoveryCodes.length > 0 && (
            <div className="one-time-secret" data-testid="recovery-codes">
              <strong>{zh ? "恢复码仅显示一次" : "Recovery codes are shown once"}</strong>
              <pre>{oneTimeRecoveryCodes.join("\n")}</pre>
              <button onClick={() => setOneTimeRecoveryCodes([])}>{zh ? "我已保存" : "I saved them"}</button>
            </div>
          )}
        </section>

        <section className="panel" aria-label="Session management">
          <h3>{zh ? "会话" : "Sessions"}</h3>
          <div className="security-actions">
            <button disabled={pending} onClick={() => void run(async () => {
              await api("/api/v1/security/sessions/revoke-others", { method: "POST", body: "{}" });
              await refresh();
            })}>{zh ? "撤销其他会话" : "Revoke other sessions"}</button>
            <button className="danger" disabled={pending} onClick={() => void run(async () => {
              await api("/api/v1/security/sessions/revoke-all", { method: "POST", body: "{}" });
              hardResetSession();
            })}>{zh ? "撤销全部并退出" : "Revoke all and sign out"}</button>
          </div>
          <div className="security-list">
            {sessions.map((session) => (
              <article key={session.id}>
                <strong>{session.current ? (zh ? "当前会话" : "Current session") : session.id.slice(0, 8)}</strong>
                <span>{session.status} · {new Date(session.createdAt).toLocaleString()}</span>
                {session.status === "active" && <button disabled={pending} onClick={() => revokeSession(session)}>{zh ? "撤销" : "Revoke"}</button>}
              </article>
            ))}
          </div>
        </section>

        {customerApiEligible && <section className="panel" aria-label="Customer API keys">
          <h3>{zh ? "客户 API Key" : "Customer API keys"}</h3>
          <p className="muted">{zh ? "仅支持固定的低风险实验室 scopes；实时检查用户、账户和成员关系。" : "Only fixed low-risk laboratory scopes are available; User, Account, and Membership are checked live."}</p>
          <form onSubmit={createApiKey}>
            <label>{zh ? "名称" : "Name"}<input value={apiKeyName} onChange={(event) => { setApiKeyName(event.target.value); apiKeyIntent.current = null; }} required /></label>
            <fieldset><legend>Scopes</legend>{API_KEY_SCOPES.map((scope) => (
              <label className="scope-option" key={scope}><input type="checkbox" checked={apiKeyScopes.has(scope)} onChange={(event) => {
                const next = new Set(apiKeyScopes);
                if (event.target.checked) next.add(scope); else next.delete(scope);
                setApiKeyScopes(next);
                apiKeyIntent.current = null;
              }} />{scope}</label>
            ))}</fieldset>
            <label>{zh ? "密码" : "Password"}<input name="password" type="password" required /></label>
            <label>{zh ? "TOTP / 恢复码（如已启用）" : "TOTP / recovery code (when enabled)"}<input name="factorCode" /></label>
            <button className="primary" disabled={pending || apiKeyScopes.size === 0}>{zh ? "创建 API Key" : "Create API key"}</button>
          </form>
          {oneTimeApiKey && (
            <div className="one-time-secret" data-testid="api-key-secret">
              <strong>{zh ? "密钥仅显示一次" : "Secret shown once"}</strong>
              <code>{oneTimeApiKey}</code>
              <button onClick={() => setOneTimeApiKey("")}>{zh ? "我已保存" : "I saved it"}</button>
            </div>
          )}
          <div className="security-list">
            {apiKeys.map((key) => (
              <article key={key.id}>
                <strong>{key.name} · {key.status}</strong>
                <span>{key.scopes.join(", ")}</span>
                {key.status === "active" && <form onSubmit={(event) => revokeApiKey(event, key.id)}>
                  <input name="password" type="password" placeholder={zh ? "密码" : "Password"} required />
                  <input name="factorCode" placeholder={zh ? "TOTP / 恢复码" : "TOTP / recovery code"} />
                  <button className="danger" disabled={pending}>{zh ? "撤销" : "Revoke"}</button>
                </form>}
              </article>
            ))}
          </div>
        </section>}
      </div>
    </section>
  );
}

function fragmentToken(): string | null {
  const values = new URLSearchParams(window.location.hash.slice(1)).getAll("token");
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0] ?? "")
    ? values[0]!
    : null;
}

export function PasswordRecoveryPage(props: Readonly<{
  locale: Locale;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}>): React.JSX.Element {
  const zh = props.locale === "zh-CN";
  const [token, setToken] = useState<string | null>(() => fragmentToken());
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    const request = token
      ? api("/api/v1/auth/password-recovery/complete", {
          method: "POST",
          body: JSON.stringify({ token, newPassword: data.get("newPassword") }),
        })
      : api("/api/v1/auth/password-recovery/request", {
          method: "POST",
          body: JSON.stringify({ email: data.get("email") }),
        });
    void request.then(() => {
      form.reset();
      setToken(null);
      props.onNotice(token
        ? zh ? "密码已重置，所有会话与客户 API Key 均已撤销。" : "Password reset; all sessions and customer API keys were revoked."
        : zh ? "如该身份符合条件，Mock Mail 将收到恢复链接。" : "If eligible, the identity will receive a Mock Mail recovery link.");
    }).catch((caught: unknown) => props.onError(caught instanceof Error ? caught.message : "Password recovery failed"))
      .finally(() => setPending(false));
  };
  return <section className="route-access" aria-label="Password recovery" data-testid="password-recovery">
    <p className="eyebrow">{zh ? "密码恢复" : "Password recovery"}</p>
    <h2>{token ? (zh ? "设置新密码" : "Set a new password") : (zh ? "申请恢复链接" : "Request a recovery link")}</h2>
    <p>{zh ? "恢复链接只使用 URL fragment；令牌不会进入查询字符串、日志或本地存储。" : "Recovery links use only a URL fragment; the token is never put in a query string, logs, or local storage."}</p>
    <form onSubmit={submit}>
      {token ? <label>{zh ? "新密码" : "New password"}<input name="newPassword" type="password" minLength={12} required /></label>
        : <label>{zh ? "邮箱" : "Email"}<input name="email" type="email" required /></label>}
      <button className="primary" disabled={pending}>{token ? (zh ? "重置密码" : "Reset password") : (zh ? "发送恢复链接" : "Send recovery link")}</button>
    </form>
  </section>;
}

export function EmailChangePage(props: Readonly<{
  authenticated: boolean;
  locale: Locale;
  onCompleted: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}>): React.JSX.Element {
  const zh = props.locale === "zh-CN";
  const [token, setToken] = useState<string | null>(() => fragmentToken());
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (window.location.hash) window.history.replaceState({}, "", window.location.pathname);
  }, []);
  const complete = () => {
    if (!token) return;
    setPending(true);
    void api("/api/v1/security/email-change/complete", {
      method: "POST",
      body: JSON.stringify({ token }),
    }).then(async () => {
      setToken(null);
      await props.onCompleted();
      props.onNotice(zh ? "邮箱已验证并更新；其他会话已撤销。" : "Email verified and updated; other sessions were revoked.");
    }).catch((caught: unknown) => props.onError(caught instanceof Error ? caught.message : "Email change failed"))
      .finally(() => setPending(false));
  };
  return <section className="route-access" aria-label="Email change confirmation" data-testid="email-change-confirmation">
    <p className="eyebrow">{zh ? "邮箱变更验证" : "Email change verification"}</p>
    <h2>{zh ? "确认新邮箱" : "Confirm the new email"}</h2>
    <p>{!props.authenticated
      ? (zh ? "请先使用原身份登录，再打开此 fragment 链接完成确认。" : "Sign in as the existing identity before completing this fragment link.")
      : token ? (zh ? "确认后，新邮箱立即成为已验证登录邮箱。" : "After confirmation, the new address immediately becomes the verified sign-in email.")
        : (zh ? "链接缺失或已从当前页面消费。" : "The link is missing or was already consumed in this page.")}</p>
    <button className="primary" disabled={!props.authenticated || !token || pending} onClick={complete}>{zh ? "确认邮箱变更" : "Confirm email change"}</button>
  </section>;
}
