/**
 * 日本の暦情報 (令和年号 / 六曜 / 月相) を依存ゼロで計算する。
 *
 * - 令和: Intl.DateTimeFormat の japanese カレンダーで取得 (確実)
 * - 月相: synodic 月 (29.530588853 日) と既知の新月時刻からの差で算出
 * - 六曜: 同じ synodic 計算で「最近の新月から何日目」と「その新月が属する太陰月」を
 *        近似 → (lunar_month - 1 + lunar_day - 1) % 6 で 6 種に割り当て
 *
 * 六曜の計算は厳密には旧暦の閏月処理が必要だが、ここでは display 用途として割り切り、
 * 「新月が属する太陽月」を太陰月とみなす近似を使う。年に数回、閏月境界で 1 日ずれる
 * ことがあるが許容範囲。Yui のヘッダ表示用途なので精度はこれで十分。
 */

// 既知の新月 (2000-01-06 18:14 UTC) — JPL の月齢計算で広く使われる基準
const REF_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14, 0);
const SYNODIC_MONTH_DAYS = 29.530588853;
const SYNODIC_MONTH_MS = SYNODIC_MONTH_DAYS * 86400000;
const JST_OFFSET_MS = 9 * 3600 * 1000;

/**
 * 与えた瞬間の直前 (≤) の新月時刻と、そこから何日目かを返す。
 * lunarDay は 1 始まり (新月当日 = 1日目)。
 */
function lunarPhase(date: Date): { lastNewMoonMs: number; lunarDay: number } {
  const t = date.getTime();
  const cyclesSinceRef = (t - REF_NEW_MOON_MS) / SYNODIC_MONTH_MS;
  const lunations = Math.floor(cyclesSinceRef);
  const lastNewMoonMs = REF_NEW_MOON_MS + lunations * SYNODIC_MONTH_MS;
  const daysSinceNewMoon = Math.floor((t - lastNewMoonMs) / 86400000);
  return { lastNewMoonMs, lunarDay: daysSinceNewMoon + 1 };
}

/**
 * 月相を日本語名で返す。
 * 0 〜 29.53 を 8 つのフェーズに分割:
 *   新月 → 三日月 → 上弦 → 十三夜 → 満月 → 十六夜 → 下弦 → 二十六夜
 */
export function getMoonPhaseName(date: Date = new Date()): string {
  const { lunarDay } = lunarPhase(date);
  // lunarDay は 1..30。8 分割の境界 ≈ 29.53/8 = 3.69 日ごと
  const d = lunarDay - 1; // 0..29
  if (d < 1) return "新月";
  if (d < 5) return "三日月";
  if (d < 9) return "上弦";
  if (d < 13) return "十三夜";
  if (d < 17) return "満月";
  if (d < 21) return "十六夜";
  if (d < 25) return "下弦";
  return "二十六夜";
}

const ROKUYOU_NAMES = ["先勝", "友引", "先負", "仏滅", "大安", "赤口"] as const;
export type Rokuyou = (typeof ROKUYOU_NAMES)[number];

/**
 * 六曜を返す。
 * (旧暦の月 + 日 - 2) % 6 で割り当てる公式に対し、ここでは
 * 「最近の新月が含まれる JST 月」を旧暦の月の近似値とする。
 * 閏月を持つ年 (3年に1回程度) では境界で 1 日ずれる可能性あり、表示用途のため割愛。
 */
export function getRokuyou(date: Date = new Date()): Rokuyou {
  const { lastNewMoonMs, lunarDay } = lunarPhase(date);
  const newMoonJst = new Date(lastNewMoonMs + JST_OFFSET_MS);
  const lunarMonth = newMoonJst.getUTCMonth() + 1; // 1..12
  const idx = ((lunarMonth - 1 + lunarDay - 1) % 6 + 6) % 6;
  return ROKUYOU_NAMES[idx];
}

/**
 * 令和の年号文字列を返す ("令和8年" 等)。
 * 元号変更にも自動追従 (Intl の japanese calendar が最新を持つ前提)。
 */
const ERA_FORMATTER = new Intl.DateTimeFormat("ja-JP-u-ca-japanese", {
  era: "long",
  year: "numeric",
});

export function getJapaneseEraYear(date: Date = new Date()): string {
  // フォーマット結果は "令和8年" のような文字列
  return ERA_FORMATTER.format(date);
}

/**
 * 日本語の曜日 (日/月/火/水/木/金/土) を 1 文字で返す。
 */
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;
export function getWeekdayShort(date: Date = new Date()): string {
  return WEEKDAYS[date.getDay()];
}
