# 道案内 / ルート計算 設計書

## 1. 背景と目的

Yui に「○○まで行く時の所要時間」「電車での乗換」を聞いた時、ルート tool が無いため
**LLM の training data からの想像で答えてしまい、幻覚が起きる**。

実例 (2026-06-03 帰り道):
> ご主人様: 渋谷から末広町に行きたい
> Yui: 銀座線 渋谷駅 → 赤坂見附 → ... (= 乗換 3 回案内)
> 実際: 銀座線 1 本で末広町まで直通 (= 乗換 0 回)

→ Yui に **「公式の経路 API」** を持たせる必要がある。

---

## 2. 制約 (= 重要な事実)

### 2.1 Google Maps Platform の JP transit 限界

| 経路 | server REST で取れる? | JS SDK で取れる? |
|---|---|---|
| Driving (車) | ✓ Routes API | ✓ |
| Walking (徒歩) | ✓ Routes API | ✓ |
| Transit (US, EU 等) | ✓ Routes API | ✓ |
| **Transit (JP)** | **❌ ZERO_RESULTS** | **❌ ZERO_RESULTS** |
| Bicycling | ✓ | ✓ |

JP transit データは Google Maps の **consumer プロダクト (maps.google.com / Google Maps
アプリ)** にのみ存在し、API では提供されていない。Routes API も Directions API も
DirectionsService (JS) も全部不可。

これは確認済みの公式仕様 (2025-08 時点で公式アナウンス、2026-06 現在も継続)。

### 2.2 JP transit を JSON で取れる選択肢

| サービス | コスト | データ形式 | 備考 |
|---|---|---|---|
| Google Maps URL リンク | 無料 | URL のみ | クリック先で正確 |
| 駅すぱあと フリープラン | 無料 | URL のみ | Google Maps と同じ枠 |
| **駅すぱあと スタンダード (従量制)** | **従量** | **JSON 構造化** | **本命**、90 日無料評価あり |
| NAVITIME API | 法人契約 | JSON | 大規模向け、個人不向き |
| ジョルダン API | 商用契約 | JSON | 同上 |

---

## 3. 実装方針 (= 段階移行)

### Phase 1 (実装済、2026-06-03) — driving/walking 構造化 + transit URL fallback

- **driving / walking**: Google Routes API で構造化 (= 所要時間 / 距離 / 混雑判定)
- **transit**: API 呼出スキップ (= JP は必ず ZERO_RESULTS で無駄) →
  **Google Maps deep link** を組み立てて返す
- ご主人様の最初の痛点 (= Yui の幻覚乗換) はこれで完全解消
  → Yui は推測しなくなり、URL リンクをクリックすると Google Maps 本体が正確に案内

### Phase 2 (= 駅すぱあと 90 日評価有効化後) — transit を構造化に格上げ

駅すぱあと スタンダードの 90 日無料評価期間中:
- 設定 > 連携 タブに **「駅すぱあと API キー」** フィールド追加
- `lib/routing.ts` の transit 分岐を駅すぱあと API に差し替え
  - driving / walking は Google Routes API のまま (= 不要に変更しない)
- 駅すぱあと JSON を `RouteSummary.transitSteps` に整形 (= 既存スキーマで吸収)
- formatter は構造化が入れば自動でリッチ表示に切替 (= 現状の fallback URL を上書き)

### Phase 3 (= 90 日評価後) — 従量制 本契約

- 1 ヶ月の使用量で従量単価を駅すぱあとに問い合わせ
- 個人利用の見込み: 月 150-600 リクエスト → 数百円程度の想定
- NAVITIME / ジョルダンとの単価比較 (= もし駅すぱあとが想定以上なら検討)

### Phase 4 (任意・将来) — マップ視覚化

- ReportPanel に **Google Static Maps** で経路画像を表示
- 駅すぱあと では駅・路線情報の API もあるので、簡易マップ自作も可
- Yui voice 「視覚的にお見せしますね」+ ReportPanel に地図 push

---

## 4. データモデル / API

### 4.1 `RouteSummary` (= 全 source 共通スキーマ)

