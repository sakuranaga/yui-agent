/**
 * ブラウザ側で画像を WebP にリサイズする。
 * - 長辺 LONG_EDGE_MAX に縮小 (元が小さければそのまま)
 * - quality 0.85 で WebP encode
 * - 返り値は base64 (data URL prefix 無し) と media type
 *
 * Sonnet vision は jpeg/png/gif/webp 受付。WebP が一番軽い。
 */
const LONG_EDGE_MAX = 1568;
const QUALITY = 0.85;

export type ResizedImage = {
  mediaType: "image/webp";
  data: string;     // base64 (no data URL prefix)
  dataUrl: string;  // for <img src=...> preview
  width: number;
  height: number;
  bytes: number;
};

export async function resizeImageToWebp(file: File): Promise<ResizedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("画像ファイルではありません");
  }
  const bitmap = await createImageBitmap(file);
  const { width: w0, height: h0 } = bitmap;
  const longEdge = Math.max(w0, h0);
  const scale = longEdge > LONG_EDGE_MAX ? LONG_EDGE_MAX / longEdge : 1;
  const width = Math.round(w0 * scale);
  const height = Math.round(h0 * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context が取れません");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", QUALITY);
  });
  if (!blob) throw new Error("WebP encode に失敗しました");

  const buf = await blob.arrayBuffer();
  const data = arrayBufferToBase64(buf);
  const dataUrl = `data:image/webp;base64,${data}`;
  return {
    mediaType: "image/webp",
    data,
    dataUrl,
    width,
    height,
    bytes: blob.size,
  };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
