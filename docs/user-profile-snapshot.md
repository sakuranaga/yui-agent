# ご主人様プロファイル スナップショット 設計書

## 1. 背景と目的

memory_chunks に「ご主人様の事実」(お寿司好き、ヘビメタ好き、etc.) は溜まっているが、
**「ご主人様という人物像 (= データから推測されるキャラクタ要約)」** は明示的に保存
されていない。

retrieval は「今の質問に関連する個別 chunk」を引いてくるだけで、Yui には毎ターン
「上司はこういう人だ」という **総和の像** が渡らない。結果として:

- Yui の応答が **chunk のつぎはぎ感** 残る (= 個別事実は正確だが全体像が薄い)
- ご主人様自身が **「自分は今 AI からどう見えているか」を確認できない**
- 時系列で「3 ヶ月前と今のご主人様、像はどう変わったか」を可視化できない

ChatGPT で話題になった「あなたへの扱いを画像にして」実験は、まさにこの **synthesis
レイヤー** を AI に再構成させる行為。本機能はそれを **日々自動で蓄積** し、ご主人様
の self-mirror と Yui の応答品質向上の両方に使う。

## 1.1 日記との明確な役割分担 (重要)

| | 視点 | 内容 | 文体 |
|---|---|---|---|
| **日記** (`diary_entries`) | **結衣の主観・内面** | 「今日はご主人様とこんな話をして、わたしは嬉しかった」 | 結衣口調の散文 |
| **プロファイル** (`user_profile_snapshots`) | **ご主人様の客観・データ駆動アセスメント** | 「直近 2 週間の mood 平均 3.5、上昇傾向。論理的会話が多い。」 | ニュートラル、数値混じり |

**日記ロジックは一切いじらない**。プロファイルは完全に別レコード・別生成パイプ。
UI 配置は同じ DiaryModal を共有するが (= 時間軸が同じなので便利)、内容のレンズが
**正反対**であることを UI でも区別表示する。

| | 主体 | 形 |
|---|---|---|
| 日記 = Yui 視点 | 「わたしは…」「ご主人様の○○の表情が…」 | 1 人称、感情込み |
| プロファイル = データ視点 | 「ご主人様は…」「直近 N 件の発話傾向は…」 | 3 人称、根拠付き |

---

## 2. memory_chunks との関係 (重複しない)

| | memory_chunks | profile_snapshots (新規) |
|---|---|---|
| 粒度 | 1 chunk = 1 事実 | 1 snapshot = 1 段落の人物要約 (5-10 行) |
| 鮮度 | 永続、reconcile で更新 | **時系列で日々上書き** (時間で変化を追える) |
| 注入 | L4 で関連 chunk 5 件 retrieval | system prompt の memory section に **常時** 1 block |
| 素材 | raw_messages 直接 | **memory_chunks + diary + body_metrics を食う** (二次集計) |
| 用途 | 「お寿司好きでしたよね」 | 「ご主人様は分析肌で、感情より結果を優先される性格」 |

**profile は memory を素材として食う出力レイヤー** = 完全に重複なし。

---

## 3. データモデル

### 3.1 `user_profile_snapshots`

```sql
CREATE TABLE user_profile_snapshots (
  id                  BIGSERIAL PRIMARY KEY,
  snapshot_date       DATE NOT NULL UNIQUE,           -- JST 1 日 1 件
  personality         TEXT NOT NULL,                  -- 性格 (観測される行動パターン由来、5-10 行)
  communication_style TEXT NOT NULL,                  -- 話法統計 (口数、論理/感情比率、語彙傾向、依頼形 vs 雑談形)
  current_focus       TEXT NOT NULL,                  -- 直近の関心領域 (active project / 高頻度話題 / 完了済 todo 系統)
  mood_trend          TEXT NOT NULL,                  -- mood_1to5 推移 + 体調 + 行動量 (HealthKit) を組み合わせた傾向
  inferred_traits     TEXT NOT NULL,                  -- 推測される特性 (= 行動から推論、根拠と一緒に書く)
  evidence_notes      TEXT,                           -- 各フィールドの根拠サマリ (= どの素材から導いたか)
  inferred_image_prompt TEXT,                         -- 将来の image gen 用プロンプト (NULL 可)
  source_meta         JSONB,                          -- 生成素材の meta (raw_messages 件数等)
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by        TEXT NOT NULL DEFAULT 'cron'    -- "cron" | "manual" | "regen"
);
CREATE INDEX idx_user_profile_snapshots_date ON user_profile_snapshots (snapshot_date DESC);
```

