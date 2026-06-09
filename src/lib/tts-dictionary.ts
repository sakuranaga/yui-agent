/**
 * TTS 用語辞書のロード + 単純置換ヘルパ。
 *
 * - DB から enabled=true な entries を fetch、in-memory cache (TTL 60 秒)
 * - applyDictionarySubstitution(text): longest-first で文字列置換
 *   (短い語が長い語の部分文字列に含まれるケースで誤置換を避ける)
 * - /api/tts route の前段、normalize-tts.ts の前処理として呼ばれる
 */
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { ttsDictionary } from "@/db/schema";

type Entry = { word: string; reading: string };

let cache: { entries: Entry[]; loadedAt: number } | null = null;
const TTL_MS = 60_000;

/** 強制 reload (admin 用)。CRUD 後の cache 無効化に使う。 */
export function invalidateDictionaryCache(): void {
  cache = null;
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
    // longest-first で並べ替え (= 「Apple Music」が「Apple」より先に当たる)
    const sorted = [...rows].sort((a, b) => b.word.length - a.word.length);
    cache = { entries: sorted, loadedAt: now };
    return sorted;
  } catch (e) {
    console.warn("[tts-dictionary] load failed:", e);
    return cache?.entries ?? [];
  }
}

/**
 * テキスト中の辞書 word を reading に全置換 (大文字小文字を区別しない簡易マッチ)。
 * 同じ word の連続出現はすべて置換。replace で文字列 indexOf を回す素朴実装、
 * 数十語 × 数百〜数千文字なら 1 ms 程度。
 */
export function applyDictionarySubstitution(text: string, dict: Entry[]): string {
  if (!text || dict.length === 0) return text;
  let out = text;
  for (const { word, reading } of dict) {
    if (!word) continue;
    // 大文字小文字を区別しない置換: word を regex エスケープ + i フラグ
    const re = new RegExp(escapeRegExp(word), "gi");
    out = out.replace(re, reading);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convenience: DB から fetch して即適用。/api/tts などのホットパスで使う。 */
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
