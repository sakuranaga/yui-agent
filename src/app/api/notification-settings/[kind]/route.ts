/**
 * PATCH /api/notification-settings/<event_kind>
 *   body (v2 新):
 *     toastOnline?, speakOnline?,
 *     toastAway?,   speakAway?,
 *     toastFocus?,  speakFocus?,
 *     discordPolicy?, importance?
 *   body (v1 旧、F2-F4 compat 期間):
 *     modeOnline?, modeAway?, modeFocus?  (= "speak" | "notify" | "silent")
 *     → 内部で legacyModeToFlags() を通じて toast / speak boolean に変換
 *
 * 1 行更新 (該当行が無ければデフォルトを元に作成して update)。
 *
 * 設計: docs/notification-system.md §12.3
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  updateRule,
  legacyModeToFlags,
  type EventKind,
  type DiscordPolicy,
  type Importance,
  type LegacyMode,
} from "@/lib/notification-settings";
import { clientError } from "@/lib/api-error";

const VALID_LEGACY_MODE = new Set<LegacyMode>(["speak", "notify", "silent"]);
const VALID_DISCORD = new Set<DiscordPolicy>(["always", "away_only", "never"]);
const VALID_IMPORTANCE = new Set<Importance>(["high", "normal", "low"]);
const VALID_KIND = new Set<EventKind>([
  "morning_brief",
  "diary",
  "news",
  "mail_important",
  "mail_other",
  "music",
  "schedule",
  "health",
  "reminder",
]);

type LegacyPatchBody = {
  modeOnline?: string;
  modeAway?: string;
  modeFocus?: string;
};

type V2PatchBody = {
  toastOnline?: boolean;
  speakOnline?: boolean;
  toastAway?: boolean;
  speakAway?: boolean;
  toastFocus?: boolean;
  speakFocus?: boolean;
};

type CommonPatchBody = {
  discordPolicy?: string;
  importance?: string;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ kind: string }> }
) {
  const { kind } = await params;
  if (!VALID_KIND.has(kind as EventKind)) {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  }
  try {
    const body = (await req.json()) as LegacyPatchBody & V2PatchBody & CommonPatchBody;
    const patch: Parameters<typeof updateRule>[1] = {};

    // 旧 mode_* (v1 互換): legacyModeToFlags で toast/speak に変換
    if (body.modeOnline !== undefined) {
      if (!VALID_LEGACY_MODE.has(body.modeOnline as LegacyMode)) {
        return NextResponse.json({ error: "invalid modeOnline" }, { status: 400 });
      }
      const { toast, speak } = legacyModeToFlags(body.modeOnline as LegacyMode);
      patch.toastOnline = toast;
      patch.speakOnline = speak;
    }
    if (body.modeAway !== undefined) {
      if (!VALID_LEGACY_MODE.has(body.modeAway as LegacyMode)) {
        return NextResponse.json({ error: "invalid modeAway" }, { status: 400 });
      }
      const { toast, speak } = legacyModeToFlags(body.modeAway as LegacyMode);
      patch.toastAway = toast;
      patch.speakAway = speak;
    }
    if (body.modeFocus !== undefined) {
      if (!VALID_LEGACY_MODE.has(body.modeFocus as LegacyMode)) {
        return NextResponse.json({ error: "invalid modeFocus" }, { status: 400 });
      }
      const { toast, speak } = legacyModeToFlags(body.modeFocus as LegacyMode);
      patch.toastFocus = toast;
      patch.speakFocus = speak;
    }

    // 新 toast/speak (v2): そのまま採用 (boolean validation)
    if (body.toastOnline !== undefined) {
      if (typeof body.toastOnline !== "boolean") {
        return NextResponse.json({ error: "toastOnline must be boolean" }, { status: 400 });
      }
      patch.toastOnline = body.toastOnline;
    }
    if (body.speakOnline !== undefined) {
      if (typeof body.speakOnline !== "boolean") {
        return NextResponse.json({ error: "speakOnline must be boolean" }, { status: 400 });
      }
      patch.speakOnline = body.speakOnline;
    }
    if (body.toastAway !== undefined) {
      if (typeof body.toastAway !== "boolean") {
        return NextResponse.json({ error: "toastAway must be boolean" }, { status: 400 });
      }
      patch.toastAway = body.toastAway;
    }
    if (body.speakAway !== undefined) {
      if (typeof body.speakAway !== "boolean") {
        return NextResponse.json({ error: "speakAway must be boolean" }, { status: 400 });
      }
      patch.speakAway = body.speakAway;
    }
    if (body.toastFocus !== undefined) {
      if (typeof body.toastFocus !== "boolean") {
        return NextResponse.json({ error: "toastFocus must be boolean" }, { status: 400 });
      }
      patch.toastFocus = body.toastFocus;
    }
    if (body.speakFocus !== undefined) {
      if (typeof body.speakFocus !== "boolean") {
        return NextResponse.json({ error: "speakFocus must be boolean" }, { status: 400 });
      }
      patch.speakFocus = body.speakFocus;
    }

    if (body.discordPolicy !== undefined) {
      if (!VALID_DISCORD.has(body.discordPolicy as DiscordPolicy)) {
        return NextResponse.json({ error: "invalid discordPolicy" }, { status: 400 });
      }
      patch.discordPolicy = body.discordPolicy as DiscordPolicy;
    }
    if (body.importance !== undefined) {
      if (!VALID_IMPORTANCE.has(body.importance as Importance)) {
        return NextResponse.json({ error: "invalid importance" }, { status: 400 });
      }
      patch.importance = body.importance as Importance;
    }
    await updateRule(kind as EventKind, patch);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "notification-settings/[kind]", message: "通知設定の更新に失敗しました" });
  }
}
