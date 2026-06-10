#!/usr/bin/env python3
"""
英→カタカナ辞書を e2k (C2K) で一括生成して CSV に出力する。

C2K は文字ベースのニューラル変換なので g2p / 音素は不要。CMUDict は「英単語リスト」
としてのみ使う (= 約 13 万語の見出し語)。

依存:
    pip install e2k cmudict

実行 (host で):
    python3 scripts/gen-katakana-dict.py
    # → english_to_katakana_dict.csv (word,reading) を生成

生成後、コンテナ内で DB に取り込む:
    docker cp english_to_katakana_dict.csv yui-agent-web:/app/
    docker exec -w /app yui-agent-web npx tsx scripts/tts-dict-import.ts --reset

フィルタ方針 = 最小 (= ご主人様の選択):
    - C2K が扱える文字 (a-z とアポストロフィ) のみの見出しを対象
    - 見出し語の重複は除去 (= CMUDict の発音バリアントは dict() がキー1個に畳むので自然に1件)
    - 変換結果が空のものは除外
    - 短語 / 機能語の除外はしない (= 暴発リスクは source='cmudict' 優先 + 実運用で別途判断)
"""
import csv
import re
import sys

try:
    import cmudict
    from e2k import C2K
except ImportError:
    print("依存が未インストールです: pip install e2k cmudict", file=sys.stderr)
    raise

OUT_PATH = "english_to_katakana_dict.csv"
VALID = re.compile(r"^[a-z']+$")  # C2K in_table = lowercase letters + apostrophe (+ space)


def main() -> None:
    c2k = C2K()

    # CMUDict の全見出し語。dict() のキーは小文字、発音バリアントは値リストに畳まれる。
    words = sorted(cmudict.dict().keys())
    print(f"[gen] CMUDict words: {len(words)}")

    rows: list[tuple[str, str]] = []
    seen: set[str] = set()
    skipped_invalid = 0
    skipped_empty = 0

    for i, w in enumerate(words):
        lw = w.strip().lower()
        if not lw or lw in seen:
            continue
        if not VALID.match(lw):
            skipped_invalid += 1
            continue
        seen.add(lw)
        try:
            kata = c2k(lw)
        except Exception:
            skipped_empty += 1
            continue
        if not kata:
            skipped_empty += 1
            continue
        rows.append((lw, kata))
        if (i + 1) % 10000 == 0:
            print(f"[gen] {i + 1}/{len(words)} processed, {len(rows)} kept")

    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["word", "reading"])
        writer.writerows(rows)

    print(
        f"[gen] done: {len(rows)} entries -> {OUT_PATH} "
        f"(skipped invalid={skipped_invalid}, empty={skipped_empty})"
    )


if __name__ == "__main__":
    main()
