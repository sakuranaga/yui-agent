/**
 * タイマー / アラーム の CRUD と発火スケジューラ。
 *
 * - DB (timers) に永続化されているので browser リロード / サーバー再起動でも消えない
 * - boot 時に rearmAllPending() で pending 全件を再 schedule
 * - 発火時に SSE で frontend に通知
 *
 * 単一プロセス前提 (in-memory Map で setTimeout を保持)。
 * スケールするなら Redis + 共有ワーカに移行。
 */
import { db } from "@/db/client";
import { timers, type Timer } from "@/db/schema";
import { and, eq, gt, lte } from "drizzle-orm";
import { pushToSession } from "@/lib/jobs/events";
import { writeAssistantMessage } from "@/lib/memory";

// 個別の setTimeout ハンドルを id → handle で保持 (cancel 用)
const activeTimeouts = new Map<number, ReturnType<typeof setTimeout>>();

// 最大予約秒数 (例: 30 日先)。これより先は弾く
const MAX_SCHEDULE_MS = 30 * 86400 * 1000;

// Node の setTimeout は 32bit signed int を超える delay を 1ms に丸めて即発火させる
// (TimeoutOverflowWarning)。24.86 日 (= 2^31-1 ms) を超える場合はチャンクで分割再arm。
const INT32_MAX_MS = 2_147_483_647;

export type CreateTimerInput = {
  sessionId: string;
  kind: "timer" | "alarm";
  label?: string | null;
  // 相対: from-now の秒数
  durationSeconds?: number;
  // 絶対: ISO 8601 (JST 推奨)
  targetAt?: string;
  // 発火時に Yui に実行させる prompt (例: "ポップスかけて", "今日のニュース教えて")
  onFirePrompt?: string | null;
};

export async function createTimer(input: CreateTimerInput): Promise<Timer> {
  let targetMs: number;
  if (input.durationSeconds !== undefined) {
    if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
      throw new Error(`durationSeconds must be positive number: ${input.durationSeconds}`);
    }
    targetMs = Date.now() + input.durationSeconds * 1000;
  } else if (input.targetAt) {
    const t = new Date(input.targetAt).getTime();
    if (!Number.isFinite(t)) throw new Error(`invalid targetAt: ${input.targetAt}`);
    if (t <= Date.now()) {
      throw new Error(`targetAt must be in the future: ${input.targetAt}`);
    }
    targetMs = t;
  } else {
    throw new Error("either durationSeconds or targetAt is required");
  }

  if (targetMs - Date.now() > MAX_SCHEDULE_MS) {
    throw new Error("target too far in the future (max 30 days)");
  }

  const [row] = await db
    .insert(timers)
    .values({
      sessionId: input.sessionId,
      kind: input.kind,
      label: input.label ?? null,
      targetAt: new Date(targetMs),
      onFirePrompt: input.onFirePrompt ?? null,
    })
    .returning();

  schedule(row);
  pushToSession(input.sessionId, {
    type: "timer_created",
    id: row.id,
    kind: row.kind,
    label: row.label,
    targetAt: row.targetAt.toISOString(),
  });
  return row;
}

export async function cancelTimer(id: number): Promise<boolean> {
  const handle = activeTimeouts.get(id);
  if (handle) {
    clearTimeout(handle);
    activeTimeouts.delete(id);
  }
  const [row] = await db
    .update(timers)
    .set({ status: "cancelled" })
    .where(and(eq(timers.id, id), eq(timers.status, "pending")))
    .returning();
  if (row) {
    pushToSession(row.sessionId, { type: "timer_cancelled", id });
    return true;
  }
  return false; // 既に fired/cancelled
}

/**
 * fuzzy cancel: label 部分一致 or kind 一致で、active な中で最新のもの 1 件を cancel。
 * 「タイマー取り消し」「ラーメンタイマー止めて」等のために。
 */
export async function cancelTimerByMatch(opts: {
  sessionId: string;
  match?: string;
  kind?: "timer" | "alarm";
}): Promise<Timer | null> {
  const list = await listActiveTimers(opts.sessionId);
  if (list.length === 0) return null;
  let candidate: Timer | undefined;
  if (opts.match) {
    const m = opts.match.toLowerCase();
    candidate = list.find(
      (t) => t.label?.toLowerCase().includes(m) || t.kind.includes(m)
    );
  }
  if (!candidate && opts.kind) {
    candidate = list.find((t) => t.kind === opts.kind);
  }
  if (!candidate) candidate = list[0]; // 最新の active
  if (!candidate) return null;
  await cancelTimer(candidate.id);
  return candidate;
}

export async function listActiveTimers(sessionId?: string): Promise<Timer[]> {
  const where = sessionId
    ? and(eq(timers.status, "pending"), eq(timers.sessionId, sessionId))
    : eq(timers.status, "pending");
  return await db
    .select()
    .from(timers)
    .where(where)
    .orderBy(timers.targetAt);
}