- `snapshot_date` UNIQUE → 1 日 1 件 (既に書かれた日に再 cron 走っても upsert)
- 全フィールド TEXT で柔らかく持つ。schema 厳密化はやらない
- **Yui の主観フィールドは持たない** (= それは日記の役割)。プロファイルは観測 +
  推論 + 根拠のセットだけ
- `evidence_notes` は「なぜそう書いたか」の透明性のため (= ご主人様が「これ違うよ」
  と訂正できる素地)
- `inferred_image_prompt` は将来の「あなたへの扱いを画像にする」機能用 (Phase 6)

### 3.2 生成 logic

`src/lib/user-profile.ts`:

```ts
export async function generateProfileSnapshot(date: Date): Promise<Snapshot> {
  // 素材集め (直近 14 日)
  const materials = await collectProfileMaterials(date, 14);
  // - raw_messages から user 発話のサンプル (要約 or 直近 N 件)
  // - memory_chunks (owner=ご主人様、importance トップ N)
  // - diary_entries (直近 7 件)
  // - body_metrics (mood_1to5、weight_kg、HealthKit 系の推移)
  // - 完了済 todos / 進行中 todos / projects のサマリ

  // Sonnet で profile を 1 ターン生成
  const reply = await callLlm("profile_synth", {
    system: PROFILE_SYNTH_PROMPT,
    messages: [{ role: "user", content: formatMaterials(materials) }],
    maxTokens: 1200,
  });

  // JSON で 5 フィールド (personality / communication_style / current_focus /
  //  mood_trend / yui_perception) + image_prompt が返る想定
  const parsed = parseJsonLoose(reply.content);
  return upsertSnapshot(date, parsed, materials.meta);
}
```

**重要**: `yui_perception` は **Yui の人格 (おっとり秘書、結衣) からの主観で書く**。
中立的な人物分析ではなく、「結衣がご主人様をどう見ているか」の主観記述。これが
self-mirror 体験を生む。

### 3.3 PROFILE_SYNTH_PROMPT (概要)

**ニュートラルなアセスメント言語で書く** (= 結衣口調・感情・愛着を入れない)。
これは日記とは別物で、データ駆動の客観プロファイルとして雇用主への業務レポート
の温度で書く。

```
あなたはユーザー (= ご主人様) に関する直近 2 週間のデータを与えられます。
データから観測される事実と、そこから導かれる推測を分けて、5 観点で簡潔に
まとめてください。

【スタイル制約】
- 3 人称で書く ("ご主人様は…")。結衣口調 ("ふふっ" "ですもの" 等) は使わない
- 感情・愛着・主観の総括は一切入れない (それは別レコードである日記の役割)
- 推測には根拠を一行で添える ("発話の N % が依頼形 → 仕事中心の生活" のように)
- 数値があるものは数値で書く (mood 平均、歩数、active kcal、todo 完了数等)
- 不明な観点は「データ不足」と書く (= でっち上げない)

【5 フィールド】
- personality: 観測される行動パターンから推論される性格特性 (5-10 行)
- communication_style: 話法統計 (口数、論理/感情比率、語彙傾向、依頼形比率)
- current_focus: 直近の関心領域 (active project、高頻度話題、完了 todo の系統)
- mood_trend: mood_1to5 推移 + 体調 + 行動量 (HealthKit) を組み合わせた傾向
- inferred_traits: 上記から推論される追加特性 (= 根拠と一緒に書く)

【evidence_notes】
各フィールドの根拠サマリを 1-2 行で添える。

【inferred_image_prompt】
ご主人様の今の状態 / 性質を visual に表すならどんな絵か、英語の image generation
prompt として 1-2 文。

JSON 1 行で返してください。
```

---

## 4. cron 統合 (diary-write の隣に座る)

`src/periodic/profile-snapshot.ts` を新規追加 — `diary-write` と同じ schedule で
動かす:

```ts
const profileSnapshot: PeriodicModule = {
  id: "profile-snapshot",
  enabled: true,
  schedule: { kind: "interval", everyMs: 60 * 60_000 },  // 1 時間
  run: async (ctx) => {
    // 今日の snapshot がまだ無くて、22 時以降なら生成
    const todayYmd = jstYmdOf(new Date());
    const exists = await db.select().from(userProfileSnapshots)
      .where(eq(userProfileSnapshots.snapshotDate, todayYmd)).limit(1);
    if (exists.length > 0) return { skip: true, reason: "already exists" };
    const hour = jstHour(new Date());
    if (hour < 22) return { skip: true, reason: `before 22:00 (${hour}h)` };

    try {
      await generateProfileSnapshot(new Date());
      return { skip: true, reason: "snapshot generated" };  // fire しない (Yui 発話は無し)
    } catch (e) {
      return { skip: true, reason: `error: ${e}` };
    }
  },
};
```

