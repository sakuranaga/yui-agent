# Capacitor ネイティブアプリ 設計書

## 1. 背景と目的

Yui の現状は Web アプリ + Discord bot の 2 surface 構成だが、以下の **phone-native
機能** が取れない:

| 機能 | 現状 | 課題 |
|---|---|---|
| HealthKit (歩数 / 心拍 / 睡眠) | iOS Shortcut 手動 | 毎日手動キックは負担、自動化に Capacitor 必須 |
| 位置情報 | ブラウザ getCurrentPosition | 外出中 Mac 開けない、phone GPS が要る |
| プッシュ通知 | Web 通知 only | OS 通知センター / lock screen に出ない |
| マップ系 transit | server REST 不可 | Maps SDK ネイティブで実現可能性あり (要検証) |
| 「ポケットに Yui」感 | Mac 必須 | 外出時は Yui に話しかけられない |

Capacitor アプリを作れば **Web の UI (VRM / Chat / ヘルス画面 / 設定) を WebView
で表示しつつ、ネイティブ API (HealthKit / GPS / Push) を bridge 経由で叩ける**。

「**サーバ + UI は丸ごと既存 Web 流用、ネイティブ機能だけ薄く足す**」のが Capacitor の
最大利点。

---

## 2. 設計の核

### 2.1 Capacitor アプリ構成

```
Capacitor iOS App (.ipa)
  ├─ WebView (= Yui Web を全画面表示)
  │    既存 src/app/* がそのまま動く (VRM / Chat / Settings 等)
  ├─ Capacitor Bridge (= native ↔ JS の橋)
  └─ Native Plugins
       ├─ Geolocation (= 位置情報、background 対応)
       ├─ HealthKit (= ヘルスデータ読取 → POST /api/health/import)
       ├─ PushNotifications (= APNs 経由)
       └─ App lifecycle (= Background fetch、wake on push)
```

### 2.2 Server 側のスタンス

**サーバは Capacitor アプリと Web ブラウザを区別しない**。両方とも同じ Yui Web を
読みに来る HTTP クライアント。差は:
- Capacitor アプリは User-Agent に `Yui-Capacitor/1.0` を付ける
- Native 機能由来のデータは既存の `POST /api/health/import` / `POST /api/location`
  経由でサーバに流れる (= プロトコルは既存と互換)

これで「サーバには Capacitor 専用の特殊な分岐をほぼ作らずに済む」。

### 2.3 通知経路の統合

| 経路 | 現状 | Capacitor 後 |
|---|---|---|
| お便りバッジ (Web) | SSE → DOM toast | 変わらず |
| Discord forward | Discord bot via Webhook | 変わらず |
| **iOS 通知** | **無し** | **APNs 経由でロック画面 / 通知センターに表示** |

サーバ側で `saveNotification` から派生する経路に「APNs 配信」を追加するだけ。
- `notification_settings` の matrix に「iOS push」mode を追加 (= 既存の speak / notify
  / silent に並ぶ第 4 mode)

---

## 3. データモデル / API 追加

### 3.1 `push_devices` (Capacitor デバイスの APNs token 登録)

```sql
CREATE TABLE push_devices (
  id          BIGSERIAL PRIMARY KEY,
  platform    TEXT NOT NULL,            -- "ios" | "android"
  device_id   TEXT NOT NULL,            -- アプリ生成の安定 ID
  apns_token  TEXT,                     -- iOS の場合のみ
  fcm_token   TEXT,                     -- Android の場合のみ
  user_agent  TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, device_id)
);
```

### 3.2 API endpoints (新規)

| Method | Path | 用途 |
|---|---|---|
| POST | `/api/push/register` | アプリ起動時に token 登録 |
| POST | `/api/push/unregister` | サインアウト / アンインストール検知時 |
| POST | `/api/push/test` | (内部 / 設定 tab) テスト通知送信 |

既存 endpoints の流用:
- `POST /api/health/import` (= HealthKit データ受け口、既存) — Capacitor が定期実行
- `POST /api/location` (= 位置情報、既存) — 同上、background でも投げる

---

## 4. ネイティブ Plugin の使い方

### 4.1 Geolocation (background)

```ts
import { Geolocation } from '@capacitor/geolocation';

// foreground
const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
// → POST /api/location

// background (= アプリ閉じてても定期取得、要 permission)
// → @capacitor-community/background-geolocation または専用 plugin
```

### 4.2 HealthKit

`capacitor-health` or 自作 plugin:
- 起動時 + 1 時間 background fetch で最新 24h を取得
- 既存 `/api/health/import` に流す
- `iOS Shortcut` 経路は廃止 (= docs/health-tracking.md Phase 5 を Capacitor 経由に移行)

### 4.3 PushNotifications (APNs)

```ts
import { PushNotifications } from '@capacitor/push-notifications';

PushNotifications.requestPermissions().then(p => {
  if (p.receive === 'granted') PushNotifications.register();
});
PushNotifications.addListener('registration', token => {
  // POST /api/push/register { platform: 'ios', apns_token: token.value, device_id: ... }
});
PushNotifications.addListener('pushNotificationReceived', notif => {
  // フォアグラウンドで来た場合 (= 通常は OS が処理)
});
PushNotifications.addListener('pushNotificationActionPerformed', action => {
  // 通知タップ時、deep link で該当 modal を開く
});
```

### 4.4 App lifecycle

- 起動 / バックグラウンド復帰時に最新位置 + HealthKit を吸い上げる
- Background fetch で 1 時間ごとに同期 (= バッテリー観点で短くしすぎない)

---

## 5. サーバ側の差分

### 5.1 通知ハブの拡張

