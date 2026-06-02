"use client";

export interface ShipmentPrintLabelProps {
  marks: string;
  packageCount: number | string;
  trackingNo: string;
  itemName?: string;
  productQuantity?: number;
  transportMode?: string;
}

/**
 * 运单打印标签：唛头 + 运输方式 + 品名 + 箱号 + 单箱数量 + 运单号。
 * 按箱数生成多张标签，每张标注 N/总计。
 */
export function openPrintLabel(props: ShipmentPrintLabelProps) {
  const win = window.open("", "_blank", "width=340,height=520");
  if (!win) return;

  const total = Number(props.packageCount) || 1;
  const modeText = props.transportMode
    ? (props.transportMode === "sea" ? "海运" : "陆运")
    : "";

  let labelsHtml = "";
  for (let i = 1; i <= total; i++) {
    labelsHtml += `
<div class="label">
  <div class="row">
    <span>${escapeHtml(props.marks)}</span>
    <span>${escapeHtml(modeText)}</span>
    <span>${escapeHtml(props.itemName ?? "")}</span>
  </div>
  <div class="row">
    <span>箱号：${i}/${total}</span>
    <span>${props.productQuantity ? `单箱数量：${props.productQuantity}个` : ""}</span>
  </div>
  <div class="row"><span>${escapeHtml(props.trackingNo)}</span></div>
  <div class="footer">湘泰物流</div>
</div>`;
  }

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>运单标签</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; padding: 4px; }
  .label { width: 280px; margin: 6px auto; border: 1.5px solid #000; padding: 8px 10px; page-break-after: always; }
  .label:last-child { page-break-after: auto; }
  .row { display: flex; justify-content: space-between; font-size: 14px; font-weight: bold; margin: 2px 0; }
  .row span { flex: 1; text-align: center; word-break: break-all; }
  .footer { font-size: 10px; color: #888; text-align: center; margin-top: 6px; }
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
}

/**
 * 预报单打印标签：唛头 + 运输方式 + 品名 + 箱号 + 单箱数量 + 预报单号。
 * 按箱数生成多张标签，每张标注 N/总计。
 */
export function openPrintPrealert(props: PrealertPrintProps) {
  const win = window.open("", "_blank", "width=340,height=520");
  if (!win) return;

  const total = Number(props.packageCount) || 1;
  const modeText = props.transportMode === "sea" ? "海运" : "陆运";
  const pkgLabel = props.packageUnit === "box" ? "箱" : "袋";

  let labelsHtml = "";
  for (let i = 1; i <= total; i++) {
    labelsHtml += `
<div class="label">
  <div class="row">
    <span>${escapeHtml(props.clientId ?? "")}</span>
    <span>${escapeHtml(modeText)}</span>
    <span>${escapeHtml(props.itemName)}</span>
  </div>
  <div class="row">
    <span>箱号：${i}/${total}</span>
    <span>${props.productQuantity ? `单箱数量：${props.productQuantity}个` : ""}</span>
  </div>
  <div class="row"><span>${escapeHtml(props.prealertNo)}</span></div>
  <div class="footer">湘泰物流预报单</div>
</div>`;
  }

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>预报单标签</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; padding: 4px; }
  .label { width: 280px; margin: 6px auto; border: 1.5px solid #000; padding: 8px 10px; page-break-after: always; }
  .label:last-child { page-break-after: auto; }
  .row { display: flex; justify-content: space-between; font-size: 14px; font-weight: bold; margin: 2px 0; }
  .row span { flex: 1; text-align: center; word-break: break-all; }
  .footer { font-size: 10px; color: #888; text-align: center; margin-top: 6px; }
  @media print { body { padding: 0; } .label { border: none; } }
</style></head><body>
${labelsHtml}
<script>window.print();</script></body></html>`);

  win.document.close();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
