"use client";

/**
 * メール仕分け学習モーダル。
 *
 * 設計: docs/mail-classification.md §6.1, §8.1
 *
 * 3 ボタン (重要/要/不要) + 自然言語ヒント textarea。
 * POST /api/mail-training で embed + INSERT、元 mail の bucket も上書き。
 * 既存ラベル (props.currentBucket / currentHint) があれば pre-fill された訂正モードになる。
 */
import { useEffect, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";

type Bucket = "important" | "needed" | "unneeded";

const BUCKET_LABEL: Record<Bucket, string> = {
  important: "重要",
  needed: "要",
  unneeded: "不要",
};

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void; // 保存成功後 (一覧 / 詳細の再 fetch 用)
  mailId: number;
  mailSubject: string | null;
  mailFromLabel: string; // "依田 沙希 <yoda@example.com>" 等の表示用
  currentBucket?: Bucket | null;
  currentHint?: string | null;
  currentAutoTodo?: boolean;
  currentAutoEvent?: boolean;
};

export default function MailTrainingModal(props: Props) {
  const { mounted, closing } = useModalTransition(props.open);
  const [bucket, setBucket] = useState<Bucket | null>(null);
  const [hint, setHint] = useState("");
  const [autoTodo, setAutoTodo] = useState(false);
  const [autoEvent, setAutoEvent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // open / props 変化時に編集 form をリセット (= 別メールを開いた時に前のメールの編集が残らないように)。
  // 公式 anti-pattern #3 (key prop で remount) の方が綺麗だが follow-up とする。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!props.open) return;
    setBucket(props.currentBucket ?? null);
    setHint(props.currentHint ?? "");
    setAutoTodo(props.currentAutoTodo ?? false);
    setAutoEvent(props.currentAutoEvent ?? false);
    setError(null);
  }, [
    props.open, props.mailId, props.currentBucket, props.currentHint,
    props.currentAutoTodo, props.currentAutoEvent,
  ]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!mounted) return null;

  const save = async () => {
    if (!bucket) {
      setError("分類 (重要 / 要 / 不要) を選択してください");
      return;
    }
    if (hint.trim().length === 0) {
      setError("判定の理由を入力してください");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/mail-training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailId: props.mailId,
          bucket,
          hintText: hint.trim(),
          // 重要 以外で送られても server 側で強制 false
          autoTodo: bucket === "important" ? autoTodo : false,
          autoEvent: bucket === "important" ? autoEvent : false,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      props.onSaved?.();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`mail-training-backdrop${closing ? " modal-closing" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) props.onClose();
      }}
    >
      <div className={`mail-training-modal${closing ? " modal-closing" : ""}`}>
        <div className="mail-training-header">
          <h3>このメールを学習する</h3>
          <button
            type="button"
            className="mail-training-close"
            onClick={() => !saving && props.onClose()}
            aria-label="閉じる"
            disabled={saving}
          >
            ×
          </button>
        </div>

        <div className="mail-training-body">
          <div className="mail-training-mail">
            <div className="mail-training-mail-from">{props.mailFromLabel}</div>
            <div className="mail-training-mail-subject">
              {props.mailSubject ?? "(件名なし)"}
            </div>
          </div>

          <div className="mail-training-section">
            <div className="mail-training-label">分類</div>
            <div className="mail-training-bucket-row">
              {(["important", "needed", "unneeded"] as Bucket[]).map((b) => (
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
              <div className="mail-training-label">
                自動アクション (このタイプのメールに対して)
              </div>
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
              <div className="mail-training-hint-note">
                チェックが無ければ受信箱で目立たせるだけ。発動は Phase 3 以降。
              </div>
            </div>
          )}

          <div className="mail-training-section">
            <div className="mail-training-label">判定の理由 (この種類のメールの特徴)</div>
            <textarea
              name="mail-training-hint"
              className="mail-training-hint"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="例: 営業フォームの自動受付。本文に予約フィールドが echo されているのが特徴。"
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
            disabled={saving || !bucket || hint.trim().length === 0}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
