"use client";

/**
 * SettingsModal「通知」タブ (v2)。
 *
 * v1 からの変更:
 * - サイレント時間帯セクションを追加 (= 旧夜間 22-7 ハードコード置換)
 * - マトリックスの状態列を toast / speak の 2 サブ列に分割 (= 4 通り選択可能)
 * - timer 行を削除 (= 独自 UI、設定 BYPASS)
 * - schedule 行を追加
 *
 * 設計: docs/notification-system.md §11
 */
import { useCallback, useEffect, useState } from "react";

type DiscordPolicy = "always" | "away_only" | "never";
type Importance = "high" | "normal" | "low";

type Rule = {
  eventKind: string;
  toastOnline: boolean;
  speakOnline: boolean;
  toastAway: boolean;
  speakAway: boolean;
  toastFocus: boolean;
  speakFocus: boolean;
  discordPolicy: DiscordPolicy;
  importance: Importance;
};

type QuietHours = {
  enabled: boolean;
  startHour: number;
  endHour: number;
};

const KIND_LABEL: Record<string, string> = {
  morning_brief: "朝のブリーフィング",
  diary: "日記生成",
  news: "ニュース新着",
  mail_important: "メール (重要送信者)",
  mail_other: "メール (その他)",
  music: "音楽切替",
  schedule: "予定 (5 分前)",
  health: "体調 / 健康警告",
  reminder: "リマインダー",
  mcp_notify: "作業連絡 (MCP)",
};

// timer は独自 UI / 設定 BYPASS なので表示対象外 (= 設計 §2.8)
const HIDDEN_KINDS = new Set<string>(["timer"]);

const DISCORD_LABEL: Record<DiscordPolicy, string> = {
  always: "常時 push",
  away_only: "離席時のみ",
  never: "配信なし",
};

const IMPORTANCE_LABEL: Record<Importance, string> = {
  high: "high",
  normal: "normal",
  low: "low",
};

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);

