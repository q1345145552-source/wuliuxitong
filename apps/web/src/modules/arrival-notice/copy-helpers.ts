/**
 * 到货通知里「复制文案」「复制图片」「保存图片」（2026-10-06 老板：「由客服在系统直接复制文案，图片然后去告知客户」）。
 *
 * - 复制文案：系统剪贴板；老浏览器不认就退回 execCommand。
 * - 复制图片：剪贴板只认 PNG，JPEG 先在画布上转一下；电脑上的 Chrome / Edge 能直接粘进微信、LINE。
 *   手机浏览器和 app 里大多不支持往剪贴板放图片，失败了提示改点「保存」。
 * - 保存图片：走普通下载；app 里下载会弹系统分享（native-app.ts 接管），能直接发给微信、LINE。
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 下面老办法再试一次 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const okCopy = document.execCommand("copy");
    ta.remove();
    return okCopy;
  } catch {
    return false;
  }
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`图片取不到（${res.status}）`);
  return res.blob();
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布用不了");
  // ⚠️ canvas 不认 CSS 变量（CLAUDE.md 第 23 条）：这里只画图，不填底色
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("转换失败"))), "image/png");
  });
}

/** 成功 true；这台设备不支持往剪贴板放图片 / 失败 false */
export async function copyImage(url: string): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
  try {
    // 先给剪贴板一个「还在取」的 Promise：Safari 要求点击当下就调 write，等取完图再调会被当成不是用户操作
    await navigator.clipboard.write([new ClipboardItem({ "image/png": fetchBlob(url).then(toPng) })]);
    return true;
  } catch {
    try {
      const png = await toPng(await fetchBlob(url));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return true;
    } catch {
      return false;
    }
  }
}

export async function saveImage(url: string, fileName: string): Promise<void> {
  const blob = await fetchBlob(url);
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName || "到货照片.jpg";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // app 里接管下载要读这个 blob，晚一点再放掉
  window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
