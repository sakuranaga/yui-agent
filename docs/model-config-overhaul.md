# モデル設定刷新 設計書 (#206)

LLM のモデル選択を「2 枠固定 + ローカル単一・サブ専用」から、**モデルレジストリ + 3 目的別 tier + ローカル複数 + 能力テストゲート + tier 別フォールバック**に刷新する。

---

## 0. 目的・スコープ

### やること
- **モデルレジストリ**: hosted/ローカルのモデルを**複数登録**（ローカルも複数）。provider を**明示**保持。
- **3 つの目的別 tier**: **main**（会話・tool 必須）/ **sub**（軽量背景・テキストで可）/ **heavy**（複雑タスク・リサーチ・コーディング・tool 必須）。各 tier にレジストリから 1 モデル割当。
- **能力テスト（接続テスト）でゲート**: 到達性 + **tool-use 対応**を probe。**tool 非対応モデルは main/heavy（tool 必須枠）に割当不可**（UI で選べない・保存を弾く）。
- **ローカルも main/heavy に使える**（tool テストを通れば）。現在の「ローカル text-only 前置きの skip + model 名 prefix 推定」を撤廃し、**割り当てられたモデルの provider(明示)/能力に従う**よう一般化。
- **tier 別フォールバック**: 各 tier のモデルが失敗時にどこへ投げるか設定可能。
- **役割→tier 再マッピング** + 既存設定の**移行**（後方互換）。

### スコープ外
- モデルの自動ベンチ/品質スコアリング（手動選択のまま）。
- ストリーミング能力テスト（将来）。

---

## 1. 現状 (コード根拠)

| 項目 | 実装 | 制約 |
|---|---|---|
| モデル枠 | `anthropic_main_model` / `anthropic_haiku_model` の **2 枠** (ai-settings.ts:43-44。legacy 名だが任意 provider ID 可) | 2 枠固定 |
| provider 判定 | **model ID prefix 推定** `detectProvider` (claude-/gpt-/o[134]/gemini-/grok-、不明→anthropic) | **ローカル model 名は推定不能** |
| role→枠 | `SONNET_ROLES` (main/news_speak/diary/sleep_intro/profile_synth) → mainModel、他 → haikuModel (`llm.ts:66-71`) | 2 tier 固定・ハードコード |
| ローカル | `local_llm_enabled/url/model/roles` の**単一**設定 (ai-settings.ts:48-51)。`shouldUseLocalLlmFor` + `callLocalLlm` で**サブ・テキスト専用の前置き** | 複数不可・main 不可 |
| tool 付き呼び出し | `hasTools \|\| hasComplexSystem` だと**ローカル前置きを skip** し、以降は `detectProvider(model)` で hosted (anthropic/openai/gemini/grok いずれも tools を受ける) に流れる (`llm.ts:236,291,320,335`)。「強制 Anthropic」ではない (Codex 訂正) | **未知のローカル model 名は detectProvider 不明→anthropic に誤ルーティング**。ローカルは tool 経路に乗れない (text-only 前置きが skip される) = ローカルを main にできない実質的理由 |
| API キー | anthropic/openai/gemini/grok を ai_settings に暗号化保存 (`SECRET_KEYS`) | — |

→ 「2 枠 + provider prefix 推定 + ローカルは別経路の単一サブ」が現状。**provider を明示化**し、**ローカルを router の一級市民**にするのが刷新の核。

---

## 2. 新アーキテクチャ

### 2.1 モデルレジストリ
登録モデル 1 件 = 1 エントリ:

