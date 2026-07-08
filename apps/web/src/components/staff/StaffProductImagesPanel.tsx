"use client";

import { useRef } from "react";
import type { OrderProductImagesPanelProps } from "../../modules/staff/types";
import { MAX_ORDER_PRODUCT_IMAGES } from "../../modules/staff/types";
import { apiBaseUrl } from "../../services/core-api";

/**
 * 订单详情产品图：展示、上传与删除。
 */
export default function StaffProductImagesPanel(props: OrderProductImagesPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgs = props.images ?? [];
  const canAdd = props.canManage && imgs.length < MAX_ORDER_PRODUCT_IMAGES;
  return (
    <div style={{ marginTop: 8, marginBottom: 8, padding: 10, background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13, color: "#000000" }}>
        订单详情 · 产品图（最多 {MAX_ORDER_PRODUCT_IMAGES} 张）
      </div>
      {imgs.length === 0 && !canAdd ? (
        <div style={{ fontSize: 12, color: "#000000" }}>暂无产品图</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
          {imgs.map((img) => (
            <div key={img.id}>
              <img
                src={img.imageUrl ? `${apiBaseUrl()}${img.imageUrl}` : ""}
                alt={img.fileName}
                style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 8, border: "1px solid #e5e7eb", display: "block" }}
              />
              {props.canManage ? (
                <button
                  type="button"
                  disabled={props.busy}
                  onClick={() => void props.onDelete(img.id)}
                  style={{
                    marginTop: 4,
                    width: "100%",
                    border: "1px solid #fecaca",
                    borderRadius: 6,
                    padding: "2px 4px",
                    fontSize: 11,
                    background: "#fff",
                    color: "#b91c1c",
                    cursor: props.busy ? "not-allowed" : "pointer",
                  }}
                >
                  删除
                </button>
              ) : null}
            </div>
          ))}
          {canAdd ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                disabled={props.busy}
                style={{ position: "absolute", width: 0, height: 0, opacity: 0, pointerEvents: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void props.onSelectFile(f);
                }}
              />
              <button
                type="button"
                disabled={props.busy}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  width: 88,
                  height: 88,
                  border: "1px dashed #000000",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  color: "#000000",
                  cursor: props.busy ? "not-allowed" : "pointer",
                  background: "#fff",
                }}
              >
                {props.busy ? "…" : "+ 上传"}
              </button>
            </>
          ) : null}
        </div>
      )}
      {!props.canManage ? <div style={{ fontSize: 12, color: "#000000", marginTop: 6 }}>仅展示；无本仓库操作权限时不可修改（与上传接口校验的订单仓库一致）。</div> : null}
    </div>
  );
}
