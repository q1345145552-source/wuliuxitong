import JsBarcode from "jsbarcode";

const QUIET_ZONE_MODULES = 10;
const MAX_WIDTH_PX = 256; // 现有 280px 标签扣掉边框与内边距，不能挤掉条码两侧静区。
const BAR_HEIGHT_PX = 44;

/** CODE128 编码交给已有依赖；只把它的二进制条纹画成无需网络/DOM 的 SVG。 */
export function renderTrackingBarcode(trackingNo: string): string {
  const warning = (message: string) => `<p class="barcode-warning">条码未生成：${message}</p>`;
  if (!trackingNo || !trackingNo.trim()) return warning("未提供运单号。");
  // 禁止控制字符和库的特殊功能码；扫描值必须是原运单号，不做 trim/转大写/拼箱号。
  if (!/^[\x20-\x7e]+$/.test(trackingNo)) return warning("运单号含不支持的字符，请按文字核对。");
  if (trackingNo.length > 128) return warning("运单号过长，请按文字核对。");

  try {
    const result: { encodings?: Array<{ data: string }> } = {};
    JsBarcode(result, trackingNo, { format: "CODE128", displayValue: false });
    const bars = result.encodings?.map((encoding) => encoding.data).join("") ?? "";
    if (!/^[01]+$/.test(bars)) throw new Error("Empty or invalid barcode encoding");

    const modules = bars.length + QUIET_ZONE_MODULES * 2;
    const moduleWidth = modules * 1.5 <= MAX_WIDTH_PX ? 1.5 : 1;
    if (modules * moduleWidth > MAX_WIDTH_PX) return warning("运单号过长，请按文字核对。");

    const width = modules * moduleWidth;
    const height = BAR_HEIGHT_PX + 8;
    const rectangles = Array.from(bars.matchAll(/1+/g), (bar) => {
      const x = (QUIET_ZONE_MODULES + bar.index) * moduleWidth;
      return `<rect x="${x}" y="4" width="${bar[0].length * moduleWidth}" height="${BAR_HEIGHT_PX}" fill="#000"/>`;
    }).join("");

    // 完整 SVG 已在 window.print 之前写入；不依赖图片加载、字体、CDN 或打印窗口里的脚本。
    return `<svg class="barcode" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="运单号条形码" data-format="CODE128" shape-rendering="crispEdges"><rect width="${width}" height="${height}" fill="#fff"/>${rectangles}</svg>`;
  } catch {
    // 条码失败不能让原有标签消失，也不能悄悄换成另一个号码。
    return warning("编码失败，请按文字运单号核对。");
  }
}
