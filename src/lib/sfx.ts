/**
 * クライアント側の軽量効果音。Web Audio API でその場合成 (アセット不要)。
 *
 * 用途: お便りを開いた瞬間など、Yui の発話とは別の軽いフィードバック音。
 * 1〜2 つの sine 音を短く重ねるだけなので audio asset を持ち回らずに済む。
 */

let ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

type ChimeOptions = {
  freqs?: number[]; // Hz
  duration?: number; // 各音の長さ (sec)
  gap?: number; // 音間の隙間 (sec)
  gain?: number; // 0-1
};

/** 単発の short ping (お便りを開いた等) */
export function playOpenChime(): void {
  playChime({ freqs: [880, 1320], duration: 0.08, gap: 0.04, gain: 0.18 });
}

function playChime(opts: ChimeOptions = {}): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") {
    void c.resume();
  }
  const freqs = opts.freqs ?? [1000];
  const dur = opts.duration ?? 0.1;
  const gap = opts.gap ?? 0;
  const gain = opts.gain ?? 0.2;

  let t = c.currentTime;
  for (const f of freqs) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f, t);

    // 軽い envelope (attack 5ms, decay 〜end)
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc.connect(g);
    g.connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    t += dur + gap;
  }
}
