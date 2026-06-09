"use client";

/**
 * 設定ページ (standalone fallback)。
 *
 * 通常は home の SettingsModal から開く。このページは:
 * - 直接 URL アクセス (ブックマーク等) 用
 * - OAuth callback の non-popup フォールバック
 */
import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import SettingsPanel from "@/components/SettingsPanel";

function SettingsInner() {
  const sp = useSearchParams();
  const initialFlash = useMemo(() => {
    // Google 系
    const err = sp.get("error");
    const connected = sp.get("connected");
    if (err) return { kind: "err" as const, text: err };
    if (connected) return { kind: "ok" as const, text: `${connected} を連携しました` };
    // Spotify 系
    const spErr = sp.get("spotify_error");
    const spOk = sp.get("spotify_connected");
    if (spErr) return { kind: "err" as const, text: `Spotify: ${spErr}` };
    if (spOk) return { kind: "ok" as const, text: "Spotify を連携しました" };
    return null;
  }, [sp]);

  return (
    <main className="settings-page">
      <header className="settings-header">
        <Link href="/" className="settings-back" aria-label="ホームへ戻る">
          ← Home
        </Link>
        <h1>設定</h1>
      </header>
      <SettingsPanel initialFlash={initialFlash} />
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<main className="settings-page"><p>Loading…</p></main>}>
      <SettingsInner />
    </Suspense>
  );
}
