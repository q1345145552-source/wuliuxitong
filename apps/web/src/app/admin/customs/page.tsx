"use client";

import { useEffect, useState } from "react";
import { useLiveRefresh } from "../../../modules/realtime/useRealtime";
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
    let cancelled = false;
    setLoading(true);
    reload().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // 实时更新（2026-10-05）：别的管理员录了 / 改了，悄悄重拉（reload 本来就不开「加载中」）
  useLiveRefresh({ topics: ["config"], refresh: () => reload() });

  return (
    <>
      <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)", marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>报关状态录入</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8 }}>
          <input value={form.shipmentId} onChange={(e) => setForm((v) => ({ ...v, shipmentId: e.target.value }))} placeholder="运单ID（可选）" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.orderId} onChange={(e) => setForm((v) => ({ ...v, orderId: e.target.value }))} placeholder="订单ID（可选）" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
          <select value={form.status} onChange={(e) => setForm((v) => ({ ...v, status: e.target.value }))} style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }}>
            <option value="inspection">查验</option>
            <option value="cleared">放行</option>
            <option value="pending">待处理</option>
          </select>
          <input value={form.remark} onChange={(e) => setForm((v) => ({ ...v, remark: e.target.value }))} placeholder="备注（通知客服原因）" style={{ border: "1px solid var(--l-strong)", borderRadius: 8, padding: "8px 10px" }} />
        </div>
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              try {
                try {
                  await createAdminCustomsCase({
                    shipmentId: form.shipmentId.trim() || undefined,
                    orderId: form.orderId.trim() || undefined,
                    status: form.status,
                    remark: form.remark.trim() || undefined,
                  });
                } catch (error) {
                  const text = error instanceof Error ? error.message : "更新失败";
                  setMessage(`更新失败：${text}`);
                  return;
                }
                /* 已经记上了：接着刷新列表失败不能说成「更新失败」—— 不然再点一次就多一条记录（2026-10-18 全系统审查 F-14） */
                try {
                  await reload();
                  setMessage("关务状态已更新");
                } catch (error) {
                  setMessage(`关务状态已更新，只是列表这次没刷新上（别再点保存，会多记一条）：${error instanceof Error ? error.message : "请稍后刷新"}`);
                }
              } finally {
                setLoading(false);
              }
            }}
            style={{ border: "none", borderRadius: 8, padding: "8px 12px", color: "var(--white)", background: "var(--c-blue)" }}
          >
            保存状态
          </button>
        </div>
      </section>
      <section style={{ border: "1px solid var(--l-soft)", borderRadius: 12, padding: 16, background: "var(--white)" }}>
        <h3 style={{ marginTop: 0 }}>关务事件列表</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((item: any) => (
            <div key={item.id} style={{ border: "1px solid var(--l-cool)", borderRadius: 8, padding: 8, background: "var(--s-cool)" }}>
              [{item.status === "inspection" ? "查验" : item.status === "cleared" ? "放行" : item.status === "pending" ? "待处理" : item.status}] 运单 {item.shipmentTrackingNo ?? item.shipmentId ?? "-"} / {item.remark ?? "-"}
            </div>
          ))}
        </div>
        {message ? <p style={{ marginTop: 10, color: message.includes("失败") ? "var(--c-red-deep)" : "var(--c-green-dark)" }}>{message}</p> : null}
      </section>
    </>
  );
}
