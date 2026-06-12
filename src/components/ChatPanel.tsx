"use client";

import { useEffect, useRef, useState } from "react";
import type { VRMExpression } from "./VRMViewer";
import { splitForTTS, stripUrlForTts, splitForDisplay } from "@/lib/split-tts";
import { resizeImageToWebp, type ResizedImage } from "@/lib/image-resize";
import { useUserState, type UserState } from "@/lib/useUserState";

type Message = {
  role: "user" | "assistant";
  content: string;
  imageUrls?: string[];  // 表示用 (data URL or /api/chat/image?...)。複数添付対応。
  /** assistant 行が実行した tool 呼び出しサマリ。LLM 履歴注入用、UI には出さない。 */
  toolSummary?: Array<{ name: string; brief: string }>;
  /**
   * メッセージの出所。LLM 文脈構築時のフィルタリングに使う:
   *  - raw            : raw_messages (DB) 由来。通常モードで送られた通常会話
   *  - overlay-private: Valkey overlay の private 会話 → private モード中のみ LLM 文脈に含める
   *  - overlay-ephemeral: ニュース/音楽紹介の SSE 揮発 → 文脈に含めて OK (private 性無し)
   * 未指定はリアルタイム入力 (送信直後) で、現状の state に応じて扱う。
   */
  origin?: "raw" | "overlay-private" | "overlay-ephemeral";
};

const MAX_IMAGES_PER_TURN = 10;

// [tts-debug] ロガー: dev では console に出して TTS state を追えるようにし、
// production build では NODE_ENV 判定で no-op になる (= bundler が dead-code 除去)。
// ご主人様の会話プレビューが production console に出ないための gate。
const TTS_DEBUG = process.env.NODE_ENV !== "production";
function ttsLog(...args: unknown[]): void {
  if (TTS_DEBUG) console.log("[tts-debug]", ...args);
}
function ttsWarn(...args: unknown[]): void {
  if (TTS_DEBUG) console.warn("[tts-debug]", ...args);
}

/**
 * 連続する同 role の message を 1 つに結合する (空行 2 つで連結)。
 * Anthropic API は user/assistant alternating を要求するので、長文応答を
 * 段落チャンクごとに別 message として state 保存している場合の API 送出前 fix。
 * toolSummary は assistant 行のいずれかに付いていれば merge 後の代表に持たせる。
 */
function mergeConsecutiveSameRole(msgs: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
      if (m.toolSummary && m.toolSummary.length > 0) {
        last.toolSummary = m.toolSummary;
      }
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

export type AudioBridge = {
  analyser: AnalyserNode | null;
  speaking: boolean;
};

type Props = {
  onBotResponse: (text: string, emotion: VRMExpression) => void;
  /** Specialist 完了時に report agent が生成した note を親に流す */
  onReportUpdate?: (title: string, markdown: string, noteId?: number) => void;
  /** Mutable bridge so VRMViewer can read live audio amplitude in its frame loop. */
  audioBridge: { current: AudioBridge };
};

/** Yui の声 (TTS) 用の音量。音楽の音量とは独立。
 *  旧 key "vroid-chat-volume" は全体音量だったが、現在は Yui 声専用に切り出し済。
 *  既存ユーザ設定を引き継ぐため、新 key が空なら旧 key からフォールバック読込する。 */
const VOLUME_STORAGE_KEY = "vroid-yui-voice-volume";
const LEGACY_VOLUME_KEY = "vroid-chat-volume";
const SESSION_STORAGE_KEY = "vroid-chat-session-id";
const DEFAULT_VOLUME = 1; // SSR で使う初期値 (実値は mount 後に localStorage から復元)

function readVolumeFromStorage(): number {
  if (typeof window === "undefined") return DEFAULT_VOLUME;
  // 新 key 優先、無ければ旧 key から migrate (旧 key も無ければ default)
  const raw =
    window.localStorage.getItem(VOLUME_STORAGE_KEY) ??
    window.localStorage.getItem(LEGACY_VOLUME_KEY);
  if (raw == null) return DEFAULT_VOLUME;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_VOLUME;
}

/**
 * localStorage に session_id を保持する。タブ・ウィンドウ・ブラウザ再起動を跨いで
 * 同じ session を継続するので、Yui との会話は常に 1 本の連続スレッドになる。
 * (以前は sessionStorage = タブごとに別 session だったが、単一ユーザー運用には
 * 不便だったため localStorage に変更。memory_chunks の retrieval は session を
 * フィルタしないため、長く同じ session を使い続けても支障無し。)
 * SSR 中は呼ばないこと (useEffect 内で呼ぶ)。
 */
function readOrCreateSessionId(): string {
  const existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;
  // 旧仕様 (sessionStorage) からの移行: タブ内で生きてれば拾い上げる
  const legacy = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (legacy) {
    window.localStorage.setItem(SESSION_STORAGE_KEY, legacy);
    // page.tsx 側 (TimerToast の SSE 受信用) が sessionId 変化を検知できるよう発火。
    // 同タブ内では `storage` event は飛ばない (= 他タブ宛て限定) ため独自 event を使う。
    window.dispatchEvent(new Event("vroid-session-changed"));
    return legacy;
  }
  const fresh = generateUuid();
  window.localStorage.setItem(SESSION_STORAGE_KEY, fresh);
  window.dispatchEvent(new Event("vroid-session-changed"));
  return fresh;
}

/**
 * UUID v4 生成。crypto.randomUUID() があれば使う、無ければ Math.random で代替。
 * `crypto.randomUUID` は secure context 限定 (= HTTPS or localhost) で、
 * 127.0.0.1 origin の一部ブラウザで undefined になることがあるためフォールバック必須。
 */
function generateUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* noop */ }
  // RFC4122 v4 fallback (Math.random ベース、十分にユニーク)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const SPECIALIST_LABELS: Record<string, string> = {
  ask_task_specialist: "タスク",
  ask_schedule_specialist: "ご予定",
  ask_mail_specialist: "メール",
  ask_research_specialist: "調べ物",
};

function specialistsLabel(jobs: Map<number, PendingJob>): string {
  const set = new Set<string>();
  for (const j of jobs.values()) {
    set.add(SPECIALIST_LABELS[j.specialist] ?? j.specialist);
  }
  return Array.from(set).join("と");
}

type PendingJob = { specialist: string; startedAt: number };

/**
 * チャットバブル本文を render。
 * URL を検出して <a target="_blank"> にする (= クリックで別タブ)。
 * URL 文字列はそのまま表示 (省略しない)、長すぎる時は CSS で折返し。
 */
