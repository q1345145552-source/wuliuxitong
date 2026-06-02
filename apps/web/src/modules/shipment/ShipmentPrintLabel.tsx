"use client";

import { useEffect, useRef } from "react";
import JsBarcode from "jsbarcode";

export interface ShipmentPrintLabelProps {
  marks: string;
  packageCount: number | string;
  trackingNo: string;
  itemName?: string;
  productQuantity?: number;
  transportMode?: string;
}

/**
 * 运单打印标签：唛头 + 件数 + 运单号 + 条形码。
 * 点击后打开新窗口打印，条形码由 jsbarcode 生成到 SVG。
 */
export function openPrintLabel(props: ShipmentPrintLabelProps) {
  const win = window.open("", "_blank", "width=340,height=520");
  if (!win) return;

  const modeText = props.transportMode
    ? (props.transportMode === "sea" ? "海运" : "陆运")
    : "";

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>运单标签</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; padding: 4px; }
  .label { width: 280px; margin: 0 auto; border: 1.5px solid #000; padding: 8px 10px; }
  .row { display: flex; justify-content: space-between; font-size: 14px; font-weight: bold; margin: 2px 0; }
  .row span { flex: 1; text-align: center; word-break: break-all; }
  .barcode-wrap { margin: 6px 0 2px; text-align: center; }
  .barcode-wrap svg { max-width: 100%; height: auto; }
  .footer { font-size: 10px; color: #888; text-align: center; margin-top: 2px; }
  @media print { body { padding: 0; } .label { border: none; } }
</style></head><body>
<div class="label">
  <div class="row">
    <span>${escapeHtml(props.marks)}</span>
    <span>${escapeHtml(modeText)}</span>
    <span>${escapeHtml(props.itemName ?? "")}</span>
  </div>
  <div class="row">
    <span>箱数：${props.packageCount}</span>
    <span>${props.productQuantity ? `单箱数量：${props.productQuantity}个` : ""}</span>
  </div>
  <div class="row"><span>${escapeHtml(props.trackingNo)}</span></div>
  <div class="barcode-wrap"><svg id="barcode"></svg></div>
  <div class="footer">湘泰物流</div>
</div>
<script>
  try {
    JsBarcode("#barcode", ${JSON.stringify(props.trackingNo)}, {
      format: "CODE128",
      width: 1.4,
      height: 40,
      displayValue: false,
      margin: 2,
    });
  } catch(e) { document.getElementById("barcode").textContent = ${JSON.stringify(props.trackingNo)}; }
  window.print();
</script></body></html>`);

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
 * 预报单打印标签：唛头 + 品名 + 件数 + 预报单号 + 条形码。
 * 点击后打开新窗口打印，条形码由 jsbarcode 生成到 SVG。
 */
export function openPrintPrealert(props: PrealertPrintProps) {
  const win = window.open("", "_blank", "width=340,height=520");
  if (!win) return;

  const modeText = props.transportMode === "sea" ? "海运" : "陆运";
  const pkgLabel = props.packageUnit === "box" ? "箱" : "袋";

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>预报单标签</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; padding: 4px; }
  .label { width: 280px; margin: 0 auto; border: 1.5px solid #000; padding: 8px 10px; }
  .row { display: flex; justify-content: space-between; font-size: 14px; font-weight: bold; margin: 2px 0; }
  .row span { flex: 1; text-align: center; word-break: break-all; }
  .barcode-wrap { margin: 6px 0 2px; text-align: center; }
  .barcode-wrap svg { max-width: 100%; height: auto; }
  .footer { font-size: 10px; color: #888; text-align: center; margin-top: 2px; }
  @media print { body { padding: 0; } .label { border: none; } }
</style></head><body>
<div class="label">
  <div class="row">
    <span>${escapeHtml(props.clientId ?? "")}</span>
    <span>${escapeHtml(modeText)}</span>
    <span>${escapeHtml(props.itemName)}</span>
  </div>
  <div class="row">
    <span>箱数：${props.packageCount}${pkgLabel}</span>
    <span>${props.productQuantity ? `单箱数量：${props.productQuantity}个` : ""}</span>
  </div>
  <div class="row"><span>${escapeHtml(props.prealertNo)}</span></div>
  <div class="barcode-wrap"><svg id="barcode"></svg></div>
  <div class="footer">湘泰物流预报单</div>
</div>
<script>
  try {
    JsBarcode("#barcode", ${JSON.stringify(props.prealertNo)}, {
      format: "CODE128",
      width: 1.4,
      height: 40,
      displayValue: false,
      margin: 2,
    });
  } catch(e) { document.getElementById("barcode").textContent = ${JSON.stringify(props.prealertNo)}; }
  window.print();
</script></body></html>`);

  win.document.close();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
