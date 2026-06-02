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
 * 居中竖排，按箱数生成多张。
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
  <div class="marks">${escapeHtml(props.marks)}</div>
  <div class="mode">${escapeHtml(modeText)}</div>
  <div class="name">${escapeHtml(props.itemName ?? "")}</div>
  <div class="info">箱号：${i}/${total}</div>
  ${props.productQuantity ? `<div class="info">单箱数量：${props.productQuantity}个</div>` : ""}
  <div class="no">${escapeHtml(props.trackingNo)}</div>
  <div class="footer">湘泰物流</div>
</div>`;
  }

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>运单标签</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; padding: 4px; }
  .label { width: 280px; margin: 6px auto; border: 1.5px solid #000; padding: 10px 12px; text-align: center; page-break-after: always; }
  .label:last-child { page-break-after: auto; }
  .marks { font-size: 22px; font-weight: bold; margin: 6px 0; word-break: break-all; }
  .mode { font-size: 18px; font-weight: bold; margin: 4px 0; letter-spacing: 4px; }
  .name { font-size: 14px; color: #444; margin: 4px 0; }
  .info { font-size: 15px; font-weight: bold; margin: 3px 0; }
  .no { font-size: 15px; font-weight: bold; margin: 4px 0; letter-spacing: 1px; }
  .footer { font-size: 10px; color: #888; margin-top: 8px; }
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
 * 居中竖排，按箱数生成多张。
 */
export function openPrintPrealert(props: PrealertPrintProps) {
  const win = window.open("", "_blank", "width=340,height=520");
  if (!win) return;

  const total = Number(props.packageCount) || 1;
  const modeText = props.transportMode === "sea" ? "海运" : "陆运";

  let labelsHtml = "";
  for (let i = 1; i <= total; i++) {
    labelsHtml += `
<div class="label">
  <div class="marks">${escapeHtml(props.clientId ?? "")}</div>
  <div class="mode">${escapeHtml(modeText)}</div>
  <div class="name">${escapeHtml(props.itemName)}</div>
  <div class="info">箱号：${i}/${total}</div>
  ${props.productQuantity ? `<div class="info">单箱数量：${props.productQuantity}个</div>` : ""}
  <div class="no">${escapeHtml(props.prealertNo)}</div>
  <div class="footer">湘泰物流预报单</div>
</div>`;
  }

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>预报单标签</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; padding: 4px; }
  .label { width: 280px; margin: 6px auto; border: 1.5px solid #000; padding: 10px 12px; text-align: center; page-break-after: always; }
  .label:last-child { page-break-after: auto; }
  .marks { font-size: 22px; font-weight: bold; margin: 6px 0; word-break: break-all; }
  .mode { font-size: 18px; font-weight: bold; margin: 4px 0; letter-spacing: 4px; }
  .name { font-size: 14px; color: #444; margin: 4px 0; }
  .info { font-size: 15px; font-weight: bold; margin: 3px 0; }
  .no { font-size: 15px; font-weight: bold; margin: 4px 0; letter-spacing: 1px; }
  .footer { font-size: 10px; color: #888; margin-top: 8px; }
  @media print { body { padding: 0; } .label { border: none; } }
</style></head><body>
${labelsHtml}
<script>window.print();</script></body></html>`);

  win.document.close();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
