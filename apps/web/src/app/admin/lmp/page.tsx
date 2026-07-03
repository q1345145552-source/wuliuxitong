"use client";

import { useEffect, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { createAdminLmpRate, fetchAdminLmpRates, type AdminLmpRateItem } from "../../../services/business-api";

/**
 * 渠道与价格管理页面（LMP）。
 */
export default function AdminLmpPage() {
  const [items, setItems] = useState<AdminLmpRateItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    routeCode: "",
    supplierName: "",
    transportMode: "sea",
    seasonTag: "normal",
    supplierCost: "",
    quotePrice: "",
  });

  /**
   * 拉取 LMP 列表。
   */
  const reload = async () => {
    const list = await fetchAdminLmpRates();
    setItems(list);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reload().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <RoleShell allowedRole="admin" title="渠道与价格管理（LMP）">
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>维护航线与供应商底价</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
          <input value={form.routeCode} onChange={(e) => setForm((v) => ({ ...v, routeCode: e.target.value }))} placeholder="航线代码（如 CN-TH-BKK）" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.supplierName} onChange={(e) => setForm((v) => ({ ...v, supplierName: e.target.value }))} placeholder="供应商名称" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <select value={form.transportMode} onChange={(e) => setForm((v) => ({ ...v, transportMode: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}>
            <option value="sea">海运</option>
            <option value="land">陆运</option>
            <option value="air">空运</option>
          </select>
          <select value={form.seasonTag} onChange={(e) => setForm((v) => ({ ...v, seasonTag: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}>
            <option value="normal">平季</option>
            <option value="peak">旺季</option>
            <option value="promotion">活动价</option>
          </select>
          <input value={form.supplierCost} onChange={(e) => setForm((v) => ({ ...v, supplierCost: e.target.value }))} placeholder="供应商底价" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.quotePrice} onChange={(e) => setForm((v) => ({ ...v, quotePrice: e.target.value }))} placeholder="客户报价" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
        </div>
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await createAdminLmpRate({
                  routeCode: form.routeCode.trim(),
                  supplierName: form.supplierName.trim(),
                  transportMode: form.transportMode,
                  seasonTag: form.seasonTag,
                  supplierCost: Number(form.supplierCost),
                  quotePrice: Number(form.quotePrice),
                });
                await reload();
                setMessage("LMP 规则新增成功");
              } catch (error) {
                const text = error instanceof Error ? error.message : "新增失败";
                setMessage(`新增失败：${text}`);
              } finally {
                setLoading(false);
              }
            }}
            style={{ border: "none", borderRadius: 8, padding: "8px 12px", color: "#fff", background: "#2563eb" }}
          >
            保存规则
          </button>
        </div>
      </section>
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <h3 style={{ marginTop: 0 }}>规则列表</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((item) => (
            <div key={item.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 8, background: "#f8fafc" }}>
              {item.routeCode} / {item.supplierName} / {item.transportMode} / {item.seasonTag} / 底价 {item.supplierCost} / 报价 {item.quotePrice}
            </div>
          ))}
        </div>
        {message ? <p style={{ marginTop: 10, color: message.includes("失败") ? "#b91c1c" : "#166534" }}>{message}</p> : null}
      </section>
    </RoleShell>
  );
}
