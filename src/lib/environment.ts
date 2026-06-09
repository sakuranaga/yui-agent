/**
 * Yui の "周囲の状況" (アンビエント・アウェアネス) を集約して system prompt に
 * 注入するための環境ブロック。
 *
 * 各 provider は独立 async + 失敗時 null。提供できた情報だけ出力するので、
 * 機能が壊れても会話自体は止まらない。
 *
 * 現状の provider:
 *  - time:        現在の JST (常時)
 *  - place:       現在地 (reverse-geocode 済み)
 *  - weather:     現在天気
 *  - music:       いま流れている曲
 *  - timers:      進行中の timer / alarm
 *  - reminders:   今日有効なリマインダー (重複設定防止用)
 *  - events:      今日の calendar 予定
 *  - other surfaces: 他 surface (Discord) の最近の発話
 */
import { buildTimeContextBlock } from "./time";
import { getNowPlaying } from "./music-commands";
import { listActiveTimers } from "./timers";
import { getLocation, getPlaceLabel } from "./location";
import { getCurrentWeather, isWeatherEnabled } from "./weather";
import { listReminders } from "./reminders";
import { listEvents } from "./gcal";
import { db } from "@/db/client";
import { rawMessages } from "@/db/schema";
import { and, desc, eq, gte, ne } from "drizzle-orm";

const TZ = "Asia/Tokyo";

export type EnvironmentInput = {
  sessionId?: string;
};

/**
 * system prompt 用の "## 今の環境" ブロックを組み立てる。
 * 失敗 provider は単にスキップ。timeProvider だけは必ず入る。
 */
export async function buildEnvironmentBlock(
  opts: EnvironmentInput = {}
): Promise<string> {
  const sections: string[] = ["## 今の環境"];

  // 1) time (常に成功)
  sections.push(formatTimeLine());

  // 2-7 を並列取得
  const [music, timersText, weatherText, otherSurfaces, remindersText, eventsText] =
    await Promise.all([
      safeNowPlaying(),
      opts.sessionId ? safeListTimers(opts.sessionId) : Promise.resolve(null),
      safeWeather(),
      opts.sessionId ? safeOtherSurfaceActivity(opts.sessionId) : Promise.resolve(null),
      opts.sessionId ? safeListReminders(opts.sessionId) : Promise.resolve(null),
      safeTodayEvents(),
    ]);

  // 現在地 (reverse-geocode 済みの地域名のみ。lat/lon は LLM に渡さない)
  const place = getPlaceLabel();
  if (place) sections.push(`- 現在地: ${place}`);

  if (weatherText) sections.push(weatherText);
  if (music) sections.push(music);
  if (timersText) sections.push(timersText);
  if (remindersText) sections.push(remindersText);
  if (eventsText) sections.push(eventsText);
  if (otherSurfaces) sections.push(otherSurfaces);

  sections.push(
    "",
    "上記は会話中に自然に活用してください (例: 「いま流れているハイドンですか?」「タイマー残り3分ですね」)。情報自体を読み上げる必要はありません。"
  );

  return sections.join("\n");
}

function formatTimeLine(): string {
  // 既存の buildTimeContextBlock は "## 現在の状況" 見出し付きで返すので、
  // 中身の 日時 行だけを抜きたい。重複しないよう "- 日時:" 部分を再構成する。
  const now = new Date();
  const datePart = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(now);
  const timePart = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return `- 日時: ${datePart} ${timePart} (JST)`;
}

// in-memory cache が古い (> NOW_PLAYING_FRESH_MS) ときは ENV 構築時に即時 poll する。
// これがないとブラウザリロード直後の初手チャットで「リロード前の曲」が ENV に乗って
// Yui が古い曲名を案内する。
const NOW_PLAYING_FRESH_MS = 10_000;
// 直前 poll が null (= 未連携 / 未再生 / Spotify API 障害) だった時の retry 抑制。
// これが無いと未連携ユーザのチャット毎に DB token lookup + 例外処理が走る。
const NOW_PLAYING_NULL_RETRY_MS = 60_000;
let lastNullPollAt = 0;

