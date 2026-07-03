"use client";

import { useEffect, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import {
  createAdminSettlementEntry,
  fetchAdminProfitAnalysis,
  fetchAdminSettlementEntries,
  type AdminProfitItem,
  type AdminSettlementEntryItem,
} from "../../../services/business-api";

/**
 * 财务结算与利润分析页面。
 */
export default function AdminSettlementPage() {
  const [entries, setEntries] = useState<AdminSettlementEntryItem[]>([]);
  const [profitItems, setProfitItems] = useState<AdminProfitItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    orderId: "",
    clientReceivable: "",
    supplierPayable: "",
    taxFee: "",
    currency: "CNY",
  });

  /**
   * 刷新结算数据与利润分析。
   */
  const reload = async () => {
    const [entryList, profitList] = await Promise.all([fetchAdminSettlementEntries(), fetchAdminProfitAnalysis()]);
    setEntries(entryList);
    setProfitItems(profitList);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reload().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <RoleShell allowedRole="admin" title="财务结算系统">
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>结算录入（AR/AP/税费）</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8 }}>
          <input value={form.orderId} onChange={(e) => setForm((v) => ({ ...v, orderId: e.target.value }))} placeholder="订单号" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.clientReceivable} onChange={(e) => setForm((v) => ({ ...v, clientReceivable: e.target.value }))} placeholder="应收 AR" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.supplierPayable} onChange={(e) => setForm((v) => ({ ...v, supplierPayable: e.target.value }))} placeholder="应付 AP" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <input value={form.taxFee} onChange={(e) => setForm((v) => ({ ...v, taxFee: e.target.value }))} placeholder="税费" style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }} />
          <select value={form.currency} onChange={(e) => setForm((v) => ({ ...v, currency: e.target.value }))} style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}>
            <option value="CNY">CNY</option>
            <option value="THB">THB</option>
          </select>
        </div>
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await createAdminSettlementEntry({
                  orderId: form.orderId.trim(),
                  clientReceivable: Number(form.clientReceivable),
                  supplierPayable: Number(form.supplierPayable),
                  taxFee: Number(form.taxFee),
                  currency: form.currency,
                });
                await reload();
                setMessage("结算录入成功");
              } catch (error) {
                const text = error instanceof Error ? error.message : "录入失败";
                setMessage(`录入失败：${text}`);
              } finally {
                setLoading(false);
              }
            }}
            style={{ border: "none", borderRadius: 8, padding: "8px 12px", color: "#fff", background: "#2563eb" }}
          >
            保存结算
          </button>
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff", marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>结算列表</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {entries.map((item: any) => (
            <div key={item.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 8, background: "#f8fafc" }}>
              运单 {item.trackingNo ?? item.orderId} / AR {item.clientReceivable} / AP {item.supplierPayable} / 税费 {item.taxFee} / {item.currency}
            </div>
          ))}
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>
        <h3 style={{ marginTop: 0 }}>利润分析（单票）</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {profitItems.map((item: any) => (
            <div key={`${item.orderId}-${item.updatedAt}`} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 8, background: "#f8fafc" }}>
              运单 {item.trackingNo ?? item.orderId} / 利润 = AR({item.clientReceivable}) - AP({item.supplierPayable}) - 税费({item.taxFee}) ={" "}
              <strong>{item.profit}</strong> {item.currency}
            </div>
          ))}
        </div>
        {message ? <p style={{ marginTop: 10, color: message.includes("失败") ? "#b91c1c" : "#166534" }}>{message}</p> : null}
      </section>
    </RoleShell>
  );
}
