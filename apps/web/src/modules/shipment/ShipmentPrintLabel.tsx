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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
