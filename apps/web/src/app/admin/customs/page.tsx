"use client";

import { useEffect, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { createAdminCustomsCase, fetchAdminCustomsCases, type AdminCustomsCaseItem } from "../../../services/business-api";

/**
 * 关务监控页面。
 */
export default function AdminCustomsPage() {
  const [items, setItems] = useState<AdminCustomsCaseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    shipmentId: "",
    orderId: "",
    status: "inspection",
    remark: "",
  });

  /**
   * 刷新关务监控列表。
   */
  const reload = async () => {
    const list = await fetchAdminCustomsCases();
    setItems(list);
  };

  useEffect(() => {
    setLoading(true);
    reload().finally(() => setLoading(false));
  }, []);

  return (
    <RoleShell allowedRole="admin" title="关务监控">
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>报关状态录入</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8 }}>
          <input value={form.shipmentId} onChange={(e) => setForm((v) => ({ ...v, shipmentId: e.target.value }))} placeholder="运单ID（可选）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.orderId} onChange={(e) => setForm((v) => ({ ...v, orderId: e.target.value }))} placeholder="订单ID（可选）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <select value={form.status} onChange={(e) => setForm((v) => ({ ...v, status: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}>
            <option value="inspection">查验</option>
            <option value="released">放行</option>
            <option value="pending">待处理</option>
          </select>
          <input value={form.remark} onChange={(e) => setForm((v) => ({ ...v, remark: e.target.value }))} placeholder="备注（通知客服原因）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
        </div>
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await createAdminCustomsCase({
                  shipmentId: form.shipmentId.trim() || undefined,
                  orderId: form.orderId.trim() || undefined,
                  status: form.status,
                  remark: form.remark.trim() || undefined,
                });
                await reload();
                setMessage("关务状态已更新");
              } catch (error) {
                const text = error instanceof Error ? error.message : "更新失败";
                setMessage(`更新失败：${text}`);
              } finally {
                setLoading(false);
              }
            }}
            style={{ border: "none", borderRadius: 8, padding: "8px 12px", color: "#fff", background: "#2563eb" }}
          >
            保存状态
          </button>
        </div>
      </section>
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <h3 style={{ marginTop: 0 }}>关务事件列表</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((item: any) => (
            <div key={item.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 8, background: "#f8fafc" }}>
              [{item.status === "inspection" ? "查验" : item.status === "released" ? "放行" : item.status === "pending" ? "待处理" : item.status}] 运单 {item.shipmentTrackingNo ?? item.shipmentId ?? "-"} / {item.remark ?? "-"}
            </div>
          ))}
        </div>
        {message ? <p style={{ marginTop: 10, color: message.includes("失败") ? "#b91c1c" : "#166534" }}>{message}</p> : null}
      </section>
    </RoleShell>
  );
}
