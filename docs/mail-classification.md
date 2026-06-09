# メール仕分け学習システム 設計書

## 1. 背景と目的

`docs/mail-system.md` §5 で実装されているメールキュレーションは:

- header (from + subject + snippet) のみを Gemma に渡す single-shot 判定
- 連続値 `score (0..1)` + reason のみで自動アクションは無し
- 「営業フォーム自動受付」と「先方からの実質返信」が subject だけでは判別不能

実際のデータで確認:

| from | subject | 本来 | 現在の score |
|---|---|---|---|
| ホテルこうしゅうえん | 依田 沙希 様　お問い合わせありがとうございました。 | **不要** (フォーム自動受付) | 0.7 (過大評価) |
| 庭のホテル 東京 | お問い合わせ受け付けのお知らせ | **不要** | 0.7 |
| (将来) ホテル先方からの実返信 | Re: お問い合わせ | **重要** | (判別困難) |

本文を読めば: 自動受付は `・予約の種類:` `・ご宿泊日:` 等の **フォームフィールドが echo されている** という決定的な構造特徴がある。これは header だけでは絶対に見えない。

そこで本システムは以下を実現する:

1. **本文込みの読解** で header だけでは判別できない構造的特徴を捉える
2. **3 bucket 離散判定** (重要 / 要 / 不要) を score の代わりに付与
3. **user の手動ラベル付け (学習例) を RAG で活用** することで個別ユーザの判断基準を反映
4. **学習裏付け + 高確度の二重ゲート** がそろった時のみ自動アクション (ゴミ箱 / TODO起票)

ローカル LLM (Gemma) のみで完結する。プライバシー方針 (メール本文を外部に送らない) を維持。

---

## 2. 用語

| 用語 | 意味 |
|---|---|
| **bucket** | 3 値判定: `important` / `needed` / `unneeded` (UI 表示: 重要 / 要 / 不要) |
| **学習例** | user が手動でラベル付けしたメール 1 件分の (embedding + bucket + 自然言語ヒント) |
| **RAG** | 新着メールの embedding で学習 DB を vector 検索し、top-K の類似例を few-shot として Gemma プロンプトに注入する仕組み |
| **学習ヒット** | top-1 の cosine 類似度が閾値 (0.60) 以上 ⇔ user が判断基準を提供済みの領域に新着メールが入る |
| **自動アクション** | bucket = 不要 → ゴミ箱、bucket = 重要 → TODO/予定 draft 起票。学習ヒット必須 |

---

## 3. アーキテクチャ

### 3.1 現行 (mail-curate.ts §5)

```
poll → mail_messages 行 (header + snippet)
        ↓ batch (20件)
   Gemma single-shot: subject + snippet → score + reason
        ↓
   mail_messages.score / score_reason / curated_at に書き込み
```

### 3.2 改修後

```
poll → mail_messages 行 (header + snippet)
        ↓
   block / VIP filter (即決)
        ↓
   本文 head 取得 (body_text[:1500])
        ↓
   embed(subject + body_head) (bge-m3, 1024-dim)
        ↓
   mail_training_examples で top-K=5 cosine 検索
        ↓
   Gemma few-shot:
     [past example 1: bucket=unneeded, hint="フォーム自動受付"]
     [past example 2: bucket=important, hint="ホテル先方からの実質返信"]
     ...
     [new mail]
        ↓
   JSON: { bucket, confidence (0..1), reason }
        ↓
   mail_messages.bucket / bucket_confidence / bucket_reason
                / classified_at に書き込み
        ↓
   学習ヒット (top-1 sim ≥ 0.60) + confidence ≥ 0.85 の場合のみ:
     unneeded → trashed_at = now (ゴミ箱)
     important → /api/intent 経由で TODO/予定 draft 起票
   それ以外: 受信箱に残す (バッジのみ)
```

### 3.3 batch から per-mail への変更

現行は 20 件まとめて Gemma に投げているが、改修後は RAG が per-mail で異なるため per-mail 処理に変える。

- ローカル LLM レイテンシ: 1 通 2-5 秒
- 100 通/日 × 平均 3 秒 = 5 分以内、十分捌ける
- 並列化は当面しない (Gemma server 側の並列許容次第で後で導入)

