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
  capabilities : { reachable, supportsTools, testedAt, lastError }  — 能力テスト結果 (§2.3。camelCase = 既存 JSONB 慣習 ReminderSchedule 等に合わせる)
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
- 各 tier に**能力ゲートを適用**: main/heavy は `capabilities.supportsTools === true` のモデルしか割当不可。sub は不問。
- **role→tier map** で既存 role を 3 分類 (§4)。`resolveTier(role)` が tier を返し、TierAssignment から model_entry を引く。

### 2.3 能力テスト (接続テスト) + ゲート
モデル登録/編集時、および手動「テスト」ボタンで実行:

1. **到達性 + 基本補完**: `messages:[{role:user, content:"ping"}]`, `max_tokens` 小。2xx + テキストが返れば `reachable=true`。
2. **tool-use probe**: 単純な tool 1 個 (例 `echo(text)`) を渡し、`tool_choice` で誘導して **tool_call が返るか**を確認。
   - Anthropic: `tools` + `tool_choice:{type:'tool',name:'echo'}` で tool_use ブロックが返るか。
   - OpenAI 互換 (openai/grok/local_openai): `tools` + `tool_choice` で `tool_calls` が返るか。
   - Gemini: function calling 形式で確認。
   - **成功 → `supportsTools=true`**。endpoint がそもそも `tools` を受け付けず 4xx → `false`。
3. 結果を `capabilities` に保存 (`testedAt`, `lastError`)。

