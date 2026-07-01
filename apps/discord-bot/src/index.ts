/**
 * Yui Discord bot (Phase F-1)。
 *
 * - DM 専用、OWNER_ID 以外は無視
 * - メッセージ受信 → /api/chat に転送 → 応答を Discord に返す
 * - 添付画像も /api/chat の images フィールドに base64 で渡す
 * - 直近の Discord 履歴 (/api/chat/history) を毎ターン同梱して会話の連続性を保つ
 *
 * Yui の全 tool (calendar / contacts / todos / web search / 日記 ...) は
 * /api/chat 側で動くため、bot は配管役のみ。
 */
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type DMChannel,
  type Message,
  Events,
} from "discord.js";
import { chunkForDiscord } from "./chunk.js";
import { runSseLoop, type SseEvent } from "./sse.js";

const TOKEN = required("DISCORD_BOT_TOKEN");
const OWNER_ID = required("DISCORD_OWNER_ID");
const SESSION_ID = required("DISCORD_SESSION_ID");
const YUI_API_URL = process.env.YUI_API_URL ?? "http://web:3000";
const HISTORY_TURNS = 20; // 直近何件を /api/chat に同梱するか
// web 側 middleware 認証ゲートを通過するための共有トークン (= AUTH_TOKEN と同値)。
// docker-compose で web container と同じ env を共有する。
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "";

/** 共通: 認証ヘッダ付き fetch */
function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (AUTH_TOKEN) headers.set("X-Internal-Auth", AUTH_TOKEN);
  return fetch(url, { ...init, headers });
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[bot] env ${key} is required`);
    process.exit(1);
  }
  return v;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  // DM チャンネルはキャッシュされないので Partials が必要
  partials: [Partials.Channel, Partials.Message],
});

// owner との DM チャンネルキャッシュ。Yui からの自発発話 (timer 発火 / specialist
// 追い応答 / periodic check) を ここに send する。
let ownerDM: DMChannel | null = null;

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] logged in as ${c.user.tag} (id=${c.user.id})`);
  console.log(`[bot] owner=${OWNER_ID} session=${SESSION_ID.slice(0, 8)}…`);

  // owner DM を先に開いておく (SSE 経由の push 受信時に即送れる)
  try {
    const user = await c.users.fetch(OWNER_ID);
    ownerDM = await user.createDM();
    console.log(`[bot] DM channel ready for ${user.tag}`);
  } catch (e) {
    console.warn("[bot] owner DM open failed:", e);
  }

  // SSE 購読開始 (再接続ループ。プロセス終了まで回る)
  startSseSubscription();
});

function startSseSubscription(): void {
  const clientId = `discord:${SESSION_ID}`;
  const url =
    `${YUI_API_URL}/api/chat/stream?session=${encodeURIComponent(SESSION_ID)}` +
    `&client=${encodeURIComponent(clientId)}`;
  console.log(`[bot] subscribing SSE: ${url}`);
  void runSseLoop({
    url,
    headers: AUTH_TOKEN ? { "X-Internal-Auth": AUTH_TOKEN } : undefined,
    onEvent: handleSseEvent,
    onError: (e) => console.warn("[bot] sse error:", e),
  });
}

async function handleSseEvent(e: SseEvent): Promise<void> {
  if (!ownerDM) return;
  const d = e.data as Record<string, unknown> & { type?: string };
  const type = d.type ?? e.name;
  try {
    if (type === "yui_message") {
      // specialist 追い応答 / periodic check 発話 / 曲変化通知 等。
      // 曲変化通知は不要なので specialistId === undefined かつ text が
      // 「再生中: ...」で始まるものは抑制… ではなく、今回は specialistId 等を
      // 見ずに「ユーザが要らないと指定した曲変化」だけスキップ。
      // 曲変化は report_update が "再生中: ..." で来るが yui_message は素の発話。
      // ここでは全 yui_message を通す (music 関連も Yui の話す内容として価値あり)。
      const text = typeof d.text === "string" ? d.text.trim() : "";
      if (!text) return;
      await sendChunked(text);
    } else if (type === "timer_fired") {
      // hasAction=true なら別途 yui_message が流れてくるのでここではスキップ
      if (d.hasAction === true) return;
      const label = typeof d.label === "string" ? d.label : null;
      const kind = d.kind === "reminder" ? "リマインダー" : "タイマー";
      const labelPart = label ? `「${label}」の` : "";
      await sendChunked(`${labelPart}${kind}の時間ですよ、ご主人様。`);
    } else if (type === "notification") {
      // 通知 (お便り)。サーバ側で forwardToDiscord フラグが立っているものだけ転送。
      // 内容は speakText (= Web チャットで Yui が読む全文) のみ。
      // 「📬 title\npreview」形式のドライ表記は Discord には送らない:
      // キャラ感の薄いプリアンブルは雑音にしかならないので、speakText が無い種類
      // (= ご主人様向けに整形されたセリフが用意されていない) は完全沈黙する。
      if (d.forwardToDiscord !== true) return;
      const speakText = typeof d.speakText === "string" ? d.speakText.trim() : "";
      if (!speakText) return;
      await sendChunked(`📬 ${speakText}`);
    }
    // 以下は Discord 用途では無関係なので無視:
    //   report_update (ノートパネル更新 = Discord に表示先なし)
    //   music_command (browser MusicKit 専用)
    //   job_status / timer_created / timer_cancelled (UI 更新シグナル)
    //   ready (初回開通の合図)
  } catch (err) {
    console.warn("[bot] sse handler error:", err);
  }
}

