"use client";

/**
 * Sleep Overlay — 認知シャッフル本体の再生エンジン + フルスクリーン真っ黒 UI。
 *
 * フロー:
 *   1. SleepModal の Start で window CustomEvent("sleep-session-start", config) 発火
 *   2. このコンポーネントが listen → config を state にセット → 開始
 *   3. preparing → intro → playing → (timer/手動) → closing → 終了
 *
 * 再生レイヤー:
 *   - BGM: HTMLAudioElement (loop=true, volume=config.bgmVolume)
 *   - TTS: /api/tts を fetch → Blob URL → HTMLAudioElement で 1 回再生
 *   - 単語: `👂{word}` + ref_wav=whisper_ref.wav
 *   - アファ: `👂{text}` + ref_wav=whisper_ref.wav
 *   - intro/closing: text のみ + ref_wav (ref で囁き trait 継承)
 *
 * 単語選択:
 *   - Fisher-Yates で全単語シャッフル → bag を使い切ったら再シャッフル
 *   - 各 step で affirmationProbability の確率でアファ、それ以外は次の単語
 *
 * 停止:
 *   - Stop button → "manual", タイマー → "timer"
 *   - どちらも closing TTS を流して BGM フェードアウト → PATCH session
 *
 * 設計: docs/sleep-support.md (Phase 4)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SleepSessionConfig } from "@/components/SleepModal";
import { setUserStateGlobal } from "@/lib/useUserState";

// TTS サーバ側に置いた囁き用 ref の絶対パス。
// AI 設定の TTS → tts_whisper_ref から取得 (= マウント時に /api/ai-settings で fetch)。
// 設定なしなら空文字 → 通常声で合成。
//
// 設計: ref ファイル自体は assets/tts-refs/whisper_ref.wav として repo 同梱しているが、
// TTS server (= 別プロセス) が直接 file を読むので、TTS server 側 fs にコピーして
// その絶対パスを設定する運用。

type Phase = "preparing" | "intro" | "playing" | "closing" | "done";

type StartEvent = CustomEvent<SleepSessionConfig>;

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickInterval(minSec: number, maxSec: number): number {
  const lo = Math.max(1, Math.min(minSec, maxSec));
  const hi = Math.max(lo, maxSec);
  return (lo + Math.random() * (hi - lo)) * 1000;
}

async function fetchTts(text: string, refWav: string): Promise<HTMLAudioElement> {
  // ref_wav が空 (= WHISPER_REF 未設定) なら field 自体送らない → TTS server 側の
  // 通常 voice で合成される (= 囁き効かないが Sleep 自体は動く)。
  const body: Record<string, string> = { text };
  if (refWav && refWav.length > 0) {
    body.ref_wav = refWav;
  }
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`tts failed ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.preload = "auto";
  return audio;
}

/**
 * 長文を句点 (。!?\n) で分割。長すぎる文 (60 字超) は読点でも切って 30-60 字ずつに。
 * 1 回の TTS リクエストの音声長を ~5-8 秒以内に抑えることで、囁き reference の
 * 追従精度を維持する (長文だと model が default speaker に drift してしまうため)。
 */
