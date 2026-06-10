/**
 * TTS 用語辞書のロード + 内部置換ヘルパ (v2 = Aho-Corasick)。
 *
 * - DB から enabled=true な entries を fetch、in-memory cache (TTL 60 秒)
 * - applyDictionarySubstitution(text, dict): Aho-Corasick で 1-pass leftmost-longest 置換
 * - /api/tts route の前段、tts-normalize.ts の前処理として呼ばれる
 *
 * v2 の設計詳細 / セマンティクス / 検証は docs/tts-dictionary-v2.md を参照。
 * 要点:
 *   - 多パターン同時マッチで辞書サイズに対しほぼ定数時間 (= O(M + 出現数))
 *   - leftmost-longest: 位置が重なる match は左端で始まる最長を採用
 *     (= 「Apple Music」が「Apple」より優先)
 *   - 1-pass: 置換結果に対する再マッチはしない (= v1 の連鎖置換は発動しない)
 *   - case-insensitive: 自前 normalize layer (= word / text を toLowerCase) で実現
 *   - 例外時は legacy 素朴 loop に退避し、TTS 出力経路を絶対に止めない
 */
import { asc, eq } from "drizzle-orm";
import { AhoCorasick } from "@monyone/aho-corasick/greedy";
import { db } from "@/db/client";
import { ttsDictionary } from "@/db/schema";

export type Entry = { word: string; reading: string };

/**
 * (entries, matcher, lookup) を同時生成した不変オブジェクト。
 * entries は fast-path 判定 (= reference identity) と legacy fallback に使う元 reference。
 * @internal verification / bench スクリプト用に export (= 通常の caller は使わない)
 */
export type Snapshot = {
  entries: Entry[];
  matcher: AhoCorasick;
  readingByWordLower: Map<string, string>; // keyword (= toLowerCase 済) → reading
};

let cache: (Snapshot & { loadedAt: number }) | null = null;
const TTL_MS = 60_000;

/** 強制 reload (admin 用)。CRUD 後の cache 無効化に使う。matcher も同一 snapshot で同時破棄。 */
export function invalidateDictionaryCache(): void {
  cache = null;
}

/**
 * Entry[] から AC matcher + word-lower → reading の lookup を構築。
 * 同一 lowercase キーは先勝ち (= entries が longest-first sort 済なら長い方が勝つ)。
 * @internal verification / bench スクリプト用に export (= 通常の caller は使わない)
 */
export function buildSnapshot(entries: Entry[]): Snapshot {
  const readingByWordLower = new Map<string, string>();
  const patterns: string[] = [];
  for (const e of entries) {
    if (!e.word) continue;
    const k = e.word.toLowerCase();
    if (!readingByWordLower.has(k)) {
      readingByWordLower.set(k, e.reading);
      patterns.push(k);
    }
  }
  const matcher = new AhoCorasick(patterns); // greedy 版 = leftmost-longest 自動
  return { entries, matcher, readingByWordLower };
}

/**
 * matchInText の結果から置換後文字列を組み立てる。
 * begin/end は lowercase 済 text に対する index だが、toLowerCase が長さを保つ限り
 * 元 text の index と一致する (= ASCII / CJK は常に保つ)。長さが変わる稀な文字
 * (= Turkish İ 等) が混じると index がズレるため、長さ不一致を検出したら legacy
 * loop に退避して出力の正しさを最優先する。
 * @internal verification / bench スクリプト用に export (= 通常の caller は使わない)
 */
export function replaceWithSnapshot(text: string, snap: Snapshot): string {
  if (!text) return text;
  const lower = text.toLowerCase();
  if (lower.length !== text.length) {
    // index 整合が崩れるケース → legacy で安全側に倒す
    return legacyLoopReplace(text, snap.entries);
  }
  const matches = snap.matcher.matchInText(lower);
  if (matches.length === 0) return text;

  // leftmost-longest なので非重複。begin 昇順で並べて差し込み構築。
  matches.sort((a, b) => a.begin - b.begin);

  const out: string[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.begin < cursor) continue; // 非重複前提だが念のためのガード
    out.push(text.slice(cursor, m.begin)); // 元 text (= case 保持) から切り出し
    const reading = snap.readingByWordLower.get(m.keyword);
    out.push(reading ?? text.slice(m.begin, m.end));
    cursor = m.end;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

export async function loadDictionary(): Promise<Entry[]> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < TTL_MS) return cache.entries;
  try {
    const rows = await db
      .select({ word: ttsDictionary.word, reading: ttsDictionary.reading })
      .from(ttsDictionary)
      .where(eq(ttsDictionary.enabled, true))
      .orderBy(asc(ttsDictionary.word));
    // longest-first で並べ替え (= 同一 lowercase キーで長い方を先勝ちさせる)
    const sorted = [...rows].sort((a, b) => b.word.length - a.word.length);
    const snap = buildSnapshot(sorted); // entries と matcher を同一 snapshot で構築
    cache = { ...snap, loadedAt: now };
    return sorted;
  } catch (e) {
    console.warn("[tts-dictionary] load failed:", e);
    return cache?.entries ?? [];
  }
}

