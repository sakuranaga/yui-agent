/**
 * 1 時間毎、全 enabled な news_sources の RSS を fetch → news_articles に upsert。
 * 新着があれば Haiku でキュレーション → 閾値超え + throttle 通過なら Sonnet で
 * Yui セリフ生成 → speak、それ以外は notify。全件閾値以下なら silent (お便り無)。
 *
 * 設計: docs/news-curation.md
 */
import type { PeriodicModule, PeriodicContext, PeriodicResult } from "./types";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { newsArticles, newsSources } from "@/db/schema";
import { fetchAllSources } from "@/lib/news";
import { dispatchNotification } from "@/lib/notifications";
import { curateArticles } from "@/lib/news-curate";
import { generateNewsSpeech } from "@/lib/news-speak";
import {
  getCurationSettings,
  markSpoken,
} from "@/lib/news-curation-settings";

const newsFetch: PeriodicModule = {
  id: "news-fetch",
  enabled: true,
  schedule: { kind: "interval", everyMs: 3 * 60 * 60_000 }, // 3 時間
  run: async (ctx: PeriodicContext): Promise<PeriodicResult> => {
    try {
      const results = await fetchAllSources();
      const totalInserted = results.reduce((sum, r) => sum + r.inserted, 0);
      const totalFetched = results.reduce((sum, r) => sum + r.fetched, 0);
      const insertedIds = results.flatMap((r) => r.insertedIds);
      const errors = results.filter((r) => r.error);
      for (const e of errors) console.warn(`[news-fetch] ${e.source.name}: ${e.error}`);
      console.log(
        `[news-fetch] sources=${results.length} fetched=${totalFetched} inserted=${totalInserted} errors=${errors.length}`
      );

      if (insertedIds.length === 0) {
        return { skip: true, reason: `no new articles` };
      }

      // キュレーション (Haiku batch)
      await curateArticles(insertedIds);

      // 設定 + 新着の score を取得して、speak 候補を決める
      const settings = await getCurationSettings();
      const articles = await db
        .select({
          id: newsArticles.id,
          title: newsArticles.title,
          link: newsArticles.link,
          summary: newsArticles.summary,
          score: newsArticles.score,
          scoreReason: newsArticles.scoreReason,
          sourceName: newsSources.name,
        })
        .from(newsArticles)
        .innerJoin(newsSources, eq(newsArticles.sourceId, newsSources.id))
        .where(inArray(newsArticles.id, insertedIds));

      // score 降順でソート
      const sorted = [...articles].sort(
        (a, b) => (b.score ?? 0) - (a.score ?? 0)
      );
      const top = sorted[0];
      const maxScore = top?.score ?? 0;
      const passing = sorted.filter(
        (a) => (a.score ?? 0) >= settings.scoreThreshold
      );

      console.log(
        `[news-fetch] curated max=${maxScore.toFixed(2)} threshold=${settings.scoreThreshold} passing=${passing.length}/${articles.length}`
      );

      // 全件 閾値以下 → silent (お便りも作らない)
      if (passing.length === 0) {
        return { skip: true, reason: `all below threshold ${settings.scoreThreshold}` };
      }

      // throttle 判定
      const now = Date.now();
      const lastSpokenMs = settings.lastSpokenAt
        ? settings.lastSpokenAt.getTime()
        : 0;
      const throttleMs = settings.minSpeakIntervalHours * 60 * 60_000;
      const inThrottle = lastSpokenMs > 0 && now - lastSpokenMs < throttleMs;

      const mode: "speak" | "notify" = inThrottle ? "notify" : "speak";

      // 発話セリフ生成 (speak モードのみ、Sonnet コスト節約)
      let speakText: string | undefined;
      if (mode === "speak" && top) {
        try {
          speakText = await generateNewsSpeech({
            title: top.title,
            sourceName: top.sourceName,
            summary: top.summary,
            link: top.link,
            score: top.score ?? 0,
            scoreReason: top.scoreReason,
          });
        } catch (e) {
          console.warn("[news-fetch] speech generation failed, fallback to title:", e);
        }
      }

      // bodyMd: 通過した記事を score 順、選ばれた 1 件をハイライト + 閾値以下も参考表示
      const bodyMd = buildBodyMd({
        selectedId: top?.id ?? null,
        all: sorted,
        threshold: settings.scoreThreshold,
      });

      const title = `新着ニュース ${passing.length}/${articles.length} 件`;
      const preview = top ? top.title.slice(0, 70) : "";

      // throttle 中は speak を抑制 (= toast + 履歴のみ)。throttle 解除後は
      // 通知マトリックスの speak_* rule が respect される。
      const dispatchResult = await dispatchNotification({
        sessionId: ctx.sessionId,
        kind: "news",
        importance: "low",
        title,
        preview,
        bodyMd,
        payload: {
          totalInserted,
          totalFetched,
          maxScore,
          passingCount: passing.length,
          selectedId: top?.id ?? null,
          throttled: inThrottle,
        },
        speakText,
        skipAutoSpeak: inThrottle,
      });

      // 実際に speak fired したときだけ throttle 起点を進める。
      // rule.speak* が false で speak されなかった場合は throttle 進めない
      // (= 後から speak を ON にしても throttle で抑制されないように)
      if (dispatchResult.speakFired) {
        await markSpoken(new Date());
      }

      return {
        skip: true,
        reason: `mode=${mode} selected=${top?.id ?? "-"} score=${maxScore.toFixed(2)}`,
      };
    } catch (e) {
      console.warn("[news-fetch] failed:", e);
      return { skip: true, reason: `error: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

function buildBodyMd(args: {
  selectedId: number | null;
  all: Array<{
    id: number;
    title: string;
    link: string | null;
    summary: string | null;
    score: number | null;
    scoreReason: string | null;
    sourceName: string;
  }>;
  threshold: number;
}): string {
  const lines: string[] = [];

  lines.push("# 新着ニュース");
  lines.push("");

  if (args.selectedId !== null) {
    const sel = args.all.find((a) => a.id === args.selectedId);
    if (sel) {
      lines.push(`## ⭐ おすすめ`);
      lines.push(formatArticle(sel, true));
      lines.push("");
    }
  }

  // 残り (選ばれた 1 件以外) を閾値で 2 つに分ける:
  //   - 関心のありそうな話題 (>= threshold)
  //   - 興味なさそうな話題    (<  threshold)
  // score 降順で並んでいるので、各セクション内も高い順に表示される。
  const rest = args.all.filter((a) => a.id !== args.selectedId);
  const interested = rest.filter((a) => (a.score ?? 0) >= args.threshold);
  const notInterested = rest.filter((a) => (a.score ?? 0) < args.threshold);

  if (interested.length > 0) {
    lines.push(`## 関心のありそうな話題`);
    for (const a of interested) lines.push(formatArticle(a, false));
    lines.push("");
  }

  if (notInterested.length > 0) {
    lines.push(`## 興味なさそうな話題`);
    for (const a of notInterested) lines.push(formatArticle(a, false));
  }

  return lines.join("\n");
}

function formatArticle(
  a: {
    title: string;
    link: string | null;
    summary: string | null;
    score: number | null;
    scoreReason: string | null;
    sourceName: string;
  },
  highlight: boolean
): string {
  const scoreStr = a.score !== null ? a.score.toFixed(2) : "—";
  const reasonStr = a.scoreReason ? ` — ${a.scoreReason}` : "";
  const titleStr = highlight ? `**${a.title}**` : a.title;
  const linkStr = a.link ? `[${titleStr}](${a.link})` : titleStr;
  let line = `- ${linkStr} _(${a.sourceName}, score ${scoreStr}${reasonStr})_`;
  if (a.summary) line += `\n  ${sanitizeSummary(a.summary).slice(0, 140)}`;
  return line;
}

/**
 * RSS の summary はソースによって markdown 記号や URL を含む (例: Hacker News の
 * "# Comments: 2", "Article URL: ..."). そのまま markdown として描画すると意図しない
 * 見出しや構造になるので、フラットな文字列に正規化する。
 *  - 改行は半角スペース
 *  - 行頭/単語頭の "# " のような markdown ヘッダ記号をエスケープ
 *  - 連続空白を圧縮
 */
function sanitizeSummary(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/(^|\s)(#{1,6})\s/g, "$1") // 行頭ヘッダ記号を剥がす
    .replace(/\s+/g, " ")
    .trim();
}

export default newsFetch;
