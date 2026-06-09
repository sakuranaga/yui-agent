/**
 * VCF (vCard) → contacts テーブル one-shot importer.
 *
 * 実行: docker compose exec web npx tsx src/scripts/import-vcf.ts <path.vcf>
 *
 * 仕様:
 *   - vCard 3.0/4.0 対応 (Apple Contacts export 想定)
 *   - line folding (RFC 2425) を unfold
 *   - PHOTO は破棄 (容量大)
 *   - 既存 (external_ref = "vcf:<UID>") があれば SKIP (idempotent)
 *   - emails/phones/addresses は配列で全保存、primary を単一カラムにコピー
 */
import { promises as fs } from "node:fs";
import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

const DEFAULT_SESSION_ID = process.env.IMPORT_CONTACTS_SESSION_ID ?? "imported-from-vcf";

type VCardField = {
  name: string;            // "EMAIL", "TEL" 等
  params: Record<string, string>; // {TYPE: "WORK,VOICE"} 等
  value: string;
};

type VCard = {
  uid?: string;
  fields: VCardField[];
};

function unfoldLines(text: string): string[] {
  // RFC 2425: CRLF + (space|tab) は前行の継続
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = norm.split("\n");
  const out: string[] = [];
  for (const line of rawLines) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseLine(line: string): VCardField | null {
  if (!line || line.startsWith(":")) return null;
  const colonIdx = line.indexOf(":");
  if (colonIdx < 0) return null;
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = left.split(";");
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const eq = p.indexOf("=");
    if (eq > 0) {
      params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    } else {
      // type だけ ("HOME" 単独) もある
      params.TYPE = (params.TYPE ? params.TYPE + "," : "") + p;
    }
  }
  // QUOTED-PRINTABLE デコード (旧 vCard)
  let decoded = value;
  if (params.ENCODING && params.ENCODING.toUpperCase().includes("QUOTED-PRINTABLE")) {
    decoded = decoded.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
    // CHARSET=Shift_JIS など指定があれば本来そこ通すべきだが、Apple export は UTF-8 想定で省略
  }
  return { name, params, value: decoded };
}

function parseVCards(text: string): VCard[] {
  const lines = unfoldLines(text);
  const cards: VCard[] = [];
  let current: VCard | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VCARD") {
      current = { fields: [] };
    } else if (line === "END:VCARD") {
      if (current) cards.push(current);
      current = null;
    } else if (current) {
      if (line.toUpperCase().startsWith("PHOTO")) continue; // skip binary
      const f = parseLine(line);
      if (!f) continue;
      if (f.name === "UID") current.uid = f.value;
      current.fields.push(f);
    }
  }
  return cards;
}

function pickFirst(card: VCard, name: string): VCardField | undefined {
  return card.fields.find((f) => f.name === name);
}
function pickAll(card: VCard, name: string): VCardField[] {
  return card.fields.filter((f) => f.name === name);
}

function typeLabel(params: Record<string, string>): string | undefined {
  const t = params.TYPE;
  if (!t) return undefined;
  // "INTERNET,WORK,PREF" のような複合 → 最初の意味的 type だけ
  const candidates = t
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !["internet", "pref", "voice"].includes(s));
  return candidates[0];
}

function formatAddress(value: string): string {
  // VCF ADR: PO;ExtAddr;Street;Locality;Region;Postcode;Country
  // 日本住所は逆順 (Country〜Postcode〜Region〜Locality〜Street) の方が読みやすい
  const parts = value.split(";").map((s) => s.trim());
  const [, , street = "", locality = "", region = "", postcode = "", country = ""] =
    parts;
  // 日本: <郵便番号> <region><locality><street>
  if (country === "" || /(japan|日本|jp)/i.test(country)) {
    const post = postcode ? `〒${postcode} ` : "";
    return `${post}${region}${locality}${street}`.trim() || value;
  }
  // 海外
  return [street, locality, region, postcode, country].filter(Boolean).join(", ");
}

