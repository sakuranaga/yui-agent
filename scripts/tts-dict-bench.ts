/**
 * TTS 辞書 v1 / v2 性能ベンチ。
 *
 * 合成辞書 (= 件数別) × 合成 text (= 長さ別) で v1 (= 素朴 loop) と v2 (= AC) の
 * 所要 ms を median で比較し、§4.1 の hard line (= 100k 件 / 500 字 ≤ 50ms) 達成可否を判定。
 *
 * v2 は現行 lib の buildSnapshot / replaceWithSnapshot を直接呼ぶ (= 実コードを計測、drift なし)。
 * hot path = snapshot 構築済で replaceWithSnapshot を回す経路 (= fast path) を測る。
 *
 * docs/tts-dictionary-v2.md §4 / §6.3 参照。
 * Usage (container 内): npx tsx scripts/tts-dict-bench.ts
 *
 * 注: scripts/** は eslint.config.mjs で lint 対象外 (= 全 dev スクリプト共通の方針、
 * src/db/migrate.ts も同様)。本ファイルは tsconfig.json の include 対象なので
 * `npm run typecheck` では型検査される。lint をかけたい場合は
 * `npx eslint --no-ignore scripts/tts-dict-bench.ts`。
 */
import {
  buildSnapshot,
  replaceWithSnapshot,
  type Entry,
  type Snapshot,
} from "@/lib/tts-dictionary";

const DICT_SIZES = [50, 1_000, 10_000, 50_000, 100_000];
const TEXT_LENS = [100, 500, 2_000, 10_000];
const WARMUP = 3;
const MEASURE = 10;
// v1 は大規模で極端に遅い (= 置換対象が増える) ため、件数上限を設けて crossover だけ示す。
const V1_MAX_SIZE = 10_000;

// 決定的擬似乱数 (= Math.random は使わない、seed 固定で再現性を持たせる)
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const KATA = "アイウエオカキクケコサシスセソタチツテトナニヌネノ";

function randWord(rng: () => number): string {
  const len = 8 + Math.floor(rng() * 5); // 8-12 文字
  let w = "";
  for (let i = 0; i < len; i++) w += ALPHA[Math.floor(rng() * ALPHA.length)];
  return w;
}
function randReading(rng: () => number): string {
  const len = 3 + Math.floor(rng() * 4);
  let r = "";
  for (let i = 0; i < len; i++) r += KATA[Math.floor(rng() * KATA.length)];
  return r;
}

function makeDict(size: number, rng: () => number): Entry[] {
  const seen = new Set<string>();
  const dict: Entry[] = [];
  while (dict.length < size) {
    const word = randWord(rng);
    if (seen.has(word.toLowerCase())) continue; // case 衝突を避けてクリーンな合成辞書に
    seen.add(word.toLowerCase());
    dict.push({ word, reading: randReading(rng) });
  }
  // lib と同じく longest-first sort
  return dict.sort((a, b) => b.word.length - a.word.length);
}

/** dict の word をところどころ混ぜた text を生成 (= 実際に match が起きる現実的な負荷)。 */
function makeText(len: number, dict: Entry[], rng: () => number): string {
  const filler = "あいうえおかきくけこさしすせそ日本語のテキスト ";
  let out = "";
  while (out.length < len) {
    if (rng() < 0.15 && dict.length > 0) {
      out += dict[Math.floor(rng() * dict.length)].word + " ";
    } else {
      out += filler[Math.floor(rng() * filler.length)];
    }
  }
  return out.slice(0, len);
}

// ── v1 frozen reference ──
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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function timeRun(fn: () => void): number {
  for (let i = 0; i < WARMUP; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < MEASURE; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

type Cell = { size: number; len: number; v1: number | null; v2: number };

function fmt(ms: number | null): string {
  if (ms === null) return "  (skip)";
  return `${ms.toFixed(2)}ms`.padStart(8);
}

async function main() {
  const rng = makeRng(20260610);
  const cells: Cell[] = [];

  console.log(
    `\n=== TTS 辞書 v1/v2 ベンチ (warmup ${WARMUP} + measure ${MEASURE}, median) ===\n`
  );

  for (const size of DICT_SIZES) {
    const dict = makeDict(size, rng);
    const snap: Snapshot = buildSnapshot(dict); // fast path = 構築済 snapshot を再利用
    const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
    for (const len of TEXT_LENS) {
      const text = makeText(len, dict, rng);
      const v2 = timeRun(() => {
        replaceWithSnapshot(text, snap);
      });
      const v1 =
        size <= V1_MAX_SIZE
          ? timeRun(() => {
              v1Replace(text, dict);
            })
          : null;
      cells.push({ size, len, v1, v2 });
    }
    console.log(`  [${size.toLocaleString()} 件] snapshot 構築後 heapUsed ≈ ${heapMb.toFixed(0)} MB`);
  }

  // markdown table 出力
  console.log(`\n| dict 件数 | text 長 | v1 (loop) | v2 (AC) | 速度比 |`);
  console.log(`|---|---|---|---|---|`);
  for (const c of cells) {
    const ratio =
      c.v1 !== null && c.v2 > 0 ? `${(c.v1 / c.v2).toFixed(1)}x` : "—";
    console.log(
      `| ${c.size.toLocaleString()} | ${c.len} | ${fmt(c.v1)} | ${fmt(c.v2)} | ${ratio} |`
    );
  }

  // hard line 判定: 100k 件 / 500 字 ≤ 50ms
  const hard = cells.find((c) => c.size === 100_000 && c.len === 500);
  console.log(`\n=== §4.1 hard line 判定 ===`);
  if (hard) {
    const ok = hard.v2 <= 50;
    console.log(
      `  100k 件 / 500 字: v2 = ${hard.v2.toFixed(2)}ms  →  ${ok ? "✅ OK (≤ 50ms)" : "❌ NG (> 50ms)"}`
    );
  } else {
    console.log(`  100k/500 セルが見つかりません`);
  }
  console.log(
    `\n注: v1 は ${V1_MAX_SIZE.toLocaleString()} 件超を skip (= §2.1 の推定通り秒オーダーで遅く、` +
      `置き換え対象そのもの)。\n`
  );

  process.exit(0);
}

main().catch((e) => {
  console.error("[tts-dict-bench] failed:", e);
  process.exit(1);
});
