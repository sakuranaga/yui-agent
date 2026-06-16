# 長期記憶 v2 改善設計書

`docs/memory-architecture.md` (v1) で構築した長期記憶システムの**改善提案**をまとめる。

v1 は「抽出して圧縮してから embed」「ADD-only + 背景 reconcile」「多段抽出トリガー」「importance 段階別の減衰・忘却」まで作り込まれており、土台は筋が良い。本書はその上で**実測で効く残りの伸びしろ**だけに絞る。

> **重要な前提 (誤って作り直さないため)**: §1 で「既に出来ていること」を明記する。v2 の各項目は**既存の上に積む**ものであり、既存機構を置き換えない。

---

## 1. 現状の到達点 (= 既に出来ていること)

実装を読んで確認した、v1 で**既に動いている**機構。v2 はこれらを前提にする。

| 機構 | 実装 | 状態 |
|---|---|---|
| ハイブリッド検索 (semantic 0.7 + BM25 0.3) + 時間減衰 (τ=30d) + MMR (λ=0.5) | `src/lib/memory.ts:113` `retrieveRelevant` | ✅ |
| L2 常時 facts (importance≥0.5 上位) / L3 直近要約 | `memory.ts:226` `loadAlwaysOnFacts` / `:277` `loadRecentSummaries` | ✅ |
| **importance 段階別の自然減衰 (忘却)** | `src/periodic/memory-decay.ts` | ✅ (≥0.9 不変 / 0.7–0.9 ×0.99 / 0.5–0.7 ×0.97 / <0.5 ×0.95) |
| **直近参照は減衰から保護** | `memory-decay.ts:71-87` (retrieval_log の MAX(retrieved_at) ≥ 30d cutoff を候補から除外) | ✅ (passive な利用→保持) |
| **reinforce_count による減衰耐性** | `memory-decay.ts:106` (≥3 で減衰レート半減) | ✅ (ただし加算経路は限定的、§2.5) |
| auto-invalidate (importance < 0.05) | `memory-decay.ts:110` | ✅ |
| soft invalidation + 監査トレイル | `memory.ts:443` `invalidateChunk` | ✅ |
| retrieval_log (append-only 利用記録) | `memory.ts:396` `logRetrieval` / schema `retrieval_log` | ✅ |
| 物理 cleanup (古い log/chunk 削除) | `src/periodic/memory-cleanup.ts` | ✅ |
| decay_runs / stats 観測 | `decay_runs` テーブル / `/api/memory/stats` | ✅ |
| ADD-only + 背景 reconcile (`callLlm("reconcile")` による duplicate/supersedes 判定) | `src/lib/reconcile.ts` | ✅ |
| extract/reconcile を **role 経由でローカル LLM (Gemma) にルーティング可能** | `callLlm("extract"/"reconcile")`。実際にローカルに入るのは `local_llm_enabled` かつ roles 含む時のみ (`ai-settings.ts:199` / `llm.ts:241`) | ✅ (コスト最適化、設定依存) |

→ **「忘却・減衰・cleanup・観測」はむしろ成熟している**。v2 で触らない。

---

## 2. 改善項目

> **番号 (I1..I6) は識別子であり優先度ではない**。実際の着手順は §4 のフェーズ参照。
> 真の優先度: **I2 (評価ハーネス) が起点** → I4 (低リスク小改善) → I5 → I1 (固有名詞リコール、I2 で取りこぼし実在を確認してから) → I3 → I6 (任意)。

### I1. 日本語 lexical (BM25) チャネルが機能していない ← **効果は限定的だが実在 (固有名詞リコールの底上げ)。要測定 (I2) の上で判断**

> **トーンの訂正 (2026-06-14)**: 当初「最優先・効果最大」と書いたが**誇張だった**。lexical チャネル単体が日本語で死んでいるのは事実 (下記実測) だが、**検索の主役は semantic で、lexical は脇役 (0.3) かつ多くのクエリで冗長**。よって日常の想起はこれでも十分効く。本項の本当の価値は「壊れた検索を直す」ではなく「**semantic が苦手な固有名詞・短い具体語のリコールを底上げする**」に留まる。優先度の起点は I1 ではなく **I2 (評価ハーネス)**。

#### 現状の問題 (実測で確認)
`memory.ts:166-169` の lexical channel は `to_tsvector('simple', content)` + `plainto_tsquery('simple', ...)`。**PostgreSQL の `simple` 設定は空白・記号でしか分割しない**ため、日本語 (分かち書きしない言語) は語に割れない。実測 (psql):

