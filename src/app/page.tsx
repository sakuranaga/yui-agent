"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ChatPanel, { type AudioBridge } from "@/components/ChatPanel";
import ToolConfirmDialog from "@/components/ToolConfirmDialog";
import IconBar from "@/components/IconBar";
import MusicModal from "@/components/MusicModal";
import ReportPanel, { type Report } from "@/components/ReportPanel";
import SettingsModal from "@/components/SettingsModal";
import LogModal from "@/components/LogModal";
import TodoModal from "@/components/TodoModal";
import ContactsModal from "@/components/ContactsModal";
import DiaryModal from "@/components/DiaryModal";
import NewsModal from "@/components/NewsModal";
import CalendarModal from "@/components/CalendarModal";
import MailModal from "@/components/MailModal";
import MailComposeModal, { type ComposeMode } from "@/components/MailComposeModal";
import SleepModal from "@/components/SleepModal";
import HealthModal from "@/components/HealthModal";
import RemindersModal from "@/components/RemindersModal";
import NotesModal from "@/components/NotesModal";
import SpotifyWebPlayer from "@/components/SpotifyWebPlayer";
import SleepOverlay from "@/components/SleepOverlay";
import ProjectHubModal from "@/components/ProjectHubModal";
import EnvironmentWidget from "@/components/EnvironmentWidget";
import HeartBurst, { type HeartBurst as HeartBurstType } from "@/components/HeartBurst";
import NotificationToast from "@/components/NotificationToast";
import SecretaryCard from "@/components/SecretaryCard";
import ThemeProvider from "@/components/ThemeProvider";
import TimerToast from "@/components/TimerToast";
import type { VRMExpression } from "@/components/VRMViewer";

const VRMViewer = dynamic(() => import("@/components/VRMViewer"), {
  ssr: false,
  loading: () => <div className="vrm-loading">Loading...</div>,
});

const SESSION_STORAGE_KEY = "vroid-chat-session-id";

// VRM ダブルクリックでハートを送られた時、Yui が言う短い嬉しがりライン。
// TTS cache が効くので、初回以外は瞬時に再生される。
const HEART_LINES = [
  "えへへ…",
  "ありがとうございます",
  "あら、嬉しい",
  "ふふ、ご主人様…",
  "えへ、お気に召しましたか?",
  "ありがとうございます、ご主人様",
  "ふふ…もう",
  "嬉しい…",
  "うふっ",
  "お優しいご主人様…",
  "ご主人様、嬉しゅうございます",
  "もう、ご主人様ったら",
  "えへ、もうっ",
  "ふふ、もっとですか?",
];

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ハート burst を発火しても良い DOM 要素かを判定: chat-panel / IconBar /
// EnvironmentWidget / ReportPanel / モーダル / ボタン類の上は無視する。
const HEART_IGNORE_SELECTOR = [
  ".chat-panel",
  ".icon-bar",
  ".env-widget",
  ".report-panel",
  ".report-panel-toggle",
  "[role='dialog']",
  "button",
  "a",
  "input",
  "textarea",
].join(",");

const HEART_BURST_TTL_MS = 1600;

