/**
 * Session-scoped server-sent events registry.
 *
 * バックグラウンドジョブが完了したら `pushToSession(sessionId, event)` で
 * 通知 → 該当 session に subscribe してる全 SSE 接続にイベントが流れる。
 *
 * Next.js の Route Handler は別 lambda になりやすいが、ここは Node.js
 * モノリス前提なので in-memory Map で十分。
 * 複数プロセス対応が必要になったら Redis pub/sub に差し替え。
 */

export type YuiMessageEvent = {
  type: "yui_message";
  jobId: number;
  /** Yui のセリフ (TTS 再生される) */
  text: string;
  /** 感情ラベル (VRM 表情用) */
  emotion: string;
  /** どの specialist が起因か (デバッグ用) */
  specialistId?: string;
};

export type JobStatusEvent = {
  type: "job_status";
  jobId: number;
  status: "running" | "succeeded" | "failed";
  specialistId?: string;
  error?: string;
};

/** Report panel に表示するノート用イベント */
export type ReportUpdateEvent = {
  type: "report_update";
  jobId: number;
  /** ノートのタイトルタグ (例: "本日の予定", "GoENタスク一覧") */
  title: string;
  /** 本文 markdown */
  markdown: string;
  specialistId?: string;
  /**
   * 紐づくノート id (= save_note で保存したノート)。
   * 付いている時だけ ReportPanel のタイトルタブをクリック可能にし、NotesModal を該当ノートで開く。
   * 既存 producer (morning brief / list_todos 等) は付けない (= optional)。
   */
  noteId?: number;
};

/** Timer/Alarm lifecycle イベント */
export type TimerEvent =
  | {
      type: "timer_created";
      id: number;
      kind: "timer" | "alarm";
      label: string | null;
      targetAt: string; // ISO
    }
  | {
      type: "timer_fired";
      id: number;
      kind: "timer" | "alarm";
      label: string | null;
      targetAt: string;
      /** true = on_fire_prompt 経由で Yui がアクション実行する。frontend は voice 通知を suppress */
      hasAction?: boolean;
    }
  | {
      type: "timer_cancelled";
      id: number;
    };

/**
 * 秘書カード (SecretaryCard) の Lv / お給料 / ハート数の即時反映用。
 * stats 変化が起きた callsite (XP 加算、いいね追加、LLM 呼び出し記録) が
 * push してリロードなしで UI が動くようにする。
 *
 * シンプルさのため stats そのものは送らない (どの session でも全体集計を読み直す
 * ので broadcast でいい)。client は受信したら GET /api/secretary/stats を再 fetch。
 * levelUp は server 側で前後 Lv を比較して検知し、桁が変わった時のみ含める。
 */
export type StatsUpdateEvent = {
  type: "stats_update";
  /** 直前から今で Lv が上がっていれば付与。SecretaryCard が演出を発火する。 */
  levelUp?: { from: number; to: number };
};

/**
 * 通知 (お便り) の新着 push。クライアントは NotificationToast スタックに 1 件追加する。
 * Discord bot は forwardToDiscord=true のときだけ DM に転送する。
 * 設計: docs/notification-system.md §8
 */
export type NotificationEvent = {
  type: "notification";
  id: number;
  kind: string;
  importance: "high" | "normal" | "low" | "silent";
  title: string;
  preview: string;
  /**
   * mode=speak で Yui が読み上げる本文。Web では TTS、Discord ではこのまま転送する
   * (Web チャットと Discord で同じ内容を出すため)。
   * 未指定なら title + preview をフォールバックに使う。
   */
  speakText?: string;
  /** Discord bot がこのフラグを読んで転送判定。離席時 or 朝のブリーフィングのとき true。 */
  forwardToDiscord: boolean;
};

/**
 * メール新着 push (periodic mail-poll / 手動 POST /api/mail/poll が INSERT 後に発火)。
 * MailModal が開いていれば自動で list を refresh する。
 */
export type MailInsertedEvent = {
  type: "mail_inserted";
  /** 今回 INSERT された件数 (chunk 単位で複数回飛びうる) */
  count: number;
};

/**
 * destructive / external_send tool が user confirm を要求した時の SSE event。
 * frontend は ToolConfirmDialog で受けて modal 表示 → POST /api/tool-confirm/{token}。
 * 設計: docs/tool-architecture.md §4.5
 */
export type ToolConfirmRequestEvent = {
  type: "tool_confirm_request";
  token: string;
  toolName: string;
  summary: string;
  inputSnapshot: unknown;
};

