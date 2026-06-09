/**
 * Spotify 次の曲スキップ。Premium 必須。
 */
import { next as spotifyNext } from "@/lib/spotify";
import { markMusicActivity } from "@/lib/music-commands";
import { isSpotifyPremium } from "../availability/spotify";
import type { ToolDef } from "../types";
import { swallow404, mapSpotifyError } from "./_helpers";

export const musicNext: ToolDef = {
  name: "music_next",
  description:
    "Spotify の次の曲へスキップ。「次の曲」「スキップ」「飛ばして」等。" +
    "戻り値 success:true なら確実にスキップ済 → 「次に進めましたよ」と断言形で返す。" +
    "「何か流れてますか?」「うまく反応してるといい」等の疑問形は禁止。",
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
      await swallow404(() => spotifyNext());
      markMusicActivity();
      return {
        success: true,
        action: "next",
        message: "次の曲に進みました。",
      };
    } catch (e) {
      return mapSpotifyError(e);
    }
  },
};
