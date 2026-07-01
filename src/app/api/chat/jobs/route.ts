import { NextResponse, type NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { clientError } from "@/lib/api-error";
import { sanitizeAssistantText } from "@/lib/response-sanitizer";

export const runtime = "nodejs";

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  const ids = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, 50);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session");
  const ids = parseIds(req.nextUrl.searchParams.get("ids"));
  if (!session) {
    return NextResponse.json({ error: "session param required" }, { status: 400 });
  }
  if (ids.length === 0) {
    return NextResponse.json({ jobs: [] });
  }

  try {
    const rows = await db
      .select({
        id: tasks.id,
        status: tasks.status,
        agentName: tasks.agentName,
        output: tasks.output,
        error: tasks.error,
        completedAt: tasks.completedAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.sessionId, session),
          eq(tasks.taskType, "specialist_query"),
          inArray(tasks.id, ids),
        ),
      );

    return NextResponse.json({
      jobs: rows.map((row) => {
        const output = asRecord(row.output);
        const report = asRecord(output?.report);
        const yuiText =
          typeof output?.yuiText === "string"
            ? sanitizeAssistantText(output.yuiText)
            : null;
        return {
          id: row.id,
          status: row.status,
          specialist: row.agentName,
          completedAt: row.completedAt?.toISOString() ?? null,
          yuiText,
          emotion: typeof output?.emotion === "string" ? output.emotion : null,
          report: report
            ? {
                title: typeof report.title === "string" ? report.title : null,
                markdown: typeof report.markdown === "string" ? report.markdown : null,
                noteId: typeof report.noteId === "number" ? report.noteId : null,
              }
            : null,
          error: row.error,
        };
      }),
    });
  } catch (e) {
    return clientError(req, e, {
      context: "chat/jobs GET",
      message: "ジョブ状態の取得に失敗しました",
    });
  }
}