---

## 4. データモデル

### 4.1 新規テーブル: `mail_training_examples`

```sql
CREATE TABLE mail_training_examples (
  id              BIGSERIAL PRIMARY KEY,
  source_mail_id  BIGINT REFERENCES mail_messages(id) ON DELETE SET NULL,
                                       -- 元メール (任意。手動例も想定して nullable)
  embedding       VECTOR(1024) NOT NULL, -- bge-m3
  embedded_text   TEXT NOT NULL,         -- 何を embed したか (subject + body_head)
  bucket          TEXT NOT NULL
                  CHECK (bucket IN ('important', 'needed', 'unneeded')),
  hint_text       TEXT NOT NULL,         -- user の自然言語の判定理由
  -- 自動アクション consent (Phase 2 で追加、Phase 3 ゲート条件に使う)
  auto_todo       BOOLEAN NOT NULL DEFAULT false,  -- このタイプは TODO 自動登録 OK
  auto_event      BOOLEAN NOT NULL DEFAULT false,  -- このタイプは予定 (カレンダー) 自動登録 OK
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON mail_training_examples
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON mail_training_examples (source_mail_id);
```

### 4.2 既存 `mail_messages` への列追加

```sql
ALTER TABLE mail_messages
  ADD COLUMN bucket TEXT
    CHECK (bucket IN ('important', 'needed', 'unneeded')),
  ADD COLUMN bucket_confidence REAL,
  ADD COLUMN bucket_reason TEXT,
  ADD COLUMN classified_at TIMESTAMPTZ;

CREATE INDEX ON mail_messages (bucket) WHERE bucket IS NOT NULL;
CREATE INDEX ON mail_messages (classified_at);
```

既存の `score / score_reason / curated_at` は **残す** (移行期間中の fallback / 比較用)。Phase 1-2 並行運用、Phase 3 で評価安定後に別 commit で drop migration。

---

## 5. 推論アルゴリズム

### 5.1 入力構築

```typescript
const from = mail.fromName ? `${mail.fromName} <${mail.fromEmail}>` : mail.fromEmail;
const to = (mail.toAddresses ?? []).join(", ") || "(unknown)";
const embeddedText = [
  `from: ${from}`,
  `to: ${to}`,
  `account: ${mail.accountEmail}`,   // 受信した自分のアカウント
  `subject: ${mail.subject ?? ""}`,
  "",
  (mail.bodyText ?? "").slice(0, 1500),
].join("\n").trim();
const embedding = await embed(embeddedText); // bge-m3
```

理由:
- フォーム自動受付の決定的特徴 (`・予約の種類:` 等の構造化フィールド) は本文先頭に現れる
- **To: と受信アカウントは短いが判別に決定的**: 例「経理アドレス宛の AWS 請求 → 自分のアクション不要」「個人アドレス宛の同種メール → 確認が要る」のように、本文だけでは見えない文脈情報を補う
- mail-curate.ts 推論時 と /api/mail-training POST (例の保存時) で **同じフォーマット** を使うことで embedding 空間を揃える

### 5.2 RAG 検索

```sql
SELECT id, bucket, hint_text, embedded_text,
       1 - (embedding <=> $1::vector) AS sim
FROM mail_training_examples
ORDER BY embedding <=> $1::vector
LIMIT 5;
```

`<=>` は cosine distance。`1 - distance` = cosine similarity (0..1)。

### 5.3 学習ヒット判定

```typescript
const HIT_THRESHOLD = 0.60; // 後日チューン
const isHit = topK.length > 0 && topK[0].sim >= HIT_THRESHOLD;
```

### 5.4 プロンプト構築

```
system: あなたはメール仕分け係です。重要 / 要 / 不要 のどれかに分類してください。
        過去にご主人様が判定した例を参考に判定してください。

user:
[過去例]
1. (類似度 0.82) bucket=unneeded
   理由: "営業フォームの自動受付。本文に予約の種類: 等のフィールドが並ぶ"
   メール: subject="...", body="..."
2. (類似度 0.71) bucket=important
   理由: "..."
   メール: ...

[今回のメール]
subject: ...
body: (head 1500 chars)

出力 JSON 一行のみ:
{"bucket": "important|needed|unneeded", "confidence": 0..1, "reason": "..."}
```

