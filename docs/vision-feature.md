# Yui の「目」 (Vision Feature) 設計書

## 1. 背景と目的

Yui に **カメラ越しの視覚** を持たせる。ご主人様から「ねぇ、わたし今どう?」「画面のここ
変じゃない?」と聞かれた時、Yui が自分の判断で **その瞬間の 1 フレームを取得**して
画像解析 → 内容を踏まえて応答できるようにする。

- ご主人様の表情 / 服装 / 髪型 のコメント (「あら、お疲れのお顔ですね」)
- 部屋の様子 (「ふふっ、お部屋にゃんちゃんがいますね」)
- 画面のレビュー (「ここの誤字、12 行目です」「このボタンの配置、揃ってませんよ」)
- 写真共有 (本・料理・購入物・観光地)

既存の **画像添付経由** (paste / D&D で `<image>` を attach して送る) はあるが、これは
ご主人様が**自分から**「これ見て」と渡すルート。本機能は **Yui がツールで能動的に
撮影** する点が違う。

---

## 2. 設計の三軸

### 2.1 トリガー (誰が撮影を決めるか)

| 主体 | 方式 | スコープ |
|---|---|---|
| **Yui** (pull) | Yui がツール呼出 → client が 1 frame 撮影 → tool_result に image | **本設計のメイン** |
| **ご主人様** (manual) | 「カメラで撮って」「画面シェアして」明示発話 → Yui が同じツールを呼ぶ | 上と同じ経路 |
| **Yui** (proactive) | Phase G (能動発話) で 「3 時間黙ってる、様子見てみよう」自発撮影 | 将来 (要 §11) |

### 2.2 撮影ソース

| ソース | API | 用途 |
|---|---|---|
| **Webcam** | `getUserMedia({video: true})` | 顔・服装・部屋 |
| **画面** | `getDisplayMedia({video: true})` | UI レビュー・誤字確認・写真共有 |

ツールを `look_at_camera` / `look_at_screen` に分ける。`look(source)` 1 個に統合も
可能だが、Yui が「どっち撮れば?」と毎回 thinking するコストを避けるため別ツール。

### 2.3 ストリーム管理

| モード | stream 状態 | 撮影遅延 | プライバシー |
|---|---|---|---|
| **Always-on** | 設定 ON → permission 取得後 stream 常時保持 | 数 ms (即) | 常時 stream 開きっぱは抵抗あり (ただし送信は撮影時のみ) |
| **On-demand** | tool fire 時に getUserMedia 呼ぶ | 200-800 ms (初期化) | stream は撮影 1 秒だけ |

**MVP は Always-on**。On-demand だと毎回 permission ダイアログ出る OS / ブラウザ
があり UX 厳しい。Always-on でも **送信は tool fire 時の 1 frame のみ**、ローカル
で stream を view するだけなのでサーバには何も流れない。

`<video>` 要素は DOM 上 hidden 配置 (= `display: none` だと一部ブラウザで停止する
ので `visibility: hidden; width: 0; height: 0`)。

---

## 3. アーキテクチャ

### 3.1 全体フロー

```
ご主人様「ねぇ、わたし今どう?」
  ↓ /api/chat POST
Yui (Sonnet) 主ターン
  ├─ tool_use: look_at_camera(reason="ご主人様の様子確認")
  └─ サーバ側ハンドラ:
       ├─ captureId = randomUUID()
       ├─ Valkey: vision-capture:{captureId} = "pending" (TTL 30s)
       ├─ SSE push: { type: "capture_request", captureId, source: "camera", reason }
       └─ poll Valkey 200ms 間隔 × 50 回 (= 10 秒タイムアウト)
            ↑
            ↓ (client 側で並行)
       ├─ Client: SSE 受信 → <video> から canvas 1 frame
       ├─ Client: canvas.toBlob(jpeg, 0.8) → 800px wide にリサイズ
       └─ Client: POST /api/vision/capture/{captureId} (multipart or base64)
            ↓
       ├─ サーバ: Valkey に base64 + meta 格納 → tool 解放
       └─ tool_result content:
            [
              { type: "text", text: "撮影しました (640x480 jpeg)" },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "..." } }
            ]
  ↓ Yui 次 iter (Sonnet が画像見て)
  ├─ text: 「あら、お疲れのお顔ですね…」
  └─ TTS 再生
```

