"use client";

/**
 * 代理：名下客户的集货余额和充值记录（3.7）。只读，没有审核按钮 —— 充值照旧由湘泰超级管理员审核（4.16）。
 */
import { useState } from "react";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import { fetchAgentWallet } from "../../services/agent-api";
import { LoadState, Pager, Panel, SectionHeader, StatusTag, TableWrap, btn, fmtMoney, fmtTime, input, td, tdNum, th, useAgentLoad } from "./agent-ui";

const METHOD_ZH: Record<string, string> = { WECHAT: "微信", ALIPAY: "支付宝", BANK_TRANSFER: "银行转账" };
const RECHARGE_STATUS: Record<string, { key: string; label: string }> = {
  PENDING: { key: "pending", label: "待审核" },
  APPROVED: { key: "paid", label: "已到账" },
  REJECTED: { key: "cancelled", label: "已拒绝" },
};
const PAGE_SIZE = 50;

export default function AgentWallet() {
  const [page, setPage] = useState(1);
  const [clientId, setClientId] = useState("");
  const { data, loading, error, reload } = useAgentLoad(() => fetchAgentWallet({ page, pageSize: PAGE_SIZE, clientId: clientId || undefined }), [page, clientId]);

  return (
    <section>
      <SectionHeader
        title="集货余额"
        desc="名下客户的集货余额和充值记录。客户充值打给湘泰，由湘泰审核到账。"
        actions={<button type="button" style={btn} onClick={reload} disabled={loading}>刷新</button>}
      />
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data ? (
        data.balances.length === 0 ? (
          <EmptyStateCard title="你名下还没有客户" description="客户账号由湘泰超级管理员开在你名下。" />
        ) : (
          <>
            <Panel title="余额">
              <TableWrap label="客户余额">
                <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 420 }}>
                  <thead>
                    <tr>
                      <th scope="col" style={th}>客户</th>
                      <th scope="col" style={{ ...th, textAlign: "right" }}>集货余额</th>
                      <th scope="col" style={th}>最近变动</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.balances.map((b) => (
                      <tr key={b.clientId}>
                        <td style={td}>{b.clientId}{b.clientName && b.clientName !== b.clientId ? <span style={{ color: "var(--t-muted)" }}>（{b.clientName}）</span> : null}</td>
                        <td style={tdNum}>{fmtMoney(b.balance)}</td>
                        <td style={td}>{fmtTime(b.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Panel>

            <Panel
              title="充值记录"
              extra={
                <label style={{ fontSize: 13 }}>
                  <span className="workbench-sr-only">按客户筛选</span>
                  <select style={input} value={clientId} onChange={(e) => { setClientId(e.target.value); setPage(1); }}>
                    <option value="">全部客户</option>
                    {data.balances.map((b) => <option key={b.clientId} value={b.clientId}>{b.clientId}</option>)}
                  </select>
                </label>
              }
            >
              {data.recharges.items.length === 0 ? (
                <EmptyStateCard title="没有充值记录" description="客户在客户端「集货余额」里提交充值后会出现在这里。" />
              ) : (
                <>
                  <TableWrap label="充值记录">
                    <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                      <thead>
                        <tr>
                          <th scope="col" style={th}>客户</th>
                          <th scope="col" style={{ ...th, textAlign: "right" }}>金额</th>
                          <th scope="col" style={th}>方式</th>
                          <th scope="col" style={th}>状态</th>
                          <th scope="col" style={th}>提交时间</th>
                          <th scope="col" style={th}>更新时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.recharges.items.map((r) => {
                          const st = RECHARGE_STATUS[r.status] ?? { key: r.status, label: r.status };
                          return (
                            <tr key={r.id}>
                              <td style={td}>{r.clientId}</td>
                              <td style={tdNum}>{fmtMoney(r.amount)}</td>
                              <td style={td}>{METHOD_ZH[r.paymentMethod] ?? r.paymentMethod}</td>
                              <td style={td}><StatusTag status={st.key} label={st.label} /></td>
                              <td style={td}>{fmtTime(r.createdAt)}</td>
                              <td style={td}>{fmtTime(r.updatedAt)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </TableWrap>
                  <Pager page={data.recharges.page} pageSize={data.recharges.pageSize} total={data.recharges.total} onPage={setPage} />
                </>
              )}
            </Panel>
          </>
        )
      ) : null}
    </section>
  );
}
