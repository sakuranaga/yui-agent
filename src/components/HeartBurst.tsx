"use client";

/**
 * VRM ダブルクリックで弾けるハート粒子オーバーレイ。
 *
 * 親 (page.tsx) が bursts state を保持し、新着クリックを push する。
 * 各 burst は ~1.4 秒で消えるので、親が ts ベースで古いものを filter する。
 *
 * 視覚言語:
 * - 全 fixed overlay (pointer-events: none) なので背景の VRM 操作を邪魔しない
 * - 1 burst = 11 粒子、起点座標から ±35° に拡散しながら上昇 + 上方向にもう一段昇って fade
 * - 色は Yui の世界観 (黒赤シック) に合わせて赤〜ピンク〜白の 4 色をローテーション
 */
import { useState, type CSSProperties } from "react";

export type HeartBurst = {
  id: number;
  /** viewport px (clientX) */
  x: number;
  /** viewport px (clientY) */
  y: number;
};

type Props = {
  bursts: HeartBurst[];
};

const PARTICLES_PER_BURST = 11;
const PARTICLE_COLORS = ["#ff4f76", "#ff7a99", "#ffb0c1", "#fff0f3"];

export default function HeartBurst({ bursts }: Props) {
  return (
    <div className="heart-burst-layer" aria-hidden="true">
      {bursts.map((b) => (
        <BurstGroup key={b.id} burst={b} />
      ))}
    </div>
  );
}

function BurstGroup({ burst }: { burst: HeartBurst }) {
  // BurstGroup は親側で `key={b.id}` 指定なので id 毎に remount される (= mount 1 回 = 粒子は固定)。
  // React 19 purity: Math.random() を render 中に呼べないので useState の lazy init で
  // 「mount 時に 1 度だけ計算」にする。setter は不要 (= 以降 update しない)。
  const [particles] = useState(() =>
    Array.from({ length: PARTICLES_PER_BURST }, (_, i) => {
      // 上向き ±35° に拡散 (上が -90°)
      const angleDeg = -90 + (Math.random() - 0.5) * 70;
      const angle = (angleDeg * Math.PI) / 180;
      const distance = 90 + Math.random() * 60;
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance;
      const rot = (Math.random() - 0.5) * 60;
      const size = 16 + Math.random() * 10;
      const delay = Math.random() * 90;
      const duration = 1000 + Math.random() * 400;
      const color = PARTICLE_COLORS[i % PARTICLE_COLORS.length];
      return { key: i, dx, dy, rot, size, delay, duration, color };
    }),
  );

  return (
    <>
      {particles.map((p) => (
        <span
          key={p.key}
          className="heart-particle"
          style={
            {
              left: burst.x,
              top: burst.y,
              width: p.size,
              height: p.size,
              animationDelay: `${p.delay}ms`,
              animationDuration: `${p.duration}ms`,
              "--hp-dx": `${p.dx}px`,
              "--hp-dy": `${p.dy}px`,
              "--hp-rot": `${p.rot}deg`,
            } as CSSProperties
          }
        >
          <svg viewBox="0 0 24 24" fill={p.color} aria-hidden="true">
            <path d="M12 21s-7-4.35-9.5-9.05C.85 8.9 2.6 5 6.5 5c2.1 0 3.6 1.2 4.5 2.7C11.9 6.2 13.4 5 15.5 5c3.9 0 5.65 3.9 4 6.95C19 16.65 12 21 12 21z" />
          </svg>
        </span>
      ))}
    </>
  );
}
