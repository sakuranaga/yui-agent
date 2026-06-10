/**
 * TTS 辞書 v1 / v2 出力比較スクリプト (= 回帰確認)。
 *
 * v1 (= 素朴 loop + RegExp gi の逐次置換) と v2 (= Aho-Corasick, 現行
 * applyDictionarySubstitution) を、同じ実辞書 + fixture で並べて差分を出す。
 *
 * docs/tts-dictionary-v2.md §6.2 / §3.6 の 3 段階検証を 1 本に統合:
 *   - 検証 1: 連鎖置換 (= reading に他 word が含まれる entry)
 *   - 検証 2: overlap 競合 (= 短 word が長 word の途中に現れるペア)
 *   - 検証 3: case-insensitive 衝突 (= lower(word) で重複する entry)
 *   - real:  代表的な会話テキスト fixture (= 架空サンプル)
 *
 * Usage (container 内): npx tsx scripts/tts-dict-v1v2-compare.ts
 *
 * 注: scripts/** は eslint.config.mjs で lint 対象外 (= 全 dev スクリプト共通の方針、
 * src/db/migrate.ts も同様)。本ファイルは tsconfig.json の include 対象なので
 * `npm run typecheck` では型検査される。lint をかけたい場合は
 * `npx eslint --no-ignore scripts/tts-dict-v1v2-compare.ts`。
 */
import { asc, eq } from "drizzle-orm";
import { db, sql } from "@/db/client";
import { ttsDictionary } from "@/db/schema";
import { applyDictionarySubstitution, type Entry } from "@/lib/tts-dictionary";

// ── v1 frozen reference (= 旧 src/lib/tts-dictionary.ts の素朴 loop) ──
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function v1Replace(text: string, dict: Entry[]): string {
  if (!text || dict.length === 0) return text;
  let out = text;
  for (const { word, reading } of dict) {
    if (!word) continue;
    const re = new RegExp(escapeRegExp(word), "gi");
    out = out.replace(re, reading);
  }
  return out;
}

type Category = "chain" | "overlap" | "case" | "real";
type Fixture = { text: string; category: Category; note?: string };

/** 架空の代表会話サンプル (= 個人情報なし、Yui の発話パターンを模した固定 fixture)。 */
const REAL_FIXTURES: string[] = [
  "おかえりなさいませ、ご主人様。今日の予定は Apple Music で確認できます。",
  "AIアシスタントのゆいです。VRMモデルの読み込みに5秒ほどかかります。",
  "3Dプリンタの設定を見直しましょう。USB ケーブルは挿さっていますか。",
  "GitHub のリポジトリを公開しました。CI のチェックも通っています。",
  "明日の天気は晴れ、最高気温は28℃の予報です。水分補給を忘れずに。",
  "Spotify と Apple Music、どちらで再生しますか。",
  "Next.js のビルドが完了しました。デプロイを開始してよろしいですか。",
  "メールが3通届いています。1通は重要、2通はニュースレターです。",
  "外苑前のカフェで14時に待ち合わせ、という予定でよろしいでしょうか。",
  "TypeScript の型エラーが2件あります。修正してから commit しましょう。",
  "今日の歩数は8500歩、目標までもう少しです。",
  "ChatGPT と Claude、両方の API キーが設定されています。",
  "VRoid Studio で作ったアバターを Yui に読み込みました。",
  "睡眠時間は7時間20分でした。よく眠れたようで何よりです。",
  "Docker コンテナを再起動します。少々お待ちください。",
];

