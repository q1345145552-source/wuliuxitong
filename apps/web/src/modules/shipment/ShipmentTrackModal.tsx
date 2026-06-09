"use client";

import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import { authHeaders, apiBaseUrl } from "../../services/core-api";

// ── Types ──

interface TimelineItem {
  fromStatus: string;
  toStatus: string;
  remark: string;
  changedAt: string;
  operatorRole: string;
  operatorName: string;
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

// ── Status config ──

const STATUS_CONFIG: Record<string, { zh: string; color: string; bg: string; icon: string }> = {
  loaded:       { zh: "已装柜",   color: "#0369a1", bg: "#e0f2fe", icon: "📦" },
  delayDeparted:{ zh: "延迟开船", color: "#b45309", bg: "#fef3c7", icon: "⚠️" },
  departed:     { zh: "已开船",   color: "#1e40af", bg: "#dbeafe", icon: "🚢" },
  arrivedPort:  { zh: "已到港",   color: "#065f46", bg: "#d1fae5", icon: "⚓" },
  customsTH:    { zh: "清关中",   color: "#92400e", bg: "#fef3c7", icon: "📋" },
  customsCleared:{ zh: "清关已放行", color: "#166534", bg: "#dcfce7", icon: "✅" },
  inWarehouseTH:{ zh: "已到仓",   color: "#7c3aed", bg: "#ede9fe", icon: "🏠" },
  outForDelivery:{ zh: "派送中",  color: "#db2777", bg: "#fce7f3", icon: "🚚" },
  delivered:    { zh: "派送完成", color: "#16a34a", bg: "#f0fdf4", icon: "🎉" },
  exception:    { zh: "异常",     color: "#dc2626", bg: "#fef2f2", icon: "❗" },
  returned:     { zh: "已退回",   color: "#991b1b", bg: "#fee2e2", icon: "↩️" },
  cancelled:    { zh: "已取消",   color: "#6b7280", bg: "#f3f4f6", icon: "❌" },
};

function statusCfg(s: string) {
  return STATUS_CONFIG[s.toLowerCase()] ?? { zh: s || "未知", color: "#6b7280", bg: "#f3f4f6", icon: "📌" };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${min}`;
}

function formatFullTime(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${month}月${day}日`;
}

// ── Components ──

function LoadingSkeleton() {
  return (
    <div style={{ padding: "32px 0" }}>
      {[1, 2, 3, 4].map((i) => (
        <div key={i} style={{ display: "flex", gap: 12, marginBottom: 20, paddingLeft: 28, position: "relative" }}>
          <div style={{ position: "absolute", left: 2, top: 0, bottom: -20, width: 2, background: "#e5e7eb" }} />
          <div style={{ position: "absolute", left: -3, top: 2, width: 12, height: 12, borderRadius: "50%", background: "#e5e7eb" }} />
          <div style={{ flex: 1 }}>
            <div style={{ height: 12, width: 80, background: "#e5e7eb", borderRadius: 4, marginBottom: 6, animation: "pulse 1.5s infinite" }} />
            <div style={{ height: 14, width: "70%", background: "#f3f4f6", borderRadius: 4, marginBottom: 4 }} />
            <div style={{ height: 10, width: "40%", background: "#f9fafb", borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function TimelineNode({ item, isLast, isChild, index, total }: { item: TimelineItem; isLast: boolean; isChild?: boolean; index: number; total: number }) {
  const fromCfg = statusCfg(item.fromStatus);
  const toCfg = statusCfg(item.toStatus);
  const dotSize = isChild ? 10 : 16;

  return (
    <div style={{
      position: "relative",
      paddingBottom: isLast ? 0 : 32,
      paddingLeft: isChild ? 28 : 36,
    }}>
      {/* connecting line */}
      {!isLast && (
        <div style={{
          position: "absolute",
          left: isChild ? 12 : 16,
          top: dotSize + 8,
          bottom: 0,
          width: 2,
          background: isChild
            ? "linear-gradient(180deg, #d1d5db, #e5e7eb)"
            : `linear-gradient(180deg, ${toCfg.color}60, #e5e7eb)`,
          borderRadius: 1,
        }} />
      )}

      {/* dot ring */}
      <div style={{
        position: "absolute",
        left: isChild ? 3 : 4,
        top: 4,
        width: dotSize + 8,
        height: dotSize + 8,
        borderRadius: "50%",
        background: isLast ? `${toCfg.color}15` : `${toCfg.color}08`,
        zIndex: 0,
      }} />
      {/* dot */}
      <div style={{
        position: "absolute",
        left: isChild ? 7 : 8,
        top: 8,
        width: dotSize,
        height: dotSize,
        borderRadius: "50%",
        background: isLast ? toCfg.color : "#fff",
        border: `3px solid ${isLast ? toCfg.color : "#94a3b8"}`,
        zIndex: 1,
        boxShadow: `0 0 0 3px #fff`,
      }} />

      {/* step badge */}
      {!isChild && (
        <div style={{
          position: "absolute",
          left: -6,
          top: dotSize + 4,
          fontSize: 10,
          color: "#94a3b8",
          fontWeight: 500,
          whiteSpace: "nowrap",
        }}>
          第{index + 1}步
        </div>
      )}

      {/* content card */}
      <div style={{
        background: "#fff",
        border: `1px solid ${isLast ? toCfg.color + "40" : "#e5e7eb"}`,
        borderLeft: `3px solid ${toCfg.color}`,
        borderRadius: "8px 10px 10px 8px",
        padding: isChild ? "10px 12px" : "14px 16px",
        boxShadow: isLast
          ? `0 2px 8px ${toCfg.color}15`
          : "0 1px 3px rgba(0,0,0,0.04)",
      }}>
        {/* time */}
        <div style={{
          fontSize: isChild ? 11 : 13,
          color: "#374151",
          fontWeight: 600,
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>
          <span style={{ fontSize: 14 }}>🕐</span>
          {formatTime(item.changedAt)}
        </div>

        {/* status transition */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: item.remark ? 10 : 6,
        }}>
          <span style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 10px",
            borderRadius: 6,
            fontSize: isChild ? 11 : 12,
            fontWeight: 600,
            background: fromCfg.bg,
            color: fromCfg.color,
            border: `1px solid ${fromCfg.color}30`,
          }}>
            {fromCfg.icon} {fromCfg.zh}
          </span>
          <span style={{ color: "#94a3b8", fontSize: 16, fontWeight: 700 }}>→</span>
          <span style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 10px",
            borderRadius: 6,
            fontSize: isChild ? 11 : 12,
            fontWeight: 700,
            background: toCfg.bg,
            color: toCfg.color,
            border: `1px solid ${toCfg.color}40`,
          }}>
            {toCfg.icon} {toCfg.zh}
          </span>
        </div>

        {/* remark */}
        {item.remark ? (
          <div style={{
            fontSize: isChild ? 12 : 13,
            color: "#1e293b",
            lineHeight: 1.6,
            marginBottom: 8,
            padding: "8px 10px",
            background: "#f8fafc",
            borderRadius: 6,
            border: "1px solid #e2e8f0",
          }}>
            {item.remark}
          </div>
        ) : null}

        {/* operator */}
        {item.operatorRole !== "client" && (
          <div style={{
            fontSize: isChild ? 11 : 12,
            color: "#64748b",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}>
            <span style={{ fontSize: 13 }}>{item.operatorRole === "staff" ? "💼" : "🔧"}</span>
            <span style={{ fontWeight: 600 }}>{item.operatorName || (item.operatorRole === "staff" ? "员工" : "管理员")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TrackContent({ data }: { data: TrackData }) {
  const currentCfg = statusCfg(data.currentStatus);

  return (
    <div>
      {/* Current status banner */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 16px",
        background: `linear-gradient(135deg, ${currentCfg.bg} 0%, #ffffff 100%)`,
        borderRadius: 12,
        border: `1px solid ${currentCfg.color}30`,
        marginBottom: 16,
      }}>
        <div style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: currentCfg.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          flexShrink: 0,
          boxShadow: `0 4px 12px ${currentCfg.color}40`,
        }}>{currentCfg.icon}</div>
        <div>
          <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>当前状态</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: currentCfg.color }}>{currentCfg.zh}</div>
          {data.containers?.length > 0 && (
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
              {data.containers.map((c) => c.containerNo).join("  ｜  ")}
            </div>
          )}
        </div>
      </div>

      {/* Timeline header */}
      {data.timeline.length > 0 ? (
        <>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 12,
            paddingBottom: 8,
            borderBottom: "1px solid #e5e7eb",
          }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>📋 状态变更记录</span>
            <span style={{
              fontSize: 11,
              color: "#6b7280",
              background: "#f3f4f6",
              borderRadius: 10,
              padding: "1px 8px",
            }}>{data.timeline.length} 条</span>
          </div>

          {/* Timeline */}
          <div style={{ position: "relative" }}>
            {data.timeline.map((item, i) => (
              <TimelineNode
                key={i}
                item={item}
                isLast={i === data.timeline.length - 1}
                index={i}
                total={data.timeline.length}
              />
            ))}
          </div>
        </>
      ) : null}

      {/* Children (split shipments) */}
      {data.children && data.children.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 14,
            paddingBottom: 8,
            borderBottom: "1px solid #e5e7eb",
          }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>📦 分柜子单 ({data.children.length})</span>
          </div>

          {data.children.map((child, idx) => {
            const childCfg = statusCfg(child.currentStatus);
            return (
              <div key={idx} style={{
                marginBottom: 16,
                borderRadius: 12,
                background: "#fafbff",
                border: "1px solid #e2e8f0",
                overflow: "hidden",
              }}>
                {/* Child header */}
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  background: "linear-gradient(135deg, #eff6ff, #f8fafc)",
                  borderBottom: "1px solid #e2e8f0",
                }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#1e3a8a", fontFamily: "monospace" }}>
                      {child.trackingNo}
                    </div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                      柜号：{child.batchNo ?? "-"} ｜ {child.itemName ?? "-"} ｜ {child.packageCount ?? "-"} 件
                    </div>
                  </div>
                  <span style={{
                    padding: "3px 10px",
                    borderRadius: 20,
                    fontSize: 11,
                    fontWeight: 600,
                    background: childCfg.bg,
                    color: childCfg.color,
                    whiteSpace: "nowrap",
                  }}>
                    {childCfg.icon} {childCfg.zh}
                  </span>
                </div>

                {/* Child timeline */}
                {child.timeline?.length > 0 ? (
                  <div style={{ padding: "12px 14px", position: "relative" }}>
                    {child.timeline.map((tl, j) => (
                      <TimelineNode
                        key={j}
                        item={tl}
                        isLast={j === child.timeline.length - 1}
                        isChild
                        index={j}
                        total={child.timeline.length}
                      />
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: 16, textAlign: "center", fontSize: 12, color: "#9ca3af" }}>
                    暂无轨迹记录
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Modal wrapper ──

function ShipmentTrackModal({ trackingOrId, onClose }: { trackingOrId: string; onClose: () => void }) {
  const [data, setData] = useState<TrackData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    setData(null);
    const isUuid = /^[a-f0-9-]{20,}$/i.test(trackingOrId);
    const params = new URLSearchParams(
      isUuid ? { shipmentId: trackingOrId } : { trackingNo: trackingOrId }
    );
    fetch(`${apiBaseUrl()}/client/shipments/track?${params.toString()}`, {
      headers: { ...authHeaders() },
    })
      .then((resp) => resp.json())
      .then((json: any) => {
        if (json.code !== "OK") {
          setError(json.message || "查询失败");
          setData(null);
          setLoading(false);
          return;
        }
        if (!json.data || !json.data.trackingNo) {
          setError("未找到该运单");
          setData(null);
          setLoading(false);
          return;
        }
        setData(json.data);
        setLoading(false);
      })
      .catch((err: any) => {
        setError(err?.message || "加载失败，请重试");
        setData(null);
        setLoading(false);
      });
  }, [trackingOrId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(2px)",
        padding: 16,
        animation: "fadeIn 0.2s ease",
      }}
    >
      <div style={{
        width: "100%",
        maxWidth: 600,
        maxHeight: "88vh",
        overflow: "auto",
        background: "#fff",
        borderRadius: 16,
        boxShadow: "0 24px 80px rgba(0,0,0,0.25)",
        animation: "slideUp 0.25s ease",
      }}>
        {/* Header */}
        <div style={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "18px 22px",
          background: "linear-gradient(180deg, #ffffff, #fafbfc)",
          borderBottom: "1px solid #e5e7eb",
          borderRadius: "16px 16px 0 0",
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827" }}>物流轨迹</h3>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2, fontFamily: "monospace" }}>
              {data?.trackingNo || trackingOrId}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              background: "#fff",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
              color: "#6b7280",
              transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#f3f4f6";
              e.currentTarget.style.color = "#111827";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "#fff";
              e.currentTarget.style.color = "#6b7280";
            }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: "18px 22px 22px" }}>
          {loading ? (
            <LoadingSkeleton />
          ) : error ? (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>😞</div>
              <div style={{ fontSize: 14, color: "#b91c1c", marginBottom: 8 }}>{error}</div>
              <button
                onClick={() => load()}
                style={{
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  padding: "6px 16px",
                  background: "#fff",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "#374151",
                }}
              >
                重试
              </button>
            </div>
          ) : !data ? (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
              <div style={{ fontSize: 14, color: "#6b7280", marginBottom: 4 }}>暂无物流轨迹</div>
              <div style={{ fontSize: 12, color: "#9ca3af" }}>货物状态更新后将显示在这里</div>
            </div>
          ) : (
            <TrackContent data={data} />
          )}
        </div>
      </div>

      {/* Global animation styles */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}

// ── Public API ──

export function openShipmentTrack(trackingOrId: string) {
  // 移除旧弹窗
  const old = document.getElementById("track-modal-root");
  if (old) old.remove();

  const overlay = document.createElement("div");
  overlay.id = "track-modal-root";
  document.body.appendChild(overlay);

  try {
    const root = createRoot(overlay);
    root.render(
      <ShipmentTrackModal
        trackingOrId={trackingOrId}
        onClose={() => {
          root.unmount();
          overlay.remove();
        }}
      />,
    );
  } catch {
    overlay.innerHTML = `<div style="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);padding:16px" onclick="this.parentElement?.remove()"><div style="width:100%;max-width:500px;background:#fff;border-radius:12px;padding:24px;text-align:center"><div style="font-size:40px;margin-bottom:12px">😞</div><div style="font-size:14px;color:#b91c1c">加载失败，请刷新页面后重试</div></div></div>`;
  }
}
