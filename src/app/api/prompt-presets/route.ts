/**
 * GET  /api/prompt-presets
 *   全 preset を sort_order, created_at で返す。
 *
 * POST /api/prompt-presets
 *   body: { label, body, sort_order? }
 *   新規 preset 作成。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { promptPresets } from "@/db/schema";
import { asc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db
    .select()
    .from(promptPresets)
    .orderBy(asc(promptPresets.sortOrder), asc(promptPresets.id));
  return NextResponse.json({
    presets: rows.map((r) => ({
      id: Number(r.id),
      label: r.label,
      body: r.body,
      sortOrder: r.sortOrder,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
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
  const b = body as { label?: string; body?: string; sort_order?: number };
  if (typeof b.label !== "string" || b.label.trim() === "") {
    return NextResponse.json({ error: "label required" }, { status: 400 });
  }
  if (typeof b.body !== "string" || b.body.trim() === "") {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }
  const inserted = await db
    .insert(promptPresets)
    .values({
      label: b.label.trim(),
      body: b.body.trim(),
      sortOrder: typeof b.sort_order === "number" ? b.sort_order : 0,
    })
    .returning();
  const r = inserted[0];
  return NextResponse.json(
    {
      preset: {
        id: Number(r.id),
        label: r.label,
        body: r.body,
        sortOrder: r.sortOrder,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      },
    },
    { status: 201 }
  );
}
