/**
 * POST /api/contacts/[identifier]/restore — 論理削除取り消し
 */
import { NextResponse, type NextRequest } from "next/server";
import { restoreContact } from "@/lib/contacts";
import { clientError } from "@/lib/api-error";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ identifier: string }> }
) {
  const { identifier } = await params;
  try {
    const c = await restoreContact(identifier);
    if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, contact: c });
  } catch (e) {
    return clientError(req, e, { context: "contacts/[identifier]/restore", message: "連絡先の復元に失敗しました" });
  }
}
