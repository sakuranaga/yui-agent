/**
 * GET  /api/sleep/bgm — enabled な BGM 一覧 (id, title, url, duration_sec, is_uploaded)
 * POST /api/sleep/bgm (multipart/form-data)
 *     file: MP3 必須
 *     title: 表示名 (省略時はファイル名から拡張子抜き)
 *
 * 配信 URL の振り分け:
 *   is_uploaded=false → /sleep-bgm/{filename} (= 静的、public 配下のレガシー preset)
 *   is_uploaded=true  → /api/sleep/bgm/{id}/file (= stream、data 配下の user upload)
 *
 * 設計: docs/sleep-support.md / docs/oss-prep.md
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { sleepBgm } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { saveUploadedBgmFile, deleteUploadedBgmFile } from "@/lib/sleep-bgm-storage";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const MAX_BGM_BYTES = 30 * 1024 * 1024; // 30MB (= 約 20 分の mp3 192kbps)

/**
 * MP3 magic byte 確認:
 *   - ID3v2 tag 付き: "ID3" (0x49 0x44 0x33) で始まる
 *   - tag 無し直 frame: 0xFF + (0xE0-0xFF) (= 11 bit frame sync)
 *     MPEG-1 Layer 3 で典型的なのは 0xFFFB / 0xFFFA / 0xFFF3 / 0xFFF2
 *
 * 拡張子だけ .mp3 の任意バイナリを弾く。
 */
function isLikelyMp3(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  // ID3v2
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  // frame sync: byte 0 = 0xFF、byte 1 の上位 3 bit (= 0xE0 mask) が 0xE0
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  return false;
}

export async function GET() {
  const rows = await db
    .select()
    .from(sleepBgm)
    .where(eq(sleepBgm.enabled, true))
    .orderBy(asc(sleepBgm.id));
  return NextResponse.json({
    bgm: rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      // 後方互換: filename も返す (= SleepOverlay 等の旧 client 用)
      filename: r.filename,
      url: r.isUploaded ? `/api/sleep/bgm/${r.id}/file` : `/sleep-bgm/${r.filename}`,
      duration_sec: r.durationSec,
      is_uploaded: r.isUploaded,
      credit: r.credit,
    })),
  });
}

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) {
    return NextResponse.json({ error: "multipart/form-data required" }, { status: 400 });
  }
  const form = await req.formData();
  const file = form.get("file");
  const titleRaw = (form.get("title") as string | null)?.trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "empty file" }, { status: 400 });
  }
  if (file.size > MAX_BGM_BYTES) {
    return NextResponse.json(
      { error: `bgm too large (${file.size} > ${MAX_BGM_BYTES})` },
      { status: 413 }
    );
  }

  // 1) magic byte 検証 (= DB row 作成より前にやる、検証失敗で orphan row 残さない)
  const buf = Buffer.from(await file.arrayBuffer());
  if (!isLikelyMp3(buf)) {
    return NextResponse.json(
      { error: "invalid MP3 file (ID3v2 tag or MPEG frame sync が見つかりません)" },
      { status: 400 }
    );
  }

  // 2) row 作成 → id 取得 → ファイル書き出し。失敗時は両方 cleanup。
  const displayTitle =
    titleRaw && titleRaw.length > 0
      ? titleRaw
      : file.name.replace(/\.[^.]+$/, "") || "Untitled BGM";

  const [inserted] = await db
    .insert(sleepBgm)
    .values({
      title: displayTitle,
      filename: "__pending__",
      durationSec: null,
      enabled: true,
      isUploaded: true,
    })
    .returning({ id: sleepBgm.id });

  const id = Number(inserted.id);

  try {
    const { filename } = await saveUploadedBgmFile(id, buf);
    await db.update(sleepBgm).set({ filename }).where(eq(sleepBgm.id, id));
    return NextResponse.json({
      bgm: {
        id,
        title: displayTitle,
        filename,
        url: `/api/sleep/bgm/${id}/file`,
        duration_sec: null,
        is_uploaded: true,
      },
    });
  } catch (e) {
    try {
      await deleteUploadedBgmFile(id);
    } catch (cleanupErr) {
      console.warn(`[sleep/bgm POST] cleanup file failed id=${id}:`, cleanupErr);
    }
    try {
      await db.delete(sleepBgm).where(eq(sleepBgm.id, id));
    } catch (cleanupErr) {
      console.warn(`[sleep/bgm POST] cleanup row failed id=${id}:`, cleanupErr);
    }
    return clientError(req, e, {
      status: 500,
      message: "BGM のアップロードに失敗しました",
      context: "sleep/bgm POST",
    });
  }
}
