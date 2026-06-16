/**
 * Music specialist: Spotify ベースの選曲・再生制御担当 (Apple Music から移行)。
 *
 * Spotify Web API を直接叩いて、検索 → play / pause / next / prev / volume / device 制御まで
 * server side で完結させる。frontend へのコマンド push は不要 (UI は MusicModal が
 * 独自に Spotify API を polling して状態表示)。
 *
 * 互換性: Yui tool 名 (= `ask_music_specialist`) と registry interface は維持。
 * 上位の Yui prompt / dispatcher は触らずに済むようにしてある。
 *
 * Spotify Free でも search / now-playing は動くが、play/pause/next/volume 系は
 * Premium 必須 → SpotifyPremiumRequiredError を catch して Yui に伝える。
 */
import {
  getDevices,
  getNowPlaying as spotifyGetNowPlaying,
  isSpotifyNotConnectedError,
  isSpotifyPremiumRequiredError,
  play as spotifyPlay,
  searchPlaylists,
  searchTracks,
  setVolume as spotifySetVolume,
  transferPlayback,
  type SpotifyDevice,
  type SpotifyTrack,
} from "@/lib/spotify";
import { markMusicActivity, setNowPlaying } from "@/lib/music-commands";
import { fetchTrackTrivia } from "@/lib/music-trivia";
import { webSpecialistTools } from "@/lib/tools/web";
import type { Specialist, SpecialistTool } from "./types";

/**
 * specialist tool 内で Spotify エラーを Yui 向け文字列に変換する共通 helper。
 * 1 つでも例外を投げると runner 側で fail するので、必ず {error: "..."} 形式で
 * 返して specialist の通常応答ループを継続させる。
 */
function asSpotifyError(e: unknown): { error: string } | null {
  if (isSpotifyNotConnectedError(e)) {
    return {
      error:
        "Spotify と未連携です。設定 > Spotify から連携してください。",
    };
  }
  if (isSpotifyPremiumRequiredError(e)) {
    return {
      error:
        "この操作には Spotify Premium が必要です (Free アカウントでは再生制御不可)。",
    };
  }
  return null;
}

/**
 * Spotify Connect の active device を1つ選ぶ。
 * 1) is_active が立っているものを優先
 * 2) なければ最初のデバイス
 * 3) デバイス 0 件なら null
 */
async function pickActiveDeviceId(): Promise<string | null> {
  const devices = await getDevices();
  if (devices.length === 0) return null;
  const active = devices.find((d) => d.isActive);
  return (active ?? devices[0]).id;
}

function trackToJson(t: SpotifyTrack) {
  return {
    uri: t.uri,
    name: t.name,
    artists: t.artistNames,
    album: t.albumName,
  };
}

function deviceToJson(d: SpotifyDevice) {
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    is_active: d.isActive,
    volume_percent: d.volumePercent,
  };
}