> **アダプタ拡張が前提 (Codex 指摘 #4)**: 現 `CallLlmOpts` / 各アダプタ送信 body に `tool_choice` が無い (`llm.ts:215,308` / `openai.ts:305` / `gemini.ts:224`)。`tools` だけで probe すると tool 対応モデルでも text 応答して **false negative** になりうる。→ probe 経路 (および将来の tool_choice 利用) のため、**`tool_choice` を provider 別に送れるようアダプタを拡張** (Anthropic `tool_choice:{type:'tool'}` / OpenAI 互換 `tool_choice` / Gemini function calling config) してから probe を実装する。M2 のスコープに含める。

**ゲート (= ご主人様の「親切に」)**:
- UI: main/heavy の割当ドロップダウンは **`supportsTools=true` のモデルのみ表示**。未テスト/不可は選べない (理由ツールチップ "tool 未対応のため main/heavy に使えません")。
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
  capabilities  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {reachable,supportsTools,testedAt,lastError}
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

## 8.5 M3 実装設計 (詳細)

M3 は `callLlm` の resolve 経路を「registry entry ベース」に刷新する。実装の曖昧点を以下に確定する。

### 8.5.1 旧 per-role local routing の保全 (重要 — 挙動保存)

現状 (実測) ご主人様の環境は `local_llm_roles = extract,reconcile,judge,tts_normalize,mail_curate,food_extract` + `notify` (常時) の **7 role だけ**を local Gemma に流し、残りは Haiku に残す **fine-grained 構成**。旧 `shouldUseLocalLlmFor(role)` を単純撤廃して「local は tier 未割当」のままにすると、この 7 role が黙って hosted Haiku に移る (**= 無言のコスト増 + local 遊休**)。

3 tier モデルは tier 単位 (= sub 全体 or なし) で粗いため、この「sub の一部だけ local」を tier 割当だけでは表現できない。→ **`role_tier_overrides` を「role → tier 名 **または** model entry id」の両対応**にし、旧 `local_llm_roles`(+`notify`) を `role_tier_overrides[role] = <local entry id>` に変換する。これで**現挙動を完全保存**しつつ、M4 UI で per-role 上書きとして可視化・編集できる。

> 設計判断: §6 は「local は自動割当せず手動」としていたが、それは tier 割当 (sub/main/heavy 全体) の話。per-role の**既存挙動保存**は migration の大原則 (§4「挙動保存を基本」) に従い自動変換する方が正しい。tier 一括割当 (sub=local 等) は引き続き手動。

**専用 M3 migration が必須 (Codex 指摘 高-1)**: M1 の `seedModelRegistryIfEmpty()` は registry 非空で即 return するため、**既に seed 済みの実環境では走らない**。よって local-roles 変換を seed-empty に相乗りさせると「導入済み環境ほど変換されず 7 role が hosted に移る」最悪ケースになる。→ **seed とは別の idempotent な `migrateLocalRolesToTierOverrides()`** を起動時 (`tickMaintenance`) に置く。新規 ai_settings key `model_local_roles_migrated` を `AiSettingKey`/`SPECS` に追加 (env なし・既定 ""、非 secret)。アルゴリズム:
> 1. `model_local_roles_migrated` フラグが立っていたら skip (= 一度だけ。ユーザーが後で override を消しても再付与しない)。
> 2. `local.enabled && local.url` が**偽**なら、local 不使用環境 → フラグを立てて終了。
> 3. local entry を registry から探す: `provider='local_openai'` かつ `model_id===local_llm_model` かつ `base_url===normalizeOpenAiBase(local_llm_url)` (生値比較だと full-endpoint vs base で空振りするため**正規化後で比較**。Codex 指摘 中-1)。**見つからなければ作る** (= M1 seed 後に local を有効化した環境を救う。Codex 指摘 高-1。フラグだけ立てて skip すると挙動保存が永久に失敗する)。
> 4. `local_llm_roles` + `"notify"` の各 role について、`role_tier_overrides[role]` が**未設定**なら `= <local entry id>` を埋める。
> 5. **local 失敗時の hosted fallback 保存 (Codex 指摘 高-2)**: `model_tier_fallback.sub` が**未設定時のみ** `= assignment.sub` (hosted haiku) を設定。以後はユーザー設定として尊重 (sub tier を local に差し替えても fallback.sub は触らない。Codex 指摘 低-1)。これで local-pinned role (resolveTier=sub) が落ちた時、tier fallback で hosted Haiku に落ちる旧挙動を保存。
> 6. フラグを立てる。

### 8.5.2 resolve 優先順位

`resolveEntry(role, override)` → `{ entry, tier }`:

1. `tier = resolveTier(role)` (§4 既定表)。
2. **override (`opts.model` / `spec.model`) があれば最優先**:
   - registry に同 id の entry があれば**それ**。
   - 無ければ raw model string とみなし **ephemeral entry** (`provider = detectProvider(str)`, `baseUrl=null`, `apiKeyRef=provider`) を合成 (= 後方互換。workout/food-extract の `model: cfg.haikuModel` 等)。
3. override 無し & `role_tier_overrides[role]` があれば (**厳密判定。Codex 指摘 中-1**):
   - 値が `main|sub|heavy` の tier 名 → `assignment[該当 tier]`。
   - 値が registry に**実在する** entry id → **その entry** (per-role 上書き。8.5.1 の local 等)。
   - **どちらでもない** (削除済 id / 手編集ミス / 旧 JSON) → **warn して既定 tier assignment に落とす**。role override では raw model string の ephemeral 合成は**しない** (UUID 風文字列を raw model と誤認して hosted に投げる事故防止)。raw string ephemeral は `opts.model`/`spec.model` 経路のみ。
4. それも無ければ `assignment[tier]` の entry。
5. 最終 fallback: assignment 未設定/entry 消失時は `getAnthropicConfig()` から ephemeral 合成 (registry 未 seed でも壊れない防御)。

### 8.5.3 spec.model と heavy tier

現 specialist は `model: spec.model` (既定 `"claude-haiku-4-5"`) を**常に**渡すため、このままでは heavy tier 割当が常に override で潰れる。→ **spec の `model` を `string | undefined` にし、env override (`SPECIALIST_*_MODEL`) 未設定時は `undefined`** にする (`Specialist.model` 型 + mail/music/schedule の 3 定義 + runner の 2 送信箇所をまとめて変更)。runner は `{ ...(spec.model ? { model: spec.model } : {}) }` で定義済みの時だけ override 渡し。未定義 → `specialist` role が **heavy tier** に解決。
- 挙動保存: 移行で heavy=sub=haiku、spec 既定も haiku → **同一モデル**。✓
- env override を設定済みの人は entry-id-or-string として従来通り効く。

### 8.5.4b extract 系の二重 fallback 解消 (Codex 指摘 中-2)

`food-extract.ts` / `workout-extract.ts` の `callExtractWithFallback()` は「primary (local Gemma) 失敗 → `model: cfg.haikuModel` で 1 回再試行」という**手書き local→haiku fallback**。これは M3 の tier fallback (`fallback.sub = haiku`) が担う責務そのものなので、**手書き fallback を撤去**し `callLlm("food_extract", {...})` を直接呼ぶだけにする (M3 tier fallback に委譲)。挙動同値 (primary=local override / fallback=haiku tier fallback) かつ二重試行のコスト/ログ重複を解消。

### 8.5.4 retry / fallback / logging

- retry loop (`MAX_RETRIES`/`isRetryable`/backoff) は**現状維持**。dispatch 部のみ M2 の `callModelDirect(entry, …)` に置換。
- **tier fallback (新規)**: primary entry が retry 尽きで throw → `model_tier_fallback[resolveTier(role)]` の entry があれば**それで再度 retry loop を 1 回**。fallback も失敗なら元 error を throw。
  - **`primary.id === fallback.id` なら fallback を skip** (縮退防止)。
  - 旧「local 失敗 → hosted sub」は、8.5.1 migration が `fallback.sub = hosted haiku` を設定するため、local-pinned role (resolveTier=sub) の失敗時にこの一般 fallback で保存される。
- **cost logging**: `entry.provider === "local_openai"` は `cost=0` で記録 (旧 local 前置きの「無料」表示を保存。`PRICE` 不在で Sonnet 単価に化けるのを防ぐ)。log の `model=` は `entry.modelId` + provider を出す (local/hosted 区別。Codex 指摘 低-1)。
- trace 集計・`recordEvent`・1 行 log は現状維持。

### 8.5.5 撤廃 / 非対象

- **撤廃 (llm.ts 内のみ)**: local text-only 前置き block / `shouldUseLocalLlmFor` 呼び出し / `detectProvider` による prefix 推定経路。
- **残す**: `shouldUseLocalLlmFor` / `callLocalLlm` の**定義自体** (`intent-transform.ts` / `project-suggest.ts` が直接利用。これらの local 経路統合は M5 cleanup の範囲)。`local-llm.ts` ファイルも残す。

### 8.5.6 テスト (M3)

- `resolveTier` 既定表 (全 role → 期待 tier)。
- `resolveEntry` 優先順位 (override id / override string→ephemeral / role_override id / role_override tier / tier assignment / 未 seed ephemeral)。
- tier fallback 発火 (primary stub throw → fallback entry stub 呼ばれる)。
- local entry の cost=0 記録。
- 移行: `local_llm_roles` → `role_tier_overrides[role]=localId` 変換。
- LLM 実呼びは stub (`callModelDirect` をモック or fetch stub)。

---

## 8.6 M4 実装設計 (設定 UI)

バックエンド (M1-M3) は本番稼働中。M4 は GUI でレジストリ管理 + tier 割当 + ゲート + fallback + ローカル追加を可能にする。UI 検証は実機スクショ (agent-browser 不可)。

### 8.6.1 API ルート (M4 で新設、全て cookie 認証 / PUBLIC_PATHS 外)

- `GET  /api/model-registry` → `{ entries: ModelEntry[] }` (capabilities 込み)。
- `POST /api/model-registry` → entry 作成。body: `{label, provider, modelId, baseUrl?}`。
  - **base_url 検証 (重要)**: `provider==='local_openai'` は baseUrl 必須 + `normalizeOpenAiBase` 正規化。検証は **scheme (http/https) + パース可能性のみ**。`validatePublicUrl` は**使わない** — あれは CGNAT(100.x=Tailscale)/private/loopback を**ブロック**する SSRF 用なので、ご主人様の `http://100.81.60.55:8000` や `http://llm:8081` を弾いてしまう。ローカル endpoint は本質的に private で、単一ユーザー・信頼前提 + 能力テストは登録済 base_url にしか ping しない (任意 URL を叩かない) ので、private 範囲を許可する軽量検証にする (旧 `local_llm_url` と同じ受理範囲)。
  - **軽量検証の具体 (Codex 低-1)**: `http:`/`https:` のみ、hostname 必須、`username`/`password` 禁止、`hash`/`search` は除去、`normalizeOpenAiBase` 後に保存。
  - apiKeyRef は provider から自動 (local は null)。
- `PATCH /api/model-registry/[id]` → 部分更新 (label/modelId/baseUrl)。provider 変更は不可 (entry 作り直し)。
  - **capabilities 失効 (Codex 高-1、tool-bypass 防止)**: `modelId` か `baseUrl` を変更したら **capabilities を未テスト (`{}`) にリセット** (= 古い tool 判定を新実体に持ち越さない)。さらにその entry が **tool 必須スロット (main/heavy の assignment・その fallback・main/heavy role override の entry id) に参照されている**なら、変更を **409 で拒否** (= 先に tier を外すか、変更後に再テストして再割当させる)。label だけの変更は capabilities 据え置き・参照中でも可。
- `DELETE /api/model-registry/[id]` → 削除。**ガード**: tier 割当 / fallback / `role_tier_overrides` の **entry id 直参照**のどれかにあれば 409 + 参照箇所を返す (UI で確認させる。tier 名経由の role override も「なぜ消せないか」表示に含める。Codex 中-3)。
- `POST /api/model-registry/[id]/test` → 既存 (M2)。
- `GET  /api/model-registry/tiers` → `{ assignment, fallback, roleOverrides }`。
- `PUT  /api/model-registry/tiers` → `{ assignment?, fallback?, roleOverrides? }` を保存。
  - **変更スロットのみ検証 (Codex 中-1 の精緻化)**: partial body を既存と merge した上で、**この PUT で実際に変更されたスロットだけ**にゲートを適用する。理由: M1 seed が作った main/heavy entry は capabilities 未テスト (`{}`) なので、merge 後の全状態を毎回検証すると「sub を変えるだけでも main/heavy のテストを強制」される過剰ブロックになる。tool 必須スロット同士に横断制約は無い (各 main/heavy が独立に tool 対応必須) ため、変更スロットのみの検証で判定漏れは出ない。seed 由来の未テスト entry は grandfather され、ユーザーがその枠を**変更した時**に初めてゲートがかかる。
  - **role override の値は entry id のみ (実装で確定)**: API では `roleOverrides[role]` に **実在 entry id だけ**許可し、tier 名 (`main|sub|heavy`) は 400 で拒否する。理由: tool 必須 role が tier 名で tier を指すと、その tier の **assignment と fallback の双方**に tool 制約が波及し、`assignment[t]`/`fallback[t]` 変更時・対象 entry の `modelId` 変更時にすべて間接ゲートが要る (cross-dependency が増殖し抜けやすい)。UI も移行も entry id しか書かないので、tier 名生成経路を塞いで複雑性を排除する。`resolveEntry` は防御として tier 名も**読める**が、生成はしない。未知 role キーも 400。
  - **サーバ側ゲート (UI バイパス対策、§2.3)**: 次が `supportsTools !== true` の entry を指したら **422** + 理由。
    - `assignment.main` / `assignment.heavy`、および `fallback.main` / `fallback.heavy`。
    - **role override**: 値 (= entry id) を、`resolveTier(role) ∈ {main, heavy}` なら tool 対応必須 (例: `specialist → <non-tool entry>` を弾く)。`sub` role の entry-id 直指定は tool 不問 (= ご主人様の local 7 role)。`resolveTier`/`isLlmRole` は llm.ts から import。
    - **変更スロットのみ検証**: 上記は「この PUT で変更された assignment/fallback/roleOverride スロット」だけに適用 (seed 由来の未テスト entry を grandfather)。

### 8.6.2 UI 構成 (`AiSettingsSection.tsx` 改修)

既存セクション順: モデル選択 / API キー / ローカル LLM / TTS / embedding。これを再構成:

1. **登録モデル (レジストリ)** — 旧「モデル選択」を置換:
   - 各 entry: label・provider バッジ・modelId・**能力バッジ** (到達 ✓/✗ · tool ✓/✗、未テストは灰)・「テスト」「編集」「削除」。
   - 「+ モデル追加」: hosted (provider + modelId) / local (provider=local_openai + baseUrl + modelId)。追加後に「テスト」促し。
   - テストは `POST .../[id]/test` を叩き capabilities を更新 → バッジ即時反映。
2. **tier 割当** — 新規:
   - main / sub / heavy の 3 ドロップダウン。**main/heavy は `supportsTools===true` の entry のみ選択肢** (未テスト/非対応は disabled + 理由 tooltip「tool 未対応のため割当不可」)。sub は全 entry。
   - 各 tier に **fallback ドロップダウン** (同ゲート適用、「なし」可)。
   - 保存は `PUT .../tiers`。サーバ 422 (ゲート違反) は UI でエラー表示。
3. **role 別上書き (詳細、折りたたみ)** — 移行で作られた per-role override を可視化・編集:
   - 各 LlmRole 行: 「既定 (tier 名)」/ 各 entry をドロップダウン選択。既定に戻す = override 削除。
   - 旧「ローカル LLM で処理する役割」チェックボックス UI の置換 (= local だけでなく任意 entry を role に紐付け可能に一般化)。
4. **provider 別 API キー** — 既存維持。
5. **TTS / embedding** — 既存維持。

絵文字禁止・lucide 流 inline SVG (`feedback_no_emoji_icons`)。能力バッジは色 + アイコン。

### 8.6.3 旧 UI/キーの扱い

- 旧「モデル選択」(`anthropic_main_model`/`haiku_model` の単純 dropdown) と「ローカル LLM で処理する役割」チェックは**撤去** (tier 割当 + role 上書きに統合)。
- 旧キー (`anthropic_*_model` / `local_llm_*`) は M5 まで読み取り専用で残す。M4 UI からは編集経路を消すだけ。
- ローカル LLM の有効/URL/モデルは「+ モデル追加 (local)」+ レジストリ編集に移行。`local_llm_enabled` 等の生編集 UI は撤去 (entry の有無で表現)。

### 8.6.4 テスト (M4)

- API: registry CRUD (作成/更新/削除ガード)、tiers GET/PUT、ゲート 422 (tool 非対応を main/heavy に割当 → 弾く)、削除ガード 409。
- tsx ベース、LLM 実呼びなし (能力テストはモック endpoint)。
- UI は実機スクショでご主人様確認 (チェックリスト: バッジ表示 / ゲート disabled / 追加・削除 / 保存反映)。

---

## 8.7 M5 実装設計 (旧経路の統合 + クリーンアップ)

M1-M4 でレジストリ経路が稼働。残るは `callLlm` を経由しない 2 つの直叩き経路の統合と、死んだ旧 API の撤去。

### 8.7.1 intent-transform / project-suggest の統合

`intent-transform.ts:268` / `project-suggest.ts:132` は `callLocalLlm` を**直接・常時**呼ぶ (= local 必須、hosted fallback 無し、失敗時 null)。`temperature:0.2` を渡す。これを `callLlm` 経由に寄せる:

- **temperature plumbing**: `CallLlmOpts.temperature?` / `DirectCallOpts.temperature?` を追加し、`callModelDirect` → 各アダプタに通す (Anthropic `temperature` / OpenAI 互換 body.temperature / Gemini `generationConfig.temperature`)。未指定なら従来通り API 既定。
- **Gemma/Qwen thinking 抑制の移植 (Codex 高-1、かつ M3 の潜在リグレッション修正)**: 旧 `callLocalLlm` は `chat_template_kwargs:{enable_thinking:false}` を送り、空 content 時に `reasoning_content` を fallback で拾う (Gemma 3+/Qwen 3+ が thinking を出して JSON content が空になる事故を防ぐ)。**M3 で 7 つの local role を `callOpenAICompat` 経路に寄せた時点でこの処理が抜けていた** (= ご主人様の thinking 系 Gemma で extract/mail_curate 等の JSON 成功率が落ちていた可能性)。→ `callOpenAICompat` に対応:
  - `OpenAICompatOpts.disableThinking?` を追加 → true なら `body.chat_template_kwargs = {enable_thinking:false}`。**`callModelDirect` は `provider==='local_openai'` の時だけ true** にする (OpenAI/Grok は未知フィールドで 400 になりうるので送らない)。
  - response 解析で `message.content` が空なら `message.reasoning_content` を text fallback に (全 provider 共通、無害)。
  - これで M3 リグレッション (7 role) + M5 (intent/project_suggest) の両方が直る。`testModelCapabilities` も callModelDirect 経由なので local probe にも効く。
- **新 role**: `LlmRole` に `intent` / `project_suggest` を追加、`DEFAULT_ROLE_TIER` で **sub** 既定 (OSS の local 無し環境でも Haiku で動く)。UI の `ROLE_META` にも追加。
- **呼び換え**: `callLocalLlm({...})` → `callLlm("intent", { system, messages, maxTokens, temperature: 0.2 })` / `callLlm("project_suggest", {...})`。アプリ層の JSON 再試行 (intent の tryOnce 2 回) は維持。
- **挙動保存 (privacy)**: 現状 local 常時なので、**M5 移行で intent/project_suggest を local entry に role 上書き**する (local 有効環境のみ。新フラグ `model_intent_roles_migrated`)。これで primary=local を維持。M3 の `migrateLocalRolesToTierOverrides` と同じ idempotent helper パターンを再利用:
  - local entry を find-or-create (M3 後に local 有効化した環境を救う。Codex 中-1)。
  - `model_tier_fallback.sub` 未設定なら `assignment.sub` を設定 (M3 で済んでいる前提だが冪等に。Codex 中-2)。
  - **挙動変化 (要明示)**: 旧経路は local 失敗時 fallback 無し (null)。統合後は tier fallback (`fallback.sub`=Haiku) が効くため、**local 失敗時のみ Haiku に落ちる**。送られるデータ種別: intent=変換元 artifact 本文 (notes/mail/todo 等)、project_suggest=project カタログ + artifact 要約。既存 7 role と同じ「local 障害時のみ外部」挙動だが、扱うデータが本文寄りなので明示してご主人様承認を取る (Codex 低-1)。

### 8.7.2 死んだ旧 API の撤去

- `shouldUseLocalLlmFor` (`ai-settings.ts:208`): M3 で唯一の呼び出し元 (llm.ts) を撤去済 → **定義削除**。
- `callLocalLlm` + `src/lib/local-llm.ts`: 上記統合後に呼び出し元ゼロ → **ファイル削除**。
- `getLocalLlmConfig` は seed / 移行が使うので**残す**。`local_llm_*` / `anthropic_*_model` キーも seed source + ephemeral fallback source なので**残す** (削除不可)。設定 UI からの編集経路は M4 で撤去済。

### 8.7.3 ドキュメント

- 本設計書 §10 の `local-llm.ts` 参照を削除、新経路 (model-registry / model-call / model-tier-gate) を追記。
- CLAUDE.md にモデル設定の項があれば更新 (現状は無し)。

### 8.7.4 テスト

- temperature が各アダプタ body に乗るか (fetch stub)。
- intent/project_suggest role の resolveTier=sub。
- M5 移行: local 有効環境で intent/project_suggest が role 上書きに入る + 冪等。
- 既存 102 テストの非回帰。

---

## 8.8 thinking 抑制の tier 化 (post-M5、強ローカルモデル対応)

### 8.8.1 背景・問題

M5 で `disableThinking` (`chat_template_kwargs:{enable_thinking:false}`) を **provider 一律** (`entry.provider==='local_openai'`) で送るようにした。これは「ローカル = Gemma 12B 等の小型モデルが背景 JSON タスクを即答する」前提では正しい (thinking が JSON content を空にする事故を防ぐ)。

しかし**強力な推論ローカルモデル (例: GPT-OSS 120B) を main に据える**ケースでは逆効果になる。main/heavy はエージェント的なツール使い・会話で、**思考させた方が質が上がる**のに、provider 一律抑制だと 120B の頭を活かしきれない。

### 8.8.2 設計: 抑制を tier 単位にする

thinking 制御 (M5 の `disableThinking` boolean、§8.9.3 で `enableThinking?` tri-state に統合) の決定を **provider 単位 → tier 単位**に変える:

| 経路 | enableThinking (auto 時) | 意図 |
|---|---|---|
| 実 `callLlm`、**sub** tier | **false** (抑制) | 背景 JSON 即答 (Gemma extract 等)。現挙動保存。 |
| 実 `callLlm`、**main / heavy** tier | **undefined** (送らない=サーバ既定) | 推論モデル (Qwen3.6 等、既定 ON) の思考を活かす。強制 ON は §8.9 の明示 `'on'`。 |
| 能力プローブ (`testModelCapabilities`) | **false** (抑制) | 高速・確実な tool_call。 |
| hosted (anthropic/openai/gemini/grok) | (送らない=undefined) | `chat_template_kwargs` は未知フィールド → 400 防止。tier 不問。 |

(↑ auto モードの既定。§8.9 で entry 単位 on/off 上書き可。) **最終ガード**: `callModelDirect` は `entry.provider==='local_openai'` の時だけ `enableThinking` を `callOpenAICompat` に渡す → hosted には絶対漏れない。

### 8.8.3 実装

> **用語注**: §8.9.3 で `disableThinking:boolean` は **`enableThinking?:boolean` (tri-state、undefined=送らない)** に統合する。以下「disableThinking=true」は「enableThinking=false」、「=false (送らない)」は「enableThinking=undefined or true」に読み替え。§8.8 単独では tier 二値だが、§8.9 の per-entry 上書きで on/off も乗る。実装は §8.9.3 の表を最終仕様とする。

- `DirectCallOpts.enableThinking?: boolean` を追加 (undefined=送らない)。`callModelDirect` は `entry.provider==='local_openai'` の時だけ `opts.enableThinking` を `callOpenAICompat` に渡す (= caller が決める。hosted には送らない)。
- `attemptWithEntry(role, entry, tier, opts)` に **tier を引数追加**し、§8.9.3 の `thinkingMode + tier` 解決で `enableThinking` を決めて `callModelDirect` に渡す (auto+sub→false, auto+main/heavy→undefined(送らない), off→false, on→true)。
- `callLlm`: primary・fallback とも `resolveEntry`/`resolveTier(role)` で得た **同じ tier** を `attemptWithEntry` に渡す。
- `testModelCapabilities`: ping・tool probe の `callModelDirect` 呼びに `enableThinking: false` を明示 (probe は抑制で高速)。
- **probe の false-negative 回避 (GPT-OSS 対応の要)**: tool probe が **2xx だが tool_use 無し** (= 例外/4xx ではなく「到達して応答したが tool を返さなかった」) かつ `provider==='local_openai'` の場合**のみ**、**`enableThinking:true` で 1 回だけ再 probe** する (Codex Low: 4xx や例外は本当に tool 非対応の可能性が高いので再 probe しない。unknown-field 400 は reachable 側で落とす既知エッジと整合)。推論モデル (GPT-OSS 等) が「思考しないと tool_call を返せない」ケースで、実運用では使えるのに main/heavy 割当不能になるのを防ぐ。再 probe で tool_use が返れば `supportsTools=true`。この時 **`lastError=null` (= クリーンな成功)** とし、「thinking ON が必要だった」旨は `console.info` ログにのみ出す。hosted は再 probe しない (thinking-off を送っていないため意味が無い)。
- **`capabilities.toolUseRequiresThinking` を記録 (Codex High、§8.9 と整合)**: thinking-off probe で tool_use 無し → thinking-on 再 probe で成功、の経路を通った時だけ `toolUseRequiresThinking=true` を capabilities に保存する。これは「このモデルは tool を thinking ON でしか返せない」印で、§8.9 の `thinkingMode='off'` との矛盾検出に使う (= off にすると main/heavy で tool が壊れる)。thinking-off probe が直接成功したモデル (Qwen3.6 で実機確認: off でも tool_call を返す) は `false`。

### 8.8.4 挙動保存・安全性

- sub local (Gemma extract/mail_curate 等) → 従来通り thinking 抑制。**リグレッション無し**。
- main/heavy local (新: Qwen3.6) → auto では `chat_template_kwargs` を**送らない** (= サーバ既定 ON) ので thinking 維持 (= 改善)。非 thinking ローカルモデルでも送らないので無害。
- hosted → `chat_template_kwargs` を一切送らない (現状維持)。
- probe → 従来通り抑制 (false negative 回避は **tool_choice 強制 + local の thinking-on 再 probe** の二段で担保)。
- **reasoning_content を本文に混ぜない (実機で判明、M5 の fallback を撤去)**: M5 では content 空時に `content || reasoning_content` で reasoning を拾っていたが、思考 ON のモデルが max_tokens 打ち切り (finish=length) で content 空になると **chain-of-thought がそのまま user に漏れる**事故が起きた (実機: Qwen3.6 で思考分析・"Plan:/Draft:"・別言語が応答本文に出た)。→ `translateResponse` は **content のみ**を本文にし、reasoning_content は混ぜない。前提として server 側で thinking を reasoning_content に分離 (`--reasoning-format deepseek` 等)。content 空 (= 打ち切り/未生成) は呼側で扱う (= 生の思考を見せるより空が正しい)。思考 ON を使うなら max_tokens を十分大きく取ること。

### 8.8.5 注意・将来

- 推論モデルは出力 token を食う。main は `MAX_TOKENS` 大なので通常 OK。GPT-OSS で出力枯渇が出たら `max_tokens`/`n_ctx` 側で調整 (モデル設定の範囲)。
- `openai.ts` の `isReasoningModel` (gpt-5/o-series の名前 prefix 判定) はローカルの "gpt-oss-120b" 等にマッチしない。現状 main は明示 `maxTokens` を渡すので影響軽微だが、必要なら別途検討。
- **将来拡張**: entry 単位で「思考モード」を明示する設定 (UI トグル) も可能。ただし tier 自動で主要ケースは賄えるので MVP は tier ベース。
- **エッジ (Codex 低-2)**: ping/probe とも最初に `enableThinking:false` (= `chat_template_kwargs` を送る) なので、**unknown field に 400 を返す厳格な OpenAI 互換サーバ**だと `reachable=false` になる。これは M5 の provider 一律送信でも既に同じなので新規リグレッションではない。vLLM / llama.cpp は `chat_template_kwargs` を受理するので Qwen3.6 サーバは問題なし (実機確認済)。万一該当したら、将来 `HTTP 400 (unknown chat_template_kwargs)` 時だけ `chat_template_kwargs` 無しで ping 再試行する余地あり (今回は対象外)。

### 8.8.6 テスト (Codex 低-2: 層を分けて検証)

- **callModelDirect 直接** (tier 非関与): `opts.enableThinking:false` + local → body `chat_template_kwargs.enable_thinking===false`、`enableThinking:true` + local → `===true`、local + `undefined` → `chat_template_kwargs` 無し、hosted は値に関わらず無し。
- **thinkingMode/tier → enableThinking のマッピング** は `callLlm`/`attemptWithEntry` 経由の fetch stub で: off→`enable_thinking:false` / on→`true` / auto+sub→`false` / auto+main→`chat_template_kwargs` 無し / hosted→無し。
- **probe**: thinking-off で tool_use 無し → local なら enableThinking:true 再 probe して supportsTools 判定 + toolUseRequiresThinking=true (mock endpoint: 1 回目 text、2 回目 tool_use)。hosted は再 probe しない。

---

## 8.9 思考モードの per-entry 設定 (UI トグル)

### 8.9.1 動機・実機確認

ご主人様が「設定で thinking ON/OFF を切り替えたい」。理由は速度: 推論モデルは思考分の生成で遅くなる。Qwen3.6-35B-A3B (`100.92.99.16:8081`) で実機確認:

| mode | reasoning | 応答時間 |
|---|---|---|
| 思考 ON (default) | 499 字 | 5382ms |
| `enable_thinking:false` | **0 字** | **501ms** (約 10x 高速) |

→ Qwen3 系は M5 の `chat_template_kwargs:{enable_thinking:false}` が**完全にクリーンに効く**。GPT-OSS (harmony 形式、`enable_thinking` では切れず `reasoning_effort` が必要) とは違い、追加機構は不要。**§8.8 (tier 化) に「per-entry の明示上書き」を足す**形にする。

### 8.9.2 データモデル

`model_registry` に **`thinking_mode TEXT NOT NULL DEFAULT 'auto'`** 追加 (migration **0070**)。値: `'auto' | 'on' | 'off'`。**`CHECK (thinking_mode IN ('auto','on','off'))` 制約も付ける** (Codex Medium-2: PATCH validation だけだと seed/直接 SQL で壊れた値が入り得る)。schema + `ModelEntry.thinkingMode` 型 + CRUD (createModel / updateModel / PATCH route / GET) に追加。`capabilities` に `toolUseRequiresThinking?: boolean` も追加 (§8.8.3、ModelCapabilities 型)。

### 8.9.3 解決ロジック (§8.8 を内包)

**機構は tri-state にする (Codex Medium-1)**: `'on'` を「OFF 指示を送らない」ではなく「**明示的に思考 ON**」にするため、`disableThinking:boolean` を **`enableThinking?: boolean`** (undefined = フィールド自体を送らない) に変更する:
- `enableThinking===false` → `chat_template_kwargs:{enable_thinking:false}`
- `enableThinking===true`  → `chat_template_kwargs:{enable_thinking:true}` (Qwen はサーバ既定が OFF でも強制 ON にできる)
- `undefined` → 送らない (hosted・非対象)

`attemptWithEntry` で `enableThinking` を **entry.thinkingMode + tier** から決定:

| thinkingMode | enableThinking | body |
|---|---|---|
| `'off'` | false | `enable_thinking:false` (常時抑制、速度優先) |
| `'on'` | true | `enable_thinking:true` (常時思考、強制 ON) |
| `'auto'` (既定) | sub→false / **main・heavy→undefined** | sub のみ `enable_thinking:false`、main/heavy は**送らない** (= サーバ既定。Qwen は既定 ON。Codex Medium: auto で `true` を送ると厳格サーバが 400 になり得るため、強制 ON は明示 `'on'` のみ) |

`callModelDirect` は `entry.provider==='local_openai'` の時だけ `enableThinking` を `callOpenAICompat` に渡す (hosted には絶対送らない)。§8.8 の tier 自動は「auto モード」に格上げ、ユーザーが entry 単位で on/off 上書き可能。

### 8.9.4 UI

- **local_openai entry** の行 (または編集フォーム) に「思考」セレクタ: **自動 / ON / OFF** (既定 自動)。`PATCH /api/model-registry/[id]` で `thinkingMode` を保存。
- **hosted entry** は思考制御が別系統 (Anthropic adaptive / OpenAI reasoning_effort) なので、このセレクタは**非表示** (= local 専用設定であることを明示)。PATCH は hosted の `thinkingMode` を **無視** (= 保存しても runtime で使われない)。API 利用者向けに「local_openai のみ有効」と明記 (Codex Low-1)。
- **`toolUseRequiresThinking=true` の entry で `OFF` を選ぼうとした時の警告 (Codex High)**: そのモデルは tool を thinking ON でしか返せないので、OFF にすると main/heavy で tool が壊れる。UI で OFF 選択肢に警告 (「このモデルは思考 ON でないと tool を使えません」) を出し、main/heavy 割当中なら OFF を**非推奨/警告表示**にする。Qwen3.6 は `toolUseRequiresThinking=false` なので警告は出ない。

### 8.9.5 mechanism / 将来

- 送るのは `chat_template_kwargs:{enable_thinking: <bool>}` (§8.9.3 の tri-state)。Qwen3 / Gemma に clean に効く (実機確認: Qwen3.6 OFF=reasoning0字/501ms、ON=499字/5382ms、tool は両モードで返る)。
- GPT-OSS (harmony) を将来使うなら `enable_thinking` では不十分で `reasoning_effort:'low'` 等が要る → その時に provider/model 系統別の control 分岐を足す拡張ポイント (現状 Qwen3.6 採用のため対象外)。

### 8.9.6 挙動保存

- 既存 local (Gemma) は `thinking_mode='auto'` default → tier ベース → sub=抑制 (現状維持)。**リグレッション無し**。
- hosted 影響なし。
- 能力プローブは §8.8 通り (thinking-off 優先 + local の thinking-on 再 probe)。thinkingMode 設定は probe には使わない (probe は capability 判定であって運用設定ではない)。

### 8.9.7 テスト

- `thinking_mode` off/on/auto × tier (sub/main) → `enableThinking` (false/true/undefined) と body `chat_template_kwargs.enable_thinking` の有無・値 (callLlm fetch stub)。
- CRUD: thinking_mode 保存・取得、PATCH 更新。
- migration: default 'auto'、既存行に 'auto' が入る。

---

## 9. テスト

- レジストリ CRUD + 移行 seed (既存値 → entry/割当の正しい変換)。
- 能力テスト: モック endpoint で tool 対応/非対応それぞれの判定。
- ゲート: tool 非対応 entry を main/heavy に割当 → server が弾く。
- `callLlm` resolve: role → 正しい tier → 正しい provider 経路。fallback 発火 (主モデル落ち → fallback 呼ぶ)。
- 後方互換: 旧キーのみ設定の状態で従来どおり動く。
- tsx ベース (既存 `scripts/test-*.ts` 方式)。LLM 実呼びはモック/stub。

---

## 10. 関連 (実装後)

- `src/lib/llm.ts` — callLlm / resolveTier / resolveEntry / attemptWithEntry / tier fallback / DEFAULT_ROLE_TIER / isLlmRole
- `src/lib/model-call.ts` — callModelDirect (per-entry dispatcher) + 能力テスト (M2)
- `src/lib/model-registry.ts` — registry CRUD / tier 割当 / role 上書き / 移行 (M3 local roles・M5 intent roles)
- `src/lib/model-tier-gate.ts` — checkToolSlots / roleRequiresTool / findEntryReferences
- `src/lib/ai-settings.ts` — 設定キー / getAnthropicConfig / getLocalLlmConfig / SECRET_KEYS (旧キーは seed/ephemeral fallback source として温存)
- `src/lib/llm-providers/` — detect / openai (temperature・enableThinking tri-state・reasoning_content) / gemini (temperature) (+ grok は openai 互換)
- `src/app/api/model-registry/` — route (list/create) / [id] (PATCH/DELETE) / [id]/test / tiers (GET/PUT)
- `src/components/{AiSettingsSection,ModelRegistryManager}.tsx` — 設定 UI
- `src/lib/crypto.ts` — API キー暗号化 / `src/lib/url-validate.ts` — public URL 検証 (local は `sanitizeLocalBaseUrl` で別扱い)
- **撤去済 (M5)**: `src/lib/local-llm.ts` (callLocalLlm) / `shouldUseLocalLlmFor` — intent/project_suggest を callLlm に統合し不要化。
