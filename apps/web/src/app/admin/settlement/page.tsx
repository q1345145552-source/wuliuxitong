"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { fetchContainerRevenue, type ContainerRevenueSummary } from "../../../services/business-api";

/* 2026-08-27 重做：这一页原来是「结算与利润」——手工填应收/应付/税费再算利润，
   生产上 0 条数据、从没人用过。老板定的新口径：不算利润，就看这条柜收客户多少钱。 */

const money = (n: number) => `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_ZH: Record<string, string> = {
  planning: "计划中", collecting: "收集中", full_confirmed: "已满待报价", quoted: "已报价待付款",
  paid: "已付款", loading: "装柜中", in_transit: "运输中", customs: "清关中",
  delivering: "派送中", completed: "已完成", shipped: "已发运",
  thailand_received: "已到泰国", cancelled: "已取消",
};

export default function AdminSettlementPage() {
  const [data, setData] = useState<ContainerRevenueSummary | null>(null);
  const [error, setError] = useState("");
  const [openNo, setOpenNo] = useState("");

  const load = useCallback(async () => {
    setError("");
    try { setData(await fetchContainerRevenue()); }
    catch { setError("无法加载柜子收款数据"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const td = { padding: "10px 12px" } as const;
  const th = { padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" } as const;
  const thNum = { ...th, textAlign: "right" } as const;
  const tdNum = { ...td, textAlign: "right", fontFamily: "monospace" } as const;

  return (
    <>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--ink-legacy)", margin: "0 0 4px" }}>柜子收款</h1>
      <p style={{ fontSize: 13, color: "var(--ink-mute)", margin: "0 0 16px" }}>
        一行一个柜，看这条柜收了客户多少钱。点「客户明细」看柜里每个客户各付了多少。
      </p>

      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 20 }}>
          {[
            { label: "已收款", value: money(data.totalReceived) },
            { label: "待收款", value: money(data.totalReceivable) },
            { label: "未到收款环节", value: money(data.totalNotYet) },
            { label: "柜子数", value: `${data.containerCount} 个` },
          ].map((k) => (
            <div key={k.label} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)", padding: 16, background: "var(--canvas)" }}>
              <div style={{ fontSize: 12, color: "var(--ink-mute)", fontWeight: 500 }}>{k.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ink-legacy)", marginTop: 4 }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      {error && <p style={{ color: "var(--accent-crimson)", fontSize: 13, marginBottom: 8 }}>{error}</p>}

      {!data && !error ? <p style={{ color: "var(--ink-mute)", fontSize: 13 }}>加载中…</p> : data && (
        <div style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-lg)", overflow: "hidden", background: "var(--canvas)" }}>
          <div style={{ overflowX: "auto" }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 820 }}>
              <thead>
                <tr style={{ background: "var(--canvas-soft)" }}>
                  <th style={th}>类型</th>
                  <th style={th}>柜 / 计划号</th>
                  <th style={th}>柜型</th>
                  <th style={th}>状态</th>
                  <th style={thNum}>客户</th>
                  <th style={thNum}>单数</th>
                  <th style={thNum}>已收</th>
                  <th style={thNum}>待收</th>
                  <th style={thNum}>未到收款</th>
                  <th style={thNum}>合计</th>
                  <th style={th}>明细</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <Fragment key={r.no}>
                    <tr style={{ borderTop: "1px solid var(--hairline-cool)" }}>
                      <td style={td}>{r.kindLabel}</td>
                      <td style={{ ...td, fontWeight: 500, fontFamily: "monospace" }}>{r.no}</td>
                      <td style={td}>{r.containerType}</td>
                      <td style={td}>{STATUS_ZH[r.status] ?? r.status}</td>
                      <td style={tdNum}>{r.customerCount}</td>
                      <td style={tdNum}>{r.orderCount}</td>
                      <td style={{ ...tdNum, color: r.received > 0 ? "var(--success)" : "var(--ink-mute)" }}>
                        {r.quotedCount > 0 ? money(r.received) : "—"}
                      </td>
                      <td style={{ ...tdNum, color: r.receivable > 0 ? "var(--accent-yellow)" : "var(--ink-mute)" }}>
                        {r.quotedCount > 0 ? money(r.receivable) : "—"}
                      </td>
                      <td style={{ ...tdNum, color: "var(--ink-mute)" }}>
                        {r.quotedCount > 0 ? money(r.notYet) : "—"}
                      </td>
                      <td style={{ ...tdNum, fontWeight: 600 }}>{r.quotedCount > 0 ? money(r.total) : "—"}</td>
                      <td style={td}>
                        {r.customers.length > 0 && (
                          <button type="button" onClick={() => setOpenNo(openNo === r.no ? "" : r.no)}
                            style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-xs)", padding: "3px 10px", fontSize: 12, background: "var(--canvas)", cursor: "pointer", color: "var(--t-strong)" }}>
                            {openNo === r.no ? "收起" : "客户明细"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {openNo === r.no && r.customers.map((c) => (
                      <tr key={`${r.no}-${c.clientId}`} style={{ background: "var(--canvas-soft)" }}>
                        <td style={td} />
                        <td style={{ ...td, color: "var(--ink-mute)" }} colSpan={3}>↳ {c.clientId}</td>
                        <td style={tdNum} />
                        <td style={tdNum}>{c.orderCount}</td>
                        <td style={tdNum}>{c.received > 0 ? money(c.received) : "—"}</td>
                        <td style={tdNum}>{c.receivable > 0 ? money(c.receivable) : "—"}</td>
                        <td style={tdNum}>{c.notYet > 0 ? money(c.notYet) : "—"}</td>
                        {/* ⚠️ 判断依据必须是「报过价没有」，不是「有没有单」（2026-08-27 二修）：
                            `orderCount > 0` 只能证明有单，证明不了报过价 ——
                            生产上 JH0000001 有 1 张单但 totalFee 是 null（根本没报价），
                            用 orderCount 判断就会显示成「¥0.00」，跟「报价就是 0 元」混掉。
                            改用 quotedCount：一张都没报价 → 「—」；报过价（哪怕报的是 0）→ 如实显示。 */}
                        <td style={tdNum}>
                          {c.quotedCount > 0 ? money(c.received + c.receivable + c.notYet) : "—"}
                        </td>
                        <td style={td} />
                      </tr>
                    ))}
                  </Fragment>
                ))}
                {data.rows.length === 0 && (
                  <tr><td colSpan={11} style={{ padding: 20, textAlign: "center", color: "var(--ink-mute)" }}>还没有集货柜</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
