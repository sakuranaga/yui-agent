"use client";

/**
 * モーダル開閉のフェード/ポップ in-out アニメーション制御フック。
 *
 * 親が open: boolean を切り替えると:
 *  - open=true: 即座に mounted=true、closing=false (entering animation で描画)
 *  - open=false: closing=true で N ms 描画継続 (exit animation) → unmount
 *
 * 各モーダルは {mounted, closing} を見て:
 *  - if (!mounted) return null
 *  - className に `${closing ? "modal-closing" : ""}` を加える
 *
 * CSS 側は `.X-backdrop.modal-closing { animation: modal-fade-out ... }` の selector で逆 animation。
 *
 * EXIT_MS は globals.css の `modal-fade-out` / `modal-pop-out` の duration と揃える。
 *
 * 実装メモ (Next 16 / React 19 で見つけたバグ修正):
 *  - mounted は state として保持する (= `open || closing` 派生では NG)。
 *    open prop が true → false に切り替わった瞬間、React の中で「open=false / closing=false
 *    の中間 frame」が一瞬入る → 派生 mounted が false → DOM から消える → effect で
 *    closing=true → 再 mount で出現、という「閉じる→一瞬出る→閉じる」フラッシュになる。
 *    mounted を独立 state にして「closing が立つまでは mounted=true のまま」を保証する。
 *  - 初回 mount で open=false の modal は exit を空打ちしないよう、`if (!mounted) return;`
 *    で早期 return (= 一度も開いてないのにリロード時に全 modal が exit を流す現象の対策)。
 */
import { useEffect, useState } from "react";

const EXIT_MS = 180;

export function useModalTransition(open: boolean): {
  mounted: boolean;
  closing: boolean;
} {
  // mounted を state にする (派生ではない) のが要点。closing と同じ render commit で
  // 立てることで「mounted=false の中間 frame」を作らない。
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- prop → animation phase の同期。cascading render は起きない (open / mounted が安定したら再 fire しない)。 */
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    // 一度も開いてない modal は exit を流さない (初回 render での空打ち防止)。
    if (!mounted) return;
    setClosing(true);
    const t = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, EXIT_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { mounted, closing };
}
