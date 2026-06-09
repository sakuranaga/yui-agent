# CREDITS

Yui Agent (= 本リポジトリ) の **ソースコードは PolyForm Noncommercial 1.0.0** に従います (= `LICENSE` ファイル参照)。

ただし配布物に同梱されている**バンドルアセット** (= 3D アバター、BGM 音源、TTS 参照音声) は、それぞれ独立したライセンスの下で利用されています。本ドキュメントはそれらの attribution と license を一覧したものです。

---

## 3D アバター (VRM モデル)

### `public/girl.vrm`

- **ライセンス**: VRoid Studio 個別利用規約 ([https://policies.pixiv.net/#vroidstudio](https://policies.pixiv.net/#vroidstudio))
- **制作元**: VRoid Studio を用いてプロジェクト所有者が制作
- **構成要素の権利**:
  - 一から創作したテクスチャ / 髪のメッシュ等 → プロジェクト所有者に帰属
  - VRoid Studio 組込の素体 / 衣装メッシュ / プリセットアイテム → ピクシブ株式会社が著作権を保持、ただし利用者に対する販売・改変・配布等の広いライセンスが付与されている
- **再配布同梱の根拠**: VRoid Studio 個別利用規約 §11 により、自作モデルの配布 (商用 / 非商用) が許容されている
- **禁止されている利用**: 本ファイルおよび VRoid Studio 由来素材を用いた **「キャラメイク / アバター出力機能を持つアプリケーション」の第三者向け公開** (= BYO アバター方式 = ユーザが既存 VRM を読み込んで表示する設計はこれに該当しない)

ご主人様自身の VRM を差し替える場合は、設定 → VRM タブから upload してください (= `data/vrm-models/` 配下に保存され、Git 管理外)。

---

## 睡眠サポート BGM

`public/sleep-bgm/` 配下の MP3 ファイルは [Chosic](https://www.chosic.com/) 経由で配布されている **Creative Commons Attribution (CC BY)** ライセンスの楽曲です。ライセンス本文は `public/sleep-bgm/credits/*.txt` に同梱されています。

| ファイル | タイトル | アーティスト | ライセンス | 出典 |
|---|---|---|---|---|
| `bgm_sunset_landscape.mp3` | Sunset Landscape | Keys of Moon ([SoundCloud](https://soundcloud.com/keysofmoon)) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [Chosic](https://www.chosic.com/download-audio/30491/) |
| `bgm_spa_relax.mp3` | Spa Relax | Alex-Productions ([onsound.eu](https://onsound.eu/)) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Chosic](https://www.chosic.com/download-audio/58213/) |
| `bgm_spatium.mp3` | Spatium | Keys of Moon ([SoundCloud](https://soundcloud.com/keysofmoon)) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [Chosic](https://www.chosic.com/download-audio/28307/) |
| `bgm_reverie.mp3` | Reverie | Scott Buckley ([scottbuckley.com.au](https://www.scottbuckley.com.au/)) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [Chosic](https://www.chosic.com/download-audio/37441/) |
| `bgm_mantra.mp3` | MANTRA | Alex-Productions ([onsound.eu](https://onsound.eu/)) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Chosic](https://www.chosic.com/download-audio/42116/) |

楽曲プロモーション: [https://www.chosic.com/free-music/all/](https://www.chosic.com/free-music/all/)

**ご主人様自身が追加 BGM を upload する場合** (= Sleep モーダルの「+ MP3 をアップロード」) は `data/sleep-bgm/` 配下に保存され、Git 管理外。upload 分は本プロジェクトのライセンスとは独立 — ユーザご自身が利用権を持つ音源を upload してください。

---

## TTS 参照音声

`assets/tts-refs/` 配下の WAV ファイルは、TTS サーバ (= [Irodori TTS](https://huggingface.co/Aratako/Irodori-TTS-500M-v3)、Aratako さん作、MIT License) の **Voice Design** モードを使い、シード値からゼロベースで合成したサンプル音声です。

| ファイル | 用途 | 生成方式 |
|---|---|---|
| `cool_seed_7777.wav` | 通常会話用 voice ref | Irodori-TTS Voice Design (seed 7777、参照音声を使わない純合成) |
| `whisper_ref.wav` | 睡眠サポートのささやき用 voice ref | 同上 (whisper スタイルプロンプト) |

- **実在人物の声に基づくクローン音声ではありません** (= Voice Design は text instruction + seed から合成される純合成音声)
- Irodori TTS モデル本体は MIT License 配布のため、出力音声の再配布に関する追加制約はありません

---

## ソフトウェア依存

主な npm パッケージ (= `package.json`) はそれぞれのオープンソースライセンスに従います (MIT / Apache-2.0 / BSD 等)。詳細は `node_modules/<package>/LICENSE` を参照してください。

特に関連の深いもの:
- [Next.js](https://nextjs.org/) — MIT
- [React](https://react.dev/) — MIT
- [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) — MIT (= VRM ロード / レンダリング)
- [Three.js](https://threejs.org/) — MIT
- [Drizzle ORM](https://orm.drizzle.team/) — Apache-2.0
- [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) — MIT

---

## 外部サービス (= 同梱ではなく runtime 依存)

本リポジトリには **同梱されていない** が、`docker-compose up` 時に Docker Hub から
自動 pull される / ユーザご自身で別途用意するサービス。

- **SearXNG** ([searxng.org](https://searxng.org/), AGPL-3.0): Web 検索の自前 instance。
  `docker-compose.yml` 上で `image: searxng/searxng:latest` を指定しているのみで、
  本リポジトリは SearXNG のコード / バイナリを**含まない**。ユーザの docker pull で
  各自取得される。設定ファイル `searxng/settings.yml` だけは本リポジトリ管理 (= Yui Agent
  ライセンスに従う)。AGPL-3.0 の責務は SearXNG イメージを配布する SearXNG project 自身が
  負っており、それを単に利用 / Compose する本プロジェクトは影響を受けない。
- **外部 API** (Anthropic / OpenAI / Google / Spotify / etc): 各 provider の利用規約に
  従ってご主人様自身の API key で利用してください。本プロジェクト自体は API key を含みません。

---

## アセット追加 / 差し替えの方針

配布物としての安全性を保つため、本リポジトリに同梱できるアセットは以下の条件を満たす必要があります:

1. **明示的なライセンスが存在する** (= 出典 URL でライセンスを確認できる)
2. **非商用配布物としての再頒布が認められている** (= 商用 OK / 非商用 OK は問わないが、再配布禁止素材は除外)
3. **attribution 要件がある場合は本ファイルに追記する** (= CC BY 系)

判断に迷う素材は同梱せず、`data/` 配下 (= Git 管理外) にユーザ各自で配置してもらう設計にしてください (= 現状の sleep-bgm upload / vrm upload はこのパターン)。
