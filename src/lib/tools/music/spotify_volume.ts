import { setVolume as spotifySetVolume } from "@/lib/spotify";
import { isSpotifyPremium } from "../availability/spotify";
import { asSpotifyError, pickActiveDeviceId } from "./_specialist_helpers";
import type { ToolDef } from "../types";

export const spotifyVolume: ToolDef = {
  name: "spotify_volume",
  description:
    "Spotify 再生音量を 0-100 のパーセントで設定する。" +
    "「音量上げて/下げて」「もう少し小さく」等。",
  input_schema: {
    type: "object",
    properties: {
      percent: { type: "integer", minimum: 0, maximum: 100 },
    },
    required: ["percent"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "specialist", id: "music" }],
  surface: "transport",
  domain: "music",
  allowedModes: ["normal", "timer"],
  confirmationPolicy: "auto",
  availabilityKey: "spotify:premium",
  isAvailable: isSpotifyPremium,
  handler: async (input) => {
    try {
      const i = (input ?? {}) as Record<string, unknown>;
      const percent = Math.max(0, Math.min(100, Number(i.percent)));
      const deviceId = await pickActiveDeviceId();
      await spotifySetVolume(percent, deviceId ?? undefined);
      return { ok: true, volume_percent: percent };
    } catch (e) {
      const errResp = asSpotifyError(e);
      if (errResp) return errResp;
      throw e;
    }
  },
};
