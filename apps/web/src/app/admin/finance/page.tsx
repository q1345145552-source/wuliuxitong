"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchFinanceSummary, type FinanceSummary } from "../../../services/business-api";

/* 2026-08-27 重做：这一页只看集货拼柜的两个功能，不再统计运单。
   老板口径：运单跟钱无关，钱只在集货那两个功能里。 */

/**
 * ⚠️ 后端容器跑在 UTC，`createdAt` 是 ISO 串。直接 `.slice(0,10)` 截出来的是 UTC 日期 ——
 * 北京时间 8 月 27 日凌晨 1 点建的单，会显示成 8 月 26 日，**整整差一天**。
 * 中国不实行夏令时，固定 +8 小时。
 */
const dayInBeijing = (iso: string) =>
  new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

const money = (n: number) => `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function AdminFinancePage() {
  const [data, setData] = useState<FinanceSummary | null>(null);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [kindFilter, setKindFilter] = useState("ALL");
  const [payFilter, setPayFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const load = useCallback(async () => {
    setError("");
    try { setData(await fetchFinanceSummary()); }
    catch { setError("无法加载财务数据"); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const kw = keyword.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (kw && !(r.no.toLowerCase().includes(kw) || r.client.toLowerCase().includes(kw) || r.clientId.toLowerCase().includes(kw))) return false;
      if (kindFilter !== "ALL" && r.kind !== kindFilter) return false;
      if (payFilter === "PAID" && !r.paid) return false;
      if (payFilter === "UNPAID" && r.paid) return false;
      return true;
    });
  }, [data, keyword, kindFilter, payFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const cellStyle = { padding: "10px 12px" } as const;
  const thStyle = { padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" } as const;
  const thNum = { ...thStyle, textAlign: "right" } as const;

  return (
    <>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--ink-legacy)", margin: "0 0 4px" }}>财务结算</h1>
      <p style={{ fontSize: 13, color: "var(--ink-mute)", margin: "0 0 16px" }}>
        只统计集货拼柜（普通版 + 仓库版）。运单不计价，不在这里。
      </p>

      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 20 }}>
          {[
            { label: "待收款", value: money(data.receivableAmount), sub: `${data.receivableCount} 张 · 货已到仓待付款` },
            { label: "已收款", value: money(data.receivedAmount), sub: `${data.receivedCount} 张` },
            { label: "客户余额", value: money(data.balanceAmount), sub: `${data.balanceClientCount} 个客户充值未用` },
            { label: "未到收款环节", value: money(data.notYetAmount), sub: `${data.notYetCount} 张 · 还没到该收钱的环节` },
          ].map((kpi) => (
            <div key={kpi.label} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", padding: 16, background: "var(--canvas)" }}>
              <div style={{ fontSize: 12, color: "var(--ink-mute)", fontWeight: 500 }}>{kpi.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ink-legacy)", marginTop: 4 }}>{kpi.value}</div>
              <div style={{ fontSize: 11, color: "var(--ink-mute)", marginTop: 4 }}>{kpi.sub}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} placeholder="单号 / 客户唛头…"
          style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 13, minWidth: 180 }} />
        <select value={kindFilter} onChange={(e) => { setKindFilter(e.target.value); setPage(1); }}
          style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 13 }}>
          <option value="ALL">两种都看</option>
          <option value="warehouse">仓库版</option>
          <option value="normal">普通版</option>
        </select>
        <select value={payFilter} onChange={(e) => { setPayFilter(e.target.value); setPage(1); }}
          style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 13 }}>
          <option value="ALL">全部</option>
          <option value="UNPAID">未付</option>
          <option value="PAID">已付</option>
        </select>
      </div>

      {error && <p style={{ color: "var(--accent-crimson)", fontSize: 13, marginBottom: 8 }}>{error}</p>}

      {!data && !error ? <p style={{ color: "var(--ink-mute)", fontSize: 13 }}>加载中…</p> : (
        <div style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-lg)", overflow: "hidden", background: "var(--canvas)" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 760 }}>
              <thead>
                <tr style={{ background: "var(--canvas-soft)" }}>
                  <th style={thStyle}>类型</th>
                  <th style={thStyle}>单号</th>
                  <th style={thStyle}>客户 / 唛头</th>
                  <th style={thStyle}>状态</th>
                  <th style={thNum}>金额</th>
                  <th style={thStyle}>付款</th>
                  <th style={thStyle}>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={`${r.kind}-${r.no}`} style={{ borderTop: "1px solid var(--hairline-cool)" }}>
                    <td style={cellStyle}>{r.kindLabel}</td>
                    <td style={{ ...cellStyle, fontWeight: 500, fontFamily: "monospace" }}>{r.no}</td>
                    <td style={cellStyle}>{r.client}</td>
                    <td style={cellStyle}>{r.statusZh}</td>
                    {/* 没报价就留空，不要显示 ¥0.00 —— 那会让人以为这单不要钱 */}
                    <td style={{ ...cellStyle, textAlign: "right", fontFamily: "monospace" }}>
                      {r.amount == null ? <span style={{ color: "var(--ink-mute)" }}>—</span> : money(r.amount)}
                    </td>
                    <td style={cellStyle}>
                      <span style={{ color: r.paid ? "var(--success)" : "var(--accent-yellow)", fontWeight: 500, fontSize: 12 }}>
                        {r.paid ? "已付" : "未付"}
                      </span>
                    </td>
                    <td style={{ ...cellStyle, color: "var(--ink-mute)" }}>{dayInBeijing(r.createdAt)}</td>
                  </tr>
                ))}
                {pageRows.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: 20, textAlign: "center", color: "var(--ink-mute)" }}>暂无数据</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderTop: "1px solid var(--hairline-cool)", fontSize: 13, color: "var(--ink-mute)" }}>
            <span>共 {filtered.length} 条，第 {safePage}/{totalPages} 页</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-xs)", padding: "4px 12px", fontSize: 12, background: "var(--canvas)", cursor: safePage <= 1 ? "not-allowed" : "pointer", color: "var(--t-strong)" }}>上一页</button>
              <button disabled={safePage >= totalPages} onClick={() => setPage((p) => p + 1)} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-xs)", padding: "4px 12px", fontSize: 12, background: "var(--canvas)", cursor: safePage >= totalPages ? "not-allowed" : "pointer", color: "var(--t-strong)" }}>下一页</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
