/**
 * ご主人様が送ってきた画像を Haiku で 1-2 文に要約し、memory_chunks に保存。
 * - chat hot path 終了後に fire-and-forget で呼ぶ
 * - 画像 bytes は保存しない (要約テキストのみ embed して残す)
 * - 後のターンで「さっき見せた写真の〜」と聞かれた時、memory retrieval が拾えるように
 */
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db/client";
import { memoryChunks } from "@/db/schema";
import { embed } from "@/lib/embed";
import { callLlm, withTrace } from "@/lib/llm";

type ClientImage = {
  mediaType: "image/webp" | "image/png" | "image/jpeg" | "image/gif";
  data: string;
};

export async function summarizeUserImageBg(opts: {
  sessionId: string;
  images: ClientImage[];
  userText: string;
  assistantReply: string;
}): Promise<void> {
  const { sessionId, images, userText, assistantReply } = opts;
  if (images.length === 0) return;

  await withTrace(`image_summary:${sessionId.slice(0, 8)}`, async () => {
    const n = images.length;
    const system =
      "あなたは画像をログに残すためのアシスタントです。" +
      `ご主人様が結衣に送った画像 ${n} 枚を、後から思い出して検索できるように` +
      "全体で 1〜3 文の日本語で短く客観的に説明してください。" +
      "「写真」「画像」などの語は省き、何が写っているか・色や雰囲気・読み取れる文字があれば含めてください。" +
      "複数枚あれば全体の主題をまとめ、特筆すべき差分があれば触れてください。" +
      "余計な前置きや感想は不要です。";

    const imageBlocks: Anthropic.ImageBlockParam[] = images.map((img) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType,
        data: img.data,
      },
    }));
    const textBlock: Anthropic.TextBlockParam = {
      type: "text",
      text:
        `ご主人様のメッセージ: ${userText || "(本文なし)"}\n` +
        `結衣の返答: ${assistantReply.slice(0, 240)}\n\n` +
        `この${n > 1 ? `${n}枚の画像をまとめて` : "画像を"} 1〜3 文で説明してください。`,
    };

    const res = await callLlm("extract", {
      maxTokens: 300,
      system,
      messages: [
        {
          role: "user",
          content: [...imageBlocks, textBlock],
        },
      ],
    });
    const summary = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!summary) return;

    // chunk_type は "event" (ご主人様の行為記録)。importance はやや高め (0.6)。
    const [vec] = await embed([summary]);
    await db.insert(memoryChunks).values({
      sessionId,
      chunkType: "event",
      content: `[画像] ${summary}`,
      embedding: vec,
      importance: 0.6,
      actorType: "system",
      actorId: "image_summary",
      sourceSystem: "user_image",
      metadata: {
        userText,
        imageCount: n,
        mediaTypes: images.map((i) => i.mediaType),
      },
    });
  }).catch((e) => {
    console.warn("[image_summary] failed:", e);
  });
}
