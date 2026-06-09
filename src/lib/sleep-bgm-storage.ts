/**
 * Sleep BGM (= user upload) のファイル I/O 層。`data/sleep-bgm/` 配下に保存。
 * `data/` は .gitignore 配下なのでコミットされない。
 *
 * - ファイル名: <id>.mp3 (= DB row の id をそのまま使う)
 * - 配信は API stream (= /api/sleep/bgm/{id}/file) 経由
 *
 * legacy preset (= public/sleep-bgm/*.mp3) はここでは扱わない。
 * 配信時に DB の is_uploaded で振り分ける。
 */
import { mkdir, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";

const STORAGE_DIR = join(process.cwd(), "data", "sleep-bgm");

export function uploadedBgmFilenameFor(id: number): string {
  return `${id}.mp3`;
}

export function uploadedBgmAbsPath(filename: string): string {
  return join(STORAGE_DIR, filename);
}

async function ensureDir(): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true });
}

export async function saveUploadedBgmFile(
  id: number,
  buf: Buffer
): Promise<{ filename: string; size: number }> {
  await ensureDir();
  const filename = uploadedBgmFilenameFor(id);
  await writeFile(uploadedBgmAbsPath(filename), buf);
  const s = await stat(uploadedBgmAbsPath(filename));
  return { filename, size: s.size };
}

export async function deleteUploadedBgmFile(id: number): Promise<void> {
  const filename = uploadedBgmFilenameFor(id);
  try {
    await unlink(uploadedBgmAbsPath(filename));
  } catch (e) {
    console.warn(`[sleep-bgm-storage] delete failed ${filename}:`, e);
  }
}
