"use client";

/**
 * ヘルス目標管理 modal。
 * - 既存目標を kind ごとに一覧
 * - 新規追加 (kind + metric_key + target_value + deadline?)
 * - 編集 / 無効化 / 削除
 *
 * 設計: docs/health-goals.md §6.2 / §6.3
 */
import { useCallback, useEffect, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";

type Kind = "one_time_by_date" | "daily_min" | "daily_max";

type Goal = {
  id: number;
  metricKey: string;
  kind: Kind;
  targetValue: number;
  baselineValue: number | null;
  deadline: string | null;
  startDate: string;
  label: string | null;
  enabled: boolean;
  notes: string | null;
  achievedAt: string | null;
};

type GoalStatus =
  | { kind: "one_time_by_date"; current: number | null; target: number;
      baseline: number | null; remaining: number | null;
      progressPct: number | null; daysLeft: number;
      pace: "ok" | "behind" | "ahead" | "fail" | "achieved" | "unknown" }
  | { kind: "daily_min"; today: number | null; target: number;
      achieved: boolean; ratio: number | null; remaining: number | null }
  | { kind: "daily_max"; today: number | null; cap: number;
      exceeded: boolean; ratio: number | null; remaining: number | null;
      zone: "green" | "yellow" | "red" | "unknown" };

type Item = { goal: Goal; status: GoalStatus };

// kind ごとの妥当 metric_key
const METRICS_BY_KIND: Record<Kind, Array<{ key: string; label: string; unit: string }>> = {
  one_time_by_date: [
    { key: "weight_kg",     label: "体重",     unit: "kg" },
    { key: "body_fat_pct",  label: "体脂肪率", unit: "%" },
  ],
  daily_min: [
    { key: "steps_daily",          label: "歩数",          unit: "歩" },
    { key: "active_kcal_daily",    label: "活動 kcal",    unit: "kcal" },
    { key: "exercise_min_daily",   label: "運動分",        unit: "分" },
    { key: "sleep_hours_daily",    label: "睡眠時間",      unit: "h" },
    { key: "distance_km_daily",    label: "距離",          unit: "km" },
    { key: "protein_daily_total",  label: "タンパク質",    unit: "g" },
    { key: "fiber_daily_total",    label: "食物繊維",      unit: "g" },
  ],
  daily_max: [
    { key: "kcal_daily_total",    label: "食事 kcal",    unit: "kcal" },
    { key: "carbs_daily_total",   label: "炭水化物",      unit: "g" },
    { key: "fat_daily_total",     label: "脂質",          unit: "g" },
  ],
};

const KIND_LABEL: Record<Kind, string> = {
  one_time_by_date: "期限付き到達",
  daily_min: "毎日達成 (下限)",
  daily_max: "毎日上限 (超えない)",
};

type Props = { open: boolean; onClose: () => void };

export default function HealthGoalsModal({ open, onClose }: Props) {
  const { mounted, closing } = useModalTransition(open);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/health/goals?withStatus=1", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items: Item[] };
      setItems(data.items);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // modal open 時に load。load 内 setState は async 後で cascade ではない。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open fetch
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const disable = async (g: Goal) => {
    if (!confirm(`「${labelOf(g)}」を無効化します。よろしいですか?`)) return;
    const res = await fetch(`/api/health/goals/${g.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    if (res.ok) void load();
  };
  const remove = async (g: Goal) => {
    if (!confirm(`「${labelOf(g)}」を完全に削除します。よろしいですか?`)) return;
    const res = await fetch(`/api/health/goals/${g.id}`, { method: "DELETE" });
    if (res.ok) void load();
  };
  const reenable = async (g: Goal) => {
    const res = await fetch(`/api/health/goals/${g.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    if (res.ok) void load();
  };

  if (!mounted) return null;

  const byKind: Record<Kind, Item[]> = {
    one_time_by_date: [],
    daily_min: [],
    daily_max: [],
  };
  for (const it of items) byKind[it.goal.kind].push(it);

  return (
    <div className={`health-goals-modal-backdrop${closing ? " modal-closing" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`health-goals-modal${closing ? " modal-closing" : ""}`}>
        <button type="button" className="health-modal-close" onClick={onClose} aria-label="閉じる">×</button>
        <header className="health-goals-modal-header">
          <h1>ヘルス目標</h1>
          <button
            type="button"
            className="todo-add-btn"
            onClick={() => setShowCreate(true)}
          >＋ 新規目標</button>
        </header>
        <div className="health-goals-body">
          {loading && <div className="health-empty">読み込み中…</div>}
          {!loading && items.length === 0 && (
            <div className="health-empty">目標がまだ登録されていません。「＋ 新規目標」から追加してください。</div>
          )}
          {(["one_time_by_date", "daily_min", "daily_max"] as Kind[]).map((k) => (
            byKind[k].length > 0 && (
              <section key={k} className="health-goals-kind">
                <h2 className="health-goals-kind-title">{KIND_LABEL[k]}</h2>
                <div className="health-goals-list">
                  {byKind[k].map(({ goal, status }) => (
                    <GoalRow
                      key={goal.id}
                      goal={goal}
                      status={status}
                      onDisable={() => void disable(goal)}
                      onReenable={() => void reenable(goal)}
                      onDelete={() => void remove(goal)}
                    />
                  ))}
                </div>
              </section>
            )
          ))}
        </div>
        {showCreate && (
          <CreatePopup onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); void load(); }} />
        )}
      </div>
    </div>
  );
}

function labelOf(g: Goal): string {
  if (g.label) return g.label;
  const m = [...METRICS_BY_KIND.one_time_by_date, ...METRICS_BY_KIND.daily_min, ...METRICS_BY_KIND.daily_max]
    .find((x) => x.key === g.metricKey);
  return `${m?.label ?? g.metricKey} ${g.targetValue}${m?.unit ?? ""}`;
}

function GoalRow({
  goal, status, onDisable, onReenable, onDelete,
}: {
  goal: Goal;
  status: GoalStatus;
  onDisable: () => void;
  onReenable: () => void;
  onDelete: () => void;
}) {
  const label = labelOf(goal);
  return (
    <div className={`health-goals-row${goal.enabled ? "" : " disabled"}`}>
      <div className="health-goals-row-head">
        <span className="health-goals-row-label">{label}</span>
        {goal.achievedAt && <span className="health-goals-badge achieved">達成 ✓</span>}
        {!goal.enabled && <span className="health-goals-badge disabled">無効</span>}
      </div>
      <div className="health-goals-row-status">
        {renderStatus(status)}
      </div>
      <div className="health-goals-row-actions">
        {goal.enabled
          ? <button type="button" className="health-goals-btn" onClick={onDisable}>無効化</button>
          : <button type="button" className="health-goals-btn" onClick={onReenable}>有効化</button>
        }
        <button type="button" className="health-goals-btn danger" onClick={onDelete}>削除</button>
      </div>
    </div>
  );
}

function renderStatus(s: GoalStatus): React.ReactNode {
  if (s.kind === "one_time_by_date") {
    if (s.pace === "achieved") return <span className="ok">達成済</span>;
    if (s.current === null) return <span className="muted">測定値なし</span>;
    const pct = s.progressPct !== null ? `${Math.round(s.progressPct)}%` : "?";
    const paceText = {
      ok: "順調", behind: "やや遅れ気味", ahead: "ペース上回り",
      fail: "期限超過", achieved: "達成", unknown: "?",
    }[s.pace];
    return (
      <>
        <span className="health-goals-progress">{pct}</span>
        <span className="muted">現在 {s.current?.toFixed(1)} / 目標 {s.target.toFixed(1)} / 残り {s.daysLeft} 日</span>
        <span className={`health-goals-pace ${s.pace}`}>{paceText}</span>
      </>
    );
  }
  if (s.kind === "daily_min") {
    if (s.today === null) return <span className="muted">未測定</span>;
    const pct = s.ratio !== null ? Math.round(s.ratio * 100) : 0;
    return (
      <>
        <span className={`health-goals-progress ${s.achieved ? "ok" : ""}`}>
          {s.today.toFixed(0)} / {s.target.toFixed(0)} ({pct}%)
        </span>
        <span className="muted">{s.achieved ? "達成" : `あと ${(s.remaining ?? 0).toFixed(0)}`}</span>
      </>
    );
  }
  if (s.today === null) return <span className="muted">未測定</span>;
  const pct = s.ratio !== null ? Math.round(s.ratio * 100) : 0;
  return (
    <>
      <span className={`health-goals-progress ${s.zone}`}>
        {s.today.toFixed(0)} / 上限 {s.cap.toFixed(0)} ({pct}%)
      </span>
      <span className="muted">{s.exceeded ? `超過 ${(-(s.remaining ?? 0)).toFixed(0)}` : `残り ${(s.remaining ?? 0).toFixed(0)}`}</span>
    </>
  );
}

function CreatePopup({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<Kind>("daily_min");
  const [metricKey, setMetricKey] = useState<string>(METRICS_BY_KIND.daily_min[0].key);
  const [target, setTarget] = useState<string>("");
  const [deadline, setDeadline] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onKindChange = (k: Kind) => {
    setKind(k);
    setMetricKey(METRICS_BY_KIND[k][0].key);
  };

  const submit = async () => {
    const t = parseFloat(target);
    if (!Number.isFinite(t)) {
      setErr("目標値を入力してください");
      return;
    }
    if (kind === "one_time_by_date" && !deadline) {
      setErr("期限を入力してください");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/health/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metric_key: metricKey,
          kind,
          target_value: t,
          deadline: kind === "one_time_by_date" ? deadline : null,
          label: label.trim() || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error ?? `失敗: ${res.status}`);
        return;
      }
      onCreated();
    } finally {
      setBusy(false);
    }
  };

  const metrics = METRICS_BY_KIND[kind];
  const currentMetric = metrics.find((m) => m.key === metricKey);

  return (
    <div className="confirm-popup-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="confirm-popup confirm-popup-accent health-goals-create-popup" role="dialog" aria-modal="true">
        <h2 className="confirm-popup-title">新規目標</h2>
        <div className="health-goals-create-fields">
          <label className="health-goals-create-row">
            <span>種類</span>
            <select value={kind} onChange={(e) => onKindChange(e.target.value as Kind)}>
              <option value="one_time_by_date">期限付き到達 (例: 65kg まで)</option>
              <option value="daily_min">毎日達成 (例: 1万歩)</option>
              <option value="daily_max">毎日上限 (例: 2,000kcal 未満)</option>
            </select>
          </label>
          <label className="health-goals-create-row">
            <span>メトリクス</span>
            <select value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
              {metrics.map((m) => (
                <option key={m.key} value={m.key}>{m.label} ({m.unit})</option>
              ))}
            </select>
          </label>
          <label className="health-goals-create-row">
            <span>目標値</span>
            <input
              name="health-goal-target"
              type="number" step={0.1}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={`例: ${kind === "daily_min" ? "10000" : kind === "daily_max" ? "2000" : "65"}`}
            />
            <span className="health-goals-create-unit">{currentMetric?.unit ?? ""}</span>
          </label>
          {kind === "one_time_by_date" && (
            <label className="health-goals-create-row">
              <span>期限</span>
              <input
                name="health-goal-deadline"
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </label>
          )}
          <label className="health-goals-create-row">
            <span>ラベル (任意)</span>
            <input
              name="health-goal-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例: 夏までに減量"
            />
          </label>
          {err && <div className="health-goals-create-err">{err}</div>}
        </div>
        <div className="confirm-popup-actions">
          <button type="button" className="confirm-cancel-btn" onClick={onClose}>キャンセル</button>
          <button type="button" className="confirm-confirm-btn" onClick={() => void submit()} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
