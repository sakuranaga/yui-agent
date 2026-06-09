"use client";

/**
 * Artifact Links Panel — 各 modal の detail pane 末尾に表示する back-link UI。
 *
 * 同 artifact について「出典 (sources)」「派生 (targets)」 両方向を 1 つの
 * パネルで列挙、クリックで該当 modal にジャンプ。
 *
 * 使い方:
 *   <ArtifactLinksPanel artifactType="todo" artifactId="123" />
 *
 * 各 link クリック → window.dispatchEvent("yui-jump-modal", {
 *   tool: "mail" | "todo" | "contact" | "calendar",
 *   artifactId: "...",
 * }) を発火 → page.tsx 側で該当 modal を開く + (将来) deep-link で該当 item へ。
 *
 * 設計: docs/roadmap.md §6.9 (intent endpoint Phase B — back-link UI)
 */
import { useCallback, useEffect, useState } from "react";

type EnrichedLink = {
  type: "todo" | "mail" | "contact" | "event" | "diary" | "memo";
  id: string;
  label: string;
  sublabel?: string;
  date?: string;
  created_by: "intent" | "manual";
};

type Props = {
  artifactType: "todo" | "mail" | "event" | "contact" | "memo";
  artifactId: string;
};

const TYPE_LABEL: Record<string, string> = {
  todo: "TODO",
  mail: "メール",
  contact: "連絡先",
  event: "予定",
  diary: "日記",
  memo: "メモ",
};

const TYPE_TO_TOOL: Record<string, string> = {
  todo: "todo",
  mail: "mail",
  contact: "contact",
  event: "calendar",
  diary: "diary",
  memo: "memo",
};

function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function ArtifactLinksPanel({ artifactType, artifactId }: Props) {
  const [sources, setSources] = useState<EnrichedLink[]>([]);
  const [targets, setTargets] = useState<EnrichedLink[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!artifactId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/artifact-links/for?artifactType=${encodeURIComponent(artifactType)}&artifactId=${encodeURIComponent(artifactId)}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const json = (await res.json()) as {
        sources: EnrichedLink[];
        targets: EnrichedLink[];
      };
      setSources(json.sources);
      setTargets(json.targets);
    } catch (e) {
      console.warn("[artifact-links-panel] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, [artifactType, artifactId]);

  useEffect(() => {
    // artifact 変化時に紐付き一覧を再 fetch。reload 内 setState は async 後で cascade ではない。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-change fetch
    void reload();
  }, [reload]);

  const jumpTo = (link: EnrichedLink) => {
    const tool = TYPE_TO_TOOL[link.type];
    if (!tool) return;
    window.dispatchEvent(
      new CustomEvent("yui-jump-modal", {
        detail: { tool, artifactId: link.id },
      })
    );
  };

  if (loading && sources.length === 0 && targets.length === 0) return null;
  if (sources.length === 0 && targets.length === 0) return null;

  return (
    <div className="artifact-links-panel">
      {sources.length > 0 && (
        <section className="artifact-links-section">
          <h4 className="artifact-links-head">出典</h4>
          <ul className="artifact-links-list">
            {sources.map((s) => (
              <li key={`${s.type}-${s.id}`}>
                <button
                  type="button"
                  className="artifact-links-row"
                  onClick={() => jumpTo(s)}
                >
                  <span className="artifact-links-row-type">
                    {TYPE_LABEL[s.type]}
                  </span>
                  <span className="artifact-links-row-label">{s.label}</span>
                  {s.sublabel && (
                    <span className="artifact-links-row-sub">{s.sublabel}</span>
                  )}
                  {s.date && (
                    <span className="artifact-links-row-date">{fmtDate(s.date)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {targets.length > 0 && (
        <section className="artifact-links-section">
          <h4 className="artifact-links-head">派生</h4>
          <ul className="artifact-links-list">
            {targets.map((t) => (
              <li key={`${t.type}-${t.id}`}>
                <button
                  type="button"
                  className="artifact-links-row"
                  onClick={() => jumpTo(t)}
                >
                  <span className="artifact-links-row-type">
                    {TYPE_LABEL[t.type]}
                  </span>
                  <span className="artifact-links-row-label">{t.label}</span>
                  {t.sublabel && (
                    <span className="artifact-links-row-sub">{t.sublabel}</span>
                  )}
                  {t.date && (
                    <span className="artifact-links-row-date">{fmtDate(t.date)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