```
ModelEntry {
  id           : string (uuid/slug)        — 内部参照キー
  label        : string                     — 表示名 (例 "Opus 4.8 (heavy)", "ローカル Gemma 27B")
  provider     : 'anthropic'|'openai'|'gemini'|'grok'|'local_openai'  — **明示** (prefix 推定しない)
  model_id     : string                     — 各 provider の model 名
  base_url     : string|null                — OpenAI 互換の **base** (例 `http://llm:8081/v1`、provider=local_openai 時必須)。adapter が `/chat/completions` を付加する (= full endpoint を入れない。§6 で正規化)
  api_key_ref  : 'anthropic'|'openai'|...|null  — どの保存済みキーを使うか (local は不要/任意)
  capabilities : { reachable, supports_tools, tested_at, last_error }  — 能力テスト結果 (§2.3)
  created_at, updated_at
}
```

ポイント:
- **provider を明示**することで、ローカル ("gemma-…" 等 prefix 不能) も router に乗る。`detectProvider` は**移行時の既存値推定のみ**に残し、新経路は entry.provider を信頼。
- **`local_openai`** = OpenAI 互換 endpoint。ローカルは「base_url 付き OpenAI 互換 provider」として統一し、特別経路 `callLocalLlm` を**この一般経路に畳む**。base_url は `.../v1` の形で持つ (full endpoint は持たない。既存 `local_llm_url` からの移行は §6 で正規化)。

### 2.2 3 tier slots + role→tier map
```
TierAssignment {
  main  : model_entry_id    — 会話 (tool 必須)
  sub   : model_entry_id    — 軽量背景 (tool 不要・テキスト可)
  heavy : model_entry_id    — 複雑タスク/リサーチ/コーディング (tool 必須)
}
```
- 各 tier に**能力ゲートを適用**: main/heavy は `capabilities.supports_tools === true` のモデルしか割当不可。sub は不問。
- **role→tier map** で既存 role を 3 分類 (§4)。`resolveTier(role)` が tier を返し、TierAssignment から model_entry を引く。

### 2.3 能力テスト (接続テスト) + ゲート
モデル登録/編集時、および手動「テスト」ボタンで実行:

1. **到達性 + 基本補完**: `messages:[{role:user, content:"ping"}]`, `max_tokens` 小。2xx + テキストが返れば `reachable=true`。
2. **tool-use probe**: 単純な tool 1 個 (例 `echo(text)`) を渡し、`tool_choice` で誘導して **tool_call が返るか**を確認。
   - Anthropic: `tools` + `tool_choice:{type:'tool',name:'echo'}` で tool_use ブロックが返るか。
   - OpenAI 互換 (openai/grok/local_openai): `tools` + `tool_choice` で `tool_calls` が返るか。
   - Gemini: function calling 形式で確認。
   - **成功 → `supports_tools=true`**。endpoint がそもそも `tools` を受け付けず 4xx → `false`。
3. 結果を `capabilities` に保存 (`tested_at`, `last_error`)。

> **アダプタ拡張が前提 (Codex 指摘 #4)**: 現 `CallLlmOpts` / 各アダプタ送信 body に `tool_choice` が無い (`llm.ts:215,308` / `openai.ts:305` / `gemini.ts:224`)。`tools` だけで probe すると tool 対応モデルでも text 応答して **false negative** になりうる。→ probe 経路 (および将来の tool_choice 利用) のため、**`tool_choice` を provider 別に送れるようアダプタを拡張** (Anthropic `tool_choice:{type:'tool'}` / OpenAI 互換 `tool_choice` / Gemini function calling config) してから probe を実装する。M2 のスコープに含める。

**ゲート (= ご主人様の「親切に」)**:
- UI: main/heavy の割当ドロップダウンは **`supports_tools=true` のモデルのみ表示**。未テスト/不可は選べない (理由ツールチップ "tool 未対応のため main/heavy に使えません")。
- API: 保存時にも server 側で再検証し、tool 必須枠への tool 不可モデル割当を**弾く** (UI バイパス対策)。

### 2.4 tier 別フォールバック
```
FallbackConfig {
  main  : model_entry_id|null
  sub   : model_entry_id|null
  heavy : model_entry_id|null
}
```
- 各 tier のモデルが失敗 (到達不能/エラー/リトライ尽き) したら、その tier の fallback entry に切替えて 1 回再試行。
- **MVP は 1 段** (tier → fallback 1 つ)。多段チェーンは将来 (YAGNI)。
- fallback 先にも tier の tool 要件を適用 (main/heavy の fallback は tool 対応必須)。
- 既存の「ローカル失敗→hosted sub」挙動は、この一般フォールバックに包含される。

### 2.5 callLlm の resolve 経路 刷新
現 `callLlm` (`llm.ts:231-`) を:
1. `tier = resolveTier(role)` → `entry = registry[assignment[tier]]`。
2. `entry.provider` に従って呼ぶ (anthropic SDK / openai 互換 / gemini / local_openai=base_url 付き openai 互換)。
3. **撤廃するのは「ローカル text-only 前置きの skip」と「prefix 推定」** (Codex 訂正。「強制 Anthropic」ではない)。ローカルを `entry.provider='local_openai'` の明示 provider として router の一級経路に乗せる → tool 付き呼び出しもローカルに行ける。現に `callLlm` に tools を渡すのは **main と specialist だけ** (Codex 確認: `route.ts:799` / `runner.ts:87`) で sub 相当 role は tools を渡さない。よって **main/heavy を tool 対応モデルにゲートすれば、tool 付き呼び出しは必ず tool 対応モデルに当たる**。
   - **ただし `spec.model` override の穴 (§4 注、Codex 指摘 #1)**: specialist は `model: spec.model` を直接渡すので、override が tool 非対応/未登録モデルだとゲートも fallback も迂回する。→ **`spec.model` は registry entry id の override とし、同じ能力検証 (tool 必須) を適用**する。
4. 失敗時 → `fallback[tier]` で 1 回再試行 → それも失敗なら throw (現状の retry/trace は維持)。
- `shouldUseLocalLlmFor` / 単一 local 前置きは**廃止**。ローカルは tier 割当で main/sub/heavy のどこにでも入る一級 provider になる。

---

## 3. データモデル

KV の ai_settings に押し込むと構造が辛いので、**専用テーブル**を新設:

```sql
CREATE TABLE model_registry (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  provider      TEXT NOT NULL,          -- anthropic|openai|gemini|grok|local_openai
  model_id      TEXT NOT NULL,
  base_url      TEXT,                   -- local_openai 時必須
  api_key_ref   TEXT,                   -- anthropic|openai|gemini|grok|NULL
  capabilities  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {reachable,supports_tools,tested_at,last_error}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

tier 割当 + fallback + role→tier override は**点在しない少数の値**なので ai_settings KV に JSON で:
- `model_tier_assignment` = `{"main":"<id>","sub":"<id>","heavy":"<id>"}`
- `model_tier_fallback`   = `{"main":"<id|null>", ...}`
- (任意) `role_tier_overrides` = `{"diary":"sub", ...}` — §4 既定を上書きしたい時だけ

API キーは既存の暗号化 ai_settings (`anthropic_api_key` 等) を `api_key_ref` で参照 (キー本体はレジストリに重複保存しない)。

---

## 4. 役割 → tier 既定マッピング

現 `LlmRole` (実在: `main`, `voice`, `judge`, `report`, `extract`, `reconcile`, `news_curate`, `news_speak`, `morning_speak`, `diary`, `profile_synth`, `sleep_intro`, `tts_normalize`, `mail_curate`, `food_extract`, `notify`, `specialist`。`llm.ts:44`、Codex 訂正) を 3 分類に。`resolveTier(role)` の既定表 (override 可):

| tier | role | 現状の tier | 性質 |
|---|---|---|---|
| **main** | `main`, `news_speak`, `diary`, `sleep_intro`, `profile_synth` | Sonnet (= 現 SONNET_ROLES) | 会話・人格・ユーザー向け生成。tool/複雑 system あり |
| **sub** | `voice`, `judge`, `report`, `extract`, `reconcile`, `news_curate`, `morning_speak`, `mail_curate`, `tts_normalize`, `food_extract`, `notify` | Haiku | 軽量背景。**tool は使わない**が `voice`/`report` 等は structured system (配列) を使う (= 「テキストのみ」ではなく「tool 不要・system あり得る」。Codex 訂正) |
| **heavy** | `specialist`, (将来) `deep_research`, `doc_agent`, `coding` | Haiku (or `spec.model` override) | 多段推論・遅延許容・品質最優先。Agent SDK エージェント受け皿 |

注:
- **migration は挙動保存を基本**: main tier ← 現 SONNET_ROLES、sub tier ← 現 Haiku 群、heavy tier ← `specialist`。`morning_speak` は**現状 Haiku なので既定 sub** (ユーザー向け発話なので main に上げたい人は `role_tier_overrides` で)。`diary` は**現 Sonnet のまま main**に置く (sub に落とすと品質低下するので既定では動かさない)。
- `specialist` の `spec.model` override は **registry entry id の override** とし、**同じ tool 能力検証を適用** (§2.5 #3、Codex 指摘 #1)。
- heavy role の一部 (deep_research/doc_agent/coding) は**まだ存在しない**ので前方互換 (role 追加時に heavy に入るだけ)。

---

## 5. UI (設定 → AI タブ 刷新)

`AiSettingsSection.tsx` を再構成:

1. **登録モデル一覧** (レジストリ): label / provider / model_id / 能力バッジ (到達 ✓ / tool ✓✗) + 「テスト」「編集」「削除」。「+ モデル追加」。
2. **provider 別 API キー** (既存): anthropic/openai/gemini/grok。
3. **tier 割当**: main / sub / heavy の 3 ドロップダウン。**main/heavy は tool 対応モデルのみ選択肢**。各 tier に fallback ドロップダウン。
4. ローカル追加フロー: provider=`local_openai` + base_url 入力 + テスト。tool が返れば main/heavy にも出せる。

絵文字禁止・lucide 流 SVG。能力バッジは色 + アイコンで可視化。

---

## 6. 移行 (後方互換)

migration + 起動時 1 回の seed:
- `anthropic_main_model` → レジストリに 1 entry 作成 (provider は移行時のみ `detectProvider` で推定、api_key_ref 付与) → `model_tier_assignment.main` に割当。
- `anthropic_haiku_model` → 同様 → `sub` に割当。**`heavy` の既定 = sub と同じ entry** (= 現 `specialist` は Haiku 解決なので、heavy=sub にすれば**挙動保存**。Agent SDK の強モデルが来たらユーザーが heavy を差し替える。Codex 指摘を反映し main 既定はやめる)。
- `local_llm_enabled=true` だった場合 → `local_openai` entry を 1 件作成。**base_url 正規化 (Codex 指摘 #3)**: 既存 `local_llm_url` は full endpoint (`http://llm:8081/v1/chat/completions`) だが、`callOpenAICompat` は `base_url + "/chat/completions"` を組む (`openai.ts:317`) ので、**`/chat/completions` を剥がして `base_url=http://llm:8081/v1` に正規化**して保存する (二重 suffix 防止)。model_id=local_llm_model。`local_llm_roles` が指していた role の tier に応じて、その entry を割当候補/fallback として**移行ログ + UI 案内**に出す (自動割当はせず、ユーザーがテストして割当)。
- 旧キー (`local_llm_*`, `anthropic_*_model`) は**読み取り専用で残し**、新経路が値を持てば新経路優先。完全削除は次フェーズ。

**挙動が変わりうる role** (移行時に明示):
- `diary` を sub に移す案 → main(Sonnet) から sub(Haiku) に品質が落ちる。要確認 (§4 注)。落としたくなければ role_tier_overrides で main に。

---

## 7. セキュリティ

- **API キー**: 既存の暗号化 ai_settings をそのまま参照 (レジストリには本体を持たない、`api_key_ref` のみ)。
- **base_url (local endpoint)**: ユーザー設定 (単一ユーザー・信頼) だが、`safeFetch`/`validatePublicUrl` の方針に従い、SSRF 観点で**保存時に形式検証** (スキーム/ホスト)。LAN/Tailscale 前提のローカル endpoint は許可。
- **能力テスト**: 任意 endpoint に ping を投げるので、base_url は登録済みエントリのものに限定 (任意 URL を都度叩かない)。
- エラーは CLAUDE.md 準拠で client に固定文 (テスト失敗理由は `sanitizeTestError` 系で「HTTP xxx / timeout / DNS」等のカテゴリに丸める)。

---

## 8. 実装フェーズ

| Phase | 内容 |
|---|---|
| **M1** | `model_registry` テーブル + レジストリ CRUD lib + 移行 seed (既存 2 枠 + local を entry 化、main/sub 割当、**heavy=sub** で挙動保存) |
| **M2** | 能力テスト (到達 + tool-use probe、provider 別) + capabilities 保存 |
| **M3** | `callLlm` 刷新 (resolveTier → entry → provider 呼び分け、tier fallback)。**ローカル text-only 前置き廃止 / prefix 推定廃止** (= provider 明示化)、`shouldUseLocalLlmFor`/単一 local 前置き廃止。`spec.model` を registry entry id override 化 + 能力検証適用 |
| **M4** | 設定 UI 刷新 (レジストリ一覧 + tier 割当 + ゲート + fallback + local 追加) |
| **M5** | 旧キーのクリーンアップ + ドキュメント |

各 Phase 独立コミット (要許可)。M1-M3 でバックエンドが動き、M4 で UI、の順。

---

## 9. テスト

- レジストリ CRUD + 移行 seed (既存値 → entry/割当の正しい変換)。
- 能力テスト: モック endpoint で tool 対応/非対応それぞれの判定。
- ゲート: tool 非対応 entry を main/heavy に割当 → server が弾く。
- `callLlm` resolve: role → 正しい tier → 正しい provider 経路。fallback 発火 (主モデル落ち → fallback 呼ぶ)。
- 後方互換: 旧キーのみ設定の状態で従来どおり動く。
- tsx ベース (既存 `scripts/test-*.ts` 方式)。LLM 実呼びはモック/stub。

---

## 10. 関連

- `src/lib/llm.ts` — callLlm / resolveModel / SONNET_ROLES / ローカル前置き
- `src/lib/ai-settings.ts` — 設定キー / getAnthropicConfig / getLocalLlmConfig / SECRET_KEYS
- `src/lib/llm-providers/` — detect / openai / gemini (+ grok は openai 互換)
- `src/lib/local-llm.ts` — callLocalLlm (→ local_openai provider に畳む)
- `src/components/AiSettingsSection.tsx` — 設定 UI
- `src/lib/crypto.ts` — API キー暗号化 / `src/lib/url-validate.ts` — base_url 検証
