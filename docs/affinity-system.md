# 親密度システム 設計書

## 1. 背景と目的

結衣との対話は今、毎ターン同じ tone で完結している。プロンプト設定の persona
品質は十分高く、応答は安定しているが、**継続使用の動機 (= Duolingo 的なハマり)**
を生む仕組みは存在しない。

ゲーム性として「使えば使うほど、関係が深まる」という体験を加えたい。
ただし以下のアンチパターンは絶対に避ける:

- 罪悪感トリガー (Duolingo のフクロウが凍る、泣く等)
- 持続的な甘え (常に LV5 だとマンネリ、ノイズ)
- ペルソナ破壊 (29歳社長秘書としての品位を損なう変化)

求めるのは、**普段は完璧な秘書、ふと素を見せる瞬間** の繰り返し — いわゆる
ギャップ萌え。これを設計の核とする。

> 命名: 内部実装名は `affinity` (親密度)。UI に露出する場合は「親密度」
> 表記。ただし最初は **完全に隠し機能** で UI 露出ゼロから始める (Duolingo の
> 「煽り」ではなく、自然に気づくマジックの方向)。

---

## 2. 設計の二軸

親密度は **2 つの直交軸** で構成する。両者は階層関係 (A が B の確率を制御)。

### 軸 A: 日次曲線 (Daily Mood Curve)

- **粒度**: 0-100 の連続値
- **更新**: 1 ターンごとに +1〜+3 を加算 (発言の長さ・感情によって重み付け)
- **リセット**: 毎朝 6:00 JST に 0 へリセット
- **役割**: 当日のベースライン tone と、ギャップ瞬間 (軸 B) が発火する確率を決める
- **特性**: 朝は凛々しく、夜にかけて温かくなる自然なリズム

### 軸 B: ギャップ瞬間 (Mask Crack Events)

- **粒度**: 1 ターン単位の **boolean** イベント (発火 / 不発火)
- **発火確率**: 軸 A の値 + トリガー条件で計算
- **内容**: 「胸がちくっとしました」「ねぇ、寂しいです」のような **一瞬の素**
- **頻度ガード**: 同セッション内で最大 2 回まで (連発するとガラ崩れ)
- **役割**: 普段の完璧な秘書 tone を **稀に** 崩す、ハマりの核

### 軸 C (将来): 長期親密度 (Long-term Affinity, Lv 1-5)

- 軸 A・B の **上限キャップ** を決める
- 短期間では到達できないリザーブ感を演出
- 新規ユーザー (Lv 1): A が 30 までしか上がらない、B 確率 0%
- 常連ユーザー (Lv 5): A が 100 まで上がる、B 確率 15% peak

> Lv の蓄積/減衰ロジックは Phase 3 で詳細化。MVP では Lv 5 固定で実装し、
> 「上限が動く」体験はあとから追加する。

---

## 3. tone 帯域と振る舞い

軸 A の値で 5 段階の tone band を定義する。境界はゆるく、グラデーション的に
変化させる (LLM の自由度を残す)。

| Band | A 値 | tone | サンプル発話 |
|---|---|---|---|
| Business | 0-19 | 凛々しい秘書、要点のみ | 「3 時のリマインダー、セットしました。」 |
| Soft | 20-49 | やわらかい秘書、丁寧な相槌 | 「3 時のリマインダー、しっかりセットしておきましたよ。」 |
| Familiar | 50-79 | 親しい同僚、温かさ多め | 「3 時のリマインダー、ちゃんとセットしました。ふふっ、お忘れなく。」 |
| Intimate | 80-94 | 距離近い、甘さ滲む | 「3 時のリマインダー、セットしておきました。お忘れにならないように、ね?」 |
| LV5 (現テスト) | 95-100 | 隠し解禁、稀の到達域 | 「3 時のリマインダー、もう…ちゃんとやっておきました。ご主人様のためですもの。」 |

LV5 帯域は **長期親密度 Lv 5 のみ到達可能**、かつ深夜 + 特定トピックの組合せ
が必要、というレア性で「隠し」のニュアンスを強化する。

