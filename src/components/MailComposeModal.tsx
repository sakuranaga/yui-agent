"use client";

/**
 * メール送信モーダル (Compose Modal)。
 *
 * - 新規 / 返信 / 転送 の 3 モード
 * - 宛先は contacts 連動 (autocomplete + popup)
 * - 「校正」ボタン: Sonnet で本文を整形 → 左右並びで差分表示 → 採用 / キャンセル
 * - 「返信を書かせる」 (返信モード): intent プリセット (了承/断り/保留/単純確認) → 本文置換
 * - 下書き保存: Gmail Drafts へ、成功後モーダル自動 close
 * - 送信: user 明示クリックのみ
 *
 * 設計: docs/mail-system.md §6.2.5
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";

export type ComposeMode =
  | { kind: "new"; toPrefill?: string[]; subjectPrefill?: string }
  | { kind: "reply"; inReplyToDbId: number; to: string[]; subject: string; quotedBody?: string; fromAccountEmail: string }
  | { kind: "forward"; inReplyToDbId: number; subject: string; quotedBody: string; fromAccountEmail: string };

type Account = {
  id: number;
  email: string;
  displayName: string | null;
  enabled: boolean;
  isPrimary: boolean;
};

type ContactHit = {
  id: number;
  name: string;
  kana: string | null;
  company: string | null;
  emails: Array<{ type: string | null; value: string }>;
};

type Props = {
  open: boolean;
  mode: ComposeMode | null;
  onClose: () => void;
};

type ReplyIntent = "agree" | "decline" | "hold" | "ack";

export default function MailComposeModal({ open, mode, onClose }: Props) {
  const { mounted, closing } = useModalTransition(open);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [fromEmail, setFromEmail] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const [polishing, setPolishing] = useState(false);
  const [polished, setPolished] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contactsOpen, setContactsOpen] = useState(false);
  const [contactsQuery, setContactsQuery] = useState("");
  const [contactsHits, setContactsHits] = useState<ContactHit[]>([]);
  const [autocomplete, setAutocomplete] = useState<{ field: "to" | "cc" | "bcc"; hits: ContactHit[] } | null>(null);

  const toInputRef = useRef<HTMLInputElement>(null);

  // 初期化: open / mode 切替時にフィールドを reset。
  // 本来は <MailComposeModal key={mode?.kind ?? "new"}> で remount すれば自前 reset 不要
  // (React 公式 anti-pattern #3 の正攻法) だが、親側の整理を伴うので follow-up とし、
  // ここは block disable で legitimate sync として扱う。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setError(null);
    setPolished(null);
    setCc("");
    setBcc("");
    setShowCcBcc(false);
    if (!mode || mode.kind === "new") {
      setTo(mode?.toPrefill?.join(", ") ?? "");
      setSubject(mode?.subjectPrefill ?? "");
      setBody("");
    } else if (mode.kind === "reply") {
      setTo(mode.to.join(", "));
      setSubject(mode.subject.startsWith("Re: ") ? mode.subject : `Re: ${mode.subject}`);
      setBody(mode.quotedBody ?? "");
    } else if (mode.kind === "forward") {
      setTo("");
      setSubject(mode.subject.startsWith("Fwd: ") ? mode.subject : `Fwd: ${mode.subject}`);
      setBody(mode.quotedBody);
    }
  }, [open, mode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // accounts 取得 + from default 解決 (返信 / 転送なら元の受信アカウント、新規は primary)
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const res = await fetch("/api/mail/accounts", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { accounts: Account[] };
        setAccounts(data.accounts);
        if (mode && mode.kind !== "new") {
          setFromEmail(mode.fromAccountEmail);
        } else {
          const primary = data.accounts.find((a) => a.isPrimary) ?? data.accounts[0];
          setFromEmail(primary?.email ?? "");
        }
      } catch (e) {
        console.warn("[compose] accounts load failed:", e);
      }
    })();
  }, [open, mode]);

  // Esc で close (差分表示中なら差分だけ閉じる)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (polished !== null) {
        setPolished(null);
        return;
      }
      if (autocomplete) {
        setAutocomplete(null);
        return;
      }
      if (contactsOpen) {
        setContactsOpen(false);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, polished, autocomplete, contactsOpen, onClose]);

  // 宛先 autocomplete (debounce 200ms)
  const fetchContacts = useCallback(async (q: string): Promise<ContactHit[]> => {
    const res = await fetch(`/api/mail/contacts-search?q=${encodeURIComponent(q)}&limit=10`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { contacts: ContactHit[] };
    return data.contacts;
  }, []);

  const handleAddrChange = useCallback(
    (field: "to" | "cc" | "bcc", value: string) => {
      if (field === "to") setTo(value);
      else if (field === "cc") setCc(value);
      else setBcc(value);

      // 最後のカンマ以降を query にして autocomplete
      const last = value.split(",").pop()?.trim() ?? "";
      if (last.length < 1) {
        setAutocomplete(null);
        return;
      }
      void fetchContacts(last).then((hits) => {
        if (hits.length === 0) setAutocomplete(null);
        else setAutocomplete({ field, hits });
      });
    },
    [fetchContacts]
  );

  const insertEmail = useCallback(
    (field: "to" | "cc" | "bcc", email: string) => {
      const cur = field === "to" ? to : field === "cc" ? cc : bcc;
      const parts = cur.split(",").map((s) => s.trim()).filter(Boolean);
      parts.pop(); // 最後のクエリ部分を捨てる
      parts.push(email);
      const next = parts.join(", ") + ", ";
      if (field === "to") setTo(next);
      else if (field === "cc") setCc(next);
      else setBcc(next);
      setAutocomplete(null);
    },
    [to, cc, bcc]
  );

  // 連絡先 popup 検索
  useEffect(() => {
    if (!contactsOpen) return;
    void fetchContacts(contactsQuery).then(setContactsHits);
  }, [contactsOpen, contactsQuery, fetchContacts]);

  const parseAddrs = (s: string): string[] =>
    s.split(",").map((x) => x.trim()).filter(Boolean);

  const polish = async () => {
    if (!body.trim()) return;
    setPolishing(true);
    setError(null);
    try {
      const res = await fetch("/api/mail/polish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { polished: string };
      setPolished(data.polished);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolishing(false);
    }
  };

  const replyGenerate = async (intent: ReplyIntent) => {
    if (!mode || mode.kind !== "reply") return;
    setReplying(true);
    setError(null);
    try {
      const res = await fetch(`/api/mail/${mode.inReplyToDbId}/reply-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { body: string };
      setBody(data.body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReplying(false);
    }
  };

  const buildPayload = () => {
    const payload: {
      fromEmail: string;
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body: string;
      inReplyToDbId?: number;
    } = {
      fromEmail,
      to: parseAddrs(to),
      subject,
      body,
    };
    const ccs = parseAddrs(cc);
    if (ccs.length > 0) payload.cc = ccs;
    const bccs = parseAddrs(bcc);
    if (bccs.length > 0) payload.bcc = bccs;
    if (mode && mode.kind !== "new") {
      payload.inReplyToDbId = mode.inReplyToDbId;
    }
    return payload;
  };

  const send = async () => {
    if (!fromEmail || parseAddrs(to).length === 0) {
      setError("送信元と宛先は必須です");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/mail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 403) {
          throw new Error(
            "送信権限 (gmail.send) がありません。設定 > 連携 で Google を一度切断 → 再接続してください。"
          );
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const saveDraft = async () => {
    if (!fromEmail) {
      setError("送信元は必須です");
      return;
    }
    setSavingDraft(true);
    setError(null);
    try {
      const res = await fetch("/api/mail/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 403) {
          throw new Error("下書き保存権限 (gmail.compose) がありません。再連携が必要です。");
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingDraft(false);
    }
  };

  const title = useMemo(() => {
    if (!mode || mode.kind === "new") return "新規メール";
    if (mode.kind === "reply") return "返信";
    return "転送";
  }, [mode]);

  if (!mounted) return null;

  // 差分表示モード
  if (polished !== null) {
    return (
      <div
        className={`mail-modal-backdrop ${closing ? "modal-closing" : ""}`}
        onClick={(e) => { if (e.target === e.currentTarget) setPolished(null); }}
      >
        <div className={`mail-modal mail-polish-modal ${closing ? "modal-closing" : ""}`}>
          <button type="button" className="todo-modal-close" onClick={() => setPolished(null)}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
          <header className="mail-modal-header">
            <h1>校正結果</h1>
          </header>
          <div className="mail-polish-body">
            <div className="mail-polish-pane">
              <div className="mail-polish-label">元の本文</div>
              <pre className="mail-polish-text">{body}</pre>
            </div>
            <div className="mail-polish-pane">
              <div className="mail-polish-label">校正後</div>
              <pre className="mail-polish-text">{polished}</pre>
            </div>
          </div>
          <div className="mail-compose-foot">
            <button type="button" className="ai-edit-btn" onClick={() => setPolished(null)}>
              キャンセル
            </button>
            <button
              type="button"
              className="todo-add-btn"
              onClick={() => {
                setBody(polished);
                setPolished(null);
              }}
            >
              採用
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`mail-modal-backdrop ${closing ? "modal-closing" : ""}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`mail-modal mail-compose-modal ${closing ? "modal-closing" : ""}`}>
        <button type="button" className="todo-modal-close" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
        <header className="mail-modal-header">
          <h1>{title}</h1>
        </header>

        <div className="mail-compose-body">
          {/* From */}
          <div className="mail-compose-row">
            <label className="mail-compose-label">From</label>
            <select
              className="ai-input"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.email}>
                  {a.email}{a.isPrimary ? " (primary)" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* To */}
          <div className="mail-compose-row">
            <label className="mail-compose-label">宛先</label>
            <div className="mail-compose-input-with-btn">
              <input
                name="mail-compose-to"
                ref={toInputRef}
                type="text"
                className="ai-input"
                value={to}
                onChange={(e) => handleAddrChange("to", e.target.value)}
                placeholder="example@example.com"
              />
              <button
                type="button"
                className="ai-edit-btn mail-contacts-btn"
                onClick={() => { setContactsOpen(true); setContactsQuery(""); }}
                title="連絡先から選択"
                aria-label="連絡先から選択"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </button>
            </div>
            {autocomplete?.field === "to" && (
              <Autocomplete
                hits={autocomplete.hits}
                onPick={(email) => insertEmail("to", email)}
              />
            )}
          </div>

          {/* Cc / Bcc 折りたたみ */}
          {!showCcBcc ? (
            <button
              type="button"
              className="mail-compose-cc-toggle"
              onClick={() => setShowCcBcc(true)}
            >
              ＋ Cc / Bcc を追加
            </button>
          ) : (
            <>
              <div className="mail-compose-row">
                <label className="mail-compose-label">Cc</label>
                <input
                  name="mail-compose-cc"
                  type="text"
                  className="ai-input"
                  value={cc}
                  onChange={(e) => handleAddrChange("cc", e.target.value)}
                />
                {autocomplete?.field === "cc" && (
                  <Autocomplete hits={autocomplete.hits} onPick={(email) => insertEmail("cc", email)} />
                )}
              </div>
              <div className="mail-compose-row">
                <label className="mail-compose-label">Bcc</label>
                <input
                  name="mail-compose-bcc"
                  type="text"
                  className="ai-input"
                  value={bcc}
                  onChange={(e) => handleAddrChange("bcc", e.target.value)}
                />
                {autocomplete?.field === "bcc" && (
                  <Autocomplete hits={autocomplete.hits} onPick={(email) => insertEmail("bcc", email)} />
                )}
              </div>
            </>
          )}

          {/* 件名 */}
          <div className="mail-compose-row">
            <label className="mail-compose-label">件名</label>
            <input
              name="mail-compose-subject"
              type="text"
              className="ai-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="件名を入力"
            />
          </div>

          {/* 本文 */}
          <div className="mail-compose-row mail-compose-body-row">
            <textarea
              name="mail-compose-body"
              className="mail-compose-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="本文を入力"
            />
          </div>

          {/* Yui assist */}
          <div className="mail-compose-yui-row">
            <button
              type="button"
              className="ai-edit-btn"
              disabled={polishing || !body.trim()}
              onClick={() => void polish()}
              title="本文を丁寧な文体に整形"
            >
              {polishing ? "校正中…" : "ゆいに校正させる"}
            </button>
            {mode && mode.kind === "reply" && (
              <>
                <span className="mail-compose-divider">|</span>
                <span className="mail-compose-yui-label">返信:</span>
                {(["agree", "decline", "hold", "ack"] as const).map((intent) => (
                  <button
                    key={intent}
                    type="button"
                    className="ai-edit-btn"
                    disabled={replying}
                    onClick={() => void replyGenerate(intent)}
                  >
                    {INTENT_BTN_LABEL[intent]}
                  </button>
                ))}
              </>
            )}
          </div>

          {error && <div className="mail-compose-error">⚠ {error}</div>}
        </div>

        <div className="mail-compose-foot">
          <button
            type="button"
            className="ai-edit-btn"
            onClick={() => void saveDraft()}
            disabled={savingDraft}
          >
            {savingDraft ? "保存中…" : "下書き保存"}
          </button>
          <button type="button" className="ai-edit-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="todo-add-btn"
            onClick={() => void send()}
            disabled={sending || !fromEmail || !to.trim()}
          >
            {sending ? "送信中…" : "送信"}
          </button>
        </div>

        {/* 連絡先 popup */}
        {contactsOpen && (
          <div
            className="mail-contacts-popup-backdrop"
            onClick={(e) => { if (e.target === e.currentTarget) setContactsOpen(false); }}
          >
            <div className="mail-contacts-popup">
              <input
                name="mail-compose-contacts-search"
                type="text"
                className="ai-input"
                placeholder="名前 / 会社 / メアドで検索"
                value={contactsQuery}
                onChange={(e) => setContactsQuery(e.target.value)}
                autoFocus
              />
              <div className="mail-contacts-list">
                {contactsHits.length === 0 ? (
                  <div className="settings-placeholder">該当なし</div>
                ) : (
                  contactsHits.map((c) =>
                    c.emails.map((e) => (
                      <button
                        key={`${c.id}-${e.value}`}
                        type="button"
                        className="mail-contacts-item"
                        onClick={() => {
                          insertEmail("to", e.value);
                          setContactsOpen(false);
                        }}
                      >
                        <span className="mail-contacts-name">
                          {c.name}
                          {c.company && <span className="mail-contacts-company"> · {c.company}</span>}
                        </span>
                        <span className="mail-contacts-email">{e.value}{e.type && ` (${e.type})`}</span>
                      </button>
                    ))
                  )
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const INTENT_BTN_LABEL: Record<ReplyIntent, string> = {
  agree: "了承",
  decline: "断り",
  hold: "保留",
  ack: "単純確認",
};

function Autocomplete(props: { hits: ContactHit[]; onPick: (email: string) => void }) {
  return (
    <div className="mail-autocomplete">
      {props.hits.flatMap((c) =>
        c.emails.map((e) => (
          <button
            key={`${c.id}-${e.value}`}
            type="button"
            className="mail-autocomplete-item"
            onMouseDown={(ev) => {
              ev.preventDefault();
              props.onPick(e.value);
            }}
          >
            <span className="mail-autocomplete-name">{c.name}</span>
            <span className="mail-autocomplete-email">{e.value}</span>
          </button>
        ))
      )}
    </div>
  );
}
