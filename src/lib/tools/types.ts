/**
 * ツール基盤の共通型。
 *
 * 設計: docs/tool-architecture.md (v3 fix)
 *
 * 主な役割:
 *   - ToolDef: 1 ツールを宣言的に表す (= name / description / input_schema / handler +
 *     security metadata: callableBy / surface / domain / untrustedOutput / allowedModes /
 *     confirmationPolicy / isAvailable / availabilityKey)
 *   - ToolContext: handler / availability check に渡す per-call 情報
 *   - 列挙型 (ToolSurface / ToolMode / ToolDomain / SpecialistId / ConfirmationPolicy)
 */

export type ToolSurface =
  | "read"        // DB / 外部 API の read-only (gmail_search, list_todos)
  | "mutate"      // user データの変更 (delete_contact, gcal_delete_event)
  | "transport"   // データ無変更の制御 (music_pause, music_volume)
  | "external";   // 外部 internet への egress (web_fetch = exfil 経路)

export type ToolMode =
  | "normal"      // 通常 chat (ご主人様の元発話)
  | "timer"       // timer/alarm 発火
  | "background"; // periodic worker / cron

export type ToolDomain =
  | "mail" | "schedule" | "todo" | "contact" | "music" | "web"
  | "memory" | "vrm" | "health" | "diary" | "status" | "news" | "timer" | "reminder" | "brief" | "project"
  | "dict"; // TTS 読み方辞書 (= 結衣が読み間違いを訂正された時の自律学習)

export type SpecialistId = "mail" | "schedule" | "music" | "report";

/** どの caller から見えるかを宣言。複数指定で「main にも specialist にも露出」可。 */
export type ToolCaller =
  | { kind: "main" }                              // chat/route の main Yui
  | { kind: "specialist"; id: SpecialistId };     // 特定 specialist の内部 loop

export type ToolContext = {
  sessionId: string;
  caller: ToolCaller;
  mode: ToolMode;
  userUtterance: string | null;
  /** 同一ターン内で availability 結果を共有するキャッシュ */
  availabilityCache: Map<string, Promise<boolean>>;
};

export type ConfirmationPolicy =
  | "auto"                    // 確認不要 (read-only / transport / 軽い mutate)
  | "confirm_destructive"     // 削除 / 不可逆更新
  | "confirm_external_send";  // 外部への送信

export type ToolDef = {
  /** Anthropic Tool 名 (snake_case 推奨) */
  name: string;
  description: string;
  input_schema: object;
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;

  // ── caller boundary ──
  callableBy: ToolCaller[];

  // ── security metadata ──
  surface: ToolSurface;
  domain: ToolDomain;
  untrustedOutput?: boolean;
  allowedModes: ToolMode[];
  confirmationPolicy?: ConfirmationPolicy;
  isAvailable?: (ctx: Pick<ToolContext, "sessionId" | "availabilityCache">) => Promise<boolean>;
  availabilityKey?: string;
};

/** runTool が ToolResult を作るために使う */
export type ToolUseLike = {
  id: string;
  name: string;
  input: unknown;
};
