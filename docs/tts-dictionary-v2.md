# TTS 辞書 v2 (= Aho-Corasick による内部置換高速化) 設計書

## 0. 本書の位置付け

### 0.1 目的

**Yui のセリフを Irodori (= TTS エンジン) で完璧に発音させる**。

そのために、Yui 側で持っている TTS 辞書 (= `tts_dictionary`) を **辞書サイズが業務レベル (= 1 万件 + 想定、上限なし) に増えても UX 破綻しない実装グレード** に引き上げる。

本書は **汎用日本語カタカナ変換ライブラリの設計書ではない**。ja-furigana 風 Smart engine / 文脈分岐 / Unicode 正規化 / 形態素解析 / 観測性パイプラインは **明示的にスコープ外** (= §9)。

問題は「辞書サイズが 1 万件 + に増えると素朴 loop が遅い」だけ。解決は「内部実装を Aho-Corasick に置き換える」だけ。

### 0.2 責務分担 (= 本書の根幹原則)

| 領域 | 責務者 | 理由 |
|---|---|---|
| 漢字読み振り | **TTS エンジン (= Irodori)** | TTS モデル内部で訓練済。再実装は二重持ち |
| 助詞・文末イントネーション | TTS エンジン | 同上 |
| 文脈に応じた読み分岐 | TTS エンジン | 同上 |
| 形態素解析 | TTS エンジン | 同上 |
| Unicode 正規化 | TTS エンジン | 同上 (= Yui 側で先回りすると逆に誤動作の元) |
| **英語固有名詞のカタカナ化** | **Yui (= 本書)** | Irodori の主な弱点 |
| **Irodori が誤読する漢字熟語の固定読み補正** | **Yui (= 本書)** | ご主人様の保険、例外的少数 entry |
| 観測性 / 統計 / 監視ダッシュボード | 該当なし | Yui の用途 (= TTS 補完) では不要、UX 計測は別問題 |
| 多言語拡張 / 汎用化 | 該当なし | スコープ外 |

**設計指針**: Yui は「TTS エンジンが間違える部分だけ」を辞書置換で補完する layer。TTS エンジンの内部機能を Yui 側で再実装する誘惑があっても **絶対に避ける** (= 二重実装は追加機能ではなく追加リスク。機能漏れ / 整合性ズレ / メンテ二重化 / 多段判定での誤差累積)。

業務レベルの達成基準は機能の網羅性ではなく、**現スコープでの実装グレード** で測る:
- 辞書 1 万 〜 10 万件まで線形劣化させない
- 既存 API 互換 + 実運用辞書での出力同一性を検証 (= §3.6 の 3 段階検証で担保。v1/v2 完全一致は主張しない)
- caller への影響ゼロでの内部置換

---

## 1. 現状把握 (v1)

### 1.1 既存スキーマ

`src/db/schema.ts`:

```ts
export const ttsDictionary = pgTable("tts_dictionary", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  word: text("word").notNull().unique(),
  reading: text("reading").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp(...),
  updatedAt: timestamp(...),
});
```

### 1.2 既存実装 (= 素朴 loop)

`src/lib/tts-dictionary.ts`:

- `loadDictionary()`: 60 秒 TTL の memory cache、enabled=true の行を `longest-first sort` で取得
- `applyDictionarySubstitution(text, dict)`: dict 全件を loop、各 entry ごとに `RegExp(word, "gi")` で text 全 scan + 置換
- 計算量: **O(N × M)** (= N: 辞書サイズ、M: テキスト長)
- 内部コメント: 「数十語 × 数百〜数千文字なら 1ms 程度」

### 1.3 runtime 経路

`src/lib/tts-normalize.ts`:
1. `loadDictionary()` で DB から辞書取得
2. `applyDictionarySubstitution(input, dict)` で **DB 辞書だけで pre-substitute**
3. その結果を LLM 正規化 (= Anthropic Haiku) に投げて記号 / 漢字読みを最終調整
4. 結果を Irodori に渡す

(= preset 50 件は **runtime では参照されない**。`seedTtsDictionaryIfEmpty()` の seed source + LLM プロンプトの DB 空時の安全網のみ)

### 1.4 cache 構造

- `let cache: { entries: Entry[]; loadedAt: number } | null`
- TTL: 60_000 ms
- 無効化: `invalidateDictionaryCache()` を CRUD 直後に呼ぶ

---

## 2. 問題定義

### 2.1 線形劣化の試算

text 500 文字想定、件数別の予測:

| 辞書件数 | 素朴 loop | UX 体感 |
|---|---|---|
| 50 (現状) | ~1 ms | 体感ゼロ |
| 1,000 | ~20 ms | 体感ゼロ |
| 5,000 | ~100 ms | ほぼ問題なし |
| 10,000 | ~200 ms | 違和感出始め |
| 50,000 | ~1 秒 | 明確に遅い (= Yui の声に遅延) |
| **100,000** | **~2 秒** | **UX 破綻** |

加えて毎ターン `new RegExp()` を N 回 compile するコストも積む (= GC pressure)。

### 2.2 業務レベルでの許容基準

- 100k 件規模で **TTS 1 ターンあたり 50ms 以下** を維持
- 平均 entry 8-12 文字、text 200-1000 文字、現実的な負荷
- これを満たせないと「Yui の声の即応性」が壊れる → 不可

---

## 3. v2 設計

### 3.1 アルゴリズム選定

**Aho-Corasick (= AC) + leftmost-longest mode**。

- 多パターン同時マッチング (= 1 回の text scan で全 entry を検出)
- 計算量: **O(M + 出現数)** (= 辞書サイズに対してほぼ定数時間)
- leftmost-longest で「Apple Music」が「Apple」より優先される (= ご主人様の用途で必須)
- 文字種を問わない (= 英語 / 漢字 / 記号、混在 OK)

ja-furigana 風 Smart engine (= 6 Provider + Viterbi DP + 文脈マッチ) は **採用しない**。理由は §0.2 責務分担を参照。

### 3.2 ライブラリ選定 (= 確定: `@monyone/aho-corasick`)

#### 3.2.1 評価基準 (= 将来の再選定時の指針)

