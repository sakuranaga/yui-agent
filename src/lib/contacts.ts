/**
 * Contacts (人物録) CRUD.
 *
 * AI 最適化:
 *   - identifier "C-1" ベース、Yui からは name 部分一致でも引ける
 *   - notes は markdown 自由テキスト。会った日 / 内容を Yui が append していく想定
 *   - append_note は last_contact_at も自動更新 → sort で「最近やりとりした人」上位に
 */
import { db } from "@/db/client";
import { contacts, type Contact } from "@/db/schema";
import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";

/** 論理削除済を除外する共通条件 */
const notDeleted = isNull(contacts.deletedAt);

async function nextIdentifier(): Promise<string> {
  const result = await db.execute<{ n: number }>(
    sql`SELECT nextval('contacts_identifier_seq') AS n`
  );
  const n = (result as unknown as Array<{ n: number }>)[0]?.n;
  return `C-${n}`;
}

export type ContactValue = { type?: string; value: string };

export type AddContactInput = {
  sessionId: string;
  name: string;
  kana?: string;
  nickname?: string;
  company?: string;
  department?: string;
  role?: string;
  emails?: ContactValue[];
  phones?: ContactValue[];
  addresses?: ContactValue[];
  urls?: string[];
  birthday?: Date;
  tags?: string[];
  notes?: string;
};

export async function addContact(input: AddContactInput): Promise<Contact> {
  const identifier = await nextIdentifier();
  const [row] = await db
    .insert(contacts)
    .values({
      identifier,
      sessionId: input.sessionId,
      name: input.name,
      kana: input.kana ?? null,
      nickname: input.nickname ?? null,
      company: input.company ?? null,
      department: input.department ?? null,
      role: input.role ?? null,
      emails: input.emails ?? [],
      phones: input.phones ?? [],
      addresses: input.addresses ?? [],
      urls: input.urls ?? [],
      birthday: input.birthday ?? null,
      tags: input.tags ?? [],
      notes: input.notes ?? null,
      lastContactAt: input.notes ? new Date() : null,
    })
    .returning();
  return row;
}

export type UpdateContactInput = {
  identifier: string;
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
  birthday?: Date | null;
  tags?: string[];
  notes?: string;
};

export async function updateContact(input: UpdateContactInput): Promise<Contact | null> {
  const found = await getContactByIdentifier(input.identifier);
  if (!found) return null;
  const patch: Partial<Contact> & { updatedAt: Date } = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.kana !== undefined) patch.kana = input.kana;
  if (input.nickname !== undefined) patch.nickname = input.nickname;
  if (input.company !== undefined) patch.company = input.company;
  if (input.department !== undefined) patch.department = input.department;
  if (input.role !== undefined) patch.role = input.role;
  if (input.emails !== undefined) patch.emails = input.emails;
  if (input.phones !== undefined) patch.phones = input.phones;
  if (input.addresses !== undefined) patch.addresses = input.addresses;
  if (input.urls !== undefined) patch.urls = input.urls;
  if (input.birthday !== undefined) patch.birthday = input.birthday;
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.notes !== undefined) patch.notes = input.notes;

  const [row] = await db
    .update(contacts)
    .set(patch)
    .where(eq(contacts.id, found.id))
    .returning();
  return row ?? null;
}

/** 配列に 1 件追加 (重複は省く) */
export async function appendContactValue(
  identifier: string,
  field: "emails" | "phones" | "addresses",
  v: ContactValue
): Promise<Contact | null> {
  const found = await getContactByIdentifier(identifier);
  if (!found) return null;
  const cur = (found[field] ?? []) as ContactValue[];
  if (cur.some((x) => x.value === v.value)) return found;
  const next = [...cur, v];
  const patch: Partial<Contact> & { updatedAt: Date } = { updatedAt: new Date() };
  if (field === "emails") patch.emails = next;
  if (field === "phones") patch.phones = next;
  if (field === "addresses") patch.addresses = next;
  const [row] = await db
    .update(contacts)
    .set(patch)
    .where(eq(contacts.id, found.id))
    .returning();
  return row ?? null;
}

/**
 * notes 末尾に "## YYYY-MM-DD\n<entry>" を append。last_contact_at 自動更新。
 * Yui がやりとりを記録する主要経路。
 */
export async function appendContactNote(opts: {
  identifier: string;
  entry: string;
  /** 日付 (省略時は今日) */
  at?: Date;
}): Promise<Contact | null> {
  const found = await getContactByIdentifier(opts.identifier);
  if (!found) return null;
  const date = opts.at ?? new Date();
  // YYYY-MM-DD HH:MM (JST)。時刻まで含めると同日複数エントリも区別可能。
  const fmtJst = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmtJst.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const stamp = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  const header = `## ${stamp}`;
  const block = `${header}\n${opts.entry.trim()}`;
  const newNotes = found.notes ? `${found.notes.trim()}\n\n${block}` : block;
  const [row] = await db
    .update(contacts)
    .set({ notes: newNotes, lastContactAt: date, updatedAt: new Date() })
    .where(eq(contacts.id, found.id))
    .returning();
  return row ?? null;
}

