"use client";

import { useEffect, useRef } from "react";
import JsBarcode from "jsbarcode";

export interface ShipmentPrintLabelProps {
  marks: string;
  packageCount: number | string;
  trackingNo: string;
  itemName?: string;
}

/**
 * 运单打印标签：唛头 + 件数 + 运单号 + 条形码。
 * 点击后打开新窗口打印，条形码由 jsbarcode 生成到 SVG。
 */
export function openPrintLabel(props: ShipmentPrintLabelProps) {
  const win = window.open("", "_blank", "width=400,height=600");
  if (!win) return;

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>运单标签</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; padding: 20px; }
  .label { width: 320px; margin: 0 auto; border: 2px solid #000; padding: 20px; text-align: center; }
  .marks { font-size: 28px; font-weight: bold; margin: 12px 0; word-break: break-all; }
  .item-name { font-size: 14px; color: #555; margin-bottom: 8px; }
  .count { font-size: 22px; font-weight: bold; margin: 8px 0; }
  .tracking { font-size: 16px; font-weight: bold; margin: 10px 0; letter-spacing: 1px; }
  .barcode-wrap { margin: 12px 0; text-align: center; }
  .barcode-wrap svg { max-width: 100%; height: auto; }
  .footer { font-size: 11px; color: #999; margin-top: 8px; }
  @media print { body { padding: 0; } .label { border: none; } }
</style></head><body>
<div class="label">
  <div class="marks">${escapeHtml(props.marks)}</div>
  ${props.itemName ? `<div class="item-name">${escapeHtml(props.itemName)}</div>` : ""}
  <div class="count">件数：${props.packageCount}</div>
  <div class="tracking">${escapeHtml(props.trackingNo)}</div>
  <div class="barcode-wrap"><svg id="barcode"></svg></div>
  <div class="footer">湘泰物流</div>
</div>
<script>
  try {
    JsBarcode("#barcode", ${JSON.stringify(props.trackingNo)}, {
      format: "CODE128",
      width: 1.6,
      height: 50,
      displayValue: false,
      margin: 4,
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
}

/**
 * 预报单打印：预报单号 + 品名 + 件数 + 运输方式 + 仓库 + 国内单号 + 创建时间 + 唛头。
 * 点击后打开新窗口直接打印。
 */
export function openPrintPrealert(props: PrealertPrintProps) {
  const win = window.open("", "_blank", "width=480,height=680");
  if (!win) return;

  const modeLabel = props.transportMode === "sea" ? "海运" : "陆运";
  const pkgLabel = props.packageUnit === "box" ? "箱" : "袋";

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>预报单</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; padding: 20px; }
  .prealert { width: 380px; margin: 0 auto; border: 2px solid #000; padding: 24px; }
  .title { text-align: center; font-size: 22px; font-weight: bold; margin-bottom: 20px; letter-spacing: 4px; }
  .row { display: flex; padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
  .row .label { width: 80px; color: #6b7280; flex-shrink: 0; }
  .row .value { flex: 1; font-weight: 500; color: #111; word-break: break-all; }
  .prealert-no { font-size: 18px; font-weight: bold; margin-bottom: 8px; text-align: center; font-family: monospace; }
  .footer { font-size: 11px; color: #999; text-align: center; margin-top: 20px; }
  @media print { body { padding: 0; } .prealert { border: none; } }
</style></head><body>
<div class="prealert">
  <div class="title">预 报 单</div>
  <div class="prealert-no">${escapeHtml(props.prealertNo)}</div>
  <div class="row"><span class="label">品名</span><span class="value">${escapeHtml(props.itemName)}</span></div>
  <div class="row"><span class="label">件数</span><span class="value">${props.packageCount} ${pkgLabel}</span></div>
  <div class="row"><span class="label">运输方式</span><span class="value">${modeLabel}</span></div>
  <div class="row"><span class="label">仓库</span><span class="value">${escapeHtml(props.warehouseLabel)}</span></div>
  ${props.domesticTrackingNo ? `<div class="row"><span class="label">国内单号</span><span class="value">${escapeHtml(props.domesticTrackingNo)}</span></div>` : ""}
  <div class="row"><span class="label">创建时间</span><span class="value">${props.createdAt.slice(0, 10)}</span></div>
  ${props.clientId ? `<div class="row"><span class="label">唛头</span><span class="value">${escapeHtml(props.clientId)}</span></div>` : ""}
  <div class="footer">湘泰物流</div>
</div>
<script>window.print();</script></body></html>`);

  win.document.close();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
