/**
 * メールキュレーション設定 (singleton) の DB アクセス層。
 * news_curation_settings と別管理 (判定軸が違う)。
 *
 * 設計: docs/mail-system.md §4.4, §5
 */
import { db } from "@/db/client";
import { mailCurationSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

export type MailCurationCfg = {
  interestProfile: string;
  scoreThreshold: number;
  vipAddresses: string[];
  blockedAddresses: string[];
};

const DEFAULTS: MailCurationCfg = {
  interestProfile: "",
  scoreThreshold: 0.5,
  vipAddresses: [],
  blockedAddresses: [],
};

let cached: MailCurationCfg | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

export async function getMailCurationSettings(): Promise<MailCurationCfg> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  try {
    const [row] = await db
      .select()
      .from(mailCurationSettings)
      .where(eq(mailCurationSettings.id, 1))
      .limit(1);
    const next: MailCurationCfg = row
      ? {
          interestProfile: row.interestProfile,
          scoreThreshold: row.scoreThreshold,
          vipAddresses: row.vipAddresses ?? [],
          blockedAddresses: row.blockedAddresses ?? [],
        }
      : DEFAULTS;
    cached = next;
    cachedAt = Date.now();
    return next;
  } catch (e) {
    console.warn("[mail-curation-settings] load failed:", e);
    return DEFAULTS;
  }
}

export async function updateMailCurationSettings(
  patch: Partial<MailCurationCfg>
): Promise<void> {
  const current = await getMailCurationSettings();
  const next: MailCurationCfg = { ...current, ...patch };
  await db
    .insert(mailCurationSettings)
    .values({
      id: 1,
      interestProfile: next.interestProfile,
      scoreThreshold: next.scoreThreshold,
      vipAddresses: next.vipAddresses,
      blockedAddresses: next.blockedAddresses,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: mailCurationSettings.id,
      set: {
        interestProfile: next.interestProfile,
        scoreThreshold: next.scoreThreshold,
        vipAddresses: next.vipAddresses,
        blockedAddresses: next.blockedAddresses,
        updatedAt: new Date(),
      },
    });
  invalidateCache();
}

export async function addVip(email: string): Promise<void> {
  const cur = await getMailCurationSettings();
  const lower = email.toLowerCase().trim();
  if (cur.vipAddresses.includes(lower)) return;
  await updateMailCurationSettings({ vipAddresses: [...cur.vipAddresses, lower] });
}

export async function removeVip(email: string): Promise<void> {
  const cur = await getMailCurationSettings();
  const lower = email.toLowerCase().trim();
  await updateMailCurationSettings({
    vipAddresses: cur.vipAddresses.filter((e) => e !== lower),
  });
}

export async function addBlocked(email: string): Promise<void> {
  const cur = await getMailCurationSettings();
  const lower = email.toLowerCase().trim();
  if (cur.blockedAddresses.includes(lower)) return;
  await updateMailCurationSettings({ blockedAddresses: [...cur.blockedAddresses, lower] });
}

export async function removeBlocked(email: string): Promise<void> {
  const cur = await getMailCurationSettings();
  const lower = email.toLowerCase().trim();
  await updateMailCurationSettings({
    blockedAddresses: cur.blockedAddresses.filter((e) => e !== lower),
  });
}

export function invalidateCache(): void {
  cached = null;
  cachedAt = 0;
}
