import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const IMAGES_DIR = process.env.IMAGES_DIR || "/app/images";
const IMAGES_URL_PREFIX = "/images";

/** Initialize the images directory (call once on startup). */
export function ensureImagesDir(): void {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
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
  const filePath = path.join(IMAGES_DIR, name);
  const buffer = Buffer.from(contentBase64, "base64");
  fs.writeFileSync(filePath, buffer);
  return `${IMAGES_URL_PREFIX}/${name}`;
}

/** Read an image file back as base64. Returns null if the file doesn't exist. */
export function readImageAsBase64(filePath: string): string | null {
  const fullPath = path.join(IMAGES_DIR, path.basename(filePath));
  if (!fs.existsSync(fullPath)) return null;
  const buffer = fs.readFileSync(fullPath);
  return buffer.toString("base64");
}

/** Delete an image file from disk. */
export function deleteImageFile(filePath: string): void {
  const fullPath = path.join(IMAGES_DIR, path.basename(filePath));
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
