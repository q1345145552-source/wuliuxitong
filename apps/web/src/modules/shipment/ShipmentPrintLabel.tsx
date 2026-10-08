"use client";

import { renderTrackingBarcode } from "./trackingBarcode";

export interface ShipmentPrintLabelProps {
  marks: string;
  packageCount: number | string;
  trackingNo: string;
  itemName?: string;
  productQuantity?: number;
  transportMode?: string;
  currentStatus?: string;
  products?: Array<{ itemName: string; packageCount: number }>;
  /**
   * 后端算好的整票件数（列表接口的 totalPackageCount = 父单剩余 + 全部子单），只拿来跟产品行之和对账，不当分母。
   * 不传 / 空 = 不对账（2026-10-08 修复第 2 轮）。
   */
  wholePackageCount?: number | null;
}

/**
 * 运单打印标签：唛头 + 运输方式 + 产品列表 + 箱号 + 单箱数量 + 运单号及条形码。
 * 多产品时每行一个产品，标明箱数。
 * 2026-09-15：老板要求去掉底部「湘泰物流网站」那一行（连带 .footer 样式），其余不动。
 */
function positiveInt(n: unknown): number | null {
  const v = typeof n === "string" && n.trim() !== "" ? Number(n) : n;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * 件数排不出箱号时不打（2026-10-08 到货通知审查 F07）。
 * 原来没件数按 1 箱打（「箱号 1/1」，贴上去就是错的），产品行件数 0 一张都不出（空白页）。
 * 箱数宁可拦住让人补，绝不猜（同 productRowGuard 的规矩）。能打印返回 null。
 * 文案说「空的或 0」而不是「还没填」：拆柜后父单剩 0、又没有产品行的老数据也会被这句挡住。
 */
export function printLabelBlockedReason(props: Pick<ShipmentPrintLabelProps, "packageCount" | "products" | "wholePackageCount" | "currentStatus">): string | null {
  const products = props.products ?? [];
  if (products.length > 0) {
    const bad = products.find((p) => positiveInt(p.packageCount) == null);
    if (bad) return `「${bad.itemName || "未填品名"}」这一行的件数是空的或 0，排不出箱号，补上件数再打印`;
    /* 产品行之和跟整票件数对不上也不打（2026-10-08 修复第 2 轮）：确认收货 / 改单时改了整票件数、产品行没跟着改
       （多产品行的单确认收货只改订单和运单），原来按产品行打出「1/7…7/7」—— 实收 9 箱少 2 张标签，标签上却像打全了。 */
    const sum = products.reduce((s, p) => s + (positiveInt(p.packageCount) ?? 0), 0);
    const whole = positiveInt(props.wholePackageCount);
    return whole != null && whole !== sum
      ? `产品行箱数合计 ${sum} 箱，跟这票货的件数 ${whole} 箱对不上（收货或改单时改了件数、产品行没跟着改），先请超管在运单管理把产品行箱数改对再打印`
      : null;
  }
  if (positiveInt(props.packageCount) == null) return "这票货的件数是空的或 0，排不出箱号，补上件数再打印";
  if (props.currentStatus === "pendingInbound") {
    return "这票待入库的货产品明细没填齐，请在「到货通知」补齐每款品名和件数再打印";
  }
  return null;
}

/** 打开打印窗口。件数不全时不开窗口，返回给人看的原因；其余情况（包括浏览器拦了弹窗）返回 null。 */
export function openPrintLabel(props: ShipmentPrintLabelProps): string | null {
  const blocked = printLabelBlockedReason(props);
  if (blocked) return blocked;
  const win = window.open("", "_blank", "width=340,height=520");
  if (!win) return null;

  // 同一运单各箱共用运单条码；箱号仍是文字，不改变扫描后用于查运单的值。
  const barcodeHtml = renderTrackingBarcode(props.trackingNo);
  const hasProducts = (props.products?.length ?? 0) > 0;
  // 有产品行时标签张数 = 产品行件数之和（上面已确认每行都是正整数），分母也一律用这个和：
  // 张数和分母同一个数，不会出现「101/71」（调用方传的件数可能是拆柜 / 部分装柜后的剩余数，2026-10-08 修复审查）。
  // 没有产品行时分母 = 调用方传的整票件数（员工 / 超管传 totalPackageCountOf）
  const productSum = (props.products ?? []).reduce((s, p) => s + (positiveInt(p.packageCount) ?? 0), 0);
  const total = hasProducts ? productSum : (positiveInt(props.packageCount) ?? 0);
  const modeText = props.transportMode
    ? (props.transportMode === "sea" ? "海运" : "陆运")
    : "";

  let labelsHtml = "";
  let globalIdx = 0;
  if (hasProducts) {
    for (const p of props.products!) {
      for (let j = 0; j < p.packageCount; j++) {
        globalIdx++;
        labelsHtml += `
<div class="label">
  <div class="row"><span>${escapeHtml(props.marks)}</span><span>${escapeHtml(modeText)}</span></div>
  <div class="row"><span>${escapeHtml(p.itemName)}</span></div>
  <div class="row"><span>箱号：${globalIdx}/${total}</span></div>
  <div class="row"><span class="tracking-no">${escapeHtml(props.trackingNo)}</span></div>
  ${barcodeHtml}
</div>`;
      }
    }
  } else {
    for (let i = 1; i <= total; i++) {
      labelsHtml += `
<div class="label">
  <div class="row"><span>${escapeHtml(props.marks)}</span><span>${escapeHtml(modeText)}</span></div>
  <div class="row"><span>${escapeHtml(props.itemName ?? "")}</span></div>
  <div class="row"><span>箱号：${i}/${total}</span><span>${props.productQuantity ? `单箱数量：${props.productQuantity}个` : ""}</span></div>
  <div class="row"><span class="tracking-no">${escapeHtml(props.trackingNo)}</span></div>
  ${barcodeHtml}
</div>`;
    }
  }

  // ⚠️ 下面这段 HTML 是写进**新开的打印窗口**的，那个窗口没有 globals.css，
  // 所以里面的颜色**必须写死，不能用设计变量**（2026-08-09 批量换色时被换过，已改回）。
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>运单标签</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; padding: 4px; }
  .label { width: 280px; margin: 6px auto; border: 1.5px solid #000; padding: 8px 10px; page-break-after: always; }
  .label:last-child { page-break-after: auto; }
  .row { display: flex; font-size: 14px; font-weight: bold; margin: 3px 0; }
  .row span { flex: 1; text-align: center; word-break: break-all; }
  .tracking-no { white-space: break-spaces; }
  .barcode { display: block; margin: 6px auto 2px; }
  .barcode-warning { font-size: 11px; line-height: 1.4; text-align: center; margin-top: 6px; }
  @media print { body { padding: 0; } .label { border: none; } }
</style></head><body>
${labelsHtml}
<script>window.print();</script></body></html>`);

  win.document.close();
  return null;
}

/* 2026-08-31（复查条目24 / 条目48收尾）：openPrintPrealert 和 PrealertPrintProps 已删 ——
   唯一调用方是客户端预报单列表 2026-06-28 就被删掉的「打印预报单」按钮，
   全 web 目录 grep 引用为 0，留着就是死导出（教训9）。escapeHtml 上面 openPrintLabel 还在用，保留。 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