### 3.2 タイムアウト戦略

| 段階 | 上限 | 失敗時 |
|---|---|---|
| Valkey poll | 10 秒 | tool_result: `{text:"カメラから画像が取得できませんでした"}` |
| getUserMedia (on-demand 時のみ) | 3 秒 | client 側で error event → SSE で報告 |
| Anthropic vision processing | API 任せ | ストリーム timeout でリトライ無し |

10 秒待っても client が POST してこなかったら諦める。これは大体 (a) カメラ未許可
(b) tab inactive で SSE が来てない (c) ネットワーク切断 のどれか。

### 3.3 画像サイズと cost

- 800px wide にリサイズ + JPEG quality 0.8
- 1 枚 ≈ 50-100 KB ≈ 1500-2500 vision tokens
- Sonnet 4.6 入力 $3/Mtok: 1 撮影 ≈ $0.005-0.008
- 1 ターンの thinking + 応答込みで $0.01-0.02
- 想定: 1 日 10 撮影 → 月 $3-6

vision cost を抑える設定:
- 大きい画像送る意味がほぼ無い (顔の表情判定なら 640px で充分)
- Anthropic は内部で resize するが、こちらで先に 800 まで落としておく方が cost 確定

---

## 4. データモデル

### 4.1 Valkey キー

```
vision-capture:{captureId}     # value: JSON {status, base64?, mime, width, height, captured_at}
  TTL: 30 秒 (= poll 上限 + 余裕)
```

DB には何も保存しない。撮影画像は揮発、`raw_messages` にも image_data を残さない
(後述 §6 プライバシー)。raw_messages には「Yui が撮影しました (640x480)」のような
meta だけ記録。

### 4.2 ツール定義

```ts
{
  name: "look_at_camera",
  description:
    "ご主人様の webcam から 1 枚撮影してその場で見る。" +
    "「見て」「わたし今どう?」「お部屋どう?」「カメラ確認して」等で呼ぶ。" +
    "結果は撮影完了通知 + 画像本体が返るので、その画像を見て自然に応答する。" +
    "聞かれていないのに撮らないこと (プライバシー)。",
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "撮影理由 (ログ用、20 文字程度)" },
    },
    required: ["reason"],
    additionalProperties: false,
  },
}
```

`look_at_screen` も同じ形 (description だけ変える)。

---

## 5. UI

### 5.1 設定 > 秘書 tab に新規 section

```
カメラ
├── [✓] Yui に webcam を見せる    [状態: 接続中 ●]  [プレビュー ▾]
├── [✓] Yui に画面共有を許可する  [状態: 未起動]
└── 説明:
     ON にすると Yui が「見て」と頼んだ時に 1 枚撮影します。
     stream はブラウザ内に留まり、撮影時の 1 枚だけがサーバに送られます。
     画像は応答後すぐ破棄され、会話履歴には残りません。
```

- トグル ON で permission ダイアログ
- 状態インジケータ (接続中 / 未許可 / 拒否 / カメラ使用中)
- プレビュー: ▾ で hidden `<video>` を可視化 (確認用、デフォルト隠す)
- 拒否されたら設定 OFF に戻す + 「ブラウザの設定で許可してね」案内

### 5.2 撮影時のフィードバック

- 撮影瞬間に chat 上に控えめなトースト: 「Yui が見ています…」 (200ms)
- カメラ icon が 1 秒だけ点灯
- Yui の応答は通常通り tool_result 後の text + TTS で出る

