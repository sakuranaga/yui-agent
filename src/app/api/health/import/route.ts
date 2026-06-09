/**
 * POST /api/health/import
 *
 * 外部ヘルスデータ (iOS HealthKit / Garmin / Fitbit 等) の取り込み口。
 * iOS Shortcut が定期的に POST する想定。
 *
 * 認証: env HEALTH_INGEST_KEY を Header X-Health-Key で送る。未設定なら 503。
 *
 * Request body:
 *   {
 *     "source"?: "apple_health" | "garmin" | ...,   // 全 metrics に共通して付く出典
 *     "metrics": [
 *       { "type": "steps_daily", "value": 12345, "date": "2026-06-02" },
 *       { "type": "active_kcal_daily", "value": 423, "date": "2026-06-02" },
 *       { "type": "resting_hr", "value": 62, "recorded_at": "2026-06-02T08:00:00+09:00" }
 *     ]
 *   }
 *
 * 設計: docs/health-tracking.md §11 Phase 5
 */
import { NextResponse, type NextRequest } from "next/server";
import { importHealthMetrics, type ImportMetric } from "@/lib/health-import";

export const dynamic = "force-dynamic";

/** 定数時間比較 (= タイミング攻撃対策、middleware と同設計) */
function timingSafeEq(a: string, b: string): boolean {
  const la = a.length;
  const lb = b.length;
  const len = Math.max(la, lb);
  let diff = la ^ lb;
  for (let i = 0; i < len; i++) {
    const ca = i < la ? a.charCodeAt(i) : 0;
    const cb = i < lb ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export async function POST(req: NextRequest) {
  const expectedKey = process.env.HEALTH_INGEST_KEY;
  if (!expectedKey) {
    return NextResponse.json(
      { error: "HEALTH_INGEST_KEY env not set on server" },
      { status: 503 }
    );
  }
  const provided = req.headers.get("x-health-key") ?? "";
  if (!timingSafeEq(provided, expectedKey)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const b = body as { source?: string; metrics?: unknown };
  if (!Array.isArray(b.metrics)) {
    return NextResponse.json({ error: "metrics: array required" }, { status: 400 });
  }
  // 上限 (一度に大量送信されないように)
  if (b.metrics.length > 500) {
    return NextResponse.json({ error: "too many metrics (max 500)" }, { status: 400 });
  }

  const result = await importHealthMetrics(
    b.metrics as ImportMetric[],
    typeof b.source === "string" ? b.source : "apple_health"
  );
  return NextResponse.json(result);
}
