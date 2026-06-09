/**
 * GET /api/notification-settings
 *   現在のマトリックス設定 (全 event_kind) を返す。
 *
 * v2: 新 toast_* / speak_* boolean に加えて、旧 mode_* (v1) 形式も併記する
 * (= F2-F4 compat 期間、旧 UI が引き続き mode_* を読むため)。F5 で削除。
 */
import { NextResponse, type NextRequest } from "next/server";
import { loadAllRules, type Rule, type LegacyMode } from "@/lib/notification-settings";
import { clientError } from "@/lib/api-error";

function toLegacyMode(toast: boolean, speak: boolean): LegacyMode {
  if (speak) return "speak";
  if (toast) return "notify";
  return "silent";
}

function augmentLegacy(r: Rule) {
  return {
    ...r,
    modeOnline: toLegacyMode(r.toastOnline, r.speakOnline),
    modeAway:   toLegacyMode(r.toastAway,   r.speakAway),
    modeFocus:  toLegacyMode(r.toastFocus,  r.speakFocus),
  };
}

export async function GET(req: NextRequest) {
  try {
    const rules = await loadAllRules();
    return NextResponse.json({ rules: rules.map(augmentLegacy) });
  } catch (e) {
    return clientError(req, e, { context: "notification-settings", message: "通知設定の取得に失敗しました" });
  }
}