```ts
// 既存 saveNotification の最後で:
if (shouldDispatchPush(rule, userState)) {
  await dispatchToApns(devices, title, body, payload);
}
```

- APNs 送信は `web-push` ライブラリ / 自前 HTTP/2 client
- 認証は Apple Auth Key (= MusicKit / WeatherKit と同じ .p8 形式、別 key)

### 5.2 通知設定 UI 拡張

設定 > 通知 tab のマトリックスに **「iOS push」モード** を追加 (= speak / notify /
silent と並列)。kind × user_state ごとに「ロック画面まで届けるか」設定可能。

---

## 6. UI / UX 配慮

### 6.1 WebView の挙動調整

- ステータスバーの色を VRM テーマに合わせる (= Capacitor の StatusBar plugin)
- スワイプバック無効 (= 誤操作で前ページに戻る事故防止)
- Pinch to zoom OFF (= VRM 視点で zoom はジェスチャー干渉)
- Safe area (notch / home indicator) 対応

### 6.2 アプリ起動時 splash

- VRM ロード完了まで native splash で隠す (= WebView が真っ白になるのを避ける)
- Splash image はキャラ立ち絵推奨

### 6.3 オフライン挙動

- Service Worker で最小限のオフライン UI を表示 (= 「サーバに繋がってません」案内)
- 位置情報・HealthKit はキャッシュして再接続時に flush

---

## 7. 配布方法

### 7.1 TestFlight (個人用)

- Apple Developer Program ($99/年、既に MusicKit / WeatherKit で持ってる)
- Xcode で archive → App Store Connect → TestFlight
- ご主人様の iPhone 1 台だけインストール (= 個人内部利用)
- 90 日ごとに再配布 (TestFlight 制約)

### 7.2 (将来) App Store 公開

- 単独ユーザー前提のため Store 公開は想定外
- もし家族 / 友人にも使わせるならその時に審査対応

---

## 8. セキュリティ

### 8.1 認証

- 現状の Web は単独ユーザー前提で sessionId だけ
- Capacitor 経由でも同じ sessionId が使える (= localStorage が WebView 内で永続)
- ただし「外出中に iPhone 紛失したら他人が触れる」リスクがあるので
  - Face ID / Touch ID で起動時ロック (= Capacitor の Biometric plugin)
  - Lock 解除しないと WebView 表示しない

### 8.2 サーバ接続先

- 自宅サーバなら VPN (Tailscale 等) 経由が無難
- 公開サーバなら HTTPS 必須 + API key / Bearer token で push endpoint を保護

---

## 9. 実装フェーズ

### Phase 1 — Capacitor 雛形 + WebView だけ動く
- `npx cap init` で iOS project 生成
- WebView の URL を Yui Web に設定
- Xcode でビルド → iPhone 実機で起動確認
- 所要: 半日

### Phase 2 — Geolocation + HealthKit ブリッジ
- 各 Plugin の permission UX
- Background fetch 設定
- 既存 API endpoint (`/api/location`, `/api/health/import`) に流す
- 所要: 1 日

### Phase 3 — Push 通知
- APNs auth key 取得 (= Apple Developer で発行)
- `push_devices` テーブル + register/unregister endpoint
- `saveNotification` から APNs dispatcher 経由
- 通知設定 UI に「iOS push」mode 追加
- 所要: 1-2 日

### Phase 4 — Polish + 配布
- Splash / icon / status bar / safe area
- Biometric ロック
- TestFlight 申請 → 内部配布
- 所要: 1 日

### Phase 5 (任意) — Yui からの能動 push
- リマインダー基盤 (= docs/reminders-system.md) と連動
- 「お薬の時間です」「Discord で会食何時か聞かれてますよ」等が iOS 通知で届く
- = Phase G (Proactive Autonomy) の出口の 1 つ

**合計**: 3-5 日。6/15 後の比較的早い時期に着手したい。

---

## 10. 既存資産との関係

| 機能 | 関係 |
|---|---|
| Web 全画面 (VRM / Chat / 設定 / ヘルス etc.) | 100% 再利用 (WebView 表示) |
| `/api/health/import` | Capacitor の HealthKit plugin から呼ぶ |
| `/api/location` | 同、Geolocation plugin から呼ぶ |
| `notification_settings` | 「iOS push」mode 追加 |
| `iOS Shortcut` (= docs/health-tracking.md Phase 5) | **廃止** — Capacitor 経路で置換 |
| Discord bot | 別 surface として共存 |

---

## 11. 既知の制約 / 注意点

- **iOS 専用 (= Android はやらない)** ご主人様が iPhone 利用者のため、Android 対応
  はスコープ外。Capacitor は将来 Android にも対応可能
- **HealthKit データ細目** — 全種類取れるが、デフォは歩数 / 活動 kcal / 運動 / 睡眠 /
  心拍 / SpO₂ に絞る
- **Background fetch の頻度制限** — iOS は 1 時間に 1 回程度が上限、毎分は不可
- **TestFlight 90 日制約** — 内部配布も 90 日ごとに再配布必要。年 4 回更新
- **VRM のパフォーマンス** — iPhone WebView での 3D 描画は重い可能性、解像度や FPS を
  iPhone 専用に下げる検討
- **VRM のドラッグ / スワイプ干渉** — タッチ操作で VRM 視点とブラウザナビが競合する
  ので Capacitor の Gesture Handler で調整

---

## 12. 関連設計書

- `docs/health-tracking.md` Phase 5 — iOS Shortcut 経路、Capacitor 移行で廃止予定
- `docs/notification-system.md` — APNs mode 追加先
- `docs/routing-guidance.md` — 道案内、Capacitor 上で動かす時の位置情報精度が上がる
- `docs/reminders-system.md` (Phase 4) — リマインダー → iOS push の出口
