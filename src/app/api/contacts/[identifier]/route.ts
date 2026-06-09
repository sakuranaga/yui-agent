/**
 * PATCH  /api/contacts/[identifier]  — フィールド部分更新
 * DELETE /api/contacts/[identifier]  — 論理削除
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  updateContact,
  deleteContact,
  type ContactValue,
} from "@/lib/contacts";
import { clientError } from "@/lib/api-error";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ identifier: string }> }
) {
  const { identifier } = await params;
  try {
    const body = (await req.json()) as {
      name?: string;
      kana?: string;
      nickname?: string;
      company?: string;
      department?: string;
      role?: string;
      emails?: ContactValue[];
      phones?: ContactValue[];
      addresses?: ContactValue[];
      urls?: string[];
      birthday?: string | null;
      tags?: string[];
      notes?: string;
    };
    const c = await updateContact({
      identifier,
      name: body.name,
      kana: body.kana,
      nickname: body.nickname,
      company: body.company,
      department: body.department,
      role: body.role,
      emails: body.emails,
      phones: body.phones,
      addresses: body.addresses,
      urls: body.urls,
      birthday:
        body.birthday === null
          ? null
          : body.birthday
            ? new Date(body.birthday)
            : undefined,
      tags: body.tags,
      notes: body.notes,
    });
    if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, contact: c });
  } catch (e) {
    return clientError(req, e, { context: "contacts/[identifier]", message: "連絡先の更新に失敗しました" });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ identifier: string }> }
) {
  const { identifier } = await params;
  try {
    const c = await deleteContact(identifier);
    if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, contact: c });
  } catch (e) {
    return clientError(req, e, { context: "contacts/[identifier]", message: "連絡先の削除に失敗しました" });
  }
}
