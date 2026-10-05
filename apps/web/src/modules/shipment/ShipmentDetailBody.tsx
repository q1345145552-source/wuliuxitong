"use client";

import type { ReactNode } from "react";
import { formatMetric, warehouseLabelFromId } from "../staff/utils";
import { apiBaseUrl } from "../../services/core-api";

/**
 * 「运单详情」弹窗里的正文：基本信息、产品明细、产品图片。
 * 原来写在客户「运单查询」页面里（client/page.tsx），2026-10-06 抽出来共用：
 * 客服对话里点运单卡片弹的详情（老板拍板「1A」：跟运单查询里点开的一样）也用这一份，两边永远一个样。
 * 员工那头（「2 要」）也用它，前面多一格唛头（extraFields）；员工那头的数据没有审批状态，那一格就不出。
 */

export interface ShipmentDetailProduct {
  id?: string;
  itemName?: string | null;
  packageCount?: number | null;
  productQuantity?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  weightKg?: number | string | null;
  cargoType?: string | null;
  domesticTrackingNo?: string | null;
}

export interface ShipmentDetailData {
  warehouseId?: string | null;
  trackingNo?: string | null;
  orderNo?: string | null;
  /** 客户那头才有；没有（undefined）就不出这一格 */
  approvalStatus?: string | null;
  transportMode?: string | null;
  domesticTrackingNo?: string | null;
  shipDate?: string | null;
  cargoType?: string | null;
  receiverAddressTh?: string | null;
  products?: ShipmentDetailProduct[] | null;
}

export interface ShipmentDetailImage {
  id: string;
  fileName: string;
  imageUrl?: string | null;
}

function imgSrc(img: { imageUrl?: string | null }): string {
  return img.imageUrl ? apiBaseUrl() + img.imageUrl : "";
}

export default function ShipmentDetailBody({ item, images, onPreview, extraFields = [] }: {
  item: ShipmentDetailData;
  images: ShipmentDetailImage[];
  /** 点产品图看大图 */
  onPreview: (src: string, alt: string) => void;
  /** 基本信息最前面多加的几格（员工那头的唛头） */
  extraFields?: Array<{ label: string; value: ReactNode }>;
}) {
  const cargoTypeLabel = item.cargoType === "inspection" ? "商检货" : item.cargoType === "sensitive" ? "敏感货" : "普货";
  return (
    <div>
      {/* 基本信息 */}
      <h4 style={{ margin: "0 0 8px", fontSize: 14, color: "var(--t-body)" }}>基本信息</h4>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "6px 16px", marginBottom: 12 }}>
        {extraFields.map((f) => (
          <div key={f.label}><span style={{ color: "var(--t-muted)", fontSize: 12 }}>{f.label}：</span>{f.value}</div>
        ))}
        <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>仓库：</span>{warehouseLabelFromId(item.warehouseId ?? undefined)}</div>
        {/* 2026-08-07 删除「批次号」：它存的就是柜号，用户要求客户不能看到柜号。
            后端 /client/orders 已同时不再下发 batchNo，两边一起改，不留半截。 */}
        <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>运单号：</span>{item.trackingNo || "—"}</div>
        <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>预报单号：</span>{item.orderNo || "—"}</div>
        {item.approvalStatus !== undefined ? (
          <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>审批状态：</span>{item.approvalStatus === "shipped" ? "已发货" : item.approvalStatus === "approved" ? "已审核" : item.approvalStatus === "received" ? "已收货" : item.approvalStatus || "—"}</div>
        ) : null}
        <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>运输方式：</span>{item.transportMode === "sea" ? "海运" : item.transportMode === "land" ? "陆运" : item.transportMode || "—"}</div>
        <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>国内单号：</span>{(item.products?.length ?? 0) > 0 ? (item.products ?? []).map((p) => p.domesticTrackingNo || "—").filter(Boolean).join("、") || "—" : (item.domesticTrackingNo || "—")}</div>
        <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>发货日期：</span>{item.shipDate || "—"}</div>
        <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>货型：</span>{cargoTypeLabel}</div>
        <div><span style={{ color: "var(--t-muted)", fontSize: 12 }}>收货地址：</span>{item.receiverAddressTh || "—"}</div>
      </div>
      {/* 产品明细 */}
      {(item.products?.length ?? 0) > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 14, color: "var(--t-body)" }}>产品明细</h4>
          <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr style={{ background: "var(--s-cool-2)" }}>
              <th style={{ padding: "4px 6px", textAlign: "left" }}>品名</th>
              <th style={{ padding: "4px 6px", textAlign: "center" }}>件数</th>
              <th style={{ padding: "4px 6px", textAlign: "center" }}>单箱数量</th>
              <th style={{ padding: "4px 6px", textAlign: "center" }}>尺寸(cm)</th>
              <th style={{ padding: "4px 6px", textAlign: "center" }}>重量(kg)</th>
              <th style={{ padding: "4px 6px", textAlign: "center" }}>货型</th>
              <th style={{ padding: "4px 6px", textAlign: "center" }}>国内单号</th>
            </tr></thead>
            <tbody>
              {(item.products ?? []).map((p, i) => (
                <tr key={p.id || i} style={{ borderBottom: "1px solid var(--l-soft)" }}>
                  <td style={{ padding: "4px 6px" }}>{p.itemName}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center" }}>{p.packageCount}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center" }}>{p.productQuantity ?? "—"}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center", fontSize: 11 }}>{p.lengthCm && p.widthCm && p.heightCm ? `${p.lengthCm}×${p.widthCm}×${p.heightCm}` : "—"}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center" }}>{formatMetric(p.weightKg as number | null | undefined, 2)}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center" }}>{p.cargoType === "inspection" ? "商检货" : p.cargoType === "sensitive" ? "敏感货" : "普货"}</td>
                  <td style={{ padding: "4px 6px", textAlign: "center", fontSize: 11 }}>{p.domesticTrackingNo || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {/* 产品图片 */}
      <div>
        <h4 style={{ margin: "0 0 8px", fontSize: 14, color: "var(--t-body)" }}>产品图片</h4>
        {images.length === 0 ? <span style={{ fontSize: 12, color: "var(--t-faint)" }}>暂无</span> : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {images.map((img) => (
              <img key={img.id} src={imgSrc(img)} alt={img.fileName} onClick={() => onPreview(imgSrc(img), img.fileName)} style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 6, border: "1px solid var(--l-soft)", cursor: "pointer" }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
