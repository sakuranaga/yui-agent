/**
 * 結衣の日記を 1 日 1 回生成する periodic module。
 *
 * 仕様:
 *   - 5 分おきにチェック
 *   - JST 23:00 以降: 今日の日記がまだ無ければ生成
 *   - 任意時刻: 昨日の日記がまだ無ければ catch-up で生成
 *     (23 時台にサーバが止まってた / scheduler 未登録だった等で抜け落ちた日を翌日朝以降に救う)
 *   - 1 tick = 最大 1 件生成 (LLM 連打を避けるため複数欠損は次 tick で順次処理)
 *   - Yui voice の fire は出さない (バックグラウンド作業、ユーザー通知なし)
 */
import type { PeriodicModule, PeriodicContext, PeriodicResult } from "./types";
import { generateDiaryEntry, getDiaryEntry } from "@/lib/diary";
import { ymdStringJST } from "@/lib/time";
import { dispatchNotification } from "@/lib/notifications";

const HOUR_WRITE_AFTER_JST = 23;

function nowJstHour(d: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    hour12: false,
  });
  const h = fmt.formatToParts(d).find((p) => p.type === "hour")?.value ?? "0";
  return parseInt(h, 10);
}

const diaryWrite: PeriodicModule = {
  id: "diary-write",
  enabled: true,
  schedule: { kind: "interval", everyMs: 5 * 60_000 },
  run: async (ctx: PeriodicContext): Promise<PeriodicResult> => {
    const now = new Date();
    const hour = nowJstHour(now);
    const todayYmd = ymdStringJST(now);

    // 候補日: 今日 (23 時以降のみ) と 昨日 (常時、catch-up 用)。
    // 今日を先に試す → 23 時の本来生成タイミング優先。昨日は穴埋め。
    const candidates: Array<{ ymd: string; date: Date }> = [];
    if (hour >= HOUR_WRITE_AFTER_JST) {
      candidates.push({ ymd: todayYmd, date: now });
    }
    // 24h 引き算。setUTCDate と違って DST や月跨ぎでも常に「真の 24 時間前」を返す。
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    candidates.push({ ymd: ymdStringJST(yesterday), date: yesterday });

    for (const c of candidates) {
      const existing = await getDiaryEntry(c.ymd);
      if (existing) continue;
      try {
        const generated = await generateDiaryEntry({ date: c.date });
        // 「日記を書きました」お便りを 1 件積む (低優先 / トースト + LogModal)
        try {
          const body = generated?.body ?? "";
          const preview = body
            .replace(/\n+/g, " ")
            .replace(/[#*_`]/g, "")
            .trim()
            .slice(0, 70);
          // Discord / Web TTS 用の短い告知。LLM を使うほどではないので固定文。
          // 「ご主人様」呼称は persona で変えられるが、ここまでで取得するコスト見合わないので
          // ニュートラルに「日記を書き終えました」だけにする。
          const speakText = `${c.ymd} の日記を書き終えましたよ。`;
          await dispatchNotification({
            sessionId: ctx.sessionId,
            kind: "diary",
            importance: "low",
            title: `${c.ymd} の日記を書きました`,
            preview,
            bodyMd: body,
            payload: { entry_date: c.ymd },
            refTable: "diary_entries",
            refId: generated?.id ? Number(generated.id) : undefined,
            speakText,
          });
        } catch (e) {
          console.warn("[diary-write] save notification failed:", e);
        }
        return { skip: true, reason: `diary for ${c.ymd} generated` };
      } catch (e) {
        console.warn(`[diary-write] generation failed for ${c.ymd}:`, e);
        return { skip: true, reason: `error: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    return { skip: true, reason: `no missing diary (today=${todayYmd}, hour=${hour})` };
  },
};

export default diaryWrite;