function splitTtsChunks(text: string): string[] {
  const sentences = text
    .split(/(?<=[。！？\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= 60) {
      out.push(s);
      continue;
    }
    const parts = s.split(/(?<=、)/);
    let buf = "";
    for (const p of parts) {
      if (buf.length + p.length > 50 && buf.length > 0) {
        out.push(buf);
        buf = p;
      } else {
        buf += p;
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

/**
 * 分割した chunk を 1 つずつ fetch → 再生。chunk 間は fetch のレイテンシ (~1-3s)
 * が自然な間になる。abort されたら次の chunk に進まず即抜ける。
 * currentRef は再生中の audio element を外から参照できるよう注入 (stop の pause 用)。
 */
async function playTtsChunks(
  chunks: string[],
  refWav: string,
  abort: { aborted: boolean },
  currentRef: { current: HTMLAudioElement | null },
  prefix: string = ""
): Promise<void> {
  for (const chunk of chunks) {
    if (abort.aborted) return;
    try {
      const audio = await fetchTts(`${prefix}${chunk}`, refWav);
      if (abort.aborted) return;
      currentRef.current = audio;
      await playAudio(audio, abort);
      currentRef.current = null;
    } catch (e) {
      console.warn("[sleep] chunk tts failed:", chunk, e);
    }
  }
}

function playAudio(audio: HTMLAudioElement, abortSignal: { aborted: boolean }): Promise<void> {
  return new Promise((resolve) => {
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    const cleanup = () => {
      audio.removeEventListener("ended", onEnd);
      audio.removeEventListener("error", onEnd);
      audio.removeEventListener("pause", onEnd);
      try {
        URL.revokeObjectURL(audio.src);
      } catch {
        /* noop */
      }
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("error", onEnd);
    // stopSession が audio.pause() で割り込んできた時にも resolve させる
    // (natural な pause は無いので除外不要)
    audio.addEventListener("pause", onEnd);
    audio.play().catch(() => {
      cleanup();
      resolve();
    });
  });
}

export default function SleepOverlay() {
  const [config, setConfig] = useState<SleepSessionConfig | null>(null);
  const [phase, setPhase] = useState<Phase>("preparing");
  const [currentLabel, setCurrentLabel] = useState<string>("");
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>("");
  // AI 設定の tts_whisper_ref。マウント時に /api/ai-settings から取得。
  // 設定 → AI → TTS で変更可、未設定なら空文字 (= ref 渡さない)。
  const whisperRefRef = useRef<string>("");
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch("/api/ai-settings", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { settings?: { tts_whisper_ref?: string } };
        if (active) whisperRefRef.current = (j.settings?.tts_whisper_ref ?? "").trim();
      } catch {
        /* noop */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // mutable refs (do not trigger rerender)
  // BGM は WebAudio (BufferSource + GainNode) で再生。OS の audio スレッドが
  // タイマー秒後のフェード+停止を予約実行してくれるので、PC スリープで JS が
  // 止まっても BGM が時間通りに止まる。HTMLAudioElement だと JS タイマー依存
  // (= スリープで止まらない) になるので使わない。
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bgmSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bgmGainRef = useRef<GainNode | null>(null);
  const currentTtsRef = useRef<HTMLAudioElement | null>(null);
  const wordBagRef = useRef<string[]>([]);
  const wordBagIdxRef = useRef(0);
  const affirmationsRef = useRef<string[]>([]);
  const sessionIdRef = useRef<number | null>(null);
  const wordsSpokenRef = useRef(0);
  const affirmationsSpokenRef = useRef(0);
  const nextStepTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerEndAtRef = useRef<number | null>(null);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef<{ aborted: boolean }>({ aborted: false });

  // 終了処理 (closing TTS → BGM fade → PATCH session → unmount)
  const stopSession = useCallback(
    async (reason: "manual" | "timer" | "unmount") => {
      // 既に停止処理中なら no-op
      if (stoppedRef.current.aborted) return;
      stoppedRef.current.aborted = true;

      // セッション自然終了は「離席」へ。unmount (ナビゲーション・StrictMode 等)
      // は意図せぬ離脱の可能性があるので user state はいじらない。
      if (reason === "manual" || reason === "timer") {
        setUserStateGlobal("away");
      }

      if (nextStepTimeoutRef.current) {
        clearTimeout(nextStepTimeoutRef.current);
        nextStepTimeoutRef.current = null;
      }
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
        tickIntervalRef.current = null;
      }

      // 現在再生中の TTS を即停止
      const curTts = currentTtsRef.current;
      if (curTts) {
        try {
          curTts.pause();
        } catch {
          /* noop */
        }
        currentTtsRef.current = null;
      }

      // unmount 経路では closing 不要 (画面遷移しているので)
      if (reason !== "unmount") {
        setPhase("closing");
        setStatusMsg(reason === "timer" ? "おやすみなさい…" : "セッションを終了しています…");
        setCurrentLabel("");
        try {
          const res = await fetch("/api/sleep/closing", { method: "POST" });
          const json = (await res.json()) as { text?: string; error?: string };
          if (json.text) {
            // closing も intro と同じ chunk 分割。中断不可 (停止リクエストの結果)。
            const closingChunks = splitTtsChunks(json.text);
            await playTtsChunks(
              closingChunks,
              whisperRefRef.current,
              { aborted: false },
              currentTtsRef,
              "👂"
            );
          }
        } catch (e) {
          console.warn("[sleep] closing failed, skipping:", e);
        }
      }

      // BGM フェード (WebAudio: gain ramp + source.stop + ctx.close)
      const ctx = audioCtxRef.current;
      const gain = bgmGainRef.current;
      const source = bgmSourceRef.current;
      if (ctx && gain && source) {
        try {
          const now = ctx.currentTime;
          const FADE_SEC = 1.5;
          // 予約済の (timer 用) スケジュールがあれば cancel
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0, now + FADE_SEC);
          try {
            source.stop(now + FADE_SEC + 0.1);
          } catch {
            /* noop: 既に stop 済の可能性 */
          }
          // フェード完了まで wall-clock で待つ
          await new Promise<void>((r) => setTimeout(r, FADE_SEC * 1000 + 200));
          await ctx.close().catch(() => {});
        } catch (e) {
          console.warn("[sleep] bgm fade failed:", e);
        }
        audioCtxRef.current = null;
        bgmGainRef.current = null;
        bgmSourceRef.current = null;
      }

      // session 完了 PATCH
      const sid = sessionIdRef.current;
      if (sid !== null) {
        try {
          await fetch(`/api/sleep/sessions/${sid}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              stoppedBy: reason,
              wordsSpoken: wordsSpokenRef.current,
              affirmationsSpoken: affirmationsSpokenRef.current,
            }),
          });
        } catch (e) {
          console.warn("[sleep] session PATCH failed:", e);
        }
      }

      // overlay を閉じる
      setPhase("done");
      setConfig(null);
    },
    []
  );

  // 単語/アファを 1 回発話 → 次のステップを schedule。
  // cfg は引数で受ける (useState の config だと初回 render の closure で
  // null のまま固定されてしまい !config の早期 return でループが止まる)。
  const stepOnce = useCallback(async (cfg: SleepSessionConfig) => {
    if (stoppedRef.current.aborted) return;

    // タイマーチェック
    const tend = timerEndAtRef.current;
    if (tend !== null && performance.now() >= tend) {
      void stopSession("timer");
      return;
    }

    // 何を発話するか決定
    const useAff =
      affirmationsRef.current.length > 0 &&
      Math.random() < cfg.affirmationProbability;
    let label: string;
    let ttsText: string;
    if (useAff) {
      const pick =
        affirmationsRef.current[
          Math.floor(Math.random() * affirmationsRef.current.length)
        ];
      label = pick;
      ttsText = `👂${pick}`;
    } else {
      if (wordBagIdxRef.current >= wordBagRef.current.length) {
        shuffleInPlace(wordBagRef.current);
        wordBagIdxRef.current = 0;
      }
      const word = wordBagRef.current[wordBagIdxRef.current++];
      label = word;
      ttsText = `👂${word}`;
    }

    setCurrentLabel(label);
    try {
      const audio = await fetchTts(ttsText, whisperRefRef.current);
      if (stoppedRef.current.aborted) return;
      currentTtsRef.current = audio;
      await playAudio(audio, stoppedRef.current);
      currentTtsRef.current = null;
    } catch (e) {
      console.warn("[sleep] tts failed for", label, e);
    }

    if (useAff) affirmationsSpokenRef.current += 1;
    else wordsSpokenRef.current += 1;

    if (stoppedRef.current.aborted) return;

    // 単語ラベルは次の単語が来るまで出しっぱなしにする (寝落ち前にチラ見して
    // 「何の単語だっけ」を確認できるように)。clear は次の stepOnce で
    // setCurrentLabel(label) が上書きするので不要。

    // 次の発話まで待機
    const waitMs = pickInterval(cfg.intervalMinSec, cfg.intervalMaxSec);
    nextStepTimeoutRef.current = setTimeout(() => {
      // 自己再帰: setTimeout のクロージャが TDZ 後に評価されるので runtime 安全。
      // React 19 の hooks 厳格化で flag されるが、ref 化すると再生サイクルが
      // 壊れるリスクあり、ここは意図的に許容。
      // eslint-disable-next-line react-hooks/immutability
      void stepOnce(cfg);
    }, waitMs);
  }, [stopSession]);

  // セッション開始
  const beginSession = useCallback(
    async (cfg: SleepSessionConfig) => {
      stoppedRef.current = { aborted: false };
      wordsSpokenRef.current = 0;
      affirmationsSpokenRef.current = 0;
      setPhase("preparing");
      setStatusMsg("準備中…");
      setCurrentLabel("");

      // セッション中はニュース / 通知を抑止するため自動で「集中」モードに。
      // 終了時 (stopSession) で「離席」へ。
      setUserStateGlobal("focus");

      try {
        // 並列で 4 つ取得
        const wordsP = fetch(
          `/api/sleep/words?cats=${cfg.categoryIds.join(",")}&maxDiff=${cfg.difficultyMax}`,
          { cache: "no-store" }
        ).then((r) => r.json() as Promise<{ words: string[] }>);
        const affP = fetch("/api/sleep/affirmations", { cache: "no-store" }).then(
          (r) => r.json() as Promise<{ affirmations: Array<{ text: string; enabled: boolean }> }>
        );
        const sessP = fetch("/api/sleep/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            categories: cfg.categoryIds,
            bgmId: cfg.bgmId,
            timerMin: cfg.timerMin,
          }),
        }).then((r) => r.json() as Promise<{ id: number }>);
        const introP = fetch("/api/sleep/intro", { method: "POST" }).then(
          (r) => r.json() as Promise<{ text: string }>
        );

        // BGM の URL も並行に prefetch (decode は再生時)。
        // url は legacy preset なら /sleep-bgm/{filename}、user upload なら
        // /api/sleep/bgm/{id}/file。client は url をそのまま fetch する。
        let bgmUrl: string | null = null;
        if (cfg.bgmId !== null) {
          const bgmRes = await fetch("/api/sleep/bgm", { cache: "no-store" });
          const bgmJson = (await bgmRes.json()) as {
            bgm: Array<{ id: number; url: string }>;
          };
          const found = bgmJson.bgm.find((b) => b.id === cfg.bgmId);
          if (found) bgmUrl = found.url;
        }

        const [wordsJson, affJson, sessJson, introJson] = await Promise.all([
          wordsP,
          affP,
          sessP,
          introP,
        ]);

        if (stoppedRef.current.aborted) return;

        wordBagRef.current = shuffleInPlace([...wordsJson.words]);
        wordBagIdxRef.current = 0;
        affirmationsRef.current = affJson.affirmations
          .filter((a) => a.enabled)
          .map((a) => a.text);
        sessionIdRef.current = sessJson.id;

        // BGM 開始 (WebAudio で OS audio スレッドにスケジュール)。
        // タイマー設定があれば「timer 秒後にフェード → stop」を予約。
        // JS が PC スリープで止まっても OS が約束通り止めてくれる。
        if (bgmUrl) {
          try {
            const ctx = new AudioContext();
            const res = await fetch(bgmUrl);
            const arrayBuf = await res.arrayBuffer();
            const audioBuf = await ctx.decodeAudioData(arrayBuf);
            if (stoppedRef.current.aborted) {
              await ctx.close().catch(() => {});
              return;
            }
            const source = ctx.createBufferSource();
            source.buffer = audioBuf;
            source.loop = true;
            const gain = ctx.createGain();
            gain.gain.value = cfg.bgmVolume;
            source.connect(gain).connect(ctx.destination);
            source.start(0);
            audioCtxRef.current = ctx;
            bgmSourceRef.current = source;
            bgmGainRef.current = gain;

            // タイマー予約: timer 秒後にフェード (2s) → 完全停止
            if (cfg.timerMin !== null && cfg.timerMin > 0) {
              const FADE_SEC = 2;
              const endSec = ctx.currentTime + cfg.timerMin * 60;
              gain.gain.setValueAtTime(cfg.bgmVolume, endSec);
              gain.gain.linearRampToValueAtTime(0, endSec + FADE_SEC);
              try {
                source.stop(endSec + FADE_SEC + 0.1);
              } catch {
                /* noop */
              }
            }
          } catch (e) {
            console.warn("[sleep] bgm setup failed:", e);
          }
        }

        // タイマー
        if (cfg.timerMin !== null && cfg.timerMin > 0) {
          timerEndAtRef.current = performance.now() + cfg.timerMin * 60_000;
          setRemainingSec(cfg.timerMin * 60);
          tickIntervalRef.current = setInterval(() => {
            const tend = timerEndAtRef.current;
            if (tend === null) return;
            const remain = Math.max(0, Math.round((tend - performance.now()) / 1000));
            setRemainingSec(remain);
            if (remain <= 0) {
              void stopSession("timer");
            }
          }, 1000);
        } else {
          timerEndAtRef.current = null;
          setRemainingSec(null);
        }

        // intro 再生 — 長文を句点で分割して 1 sentence ずつ TTS に送る。
        // 単一の長い TTS リクエストだと囁き reference から drift して別人の声になるため、
        // 短い chunk + 各 chunk 頭に 👂 を入れて whisper trait を毎回 reset する。
        setPhase("intro");
        setStatusMsg("");
        const introChunks = splitTtsChunks(introJson.text);
        await playTtsChunks(
          introChunks,
          whisperRefRef.current,
          stoppedRef.current,
          currentTtsRef,
          "👂"
        );

        if (stoppedRef.current.aborted) return;

        // intro が終わった直後にいきなり単語を発話するとせわしないので、10s 沈黙を置く
        // (BGM は鳴り続ける)。stop が来たら 500ms 以内に抜ける。
        {
          const deadline = performance.now() + 10_000;
          while (performance.now() < deadline) {
            if (stoppedRef.current.aborted) break;
            await new Promise<void>((r) => setTimeout(r, 500));
          }
        }

        if (stoppedRef.current.aborted) return;

        // メインループへ
        setPhase("playing");
        void stepOnce(cfg);
      } catch (e) {
        console.error("[sleep] session start failed:", e);
        setStatusMsg("開始に失敗しました");
        setTimeout(() => {
          setPhase("done");
          setConfig(null);
        }, 2000);
      }
    },
    [stepOnce, stopSession]
  );

  // CustomEvent listen
  useEffect(() => {
    const handler = (ev: Event) => {
      const cfg = (ev as StartEvent).detail;
      if (!cfg) return;
      setConfig(cfg);
      void beginSession(cfg);
    };
    window.addEventListener("sleep-session-start", handler as EventListener);
    return () =>
      window.removeEventListener("sleep-session-start", handler as EventListener);
  }, [beginSession]);

  // unmount cleanup
  useEffect(() => {
    return () => {
      void stopSession("unmount");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PC スリープ / タブ離脱からの復帰時の後始末。
  // BGM は WebAudio スケジュールで OS 側がタイマーまで止めるので、ここでは pause しない
  // (PC スリープ中も BGM は鳴り続ける = ご主人様の意図通り)。
  // visible 復帰時に既にタイマー時刻を過ぎていれば、セッション状態を即終了させる
  // (BGM 自体は WebAudio が止めてくれてるが、JS 側の session state を片付ける)。
  useEffect(() => {
    if (config === null) return;
    const onVisChange = () => {
      if (document.hidden) return;
      if (stoppedRef.current.aborted) return;
      const tend = timerEndAtRef.current;
      if (tend !== null && performance.now() >= tend) {
        void stopSession("timer");
      }
    };
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, [config, stopSession]);

  if (config === null || phase === "done") return null;

  return (
    <div className="sleep-overlay" role="dialog" aria-modal="true" aria-label="睡眠サポート">
      {/* 中央: 現在の単語 (極限まで薄く) */}
      <div className="sleep-overlay-center">
        {phase === "preparing" || phase === "closing" ? (
          <span className="sleep-overlay-status">{statusMsg}</span>
        ) : (
          <span className="sleep-overlay-word" key={currentLabel}>
            {currentLabel}
          </span>
        )}
      </div>

      {/* 下: タイマー残り + Stop */}
      <div className="sleep-overlay-foot">
        {remainingSec !== null && (
          <span className="sleep-overlay-timer">
            {Math.floor(remainingSec / 60)}:
            {String(remainingSec % 60).padStart(2, "0")}
          </span>
        )}
        <button
          type="button"
          className="sleep-overlay-stop"
          onClick={() => void stopSession("manual")}
          disabled={phase === "closing"}
        >
          起きる
        </button>
      </div>
    </div>
  );
}
