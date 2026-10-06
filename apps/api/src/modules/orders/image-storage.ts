import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

function getImagesDir(): string {
  return process.env.IMAGES_DIR || "./data/images";
}
const IMAGES_URL_PREFIX = "/images";

/** Initialize the images directory (call once on startup). */
export function ensureImagesDir(): void {
  const dir = getImagesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Save a base64 image to disk. Returns the public URL path.
 * The file is named `<orderId>_<cuid>.ext` to avoid collisions.
 */
export function saveImageToDisk(orderId: string, mime: string, contentBase64: string): string {
  // Defense-in-depth: sanitize orderId to prevent path traversal
  const safeId = orderId.replace(/[^a-zA-Z0-9_-]/g, "_");
  ensureImagesDir();
  const ext = mimeToExt(mime);
  const name = `${safeId}_${crypto.randomBytes(6).toString("hex")}${ext}`;
  const filePath = path.join(getImagesDir(), name);
  const buffer = Buffer.from(contentBase64, "base64");
  fs.writeFileSync(filePath, buffer);
  return `${IMAGES_URL_PREFIX}/${name}`;
}

/** Read an image file back as base64. Returns null if the file doesn't exist. */
export function readImageAsBase64(filePath: string): string | null {
  const fullPath = path.join(getImagesDir(), path.basename(filePath));
  if (!fs.existsSync(fullPath)) return null;
  const buffer = fs.readFileSync(fullPath);
  return buffer.toString("base64");
}

/**
 * 这张图的文件在不在、是不是空的（只看大小，不把整张图读进内存）。
 * 2026-10-06 到货通知转正式时核「运单上那份还在不在」用：0 字节的坏文件算不在（跟读图时 `!b64` 一个口径）。
 */
export function imageFileUsable(filePath: string): boolean {
  const fullPath = path.join(getImagesDir(), path.basename(filePath));
  try {
    const st = fs.statSync(fullPath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** Delete an image file from disk. */
export function deleteImageFile(filePath: string): void {
  const fullPath = path.join(getImagesDir(), path.basename(filePath));
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
  };
  return map[mime] ?? ".jpg";
}
