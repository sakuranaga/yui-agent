/**
 * GET /api/workouts?limit=20
 *   筋トレログを新しい順に返す (HealthModal の運動セクション用)。
 *
 * POST /api/workouts
 *   { performed_at?, body_parts: string[], exercises?: [], duration_min?, intensity?, notes? }
 *   manual 入力で workout_logs に INSERT。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { workoutLogs } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

const VALID_PARTS = new Set([
  "chest", "back", "shoulders", "legs", "arms", "core", "cardio", "full",
]);

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 100);

  const rows = await db
    .select()
    .from(workoutLogs)
    .orderBy(desc(workoutLogs.performedAt))
    .limit(limit);

  return NextResponse.json({
    workouts: rows.map((r) => ({
      id: Number(r.id),
      performedAt: r.performedAt.toISOString(),
      bodyParts: r.bodyParts,
      exercises: r.exercises,
      durationMin: r.durationMin,
      intensity: r.intensity,
      notes: r.notes,
      confidence: r.confidence,
    })),
  });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const b = body as {
    performed_at?: string;
    body_parts?: unknown;
    exercises?: unknown;
    duration_min?: number;
    intensity?: string;
    notes?: string;
  };

  const parts = Array.isArray(b.body_parts)
    ? b.body_parts.filter((p) => typeof p === "string" && VALID_PARTS.has(p))
    : [];
  if (parts.length === 0) {
    return NextResponse.json({ error: "body_parts is required" }, { status: 400 });
  }

  const performedAt = b.performed_at ? new Date(b.performed_at) : new Date();
  if (Number.isNaN(performedAt.getTime())) {
    return NextResponse.json({ error: "invalid performed_at" }, { status: 400 });
  }
  const intensity =
    b.intensity && ["light", "normal", "hard"].includes(b.intensity) ? b.intensity : null;

  const inserted = await db
    .insert(workoutLogs)
    .values({
      performedAt,
      bodyParts: parts,
      exercises: Array.isArray(b.exercises) ? b.exercises : [],
      durationMin: typeof b.duration_min === "number" ? Math.round(b.duration_min) : null,
      intensity,
      notes: b.notes ?? null,
      rawText: "manual",
      sourceMessageId: null,
      confidence: 1.0,
    })
    .returning();

  return NextResponse.json({ workout: inserted[0] }, { status: 201 });
}
