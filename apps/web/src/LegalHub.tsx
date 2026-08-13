// SPDX-License-Identifier: AGPL-3.0-or-later

type Locale = "en" | "zh-CN";

export type PublishedLegalDocument = Readonly<{
  documentId: string;
  kind?: "terms" | "aup" | "privacy";
  requestedLocale?: Locale;
  locale: Locale;
  fallback: boolean;
  revision: string;
  version: string;
  title: string;
  body: string;
  publishedAt?: string;
}>;

const kinds = ["terms", "aup", "privacy"] as const;

export function LegalHub({
  active,
  locale,
  documents,
}: Readonly<{
  active: boolean;
  locale: Locale;
  documents: Record<(typeof kinds)[number], PublishedLegalDocument> | null;
}>) {
  if (!active) return null;
  return (
    <section className="catalog legal-hub" aria-label="Published legal documents">
      <p className="eyebrow">
        {locale === "zh-CN" ? "已发布法律版本" : "Published legal versions"}
      </p>
      <h2>{locale === "zh-CN" ? "条款、AUP 与隐私说明" : "Terms, AUP and Privacy"}</h2>
      {!documents ? (
        <p>{locale === "zh-CN" ? "正在加载当前发布版本…" : "Loading current publications…"}</p>
      ) : (
        <div className="product-grid">
          {kinds.map((kind) => {
            const document = documents[kind];
            return (
              <article
                className="product-card legal-card"
                data-testid={`legal-${kind}`}
                data-document-id={document.documentId}
                key={kind}
              >
                <div>
                  <span className="mode">{kind === "aup" ? "AUP" : kind}</span>
                  <h3>{document.title}</h3>
                  <p>{document.body}</p>
                </div>
                <small>
                  {document.locale} · {document.version} · r{document.revision}
                  {document.fallback
                    ? locale === "zh-CN"
                      ? " · 英文回退"
                      : " · English fallback"
                    : ""}
                </small>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