```
to_tsvector('simple','ユーザーは魚アレルギーで犬のミロを飼っている')
   = 'ユーザーは…飼っている':1        ← 文まるごと 1 トークン
plainto_tsquery「アレルギー」 一致? = false
plainto_tsquery「ミロ」       一致? = false
全文完全一致のみ                     = true
'PROJ-123 の年次レビュー資料' = 'proj':1 '-123':2 'の年次レビュー資料':3  ← ASCII/空白は割れる
plainto_tsquery「PROJ-123」 一致? = true
```

結果:
- `LEXICAL_WEIGHT = 0.3` の重みは、**日本語自由文ではほぼ常に空振り** (部分語で引けない)。
- 実際に効くのは ASCII 固有名詞 (`Plane` / `PROJ-123` / 人名ローマ字) や空白区切りトークンのみ。

#### なぜ「死んでいる」のに体感のリコールは正確か (重要な補足)
1. **検索の主役は semantic**。スコアは `(sim×0.7 + bm25×0.3)×decay` なので、`bm25=0` でも chunk は `sim×0.7` で retrieval される。lexical の死は「0.3 のボーナスを取りこぼす」だけで、検索自体は欠けない。
2. **bge-m3 の日本語意味検索が得意**。言い換え・話題リコール (「コーヒーの話」「アレルギー」) は semantic の独壇場で、lexical の助けが要らない。
3. **そもそも L4 検索に頼らない層が多い**。L2 常時 facts (importance 上位、アレルギー・名前) は**毎ターン無条件注入**、L3 直近要約・L5 直近 8 ターン逐語も常時。「正確な応答」の多くは L4 検索ではなく L2/L3/L5 が支えている。
4. → 欠けが顕在化するのは **semantic が苦手なニッチ = 固有名詞・短い具体語**(「あの店なんだっけ」=特定店名、人の苗字) だけ。embedding は店名等の識別力が弱く、本来 lexical が救うべき所だが日本語では救えていない。**ここが I1 の主戦場**。

#### 改善設計 (3 案、低リスク順)
- **案C (推奨・第一手): アプリ側で分かち書き**
  - `embed`/挿入時とクエリ時に、JS の軽量トークナイザ (TinySegmenter / kuromoji) で content を分かち書きし、**空白区切りにしてから** `to_tsvector('simple', ...)` に渡す。
  - pg 拡張不要・インフラ変更なし。精度は中だが、現状(ほぼ無)からは大幅改善。
  - 既存 chunk は再 index 不要 (検索時に query 側だけ分かち書きしても部分改善。完全には挿入側も分かち書きして保存列を追加)。
- **案B: `pg_bigm` / `pg_trgm` (N-gram 全文検索)**
  - 日本語 bigram で部分一致。`pg_trgm` は導入容易だが日本語は bigram 推奨 → `pg_bigm`。
  - GIN index。`simple` tsvector を bigram 演算子に置換。
- **案A: PGroonga (mecab/N-gram、日本語全文検索の本命)**
  - 精度最高だが、`ankane/pgvector` イメージに PGroonga が無く、**Docker image の差し替え/ビルドが必要**(インフラ変更コスト大)。pgvector と同居できるイメージ選定が要る。

#### 判断
まず**案C で I2 (eval) を使って改善幅を実測** → 不足なら案B/A。あるいは **lexical を廃し embedding 一本化 + 固有名詞は別フィルタ (content ILIKE / 部分一致) で救済**する選択肢も eval で比較する。

#### リスク・トレードオフ
- 案C: トークナイザ依存追加 (kuromoji は辞書が重い → TinySegmenter は軽量だが精度劣る)。挿入側も分かち書きするなら**保存列追加 + 既存 chunk の再 index バッチ**が要る。
- 案A: インフラ変更が大きい。pgvector との同居検証必須。

---

### I2. オフライン評価ハーネスが無い ← **最優先 (= 全改善の起点。I1 が実際に効くかもこれで測る)**

#### 現状の問題
`TAU_DAYS=30` / `SEMANTIC_WEIGHT=0.7` / `LEXICAL_WEIGHT=0.3` / `MMR_LAMBDA=0.5` / rolling の `importance 0.6 cap` は**すべて勘で固定された定数** (`memory.ts:26-29`)。`scripts/` に記憶検索の評価は**無い**。

