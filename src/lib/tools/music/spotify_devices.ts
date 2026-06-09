import { getDevices } from "@/lib/spotify";
import { isSpotifyPlayback } from "../availability/spotify";
import { asSpotifyError, deviceToJson } from "./_specialist_helpers";
import type { ToolDef } from "../types";

export const spotifyDevices: ToolDef = {
  name: "spotify_devices",
  description:
    "Spotify Connect で見えているデバイス一覧を返す。" +
    "「どのスピーカーで流れてる?」「PC に切り替えて」等のときに使う。" +
    "transfer_device で active を切り替えられる。",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  callableBy: [{ kind: "specialist", id: "music" }],
  surface: "read",
  domain: "music",
  allowedModes: ["normal", "timer"],
  confirmationPolicy: "auto",
  availabilityKey: "spotify:playback",
  isAvailable: isSpotifyPlayback,
  handler: async () => {
    try {
      const devices = await getDevices();
      return { count: devices.length, devices: devices.map(deviceToJson) };
    } catch (e) {
      const errResp = asSpotifyError(e);
      if (errResp) return errResp;
      throw e;
    }
  },
};
