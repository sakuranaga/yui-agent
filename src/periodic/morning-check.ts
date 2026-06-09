/**
 * 朝のブリーフィング: 1 日 1 回、ターゲット時刻 (env MORNING_CHECK_HOUR_JST, default 7) 以降に
 * 「今日の予定 + 期限近 todos + 主要ニュース + 未読メール」をまとめて Yui voice で届ける。
 *
 * - 5 分 interval で「今日の発火時刻に到達 && 今日まだ未発火」を判定
 * - snapshot に lastFiredYmd を保存して 1 日 1 回保証
 * - fire 時は brief prompt を /api/chat 経由で Yui (Sonnet) に送り、結衣の口調にして応答
 */
import type { PeriodicModule, PeriodicContext, PeriodicResult } from "./types";
import {
  collectMorningMaterial,
  buildMorningBriefPrompt,
  buildMorningBriefMarkdown,
} from "@/lib/morning-brief";
import { pushToSession } from "@/lib/jobs/events";
import { addXp } from "@/lib/xp";
import { saveMorningBrief } from "@/lib/morning-briefs";
import { dispatchNotification } from "@/lib/notifications";
import { getRule } from "@/lib/notification-settings";
import { getEffectiveState } from "@/lib/activity";
import { generateMorningSpeech } from "@/lib/morning-speak";

const HOUR_JST = parseInt(process.env.MORNING_CHECK_HOUR_JST ?? "9", 10);

function nowJstHour(d: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    hour12: false,
  })
    .formatToParts(d)
    .find((p) => p.type === "hour")?.value;
  return parseInt(h ?? "0", 10);
}

