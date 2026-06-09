/**
 * SSRF 防護付き fetch ヘルパ。
 *
 * 既定で:
 *   - http(s) スキームのみ許容
 *   - DNS 解決後の IP を検査し、private / loopback / link-local / multicast / metadata
 *     範囲なら拒否 (= 内部サービス / Tailnet / クラウド metadata への到達を遮断)
 *   - リダイレクトを手動で追跡し、各 hop 後に再検証 (= public URL → 内部 IP の誘導を防ぐ)
 *   - レスポンス size とタイムアウトの上限
 *
 * 使い分け:
 *   - 外部 (= 任意ユーザ入力 URL) を叩く → 必ず safeFetch
 *   - 内部 self-call (= http://localhost:3000/api/...) → internalFetch (auth header 経由)
 *   - 既知サービス (= env で固定された SearXNG / Open-Meteo / Spotify API 等) → 生 fetch を
 *     allowedHosts に追加するか、呼び出し側で eslint-disable + 明示コメントで例外化
 *
 * 公開構成 (= 配布物として様々な user 環境で動く) では「private 範囲拒否」が user の
 * Tailnet 経由 service を壊しうるため、allowedHosts オプションで上書き可能。
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { blockedIpReason } from "@/lib/ip-block";

export type SafeFetchOptions = RequestInit & {
  /** 最大リダイレクト追跡数 (= 既定 3) */
  maxRedirects?: number;
  /** レスポンス body の最大 byte 数 (= 既定 5MB)。超えたら abort */
  maxBytes?: number;
  /** リクエストタイムアウト (= 既定 15 秒) */
  timeoutMs?: number;
  /**
   * 追加で private 範囲アクセスを許可するホスト名 allowlist。
   * ⚠️ user 入力 URL の hostname を自動で入れてはいけない (= SSRF 防護無効化)。
   * 必ず **env など信頼経路で固定された** ホストだけを渡す。
   * env `SAFE_FETCH_ALLOWED_HOSTS` (= comma-separated) は自動で merge される。
   * 例: ["llm.internal", "10.0.0.10"] のように既知の私的 LLM / Tailnet を通すため。
   */
  allowedHosts?: string[];
};

/**
 * env `SAFE_FETCH_ALLOWED_HOSTS` から信頼ホスト集合を作る (= 起動時に 1 度評価)。
 * comma 区切り。空白は trim。
 * 例: `SAFE_FETCH_ALLOWED_HOSTS=llm.internal,ollama-host,10.0.0.10`
 */
const ENV_ALLOWED_HOSTS: ReadonlySet<string> = (() => {
  const raw = process.env.SAFE_FETCH_ALLOWED_HOSTS ?? "";
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
  );
})();

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export class SafeFetchBlockedError extends Error {
  constructor(public readonly reason: string, public readonly target: string) {
    super(`safeFetch blocked: ${reason} (${target})`);
    this.name = "SafeFetchBlockedError";
  }
}

// 内部/private IP 判定は src/lib/ip-block.ts に共通化 (= url-validate.ts と共有)。
// IPv4-mapped IPv6 (::ffff:127.0.0.1 等) もそこで弾く。

/**
 * 1 ホップごとの URL 検証 (= スキーム + 解決後 IP)。
 *
 * 戻り値: { url, pinnedIp } — fetch 用の URL と、検証で得た IP (= http の場合 URL を
 * IP に rewrite して fetch することで TOCTOU 窓を閉じる。https は SNI / TLS 証明書検証の
 * 都合で hostname のまま fetch するため、Node が再 DNS 解決する隙が残る)。
 */
