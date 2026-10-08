/**
 * 到货通知照片的小图（2026-10-08 审查 G03）。
 *
 * 列表一页 30 条、每条最多 20 张，原来卡片上 96×96 的小方块直接加载上传图（长边 1600、几百 KB 一张）。
 * 服务器上没有图片处理库，所以在浏览器里用 canvas 另画一张长边 360 的 JPEG，跟原图一起传（后端存成 thumb_path）。
 * 卡片和修改弹窗的小方块用小图；点开大图、复制、保存仍然用原图。
 *
 * 任何一步出错（老安卓 WebView 画不了、解码失败、画出来还太大）都返回 null：照片照样传，列表退回用原图，不挡上传。
 */
import type { UploadImage } from "../shared/image-compress";

/** 小图长边 */
const THUMB_EDGE = 360;
const THUMB_QUALITY = 0.75;
/** 跟后端 THUMB_MAX_BASE64 同一个数：超过就不带小图（后端会 400） */
export const THUMB_MAX_BASE64 = 200_000;

export type NoticeThumb = { mime: "image/jpeg"; base64: string };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("小图解码失败"));
    el.src = src;
  });
}

/** 从**压缩后**那份（要上传的那份）画小图；画不了返回 null */
export async function makeThumb(img: UploadImage): Promise<NoticeThumb | null> {
  try {
    if (typeof document === "undefined" || !img.base64 || !img.mime.startsWith("image/")) return null;
    const el = await loadImage(`data:${img.mime};base64,${img.base64}`);
    const width = el.naturalWidth;
    const height = el.naturalHeight;
    if (!width || !height) return null;
    const scale = Math.min(1, THUMB_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // JPEG 没有透明：透明 PNG 不先铺底会变黑底。
    // ⚠️ 必须写死颜色，不能用 var(--white)：fillStyle 是 canvas 的 JS 接口不是 CSS，var() 认不出就退回黑色（教训 23）
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(el, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", THUMB_QUALITY);
    const prefix = "data:image/jpeg;base64,";
    if (!dataUrl.startsWith(prefix)) return null; // 有的浏览器不认 jpeg 会退成 png，那就不带小图
    const base64 = dataUrl.slice(prefix.length);
    if (!base64 || base64.length > THUMB_MAX_BASE64) return null;
    return { mime: "image/jpeg", base64 };
  } catch {
    return null;
  }
}
