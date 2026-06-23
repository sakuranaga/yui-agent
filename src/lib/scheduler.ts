/**
 * Periodic Module Scheduler
 *
 * boot 時に 1 回だけ起動し、registry の有効モジュールを setInterval で登録。
 * 各 tick で:
 *   1. DB から前回 snapshot 読み込み
 *   2. module.run(ctx) を呼ぶ
 *   3. snapshot を DB に書き戻し
 *   4. fire 要求があれば最新 active session を引いて /api/chat に内部 POST
 *      (timer.on_fire_prompt と同じ pattern。Yui ターン起動 → SSE で push)
 *
 * Next.js dev (HMR) 対策: globalThis フラグで重複起動を防止。
 */
import { db } from "@/db/client";
import { periodicState, rawMessages } from "@/db/schema";
import { eq, desc, ne, and } from "drizzle-orm";
import { listEnabled } from "@/periodic/registry";
import type { PeriodicModule } from "@/periodic/types";
import { withTrace } from "@/lib/llm";

declare global {
  // 既登録モジュール id → setInterval handle。
  // HMR で startScheduler が再 import される度に呼ばれても、id 別に dedup するので
  // 「初回起動時には未追加だった新モジュール」も後から拾える (= 開発中の追加が反映される)。
  var __vroidSchedulerHandlesById: Map<string, NodeJS.Timeout> | undefined;
}

function getHandleMap(): Map<string, NodeJS.Timeout> {
  if (!globalThis.__vroidSchedulerHandlesById) {
    globalThis.__vroidSchedulerHandlesById = new Map();
  }
  return globalThis.__vroidSchedulerHandlesById;
}

export function startScheduler(): void {
  const handles = getHandleMap();
  const modules = listEnabled();
  if (modules.length === 0) {
    if (handles.size === 0) console.log("[scheduler] no enabled modules");
    return;
  }

  let registeredNew = 0;
  for (const mod of modules) {
    if (handles.has(mod.id)) continue; // 既に登録済 → skip (dedup)
    if (mod.schedule.kind !== "interval") {
      console.warn(`[scheduler] module ${mod.id}: cron schedule not yet supported, skipping`);
      continue;
    }
    const everyMs = mod.schedule.everyMs;
    const handle = setInterval(() => {
      void tick(mod).catch((e) => console.error(`[scheduler:${mod.id}] tick error:`, e));
    }, everyMs);
    handles.set(mod.id, handle);
    registeredNew++;
    console.log(
      `[scheduler] registered ${mod.id} (interval ${Math.round(everyMs / 1000)}s)`
    );
    // 即時 1 tick は「前回 lastRunAt から everyMs 経過してる場合のみ」走らせる。
    // サーバ再起動 / Next.js HMR で in-memory ハンドルが消えても、DB に lastRunAt が
    // 残ってるので「最近走ったばかりなら即時 tick skip」できる。これでリロード/再起動
    // 直後にニュース等が再発火する事故を防ぐ。
    void shouldInitialTick(mod).then((should) => {
      if (should) {
        void tick(mod).catch((e) => console.error(`[scheduler:${mod.id}] initial tick error:`, e));
      } else if (process.env.DEBUG_SCHEDULER === "1") {
        console.log(`[scheduler:${mod.id}] initial tick skipped (lastRunAt recent)`);
      }
    });
  }
  if (registeredNew === 0 && process.env.NODE_ENV !== "production") {
    // dev で何度も呼ばれる際の noise を減らすため、新規登録 0 件はログを出さない
  }
}

// モジュール単位の in-flight ロック (= 前 tick がまだ実行中なら今 tick を skip)。
// setInterval は前 callback の完走を待たずに次を発火するので、run が interval を超える
// モジュール (= 例: morning-check で LLM が遅い場合) の自重複を防ぐ。
const inFlight = new Set<string>();

async function tick(mod: PeriodicModule): Promise<void> {
  if (inFlight.has(mod.id)) {
    if (process.env.DEBUG_SCHEDULER === "1") {
      console.log(`[scheduler:${mod.id}] skip: previous tick still in-flight`);
    }
    return;
  }
  inFlight.add(mod.id);
  try {
    return await withTrace(`periodic:${mod.id}`, () => tickInner(mod));
  } finally {
    inFlight.delete(mod.id);
  }
}

/**
 * 起動直後の即時 tick を打つべきかを判定。
 *  - 初回 (periodicState 行なし) → 打つ
 *  - lastRunAt から interval 経過済 → 打つ (= 普通に間隔が来た)
 *  - lastRunAt が直近 (interval 未満) → 打たない (= 再起動 / HMR 直後の重複発火を抑制)
 */
