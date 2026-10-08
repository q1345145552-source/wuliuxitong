/**
 * 到货通知登记 / 修改弹窗「保存」后逐张传照片（2026-10-08 审查 F05 / F14 拆出来的纯逻辑，不碰页面，测试能直接跑）。
 *
 * - F05：弹窗关了（或正在关）就别再往下传、也别再回调父页面 —— 原来循环里不看，关掉以后照片照样一张张传完，
 *   传完还会把刚打开的下一个登记弹窗直接关掉。isCancelled 每张开始前核一次；upload 自己在压缩完、发请求前再核一次。
 * - F14：一条最多 MAX_NOTICE_IMAGES 张（跟后端 arrival-notices/routes.ts 同一个数，测试 A9 钉住）。传满就停，不去撞后端，
 *   让页面说清楚「满了」，而不是「再点保存接着传」（再点也传不上）。
 */
export const MAX_NOTICE_IMAGES = 20;

/** 还能再加几张（库里已有的 + 框里待传的 不超过上限） */
export function photoSlotsLeft(existing: number, queued: number): number {
  return Math.max(0, MAX_NOTICE_IMAGES - existing - queued);
}

/**
 * HEIC / HEIF（苹果手机原图格式）：电脑上的 Chrome / Edge 解不开 —— 压不了、画不出小图，传上去卡片和大图都是破图、
 * 复制也复制不了（修复第 1 轮）。iPhone 上的浏览器选图时会自己转成 JPG，只有电脑上直接选 .heic 文件才会碰到
 * （比如隔空投送到 Mac 的原图）。先看类型；类型认不出（Windows 没装 HEIF 扩展时是空串）才看扩展名。
 * ⚠️ 类型已经是别的图片（image/jpeg 等）就信类型、不看扩展名：手机浏览器转好的 JPG 万一还叫 .HEIC，不能把它挡掉。
 */
export function isHeicFile(f: { name: string; type: string }): boolean {
  if (/^image\/hei[cf]/i.test(f.type)) return true;
  if (f.type.startsWith("image/")) return false;
  return /\.hei[cf]s?$/i.test(f.name);
}

/**
 * 电脑浏览器显示得了、存下来扩展名也对得上的几种图片（修复第 2 轮，2026-10-08）。
 * 原来只挡 HEIC、别的 image/* 一律放行：.tif（扫描仪、部分截图工具）、.svg 也能加进框，Chrome 压不了、画不出小图，
 * 后端把认不出的类型一律存成 .jpg、按 image/jpeg 发出去 —— 卡片 / 大图是破图、复制也复制不了，跟 HEIC 那个坑一模一样。
 * 跟后端 arrival-notices/routes.ts 上传接口的 PHOTO_MIME_ALLOWED 是同一份（测试钉住），也正好是 image-storage.ts 认得扩展名的那几种。
 */
export const DISPLAYABLE_PHOTO_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"];

export function isDisplayablePhotoType(type: string): boolean {
  return DISPLAYABLE_PHOTO_TYPES.includes(type.trim().toLowerCase());
}

const listNames = (fs: ReadonlyArray<{ name: string }>) => `${fs.slice(0, 5).map((f) => f.name).join("、")}${fs.length > 5 ? " 等" : ""}`;

/**
 * 选完照片：哪些加进框、哪些没加以及为什么（修复第 1 轮，从页面 addFiles 拆出来，测试能直接跑）。
 * 没加的一律写进提示、列出文件名（教训 19：不许静默丢）：
 *   - HEIC：电脑浏览器显示不了，请在手机上传或先转成 JPG；
 *   - 别的电脑上显示不了的图片格式（TIFF、SVG 等，不在 DISPLAYABLE_PHOTO_TYPES 里）：先转成 JPG（修复第 2 轮）；
 *   - 不是图片（type 不是 image/*，含 Windows 上认不出类型的）：没加；
 *   - 超过一条 MAX_NOTICE_IMAGES 张的上限：多出来的没加。
 * 「这次选了」按用户真选的文件个数说，不是过滤以后的。
 */