async function safeNowPlaying(): Promise<string | null> {
  try {
    let np = getNowPlaying();
    // cache が ある & fresh ならそのまま返す
    if (np && Date.now() - (np.updatedAt ?? 0) <= NOW_PLAYING_FRESH_MS) {
      // 通常 path、下の format へ
    } else if (!np && Date.now() - lastNullPollAt < NOW_PLAYING_NULL_RETRY_MS) {
      // 直前 poll で null だった (= 未連携 / 未再生) → cooldown 中、Spotify 叩かない
      return null;
    } else {
      // stale or 期限切れの null → 1 回 poll
      const { kickSpotifyPollNow } = await import("./music-commands");
      await kickSpotifyPollNow();
      np = getNowPlaying();
      if (!np) lastNullPollAt = Date.now();
    }
    if (!np) return null;
    const parts = [np.title, np.artist, np.album].filter(Boolean);
    // Spotify は pause 後も track 情報を保持して is_playing:false を返すので、
    // ENV block 上で「再生中」と「停止中」を明示する。これがないと Yui が
    // ご主人様がポーズした後も「今かかってる曲は…」と勘違いする。
    // isPlaying 未指定 (= 旧キャッシュ) は再生中扱いで後方互換。
    const isPlaying = np.isPlaying !== false;
    const label = isPlaying ? "流れている音楽" : "停止中の音楽 (= 直前に再生していた曲、いまは pause 中)";
    // この行は「Yui が今かかってる曲を把握するため」の文脈情報。
    // 再生開始 / 曲変化のタイミングで既に specialist が紹介済なので、
    // 普通のチャットでは自発的に曲名を出さない (= ブラウザリロード直後に「いま
    // ハイドンですね…」と再案内するのを防ぐ)。曲の話題はご主人様が振った時だけ。
    return `- ${label}: ${parts.join(" / ")} (= 既に紹介済の文脈情報、聞かれない限り再紹介しない)`;
  } catch (e) {
    console.warn("[env] now-playing failed:", e);
    return null;
  }
}

