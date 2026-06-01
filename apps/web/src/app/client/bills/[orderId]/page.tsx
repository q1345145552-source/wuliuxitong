"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import EmptyStateCard from "../../../../modules/layout/EmptyStateCard";
import RoleShell from "../../../../modules/layout/RoleShell";
import { formatCny } from "../../../../modules/billing/billing-utils";
import { fetchClientOrders, type OrderItem } from "../../../../services/business-api";

function getText(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value.trim() ? value : "-";
  if (typeof value === "number") return Number.isNaN(value) ? "-" : String(value);
  return String(value);
}

export default function ClientBillDetailPage() {
  const params = useParams<{ orderId?: string }>();
  const orderId = params?.orderId ? decodeURIComponent(String(params.orderId)) : "";
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [order, setOrder] = useState<OrderItem | null>(null);

  useEffect(() => {
    if (!orderId) return;
    setLoading(true);
    setMessage("");
    Promise.all([fetchClientOrders({ statusGroup: "unfinished" }), fetchClientOrders({ statusGroup: "completed" })])
      .then(([unfinished, completed]) => {
        const all = [...unfinished, ...completed];
        const found = all.find((item) => item.id === orderId) ?? null;
        setOrder(found);
        if (!found) setMessage("未找到该订单账单（可能无权限或订单不存在）。");
      })
      .catch((error) => {
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      })
      .finally(() => setLoading(false));
  }, [orderId]);

  const amount = useMemo(() => (order ? (order.receivableAmountCny ?? null) : null), [order]);
  const paymentLabel = useMemo(() => {
    const status = order?.paymentStatus ?? "unpaid";
    return status === "paid" ? "已付款" : "待付款";
  }, [order]);
  const warehouseOptions = [
    { id: "wh_yiwu_01", label: "义乌仓" },
    { id: "wh_guangzhou_01", label: "广州仓" },
    { id: "wh_dongguan_01", label: "东莞仓" },
  ] as const;
  const warehouseLabel = (warehouseId?: string): string => {
    if (!warehouseId) return "-";
    return warehouseOptions.find((w) => w.id === warehouseId)?.label ?? warehouseId;
  };

  return (
    <RoleShell allowedRole="client" title="账单详情">
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <a
          href="/client/bills"
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: 10,
            padding: "8px 12px",
            background: "#fff",
            textDecoration: "none",
            color: "#0f172a",
            fontWeight: 600,
          }}
        >
          返回账单列表
        </a>
        <a
          href="/client"
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: 10,
            padding: "8px 12px",
            background: "#fff",
            textDecoration: "none",
            color: "#0f172a",
            fontWeight: 600,
          }}
        >
          返回订单查询
        </a>
      </div>

      {message ? <p style={{ color: "#b91c1c" }}>{message}</p> : null}

      {!loading && !order ? <EmptyStateCard title="暂无数据" description="请从账单列表进入，或确认订单号是否正确。" /> : null}

      {order ? (
        <section style={{ border: "1px solid #dbeafe", borderRadius: 12, padding: 12, background: "#f8fbff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ fontWeight: 800, color: "#0f172a", fontSize: 16 }}>订单：{order.id}</div>
            <div className="order-badges">
              <span className="order-badge order-badge-amount">订单金额：{formatCny(amount)}</span>
              <span className={`order-badge ${(order.paymentStatus ?? "unpaid") === "paid" ? "order-badge-paid" : "order-badge-unpaid"}`}>
                {paymentLabel}
              </span>
            </div>
          </div>

          <p style={{ margin: "10px 0 0 0", color: "#000000", fontSize: 13 }}>
            本页展示订单全部基础信息（尤其是金额），不展示物流状态与轨迹记录。
          </p>

          <div style={{ marginTop: 10 }} className="order-fields">
            <div className="order-field">
              <div className="order-field-label">仓库</div>
              <div className="order-field-value">{warehouseLabel(order.warehouseId)}</div>
            </div>
            <div className="order-field">
              <div className="order-field-label">柜号</div>
              <div className="order-field-value">{getText(order.batchNo)}</div>
            </div>
            <div className="order-field">
              <div className="order-field-label">订单编号</div>
              <div className="order-field-value">{getText(order.orderNo)}</div>
            </div>
            <div className="order-field">
              <div className="order-field-label">品名</div>
              <div className="order-field-value">{getText(order.itemName)}</div>
            </div>
            <div className="order-field">
              <div className="order-field-label">运输方式</div>
              <div className="order-field-value">
                {order.transportMode === "sea" ? "海运" : order.transportMode === "land" ? "陆运" : getText(order.transportMode)}
              </div>
            </div>
            <div className="order-field">
              <div className="order-field-label">包裹数量</div>
              <div className="order-field-value">
                {getText(order.packageCount)} {getText(order.packageUnit)}
              </div>
            </div>
            <div className="order-field">
              <div className="order-field-label">重量</div>
              <div className="order-field-value">{getText(order.weightKg)} kg</div>
            </div>
          </div>
        </section>
      ) : null}
    </RoleShell>
  );
}

