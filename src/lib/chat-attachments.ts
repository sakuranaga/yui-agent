/**
 * チャット添付ファイル (画像) の永続化 + 期限切れクリーンアップ。
 * - 実体: data/chat-images/<sessionId>/<uuid>.<ext>
 * - DB: raw_messages.attachments に [{filename, mediaType}, ...] を保存
 * - リロード復元: GET /api/chat/image?session=<sid>&file=<filename> で配信
 * - クリーンアップ: tickMaintenance (5 分毎) から呼ばれ、created_at が
 *   7 日より古い行の添付ファイルを物理削除 + attachments を [] に。
 *   raw_messages 行自体は memory 抽出のため残す。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rawMessages } from "@/db/schema";

const ROOT = path.resolve(process.cwd(), "data", "chat-images");
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 週間で添付を消す

const EXT_BY_MEDIA: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};

export type SavedAttachment = {
  filename: string;
  mediaType: string;
};

function safeFilename(name: string): boolean {
  // session 内 dir trim 用。../ 等の path traversal 拒否。英数字 + ハイフン + アンダースコア + . のみ。
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}

function safeSessionId(sid: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(sid);
}

export function attachmentDir(sessionId: string): string {
  return path.join(ROOT, sessionId);
}

export function attachmentPath(sessionId: string, filename: string): string {
  return path.join(ROOT, sessionId, filename);
}

/**
 * base64 画像をディスクに保存。SavedAttachment を返す。
 */
export async function saveImage(opts: {
  sessionId: string;
  mediaType: string;
  base64Data: string;
}): Promise<SavedAttachment> {
  const { sessionId, mediaType, base64Data } = opts;
  if (!safeSessionId(sessionId)) throw new Error("invalid sessionId");
  const ext = EXT_BY_MEDIA[mediaType];
  if (!ext) throw new Error(`unsupported media type: ${mediaType}`);
  const filename = `${randomUUID()}.${ext}`;
  const dir = attachmentDir(sessionId);
  await fs.mkdir(dir, { recursive: true });
  const buf = Buffer.from(base64Data, "base64");
  await fs.writeFile(path.join(dir, filename), buf);
  return { filename, mediaType };
}

export async function readImage(opts: {
  sessionId: string;
  filename: string;
}): Promise<{ data: Buffer; mediaType: string } | null> {
  const { sessionId, filename } = opts;
  if (!safeSessionId(sessionId)) return null;
  if (!safeFilename(filename)) return null;
  const ext = filename.split(".").pop() ?? "";
  const mediaType =
    Object.entries(EXT_BY_MEDIA).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
  try {
    const data = await fs.readFile(attachmentPath(sessionId, filename));
    return { data, mediaType };
  } catch {
    return null;
  }
}

/**
 * created_at が TTL_MS より古い添付を全セッションまたいで一括削除。
 * tickMaintenance から定期的に呼ばれる想定 (5 分毎)。
 * 行自体は memory 抽出のため残し、attachments 配列を [] に空にして DB を更新する。
 */
export async function pruneExpiredAttachments(): Promise<{
  prunedRows: number;
  deletedFiles: number;
}> {
  const cutoff = new Date(Date.now() - TTL_MS);
  const stale = await db
    .select({
      id: rawMessages.id,
      sessionId: rawMessages.sessionId,
      attachments: rawMessages.attachments,
    })
    .from(rawMessages)
    .where(
      and(
        lt(rawMessages.createdAt, cutoff),
        sql`jsonb_array_length(${rawMessages.attachments}) > 0`
      )
    );

  if (stale.length === 0) return { prunedRows: 0, deletedFiles: 0 };

  let deleted = 0;
  for (const row of stale) {
    for (const a of row.attachments) {
      try {
        await fs.unlink(attachmentPath(row.sessionId, a.filename));
        deleted++;
      } catch {
        // ファイル消失済み等は無視
      }
    }
    await db
      .update(rawMessages)
      .set({ attachments: [] })
      .where(eq(rawMessages.id, row.id));
  }
  return { prunedRows: stale.length, deletedFiles: deleted };
}
