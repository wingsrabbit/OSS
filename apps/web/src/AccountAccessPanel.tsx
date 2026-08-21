// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ApiError, api } from "./api.js";
import type { MembershipRole } from "./AccountContextSwitcher.js";

type Locale = "en" | "zh-CN";
type Page<T> = { items: T[]; limit: number; hasMore: boolean; nextCursor: string | null };

type Member = {
  userId: string;
  email: string;
  role: MembershipRole;
  permissions: string[];
  restrictions: { membership: boolean; user: boolean };
  isRecordedOwner: boolean;
  createdAt: string;
  updatedAt: string;
};

type Invitation = {
  id: string;
  email: string;
  locale: Locale;
  role: MembershipRole;
  permissions: string[];
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
};

export type AccountContact = {
  id: string;
  displayName: string;
  email: string;
  locale: Locale;
  notificationSubscriptions: Array<"billing" | "service" | "support">;
  createdAt: string;
  updatedAt: string;
};

type CollectionState<T> = {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  nextCursor: string | null;
};

const emptyCollection = <T,>(): CollectionState<T> => ({
  items: [],
  loading: false,
  loadingMore: false,
  hasMore: false,
  nextCursor: null,
});

function customerSurfaceIsActive(): boolean {
  return (window.location.pathname.replace(/\/+$/, "") || "/") === "/customer";
}

function permissionSet(value: readonly string[]): ReadonlySet<string> {
  return new Set(
    value.filter(
      (permission) =>
        typeof permission === "string" &&
        permission.length > 0 &&
        permission.trim() === permission,
    ),
  );
}

const RECOGNIZED_ACCOUNT_CAPABILITIES = [
  "account.contacts.manage",
  "account.contacts.read",
  "account.members.manage",
  "account.members.read",
  "billing.read",
  "billing.write",
  "orders.create",
  "services.manage",
  "support.tickets.write",
] as const;

const DEFAULT_ROLE_CAPABILITIES: Record<MembershipRole, readonly string[]> = {
  owner: RECOGNIZED_ACCOUNT_CAPABILITIES,
  billing: ["billing.read", "billing.write", "orders.create", "support.tickets.write"],
  technical: ["billing.read", "services.manage", "support.tickets.write"],
  viewer: ["billing.read"],
};

function rolesWithinGrantCeiling(
  viewerIsOwner: boolean,
  capabilities: ReadonlySet<string>,
): MembershipRole[] {
  if (viewerIsOwner) return ["owner", "billing", "technical", "viewer"];
  return (["billing", "technical", "viewer"] as const).filter((candidate) =>
    DEFAULT_ROLE_CAPABILITIES[candidate].every((capability) => capabilities.has(capability)),
  );
}

function permissionList(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].sort();
}

function collectionItemKey(item: unknown): string {
  if (item && typeof item === "object") {
    const candidate = item as { id?: unknown; userId?: unknown };
    if (typeof candidate.id === "string") return `id:${candidate.id}`;
    if (typeof candidate.userId === "string") return `user:${candidate.userId}`;
  }
  return `value:${JSON.stringify(item)}`;
}

function subscriptionsFromForm(form: HTMLFormElement): Array<"billing" | "service" | "support"> {
  const data = new FormData(form);
  return ["billing", "service", "support"].filter(
    (value): value is "billing" | "service" | "support" => data.get(value) === "on",
  );
}

function when(value: string): string {
  return new Date(value).toLocaleString();
}

function tr(locale: Locale, english: string, chinese: string): string {
  return locale === "zh-CN" ? chinese : english;
}

function invitationStatus(locale: Locale, status: Invitation["status"]): string {
  if (locale === "en") return status;
  return { pending: "待接受", accepted: "已接受", revoked: "已撤销", expired: "已过期" }[status];
}

