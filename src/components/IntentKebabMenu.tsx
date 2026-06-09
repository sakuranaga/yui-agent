"use client";

/**
 * Intent Kebab Menu — 各 modal の item detail で「他ツールに送る」menu を
 * 共通実装。MailModal の MailKebabMenu を generic 化したもの。
 *
 * 使い方:
 *   <IntentKebabMenu
 *     sourcePayload={{ type: "todo", data: { title: ..., note: ... } }}
 *     sourceRefId="123"
 *     targets={["event"]}
 *   />
 *
 * クリック → /api/intent → response.dedupCheck.existing なら inline toast、
 * else yui-intent-draft event 発火 → page.tsx が該当 modal を pre-fill 状態で開く。
 *
 * 設計: docs/roadmap.md §6.9 (intent endpoint Phase B)
 */
import { useEffect, useRef, useState } from "react";
import type { ArtifactPayload } from "@/lib/artifact-payloads";

type Target = "todo" | "event" | "contact" | "memo";

const TARGET_LABEL: Record<Target, string> = {
  todo: "TODO に送る",
  event: "予定に作る",
  contact: "連絡先に登録",
  memo: "メモに送る",
};

type Props = {
  sourcePayload: ArtifactPayload;
  sourceRefId: string;
  targets: Target[];
  /** chip 等のラベル文 (Mail 用「・・・」、TODO 用「他へ」等)。省略時は • • • */
  buttonLabel?: string;
  /** popover の位置調整 — 親が relative であることが前提 */
  position?: "right" | "left";
};

export default function IntentKebabMenu({
  sourcePayload,
  sourceRefId,
  targets,
  position = "right",
}: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const sendTo = async (target: Target) => {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      const res = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          sourceRefId,
          source: sourcePayload,
        }),
      });
      const json = (await res.json()) as {
        draft: Record<string, unknown> | null;
        inheritedProjects?: Array<{ id: number; name: string; color: string | null }>;
        inheritedProjectIds?: number[];
        dedupCheck?: { existing: { id: number; identifier: string; title: string } | null };
        warning?: string;
      };
      if (target === "todo" && json.dedupCheck?.existing) {
        const e = json.dedupCheck.existing;
        setToast(`既に登録されています: ${e.identifier}「${e.title}」`);
        return;
      }
      window.dispatchEvent(
        new CustomEvent("yui-intent-draft", {
          detail: {
            target,
            draft: json.draft,
            inheritedProjects: json.inheritedProjects ?? [],
            inheritedProjectIds:
              json.inheritedProjectIds ?? (json.inheritedProjects ?? []).map((p) => p.id),
            sourceType: sourcePayload.type,
            sourceId: sourceRefId,
            warning: json.warning,
          },
        })
      );
    } catch (e) {
      console.warn("[intent-kebab] failed:", e);
      setToast("失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`intent-kebab intent-kebab-${position}`} ref={ref}>
      {toast && (
        <div className="intent-kebab-toast" role="status">
          <span>{toast}</span>
          <button
            type="button"
            className="intent-kebab-toast-close"
            onClick={() => setToast(null)}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
      )}
      <button
        type="button"
        className="intent-kebab-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="他のツールへ送る"
        title="他のツールへ送る"
        disabled={busy}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open && (
        <div className="intent-kebab-menu" role="menu">
          {targets.map((t) => (
            <button
              key={t}
              type="button"
              className="intent-kebab-item"
              onClick={() => void sendTo(t)}
              disabled={busy}
            >
              {busy ? "Yui が整えています…" : TARGET_LABEL[t]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