- **必須**:
  - leftmost-longest mode 対応 (= overlap 解決を機械的に行う)
  - case-insensitive 対応 (= 英語の大小ゆれを単一 entry でカバー、自前 normalize 含めて達成できれば OK)
  - JS から呼べる (= Yui の Node.js 環境)
  - メンテ active (= 過去 6 ヶ月以内に更新あり)
  - TypeScript 型定義あり、または高品質
  - **OSS 配布性を破壊しない** (= 純粋な npm install で完結、追加 toolchain 強制不可)
- **望ましい**:
  - 増分更新サポート (= 1 件 add で trie 全 rebuild を回避できれば理想、必須ではない)
  - 高速版オプション (= Double Array / SIMD 等の上振れ余地)
  - メモリ占有の予測可能性

#### 3.2.2 候補比較結果

調査時点 (2026-06-10) の主要 npm 公開 AC ライブラリ:

| ライブラリ | 採否 | 主理由 |
|---|---|---|
| **`@monyone/aho-corasick`** | **採用 ★** | pure TS、依存ゼロ、`/greedy` で leftmost-longest 対応、`/fast` で Double Array、active メンテ (v1.1.11 / 2026-05 publish) |
| `@blackglory/aho-corasick` | **不採用** | daachorse の Node-API wrapper、`npm install` 時に **`neon build` で Rust toolchain 必須**、prebuild なし、npm publish は 1 年以上前 (= メンテ滞り)。Yui の Docker image +数百 MB / OSS contributor の install 障壁になる |
| `daachorse` (Rust) | 対象外 | Rust crate、Node 直接利用不可 (= 上の wrapper 経由のみ) |
| `tanishiking/aho-corasick-js` | 不採用 | 2020 年から push なし (= 放置) |
| `jamestkelly/aho-corasick` | 不採用 | 2023 年から push なし (= 放置) |
| `ahocorasick` (npm) | 不採用 | 古典実装、leftmost-longest 機能不足 |
| `lazy-aho-corasick`, `spencermountain/aho_corasick` 等 | 不採用 | 機能 / メンテ実態が候補劣後 |

#### 3.2.3 採用版の重要仕様

採用: **`@monyone/aho-corasick`** (= MIT、npm `@monyone/aho-corasick`)

```bash
npm install @monyone/aho-corasick
```

- 依存追加 1 個 (= 依存ゼロのライブラリ)
- Yui の Docker image / Node 環境への追加要件 **なし**
- `lockfile commit` + `npm audit` 確認は `CLAUDE.md` の dependency 規約に従う

import エントリポイント:

| import path | 用途 |
|---|---|
| `@monyone/aho-corasick` | 基本実装 (= match 列挙) |
| **`@monyone/aho-corasick/greedy`** | **leftmost-longest 用、本書はこれを採用** |
| `@monyone/aho-corasick/fast` | Double Array 高速版 (= Phase 1 ベンチで `/greedy` と比較、有意差あれば移行可) |

API (= README より):

```ts
import { AhoCorasick } from "@monyone/aho-corasick/greedy";

const ac = new AhoCorasick(["Apple", "Apple Music", "AIDLE"]);
const matches = ac.matchInText("Apple Music と AIDLE");
// → [{begin: 0, end: 11, keyword: "Apple Music"}, {begin: 14, end: 19, keyword: "AIDLE"}]
```

- `replace(text)` の direct API はない (= `matchInText` の結果から自前で置換構築する、§3.3 で実装)
- `caseSensitive` フラグなし → **入力 / pattern を正規化して保存・検索する自前 normalize layer** で対応 (§3.3 参照)

### 3.3 内部データ構造と置換ロジック (= 採用ライブラリに即した実装)

#### 3.3.1 case-insensitive 対応戦略 (= 自前 normalize layer)

採用ライブラリ `@monyone/aho-corasick` には `caseSensitive: false` フラグはない。v2 では **自前 normalize layer** で対応:

- **辞書側 (= trie 構築時)**: word を `toLowerCase()` して pattern として trie に入れる。reading は元のまま保持
- **text 側 (= 検索時)**: 同じく `toLowerCase()` した text で AC を走らせ、`{begin, end, keyword}` を取得
- **置換時 (= 結果構築)**: begin/end は **元 text (= case 保持版)** に対する index として有効。begin から end までを reading に差し替え

この戦略は ASCII 英字 (= Yui の主要用途) で完全に動作する。日本語の漢字 / カタカナ / 平仮名は `toLowerCase()` が no-op なので影響なし。

##### case-insensitive で衝突する複数 entry の扱い (= 仕様)

`tts_dictionary.word` の DB unique 制約は case-sensitive (= Postgres default の text 比較)。よって以下が **DB レベルで許容される**:

| id | word | reading |
|---|---|---|
| 1 | Apple | アップル |
| 2 | apple | エイプル |

v1 (= 素朴 loop + RegExp `gi`):
- 両方 entry が独立に gi RegExp で text 全 scan、ループ順序で後者が勝つ
- 順序は `longest-first sort` の同長 tie 解決次第 (= 不定)
- **v1 自体が undefined 挙動**

v2 (= 自前 normalize layer + AC):
- `readingByWordLower.has(k)` 判定で先勝ち、後続 entry は無視
- `buildSnapshot` は entries 配列の iter 順 (= `loadDictionary` の longest-first sort 後の順) で先頭が勝つ
- これも順序依存だが、v1 より予測可能 (= sort 規則が明示)

**v2 の正式仕様**:
- **case-insensitive 衝突 entry が存在する場合の挙動は undefined (= 先勝ちで処理する、後続は無視)**
- ご主人様の運用では衝突を **作らない** ことを推奨。意図的に case 別 reading を割り当てたい場合は word 自体を変える (= 例: `Apple_company`, `apple_fruit`)

##### 衝突検出 SQL (= Phase 1 で実施)

```sql
-- case-insensitive で同一 word を持つ複数 entry を検出
SELECT lower(word) AS lower_word,
       COUNT(*) AS cnt,
       array_agg(word ORDER BY word) AS variants,
       array_agg(reading ORDER BY word) AS readings
FROM tts_dictionary
WHERE enabled
GROUP BY lower(word)
HAVING COUNT(*) > 1;
```