function nowJstYmd(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

type Snapshot = { lastFiredYmd?: string };

const morningCheck: PeriodicModule = {
  id: "morning-check",
  enabled: true,
  schedule: { kind: "interval", everyMs: 5 * 60_000 }, // 5 分
  run: async (ctx: PeriodicContext): Promise<PeriodicResult> => {
    const now = new Date();
    const todayYmd = nowJstYmd(now);
    const hour = nowJstHour(now);

    const snap = (ctx.lastSnapshot ?? {}) as Snapshot;

    // 既に今日発火済 (このプロセス内) → skip (= 高速 path)
    if (snap.lastFiredYmd === todayYmd) {
      return { skip: true, reason: `already fired today (${todayYmd})` };
    }

    // 目標時刻前 → skip
    if (hour < HOUR_JST) {
      return { skip: true, reason: `before ${HOUR_JST}h JST (now ${hour}h)` };
    }

    // atomic claim: multi-process / snapshot ロスト時の backstop。
    // snapshot は per-process なので blue/green や再起動で別 process が「未発火」と
    // 判定 → 二重発火するリスクがあった。DB の jobClaims テーブルで 1 日 1 行に統一。
    const { claimJob } = await import("@/lib/job-claim");
    const claimed = await claimJob({
      key: `morning-check:${todayYmd}`,
      moduleId: "morning-check",
    });
    if (!claimed) {
      return {
        skip: true,
        reason: `already claimed today (${todayYmd})`,
        snapshot: { lastFiredYmd: todayYmd },
      };
    }

    // 素材収集
    let prompt: string;
    let markdown: string;
    try {
      const material = await collectMorningMaterial(now);
      // 素材ゼロでも brief 自体はする (「今日は予定無し、お休みですね」的に)
      prompt = buildMorningBriefPrompt(material, now);
      markdown = buildMorningBriefMarkdown(material, now);
      if (process.env.NODE_ENV !== "production") {
        console.log(
          `[morning-check] collected: schedule=${material.schedule.length}, todos=${material.todos.length}, news=${material.news.length}, mail=${material.mail.length}`
        );
      }
    } catch (e) {
      console.warn("[morning-check] collect failed:", e);
      return { skip: true, reason: `error: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Discord 用に「朝の挨拶 + 要約」を Sonnet で別生成。
    // Web は後続の fire 経路 (/api/chat) で full Yui turn として配信されるが、
    // Discord はテキストのみ + 簡潔さ重視なのでここで生成した短い挨拶を送る。
    // 失敗しても brief 自体は止めない (discordText 無し = Discord 沈黙)。
    let discordText: string | undefined;
    try {
      discordText = await generateMorningSpeech(markdown);
    } catch (e) {
      console.warn("[morning-check] speech generation failed:", e);
    }

    // DB 永続化 (後で「昨日のブリーフ見せて」で Yui が tool 参照する)
    let savedBriefId: number | undefined;
    try {
      const saved = await saveMorningBrief({
        dateYmd: todayYmd,
        markdown,
        sourceMeta: {
          generated_at: now.toISOString(),
          source: "morning-check",
        },
      });
      savedBriefId = saved?.id;
    } catch (e) {
      console.warn("[morning-check] save brief failed:", e);
    }

    // ReportPanel にもブリーフ markdown を push (Yui voice とは別経路、人間が読む側)
    try {
      pushToSession(ctx.sessionId, {
        type: "report_update",
        jobId: Date.now(),
        title: "今朝のブリーフィング",
        markdown,
      });
    } catch (e) {
      console.warn("[morning-check] report push failed:", e);
    }

    // お便りバッジ用 notification を積む。saveNotification 内で:
    //   - Web mode=speak → speakText 無いので yui_message は push されない
    //     (= fire 経路の full Yui turn 1 本だけになる、重複しない)
    //   - Web mode=notify → トーストのみ
    //   - Discord は discordPolicy + discordText で転送
    try {
      const preview = markdown
        .replace(/\n+/g, " ")
        .replace(/[#*_`]/g, "")
        .trim()
        .slice(0, 70);
      await dispatchNotification({
        sessionId: ctx.sessionId,
        kind: "morning_brief",
        importance: "normal",
        title: "今朝のブリーフィング",
        preview,
        bodyMd: markdown,
        payload: { entry_date: todayYmd },
        refTable: "morning_briefs",
        refId: savedBriefId,
        discordText,
        // morning brief は rich speak を別経路 (= fire:{prompt}) で投げるので
        // dispatcher 側の自動 speak は抑制 (= 重複防止)
        skipAutoSpeak: true,
      });
    } catch (e) {
      console.warn("[morning-check] save notification failed:", e);
    }

    // morning brief 配信 = +2 XP (todayYmd を ref に擬似 id を持たせて重複防止)
    void addXp({
      eventType: "morning_brief",
      refTable: "morning_check",
      refId: Number(todayYmd.replace(/-/g, "")),
    });

    // Web 側: 設定マトリックスの speak_* が true のときだけ Yui に prompt を
    // fire (= TTS で rich greeting を読み上げる)。デフォルトは toast のみなので fire しない。
    // この経路は full Yui turn (memory / tool 含む) を流すために残す。
    // Discord 配信は上の dispatchNotification で discordText 経由で完結している。
    const nextSnap: Snapshot = { lastFiredYmd: todayYmd };
    let shouldFire = false;
    try {
      const rule = await getRule("morning_brief");
      const rawState = await getEffectiveState(ctx.sessionId);
      const matrixState = rawState === "private" ? "focus" : rawState;
      shouldFire =
        matrixState === "online"
          ? rule.speakOnline
          : matrixState === "away"
            ? rule.speakAway
            : rule.speakFocus;
    } catch (e) {
      console.warn("[morning-check] rule load failed, defaulting to toast only:", e);
    }
    if (shouldFire) {
      return {
        fire: { prompt },
        reason: `morning brief for ${todayYmd} (speak)`,
        snapshot: nextSnap,
      };
    }
    return {
      skip: true,
      reason: `morning brief for ${todayYmd} (notify only)`,
      snapshot: nextSnap,
    };
  },
};

export default morningCheck;
