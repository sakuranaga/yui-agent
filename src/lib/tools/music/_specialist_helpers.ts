/**
 * music specialist 内部 tool の共通 helper。元 src/lib/specialists/music.ts から抽出。
 */
import {
  getDevices,
  isSpotifyNotConnectedError,
  isSpotifyPremiumRequiredError,
  type SpotifyDevice,
  type SpotifyTrack,
} from "@/lib/spotify";

export function asSpotifyError(e: unknown): { error: string } | null {
  if (isSpotifyNotConnectedError(e)) {
    return { error: "Spotify と未連携です。設定 > Spotify から連携してください。" };
  }
  if (isSpotifyPremiumRequiredError(e)) {
    return {
      error:
        "この操作には Spotify Premium が必要です (Free アカウントでは再生制御不可)。",
    };
  }
  return null;
}

export async function pickActiveDeviceId(): Promise<string | null> {
  const devices = await getDevices();
  if (devices.length === 0) return null;
  const active = devices.find((d) => d.isActive);
  return (active ?? devices[0]).id;
}

export function trackToJson(t: SpotifyTrack) {
  return {
    uri: t.uri,
    name: t.name,
    artists: t.artistNames,
    album: t.albumName,
  };
}

export function deviceToJson(d: SpotifyDevice) {
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    is_active: d.isActive,
    volume_percent: d.volumePercent,
  };
}