ヒットがあればご主人様に提示し、片方を削除 / disable / word 変更でクリーンにしてから v2 移行。

#### 3.3.2 Matcher 構築 helper (= 内部関数)

```ts
// src/lib/tts-dictionary.ts (= v2)
import { AhoCorasick } from "@monyone/aho-corasick/greedy";

type Entry = { word: string; reading: string };

/**
 * Entry[] から AC matcher + word-lower → reading の lookup を作る。
 * snapshot とは「(entries, matcher, lookup) を同時生成された不変オブジェクト」を指す。
 */
type Snapshot = {
  entries: Entry[];                            // identity 比較用 (= 元 reference)
  matcher: AhoCorasick;                        // trie 本体
  readingByWordLower: Map<string, string>;     // keyword (= toLowerCase 済) → reading
};

function buildSnapshot(entries: Entry[]): Snapshot {
  const readingByWordLower = new Map<string, string>();
  const patterns: string[] = [];
  for (const e of entries) {
    if (!e.word) continue;
    const k = e.word.toLowerCase();
    // 同一 lowercase キーで先勝ち (= 既存 longest-first sort 後で先に来た方が長いので妥当)
    if (!readingByWordLower.has(k)) {
      readingByWordLower.set(k, e.reading);
      patterns.push(k);
    }
  }
  const matcher = new AhoCorasick(patterns);  // greedy 版なので leftmost-longest 自動
  return { entries, matcher, readingByWordLower };
}
```

#### 3.3.3 置換ロジック (= matchInText → replace 構築)

`@monyone/aho-corasick` は `replace()` の direct API を持たない。matchInText の結果から自前で置換結果を組み立てる:

```ts
function replaceWithSnapshot(text: string, snap: Snapshot): string {
  if (!text) return text;
  const lower = text.toLowerCase();
  const matches = snap.matcher.matchInText(lower);
  if (matches.length === 0) return text;

  // matches は leftmost-longest で非重複。begin 昇順で並べて差し込み構築。
  matches.sort((a, b) => a.begin - b.begin);

  const out: string[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.begin < cursor) continue;  // 安全のためのガード (= 非重複前提だが念のため)
    out.push(text.slice(cursor, m.begin));  // 元 text (= case 保持) から切り出し
    const reading = snap.readingByWordLower.get(m.keyword);
    out.push(reading ?? text.slice(m.begin, m.end));
    cursor = m.end;
  }
  out.push(text.slice(cursor));
  return out.join("");
}
```

#### 3.3.4 cache + public API

```ts
let cache: (Snapshot & { loadedAt: number }) | null = null;
const TTL_MS = 60_000;

export function invalidateDictionaryCache(): void {
  cache = null;  // 既存通り。matcher も snapshot 内で同時破棄される
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
    const sorted = [...rows].sort((a, b) => b.word.length - a.word.length);
    const snap = buildSnapshot(sorted);  // entries と matcher を同一 snapshot で構築
    cache = { ...snap, loadedAt: now };
    return sorted;
  } catch (e) {
    console.warn("[tts-dictionary] load failed:", e);
    return cache?.entries ?? [];
  }
}

/**
 * 純粋関数として dict 引数を尊重する (= テスト / 任意辞書の呼び出しでも正しい結果)。
 * 内部最適化: dict が cache.entries と **同一 reference** なら cache.matcher 再利用 (= fast path、O(M + Z))。
 * 別 reference のときは ad-hoc snapshot を構築 (= slow path、O(P + M + Z)。P = 辞書 word 総文字数)。
 * 詳細な計算量・例外時 fallback は §3.5 参照。
 */
export function applyDictionarySubstitution(text: string, dict: Entry[]): string {
  if (!text || dict.length === 0) return text;
  // fast path: cache snapshot を再利用
  if (cache && cache.entries === dict) {
    return replaceWithSnapshot(text, cache);
  }
  // slow path: 任意辞書 → ad-hoc snapshot 構築
  const adhoc = buildSnapshot(dict);
  return replaceWithSnapshot(text, adhoc);
}

/** Hot path 用の convenience wrapper (= cache snapshot を使う) */
export async function applyDictionary(text: string): Promise<string> {
  const dict = await loadDictionary();
  return applyDictionarySubstitution(text, dict);  // fast path に当たる
}
```

#### 3.3.5 設計上の論点

- **`applyDictionarySubstitution(text, dict)` の signature は維持** (= caller 影響ゼロ)
- **dict 引数は無視されない** (= 任意辞書を渡したテストでも正しい出力)
- **fast path 判定は reference identity** (= deep compare ではない)。`loadDictionary` が返した配列をそのまま `applyDictionarySubstitution` に渡せば fast path、別配列を渡せば slow path
- **slow path は ad-hoc snapshot 構築** (= 任意辞書でも O(P + M + Z) を担保。詳細な階層と例外時 fallback は §3.5 参照)
- **case-insensitive は自前 normalize で達成** (= 日本語 entry にも no-op で影響なし)
- **`/greedy` の leftmost-longest が overlap 解決を機械的に保証** (= ご主人様の「Apple Music vs Apple」「AIDLE vs AI」ケースを `matchInText` 単体でカバー)

### 3.4 cache invalidation と trie rebuild (= lazy 再構築 + 責務契約)

既存 `invalidateDictionaryCache()` (= `src/lib/tts-dictionary.ts:18`) は同期で `cache = null` するだけの軽量関数。v2 でもこの挙動を維持する:

- `invalidateDictionaryCache()`: cache を破棄するだけ (= matcher も同時に捨てられる、同一 snapshot なので)
- **次の `loadDictionary()` 呼び出し時に lazy で再構築** (= entries と matcher を同一 snapshot として 1 回でビルド)
- これにより CRUD UI (= 「読み方」タブの追加 / 編集 / 削除 / enabled 切替) は即時応答 (= invalidate 1 回だけで完了)
- trie 構築コストが発生するのは次の TTS 出力経路 (= `loadDictionary()` 呼び出し時) で初回 1 回だけ

再構築コスト見積もり (= ライブラリ選定後に実測差し替え):
- 1 万件: ~100ms
- 10 万件: ~500ms