- `diary-write` と同じ 1 時間 interval + 22 時以降条件
- 1 日 1 回生成、再 cron 走っても exists で skip (idempotent)
- 失敗時は次の 1 時間でリトライ
- `fire` 無し (Yui voice 通知は出さない、内部処理だけ)

---

## 5. Yui prompt への注入

`src/lib/memory.ts` (or 該当 retrieval ルート) で system prompt の memory section
を build する時、**最新 snapshot を 1 block 追加**:

```
## ご主人様の現在像 (直近 2 週間のデータ駆動アセスメント)

### 性格
(personality)

### 話法傾向
(communication_style)

### 直近の関心
(current_focus)

### 気分・体調の流れ
(mood_trend)

### 推測される追加特性
(inferred_traits)
```

- `loadActiveProfile()` で最新 snapshot を取得 (なければ section ごと省略)
- prompt cache breakpoint より後 (= 日次で変わるので)
- chunk retrieval (L4) と並行配置、両方 Yui に渡る
- Yui はこれを **「現状把握資料」として読む**。結衣の口調や感情は別途 persona から
  来ているので、この block で結衣の人格が定義される訳ではない

---

## 6. UI: DiaryModal に「プロファイル」tab を追加

### 6.1 配置方針

**既存の日記本文 (Zen Kurenaido + 散文 + TTS 再生) は完全に温存**。下に
追加すると「ゆいの内面」と「客観プロファイル」が縦に並んでレンズが混乱するため、
**tab で切り替える形** にする:

```
┌─ DiaryModal (2026-06-03) ───────────────────────────┐
│ < ▶ │ 2026/06/03 (火)              [▶ 読み上げ]    │
├─────────────────────────────────────────────────────┤
│ [日記 (ゆいの内面)]  [プロファイル (データ要約)]    │  ← tab 切替
├─────────────────────────────────────────────────────┤
│                                                     │
│ === [日記] タブ: 既存をそのまま ===                  │
│   Zen Kurenaido フォント                            │
│   今日はご主人様とジムの話で盛り上がりました…       │
│   ▶ 読み上げボタン                                   │
│                                                     │
│ === [プロファイル] タブ (新規) ===                   │
│   ニュートラル sans-serif、数値混じり                │
│                                                     │
│   ## 性格                                            │
│   - 直近 2 週間の発話 240 件のうち …                 │
│   - 完了済 todo 18 件のうち 13 件が技術系 …          │
│                                                     │
│   ## 話法傾向                                        │
│   - 依頼形 62 %、相談形 24 %、雑談 14 %              │
│   - 平均発話長 18 文字                               │
│                                                     │
│   ## 直近の関心                                      │
│   - リマインダー / habits 基盤 (12 言及)             │
│   - ヘルス機能 (8 言及)                              │
│                                                     │
│   ## 気分・体調の流れ                                │
│   - mood 平均 3.6 (前週比 +0.4)、歩数平均 9,200 歩   │
│                                                     │
│   ## 推測される追加特性                              │
│   - 効率重視、設計重視 (根拠: 「先に設計書」発言×3)  │
│                                                     │
│   ▼ 根拠 notes (展開可)                              │
│                                                     │
│   [前日と比較]   [画像で見る (将来)]                  │
└─────────────────────────────────────────────────────┘
```

- 日付 nav は両 tab で共有 (◀ ▶ で前後の日に動くと両方同期)
- tab 切替は localStorage に最後の選択を記憶
- 視覚的に **フォント / 文体を区別** (日記 = Zen Kurenaido 散文、プロファイル = sans 構造)
- 「前日と比較」は profile tab のみ (= データ駆動なので diff が意味を持つ)

### 6.2 API

新規 endpoint:

```
GET  /api/profile-snapshots/{date}   1 日分取得 (date は YYYY-MM-DD)
GET  /api/profile-snapshots/recent?limit=14   直近 N 件
POST /api/profile-snapshots/regenerate?date=YYYY-MM-DD   手動再生成 (admin 系)
```

- DiaryModal の日付 nav 変更時に `/api/profile-snapshots/{date}` を fetch
- 「前日と比較」は 2 つの date を別 fetch

### 6.3 「画像で見る」(Phase 4)

`inferred_image_prompt` を image gen API (ChatGPT DALL-E / Flux / Stable Diffusion)
に渡してその日のご主人様の「扱いを表す絵」を生成。

- 月 N 枚までの cost 制限 (1 枚 $0.04 で 月 30 枚 = $1.2)
- 結果を `user_profile_images` に S3 / local 保存
- DiaryModal の section に thumbnail 表示

---

## 7. 設定 (任意 Phase 3)

