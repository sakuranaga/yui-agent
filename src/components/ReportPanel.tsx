"use client";

/**
 * Floating ノートパネル。
 *
 * - 通常 (折りたたみ): 右下にノートアイコンだけ
 * - 展開: アバター上にオーバーレイで markdown を表示
 *   - 左上に動的タイトルタグ (VN セリフボックス風)
 *   - 右上に閉じるボタン
 *   - 右下に ← / → ナビ + i/N インジケータ (複数履歴対応)
 * - 新しい report が来たら最新表示に切り替えて自動展開
 * - 履歴は親 (page.tsx) が in-memory で最新 10 件保持 (永続化しない)
 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useModalTransition } from "@/lib/useModalTransition";

export type Report = {
  title: string;
  markdown: string;
  /** 受信タイムスタンプ (ms)。新着判定用 */
  receivedAt: number;
};

type Props = {
  /** 新しい順 (newest first) の配列。空配列なら未生成扱い。 */
  reports: Report[];
};

export default function ReportPanel({ reports }: Props) {
  const [open, setOpen] = useState(false);
  // 表示中の index (0 = 最新)。新着で 0 にリセット。
  const [viewIndex, setViewIndex] = useState(0);
  const lastSeenAtRef = useRef<number>(0);

  const latest = reports[0] ?? null;
  // 範囲外ガード (履歴がリセットされた等)
  const safeIndex = Math.min(viewIndex, Math.max(reports.length - 1, 0));
  const current = reports[safeIndex] ?? null;

  // 新しい report が来たら自動展開 + 最新に飛ばす
  useEffect(() => {
    if (!latest) return;
    if (latest.receivedAt > lastSeenAtRef.current) {
      lastSeenAtRef.current = latest.receivedAt;
      setViewIndex(0);
      setOpen(true);
    }
  }, [latest]);

  // 開閉 transition: closing 中も描画して fade-out animation を見せる
  const { mounted, closing } = useModalTransition(open);

  // まだ何もない & 閉じてる → 何も描画しない (空のアイコンは出さない)
  if (reports.length === 0 && !mounted) return null;

  if (!mounted) {
    return (
      <button
        type="button"
        className="report-panel-toggle"
        onClick={() => setOpen(true)}
        aria-label="メモを開く"
        title={latest ? `メモ: ${latest.title}` : "メモ"}
      >
        <NoteIcon />
      </button>
    );
  }

  const canGoOlder = safeIndex < reports.length - 1;
  const canGoNewer = safeIndex > 0;

  return (
    <div className={`report-panel ${closing ? "report-panel-closing" : ""}`} role="dialog" aria-label="結衣のメモ">
      <div className="report-panel-titletab">
        <NoteIcon size={14} />
        <span>{current?.title ?? "メモ"}</span>
      </div>
      <button
        type="button"
        className="report-panel-close"
        onClick={() => setOpen(false)}
        aria-label="メモを閉じる"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>
      <div className="report-panel-body">
        {current ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // ニュース等の外部リンクを新規タブで開く (Yui アプリ内ナビは絶対パスなので
              // ホスト一致で同タブ維持、それ以外は別タブ + opener/referrer は剥がす)
              a: ({ href, children, ...rest }) => {
                const isExternal =
                  typeof href === "string" && /^https?:\/\//i.test(href);
                if (isExternal) {
                  return (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      {...rest}
                    >
                      {children}
                    </a>
                  );
                }
                return (
                  <a href={href} {...rest}>
                    {children}
                  </a>
                );
              },
            }}
          >
            {current.markdown}
          </ReactMarkdown>
        ) : (
          <p className="report-panel-empty">
            結衣がお調べした内容はこちらに表示されます。
          </p>
        )}
      </div>
      {reports.length > 1 && (
        <div className="report-panel-nav">
          <button
            type="button"
            className="report-panel-nav-btn"
            disabled={!canGoOlder}
            onClick={() => setViewIndex((i) => i + 1)}
            aria-label="前のメモ"
            title="前のメモ"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="report-panel-nav-index">
            {safeIndex + 1} / {reports.length}
          </span>
          <button
            type="button"
            className="report-panel-nav-btn"
            disabled={!canGoNewer}
            onClick={() => setViewIndex((i) => Math.max(0, i - 1))}
            aria-label="次のメモ"
            title="次のメモ"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

function NoteIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  );
}
