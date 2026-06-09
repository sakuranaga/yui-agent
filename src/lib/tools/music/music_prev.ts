/**
 * Spotify 前の曲へ戻す。Premium 必須。
 */
import { previous as spotifyPrevious } from "@/lib/spotify";
import { markMusicActivity } from "@/lib/music-commands";
import { isSpotifyPremium } from "../availability/spotify";
import type { ToolDef } from "../types";
import { swallow404, mapSpotifyError } from "./_helpers";

export const musicPrev: ToolDef = {
  name: "music_prev",
  description:
    "Spotify の前の曲へ戻る。「前の曲」「戻して」等。" +
    "戻り値 success:true なら確実に戻し済 → 「前に戻しましたよ」と断言形で返す。",
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
      await swallow404(() => spotifyPrevious());
      markMusicActivity();
      return {
        success: true,
        action: "prev",
        message: "前の曲に戻しました。",
      };
    } catch (e) {
      return mapSpotifyError(e);
    }
  },
};