async function verifyTarget(
  rawUrl: string,
  allowedHosts: Set<string>
): Promise<{ url: URL; pinnedIp: string | null }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchBlockedError("invalid URL", rawUrl);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchBlockedError(`unsupported scheme ${url.protocol}`, rawUrl);
  }
  // allowlist 完全一致 (例: "ollama-host", "10.0.0.10")。
  // ⚠️ user 入力ベースで自動拡張してはいけない (= SSRF 防護無効化)。caller の allowedHosts は
  // env / 信頼経路の固定値のみ渡すべき。
  const hostLower = url.hostname.toLowerCase();
  if (allowedHosts.has(hostLower) || ENV_ALLOWED_HOSTS.has(hostLower)) {
    return { url, pinnedIp: null };
  }

  // 直接 IP 指定 (= "http://192.168.x.x/" / "http://[::ffff:127.0.0.1]/" 等) は
  // DNS 解決をスキップして即検証 (= IPv4-mapped IPv6 も blockedIpReason が IPv4 として再判定)
  if (isIP(url.hostname)) {
    const reason = blockedIpReason(url.hostname);
    if (reason) {
      throw new SafeFetchBlockedError(`blocked IP ${url.hostname} (${reason})`, rawUrl);
    }
    return { url, pinnedIp: url.hostname };
  }

  // ホスト名 → DNS 解決 (= 攻撃者が `internal.example.com` を 10.x.x.x に向ける DNS rebinding 対策)
  let addrs;
  try {
    addrs = await lookup(url.hostname, { all: true });
  } catch (e) {
    throw new SafeFetchBlockedError(
      `DNS resolution failed: ${e instanceof Error ? e.message : String(e)}`,
      rawUrl
    );
  }
  for (const a of addrs) {
    const reason = blockedIpReason(a.address);
    if (reason) {
      throw new SafeFetchBlockedError(
        `${url.hostname} resolved to blocked ${a.address} (${reason})`,
        rawUrl
      );
    }
  }
  // 検証 OK の最初の IP を pinned IP として返す (= http の場合 fetch URL を書き換え)
  const firstIp = addrs[0]?.address ?? null;
  return { url, pinnedIp: firstIp };
}

/**
 * SSRF 防護付き fetch。
 * - URL を解決 → 内部 IP なら即拒否
 * - redirect: 'manual' で各 hop を自前で追跡、毎回 verify
 * - body は maxBytes でカット
 *
 * 戻り値は標準 Response 互換 (= res.text() / res.json() / res.arrayBuffer() 等が使える)。
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {}
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowedHosts = new Set(opts.allowedHosts ?? []);

  // RequestInit 部分は redirect/signal を上書きするので copy 取り出し
  const { maxRedirects: _mr, maxBytes: _mb, timeoutMs: _t, allowedHosts: _ah, ...init } = opts;
  void _mr; void _mb; void _t; void _ah;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    let currentUrl = rawUrl;
    let res: Response | null = null;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const { url: verified, pinnedIp } = await verifyTarget(currentUrl, allowedHosts);
      // HTTP の場合は URL を pinned IP に書き換えて Host header に元 hostname を保持する。
      // これで Node の fetch が再 DNS 解決しても接続先が固定 IP になり、DNS rebinding を
      // 完全に閉じる。
      // HTTPS は SNI / 証明書検証が hostname ベースなので IP rewrite せず hostname のまま
      // fetch する (= rebinding 窓は残るが、最初の verify で 1 度通った IP が攻撃者制御
      // 名前サーバから「verify と fetch の間に書き換わる」窓は通常ミリ秒で実害は低い)。
      let fetchUrl = verified.toString();
      const fetchHeaders = new Headers(init.headers);
      if (verified.protocol === "http:" && pinnedIp && pinnedIp !== verified.hostname) {
        fetchHeaders.set("Host", verified.host); // host:port
        const ipUrl = new URL(verified.toString());
        // IPv6 は [..] で囲む必要
        ipUrl.hostname = isIP(pinnedIp) === 6 ? `[${pinnedIp}]` : pinnedIp;
        fetchUrl = ipUrl.toString();
      }
      res = await fetch(fetchUrl, {
        ...init,
        headers: fetchHeaders,
        redirect: "manual",
        signal: ac.signal,
      });
      // 3xx → Location を取って再検証
      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        if (hop === maxRedirects) {
          throw new SafeFetchBlockedError(`too many redirects (>${maxRedirects})`, currentUrl);
        }
        const loc = res.headers.get("location")!;
        // 相対 URL を絶対化 (= verified base、IP rewrite 後ではなく元 URL ベース)
        currentUrl = new URL(loc, verified).toString();
        // body 読み捨て (= keep-alive 行儀)
        try { await res.arrayBuffer(); } catch { /* noop */ }
        continue;
      }
      break;
    }
    if (!res) throw new SafeFetchBlockedError("no response", rawUrl);

    // body size 制限 = stream をラップして maxBytes 超えたら abort
    if (res.body) {
      const limited = new Response(limitStream(res.body, maxBytes, ac), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      return limited;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** ReadableStream を maxBytes でラップ。超えたら abort + stream エラーで close。 */
function limitStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  ac: AbortController
): ReadableStream<Uint8Array> {
  let read = 0;
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        read += value.byteLength;
        if (read > maxBytes) {
          ac.abort();
          controller.error(new SafeFetchBlockedError(`response exceeds ${maxBytes} bytes`, ""));
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
}
