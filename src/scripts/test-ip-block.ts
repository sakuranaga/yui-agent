/* eslint-disable */
import { blockedIpReason } from "@/lib/ip-block";

const tests = [
  // IPv4-mapped IPv6 — レビュー指摘で追加した防御テスト
  "::ffff:127.0.0.1",
  "::ffff:169.254.169.254",
  "::ffff:10.0.0.1",
  "::ffff:7f00:1",      // hex 形式 = 127.0.0.1
  "::ffff:a9fe:a9fe",   // hex 形式 = 169.254.169.254
  "::127.0.0.1",        // IPv4-compatible (deprecated だが念のため)

  // 既存 IPv6 範囲
  "::1",
  "fc00::1",
  "fe80::1",

  // 既存 IPv4 範囲
  "127.0.0.1",
  "10.0.0.1",
  "169.254.169.254",
  "100.64.0.1",         // CGNAT

  // 通すべき
  "8.8.8.8",
  "2606:4700:4700::1111",
  "100.92.99.16",       // CGNAT 範囲のサンプル (= env allowlist 経由でのみ通る想定)
];
for (const t of tests) console.log(t.padEnd(28), "→", blockedIpReason(t) ?? "OK");