/** user の click + Phase B 実行結果 (= 成功 or 失敗 + 理由) を frontend に伝える */
export type ToolConfirmResultEvent = {
  type: "tool_confirm_result";
  token: string;
  toolName?: string;
  success: boolean;
  result?: unknown;
  reason?: string;
};

export type ServerEvent =
  | YuiMessageEvent
  | JobStatusEvent
  | ReportUpdateEvent
  | TimerEvent
  | StatsUpdateEvent
  | NotificationEvent
  | MailInsertedEvent
  | ToolConfirmRequestEvent
  | ToolConfirmResultEvent;

type Subscriber = (event: ServerEvent) => void;

declare global {
  var __vroidEventSubs: Map<string, Set<Subscriber>> | undefined;
}

// dev hot reload で再生成されないよう globalThis に持つ
const subs: Map<string, Set<Subscriber>> =
  globalThis.__vroidEventSubs ?? new Map();
if (process.env.NODE_ENV !== "production") {
  globalThis.__vroidEventSubs = subs;
}

export function subscribeSession(
  sessionId: string,
  subscriber: Subscriber
): () => void {
  let set = subs.get(sessionId);
  if (!set) {
    set = new Set();
    subs.set(sessionId, set);
  }
  set.add(subscriber);

  // 返り値: unsubscribe
  return () => {
    const s = subs.get(sessionId);
    if (!s) return;
    s.delete(subscriber);
    if (s.size === 0) subs.delete(sessionId);
  };
}

export function pushToSession(sessionId: string, event: ServerEvent): number {
  const set = subs.get(sessionId);
  if (!set) return 0;
  let delivered = 0;
  for (const fn of set) {
    try {
      fn(event);
      delivered++;
    } catch (e) {
      console.warn("[events] subscriber threw:", e);
    }
  }
  return delivered;
}

/** デバッグ用: 現在の購読状況 */
export function sessionSubscriberCount(sessionId: string): number {
  return subs.get(sessionId)?.size ?? 0;
}

/** env DEBUG_REPORTS=1 かつ **非 production** の時だけ有効。
 *  debug report は内部 raw error を ReportPanel (SSE で client 配信) に載せるため、
 *  CLAUDE.md「client に生エラーを返さない」に配慮し production build では無効化する
 *  (owner 自己デバッグ = dev 運用前提)。 */
export function debugReportsEnabled(): boolean {
  return process.env.DEBUG_REPORTS === "1" && process.env.NODE_ENV !== "production";
}

/**
 * デバッグレポートを ReportPanel (report_update SSE) に流す。env DEBUG_REPORTS=1 の時のみ。
 * 内部の pick / executor 結果 / L2 発火 / LLM エラー等を、ログを掘らず UI でその場確認するため。
 */
export function pushDebugReport(sessionId: string, lines: string[]): void {
  if (!debugReportsEnabled() || lines.length === 0) return;
  pushToSession(sessionId, {
    type: "report_update",
    jobId: 0,
    title: "🔧 Debug",
    markdown: lines.join("\n"),
  });
}

/** 現在 SSE 購読中の (= active) session id 一覧。MCP notify の broadcast 等で使う。 */
export function activeSessionIds(): string[] {
  return [...subs.keys()];
}

export function allSubscribersCount(): { sessions: number; total: number } {
  let total = 0;
  for (const s of subs.values()) total += s.size;
  return { sessions: subs.size, total };
}

/**
 * stats_update を全 active session に broadcast。SecretaryCard が
 * 受信したら GET /api/secretary/stats を再 fetch する想定。
 * 給料 / XP / ハート数いずれかが変化した callsite から呼ばれる。
 */
export function broadcastStatsUpdate(levelUp?: { from: number; to: number }): void {
  const event: StatsUpdateEvent = { type: "stats_update", ...(levelUp ? { levelUp } : {}) };
  for (const set of subs.values()) {
    for (const fn of set) {
      try {
        fn(event);
      } catch (e) {
        console.warn("[events] broadcast subscriber threw:", e);
      }
    }
  }
}

/** メール INSERT 完了を全 web session に broadcast。MailModal が listen して reload する。 */
export function broadcastMailInserted(count: number): void {
  if (count <= 0) return;
  const event: MailInsertedEvent = { type: "mail_inserted", count };
  for (const set of subs.values()) {
    for (const fn of set) {
      try {
        fn(event);
      } catch (e) {
        console.warn("[events] broadcast mail subscriber threw:", e);
      }
    }
  }
}
