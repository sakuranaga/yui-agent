/**
 * VRM ファイル / サムネの disk I/O 層。/data/vrm-models/ 配下に保存。
 * /data は .gitignore 配下なのでコミットされない。
 *
 * - VRM 本体: <id>.vrm (例: 12.vrm)
 * - サムネ:   <id>.thumb.png
 *
 * 設計: docs/vrm-wardrobe.md (Phase 1)
 */
import { mkdir, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";

const STORAGE_DIR = join(process.cwd(), "data", "vrm-models");

export function vrmFilenameFor(id: number): string {
  return `${id}.vrm`;
}
export function thumbFilenameFor(id: number): string {
  return `${id}.thumb.png`;
}

export function vrmAbsPath(filename: string): string {
  return join(STORAGE_DIR, filename);
}

async function ensureDir(): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true });
}

export async function saveVrmFile(id: number, buf: Buffer): Promise<{ filename: string; size: number }> {
  await ensureDir();
  const filename = vrmFilenameFor(id);
  await writeFile(vrmAbsPath(filename), buf);
  const s = await stat(vrmAbsPath(filename));
  return { filename, size: s.size };
}

export async function saveThumbFile(id: number, buf: Buffer): Promise<string> {
  await ensureDir();
  const filename = thumbFilenameFor(id);
  await writeFile(vrmAbsPath(filename), buf);
  return filename;
}

export async function deleteVrmFiles(filename: string, thumbFilename: string | null): Promise<void> {
  try {
    await unlink(vrmAbsPath(filename));
  } catch (e) {
    console.warn(`[vrm-storage] delete vrm failed ${filename}:`, e);
  }
  if (thumbFilename) {
    try {
      await unlink(vrmAbsPath(thumbFilename));
    } catch (e) {
      console.warn(`[vrm-storage] delete thumb failed ${thumbFilename}:`, e);
    }
  }
}