設定 > データ tab に「ご主人様プロファイル」section:

- **生成を一時停止** (チェックボックス) — privacy 配慮の opt-out
- **過去の snapshot を全削除** — リセット
- **再生成** (今日分) — 強制リトライ
- **エクスポート** (JSON / markdown) — 別の AI に渡したい人用

---

## 8. プライバシー / 倫理設計

- snapshot 生成は **完全ローカル** (Anthropic API 経由はあるが、生成結果は外に漏れない)
- ご主人様自身が見れない情報は無い (= 全て transparent、隠し profile 無し)
- **客観アセスメントだが「推測」であることを UI 注釈で明示**
  (例: 「これは AI による行動データの解釈です。実際のお気持ちと違う場合があります」)
- `evidence_notes` フィールドで **「なぜそう書いたか」を必ず開示**
- 削除 / opt-out が常時可能
- raw_messages を素材にするが、profile 自体には raw text を引用しない (= 「先日
  X 様とのメールで」のような実名漏洩は避ける)
- Discord forward 対象外 (= Discord text にこっそり「今日のご主人様像」が流れる
  ことは無い)
- 「これは違う」訂正経路: profile 画面で「訂正する」ボタン → ユーザのコメントを
  `user_profile_corrections` に記録 → 次回 cron 時に素材として与えて反映 (Phase 5)

---

## 9. 既存資産との関係

| 機能 | 関係 |
|---|---|
| **memory_chunks** | 素材として読む。profile は memory の二次集計層 |
| **diary_entries** | **ロジック完全別**。Yui 主観の散文 (日記) と、客観データ要約 (profile) は別レコード・別生成パイプ。UI は DiaryModal の tab 切替で同居するだけ |
| **affinity (未実装)** | mood_trend と部分重複あり。affinity 実装時に「親密度推移」が profile にも反映される |
| **body_metrics** | mood_1to5 推移を mood_trend の素材として読む |
| **HealthKit (歩数 / 活動 kcal / 睡眠)** | mood_trend / current_focus の素材として読む |
| **todos / projects** | current_focus の素材 |
| **notification system** | Yui voice 通知は出さない (内部処理のみ) |

---

## 10. 着手の優先度

中。**memory_chunks だけで Yui は普通に喋れている** 現状、profile が無いことで困っ
ている訳ではない。価値は以下:

1. **Yui の応答品質向上** (= 個別 chunk のつぎはぎから、像を踏まえた一貫した応答へ)
2. **self-mirror UX** (= ご主人様が自分の像を確認できる、面白い)
3. **時系列の変化** (= 半年で人格が成長したのを Yui 側からも見える)

着手タイミング: memory v2 が安定運用に乗ってから、または「自分が AI からどう
見られてるか確認したい」と思った瞬間。リマインダー基盤 (#186) や Health Phase 4
よりは優先度低い。

---

## 11. 実装フェーズ

### Phase 1 — 設計書 ✓ (= 本ドキュメント)

### Phase 2 — schema + 生成 + cron
- `0049_user_profile_snapshots.sql` migration
- `lib/user-profile.ts` の生成 logic (素材収集 → Sonnet → upsert)
- `periodic/profile-snapshot.ts` で 22 時以降 daily cron
- 初回手動キック用 endpoint `POST /api/profile-snapshots/regenerate`

### Phase 3 — Yui prompt 注入
- memory section に「今日のご主人様像」block 追加
- `loadActiveProfile()` で最新 snapshot を取得
- chunk retrieval と並行配置

### Phase 4 — DiaryModal UI
- **既存日記タブはそのまま温存**、新規「プロファイル」tab を追加
- `GET /api/profile-snapshots/{date}` で日付同期
- 「前日と比較」2-column 表示 (profile tab のみ)
- フォント / 文体を視覚的に区別 (日記 = Zen Kurenaido 散文、profile = sans 構造)

### Phase 5 — 設定 / opt-out + 訂正経路
- 設定 > データ tab に管理 UI (削除 / 一時停止 / エクスポート)
- profile 画面に「これは違う」訂正ボタン → `user_profile_corrections` 記録
- 次回 cron 時に訂正を素材として与えて反映

### Phase 6 (任意・遠い) — 画像化
- `inferred_image_prompt` を image gen API へ
- `user_profile_images` に保存
- DiaryModal に thumbnail 表示
- cost: 月 30 枚で $1.2 程度

---

## 12. 関連設計書

- `docs/memory-architecture.md` — 素材源
- `docs/affinity-system.md` — mood_trend と部分重複、将来統合余地
- `docs/health-tracking.md` — body_metrics (mood_1to5) の素材源
- `docs/notification-system.md` — profile 生成は通知出さない (内部処理) を確認
