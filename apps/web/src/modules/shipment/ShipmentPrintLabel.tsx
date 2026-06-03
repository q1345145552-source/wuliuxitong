"use client";

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
 * 运单打印标签：唛头 + 运输方式 + 产品列表 + 箱号 + 单箱数量 + 运单号。
 * 多产品时每行一个产品，标明箱数。
 */
export function openPrintLabel(props: ShipmentPrintLabelProps) {
  const win = window.open("", "_blank", "width=340,height=520");
  if (!win) return;

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
  <div class="row"><span>${escapeHtml(props.trackingNo)}</span></div>
  <div class="footer">湘泰物流</div>
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
  <div class="row"><span>${escapeHtml(props.trackingNo)}</span></div>
  <div class="footer">湘泰物流</div>
</div>`;
    }
  }

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>运单标签</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; padding: 4px; }
  .label { width: 280px; margin: 6px auto; border: 1.5px solid #000; padding: 8px 10px; page-break-after: always; }
  .label:last-child { page-break-after: auto; }
  .row { display: flex; font-size: 14px; font-weight: bold; margin: 3px 0; }
  .row span { flex: 1; text-align: center; word-break: break-all; }
  .footer { font-size: 10px; color: #888; text-align: center; margin-top: 4px; }
  @media print { body { padding: 0; } .label { border: none; } }
</style></head><body>
${labelsHtml}
<script>window.print();</script></body></html>`);

  win.document.close();
}

export interface PrealertPrintProps {
  prealertNo: string;
  itemName: string;
  packageCount: number;
  packageUnit: "bag" | "box";
  transportMode: "sea" | "land";
  warehouseLabel: string;
  domesticTrackingNo?: string;
  createdAt: string;
  clientId?: string;
  productQuantity?: number;
  products?: Array<{ itemName: string; packageCount: number }>;
}

/**
 * 预报单打印标签：唛头 + 运输方式 + 产品列表 + 箱号 + 单箱数量 + 预报单号。
 * 多产品时每行一个产品，标明箱数。
 */
export function openPrintPrealert(props: PrealertPrintProps) {
  const win = window.open("", "_blank", "width=340,height=520");
  if (!win) return;

  const total = Number(props.packageCount) || 1;
  const modeText = props.transportMode === "sea" ? "海运" : "陆运";
  const hasProducts = (props.products?.length ?? 0) > 0;

  let labelsHtml = "";
  let globalIdx = 0;
  if (hasProducts) {
    for (const p of props.products!) {
      for (let j = 0; j < p.packageCount; j++) {
        globalIdx++;
        labelsHtml += `
<div class="label">
  <div class="row"><span>${escapeHtml(props.clientId ?? "")}</span><span>${escapeHtml(modeText)}</span></div>
  <div class="row"><span>${escapeHtml(p.itemName)}</span></div>
  <div class="row"><span>箱号：${globalIdx}/${total}</span></div>
  <div class="row"><span>${escapeHtml(props.prealertNo)}</span></div>
  <div class="footer">湘泰物流预报单</div>
</div>`;
      }
    }
  } else {
    for (let i = 1; i <= total; i++) {
      labelsHtml += `
<div class="label">
  <div class="row"><span>${escapeHtml(props.clientId ?? "")}</span><span>${escapeHtml(modeText)}</span></div>
  <div class="row"><span>${escapeHtml(props.itemName)}</span></div>
  <div class="row"><span>箱号：${i}/${total}</span><span>${props.productQuantity ? `单箱数量：${props.productQuantity}个` : ""}</span></div>
  <div class="row"><span>${escapeHtml(props.prealertNo)}</span></div>
  <div class="footer">湘泰物流预报单</div>
</div>`;
    }
  }

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>预报单标签</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; padding: 4px; }
  .label { width: 280px; margin: 6px auto; border: 1.5px solid #000; padding: 8px 10px; page-break-after: always; }
  .label:last-child { page-break-after: auto; }
  .row { display: flex; font-size: 14px; font-weight: bold; margin: 3px 0; }
  .row span { flex: 1; text-align: center; word-break: break-all; }
  .footer { font-size: 10px; color: #888; text-align: center; margin-top: 4px; }
  @media print { body { padding: 0; } .label { border: none; } }
</style></head><body>
${labelsHtml}
<script>window.print();</script></body></html>`);

  win.document.close();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