これは TTS 出力前の 1 度だけ発生 (= 60 秒 cache 内なら以降の出力経路ではゼロ)。hot path 影響は最小。

#### 3.4.1 全 CRUD 経路の責務契約 (= invalidate 呼び出し責任)

`tts_dictionary` テーブルを `INSERT` / `UPDATE` / `DELETE` する **すべての** 経路は、DB 操作の直後に **必ず `invalidateDictionaryCache()` を呼ぶ責務を持つ**。これは v1 から継続するルールで、v2 でも維持する。

理由: invalidate を忘れると、cache TTL (= 60 秒) が満了するまで古い trie が使われ続け、Yui が word を追加しても TTS で置換されない (= ご主人様 / Yui の意図と乖離した状態が最大 60 秒残る)。

#### 3.4.2 既存 CRUD 経路 (= v1 時点で確認済)

| # | 経路 | DB 操作 | `invalidateDictionaryCache()` 呼出し |
|---|---|---|---|
| 1 | `app/api/tts-dictionary/route.ts` (= POST、新規追加 / 「読み方」タブ) | line 49 INSERT | line 60 ✓ |
| 2 | `app/api/tts-dictionary/[id]/route.ts` (= PATCH、編集 / 「読み方」タブ) | line 33 UPDATE | line 40 ✓ |
| 3 | `app/api/tts-dictionary/[id]/route.ts` (= DELETE、削除 / 「読み方」タブ) | line 58 DELETE | line 64 ✓ |
| 4 | `lib/tools/dict/add_pronunciation.ts` (= **Yui のツール経由追加**) | line 59 INSERT | line 66 ✓ |
| 5 | `lib/tts-dictionary.ts` の `seedTtsDictionaryIfEmpty()` (= 初回 seed) | line 90 INSERT | line 97 ✓ |

すべての経路で呼ばれている (= v1 時点で実装済)。v2 でも同じ責務契約を守る。

#### 3.4.3 新規 CRUD 経路を追加する人へのルール

将来 `tts_dictionary` を CRUD する経路 (= 一括 import、bulk update、辞書管理 UI 拡張、新ツール等) を追加する場合、**DB 操作直後に必ず `invalidateDictionaryCache()` を呼ぶこと**。

呼び忘れの主な症状:
- Yui が `add_pronunciation` で word 追加 → TTS で置換されない (= 最大 60 秒)
- 「読み方」UI でご主人様が編集 → 反映が遅れる

#### 3.4.4 監査用セルフチェック

CRUD 経路追加 PR 時 / 定期監査時に、以下の grep で漏れを検出:

```bash
# 1. tts_dictionary を mutation している全箇所をリストアップ
grep -rn "ttsDictionary" src --include="*.ts" --include="*.tsx" \
  | grep -E "(insert|update|delete)\(ttsDictionary"

# 2. 同じファイル内で invalidateDictionaryCache が呼ばれていることを確認
# (= 上の grep の各ファイルが下の grep にも出てくるかチェック)
grep -rn "invalidateDictionaryCache" src --include="*.ts" --include="*.tsx"
```

両方の出力を突き合わせて、mutation するファイルが invalidate を呼んでいない (= ファイル名が片方にしか出ない) 経路がないことを確認する。

### 3.5 ホット経路の振る舞いと例外時 fallback (= 一本化)

`applyDictionarySubstitution` の振る舞いを 3 階層に整理し、§3.3.4 と Phase 1/2 で齟齬が出ないようにする:

| 状況 | 動作 | パス名 | 計算量 (= M: text 長、N: dict 件数、P: 辞書 word 総文字数、Z: 出現数) |
|---|---|---|---|
| `text` または `dict` が空 | そのまま返す | early return | O(1) |
| `cache.entries === dict` (= 同一 reference) | cache の snapshot を再利用して AC で置換 | **fast path** | **O(M + Z)** (= build は事前完了済) |
| 上記以外 (= 任意辞書 / cache 未初期化) | ad-hoc snapshot を構築して AC で置換 | **slow path** | **O(P + M + Z)** (= build P が毎回入る) |
| AC ライブラリが throw / 失敗 (= ライブラリ bug 等の例外) | legacy 素朴 loop で出力を担保 | **safety fallback** | O(N × M) |

slow path の `P` (= 辞書 word 総文字数) は **毎回 build が走るため非無視**。任意辞書を頻繁に渡す呼び出し (= 将来テスト経路 / バッチ処理) では事前に snapshot を作って cache に固定するか、別 helper で snapshot を保持する設計が望ましい。本書のスコープ内では hot path は fast path で動作するので問題ない。

実装パターン:

```ts
export function applyDictionarySubstitution(text: string, dict: Entry[]): string {
  if (!text || dict.length === 0) return text;
  try {
    if (cache && cache.entries === dict) {
      return replaceWithSnapshot(text, cache);       // fast path
    }
    const adhoc = buildSnapshot(dict);
    return replaceWithSnapshot(text, adhoc);          // slow path
  } catch (e) {
    console.warn("[tts-dictionary] AC pipeline failed, falling back to legacy loop:", e);
    return legacyLoopReplace(text, dict);             // safety fallback
  }
}
```

#### 3.5.1 legacy loop fallback の位置付け (= 恒久維持)

ご主人様の業務レベル要件 (= 「絶対に出力を返す」契約) のために、safety fallback は **恒久維持** とする。一時的な移行期コードではない:

- AC ライブラリ側に将来 bug が混入しても、TTS 出力経路が止まらない
- legacy loop は数十行の小さなコード、保守コストはほぼゼロ
- Phase 2 (= §7) では「移行期 fallback を削除」のような誤った clean-up を **行わない**

「v2 の slow path は素朴 loop」「移行期だけ残す」という旧記述は撤回。**slow path = ad-hoc snapshot 構築、legacy loop = AC 例外時の safety fallback のみ**で一本化する。

### 3.6 セマンティクス: v1 と v2 の置換モデル差分 (= 仕様変更を明示)

