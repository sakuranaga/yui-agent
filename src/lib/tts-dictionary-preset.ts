/**
 * TTS 辞書のプリセット (= 初期セットアップ時に DB へ seed する初期エントリ + LLM 正規化の
 * プロンプト内例示にも使う共有定数)。
 *
 * ここの値は **OSS 配布の標準セットアップで誰でも入っていることが期待される最低限**。
 * ユーザー個別の固有名詞や好みの読み方は、結衣に教えて add_pronunciation 経由で
 * 自律登録させるか、設定 → 読み方 から手動追加する想定。
 */

export const TTS_DICTIONARY_PRESET: ReadonlyArray<{ word: string; reading: string }> = [
  // Tech 略語
  { word: "3D", reading: "スリーディー" },
  { word: "2D", reading: "ツーディー" },
  { word: "AI", reading: "エーアイ" },
  { word: "VR", reading: "ブイアール" },
  { word: "AR", reading: "エーアール" },
  { word: "PC", reading: "ピーシー" },
  { word: "OS", reading: "オーエス" },
  { word: "iOS", reading: "アイオーエス" },
  { word: "URL", reading: "ユーアールエル" },
  { word: "API", reading: "エーピーアイ" },
  { word: "DB", reading: "ディービー" },
  { word: "SQL", reading: "エスキューエル" },
  { word: "LLM", reading: "エルエルエム" },
  { word: "TTS", reading: "ティーティーエス" },
  { word: "VRM", reading: "ブイアールエム" },
  { word: "VRMA", reading: "ブイアールエムエー" },
  { word: "SaaS", reading: "サース" },
  { word: "EC", reading: "イーシー" },
  { word: "TODO", reading: "トゥードゥー" },
  { word: "ping", reading: "ピング" },
  { word: "pong", reading: "ポン" },
  // 時刻 / 略号
  { word: "UTC", reading: "ユーティーシー" },
  { word: "JST", reading: "ジェーエスティー" },
  { word: "AM", reading: "エーエム" },
  { word: "PM", reading: "ピーエム" },
  // サービス / ブランド
  { word: "GitHub", reading: "ギットハブ" },
  { word: "Apple Music", reading: "アップルミュージック" },
  { word: "Discord", reading: "ディスコード" },
  { word: "Twitter", reading: "ツイッター" },
  { word: "X", reading: "エックス" },
  { word: "Slack", reading: "スラック" },
  { word: "Notion", reading: "ノーション" },
  { word: "Google", reading: "グーグル" },
  { word: "OpenAI", reading: "オープンエーアイ" },
  { word: "Anthropic", reading: "アンスロピック" },
  { word: "Claude", reading: "クロード" },
  { word: "Sonnet", reading: "ソネット" },
  { word: "Haiku", reading: "ハイク" },
  { word: "Opus", reading: "オーパス" },
  { word: "Yui", reading: "ゆい" },
  // 1 文字記号で TTS が崩れがちなもの
  { word: "vs", reading: "ブイエス" },
  { word: "etc", reading: "エトセトラ" },
];
