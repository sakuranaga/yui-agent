import { getNowPlaying as spotifyGetNowPlaying } from "@/lib/spotify";
import { setNowPlaying } from "@/lib/music-commands";
import { isSpotifyPlayback } from "../availability/spotify";
import { asSpotifyError } from "./_specialist_helpers";
import type { ToolDef } from "../types";

export const spotifyNowPlaying: ToolDef = {
  name: "spotify_now_playing",
  description:
    "今かかっている曲を取得 (= 「この曲なに?」「アーティスト誰?」)。" +
    "何も再生していなければ now_playing=null。",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  callableBy: [{ kind: "specialist", id: "music" }],
  surface: "read",
  domain: "music",
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  availabilityKey: "spotify:playback",
  isAvailable: isSpotifyPlayback,
  handler: async () => {
    try {
      const np = await spotifyGetNowPlaying();
      if (!np) return { now_playing: null };
      setNowPlaying({
        title: np.trackName,
        artist: np.artistNames.join(", "),
        album: np.albumName,
        durationMs: np.durationMs,
        id: np.trackUri,
        isPlaying: np.isPlaying,
        updatedAt: Date.now(),
      });
      return {
        now_playing: {
          title: np.trackName,
          artist: np.artistNames.join(", "),
          album: np.albumName,
          is_playing: np.isPlaying,
          progress_ms: np.progressMs,
          duration_ms: np.durationMs,
          track_uri: np.trackUri,
        },
      };
    } catch (e) {
      const errResp = asSpotifyError(e);
      if (errResp) return errResp;
      throw e;
    }
  },
};
