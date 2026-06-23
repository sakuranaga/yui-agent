import type Anthropic from "@anthropic-ai/sdk";
import { buildYuiSystemPrompt } from "@/app/api/chat/yui-prompt";
import { loadPersona } from "@/lib/persona";
import { callLlm } from "@/lib/llm";
import { sanitizeAssistantText } from "@/lib/response-sanitizer";
import { classifyEmotion } from "@/lib/emotion";
import { pushToSession } from "@/lib/jobs/events";
import { getEffectiveState } from "@/lib/activity";
import { appendOverlay } from "@/lib/conversation-overlay";
import { writeAssistantMessage } from "@/lib/memory";
import { cacheSetIfAbsent } from "@/lib/cache";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { sql } from "drizzle-orm";

const FINAL_VOICE_TTL_SEC = 24 * 60 * 60;

export type ConfirmResultControllerInput = {
  sessionId: string;
  token: string;
  toolName: string;
  summary: string;
  success: boolean;
  result?: unknown;
  reason?: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

async function updateTaskFinalReply(args: {
  token: string;
  reply: string;
  emotion: string;
}): Promise<void> {
  try {
    const updated = await db.execute(sql`
      UPDATE ${tasks}
      SET output = jsonb_set(
        jsonb_set(
          jsonb_set(
            COALESCE(output, '{}'::jsonb),
            '{yuiText}',
            to_jsonb(${args.reply}::text),
            true
          ),
          '{emotion}',
          to_jsonb(${args.emotion}::text),
          true
        ),
        '{confirmFinal}',
        COALESCE(output->'confirmFinal', '{}'::jsonb) || jsonb_build_object(
          'reply', ${args.reply}::text,
          'emotion', ${args.emotion}::text,
          'replyEmittedAt', now()
        ),
        true
      )
      WHERE output->'confirmFinal'->>'token' = ${args.token}::text
      RETURNING id
    `);
    if (updated.length === 0) {
      console.warn(`[tool-confirm/${args.token}] final reply task update matched no rows`);
    }
  } catch (e) {
    console.warn(`[tool-confirm/${args.token}] final reply task update failed:`, e);
  }
}

function formatJstDateLabel(ymd: string): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = fmt.format(now);
  const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrow = fmt.format(tomorrowDate);
  if (ymd === today) return "今日";
  if (ymd === tomorrow) return "明日";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${Number(m[2])}月${Number(m[3])}日`;
}

function formatJstClock(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return m === 0 ? `${h}時` : `${h}時${String(m).padStart(2, "0")}分`;
}

function formatConfirmEventTime(start: unknown, end: unknown): string {
  const s = asRecord(start);
  const e = asRecord(end);
  if (!s) return "";
  if (typeof s.date === "string") {
    return `${formatJstDateLabel(s.date)}、終日`;
  }
  if (typeof s.dateTime !== "string") return "";
  const sd = new Date(s.dateTime);
  if (Number.isNaN(sd.getTime())) return s.dateTime;
  const dateKey = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(sd);
  const startTime = formatJstClock(sd);
  let endTime = "";
  if (e && typeof e.dateTime === "string") {
    const ed = new Date(e.dateTime);
    if (!Number.isNaN(ed.getTime())) {
      const endDateKey = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(ed);
      if (endDateKey === dateKey) endTime = formatJstClock(ed);
    }
  }
  return `${formatJstDateLabel(dateKey)}、${startTime}${endTime ? `から${endTime}まで` : "から"}`;
}

export function buildConfirmFallbackReply(input: ConfirmResultControllerInput): string {
  if (!input.success) {
    if (input.reason === "user denied") {
      return `承知しました。${input.summary}はやめておきます。`;
    }
    return `申し訳ございません。${input.summary}を実行できませんでした。${input.reason ? `理由は ${input.reason} です。` : ""}`.trim();
  }

  const root = asRecord(input.result);
  const event = asRecord(root?.event);
  if (input.toolName === "gcal_create_event" && event) {
    const title = typeof event.summary === "string" ? event.summary : "予定";
    const location = typeof event.location === "string" && event.location ? event.location : "";
    const when = formatConfirmEventTime(event.start, event.end);
    const target = `${location ? `${location}での` : ""}${title}`;
    return `かしこまりました。${when ? `${when}、` : ""}${target}の予定を登録いたしました。`;
  }

  return `かしこまりました。${input.summary}が完了しました。`;
}

export function buildConfirmToolSummary(input: ConfirmResultControllerInput): Array<{ name: string; brief: string }> {
  const state = input.success ? "completed" : "not_completed";
  const reason = input.reason ? ` reason=${input.reason}` : "";
  const root = asRecord(input.result);
  const event = asRecord(root?.event);
  if (input.toolName === "gcal_create_event" && input.success && event) {
    const parts = [state];
    const id = typeof event.id === "string" ? event.id : "";
    const calendarId =
      typeof event.calendar_id === "string"
        ? event.calendar_id
        : typeof event.calendarId === "string"
          ? event.calendarId
          : "primary";
    const title = typeof event.summary === "string" ? event.summary : "";
    const startJst = typeof event.start_jst === "string" ? event.start_jst : "";
    const endJst = typeof event.end_jst === "string" ? event.end_jst : "";
    if (id) parts.push(`id=${id}`);
    if (calendarId) parts.push(`calendar=${calendarId}`);
    if (title) parts.push(`title="${title}"`);
    if (startJst) parts.push(`start=${startJst}`);
    if (endJst) parts.push(`end=${endJst}`);
    return [
      {
        name: input.toolName,
        brief: parts.join(" ").slice(0, 240),
      },
    ];
  }
  return [
    {
      name: input.toolName,
      brief: `${state}: ${input.summary}${reason}`.slice(0, 240),
    },
  ];
}

async function generateConfirmResultReply(
  input: ConfirmResultControllerInput
): Promise<string> {
  const fallback = buildConfirmFallbackReply(input);
  const persona = await loadPersona();
  const personaPrompt = buildYuiSystemPrompt(persona);
  const payload = {
    toolName: input.toolName,
    summary: input.summary,
    success: input.success,
    reason: input.reason ?? null,
    result: input.result ?? null,
  };
  const system = [
    personaPrompt,
    "",
    "あなたは上記ペルソナとして、確認付きツールの完了報告を1文だけ作ります。",
    "通常チャットの履歴・記憶・環境情報は一切使えません。入力 JSON だけが事実です。",
    "入力 JSON に無い予定名、日付、時刻、場所、相手、結果を絶対に補完しないでください。",
    "特に別の予定名や今日の予定を混ぜてはいけません。",
    "success=true なら完了を自然に報告します。success=false なら未実行/中止を自然に報告します。",
    "口調はペルソナに合わせてください。ただし簡潔に、1文だけ。内部情報、JSON、tool 名、token は出しません。",
  ].join("\n");
  const user = [
    "この JSON だけを材料に、ご主人様への完了報告を1文で作ってください。",
    "",
    JSON.stringify(payload, null, 2).slice(0, 5000),
  ].join("\n");
  try {
    const resp = await callLlm("voice", {
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 160,
      temperature: 0.3,
    });
    const text = sanitizeAssistantText(
      resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim()
    );
    return text || fallback;
  } catch (e) {
    console.warn("[tool-confirm] final voice generation failed:", e);
    return fallback;
  }
}

export async function emitConfirmResult(input: ConfirmResultControllerInput): Promise<void> {
  const first = await cacheSetIfAbsent(
    `tool-confirm:final-voice:${input.token}`,
    { emittedAt: Date.now() },
    FINAL_VOICE_TTL_SEC
  );
  if (!first) return;

  const reply = sanitizeAssistantText(await generateConfirmResultReply(input)) || "かしこまりました。";
  const emotion = classifyEmotion(reply);
  const toolSummary = buildConfirmToolSummary(input);
  await updateTaskFinalReply({
    token: input.token,
    reply,
    emotion,
  });

  pushToSession(input.sessionId, {
    type: "yui_message",
    jobId: -1,
    text: reply,
    emotion,
    specialistId: undefined,
  });

  if ((await getEffectiveState(input.sessionId)) === "private") {
    await appendOverlay(input.sessionId, {
      role: "assistant",
      content: reply,
      kind: "private",
      source: "tool_confirm_result",
      emotion,
      toolSummary,
      ts: Date.now(),
    });
    return;
  }

  await writeAssistantMessage({
    sessionId: input.sessionId,
    source: "tool_confirm_result",
    content: reply,
    emotion,
    toolSummary,
  });
}
