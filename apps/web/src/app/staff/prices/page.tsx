"use client";
import { DEFAULT_SHIPPING_PRICES, INSPECTION_SURCHARGE, SENSITIVE_SURCHARGE } from "../../../packages/shared-types/constants";

import { useEffect, useMemo, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { fetchStaffClients, fetchAdminShippingRates, fetchClientShippingConfig } from "../../../services/business-api";

export default function StaffPricesPage() {
  const [clients, setClients] = useState<Array<{ id: string; name: string }>>([]);
  const [defaults, setDefaults] = useState<Array<{ transportMode: string; cargoType: string; unitPriceCny: number }>>([
    { transportMode: "sea", cargoType: "normal", unitPriceCny: DEFAULT_SHIPPING_PRICES.sea },
    { transportMode: "sea", cargoType: "inspection", unitPriceCny: 700 },
    { transportMode: "sea", cargoType: "sensitive", unitPriceCny: 800 },
    { transportMode: "land", cargoType: "normal", unitPriceCny: DEFAULT_SHIPPING_PRICES.land },
    { transportMode: "land", cargoType: "inspection", unitPriceCny: 1250 },
    { transportMode: "land", cargoType: "sensitive", unitPriceCny: 1350 },
  ]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [clientPrices, setClientPrices] = useState<Record<string, number>>({});
  const [disableMin, setDisableMin] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [c, r] = await Promise.all([fetchStaffClients(), fetchAdminShippingRates()]);
      setClients(c);
      setDefaults(r.defaults);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const viewClient = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    try {
      const d = await fetchClientShippingConfig(id);
      setClientPrices(d.prices);
      setDisableMin(d.disableMinVolume);
    } catch (e) { console.error(e); }
  };

  return (
    <RoleShell allowedRole="staff" title="客户价格查询">
      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 20, background: "#fff" }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>客户价格查询</h2>
        <p style={{ color: "#000000", fontSize: 13, marginBottom: 16 }}>查看每个客户当前的价格配置（只读）。</p>
        {loading ? <p>加载中…</p> : (
          <div style={{ display: "grid", gap: 6 }}>
            {clients.map((c) => (
              <div key={c.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{c.name} <span style={{ color: "#6b7280", fontSize: 12, fontFamily: "monospace" }}>{c.id}</span></span>
                  <button type="button" onClick={() => viewClient(c.id)}
                    style={{ border: "1px solid #2563eb", borderRadius: 4, padding: "4px 10px", fontSize: 12, background: "#fff", color: "#2563eb", cursor: "pointer" }}>
                    {expandedId === c.id ? "收起" : "查看价格"}
                  </button>
                </div>
                {expandedId === c.id ? (
                  <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
                    {defaults.map((d) => {
                      const key = `${d.transportMode}|${d.cargoType}`;
                      const val = clientPrices[key] ?? d.unitPriceCny;
                      return (
                        <div key={key} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                          <span style={{ width: 100, fontSize: 13 }}>{d.transportMode === "sea" ? "海运" : "陆运"}·{d.cargoType === "normal" ? "普货" : d.cargoType === "inspection" ? "商检" : "敏感"}</span>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>¥{val.toFixed(0)}/m³</span>
                        </div>
                      );
                    })}
                    <div style={{ marginTop: 6, fontSize: 12, color: disableMin ? "#8b5cf6" : "#6b7280" }}>
                      低消：{disableMin ? "已取消" : "正常"}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </RoleShell>
  );
}
