# AI 設定タブ 設計書

## 1. 背景と目的

現状、AI まわりの設定はすべて `.env` / `docker-compose.yml` の環境変数で管理:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`, `ANTHROPIC_*_MODEL` (role 別 model override)
- `TTS_URL`
- `EMBED_URL`, `EMBED_MODEL`, `EMBED_DIMENSIONS`
- ローカル LLM (Gemma 等 OpenAI 互換サーバ) のエンドポイント

変更のたびに `.env` 編集 → コンテナ再起動が必要で、

- ご主人様自身が気軽に endpoint / model を差し替えづらい
- 「ローカル LLM 一時停止して Haiku に切り替え」のような運用が手間
- 設定の現状把握が散らかってる (env を grep しないと分からない)

そこで SettingsModal に「**AI**」タブを新設し、UI からまとめて編集可能にする。

### 設計原則

- **env はデフォルト値**: DB 設定があれば優先、無ければ env、無ければハードコード
- **再起動不要**: 殆どの値は次回 LLM call から反映 (キャッシュ 30 秒)
- **シークレットの扱い**: API キーは DB に保存 (個人用前提)、UI ではマスク表示
- **互換性**: 既存コードを段階移行できるよう `getAiSetting(key)` の wrapper を導入

---

## 2. 設定項目

### 2.1 Anthropic

| キー | 説明 | env fallback | 例 |
|---|---|---|---|
| `anthropic_api_key` | API キー (シークレット) | `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `anthropic_main_model` | Yui ターン用モデル (Sonnet) | `ANTHROPIC_MODEL` | `claude-sonnet-4-6` |
| `anthropic_haiku_model` | サブタスク用 (curation/extract 等) | `ANTHROPIC_HAIKU_MODEL` | `claude-haiku-4-5` |

role 別 override (現 env の `ANTHROPIC_EXTRACT_MODEL` 等) は v1 では UI から
出さない。設定は 2 つのみ (main / haiku) で全 role を 2 つにマップする運用に。
細かい role 別差し替えが必要になったら v2 で拡張。

### 2.2 ローカル LLM

| キー | 説明 | env fallback | 例 |
|---|---|---|---|
| `local_llm_url` | OpenAI 互換エンドポイント | `LOCAL_LLM_URL` | `http://llm:8081/v1/chat/completions` |
| `local_llm_model` | モデル ID | `LOCAL_LLM_MODEL` | `gemma-4-26b-a4b` |
| `local_llm_enabled` | 有効/無効 | `LOCAL_LLM_ENABLED` | true/false |

mail curation のような「ローカル優先」用途で使う。enabled=false なら mail-curate
は Anthropic Haiku にフォールバック (`mail_curate_fallback_to_haiku` 設定で
さらに分岐可能、デフォルトは fallback OFF =プライバシー優先で curate 停止)。

### 2.3 TTS

| キー | 説明 | env fallback | 例 |
|---|---|---|---|
| `tts_url` | TTS サーバー base URL | `TTS_URL` | `http://tts-host:7880` |

TTS の voice / engine 切り替えは別 (TTS_DICTIONARY タブで管理してる)。
ここは endpoint のみ。

### 2.4 Embeddings

| キー | 説明 | env fallback | 例 |
|---|---|---|---|
| `embed_url` | エンドポイント | `EMBED_URL` | `http://llm:8082/v1/embeddings` |
| `embed_model` | モデル名 | `EMBED_MODEL` | `bge-m3` |
| `embed_dimensions` | 次元数 (memory_chunks の embedding 列と整合) | `EMBED_DIMENSIONS` | `1024` |

`embed_dimensions` は変更すると既存 vector との互換性が壊れる。UI では
「危険、変更時は memory rebuild が必要」と警告表示し、確認ダイアログを出す。

---

## 3. スキーマ

```sql
CREATE TABLE ai_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,           -- string で統一、必要に応じて caller が parse
  is_secret   BOOLEAN NOT NULL DEFAULT false,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

シンプルな key-value テーブル。型変換は呼び出し側 (`getAiSetting`) で行う。

`is_secret = true` の行は GET API で **マスク済み** ("sk-...***...") で返し、
PUT で「空文字または `***` の場合は変更しない」扱いにする。

---

## 4. 取得 API (server)

```ts
// src/lib/ai-settings.ts
export async function getAiSetting(key: string, fallbackEnv?: string): Promise<string | null> {
  // DB → env → null の順
  // 30 秒キャッシュ
}