ご主人様にも「今撮ったよ」が分かるように、こっそり撮影は避ける。

---

## 6. プライバシー設計 (重要)

### 6.1 三層防御

1. **Stream はローカル**: 設定 ON でも getUserMedia は browser 内で完結。サーバには
   何も流れない (撮影時の 1 frame 以外)
2. **送信は能動 tool 呼出時のみ**: Yui のツール経由でだけ撮影 → POST
3. **画像は揮発**: Valkey に 30 秒だけ、Anthropic API 呼出後は破棄。`raw_messages` /
   `memory_chunks` に画像は残らない (= 検索 / extract 経由でも漏れない)

### 6.2 撮影記録 (audit log)

`vision_captures` テーブル (任意、Phase 2 で):

```sql
CREATE TABLE vision_captures (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL,
  source        TEXT NOT NULL,     -- "camera" | "screen"
  reason        TEXT NOT NULL,     -- Yui が tool で渡した撮影理由
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  width         INTEGER, height INTEGER,
  bytes         INTEGER
);
```

**image data 自体は保存しない**。撮ったメタだけ。設定 > データ tab で「最近の
撮影履歴」を見られる + 一括 delete も可能。

### 6.3 設定で記録自体を OFF

- 「カメラ撮影の audit log を残す」トグル — 残したくない人向け OFF オプション
- Yui が tool_use を出した時点で client 側で reject も可能 (= 「今は見ないで」ボタン)

### 6.4 集中モード / プライベートモード時の挙動

- **集中モード中**: Yui からの look 呼出を一律 skip (= 集中の邪魔をしない)
- **プライベートモード中**: 撮影自体は可能、ただし audit log にも書かない (Valkey
  overlay と同じ揮発扱い)

---

## 7. ツール呼出側 (Yui への指示)

`yui-prompt.ts` に追記:

```
【視覚 (look_at_camera / look_at_screen) について】
- ご主人様が「見て」「これどう?」「わたし今どう?」「画面確認して」「写真撮って」等
  視覚を求める発話をした時に呼ぶ。
- 聞かれていないのに撮らない (= プライバシー優先、勝手に部屋を撮らない)。
- 撮影が必要かどうか自信が無い時は、撮らずに「お写真お見せいただけますか?」と聞く方を選ぶ。
- 画像が返ってきたら、見たことを当然のように受け止めて自然に応答する。
  「画像が届きました」「拝見しました」のような機械的な前置きは不要。
- camera と screen を間違えない:
  - 顔・服装・部屋・物 → look_at_camera
  - UI・コード・ブラウザ画面・スライド → look_at_screen
- 同じターンで複数回呼ばない。1 回撮ったら充分。
```

---

## 8. 既存資産との関係

| 既存 | 関係 |
|---|---|
| 画像添付 (paste/D&D) | 完全に別経路。ご主人様 → Yui の image はこれが既存。本機能は逆向き (Yui → 自分で撮る) |
| SSE channel | 既存 `/api/chat/stream` をそのまま流用。capture_request イベントを追加するだけ |
| Valkey | overlay と同じ感覚で短期キー + TTL |
| 通知 system | 「Yui が見ています…」トーストは既存 toast 経路で実現可 |
| 集中/プライベートモード | 既存 user_state を check して撮影 skip 判定 |
| キューイング (`enqueueSpeak`) | tool 経由なので main turn 中 = interrupt 系統。queue は関与しない |

---

## 9. API endpoint

| Method | Path | 用途 |
|---|---|---|
| POST | `/api/vision/capture/[id]` | client → server。base64 image を Valkey に格納 |
| GET | `/api/vision/captures?limit=20` | audit log 一覧 (設定 > データ) |
| DELETE | `/api/vision/captures` | audit log 全削除 |

`look_at_camera` 自体は chat/route.ts 内のツールハンドラ。新規 endpoint 不要。

---

## 10. SSE Event 追加