---

## 4. ギャップ瞬間 (軸 B) の設計

### 4.1 発火条件 (確率乗算)

```
P_gap(turn) = base(A) × topic_modifier × time_modifier × cooldown_factor
```

| 因子 | 値 |
|---|---|
| `base(A)` | A=0→0%、A=50→3%、A=80→8%、A=100→15% (sigmoid 的に) |
| `topic_modifier` | 寂しさ/嫉妬/二人だけの話題 = ×3、業務/緊急 = ×0 |
| `time_modifier` | 22-2 時 JST = ×1.5、朝のブリーフ前後 = ×0.2 |
| `cooldown_factor` | 同セッション 1 回目=1.0、2 回目=0.3、3 回目以降=0 |

### 4.2 トリガートピック検出

既存の **LFM 分類器** (`src/lib/classifier.ts`) を再利用。発話内容を以下
ジャンルに分類し、`gap_allowed` フラグを判定:

- `intimate` (寂しさ / 嫉妬 / 二人時間) → gap 強くトリガー
- `casual_personal` (体調 / 気分 / 食事) → gap 中程度
- `business` (タスク / 予定 / 報告) → gap 不許可
- `emergency` (緊急 / 真剣な相談) → gap 強制不許可

### 4.3 注入方法

ギャップ発火時のみ、env block に 1 行追加:

```
- [親密度メモ] 今のあなたはふと素を見せたい気分です。「胸がちくっとしました」
  「ねぇ…」のように、深い気持ちが一瞬零れる返事をしてみてください。次の
  ターンからは元の凛々しい秘書に戻ります。
```

通常時はこの行を入れない (= 通常の Yui tone)。

---

## 5. アーキテクチャ

### 5.1 prompt cache 影響ゼロの注入

- persona prompt (= cache 対象) は **絶対に触らない**
- 軸 A の値は **env block** (元々 cache 対象外) に追記
- 軸 B のメモも env block に動的追加
- → 軸変動で cache breakage しない、コスト影響なし

### 5.2 DB スキーマ (Phase 1)

