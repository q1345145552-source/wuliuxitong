"use client";

/**
 * 代理：仓库版集货（3.2 / 3.3）。
 * 一个柜里混着湘泰和别家的货时，接口只回他名下客户那几行 —— 页面也只画这几行，整柜已用方数不显示。
 */
import { useEffect, useState } from "react";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import { fetchAgentWhrPlanDetail, fetchAgentWhrPlans, type AgentWhrPlanDetail, type AgentWhrPrealert } from "../../services/agent-api";
import {
  CARGO_ZH,
  LoadState,
  PREALERT_STATUS_ZH,
  Panel,
  ProofThumbs,
  SectionHeader,
  StatusTag,
  TableWrap,
  TruncatedNote,
  btn,
  fmtM3,
  fmtMoney,
  fmtTime,
  mono,
  priceText,
  td,
  tdNum,
  th,
  useAgentLoad,
} from "./agent-ui";

function PrealertCard({ pa }: { pa: AgentWhrPrealert }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: "1px solid var(--l-soft)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ ...mono, fontWeight: 600 }}>{pa.trackingNo}</span>
        <StatusTag status={pa.status} />
        <span style={{ fontSize: 13 }}>唛头：{pa.mark}</span>
        {pa.expressNo ? <span style={{ fontSize: 13, color: "var(--t-muted)" }}>快递单号：{pa.expressNo}</span> : null}
        <span style={{ fontSize: 13 }}>金额：{fmtMoney(pa.totalFee)}</span>
        {pa.rebateAmount != null ? <span style={{ fontSize: 13, color: "var(--c-green-deep)" }}>这单返现：{fmtMoney(pa.rebateAmount)}</span> : null}
        <button type="button" style={{ ...btn, marginLeft: "auto", padding: "2px 10px" }} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "收起" : "展开"}</button>
      </div>
      <div style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap" }}>
        <span>建单：{fmtTime(pa.createdAt)}</span>
        <span>仓库签收：{fmtTime(pa.signedAt)}</span>
        <span>付款：{fmtTime(pa.paidAt)}</span>
        <span>泰国签收：{fmtTime(pa.thailandReceivedAt)}</span>
        {pa.cancelledAt ? <span>取消：{fmtTime(pa.cancelledAt)}{pa.cancelReason ? `（${pa.cancelReason}）` : ""}</span> : null}
      </div>
      {pa.paymentRejectReason ? <div style={{ fontSize: 12, color: "var(--c-red-dark)", marginTop: 4 }}>付款被退回：{pa.paymentRejectReason}</div> : null}
      {open ? (
        <div style={{ marginTop: 10 }}>
          {pa.items.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--t-muted)" }}>没有货品</div>
          ) : (
            <TableWrap label="货品明细">
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
                <thead>
                  <tr>
                    <th scope="col" style={th}>品名</th>
                    <th scope="col" style={th}>货型</th>
                    <th scope="col" style={{ ...th, textAlign: "right" }}>箱数</th>
                    <th scope="col" style={{ ...th, textAlign: "right" }}>每箱数量</th>
                    <th scope="col" style={th}>长×宽×高(cm)</th>
                    <th scope="col" style={{ ...th, textAlign: "right" }}>方数</th>
                    <th scope="col" style={{ ...th, textAlign: "right" }}>总重(kg)</th>
                    <th scope="col" style={th}>材质</th>
                    <th scope="col" style={th}>货值</th>
                  </tr>
                </thead>
                <tbody>
                  {pa.items.map((it) => (
                    <tr key={it.id}>
                      <td style={td}>{it.productName}</td>
                      <td style={td}>{CARGO_ZH[it.cargoType] ?? "普货"}</td>
                      <td style={tdNum}>{it.packageCount}</td>
                      <td style={tdNum}>{it.quantityPerBox}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{it.lengthCm ?? "—"}×{it.widthCm ?? "—"}×{it.heightCm ?? "—"}</td>
                      <td style={tdNum}>{fmtM3(it.volumeM3)}</td>
                      <td style={tdNum}>{it.totalWeightKg ?? "—"}</td>
                      <td style={td}>{it.material}</td>
                      <td style={td}>{it.cargoValue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          {pa.feeBreakdown.rows.length > 0 ? (
            <div style={{ fontSize: 13, marginTop: 8 }}>
              费用明细：{pa.feeBreakdown.rows.map((r) => `${r.label} ${fmtM3(r.volumeM3)} 方 × ${r.unitPrice} = ${fmtMoney(r.amount)}`).join("；")}
            </div>
          ) : null}
          <ProofThumbs proofs={pa.warehouseReceiptProofs} label="仓库签收照片" />
          <ProofThumbs proofs={pa.thailandReceiptProofs} label="泰国签收照片" />
          {pa.statusLogs.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: "var(--t-muted)", marginBottom: 4 }}>状态记录</div>
              <TruncatedNote total={pa.statusLogTotal} limit={pa.statusLogs.length} truncated={pa.statusLogsTruncated} which="最近的" />
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {pa.statusLogs.map((l) => (
                  <li key={l.id}>{fmtTime(l.createdAt)} {PREALERT_LABEL(l.fromStatus)} → {PREALERT_LABEL(l.toStatus)}{l.remark ? `（${l.remark}）` : ""}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PREALERT_LABEL(s: string): string {
  return PREALERT_STATUS_ZH[s] ?? s;
}

function PlanDetail({ planId, onBack }: { planId: string; onBack: () => void }) {
  const { data, loading, error, reload } = useAgentLoad<AgentWhrPlanDetail>(() => fetchAgentWhrPlanDetail(planId), [planId]);
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <button type="button" style={btn} onClick={onBack}>← 返回列表</button>
        <button type="button" style={btn} onClick={reload} disabled={loading}>刷新</button>
      </div>
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data ? (
        <>
          <Panel title={<span>集货计划 <span style={mono}>{data.planNo}</span> <StatusTag status={data.planStatus} /></span>}>
            <div style={{ fontSize: 13, display: "flex", gap: 16, flexWrap: "wrap" }}>
              <span>仓库：{data.warehouse}</span>
              <span>柜型：{data.containerType}</span>
              <span>目的地：{data.destinationTh}</span>
              <span>建立：{fmtTime(data.createdAt)}</span>
            </div>
          </Panel>
          {data.customers.map((c) => (
            <Panel key={c.customerId} title={`${c.clientId}${c.clientName && c.clientName !== c.clientId ? `（${c.clientName}）` : ""}`}>
              <div style={{ fontSize: 13, display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 8 }}>
                <span>本柜单价：{priceText(c.unitPrices)}</span>
                <span>方数：{fmtM3(c.totalVolumeM3)}</span>
                <span>件数：{c.totalPackages}</span>
                <span>金额：{fmtMoney(c.totalFee)}</span>
              </div>
              <div style={{ fontSize: 13, marginBottom: 10 }}>
                泰国收货地址：{c.deliveryAddress ? c.deliveryAddress : <span style={{ color: "var(--c-amber-deep)" }}>没填（请让客户填，或把地址发给湘泰超级管理员代填）</span>}
              </div>
              <TruncatedNote total={c.prealertTotal} limit={data.prealertLimit} truncated={c.prealertsTruncated} unit="张" label="预报单" which="最早的" />
              {c.prealerts.length === 0 ? <div style={{ fontSize: 13, color: "var(--t-muted)" }}>还没有预报单</div> : c.prealerts.map((pa) => <PrealertCard key={pa.id} pa={pa} />)}
            </Panel>
          ))}
        </>
      ) : null}
    </div>
  );
}

export default function AgentWhr({ focusPlanId, onFocusHandled }: { focusPlanId: string | null; onFocusHandled: () => void }) {
  const [planId, setPlanId] = useState<string | null>(focusPlanId);
  // 从首页「看明细」点进来：直接打开那个柜
  useEffect(() => {
    if (focusPlanId) {
      setPlanId(focusPlanId);
      onFocusHandled();
    }
  }, [focusPlanId, onFocusHandled]);

  const { data, loading, error, reload } = useAgentLoad(fetchAgentWhrPlans, []);

  if (planId) {
    return (
      <section>
        <SectionHeader title="仓库版集货明细" desc="只显示你名下客户在这个柜里的单子。" />
        <PlanDetail planId={planId} onBack={() => setPlanId(null)} />
      </section>
    );
  }

  return (
    <section>
      <SectionHeader
        title="仓库版集货"
        desc="名下客户所在的集货计划。一个柜里有别家的货时，只显示你名下客户那几行。"
        actions={<button type="button" style={btn} onClick={reload} disabled={loading}>刷新</button>}
      />
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data && data.items.length === 0 ? <EmptyStateCard title="暂无集货计划" description="名下客户还没有被加进仓库版集货计划。" /> : null}
      {data ? <TruncatedNote total={data.total} limit={data.limit} truncated={data.truncated} unit="个" label="集货计划" which="最近的" /> : null}
      {data && data.items.length > 0 ? (
        <TableWrap label="集货计划列表">
          <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
            <thead>
              <tr>
                <th scope="col" style={th}>计划号</th>
                <th scope="col" style={th}>计划状态</th>
                <th scope="col" style={th}>仓库 / 柜型</th>
                <th scope="col" style={th}>名下客户</th>
                <th scope="col" style={{ ...th, textAlign: "right" }}>方数</th>
                <th scope="col" style={{ ...th, textAlign: "right" }}>金额</th>
                <th scope="col" style={th}>建立时间</th>
                <th scope="col" style={th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.planId}>
                  <td style={{ ...td, ...mono }}>{p.planNo}</td>
                  <td style={td}><StatusTag status={p.planStatus} /></td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{p.warehouse} / {p.containerType}</td>
                  <td style={td}>
                    {p.customers.map((c) => (
                      <div key={c.customerId} style={{ whiteSpace: "nowrap" }}>
                        {c.clientId} <StatusTag status={c.latestStatus} /> <span style={{ fontSize: 12, color: "var(--t-muted)" }}>{c.prealertCount} 单{c.deliveryAddress ? "" : " · 没填地址"}</span>
                      </div>
                    ))}
                  </td>
                  <td style={tdNum}>{fmtM3(p.customers.reduce((s, c) => s + c.totalVolumeM3, 0))}</td>
                  <td style={tdNum}>{p.customers.some((c) => c.totalFee != null) ? fmtMoney(p.customers.reduce((s, c) => s + (c.totalFee ?? 0), 0)) : "—"}</td>
                  <td style={td}>{fmtTime(p.createdAt)}</td>
                  <td style={td}><button type="button" style={btn} onClick={() => setPlanId(p.planId)}>看明细</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : null}
    </section>
  );
}