→ プロンプト改善・重み変更・I1/I4/I5 のどれも、**recall が上がったか下がったか測れない**。「体感」でしか評価できず、退行に気付けない。

#### 改善設計
- **評価データ**: `data/memory-eval.jsonl` — `{ query, expected_chunk_ids[] | expected_substrings[] }` を 30–50 件。自分の実会話 + `retrieval_log` を種に半自動生成 (過去に実際にヒットして役立った組を抜く)。
- **ハーネス**: `scripts/eval-memory.ts` — 各 query で `retrieveRelevant` を回し、**recall@5 / MRR / nDCG@5** を出す。
- **パラメータ sweep**: τ / weights / λ をグリッドで振って指標最大の組を出す (定数を eval 由来に置換)。
- **回帰**: プロンプトや検索を変えるたびに走らせ、指標が下がる変更を弾く。

#### 効果
I1 (日本語 lexical) の効果測定、I4 の type 別減衰、将来の embedding モデル変更まで、**全改善の前提インフラ**。これ単体では体感は変わらないが、これが無いと他が全部「祈り」になる。

#### リスク
- eval セットが小さい/偏ると過適合。→ 定期的に追補、固定し過ぎない。

---

### I3. 受動注入オンリーで「明示的想起」を取りこぼす

#### 現状の問題
記憶は毎ターン `retrieveRelevant` の top-K を**受動的に押し込む**だけ。ゆいが**能動的に過去を掘れない**(v1 決定ログで Memory tool は latency を理由に却下)。

雑談はこれで良いが、「**先月 X について何て言った?**」「○○の件、前に決めた結論は?」のような**明示的想起**は、受動 top-K=5 では文脈が薄く取りこぼす。

#### 改善設計
- **ハイブリッド**: 通常ターンは受動注入のまま (latency 据え置き)。**ユーザーが明示的に過去を尋ねた時だけ**使える `recall_memory(query, k?)` ツールを 1 本追加。
- 実装は薄いラッパ: ツール handler が `retrieveRelevant({ queryText, currentSessionId, limit: k })` を呼んで返すだけ (= 実シグネチャは `queryText` + `currentSessionId` 必須、`memory.ts:113`)。`surface: "read"`, `allowedModes: ["normal"]`。
- ツール description で「**ユーザーが明示的に過去の発言/決定を尋ねた時のみ**。通常の雑談では使わない (受動の記憶で足りる)」と強く縛る → 乱用による latency 増を防ぐ。

#### リスク・トレードオフ
- ツール乱用で latency。→ description の縛り + 必要なら judge で発火制御。
- v1 決定ログの「受動注入のみ」方針からの**意図的な部分緩和**。雑談 latency は犠牲にしない設計なので方針と矛盾しない。

---

### I4. retrieval スコアの時間減衰が timeless な fact にもかかる

#### 現状の問題
`memory.ts:189-191` の検索スコアは `decay = exp(-age/30d)` を**全 chunk_type に一律**適用する:
```ts
const decay = Math.exp(-ageDays / TAU_DAYS);
const base = (r.sim * SEMANTIC_WEIGHT + r.bm25 * LEXICAL_WEIGHT) * decay;
const score = base * (1 + r.importance);
```
背景の `memory-decay.ts` は importance≥0.9 を保護するが、**これは別機構**。検索時スコアは `fact`(魚アレルギー)・`preference`・`procedural` のような**時間で古びない記憶も、作成からの経過で順位を下げる**。L2 常時注入が importance 上位を別経路で拾うので致命的ではないが、**中 importance の重要 fact が L4 検索で沈む**。

#### 改善設計
検索時の `decay` を **chunk_type で分岐**:
- `fact` / `preference` / `procedural` → `decay = 1.0` (timeless、減衰させない)
- `event` / `emotion` / `summary` / `turn_summary` / `task_result` → 従来どおり `exp(-age/τ)`

(v1 §4.6 の「時間表記」方針が既に timeless/時系列を type で分けているので、**同じ分類を検索スコアにも適用するだけ**で一貫する。)

#### リスク
- 小変更・低リスク。I2 の eval で「fact の recall が上がり、event の鮮度が落ちていない」ことを確認。

---

### I5. フィードバック閉ループの「強化」側が未配線

