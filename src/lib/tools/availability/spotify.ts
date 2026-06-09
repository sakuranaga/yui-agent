/**
 * Spotify 連携の capability 可用性判定。
 *
 * capability:
 *   - spotify:playback — 連携済 + Web API 到達可 (= Free でも限定的 read は可)
 *   - spotify:premium  — 上記 + Premium 必須機能 (transfer / volume 設定など)
 *
 * 設計: docs/tool-architecture.md §4.4 (v3)
 */
import { getMe } from "@/lib/spotify";
import type { ToolContext } from "../types";

/** Spotify 連携済 + Web API 経由で /me が叩けるか */
export const isSpotifyPlayback = async (
  _: Pick<ToolContext, "sessionId" | "availabilityCache">
): Promise<boolean> => {
  const me = await getMe().catch(() => null);
  return me !== null;
};

/** Spotify Premium かどうか (= playback control / transfer 系で必須) */
export const isSpotifyPremium = async (
  _: Pick<ToolContext, "sessionId" | "availabilityCache">
): Promise<boolean> => {
  const me = await getMe().catch(() => null);
  return me?.product === "premium";
};
