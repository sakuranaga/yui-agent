/**
 * POST /api/spotify/control
 *
 * 再生制御の単一 endpoint。
 *
 * body 例:
 *   { action: "play", uris: ["spotify:track:..."] }
 *   { action: "play", contextUri: "spotify:playlist:..." }
 *   { action: "pause" }
 *   { action: "next" }
 *   { action: "prev" }
 *   { action: "volume", volumePercent: 50 }
 *   { action: "transfer", deviceId: "..." }
 *
 * 全 action 共通の optional: deviceId
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  isSpotifyNotConnectedError,
  isSpotifyPremiumRequiredError,
  next as nextTrack,
  pause,
  play,
  previous,
  seek,
  setVolume,
  transferPlayback,
} from "@/lib/spotify";

type ControlAction =
  | "play"
  | "pause"
  | "next"
  | "prev"
  | "volume"
  | "seek"
  | "transfer";

type ControlBody = {
  action: ControlAction;
  deviceId?: string;
  volumePercent?: number;
  positionMs?: number;
  play?: boolean;
  uris?: string[];
  contextUri?: string;
};

function isControlAction(v: unknown): v is ControlAction {
  return (
    v === "play" ||
    v === "pause" ||
    v === "next" ||
    v === "prev" ||
    v === "volume" ||
    v === "seek" ||
    v === "transfer"
  );
}

function parseBody(raw: unknown): ControlBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body must be JSON object" };
  const obj = raw as Record<string, unknown>;
  if (!isControlAction(obj.action)) return { error: "invalid action" };

  const body: ControlBody = { action: obj.action };

  if (obj.deviceId !== undefined) {
    if (typeof obj.deviceId !== "string") return { error: "deviceId must be string" };
    body.deviceId = obj.deviceId;
  }
  if (obj.volumePercent !== undefined) {
    if (typeof obj.volumePercent !== "number") return { error: "volumePercent must be number" };
    body.volumePercent = obj.volumePercent;
  }
  if (obj.positionMs !== undefined) {
    if (typeof obj.positionMs !== "number") return { error: "positionMs must be number" };
    body.positionMs = obj.positionMs;
  }
  if (obj.play !== undefined) {
    if (typeof obj.play !== "boolean") return { error: "play must be boolean" };
    body.play = obj.play;
  }
  if (obj.uris !== undefined) {
    if (
      !Array.isArray(obj.uris) ||
      !obj.uris.every((u): u is string => typeof u === "string")
    ) {
      return { error: "uris must be string[]" };
    }
    body.uris = obj.uris;
  }
  if (obj.contextUri !== undefined) {
    if (typeof obj.contextUri !== "string") return { error: "contextUri must be string" };
    body.contextUri = obj.contextUri;
  }
  return body;
}

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    switch (parsed.action) {
      case "play":
        await play({
          deviceId: parsed.deviceId,
          uris: parsed.uris,
          contextUri: parsed.contextUri,
        });
        break;
      case "pause":
        await pause(parsed.deviceId);
        break;
      case "next":
        await nextTrack(parsed.deviceId);
        break;
      case "prev":
        await previous(parsed.deviceId);
        break;
      case "volume":
        if (parsed.volumePercent === undefined) {
          return NextResponse.json(
            { error: "volumePercent required for action=volume" },
            { status: 400 }
          );
        }
        await setVolume(parsed.volumePercent, parsed.deviceId);
        break;
      case "seek":
        if (parsed.positionMs === undefined) {
          return NextResponse.json(
            { error: "positionMs required for action=seek" },
            { status: 400 }
          );
        }
        await seek(parsed.positionMs, parsed.deviceId);
        break;
      case "transfer":
        if (!parsed.deviceId) {
          return NextResponse.json(
            { error: "deviceId required for action=transfer" },
            { status: 400 }
          );
        }
        await transferPlayback(parsed.deviceId, parsed.play ?? false);
        break;
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isSpotifyNotConnectedError(e)) {
      return NextResponse.json(
        { error: "Spotify not connected" },
        { status: 401 }
      );
    }
    if (isSpotifyPremiumRequiredError(e)) {
      return NextResponse.json(
        { error: "Spotify Premium required" },
        { status: 402 }
      );
    }
    const { clientError } = await import("@/lib/api-error");
    return clientError(req, e, {
      status: 500,
      message: "Spotify 操作に失敗しました",
      context: `spotify/control action=${parsed.action}`,
    });
  }
}