export default function NotificationsSection() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [quietHours, setQuietHoursState] = useState<QuietHours>({
    enabled: false,
    startHour: 22,
    endHour: 7,
  });
  const [loading, setLoading] = useState(true);
  const [confirmReset, setConfirmReset] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [resRules, resQuiet] = await Promise.all([
        fetch("/api/notification-settings"),
        fetch("/api/quiet-hours"),
      ]);
      if (resRules.ok) {
        const data = (await resRules.json()) as { rules: Rule[] };
        const filtered = (data.rules ?? []).filter((r) => !HIDDEN_KINDS.has(r.eventKind));
        setRules(filtered);
      }
      if (resQuiet.ok) {
        const data = (await resQuiet.json()) as QuietHours;
        setQuietHoursState(data);
      }
    } catch (e) {
      console.warn("[notification-settings] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 初回 mount + reload 関数が変わったら再 fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void reload();
  }, [reload]);

  const patchRule = async (kind: string, patch: Partial<Rule>) => {
    // 楽観的更新 + 失敗時 rollback。HTTP 4xx/5xx と network error の両方をハンドル。
    const prev = rules.find((r) => r.eventKind === kind);
    setRules((cur) => cur.map((r) => (r.eventKind === kind ? { ...r, ...patch } : r)));
    try {
      const res = await fetch(`/api/notification-settings/${encodeURIComponent(kind)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        if (prev) {
          setRules((cur) => cur.map((r) => (r.eventKind === kind ? prev : r)));
        }
        console.warn(`[notification-settings] patch HTTP ${res.status}`);
      }
    } catch (e) {
      if (prev) {
        setRules((cur) => cur.map((r) => (r.eventKind === kind ? prev : r)));
      }
      console.warn("[notification-settings] patch failed:", e);
    }
  };

  const patchQuietHours = async (patch: Partial<QuietHours>) => {
    const prev = quietHours;
    setQuietHoursState((s) => ({ ...s, ...patch }));
    try {
      const res = await fetch("/api/quiet-hours", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setQuietHoursState(prev);
      }
    } catch (e) {
      console.warn("[quiet-hours] patch failed:", e);
      setQuietHoursState(prev);
    }
  };

  const resetAll = async () => {
    setConfirmReset(false);
    try {
      await fetch("/api/notification-settings/reset", { method: "POST" });
      await reload();
    } catch (e) {
      console.warn("[notification-settings] reset failed:", e);
    }
  };

  return (
    <div className="notify-settings">
      <div className="notify-settings-head">
        <p className="notify-settings-desc">
          通知の種類ごとに、状態 (オンライン / 離席 / 集中) での挙動と Discord 配信、優先度を設定できます。各セルで お便り (toast) と 読み上げ (speak) を独立に ON/OFF できます。
        </p>
        <button
          type="button"
          className="todo-cancel-btn"
          onClick={() => setConfirmReset(true)}
        >
          既定値に戻す
        </button>
      </div>

      {/* サイレント時間帯 セクション */}
      <div className="quiet-hours-section">
        <label className="quiet-hours-toggle">
          <input
            type="checkbox"
            checked={quietHours.enabled}
            onChange={(e) => void patchQuietHours({ enabled: e.target.checked })}
          />
          <span>指定した時間帯は自動的に &quot;離席&quot; 扱いにする</span>
        </label>
        <div className="quiet-hours-range">
          <span>開始</span>
          <select
            className="notify-settings-select"
            value={quietHours.startHour}
            disabled={!quietHours.enabled}
            onChange={(e) =>
              void patchQuietHours({ startHour: parseInt(e.target.value, 10) })
            }
          >
            {HOUR_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h} 時
              </option>
            ))}
          </select>
          <span>〜 終了</span>
          <select
            className="notify-settings-select"
            value={quietHours.endHour}
            disabled={!quietHours.enabled}
            onChange={(e) =>
              void patchQuietHours({ endHour: parseInt(e.target.value, 10) })
            }
          >
            {HOUR_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h} 時
              </option>
            ))}
          </select>
        </div>
        <p className="quiet-hours-hint">
          跨ぎ指定可 (例: 23 → 6 で 23 時 〜 翌 6 時)。集中 / プライベートモード中は対象外。
        </p>
      </div>

      {loading && rules.length === 0 ? (
        <div className="settings-placeholder">読み込み中…</div>
      ) : (
        <div className="notify-settings-table-wrap">
          <table className="notify-settings-table">
            <thead>
              <tr>
                <th rowSpan={2}>発火元</th>
                <th colSpan={2}>オンライン</th>
                <th colSpan={2}>離席</th>
                <th colSpan={2}>集中</th>
                <th rowSpan={2}>Discord</th>
                <th rowSpan={2}>優先度</th>
              </tr>
              <tr>
                <th className="notify-sub-th">お便り</th>
                <th className="notify-sub-th">読み上げ</th>
                <th className="notify-sub-th">お便り</th>
                <th className="notify-sub-th">読み上げ</th>
                <th className="notify-sub-th">お便り</th>
                <th className="notify-sub-th">読み上げ</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.eventKind}>
                  <td className="notify-settings-kind">
                    {KIND_LABEL[r.eventKind] ?? r.eventKind}
                  </td>
                  <td className="notify-cell">
                    <BoolCheck
                      checked={r.toastOnline}
                      onChange={(v) => void patchRule(r.eventKind, { toastOnline: v })}
                    />
                  </td>
                  <td className="notify-cell">
                    <BoolCheck
                      checked={r.speakOnline}
                      onChange={(v) => void patchRule(r.eventKind, { speakOnline: v })}
                    />
                  </td>
                  <td className="notify-cell">
                    <BoolCheck
                      checked={r.toastAway}
                      onChange={(v) => void patchRule(r.eventKind, { toastAway: v })}
                    />
                  </td>
                  <td className="notify-cell">
                    <BoolCheck
                      checked={r.speakAway}
                      onChange={(v) => void patchRule(r.eventKind, { speakAway: v })}
                    />
                  </td>
                  <td className="notify-cell">
                    <BoolCheck
                      checked={r.toastFocus}
                      onChange={(v) => void patchRule(r.eventKind, { toastFocus: v })}
                    />
                  </td>
                  <td className="notify-cell">
                    <BoolCheck
                      checked={r.speakFocus}
                      onChange={(v) => void patchRule(r.eventKind, { speakFocus: v })}
                    />
                  </td>
                  <td>
                    <DiscordSelect
                      value={r.discordPolicy}
                      onChange={(v) => void patchRule(r.eventKind, { discordPolicy: v })}
                    />
                  </td>
                  <td>
                    <ImportanceSelect
                      value={r.importance}
                      onChange={(v) => void patchRule(r.eventKind, { importance: v })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmReset && (
        <div
          className="confirm-popup-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmReset(false);
          }}
        >
          <div className="confirm-popup" role="dialog" aria-modal="true">
            <h2 className="confirm-popup-title">既定値に戻す</h2>
            <p className="confirm-popup-body">
              通知マトリックスの全ての設定を、設計書のデフォルト値に戻します。
              <br />
              <span className="confirm-popup-note">この操作は取り消せません。</span>
            </p>
            <div className="confirm-popup-actions">
              <button type="button" className="confirm-cancel-btn" onClick={() => setConfirmReset(false)}>
                キャンセル
              </button>
              <button
                type="button"
                className="confirm-confirm-btn"
                onClick={() => void resetAll()}
                autoFocus
              >
                戻す
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BoolCheck({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      className="notify-bool-check"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function DiscordSelect({
  value,
  onChange,
}: {
  value: DiscordPolicy;
  onChange: (v: DiscordPolicy) => void;
}) {
  return (
    <select
      className="notify-settings-select"
      value={value}
      onChange={(e) => onChange(e.target.value as DiscordPolicy)}
    >
      <option value="always">{DISCORD_LABEL.always}</option>
      <option value="away_only">{DISCORD_LABEL.away_only}</option>
      <option value="never">{DISCORD_LABEL.never}</option>
    </select>
  );
}

function ImportanceSelect({
  value,
  onChange,
}: {
  value: Importance;
  onChange: (v: Importance) => void;
}) {
  return (
    <select
      className="notify-settings-select"
      value={value}
      onChange={(e) => onChange(e.target.value as Importance)}
    >
      <option value="high">{IMPORTANCE_LABEL.high}</option>
      <option value="normal">{IMPORTANCE_LABEL.normal}</option>
      <option value="low">{IMPORTANCE_LABEL.low}</option>
    </select>
  );
}
