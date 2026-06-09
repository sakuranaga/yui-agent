/**
 * 時間関連のユーティリティ。JST 固定で人間が読みやすい形式に整形する。
 * - system prompt に注入する "現在の状況" ブロック
 * - chunk の created_at を相対時刻 ("3日前" 等) として表示
 *
 * コンテナの TZ 設定に依存しないよう、すべて Intl.DateTimeFormat に
 * `timeZone: 'Asia/Tokyo'` を明示する。
 */

const TZ = "Asia/Tokyo";

/**
 * "2026年5月24日 (土) 15:30 JST" 形式で現在時刻ヘッダーを返す。
 * system prompt の動的ブロックに含める。
 */
export function buildTimeContextBlock(now: Date = new Date()): string {
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
  return [
    "## 現在の状況",
    `- 日時: ${datePart} ${timePart} (JST)`,
    "- 結衣の発言で日付や曜日に触れる場合は、この情報を真として扱ってください。",
  ].join("\n");
}

/**
 * 過去日時を「今日 / 昨日 / N日前 / 5/22 (90日前)」のように表現する。
 * 1週間以内: 「今日」「昨日」「N日前」
 * 1週間〜30日: 「M/D (N日前)」
 * 30日以上: 「YYYY/M/D (N日前)」
 */
export function relativeJST(past: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - past.getTime();
  // 1日 = 86,400,000ms。負 (未来) は0扱い。
  const diffDays = Math.max(0, Math.floor(diffMs / 86_400_000));

  if (diffDays === 0) return "今日";
  if (diffDays === 1) return "昨日";
  if (diffDays < 7) return `${diffDays}日前`;

  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    ...(diffDays >= 365
      ? { year: "numeric", month: "numeric", day: "numeric" }
      : { month: "numeric", day: "numeric" }),
  });
  return `${formatter.format(past)} (${diffDays}日前)`;
}

/**
 * チャット履歴メッセージ用、JST 絶対時刻マーカー。
 * "2026-05-29 06:28 JST" 形式。
 *
 * 用途: LLM への apiMessages 履歴注入時、各メッセージの先頭に
 * `[2026-05-29 06:28 JST] ` のように付ける。
 * 現在時刻は env block で既に渡しているので、LLM は引き算で経過時間を判定できる。
 */
export function chatTimestampMarker(past: Date): string {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(past);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} JST`;
}

/** "M/D" だけ返したいケース (短い表記が欲しいとき) */
export function shortDateJST(d: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    month: "numeric",
    day: "numeric",
  }).format(d);
}

/**
 * JST タイムゾーン基準の "YYYY-MM-DD" 文字列。
 * 日記やカレンダー等、日単位の同一性比較や DB の DATE 型に渡す時に使う。
 * コンテナの TZ 設定に依存しない。
 */
export function ymdStringJST(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
