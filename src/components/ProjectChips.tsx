"use client";

/**
 * Project Chips (表示専用) — 各ツールで共通の見た目で project chip を並べる。
 *
 * 編集 UI (「+」popover、× 解除) は ProjectChipsEditor.tsx が内部で本 component を
 * 使って組み立てる。リスト card のように「表示だけ」したい時は本 component を
 * 直接 import すること (fetch 走らないので軽い、各行で safe)。
 *
 * 設計: docs/roadmap.md §6.8 (project-links Phase 2 改 — チップ統一)
 */
import type { ReactNode } from "react";

export type Chip = {
  id: number;
  name: string;
  color: string | null;
  linkedBy: "manual" | "ai" | "intent" | "primary";
};

type Props = {
  chips: Chip[];
  /** chip 末尾に追加で挿入する要素 (例: 「+」 ボタン)。編集 UI 用。 */
  trailing?: ReactNode;
  /** chip クリック時のハンドラ (Hub 等で project にジャンプしたい時用)。 */
  onChipClick?: (chip: Chip) => void;
  /** 各 chip 右端に × を出して click で onRemove を呼ぶ。primary は強制で × なし。 */
  onRemove?: (chip: Chip) => void;
};

export default function ProjectChips({ chips, trailing, onChipClick, onRemove }: Props) {
  return (
    <span className="project-chips">
      {chips.map((p) => {
        const removable = onRemove && p.linkedBy !== "primary";
        return (
          <span
            key={p.id}
            className={`project-chip ${p.linkedBy === "primary" ? "is-primary" : ""}`}
            style={p.color ? { borderColor: p.color } : undefined}
            onClick={onChipClick ? () => onChipClick(p) : undefined}
            role={onChipClick ? "button" : undefined}
            title={p.linkedBy === "primary" ? `${p.name} (primary)` : p.name}
          >
            {p.color && (
              <span
                className="project-chip-dot"
                style={{ background: p.color }}
                aria-hidden="true"
              />
            )}
            <span className="project-chip-name">{p.name}</span>
            {removable && (
              <button
                type="button"
                className="project-chip-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove?.(p);
                }}
                aria-label={`${p.name} の紐付けを外す`}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
      {trailing}
    </span>
  );
}