学習例ゼロ (cold start) の場合は `[過去例]` セクションを省略し、bucket の判定基準を system prompt にハードコードした single-shot 判定に fallback。

### 5.5 出力ハンドリング

```typescript
const { bucket, confidence, reason } = parseJson(gemmaResponse);
await db.update(mailMessages)
  .set({ bucket, bucketConfidence: confidence, bucketReason: reason,
         classifiedAt: new Date() })
  .where(eq(mailMessages.id, mail.id));
```

### 5.6 自動アクションのゲート

学習例には `auto_todo` / `auto_event` の **明示的 consent フラグ** が立っている。bucket 判定だけでは「このタイプの重要メールに対して TODO を自動起票していいか」を区別できないため、top-1 ヒット例のフラグを参照する。

```typescript
const top = topK[0]; // 学習ヒットの基準は top-1 cosine sim >= 0.60
const canAutoAct = isHit && confidence >= 0.85;

if (canAutoAct && bucket === "unneeded") {
  // 不要は consent 不要 (ゴミ箱送りはそのカテゴリ判定で十分。誤判定時も復旧手段なし設計だが、
  // soft trash でゴミ箱を空にする時に物理削除なので猶予はある)
  await db.update(mailMessages)
    .set({ trashedAt: new Date() })
    .where(eq(mailMessages.id, mail.id));
}

if (canAutoAct && bucket === "important") {
  if (top.autoTodo) {
    await dispatchIntent({ target: "todo", sourceType: "mail", sourceId: mail.id });
  }
  if (top.autoEvent) {
    await dispatchIntent({ target: "event", sourceType: "mail", sourceId: mail.id });
  }
  // 重要だが auto_todo/event とも false: 受信箱トップ + briefing 通知だけで止める
}

// それ以外 (低確度 or 学習ヒット無し): mail_messages の bucket だけ書き込み、受信箱に残す
```

自動アクション設計の要点:
- `bucket=重要` だけでは「TODO に入れたい」とは限らない (例: 「先方からの実質返信」は重要だが返信を書くべきであり TODO 起票はしたくない)
- 学習例に **「このタイプは TODO に入れて」「カレンダーに入れて」** を user が明示する。hint テキストへの依存を避け、誤動作リスクを構造的に排除

---

## 6. 学習ループ

### 6.1 学習例の追加

user が Mail modal の右クリック / kebab から「学習」を選ぶと、モーダルが開く:

- 3 ボタン: 重要 / 要 / 不要
- **自動アクション (重要 を選んだ時のみ表示) — Phase 2 で追加:**
  - チェック: TODO に自動登録する
  - チェック: 予定 (カレンダー) に自動登録する
  - どちらも default 未チェック (= 起票せず受信箱に残すだけの「目立たせ」止め)
- textarea: 自然言語のヒント (例: "営業フォームの自動受付。本文に予約フィールドが echo されているのが特徴")
- 保存ボタン

保存時:
1. mail の (from/to/account/subject + body_head) を embed
2. `mail_training_examples` に bucket / hint / auto_todo / auto_event 付きで INSERT
3. 元 mail の `bucket / bucket_confidence (= 1.0) / bucket_reason (= hint_text)` も上書き

### 6.2 訂正フロー (これは違う)

自動分類されたメールの bucket バッジ横に「これは違う」ボタンを置く。クリックで 6.1 と同じモーダルが現れ、現バケットが pre-fill された訂正フォームになる。

**1 メール = 1 学習例** (Phase 4 で方針確定)。POST /api/mail-training は `source_mail_id` で既存例を探し、あれば UPDATE、なければ INSERT する upsert 動作。同じメールで保存ボタンを連打しても重複が増えない、訂正は最新意図で上書き、RAG の偏りも回避できる。embedding は新規 INSERT 時のみ計算 (UPDATE 経路は再計算しない)。