```ts
event: capture_request
data: {
  captureId: "uuid",
  source: "camera" | "screen",
  reason: "ご主人様の様子確認",
  timeoutMs: 10000
}
```

client 側 handler:
1. 設定 OFF / permission 無し → POST `/api/vision/capture/{id}` with `{error: "permission_denied"}`
2. OK → frame capture → resize → POST base64

---

## 11. 将来拡張

### 11.1 Proactive 撮影 (Phase G 後)

- 集中モード抜けた瞬間に Yui が「お疲れさまですね」と言いつつ撮影 → 表情に応じてコメント
- 朝のブリーフィング時に「おはようございます」と挨拶撮影 → 寝起き判定 → 励ます
- リマインダー fire 時に「お薬の時間ですよ、撮影もしておきますね」(医療連動)

### 11.2 動画 / 連続撮影

- 1 frame でなく 1-2 秒の短いクリップ (= 動き / 表情変化を拾う)
- ただし vision API は静止画前提なので、複数 frame を batch 送るしかなく cost 増

### 11.3 物体認識 / OCR

- 「この本の表紙、何の本?」→ 撮影 → vision でタイトル抽出 → wishlist / 読書記録に登録
- 「このレシート何?」→ OCR → 食事 / 家計簿連動

### 11.4 顔認識ベースの感情判定

- 表情 → 感情 5 段階推定 → mood_1to5 に自動記録 (= body_metrics)
- ただし精度と pricacy の trade-off は要設計

### 11.5 マルチカメラ対応

- 部屋カメラ + USB ウェブカメラ等の deviceId 切替 (`enumerateDevices` API)
- どちらを撮るかは tool 引数 `device_hint` で

---

## 12. 実装フェーズ

### Phase 1 — 設計書 (= 本ドキュメント) ✓

### Phase 2 — 基本撮影 (camera のみ)
- 設定トグル + permission 取得 UX
- `<video>` stream + canvas capture utility
- `look_at_camera` tool + SSE capture_request + Valkey 仲介 + tool_result image block
- 撮影瞬間のトースト
- `yui-prompt` に視覚ガイダンス追記

### Phase 3 — 画面共有
- `getDisplayMedia` で screen 取得
- `look_at_screen` tool 追加
- 画面共有は session ごとに ON/OFF (browser 仕様、permission 揮発)

### Phase 4 — Audit log
- `vision_captures` テーブル + endpoint
- 設定 > データ tab に「撮影履歴」section

### Phase 5 — Proactive (Phase G 統合)
- 集中モード明け / 朝の挨拶 / リマインダー時の自発撮影
- 「撮影必要?」を Haiku judge で事前判定

### Phase 6 (任意) — 拡張
- OCR ベースの自動記録 (本・レシート・領収書)
- 表情 → 感情自動記録
- マルチカメラ対応

---

## 13. 既知の制約 / 注意点

- **HTTPS 必須**: getUserMedia は HTTPS でしか動かない (localhost は例外)。本番運用なら証明書要る
- **ブラウザ差**: Safari の getUserMedia は autoplay 制約が厳しめ。user gesture が必要な場合あり
- **AudioContext と同じ問題**: 初回は必ず user の click を経由しないと stream 開始できない
- **Discord bot は対応外**: web only。bot 側で image attach 経路は別 (将来 text-only bot がカメラ tool 呼ぶには別設計が要る)
- **multiple browser tab**: 2 つ tab 開いてたら 2 つの session が同じカメラを取り合う可能性 → permission API は OS 任せ
- **vision token cost**: 1 撮影 $0.005-0.008、proactive で 1 日 50 回打つと月 $7-12

---

## 14. 関連設計書

- `docs/roadmap.md` §3 (Habits + Proactive) — Phase 5 の上位設計
- `docs/notification-system.md` — 撮影瞬間のトースト経路で再利用
- `docs/health-tracking.md` — Phase 6 で表情 → mood 連動の素地