```ts
type RouteMode = "transit" | "driving" | "walking";
type RouteSummary = {
  mode: RouteMode;
  ok: boolean;
  error?: string;
  distanceMeters?: number;
  durationSeconds?: number;
  // transit 構造化 (= 駅すぱあと等で埋まる)
  transitFareYen?: number;
  transitTransfers?: number;
  transitSteps?: Array<{
    line: string;           // "銀座線"
    fromStation: string;
    toStation: string;
    departureTime?: string;
    arrivalTime?: string;
    numStops?: number;
  }>;
  // transit fallback URL (= Phase 1 で transit に入る)
  fallbackUrl?: string;
  hasTraffic?: boolean;
  polyline?: string;
};
```

### 4.2 主要関数 (`src/lib/routing.ts`)

- `getRoute(req: RouteRequest): Promise<RouteResponse>` — 3 モード並列、5 min Valkey cache
- `formatRouteSummary(resp): string` — Yui 向けテキスト整形 (transit は構造化があれば
  ステップ列、無ければ fallback URL を案内)
- `buildMapsTransitUrl(origin, destination): string` — Google Maps deep link

### 4.3 API endpoint

```
GET /api/route?destination=末広町駅&from=渋谷駅&modes=transit,driving,walking
  → { origin, destination, results: RouteSummary[], summary: string, generatedAt }
```

### 4.4 Yui tool

```
get_route(destination, from?, modes?)
  → 「○○までどう行く?」等で呼ぶ
  → from 省略時は env block の現在地 (= getLocation())
  → 推測で transit を答えない (= 必ず本ツールを呼ぶ) ことを description で指示
```

---

## 5. 認証 / 連携設定

### 5.1 Google Maps API key

- **設定 > 連携 タブ** の「道案内用 Google マップ API キー」フィールドで管理
- DB の `integration_settings` テーブルに `key=google_maps_api_key` で保存
- env `GOOGLE_MAPS_API_KEY` も fallback
- 必要な Google Cloud API:
  - **Directions API** (legacy、廃止予定だが残しておく)
  - **Routes API** (= 現状使ってる、driving/walking)
  - **Geocoding API** (= 任意、住所 → 座標)
  - **Maps Static API** (= Phase 4 で経路画像)

### 5.2 駅すぱあと API key (Phase 2)

- 同じ設定画面に **「駅すぱあと API キー」** フィールドを追加 (Phase 2 で)
- `integration_settings` の `key=ekispert_api_key` で保存
- 90 日無料評価版でまず動作確認 → 従量制本契約

---

## 6. プロンプト設計 (= Yui の振る舞い)

`yui-prompt.ts` 追記 (= Phase 1 で実施済):
```
- ルート / 乗換 / 所要時間 を聞かれたら必ず get_route を呼ぶ。
- 推測で「○○線 → △△線で乗換」と答えない (= Yui の training data は不正確)。
- transit (電車) は server で取れないので Google Maps URL リンクを案内する。
  ご主人様にリンクをクリックしていただくスタイル。
- 駅すぱあと API が有効化された後は transit も構造化で答える。
```

---

## 7. 既存資産との関係

| 機能 | 関係 |
|---|---|
| `env block` (現在地 / 時刻) | get_route の from default として位置を使う |
| `Calendar` (予定の集合) | 将来「明日の予定までの経路」を proactive に教える経路として組み合わせ可能 |
| `ReportPanel` | Phase 4 で経路画像 / 視覚マップを push する経路 |
| `Yui tool 群` | get_route は新規 tool、他 tool との独立性高い |
| `integration_settings` | Google Maps key の保管、駅すぱあと key も将来同居 |
| roadmap §8 (Coding Shell) | 関係なし |

---

## 8. 既知の制約 / 注意点

- **JP transit の幻覚を完全に防ぐ仕組み** — Yui prompt + tool description の併用
  で 99% 抑止できるが、たまに sonnet が tool を呼ばずに直答する余地は残る
- **Routes API の departureTime は厳密未来時刻** (= now() + 60s 必須、now() 自体は弾く)
- **transit fallback URL は driving + walking と並んで表示する** ため、見栄えが
  unbalanced (= structured x2 + URL x1)。許容範囲だが、Phase 2 で改善
- **Google Maps API 課金** — 月 $200 free credit 内で個人利用は完全収まる想定
- **駅すぱあと スタンダードは有効化に 3 日程度** (= 公式アナウンス) → 申込時期注意

---

## 9. 関連設計書

- `docs/google-oauth-setup.md` — Google Cloud project の OAuth 設定 (Maps 用ではないが project 共有)
- `docs/roadmap.md` §6.7 / §7 — ReportPanel / 視覚化系
- 将来 `docs/capacitor-app.md` — モバイル版での位置情報 / Maps 連携
