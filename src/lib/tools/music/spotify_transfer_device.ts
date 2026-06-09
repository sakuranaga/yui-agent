import { transferPlayback } from "@/lib/spotify";
import { isSpotifyPremium } from "../availability/spotify";
import { asSpotifyError } from "./_specialist_helpers";
import type { ToolDef } from "../types";

export const spotifyTransferDevice: ToolDef = {
  name: "spotify_transfer_device",
  description:
    "再生を別のデバイスに移す。device_id は spotify_devices で取得した id。",
  input_schema: {
    type: "object",
    properties: { device_id: { type: "string" } },
    required: ["device_id"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "specialist", id: "music" }],
  surface: "transport",
  domain: "music",
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  availabilityKey: "spotify:premium",
  isAvailable: isSpotifyPremium,
  handler: async (input) => {
    try {
      const i = (input ?? {}) as Record<string, unknown>;
      await transferPlayback(String(i.device_id));
      return { ok: true, device_id: String(i.device_id) };
    } catch (e) {
      const errResp = asSpotifyError(e);
      if (errResp) return errResp;
      throw e;
    }
  },
};