const tools: SpecialistTool[] = [
  {
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
    handler: async (input) => {
      const query = String(input.query);
      const kind = String(input.kind) as "track" | "playlist";
      const limit = (input.limit as number | undefined) ?? 5;
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
          if (tracks.length === 0) {
            return { played: false, count: 0, query };
          }
          const top = tracks[0];
          await spotifyPlay({ deviceId, uris: [top.uri] });
          // 初回紹介は specialist の voice formatter が出すので、その直後の auto-notify
          // (= 曲変化検知で「次は X ですね」) を抑制するため activity マーカー
          markMusicActivity();
          // trivia 取得 (= web 検索 + LLM 要約、cache hit ならゼロ待ち)
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
          if (playlists.length === 0) {
            return { played: false, count: 0, query };
          }
          const top = playlists[0];
          // 直前に再生 (or paused) されていた track URI を覚えておく。後段の polling で
          // 「context 切替直後にまだ前曲が返ってくる」のを除外するため。
          // 例: ユーロビート paused → 演歌 playlist 再生開始 → 1 曲目を polling した瞬間に
          //     まだ Spotify 側は paused 中のユーロビートを返してしまい、結果 trivia が
          //     ユーロビート曲のものになる、というのが実機で発生した。
          let prevUri: string | null = null;
          try {
            const prev = await spotifyGetNowPlaying();
            prevUri = prev?.trackUri ?? null;
          } catch {
            /* noop */
          }
          await spotifyPlay({ deviceId, contextUri: top.uri });
          markMusicActivity();
          // Spotify が context active 化して最初の track を選ぶまで polling。
          // 条件: 「isPlaying=true」かつ「直前 URI と異なる」track を採用 (= 切替確認)。
          //   - isPlaying=false は単に track が読み込まれてないだけの可能性
          //   - 直前と同 URI = 旧キャッシュをそのまま返してるだけ
          // どちらも満たす track が出るまで最大 ~3 秒待つ。
          let firstTrack: {
            title: string;
            artist: string;
            trackUri?: string;
            trivia?: string | null;
          } | null = null;
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 400));
            try {
              const np = await spotifyGetNowPlaying();
              if (
                np?.trackName &&
                np.isPlaying &&
                np.trackUri !== prevUri
              ) {
                firstTrack = {
                  title: np.trackName,
                  artist: np.artistNames.join(", "),
                  trackUri: np.trackUri,
                };
                break;
              }
            } catch {
              /* noop — 取得失敗時は first_track=null で return */
            }
          }
          // first_track が確定したら trivia 取得 (= web 検索 + LLM 要約、cache hit ならゼロ待ち)。
          // 失敗しても trivia=null で進める。
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
  },
  // 旧: spotify_play_pause / spotify_next / spotify_prev / spotify_volume は削除済。
  // transport (停止 / 次 / 前 / 音量) は Yui main の direct tool (music_pause / music_next
  // / music_prev / music_volume) で即時 Spotify Web API を叩くので、specialist は経由しない。
  // specialist は新規選曲 (= spotify_search_play、trivia 取得込み) に専念する。
  {
    name: "spotify_now_playing",
    description:
      "今かかっている曲を取得 (= 「この曲なに?」「アーティスト誰?」)。" +
      "何も再生していなければ now_playing=null。",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      try {
        const np = await spotifyGetNowPlaying();
        if (!np) return { now_playing: null };
        // 同時に in-memory now-playing キャッシュも更新 (env block で使われる)
        setNowPlaying({
          title: np.trackName,
          artist: np.artistNames.join(", "),
          album: np.albumName,
          durationMs: np.durationMs,
          id: np.trackUri,
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
  },
  {
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
    handler: async (input) => {
      try {
        const percent = Math.max(0, Math.min(100, Number(input.percent)));
        const deviceId = await pickActiveDeviceId();
        await spotifySetVolume(percent, deviceId ?? undefined);
        return { ok: true, volume_percent: percent };
      } catch (e) {
        const errResp = asSpotifyError(e);
        if (errResp) return errResp;
        throw e;
      }
    },
  },
  {
    name: "spotify_devices",
    description:
      "Spotify Connect で見えているデバイス一覧を返す。" +
      "「どのスピーカーで流れてる?」「PC に切り替えて」等のときに使う。" +
      "transfer_device で active を切り替えられる。",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      try {
        const devices = await getDevices();
        return {
          count: devices.length,
          devices: devices.map(deviceToJson),
        };
      } catch (e) {
        const errResp = asSpotifyError(e);
        if (errResp) return errResp;
        throw e;
      }
    },
  },
  {
    name: "spotify_transfer_device",
    description:
      "再生を別のデバイスに移す。device_id は spotify_devices で取得した id。",
    input_schema: {
      type: "object",
      properties: { device_id: { type: "string" } },
      required: ["device_id"],
      additionalProperties: false,
    },
    handler: async (input) => {
      try {
        await transferPlayback(String(input.device_id));
        return { ok: true, device_id: String(input.device_id) };
      } catch (e) {
        const errResp = asSpotifyError(e);
        if (errResp) return errResp;
        throw e;
      }
    },
  },
];

export const musicSpecialist: Specialist = {
  id: "music",
  yuiToolName: "ask_music_specialist",
  yuiDescription:
    "Spotify の **新規選曲** (= 検索して再生開始 + 楽曲解説 trivia 取得) を担当に依頼する。" +
    "「ジャズかけて」「Mr.Children 流して」「<曲名> 再生」等のように **ジャンル/アーティスト/曲名で再生を依頼する場合** に使う。" +
    "⛔ 「止めて」「次の曲」「前の曲」「音量上げて」「この曲なに?」等の **transport / 状態確認系は** " +
    "Yui main の direct tool (music_pause/next/prev/volume/now_playing) で処理されるので、" +
    "specialist を呼んではならない。" +
    "ジャンル指定が無い「音楽かけて」だけならジャンルを聞き返してから。",
  model: process.env.SPECIALIST_MUSIC_MODEL, // 未設定 → heavy tier に解決 (#206 M3)
  systemPrompt: `あなたは Yui (上司の秘書AI) の「音楽担当」(Spotify 操作係) です。
Spotify Web API を直接叩いて、検索・再生・スキップ・音量制御を行います。
最終的にユーザーと話すのは Yui で、Yui がこの情報に口調を載せて応答します。あなたは口調を作りません。

## 行動ルール 🎯 重要な分岐
1. **ジャンル/アーティスト/曲名で新規依頼** → spotify_search_play を 1 回呼ぶだけで完結 (検索 + 再生開始 + trivia 自動取得が同時)。
   ジャンル系 ("ジャズ", "クラシック", "lofi") なら kind="playlist"、特定曲なら kind="track"。
   ⚠️ **絶対にユーザーに「どれにしますか?」と聞き返さない**。検索結果リストを返すだけで終わるのは禁止。
   間違ったらユーザーが「違う」と言ってくる、それから再 search すればいい。

   **trivia は spotify_search_play が自動で取得して戻り値に含めるので、追加で web_search を呼ぶ必要は無い**。
   - kind=track の戻り値: trivia (string | null)
   - kind=playlist の戻り値: first_track.trivia (string | null)

   ## 🚨🚨 trivia の扱い (絶対厳守)
   - trivia が non-null (= 文字列) なら、**全文を結論にそのまま貼り付ける**。
   - **省略・要約・抜粋・改変・短縮は完全禁止**。仮に trivia が 400 字あっても 400 字全部書く。
   - 「長いから」「冗長だから」「Yui が後で言うから」等の理由で省略するのは禁止。Yui (上位) は
     ここで省略されると trivia 情報を失う。短縮するのは Yui の役割であって specialist の役割ではない。
   - 「結論:」の後に「<playlist 名>」「1 曲目: <title> (<artist>)」を書き、続けて trivia 全文を改行して貼る。
   - trivia が null の場合だけ trivia 部分を省略。

   ⚠️ **kind=playlist の戻り値 first_track が non-null の場合、必ず結論に「1 曲目: <title> (<artist>)」を含めること**。
   first_track が null の時だけ playlist 名のみで OK。

   例 (track, trivia あり):
   「結論: 再生開始 — Bohemian Rhapsody (Queen)。
   trivia: 1975 年 10 月、Queen の 4 枚目スタジオアルバム『A Night at the Opera』に収録、シングルカットもされた。フレディ・マーキュリーの作詞作曲で、オペラ・バラード・ハードロックを 6 分弱の中に詰め込んだ前代未聞の構成。プロデューサーや EMI は当時「長すぎる」と難色を示したが結果的に英 UK チャートで 9 週連続 1 位、後に映画『ボヘミアン・ラプソディ』(2018) のタイトルにもなった代表曲です。」

   例 (playlist, trivia あり) — trivia は短くせず原文をすべて貼る:
   「結論: 再生開始 — <playlist 名>。1 曲目: <title> (<artist>)。
   trivia: <ここに trivia 全文を一字一句そのまま>」

   例 (trivia null):
   「結論: 再生開始 — <playlist 名>。1 曲目: <title> (<artist>)。」
2. **「もう一度」「もう一回」「さっきの曲」「同じの」「リピート」「最初から」** →
   spotify_now_playing で今かかってる曲 (= 既にスキップ前の曲) を確認。
   それでも「直前」が取れない場合は spotify_prev で前の曲に戻る。
3. **「次の曲」(skip_next)** → spotify_next。実行後は spotify_now_playing で新しい曲名を取得 → 結論に含める。
4. **「前の曲」(skip_prev)** → spotify_prev。
5. ⛔ **「止めて」「次の曲」「前の曲」「音量」 系は specialist の役目では無くなった**。
   これらは Yui main 側の direct tool (music_pause / music_next / music_prev / music_volume) で
   既に処理される。万一 ask_music_specialist 経由で来てしまった場合は、tool を呼ばずに
   「結論: transport 操作は Yui 側で直接処理されました。specialist 経由は不要です。」とだけ返す。
6. **「この曲なに?」「アーティスト誰?」「タイトルは?」** → spotify_now_playing → 「結論: <title> / <artist> / <album>」。play しない。
6b. **タイアップ情報 (どのアニメ / ドラマ / 映画 / ゲームの曲か) を聞かれた場合**:
    1) まず spotify_now_playing で title/artist を確定
    2) **web_search で確認** (例: query="<title> <artist> タイアップ" や "<title> <artist> アニメ")
    3) 検索結果の snippet を踏まえて答える。
    内部知識だけで「○○のEDだと思います」は禁止 (古い・間違いを返す危険)。
    検索しても出てこなければ「結論: タイアップ情報は検索でも特定できませんでした。曲名: <title> / <artist>。」
7. **「どこで流れてる?」「PC で再生して」** → spotify_devices で一覧取得 → 必要なら spotify_transfer_device。
8. 1 ターンで判断 → 必要な tool を呼ぶ → 結論まで完結 (連続 tool 呼びはできるだけ最小限)。

## 🚨 エラー時の挙動
- tool が { error: "..." } を返したら、その文言をそのまま結論に乗せる。
  例: 「結論: Spotify と未連携です。設定 > Spotify から連携してください。」
- Premium 必須エラーが出たら: 「結論: この操作には Spotify Premium が必要です。Free アカウントでは再生制御ができません。」
- "再生可能なデバイスが見つかりません" が出たら: そのまま結論に含める (Spotify アプリを開く必要があると伝える)。

## 🚨 出力に関する厳守ルール
- 最終応答 (tool_use を伴わない turn) は必ず **「結論:」で始める**。
- **「〜します」「〜検索します」だけで応答終了禁止**。preamble は答えではない。
- play した直後は「結論: 再生開始 — <name> (<artist>)」もしくは「結論: 再生開始 — <playlist 名>」。
- 該当無し: 「結論: 該当 0件 — <検索キーワード>」。

## 出力形式
- 散文や敬語にしない。**ファクト列挙**。最大 5 行以内。
- 例:
  「結論: 再生開始 — ジャズ ベスト100 (My Library)」
  「結論: 再生開始 — Bohemian Rhapsody (Queen)」
  「結論: 次の曲へスキップ — Sky Walker (BUMP OF CHICKEN)」

Yui があなたの返事を受けて口語に展開するので、丁寧語/感想/結衣口調は一切いらない。`,
  // music ネイティブ tools + 共有 web tools (タイアップ確認等で使う)
  tools: [...tools, ...webSpecialistTools],
  maxIterations: 6,
  maxTokens: 1200,
};
