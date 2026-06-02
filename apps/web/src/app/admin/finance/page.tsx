"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import { fetchFinanceSummary, type FinanceSummary } from "../../../services/business-api";

export default function AdminFinancePage() {
  const [data, setData] = useState<FinanceSummary | null>(null);
  const [error, setError] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [warehouseFilter, setWarehouseFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const load = useCallback(async () => {
    setError("");
    try {
      const d = await fetchFinanceSummary();
      setData(d);
    } catch {
      setError("无法加载财务数据");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.rows.filter((r) => {
      const clientMatch = !clientFilter.trim() || r.clientName.toLowerCase().includes(clientFilter.trim().toLowerCase());
      const warehouseMatch = warehouseFilter === "ALL" || r.warehouse === warehouseFilter;
      return clientMatch && warehouseMatch;
    });
  }, [data, clientFilter, warehouseFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <RoleShell allowedRole="admin" title="财务报表">
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--ink)", margin: "0 0 16px" }}>财务结算</h1>

      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 20 }}>
          {[
            { label: "总订单数", value: `${data.totalOrders} 单` },
            { label: "总重量", value: `${data.totalWeight.toFixed(1)} kg` },
            { label: "总体积", value: `${data.totalVolume.toFixed(4)} m³` },
            { label: "本月订单", value: `${data.monthOrders} 单` },
          ].map((kpi) => (
            <div key={kpi.label} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", padding: 16, background: "var(--canvas)" }}>
              <div style={{ fontSize: 12, color: "var(--ink-mute)", fontWeight: 500 }}>{kpi.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ink)", marginTop: 4 }}>{kpi.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* 筛选 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input value={clientFilter} onChange={(e) => { setClientFilter(e.target.value); setPage(1); }} placeholder="客户名称…" style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 13, minWidth: 160 }} />
        <select value={warehouseFilter} onChange={(e) => { setWarehouseFilter(e.target.value); setPage(1); }} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 13 }}>
          <option value="ALL">全部仓库</option>
          <option value="wh_yiwu_01">义乌仓</option>
          <option value="wh_guangzhou_01">广州仓</option>
          <option value="wh_dongguan_01">东莞仓</option>
        </select>
      </div>

      {error && <p style={{ color: "var(--accent-crimson)", fontSize: 13, marginBottom: 8 }}>{error}</p>}

      {!data && !error ? <p style={{ color: "var(--ink-mute)", fontSize: 13 }}>加载中…</p> : (
        <div style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-lg)", overflow: "hidden", background: "var(--canvas)" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 900 }}>
              <thead>
                <tr style={{ background: "var(--canvas-soft)" }}>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>订单号</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>仓库</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>客户</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>运输方式</th>
                  <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 500, color: "var(--ink-mute)" }}>重量(kg)</th>
                  <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 500, color: "var(--ink-mute)" }}>体积(m³)</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>付款状态</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid var(--hairline-cool)" }}>
                    <td style={{ padding: "10px 12px", fontWeight: 500 }}>{r.orderNo}</td>
                    <td style={{ padding: "10px 12px" }}>{r.warehouse}</td>
                    <td style={{ padding: "10px 12px" }}>{r.clientName}</td>
                    <td style={{ padding: "10px 12px" }}>{r.transportMode}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right" }}>{r.weightKg.toFixed(1)}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right" }}>{r.volumeM3.toFixed(4)}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <span style={{ color: r.paymentStatus === "paid" ? "var(--success)" : "var(--accent-yellow)", fontWeight: 500, fontSize: 12 }}>
                        {r.paymentStatus === "paid" ? "已付" : "未付"}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px", color: "var(--ink-mute)" }}>{r.createdAt.slice(0, 10)}</td>
                  </tr>
                ))}
                {pageRows.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: 20, textAlign: "center", color: "var(--ink-mute)" }}>暂无数据</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderTop: "1px solid var(--hairline-cool)", fontSize: 13, color: "var(--ink-mute)" }}>
            <span>共 {filtered.length} 条，第 {safePage}/{totalPages} 页</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-xs)", padding: "4px 12px", fontSize: 12, background: "var(--canvas)", cursor: safePage <= 1 ? "not-allowed" : "pointer", color: "#000000" }}>上一页</button>
              <button disabled={safePage >= totalPages} onClick={() => setPage((p) => p + 1)} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-xs)", padding: "4px 12px", fontSize: 12, background: "var(--canvas)", cursor: safePage >= totalPages ? "not-allowed" : "pointer", color: "#000000" }}>下一页</button>
            </div>
          </div>
        </div>
      )}
    </RoleShell>
  );
}
