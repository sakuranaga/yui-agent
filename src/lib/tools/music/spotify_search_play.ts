import {
  searchTracks,
  searchPlaylists,
  play as spotifyPlay,
  getNowPlaying as spotifyGetNowPlaying,
} from "@/lib/spotify";
import { markMusicActivity } from "@/lib/music-commands";
import { fetchTrackTrivia } from "@/lib/music-trivia";
import { isSpotifyPremium } from "../availability/spotify";
import { asSpotifyError, pickActiveDeviceId, trackToJson } from "./_specialist_helpers";
import type { ToolDef } from "../types";

export const spotifySearchPlay: ToolDef = {
  name: "spotify_search_play",
  description:
    "Spotify を検索して、ヒットした 1 件目をすぐ再生する (= 「ジャズ流して」「Mr.Children 再生」等)。" +
    "kind=track なら曲、kind=playlist ならプレイリストを検索。" +
    "ジャンルだけの依頼ならまず playlist 推奨 (長く流れる)。" +
    "再生開始したら必ず結論に track/playlist 名を含めて返すこと。" +
    "kind=playlist の戻り値には first_track (= context 再生開始直後の 1 曲目の title/artist) が含まれる " +
    "(取れなかった場合のみ null)。**first_track がある場合は必ず結論に「1 曲目: <title> (<artist>)」を含めること**。",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "検索キーワード (例: 'ジャズ', 'Mr.Children Tomorrow never knows')" },
      kind: {
        type: "string",
        enum: ["track", "playlist"],
        description: "track = 単曲検索 / playlist = プレイリスト検索",
      },
      limit: { type: "integer", default: 5 },
    },
    required: ["query", "kind"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "specialist", id: "music" }],
  surface: "transport",
  domain: "music",
  allowedModes: ["normal", "timer"],
  confirmationPolicy: "auto",
  // transport だが戻り値に再生した track/playlist・候補・trivia を含み結論に反映する必要があるため
  // 既定 (transport→silent) を上書きして report (docs/tool-dispatch-redesign.md §4.2、Codex P1 Low)。
  dispatch: { disposition: "report" },
  availabilityKey: "spotify:premium",
  isAvailable: isSpotifyPremium,
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const query = String(i.query);
    const kind = String(i.kind) as "track" | "playlist";
    const limit = typeof i.limit === "number" ? i.limit : 5;
    try {
      const deviceId = await pickActiveDeviceId();
      if (!deviceId) {
        return {
          error:
            "再生可能なデバイスが見つかりません。Spotify アプリを 1 度開いてアクティブ化してください (PC/スマホ いずれか)。",
        };
      }
      if (kind === "track") {
        const tracks = await searchTracks(query, limit);
        if (tracks.length === 0) return { played: false, count: 0, query };
        const top = tracks[0];
        await spotifyPlay({ deviceId, uris: [top.uri] });
        markMusicActivity();
        const triviaObj = await fetchTrackTrivia(
          top.name,
          top.artistNames.join(", "),
          top.uri
        ).catch(() => null);
        return {
          played: true,
          kind: "track",
          top: trackToJson(top),
          trivia: triviaObj?.trivia ?? null,
          trivia_markdown: triviaObj?.markdown ?? null,
          candidates: tracks.slice(1, 4).map(trackToJson),
        };
      } else {
        const playlists = await searchPlaylists(query, limit);
        if (playlists.length === 0) return { played: false, count: 0, query };
        const top = playlists[0];
        let prevUri: string | null = null;
        try {
          const prev = await spotifyGetNowPlaying();
          prevUri = prev?.trackUri ?? null;
        } catch {
          /* noop */
        }
        await spotifyPlay({ deviceId, contextUri: top.uri });
        markMusicActivity();
        let firstTrack: {
          title: string;
          artist: string;
          trackUri?: string;
          trivia?: string | null;
        } | null = null;
        for (let n = 0; n < 8; n++) {
          await new Promise((r) => setTimeout(r, 400));
          try {
            const np = await spotifyGetNowPlaying();
            if (np?.trackName && np.isPlaying && np.trackUri !== prevUri) {
              firstTrack = {
                title: np.trackName,
                artist: np.artistNames.join(", "),
                trackUri: np.trackUri,
              };
              break;
            }
          } catch {
            /* noop */
          }
        }
        let firstTrackTriviaMarkdown: string | null = null;
        if (firstTrack) {
          const triviaObj = await fetchTrackTrivia(
            firstTrack.title,
            firstTrack.artist,
            firstTrack.trackUri ?? null
          ).catch(() => null);
          firstTrack.trivia = triviaObj?.trivia ?? null;
          firstTrackTriviaMarkdown = triviaObj?.markdown ?? null;
        }
        return {
          played: true,
          kind: "playlist",
          top: {
            uri: top.uri,
            name: top.name,
            owner: top.ownerName,
            track_count: top.trackCount,
          },
          first_track: firstTrack,
          first_track_trivia_markdown: firstTrackTriviaMarkdown,
        };
      }
    } catch (e) {
      const errResp = asSpotifyError(e);
      if (errResp) return errResp;
      throw e;
    }
  },
};
