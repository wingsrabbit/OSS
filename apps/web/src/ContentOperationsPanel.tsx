// SPDX-License-Identifier: AGPL-3.0-or-later

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

type Locale = "en" | "zh-CN";
type Entry = Readonly<{
  id: string;
  slug: string;
  kind: string;
  audience: string;
  locale: Locale;
  current_revision_id: string | null;
  revision_sequence: string;
}>;
type Revision = Readonly<{
  id: string;
  entry_id: string;
  locale: Locale;
  revision: string;
  title: string;
  summary: string;
  body: string;
  status_level: string;
  published_at: string | null;
  retired_at: string | null;
}>;
type LegalRevision = Readonly<{
  id: string;
  kind: "terms" | "aup" | "privacy";
  locale: Locale;
  revision: string;
  version: string;
  title: string;
  body: string;
  published_at: string | null;
  retired_at: string | null;
  current: boolean;
}>;

type Snapshot = Readonly<{
  entries: Entry[];
  revisions: Revision[];
  legalDocuments: LegalRevision[];
}>;

export function ContentOperationsPanel({
  active,
  locale,
  canRead,
  canManage,
  accessFingerprint,
  onNotice,
  onError,
}: Readonly<{
  active: boolean;
  locale: Locale;
  canRead: boolean;
  canManage: boolean;
  accessFingerprint: string;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}>) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ entries: [], revisions: [], legalDocuments: [] });
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    if (!active || !canRead) {
      setSnapshot({ entries: [], revisions: [], legalDocuments: [] });
      return;
    }
    setSnapshot(await api<Snapshot>("/api/v1/admin/content"));
  }, [active, canRead]);

  useEffect(() => {
    void refresh().catch((caught: unknown) =>
      onError(caught instanceof Error ? caught.message : "Content Operations is unavailable"),
    );
  }, [accessFingerprint, onError, refresh]);

  useEffect(() => {
    setPassword("");
  }, [accessFingerprint, canManage]);

  async function mutate(path: string, body: Record<string, unknown>): Promise<boolean> {
    if (!canManage || password.length === 0) return false;
    setPending(true);
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      await api(path, { method: "POST", body: JSON.stringify(body) });
      setPassword("");
      onNotice(locale === "zh-CN" ? "内容事实已提交。" : "Content fact committed.");
      try {
        await refresh();
      } catch (caught) {
        const detail = caught instanceof Error ? caught.message : "Content Operations is unavailable";
        onError(
          locale === "zh-CN"
            ? `内容事实已提交，但历史刷新失败：${detail}`
            : `Content fact committed, but history refresh failed: ${detail}`,
        );
      }
      return true;
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Content mutation failed");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function createEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const committed = await mutate("/api/v1/admin/content/entries", {
      slug: form.get("slug"),
      kind: form.get("kind"),
      audience: form.get("audience"),
      locale: form.get("locale"),
      title: form.get("title"),
      summary: form.get("summary"),
      body: form.get("body"),
      statusLevel: form.get("statusLevel"),
      reason: form.get("reason"),
    });
    if (committed) formElement.reset();
  }

  async function createContentRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const entryId = String(form.get("entryId") ?? "");
    if (!entryId) return;
    const committed = await mutate(`/api/v1/admin/content/entries/${entryId}/revisions`, {
      locale: form.get("locale"),
      title: form.get("title"),
      summary: form.get("summary"),
      body: form.get("body"),
      statusLevel: form.get("statusLevel"),
      reason: form.get("reason"),
    });
    if (committed) formElement.reset();
  }

  async function createLegalRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const committed = await mutate("/api/v1/admin/legal/documents", {
      kind: form.get("kind"),
      locale: form.get("locale"),
      version: form.get("version"),
      title: form.get("title"),
      body: form.get("body"),
      reason: form.get("reason"),
    });
    if (committed) formElement.reset();
  }

  if (!active || !canRead) return null;
  const uniqueEntries = [...new Map(snapshot.entries.map((entry) => [entry.id, entry])).values()];
  const entryById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const copy = locale === "zh-CN"
    ? {
        ariaLabel: "内容运营",
        stableSlug: "稳定标识",
        announcement: "公告",
        knowledgeBase: "知识库",
        networkStatus: "网络状态",
        publicAudience: "公开",
        customerAudience: "客户",
        english: "英语",
        simplifiedChinese: "简体中文",
        title: "标题",
        summary: "摘要",
        contentBody: "合成 Mock-only 正文",
        legalBody: "合成 Mock-only 法律正文",
        information: "信息",
        operational: "运行正常",
        maintenance: "维护中",
        degraded: "服务降级",
        resolved: "已恢复",
        creationReason: "创建原因",
        revisionReason: "版本原因",
        createDraft: "创建不可变草稿",
        appendDraft: "追加草稿",
        appendLegalDraft: "追加法律草稿",
        publish: "发布",
        retire: "退役",
        terms: "条款",
        privacy: "隐私说明",
      }
    : {
        ariaLabel: "Content Operations",
        stableSlug: "stable-slug",
        announcement: "Announcement",
        knowledgeBase: "Knowledge Base",
        networkStatus: "Network Status",
        publicAudience: "Public",
        customerAudience: "Customer",
        english: "English",
        simplifiedChinese: "Simplified Chinese",
        title: "Title",
        summary: "Summary",
        contentBody: "Synthetic Mock-only body",
        legalBody: "Synthetic Mock-only legal body",
        information: "Information",
        operational: "Operational",
        maintenance: "Maintenance",
        degraded: "Degraded",
        resolved: "Resolved",
        creationReason: "Creation reason",
        revisionReason: "Revision reason",
        createDraft: "Create immutable draft",
        appendDraft: "Append draft",
        appendLegalDraft: "Append legal draft",
        publish: "Publish",
        retire: "Retire",
        terms: "Terms",
        privacy: "Privacy",
      };
  const entryContextLabel = (entryId: string): string => {
    const entry = entryById.get(entryId);
    if (!entry) return locale === "zh-CN" ? "未知内容目标" : "Unknown Content target";
    const kind = entry.kind === "announcement"
      ? copy.announcement
      : entry.kind === "knowledge_base"
        ? copy.knowledgeBase
        : copy.networkStatus;
    const audience = entry.audience === "customer" ? copy.customerAudience : copy.publicAudience;
    return `${entry.slug} · ${kind} · ${audience}`;
  };
  return (
    <section className="order-panel content-operations" aria-label={copy.ariaLabel} data-testid="content-operations">
      <div>
        <p className="eyebrow">{locale === "zh-CN" ? "Staff 内容运营" : "Staff Content Operations"}</p>
        <h2>{locale === "zh-CN" ? "不可变版本与发布事实" : "Immutable revisions and publication facts"}</h2>
        <p>
          {locale === "zh-CN"
            ? "历史内容和法律版本永不编辑；新版本通过发布或退役事实改变当前投影。"
            : "Historical Content and legal revisions are never edited. Publication and retirement facts change the current projection."}
        </p>
      </div>

      {canManage && (
        <label>
          {locale === "zh-CN" ? "当前密码确认" : "Current password confirmation"}
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
      )}

      <div className="form-columns">
        {canManage && (
          <form onSubmit={createEntry}>
            <h3>{locale === "zh-CN" ? "创建内容条目" : "Create Content entry"}</h3>
            <input name="slug" placeholder={copy.stableSlug} required />
            <select name="kind" aria-label={locale === "zh-CN" ? "内容类型" : "Content kind"} defaultValue="announcement">
              <option value="announcement">{copy.announcement}</option>
              <option value="knowledge_base">{copy.knowledgeBase}</option>
              <option value="network_status">{copy.networkStatus}</option>
            </select>
            <select name="audience" aria-label={locale === "zh-CN" ? "受众" : "Audience"} defaultValue="public">
              <option value="public">{copy.publicAudience}</option>
              <option value="customer">{copy.customerAudience}</option>
            </select>
            <select name="locale" aria-label={locale === "zh-CN" ? "语言" : "Locale"} defaultValue="en"><option value="en">{copy.english}</option><option value="zh-CN">{copy.simplifiedChinese}</option></select>
            <input name="title" placeholder={copy.title} required />
            <input name="summary" placeholder={copy.summary} />
            <textarea name="body" placeholder={copy.contentBody} required />
            <select name="statusLevel" aria-label={locale === "zh-CN" ? "状态级别" : "Status level"} defaultValue="information">
              <option value="information">{copy.information}</option>
              <option value="operational">{copy.operational}</option>
              <option value="maintenance">{copy.maintenance}</option>
              <option value="degraded">{copy.degraded}</option>
              <option value="resolved">{copy.resolved}</option>
            </select>
            <input name="reason" placeholder={copy.creationReason} required />
            <button disabled={pending || password.length === 0}>{copy.createDraft}</button>
          </form>
        )}

        {canManage && uniqueEntries.length > 0 && (
          <form onSubmit={createContentRevision}>
            <h3>{locale === "zh-CN" ? "追加内容版本" : "Append Content revision"}</h3>
            <select name="entryId" aria-label={locale === "zh-CN" ? "内容条目" : "Content entry"}>{uniqueEntries.map((entry) => <option value={entry.id} key={entry.id}>{entry.slug}</option>)}</select>
            <select name="locale" aria-label={locale === "zh-CN" ? "语言" : "Locale"} defaultValue="en"><option value="en">{copy.english}</option><option value="zh-CN">{copy.simplifiedChinese}</option></select>
            <input name="title" placeholder={copy.title} required />
            <input name="summary" placeholder={copy.summary} />
            <textarea name="body" placeholder={copy.contentBody} required />
            <select name="statusLevel" aria-label={locale === "zh-CN" ? "状态级别" : "Status level"} defaultValue="information">
              <option value="information">{copy.information}</option>
              <option value="operational">{copy.operational}</option>
              <option value="maintenance">{copy.maintenance}</option>
              <option value="degraded">{copy.degraded}</option>
              <option value="resolved">{copy.resolved}</option>
            </select>
            <input name="reason" placeholder={copy.revisionReason} required />
            <button disabled={pending || password.length === 0}>{copy.appendDraft}</button>
          </form>
        )}

        {canManage && (
          <form onSubmit={createLegalRevision}>
            <h3>{locale === "zh-CN" ? "追加法律版本" : "Append legal revision"}</h3>
            <select name="kind" aria-label={locale === "zh-CN" ? "法律类型" : "Legal kind"} defaultValue="privacy"><option value="privacy">{copy.privacy}</option><option value="terms">{copy.terms}</option><option value="aup">AUP</option></select>
            <select name="locale" aria-label={locale === "zh-CN" ? "语言" : "Locale"} defaultValue="en"><option value="en">{copy.english}</option><option value="zh-CN">{copy.simplifiedChinese}</option></select>
            <input name="version" placeholder="mock-lab-v2" required />
            <input name="title" placeholder={copy.title} required />
            <textarea name="body" placeholder={copy.legalBody} required />
            <input name="reason" placeholder={copy.revisionReason} required />
            <button disabled={pending || password.length === 0}>{copy.appendLegalDraft}</button>
          </form>
        )}
      </div>

      <div className="product-grid">
        {snapshot.revisions.map((revision) => (
          <article className="product-card" key={revision.id}>
            <div><span className="mode" data-testid={`content-revision-context-${revision.id}`}>{entryContextLabel(revision.entry_id)} · {revision.locale} · r{revision.revision}</span><h3>{revision.title}</h3><p>{revision.summary}</p><p className="revision-body" data-testid={`content-revision-body-${revision.id}`}>{revision.body}</p></div>
            <small>{revision.published_at ? revision.retired_at ? locale === "zh-CN" ? "已退役" : "retired" : locale === "zh-CN" ? "已发布" : "published" : locale === "zh-CN" ? "草稿" : "draft"}</small>
            {canManage && !revision.published_at && <button disabled={pending || password.length === 0} onClick={() => void mutate(`/api/v1/admin/content/revisions/${revision.id}/publication`, { reason: "Publish reviewed synthetic Content revision" })}>{copy.publish}</button>}
            {canManage && revision.published_at && !revision.retired_at && <button disabled={pending || password.length === 0} onClick={() => void mutate(`/api/v1/admin/content/revisions/${revision.id}/retirement`, { reason: "Retire current synthetic Content revision" })}>{copy.retire}</button>}
          </article>
        ))}
        {snapshot.legalDocuments.map((document) => (
          <article className="product-card" key={document.id} data-testid={`legal-history-${document.id}`}>
            <div><span className="mode">{document.kind === "aup" ? "AUP" : document.kind === "terms" ? copy.terms : copy.privacy} · {document.locale} · r{document.revision}</span><h3>{document.title}</h3><p>{document.version}</p><p className="revision-body" data-testid={`legal-revision-body-${document.id}`}>{document.body}</p></div>
            <small>{document.current ? locale === "zh-CN" ? "当前版本" : "current" : document.retired_at ? locale === "zh-CN" ? "已退役" : "retired" : locale === "zh-CN" ? "草稿" : "draft"}</small>
            {canManage && !document.published_at && <button disabled={pending || password.length === 0} onClick={() => void mutate(`/api/v1/admin/legal/documents/${document.id}/publication`, { reason: "Publish reviewed synthetic legal revision" })}>{copy.publish}</button>}
            {canManage && document.current && <button disabled={pending || password.length === 0} onClick={() => void mutate(`/api/v1/admin/legal/documents/${document.id}/retirement`, { reason: "Retire current synthetic legal revision" })}>{copy.retire}</button>}
          </article>
        ))}
      </div>
    </section>
  );
}
