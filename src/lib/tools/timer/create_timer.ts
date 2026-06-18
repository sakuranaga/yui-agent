import { createTimer } from "@/lib/timers";
import { normalizeAnchorDateTime } from "../dedup-guard";
import type { ToolDef } from "../types";

const UNIT_FACTOR: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600 };

/** dedup anchor / handler 共通の秒換算 */
function durationSecondsOf(i: Record<string, unknown>): number | undefined {
  return typeof i.duration_seconds === "number"
    ? i.duration_seconds
    : typeof i.duration === "number"
      ? i.duration *
        (UNIT_FACTOR[typeof i.duration_unit === "string" ? i.duration_unit : "minutes"] ?? 60)
      : undefined;
}

export const createTimerTool: ToolDef = {
  name: "create_timer",
  description:
    "タイマー (相対秒数カウントダウン) または アラーム (絶対時刻起動) を作成。" +
    "**長さ (duration) / 起動時刻 (target_at) がユーザー発話・履歴から読み取れない場合は呼ばない** " +
    "(既定値で埋めず、何分/何時か聞き返してから作る)。" +
    "kind='timer' は duration (数) + duration_unit ('seconds'|'minutes'|'hours') で長さを渡す。kind='alarm' は target_at (ISO8601)。" +
    "「5分」→ duration=5, duration_unit='minutes'。「30秒」→ duration=30, duration_unit='seconds'。「1時間」→ duration=1, duration_unit='hours'。秒換算は app がやるので**自分で掛け算しない**。" +
    "label は任意 (例: 'ラーメン', '会議', 'メール返信')。" +
    "時刻解釈は time context (JST) を基準に。「6時」が過去なら翌日扱い。" +
    "on_fire_prompt は**ユーザーが発火時の行動を明示した時だけ** (「○分後に〜して」の〜) 入れる。" +
    "単純な時間通知 (「5分タイマー」「40分タイマーかけて」等) は**必ず省略**する (勝手に行動を足さない)。",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["timer", "alarm"] },
      label: { type: "string", description: "(任意) 表示用ラベル" },
      duration: {
        type: "integer",
        description: "kind=timer 用。長さの**数字だけ** (例: 「5分」→5、「40分」→40、「30秒」→30、「1時間」→1)。掛け算しない。",
      },
      duration_unit: {
        type: "string",
        enum: ["seconds", "minutes", "hours"],
        description: "duration の単位。「分」=minutes、「秒」=seconds、「時間」=hours。",
      },
      target_at: {
        type: "string",
        description:
          "kind=alarm 用。RFC3339/ISO8601 (例: '2026-05-25T06:00:00+09:00')",
      },
      on_fire_prompt: {
        type: "string",
        description:
          "(任意) ユーザーが**発火時の行動を明示した時だけ**その行動。単純な時間通知は省略 (勝手に足さない)。",
      },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "timer",
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  // 重複ガード: 同 session・同タイミング (timer=長さ / alarm=絶対時刻) で label が類似なら再作成しない。
  dedup: {
    scope: (_input, ctx) => `session:${ctx.sessionId}`,
    anchor: (input) => {
      const i = (input ?? {}) as Record<string, unknown>;
      if (i.kind === "alarm") {
        const at = normalizeAnchorDateTime(
          typeof i.target_at === "string" ? i.target_at : null,
        );
        return at ? `alarm:${at}` : null;
      }
      const secs = durationSecondsOf(i);
      return secs != null ? `timer:${secs}` : null;
    },
    title: (input) => {
      const i = (input ?? {}) as Record<string, unknown>;
      if (typeof i.label === "string" && i.label.trim()) return i.label;
      return typeof i.on_fire_prompt === "string" ? i.on_fire_prompt : "";
    },
  },
  handler: async (input, ctx) => {
    const i = (input ?? {}) as {
      kind?: "timer" | "alarm";
      label?: unknown;
      duration?: unknown;
      duration_unit?: unknown;
      duration_seconds?: unknown;
      target_at?: unknown;
      on_fire_prompt?: unknown;
    };
    // 単位換算は app 側で。tool モデル (xLAM 等) には「数 (duration) + 単位 (duration_unit enum)」
    // で受けさせ ×60/×3600 を app がやる (xLAM は「40分」→ 秒換算を誤りやすいが enum 充填は得意)。
    // 後方互換で duration_seconds 直指定も受ける (優先)。dedup anchor と同じ換算を共有。
    const durationSeconds = durationSecondsOf(i);
    const row = await createTimer({
      sessionId: ctx.sessionId,
      kind: i.kind ?? "timer",
      label: typeof i.label === "string" ? i.label : undefined,
      durationSeconds,
      targetAt: typeof i.target_at === "string" ? i.target_at : undefined,
      onFirePrompt:
        typeof i.on_fire_prompt === "string" ? i.on_fire_prompt : undefined,
    });
    return {
      created: true,
      id: row.id,
      kind: row.kind,
      label: row.label,
      target_at: row.targetAt.toISOString(),
    };
  },
};