**v1 (= 素朴 loop + longest-first sort)** は **逐次置換** モデル:
- 辞書を文字数降順にループ
- 各 entry ごとに `text.replace(regex, reading)` を実行
- **前の置換で生まれた文字列に対して、後続の entry が再マッチする可能性がある**

**v2 (= AC + leftmost-longest)** は **元 text 1-pass** モデル:
- 元 text に対して 1 回 scan
- 非重複の match を一括置換
- **置換結果に対する再マッチは行わない**

#### ケース A: 大半の実用ケース (= 両者一致)

text: `"AIDLEを使う"`、辞書: `[AI=エーアイ, IDLE=アイドル, AIDLE=アイドル]`
- v1: 文字数降順 → AIDLE 先 → "アイドルを使う" ✓
- v2: 位置 0 から最長マッチ → AIDLE → "アイドルを使う" ✓

text: `"AIとIDLEは違う"`、辞書: `[AI=エーアイ, IDLE=アイドル]`
- v1: IDLE 先 → "AIとアイドルは違う" → AI 後 → "エーアイとアイドルは違う"
- v2: 位置 0 で AI、位置 3 で IDLE → "エーアイとアイドルは違う"
- 両者同じ結果 ✓

#### ケース B: 連鎖置換が発動する場合 (= 仕様変更で v1 ≠ v2)

辞書: `[A=B, B=C]`、text: `"A"`

- **v1**: A→B (= 1 周目) → 次に B→C (= 2 周目) → 結果 **"C"**
- **v2**: A→B (= 1-pass) → 結果 **"B"**

辞書: `[USD=ユーエスドル, ドル=ダラー]`、text: `"USD"`

- **v1**: USD→ユーエスドル → 続いて ドル→ダラー → 結果 **"ユーエスダラー"**
- **v2**: USD→ユーエスドル → 結果 **"ユーエスドル"**

#### ケース C: overlap 競合 (= 「全体 longest-first」と「leftmost-longest」の差)

辞書: `[bcd=Y, ab=X]`、text: `"abcd"`

- **v1** (= 文字数降順 sort + 順次置換): bcd (3 字) を先に処理 → text 中で「bcd」を見つけて置換 → "aY"
- **v2** (= leftmost-longest 1-pass): 位置 0 から最長を探す → 「ab」(= 2 字、位置 0-1) を採用、位置 1-3 の「bcd」は重なるので不採用 → "Xcd"

> **重要**: 両 entry の長さが同じでも、開始位置が違って範囲が重なれば差分が出る。v1 は「辞書順 (= 文字数降順) で先に見つかった方が勝つ」、v2 は「左端で始まる長い方が勝つ」。これは異なる semantics。

実用辞書では発生率が低い (= 通常の英語固有名詞 / 漢字熟語は単語境界がはっきり、互いに重ならない) が、辞書サイズが 1 万件規模になると確率的に起き得る。

#### v2 の仕様変更宣言

**v2 は以下の semantics を採用する**:

1. **1-pass**: reading に他 word が再出現しても再置換しない (= ケース B の連鎖置換は発動しない)
2. **leftmost-longest**: 位置が重なる match のうち、左端で始まる最長を採用する (= ケース C の overlap 競合は左端優先)
3. **case-insensitive**: 自前 normalize layer で実現 (= §3.3.1)

理由:

1. v1 の連鎖置換 / 全体 longest-first は意図的機能ではなく素朴 loop 実装の副作用 (= 順序依存で出力が変わる、辞書の sort 規則を変えると挙動が変わる、開発者が予測しにくい)
2. ご主人様の実運用辞書 (= 英語固有名詞 / 漢字熟語の独立した entry) では連鎖置換 / overlap 競合に依存していない
3. leftmost-longest + 1-pass は予測可能で、辞書設計時のメンタルモデルが単純 (= 「位置 i から最長の word を見つけたら reading に置換、次の位置 = i + match 長から再開」)
4. 業務レベル運用 (= 10 万件規模) で v1 semantics を維持すると、辞書同士の意図しない干渉が運用上のバグ温床になる

#### 移行時の互換性確認手順 (= Phase 1 で実施)

**3 段階の検証** で v1 → v2 移行を安全に行う:

##### 検証 1: 連鎖置換依存 entry の SQL 検出 (= ケース B)

```sql
-- reading 列に他 word が含まれる entry を SQL で検出。
-- LIKE は b.word に % や _ が含まれると wildcard 化するため、Postgres の
-- position() 関数を使って literal substring 検出に統一。
SELECT a.word AS a_word, a.reading, b.word AS b_word
FROM tts_dictionary a
JOIN tts_dictionary b ON position(b.word in a.reading) > 0
WHERE a.id != b.id AND a.enabled AND b.enabled;
```

##### 検証 2: overlap 競合候補ペアの検出 (= ケース C)

overlap 競合には **2 クラス** あり、両方を検出する。

**2a: substring overlap (= 短 word が長 word の途中に含まれる)** — SQL で検出:

```sql
-- 短い word が長い word の途中 (= 先頭以外) に substring として現れるペア
-- (例: "ab" が "xab" の途中、"bcd" が "abcd" の途中)
-- このペアは特定の text パターンで v1/v2 差分が出る候補。
SELECT
  short.word  AS short_word,
  short.reading AS short_reading,
  long.word   AS long_word,
  long.reading  AS long_reading,
  position(short.word in long.word) AS pos_in_long
FROM tts_dictionary short
JOIN tts_dictionary long
  ON position(short.word in long.word) > 1     -- 1 = 先頭、2 以降 = 途中
WHERE short.id != long.id
  AND length(short.word) < length(long.word)
  AND short.enabled AND long.enabled;
```

**2b: suffix/prefix overlap (= A の末尾 k 文字 == B の先頭 k 文字)** — 2a では検出できない別クラス:

- 例: `A=ab`, `B=bc` → text `"abc"` で A が `[0,2)`、B が `[1,3)` と範囲が重なる
- v1 (= 逐次置換) は辞書順で先に当たった方が勝つ (= 順序依存)、v2 (= leftmost-longest) は左端の A を採用して B を捨てる → **同じ divergence クラス**
- substring (= 2a) の SQL では「A は B の substring ではない」ため漏れる
- SQL の substring join では表現しにくいので、**比較スクリプト側で読み込み済み辞書から JS で O(N²) 算出** する (`A.suffix(k) === B.prefix(k)` なペアから merge text を合成)。大規模辞書では scan / 生成件数に上限を設け、超過は log で明示 (= silent cap 禁止)。実装は `scripts/tts-dict-v1v2-compare.ts` の「検証 2b」を参照