function extractKana(card: VCard): string | undefined {
  // Apple は X-PHONETIC-LAST-NAME / X-PHONETIC-FIRST-NAME
  const last = card.fields.find((f) => f.name === "X-PHONETIC-LAST-NAME")?.value;
  const first = card.fields.find((f) => f.name === "X-PHONETIC-FIRST-NAME")?.value;
  const parts = [last, first].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function unescapeText(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

async function nextIdentifier(): Promise<string> {
  const result = await db.execute<{ n: number }>(
    sql`SELECT nextval('contacts_identifier_seq') AS n`
  );
  const n = (result as unknown as Array<{ n: number }>)[0]?.n;
  return `C-${n}`;
}

async function main() {
  const path = process.argv[2] ?? "./address_list.vcf";
  console.log(`[import] reading ${path}`);
  const raw = await fs.readFile(path, "utf-8");
  const cards = parseVCards(raw);
  console.log(`[import] parsed ${cards.length} vCards`);

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const card of cards) {
    try {
      const fn = pickFirst(card, "FN")?.value;
      const n = pickFirst(card, "N")?.value;
      let name = fn ? unescapeText(fn).trim() : "";
      if (!name && n) {
        // N: Family;Given;Middle;Prefix;Suffix
        const parts = n.split(";").map(unescapeText);
        name = [parts[3], parts[0], parts[1], parts[2], parts[4]]
          .filter(Boolean)
          .join(" ")
          .trim();
      }
      if (!name) {
        // 名前が無い card は skip
        skipped++;
        continue;
      }

      const externalRef = card.uid ? `vcf:${card.uid}` : `vcf:name:${name}`;
      const [existing] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.externalRef, externalRef))
        .limit(1);
      if (existing) {
        skipped++;
        continue;
      }

      const emails = pickAll(card, "EMAIL").map((f) => ({
        type: typeLabel(f.params),
        value: unescapeText(f.value).trim(),
      }));
      const phones = pickAll(card, "TEL").map((f) => ({
        type: typeLabel(f.params),
        value: unescapeText(f.value).trim(),
      }));
      const addresses = pickAll(card, "ADR")
        .map((f) => ({
          type: typeLabel(f.params),
          value: formatAddress(unescapeText(f.value)),
        }))
        .filter((a) => a.value.length > 0);
      const urls = pickAll(card, "URL")
        .map((f) => unescapeText(f.value).trim())
        .filter(Boolean);

      const org = pickFirst(card, "ORG")?.value;
      let company: string | null = null;
      let department: string | null = null;
      if (org) {
        const parts = org.split(";").map((s) => unescapeText(s).trim());
        company = parts[0] || null;
        department = parts[1] || null;
      }

      const title = pickFirst(card, "TITLE")?.value;
      const role = pickFirst(card, "ROLE")?.value;
      const finalRole = title
        ? unescapeText(title).trim()
        : role
          ? unescapeText(role).trim()
          : null;

      const bday = pickFirst(card, "BDAY")?.value;
      let birthday: Date | null = null;
      if (bday) {
        // 20210315 or 2021-03-15 or --03-15 等
        const compact = bday.replace(/-/g, "");
        if (/^\d{8}$/.test(compact)) {
          birthday = new Date(
            `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T00:00:00.000Z`
          );
          if (Number.isNaN(birthday.getTime())) birthday = null;
        }
      }

      const note = pickFirst(card, "NOTE")?.value;
      const notes = note ? unescapeText(note).trim() : null;

      const categories = pickFirst(card, "CATEGORIES")?.value;
      const tags = categories
        ? categories.split(",").map((s) => unescapeText(s).trim()).filter(Boolean)
        : [];

      const nickname = pickFirst(card, "NICKNAME")?.value;

      const identifier = await nextIdentifier();
      await db.insert(contacts).values({
        identifier,
        sessionId: DEFAULT_SESSION_ID,
        name,
        kana: extractKana(card) ?? null,
        nickname: nickname ? unescapeText(nickname).trim() : null,
        company,
        department,
        role: finalRole,
        emails,
        phones,
        addresses,
        urls,
        birthday,
        tags,
        notes,
        externalRef,
      });
      added++;
    } catch (e) {
      console.warn("[import] card failed:", e);
      failed++;
    }
  }

  console.log(`[import] DONE: added=${added}, skipped=${skipped}, failed=${failed}`);

  const [total] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(contacts);
  console.log(`[import] contacts total in DB = ${total.c}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[import] FAILED:", e);
  process.exit(1);
});
