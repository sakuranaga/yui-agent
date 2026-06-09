/**
 * music transport 共通ヘルパー。
 *
 * - swallow404: Spotify API 操作で 404 (= 既に止まってる / device 無し / 既に再生中等の
 *   state mismatch) を無視する。それ以外の例外は throw して上位の error mapping に流す。
 * - mapSpotifyError: 連携無し / Premium 必須 を構造化 { error: ... } に正規化。
 *   それ以外は throw し直す (= ToolRunner 側で errResult 化される)。
 */
import {
  isSpotifyNotConnectedError,
  isSpotifyPremiumRequiredError,
} from "@/lib/spotify";

export async function swallow404<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && /\b404\b/.test(e.message)) return undefined;
    throw e;
  }
}

export function mapSpotifyError(e: unknown): { error: string } {
  if (isSpotifyNotConnectedError(e)) {
    return { error: "Spotify と未連携です。設定 > Spotify から連携してください。" };
  }
  if (isSpotifyPremiumRequiredError(e)) {
    return { error: "Spotify Premium が必要な操作です。" };
  }
  throw e;
}
