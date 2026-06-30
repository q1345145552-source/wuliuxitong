"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import EmptyStateCard from "../../../modules/layout/EmptyStateCard";
import RoleShell from "../../../modules/layout/RoleShell";
import { formatCny } from "../../../modules/billing/billing-utils";
import { fetchClientOrders, fetchClientWalletOverview, type OrderItem } from "../../../services/business-api";
import { apiBaseUrl, authHeaders } from "../../../services/core-api";

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
    trackingNo: "",
    warehouseId: "",
    transportMode: "",
  });
  const [payTab, setPayTab] = useState<"unpaid" | "paid">("unpaid");
  const [payModal, setPayModal] = useState<{ orderId: string; trackingNo: string; amount: number } | null>(null);
  const [payMethod, setPayMethod] = useState<"balance" | "offline">("balance");
  const [payProof, setPayProof] = useState<string | null>(null);
  const [paySubmitting, setPaySubmitting] = useState(false);
  const [payError, setPayError] = useState("");
  const [walletBalance, setWalletBalance] = useState(0);
  const payFileRef = useRef<HTMLInputElement>(null);

  const loadOrders = async () => {
    setLoading(true);
    setMessage("");
    try {
      const [unfinished, completed] = await Promise.all([fetchClientOrders({ statusGroup: "unfinished" }), fetchClientOrders({ statusGroup: "completed" })]);
      const merged = uniqueById([...unfinished, ...completed]);
      merged.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      setOrders(merged);
    } catch (error) {
      const text = error instanceof Error ? error.message : "加载失败";
      setMessage(`加载失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const handlePay = async () => {
    if (!payModal || paySubmitting) return;
    if (payMethod === "offline" && !payProof) { setPayError("请上传付款凭证"); return; }
    setPaySubmitting(true);
    setPayError("");
    try {
      const res = await fetch(`${apiBaseUrl()}/client/orders/pay`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ orderId: payModal.orderId, method: payMethod, proofImage: payMethod === "offline" ? payProof : undefined }),
      });
      const data = await res.json();
      if (data.code !== "OK") throw new Error(data.message || "付款失败");
      setMessage(data.data?.message || "付款成功");
      setPayModal(null);
      setPayProof(null);
      await loadOrders();
    } catch (e: any) { setPayError(e.message || "付款失败"); }
    finally { setPaySubmitting(false); }
  };

  const openPayModal = async (item: OrderItem) => {
    setPayModal({ orderId: item.id, trackingNo: item.trackingNo || item.orderNo || "—", amount: item.receivableAmountCny ?? 0 });
    try {
      const wallet = await fetchClientWalletOverview();
      setWalletBalance(wallet.accounts.find((a) => a.currency === "CNY")?.balance ?? 0);
    } catch { setWalletBalance(0); }
  };

  const warehouseOptions = [
    { id: "wh_yiwu_01", label: "义乌仓" },
    { id: "wh_guangzhou_01", label: "广州仓" },
    { id: "wh_dongguan_01", label: "东莞仓" },
  ] as const;
  const warehouseLabel = (warehouseId?: string): string => {
    if (!warehouseId) return "-";
    return warehouseOptions.find((w) => w.id === warehouseId)?.label ?? warehouseId;
  };

  useEffect(() => { loadOrders(); }, []);

  const filtered = useMemo(() => {
    const orderIdKey = filters.trackingNo.trim().toLowerCase();
    const warehouseId = filters.warehouseId.trim();
    const transportMode = filters.transportMode.trim();
    return orders
      .filter((item) => {
        const status = item.paymentStatus ?? "unpaid";
        return status === payTab;
      })
      .filter((item) => !orderIdKey || (item.trackingNo ?? "").toLowerCase().includes(orderIdKey))
      .filter((item) => !warehouseId || (item.warehouseId ?? "") === warehouseId)
      .filter((item) => !transportMode || (item.transportMode ?? "") === transportMode);
  }, [filters.trackingNo, filters.transportMode, filters.warehouseId, orders, payTab]);

  const exportBillsExcel = () => {
    const rows = filtered.map((item, idx) => ({
      序号: idx + 1,
      运单号: item.trackingNo ?? "-",
      仓库: warehouseLabel(item.warehouseId),
      预报单号: item.orderNo ?? "-",
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
          value={filters.trackingNo}
          onChange={(e) => setFilters((v) => ({ ...v, trackingNo: e.target.value }))}
          placeholder="运单号"
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
              trackingNo: "",
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

      {loading && filtered.length === 0 ? (
        <p style={{ color: "#6b7280", fontSize: 13, padding: 20, textAlign: "center" }}>加载中...</p>
      ) : !loading && filtered.length === 0 ? (
        <EmptyStateCard title="暂无账单数据" description="当前没有可展示的订单账单，或搜索条件无匹配。" />
      ) : null}

      {filtered.map((item, idx) => {
        const amount = item.receivableAmountCny ?? null;
        const paymentLabel = (item.paymentStatus ?? "unpaid") === "paid" ? "已付款" : "待付款";
        return (
          <article key={item.id} className="order-card">
            <div className="order-head">
              <div className="order-title">#{idx + 1} 运单 {item.trackingNo || item.orderNo || "-"}</div>
              <div className="order-badges">
                <span className="order-badge order-badge-amount">金额：{formatCny(amount)}</span>
                <span className={`order-badge ${(item.paymentStatus ?? "unpaid") === "paid" ? "order-badge-paid" : "order-badge-unpaid"}`}>
                  {paymentLabel}
                </span>
                {(item.paymentStatus ?? "unpaid") !== "paid" && (
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
                )}
                {item.paymentProofUploadedAt && (item.paymentStatus ?? "unpaid") !== "paid" ? (
                  <span style={{ fontSize: 11, color: "#d97706", background: "#fef3c7", padding: "2px 8px", borderRadius: 999, marginLeft: 6 }}>凭证待审核</span>
                ) : (item.paymentStatus ?? "unpaid") !== "paid" && amount && amount > 0 ? (
                  <button
                    type="button"
                    onClick={() => openPayModal(item)}
                    style={{ border: "none", borderRadius: 999, padding: "3px 10px", background: "#16a34a", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", marginLeft: 6 }}
                  >
                    付款
                  </button>
                ) : null}
              </div>
            </div>

            <div className="order-fields">
              <div className="order-field">
                <div className="order-field-label">仓库</div>
                <div className="order-field-value">{warehouseLabel(item.warehouseId)}</div>
              </div>
              <div className="order-field">
                <div className="order-field-label">运单号</div>
                <div className="order-field-value">{item.trackingNo || "-"}</div>
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
      {/* 付款弹窗 */}
      {payModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 440, background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>付款</h3>
            <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 12 }}>运单 {payModal.trackingNo} · 金额 ¥{payModal.amount.toFixed(2)}</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button type="button" onClick={() => setPayMethod("balance")} style={{ flex: 1, padding: 12, borderRadius: 8, border: payMethod === "balance" ? "2px solid #2563eb" : "1px solid #d1d5db", background: payMethod === "balance" ? "#eff6ff" : "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>💰 余额支付</button>
              <button type="button" onClick={() => setPayMethod("offline")} style={{ flex: 1, padding: 12, borderRadius: 8, border: payMethod === "offline" ? "2px solid #2563eb" : "1px solid #d1d5db", background: payMethod === "offline" ? "#eff6ff" : "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>📎 线下支付</button>
            </div>
            {payMethod === "offline" && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", marginBottom: 6, fontWeight: 500, fontSize: 14 }}>上传付款凭证</label>
                <input ref={payFileRef} type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) { const r = new FileReader(); r.onload = () => setPayProof(r.result as string); r.readAsDataURL(f); } }} />
                {payProof && <img src={payProof} alt="凭证" style={{ width: "100%", maxHeight: 160, objectFit: "contain", borderRadius: 8, border: "1px solid #e5e7eb", marginTop: 8 }} />}
              </div>
            )}
            {payMethod === "balance" && <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>当前 CNY 余额：<strong>¥{walletBalance.toFixed(2)}</strong>{walletBalance < payModal.amount ? <span style={{ color: "#dc2626", marginLeft: 8 }}>余额不足</span> : <span style={{ color: "#16a34a", marginLeft: 8 }}>余额充足</span>}<br />将扣除 ¥{payModal.amount.toFixed(2)}</p>}
            {payError && <p style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{payError}</p>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => { setPayModal(null); setPayProof(null); setPayError(""); }} disabled={paySubmitting} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 16px", background: "#fff", cursor: "pointer", fontSize: 13 }}>取消</button>
              <button type="button" onClick={handlePay} disabled={paySubmitting} style={{ border: "none", borderRadius: 8, padding: "8px 20px", background: paySubmitting ? "#6b7280" : "#16a34a", color: "#fff", fontWeight: 600, cursor: paySubmitting ? "not-allowed" : "pointer", fontSize: 14, opacity: paySubmitting ? 0.7 : 1 }}>{paySubmitting ? "处理中..." : "确认支付"}</button>
            </div>
          </div>
        </div>
      )}
    </RoleShell>
  );
}

