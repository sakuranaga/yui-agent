"use client";

/**
 * 設定パネル本体 (中身だけ、page chrome や modal chrome は含まない)。
 *
 * - /settings ページ (standalone) で使用 (SettingsModal は別ファイルで game-style)
 * - 各セクションは個別 component に切り出し済 (PersonaSection / ThemeSection /
 *   GoogleIntegrationSection)
 */
import PersonaSection from "./PersonaSection";
import ThemeSection from "./ThemeSection";
import GoogleIntegrationSection from "./GoogleIntegrationSection";
import SpotifyIntegrationSection from "./SpotifyIntegrationSection";

type Props = {
  initialFlash?: { kind: "ok" | "err"; text: string } | null;
};

export default function SettingsPanel({ initialFlash = null }: Props) {
  return (
    <>
      <ThemeSection />
      <PersonaSection />
      <GoogleIntegrationSection initialFlash={initialFlash} />
      <SpotifyIntegrationSection initialFlash={initialFlash} />
    </>
  );
}
