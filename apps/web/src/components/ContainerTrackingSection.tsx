"use client";

/**
 * 出柜追踪组件 — 客户端"我的订单"卡片里显示该订单运单所属的柜子。
 *
 * 数据来源：GET /client/shipments/track?shipmentId=xxx 或 trackingNo=xxx
 * 拆柜提示：当 splitCount > 1 时自动显示"⚡ 此订单分 N 柜运送"
 *
 * 用法：
 *   <ContainerTrackingSection shipmentId={item.id} trackingNo={item.trackingNo} />
 */

import { useEffect, useState } from "react";
import { apiBaseUrl, authHeaders } from "../services/core-api";

type ContainerInfo = {
  containerId: string;
  containerNo: string;
  containerType: string;
  carrierName?: string | null;
  loadedVolumeM3: number;
  loadedPieceCount: number;
  containerStatus: string;
  containerStatusLabel: string;
  loadingDate: string | null;
  departureDate: string | null;
  eta: string | null;
  ata: string | null;
  customsClearedAt: string | null;
};

type TrackData = {
  shipmentId: string;
  trackingNo: string;
  totalVolumeM3: number;
  totalLoadedM3: number;
  isSplit: boolean;
  splitCount: number;
  containers: ContainerInfo[];
};

interface Props {
  /** 优先用 shipmentId 查询，没有则用 trackingNo */
  shipmentId?: string;
  trackingNo?: string;
  hideContainerNo?: boolean;
}

/** 柜子状态 → 颜色映射 */
function statusColor(status: string): { bg: string; fg: string; border: string } {
  switch (status) {
    case "LOADING":
      return { bg: "#fef3c7", fg: "#92400e", border: "#fde68a" };
    case "SEALED":
      return { bg: "#e0f2fe", fg: "#0369a1", border: "#7dd3fc" };
    case "IN_TRANSIT":
      return { bg: "#dbeafe", fg: "#1d4ed8", border: "#bfdbfe" };
    case "DELAY_DEPARTED":
      return { bg: "#fef3c7", fg: "#b45309", border: "#fde68a" };
    case "ARRIVED":
      return { bg: "#cffafe", fg: "#0e7490", border: "#a5f3fc" };
    case "CUSTOMS":
      return { bg: "#fce7f3", fg: "#9d174d", border: "#fbcfe8" };
    case "CUSTOMS_CLEARED":
      return { bg: "#dcfce7", fg: "#166534", border: "#bbf7d0" };
    case "IN_WAREHOUSE_TH":
      return { bg: "#ede9fe", fg: "#7c3aed", border: "#c4b5fd" };
    case "DELIVERING":
      return { bg: "#fed7aa", fg: "#9a3412", border: "#fdba74" };
    case "SIGNED":
      return { bg: "#dcfce7", fg: "#166534", border: "#bbf7d0" };
    default:
      return { bg: "#f1f5f9", fg: "#000000", border: "#e2e8f0" };
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export function ContainerTrackingSection({ shipmentId, trackingNo, hideContainerNo }: Props) {
  const [data, setData] = useState<TrackData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (shipmentId) params.set("shipmentId", shipmentId);
    else if (trackingNo) params.set("trackingNo", trackingNo);
    else {
      setLoading(false);
      setError("缺少 shipmentId/trackingNo");
      return;
    }

    fetch(`${apiBaseUrl()}/client/shipments/track?${params.toString()}`, {
      headers: { ...authHeaders() },
    })
      .then(async (resp) => {
        const json = await resp.json();
        if (cancelled) return;
        if (json.code === "OK") {
          setData(json.data as TrackData);
        } else {
          setError(json.message || "加载失败");
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "网络错误");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [shipmentId, trackingNo]);

  if (loading) {
    return (
      <div style={{ padding: 10, color: "#94a3b8", fontSize: 13 }}>
        正在查询出柜信息…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 10, color: "#dc2626", fontSize: 13 }}>
        出柜信息加载失败：{error}
      </div>
    );
  }

  if (!data || data.containers.length === 0) {
    return (
      <div
        style={{
          padding: "10px 12px",
          color: "#64748b",
          fontSize: 13,
          background: "#f8fafc",
          border: "1px dashed #cbd5e1",
          borderRadius: 8,
        }}
      >
        暂未装柜（货物还在仓库集货中）
      </div>
    );
  }

  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        background: "#fafbff",
        padding: 12,
      }}
    >
      {/* 标题 + 拆柜提示 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#1e293b" }}>
          出柜追踪
          <span style={{ marginLeft: 8, color: "#64748b", fontWeight: 400, fontSize: 12 }}>
            总量 {data.totalVolumeM3.toFixed(2)} m³ · 已装 {data.totalLoadedM3.toFixed(2)} m³
          </span>
        </div>
        {data.isSplit ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 10px",
              borderRadius: 999,
              background: "linear-gradient(90deg, #fef3c7, #fde68a)",
              color: "#92400e",
              fontSize: 12,
              fontWeight: 700,
              border: "1px solid #fcd34d",
            }}
          >
            ⚡ 此订单分 {data.splitCount} 柜运送
          </span>
        ) : null}
      </div>

      {/* 柜子卡片列表 */}
      <div style={{ display: "grid", gap: 8 }}>
        {data.containers.map((c, idx) => {
          const color = statusColor(c.containerStatus);
          return (
            <div
              key={c.containerId}
              style={{
                border: `1px solid ${color.border}`,
                borderRadius: 8,
                padding: "10px 12px",
                background: "#fff",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 8,
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, color: "#0f172a", fontSize: 14 }}>
                    柜 {idx + 1}{hideContainerNo ? "" : `：${c.containerNo}`}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "1px 7px",
                      borderRadius: 4,
                      background: "#f1f5f9",
                      color: "#000000",
                      fontWeight: 600,
                    }}
                  >
                    {c.containerType}
                  </span>
                  {c.carrierName ? (
                    <span style={{ fontSize: 12, color: "#475569", fontWeight: 500 }}>
                      {c.carrierName}
                    </span>
                  ) : null}
                  <span
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: color.bg,
                      color: color.fg,
                      fontWeight: 600,
                      border: `1px solid ${color.border}`,
                    }}
                  >
                    {c.containerStatusLabel}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#64748b", display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
                  <span>本柜 {c.loadedVolumeM3.toFixed(2)} m³ · {c.loadedPieceCount} 件</span>
                  <span>装柜 {formatDate(c.loadingDate)}</span>
                  <span>开船 {formatDate(c.departureDate)}</span>
                  <span>
                    {c.ata ? `到港 ${formatDate(c.ata)}` : `预计到港 ${formatDate(c.eta)}`}
                  </span>
                  {c.customsClearedAt ? <span>清关 {formatDate(c.customsClearedAt)}</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