// 型付き helper
export async function getAnthropicApiKey(): Promise<string | null> { ... }
export async function getLocalLlmConfig(): Promise<LocalLlmConfig> { ... }
export async function getTtsUrl(): Promise<string> { ... }
export async function getEmbedConfig(): Promise<EmbedConfig> { ... }
```

既存コードは `process.env.X` を直接読んでいる箇所が多いので、段階的に
`getAiSetting` 経由に置き換える。env 直読みのままでもデフォルト動作には影響なし。

---

## 5. HTTP API

```
GET  /api/ai-settings
  → { anthropic_api_key: "sk-ant-***...", anthropic_main_model: "...", ... }
  シークレットはマスク済み

PUT  /api/ai-settings
  body: { anthropic_api_key?: "...", ... }
  シークレット値が "" または "***" なら無変更扱い
  → 200 { ok: true }
```

---

## 6. UI (SettingsModal「AI」タブ)

```
┌─ Anthropic ──────────────────────────────────┐
│ API Key   [sk-ant-***...]    [編集]          │
│ Main      [claude-sonnet-4-6        ▼]      │
│ Haiku     [claude-haiku-4-5         ▼]      │
└──────────────────────────────────────────────┘

┌─ ローカル LLM ───────────────────────────────┐
│ ☑ 有効                                       │
│ URL       [http://llm:8081/v1/chat/...]    │
│ モデル    [gemma-4-26b-a4b              ]   │
│ [接続テスト]  ✓ 応答 ok (512ms)              │
└──────────────────────────────────────────────┘

┌─ TTS ────────────────────────────────────────┐
│ URL       [http://tts-host:7880          ]  │
│ [接続テスト]                                  │
└──────────────────────────────────────────────┘

┌─ Embeddings ─────────────────────────────────┐
│ URL       [http://llm:8082/v1/embeddings ]  │
│ モデル    [bge-m3                        ]  │
│ 次元数    [1024]  ⚠ 変更すると要 rebuild     │
└──────────────────────────────────────────────┘

           [接続テスト一括]   [保存]
```

「接続テスト」は対応 endpoint に簡易リクエストを投げて応答時間を返すだけ:
- Anthropic: `models.list()`
- Local LLM: 短い chat completion
- TTS: HEAD or short synth
- Embed: 短い embed

接続テストは保存前に行える (= 入力した値で試せる)。

---

## 7. 実装フェーズ

### Phase 1 — schema + helper

- DB migration: `ai_settings` table
- `src/lib/ai-settings.ts`: get/put + 30s cache
- まだ UI / API なし、サーバ側 helper だけ

### Phase 2 — API

- `GET /api/ai-settings` (シークレットマスク)
- `PUT /api/ai-settings`
- `POST /api/ai-settings/test/<provider>` 接続テスト

### Phase 3 — UI

- SettingsModal「AI」タブ追加
- 4 つのカード (Anthropic / Local LLM / TTS / Embed)
- 接続テスト + 保存

### Phase 4 — 既存コードの段階移行

- `src/lib/llm.ts`: `process.env.ANTHROPIC_*` → `getAnthropicApiKey()` 経由
- `src/lib/classifier.ts`: env 直読みを setting 経由に
- `src/lib/local-llm.ts` (mail curation 用、これから新規): setting 経由
- `src/app/api/tts/route.ts`: `process.env.TTS_URL` → setting 経由
- `src/db/embed.ts` (or 該当箇所): embed URL/model を setting 経由

このフェーズは挙動を変えない (env のままでも動く) ので、機能追加とは独立に進められる。

---

## 8. 制約・既知の課題

- **embed_dimensions 変更**: vector 列の型と一致しないと SELECT で死ぬ。
  v1 では「保存可能だが警告表示、再起動 + memory rebuild が必要」とする。
  自動 rebuild は v2 で検討。
- **secret 漏洩リスク**: DB ダンプにキーが入る。個人用前提なので許容。
  気になるなら pgcrypto で暗号化保存も可能 (v2)。
- **同時編集なし**: 個人用なので楽観的にロックなし。
- **AI 設定の DB 取得失敗時**: env fallback → ハードコードデフォルトで死活維持。
