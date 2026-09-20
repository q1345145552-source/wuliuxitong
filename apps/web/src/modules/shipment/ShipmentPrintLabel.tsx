"use client";

import { renderTrackingBarcode } from "./trackingBarcode";

export interface ShipmentPrintLabelProps {
  marks: string;
  packageCount: number | string;
  trackingNo: string;
  itemName?: string;
  productQuantity?: number;
  transportMode?: string;
  products?: Array<{ itemName: string; packageCount: number }>;
}

/**
 * 运单打印标签：唛头 + 运输方式 + 产品列表 + 箱号 + 单箱数量 + 运单号及条形码。
 * 多产品时每行一个产品，标明箱数。
 * 2026-09-15：老板要求去掉底部「湘泰物流网站」那一行（连带 .footer 样式），其余不动。
 */
export function openPrintLabel(props: ShipmentPrintLabelProps) {
  const win = window.open("", "_blank", "width=340,height=520");
  if (!win) return;

  // 同一运单各箱共用运单条码；箱号仍是文字，不改变扫描后用于查运单的值。
  const barcodeHtml = renderTrackingBarcode(props.trackingNo);
  const total = Number(props.packageCount) || 1;
  const modeText = props.transportMode
    ? (props.transportMode === "sea" ? "海运" : "陆运")
    : "";
  const hasProducts = (props.products?.length ?? 0) > 0;

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
}

/* 2026-08-31（复查条目24 / 条目48收尾）：openPrintPrealert 和 PrealertPrintProps 已删 ——
   唯一调用方是客户端预报单列表 2026-06-28 就被删掉的「打印预报单」按钮，
   全 web 目录 grep 引用为 0，留着就是死导出（教训9）。escapeHtml 上面 openPrintLabel 还在用，保留。 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
