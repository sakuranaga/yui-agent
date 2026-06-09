# ニュースキュレーション 設計書

## 1. 背景と目的

現状の `news-fetch` periodic は、1 時間ごとに有効な全 RSS ソースを fetch し、
新着が 1 件でもあれば「新着ニュース N 件」という低優先お便りを 1 件積むだけの
**ダム配信**。ユーザーがニュースタブを開けば全件読めるが、Yui が能動的に
「これは面白いですよ」と話すことはない。

問題:

1. **新着があってもユーザーの興味と関係ない可能性が高い** — 例: 殺人事件、芸能
   ゴシップなど、ユーザーが見たくないニュースも均等に通知される
2. **Yui の人格性が活きていない** — 通知タイトルが機械的で、再生時の発話も
   「ニュースを開きました」というシステム文言
3. **発話の質と量のトレードオフが取れていない** — speak モードに設定すると
   1 時間ごとに「新着ニュース 7 件。Hacker News (3), TechCrunch (4)」のような
   機械的な発話が走る

そこで **キュレーション** と **発話生成** の 2 層を導入し、ユーザーの興味に
合った 1 件だけを Yui のキャラ性で読み上げる。

### 設計原則

- **キュレーションは記憶を使わない** — ユーザーの興味プロファイル (自由テキスト)
  と新着タイトル一覧だけで判定。テスト容易、即制御可能、副作用なし
- **発話は Yui のキャラを通す** — 「ご主人様、面白いニュースが届いてますよ。
  ○○の〜〜〜」のように Yui の口調で要約 + 感想
- **読み上げは 1 件のみ** — ニュースは重要度低、過剰な発話は集中を破る
- **閾値以下は完全沈黙** — お便りバッジにも残さない。「キュレーション通過ゼロ」
  自体は通知しない方が自然
- **業務級品質** — score / reason を DB に残し audit 可能、設定変更履歴を取れる
  構造、throttle の状態は永続化

---

## 2. パイプライン

```
            ┌──────────────────────────────────────┐
1 時間毎 → │ RSS fetch (既存 news-fetch.ts)       │
            │   全有効ソースから記事取得           │
            │   news_articles に upsert            │
            └────────────┬─────────────────────────┘
                         │ 新着 N 件
                         ▼
            ┌──────────────────────────────────────┐
            │ curate() — Haiku 4.5 batch call      │
            │   入力: 興味プロファイル + 新着タイトル
            │   出力: [{idx, score 0-1, reason}]   │
            │   articles テーブルに score を保存   │
            └────────────┬─────────────────────────┘
                         │
                ┌────────┴────────┐
                ▼                 ▼
        全件 < threshold    最高 score >= threshold
                │                 │
                │                 ▼
                │     ┌──────────────────────────┐
                │     │ throttle 判定              │
                │     │ now - last_spoken_at      │
                │     │      < min_interval_h?    │
                │     └────────┬─────────────────┘
                │              │
                │     ┌────────┴────────┐
                │     ▼                 ▼
                │  通過                 throttle 中
                │     │                 │
                │     ▼                 │
                │  ┌──────────────────┐│
                │  │ speak() — Sonnet ││
                │  │ 1 件本文 → Yui   ││
                │  │ セリフ生成        ││
                │  └────────┬─────────┘│
                │           ▼           ▼
                │  saveNotification    saveNotification
                │  (mode=speak、       (mode=notify、
                │   yui_message 発話) toast のみ)
                │           │           │
                │           ▼           ▼
                │  last_spoken_at      ─
                │  を now で更新
                │
                ▼
            silent (お便りも作らない)
```

---

## 3. キュレーション (Haiku 4.5)

### 3.1 入力フォーマット

```
[system]
あなたはニュースキュレーターです。
ユーザーの興味プロファイルに沿って、各ニュース見出しに 0.0〜1.0 のスコアを
付けてください。

判定基準:
- 0.8〜1.0: 強く関心ありそう (プロファイルに直接一致)
- 0.5〜0.8: 関連ありそう (隣接ドメイン)
- 0.2〜0.5: 関心薄
- 0.0〜0.2: 不要 / 興味なしと明示 / ネガティブな話題

出力は JSON 配列のみ。説明文・装飾不要。
[{"idx": 1, "score": 0.95, "reason": "新モデルリリース"}, ...]

[user]
## ユーザーの興味プロファイル
{interest_profile}

## ニュース一覧
1. {title_1} — {source_1}
2. {title_2} — {source_2}
...
N. {title_N} — {source_N}
```

### 3.2 batch サイズ

1 fetch サイクルで取得した新着全件 (通常 5〜20 件) を 1 call にまとめる。
50 件超なら 2 call に分割。Haiku の context 制約より、JSON 出力安定性を優先。

### 3.3 失敗時の挙動

- LLM call 失敗 → 全件 score=null で DB 保存、お便りなし
- JSON parse 失敗 → 同上、warn ログ
- 設計上: キュレーション失敗は「沈黙」に倒す。誤って低品質な記事を speak しない

