"use client";

/**
 * メール設定 (SettingsModal「メール」タブ)。
 *
 * 3 セクション:
 *  - キュレーション設定: 興味プロファイル + 閾値
 *  - VIP / ブロックリスト編集
 *  - Gmail アカウント管理 (登録 / primary / 有効無効 / 初回同期日数 / 削除)
 *
 * 設計: docs/mail-system.md §6.3
 */
import { useCallback, useEffect, useState } from "react";

type CurationSettings = {
  interestProfile: string;
  scoreThreshold: number;
  vipAddresses: string[];
  blockedAddresses: string[];
};

type Account = {
  id: number;
  email: string;
  displayName: string | null;
  enabled: boolean;
  isPrimary: boolean;
  initialSyncDays: number;
  lastSyncedAt: string | null;
};

type AccountsResponse = {
  accounts: Account[];
  candidates: Array<{ email: string }>;
};

const PROFILE_PLACEHOLDER = `例:
仕事の連絡や重要な契約・請求は重要。
○○さんからのメールは常に優先。
広告メールやニュースレターはほぼ不要。
ただし AI 関連や新しい技術のニュースレターは興味あり。`;

export default function MailSettingsSection() {
  const [profile, setProfile] = useState("");
  const [threshold, setThreshold] = useState(0.5);
  const [vipList, setVipList] = useState<string[]>([]);
  const [blockList, setBlockList] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [candidates, setCandidates] = useState<Array<{ email: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // 「保存しました」バッジを 2.5s で自動的に消す。
  // 旧実装は render 内で `Date.now() - savedAt < 2500` を判定していたが、React 19 では
  // render 中に Date.now() を呼ぶ purity 違反になるので effect で setSavedAt(null) する。
  useEffect(() => {
    if (savedAt === null) return;
    const id = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(id);
  }, [savedAt]);

  const [newVip, setNewVip] = useState("");
  const [newBlock, setNewBlock] = useState("");

  const reload = useCallback(async () => {
    try {
      const [cuRes, accRes] = await Promise.all([
        fetch("/api/mail/curation-settings", { cache: "no-store" }),
        fetch("/api/mail/accounts", { cache: "no-store" }),
      ]);
      if (cuRes.ok) {
        const data = (await cuRes.json()) as CurationSettings;
        setProfile(data.interestProfile);
        setThreshold(data.scoreThreshold);
        setVipList(data.vipAddresses);
        setBlockList(data.blockedAddresses);
      }
      if (accRes.ok) {
        const data = (await accRes.json()) as AccountsResponse;
        setAccounts(data.accounts);
        setCandidates(data.candidates);
      }
    } catch (e) {
      console.warn("[mail-settings] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 初回 mount で キュレーション設定 + アカウント情報を fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void reload();
  }, [reload]);

  const saveCuration = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/mail/curation-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interestProfile: profile,
          scoreThreshold: threshold,
          vipAddresses: vipList,
          blockedAddresses: blockList,
        }),
      });
      if (res.ok) setSavedAt(Date.now());
    } catch (e) {
      console.warn("[mail-settings] save failed:", e);
    } finally {
      setSaving(false);
    }
  };

  const addAccount = async (email: string) => {
    try {
      await fetch("/api/mail/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      await reload();
    } catch (e) {
      console.warn("[mail-settings] addAccount failed:", e);
    }
  };

  const patchAccount = async (id: number, patch: Partial<Account>) => {
    try {
      await fetch(`/api/mail/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      await reload();
    } catch (e) {
      console.warn("[mail-settings] patchAccount failed:", e);
    }
  };

  const deleteAccount = async (id: number, email: string) => {
    if (!confirm(`${email} を削除しますか? このアカウントのメールキャッシュも全て消えます。`)) {
      return;
    }
    try {
      await fetch(`/api/mail/accounts/${id}`, { method: "DELETE" });
      await reload();
    } catch (e) {
      console.warn("[mail-settings] deleteAccount failed:", e);
    }
  };

  if (loading) {
    return <div className="settings-placeholder">読み込み中…</div>;
  }

  return (
    <div className="mail-settings">
      {/* === キュレーション === */}
      <section className="ai-card">
        <h3 className="ai-card-title">キュレーション</h3>

        <div className="ai-field">
          <label className="ai-label" htmlFor="mail-profile">興味プロファイル</label>
          <div className="ai-hint">
            メールの重要度判定に使われます。仕事の文脈、興味分野、不要な話題などを自然な文章で。
          </div>
          <textarea
            name="mail-settings-profile"
            id="mail-profile"
            className="news-curation-textarea"
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder={PROFILE_PLACEHOLDER}
            rows={6}
            maxLength={4000}
          />
          <div className="news-curation-count">{profile.length} / 4000</div>
        </div>

        <div className="ai-field">
          <label className="ai-label">
            キュレーション閾値: <strong>{threshold.toFixed(2)}</strong>
          </label>
          <input
            name="mail-settings-threshold"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
            className="news-curation-slider"
          />
          <div className="ai-hint">
            このスコア以上のメールが受信箱に表示されます。標準 0.5。
          </div>
        </div>
      </section>

      {/* === VIP === */}
      <section className="ai-card">
        <h3 className="ai-card-title">VIP リスト</h3>
        <div className="ai-hint">
          このアドレスからのメールは LLM 判定をスキップして score=1.0 で即時 pass します。
          <br />
          <strong>住所録に登録されているメアドは自動的に VIP 扱い</strong>になるので、
          ここには住所録に無い (= 連絡先として保存していないが優遇したい) 相手だけ追加してください。
        </div>
        <div className="mail-list-edit">
          {vipList.length === 0 ? (
            <div className="settings-placeholder">未登録</div>
          ) : (
            vipList.map((email) => (
              <div key={email} className="mail-list-row">
                <span>{email}</span>
                <button
                  type="button"
                  className="ai-edit-btn"
                  onClick={() => setVipList((cur) => cur.filter((e) => e !== email))}
                >
                  削除
                </button>
              </div>
            ))
          )}
        </div>
        <div className="ai-input-row">
          <input
            name="mail-settings-vip-add"
            type="email"
            className="ai-input"
            placeholder="vip@example.com"
            value={newVip}
            onChange={(e) => setNewVip(e.target.value)}
          />
          <button
            type="button"
            className="ai-edit-btn"
            onClick={() => {
              const e = newVip.trim().toLowerCase();
              if (e && !vipList.includes(e)) {
                setVipList((cur) => [...cur, e]);
                setNewVip("");
              }
            }}
          >
            ＋ 追加
          </button>
        </div>
      </section>

      {/* === ブロック === */}
      <section className="ai-card">
        <h3 className="ai-card-title">ブロックリスト</h3>
        <div className="ai-hint">
          このアドレスからのメールは <strong>取得時点で自 DB に保存しません</strong>。
          LLM にも渡らず、受信箱にも残らない完全な silent 扱いです。
          Gmail 側にはそのまま残るので、必要なら Gmail を直接見てください。
        </div>
        <div className="mail-list-edit">
          {blockList.length === 0 ? (
            <div className="settings-placeholder">未登録</div>
          ) : (
            blockList.map((email) => (
              <div key={email} className="mail-list-row">
                <span>{email}</span>
                <button
                  type="button"
                  className="ai-edit-btn"
                  onClick={() => setBlockList((cur) => cur.filter((e) => e !== email))}
                >
                  削除
                </button>
              </div>
            ))
          )}
        </div>
        <div className="ai-input-row">
          <input
            name="mail-settings-block-add"
            type="email"
            className="ai-input"
            placeholder="spam@example.com"
            value={newBlock}
            onChange={(e) => setNewBlock(e.target.value)}
          />
          <button
            type="button"
            className="ai-edit-btn"
            onClick={() => {
              const e = newBlock.trim().toLowerCase();
              if (e && !blockList.includes(e)) {
                setBlockList((cur) => [...cur, e]);
                setNewBlock("");
              }
            }}
          >
            ＋ 追加
          </button>
        </div>
      </section>

      {/* 保存 (キュレーション + VIP/ブロック を一括) */}
      <div className="ai-foot">
        {savedAt !== null && (
          <span className="ai-saved">保存しました</span>
        )}
        <button
          type="button"
          className="todo-add-btn"
          onClick={() => void saveCuration()}
          disabled={saving}
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>

      {/* === アカウント === */}
      <section className="ai-card">
        <h3 className="ai-card-title">Gmail アカウント</h3>
        <div className="ai-hint">
          メール機能で使う Gmail アカウントを登録します。事前に「連携」タブで Google OAuth
          接続 (gmail.readonly scope) を済ませてください。
        </div>

        {accounts.length === 0 ? (
          <div className="settings-placeholder">未登録</div>
        ) : (
          <div className="mail-accounts-list">
            {accounts.map((a) => (
              <div key={a.id} className="mail-account-row">
                <div className="mail-account-info">
                  <div className="mail-account-email">
                    {a.isPrimary && <span className="mail-account-primary">★ primary</span>}
                    {a.email}
                  </div>
                  <div className="mail-account-meta">
                    最終同期: {a.lastSyncedAt
                      ? new Date(a.lastSyncedAt).toLocaleString("ja-JP")
                      : "未同期"}
                    {" / 初回同期日数: "}
                    <input
                      name="mail-settings-initial-sync-days"
                      type="number"
                      min={1}
                      max={30}
                      value={a.initialSyncDays}
                      onChange={(e) =>
                        void patchAccount(a.id, { initialSyncDays: parseInt(e.target.value, 10) || 3 })
                      }
                      className="ai-input ai-input-small"
                      style={{ width: 60, padding: "2px 6px" }}
                    />
                    {" 日"}
                  </div>
                </div>
                <div className="mail-account-actions">
                  <label className="mail-account-toggle">
                    <input
                      type="checkbox"
                      checked={a.enabled}
                      onChange={(e) => void patchAccount(a.id, { enabled: e.target.checked })}
                    />
                    有効
                  </label>
                  {!a.isPrimary && (
                    <button
                      type="button"
                      className="ai-edit-btn"
                      onClick={() => void patchAccount(a.id, { isPrimary: true })}
                    >
                      primary に
                    </button>
                  )}
                  <button
                    type="button"
                    className="ai-edit-btn mail-account-delete"
                    onClick={() => void deleteAccount(a.id, a.email)}
                  >
                    削除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {candidates.length > 0 && (
          <div className="ai-field" style={{ marginTop: 12 }}>
            <div className="ai-hint">
              OAuth 接続済で未登録のアカウント:
            </div>
            <div className="mail-list-edit">
              {candidates.map((c) => (
                <div key={c.email} className="mail-list-row">
                  <span>{c.email}</span>
                  <button
                    type="button"
                    className="ai-edit-btn"
                    onClick={() => void addAccount(c.email)}
                  >
                    ＋ 追加
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <MailTrainingExamplesCard />
    </div>
  );
}

// ──────────────────────────────────────────────────────
// 学習例の管理 (docs/mail-classification.md §8.4, Phase 4)
// ──────────────────────────────────────────────────────

type TrainingExample = {
  id: number;
  sourceMailId: number | null;
  bucket: "important" | "needed" | "unneeded";
  hintText: string;
  embeddedText: string;
  autoTodo: boolean;
  autoEvent: boolean;
  createdAt: string;
  updatedAt: string;
  sourceSubject: string | null;
};

const BUCKET_LABEL: Record<TrainingExample["bucket"], string> = {
  important: "重要",
  needed: "要",
  unneeded: "不要",
};

const BUCKET_ORDER: TrainingExample["bucket"][] = ["important", "needed", "unneeded"];

function MailTrainingExamplesCard() {
  const [examples, setExamples] = useState<TrainingExample[]>([]);
  const [loading, setLoading] = useState(true);
  const [openBuckets, setOpenBuckets] = useState<Set<string>>(
    new Set<string>(["important"])
  );
  const [editingId, setEditingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/mail-training?limit=500", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { examples: TrainingExample[] };
      setExamples(data.examples);
    } catch (e) {
      console.warn("[mail-training] list failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 初回 mount で学習例を fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void load();
  }, [load]);

  const grouped: Record<TrainingExample["bucket"], TrainingExample[]> = {
    important: [],
    needed: [],
    unneeded: [],
  };
  for (const ex of examples) grouped[ex.bucket].push(ex);

  const toggleBucket = (b: string) => {
    setOpenBuckets((cur) => {
      const next = new Set(cur);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  };

  const onDelete = async (id: number) => {
    if (!confirm("この学習例を削除します。よろしいですか?")) return;
    try {
      const res = await fetch(`/api/mail-training/${id}`, { method: "DELETE" });
      if (res.ok) {
        setExamples((cur) => cur.filter((e) => e.id !== id));
      }
    } catch (e) {
      console.warn("[mail-training] delete failed:", e);
    }
  };

  return (
    <section className="settings-section">
      <h2>学習例 ({examples.length})</h2>
      <p className="settings-section-sub">
        メール仕分けに使う user 教師データ。間違って登録した時や、状況変化で必要度が変わった時に編集 / 削除できます。
      </p>

      {loading ? (
        <div className="settings-placeholder">読み込み中…</div>
      ) : examples.length === 0 ? (
        <div className="settings-placeholder">
          まだ学習例がありません。Mail Modal から「学習させる」を押すと貯まっていきます。
        </div>
      ) : (
        <div className="mail-training-list">
          {BUCKET_ORDER.map((b) => {
            const items = grouped[b];
            if (items.length === 0) return null;
            const isOpen = openBuckets.has(b);
            return (
              <div className={`mail-training-group bucket-${b}`} key={b}>
                <button
                  type="button"
                  className="mail-training-group-head"
                  onClick={() => toggleBucket(b)}
                >
                  <span className={`mail-training-group-badge bucket-${b}`}>
                    {BUCKET_LABEL[b]}
                  </span>
                  <span className="mail-training-group-count">{items.length} 件</span>
                  <span className="mail-training-group-chev">{isOpen ? "▾" : "▸"}</span>
                </button>
                {isOpen && (
                  <ul className="mail-training-items">
                    {items.map((ex) => (
                      <li key={ex.id} className="mail-training-item">
                        <div className="mail-training-item-head">
                          <div className="mail-training-item-subject">
                            {ex.sourceSubject ?? extractSubjectFromEmbed(ex.embeddedText) ?? "(件名なし)"}
                            {ex.sourceMailId === null && (
                              <span className="mail-training-item-note">元削除済</span>
                            )}
                          </div>
                          <div className="mail-training-item-actions">
                            <button
                              type="button"
                              className="mail-training-item-btn"
                              onClick={() => setEditingId(ex.id)}
                            >
                              編集
                            </button>
                            <button
                              type="button"
                              className="mail-training-item-btn danger"
                              onClick={() => void onDelete(ex.id)}
                            >
                              削除
                            </button>
                          </div>
                        </div>
                        <div className="mail-training-item-hint">{ex.hintText}</div>
                        {(ex.autoTodo || ex.autoEvent) && (
                          <div className="mail-training-item-flags">
                            {ex.autoTodo && <span className="mail-training-flag">TODO 自動</span>}
                            {ex.autoEvent && <span className="mail-training-flag">予定自動</span>}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editingId !== null && (
        <TrainingExampleEditModal
          example={examples.find((e) => e.id === editingId)!}
          onClose={() => setEditingId(null)}
          onSaved={(updated) => {
            setExamples((cur) =>
              cur.map((e) => (e.id === updated.id ? { ...e, ...updated } : e))
            );
            setEditingId(null);
          }}
        />
      )}
    </section>
  );
}

/** embedded_text の先頭から「subject: ...」行を拾う (sourceSubject が NULL の時の fallback) */
function extractSubjectFromEmbed(s: string): string | null {
  const m = s.match(/^subject:\s*(.+)$/m);
  return m?.[1]?.trim() || null;
}

function TrainingExampleEditModal(props: {
  example: TrainingExample;
  onClose: () => void;
  onSaved: (updated: Partial<TrainingExample> & { id: number }) => void;
}) {
  const ex = props.example;
  const [bucket, setBucket] = useState<TrainingExample["bucket"]>(ex.bucket);
  const [hint, setHint] = useState(ex.hintText);
  const [autoTodo, setAutoTodo] = useState(ex.autoTodo);
  const [autoEvent, setAutoEvent] = useState(ex.autoEvent);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/mail-training/${ex.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bucket,
          hintText: hint.trim(),
          autoTodo: bucket === "important" ? autoTodo : false,
          autoEvent: bucket === "important" ? autoEvent : false,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      props.onSaved({
        id: ex.id,
        bucket,
        hintText: hint.trim(),
        autoTodo: bucket === "important" ? autoTodo : false,
        autoEvent: bucket === "important" ? autoEvent : false,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="mail-training-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) props.onClose();
      }}
    >
      <div className="mail-training-modal">
        <div className="mail-training-header">
          <h3>学習例を編集</h3>
          <button
            type="button"
            className="mail-training-close"
            onClick={() => !saving && props.onClose()}
            disabled={saving}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
        <div className="mail-training-body">
          <div className="mail-training-mail">
            <div className="mail-training-mail-subject">
              {ex.sourceSubject ?? extractSubjectFromEmbed(ex.embeddedText) ?? "(件名なし)"}
              {ex.sourceMailId === null && (
                <span className="mail-training-item-note"> (元削除済)</span>
              )}
            </div>
          </div>

          <div className="mail-training-section">
            <div className="mail-training-label">分類</div>
            <div className="mail-training-bucket-row">
              {(["important", "needed", "unneeded"] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  className={`mail-training-bucket-btn bucket-${b}${bucket === b ? " selected" : ""}`}
                  onClick={() => setBucket(b)}
                  disabled={saving}
                >
                  {BUCKET_LABEL[b]}
                </button>
              ))}
            </div>
          </div>

          {bucket === "important" && (
            <div className="mail-training-section">
              <div className="mail-training-label">自動アクション</div>
              <label className="mail-training-checkbox">
                <input
                  type="checkbox"
                  checked={autoTodo}
                  onChange={(e) => setAutoTodo(e.target.checked)}
                  disabled={saving}
                />
                <span>TODO に自動登録する</span>
              </label>
              <label className="mail-training-checkbox">
                <input
                  type="checkbox"
                  checked={autoEvent}
                  onChange={(e) => setAutoEvent(e.target.checked)}
                  disabled={saving}
                />
                <span>予定 (カレンダー) に自動登録する</span>
              </label>
            </div>
          )}

          <div className="mail-training-section">
            <div className="mail-training-label">判定の理由</div>
            <textarea
              name="mail-settings-training-hint"
              className="mail-training-hint"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              rows={5}
              disabled={saving}
            />
          </div>

          {error && <div className="mail-training-error">{error}</div>}
        </div>
        <div className="mail-training-foot">
          <button
            type="button"
            className="mail-training-cancel"
            onClick={props.onClose}
            disabled={saving}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="mail-training-save"
            onClick={() => void save()}
            disabled={saving || hint.trim().length === 0}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