#### 現状の問題 (= §1 で credit した上での残りギャップ)
- **忘却側 (decay)**: ✅ 完成。直近参照は減衰から保護される (passive な利用→保持)。
- **強化側 (reinforce)**: `reinforce_count` / importance を上げる `boostImportance` (`memory.ts:421`) は、**reconcile が `duplicate` (= 近重複) と判定して残す側 (winner) を boost する時だけ加算**される (`reconcile.ts:179`。`supersedes` 判定は OLD を invalidate するだけで boost しない)。つまり**「検索で頻繁にヒットして実際に役立った記憶」を能動的に強化する経路が無い**。
  → 100 回の会話で想起され続けても、reconcile で勝たない限り `reinforce_count` は 0 のまま。「直近参照保護」で消えはしないが、**重要度が上がっていかない** = ランキングで埋もれ続ける。

#### 改善設計
- retrieval で **MMR 後に最終採用 (top-K) された chunk** に、弱い強化を与える:
  - `boostImportance({ chunkId, delta: 小 })` を**レート制限付き**で (例: 1 chunk あたり 1 日 1 回まで、`metadata.reinforced_at` で抑制)。
  - これで `reinforce_count` も増え、`memory-decay.ts:106` の減衰耐性が**実際に効くようになる** (現状は加算経路が細いのでほぼ発火しない)。
- より正確には「**ゆいが応答で実際に使った**」シグナルが理想 (出力パース or tool) だが、MVP は top-K ヒットで弱く始め、I2 で過強化が起きないか観測。

#### リスク・トレードオフ
- 検索ノイズ (無関係 chunk が top-K に紛れる) を強化すると誤学習。→ delta を小さく + レート制限 + importance 上限 (既に LEAST(1.0,...))。eval で「強化が recall を上げるか」を測る。

---

### I6. 意味圧縮 (compaction) が無い ← 任意・将来

#### 現状
`invalidate` (soft) + `cleanup` (物理削除) はあるが、**古い event/summary クラスタを 1 つの要約 chunk にまとめて畳む圧縮**は無い。decay + auto-invalidate で当面は膨らみすぎないので**優先度は低い**。

#### 改善設計 (将来)
- 月次、同 `chunk_type` の古い低 importance クラスタ (semantic 近傍) を Haiku で 1 件の要約 chunk に統合し、元を invalidate。retrieval 候補プールの質と HNSW の健全性を維持。

---

## 3. 評価指標 (I2 と連動)

| 指標 | 意味 | 目標 |
|---|---|---|
| recall@5 | 期待 chunk が top-5 に入る率 | 全体の基準値 (semantic 主体で既に高い想定) |
| MRR | 期待 chunk の平均逆順位 | 上位に来ているか |
| nDCG@5 | 順位重み付き | importance/decay 調整の効果 |
| 固有名詞クエリ recall | 「○○さん」「あの店」系のサブセット | I1 の主戦場、別途集計 |

---

## 4. 実装フェーズ

| Phase | 内容 | 依存 |
|---|---|---|
| **V2-0** | **I2 評価ハーネス** + eval セット (30–50 件、固有名詞サブセット含む) | なし (最初にやる) |
| **V2-1** | **I4 type 別 retrieval 減衰** (低リスク小改善) | V2-0 |
| **V2-2** | **I5 retrieval→弱強化の配線** | V2-0 |
| **V2-3** | **I1 日本語 lexical (案C 分かち書き)** — V2-0 の固有名詞 recall で**取りこぼし実在を確認してから**着手 | V2-0 |
| **V2-4** | **I3 能動 recall ツール** | — |
| **V2-5** | (任意) I1 案B/A への格上げ / I6 compaction | V2-0/V2-1 |

各 Phase は独立コミット。**V2-0 (eval) を最初に**やることで、以降の効果を数値で示しながら進められる。実装は各 Phase で v1 と同様にテスト必須、Codex レビュー二段ゲートを通す。

---

## 5. 関連

- `docs/memory-architecture.md` — v1 設計 (本書の前提)
- `src/lib/memory.ts` — retrieveRelevant / scoring / MMR / loadAlwaysOnFacts / boostImportance
- `src/periodic/memory-decay.ts` — 忘却 (importance 段別減衰)
- `src/periodic/memory-cleanup.ts` — 物理 cleanup
- `src/lib/reconcile.ts` — ADD-only + 背景矛盾解決
- `src/lib/embed.ts` — bge-m3 (1024d, 1500 char cap)
- `src/db/schema.ts` — memory_chunks / retrieval_log / decay_runs / extraction_progress