async function buildFixtures(dict: Entry[]): Promise<Fixture[]> {
  const fixtures: Fixture[] = REAL_FIXTURES.map((text) => ({ text, category: "real" as const }));

  // 検証 1: 連鎖置換候補 (= a.reading に b.word が literal substring で含まれる)
  const chainRows = (await sql`
    SELECT a.word AS a_word, b.word AS b_word
    FROM tts_dictionary a
    JOIN tts_dictionary b ON position(b.word in a.reading) > 0
    WHERE a.id != b.id AND a.enabled AND b.enabled
    LIMIT 200
  `) as unknown as Array<{ a_word: string; b_word: string }>;
  for (const r of chainRows) {
    // a.word を含む text を投げると v1 は a→reading 後に reading 中の b を再置換し得る
    fixtures.push({
      text: `${r.a_word} を使います。`,
      category: "chain",
      note: `a=${r.a_word} reading に b=${r.b_word} を含む`,
    });
  }

  // 検証 2a: overlap 競合候補 (= short.word が long.word の途中 = 先頭以外に substring)
  const overlapRows = (await sql`
    SELECT short.word AS short_word, long.word AS long_word
    FROM tts_dictionary short
    JOIN tts_dictionary long ON position(short.word in long.word) > 1
    WHERE short.id != long.id
      AND length(short.word) < length(long.word)
      AND short.enabled AND long.enabled
    LIMIT 200
  `) as unknown as Array<{ short_word: string; long_word: string }>;
  for (const r of overlapRows) {
    fixtures.push({
      text: `${r.long_word} について話します。`,
      category: "overlap",
      note: `substring: short=${r.short_word} が long=${r.long_word} の途中`,
    });
  }

  // 検証 2b: suffix/prefix overlap merge (= A の suffix(k) == B の prefix(k))。
  // 例: A="ab", B="bc" → merge text "abc"。A が [0,2)、B が [1,3) で範囲が重なる。
  //   - v1 (逐次置換): 辞書順で先に当たった方が勝つ (= 順序依存)
  //   - v2 (leftmost-longest 1-pass): 左端の A を採用、重なる B は不採用
  //   → 同じ divergence クラス。substring (= 検証 2a) では検出できないので JS で別途生成。
  // SQL の substring join では表現しにくいため、ロード済 dict から O(N^2) で算出。
  // 大規模辞書では scan 件数 / 生成 fixture 件数に上限を設け、超過は log で明示 (= silent cap 禁止)。
  const OVERLAP_SCAN_CAP = 1500;
  const OVERLAP_FIXTURE_CAP = 1000;
  const words = dict.map((e) => ({ orig: e.word, low: e.word.toLowerCase() }));
  const scanN = Math.min(words.length, OVERLAP_SCAN_CAP);
  let mergeCount = 0;
  outer: for (let i = 0; i < scanN; i++) {
    for (let j = 0; j < scanN; j++) {
      if (i === j) continue;
      const a = words[i].low;
      const b = words[j].low;
      const maxK = Math.min(a.length, b.length) - 1;
      for (let k = maxK; k >= 1; k--) {
        if (a.slice(a.length - k) === b.slice(0, k)) {
          // A 全体 + B の overlap 以降を元 case で連結 (= ASCII なら k は orig とも整合)
          const merged = words[i].orig + words[j].orig.slice(k);
          fixtures.push({
            text: `${merged} です。`,
            category: "overlap",
            note: `suffix/prefix merge: ${words[i].orig} + ${words[j].orig} (k=${k})`,
          });
          mergeCount++;
          if (mergeCount >= OVERLAP_FIXTURE_CAP) {
            console.warn(
              `⚠️  suffix/prefix merge fixture が上限 ${OVERLAP_FIXTURE_CAP} 件に到達。以降は打ち切り。`
            );
            break outer;
          }
          break; // 最長 overlap のみ採用
        }
      }
    }
  }
  if (words.length > OVERLAP_SCAN_CAP) {
    console.warn(
      `⚠️  suffix/prefix merge scan は先頭 ${OVERLAP_SCAN_CAP} 件に限定 (dict ${words.length} 件)。` +
        ` 全 O(N^2) scan は大規模辞書では別途バッチで実施のこと。`
    );
  }

  // 検証 3: case-insensitive 衝突 (= lower(word) で重複)
  const caseRows = (await sql`
    SELECT array_agg(word ORDER BY word) AS variants
    FROM tts_dictionary
    WHERE enabled
    GROUP BY lower(word)
    HAVING COUNT(*) > 1
    LIMIT 200
  `) as unknown as Array<{ variants: string[] }>;
  for (const r of caseRows) {
    for (const v of r.variants ?? []) {
      fixtures.push({
        text: `${v} と表記されています。`,
        category: "case",
        note: `衝突 variants=${(r.variants ?? []).join(" / ")}`,
      });
    }
  }

  return fixtures;
}

