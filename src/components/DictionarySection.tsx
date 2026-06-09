"use client";

/**
 * TTS 用語辞書 (SettingsModal の「読み方」タブ)。
 * 追加 / 編集 (word・reading) / 有効無効トグル / 削除。検索 input 付き。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { splitForTTS } from "@/lib/split-tts";

type Entry = {
  id: number;
  word: string;
  reading: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

type SpeakWindow = Window & {
  __yuiSpeakText?: (text: string) => Promise<void>;
};

export default function DictionarySection() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [newWord, setNewWord] = useState("");
  const [newReading, setNewReading] = useState("");
  // 読み上げテスト用 (保存しない、テストフォーム)。
  const [testInput, setTestInput] = useState("");
  const [testNormalized, setTestNormalized] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  const runTest = useCallback(async () => {
    const text = testInput.trim();
    if (!text || testBusy) return;
    setTestBusy(true);
    setTestNormalized(null);
    try {
      const res = await fetch("/api/tts-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { normalized: string };
      setTestNormalized(data.normalized);
      const speak = (window as SpeakWindow).__yuiSpeakText;
      if (speak) await speak(data.normalized);
    } catch (e) {
      console.warn("[dictionary] tts test failed:", e);
    } finally {
      setTestBusy(false);
    }
  }, [testInput, testBusy]);

  // 正規化なしの素読み (辞書置換も LLM 正規化もスキップ)。
  // ChatPanel と同じ「1 個先読み + 直列再生」キューイングを実装し、長文でも破綻させない。
  // gain node は経由しないので MUTE ボタンと完全連動しない点だけ仕様外 (テスト用途のため)。
  const runTestRaw = useCallback(async () => {
    const text = testInput.trim();
    if (!text || testBusy) return;
    setTestBusy(true);
    setTestNormalized(null);
    try {
      const chunks = splitForTTS(text);
      if (chunks.length === 0) return;

      const fetchChunk = async (
        chunk: string
      ): Promise<{ audio: HTMLAudioElement; url: string } | null> => {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: chunk, skipDictionary: true }),
        });
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        return { audio: new Audio(url), url };
      };

      // 最初の 1 個を fetch 開始 → ループ内で「再生 + 次を先読み」
      let nextPromise: Promise<{ audio: HTMLAudioElement; url: string } | null> | null =
        fetchChunk(chunks[0]);
      for (let i = 0; i < chunks.length; i++) {
        const ready = await nextPromise;
        nextPromise = i + 1 < chunks.length ? fetchChunk(chunks[i + 1]) : null;
        if (!ready) continue;
        await new Promise<void>((resolve) => {
          ready.audio.onended = () => {
            URL.revokeObjectURL(ready.url);
            resolve();
          };
          ready.audio.onerror = () => {
            URL.revokeObjectURL(ready.url);
            resolve();
          };
          void ready.audio.play();
        });
      }
    } catch (e) {
      console.warn("[dictionary] raw tts failed:", e);
    } finally {
      setTestBusy(false);
    }
  }, [testInput, testBusy]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tts-dictionary");
      if (!res.ok) return;
      const data = (await res.json()) as { entries: Entry[] };
      setEntries(data.entries ?? []);
    } catch (e) {
      console.warn("[dictionary] reload failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 初回 mount + reload 変化時に再 fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return entries;
    return entries.filter(
      (e) => e.word.toLowerCase().includes(k) || e.reading.includes(k)
    );
  }, [entries, q]);

  const patch = async (id: number, body: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/tts-dictionary/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) await reload();
    } catch (e) {
      console.warn("[dictionary] patch failed:", e);
    }
  };

  const remove = async (id: number) => {
    try {
      const res = await fetch(`/api/tts-dictionary/${id}`, { method: "DELETE" });
      if (res.ok) await reload();
    } catch (e) {
      console.warn("[dictionary] delete failed:", e);
    }
  };

  const create = async () => {
    const word = newWord.trim();
    const reading = newReading.trim();
    if (!word || !reading) return;
    try {
      const res = await fetch("/api/tts-dictionary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word, reading }),
      });
      if (res.ok) {
        setNewWord("");
        setNewReading("");
        setCreating(false);
        await reload();
      }
    } catch (e) {
      console.warn("[dictionary] create failed:", e);
    }
  };

  return (
    <div className="dictionary-section">
      <div className="dictionary-help">
        <p>
          結衣が発話する直前の <strong>単純フィルタ</strong> として、登録した{" "}
          <code>word → 読み</code> を longest-first で全置換します (LLM 正規化の前段)。
        </p>
        <p>
          <strong>チャットで結衣に教えれば自律的に登録</strong>もされます。例:
        </p>
        <ul>
          <li>
            「小諸高原は<strong>こもろこうげん</strong>って読むんだよ」 → 結衣が{" "}
            <code>add_pronunciation</code> で自分で登録 → 次回からは正しく読みます
          </li>
          <li>
            「<strong>3D</strong> は <strong>スリーディー</strong> って読んでね」も同様
          </li>
          <li>既存の語を再訂正すると上書き更新</li>
        </ul>
        <p className="dictionary-help-note">
          ※ 大文字小文字を区別しない置換、cache TTL 60 秒。複雑な分岐 (= 「読み」ではなく
          「同音異義の発音強調」等) は LLM 正規化側の領域なのでここには登録しないでください。
        </p>
      </div>
      <div className="dictionary-test">
        <label className="dictionary-test-label">
          <span>読み上げテスト (保存されません)</span>
          <textarea
            name="dict-test-input"
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            placeholder="任意のテキストを入力 → 前処理 (辞書置換 + LLM 正規化) を通して読み上げます。"
            rows={3}
            className="dictionary-test-input"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void runTest();
              }
            }}
          />
        </label>
        <div className="dictionary-test-actions">
          <button
            type="button"
            className="todo-cancel-btn"
            onClick={() => void runTestRaw()}
            disabled={!testInput.trim() || testBusy}
            title="辞書置換も LLM 正規化もせず、入力をそのまま TTS へ渡します"
          >
            そのまま読み上げ
          </button>
          <button
            type="button"
            className="todo-add-btn"
            onClick={() => void runTest()}
            disabled={!testInput.trim() || testBusy}
          >
            {testBusy ? "処理中…" : "正規化して読み上げ"}
          </button>
        </div>
        {testNormalized !== null && (
          <div className="dictionary-test-result">
            <span className="dictionary-test-result-label">正規化結果</span>
            <div className="dictionary-test-result-text">{testNormalized}</div>
          </div>
        )}
      </div>

      <div className="dictionary-toolbar">
        <input
          name="dict-search"
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="検索 (word または 読み)"
          className="dictionary-search"
        />
        <button
          type="button"
          className="todo-add-btn"
          onClick={() => {
            // 検索バーに入ってる文字列を新規エントリの word に prefill
            // (= 「○○ を辞書追加したい」と思って検索 → 該当なし → そのまま追加、を 1 click に短縮)
            setNewWord(q.trim());
            setNewReading("");
            setCreating(true);
          }}
        >
          ＋ 追加
        </button>
      </div>

      {loading && entries.length === 0 && (
        <div className="settings-placeholder">読み込み中…</div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="settings-placeholder">
          {q ? "該当する項目がありません" : "辞書がまだ空です"}
        </div>
      )}

      {creating && (
        <div
          className="confirm-popup-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setCreating(false);
              setNewWord("");
              setNewReading("");
            }
          }}
        >
          <div className="confirm-popup confirm-popup-accent" role="dialog" aria-modal="true">
            <h2 className="confirm-popup-title">読み方を追加</h2>
            <div className="dictionary-popup-fields">
              <label className="project-edit-label">
                <span>word</span>
                <input
                  name="dict-new-word"
                  type="text"
                  value={newWord}
                  autoFocus
                  placeholder="例: 3D"
                  onChange={(e) => setNewWord(e.target.value)}
                />
              </label>
              <label className="project-edit-label">
                <span>読み</span>
                <input
                  name="dict-new-reading"
                  type="text"
                  value={newReading}
                  placeholder="例: スリーディー"
                  onChange={(e) => setNewReading(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void create();
                    } else if (e.key === "Escape") {
                      setCreating(false);
                      setNewWord("");
                      setNewReading("");
                    }
                  }}
                />
              </label>
            </div>
            <div className="confirm-popup-actions">
              <button
                type="button"
                className="confirm-cancel-btn"
                onClick={() => {
                  setCreating(false);
                  setNewWord("");
                  setNewReading("");
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="todo-add-btn"
                onClick={() => void create()}
                disabled={!newWord.trim() || !newReading.trim()}
              >
                追加
              </button>
            </div>
          </div>
        </div>
      )}

      {filtered.length > 0 && (
        <table className="dictionary-table">
          <thead>
            <tr>
              <th>word</th>
              <th>読み</th>
              <th>有効</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <DictionaryRow
                key={e.id}
                entry={e}
                onPatch={(body) => patch(e.id, body)}
                onDelete={() => void remove(e.id)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DictionaryRow({
  entry,
  onPatch,
  onDelete,
}: {
  entry: Entry;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
}) {
  const [word, setWord] = useState(entry.word);
  const [reading, setReading] = useState(entry.reading);

  // entry prop が変わったら編集中の値を同期。
  // 公式 anti-pattern #4 (adjusting state when prop changes) → 正攻法は親側で
  // `<DictionaryRow key={entry.id} />` の remount。follow-up で整理予定。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setWord(entry.word);
    setReading(entry.reading);
  }, [entry.id, entry.word, entry.reading]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <tr className={`dictionary-row ${entry.enabled ? "" : "dictionary-row-disabled"}`}>
      <td>
        <input
          name="dict-word"
          type="text"
          value={word}
          onChange={(e) => setWord(e.target.value)}
          onBlur={() => {
            if (word.trim() && word !== entry.word) {
              void onPatch({ word: word.trim() });
            }
          }}
          className="dictionary-cell-input"
        />
      </td>
      <td>
        <input
          name="dict-reading"
          type="text"
          value={reading}
          onChange={(e) => setReading(e.target.value)}
          onBlur={() => {
            if (reading.trim() && reading !== entry.reading) {
              void onPatch({ reading: reading.trim() });
            }
          }}
          className="dictionary-cell-input"
        />
      </td>
      <td>
        <button
          type="button"
          className={`dictionary-toggle ${entry.enabled ? "on" : "off"}`}
          onClick={() => void onPatch({ enabled: !entry.enabled })}
          aria-label={entry.enabled ? "無効化" : "有効化"}
          title={entry.enabled ? "無効化" : "有効化"}
        >
          <span className="dictionary-toggle-knob" />
        </button>
      </td>
      <td>
        <button
          type="button"
          className="dictionary-delete-btn"
          onClick={onDelete}
          aria-label="削除"
          title="削除"
        >
          ×
        </button>
      </td>
    </tr>
  );
}
