"use client";

/**
 * 設定モーダル — game-style サイドバータブ。
 *
 * 左: 縦アイコンタブ (秘書 / 見た目 / プロジェクト / 連携 / データ)
 * 右: 選択中タブの内容
 *
 * - backdrop / ESC / 円形 × で閉じる
 * - 体裁は TodoModal と同テイスト (オフホワイト + accent 額縁 + 円形 close)
 * - 各タブの中身は既存 component (PersonaSection / ThemeSection) を流用。
 *   Google 連携と未実装タブは Phase B 以降で内容を埋める。
 */
import { useEffect, useRef, useState } from "react";
import PersonaSection from "./PersonaSection";
import ThemeSection from "./ThemeSection";
import ProjectsSection from "./ProjectsSection";
import GoogleIntegrationSection from "./GoogleIntegrationSection";
import SpotifyIntegrationSection from "./SpotifyIntegrationSection";
import DictionarySection from "./DictionarySection";
import NotificationsSection from "./NotificationsSection";
import NewsSourcesSection from "./NewsSourcesSection";
import NewsCurationSection from "./NewsCurationSection";
import AiSettingsSection from "./AiSettingsSection";
import MailSettingsSection from "./MailSettingsSection";
import DataSection from "./DataSection";
import MemorySection from "./MemorySection";
import { useModalTransition } from "@/lib/useModalTransition";

type TabId = "persona" | "appearance" | "projects" | "integrations" | "notifications" | "news" | "mail" | "dictionary" | "memory" | "ai" | "data";

type TabDef = {
  id: TabId;
  label: string;
  icon: (size?: number) => React.ReactNode;
};

const TABS: TabDef[] = [
  {
    id: "persona",
    label: "秘書",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
      </svg>
    ),
  },
  {
    id: "appearance",
    label: "見た目",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {/* palette (lucide-react 同形状) */}
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.94 0 1.66-.75 1.66-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.65 1.65 0 0 1 1.67-1.67H16.5c3 0 5.5-2.5 5.5-5.56C22 6.01 17.5 2 12 2Z" />
        <circle cx="6.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
        <circle cx="8.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
        <circle cx="13.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
        <circle cx="17.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: "projects",
    label: "プロジェクト",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      </svg>
    ),
  },
  {
    id: "integrations",
    label: "連携",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {/* chain link */}
        <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" />
        <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5" />
      </svg>
    ),
  },
  {
    id: "notifications",
    label: "通知",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {/* bell */}
        <path d="M18 17H6a2 2 0 0 1-1.8-2.85L5 13V9a7 7 0 0 1 14 0v4l.8 1.15A2 2 0 0 1 18 17Z" />
        <path d="M10 21a2 2 0 0 0 4 0" />
      </svg>
    ),
  },
  {
    id: "news",
    label: "ニュース",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {/* newspaper */}
        <rect x="3" y="5" width="18" height="14" rx="1.5" />
        <line x1="7" y1="9" x2="17" y2="9" />
        <line x1="7" y1="13" x2="13" y2="13" />
        <line x1="7" y1="16" x2="17" y2="16" />
      </svg>
    ),
  },
  {
    id: "mail",
    label: "メール",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 7l9 6 9-6" />
      </svg>
    ),
  },
  {
    id: "dictionary",
    label: "読み方",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {/* book / dictionary */}
        <path d="M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3V4z" />
        <path d="M4 17a3 3 0 0 1 3-3h12" />
        <line x1="8" y1="8" x2="14" y2="8" />
      </svg>
    ),
  },
  {
    id: "memory",
    label: "記憶",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {/* brain (simplified) */}
        <path d="M9 4a3 3 0 0 0-3 3v2a3 3 0 0 0-3 3 3 3 0 0 0 3 3v2a3 3 0 0 0 3 3" />
        <path d="M15 4a3 3 0 0 1 3 3v2a3 3 0 0 1 3 3 3 3 0 0 1-3 3v2a3 3 0 0 1-3 3" />
        <line x1="12" y1="6" x2="12" y2="20" />
      </svg>
    ),
  },
  {
    id: "ai",
    label: "AI",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {/* cute robot head: antenna + body + side knobs + eyes */}
        <line x1="12" y1="2" x2="12" y2="5" />
        <circle cx="12" cy="2" r="0.6" fill="currentColor" stroke="none" />
        <rect x="5" y="6" width="14" height="12" rx="2.5" />
        <line x1="3" y1="12" x2="5" y2="12" />
        <line x1="19" y1="12" x2="21" y2="12" />
        <circle cx="9.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="14.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: "data",
    label: "データ",
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
        <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </svg>
    ),
  },
];

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function SettingsModal({ open, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { mounted, closing } = useModalTransition(open);
  const [active, setActive] = useState<TabId>("persona");

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!mounted) return null;

  const activeDef = TABS.find((t) => t.id === active) ?? TABS[0];

  return (
    <div
      className={`settings-modal-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`settings-modal ${closing ? "modal-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className="settings-modal-close"
          onClick={onClose}
          aria-label="閉じる"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <aside className="settings-sidebar" aria-label="設定カテゴリ">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`settings-tab ${active === t.id ? "active" : ""}`}
              onClick={() => setActive(t.id)}
              aria-current={active === t.id ? "page" : undefined}
            >
              {t.icon()}
              <span>{t.label}</span>
            </button>
          ))}
        </aside>

        <div className="settings-content">
          <header className="settings-content-header">
            {activeDef.icon()}
            <h2 id="settings-modal-title">{activeDef.label}</h2>
          </header>
          <div className="settings-content-body">
            {active === "persona" && <PersonaSection />}
            {active === "appearance" && <ThemeSection />}
            {active === "projects" && <ProjectsSection />}
            {active === "integrations" && (
              <>
                <GoogleIntegrationSection />
                <SpotifyIntegrationSection />
              </>
            )}
            {active === "notifications" && <NotificationsSection />}
            {active === "news" && (
              <div className="news-settings-tab">
                <NewsCurationSection />
                <hr className="news-settings-divider" />
                <NewsSourcesSection />
              </div>
            )}
            {active === "dictionary" && <DictionarySection />}
            {active === "memory" && <MemorySection />}
            {active === "ai" && <AiSettingsSection />}
            {active === "mail" && <MailSettingsSection />}
            {active === "data" && <DataSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
