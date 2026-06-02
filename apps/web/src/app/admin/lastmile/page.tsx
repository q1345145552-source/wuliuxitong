"use client";

import { useEffect, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { createAdminLastmileOrder, fetchAdminLastmileOrders, type AdminLastmileItem } from "../../../services/business-api";

/**
 * 海外仓/末端派送集成页面。
 */
export default function AdminLastmilePage() {
  const [items, setItems] = useState<AdminLastmileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    shipmentId: "",
    carrierName: "DHL",
    externalTrackingNo: "",
    status: "created",
  });

  /**
   * 刷新末端对接记录。
   */
  const reload = async () => {
    const list = await fetchAdminLastmileOrders();
    setItems(list);
  };

  useEffect(() => {
    setLoading(true);
    reload().finally(() => setLoading(false));
  }, []);

  return (
    <RoleShell allowedRole="admin" title="海外仓/末端集成">
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>末端派送单号录入</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8 }}>
          <input value={form.shipmentId} onChange={(e) => setForm((v) => ({ ...v, shipmentId: e.target.value }))} placeholder="shipmentId" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <select value={form.carrierName} onChange={(e) => setForm((v) => ({ ...v, carrierName: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}>
            <option value="UPS">UPS</option>
            <option value="FedEx">FedEx</option>
            <option value="DHL">DHL</option>
            <option value="LocalPost">当地邮政</option>
          </select>
          <input value={form.externalTrackingNo} onChange={(e) => setForm((v) => ({ ...v, externalTrackingNo: e.target.value }))} placeholder="末端派送单号" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <select value={form.status} onChange={(e) => setForm((v) => ({ ...v, status: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}>
            <option value="created">已创建</option>
            <option value="inTransit">派送中</option>
            <option value="delivered">已签收</option>
          </select>
        </div>
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await createAdminLastmileOrder({
                  shipmentId: form.shipmentId.trim(),
                  carrierName: form.carrierName,
                  externalTrackingNo: form.externalTrackingNo.trim(),
                  status: form.status,
                });
                await reload();
                setMessage("末端派送单号已同步");
              } catch (error) {
                const text = error instanceof Error ? error.message : "保存失败";
                setMessage(`保存失败：${text}`);
              } finally {
                setLoading(false);
              }
            }}
            style={{ border: "none", borderRadius: 8, padding: "8px 12px", color: "#fff", background: "#2563eb" }}
          >
            保存记录
          </button>
        </div>
      </section>
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <h3 style={{ marginTop: 0 }}>对接记录列表</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((item) => (
            <div key={item.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 8, background: "#f8fafc" }}>
              {item.carrierName} / {item.externalTrackingNo} / shipment: {item.shipmentId} / {item.status === "created" ? "已创建" : item.status === "inTransit" ? "派送中" : item.status === "delivered" ? "已签收" : item.status}
            </div>
          ))}
        </div>
        {message ? <p style={{ marginTop: 10, color: message.includes("失败") ? "#b91c1c" : "#166534" }}>{message}</p> : null}
      </section>
    </RoleShell>
  );
}
