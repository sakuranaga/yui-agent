/**
 * Spotify 音量設定 (0-100)。Premium 必須。
 * markMusicActivity は呼ばない (= 既存 route.ts の挙動を踏襲)。
 */
import { setVolume as spotifySetVolume } from "@/lib/spotify";
import { isSpotifyPremium } from "../availability/spotify";
import type { ToolDef } from "../types";
import { swallow404, mapSpotifyError } from "./_helpers";

export const musicVolume: ToolDef = {
  name: "music_volume",
  description:
    "Spotify の再生音量を設定する (0-100)。「音量上げて」なら現在値 +10、「音量 50 にして」なら 50。" +
    "現在値が必要なら music_now_playing で device の volume_percent を見てから増減する。" +
    "戻り値 success:true なら確実に設定済 → 「音量 N% にしました」と断言形で返す。",
  input_schema: {
    type: "object",
    properties: {
      percent: { type: "integer", description: "0-100 の音量値" },
    },
    required: ["percent"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "transport",
  domain: "music",
  untrustedOutput: false,
  allowedModes: ["normal", "timer"],
  confirmationPolicy: "auto",
  availabilityKey: "spotify:premium",
  isAvailable: isSpotifyPremium,
  handler: async (input) => {
    const i = (input ?? {}) as { percent?: unknown };
    const pct = typeof i.percent === "number" ? i.percent : 50;
    try {
      await swallow404(() => spotifySetVolume(pct));
      return {
        success: true,
        volume_percent: pct,
        message: `音量を ${pct}% に設定しました。`,
      };
    } catch (e) {
      return mapSpotifyError(e);
    }
  },
};