/** boot 時に DB の pending 全件 (このプロセス境界では cancel/fire できなかった) を再 schedule */
export async function rearmAllPending(): Promise<number> {
  const now = new Date();
  // 過去分 (停止中に過ぎたもの): 即発火扱い
  const overdue = await db
    .select()
    .from(timers)
    .where(and(eq(timers.status, "pending"), lte(timers.targetAt, now)));
  for (const t of overdue) {
    void fireNow(t);
  }
  // 未来分: 通常 schedule
  const future = await db
    .select()
    .from(timers)
    .where(and(eq(timers.status, "pending"), gt(timers.targetAt, now)));
  for (const t of future) {
    schedule(t);
  }
  return overdue.length + future.length;
}

function schedule(row: Timer): void {
  const delay = Math.max(0, row.targetAt.getTime() - Date.now());
  scheduleChunked(row, delay);
}

// delay > INT32_MAX_MS の場合、INT32_MAX_MS だけ待って残時間で再 schedule。
// 残時間は再計算 (drift 補正 = 中断中の壁時計ズレに耐える)。
function scheduleChunked(row: Timer, delay: number): void {
  if (delay <= INT32_MAX_MS) {
    const handle = setTimeout(() => fireNow(row), delay);
    activeTimeouts.set(row.id, handle);
    return;
  }
  const handle = setTimeout(() => {
    const remaining = Math.max(0, row.targetAt.getTime() - Date.now());
    scheduleChunked(row, remaining);
  }, INT32_MAX_MS);
  activeTimeouts.set(row.id, handle);
}

async function fireNow(row: Timer): Promise<void> {
  activeTimeouts.delete(row.id);
  // 既に fired/cancelled なら ignore
  const [updated] = await db
    .update(timers)
    .set({ status: "fired", firedAt: new Date() })
    .where(and(eq(timers.id, row.id), eq(timers.status, "pending")))
    .returning();
  if (!updated) return;

  const hasAction = !!updated.onFirePrompt;

  pushToSession(updated.sessionId, {
    type: "timer_fired",
    id: updated.id,
    kind: updated.kind,
    label: updated.label,
    targetAt: updated.targetAt.toISOString(),
    hasAction,
  });

  if (hasAction) {
    // 内部 chat dispatch: Yui に発火時 prompt を実行させる。
    // SSE 通知の voice は frontend で suppress される (hasAction=true)、代わりに
    // chat route 経由の ack + 後続の specialist 結果 voice が流れる。
    void dispatchOnFireAction(updated).catch((e) =>
      console.warn(`[timer ${updated.id}] dispatchOnFireAction failed:`, e)
    );
  } else {
    // 通知のみ: history 復元用に Yui voice テキストを raw_messages に保存
    const labelPart = updated.label ? `「${updated.label}」の` : "";
    const kindPart = updated.kind === "timer" ? "タイマー" : "アラーム";
    const text = `${labelPart}${kindPart}の時間ですよ、ご主人様。`;
    void writeAssistantMessage({
      sessionId: updated.sessionId,
      source: "web",
      content: text,
      emotion: "relaxed",
    }).catch((e) => console.warn(`[timer ${updated.id}] writeAssistantMessage failed:`, e));
  }
}

/**
 * 発火時 prompt を Yui に実行させる。内部で /api/chat に POST する。
 * SSE は session 単位で発火するので、結果は元の session の frontend に届く。
 */
async function dispatchOnFireAction(timer: Timer): Promise<void> {
  const prompt = timer.onFirePrompt;
  if (!prompt) return;
  const port = process.env.PORT ?? "3000";
  const url = `http://localhost:${port}/api/chat`;
  try {
    const { internalFetch } = await import("@/lib/internal-fetch");
    const res = await internalFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // 保存 prompt を生の user message として再投入しない (= prompt injection 対策)。
        // 代わりに source: "timer" + timerEvent.savedText で渡し、chat route 側で
        // 固定 system guard + untrusted ラップ + tool allowlist 絞り込みを掛ける。
        messages: [],
        sessionId: timer.sessionId,
        source: "timer",
        timerEvent: {
          id: timer.id,
          kind: timer.kind,
          label: timer.label ?? null,
          targetAt: timer.targetAt.toISOString(),
          savedText: prompt,
        },
      }),
    });
    if (!res.ok) {
      console.warn(`[timer ${timer.id}] internal /api/chat → ${res.status}`);
    }
    // 応答 JSON 自体は捨てる (SSE 経由で frontend に届く)。chat route が
    // source=timer のとき yui_message を SSE push してくれる前提。
  } catch (e) {
    console.warn(`[timer ${timer.id}] internal dispatch error:`, e);
  }
}