async function sendChunked(text: string): Promise<void> {
  if (!ownerDM) return;
  for (const chunk of chunkForDiscord(text)) {
    await ownerDM.send(chunk);
  }
}

client.on(Events.MessageCreate, async (msg) => {
  // フィルタ: 自分のメッセージ / bot 同士 / 他人 / DM 以外を弾く
  if (msg.author.bot) return;
  if (msg.author.id !== OWNER_ID) return;
  if (msg.channel.type !== ChannelType.DM) return;
  if (!msg.content && msg.attachments.size === 0) return;

  await handleMessage(msg).catch((e) => {
    console.error("[bot] handler error:", e);
    msg.channel.send("申し訳ございません、少し不調のようです。").catch(() => {});
  });
});

async function handleMessage(msg: Message): Promise<void> {
  // typing インジケーター: Discord は 10 秒で切れるので 8 秒毎に再 fire
  await safeSendTyping(msg);
  const typingTimer = setInterval(() => void safeSendTyping(msg), 8_000);

  try {
    // 画像添付を base64 化 (image/* のみ)。
    // mediaType は Discord の contentType を信用せず実バイトの magic bytes から判定
    // (Discord CDN は webp 変換ヘッダを返しつつ原本 PNG を配信する等あって不一致が起きる)
    const imageAttachments = msg.attachments.filter((a) =>
      (a.contentType ?? "").startsWith("image/")
    );
    const images = (
      await Promise.all(
        imageAttachments.map(async (a) => {
          const res = await fetch(a.url);
          if (!res.ok) throw new Error(`image fetch ${res.status}: ${a.url}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const sniffed = sniffImageMediaType(buf);
          if (!sniffed) {
            console.warn("[bot] unknown image format, skipping:", a.url);
            return null;
          }
          return { mediaType: sniffed, data: buf.toString("base64") };
        })
      )
    ).filter((x): x is { mediaType: ImageMediaType; data: string } => x !== null);

    // 直近の Discord 履歴を取得 (この session のみ)
    const history = await fetchHistory(SESSION_ID, HISTORY_TURNS);
    const userText = msg.content || "(画像のみ)";
    const messages = [
      ...history,
      {
        role: "user" as const,
        content: userText,
        ...(images.length > 0 ? { images } : {}),
      },
    ];

    const res = await authFetch(`${YUI_API_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        sessionId: SESSION_ID,
        source: "discord_text",
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`api ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const data = (await res.json()) as { reply?: string };
    const reply = (data.reply ?? "").trim() || "かしこまりました。";

    // Discord は 1 メッセージ 2000 字制限 → split して順次送信。
    // 1:1 DM なので reply (返信参照) は使わず、普通の send で十分。
    const chunks = chunkForDiscord(reply);
    if (!msg.channel.isSendable()) return;
    for (const chunk of chunks) {
      await msg.channel.send(chunk);
    }
  } finally {
    clearInterval(typingTimer);
  }
}

type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
  toolSummary?: Array<{ name: string; brief: string }>;
};

async function fetchHistory(sessionId: string, limit: number): Promise<HistoryMessage[]> {
  try {
    const url = `${YUI_API_URL}/api/chat/history?session=${encodeURIComponent(
      sessionId
    )}&limit=${limit}`;
    const res = await authFetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      messages?: Array<{
        role: "user" | "assistant";
        content: string;
        toolSummary?: Array<{ name: string; brief: string }>;
      }>;
    };
    return (data.messages ?? []).map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolSummary && m.toolSummary.length > 0
        ? { toolSummary: m.toolSummary }
        : {}),
    }));
  } catch (e) {
    console.warn("[bot] history fetch failed:", e);
    return [];
  }
}

/**
 * 画像バイト列の magic bytes から media type を判定。
 * Anthropic は media_type と実バイトの不一致を 400 で弾くので、
 * Discord の attachment.contentType を信用せずここで決定する。
 */
type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function sniffImageMediaType(buf: Buffer): ImageMediaType | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "image/png";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // GIF: "GIF87a" or "GIF89a"
  if (buf.slice(0, 6).toString("ascii") === "GIF87a" || buf.slice(0, 6).toString("ascii") === "GIF89a")
    return "image/gif";
  // WebP: "RIFF" ... "WEBP" at offset 8
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  return null;
}

async function safeSendTyping(msg: Message): Promise<void> {
  try {
    if (msg.channel.isSendable() && msg.channel.isDMBased()) {
      await msg.channel.sendTyping();
    }
  } catch {
    // typing 失敗は致命ではない
  }
}

function shutdown(sig: string) {
  console.log(`[bot] received ${sig}, shutting down`);
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

void client.login(TOKEN);