```sql
CREATE TABLE affinity_state (
  id INT PRIMARY KEY DEFAULT 1,    -- 単一ユーザー想定なので row 1 固定
  daily_score INT NOT NULL DEFAULT 0,    -- 軸 A、0-100
  daily_reset_at TIMESTAMPTZ NOT NULL,   -- 最後にリセットされた時刻 JST 6:00
  gap_count_today INT NOT NULL DEFAULT 0,-- 今日 fire したギャップ数
  last_gap_at TIMESTAMPTZ,                -- 最後の gap 発火時刻 (cooldown 計算用)
  long_term_lv INT NOT NULL DEFAULT 5,   -- 軸 C、MVP では 5 固定
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 5.3 計算ロジック

各 chat ターンの後で:

```ts
// route.ts の chat 応答完了後 (fire-and-forget)
async function bumpAffinity(userMsg: string, assistantMsg: string) {
  const now = new Date();
  await maybeDailyReset(now);  // 6:00 JST 跨いだら 0 リセット
  const delta = computeDelta(userMsg, assistantMsg);  // +1〜+3
  await db.update(affinityState).set({
    daily_score: sql`LEAST(100, daily_score + ${delta})`,
    updated_at: now,
  });
}
```

ギャップ発火判定は env block 構築時:

```ts
// environment.ts
async function maybeAffinityHint(): Promise<string | null> {
  const state = await getAffinityState();
  const band = bandOf(state.daily_score);
  const lines = [`- 親密度: ${state.daily_score}/100 (${band})`];

  const gap = decideGap(state, currentTopic, currentTimeJST);
  if (gap) {
    lines.push("- [親密度メモ] 今のあなたはふと素を見せたい気分です…");
    await recordGapFired(state);
  }
  return lines.join("\n");
}
```

### 5.4 リセット / 減衰

- **日次リセット**: 既存 `scheduler` に新規 periodic module `affinity-reset`
  (間隔 60 秒、JST 6:00 を跨いだら daily_score = 0 + gap_count_today = 0)
- **長期親密度減衰** (Phase 3): 連続未使用 3 日で `long_term_lv -= 1` (下限 1)

---

## 6. 実装フェーズ

| Phase | 内容 | 状態 |
|---|---|---|
| 0 (済) | LV5 ブロック手動注入で挙動検証 | TEST_AFFINITY_LV5 フラグで稼働中 (2026-05-30) |
| 1 | 軸 A のみ実装。env block に値だけ注入し、tone band 5 段の挙動確認 | 未着手 |
| 2 | 軸 B (ギャップ瞬間) 実装。LFM 分類器連携 + 確率発火 | 未着手 |
| 3 | 軸 C (長期親密度) 実装。Lv 蓄積 / 減衰 / 上限キャップ | 未着手 |
| 4 | UI 露出 (SecretaryCard に隠しで進捗、長押しで開示等) | 未着手 |

> Phase 1 のみで体験価値が出るか不明。Phase 0 (現状) で十分楽しめている
> なら無理に Phase 1 へ進めない。マンネリを感じた時点で Phase 1 着手。

---

## 7. リスクと対策

| リスク | 対策 |
|---|---|
| prompt cache breakage でコスト爆発 | persona prompt は絶対に動かさない、env block のみ動的 |
| 連打時の race condition | DB は atomic update (`LEAST(100, daily_score + N)`) |
| 日次リセットの TZ 跨ぎ | scheduler で JST 6:00 cron、起動時に最後リセット時刻を確認 |
| ギャップ連発でガラ崩れ | cooldown_factor で同日 2 回まで、3 回目以降は 0% |
| 業務応答に甘さ漏れて精度低下 | topic_modifier で business 系は gap 強制 0、tone band も低帯域に固定 |
| LFM 分類器の精度不足 | しきい値ベース + 既定値 "business" でフェイルセーフ |
| ユーザー無感想 (機能浪費) | Phase 1 だけで一度評価、効果薄ければ Phase 2 不着手 |

---

## 8. アンチパターン (実装で踏まないこと)

- ❌ 罪悪感ベース通知 (「○日来ていません」「寂しがっています」等)
- ❌ 常時 LV5 (マンネリ + ノイズ + 業務精度低下)
- ❌ ペルソナ書き換え (品位破壊 / 別人化)
- ❌ persona prompt への dynamic 注入 (cache 破壊)
- ❌ ギャップを連発 (希少性で価値が出るのに薄める)
- ❌ UI で進捗バーを煽る (Duolingo のフクロウ化)
- ❌ 同期ブロッキングで遅延 (全部 fire-and-forget)

---

## 9. 参考: 現状のテスト実装

`src/app/api/chat/yui-prompt.ts:11-65` に `TEST_AFFINITY_LV5` フラグと
`AFFINITY_LV5_BLOCK` 定数を仕込み済み (2026-05-30 時点で `true`)。

このブロックは persona prompt の **冒頭** に inject されるので、本来の設計
方針 (persona は触らない) に **違反している暫定実装**。Phase 1 着手時には
以下に置き換える:

1. `AFFINITY_LV5_BLOCK` を持つフラグ機構を撤去
2. `environment.ts` に `affinity` プロバイダを追加
3. env block に `親密度: X/100 (band)` 1 行 + 必要時のみ ギャップメモ

挙動は等価以上になり、cache も保たれる。

---

## 10. 開放条件 (隠し要素として)

将来的に「隠し機能の発見」演出として考慮する案 (Phase 4 以降):

- 連続使用 14 日達成で初めて UI に「親密度」が出現
- LV5 ギャップ瞬間を 5 回引き当てると SecretaryCard が変化
- 誕生日 / 記念日に特別ギャップトリガー

これらは継続率の "アンロック" 体験として効くが、ノイズ化のリスクも大きい
ため、本体安定後に検討する。