/** 論理削除 (deleted_at をセットするのみ、行は残る)。誤削除からの復旧用に物理削除しない。 */
export async function deleteContact(identifier: string): Promise<Contact | null> {
  const found = await getContactByIdentifier(identifier);
  if (!found) return null;
  const [row] = await db
    .update(contacts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(contacts.id, found.id))
    .returning();
  return row ?? null;
}

/** 論理削除を取り消す (誤削除復旧) */
export async function restoreContact(identifier: string): Promise<Contact | null> {
  // 削除済も含めて検索
  const [found] = await db
    .select()
    .from(contacts)
    .where(or(eq(contacts.identifier, identifier), eq(contacts.name, identifier))!)
    .limit(1);
  if (!found) return null;
  const [row] = await db
    .update(contacts)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(eq(contacts.id, found.id))
    .returning();
  return row ?? null;
}

/** "C-42" or 名前完全一致 で取得 (削除済は除外) */
export async function getContactByIdentifier(identifier: string): Promise<Contact | null> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(
      and(
        notDeleted,
        or(eq(contacts.identifier, identifier), eq(contacts.name, identifier))!
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * 名前 / フリガナ / 会社 / メール を ILIKE 検索。
 * 日本名対策: 「杉谷奈々」「奈々 杉谷」「杉谷 奈々」の名前順序とスペース有無の揺れに
 * 対応するため、名前と query の両方の空白を除いた形でも比較する。
 * さらに、長さ偶数のクエリは中央で分けた逆順バリアントも生成 (姓名スワップ対応)。
 */
export async function searchContacts(query: string, limit = 10): Promise<Contact[]> {
  const q = `%${query}%`;
  const variants = generateJaNameVariants(query);
  const stripExpr = sql`REPLACE(REPLACE(${contacts.name}, ' ', ''), '　', '')`;

  const variantClauses = variants.map(
    (v) => sql`${stripExpr} ILIKE ${`%${v}%`}`
  );

  return db
    .select()
    .from(contacts)
    .where(
      and(
        notDeleted,
        or(
          ilike(contacts.name, q),
          ilike(contacts.kana, q),
          ilike(contacts.nickname, q),
          ilike(contacts.company, q),
          eq(contacts.identifier, query),
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${contacts.emails}) e WHERE e->>'value' ILIKE ${q})`,
          ...variantClauses
        )!
      )
    )
    .orderBy(desc(contacts.lastContactAt), asc(contacts.name))
    .limit(limit);
}

/**
 * 日本名のクエリ揺れに対応するバリアント生成。
 * "杉谷奈々" → ["杉谷奈々", "奈々杉谷"]  (中央で分けて逆順も追加)
 * "杉谷 奈々" → ["杉谷奈々", "奈々杉谷"]
 */
function generateJaNameVariants(q: string): string[] {
  const noSpace = q.replace(/[\s　]+/g, "");
  const set = new Set<string>([noSpace]);
  // 偶数長 (≥2) なら姓名スワップ
  if (noSpace.length >= 2 && noSpace.length % 2 === 0) {
    const mid = noSpace.length / 2;
    set.add(noSpace.slice(mid) + noSpace.slice(0, mid));
  }
  // 元クエリにスペース or 全角スペースがあったら、その位置で切って逆順
  const spaceMatch = q.match(/^(.+?)[\s　]+(.+)$/);
  if (spaceMatch) {
    set.add(spaceMatch[2] + spaceMatch[1]);
    set.add(spaceMatch[1] + spaceMatch[2]);
  }
  return [...set].filter((s) => s.length >= 2);
}

export type ListContactsOpts = {
  tag?: string;
  company?: string;
  limit?: number;
};
export async function listContacts(opts: ListContactsOpts = {}): Promise<Contact[]> {
  const conds: SQL[] = [notDeleted];
  if (opts.tag) conds.push(sql`${contacts.tags} @> ARRAY[${opts.tag}]::text[]`);
  if (opts.company) conds.push(ilike(contacts.company, `%${opts.company}%`));
  return db
    .select()
    .from(contacts)
    .where(and(...conds))
    .orderBy(desc(contacts.lastContactAt), asc(contacts.name))
    .limit(opts.limit ?? 50);
}

/** Yui に渡す compact 1 行表記。token 節約。
 * 電話は配列の先頭 1 件だけプレビュー、メール件数は数字のみ。 */
export function formatContactCompact(c: Contact): string {
  const phonePreview = c.phones && c.phones.length > 0 ? c.phones[0].value : "-";
  const phoneCount = c.phones?.length ?? 0;
  const phoneCell = phoneCount > 1 ? `${phonePreview}+${phoneCount - 1}` : phonePreview;
  const emailCount = c.emails?.length ?? 0;
  const parts = [
    c.identifier,
    c.name,
    c.company ?? "-",
    c.role ?? "-",
    phoneCell,
    emailCount > 0 ? `mail:${emailCount}` : "mail:-",
    c.lastContactAt ? `last:${c.lastContactAt.toISOString().slice(0, 10)}` : "last:-",
  ];
  return parts.join("|");
}

/** ノートパネル用: 1 人の詳細 markdown */
export function formatContactDetailMarkdown(c: Contact): { title: string; markdown: string } {
  const lines: string[] = [];
  // ヘッダー
  const subParts: string[] = [];
  if (c.kana) subParts.push(`(${c.kana})`);
  if (c.nickname) subParts.push(`/ ${c.nickname}`);
  const subhead = subParts.length > 0 ? ` ${subParts.join(" ")}` : "";
  lines.push(`# ${c.name}${subhead}`);
  lines.push(`_${c.identifier}_`);

  // 所属・役職
  const affil: string[] = [];
  if (c.company) affil.push(c.company);
  if (c.department) affil.push(c.department);
  if (c.role) affil.push(c.role);
  if (affil.length > 0) {
    lines.push("");
    lines.push(`**所属**: ${affil.join(" / ")}`);
  }

  // 電話
  if (c.phones && c.phones.length > 0) {
    lines.push("");
    lines.push("## ☎ 電話");
    for (const p of c.phones) {
      const t = p.type ? `(${p.type}) ` : "";
      lines.push(`- ${t}${p.value}`);
    }
  }

  // メール
  if (c.emails && c.emails.length > 0) {
    lines.push("");
    lines.push("## ✉ メール");
    for (const e of c.emails) {
      const t = e.type ? `(${e.type}) ` : "";
      lines.push(`- ${t}${e.value}`);
    }
  }

  // 住所
  if (c.addresses && c.addresses.length > 0) {
    lines.push("");
    lines.push("## 🏠 住所");
    for (const a of c.addresses) {
      const t = a.type ? `(${a.type}) ` : "";
      lines.push(`- ${t}${a.value}`);
    }
  }

  // URL
  if (c.urls && c.urls.length > 0) {
    lines.push("");
    lines.push("## 🔗 URL");
    for (const u of c.urls) {
      lines.push(`- ${u}`);
    }
  }

  // メタ
  const meta: string[] = [];
  if (c.birthday) {
    const d = c.birthday.toISOString().slice(0, 10);
    meta.push(`誕生日: ${d}`);
  }
  if (c.tags && c.tags.length > 0) meta.push(`タグ: ${c.tags.join(", ")}`);
  if (c.lastContactAt) {
    meta.push(`最終接触: ${c.lastContactAt.toISOString().slice(0, 10)}`);
  }
  if (meta.length > 0) {
    lines.push("");
    lines.push(meta.map((m) => `- ${m}`).join("\n"));
  }

  // メモ
  if (c.notes && c.notes.trim().length > 0) {
    lines.push("");
    lines.push("## 📝 メモ");
    lines.push(c.notes.trim());
  }

  return {
    title: `連絡先: ${c.name}`,
    markdown: lines.join("\n"),
  };
}

/** ノートパネル用: 一覧 markdown table */
export function formatContactListMarkdown(
  list: Contact[],
  opts: { titleHint?: string } = {}
): { title: string; markdown: string } {
  if (list.length === 0) {
    return {
      title: opts.titleHint ?? "連絡先",
      markdown: "(該当なし)",
    };
  }
  const rows = list.map((c) => {
    const last = c.lastContactAt ? c.lastContactAt.toISOString().slice(0, 10) : "-";
    const phones = c.phones ?? [];
    const phoneCell =
      phones.length === 0
        ? "-"
        : phones.length === 1
          ? phones[0].value
          : `${phones[0].value} (+${phones.length - 1})`;
    return `| **${c.identifier}** | ${c.name} | ${c.company ?? "-"} | ${c.role ?? "-"} | ${phoneCell} | ${last} |`;
  });
  return {
    title: opts.titleHint ?? `連絡先 (${list.length}件)`,
    markdown: [
      `_全 ${list.length} 件_`,
      "",
      "| ID | 名前 | 会社 | 役職 | 電話 | 最終接触 |",
      "|---|---|---|---|---|---|",
      ...rows,
    ].join("\n"),
  };
}
