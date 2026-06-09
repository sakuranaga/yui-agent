"use client";

/**
 * テーマ切替 UI。
 * - localStorage の "vroid-theme" に保存
 * - body[data-theme="..."] でグローバル適用
 * - ThemeProvider が page mount 時に保存値を読んで適用
 */
import { useState } from "react";

const STORAGE_KEY = "vroid-theme";

type ThemeId = "purple" | "sakura" | "blue" | "matcha" | "brown" | "crimson";

type Theme = {
  id: ThemeId;
  name: string;
  swatch: string;        // 主色 (プレビュー swatch 用)
  swatch2: string;       // 副色 (グラデーション参考)
  description: string;
};

const THEMES: Theme[] = [
  { id: "purple", name: "紫 (デフォルト)", swatch: "#8b5cf6", swatch2: "#6366f1", description: "落ち着いた紫、知的でやわらか" },
  { id: "sakura", name: "桜", swatch: "#ec4899", swatch2: "#f43f5e", description: "華やかな桜色、明るく可愛らしく" },
  { id: "blue", name: "青", swatch: "#3b82f6", swatch2: "#0ea5e9", description: "爽やかな青、シャープで澄んだ印象" },
  { id: "matcha", name: "抹茶", swatch: "#84cc16", swatch2: "#65a30d", description: "和を感じる抹茶色、自然で穏やか" },
  { id: "brown", name: "ディープブラウン", swatch: "#b45309", swatch2: "#92400e", description: "深い茶色、落ち着いた書斎の趣" },
  { id: "crimson", name: "深紅", swatch: "#dc2626", swatch2: "#b91c1c", description: "情熱の深紅、力強く鮮烈に" },
];

export function applyTheme(id: ThemeId): void {
  if (typeof document === "undefined") return;
  document.body.dataset.theme = id;
}

export function getStoredTheme(): ThemeId {
  if (typeof window === "undefined") return "purple";
  const v = window.localStorage.getItem(STORAGE_KEY) as ThemeId | null;
  return v && THEMES.some((t) => t.id === v) ? v : "purple";
}

export default function ThemeSection() {
  // localStorage 同期は useState の lazy init で済むので effect 不要 (React 19 推奨)。
  // getStoredTheme() は SSR セーフ (window undefined で fallback) なので mount 時に評価して OK。
  const [current, setCurrent] = useState<ThemeId>(() => getStoredTheme());

  const choose = (id: ThemeId) => {
    setCurrent(id);
    window.localStorage.setItem(STORAGE_KEY, id);
    applyTheme(id);
  };

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2>カラーテーマ</h2>
        <p className="settings-section-sub">
          UI のアクセントカラーを変えると、結衣のイメージも変わります。
        </p>
      </div>
      <div className="settings-section-body">
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`theme-card ${current === t.id ? "active" : ""}`}
              onClick={() => choose(t.id)}
              title={t.description}
            >
              <span
                className="theme-swatch"
                style={{
                  background: `linear-gradient(135deg, ${t.swatch2}, ${t.swatch})`,
                }}
              />
              <span className="theme-name">{t.name}</span>
              {current === t.id && <span className="theme-check">✓</span>}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
