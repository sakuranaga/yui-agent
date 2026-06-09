"use client";

/**
 * ニュースキュレーション設定 (SettingsModal の「ニュース」タブ上部)。
 *
 * - 興味プロファイル (textarea): Haiku に毎回渡す
 * - score 閾値: これ未満は完全 silent
 * - 読み上げ最低間隔: speak の throttle
 *
 * 設計: docs/news-curation.md §5
 */
import { useEffect, useState } from "react";

type Settings = {
  interestProfile: string;
  scoreThreshold: number;
  minSpeakIntervalHours: number;
  lastSpokenAt: string | null;
};

const PROFILE_PLACEHOLDER = `例:
最近AI関連のニュースに興味がある。特に新しいモデルとか。
一般的な殺人や事故などのネガティブニュースは不要。
芸能関係もあまり興味がない。`;

export default function NewsCurationSection() {
  const [profile, setProfile] = useState("");
  const [threshold, setThreshold] = useState(0.6);
  const [intervalHours, setIntervalHours] = useState(1);
  const [lastSpokenAt, setLastSpokenAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // 「保存しました」バッジを 2.5s で自動的に消す (React 19 purity 対応)。
  useEffect(() => {
    if (savedAt === null) return;
    const id = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(id);
  }, [savedAt]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/news-curation-settings");
        if (!res.ok) return;
        const data = (await res.json()) as Settings;
        setProfile(data.interestProfile);
        setThreshold(data.scoreThreshold);
        setIntervalHours(data.minSpeakIntervalHours);
        setLastSpokenAt(data.lastSpokenAt);
      } catch (e) {
        console.warn("[news-curation] load failed:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/news-curation-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interestProfile: profile,
          scoreThreshold: threshold,
          minSpeakIntervalHours: intervalHours,
        }),
      });
      if (res.ok) setSavedAt(Date.now());
    } catch (e) {
      console.warn("[news-curation] save failed:", e);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="settings-placeholder">読み込み中…</div>;
  }

  return (
    <div className="news-curation">
      <div className="news-curation-block">
        <label className="news-curation-label" htmlFor="news-interest">
          興味プロファイル
        </label>
        <p className="news-curation-desc">
          ニュースの絞り込みに使われます。自由な文章で、興味のあること
          ・不要な話題を書いてください。記憶ではなくこのテキストだけが Haiku に渡されます。
        </p>
        <textarea
          name="news-curation-profile"
          id="news-interest"
          className="news-curation-textarea"
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          placeholder={PROFILE_PLACEHOLDER}
          rows={8}
          maxLength={4000}
        />
        <div className="news-curation-count">{profile.length} / 4000</div>
      </div>

      <div className="news-curation-block news-curation-row">
        <div className="news-curation-field">
          <label className="news-curation-label" htmlFor="news-threshold">
            キュレーション閾値: <strong>{threshold.toFixed(2)}</strong>
          </label>
          <input
            name="news-curation-threshold"
            id="news-threshold"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
            className="news-curation-slider"
          />
          <div className="news-curation-hint">
            これ未満のスコアは完全沈黙 (お便りも残らない)。標準 0.6。
          </div>
        </div>
        <div className="news-curation-field">
          <label className="news-curation-label" htmlFor="news-interval">
            読み上げ最低間隔
          </label>
          <div className="news-curation-interval-row">
            <input
              name="news-curation-interval-hours"
              id="news-interval"
              type="number"
              min={0}
              max={168}
              value={intervalHours}
              onChange={(e) =>
                setIntervalHours(parseInt(e.target.value, 10) || 0)
              }
              className="news-curation-number"
            />
            <span>時間</span>
          </div>
          <div className="news-curation-hint">
            この時間以内に読み上げ済みなら、次は声を出さず通知のみ。0 = throttle なし。
          </div>
        </div>
      </div>

      <div className="news-curation-foot">
        <div className="news-curation-meta">
          {lastSpokenAt
            ? `前回読み上げ: ${new Date(lastSpokenAt).toLocaleString("ja-JP")}`
            : "まだ読み上げていません"}
        </div>
        <div className="news-curation-actions">
          {savedAt !== null && (
            <span className="news-curation-saved">保存しました</span>
          )}
          <button
            type="button"
            className="todo-add-btn"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
