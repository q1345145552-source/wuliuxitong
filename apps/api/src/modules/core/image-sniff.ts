/**
 * 看 base64 图片的文件头认出是什么图（2026-10-23 安全审查 S3，签收照片用）。
 *
 * 只认 jpg / png / gif / webp 四种：线上 2087 张签收照片全是 jpg / png / webp（10-23 只读核过），
 * 浏览器也都能直接显示。跟 cs-chat/routes.ts 的 looksLikeImage 同一套文件头，那边按声明的类型核、这里直接认。
 */
export type SniffedImage = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** 标准 base64（不是 base64url）；不含空白 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 认得出就返回类型，认不出（不是 base64、太短、文件头不对）返回 null */
export function sniffImageBase64(base64: string): SniffedImage | null {
  if (base64.length < 16 || base64.length % 4 !== 0 || !BASE64_RE.test(base64)) return null;
  const head = Buffer.from(base64.slice(0, 24), "base64");
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