function renderBubbleContent(text: string): React.ReactNode {
  const segs = splitForDisplay(text);
  if (segs.length === 0) return text;
  return segs.map((s, i) => {
    if (s.kind === "url") {
      return (
        <a
          key={i}
          href={s.value}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-bubble-link"
        >{s.value}</a>
      );
    }
    return <span key={i}>{s.value}</span>;
  });
}

export default function ChatPanel({ onBotResponse, onReportUpdate, audioBridge }: Props) {
  // 初期は空。mount 後 /api/chat/history を読み込んで populate (リロード後の会話復元)。
  // 履歴が空ならその後で初回挨拶が表示される。
  const [messages, setMessages] = useState<Message[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ResizedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 共通: File[] を resize → pendingImages に追加 (上限 MAX_IMAGES_PER_TURN)
  const addImageFiles = async (files: File[]) => {
    setImageError(null);
    const remaining = MAX_IMAGES_PER_TURN - pendingImages.length;
    if (remaining <= 0) {
      setImageError(`画像は最大 ${MAX_IMAGES_PER_TURN} 枚までです`);
      return;
    }
    const accepted = files.filter((f) => f.type.startsWith("image/")).slice(0, remaining);
    if (accepted.length === 0) {
      if (files.length > 0) setImageError("画像ファイルではありません");
      return;
    }
    if (files.length > accepted.length && remaining > 0) {
      setImageError(`画像は最大 ${MAX_IMAGES_PER_TURN} 枚までです`);
    }
    try {
      const resized = await Promise.all(accepted.map((f) => resizeImageToWebp(f)));
      setPendingImages((prev) => [...prev, ...resized]);
    } catch (err) {
      setImageError(err instanceof Error ? err.message : "画像処理に失敗");
    }
  };
  // doSend は form/keyboard ハンドラから呼ぶ wrapper。
  // loading が true→false に遷移した時にフォーカスを戻す useEffect で focus 管理。
  const doSend = async () => {
    await send();
  };
  const [loading, setLoading] = useState(false);
  const prevLoadingRef = useRef(false);
  // loading が true→false に変わった瞬間 (= 応答完了) に入力欄へフォーカス復帰。
  // textarea の disabled が外れた直後に focus できる。
  useEffect(() => {
    if (prevLoadingRef.current && !loading) {
      inputRef.current?.focus();
    }
    prevLoadingRef.current = loading;
  }, [loading]);
  // 進行中の background job 一覧 (specialist 委譲で spawn されたもの)
  const [pendingJobs, setPendingJobs] = useState<Map<number, PendingJob>>(
    () => new Map()
  );
  // SSR では DEFAULT_VOLUME で初期化、mount 後に localStorage から復元。
  // readVolumeFromStorage() は SSR セーフ (window undefined で DEFAULT_VOLUME) なので
  // useState の lazy init で渡せば、SSR / hydration 整合性を保ちつつ
  // setState in effect を回避できる (React 19 推奨パターン)。
  const [volume, setVolume] = useState<number>(() => readVolumeFromStorage());
  const sessionIdRef = useRef<string>("");
  // useUserState に渡すため、sessionId を state でも保持 (mount 後 1 回 set)
  const [sessionId, setSessionId] = useState<string>("");
  const listRef = useRef<HTMLDivElement>(null);
  const greeted = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // TTS の fetch+decode を URL 単位で memoize (同一テキストの再要求は再フェッチしない)。
  // 段落チャンクは splitForTTS で安定 deterministic に分割されるので、同じ応答に対しては
  // 同じキー、同じ AudioBuffer を再利用。サイズ上限 (LRU) は最後の N 件で控えめに pruning。
  const ttsCacheRef = useRef<Map<string, Promise<AudioBuffer | null>>>(new Map());
  const TTS_CACHE_MAX = 64;
  // /sounds/<name>.mp3 (timer / alarm 等) の decode 済 buffer キャッシュ
  const chimeCacheRef = useRef<Map<string, Promise<AudioBuffer | null>>>(new Map());
  const sseRef = useRef<EventSource | null>(null);
  // /api/chat の in-flight fetch を unmount / 連投時に abort。
  // 連投時は前ターンの fetch が走り続けて stale state を setState する race を防ぐ。
  const chatFetchAbortRef = useRef<AbortController | null>(null);
  // playTTS と onBotResponse を SSE handler 側からも呼ぶので ref に
  const playTTSRef = useRef<((text: string) => Promise<boolean>) | null>(null);
  const speakSequentialRef = useRef<
    ((text: string, emotion: VRMExpression) => Promise<void>) | null
  >(null);
  const appendAssistantChunksRef = useRef<
    | ((
        text: string,
        toolSummary?: Array<{ name: string; brief: string }>,
        origin?: "raw" | "overlay-private" | "overlay-ephemeral"
      ) => string[])
    | null
  >(null);
  const speakChunksRef = useRef<((chunks: string[]) => Promise<void>) | null>(null);
  // SSE 経由 (news/music/timer 等) を、現在の speak が終わるまで待たせる queue。
  // user 送信由来の speakChunks は割り込み (queue クリア)。ESC は現在を中断 + queue 次へ進める。
  const enqueueSpeakRef = useRef<((chunks: string[]) => void) | null>(null);
  const speakQueueRef = useRef<string[][]>([]);
  const isSpeakingRef = useRef<boolean>(false);
  // 同時複数発話を防ぐための世代カウンタ。新規 speak が走るたびに +1。
  // 古い世代の speak ループは generationRef と比較して自分が陳腐化したら自主中断。
  const speakGenerationRef = useRef(0);
  const onBotResponseRef = useRef(onBotResponse);
  useEffect(() => {
    onBotResponseRef.current = onBotResponse;
  }, [onBotResponse]);
  const onReportUpdateRef = useRef(onReportUpdate);
  useEffect(() => {
    onReportUpdateRef.current = onReportUpdate;
  }, [onReportUpdate]);

  // 起動時: localStorage から sessionId 読み込み + SSE 接続。
  // volume は上の useState lazy init で取り込み済み。
  useEffect(() => {
    const sid = readOrCreateSessionId();
    sessionIdRef.current = sid;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount sessionId init from localStorage
    setSessionId(sid);

    // SSE 接続: bg job 完了の push を受ける
    const es = new EventSource(
      `/api/chat/stream?session=${encodeURIComponent(sid)}`
    );
    sseRef.current = es;

    es.addEventListener("yui_message", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          jobId: number;
          text: string;
          emotion: VRMExpression;
          specialistId?: string;
        };
        ttsLog("yui_message recv", {
          jobId: data.jobId,
          textLen: data.text.length,
          textPreview: data.text.slice(0, 60),
        });
        onBotResponseRef.current(data.text, data.emotion ?? "neutral");
        // 同期で state 追加 → 非同期で TTS (race 防止)
        // SSE 経由の yui_message はニュース紹介 / 音楽紹介 / 通知などで、
        // raw_messages には書かれない揮発系 → origin="overlay-ephemeral"
        const chunks =
          appendAssistantChunksRef.current?.(data.text, undefined, "overlay-ephemeral") ?? [];
        ttsLog("chunks", {
          count: chunks.length,
          hasRef: !!speakChunksRef.current,
          first: chunks[0]?.slice(0, 40),
        });
        // SSE 由来 (news/music/通知) は queue 投入 — 今の Yui 発話が終わってから喋る。
        // ※ AudioContext が suspended (= Spotify SDK が audio を握ってる時等) の可能性がある
        //   ので、enqueue 前に明示的に resume を試みる。これしないと TTS の音が出ない。
        if (enqueueSpeakRef.current && chunks.length > 0) {
          void (async () => {
            const ctx = audioCtxRef.current;
            if (ctx && ctx.state !== "running") {
              try { await ctx.resume(); } catch { /* noop */ }
            }
            enqueueSpeakRef.current?.(chunks);
          })();
        } else {
          ttsWarn("enqueueSpeak SKIPPED (no ref or no chunks)");
        }
        // pendingJobs から除外
        setPendingJobs((m) => {
          if (!m.has(data.jobId)) return m;
          const next = new Map(m);
          next.delete(data.jobId);
          return next;
        });
      } catch (err) {
        console.warn("malformed yui_message:", err);
      }
    });

    es.addEventListener("timer_created", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          id: number;
          kind: "timer" | "alarm";
          label: string | null;
          targetAt: string;
        };
        window.dispatchEvent(new CustomEvent("yui-timer-created", { detail: data }));
      } catch (err) {
        console.warn("malformed timer_created:", err);
      }
    });

    es.addEventListener("timer_fired", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          id: number;
          kind: "timer" | "alarm";
          label: string | null;
          targetAt: string;
          hasAction?: boolean;
        };
        window.dispatchEvent(new CustomEvent("yui-timer-fired", { detail: data }));
        // hasAction=true なら on_fire_prompt 経由で Yui がアクション実行する。
        // 通知 voice を出すと冗長 (chat 経由で別途返答する)。chime はそのまま鳴らす。
        if (data.hasAction) {
          void (async () => {
            const ctx = audioCtxRef.current;
            if (ctx && ctx.state !== "running") {
              try { await ctx.resume(); } catch { /* noop */ }
            }
            try { await playChime(data.kind); } catch { /* noop */ }
          })();
          return;
        }
        // Yui voice 通知: 発火を結衣口調で読み上げる
        const labelPart = data.label ? `「${data.label}」の` : "";
        const kindPart = data.kind === "timer" ? "タイマー" : "アラーム";
        const text = `${labelPart}${kindPart}の時間ですよ、ご主人様。`;
        // 同期で state 追加 (chunks 化)、TTS は非同期 (race 防止)
        // タイマー発火も raw_messages に書かれない揮発系 (notifications.ts と同経路)
        const chunks =
          appendAssistantChunksRef.current?.(text, undefined, "overlay-ephemeral") ?? [];
        // タイマー発火は user gesture を伴わないので AudioContext が suspend されてる
        // 可能性がある。最初に明示的に resume を試みる。
        // 順序: chime (即時) → Yui voice
        void (async () => {
          const ctx = audioCtxRef.current;
          if (ctx && ctx.state !== "running") {
            try {
              await ctx.resume();
            } catch (e) {
              console.warn("[timer_fired] AudioContext.resume failed:", e);
            }
          }
          // chime: timer.mp3 / alarm.mp3 を即時鳴らす
          try {
            await playChime(data.kind);
          } catch (e) {
            console.warn("[timer_fired] chime failed:", e);
          }
          // voice: chime 終わった後に Yui のセリフ。
          // timer も SSE 由来扱い (= 現在再生中なら queue 投入)。即時に鳴らしたくても
          // 喋ってる途中の文を切るのは違和感が強いので queue 動作で OK。
          if (enqueueSpeakRef.current && chunks.length > 0) {
            enqueueSpeakRef.current(chunks);
          }
        })();
        onBotResponseRef.current(text, "relaxed");
      } catch (err) {
        console.warn("malformed timer_fired:", err);
      }
    });

    es.addEventListener("timer_cancelled", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { id: number };
        window.dispatchEvent(new CustomEvent("yui-timer-cancelled", { detail: data }));
      } catch (err) {
        console.warn("malformed timer_cancelled:", err);
      }
    });

    // Spotify 移行後は music_command SSE イベントは廃止 (server 側で完結)。
    // MusicModal は独自に /api/spotify/now-playing を polling する。

    es.addEventListener("notification", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          id: number;
          kind: string;
          importance: "high" | "normal" | "low" | "silent";
          title: string;
          preview: string;
        };
        // NotificationToast がリスン
        window.dispatchEvent(new CustomEvent("yui-notification", { detail: data }));
      } catch (err) {
        console.warn("malformed notification:", err);
      }
    });

    es.addEventListener("mail_inserted", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { count: number };
        // MailModal がリスンして reload する
        window.dispatchEvent(new CustomEvent("yui-mail-inserted", { detail: data }));
      } catch (err) {
        console.warn("malformed mail_inserted:", err);
      }
    });

    es.addEventListener("tool_confirm_request", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          token: string;
          toolName: string;
          summary: string;
          inputSnapshot: unknown;
        };
        window.dispatchEvent(
          new CustomEvent("yui-tool-confirm-request", { detail: data })
        );
      } catch (err) {
        console.warn("malformed tool_confirm_request:", err);
      }
    });

    es.addEventListener("tool_confirm_result", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          token: string;
          success: boolean;
          result?: unknown;
          reason?: string;
        };
        window.dispatchEvent(
          new CustomEvent("yui-tool-confirm-result", { detail: data })
        );
      } catch (err) {
        console.warn("malformed tool_confirm_result:", err);
      }
    });

    es.addEventListener("report_update", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          jobId: number;
          title: string;
          markdown: string;
          specialistId?: string;
          noteId?: number;
        };
        onReportUpdateRef.current?.(data.title, data.markdown, data.noteId);
      } catch (err) {
        console.warn("malformed report_update:", err);
      }
    });

    es.addEventListener("job_status", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          jobId: number;
          status: "running" | "succeeded" | "failed";
        };
        // failed のときだけ pending から除外 (succeeded は yui_message で除外される)
        if (data.status === "failed") {
          setPendingJobs((m) => {
            if (!m.has(data.jobId)) return m;
            const next = new Map(m);
            next.delete(data.jobId);
            return next;
          });
        }
      } catch (err) {
        console.warn("malformed job_status:", err);
      }
    });

    es.onerror = () => {
      // EventSource は自動再接続するので警告だけ
      if (process.env.NODE_ENV !== "production") {
        console.warn("[SSE] connection error (will auto-reconnect)");
      }
    };

    return () => {
      es.close();
      sseRef.current = null;
    };
    // playChime は SSE 接続中に最新値を呼び出すが、deps に入れると毎レンダー SSE 再接続になるので意図的に固定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push the slider value into the (already-running) gain node, and persist.
  useEffect(() => {
    if (gainNodeRef.current && audioCtxRef.current) {
      const t = audioCtxRef.current.currentTime;
      gainNodeRef.current.gain.cancelScheduledValues(t);
      if (volume === 0) {
        // ミュート時はラグ無しで即時 0 にしたい (電話対応等の用途)。
        gainNodeRef.current.gain.setValueAtTime(0, t);
      } else {
        // 通常のスライダー操作はスムージング (ドラッグでクリックノイズが出ないように)。
        gainNodeRef.current.gain.setTargetAtTime(volume, t, 0.02);
      }
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VOLUME_STORAGE_KEY, String(volume));
      // IconBar 側の MUTE 表示 (ON/OFF) を同期させる
      window.dispatchEvent(new CustomEvent("yui-volume-change"));
    }
  }, [volume]);

  // IconBar (別コンポーネント) が localStorage の音量を書き換えた時、
  // ここでも state を追従させて gainNode を更新する。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      const raw =
        window.localStorage.getItem(VOLUME_STORAGE_KEY) ??
        window.localStorage.getItem(LEGACY_VOLUME_KEY);
      const v = raw == null ? DEFAULT_VOLUME : Number(raw);
      if (Number.isFinite(v)) {
        setVolume((current) => (current === v ? current : Math.max(0, Math.min(1, v))));
      }
    };
    window.addEventListener("yui-volume-change", handler);
    return () => window.removeEventListener("yui-volume-change", handler);
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  // 会話履歴を mount 直後に fetch (sessionId 確定後 1 回だけ)。
  // localStorage は同じ session_id を保持しているので、リロード/再起動後も過去ターンが復元される。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // sessionId が確定するまで microtask 待つ (上の useEffect で同期的に set される)
      await Promise.resolve();
      const sid = sessionIdRef.current;
      if (!sid) {
        setHistoryLoaded(true);
        return;
      }
      try {
        const res = await fetch(
          `/api/chat/history?session=${encodeURIComponent(sid)}&limit=100`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          messages: Array<{
            role: "user" | "assistant";
            content: string;
            attachments?: Array<{ filename: string; mediaType: string }>;
            toolSummary?: Array<{ name: string; brief: string }>;
            origin?: "raw" | "overlay-private" | "overlay-ephemeral";
          }>;
        };
        if (cancelled) return;
        // assistant 応答は元々段落チャンクで送られているので、表示時も
        // splitForTTS で同じ境界に分割して 1 チャンク = 1 バブルに復元する。
        const restored: Message[] = [];
        for (const m of data.messages) {
          const origin = m.origin ?? "raw";
          if (m.role === "assistant") {
            const chunks = splitForTTS(m.content);
            // tool_summary は分割された最後のチャンクに付ける (重複させない)
            const ts = m.toolSummary && m.toolSummary.length > 0 ? m.toolSummary : undefined;
            if (chunks.length === 0) {
              restored.push({ role: "assistant", content: m.content, toolSummary: ts, origin });
            } else {
              for (let i = 0; i < chunks.length; i++) {
                restored.push({
                  role: "assistant",
                  content: chunks[i],
                  toolSummary: i === chunks.length - 1 ? ts : undefined,
                  origin,
                });
              }
            }
          } else {
            // 過去画像添付 user msg は raw_messages 上 "[画像添付] ..." と保存されている。
            // bubble 上は marker を取り除き、attachments の filename から画像 URL 群を組む。
            const stripped = m.content.startsWith("[画像添付] ")
              ? m.content.slice("[画像添付] ".length)
              : m.content;
            const imageUrls = (m.attachments ?? []).map(
              (a) =>
                `/api/chat/image?session=${encodeURIComponent(sid)}&file=${encodeURIComponent(a.filename)}`
            );
            restored.push({
              role: m.role,
              content: stripped,
              imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
              origin,
            });
          }
        }
        setMessages(restored);
      } catch (e) {
        console.warn("[chat] history load failed:", e);
      } finally {
        if (!cancelled) setHistoryLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 初回挨拶: history 読み込み完了 && 履歴が空 のときだけ表示。
  // リロード時 (履歴あり) は「おかえり」を二重表示しないようスキップ。
  useEffect(() => {
    if (!historyLoaded) return;
    if (greeted.current) return;
    greeted.current = true;
    if (messages.length > 0) return; // 既存会話あり → 挨拶せず復帰
    const greeting = "おかえりなさいませ、ご主人様。本日はどのようにお過ごしですか?";
    // mount 後 1 回限りの挨拶投入。greeted.current ガードがあるので cascading は無い。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount greeting
    setMessages([{ role: "assistant", content: greeting }]);
    // 挨拶は最初のユーザー操作前なので AudioContext がまだ resume できない。
    // TTSは諦めて、表情とリップシンクだけ短く動かす。
    const timer = setTimeout(() => {
      audioBridge.current.speaking = true;
      onBotResponse("おかえりなさいませ", "relaxed");
      setTimeout(() => {
        audioBridge.current.speaking = false;
      }, 1500);
    }, 800);
    return () => clearTimeout(timer);
    // messages を deps に入れるとループするので意図的に除外
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyLoaded, onBotResponse, audioBridge]);

  /** Stop and disconnect any currently-playing TTS audio. */
  function cancelCurrentAudio() {
    const src = currentSourceRef.current;
    if (src) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already stopped */
      }
      currentSourceRef.current = null;
    }
    audioBridge.current.analyser = null;
    audioBridge.current.speaking = false;
  }

  /** AudioContext + gain node を遅延初期化。一度作ったら使い回す */
  function ensureAudioCtx(): AudioContext {
    if (!audioCtxRef.current) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    const ctx = audioCtxRef.current;
    if (!gainNodeRef.current) {
      gainNodeRef.current = ctx.createGain();
      gainNodeRef.current.gain.value = volume;
      gainNodeRef.current.connect(ctx.destination);
    }
    return ctx;
  }

  /**
   * /api/tts で TTS を取得し AudioBuffer まで decode する。
   * 同じテキストに対する複数同時呼び出しは 1 リクエストに集約 (Promise 共有)。
   * cache miss でなければそのまま既存 Promise を返すので追加トラフィック無し。
   */
  function fetchAndDecodeTTS(text: string): Promise<AudioBuffer | null> {
    const cache = ttsCacheRef.current;
    const existing = cache.get(text);
    if (existing) {
      // LRU: 触ったエントリを末尾に移動
      cache.delete(text);
      cache.set(text, existing);
      return existing;
    }

    const promise: Promise<AudioBuffer | null> = (async () => {
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          console.warn("TTS endpoint returned", res.status);
          return null;
        }
        const buf = await res.arrayBuffer();
        const ctx = ensureAudioCtx();
        return await ctx.decodeAudioData(buf);
      } catch (e) {
        console.warn("TTS fetch/decode failed:", e);
        return null;
      }
    })();

    cache.set(text, promise);
    // pruning (oldest first)
    while (cache.size > TTS_CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      if (firstKey === undefined) break;
      cache.delete(firstKey);
    }
    return promise;
  }

  /**
   * 既に decode 済みの AudioBuffer を再生。再生完了後に resolve する。
   * 直前に走っていた再生は cancelCurrentAudio で停止される (キューの順次性を保つため
   * 呼び出し側で適切に await 順を守ること)。
   */
  async function playBuffer(buffer: AudioBuffer): Promise<boolean> {
    try {
      const ctx = ensureAudioCtx();
      if (ctx.state === "suspended") await ctx.resume();

      cancelCurrentAudio();

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.4;

      // Chain: source → analyser → gain → destination
      source.connect(analyser);
      analyser.connect(gainNodeRef.current!);

      audioBridge.current.analyser = analyser;
      audioBridge.current.speaking = true;
      currentSourceRef.current = source;

      return await new Promise<boolean>((resolve) => {
        source.onended = () => {
          const wasCurrent = currentSourceRef.current === source;
          ttsLog("source onended", { wasCurrent, ctxState: ctx.state });
          if (wasCurrent) {
            audioBridge.current.speaking = false;
            audioBridge.current.analyser = null;
            currentSourceRef.current = null;
            // 古い (cancel された) source の onended で lip-sync-end を投げると、
            // 直後に始まる新規再生の lip-sync 開始フラグを消してしまうので、
            // 最新 source の onended でのみ end を通知する。
            window.dispatchEvent(new CustomEvent("yui-lip-sync-end"));
          }
          resolve(true);
        };
        // 再生開始と同時にリップシンクを起動。decode 完了 = TTS が「帰ってきた」
        // タイミングなので、ここで source.start() と CustomEvent dispatch を
        // 同期に呼ぶことで「TTS 帰ってきた瞬間に再生 + 口パクを発動」になる。
        source.start();
        ttsLog("source.start called", { ctxState: ctx.state, gainValue: gainNodeRef.current?.gain.value });
        window.dispatchEvent(new CustomEvent("yui-lip-sync-start"));
      });
    } catch (e) {
      console.warn("playBuffer failed:", e);
      return false;
    }
  }

  /** 後方互換: 単一テキストの fetch+play (cancellation 考慮なし)。SSE handler の保険 */
  async function playTTS(text: string): Promise<boolean> {
    const buf = await fetchAndDecodeTTS(text);
    if (!buf) return false;
    return playBuffer(buf);
  }

  /**
   * /sounds/<name>.mp3 を fetch + decode + cache。
   * timer / alarm 等の "chime" を即時鳴らすため。
   */
  function loadChime(name: string): Promise<AudioBuffer | null> {
    const cache = chimeCacheRef.current;
    const existing = cache.get(name);
    if (existing) return existing;
    const p: Promise<AudioBuffer | null> = (async () => {
      try {
        const res = await fetch(`/sounds/${name}.mp3`);
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        const ctx = ensureAudioCtx();
        return await ctx.decodeAudioData(buf);
      } catch (e) {
        console.warn(`[chime ${name}] load failed:`, e);
        return null;
      }
    })();
    cache.set(name, p);
    return p;
  }

  /**
   * Chime を再生 (TTS 再生 source を上書きしない、独立 source)。
   * gain node 経由なので volume slider が効く。AudioContext が suspend なら resume。
   */
  async function playChime(name: string): Promise<void> {
    const buf = await loadChime(name);
    if (!buf) return;
    try {
      const ctx = ensureAudioCtx();
      if (ctx.state !== "running") {
        await ctx.resume().catch(() => {});
      }
      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(gainNodeRef.current!);
        src.onended = () => resolve();
        src.start();
      });
    } catch (e) {
      console.warn(`[chime ${name}] play failed:`, e);
    }
  }

  /**
   * 応答テキストをチャンクに分割し、state に **同期で** 追加する。
   * これを呼んでから speakChunks() で TTS を別途流す。
   *
   * 同期追加にした理由: 以前は speakSequential が「state 追加 + 音声再生」を兼任していて、
   * react の async batch の隙間に次の send() が走ると ack が messages に欠落して、
   * 連続ユーザー発話が API 側で merge されて Sonnet が混乱する事故が起きた。
   * 「state は同期、音声は async」に分離することでこれを根絶。
   *
   * 戻り値: 追加されたチャンク列 (そのまま speakChunks に渡す用)。
   */
  function appendAssistantChunks(
    text: string,
    toolSummary?: Array<{ name: string; brief: string }>,
    origin?: "raw" | "overlay-private" | "overlay-ephemeral"
  ): string[] {
    const chunks = splitForTTS(text);
    if (chunks.length === 0) return [];
    const ts = toolSummary && toolSummary.length > 0 ? toolSummary : undefined;
    setMessages((m) => [
      ...m,
      ...chunks.map((c, i) => ({
        role: "assistant" as const,
        content: c,
        // tool_summary は最後のチャンクにだけ付与 (重複防止)
        ...(i === chunks.length - 1 && ts ? { toolSummary: ts } : {}),
        ...(origin ? { origin } : {}),
      })),
    ]);
    return chunks;
  }

  /**
   * 既に state に追加されたチャンク列を TTS で順次再生 (fire-and-forget で呼ぶ)。
   *
   * - 全チャンクの fetch+decode を限定並列 (再生中 + 1 個先読み) でキック
   * - 再生は順次。次の i+PREFETCH_AHEAD を再生開始前に発火し続ける
   * - 途中で新しい speak が走ったら世代カウンタで残チャンクをスキップ
   * - TTS が失敗したチャンクは fakeSpeak で時間相当の口パクだけ模擬
   */
  /**
   * 割り込み再生 (interrupt). user 送信由来の Yui 応答や即時通知に使う。
   * 現在再生中のものを cancel し、queue もクリアして即時自分が再生する。
   */
  async function speakChunks(chunks: string[]): Promise<void> {
    if (chunks.length === 0) return;
    // queue クリア (interrupt なので「再生開始時点で」溜まってたものは捨てる)
    speakQueueRef.current = [];
    await runChunks(chunks);
    // ⚠️ runChunks 実行中に SSE 経由で enqueueSpeak された分 (= 曲変化 fire 等の通知) は
    // この時点で queue に残っている。enqueueSpeak は isSpeaking=true の間 process を kick
    // しないため、ここで明示的に消化しないと「発話中に来た通知は永久に喋られない」状態になる。
    if (speakQueueRef.current.length > 0) {
      void processSpeakQueue();
    }
  }

  /**
   * Queue 投入 (= 今再生中なら待たせる、停止中なら即再生)。
   * SSE 経由の news / music / 通知 / timer voice 等で使う。
   */
  function enqueueSpeak(chunks: string[]): void {
    if (chunks.length === 0) return;
    speakQueueRef.current.push(chunks);
    if (!isSpeakingRef.current) {
      void processSpeakQueue();
    }
  }

  /** queue を 1 件ずつ消化する。再帰的に次を取り出す。*/
  async function processSpeakQueue(): Promise<void> {
    if (isSpeakingRef.current) return;
    const next = speakQueueRef.current.shift();
    if (!next) return;
    await runChunks(next);
    // chunks 完走 / cancel どちらでも、queue にまだ残ってたら次へ
    if (speakQueueRef.current.length > 0) {
      void processSpeakQueue();
    }
  }

  /** 内部: 実際に chunks を順次再生。speak generation で cancel 可能。*/
  async function runChunks(chunks: string[]): Promise<void> {
    if (chunks.length === 0) return;
    const myGen = ++speakGenerationRef.current;
    isSpeakingRef.current = true;
    ttsLog("runChunks start", { count: chunks.length, gen: myGen });

    // TTS 用 text を準備 (= URL を除去、URL のみ chunk なら "" = 完全 skip)
    const ttsTexts = chunks.map((c) => stripUrlForTts(c));

    try {
      const PREFETCH_AHEAD = 1;
      const prefetches: Array<Promise<AudioBuffer | null> | null> = chunks.map(() => null);
      const queueFetch = (idx: number) => {
        if (idx >= chunks.length || prefetches[idx] !== null) return;
        const ttsText = ttsTexts[idx];
        if (!ttsText) {
          prefetches[idx] = Promise.resolve(null); // URL のみ chunk → TTS skip
        } else {
          prefetches[idx] = fetchAndDecodeTTS(ttsText);
        }
      };
      for (let i = 0; i <= PREFETCH_AHEAD && i < chunks.length; i++) queueFetch(i);

      for (let i = 0; i < chunks.length; i++) {
        if (myGen !== speakGenerationRef.current) {
          ttsLog("gen invalidated, abort", { i, myGen, current: speakGenerationRef.current });
          return;
        }
        const chunk = chunks[i];
        const ttsText = ttsTexts[i];

        queueFetch(i + PREFETCH_AHEAD);

        const buffer = await prefetches[i];
        if (myGen !== speakGenerationRef.current) {
          ttsLog("gen invalidated post-fetch", { i });
          return;
        }

        // URL のみ chunk (= ttsText 空) → 表示は出るが TTS は完全スキップ
        if (!ttsText) {
          ttsLog("url-only chunk, skip TTS", { i });
          continue;
        }

        if (!buffer) {
          ttsWarn("no buffer for chunk, fakeSpeak", { i, len: chunk.length });
          await fakeSpeak(ttsText);
          if (myGen !== speakGenerationRef.current) return;
          continue;
        }

        ttsLog("playBuffer", { i, duration: buffer.duration.toFixed(2) });
        const ok = await playBuffer(buffer);
        if (myGen !== speakGenerationRef.current) {
          ttsLog("gen invalidated post-play", { i });
          return;
        }
        if (!ok) {
          ttsWarn("playBuffer failed, fakeSpeak", { i });
          await fakeSpeak(ttsText);
          if (myGen !== speakGenerationRef.current) return;
        } else {
          ttsLog("chunk done", { i });
        }
      }
      ttsLog("runChunks complete");
    } finally {
      if (myGen === speakGenerationRef.current) {
        isSpeakingRef.current = false;
      }
    }
  }

  /**
   * 後方互換: text 受けて「state 追加 → TTS 再生」を一気に。
   * 同期 state 追加が肝。新規コードは appendAssistantChunks + speakChunks を直接使う方が安全。
   */
  async function speakSequential(text: string, _emotion: VRMExpression): Promise<void> {
    const chunks = appendAssistantChunks(text);
    await speakChunks(chunks);
  }

  async function fakeSpeak(chunk: string): Promise<void> {
    audioBridge.current.speaking = true;
    const ms = Math.max(700, Math.min(5000, chunk.length * 110));
    await new Promise((r) => setTimeout(r, ms));
    audioBridge.current.speaking = false;
  }

  // SSE handler 側からも呼ぶので ref に置く
  useEffect(() => {
    playTTSRef.current = playTTS;
    speakSequentialRef.current = speakSequential;
    appendAssistantChunksRef.current = appendAssistantChunks;
    speakChunksRef.current = speakChunks;
    enqueueSpeakRef.current = enqueueSpeak;
  });

  // ESC キー: 現在の読み上げを即時中断 + queue の次へスキップ。
  // input フォーカス中は ESC が IME 確定取消等で使われるので捕まえない。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t as HTMLElement).isContentEditable)) {
        return;
      }
      if (!isSpeakingRef.current && speakQueueRef.current.length === 0) return;
      // 現在再生中の chunk を invalidate (= runChunks の generation guard で次 chunk から abort)
      speakGenerationRef.current++;
      isSpeakingRef.current = false;
      ttsLog("ESC pressed: cancel current + advance queue", {
        remaining: speakQueueRef.current.length,
      });
      // queue にまだ残ってたら次へ進める
      if (speakQueueRef.current.length > 0) {
        void processSpeakQueue();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // processSpeakQueue を deps に入れると keydown listener が毎レンダー再 attach、TTS 連鎖を壊す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 「いいね」反応など、chat history には載せない単発の発話を外から発火する経路。
  // page.tsx が dispatchEvent("yui-speak-line", {detail: {text}}) で呼ぶ。
  // 既存の TTS pipeline (cache + audioBridge 注入で口パク連動) をそのまま再利用する。
  useEffect(() => {
    const onSpeak = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string }>).detail;
      const text = detail?.text?.trim();
      if (!text) return;
      void playTTSRef.current?.(text);
    };
    window.addEventListener("yui-speak-line", onSpeak);
    return () => window.removeEventListener("yui-speak-line", onSpeak);
  }, []);

  // 日記読み上げ等、長文を 1 個ずつ先読みしながら直列再生する公開 API。
  // 既存 speakChunks (= 1 個先まで decode を Promise で先行 + 順次 await play) を流用。
  // 中断は speakGenerationRef を進めて cancelCurrentAudio を呼ぶ。
  useEffect(() => {
    type W = Window & {
      __yuiSpeakText?: (text: string) => Promise<void>;
      __yuiSpeakCancel?: () => void;
    };
    const w = window as W;
    w.__yuiSpeakText = async (text: string) => {
      const t = text.trim();
      if (!t) return;
      const chunks = splitForTTS(t);
      if (chunks.length === 0) return;
      await speakChunksRef.current?.(chunks);
    };
    w.__yuiSpeakCancel = () => {
      speakGenerationRef.current++;
      cancelCurrentAudio();
    };
    return () => {
      delete w.__yuiSpeakText;
      delete w.__yuiSpeakCancel;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send() {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || loading) return;
    // 画像のみ送信時はテキストを空にしないよう placeholder を入れる
    // (Anthropic は content blocks 配列の末尾が text の方が安定挙動)
    const userText = text || (pendingImages.length > 1 ? "(画像を見てください)" : "(画像を見てください)");

    const images = pendingImages;
    // currentUserState を先に取得して userMsg の origin を決める。
    // private 中なら overlay-private (= 解除後の LLM 文脈から除外)、それ以外は raw。
    const currentUserState =
      typeof window !== "undefined"
        ? window.localStorage.getItem("vroid-user-state")
        : null;
    const isPrivateNow = currentUserState === "private";
    const userMsg: Message = {
      role: "user",
      content: userText,
      imageUrls: images.length > 0 ? images.map((i) => i.dataUrl) : undefined,
      origin: isPrivateNow ? "overlay-private" : "raw",
    };
    // プライベートモード解除後は overlay-private な messages を LLM 文脈から除外する
    // (private 中に話した内容は、解除後の通常会話に文脈漏洩させない)。
    // private 中は全部含めて文脈を保つ。overlay-ephemeral (ニュース/音楽紹介) は
    // private 性のない発話なのでモード問わず含める。
    const contextMessages = isPrivateNow
      ? messages
      : messages.filter((m) => m.origin !== "overlay-private");

    // 履歴は text のみで持つ (画像は過去ターン分は再送しない: トークン爆発防止)。
    // 今回ターンの user msg だけ images を bundle して送る。
    const mergedHistory = mergeConsecutiveSameRole([
      ...contextMessages,
      { role: "user", content: userText },
    ]);
    const history: Array<{
      role: "user" | "assistant";
      content: string;
      images?: Array<{ mediaType: string; data: string }>;
      toolSummary?: Array<{ name: string; brief: string }>;
    }> = mergedHistory.map((m, i) => {
      const base: {
        role: "user" | "assistant";
        content: string;
        toolSummary?: Array<{ name: string; brief: string }>;
      } = { role: m.role, content: m.content };
      if (m.role === "assistant" && m.toolSummary && m.toolSummary.length > 0) {
        base.toolSummary = m.toolSummary;
      }
      if (i === mergedHistory.length - 1 && images.length > 0) {
        return {
          ...base,
          images: images.map((img) => ({ mediaType: img.mediaType, data: img.data })),
        };
      }
      return base;
    });
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setPendingImages([]);
    setImageError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    // textarea の高さも明示リセット (auto-grow が空後も伸びたままにならないように)
    if (inputRef.current) inputRef.current.style.height = "auto";
    setLoading(true);

    // 連投時 / unmount 時に前回の /api/chat を打ち切る
    chatFetchAbortRef.current?.abort();
    const ac = new AbortController();
    chatFetchAbortRef.current = ac;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          sessionId: sessionIdRef.current,
          source: "web",
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `API error ${res.status}`);
      }
      const data = (await res.json()) as {
        reply: string;
        emotion: VRMExpression;
        pendingJobs?: Array<{ jobId: number; specialist: string }>;
        toolSummary?: Array<{ name: string; brief: string }>;
      };

      // 表情は応答全体に対して 1 回だけ設定 (チャンクごとには変えない)
      onBotResponse(data.reply, data.emotion ?? "neutral");

      // bg job が spawn されたら pendingJobs に追加 (SSE で yui_message を待つ)
      if (data.pendingJobs && data.pendingJobs.length > 0) {
        const now = Date.now();
        setPendingJobs((m) => {
          const next = new Map(m);
          for (const j of data.pendingJobs!) {
            next.set(j.jobId, { specialist: j.specialist, startedAt: now });
          }
          return next;
        });
      }

      // 重要: state 追加を **同期** で行ってから TTS は fire-and-forget。
      // これで次の send() が走った時には ack 含めて messages が確定済 (race なし)。
      // 最後のチャンクに toolSummary を付与し、次ターン送信時に Sonnet へ実行履歴を渡す。
      // user msg と同じ origin を assistant 応答にも付ける (private 中の返答は overlay-private、
      // 通常モードの返答は raw)。isPrivateNow は doSend 冒頭で localStorage 読み出し済。
      const replyOrigin: "raw" | "overlay-private" = isPrivateNow ? "overlay-private" : "raw";
      const chunks = appendAssistantChunks(data.reply, data.toolSummary, replyOrigin);
      void speakChunks(chunks);
    } catch (e) {
      // AbortError = 連投 or unmount による意図的キャンセル → 静かに無視 (UI に出さない)。
      if (e instanceof DOMException && e.name === "AbortError") {
        return;
      }
      console.error(e);
      const msg = e instanceof Error ? e.message : "不明なエラー";
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: `申し訳ございません、少し不調のようです。(${msg})`,
        },
      ]);
      onBotResponse("申し訳ございません", "sad");
    } finally {
      // 自分の AC が現在 ref と一致するときだけ後始末する。一致しないなら、
      // 後発の send が既に走っており、そちらの finally が loading 管理を引き継ぐ
      // (= ここで setLoading(false) すると後発 send の loading=true を踏み消す)。
      if (chatFetchAbortRef.current === ac) {
        chatFetchAbortRef.current = null;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    return () => {
      cancelCurrentAudio();
      audioCtxRef.current?.close().catch(() => {});
      // unmount で in-flight /api/chat fetch を中断 (= 後発の setState を防ぐ)
      chatFetchAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="chat-panel">
      <div className="chat-panel-header">
        {/* TODO: 将来的にオプションで設定したユーザー呼び方 (persona.userAddressWork) を反映 */}
        <span className="chat-panel-title">ご主人様</span>
        <UserStatePicker sessionId={sessionId} />
      </div>
      <div className="chat-messages" ref={listRef}>
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg chat-msg-${m.role}`}>
            <div className="chat-bubble">
              {m.imageUrls && m.imageUrls.length > 0 && (
                <div
                  className={`chat-bubble-images chat-bubble-images-${
                    m.imageUrls.length === 1 ? "one" : "grid"
                  }`}
                >
                  {m.imageUrls.map((url, j) => (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      key={j}
                      src={url}
                      alt=""
                      className="chat-bubble-image"
                      loading="lazy"
                    />
                  ))}
                </div>
              )}
              {renderBubbleContent(m.content)}
            </div>
          </div>
        ))}
        {loading && (
          <div className="chat-msg chat-msg-assistant">
            <div className="chat-bubble chat-typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {pendingJobs.size > 0 && (
          <div className="chat-pending">
            <span className="chat-pending-spinner" />
            <span className="chat-pending-text">
              {specialistsLabel(pendingJobs)}を確認中…
            </span>
          </div>
        )}
      </div>
      <form
        className={`chat-input ${isDragOver ? "chat-input-dragover" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void doSend();
        }}
        onDragEnter={(e) => {
          if (!e.dataTransfer?.types.includes("Files")) return;
          e.preventDefault();
          dragCounterRef.current += 1;
          setIsDragOver(true);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(e) => {
          if (!e.dataTransfer?.types.includes("Files")) return;
          dragCounterRef.current -= 1;
          if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setIsDragOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragCounterRef.current = 0;
          setIsDragOver(false);
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (files.length > 0) void addImageFiles(files);
        }}
      >
        {(pendingImages.length > 0 || imageError) && (
          <div className="chat-input-attach">
            {pendingImages.map((img, i) => (
              <div key={i} className="chat-input-attach-item">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.dataUrl} alt="" />
                <span className="chat-input-attach-info">
                  {img.width}×{img.height} · {(img.bytes / 1024).toFixed(0)} KB
                </span>
                <button
                  type="button"
                  className="chat-input-attach-remove"
                  onClick={() => {
                    setPendingImages((prev) => prev.filter((_, j) => j !== i));
                  }}
                  aria-label="画像を削除"
                >
                  ×
                </button>
              </div>
            ))}
            {imageError && (
              <span className="chat-input-attach-error">{imageError}</span>
            )}
          </div>
        )}
        <div className="chat-input-row">
          <input
            ref={fileInputRef}
            type="file"
            name="chat-image-attach"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length === 0) return;
              await addImageFiles(files);
              if (e.target) e.target.value = "";
            }}
          />
          <button
            type="button"
            className="chat-input-image-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            aria-label="画像を添付"
            title="画像を添付 (ドラッグ&ドロップ / Cmd+V も可)"
          >
            📎
          </button>
          <textarea
            ref={inputRef}
            name="chat-message"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // auto-resize: 内容に合わせて高さを調整 (max-height で頭打ち)
              const ta = e.target;
              ta.style.height = "auto";
              ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
            }}
            onKeyDown={(e) => {
              // Enter で送信、Shift+Enter で改行 (IME 変換中は送信しない)
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void doSend();
              }
            }}
            onPaste={(e) => {
              // クリップボードに画像があれば picker と同じ流れに乗せる。
              // テキスト貼り付けは妨げない (e.preventDefault しない)。
              const items = Array.from(e.clipboardData?.items ?? []);
              const files: File[] = [];
              for (const it of items) {
                if (it.kind === "file") {
                  const f = it.getAsFile();
                  if (f && f.type.startsWith("image/")) files.push(f);
                }
              }
              if (files.length > 0) {
                e.preventDefault();
                void addImageFiles(files);
              }
            }}
            placeholder="メッセージを入力"
            disabled={loading}
            autoFocus
            rows={1}
          />
          <button
            type="submit"
            disabled={loading || (!input.trim() && pendingImages.length === 0)}
          >
            送信
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * ChatPanel ヘッダ右の状態 pill。クリックで 3 択 popover を出す。
 * useUserState が localStorage + サーバ同期 + 自動離席を担当。
 */
const STATE_LABEL: Record<UserState, string> = {
  online: "オンライン",
  away: "離席中",
  focus: "集中モード",
  private: "プライベート",
};

function UserStatePicker({ sessionId }: { sessionId: string }) {
  const { state, setState } = useUserState(sessionId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="chat-panel-status-wrap" ref={ref}>
      <button
        type="button"
        className={`chat-panel-status chat-panel-status-${state}`}
        onClick={() => setOpen((v) => !v)}
        title="ステータスを切替"
      >
        <span className="chat-panel-status-value">{STATE_LABEL[state]}</span>
        <svg
          className="chat-panel-status-chevron"
          viewBox="0 0 12 8"
          width="12"
          height="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="2 2 6 6 10 2" />
        </svg>
      </button>
      {open && (
        <ul className="chat-panel-status-popover" role="menu">
          {(["online", "away", "focus", "private"] as UserState[]).map((s) => (
            <li key={s}>
              <button
                type="button"
                className={`chat-panel-status-option ${state === s ? "active" : ""}`}
                onClick={() => {
                  setState(s);
                  setOpen(false);
                }}
              >
                <span className={`chat-panel-status-dot dot-${s}`} aria-hidden="true" />
                {STATE_LABEL[s]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
