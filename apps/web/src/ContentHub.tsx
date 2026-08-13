// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { api } from "./api.js";

type Locale = "en" | "zh-CN";

export type ContentItem = Readonly<{
  entryId: string;
  revisionId: string;
  slug: string;
  kind: "announcement" | "knowledge_base" | "network_status";
  audience: "public" | "customer";
  requestedLocale: Locale;
  locale: Locale;
  fallback: boolean;
  revision: string;
  title: string;
  summary: string;
  body: string;
  statusLevel: string;
  publishedAt: string;
}>;

export function ContentHub({
  locale,
  customer,
  active,
  onError,
}: Readonly<{
  locale: Locale;
  customer: boolean;
  active: boolean;
  onError: (message: string) => void;
}>) {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) {
      setItems([]);
      return;
    }
    let current = true;
    setItems([]);
    setLoading(true);
    const endpoint = customer ? "/api/v1/customer/content" : "/api/v1/content";
    void api<{ items: ContentItem[] }>(`${endpoint}?locale=${locale}`)
      .then((result) => {
        if (current) setItems(result.items);
      })
      .catch((caught: unknown) => {
        if (current) onError(caught instanceof Error ? caught.message : "Content is unavailable");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [active, customer, locale, onError]);

  if (!active) return null;
  return (
    <section className="catalog content-hub" aria-label={customer ? "Customer content" : "Public content"}>
      <p className="eyebrow">
        {customer
          ? locale === "zh-CN" ? "客户内容中心" : "Customer content hub"
          : locale === "zh-CN" ? "公开内容" : "Public content"}
      </p>
      <h2>{locale === "zh-CN" ? "公告、知识库与 Mock 网络状态" : "Announcements, knowledge and Mock network status"}</h2>
      {loading && <p>{locale === "zh-CN" ? "正在加载已发布内容…" : "Loading published content…"}</p>}
      {!loading && items.length === 0 && (
        <p>{locale === "zh-CN" ? "当前没有已发布内容。" : "No content is currently published."}</p>
      )}
      <div className="product-grid">
        {items.map((item) => (
          <article className="product-card content-card" key={item.entryId} data-testid={`content-${item.slug}`}>
            <div>
              <span className="mode">{item.kind.replaceAll("_", " ")}</span>
              {item.kind === "network_status" && (
                <span className={`pill ${item.statusLevel === "operational" ? "good" : ""}`}>
                  {item.statusLevel}
                </span>
              )}
              <h3>{item.title}</h3>
              {item.summary && <p><strong>{item.summary}</strong></p>}
              <p>{item.body}</p>
            </div>
            <small>
              {item.locale} · r{item.revision}
              {item.fallback ? locale === "zh-CN" ? " · 英文回退" : " · English fallback" : ""}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}