### 3.4 cost 試算

- 入力: profile 200 token + 20 件タイトル ≈ 400 token = 600 token
- 出力: JSON 20 件 ≈ 200 token
- Haiku 4.5: $1.0 / 1M input + $5.0 / 1M output
- 1 call ≈ $0.0016 ≈ 0.16 cent
- 1 日 24 fetch × 0.16 cent = **約 4 cent/日 = 月 $1.2**

---

## 4. 発話生成 (Sonnet 4.6)

### 4.1 トリガー条件

- キュレーション後、最高 score が threshold 以上
- かつ throttle (min_interval_hours) を超えている

両方満たした時、最高 score 1 件について Sonnet で Yui セリフを生成。

### 4.2 入力フォーマット

Yui のシステムプロンプト (既存 `getYuiSystemPrompt()`) を流用しつつ、
news 専用の追加ガイダンスを付ける:

```
[system]
{Yui の persona 標準プロンプト}

## このターンの役割
ニュース記事を 1 件、ご主人様に紹介してください。

## ニュース
タイトル: {title}
ソース: {source}
本文/要約: {summary}
リンク: {link}

## 出力形式
1〜3 文 (合計 120 字以内) で:
- 「ご主人様、面白いニュースが届いてますよ」のような呼びかけ
- 内容の要点 (1 文)
- Yui としての軽い感想 (1 文、任意)

リンクや URL は読み上げず、トースト側で見せます。
キャラとしてのセリフだけ返してください。
```

### 4.3 cost 試算

- 入力: persona 800 token + news 400 token = 1.2K token
- 出力: 120 字 ≈ 100 token
- Sonnet 4.6: $3.0 / 1M input + $15.0 / 1M output
- 1 call ≈ $0.0051 ≈ 0.5 cent
- 1 日: throttle 1h なら最大 24 回 = 12 cent ≈ **月 $3.6 (上限値)**
- 実際は閾値で減るので $1〜$2 が現実値

合算: キュレーション + 発話 = **月 $3〜$5 想定**

---

## 5. 設定 UI

SettingsModal の「ニュース」タブ (既存のソース管理セクションに追記):

```
┌─ 興味プロファイル ───────────────────────────────┐
│                                                  │
│  [multiline textarea, 500 字推奨]                │
│                                                  │
│  例:                                             │
│  最近AI関連のニュースに興味がある。              │
│  特に新しいモデルとか。                          │
│  一般的な殺人や事故などのネガティブニュースは不要。│
│  芸能関係もあまり興味がない。                    │
│                                                  │
└──────────────────────────────────────────────────┘

キュレーション閾値:  0.0 ─────●───── 1.0   (現在: 0.6)
読み上げ最低間隔:    [   1   ] 時間
```

### 5.1 設定の意味

| 項目 | 効果 |
|---|---|
| 興味プロファイル | Haiku に毎回渡される自由テキスト |
| 閾値 | これ未満は silent。default 0.6 |
| 最低間隔 | speak 通知の throttle。前回 speak からこの時間以内なら notify に降格 |

---

## 6. throttle 設計

### 6.1 状態の永続化

`news_curation_settings` table (singleton row) に `last_spoken_at timestamptz`
を持つ。in-memory ではなくDB に置く (= 再起動を超えて throttle が効く)。

### 6.2 判定ロジック

```
if max_score >= threshold:
  if now - last_spoken_at < min_interval_hours * 1h:
    mode = "notify"   # toast + Discord は出るが TTS は出さない
  else:
    mode = "speak"
    UPDATE news_curation_settings SET last_spoken_at = now
else:
  silent (saveNotification を呼ばない)
```

### 6.3 throttle 中のお便り表示

speak は抑止しても、お便りバッジ + レポートエリアの全件一覧は作る。
「気付いたら見れる」状態を維持し、声だけ抑える。

---

## 7. お便りモーダルのレポートエリア

選ばれた 1 件 (speak/notify 対象) と、それ以外の閾値超え記事を一覧表示。

```markdown
# 今日の新着ニュース (キュレーション結果)

## ⭐ ご主人様におすすめ
- **[Claude Opus 4.7 release with adaptive thinking](https://...)** — Anthropic
  (score: 0.95) 新モデルリリース

## その他の関心ありそうな話題
- [OpenAI o4 のベンチマーク詳報](https://...) — Hacker News  (score: 0.75)
- [LLM 推論コスト 1/10 に](https://...) — TechCrunch  (score: 0.68)

## 参考 (閾値以下、speak されなかった)
- [渋谷で交通事故](https://...) (score: 0.05)
- [人気アイドル○○さん結婚を発表](https://...) (score: 0.10)
```

閾値以下も「参考」として残す = ユーザーが「これも読みたかった」と気付けば
プロファイル調整できる (透明性)。

---

## 8. スキーマ変更

