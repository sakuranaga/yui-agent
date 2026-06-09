/**
 * API ルートの共通エラー応答 helper。
 *
 * 動機: 多くの route が `e.message` / `String(e)` を直接 client に返すと、内部ホスト名・
 * パス・上流 API エラー本文・DB ドライバ詳細などが漏れて偵察に使われる。
 * これを 1 箇所に集約して「server log には full 詳細、client には generic」を強制する。
 *
 * 使い方:
 *   } catch (e) {
 *     return clientError(req, e, { status: 500, message: "ジョブ実行に失敗しました" });
 *   }
 *
 * - server log には [api-error] tag + route + 元 exception の message + stack を出力
 * - client には { error: <safe message> } を返す (= 既定 "Internal error")
 *
 * 既知の安全エラー (= user 入力 validation 等) は普通に NextResponse.json({error: "..."}) を
 * 使えば良い。本 helper は「上流例外 / 想定外 error を catch する場面」専用。
 */
import { NextResponse, type NextRequest } from "next/server";

export type ClientErrorOpts = {
  /** HTTP status (= 既定 500) */
  status?: number;
  /** client に返す安全な error message (= 既定 "Internal error") */
  message?: string;
  /** server log に追加する文脈 (= 例: "music dispatch", "mail/poll") */
  context?: string;
};

export function clientError(
  req: NextRequest | Request | undefined,
  e: unknown,
  opts: ClientErrorOpts = {}
): NextResponse {
  const status = opts.status ?? 500;
  const message = opts.message ?? "Internal error";
  const ctx = opts.context ?? "";
  const url = req instanceof Request ? req.url : ((req as unknown as { url?: string })?.url ?? "");
  const detail = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? e.stack : undefined;
  // server log には full (= 開発者が原因追跡できる)
  console.error(
    `[api-error]${ctx ? ` ${ctx}` : ""} ${url} → status=${status}: ${detail}`,
    stack ? `\n${stack}` : ""
  );
  return NextResponse.json({ error: message }, { status });
}

/**
 * 既知エラー型をマップして適切な client message にする helper。
 * 用途: Spotify/Google API error 等を catch して整理。
 */
export function clientErrorFromKnown(
  req: NextRequest | Request | undefined,
  e: unknown,
  knownMap: Array<{ test: (e: unknown) => boolean; status: number; message: string }>
): NextResponse {
  for (const k of knownMap) {
    if (k.test(e)) {
      return clientError(req, e, { status: k.status, message: k.message });
    }
  }
  return clientError(req, e);
}