### 6.3 学習 DB のメンテナンス

- v1 では古いデータの自動削除 / 重み付けはしない
- 数百〜数千件規模まで HNSW で問題なく回る
- 将来的に「同じ source_mail_id の旧例を archive する」「embedding を再生成する」等が必要になったら別 phase

---

## 7. API

### 7.1 学習例 CRUD

```
POST   /api/mail-training            学習例の追加
       body: { mailId, bucket, hintText, autoTodo?: boolean, autoEvent?: boolean }
       → embedding 生成して INSERT、mail_messages にも反映
       autoTodo / autoEvent は default false。Phase 2 から有効、Phase 3 で読まれる

GET    /api/mail-training            一覧 (デバッグ / 管理用)
       query: ?limit=50&offset=0

DELETE /api/mail-training/:id        学習例の削除
```

### 7.2 学習例の編集 (Phase 4)

```
PATCH  /api/mail-training/:id      bucket / hint_text / auto_todo / auto_event を更新
       body: { bucket?, hintText?, autoTodo?, autoEvent? }
       注: embedding は再計算しない。embedded_text は不変。
           「何を embed したか」と「最新のラベル / consent」は分離管理。
```

embedding 再計算が必要なケース (= 元メールの本文が大きく変わった等) は v1 では考慮しない。例の hint や bucket だけを訂正したい用途を想定。

### 7.3 既存 intent endpoint との連携

`/api/intent` は既に Mail → TODO / 予定の dispatch を実装済 (Gemma で transform)。

改修後の curate pipeline は「bucket = 重要 + 学習ヒット + conf ≥ 0.85」を満たした時だけ、サーバ側から `/api/intent` を呼んで draft 起票する。intent endpoint 側は呼出元が「user の手動 kebab クリック」か「自動 curate」かを区別しない。

---

## 8. UI

### 8.1 学習モーダル

Mail modal の kebab メニューに「学習」項目を追加。

```
┌─────────────────────────────────┐
│ このメールを学習する          ✕ │
├─────────────────────────────────┤
│ from: ... <...>                  │
│ subject: ...                     │
│                                  │
│ 分類:                            │
│   [ 重要 ] [ 要 ] [ 不要 ]       │
│                                  │
│ 自動アクション (Phase 2 〜):     │
│ ※ 重要 を選んだ時のみ表示        │
│   ☐ TODO に自動登録する          │
│   ☐ 予定 (カレンダー) に自動登録 │
│                                  │
│ 判定の理由 (自由記述):           │
│ ┌─────────────────────────────┐ │
│ │                             │ │
│ └─────────────────────────────┘ │
│                                  │
│       [ キャンセル ] [ 保存 ]    │
└─────────────────────────────────┘
```

### 8.2 受信箱バッジ

mail list の各行の subject 横に bucket バッジを置く:

- 🟦 重要 (青系)
- 🟨 要 (黄系)
- 🟥 不要 (赤系、低確度なら淡色)
- 未分類 (バッジ無し)

`bucket_confidence < 0.65` または `bucket IS NULL` は淡色 + ハッチで「未確定」を示す。

並び順を `bucket → received_at` に変更:
1. important (新→旧)
2. needed (新→旧)
3. unclassified (新→旧)
4. unneeded — 自動ゴミ箱に行かなかった残り (新→旧)

### 8.3 「これは違う」訂正

bucket バッジに hover で出る small button、または kebab メニューから「分類を訂正」を選択 → 学習モーダル (pre-fill 済) を開く。

---

## 8.4 学習例の管理 UI (Phase 4、設定モーダル → メールタブ内)

Phase 1 の右クリック学習モーダルは「ある 1 通について学習させる」用途。一度貯まった学習例を **後から見直す / 訂正する / 削除する** ためのリスト管理 UI を、設定モーダル `メール` タブ内 (`MailSettingsSection`) に「学習例」カードとして追加する。

### 8.4.1 必要になるシナリオ

