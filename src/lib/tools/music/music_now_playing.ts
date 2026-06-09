/**
 * Spotify 現在再生中の曲情報取得 (= 「この曲なに?」「アーティスト誰?」)。
 * Premium 不要 (= 普通の連携で OK)。再生情報の確認のみ、制御はしない。
 */
import { getNowPlaying as spotifyGetNowPlaying } from "@/lib/spotify";
import { isSpotifyPlayback } from "../availability/spotify";
import type { ToolDef } from "../types";
import { mapSpotifyError } from "./_helpers";

export const musicNowPlaying: ToolDef = {
  name: "music_now_playing",
  description:
    "Spotify で現在再生中の曲情報を取得 (= 「この曲なに?」「アーティスト誰?」「タイトルは?」)。" +
    "再生していなければ null。再生情報の確認のみで、再生制御はしない。",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "music",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  availabilityKey: "spotify:playback",
  isAvailable: isSpotifyPlayback,
  handler: async () => {
    try {
      const np = await spotifyGetNowPlaying();
      return {
        now_playing: np
          ? {
              title: np.trackName,
              artist: np.artistNames.join(", "),
              album: np.albumName,
              is_playing: np.isPlaying,
              progress_ms: np.progressMs,
              duration_ms: np.durationMs,
            }
          : null,
      };
    } catch (e) {
      return mapSpotifyError(e);
    }
  },
};