async function shouldInitialTick(mod: PeriodicModule): Promise<boolean> {
  if (mod.schedule.kind !== "interval") return false;
  try {
    const [row] = await db
      .select({ lastRunAt: periodicState.lastRunAt })
      .from(periodicState)
      .where(eq(periodicState.moduleId, mod.id))
      .limit(1);
    if (!row?.lastRunAt) return true;
    const elapsed = Date.now() - row.lastRunAt.getTime();
    return elapsed >= mod.schedule.everyMs;
  } catch (e) {
    console.warn(`[scheduler:${mod.id}] shouldInitialTick lookup failed:`, e);
    return true; // フォールバックは安全側 = 打つ
  }
}

async function tickInner(mod: PeriodicModule): Promise<void> {
  // 1) active session を引く
  const sessionId = await findActiveSessionId();
  if (!sessionId) {
    console.log(`[scheduler:${mod.id}] skip: no active session`);
    return;
  }

  // 2) snapshot 読み込み
  const [row] = await db
    .select()
    .from(periodicState)
    .where(eq(periodicState.moduleId, mod.id))
    .limit(1);
  const lastSnapshot = row?.snapshot ?? null;

  // 3) run
  const result = await mod.run({ sessionId, lastSnapshot });

  // 4) snapshot 書き戻し (result.snapshot があれば)
  const now = new Date();
  const snapshotToPersist =
    "snapshot" in result && result.snapshot !== undefined
      ? result.snapshot
      : lastSnapshot;
  if (row) {
    await db
      .update(periodicState)
      .set({
        snapshot: snapshotToPersist,
        lastRunAt: now,
        ...("fire" in result ? { lastFiredAt: now } : {}),
      })
      .where(eq(periodicState.moduleId, mod.id));
  } else {
    await db.insert(periodicState).values({
      moduleId: mod.id,
      snapshot: snapshotToPersist,
      lastRunAt: now,
      lastFiredAt: "fire" in result ? now : null,
    });
  }

  if ("skip" in result) {
    if (process.env.DEBUG_SCHEDULER === "1") {
      console.log(`[scheduler:${mod.id}] skip (${result.reason ?? ""})`);
    }
    return;
  }

  // 5) fire → Yui ターン起動
  console.log(`[scheduler:${mod.id}] FIRE: ${result.reason ?? ""}`);
  await firePromptToYui({ sessionId, prompt: result.fire.prompt });
}

/**
 * 周期モジュールが「お便り」を届ける宛先 session を決める。
 *
 * Web と Discord は別 session を持つ ([web のブラウザ session] と [Discord bot session])。
 * raw_messages の直近行をそのまま採用すると、ご主人様が直前に Discord で雑談しただけで
 * 日記 / 朝のブリーフが「Discord session 宛て」に保存されてしまい、Web のお便りに出ない。
 *
 * 解決: DISCORD_SESSION_ID は除外し、必ず Web 側の latest session を返す。
 * Discord 配信は saveNotification → forwardToDiscord 経路で別途行われるので二重配信もない。
 */
async function findActiveSessionId(): Promise<string | null> {
  const botSid = process.env.DISCORD_SESSION_ID;
  const conds = botSid ? [ne(rawMessages.sessionId, botSid)] : [];
  const [row] = await db
    .select({ sessionId: rawMessages.sessionId })
    .from(rawMessages)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(rawMessages.createdAt))
    .limit(1);
  return row?.sessionId ?? null;
}

async function firePromptToYui(args: { sessionId: string; prompt: string }): Promise<void> {
  try {
    const { maybeQueueCronPrompt } = await import("@/lib/proactive-turn");
    const queued = await maybeQueueCronPrompt({
      sessionId: args.sessionId,
      prompt: args.prompt,
      metadata: { producer: "scheduler" },
    });
    if (queued) return;
  } catch (e) {
    console.warn("[scheduler] proactive queue check failed:", e);
  }

  const port = process.env.PORT ?? "3000";
  const url = `http://localhost:${port}/api/chat`;
  try {
    const { internalFetch } = await import("@/lib/internal-fetch");
    const res = await internalFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: args.prompt }],
        sessionId: args.sessionId,
        source: "cron",
      }),
    });
    if (!res.ok) {
      console.warn(`[scheduler] fire POST returned ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } catch (e) {
    console.warn("[scheduler] fire POST failed:", e);
  }
}
