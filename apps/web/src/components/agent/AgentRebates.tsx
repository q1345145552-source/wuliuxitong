"use client";

/**
 * 代理：每月返现单（3.4 / 4.12 / 4.13 / 4.20）。
 * 每月 1 号出上个月的单（按员工点「泰国签收」那天算月份），出了就不改；湘泰转账后超级管理员点「已返」。
 * 明细每一票写全：唛头、品名、货型方数、客户价、给代理的价、返现，和 6 个时间。
 */
import { useState } from "react";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import { fetchAgentRebateDetail, fetchAgentRebates, type AgentRebateLine, type PriceTriple } from "../../services/agent-api";
import { LoadState, Panel, SectionHeader, StatusTag, TableWrap, TruncatedNote, btn, fmtM3, fmtMoney, fmtTime, mono, td, tdNum, th, useAgentLoad } from "./agent-ui";

const BUCKETS = [
  { key: "normal", label: "普货" },
  { key: "inspection", label: "商检" },
  { key: "sensitive", label: "敏感" },
] as const;

function perBucket(volumes: PriceTriple, prices: PriceTriple, pick: "volume" | "price"): string {
  return BUCKETS.filter((b) => volumes[b.key] > 0)
    .map((b) => `${b.label} ${pick === "volume" ? fmtM3(volumes[b.key]) : prices[b.key]}`)
    .join(" / ") || "—";
}

function StatementDetail({ statementId, onBack }: { statementId: string; onBack: () => void }) {
  const { data, loading, error, reload } = useAgentLoad(() => fetchAgentRebateDetail(statementId), [statementId]);
  return (
    <div>
      <button type="button" style={{ ...btn, marginBottom: 12 }} onClick={onBack}>← 返回返现单列表</button>
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data ? (
        <>
          <Panel title={`${data.statement.month} 返现单`} extra={<StatusTag status={data.statement.status === "paid" ? "paid" : "unpaid"} label={data.statement.status === "paid" ? "已返" : "未返"} />}>
            <div style={{ fontSize: 13, display: "flex", gap: 16, flexWrap: "wrap" }}>
              <span>票数：{data.statement.lineCount}</span>
              <span>总方数：{fmtM3(data.statement.totalVolumeM3)}</span>
              <span style={{ fontWeight: 700 }}>返现合计：{fmtMoney(data.statement.totalRebate)}</span>
              <span>出单：{fmtTime(data.statement.generatedAt)}</span>
              {data.statement.paidAt ? <span>已返时间：{fmtTime(data.statement.paidAt)}</span> : null}
            </div>
          </Panel>
          {data.lines.length === 0 ? (
            <EmptyStateCard title="没有明细" description="这张返现单没有明细。" />
          ) : (
            <TableWrap label="返现明细，可横向滚动">
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 1500 }}>
                <thead>
                  <tr>
                    <th scope="col" style={th}>唛头</th>
                    <th scope="col" style={th}>预报单号</th>
                    <th scope="col" style={th}>品名</th>
                    <th scope="col" style={th}>货型 · 方数</th>
                    <th scope="col" style={th}>客户价</th>
                    <th scope="col" style={th}>给你的价</th>
                    <th scope="col" style={{ ...th, textAlign: "right" }}>这票返现</th>
                    <th scope="col" style={th}>建单</th>
                    <th scope="col" style={th}>仓库签收</th>
                    <th scope="col" style={th}>付款</th>
                    <th scope="col" style={th}>装柜</th>
                    <th scope="col" style={th}>发运</th>
                    <th scope="col" style={th}>泰国签收</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l: AgentRebateLine) => (
                    <tr key={l.id}>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{l.mark}</td>
                      <td style={{ ...td, ...mono }}>{l.trackingNo}</td>
                      <td style={{ ...td, minWidth: 140 }}>{l.productNames}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{perBucket(l.volumes, l.volumes, "volume")}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{perBucket(l.volumes, l.clientPrices, "price")}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{perBucket(l.volumes, l.agentPrices, "price")}</td>
                      <td style={tdNum}>{fmtMoney(l.rebateAmount)}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtTime(l.prealertCreatedAt)}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtTime(l.signedAt)}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtTime(l.paidAt)}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtTime(l.loadedAt)}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtTime(l.shippedAt)}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtTime(l.thailandReceivedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </>
      ) : null}
    </div>
  );
}

export default function AgentRebates() {
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, loading, error, reload } = useAgentLoad(fetchAgentRebates, []);

  if (openId) {
    return (
      <section>
        <SectionHeader title="返现单明细" />
        <StatementDetail statementId={openId} onBack={() => setOpenId(null)} />
      </section>
    );
  }

  return (
    <section>
      <SectionHeader
        title="返现单"
        desc="每月 1 号出上个月的返现单，按员工点「泰国签收」那天算月份。出了就不再改，之后才签收的算进下个月。湘泰转账后会标「已返」。"
        actions={<button type="button" style={btn} onClick={reload} disabled={loading}>刷新</button>}
      />
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data && data.items.length === 0 ? <EmptyStateCard title="还没有返现单" description="名下客户的集货到泰国签收后，下个月 1 号会出返现单。" /> : null}
      {data ? <TruncatedNote total={data.total} limit={data.limit} truncated={data.truncated} unit="张" label="返现单" which="最近的" /> : null}
      {data && data.items.length > 0 ? (
        <TableWrap label="返现单列表">
          <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
            <thead>
              <tr>
                <th scope="col" style={th}>月份</th>
                <th scope="col" style={{ ...th, textAlign: "right" }}>票数</th>
                <th scope="col" style={{ ...th, textAlign: "right" }}>总方数</th>
                <th scope="col" style={{ ...th, textAlign: "right" }}>返现合计</th>
                <th scope="col" style={th}>状态</th>
                <th scope="col" style={th}>出单时间</th>
                <th scope="col" style={th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id}>
                  <td style={{ ...td, fontWeight: 600 }}>{s.month}</td>
                  <td style={tdNum}>{s.lineCount}</td>
                  <td style={tdNum}>{fmtM3(s.totalVolumeM3)}</td>
                  <td style={tdNum}>{fmtMoney(s.totalRebate)}</td>
                  <td style={td}><StatusTag status={s.status === "paid" ? "paid" : "unpaid"} label={s.status === "paid" ? `已返 ${fmtTime(s.paidAt)}` : "未返"} /></td>
                  <td style={td}>{fmtTime(s.generatedAt)}</td>
                  <td style={td}><button type="button" style={btn} onClick={() => setOpenId(s.id)}>看明细</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : null}
    </section>
  );
}