##### 検証 3: 比較スクリプトで実 fixture を投入

検証 1/2 の SQL ヒットを **完全に排除する必要はない**。実 fixture テキスト (= ご主人様の Yui の会話履歴サンプル 50 件 §6.2) で v1 と v2 の出力を比較して、**実際に差分が出る組み合わせだけ** をご主人様にレビュー依頼:

- 差分なし → 移行 OK
- 差分あり → ご主人様判断で:
  - 該当 entry を編集して両 semantics で同じ出力になるよう調整、または
  - 差分を v2 の正しい挙動として受容

#### 「v1/v2 完全同一」を主張しない理由

検証 1/2 をすべて pass しても、新規 text パターンで差分が出る可能性は残る (= 辞書が将来増えるたびに組み合わせ爆発)。よって本書は **「v1/v2 完全同一」を主張しない**。代わりに以下を担保する:

- **新 semantics の予測可能性**: 1-pass + leftmost-longest + case-insensitive (= 上記 3 つを正本とする)
- **実運用辞書での出力同一性**: 検証 1/2/3 を Phase 1 で実施し、現辞書 + 実 fixture で差分ゼロを目視確認
- **将来差分が出た場合の運用**: 比較スクリプトを定期実行 (= §6.2) し、辞書追加で差分が顕在化した時にご主人様判断する

---

## 4. 性能ベンチ

### 4.1 達成目標

| 件数 | text 500 字 | 達成判定 |
|---|---|---|
| 50 | ≤ 1 ms | (= v1 と同等以上) |
| 1,000 | ≤ 3 ms | |
| 10,000 | ≤ 10 ms | |
| **100,000** | **≤ 50 ms** | **= 業務レベル達成判定の hard line** |

### 4.2 ベンチコード

`scripts/tts-dict-bench.ts` (= §6.3 と同一スクリプト、standalone tsx) で実施:

- 件数別 (= 50/1k/10k/50k/100k) × text 長別 (= 100/500/2000/10000 字)
- warmup 3 round + measure 10 round、median を採用
- v1 (= legacy 素朴 loop helper) と v2 (= AC fast/slow path) を同じ入力で並べて比較
- 結果を markdown table で stdout 出力、`達成判定: §4.1 hard line OK / NG` を末尾に表示
- 定期回帰は Phase 1 では手動実行、test runner 導入後 (= Phase 3) に CI 自動化を検討

### 4.3 メモリ計測

- 各件数での trie 構築後のヒープ占有 (= `process.memoryUsage().heapUsed`)
- ライブラリ選定の判断材料に追加

---

## 5. API / 既存仕様への影響

| 項目 | 影響 |
|---|---|
| `applyDictionarySubstitution(text, dict)` の signature | **変更なし** |
| `loadDictionary()` の戻り値 | **変更なし** (= 既存 `Entry[]` 維持) |
| `invalidateDictionaryCache()` | **変更なし** (= `cache = null` するだけ。entries と matcher は同一 snapshot として同時破棄され、次回 `loadDictionary()` 時に lazy で再構築される) |
| `tts_dictionary` schema | **変更なし** |
| 「読み方」UI タブ | **変更なし** |
| `tts-normalize.ts` (= LLM 正規化呼び出し元) | **変更なし** |
| `tts-dictionary-preset.ts` (= seed source 50 件) | **変更なし** |
| `seedTtsDictionaryIfEmpty()` | **変更なし** |

= caller への影響ゼロ。純粋な内部最適化。

---

## 6. 検証戦略 (= test runner 未導入の現状に合わせる)

### 6.1 現状の制約

`package.json` の `scripts` には `lint` / `typecheck` / `build` / `db:migrate` のみで、test runner (= Vitest / Jest 等) は未導入。Phase 1 のスコープ内で test runner を導入するのは別作業 (= 工数 + 既存コードベース全体への影響 + CI 設定が広がる) なので、本書では **standalone tsx スクリプトベース** の検証に絞る。

test runner 本格導入は別 doc / 別 issue で扱う。

### 6.2 検証 1: v1/v2 比較スクリプト (= 回帰確認)

`scripts/tts-dict-v1v2-compare.ts` (新規) を tsx で実行。§3.6 の 3 段階検証 (= 連鎖置換 / overlap 競合 / case-insensitive 衝突) を **1 本のスクリプトに統合** して回帰確認する:

- **入力 (= 辞書)**: 現在の DB から取得した実辞書
- **入力 (= text 集合)**: 以下を結合
  - ご主人様の Yui の会話履歴から抽出した代表サンプル (= 50 件)
  - §3.6 検証 1 の SQL ヒット (= reading に他 word を含む entry) から自動生成した連鎖置換 fixture
  - §3.6 検証 2 の SQL ヒット (= 短 word が長 word の途中に現れる overlap 候補ペア) から自動生成した overlap 競合 fixture
  - §3.3.1 衝突検出 SQL のヒット (= case-insensitive で同一 word を持つ複数 entry) から自動生成した case-insensitive 衝突 fixture
- **処理**: v1 (= 素朴 loop + RegExp gi) と v2 (= AC + 自前 normalize layer) を同じ入力で並列実行
- **出力**: 差分があった text サンプル + 該当 entry を stdout に列挙、差分カテゴリ (= 連鎖 / overlap / case) ごとに集計
- **期待**: 差分は §3.6 で「v2 の正しい挙動として受容」と決めたカテゴリのみ。それ以外の差分が出たらご主人様レビュー

```bash
npx tsx scripts/tts-dict-v1v2-compare.ts
# → "Compared 89 samples against 1234-entry dict:
#     0 diffs (chain replacement category): all pre-cleaned by §3.6 検証1
#     2 diffs (overlap category): v2 leftmost-longest 採用、ご主人様判断要
#     0 diffs (case-insensitive category): all pre-cleaned by §3.3.1
#     0 diffs (real fixture)"
```