/**
 * テキスト中の辞書 word を reading に置換する。純粋関数として dict 引数を尊重する。
 *
 * - fast path: dict が cache.entries と同一 reference なら cache の matcher を再利用 (= O(M + 出現数))
 * - slow path: 別 reference (= 任意辞書 / cache 未初期化) は ad-hoc snapshot 構築 (= O(P + M + 出現数))
 * - safety fallback: AC が throw したら legacy 素朴 loop で出力を担保 (= O(N × M))
 *
 * セマンティクス / 計算量の詳細は docs/tts-dictionary-v2.md §3.5 / §3.6 参照。
 */
export function applyDictionarySubstitution(text: string, dict: Entry[]): string {
  if (!text || dict.length === 0) return text;
  try {
    if (cache && cache.entries === dict) {
      return replaceWithSnapshot(text, cache); // fast path
    }
    const adhoc = buildSnapshot(dict);
    return replaceWithSnapshot(text, adhoc); // slow path
  } catch (e) {
    console.warn("[tts-dictionary] AC pipeline failed, falling back to legacy loop:", e);
    return legacyLoopReplace(text, dict); // safety fallback
  }
}

/**
 * v1 互換の素朴 loop 置換 (= longest-first 前提の逐次 RegExp 置換)。
 * v2 では AC 例外時 / toLowerCase 長さ変化時の safety fallback として恒久維持する。
 * docs/tts-dictionary-v2.md §3.5.1 参照 (= 移行期コードではない、削除しない)。
 */
function legacyLoopReplace(text: string, dict: Entry[]): string {
  if (!text || dict.length === 0) return text;
  let out = text;
  for (const { word, reading } of dict) {
    if (!word) continue;
    const re = new RegExp(escapeRegExp(word), "gi");
    out = out.replace(re, reading);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convenience: DB から fetch して即適用。/api/tts などのホットパスで使う (= fast path)。 */
export async function applyDictionary(text: string): Promise<string> {
  const dict = await loadDictionary();
  return applyDictionarySubstitution(text, dict);
}

/**
 * 起動時に 1 度だけ呼ぶ: tts_dictionary が完全に空ならプリセット (= TTS_DICTIONARY_PRESET)
 * を bulk insert する。**1 件でも存在すれば skip** (= user が削除した entry を seed で
 * 復活させない、user の意思を尊重)。
 *
 * 起動時に新規語が追加されたバージョンを取り込みたい場合は別途運用 (例: pre-existing
 * key だけ skip して未知の word のみ追加する増分 seed) を将来検討。
 */
export async function seedTtsDictionaryIfEmpty(): Promise<{
  seeded: number;
  reason: "empty" | "already-populated" | "error";
}> {
  try {
    const { TTS_DICTIONARY_PRESET } = await import("./tts-dictionary-preset");
    const existing = await db.select({ id: ttsDictionary.id }).from(ttsDictionary).limit(1);
    if (existing.length > 0) {
      return { seeded: 0, reason: "already-populated" };
    }
    if (TTS_DICTIONARY_PRESET.length === 0) {
      return { seeded: 0, reason: "empty" };
    }
    await db.insert(ttsDictionary).values(
      TTS_DICTIONARY_PRESET.map((p) => ({
        word: p.word,
        reading: p.reading,
        enabled: true,
      }))
    );
    invalidateDictionaryCache();
    return { seeded: TTS_DICTIONARY_PRESET.length, reason: "empty" };
  } catch (e) {
    console.warn("[tts-dictionary] seed failed:", e);
    return { seeded: 0, reason: "error" };
  }
}
