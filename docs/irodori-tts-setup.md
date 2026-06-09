# Irodori-TTS サーバ セットアップガイド

ローカルで Irodori-TTS を HTTP API として立ち上げる手順書です。
複数のアプリ（Python / Next.js / Discord bot 等）から同じ TTS インスタンスを共有でき、声は参照音声で固定できます。

実測値はすべて **RTX 3090 / Ubuntu 24.04 / Python 3.10 / PyTorch 2.10+cu128** での値です。

```
クライアント ──HTTP POST {text:"…"}──▶ TTS Server (FastAPI, :7880)
                                             │
                                             ▼
                                       Irodori-TTS (Python, GPU)
                                             │
                                             ▼
                                       wav バイナリ
```

---

## 目次

1. [必要スペック](#1-必要スペック)
2. [セットアップ手順](#2-セットアップ手順)
3. [サーバの起動](#3-サーバの起動)
4. [リファレンス音声で声を固定する](#4-リファレンス音声で声を固定する)
5. [クライアント側の使い方](#5-クライアント側の使い方)
6. [リクエストパラメータ全フィールド](#6-リクエストパラメータ全フィールド)
7. [トラブルシューティング](#7-トラブルシューティング)
8. [ファイル構成（最終形）](#8-ファイル構成最終形)
9. [パフォーマンス実測表](#9-パフォーマンス実測表)
10. [参考リンク](#10-参考リンク)

---

## 1. 必要スペック

### ハードウェア

| 項目 | 最低 | 推奨 | 我々のテスト機 |
|---|---|---|---|
| GPU | NVIDIA CUDA 対応・VRAM 5GB 以上 | 6GB+ の空き | RTX 3090 (24GB) |
| メモリ | 8 GB | 16 GB | 64 GB |
| ディスク | 5 GB | 10 GB | — |

実測 VRAM 使用量:
- 常駐: **約 3.7 GB**
- 合成中ピーク: **5〜6 GB**

### ソフトウェア
- **OS**: Linux（Ubuntu 22.04 / 24.04 で動作確認）
- **Python**: **3.10 以上**（Irodori-TTS は `>=3.10` を要求）
- **NVIDIA Driver**: CUDA 12.x 対応（CUDA 12.8 でテスト済）
- **uv**: 0.11+ 推奨（素の pip でも可）
- **git**, **build-essential**

### ネットワーク
- 初回起動時に HuggingFace から約 **1.5 GB のモデル**をダウンロード
- 以降はオフラインでも動作

---

## 2. セットアップ手順

### 2.1 前提パッケージ

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install -y git build-essential curl

# NVIDIA ドライバが入っていることを確認
nvidia-smi    # GPU 情報が表示されれば OK
```

### 2.2 uv のインストール

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"   # ~/.bashrc にも追記すると吉
uv --version                            # 0.11.x 以上
```

### 2.3 Irodori-TTS のチェックアウトと venv 構築

```bash
mkdir -p ~/dev
cd ~/dev
git clone https://github.com/Aratako/Irodori-TTS.git
cd Irodori-TTS

# venv 作成 + 依存解決
uv sync
```

`uv sync` で `.venv/` が作られ、PyTorch (CUDA 12 系)、Irodori-TTS の依存パッケージが全部入ります。
**約 5 分**かかります（torch だけで 3 GB ほど DL）。

### 2.4 動作確認（CUDA が見えるか）

```bash
.venv/bin/python - <<'EOF'
import torch
print("torch:", torch.__version__)
print("cuda available:", torch.cuda.is_available())
print("device:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "(CPU only)")
EOF
```

期待される出力（例）:
```
torch: 2.10.0+cu128
cuda available: True
device: NVIDIA GeForce RTX 3090
```

`cuda available: False` の場合は NVIDIA ドライバが入っていないか、PyTorch の CUDA ビルドが噛み合っていません。
→ [トラブルシューティング](#7-トラブルシューティング)。

### 2.5 TTS サーバ用ディレクトリ作成

Irodori-TTS の隣に薄い HTTP ラッパを置きます。

```bash
mkdir -p ~/dev/irodori-tts-server/companion
mkdir -p ~/dev/irodori-tts-server/voices
cd ~/dev/irodori-tts-server
touch companion/__init__.py
```

### 2.6 ソースコードを作成

#### 2.6.1 `companion/tts.py`

Irodori-TTS の `InferenceRuntime` を薄くラップして lazy load します。

```bash
cat > ~/dev/irodori-tts-server/companion/tts.py <<'EOF'
"""Irodori-TTS wrapper.

Loads the Irodori-TTS v3 checkpoint once and keeps the runtime warm in VRAM.
"""

from __future__ import annotations

import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Irodori-TTS はソースツリーから import するので、リポジトリ root を sys.path に。
# IRODORI_TTS_REPO 環境変数で上書き可。
_IRODORI_REPO = Path(
    os.environ.get(
        "IRODORI_TTS_REPO",
        Path(__file__).resolve().parents[2] / "Irodori-TTS",
    )
).expanduser()
if _IRODORI_REPO.is_dir() and str(_IRODORI_REPO) not in sys.path:
    sys.path.insert(0, str(_IRODORI_REPO))

from huggingface_hub import hf_hub_download  # noqa: E402
from irodori_tts.inference_runtime import (  # noqa: E402
    InferenceRuntime,
    RuntimeKey,
    SamplingRequest,
    save_wav,
)


@dataclass
class TTSConfig:
    model_repo: str = "Aratako/Irodori-TTS-500M-v3"
    codec_repo: str = "Aratako/Semantic-DACVAE-Japanese-32dim"
    model_device: str = "cuda"
    codec_device: str = "cuda"
    model_precision: str = "bf16"   # fp32 / bf16
    codec_precision: str = "fp32"


class IrodoriTTS:
    """Lazily-loaded, process-lifetime cache of an Irodori-TTS runtime."""

    def __init__(self, config: TTSConfig | None = None) -> None:
        self.config = config or TTSConfig()
        self._runtime: InferenceRuntime | None = None

    def is_loaded(self) -> bool:
        return self._runtime is not None

    def load(self) -> None:
        if self._runtime is not None:
            return
        checkpoint = hf_hub_download(
            repo_id=self.config.model_repo, filename="model.safetensors"
        )
        key = RuntimeKey(
            checkpoint=checkpoint,
            model_device=self.config.model_device,
            codec_repo=self.config.codec_repo,
            model_precision=self.config.model_precision,
            codec_device=self.config.codec_device,
            codec_precision=self.config.codec_precision,
        )
        self._runtime = InferenceRuntime.from_key(key)

    def synthesize(
        self,
        text: str,
        *,
        seed: int | None = None,
        num_steps: int = 40,
        cfg_scale_text: float = 3.0,
        cfg_scale_speaker: float = 5.0,
        duration_scale: float = 1.0,
        ref_wav: str | None = None,
    ) -> tuple[str, int]:
        """Synthesize speech; return (wav_path, used_seed)."""
        self.load()
        assert self._runtime is not None

        request = SamplingRequest(
            text=text,
            no_ref=ref_wav is None,
            ref_wav=ref_wav,
            seed=seed,
            num_steps=num_steps,
            cfg_scale_text=cfg_scale_text,
            cfg_scale_speaker=cfg_scale_speaker,
            duration_scale=duration_scale,
        )
        result = self._runtime.synthesize(request, log_fn=None)

        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        save_wav(tmp.name, result.audio, result.sample_rate)
        return tmp.name, int(result.used_seed)
EOF
```

#### 2.6.2 `tts_server.py`

FastAPI で `/tts`, `/load`, `/health` を提供。`--voice-ref` で声を固定。

```bash
cat > ~/dev/irodori-tts-server/tts_server.py <<'EOF'
#!/usr/bin/env python3
"""Standalone Irodori-TTS HTTP server.

  POST /tts       JSON: {text, seed?, num_steps?, cfg_scale_text?,
                         cfg_scale_speaker?, duration_scale?, ref_wav?}
                  Response: audio/wav body. X-Used-Seed header echoes the seed.
  POST /load      Pre-warm the Irodori runtime (loads model into VRAM).
  GET  /health    {status, loaded}
"""

from __future__ import annotations

import argparse
import os

import uvicorn
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from companion.tts import IrodoriTTS

TTS = IrodoriTTS()
_DEFAULT_REF_WAV: str | None = None

app = FastAPI(title="Irodori-TTS Server", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Text to synthesize.")
    seed: int | None = Field(None, description="Sampling seed; null = random.")
    num_steps: int = 40
    cfg_scale_text: float = 3.0
    cfg_scale_speaker: float = 5.0
    duration_scale: float = 1.0
    ref_wav: str | None = Field(
        None,
        description="Per-request reference WAV path (overrides server default).",
    )


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "loaded": TTS.is_loaded()}


@app.post("/load")
def load() -> dict:
    try:
        TTS.load()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"load failed: {exc}")
    return {"loaded": True}


@app.post("/tts")
def tts(req: TTSRequest) -> Response:
    ref_wav = req.ref_wav if req.ref_wav is not None else _DEFAULT_REF_WAV
    try:
        wav_path, used_seed = TTS.synthesize(
            req.text,
            seed=req.seed,
            num_steps=req.num_steps,
            cfg_scale_text=req.cfg_scale_text,
            cfg_scale_speaker=req.cfg_scale_speaker,
            duration_scale=req.duration_scale,
            ref_wav=ref_wav,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"synthesis failed: {exc}")

    try:
        with open(wav_path, "rb") as fh:
            data = fh.read()
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass

    return Response(
        content=data,
        media_type="audio/wav",
        headers={"X-Used-Seed": str(used_seed)},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Irodori-TTS HTTP server.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=7880)
    parser.add_argument(
        "--voice-ref",
        default=None,
        help="Reference WAV path. When set, every /tts call returns this voice "
        "regardless of seed or text. Per-request ref_wav overrides this.",
    )
    args = parser.parse_args()

    global _DEFAULT_REF_WAV
    _DEFAULT_REF_WAV = args.voice_ref
    if _DEFAULT_REF_WAV:
        if not os.path.isfile(_DEFAULT_REF_WAV):
            raise SystemExit(f"--voice-ref file not found: {_DEFAULT_REF_WAV}")
        print(f"[voice-ref] fixing voice from: {_DEFAULT_REF_WAV}", flush=True)

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
EOF
```

---

## 3. サーバの起動

### 3.1 まず素で起動（声は seed 駆動）

```bash
cd ~/dev/irodori-tts-server
~/dev/Irodori-TTS/.venv/bin/python tts_server.py --port 7880
```

初回はモデル DL のため 30 秒程度のロード時間あり。
`Uvicorn running on http://0.0.0.0:7880` が出たら OK。

### 3.2 動作確認

別ターミナルで:
```bash
# ヘルスチェック
curl http://localhost:7880/health
# → {"status":"ok","loaded":false}

# モデルをロード (6〜10秒)
curl -X POST http://localhost:7880/load
# → {"loaded":true}

# 合成 (~0.5秒)
curl -X POST http://localhost:7880/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"こんにちは、テストです"}' \
  -o test.wav
file test.wav
# → RIFF (little-endian) data, WAVE audio, ...
```

ブラウザで http://localhost:7880/docs を開くと FastAPI 自動ドキュメントから対話的に叩けます。

### 3.3 バックグラウンドで動かす（簡易版）

```bash
nohup ~/dev/Irodori-TTS/.venv/bin/python \
  ~/dev/irodori-tts-server/tts_server.py --port 7880 \
  > ~/tts_server.log 2>&1 &
```

止めるとき:
```bash
pkill -f 'tts_server.py'
```

### 3.4 systemd で常駐させる（推奨・本番運用向け）

ユーザ単位の systemd service を作成:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/irodori-tts.service <<'EOF'
[Unit]
Description=Irodori-TTS HTTP server
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/dev/irodori-tts-server
Environment=PATH=%h/dev/Irodori-TTS/.venv/bin:/usr/bin:/usr/local/bin
ExecStart=%h/dev/Irodori-TTS/.venv/bin/python %h/dev/irodori-tts-server/tts_server.py --port 7880 --voice-ref %h/dev/irodori-tts-server/voices/reference.wav
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable irodori-tts.service
systemctl --user start irodori-tts.service
systemctl --user status irodori-tts.service

# 再ログインせずにユーザサービスを動かしたい
loginctl enable-linger $USER
```

ログ確認: `journalctl --user -u irodori-tts.service -f`

---

## 4. リファレンス音声で声を固定する

Irodori-TTS の v3 モデルは、参照音声を渡すと **その声を全ての発話で再現**します。
**シードだけでは声を固定できない**（テキスト長で勝手に変わる）ため、声の同一性が必要なら必ず参照音声方式にしてください。

### 4.1 リファレンス候補を作る

サーバ起動中の状態で:

```bash
mkdir -p ~/dev/irodori-tts-server/voices
SAMPLE='そう、その気持ちは分かりますよ。慌てなくて大丈夫。ゆっくり、自分のペースで進めばいいんですから。'

for s in 5 39 77 150 280 470 1500 7777; do
  curl -s -X POST http://localhost:7880/tts \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"$SAMPLE\",\"seed\":$s}" \
    -o ~/dev/irodori-tts-server/voices/candidate_seed_$(printf '%04d' $s).wav
done

ls ~/dev/irodori-tts-server/voices/
```

8個 wav ができます。各シードで違う声色になります。気に入らなければシード集合を変えて再実行（`5 39 77 …` の部分）。

### 4.2 聴き比べて1つ選ぶ

クライアント側マシンへ転送して再生:
```bash
scp '<host>:~/dev/irodori-tts-server/voices/*.wav' ~/Downloads/
```

好きな候補を「マスターリファレンス」としてリネーム:
```bash
cp ~/dev/irodori-tts-server/voices/candidate_seed_7777.wav \
   ~/dev/irodori-tts-server/voices/reference.wav
```

### 4.3 そのリファレンスで起動

```bash
~/dev/Irodori-TTS/.venv/bin/python tts_server.py \
  --port 7880 \
  --voice-ref ~/dev/irodori-tts-server/voices/reference.wav
```

起動ログに次が出れば OK:
```
[voice-ref] fixing voice from: /…/voices/reference.wav
```

以降、**全ての `/tts` 呼び出しが reference.wav の声で返ってきます**（テキスト・シード問わず）。

### 4.4 リクエスト単位で別の声に切り替え

ボディに `ref_wav` を入れるとその1回だけ別ファイルを使えます:

```bash
curl -X POST http://localhost:7880/tts \
  -H 'Content-Type: application/json' \
  -d '{
    "text":"こんにちは",
    "ref_wav":"/absolute/path/to/another_voice.wav"
  }' \
  -o out.wav
```

優先順位: `リクエストの ref_wav` > `--voice-ref` > なし(no_ref)

### 4.5 注意点

- リファレンスは **5 秒以上（できれば 10 秒前後）** を推奨。短すぎると安定性が下がる。
- 単一話者の wav であること。複数話者混在は声が混じる。
- リファレンスはリクエストごとに読み込まれます（数十 ms オーバーヘッド）。1秒未満の合成時間に対して無視できる程度。

---

## 5. クライアント側の使い方

### 5.1 Python（同期）

```python
import httpx

TTS_URL = "http://localhost:7880"

def synthesize(text: str) -> bytes:
    r = httpx.post(f"{TTS_URL}/tts", json={"text": text}, timeout=60)
    r.raise_for_status()
    return r.content  # audio/wav

open("out.wav", "wb").write(synthesize("こんにちは"))

# その場で再生（要: pip install sounddevice soundfile）
import io, soundfile as sf, sounddevice as sd
data, sr = sf.read(io.BytesIO(synthesize("やっほー")))
sd.play(data, sr); sd.wait()
```

### 5.2 Python（非同期 / Discord bot や FastAPI 用）

```python
import httpx

async def synthesize(text: str) -> bytes:
    async with httpx.AsyncClient(timeout=60) as cli:
        r = await cli.post("http://localhost:7880/tts", json={"text": text})
        r.raise_for_status()
        return r.content
```

### 5.3 Next.js / ブラウザ（クライアントから直接 fetch）

CORS は `*` 許可済み、wav は Blob → `<audio>` で再生できます。

```tsx
"use client";
import { useState } from "react";

const TTS_URL = process.env.NEXT_PUBLIC_TTS_URL ?? "http://localhost:7880";

export default function SpeakButton({ text }: { text: string }) {
  const [loading, setLoading] = useState(false);

  async function speak() {
    setLoading(true);
    try {
      const res = await fetch(`${TTS_URL}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } finally {
      setLoading(false);
    }
  }

  return <button onClick={speak} disabled={loading}>{loading ? "…" : "🔊"}</button>;
}
```

### 5.4 Next.js Route Handler 経由

ブラウザ → TTS 直叩きの落とし穴:

1. **HTTPS ページから HTTP TTS への mixed content ブロック**（本番デプロイで発生）
2. TTS サーバを LAN 内部に閉じたまま外部に出さないケース

そのときは Next.js 側にプロキシを置きます:

```ts
// app/api/tts/route.ts
export async function POST(req: Request) {
  const body = await req.json();
  const r = await fetch("http://localhost:7880/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(r.body, {
    status: r.status,
    headers: { "Content-Type": "audio/wav" },
  });
}
```

クライアントは `/api/tts` を叩くだけ。同一オリジンなので mixed content 問題なし、CORS も無関係に。

### 5.5 curl（動作確認・スクリプト用）

```bash
curl -X POST http://localhost:7880/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"テストです"}' \
  -o out.wav
```

---

## 6. リクエストパラメータ全フィールド

```jsonc
{
  "text": "合成したいテキスト",       // 必須
  "seed": null,                        // null = ランダム。ref_wav 固定なら通常 null
  "num_steps": 40,                     // 大きいほど高品質・遅い (8〜80)
  "cfg_scale_text": 3.0,               // テキスト忠実度 (1.0〜7.0)
  "cfg_scale_speaker": 5.0,            // 話者(ref)への忠実度。下げると声紋から離れる (1.0〜9.0)
  "duration_scale": 1.0,               // >1 でゆっくり、<1 で早口 (0.5〜1.5)
  "ref_wav": null                      // この呼び出しだけ別リファレンス（絶対パス）
}
```

`text` 以外は省略可。

スタイル制御の実用パターン:

| 用途 | 設定例 |
|---|---|
| デフォルト | 全部省略 |
| ゆっくり | `"duration_scale": 1.4` |
| 早口 | `"duration_scale": 0.85` |
| 囁き寄り | `"cfg_scale_speaker": 3.0` + テキストに「…」「そっと」等の柔らかい表現 |
| はっきり/高品質 | `"num_steps": 60` |

スタイル切り替えは「`text` + `duration_scale` + `cfg_scale_speaker`」のセットで管理するのが現実的（例: `normal_mode` / `whisper_mode` プリセットをアプリ側に持つ）。

---

## 7. トラブルシューティング

### `cuda available: False`
- `nvidia-smi` で GPU が見えるか確認
- `uv sync` で torch が CUDA 版になっているか確認:
  ```bash
  ~/dev/Irodori-TTS/.venv/bin/python -c "import torch; print(torch.__version__)"
  # → 2.10.0+cu128 のように +cuXXX が付いていれば OK
  ```
- ドライバが古い場合はアップデート（CUDA 12.x 対応版）。

### 起動時に `FileNotFoundError: 'ninja'`
FlashInfer が CUDA カーネルを JIT ビルドするのに `ninja` が必要。
venv 内にはインストール済みですが PATH が通っていないと失敗します。

```bash
PATH="$HOME/dev/Irodori-TTS/.venv/bin:$PATH" \
  ~/dev/Irodori-TTS/.venv/bin/python tts_server.py --port 7880
```

systemd service の場合は `Environment=PATH=…` を Service セクションに入れる（3.4 のサンプルに含まれます）。

### `CUDA out of memory`
GPU の空きが足りていません。同じ GPU で他のモデル（LLM 等）を動かしている場合は、そちらを停止するか VRAM 設定を下げてください。
Irodori 単独なら 5〜6 GB あれば足ります。

確認コマンド:
```bash
nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader
```

### `502 Bad Gateway` がたまに出る（Docker コンテナから叩いている場合）
Docker コンテナ内では Tailscale MagicDNS 等のホスト名解決が間欠失敗することがあります。**IP アドレス直叩き**に変えてください:

```ts
// Before: fetch("http://my-server:7880/tts", ...)
// After:  fetch("http://192.168.x.y:7880/tts", ...)
```

### 「声が安定しない・テキストごとに別人になる」
no_ref モード（`--voice-ref` 指定なし）で使っています。**必ず `--voice-ref` で参照音声を指定**してください。

詳細: v3 モデルは `no_ref` のときシードからノイズを生成しますが、そのノイズテンソルの**形状が予測 duration（つまりテキスト長）に依存**するため、同じシードでもテキストが変わると声が変わります。

### モデルロードが超遅い
- 初回は HuggingFace からの DL を含むので 30 秒〜数分かかります（ネットワーク次第）
- 2回目以降は `~/.cache/huggingface/` のキャッシュから 6〜10 秒で起動

### 並列リクエストでタイムアウトする
TTS サーバは Python GIL と GPU の制約で**自然に直列化**されます。
12 並列リクエストでも 1リクエスト約 0.5 秒 × 12 = 6 秒で全部返る計算。
クライアント側のタイムアウトは **30〜60 秒**程度に設定してください。

### `--voice-ref file not found`
パスは**絶対パス**で渡してください。`~/` などの shell 展開が効かない場面があります。
```bash
--voice-ref /home/USER/dev/irodori-tts-server/voices/reference.wav
```

---

## 8. ファイル構成（最終形）

```
~/dev/
├── Irodori-TTS/                     # オリジナルリポジトリ + venv
│   ├── .venv/                       # uv sync で生成（torch + 依存）
│   ├── irodori_tts/                 # Python パッケージ
│   ├── gradio_app.py
│   ├── infer.py
│   └── ...
│
└── irodori-tts-server/              # 自作の薄い HTTP ラッパ
    ├── tts_server.py                # FastAPI エントリ
    ├── companion/
    │   ├── __init__.py
    │   └── tts.py                   # IrodoriTTS ラッパクラス
    └── voices/
        ├── reference.wav            # 固定リファレンス（推奨運用）
        └── candidate_seed_*.wav     # 候補音声
```

---

## 9. パフォーマンス実測表

RTX 3090 / bf16 / `no_ref` または `ref_wav` で測定:

| 項目 | 時間・サイズ |
|---|---|
| 初回起動（モデル DL 含む） | ~30 秒 |
| 起動2回目以降（キャッシュ済み） | 6〜10 秒 |
| **1文の合成**（3〜5秒の音声） | **0.4〜0.7 秒** |
| 長文の合成（~10秒の音声） | ~1.5 秒 |
| 参照音声のロード+エンコード（1回分） | 数十 ms |
| 12 並列リクエスト総処理時間 | ~6 秒（直列化される） |

リアルタイムの **5〜10 倍速** で合成できる。

VRAM 使用量:
| フェーズ | VRAM |
|---|---|
| 起動直後・モデル未ロード | 0 GB |
| ロード後常駐 | ~3.7 GB |
| 合成中ピーク | 5〜6 GB |

スタイル制御の効果（同一リファレンス固定下）:

| 設定 | 合成時間 | 音声サイズ（3文の例） |
|---|---|---|
| baseline | 0.55 秒 | 649 KB |
| `duration_scale=1.4`（ゆっくり） | 0.69 秒 | 910 KB（1.4倍長くなる） |
| `cfg_scale_speaker=3.0` + 柔らかテキスト | 0.70 秒 | 1037 KB |
| 全部盛り | 0.90 秒 | 1452 KB |

---

## 10. 参考リンク

- Irodori-TTS リポジトリ: https://github.com/Aratako/Irodori-TTS
- Irodori-TTS v3 モデル: https://huggingface.co/Aratako/Irodori-TTS-500M-v3
- DACVAE コーデック: https://huggingface.co/Aratako/Semantic-DACVAE-Japanese-32dim
- FastAPI: https://fastapi.tiangolo.com/
- uv: https://docs.astral.sh/uv/

---

## 付録: 真の囁き声が欲しいときは VoiceDesign 系へ

`Aratako/Irodori-TTS-500M-v3` は参照音声駆動なので、参照に「普通の発声」が入っていると囁きには寄りにくいです。
**真の囁きボイス**が要るなら、`Aratako/Irodori-TTS-500M-v2-VoiceDesign` の方が向いています（`caption` 引数で「ささやくように」等を指定できる）。
別モデルなので並行運用は VRAM 的に厳しく、入れ替えになります。
