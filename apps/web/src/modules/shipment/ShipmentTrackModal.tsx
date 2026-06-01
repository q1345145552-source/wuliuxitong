"use client";

import { useEffect, useState } from "react";
import { authHeaders, apiBaseUrl } from "../../services/core-api";

interface TimelineItem {
  fromStatus: string;
  toStatus: string;
  remark: string;
  changedAt: string;
  operatorRole: string;
}

interface ChildShipmentData {
  trackingNo: string;
  batchNo: string | null;
  itemName: string | null;
  packageCount: number | null;
  currentStatus: string;
  timeline: TimelineItem[];
}

interface TrackData {
  trackingNo: string;
  currentStatus: string;
  containers: Array<{
    containerNo: string;
    containerStatus: string;
    containerStatusLabel: string;
  }>;
  timeline: TimelineItem[];
  children?: ChildShipmentData[];
}

const STATUS_ZH: Record<string, string> = {
  loaded: "已装柜",
  delayDeparted: "延迟开船",
  departed: "已开船",
  arrivedPort: "已到港",
  customsTH: "清关中",
  customsCleared: "清关已放行",
  inWarehouseTH: "已到仓",
  outForDelivery: "派送中",
  delivered: "派送完成",
  exception: "异常",
  returned: "已退回",
  cancelled: "已取消",
};

function statusZh(s: string): string {
  return STATUS_ZH[s.toLowerCase()] || s;
}

function formatTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function openShipmentTrack(trackingNo: string) {
  // 创建遮罩和弹窗 DOM
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);padding:16px";
  const modal = document.createElement("div");
  modal.style.cssText =
    "width:100%;max-width:560px;max-height:90vh;overflow:auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.3)";
  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h3 style="margin:0;font-size:18px;font-weight:600">物流轨迹</h3>
      <span style="font-size:13px;color:#6b7280">${escapeHtml(trackingNo)}</span>
    </div>
    <div id="track-content" style="text-align:center;padding:40px 0;color:#64748b">加载中…</div>
    <div style="display:flex;justify-content:flex-end;margin-top:16px">
      <button id="track-close-btn" style="border:1px solid #d1d5db;border-radius:6px;padding:8px 16px;font-size:13px;background:#fff;cursor:pointer;color:#374151">关闭</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) document.body.removeChild(overlay);
  });
  modal.querySelector("#track-close-btn")!.addEventListener("click", () => {
    document.body.removeChild(overlay);
  });

  // 加载数据
  const params = new URLSearchParams({ trackingNo });
  fetch(`${apiBaseUrl()}/client/shipments/track?${params.toString()}`, {
    headers: { ...authHeaders() },
  })
    .then((resp) => resp.json())
    .then((json) => {
      const data = json.data as TrackData | undefined;
      const content = modal.querySelector("#track-content")!;
      if (!data || !data.timeline) {
        content.innerHTML = '<div style="color:#64748b;padding:20px 0">暂无物流轨迹</div>';
        return;
      }
      // 当前状态
      let html = `<div style="margin-bottom:16px;padding:10px 14px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0">
        <div style="font-size:13px;color:#166534">当前状态：<strong>${statusZh(data.currentStatus)}</strong></div>
      </div>`;
      // 柜号信息
      if (data.containers?.length > 0) {
        html += `<div style="margin-bottom:12px;font-size:12px;color:#64748b">柜号：${data.containers.map((c) => c.containerNo).join(" / ")}</div>`;
      }
      // 时间线
      html += '<div style="position:relative;padding-left:24px">';
      html += '<div style="position:absolute;left:10px;top:4px;bottom:4px;width:2px;background:#e5e7eb"></div>';
      data.timeline.forEach((item, i) => {
        const isLast = i === data.timeline.length - 1;
        html += `<div style="position:relative;padding-bottom:${isLast ? "0" : "16px"}">
          <div style="position:absolute;left:-18px;top:4px;width:10px;height:10px;border-radius:50%;background:${isLast ? "#16a34a" : "#93c5fd"};border:2px solid #fff;box-shadow:0 0 0 1px ${isLast ? "#16a34a" : "#93c5fd"}"></div>
          <div style="font-size:12px;color:#64748b;margin-bottom:2px">${formatTime(item.changedAt)}</div>
          <div style="font-size:13px;font-weight:500;color:#1f2937">${statusZh(item.fromStatus)} → ${statusZh(item.toStatus)}</div>
          ${item.remark ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">备注：${escapeHtml(item.remark)}</div>` : ""}
          <div style="font-size:11px;color:#6b7280;margin-top:1px">操作人：${item.operatorRole === "client" ? "客户" : item.operatorRole === "staff" ? "员工" : "管理员"}</div>
        </div>`;
      });
      html += "</div>";

      // 子单轨迹
      if (data.children && data.children.length > 0) {
        html += '<div style="margin-top:20px;border-top:1px solid #e5e7eb;padding-top:16px">';
        html += '<div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:12px">分柜子单轨迹</div>';
        data.children.forEach((child) => {
          html += `<div style="margin-bottom:16px;padding:10px 12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">
            <div style="font-size:13px;font-weight:600;color:#1e3a8a;margin-bottom:4px">${escapeHtml(child.trackingNo)}</div>
            <div style="font-size:12px;color:#64748b;margin-bottom:4px">柜号：${child.batchNo ? escapeHtml(child.batchNo) : "-"} ｜ 品名：${child.itemName ?? "-"} ｜ 件数：${child.packageCount ?? "-"}</div>
            <div style="font-size:12px;color:#166534;margin-bottom:6px">当前状态：${statusZh(child.currentStatus)}</div>`;
          if (child.timeline && child.timeline.length > 0) {
            html += '<div style="position:relative;padding-left:20px">';
            html += '<div style="position:absolute;left:8px;top:4px;bottom:4px;width:1px;background:#d1d5db"></div>';
            child.timeline.forEach((tl, j) => {
              const isLast = j === child.timeline.length - 1;
              html += `<div style="position:relative;padding-bottom:${isLast ? "0" : "10px"}">
                <div style="position:absolute;left:-14px;top:4px;width:8px;height:8px;border-radius:50%;background:${isLast ? "#16a34a" : "#93c5fd"};border:2px solid #fff;box-shadow:0 0 0 1px ${isLast ? "#16a34a" : "#93c5fd"}"></div>
                <div style="font-size:11px;color:#64748b">${formatTime(tl.changedAt)}</div>
                <div style="font-size:12px;font-weight:500;color:#1f2937">${statusZh(tl.fromStatus)} → ${statusZh(tl.toStatus)}</div>
                ${tl.remark ? `<div style="font-size:11px;color:#6b7280">备注：${escapeHtml(tl.remark)}</div>` : ""}
              </div>`;
            });
            html += '</div>';
          } else {
            html += '<div style="font-size:11px;color:#6b7280">暂无轨迹</div>';
          }
          html += '</div>';
        });
        html += '</div>';
      }

      content.innerHTML = html;
    })
    .catch(() => {
      const content = modal.querySelector("#track-content")!;
      content.innerHTML = '<div style="color:#b91c1c;padding:20px 0">加载失败，请重试</div>';
    });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