差分が出た場合の対応は §3.6 「差分あり → ご主人様判断で entry 編集 or 受容」に従う。

### 6.3 検証 2: ベンチスクリプト (= 性能達成確認)

`scripts/tts-dict-bench.ts` (新規) を tsx で実行:

- 入力: 件数別の合成辞書 (= 50/1k/10k/50k/100k 件、word は ASCII 8-12 文字ランダム)
- 入力: text 長別 (= 100/500/2000/10000 字、英語含む混在)
- 処理: warmup 3 round + measure 10 round、median を採用
- 出力: 件数 × text 長のマトリクスで v1 / v2 の所要 ms
- 達成判定: §4.1 の hard line (= 100k 件 / 500 字 で ≤ 50ms) を満たすか

```bash
npx tsx scripts/tts-dict-bench.ts
# → marddown table を stdout に出力
```

### 6.4 検証 3: エッジケース手動チェック

以下のケースを `scripts/tts-dict-v1v2-compare.ts` の fixture に含めて、出力を目視:

- leftmost-longest の解決 (= 「Apple」「Apple Music」両方登録、text に「Apple Music」)
- case-insensitive (= 「apple」「APPLE」両方マッチ)
- 同じ位置で複数 entry がマッチ (= 「AIDLE」と「AI」、leftmost-longest の正解選択)
- 空 dict / 空 text
- 大きな text (= 1 万字 + 100k 件)
- 日本語混在 (= 「外苑」「Apple Music」両方登録、text に両方含む)

### 6.5 (将来) test runner 導入後の継続的回帰

test runner (= Vitest 等) が後から導入されたら、§6.2-§6.4 のスクリプトを `*.spec.ts` 形式に書き直し CI に組み込む。本書のスコープ外。

---

## 7. 実装フェーズ

### Phase 1 (= 半日、AC 統合 + safety fallback 同時配置)

- `@monyone/aho-corasick` を `npm install`、lockfile commit、`npm audit` 確認
- `src/lib/tts-dictionary.ts` の内部実装に AC を統合
  - `buildSnapshot(entries)`: `{entries, matcher, readingByWordLower}` を同時生成 (§3.3.2)
  - `replaceWithSnapshot(text, snap)`: `matchInText` 結果から replace 構築 (§3.3.3)
  - `loadDictionary()`: entries + matcher を同一 snapshot で構築、60 秒 cache (§3.3.4)
  - `applyDictionarySubstitution(text, dict)`: fast path → slow path → safety fallback の **3 階層** (§3.5)
  - `invalidateDictionaryCache()`: 既存通り `cache = null` のみ (= lazy rebuild に任せる、§3.4)
- **legacy 素朴 loop は `legacyLoopReplace()` として切り出し、safety fallback 用に恒久維持** (= 削除しない、§3.5.1)
- **§3.6 の 3 段階 SQL チェック** で現辞書の差分リスクを洗い出す:
  - 検証 1 (= 連鎖置換、§3.6 検証 1): reading に他 word を含む entry を洗い出し、該当があれば編集 / 受容判断
  - 検証 2 (= overlap 競合、§3.6 検証 2): substring overlap (= 2a、短 word が長 word の途中) は SQL、suffix/prefix overlap (= 2b、A の末尾 k 文字 == B の先頭 k 文字) は比較スクリプトの JS で洗い出し、両クラスとも fixture に流す
  - 検証 3 (= case-insensitive 衝突、§3.3.1): `lower(word)` で重複する entry を洗い出し、片方を削除 / disable / word 変更でクリーンに
- `scripts/tts-dict-v1v2-compare.ts` (= §6.2) と `scripts/tts-dict-bench.ts` (= §6.3) を新規作成
- 動作確認: ご主人様の手元辞書 + 実 fixture で v1/v2 比較し、差分なし (= または §3.6 で受容済みカテゴリの差分のみと確認)、ベンチで §4.1 hard line 達成

### Phase 2 (= 将来、ベンチ regression 自動化と運用観測のみ)

Phase 1 で safety fallback を恒久維持するため、**「移行期 fallback の削除」のような clean-up は行わない**。Phase 2 のスコープは観測と運用のみ:

- 本番運用での AC 例外発生数を log で観測 (= `[tts-dictionary] AC pipeline failed` の発生有無)
- §4.2 のベンチを定期手動実行で性能 regression を監視
- 採用候補だった `@monyone/aho-corasick/fast` (= Double Array 版) と `/greedy` を実測比較、有意差があれば差し替え

### Phase 3 (= 将来、test runner 導入時)

- Vitest 等の test runner が導入されたら、§6.2-§6.4 のスクリプトを `*.spec.ts` に書き直し
- CI に組み込んで継続的回帰
- 本書のスコープ外、別 doc / 別 issue

---

## 8. ロールバック方針

- Phase 1: 単純 revert で v1 に戻る (= schema / API / data 変更なし)
- Phase 2: revert + Phase 1 の移行期 fallback を一時復活させれば即対応可能
- DB データ移行不要、ご主人様の辞書 entry はそのまま運用継続

---

## 9. スコープ外 (= 本書で扱わないことの明示)

将来「これも追加したい」と私が言い出した場合のための明示リスト:

- **汎用日本語形態素解析** — Irodori の責務、二重実装回避
- **漢字読み振り** (= ja-furigana 風 Smart engine) — Irodori の責務
- **文脈分岐** (= 「米」が「コメ/ベイ」で変わる) — Irodori の責務
- **Unicode 正規化** (= NFKC / 異体字統一) — Irodori の責務
- **観測性 / マッチ統計 / 未マッチ語自動収集** — Yui の TTS 補完用途では不要
- **多層パイプライン構成** (= Layer 1-4 案) — 不要、Yui は単一 layer
- **ja-furigana service 連携** — 不要、二重実装になる
- **多言語拡張** (= 中国語 / 韓国語の漢字読み) — スコープ外
- **辞書 UI の category 分類 / フィルタ強化** — 業務レベル機能としては妥当だが、本書のスコープ (= 性能改善) とは別軸、別 doc
- **自動学習** (= 未知英単語を LLM で動的補完) — 別 doc で議論

