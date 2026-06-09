/**
 * Spotify 一時停止 (Yui main direct、specialist 経由しない)。
 * Premium 必須。404 は state mismatch (= 既に止まってる) として success 扱い。
 */
import { pause as spotifyPause } from "@/lib/spotify";
import { markMusicActivity } from "@/lib/music-commands";
import { isSpotifyPremium } from "../availability/spotify";
import type { ToolDef } from "../types";
import { swallow404, mapSpotifyError } from "./_helpers";

export const musicPause: ToolDef = {
  name: "music_pause",
  description:
    "Spotify の現在の再生を一時停止する。「止めて」「ストップ」「一時停止」等で呼ぶ。" +
    "戻り値 success:true なら確実に停止済 → 「止めましたよ」と断言形で返す。" +
    "「うまく止まったかな」等の疑問形は禁止。",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  callableBy: [{ kind: "main" }],
  surface: "transport",
  domain: "music",
  untrustedOutput: false,
  allowedModes: ["normal", "timer"],
  confirmationPolicy: "auto",
  availabilityKey: "spotify:premium",
  isAvailable: isSpotifyPremium,
  handler: async () => {
    try {
      await swallow404(() => spotifyPause());
      markMusicActivity();
      return {
        success: true,
        state: "paused",
        message: "再生を一時停止しました。",
      };
    } catch (e) {
      return mapSpotifyError(e);
    }
  },
};
