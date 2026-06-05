"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import EmptyStateCard from "../../../modules/layout/EmptyStateCard";
import RoleShell from "../../../modules/layout/RoleShell";
import { formatCny } from "../../../modules/billing/billing-utils";
import { fetchClientOrders, type OrderItem } from "../../../services/business-api";

function uniqueById(items: OrderItem[]): OrderItem[] {
  const seen = new Set<string>();
  const result: OrderItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export default function ClientBillsPage() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [filters, setFilters] = useState({
    orderId: "",
    warehouseId: "",
    transportMode: "",
  });
  const [payTab, setPayTab] = useState<"unpaid" | "paid">("unpaid");

  const warehouseOptions = [
    { id: "wh_yiwu_01", label: "义乌仓" },
    { id: "wh_guangzhou_01", label: "广州仓" },
    { id: "wh_dongguan_01", label: "东莞仓" },
  ] as const;
  const warehouseLabel = (warehouseId?: string): string => {
    if (!warehouseId) return "-";
    return warehouseOptions.find((w) => w.id === warehouseId)?.label ?? warehouseId;
  };

  useEffect(() => {
    setLoading(true);
    setMessage("");
    Promise.all([fetchClientOrders({ statusGroup: "unfinished" }), fetchClientOrders({ statusGroup: "completed" })])
      .then(([unfinished, completed]) => {
        const merged = uniqueById([...unfinished, ...completed]);
        merged.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
        setOrders(merged);
      })
      .catch((error) => {
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const orderIdKey = filters.orderId.trim().toLowerCase();
    const batchKey = filters.batchNo.trim().toLowerCase();
    const warehouseId = filters.warehouseId.trim();
    const transportMode = filters.transportMode.trim();
    return orders
      .filter((item) => {
        const status = item.paymentStatus ?? "unpaid";
        return status === payTab;
      })
      .filter((item) => !orderIdKey || item.id.toLowerCase().includes(orderIdKey))
      .filter((item) => !warehouseId || (item.warehouseId ?? "") === warehouseId)
      .filter((item) => !transportMode || (item.transportMode ?? "") === transportMode);
  }, [filters.orderId, filters.transportMode, filters.warehouseId, orders, payTab]);

  const exportBillsExcel = () => {
    const rows = filtered.map((item, idx) => ({
      序号: idx + 1,
      订单号: item.id,
      仓库: warehouseLabel(item.warehouseId),

      订单编号: item.orderNo ?? "-",
      品名: item.itemName ?? "-",
      运输方式: item.transportMode === "sea" ? "海运" : item.transportMode === "land" ? "陆运" : item.transportMode ?? "-",
      包裹数量: `${item.packageCount ?? "-"} ${item.packageUnit ?? ""}`.trim(),
      重量kg: item.weightKg ?? "-",
      金额: typeof item.receivableAmountCny === "number" ? item.receivableAmountCny.toFixed(2) : "-",
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "客户账单");
    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `客户账单_${today}.xlsx`);
  };

  return (
    <RoleShell allowedRole="client" title="我的账单">
      <p style={{ marginTop: 0, color: "#000000", fontSize: 13 }}>
        账单页只展示订单信息与金额，不包含物流状态/轨迹（避免把物流进度当作账单要素）。
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
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
          返回运单查询
        </a>
        <button
          type="button"
          onClick={() => setPayTab("unpaid")}
          style={{
            border: "none",
            borderRadius: 999,
            padding: "6px 14px",
            color: "#fff",
            background: payTab === "unpaid" ? "#2563eb" : "#000000",
            fontWeight: 800,
          }}
        >
          待付款
        </button>
        <button
          type="button"
          onClick={() => setPayTab("paid")}
          style={{
            border: "none",
            borderRadius: 999,
            padding: "6px 14px",
            color: "#fff",
            background: payTab === "paid" ? "#2563eb" : "#000000",
            fontWeight: 800,
          }}
        >
          已付款
        </button>
        <input
          value={filters.orderId}
          onChange={(e) => setFilters((v) => ({ ...v, orderId: e.target.value }))}
          placeholder="订单号"
          style={{ flex: 1, minWidth: 180, border: "1px solid #d1d5db", borderRadius: 10, padding: "8px 10px" }}
        />

        <select
          value={filters.warehouseId}
          onChange={(e) => setFilters((v) => ({ ...v, warehouseId: e.target.value }))}
          style={{ border: "1px solid #d1d5db", borderRadius: 10, padding: "8px 10px", minWidth: 150 }}
        >
          <option value="">仓库（全部）</option>
          {warehouseOptions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <select
          value={filters.transportMode}
          onChange={(e) => setFilters((v) => ({ ...v, transportMode: e.target.value }))}
          style={{ border: "1px solid #d1d5db", borderRadius: 10, padding: "8px 10px", minWidth: 150 }}
        >
          <option value="">运输方式（全部）</option>
          <option value="sea">海运</option>
          <option value="land">陆运</option>
        </select>
        <button
          type="button"
          disabled={filtered.length === 0}
          onClick={exportBillsExcel}
          style={{
            border: "none",
            borderRadius: 10,
            padding: "8px 12px",
            background: filtered.length === 0 ? "#000000" : "#0f766e",
            color: "#fff",
            fontWeight: 800,
            cursor: filtered.length === 0 ? "not-allowed" : "pointer",
          }}
          title={filtered.length === 0 ? "暂无可导出的账单数据" : "导出当前筛选结果"}
        >
          导出Excel
        </button>
        <button
          type="button"
          onClick={() =>
            setFilters({
              orderId: "",
              warehouseId: "",
              transportMode: "",
            })
          }
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: 10,
            padding: "8px 12px",
            background: "#fff",
            color: "#0f172a",
            fontWeight: 700,
          }}
        >
          清空筛选
        </button>
      </div>

      {message ? <p style={{ color: "#b91c1c" }}>{message}</p> : null}

      {!loading && filtered.length === 0 ? (
        <EmptyStateCard title="暂无账单数据" description="当前没有可展示的订单账单，或搜索条件无匹配。" />
      ) : null}

      {filtered.map((item, idx) => {
        const amount = item.receivableAmountCny ?? null;
        const paymentLabel = (item.paymentStatus ?? "unpaid") === "paid" ? "已付款" : "待付款";
        return (
          <article key={item.id} className="order-card">
            <div className="order-head">
              <div className="order-title">#{idx + 1} 订单 {item.id}</div>
              <div className="order-badges">
                <span className="order-badge order-badge-amount">金额：{formatCny(amount)}</span>
                <span className={`order-badge ${(item.paymentStatus ?? "unpaid") === "paid" ? "order-badge-paid" : "order-badge-unpaid"}`}>
                  {paymentLabel}
                </span>
                <a
                  href={`/client/bills/${encodeURIComponent(item.id)}`}
                  style={{
                    border: "1px solid #bfdbfe",
                    borderRadius: 999,
                    padding: "3px 10px",
                    background: "#eff6ff",
                    color: "#1d4ed8",
                    textDecoration: "none",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  查看账单
                </a>
              </div>
            </div>

            <div className="order-fields">
              <div className="order-field">
                <div className="order-field-label">仓库</div>
                <div className="order-field-value">{warehouseLabel(item.warehouseId)}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">订单编号</div>
                <div className="order-field-value">{item.orderNo ?? "-"}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">品名</div>
                <div className="order-field-value">{item.itemName}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">运输方式</div>
                <div className="order-field-value">
                  {item.transportMode === "sea" ? "海运" : item.transportMode === "land" ? "陆运" : item.transportMode ?? "-"}
                </div>
              </div>
              <div className="order-field">
                <div className="order-field-label">包裹数量</div>
                <div className="order-field-value">
                  {item.packageCount} {item.packageUnit}
                </div>
              </div>
              <div className="order-field">
                <div className="order-field-label">重量</div>
                <div className="order-field-value">{item.weightKg ?? "-"} kg</div>
              </div>
            </div>
          </article>
        );
      })}
    </RoleShell>
  );
}

