/**
 * IP 範囲ブロック判定 (= SSRF 防護の共有 helper)。
 * safe-fetch.ts と url-validate.ts の両方で使う (= 同じロジックの重複を避ける)。
 *
 * 戻り値 string なら拒否 (理由付き)、null なら受理。
 */
import { isIP } from "node:net";

/** IPv4-mapped IPv6 (例: ::ffff:127.0.0.1, ::ffff:7f00:1, ::127.0.0.1) を IPv4 に正規化。 */
function ipv4FromMappedV6(ip: string): string | null {
  const lower = ip.toLowerCase();
  // dotted-quad: ::ffff:127.0.0.1, ::127.0.0.1 (IPv4-compatible、deprecated だが念のため)
  const dotted = lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  // hex 形式: ::ffff:7f00:1 (= ::ffff:127.0.0.1)
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
  }
  return null;
}

export function blockedIpReason(ip: string): string | null {
  const v = isIP(ip);
  if (v === 4) return blockedV4Reason(ip);
  if (v === 6) {
    // IPv4-mapped を IPv4 として再判定 (= ::ffff:127.0.0.1 が loopback を抜ける問題回避)
    const mapped = ipv4FromMappedV6(ip);
    if (mapped) {
      const r = blockedV4Reason(mapped);
      return r ? `IPv4-mapped (${mapped}) ${r}` : null;
    }
    return blockedV6Reason(ip);
  }
  return `unknown IP version: ${ip}`;
}

function blockedV4Reason(ip: string): string | null {
  const parts = ip.split(".").map((x) => parseInt(x, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return `invalid IPv4: ${ip}`;
  }
  const [a, b] = parts;
  if (a === 10) return "10/8 private";
  if (a === 127) return "127/8 loopback";
  if (a === 169 && b === 254) return "169.254/16 link-local (含 cloud metadata)";
  if (a === 172 && b >= 16 && b <= 31) return "172.16/12 private";
  if (a === 192 && b === 168) return "192.168/16 private";
  if (a === 100 && b >= 64 && b <= 127) return "100.64/10 CGNAT (Tailscale 等)";
  if (a === 0) return "0/8 reserved";
  if (a >= 224) return "224+/4 multicast/reserved";
  return null;
}

function blockedV6Reason(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return "IPv6 loopback";
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb"))
    return "fe80::/10 link-local";
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "fc00::/7 ULA";
  if (lower.startsWith("ff")) return "ff00::/8 multicast";
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return "IPv6 unspecified";
  return null;
}