async function safeListTimers(sessionId: string): Promise<string | null> {
  try {
    const list = await listActiveTimers(sessionId);
    if (list.length === 0) return null;
    const now = Date.now();
    const lines = list.map((t) => {
      const targetMs = t.targetAt.getTime();
      const remainMs = targetMs - now;
      const kind = t.kind === "timer" ? "タイマー" : "アラーム";
      const label = t.label ? `「${t.label}」` : "";
      if (t.kind === "timer") {
        return `  - ${kind}${label} 残り ${formatRemaining(remainMs)}`;
      } else {
        // alarm: 絶対時刻を表示
        const clock = new Intl.DateTimeFormat("ja-JP", {
          timeZone: TZ,
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(t.targetAt);
        return `  - ${kind}${label} ${clock}`;
      }
    });
    return [`- 進行中のタイマー/アラーム: ${list.length}件`, ...lines].join(
      "\n"
    );
  } catch (e) {
    console.warn("[env] list timers failed:", e);
    return null;
  }
}

async function safeWeather(): Promise<string | null> {
  if (!isWeatherEnabled()) return null;
  const loc = getLocation();
  if (!loc) return null;
  try {
    const w = await getCurrentWeather({ lat: loc.lat, lon: loc.lon });
    const humidity = Math.round(w.humidity * 100);
    const hiLo =
      typeof w.highTemperature === "number" && typeof w.lowTemperature === "number"
        ? ` (本日 ${Math.round(w.lowTemperature)}-${Math.round(w.highTemperature)}℃)`
        : "";
    return `- 天気: ${w.conditionJa}、${Math.round(w.temperature)}℃、湿度${humidity}%${hiLo}`;
  } catch (e) {
    console.warn("[env] weather failed:", e);
    return null;
  }
}

function formatRemaining(ms: number): string {
  if (ms < 0) return "もうすぐ";
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/**
 * 他 surface (Discord 等) で直近 60 分以内に user が発した内容を 1 行サマリ。
 * web ChatPanel は web session の raw_messages しか apiMessages に積まないため、
 * 「Discord で送ったメッセージ届いてる?」のようなメタ問いに Yui が答えられない事故を防ぐ。
 * 内容は ~30 字 preview を 2 件まで載せ、Yui に「届いてる」事実と recall trigger を渡す。
 */
async function safeOtherSurfaceActivity(currentSession: string): Promise<string | null> {
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const rows = await db
      .select({
        source: rawMessages.source,
        content: rawMessages.content,
        createdAt: rawMessages.createdAt,
      })
      .from(rawMessages)
      .where(
        and(
          ne(rawMessages.sessionId, currentSession),
          eq(rawMessages.role, "user"),
          gte(rawMessages.createdAt, since)
        )
      )
      .orderBy(desc(rawMessages.createdAt))
      .limit(20);
    if (rows.length === 0) return null;

    type Item = { content: string; createdAt: Date };
    const bySource = new Map<string, Item[]>();
    for (const r of rows) {
      const key = (r.source ?? "unknown").toString();
      if (key === "cron") continue; // 内部 trigger は除外
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key)!.push({ content: r.content, createdAt: r.createdAt });
    }
    if (bySource.size === 0) return null;

    const lines: string[] = ["- 他の経路の最近のやりとり (直近 60 分、ご主人様の発話):"];
    for (const [src, msgs] of bySource) {
      const label = surfaceLabel(src);
      const previews = msgs
        .slice(0, 2)
        .map((m) => `「${m.content.replace(/\n/g, " ").slice(0, 40)}」`)
        .join("、");
      lines.push(`  - ${label} (${msgs.length} 件): ${previews}`);
    }
    return lines.join("\n");
  } catch (e) {
    console.warn("[env] otherSurfaceActivity failed:", e);
    return null;
  }
}

function surfaceLabel(src: string): string {
  if (src === "discord_text") return "Discord";
  if (src === "discord_voice") return "Discord (音声)";
  if (src === "web") return "Web";
  return src;
}

/**
 * 今日 (= JST 00:00 〜 翌日 00:00) に発火予定 or 既に設定済の有効リマインダーを箇条書きで返す。
 * Yui がリロード後に「同じリマインダーをもう一度作る」事故を防ぐため。
 */
async function safeListReminders(sessionId: string): Promise<string | null> {
  try {
    const list = await listReminders({ sessionId, enabled: true });
    if (list.length === 0) return null;
    const now = Date.now();
    const todayEnd = (() => {
      // JST 今日の終わり (23:59:59.999) を UTC ms に
      const parts = new Intl.DateTimeFormat("ja-JP", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(now));
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      const ymd = `${get("year")}-${get("month")}-${get("day")}`;
      return new Date(`${ymd}T23:59:59.999+09:00`).getTime();
    })();
    // 今日中に next_due_at が来るもの + 既に lastFiredAt が今日のもの (= 今日鳴った reminder)
    const todayItems = list.filter((r) => {
      const nextMs = r.nextDueAt ? r.nextDueAt.getTime() : null;
      const lastMs = r.lastFiredAt ? r.lastFiredAt.getTime() : null;
      if (nextMs !== null && nextMs <= todayEnd) return true;
      if (lastMs !== null && lastMs >= todayEnd - 86400_000 && lastMs <= todayEnd) return true;
      return false;
    });
    if (todayItems.length === 0) return null;
    const lines = todayItems.slice(0, 8).map((r) => {
      const sched = r.schedule;
      let when: string;
      if (sched.kind === "once") {
        when = formatJstShort(sched.baseAt);
        if (sched.leadMinutes > 0) when += ` (${formatLead(sched.leadMinutes)}前)`;
      } else {
        const wd =
          sched.weekdays.length === 0 || sched.weekdays.length === 7
            ? "毎日"
            : sched.weekdays.map((w) => ["日", "月", "火", "水", "木", "金", "土"][w]).join("");
        when = `${wd} ${sched.baseTime}`;
        if (sched.leadMinutes > 0) when += ` (${formatLead(sched.leadMinutes)}前)`;
      }
      const ref =
        r.refTable === "todos" && r.refId !== null ? ` → TODO #${r.refId}` : "";
      return `  - 「${r.title}」 ${when}${ref}`;
    });
    return [`- 今日のリマインダー (${todayItems.length}件、設定済): `, ...lines].join("\n");
  } catch (e) {
    console.warn("[env] list reminders failed:", e);
    return null;
  }
}

/**
 * 今日の calendar event (= GCal) を箇条書きで返す。
 * Yui がリロード後に古い event を「今日の予定」と誤解しないため、
 * 必ず今日範囲だけを問い合わせる。
 */
async function safeTodayEvents(): Promise<string | null> {
  try {
    // JST 今日 00:00 〜 24:00 を RFC3339 で
    const now = new Date();
    const parts = new Intl.DateTimeFormat("ja-JP", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const ymd = `${get("year")}-${get("month")}-${get("day")}`;
    const timeMin = `${ymd}T00:00:00+09:00`;
    const timeMax = `${ymd}T23:59:59+09:00`;

    const events = await listEvents({ timeMin, timeMax, maxResults: 12 });
    if (events.length === 0) return "- 今日の予定: なし";

    const lines = events.slice(0, 8).map((e) => {
      const start = e.start?.dateTime ?? e.start?.date ?? "";
      const end = e.end?.dateTime ?? e.end?.date ?? "";
      const allDay = !e.start?.dateTime;
      const timeRange = allDay
        ? "終日"
        : `${formatJstTimeOnly(start)}〜${formatJstTimeOnly(end)}`;
      const loc = e.location ? ` @${e.location}` : "";
      return `  - ${timeRange} 「${e.summary ?? "(無題)"}」${loc}`;
    });
    return [`- 今日の予定 (${events.length}件):`, ...lines].join("\n");
  } catch (e) {
    // GCal 未認証等は珍しくないので、debug にとどめる (warn にすると noise になる)
    if (process.env.DEBUG_ENV === "1") {
      console.warn("[env] today events failed:", e);
    }
    return null;
  }
}

function formatJstShort(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: TZ,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return iso;
  }
}

function formatJstTimeOnly(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return iso;
  }
}

function formatLead(min: number): string {
  if (min < 60) return `${min}分`;
  if (min < 1440) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h}時間` : `${h}時間${m}分`;
  }
  return `${Math.floor(min / 1440)}日`;
}

// 既存の time-only block も互換のため再 export (徐々に呼出元を環境ブロックに移行)
export { buildTimeContextBlock };