export default function Home() {
  const router = useRouter();

  // 旧: localhost / 0.0.0.0 を 127.0.0.1 に強制 redirect していた (= Spotify OAuth が
  // 127.0.0.1 強制 + localStorage origin 分離回避のため)。
  // Caddy + HTTPS (https://localhost:8443) 移行後は Spotify redirect URI も localhost で
  // 揃えたので、強制 redirect は不要 (= むしろ http://127.0.0.1:3000 に逃がして Caddy を
  // 跨ぐ事故 = 「HTTP request to HTTPS server」エラーの原因になる)。
  //
  // 0.0.0.0 だけは念のため localhost に揃える (= ブラウザが 0.0.0.0 で開いた場合)。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const h = window.location.hostname;
    if (h === "0.0.0.0") {
      window.location.replace(
        `${window.location.protocol}//localhost${window.location.port ? ":" + window.location.port : ""}${window.location.pathname}${window.location.search}${window.location.hash}`
      );
    }
  }, []);

  // 初回セットアップ判定: AI key / main model / Embeddings の最低限が揃ってなければ
  // /setup ウィザードへリダイレクト。setupReady=null の間は UI を render しない
  // (= 未設定状態で main UI が一瞬チラ見えして VRM / SSE を起動してしまう事故防止)。
  // 片道のみのリダイレクト (= /setup から / に戻る経路は無い) で、ユーザは /setup から
  // 再アクセスして上書き可能 (= テスト & 設定変更運用)。
  const [setupReady, setSetupReady] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/setup/status", { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          // status endpoint が落ちてる時はユーザを止めない (= main UI へ進める)
          setSetupReady(true);
          return;
        }
        const data = (await res.json()) as { configured: boolean };
        if (!data.configured) {
          router.replace("/setup");
          return;
        }
        setSetupReady(true);
      } catch {
        if (!cancelled) setSetupReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const [expression, setExpression] = useState<VRMExpression>("neutral");
  // ReportPanel 用: 最新 10 件を新しい順 (newest first) で保持。永続化しない。
  const [reports, setReports] = useState<Report[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [musicOpen, setMusicOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [todoOpen, setTodoOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [diaryOpen, setDiaryOpen] = useState(false);
  const [newsOpen, setNewsOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [mailOpen, setMailOpen] = useState(false);
  const [sleepOpen, setSleepOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  // ReportPanel のノートタイトルタブクリックで開く対象ノート。NotesModal が消費したら null に戻す。
  const [focusNoteId, setFocusNoteId] = useState<number | null>(null);
  // Hub からのジャンプ要求: 該当 modal を開く + project filter を pre-set。
  // 受信した event.detail.projectName を該当 modal に prop で流す。
  const [todoPresetProject, setTodoPresetProject] = useState<string | null>(null);
  // Intent dispatch (Mail → TODO 等) 経由で渡される pre-fill 内容。
  // 受信して TodoModal を open + draft を prop で流す。
  const [todoIntentDraft, setTodoIntentDraft] = useState<{
    title?: string;
    note?: string;
    dueIso?: string;
    tags?: string[];
  } | null>(null);
  const [todoIntentInherits, setTodoIntentInherits] = useState<
    Array<{ id: number; name: string; color: string | null }>
  >([]);
  const [todoIntentSource, setTodoIntentSource] = useState<{ type: string; id: string } | null>(null);
  // Calendar / Contacts も同じく intent dispatch から draft + source を受け取って
  // 該当 modal を pre-fill 状態で開く。
  const [calendarIntentDraft, setCalendarIntentDraft] = useState<{
    summary?: string;
    description?: string;
    startIso?: string;
    endIso?: string;
    location?: string;
  } | null>(null);
  const [calendarIntentSource, setCalendarIntentSource] = useState<{ type: string; id: string } | null>(null);
  const [contactsIntentDraft, setContactsIntentDraft] = useState<{
    name?: string;
    role?: string;
    organization?: string;
    emails?: string[];
    phones?: string[];
    notes?: string;
  } | null>(null);
  const [contactsIntentSource, setContactsIntentSource] = useState<{ type: string; id: string } | null>(null);
  // ContactsModal の「メール送信」 etc から compose を直接起動する用 (LLM 経由しない)。
  // MailModal 内部の compose とは独立。to を ContactsModal などから注入できる。
  const [externalCompose, setExternalCompose] = useState<ComposeMode | null>(null);
  useEffect(() => {
    const handler = (ev: Event) => {
      const d = (ev as CustomEvent<{ toPrefill?: string[]; subjectPrefill?: string }>).detail;
      if (!d) return;
      setExternalCompose({
        kind: "new",
        toPrefill: d.toPrefill,
        subjectPrefill: d.subjectPrefill,
      });
    };
    window.addEventListener("yui-open-compose", handler);
    return () => window.removeEventListener("yui-open-compose", handler);
  }, []);
  // SettingsModal を CustomEvent で開く (= MusicModal 等から「設定を開く」で利用)
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener("yui-open-settings", handler);
    return () => window.removeEventListener("yui-open-settings", handler);
  }, []);
  // Spotify OAuth callback の戻り (= ?spotify_connected= or ?spotify_error=) を検知
  // → SettingsModal を自動で開く。URL から query を削除して履歴を綺麗に。
  // mount 時 1 回だけの post-redirect 処理なので cascading render は起きない。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.has("spotify_connected") || sp.has("spotify_error")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot OAuth callback handler on mount
      setSettingsOpen(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("spotify_connected");
      url.searchParams.delete("spotify_error");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);
  useEffect(() => {
    const handler = (ev: Event) => {
      const d = (ev as CustomEvent<{
        target?: string;
        draft?: { title?: string; note?: string; dueAt?: string; tags?: string[] } | null;
        inheritedProjects?: Array<{ id: number; name: string; color: string | null }>;
        inheritedProjectIds?: number[];
        sourceType?: string;
        sourceId?: string;
        warning?: string;
        sourceFallback?: { title?: string; note?: string };
      }>).detail;
      if (!d) return;
      if (d.target === "todo") {
        const draft = d.draft ?? d.sourceFallback ?? {};
        setTodoIntentDraft({
          title: draft.title ?? undefined,
          note: draft.note ?? undefined,
          dueIso:
            "dueAt" in draft && typeof draft.dueAt === "string"
              ? draft.dueAt
              : undefined,
          tags:
            "tags" in draft && Array.isArray(draft.tags) ? draft.tags : undefined,
        });
        setTodoIntentInherits(d.inheritedProjects ?? []);
        setTodoIntentSource(
          d.sourceType && d.sourceId
            ? { type: d.sourceType, id: d.sourceId }
            : null
        );
        setTodoOpen(true);
      } else if (d.target === "event") {
        const raw = (d.draft ?? {}) as Record<string, unknown>;
        setCalendarIntentDraft({
          summary: typeof raw.summary === "string" ? raw.summary : undefined,
          description: typeof raw.description === "string" ? raw.description : undefined,
          startIso: typeof raw.startIso === "string" ? raw.startIso : undefined,
          endIso: typeof raw.endIso === "string" ? raw.endIso : undefined,
          location: typeof raw.location === "string" ? raw.location : undefined,
        });
        setCalendarIntentSource(
          d.sourceType && d.sourceId
            ? { type: d.sourceType, id: d.sourceId }
            : null
        );
        setCalendarOpen(true);
      } else if (d.target === "contact") {
        const raw = (d.draft ?? {}) as Record<string, unknown>;
        setContactsIntentDraft({
          name: typeof raw.name === "string" ? raw.name : undefined,
          role: typeof raw.role === "string" ? raw.role : undefined,
          organization: typeof raw.organization === "string" ? raw.organization : undefined,
          emails: Array.isArray(raw.emails)
            ? (raw.emails as unknown[]).filter((x): x is string => typeof x === "string")
            : undefined,
          phones: Array.isArray(raw.phones)
            ? (raw.phones as unknown[]).filter((x): x is string => typeof x === "string")
            : undefined,
          notes: typeof raw.notes === "string" ? raw.notes : undefined,
        });
        setContactsIntentSource(
          d.sourceType && d.sourceId
            ? { type: d.sourceType, id: d.sourceId }
            : null
        );
        setContactsOpen(true);
      }
    };
    window.addEventListener("yui-intent-draft", handler);
    return () => window.removeEventListener("yui-intent-draft", handler);
  }, []);
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ tool: string; projectName?: string; artifactId?: string }>).detail;
      if (!detail) return;
      // artifactId 引数は将来の deep-link 用 (該当 item を選択状態で開く)。
      // 現状はまだどの modal もサポートしてないので単に modal を開くだけ。
      switch (detail.tool) {
        case "todo":
          setTodoPresetProject(detail.projectName ?? null);
          setTodoOpen(true);
          break;
        case "mail":
          setMailOpen(true);
          break;
        case "contact":
          setContactsOpen(true);
          break;
        case "calendar":
          setCalendarOpen(true);
          break;
      }
    };
    window.addEventListener("yui-jump-modal", handler);
    return () => window.removeEventListener("yui-jump-modal", handler);
  }, []);
  // 現在の VRM モデル URL。/api/vrm/current から解決、未登録なら /girl.vrm に fallback。
  // 切替時は SettingsModal が "vrm-current-changed" CustomEvent を発火 → ここで refetch。
  const [vrmUrl, setVrmUrl] = useState<string>("/girl.vrm");
  useEffect(() => {
    let cancelled = false;
    const fetchCurrent = async () => {
      try {
        const res = await fetch("/api/vrm/current", { cache: "no-store" });
        const json = (await res.json()) as { model: { id: number } | null };
        if (cancelled) return;
        setVrmUrl(json.model ? `/api/vrm/models/${json.model.id}/file` : "/girl.vrm");
      } catch (e) {
        console.warn("[page] vrm/current fetch failed, using fallback:", e);
        if (!cancelled) setVrmUrl("/girl.vrm");
      }
    };
    void fetchCurrent();
    const handler = () => void fetchCurrent();
    window.addEventListener("vrm-current-changed", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("vrm-current-changed", handler);
    };
  }, []);
  // TimerToast 用に sessionId を読む (ChatPanel が localStorage に書く同じキー)。
  // 旧実装は「mount 時 + 1 秒後の再確認」だけだったため、ChatPanel の初期化が遅れると
  // sessionId が永遠に空のままになる事故があった。代わりに ChatPanel が
  // localStorage を書いた瞬間に発火させる `vroid-session-changed` を listen。
  // 他タブで sessionId が変わるケースも標準 `storage` event で拾う。
  const [sessionId, setSessionId] = useState<string>("");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => {
      const sid = window.localStorage.getItem(SESSION_STORAGE_KEY);
      // 初期値が ""、変化なしの再 setState は React 側で no-op。
      setSessionId(sid ?? "");
    };
    sync();
    const onStorage = (e: StorageEvent) => {
      if (e.key === SESSION_STORAGE_KEY) sync();
    };
    window.addEventListener("vroid-session-changed", sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("vroid-session-changed", sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const audioBridge = useRef<AudioBridge>({ analyser: null, speaking: false });
  const expressionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleBotResponse = useCallback(
    (text: string, emotion: VRMExpression) => {
      setExpression(emotion);
      if (expressionTimerRef.current) clearTimeout(expressionTimerRef.current);
      const holdMs = Math.max(2500, Math.min(10000, text.length * 130 + 1500));
      expressionTimerRef.current = setTimeout(() => {
        setExpression("neutral");
      }, holdMs);
    },
    []
  );

  const handleReportUpdate = useCallback(
    (title: string, markdown: string, noteId?: number) => {
      const fresh: Report = { title, markdown, receivedAt: Date.now(), noteId };
      // 新着を先頭に追加し、最新 10 件のみ保持。
      setReports((prev) => [fresh, ...prev].slice(0, 10));
    },
    []
  );

  // ReportPanel のノートタイトルタブをクリック → その note を NotesModal で開く。
  const handleOpenNoteFromReport = useCallback((noteId: number) => {
    setFocusNoteId(noteId);
    setNotesOpen(true);
  }, []);

  // ハート burst の管理 (VRM 上のダブルクリック対応)
  const [heartBursts, setHeartBursts] = useState<HeartBurstType[]>([]);
  const burstIdRef = useRef(0);
  const lastSpokeAtRef = useRef(0);
  // 表情戻し用 generation: dblclick 毎に +1。古い reset job は自分の世代と
  // 現在の世代が違えば自主放棄する (連打中に古い restorer が neutral にしないため)。
  const happyGenRef = useRef(0);
  // シャッフルバッグ: HEART_LINES を 1 巡使い切るまで重複させない。
  // 巡が空になったら再 shuffle、その際に直前最後のセリフと先頭が一致する場合は
  // もう 1 度 shuffle して連続重複も避ける。
  const heartLineBagRef = useRef<string[]>([]);
  const heartLineLastRef = useRef<string | null>(null);
  const pickHeartLine = useCallback((): string => {
    if (heartLineBagRef.current.length === 0) {
      let next = shuffleInPlace([...HEART_LINES]);
      if (next[0] === heartLineLastRef.current && next.length > 1) {
        next = shuffleInPlace(next);
      }
      heartLineBagRef.current = next;
    }
    const line = heartLineBagRef.current.shift()!;
    heartLineLastRef.current = line;
    return line;
  }, []);

  const handleViewerDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // chat-panel やボタン類の上のダブルクリックは無視 (Canvas / 余白のみ反応)
      const target = e.target as HTMLElement;
      if (target.closest && target.closest(HEART_IGNORE_SELECTOR)) return;

      const id = ++burstIdRef.current;
      const newBurst: HeartBurstType = { id, x: e.clientX, y: e.clientY };
      setHeartBursts((prev) => [...prev, newBurst]);
      // TTL 経過後に除去
      setTimeout(() => {
        setHeartBursts((prev) => prev.filter((b) => b.id !== id));
      }, HEART_BURST_TTL_MS);

      // happy 表情を即時セット (戻すタイミングは発話有無で分岐)
      const gen = ++happyGenRef.current;
      setExpression("happy");
      if (expressionTimerRef.current) {
        clearTimeout(expressionTimerRef.current);
        expressionTimerRef.current = null;
      }

      // 発話判定はクライアント側 5sec throttle のみで決める (DB 失敗に依存させない)。
      // DB への記録は fire-and-forget で並行に走らせる。
      const now = Date.now();
      const willSpeak = now - lastSpokeAtRef.current >= 5000;
      if (willSpeak) {
        lastSpokeAtRef.current = now;
        const line = pickHeartLine();
        window.dispatchEvent(
          new CustomEvent("yui-speak-line", { detail: { text: line } })
        );
        // 表情戻し: audioBridge.speaking が true になるのを最大 1.5 秒待ち、
        // その後 false に落ちるまで最大 8 秒待つ。両 timeout は TTS fetch 失敗等の保険。
        void (async () => {
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          const waitStart = Date.now();
          while (
            gen === happyGenRef.current &&
            !audioBridge.current.speaking &&
            Date.now() - waitStart < 1500
          ) {
            await sleep(50);
          }
          const speechStart = Date.now();
          while (
            gen === happyGenRef.current &&
            audioBridge.current.speaking &&
            Date.now() - speechStart < 8000
          ) {
            await sleep(50);
          }
          if (gen === happyGenRef.current) setExpression("neutral");
        })();
      } else {
        // 連打中で発話 skip: 固定 1.5 秒で戻す (ハート粒子の寿命とほぼ同じ)
        expressionTimerRef.current = setTimeout(() => {
          if (gen === happyGenRef.current) setExpression("neutral");
        }, 1500);
      }

      const sid = window.localStorage.getItem(SESSION_STORAGE_KEY);
      if (sid) {
        void fetch("/api/likes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sid,
            clickX: e.clientX,
            clickY: e.clientY,
          }),
        }).catch((err) => console.warn("[like] post failed:", err));
      }
    },
    // pickHeartLine は useCallback で安定だが、deps に入れると handler が再生成されて
    // VRMViewer の onDoubleClick が毎レンダー差し替わる。意図的に固定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // セットアップ判定が完了するまで main UI を render しない。これで未設定状態の
  // 一瞬の表示や、無意味な fetch (= chat history / SSE 接続 / VRM ロード) を防ぐ。
  if (setupReady === null) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f0f12",
          color: "#888",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <span style={{ fontSize: "0.9rem" }}>初回セットアップ状態を確認中…</span>
      </main>
    );
  }

  return (
    <main className="layout">
      <ThemeProvider />
      <div className="viewer" onDoubleClick={handleViewerDoubleClick}>
        <VRMViewer expression={expression} audioBridge={audioBridge} vrmUrl={vrmUrl} />
        <EnvironmentWidget />
        <IconBar
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenMusic={() => setMusicOpen(true)}
          onOpenLog={() => setLogOpen(true)}
          onOpenTodo={() => setTodoOpen(true)}
          onOpenContacts={() => setContactsOpen(true)}
          onOpenDiary={() => setDiaryOpen(true)}
          onOpenNews={() => setNewsOpen(true)}
          onOpenCalendar={() => setCalendarOpen(true)}
          onOpenMail={() => setMailOpen(true)}
          onOpenSleep={() => setSleepOpen(true)}
          onOpenHealth={() => setHealthOpen(true)}
          onOpenReminders={() => setRemindersOpen(true)}
          onOpenProjects={() => setProjectsOpen(true)}
          onOpenNotes={() => setNotesOpen(true)}
        />
        <ReportPanel reports={reports} onOpenNote={handleOpenNoteFromReport} />
        {sessionId && (
          <div className="left-toast-column">
            <NotificationToast sessionId={sessionId} />
            <TimerToast sessionId={sessionId} />
          </div>
        )}
        <SecretaryCard />
        <ChatPanel
          onBotResponse={handleBotResponse}
          onReportUpdate={handleReportUpdate}
          audioBridge={audioBridge}
        />
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <MusicModal open={musicOpen} onClose={() => setMusicOpen(false)} />
      {/* ブラウザ自身を Spotify Connect デバイス化 (= Yui の play/pause がブラウザで鳴る)。
          invisible component。連携 + Premium なら自動初期化 + active transfer。 */}
      <SpotifyWebPlayer />
      {/* destructive / external_send tool 実行前の user 確認 modal。SSE 経由で発火する。
          docs/tool-architecture.md §4.5 */}
      <ToolConfirmDialog />
      <LogModal open={logOpen} onClose={() => setLogOpen(false)} />
      <TodoModal
        open={todoOpen}
        onClose={() => {
          setTodoOpen(false);
          setTodoPresetProject(null);
          setTodoIntentDraft(null);
          setTodoIntentInherits([]);
          setTodoIntentSource(null);
        }}
        initialProjectFilter={todoPresetProject}
        intentDraft={todoIntentDraft}
        intentInheritedProjects={todoIntentInherits}
        intentSource={todoIntentSource}
      />
      <ContactsModal
        open={contactsOpen}
        onClose={() => {
          setContactsOpen(false);
          setContactsIntentDraft(null);
          setContactsIntentSource(null);
        }}
        intentDraft={contactsIntentDraft}
        intentSource={contactsIntentSource}
      />
      <DiaryModal open={diaryOpen} onClose={() => setDiaryOpen(false)} />
      <NewsModal open={newsOpen} onClose={() => setNewsOpen(false)} />
      <CalendarModal
        open={calendarOpen}
        onClose={() => {
          setCalendarOpen(false);
          setCalendarIntentDraft(null);
          setCalendarIntentSource(null);
        }}
        intentDraft={calendarIntentDraft}
        intentSource={calendarIntentSource}
      />
      <MailModal open={mailOpen} onClose={() => setMailOpen(false)} />
      <SleepModal open={sleepOpen} onClose={() => setSleepOpen(false)} />
      <HealthModal open={healthOpen} onClose={() => setHealthOpen(false)} />
      {sessionId && (
        <RemindersModal
          open={remindersOpen}
          onClose={() => setRemindersOpen(false)}
          sessionId={sessionId}
        />
      )}
      <SleepOverlay />
      <ProjectHubModal open={projectsOpen} onClose={() => setProjectsOpen(false)} />
      <NotesModal
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
        focusNoteId={focusNoteId}
        onFocusConsumed={() => setFocusNoteId(null)}
      />
      <MailComposeModal
        open={externalCompose !== null}
        mode={externalCompose}
        onClose={() => setExternalCompose(null)}
      />
      <HeartBurst bursts={heartBursts} />
    </main>
  );
}
