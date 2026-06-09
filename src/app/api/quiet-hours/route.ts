/**
 * GET /api/quiet-hours
 *   { enabled, startHour, endHour }
 *
 * PATCH /api/quiet-hours
 *   body: { enabled?, startHour?, endHour? } (= 部分更新可)
 *   - enabled: boolean
 *   - startHour / endHour: 0-23 整数 (= 範囲外は 400)
 *
 * 設計: docs/notification-system.md §12.2
 */
import { NextResponse, type NextRequest } from "next/server";
import { getQuietHours, setQuietHours } from "@/lib/quiet-hours";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const value = await getQuietHours();
    return NextResponse.json(value);
  } catch (e) {
    return clientError(req, e, {
      context: "quiet-hours",
      message: "サイレント時間帯の取得に失敗しました",
    });
  }
}

type PatchBody = {
  enabled?: unknown;
  startHour?: unknown;
  endHour?: unknown;
};

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as PatchBody;
    const patch: { enabled?: boolean; startHour?: number; endHour?: number } = {};

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "enabled must be boolean" }, { status: 400 });
      }
      patch.enabled = body.enabled;
    }
    if (body.startHour !== undefined) {
      if (
        typeof body.startHour !== "number" ||
        !Number.isInteger(body.startHour) ||
        body.startHour < 0 ||
        body.startHour > 23
      ) {
        return NextResponse.json(
          { error: "startHour must be integer 0-23" },
          { status: 400 }
        );
      }
      patch.startHour = body.startHour;
    }
    if (body.endHour !== undefined) {
      if (
        typeof body.endHour !== "number" ||
        !Number.isInteger(body.endHour) ||
        body.endHour < 0 ||
        body.endHour > 23
      ) {
        return NextResponse.json(
          { error: "endHour must be integer 0-23" },
          { status: 400 }
        );
      }
      patch.endHour = body.endHour;
    }

    const updated = await setQuietHours(patch);
    return NextResponse.json(updated);
  } catch (e) {
    return clientError(req, e, {
      context: "quiet-hours",
      message: "サイレント時間帯の更新に失敗しました",
    });
  }
}
