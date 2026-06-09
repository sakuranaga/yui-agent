/**
 * Spotify 再生再開 (= 直前にかかってた曲を続き再生)。
 * 新規検索再生は ask_music_specialist 側。Premium 必須。
 */
import { play as spotifyPlay } from "@/lib/spotify";
import { markMusicActivity } from "@/lib/music-commands";
import { isSpotifyPremium } from "../availability/spotify";
import type { ToolDef } from "../types";
import { swallow404, mapSpotifyError } from "./_helpers";

export const musicResume: ToolDef = {
  name: "music_resume",
  description:
    "Spotify の停止中の曲を再生再開する (= 直前にかかってた曲を続き再生)。" +
    "「再生して」「再開」「続き」等で呼ぶ。新しい曲を検索して再生したい場合は使わず、" +
    "ask_music_specialist を使う。" +
    "戻り値 success:true なら確実に再開済 → 「再開しました」と断言形で返す。",
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
      await swallow404(() => spotifyPlay({}));
      markMusicActivity();
      return {
        success: true,
        state: "playing",
        message: "再生を再開しました。",
      };
    } catch (e) {
      return mapSpotifyError(e);
    }
  },
};