async function main() {
  const rows = await db
    .select({ word: ttsDictionary.word, reading: ttsDictionary.reading })
    .from(ttsDictionary)
    .where(eq(ttsDictionary.enabled, true))
    .orderBy(asc(ttsDictionary.word));
  const dict: Entry[] = [...rows].sort((a, b) => b.word.length - a.word.length);

  const fixtures = await buildFixtures(dict);

  const counts: Record<Category, { total: number; diff: number }> = {
    chain: { total: 0, diff: 0 },
    overlap: { total: 0, diff: 0 },
    case: { total: 0, diff: 0 },
    real: { total: 0, diff: 0 },
  };
  const diffs: Array<Fixture & { v1: string; v2: string }> = [];

  for (const f of fixtures) {
    counts[f.category].total++;
    const v1 = v1Replace(f.text, dict);
    const v2 = applyDictionarySubstitution(f.text, dict);
    if (v1 !== v2) {
      counts[f.category].diff++;
      diffs.push({ ...f, v1, v2 });
    }
  }

  console.log(`\n=== TTS 辞書 v1/v2 比較 (dict ${dict.length} 件, fixture ${fixtures.length} 件) ===\n`);
  for (const cat of ["real", "chain", "overlap", "case"] as Category[]) {
    const c = counts[cat];
    console.log(`  ${cat.padEnd(8)}: ${c.diff} diffs / ${c.total} fixtures`);
  }

  // real (= 実会話 fixture) の差分だけが action 対象。
  // chain / overlap / case は §3.6 で v2 semantics を正本と決めた合成 adversarial
  // fixture なので、差分が出るのが期待動作 (= 検出力の証明、要 action ではない)。
  const realDiffs = diffs.filter((d) => d.category === "real");
  const semDiffs = diffs.filter((d) => d.category !== "real");

  if (semDiffs.length > 0) {
    console.log(
      `\nℹ️  §3.6 受容カテゴリ (chain/overlap/case) の差分 ${semDiffs.length} 件 = v2 semantics の期待動作 (= 検出力の確認):\n`
    );
    for (const d of semDiffs.slice(0, 20)) {
      console.log(`  [${d.category}] ${d.note ?? ""}`);
      console.log(`    in : ${JSON.stringify(d.text)}`);
      console.log(`    v1 : ${JSON.stringify(d.v1)}  →  v2 : ${JSON.stringify(d.v2)}`);
    }
    if (semDiffs.length > 20) console.log(`  ... 他 ${semDiffs.length - 20} 件`);
  }

  console.log("");
  if (realDiffs.length === 0) {
    console.log(`✅ real (= 実会話 fixture) は差分ゼロ。移行 OK。`);
    console.log(
      `   (chain/overlap/case の差分は §3.6 で v2 を正本と決めた合成ケース、action 不要)\n`
    );
    process.exit(0);
  } else {
    console.log(`❌ real (= 実会話 fixture) で ${realDiffs.length} 件の差分 → 辞書 entry のレビュー対象:\n`);
    for (const d of realDiffs) {
      console.log(`    in : ${JSON.stringify(d.text)}`);
      console.log(`    v1 : ${JSON.stringify(d.v1)}  →  v2 : ${JSON.stringify(d.v2)}`);
    }
    console.log("");
    process.exit(1); // 実会話で差分 = 移行前に要対応
  }
}

main().catch((e) => {
  console.error("[tts-dict-v1v2-compare] failed:", e);
  process.exit(1);
});