### 8.1 `news_articles` 拡張

```sql
ALTER TABLE news_articles
  ADD COLUMN score real,             -- NULL = 未キュレーション、0.0〜1.0
  ADD COLUMN score_reason text,      -- Haiku の "reason" 抜粋
  ADD COLUMN curated_at timestamptz; -- いつ curate されたか
```

### 8.2 新 table `news_curation_settings` (singleton)

```sql
CREATE TABLE news_curation_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton 保証
  interest_profile text NOT NULL DEFAULT '',
  score_threshold real NOT NULL DEFAULT 0.6,
  min_speak_interval_hours integer NOT NULL DEFAULT 1,
  last_spoken_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO news_curation_settings (id, interest_profile)
VALUES (1, '') ON CONFLICT (id) DO NOTHING;
```

singleton table のパターン: `CHECK (id = 1)` で 1 行のみ。
将来「複数プロファイル切替」が必要になったらまた拡張。

### 8.3 audit ログ?

設定変更履歴は v1 では取らない。個人用 = ロールバック需要薄。
将来「設定変えたら通知が来なくなった」のような原因追跡が要れば
別 table `news_curation_settings_history` を追加可能 (拡張点として明記)。

---

## 9. 実装フェーズ

### Phase 1 — スキーマ + 設定保存層

- DB migration: `news_articles` 拡張 + `news_curation_settings` 作成
- `src/lib/news-curation-settings.ts` — get / update (30s cache)
- 既存の `src/lib/news.ts` の型に score 系を反映

### Phase 2 — キュレーション

- `src/lib/news-curate.ts`:
  - `curateArticles(articleIds: number[]): Promise<void>`
  - Haiku call → JSON parse → DB に score 保存
  - 失敗時 silent + warn ログ

### Phase 3 — 発話生成

- `src/lib/news-speak.ts`:
  - `generateNewsSpeech(article): Promise<string>` (Yui セリフ 120 字)
  - Sonnet 呼び出し、persona は `getYuiSystemPrompt()` 流用 + news 追加ガイダンス

### Phase 4 — pipeline 統合

- `src/periodic/news-fetch.ts` 改修:
  - 新着 insert 後 → `curateArticles()` 呼び出し
  - 最高 score 取得 → 閾値判定 → throttle 判定 → mode 決定
  - `saveNotification()` を mode 指定込みで呼ぶ
  - `last_spoken_at` 更新 (speak 時のみ)
- `saveNotification` への mode override 経路を追加 (現状はマトリックスのみ、
  今回はキュレーション結果で動的に決まる)

### Phase 5 — UI

- `src/components/SettingsModal.tsx`「ニュース」タブ:
  - 興味プロファイル textarea
  - 閾値スライダー
  - 最低間隔 input
- お便りモーダル展開時のレポートエリア:
  - 全件をスコア順に表示 (selected をハイライト、閾値以下は折りたたみ可)
- API:
  - `GET /api/news-curation-settings`
  - `PUT /api/news-curation-settings`

---

## 10. 制約 / 既知の課題

### 10.1 LLM 出力のばらつき

Haiku は同じ入力でも score が 0.05 ぶれる可能性。閾値ぎりぎりの記事は
回によって speak/silent が揺れる。許容範囲 (個人用) と判断。
気になるなら閾値判定にヒステリシス (例: speak は >0.65、止めるは <0.55) を
入れる拡張点として残す。

### 10.2 全 RSS ソース横並びの問題

現状は全ソースを均等に Haiku に渡す。例えば「2ch まとめ」と「Hacker News」を
両方有効化しているとノイズ源側が悪さする可能性。
将来拡張: source ごとに「priority weight」を持たせて score × weight で判定。

### 10.3 多言語

Haiku は日本語/英語混在で問題なく動く想定だが、ロシア語/中国語等の見出しが
混ざると score 精度が落ちる可能性。当面はユーザーが日英中心の RSS を選ぶ
という運用前提。

### 10.4 throttle の初回

`last_spoken_at` が NULL のとき (初回) は throttle なしで speak。

### 10.5 既存 news 通知との互換性

migration 直後は既存 news_articles に score=NULL が残る。
そのままで動く (curate 対象は新着のみ)。過去記事を遡及 curate は不要。

---

## 11. テスト計画

### Manual

1. 興味プロファイル空 + 新着 5 件 → 全件 score 低、silent 確認
2. プロファイルに "AI" 記述 + AI 系新着 1 件 + 無関係 4 件 → AI 系が speak される
3. 閾値 0.9 に設定 → ほぼ何も speak されない (silent 多発) を確認
4. 最低間隔 24h に設定 → 1 日 1 件しか speak されないを確認
5. throttle 中の挙動: speak 直後に閾値超え記事 → notify モードに降格

### Automated (将来)

`tests/news-curate.test.ts` で Haiku モック → score 出力の deterministic 検証。
v1 では手動でいい。
