/**
 * Periodic Module System の型定義。
 *
 * 各モジュールは独立ファイルで、自分の schedule (interval or cron) と
 * 判定 logic (run) を持つ。scheduler は registry を読んで boot 時に
 * 全モジュールを登録し、schedule に従って run を呼び出す。
 *
 * run の戻り値:
 *  - skip: 何もしない (LLM 呼ばず、ユーザーに何も伝えない)
 *  - fire: Yui ターンを起動して prompt を user role として渡す。
 *          Yui は普段通り応答 (env block 自動注入、specialist 呼び出し可能)
 *
 * 設計意図:
 *  - 判定段で LLM を使わない (ルールベース) ことで通常時の API コストをゼロに
 *  - fire 時のみ Yui (Sonnet) 1 ターンで発話 → 自律性とコストのバランス
 *  - 用途別に分離することで、頻度・条件を独立に調整可能
 */

export type PeriodicSchedule =
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expr: string }; // 将来: node-cron 等で評価。MVP は interval のみ

export type PeriodicContext = {
  /** 発火対象セッション ID (raw_messages の最新 session) */
  sessionId: string;
  /** 前回 run の結果 (差分判定用、null なら初回) */
  lastSnapshot: unknown | null;
};

export type PeriodicResult =
  | { skip: true; reason?: string; snapshot?: unknown }
  | { fire: { prompt: string }; reason?: string; snapshot?: unknown };

export type PeriodicModule = {
  /** モジュール識別子 (snapshot 保存キーにも使う) */
  id: string;
  /** 無効化フラグ。registry 編集無しで停止できる */
  enabled: boolean;
  schedule: PeriodicSchedule;
  /** 1 回の発火判定。LLM 呼んでも良いが、通常はルールで済ます */
  run: (ctx: PeriodicContext) => Promise<PeriodicResult>;
};
