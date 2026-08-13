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

  async function mutate(path: string, body: Record<string, unknown>): Promise<void> {
    if (!canManage || password.length === 0) return;
    setPending(true);
    try {
      await api("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      await api(path, { method: "POST", body: JSON.stringify(body) });
      setPassword("");
      await refresh();
      onNotice(locale === "zh-CN" ? "内容事实已提交。" : "Content fact committed.");
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Content mutation failed");
    } finally {
      setPending(false);
    }
  }

  async function createEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate("/api/v1/admin/content/entries", {
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
    event.currentTarget.reset();
  }

  async function createContentRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const entryId = String(form.get("entryId") ?? "");
    if (!entryId) return;
    await mutate(`/api/v1/admin/content/entries/${entryId}/revisions`, {
      locale: form.get("locale"),
      title: form.get("title"),
      summary: form.get("summary"),
      body: form.get("body"),
      statusLevel: form.get("statusLevel"),
      reason: form.get("reason"),
    });
    event.currentTarget.reset();
  }

  async function createLegalRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate("/api/v1/admin/legal/documents", {
      kind: form.get("kind"),
      locale: form.get("locale"),
      version: form.get("version"),
      title: form.get("title"),
      body: form.get("body"),
      reason: form.get("reason"),
    });
    event.currentTarget.reset();
  }

  if (!active || !canRead) return null;
  const uniqueEntries = [...new Map(snapshot.entries.map((entry) => [entry.id, entry])).values()];
  return (
    <section className="order-panel content-operations" aria-label="Content Operations" data-testid="content-operations">
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
            <input name="slug" placeholder="stable-slug" required />
            <select name="kind" defaultValue="announcement">
              <option value="announcement">Announcement</option>
              <option value="knowledge_base">Knowledge Base</option>
              <option value="network_status">Network Status</option>
            </select>
            <select name="audience" defaultValue="public">
              <option value="public">Public</option>
              <option value="customer">Customer</option>
            </select>
            <select name="locale" defaultValue="en"><option value="en">English</option><option value="zh-CN">简体中文</option></select>
            <input name="title" placeholder="Title" required />
            <input name="summary" placeholder="Summary" />
            <textarea name="body" placeholder="Synthetic Mock-only body" required />
            <select name="statusLevel" defaultValue="information">
              <option value="information">Information</option>
              <option value="operational">Operational</option>
              <option value="maintenance">Maintenance</option>
              <option value="degraded">Degraded</option>
              <option value="resolved">Resolved</option>
            </select>
            <input name="reason" placeholder="Creation reason" required />
            <button disabled={pending || password.length === 0}>Create immutable draft</button>
          </form>
        )}

        {canManage && uniqueEntries.length > 0 && (
          <form onSubmit={createContentRevision}>
            <h3>{locale === "zh-CN" ? "追加内容版本" : "Append Content revision"}</h3>
            <select name="entryId">{uniqueEntries.map((entry) => <option value={entry.id} key={entry.id}>{entry.slug}</option>)}</select>
            <select name="locale" defaultValue="en"><option value="en">English</option><option value="zh-CN">简体中文</option></select>
            <input name="title" placeholder="Title" required />
            <input name="summary" placeholder="Summary" />
            <textarea name="body" placeholder="Synthetic Mock-only body" required />
            <select name="statusLevel" defaultValue="information">
              <option value="information">Information</option>
              <option value="operational">Operational</option>
              <option value="maintenance">Maintenance</option>
              <option value="degraded">Degraded</option>
              <option value="resolved">Resolved</option>
            </select>
            <input name="reason" placeholder="Revision reason" required />
            <button disabled={pending || password.length === 0}>Append draft</button>
          </form>
        )}

        {canManage && (
          <form onSubmit={createLegalRevision}>
            <h3>{locale === "zh-CN" ? "追加法律版本" : "Append legal revision"}</h3>
            <select name="kind" defaultValue="privacy"><option value="privacy">Privacy</option><option value="terms">Terms</option><option value="aup">AUP</option></select>
            <select name="locale" defaultValue="en"><option value="en">English</option><option value="zh-CN">简体中文</option></select>
            <input name="version" placeholder="mock-lab-v2" required />
            <input name="title" placeholder="Title" required />
            <textarea name="body" placeholder="Synthetic Mock-only legal body" required />
            <input name="reason" placeholder="Revision reason" required />
            <button disabled={pending || password.length === 0}>Append legal draft</button>
          </form>
        )}
      </div>

      <div className="product-grid">
        {snapshot.revisions.map((revision) => (
          <article className="product-card" key={revision.id}>
            <div><span className="mode">{revision.locale} · r{revision.revision}</span><h3>{revision.title}</h3><p>{revision.summary}</p></div>
            <small>{revision.published_at ? revision.retired_at ? "retired" : "published" : "draft"}</small>
            {canManage && !revision.published_at && <button disabled={pending || password.length === 0} onClick={() => void mutate(`/api/v1/admin/content/revisions/${revision.id}/publication`, { reason: "Publish reviewed synthetic Content revision" })}>Publish</button>}
            {canManage && revision.published_at && !revision.retired_at && <button disabled={pending || password.length === 0} onClick={() => void mutate(`/api/v1/admin/content/revisions/${revision.id}/retirement`, { reason: "Retire current synthetic Content revision" })}>Retire</button>}
          </article>
        ))}
        {snapshot.legalDocuments.map((document) => (
          <article className="product-card" key={document.id} data-testid={`legal-history-${document.id}`}>
            <div><span className="mode">{document.kind} · {document.locale} · r{document.revision}</span><h3>{document.title}</h3><p>{document.version}</p></div>
            <small>{document.current ? "current" : document.retired_at ? "retired" : "draft"}</small>
            {canManage && !document.published_at && <button disabled={pending || password.length === 0} onClick={() => void mutate(`/api/v1/admin/legal/documents/${document.id}/publication`, { reason: "Publish reviewed synthetic legal revision" })}>Publish</button>}
            {canManage && document.current && <button disabled={pending || password.length === 0} onClick={() => void mutate(`/api/v1/admin/legal/documents/${document.id}/retirement`, { reason: "Retire current synthetic legal revision" })}>Retire</button>}
          </article>
        ))}
      </div>
    </section>
  );
}
