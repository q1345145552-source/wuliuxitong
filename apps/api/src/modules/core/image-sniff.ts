/**
 * 看 base64 图片的文件头认出是什么图（2026-10-23 安全审查 S3，签收照片用）。
 *
 * 只认 jpg / png / gif / webp 四种，文件头按浏览器认图的标准（WHATWG MIME Sniffing）比完整的那几个字节（JPEG、WebP 两处比标准再严一点）：
 *   · PNG 8 个字节、GIF 6 个（GIF87a / GIF89a）
 *   · JPEG：FF D8 FF 之后第 4 个字节得是 JPEG 的段标记（C0～FF），FF D8 FF 00 这种不算（dsh 第 3 轮）
 *   · WebP：RIFF + 4 字节 + WEBP 之后，首块必须正好是 VP8␠ / VP8L / VP8X（真 WebP 只有这三种；dsh 第 3 轮：原来只比到 VP，VP9 也混过去）
 * Codex 10-23 复核：原来 PNG 只比 4 个、GIF 只比 GIF8，开头凑对几个字节的乱码就能混过去。
 * 线上 2087 张签收照片按这套全部认得出：jpg 1689（第 4 字节 E1 1331、E0 332、DB 26）、png 395、webp 3（都是 VP8X）（10-23 只读核过）。
 * 只看文件头、不解码整张图 —— 挡的是传错东西、传乱码，不是存心伪造的图片文件。
 * cs-chat/routes.ts 的 looksLikeImage 是另一套（按声明的类型核），这次没动。
 */
export type SniffedImage = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** 标准 base64（不是 base64url）；不含空白 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_FIRST_CHUNKS = new Set(["VP8 ", "VP8L", "VP8X"]);

/** 认得出就返回类型，认不出（不是 base64、太短、文件头不对）返回 null */
export function sniffImageBase64(base64: string): SniffedImage | null {
  if (base64.length < 16 || base64.length % 4 !== 0 || !BASE64_RE.test(base64)) return null;
  const head = Buffer.from(base64.slice(0, 24), "base64");
  const ascii = (from: number, to: number) => head.subarray(from, to).toString("latin1");
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff && head[3] >= 0xc0) return "image/jpeg";
  if (head.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" && WEBP_FIRST_CHUNKS.has(ascii(12, 16))) return "image/webp";
  return null;
}
