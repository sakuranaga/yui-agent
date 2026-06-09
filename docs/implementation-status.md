# 実装状況とロードマップ

主要 Phase / 機能の完了状況。具体的な設計メモは `docs/roadmap.md` 参照。

---

## 完了済み (= 主要 Phase 一覧)

| 領域 | Phase | 内容 |
|---|---|---|
| **Memory v2** | Phase 1-3 ✓ | retrieval + insert + rolling extraction + reconcile |
| Memory infra | ✓ | observability + decay + cleanup + edit UI + owner split |
| **Notification** | Phase A-E ✓ | toast + state machine + Discord forward + matrix UI |
| **Mail** | Phase A-D ✓ | poll + body fetch + UI + compose modal |
| Mail Classification | Phase 1-4 ✓ | RAG 学習 + 訂正 + 自動アクション + 管理 UI |
| **Health** | Phase 1, 2, 3, 5, 6 ✓ | 食事 / 体重・気分 / ジム / HealthKit / 履歴グラフ |
| **Sleep** | Phase 1-4 ✓ | cognitive shuffle (= schema → runtime engine) |
| **VRM Wardrobe** | Phase 1 ✓ | model registry + 手動切替 |
| **Project Links** | Phase 0-3.5 ✓ | polymorphic M:N + AI suggest + Hub Modal |
| **Intent dispatch** | Phase A-B + 追補 ✓ | cross-tool dispatch + back-link + 連絡先連携 |
| **Multi-provider AI** | Phase 1-2 ✓ | 4 provider router + role 単位差替 |
| **Periodic framework** | ✓ | calendar / mail / news / morning / diary / decay / cleanup / profile-snapshot / reminder-dispatch |
| **Discord bot** | Phase F ✓ | text DM + SSE 受信 |
| **Private mode** | ✓ | Valkey 24h overlay + 即時クリア UI |
| **週間天気** | ✓ | `weather_daily` + Calendar セル表示 |
| **Local LLM routing** | ✓ | extract / reconcile / judge / curate を Gemma に逃がす |
| **Reminders / habits 共通基盤** | ✓ | `reminders` テーブル + dispatch periodic |
| **Phase D セキュリティ** | D1-D3 ✓ | OAuth at-rest 暗号化 + prompt injection 対策 + 例外漏洩 sweep + VRM upload 検証 + 初回セットアップ /setup ウィザード + Sleep BGM upload |
| **LICENSE / CREDITS / CONTRIBUTING / SECURITY** | ✓ | OSS prep の文書整備 (PolyForm-NC 1.0.0) |

---

## 保留 / 未着手

| 項目 | 状態 | ブロック理由 |
|---|---|---|
| Health Phase 4 (= 服薬) | 保留 | 既存 reminders 基盤の上に乗せる設計、未着手 |
| Affinity Phase 1 | 未着手 | 日次曲線 + tone band の env 注入 |
| VRM Wardrobe Phase 2 | 未着手 | walk-out / walk-in 着替え演出 |
| VRM Wardrobe Phase 3 | 未着手 | 時刻ベース自動切替スケジュール |
| **Habits + Proactive** | 6/15 待ち | Agent SDK サブスク解禁待ち (= Opus 直叩きはコスト高) |
| **Doc Agent** | 6/15 待ち | Opus 品質の自動 doc 生成 (= Agent SDK 経由想定) |
| **Deep Research Agent** | 6/15 待ち | 多段ネット探索 + 長文レポート |
| Discord voice (= Phase H) | 未着手 | voice channel での音声対話 |
| Mail Phase E (= 任意) | 未着手 | 添付 / 署名 / template 等の細部 |
| Sleep Phase 5 (= 任意) | 未着手 | VRM 表情連動 / 進捗ログ可視化 (= BGM upload は完了) |
| **道案内 (= transit 構造化)** | 駅すぱあと評価申込待ち | Phase 1 (driving / walking + transit URL fallback) は ✓、JP transit JSON は駅すぱあと スタンダード Phase 2 で実装予定 |
| **Capacitor iOS アプリ** | 設計のみ | WebView + HealthKit / GPS / APNs。3-5 日工数、6/15 以降着手予定 |
| **Tool Registry + Capability Policy** | 設計のみ | OSS 公開後の Phase 2 として実装予定 (= `chat/route.ts` の 53 tool を AgentTool registry に切り出し) |

---

## OSS 公開後のロードマップ (= 戦略ドキュメント由来)

`~/tmp/vroid-strategy-hermes-comparison-2026-06-05.md` で議論した順序:

1. **Tool Registry + Capability Policy** (= `src/lib/agent/tools/` を作成、既存 53 tool に capability tag を付与、timer-mode の allowlist を一般化)
2. **mail-auto-action を pending/review queue 化** (= 学習例 sim≥0.6 ヒット時に直接 TODO / 予定作るのを「user 承認待ち queue」へ)
3. **Vercel AI SDK 導入** (= `callLlm()` の裏を Vercel AI SDK に置換、provider 切替を generic に)
4. **pg-boss worker 切り出し** (= 自律エージェント基盤、`scheduler.ts` の setInterval を pg-boss に置換)
5. **goals + perceive-plan-act-reflect ループ** (= 自律タスク評価)
6. **skills テーブル + reflect による自己改善** (= timers.onFirePrompt + mail-auto-action を「スキル」として一般化)

---

## コスト懸念で保留中 (= Proactive 系)

定期的に LLM 判定するタイプは API 料金的に厳しい:

| 構成 | 月コスト概算 |
|---|---|
| 毎時 Sonnet 判定: 24×$0.05 | ~$36/月 |
| 毎時 Haiku 判定: 24×$0.01 | ~$7/月 |
| ルールベース判定のみ (= LLM 無し)、発火時のみ Yui 1 ターン | ~$1/月 |

最低限の発火はルールベースで安く済むが、「Yui が自律的に状況を見て賢く話しかける」が本領のため、**2026-06-15 の Agent SDK サブスク解禁後** に Pro/Max クレジット経由で Opus を回して実装する想定。

---

## 関連

- `docs/roadmap.md` — 個別機能のラフ設計メモ (= 実装前のスコープ整理)
- `docs/feature-overview.md` — 既存機能の概要
- `docs/architecture.md` — システム構成
