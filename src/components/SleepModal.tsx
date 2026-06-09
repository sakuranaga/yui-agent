"use client";

/**
 * Sleep Modal — IconBar の SLEEP (羊) ボタンから開く。
 *
 * Phase 3 = 設定 UI:
 *   - カテゴリ checkbox (12 個) + 全選択 / 全解除
 *   - BGM 選択 (なし + 一覧) + BGM 音量
 *   - タイマー (分、または「なし」)
 *   - アファメーション一覧 (+ 追加 / インライン編集 / 削除 / トグル) + 出現確率
 *   - TTS 音量 + 詳細設定 (間隔 / 難易度)
 *   - 「おやすみ前の準備をする」ボタン → window CustomEvent("sleep-session-start", config)
 *     Phase 4 で runtime overlay がこの event を listen する。
 *
 * 設計: docs/sleep-support.md
 */
import { useCallback, useEffect, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";

type Category = {
  id: number;
  name: string;
  display_order: number;
  enabled: boolean;
};

type Bgm = {
  id: number;
  title: string;
  filename: string;
  duration_sec: number | null;
  url: string;
  is_uploaded: boolean;
  credit: string | null;
};

type Affirmation = {
  id: number;
  text: string;
  category: string | null;
  enabled: boolean;
  created_at: string;
};

type Settings = {
  tts_duration_scale: number;
  tts_cfg_scale_speaker: number;
  interval_min_sec: number;
  interval_max_sec: number;
  default_timer_min: number;
  difficulty_max: number;
  affirmation_probability: number;
  bgm_volume: number;
  tts_volume: number;
  bgm_duck_db: number;
};

export type SleepSessionConfig = {
  categoryIds: number[];
  bgmId: number | null;
  timerMin: number | null;
  intervalMinSec: number;
  intervalMaxSec: number;
  difficultyMax: number;
  affirmationProbability: number;
  bgmVolume: number;
  ttsVolume: number;
  bgmDuckDb: number;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

const NO_BGM_VALUE = "__none__";

export default function SleepModal({ open, onClose }: Props) {
  const { mounted, closing } = useModalTransition(open);

  const [categories, setCategories] = useState<Category[]>([]);
  const [bgms, setBgms] = useState<Bgm[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [affirmations, setAffirmations] = useState<Affirmation[]>([]);

  // セッション開始用の選択状態 (DB の categories.enabled とは別、毎回 modal で選び直せる)
  const [selectedCats, setSelectedCats] = useState<Set<number>>(new Set());
  const [selectedBgm, setSelectedBgm] = useState<string>(NO_BGM_VALUE);
  const [timerMin, setTimerMin] = useState<string>("60");
  const [noTimer, setNoTimer] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(true);

  // アファメーション編集中の id (null = 編集なし)
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [newAffText, setNewAffText] = useState("");

  // BGM upload 用 (= 失敗時の inline error 表示)。
  const [bgmUploadBusy, setBgmUploadBusy] = useState(false);
  const [bgmUploadError, setBgmUploadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [cRes, bRes, sRes, aRes] = await Promise.all([
        fetch("/api/sleep/categories", { cache: "no-store" }),
        fetch("/api/sleep/bgm", { cache: "no-store" }),
        fetch("/api/sleep/settings", { cache: "no-store" }),
        fetch("/api/sleep/affirmations", { cache: "no-store" }),
      ]);
      const cJson = (await cRes.json()) as { categories: Category[] };
      const bJson = (await bRes.json()) as { bgm: Bgm[] };
      const sJson = (await sRes.json()) as { settings: Settings };
      const aJson = (await aRes.json()) as { affirmations: Affirmation[] };
      setCategories(cJson.categories);
      setBgms(bJson.bgm);
      setSettings(sJson.settings);
      setAffirmations(aJson.affirmations);
      // デフォルト選択: DB で enabled なカテゴリ全部
      setSelectedCats(
        new Set(cJson.categories.filter((c) => c.enabled).map((c) => c.id))
      );
      // BGM はランダムで 1 つ pre-select (なしより BGM ありをデフォルトに)
      if (bJson.bgm.length > 0) {
        const pick = bJson.bgm[Math.floor(Math.random() * bJson.bgm.length)];
        setSelectedBgm(String(pick.id));
      } else {
        setSelectedBgm(NO_BGM_VALUE);
      }
      setTimerMin(String(sJson.settings.default_timer_min));
      setNoTimer(false);
    } catch (e) {
      console.error("[sleep modal] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // modal open 時にカテゴリ + 設定を fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open fetch
    if (open) void reload();
  }, [open, reload]);

  const toggleCat = (id: number) => {
    setSelectedCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAllCats = () => setSelectedCats(new Set(categories.map((c) => c.id)));
  const clearAllCats = () => setSelectedCats(new Set());

  const updateSetting = useCallback(
    async (patch: Partial<Settings>) => {
      // optimistic
      setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
      try {
        await fetch("/api/sleep/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
      } catch (e) {
        console.error("[sleep modal] settings save failed:", e);
      }
    },
    []
  );

  const uploadBgm = async (file: File) => {
    if (bgmUploadBusy) return;
    setBgmUploadBusy(true);
    setBgmUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // title 省略時は server 側でファイル名 (拡張子抜き) を使う
      const res = await fetch("/api/sleep/bgm", { method: "POST", body: fd });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setBgmUploadError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      const j = (await res.json()) as { bgm: Bgm };
      setBgms((prev) => [...prev, j.bgm]);
    } catch (e) {
      console.error("[sleep modal] bgm upload failed:", e);
      setBgmUploadError("通信エラー");
    } finally {
      setBgmUploadBusy(false);
    }
  };

  const deleteBgm = async (id: number) => {
    if (!confirm("この BGM を削除しますか?")) return;
    try {
      const res = await fetch(`/api/sleep/bgm/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        alert(`削除失敗: ${j.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setBgms((prev) => prev.filter((b) => b.id !== id));
      // 削除した BGM が選択中なら BGM なしに
      if (selectedBgm === String(id)) setSelectedBgm(NO_BGM_VALUE);
    } catch (e) {
      console.error("[sleep modal] bgm delete failed:", e);
      alert("通信エラー");
    }
  };

  const addAffirmation = async () => {
    const text = newAffText.trim();
    if (!text) return;
    try {
      const res = await fetch("/api/sleep/affirmations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = (await res.json()) as { affirmation: Affirmation };
      setAffirmations((prev) => [json.affirmation, ...prev]);
      setNewAffText("");
    } catch (e) {
      console.error("[sleep modal] add affirmation failed:", e);
    }
  };

  const saveAffirmation = async (id: number) => {
    const text = editText.trim();
    if (!text) {
      setEditingId(null);
      return;
    }
    try {
      const res = await fetch(`/api/sleep/affirmations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = (await res.json()) as { affirmation: Affirmation };
      setAffirmations((prev) =>
        prev.map((a) => (a.id === id ? json.affirmation : a))
      );
      setEditingId(null);
    } catch (e) {
      console.error("[sleep modal] save affirmation failed:", e);
    }
  };

  const toggleAffirmation = async (id: number, enabled: boolean) => {
    setAffirmations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, enabled } : a))
    );
    try {
      await fetch(`/api/sleep/affirmations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    } catch (e) {
      console.error("[sleep modal] toggle affirmation failed:", e);
    }
  };

  const deleteAffirmation = async (id: number) => {
    if (!confirm("このアファメーションを削除しますか?")) return;
    try {
      await fetch(`/api/sleep/affirmations/${id}`, { method: "DELETE" });
      setAffirmations((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      console.error("[sleep modal] delete affirmation failed:", e);
    }
  };

  const startSession = () => {
    if (!settings) return;
    if (selectedCats.size === 0) {
      alert("カテゴリを少なくとも 1 つ選んでください");
      return;
    }
    const tMinNum = noTimer ? null : parseInt(timerMin, 10);
    const config: SleepSessionConfig = {
      categoryIds: Array.from(selectedCats),
      bgmId: selectedBgm === NO_BGM_VALUE ? null : parseInt(selectedBgm, 10),
      timerMin: noTimer ? null : Number.isFinite(tMinNum) && tMinNum! > 0 ? tMinNum : null,
      intervalMinSec: settings.interval_min_sec,
      intervalMaxSec: settings.interval_max_sec,
      difficultyMax: settings.difficulty_max,
      affirmationProbability: settings.affirmation_probability,
      bgmVolume: settings.bgm_volume,
      ttsVolume: settings.tts_volume,
      bgmDuckDb: settings.bgm_duck_db,
    };
    // Phase 4 の runtime overlay が listen する。Phase 3 だけで動かす場合は
    // event 受け手がいないので何も起きない → onClose() でモーダル閉じる。
    window.dispatchEvent(new CustomEvent("sleep-session-start", { detail: config }));
    onClose();
  };

  if (!mounted) return null;

  return (
    <div
      className={`sleep-modal-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`sleep-modal ${closing ? "modal-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sleep-modal-title"
      >
        <button
          type="button"
          className="sleep-modal-close"
          onClick={onClose}
          aria-label="閉じる"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <header className="sleep-modal-header">
          <h1 id="sleep-modal-title">睡眠サポート</h1>
          <p className="sleep-modal-subtitle">
            関係のない単語を聞き流して、頭の中の考え事をほどいていきます
          </p>
        </header>

        <div className="sleep-modal-body">
          {loading || !settings ? (
            <div className="sleep-loading">読み込み中…</div>
          ) : (
            <>
              {/* カテゴリ */}
              <section className="sleep-section">
                <div className="sleep-section-head">
                  <h2>カテゴリ</h2>
                  <div className="sleep-section-actions">
                    <button type="button" className="sleep-link-btn" onClick={selectAllCats}>
                      全選択
                    </button>
                    <button type="button" className="sleep-link-btn" onClick={clearAllCats}>
                      全解除
                    </button>
                  </div>
                </div>
                <div className="sleep-cat-grid">
                  {categories.map((c) => {
                    const checked = selectedCats.has(c.id);
                    return (
                      <label key={c.id} className={`sleep-cat-chip ${checked ? "is-on" : ""}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCat(c.id)}
                        />
                        <span>{c.name}</span>
                      </label>
                    );
                  })}
                </div>
              </section>

              {/* BGM */}
              <section className="sleep-section">
                <div className="sleep-section-head">
                  <h2>BGM</h2>
                  {/* 選択中 BGM のクレジット (= 折りたたみ、デフォルト閉)。
                      BGM 未選択 or credit 無し (= user upload 等) なら非表示。
                      位置: BGM 見出しの右に並べる (sleep-section-head が flex) */}
                  {(() => {
                    const selectedBgmObj =
                      selectedBgm !== NO_BGM_VALUE
                        ? bgms.find((b) => String(b.id) === selectedBgm) ?? null
                        : null;
                    if (!selectedBgmObj?.credit) return null;
                    return (
                      <details className="sleep-bgm-credit-panel">
                        <summary>ライセンス/クレジット</summary>
                        <pre className="sleep-bgm-credit-body">
                          {selectedBgmObj.credit}
                        </pre>
                      </details>
                    );
                  })()}
                </div>
                <div className="sleep-bgm-list">
                  <label className={`sleep-bgm-row ${selectedBgm === NO_BGM_VALUE ? "is-on" : ""}`}>
                    <input
                      type="radio"
                      name="bgm"
                      value={NO_BGM_VALUE}
                      checked={selectedBgm === NO_BGM_VALUE}
                      onChange={(e) => setSelectedBgm(e.target.value)}
                    />
                    <span className="sleep-bgm-title">BGM なし</span>
                  </label>
                  {bgms.map((b) => (
                    <label
                      key={b.id}
                      className={`sleep-bgm-row ${selectedBgm === String(b.id) ? "is-on" : ""}`}
                    >
                      <input
                        type="radio"
                        name="bgm"
                        value={String(b.id)}
                        checked={selectedBgm === String(b.id)}
                        onChange={(e) => setSelectedBgm(e.target.value)}
                      />
                      <span className="sleep-bgm-title">{b.title}</span>
                      {b.duration_sec != null && (
                        <span className="sleep-bgm-dur">
                          {Math.floor(b.duration_sec / 60)}:{String(b.duration_sec % 60).padStart(2, "0")}
                        </span>
                      )}
                      {b.is_uploaded && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            void deleteBgm(b.id);
                          }}
                          className="sleep-bgm-delete"
                          title="削除"
                          aria-label="削除"
                        >
                          ×
                        </button>
                      )}
                    </label>
                  ))}
                </div>

                {/* MP3 upload (= 自前 BGM 追加、data/sleep-bgm/ に保存) */}
                <div
                  style={{
                    marginTop: "0.6rem",
                    padding: "0.5rem 0.7rem",
                    background: "rgba(255,255,255,0.03)",
                    border: "1px dashed rgba(255,255,255,0.15)",
                    borderRadius: "6px",
                    fontSize: "0.85rem",
                  }}
                >
                  <label style={{ cursor: bgmUploadBusy ? "wait" : "pointer" }}>
                    <input
                      type="file"
                      accept="audio/mpeg,.mp3"
                      disabled={bgmUploadBusy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadBgm(f);
                        // ↓ 同じファイルを再 upload できるよう値クリア
                        e.target.value = "";
                      }}
                      style={{ display: "none" }}
                    />
                    <span style={{ color: "#aaa" }}>
                      {bgmUploadBusy ? "アップロード中…" : "+ MP3 をアップロード (最大 30MB)"}
                    </span>
                  </label>
                  {bgmUploadError && (
                    <div style={{ color: "#ff8a80", marginTop: "0.3rem", fontSize: "0.8rem" }}>
                      {bgmUploadError}
                    </div>
                  )}
                </div>
                <div className="sleep-slider-row">
                  <label>
                    BGM 音量
                    <input
                      name="sleep-bgm-volume"
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.bgm_volume}
                      onChange={(e) =>
                        updateSetting({ bgm_volume: parseFloat(e.target.value) })
                      }
                    />
                    <span className="sleep-slider-val">
                      {Math.round(settings.bgm_volume * 100)}%
                    </span>
                  </label>
                </div>
              </section>

              {/* タイマー */}
              <section className="sleep-section">
                <div className="sleep-section-head">
                  <h2>タイマー</h2>
                </div>
                <div className="sleep-timer-row">
                  <input
                    name="sleep-timer-minutes"
                    type="number"
                    min={1}
                    max={240}
                    value={timerMin}
                    onChange={(e) => setTimerMin(e.target.value)}
                    disabled={noTimer}
                    className="sleep-timer-input"
                  />
                  <span>分で自動停止</span>
                  <label className="sleep-checkbox">
                    <input
                      type="checkbox"
                      checked={noTimer}
                      onChange={(e) => setNoTimer(e.target.checked)}
                    />
                    <span>タイマーなし (手動停止のみ)</span>
                  </label>
                </div>
              </section>

              {/* アファメーション */}
              <section className="sleep-section">
                <div className="sleep-section-head">
                  <h2>アファメーション</h2>
                  <span className="sleep-section-hint">
                    単語の合間にランダムで挟まれます
                  </span>
                </div>
                <div className="sleep-slider-row">
                  <label>
                    出現確率
                    <input
                      name="sleep-affirmation-probability"
                      type="range"
                      min={0}
                      max={0.5}
                      step={0.01}
                      value={settings.affirmation_probability}
                      onChange={(e) =>
                        updateSetting({
                          affirmation_probability: parseFloat(e.target.value),
                        })
                      }
                    />
                    <span className="sleep-slider-val">
                      {Math.round(settings.affirmation_probability * 100)}%
                    </span>
                  </label>
                </div>
                <ul className="sleep-aff-list">
                  {affirmations.map((a) => {
                    const isEditing = editingId === a.id;
                    return (
                      <li key={a.id} className={`sleep-aff-row ${a.enabled ? "" : "is-off"}`}>
                        <input
                          type="checkbox"
                          checked={a.enabled}
                          onChange={(e) => toggleAffirmation(a.id, e.target.checked)}
                          title={a.enabled ? "無効化" : "有効化"}
                        />
                        {isEditing ? (
                          <>
                            <input
                              name="sleep-affirmation-edit"
                              type="text"
                              className="sleep-aff-edit"
                              value={editText}
                              autoFocus
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveAffirmation(a.id);
                                if (e.key === "Escape") setEditingId(null);
                              }}
                            />
                            <button
                              type="button"
                              className="sleep-mini-btn"
                              onClick={() => saveAffirmation(a.id)}
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              className="sleep-mini-btn sleep-mini-btn-ghost"
                              onClick={() => setEditingId(null)}
                            >
                              キャンセル
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="sleep-aff-text">{a.text}</span>
                            <button
                              type="button"
                              className="sleep-mini-btn sleep-mini-btn-ghost"
                              onClick={() => {
                                setEditingId(a.id);
                                setEditText(a.text);
                              }}
                            >
                              編集
                            </button>
                            <button
                              type="button"
                              className="sleep-mini-btn sleep-mini-btn-danger"
                              onClick={() => deleteAffirmation(a.id)}
                            >
                              削除
                            </button>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div className="sleep-aff-add">
                  <input
                    name="sleep-affirmation-new"
                    type="text"
                    placeholder="例: ご主人様、本当にすごいです"
                    value={newAffText}
                    onChange={(e) => setNewAffText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void addAffirmation();
                    }}
                  />
                  <button
                    type="button"
                    className="sleep-mini-btn"
                    onClick={() => void addAffirmation()}
                    disabled={!newAffText.trim()}
                  >
                    + 追加
                  </button>
                </div>
              </section>

              {/* TTS 音量 */}
              <section className="sleep-section">
                <div className="sleep-section-head">
                  <h2>結衣の声</h2>
                </div>
                <div className="sleep-slider-row">
                  <label>
                    TTS 音量
                    <input
                      name="sleep-tts-volume"
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.tts_volume}
                      onChange={(e) =>
                        updateSetting({ tts_volume: parseFloat(e.target.value) })
                      }
                    />
                    <span className="sleep-slider-val">
                      {Math.round(settings.tts_volume * 100)}%
                    </span>
                  </label>
                </div>
              </section>

              {/* 詳細設定 (collapse) */}
              <section className="sleep-section">
                <button
                  type="button"
                  className="sleep-advanced-toggle"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                >
                  {showAdvanced ? "▼" : "▶"} 詳細設定
                </button>
                {showAdvanced && (
                  <div className="sleep-advanced">
                    <div className="sleep-slider-row">
                      <label>
                        単語間隔 (最短)
                        <input
                          name="sleep-interval-min-sec"
                          type="number"
                          min={2}
                          max={60}
                          value={settings.interval_min_sec}
                          onChange={(e) =>
                            updateSetting({
                              interval_min_sec: parseInt(e.target.value, 10) || 10,
                            })
                          }
                        />
                        <span className="sleep-slider-val">秒</span>
                      </label>
                    </div>
                    <div className="sleep-slider-row">
                      <label>
                        単語間隔 (最長)
                        <input
                          name="sleep-interval-max-sec"
                          type="number"
                          min={5}
                          max={120}
                          value={settings.interval_max_sec}
                          onChange={(e) =>
                            updateSetting({
                              interval_max_sec: parseInt(e.target.value, 10) || 30,
                            })
                          }
                        />
                        <span className="sleep-slider-val">秒</span>
                      </label>
                    </div>
                    <div className="sleep-slider-row">
                      <label>
                        難易度上限
                        <select
                          value={settings.difficulty_max}
                          onChange={(e) =>
                            updateSetting({
                              difficulty_max: parseInt(e.target.value, 10),
                            })
                          }
                        >
                          <option value={1}>1 (易しい単語のみ)</option>
                          <option value={2}>2 (標準)</option>
                          <option value={3}>3 (すべて)</option>
                        </select>
                      </label>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        <footer className="sleep-modal-footer">
          <button
            type="button"
            className="sleep-start-btn"
            onClick={startSession}
            disabled={loading || !settings || selectedCats.size === 0}
          >
            おやすみ前の準備をする
          </button>
        </footer>
      </div>
    </div>
  );
}