- 学習当時はピンと来なくて雑なヒントを書いた → 後から良いヒントに書き直したい
- 状況が変わって「以前は不要だったが今は重要」になる種類のメールが出た → bucket 訂正
- 似た例を複数登録しすぎて RAG が偏った → 古いものを削除
- 元メールを物理削除した後でも、学習例だけ残って RAG に影響し続けるので、不要な学習例を直接消す手段が必要

### 8.4.2 UI レイアウト (設定モーダル → メールタブ → 「学習例」カード)

```
┌─ 学習例 ──────────────────────────────────────┐
│ 現在 47 件登録                                 │
│ ┌─ 重要 (12) ──────────────────────────────┐ │
│ │ ・GoEN ご案内 — 倉田博明                  │ │  ← クリックで展開
│ │   理由: 営業の実質返信、見落とさないように│ │
│ │   [編集] [削除]                           │ │
│ │ ・…                                        │ │
│ ├─ 要 (8) ──────────────────────────────── │ │
│ │   …                                        │ │
│ ├─ 不要 (27) ──────────────────────────────│ │
│ │ ・お問い合わせ受け付け — ホテル… (元削除済) │ │
│ │   理由: 営業フォームの自動受付             │ │
│ │   [編集] [削除]                           │ │
│ │ ・…                                        │ │
│ └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

- 行 1 件 = `embedded_text` の先頭から件名相当を抽出して表示 (元メール subject が分かれば優先表示、source_mail_id が NULL なら embedded_text の最初の改行までを表示)
- `[編集]` クリック → 学習モーダル (§8.1) を pre-fill モードで開く。bucket / hint を上書き、保存で PATCH。embedding は再生成しない
- `[削除]` クリック → 確認ダイアログ後 DELETE (既存 7.1 の DELETE エンドポイント)
- 件数が多くなったら検索フィルタ (テキストマッチで embedded_text + hint_text を絞る) を将来追加

### 8.4.3 source_mail_id が NULL の表示

元メールが物理削除済なら「元削除済」ラベルを薄文字で表示。学習例自体は生きていることを明示する。

---

## 9. 朝の briefing 統合

既存 `morning_speak` (毎朝 9 時) で:

- 「重要メール n 件あります」と要約 + 件名読み上げ (上位 3 件)
- TODO/予定 draft が起票されたメールは briefing で確認 → user が承認 / 破棄

データソース: `mail_messages WHERE bucket = 'important' AND classified_at >= last_briefing_at AND trashed_at IS NULL`

---

## 10. score 列の位置付け (Phase 2 で方針変更)

当初は「旧 score を drop して bucket だけにする」予定だったが、本文を読ませている以上、せっかくなので **バケット内重要度 score も同時に出させて保存** することにした。bucket と score は役割が違う ので、両方残して相互補完する。

| 列 | 意味 | 例 |
|---|---|---|
| `bucket` | カテゴリ判定 | important / needed / unneeded |
| `bucket_confidence` | 分類の確信度 (この bucket であることに対する確度) | 0.92 = 確信、0.55 = 微妙 |
| `score` | バケット内の重要度 (連続値) | 重要 でも 0.95 (顧客即返信) vs 0.7 (定期請求) |
| `bucket_reason` | 根拠の短文 | "営業フォーム自動受付" |

### 10.1 取扱

- score は Gemma が JSON 出力する `score: 0..1` をそのまま保存
- VIP / 住所録 → score 1.0、ブロック → score 0.0 (LLM skip 経路)
- score 出力が無い (parse 失敗等) ときは bucket 代表値 (重要 0.85 / 要 0.5 / 不要 0.15) を fallback
- 受信箱の並び順: bucket → score → 受信時刻 の優先順 (バケット内で重要なものほど上に)
- UI 右ペインに「重要度」として score を表示
- 自動アクション (Phase 3) の閾値計算には bucket_confidence (分類確度) と score (重要度) の両方を使う余地あり

drop migration は今後発生しない (列を 1 つ残すだけのコストより、連続値による柔軟な ranking 価値の方が大きい)。

### 10.2 既存メールへのバックフィル

Phase 1 完了直後に、`mail_messages WHERE classified_at IS NULL` を順次 curate する backfill バッチを 1 回走らせる (取り込み済の 15,000 件すべて)。
- per-mail 3 秒 × 15,000 = 12.5 時間。一晩で完了
- Phase 1 リリース時に手動で起動

### 10.3 学習 DB のシード

最初は学習例ゼロから始まる。user が手で:
- 営業フォーム自動受付を 5-10 件 → 不要
- 予想される本物の返信パターン (Re: で始まる、フォームフィールド無し) を 3-5 件 → 重要
- ニュースレター / 通知系を 5-10 件 → 不要 or 要

合計 15-25 件あれば実用域に入る想定。Phase 1 リリース直後の最初の 1 時間で集中的にラベル付け作業をするのが想定運用。

---

## 11. リスクと安全策

| リスク | 対策 |
|---|---|
| 学習例が偏って 重要 を 不要 判定する | 学習ヒット必須ゲートにより、訓練範囲外は自動アクションが起きない |
| 自動ゴミ箱の誤判定で大事なメールが消える | conf ≥ 0.85 + 学習ヒット必須。trashed_at は soft で hard delete はゴミ箱を空にする時のみ |
| Gemma が JSON を壊した出力をする | parse 失敗時は bucket 未設定で受信箱保留、warn ログ |
| 学習 DB が肥大化 | HNSW は数千〜数万件まで問題ない。10K 超えたら別途検討 |
| user が訂正をサボると同じ誤判定が続く | バッジに hover で訂正ボタン即起動、訂正コストを最小化 |
| 本文 head 1500 chars で重要情報を取り逃す | head に署名・テンプレ・フォームフィールド等の決定的情報が出るのが日本語ビジネスメールの一般傾向。検証後にチューン可 |

---

## 12. フェーズ計画

### Phase 1: スキーマ + 判定パイプライン改修 + 学習モーダル
- `mail_training_examples` テーブル作成 + drizzle 反映
- `mail_messages` に 4 column 追加 (bucket / bucket_confidence / bucket_reason / classified_at)
- `mail-curate.ts` を本文取得 + embed + RAG + few-shot Gemma に書き換え
- `/api/mail-training` POST/GET/DELETE 実装
- Mail modal kebab に「学習」項目追加、学習モーダル UI 実装
- 既存メールへの backfill スクリプト
- 自動アクション (自動ゴミ箱 / 自動 intent) はまだ実装しない

### Phase 2: バッジ表示 + 訂正ループ + 朝の briefing + 自動アクション consent
- 受信箱の各行に bucket バッジ表示
- 並び順を bucket → 受信時刻 に変更
- バッジから訂正モーダル即起動
- `morning_speak` に「重要メール n 件」を組み込み
- 旧 `score` ベース UI の停止 (column は残す)
- **学習例に auto_todo / auto_event カラム追加** (migration + 学習モーダル UI に「TODO 自動登録 / 予定自動登録」チェックボックス追加)
  → Phase 3 で実際に発動するための準備。Phase 2 段階では UI だけ動き、自動アクションは走らない

### Phase 3: 自動アクション (学習ヒット + consent 条件付き)
- 不要 + 学習ヒット + bucket_confidence ≥ 0.85 + score ≤ 0.15 → 自動ゴミ箱 (trashed_at)
- 重要 + 学習ヒット + bucket_confidence ≥ 0.85 + top-1 例の auto_todo=true → `/api/intent` で TODO draft 起票
- 重要 + 学習ヒット + bucket_confidence ≥ 0.85 + top-1 例の auto_event=true → `/api/intent` で 予定 draft 起票
- 重要だが auto_todo / auto_event とも false → 受信箱トップ + briefing 通知だけ
- (score 列は保持。Phase 2 で方針変更 → drop migration は無し)

### Phase 4: 学習例の管理 UI
- `PATCH /api/mail-training/:id` 実装 (bucket / hint_text 更新)
- 設定モーダル → メールタブ → 「学習例」カード追加 (§8.4 参照)
  - bucket 別に折り畳み表示、件名相当 + ヒント + 編集 / 削除
  - 元メール物理削除済 (source_mail_id IS NULL) を区別表示
- 誤登録 / 状況変化への訂正経路を確保 (学習資産のメンテナビリティ)
