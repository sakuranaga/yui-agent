/**
 * URL の事前検証 (= 登録経路 / 永続化前のチェック)。
 * safeFetch とは別に「DB に保存する前」に弾く目的。背景 cron が後で fetch するため、
 * 登録時点で private 範囲を拒否しないと stored SSRF が成立する。
 *
 * IP 範囲判定は src/lib/ip-block.ts に共通化 (= IPv4-mapped IPv6 も弾く)。
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { blockedIpReason } from "@/lib/ip-block";

/**
 * URL を解析し、private / loopback / link-local / metadata / CGNAT 範囲なら拒否理由を返す。
 * 受理なら null。
 */
export async function validatePublicUrl(rawUrl: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return "invalid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `unsupported scheme ${u.protocol}`;
  }
  if (isIP(u.hostname)) {
    const reason = blockedIpReason(u.hostname);
    if (reason) return `blocked IP ${u.hostname} (${reason})`;
    return null;
  }
  try {
    const addrs = await lookup(u.hostname, { all: true });
    for (const a of addrs) {
      const reason = blockedIpReason(a.address);
      if (reason) return `${u.hostname} resolves to blocked ${a.address} (${reason})`;
    }
  } catch (e) {
    return `DNS resolution failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
}