function usePagedCollection<T>({
  enabled,
  path,
  scopeKey,
  locale,
  onError,
}: {
  enabled: boolean;
  path: string;
  scopeKey: string;
  locale: Locale;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<CollectionState<T>>(emptyCollection);
  const generation = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    if (!enabled || !customerSurfaceIsActive()) return false;
    const requestGeneration = ++generation.current;
    setState((current) => ({
      ...(append ? current : emptyCollection<T>()),
      loading: !append,
      loadingMore: append,
    }));
    try {
      const result = await api<Page<T>>(
        `${path}?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (requestGeneration !== generation.current || !customerSurfaceIsActive()) return false;
      setState((current) => {
        const items = append
          ? [...new Map([...current.items, ...result.items].map((item) => [collectionItemKey(item), item])).values()]
          : result.items;
        return {
          items,
          loading: false,
          loadingMore: false,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        };
      });
      return true;
    } catch (caught) {
      if (requestGeneration !== generation.current || !customerSurfaceIsActive()) return false;
      if (!append || (caught instanceof ApiError && caught.status === 403)) {
        setState(emptyCollection());
      } else {
        setState((current) => ({ ...current, loading: false, loadingMore: false }));
      }
      onErrorRef.current(
        caught instanceof Error
          ? caught.message
          : tr(locale, "Account collection could not be loaded", "无法加载客户账户列表"),
      );
      return false;
    }
  }, [enabled, locale, path, scopeKey]);

  useEffect(() => {
    generation.current += 1;
    setState(emptyCollection());
    if (enabled && customerSurfaceIsActive()) void load(null, false);
    return () => {
      generation.current += 1;
    };
  }, [enabled, load, scopeKey]);

  const refresh = useCallback(() => load(null, false), [load]);
  const loadMore = useCallback(
    () => state.nextCursor ? load(state.nextCursor, true) : Promise.resolve(false),
    [load, state.nextCursor],
  );
  return { state, refresh, loadMore };
}

function CollectionShell({
  title,
  state,
  onRefresh,
  onLoadMore,
  locale,
  children,
}: {
  title: string;
  state: CollectionState<unknown>;
  onRefresh: () => void;
  onLoadMore: () => void;
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <section className="account-access-collection" aria-label={title}>
      <div className="history-heading">
        <h3>{title}</h3>
        <button disabled={state.loading || state.loadingMore} onClick={onRefresh}>{tr(locale, "Refresh", "刷新")}</button>
      </div>
      {state.loading ? <p className="muted">{tr(locale, "Loading…", "正在加载…")}</p> : children}
      {state.hasMore && (
        <button disabled={state.loadingMore || !state.nextCursor} onClick={onLoadMore}>
          {state.loadingMore ? tr(locale, "Loading more…", "正在加载更多…") : tr(locale, "Load more", "加载更多")}
        </button>
      )}
    </section>
  );
}

function MemberEditor({
  member,
  replacementOwners,
  pending,
  locale,
  grantableRoles,
  grantablePermissions,
  onValidationError,
  onUpdate,
  onRemove,
}: {
  member: Member;
  replacementOwners: Member[];
  pending: boolean;
  locale: Locale;
  grantableRoles: readonly MembershipRole[];
  grantablePermissions: ReadonlySet<string>;
  onValidationError: (message: string) => void;
  onUpdate: (body: {
    role: MembershipRole;
    permissions: string[];
    restricted: boolean;
    replacementOwnerUserId?: string;
  }) => void;
  onRemove: (replacementOwnerUserId?: string) => void;
}) {
  const [role, setRole] = useState(member.role);
  const [permissions, setPermissions] = useState(member.permissions.join(", "));
  const [restricted, setRestricted] = useState(member.restrictions.membership);
  const [replacementOwnerUserId, setReplacementOwnerUserId] = useState("");
  return (
    <article className="manual-item" data-testid="account-member">
      <strong>{member.email}</strong>
      <span className="mono">{member.userId}</span>
      <span>
        {member.isRecordedOwner ? tr(locale, "Recorded account owner · ", "登记账户所有者 · ") : ""}
        {tr(locale, "User", "用户")} {member.restrictions.user ? tr(locale, "restricted", "受限") : tr(locale, "unrestricted", "未受限")} · {tr(locale, "joined", "加入于")} {when(member.createdAt)}
      </span>
      <div className="account-access-editor">
        <label>
          {tr(locale, "Role", "角色")}
          <select disabled={grantableRoles.length < 2} aria-label={`Member role ${member.email}`} value={role} onChange={(event) => setRole(event.target.value as MembershipRole)}>
            {grantableRoles.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
          </select>
        </label>
        <label>
          {tr(locale, "Permissions (comma separated)", "权限（逗号分隔）")}
          <input
            aria-label={`Member permissions ${member.email}`}
            value={permissions}
            onChange={(event) => setPermissions(event.target.value)}
            placeholder={[...grantablePermissions].sort().join(", ")}
          />
        </label>
        <label className="checkbox-label">
          <input aria-label={`Restrict member ${member.email}`} type="checkbox" checked={restricted} onChange={(event) => setRestricted(event.target.checked)} />
          {tr(locale, "Membership restricted", "成员关系受限")}
        </label>
        <label>
          {tr(locale, "Replacement recorded owner", "接任登记所有者")}
          <select
            aria-label={`Replacement owner ${member.email}`}
            value={replacementOwnerUserId}
            onChange={(event) => setReplacementOwnerUserId(event.target.value)}
          >
            <option value="">{tr(locale, "No owner transfer selected", "不转移登记所有者")}</option>
            {replacementOwners.map((owner) => (
              <option key={owner.userId} value={owner.userId}>{owner.email} · {owner.role}</option>
            ))}
          </select>
        </label>
        <div className="workspace-actions">
          <button disabled={pending} onClick={() => {
            if (!grantableRoles.includes(role)) {
              onValidationError(tr(locale, `Role ${role} exceeds your grant ceiling.`, `角色 ${role} 超出你的授权上限。`));
              return;
            }
            const requestedPermissions = permissionList(permissions);
            const outsideCeiling = requestedPermissions.find((permission) => !grantablePermissions.has(permission));
            if (outsideCeiling) {
              onValidationError(tr(locale, `Permission ${outsideCeiling} exceeds your grant ceiling.`, `权限 ${outsideCeiling} 超出你的授权上限。`));
              return;
            }
            onUpdate({
              role,
              permissions: requestedPermissions,
              restricted,
              ...(replacementOwnerUserId.trim() ? { replacementOwnerUserId: replacementOwnerUserId.trim() } : {}),
            });
          }}>{tr(locale, "Update member", "更新成员")}</button>
          <button className="danger" disabled={pending} onClick={() => onRemove(replacementOwnerUserId.trim() || undefined)}>{tr(locale, "Remove member", "移除成员")}</button>
        </div>
      </div>
    </article>
  );
}

function ContactEditor({
  contact,
  pending,
  locale: appLocale,
  onUpdate,
  onRemove,
}: {
  contact: AccountContact;
  pending: boolean;
  locale: Locale;
  onUpdate: (body: Omit<AccountContact, "id" | "createdAt" | "updatedAt">) => void;
  onRemove: () => void;
}) {
  const [displayName, setDisplayName] = useState(contact.displayName);
  const [email, setEmail] = useState(contact.email);
  const [locale, setLocale] = useState<Locale>(contact.locale);
  const [subscriptions, setSubscriptions] = useState(new Set(contact.notificationSubscriptions));
  function toggle(subscription: "billing" | "service" | "support", enabled: boolean) {
    setSubscriptions((current) => {
      const next = new Set(current);
      if (enabled) next.add(subscription);
      else next.delete(subscription);
      return next;
    });
  }
  return (
    <article className="manual-item" data-testid="account-contact">
      <strong>{contact.displayName} · {contact.email}</strong>
      <span>{tr(appLocale, "Contact only — no sign-in, User identity or Client Account membership", "仅为联系人——没有登录、用户身份或客户账户成员权限")}</span>
      <div className="account-access-editor">
        <input aria-label={`Contact name ${contact.email}`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        <input aria-label={`Contact email ${contact.email}`} type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        <select aria-label={`Contact locale ${contact.email}`} value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
          <option value="en">English</option>
          <option value="zh-CN">简体中文</option>
        </select>
        <div className="subscription-options">
          {(["billing", "service", "support"] as const).map((subscription) => (
            <label key={subscription}>
              <input
                aria-label={`${subscription} notifications ${contact.email}`}
                type="checkbox"
                checked={subscriptions.has(subscription)}
                onChange={(event) => toggle(subscription, event.target.checked)}
              />
              {subscription}
            </label>
          ))}
        </div>
        <div className="workspace-actions">
          <button disabled={pending || !displayName.trim() || !email.trim()} onClick={() => onUpdate({
            displayName: displayName.trim(),
            email: email.trim(),
            locale,
            notificationSubscriptions: [...subscriptions].sort(),
          })}>{tr(appLocale, "Update Contact", "更新联系人")}</button>
          <button className="danger" disabled={pending} onClick={onRemove}>{tr(appLocale, "Remove Contact", "移除联系人")}</button>
        </div>
      </div>
    </article>
  );
}

export function AccountAccessPanel({
  active,
  viewerId,
  accountId,
  accountName,
  role,
  capabilities: rawCapabilities,
  contextVersion,
  writeEligible,
  locale,
  onNotice,
  onError,
  onSelfMembershipChanged,
}: {
  active: boolean;
  viewerId: string;
  accountId: string;
  accountName: string;
  role: MembershipRole;
  capabilities: readonly string[];
  contextVersion: string;
  writeEligible: boolean;
  locale: Locale;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onSelfMembershipChanged: () => Promise<void>;
}) {
  const capabilities = permissionSet(rawCapabilities);
  const memberManagementGranted = capabilities.has("account.members.manage");
  const canManageMembers = writeEligible && memberManagementGranted;
  const canReadMembers = memberManagementGranted || capabilities.has("account.members.read");
  const contactManagementGranted = capabilities.has("account.contacts.manage");
  const canManageContacts = writeEligible && contactManagementGranted;
  const canReadContacts = contactManagementGranted || capabilities.has("account.contacts.read");
  const viewerIsOwner = role === "owner";
  const grantablePermissions = new Set<string>(
    viewerIsOwner ? [...RECOGNIZED_ACCOUNT_CAPABILITIES, "*"] : capabilities,
  );
  const grantableRoles = rolesWithinGrantCeiling(viewerIsOwner, capabilities);
  const scopeKey = `${viewerId}\u0000${accountId}\u0000${contextVersion}\u0000${role}\u0000${writeEligible ? "write" : "read-only"}\u0000${[...capabilities].sort().join("\u0001")}`;
  const members = usePagedCollection<Member>({ enabled: active && canReadMembers, path: "/api/v1/account/members", scopeKey, locale, onError });
  const invitations = usePagedCollection<Invitation>({ enabled: active && canReadMembers, path: "/api/v1/account/membership-invitations", scopeKey, locale, onError });
  const contacts = usePagedCollection<AccountContact>({ enabled: active && canReadContacts, path: "/api/v1/account/contacts", scopeKey, locale, onError });
  const [password, setPassword] = useState("");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const operationGeneration = useRef(0);
  const activeScopeKey = useRef(scopeKey);
  activeScopeKey.current = scopeKey;

  type OperationScope = { generation: number; key: string };
  const operationIsCurrent = useCallback((scope: OperationScope) =>
    scope.generation === operationGeneration.current &&
    scope.key === activeScopeKey.current &&
    customerSurfaceIsActive(), []);

  useEffect(() => {
    operationGeneration.current += 1;
    setPassword("");
    setPendingKey(null);
    return () => {
      operationGeneration.current += 1;
    };
  }, [scopeKey]);

  async function confirmIdentity(scope: OperationScope): Promise<boolean> {
    if (!password) throw new Error(tr(locale, "Re-enter your password before changing members or invitations", "更改成员或邀请前请重新输入密码"));
    await api("/api/v1/auth/reauth", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    return operationIsCurrent(scope);
  }

  async function mutation(key: string, action: (scope: OperationScope) => Promise<void>) {
    if (!writeEligible || pendingKey || !customerSurfaceIsActive()) return;
    const scope = { generation: operationGeneration.current, key: activeScopeKey.current };
    setPendingKey(key);
    try {
      await action(scope);
    } catch (caught) {
      if (!operationIsCurrent(scope)) return;
      if (caught instanceof ApiError && caught.status === 403) {
        await Promise.all([members.refresh(), invitations.refresh(), contacts.refresh()]);
        if (!operationIsCurrent(scope)) return;
      }
      onError(caught instanceof Error ? caught.message : tr(locale, "Account change failed", "客户账户变更失败"));
    } finally {
      if (operationIsCurrent(scope)) setPendingKey(null);
    }
  }

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const requestedRole = String(data.get("role") ?? "viewer") as MembershipRole;
    const requestedPermissions = permissionList(String(data.get("permissions") ?? ""));
    if (!grantableRoles.includes(requestedRole)) {
      onError(tr(locale, `Role ${requestedRole} exceeds your grant ceiling.`, `角色 ${requestedRole} 超出你的授权上限。`));
      return;
    }
    const outsideCeiling = requestedPermissions.find((permission) => !grantablePermissions.has(permission));
    if (outsideCeiling) {
      onError(tr(locale, `Permission ${outsideCeiling} exceeds your grant ceiling.`, `权限 ${outsideCeiling} 超出你的授权上限。`));
      return;
    }
    await mutation("invite:create", async (scope) => {
      if (!(await confirmIdentity(scope))) return;
      await api("/api/v1/account/membership-invitations", {
        method: "POST",
        body: JSON.stringify({
          email: data.get("email"),
          locale: data.get("locale"),
          role: requestedRole,
          permissions: requestedPermissions,
        }),
      });
      if (!operationIsCurrent(scope)) return;
      form.reset();
      await invitations.refresh();
      if (!operationIsCurrent(scope)) return;
      onNotice(tr(locale, "Membership invitation queued in the Mock Provider mailbox.", "成员邀请已进入 Mock Provider 邮箱队列。"));
    });
  }

  async function createContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await mutation("contact:create", async (scope) => {
      await api("/api/v1/account/contacts", {
        method: "POST",
        body: JSON.stringify({
          displayName: data.get("displayName"),
          email: data.get("email"),
          locale: data.get("locale"),
          notificationSubscriptions: subscriptionsFromForm(form),
        }),
      });
      if (!operationIsCurrent(scope)) return;
      form.reset();
      await contacts.refresh();
      if (!operationIsCurrent(scope)) return;
      onNotice(tr(locale, "Contact created without granting sign-in or Client Account access.", "联系人已创建，未授予登录或客户账户访问权限。"));
    });
  }

  if (!active || (!canReadMembers && !canReadContacts) || !customerSurfaceIsActive()) return null;

  return (
    <section className="account-access-panel" aria-label="Client Account people and Contacts" data-testid="account-access-panel">
      <div className="history-heading">
        <div>
          <p className="eyebrow">{tr(locale, "Client Account administration", "客户账户管理")}</p>
          <h2>{tr(locale, "Members, invitations and Contacts", "成员、邀请与联系人")}</h2>
          <p>{accountName} · <span className="mono">{accountId}</span></p>
        </div>
      </div>

      {!writeEligible && (
        <p className="notice" data-testid="account-access-read-only">
          {tr(
            locale,
            "The Client Account is restricted. Members, invitations and Contacts remain readable, but changes are unavailable.",
            "客户账户当前受限；成员、邀请与联系人仍可查看，但不能进行变更。",
          )}
        </p>
      )}

      {canManageMembers && (
        <label className="account-reauth">
          {tr(locale, "Password confirmation for member and invitation changes", "成员与邀请变更的密码确认")}
          <input
            aria-label="Account administration password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={tr(locale, "Re-enter password (fixed 15-minute grant)", "重新输入密码（固定 15 分钟授权）")}
          />
        </label>
      )}

      {canReadMembers && (
        <>
          <CollectionShell
            title={tr(locale, "Client Account members", "客户账户成员")}
            state={members.state}
            onRefresh={() => void members.refresh()}
            onLoadMore={() => void members.loadMore()}
            locale={locale}
          >
            {members.state.items.length === 0 ? <p className="muted">{tr(locale, "No active members.", "没有有效成员。")}</p> : (
              <div className="manual-list" data-testid="account-members">
                {members.state.items.map((member) => canManageMembers && grantableRoles.includes(member.role) ? (
                  <MemberEditor
                    key={`${member.userId}:${member.updatedAt}`}
                    member={member}
                    replacementOwners={members.state.items.filter(
                      (candidate) =>
                        candidate.userId !== member.userId &&
                        candidate.role === "owner" &&
                        !candidate.restrictions.membership &&
                        !candidate.restrictions.user,
                    )}
                    pending={pendingKey !== null}
                    locale={locale}
                    grantableRoles={grantableRoles}
                    grantablePermissions={grantablePermissions}
                    onValidationError={onError}
                    onUpdate={(body) => void mutation(`member:update:${member.userId}`, async (scope) => {
                      if (!(await confirmIdentity(scope))) return;
                      await api(`/api/v1/account/members/${member.userId}`, {
                        method: "PATCH",
                        body: JSON.stringify(body),
                      });
                      if (!operationIsCurrent(scope)) return;
                      if (member.userId === viewerId) {
                        await onSelfMembershipChanged();
                        return;
                      }
                      await members.refresh();
                      if (!operationIsCurrent(scope)) return;
                      onNotice(tr(locale, `Membership updated for ${member.email}.`, `已更新 ${member.email} 的成员关系。`));
                    })}
                    onRemove={(replacementOwnerUserId) => void mutation(`member:remove:${member.userId}`, async (scope) => {
                      if (!(await confirmIdentity(scope))) return;
                      const query = replacementOwnerUserId ? `?replacementOwnerUserId=${encodeURIComponent(replacementOwnerUserId)}` : "";
                      await api(`/api/v1/account/members/${member.userId}${query}`, { method: "DELETE" });
                      if (!operationIsCurrent(scope)) return;
                      if (member.userId === viewerId) {
                        await onSelfMembershipChanged();
                        return;
                      }
                      await members.refresh();
                      if (!operationIsCurrent(scope)) return;
                      onNotice(tr(locale, `Membership removed for ${member.email}.`, `已移除 ${member.email} 的成员关系。`));
                    })}
                  />
                ) : (
                  <article className="manual-item" data-testid="account-member" key={member.userId}>
                    <strong>{member.email} · {member.role}</strong>
                    <span>{member.isRecordedOwner ? tr(locale, "Recorded account owner · ", "登记账户所有者 · ") : ""}{member.restrictions.membership ? tr(locale, "membership restricted", "成员关系受限") : tr(locale, "active membership", "有效成员关系")}</span>
                    <span className="mono">{member.userId}</span>
                  </article>
                ))}
              </div>
            )}
          </CollectionShell>

          <CollectionShell
            title={tr(locale, "Membership invitations", "成员邀请")}
            state={invitations.state}
            onRefresh={() => void invitations.refresh()}
            onLoadMore={() => void invitations.loadMore()}
            locale={locale}
          >
            {canManageMembers && (
              <form className="account-access-create" onSubmit={createInvitation}>
                <input aria-label="Invitation email" name="email" type="email" placeholder={tr(locale, "Invitee email", "受邀人邮箱")} required />
                <select aria-label="Invitation role" name="role" defaultValue="viewer">
                  {grantableRoles.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
                </select>
                <select aria-label="Invitation locale" name="locale" defaultValue={locale}>
                  <option value="en">English</option>
                  <option value="zh-CN">简体中文</option>
                </select>
                <input
                  aria-label="Invitation permissions"
                  name="permissions"
                  placeholder={[...grantablePermissions].sort().join(", ") || tr(locale, "No grantable permissions", "没有可授予权限")}
                />
                <button className="primary" disabled={pendingKey !== null || !password} type="submit">{tr(locale, "Invite member", "邀请成员")}</button>
              </form>
            )}
            <div className="manual-list" data-testid="account-invitations">
              {invitations.state.items.map((invitation) => (
                <article className="manual-item" data-testid="account-invitation" key={invitation.id}>
                  <strong>{invitation.email} · {invitation.role} · {invitationStatus(locale, invitation.status)}</strong>
                  <span>{tr(locale, "Expires", "到期时间")} {when(invitation.expiresAt)}</span>
                  {canManageMembers && invitation.status === "pending" && (
                    <button disabled={pendingKey !== null || !password} onClick={() => void mutation(`invite:revoke:${invitation.id}`, async (scope) => {
                      if (!(await confirmIdentity(scope))) return;
                      await api(`/api/v1/account/membership-invitations/${invitation.id}`, { method: "DELETE" });
                      if (!operationIsCurrent(scope)) return;
                      await invitations.refresh();
                      if (!operationIsCurrent(scope)) return;
                      onNotice(tr(locale, `Invitation revoked for ${invitation.email}.`, `已撤销发给 ${invitation.email} 的邀请。`));
                    })}>{tr(locale, "Revoke invitation", "撤销邀请")}</button>
                  )}
                </article>
              ))}
            </div>
          </CollectionShell>
        </>
      )}

      {canReadContacts && (
        <CollectionShell
          title={tr(locale, "Notification Contacts", "通知联系人")}
          state={contacts.state}
          onRefresh={() => void contacts.refresh()}
          onLoadMore={() => void contacts.loadMore()}
          locale={locale}
        >
          <p className="notice">{tr(locale, "Contacts are notification-only records with selected subscriptions. They never become Users, members or sign-in identities.", "联系人是带有选定订阅的通知专用记录，绝不会成为用户、成员或登录身份。")}</p>
          {canManageContacts && (
            <form className="account-access-create" onSubmit={createContact}>
              <input aria-label="Contact display name" name="displayName" placeholder={tr(locale, "Display name", "显示名称")} required />
              <input aria-label="Contact email" name="email" type="email" placeholder={tr(locale, "Contact email", "联系人邮箱")} required />
              <select aria-label="Contact locale" name="locale" defaultValue={locale}>
                <option value="en">English</option>
                <option value="zh-CN">简体中文</option>
              </select>
              <div className="subscription-options">
                {(["billing", "service", "support"] as const).map((subscription) => (
                  <label key={subscription}><input name={subscription} type="checkbox" />{subscription}</label>
                ))}
              </div>
              <button className="primary" disabled={pendingKey !== null} type="submit">{tr(locale, "Create Contact", "创建联系人")}</button>
            </form>
          )}
          <div className="manual-list" data-testid="account-contacts">
            {contacts.state.items.map((contact) => canManageContacts ? (
              <ContactEditor
                key={`${contact.id}:${contact.updatedAt}`}
                contact={contact}
                pending={pendingKey !== null}
                locale={locale}
                onUpdate={(body) => void mutation(`contact:update:${contact.id}`, async (scope) => {
                  await api(`/api/v1/account/contacts/${contact.id}`, { method: "PATCH", body: JSON.stringify(body) });
                  if (!operationIsCurrent(scope)) return;
                  await contacts.refresh();
                  if (!operationIsCurrent(scope)) return;
                  onNotice(tr(locale, `Contact updated for ${contact.email}.`, `已更新联系人 ${contact.email}。`));
                })}
                onRemove={() => void mutation(`contact:remove:${contact.id}`, async (scope) => {
                  await api(`/api/v1/account/contacts/${contact.id}`, { method: "DELETE" });
                  if (!operationIsCurrent(scope)) return;
                  await contacts.refresh();
                  if (!operationIsCurrent(scope)) return;
                  onNotice(tr(locale, `Contact removed for ${contact.email}.`, `已移除联系人 ${contact.email}。`));
                })}
              />
            ) : (
              <article className="manual-item" data-testid="account-contact" key={contact.id}>
                <strong>{contact.displayName} · {contact.email}</strong>
                <span>{tr(locale, "Contact only — no sign-in or Client Account membership", "仅为联系人——没有登录或客户账户成员权限")}</span>
                <span>{contact.notificationSubscriptions.join(", ") || tr(locale, "No notification subscriptions", "未订阅通知")}</span>
              </article>
            ))}
          </div>
        </CollectionShell>
      )}
    </section>
  );
}