= 本書は **性能改善 only**。機能拡張は別 doc で扱う。

---

## 10. 関連ドキュメント

- [`docs/irodori-tts-setup.md`](irodori-tts-setup.md) — Irodori サーバ構築方法
- `src/lib/tts-dictionary.ts` — v1 / v2 実装
- `src/lib/tts-normalize.ts` — LLM 正規化、pre-substitute 呼び出し元
- `src/lib/tts-dictionary-preset.ts` — seed source (50 件)

---

## 11. コミット規約

- 新規依存追加 (= AC ライブラリ) は `CLAUDE.md` の dependency 規約に従う:
  - 理由を commit message に明記
  - lockfile commit
  - `npm audit` で critical なし確認
- Phase 1 / Phase 2 の commit message prefix: `Phase TR2.1` / `Phase TR2.2` (= 本書の v2 = TR2 ナンバリング)
- ベンチ追加は別 commit (= ベンチデータの diff が肥大化する場合)

---

## 12. 英→カタカナ一括辞書 (= TR3、AC が必要になった理由)

AC 化 (= §3) で 1 万〜10 万件規模に耐えられるようになったので、英単語の読みを **e2k で一括生成して 13 万件規模で DB 投入** する。これが「辞書 1 万件 +」の具体的な中身。

### 12.1 出所管理 (= `source` 列、migration 0067)

`tts_dictionary.source` で出所を区別 (= 巻き戻し性と手動キュレート保護):

| source | 意味 | 衝突時 |
|---|---|---|
| `user` | 手動 / Yui ツール登録 | **最優先** (= bulk import で上書き禁止) |
| `preset` | 初期 seed (`tts-dictionary-preset`) | user に劣後、cmudict に優先 |
| `cmudict` | e2k 一括生成 (13 万件規模) | 最劣後、一括 disable/再生成/削除の対象 |

優先度は **2 段で保証** する:
1. **import 時**: `onConflictDoNothing(target: word)` で既存 word を絶対に上書きしない
2. **AC snapshot 構築時**: `buildSnapshot` が同一 lowercase キーの衝突を `sourcePriority` で解決 (= case 違いで `Claude`(user) と `claude`(cmudict) が共存しても **user の読みが必ず勝つ**)

### 12.2 生成 → 取り込みフロー

```bash
# 1. 生成 (host、deps: pip install e2k cmudict) — C2K は文字ベースなので g2p 不要
python3 scripts/gen-katakana-dict.py            # → english_to_katakana_dict.csv

# 2. コンテナに渡して取り込み (= source='cmudict'、batched、冪等)
docker cp english_to_katakana_dict.csv yui-agent-web:/app/
docker exec -w /app yui-agent-web npx tsx scripts/tts-dict-import.ts --reset
```

- `scripts/gen-katakana-dict.py`: CMUDict 見出し語を e2k `C2K` でカタカナ化、最小フィルタ (= a-z'、dedup、空除外)
- `scripts/tts-dict-import.ts`: 1000 行/batch、`onConflictDoNothing`、`--reset` で cmudict 全削除→再投入

### 12.3 検索 API / UI の 13 万件対応

- `GET /api/tts-dictionary`: `q` / `limit` / `offset` / `source` でページング。ASCII クエリは `lower(word) LIKE 'q%'` (= `idx_tts_dictionary_lower_word` 使用)、かなは `reading ILIKE`。`count` 同梱
- `DictionarySection.tsx`: 全件 load を廃止し、debounce サーバ検索 + IntersectionObserver 無限スクロール。編集/削除はローカル state 更新 (= スクロール位置維持)、source バッジ表示

### 12.4 既知の残リスク (= 最小フィルタの帰結)

短語・機能語 (`in/on/it/go`…) を残すため、**辞書に無い固有名詞での暴発** (= `Spotify` → `spot+if+y` 的な部分切り) が起き得る。`source` 優先で手動キュレートは守られるが、実運用で暴発が顕在化したら **「ASCII パターンのみ単語境界マッチ」** を次の安全弁にする (= v2 semantics への追加、本書スコープ外の follow-up)。

### 12.5 実測 (= 2026-06-10、実 124,978 件 = cmudict 124,922 + user 56)

e2k で生成した CMUDict 124,926 語を投入し (= 既存 user word と exact 衝突した 4 件は skip)、コンテナ内 (= web プロセスと同コード) で実測:

| 項目 | 実測 | 備考 |
|---|---|---|
| cold load (= DB fetch + sort + 125k trie 構築) | **301 ms** | 60 秒 TTL に 1 回。§3.4 推定 ~500ms より速い |
| hot path 置換 200 字 | 0.039 ms | fast path (= cache snapshot 再利用) |
| **hot path 置換 500 字** | **0.095 ms** | **§4.1 hard line 50ms に対し約 500 倍の余裕** ✅ |
| hot path 置換 2000 字 | 0.064 ms | |
| hot path 置換 10000 字 | 0.287 ms | |
| 検索 API (= prefix, 125k) | 9〜18 ms | `idx_tts_dictionary_lower_word` 使用 |
| trie メモリ | heap +139MB / RSS 258MB | クリーンな probe プロセス実測 |

メモリの注: §4.3 / 合成ベンチの「100k ≈ 424MB」は GC 前ゴミ込みの上振れ値で、**実測の真値は 125k で heap +139MB**。web の dev コンテナ全体は 3.5GB 超だがこれは Next dev モードのベースライン + HMR がほぼ全部で、trie は ~140MB。本番 (`next start`) ではベースラインが桁違いに小さく、trie 140MB が主コストになる。

正しさ: `Claude と schedule と coffee` → `クロード と スケジュール と コーヒー` (= user の `Claude` が cmudict の `claude` に勝ち、cmudict の `schedule`/`coffee` も正読)。§12.1 の 2 段優先が実データで機能。

= 合成ベンチ (§4、100k/500字 0.02ms) と実データ (125k/500字 0.095ms) は同オーダー。実データが僅かに高いのは英単語が実際に match するためで、体感はゼロ。**AC 設計は実データで裏取り完了**。