export function pickPhotos<T extends { name: string; type: string }>(files: readonly T[], slotsLeft: number): { take: T[]; note: string } {
  const heic = files.filter((f) => isHeicFile(f));
  const notImage = files.filter((f) => !isHeicFile(f) && !f.type.startsWith("image/"));
  const unsupported = files.filter((f) => !isHeicFile(f) && f.type.startsWith("image/") && !isDisplayablePhotoType(f.type));
  const images = files.filter((f) => !isHeicFile(f) && isDisplayablePhotoType(f.type));
  const take = images.slice(0, Math.max(0, slotsLeft));
  const over = images.slice(take.length);
  const reasons: string[] = [];
  if (heic.length) reasons.push(`${heic.length} 张是 HEIC 格式（苹果手机原图），电脑浏览器显示不了：${listNames(heic)}。请在手机上直接传，或先转成 JPG 再加`);
  if (unsupported.length) reasons.push(`${unsupported.length} 张的格式电脑上显示不了（只认 JPG / PNG / GIF / WebP / BMP）：${listNames(unsupported)}。请先转成 JPG 再加`);
  if (notImage.length) reasons.push(`${notImage.length} 个不是能识别的图片：${listNames(notImage)}`);
  if (over.length) reasons.push(`一条最多 ${MAX_NOTICE_IMAGES} 张照片，多出来的 ${over.length} 张没加：${listNames(over)}`);
  const note = reasons.length ? `这次选了 ${files.length} 个文件，加了 ${take.length} 张。${reasons.join("；")}` : "";
  return { take, note };
}

export interface PhotoUploadOutcome {
  uploaded: number;
  /** 没传上的张数（含因为满了没去传的） */
  failed: number;
  firstError: string | null;
  /** 中途被叫停（弹窗关了）：后面的没再传 */
  cancelled: boolean;
  /** 传满上限了：后面的没再传 */
  limitReached: boolean;
}

/** upload 返回 "cancelled" = 压缩完发现弹窗已关，这张没发出去；返回 count = 传完以后这条通知一共几张 */
export async function uploadQueuedPhotos<T>(opts: {
  items: readonly T[];
  /** 开传前库里已有几张（保存接口回来的那份） */
  existingCount: number;
  upload: (item: T) => Promise<{ count: number } | "cancelled">;
  isCancelled: () => boolean;
  onProgress?: (index: number, total: number) => void;
}): Promise<PhotoUploadOutcome> {
  const out: PhotoUploadOutcome = { uploaded: 0, failed: 0, firstError: null, cancelled: false, limitReached: false };
  let count = opts.existingCount;
  for (let i = 0; i < opts.items.length; i++) {
    if (opts.isCancelled()) { out.cancelled = true; break; }
    if (count >= MAX_NOTICE_IMAGES) { out.limitReached = true; out.failed += opts.items.length - i; break; }
    opts.onProgress?.(i, opts.items.length);
    try {
      const r = await opts.upload(opts.items[i]);
      if (r === "cancelled") { out.cancelled = true; break; }
      out.uploaded += 1;
      count = r.count;
    } catch (e) {
      out.failed += 1;
      if (out.firstError === null) out.firstError = e instanceof Error ? e.message : "照片没传上";
    }
  }
  return out;
}

/** G01：改了唛头、后端把「已通知」改回去时要跟员工说的那句 */
export const CLIENT_CHANGED_NOTE = "唛头换了，这条已改回「未通知」，记得通知新客户";

/**
 * 资料存上了、照片没传完时的提示（传满上限 / 有几张没传上）。
 * savedNote = 资料存上那一刻要跟员工说的话（G01 那句）。必须跟着说出来：再点「保存」时 base 已经是新唛头、
 * notifiedAt 已经是 null，第二次算不出来了，不在这里说、不留到最后说，这句就丢了（2026-10-08 修复审查）。
 */
export function photoFailMessage(r: Pick<PhotoUploadOutcome, "failed" | "firstError" | "limitReached">, savedNote: string): string {
  const saved = savedNote ? `资料已保存（${savedNote}）` : "资料已保存";
  if (r.limitReached) {
    return `${saved}。一条到货通知最多 ${MAX_NOTICE_IMAGES} 张照片，已经满了，还有 ${r.failed} 张没传：请点「移除」去掉多出来的（或者先删掉已有的照片）再保存`;
  }
  // 资料已经存上了；没传上的照片还留在框里，再点「保存」接着传（不会多登记一条）
  return `${saved}，但有 ${r.failed} 张照片没传上（${r.firstError}），再点「保存」接着传`;
}
