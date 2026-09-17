"use client";

/**
 * 代理首页：名下客户卡住的单（确认单 3.10）。
 * 湘泰不直接联系客户，找代理；代理登录后先看到这三类，由他去催。
 */
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import { AGENT_WHR_FEATURES_ENABLED } from "../../modules/agent/agent-features";
import { fetchAgentDashboard, type AgentStuckPrealert } from "../../services/agent-api";
import { LoadState, Panel, SectionHeader, StatusTag, TableWrap, TruncatedNote, btn, fmtMoney, fmtTime, mono, td, tdNum, th, useAgentLoad } from "./agent-ui";

/** 首页三类都是最早的排前面：催完的会消失，刷新后接着显示后面的 */
const STUCK_HINT = "先催这些，处理完刷新会接着显示后面的";

function PrealertTable({ rows, showFee, onOpenPlan }: { rows: AgentStuckPrealert[]; showFee?: boolean; onOpenPlan: (planId: string) => void }) {
  return (
    <TableWrap label="卡住的集货单">
      <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
        <thead>
          <tr>
            <th scope="col" style={th}>客户</th>
            <th scope="col" style={th}>预报单号</th>
            <th scope="col" style={th}>唛头</th>
            <th scope="col" style={th}>集货计划</th>
            <th scope="col" style={th}>状态</th>
            {showFee ? <th scope="col" style={{ ...th, textAlign: "right" }}>应付金额</th> : null}
            <th scope="col" style={th}>{showFee ? "仓库签收" : "建单时间"}</th>
            <th scope="col" style={th}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.prealertId}>
              <td style={td}>{r.clientName || r.clientId}<div style={{ fontSize: 12, color: "var(--t-faint)" }}>{r.clientId}</div></td>
              <td style={{ ...td, ...mono }}>{r.trackingNo}</td>
              <td style={td}>{r.mark}</td>
              <td style={{ ...td, ...mono }}>{r.planNo}</td>
              <td style={td}><StatusTag status={r.status} /></td>
              {showFee ? <td style={tdNum}>{fmtMoney(r.totalFee)}</td> : null}
              <td style={td}>{fmtTime(showFee ? r.signedAt : r.createdAt)}</td>
              <td style={td}><button type="button" style={btn} onClick={() => onOpenPlan(r.planId)}>看明细</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export default function AgentHome({ onOpenPlan }: { onOpenPlan: (planId: string) => void }) {
  /**
   * 首页这三类全是仓库版集货的催单。2026-09-18 老板拍板暂时不对代理开放集货，
   * 所以关着的时候**连请求都不发**（关了还去拉数据等于白占后端），只写一句话说清去哪看。
   * 开关：modules/agent/agent-features.ts
   */
  if (!AGENT_WHR_FEATURES_ENABLED) {
    return (
      <section aria-labelledby="agent-home-title">
        <SectionHeader title="首页" desc="仓库版集货相关的提醒暂时关闭了。" />
        <EmptyStateCard
          title="暂时没有要催的单"
          description="名下客户的货在「运单」里看，返现在「返现单」里看。"
        />
      </section>
    );
  }
  return <AgentHomeStuck onOpenPlan={onOpenPlan} />;
}

function AgentHomeStuck({ onOpenPlan }: { onOpenPlan: (planId: string) => void }) {
  const { data, loading, error, reload } = useAgentLoad(fetchAgentDashboard, []);

  return (
    <section aria-labelledby="agent-home-title">
      <SectionHeader
        title="卡住的单"
        desc="名下客户仓库版集货里需要你去催的单子。客户改好、湘泰处理后会自动从这里消失。"
        actions={<button type="button" style={btn} onClick={reload} disabled={loading}>刷新</button>}
      />
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data ? (
        data.clientCount === 0 ? (
          <EmptyStateCard title="你名下还没有客户" description="客户账号由湘泰超级管理员开在你名下，开好后这里就能看到。" />
        ) : (
          <>
            {/* 括号里是真实条数（接口 caps.total）；列表超过上限时下面写清只显示了多少（CLAUDE.md #21） */}
            <Panel title={`没填尺寸（${data.caps?.missingSize.total ?? data.missingSize.length}）`}>
              <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--t-muted)" }}>货还没签收，但客户的货品长宽高没填全。仓库签收是按客户填的尺寸算方数收钱的，请催客户在「集货拼柜(仓库版)」里补上。</p>
              <TruncatedNote {...data.caps?.missingSize} unit="张" which="最早的" hint={STUCK_HINT} />
              {data.missingSize.length === 0 ? <EmptyStateCard title="没有" description="名下客户的待签收单尺寸都填好了。" /> : <PrealertTable rows={data.missingSize} onOpenPlan={onOpenPlan} />}
            </Panel>

            <Panel title={`没填泰国地址（${data.caps?.missingAddress.total ?? data.missingAddress.length}）`}>
              <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--t-muted)" }}>这些柜还没发运，但客户没填泰国收货地址。请让客户自己填，或者把地址发给湘泰超级管理员代填。</p>
              <TruncatedNote {...data.caps?.missingAddress} unit="条" which="最早的" hint={STUCK_HINT} />
              {data.missingAddress.length === 0 ? (
                <EmptyStateCard title="没有" description="名下客户在跑的柜都填了地址。" />
              ) : (
                <TableWrap label="没填泰国地址">
                  <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
                    <thead>
                      <tr>
                        <th scope="col" style={th}>客户</th>
                        <th scope="col" style={th}>集货计划</th>
                        <th scope="col" style={th}>计划状态</th>
                        <th scope="col" style={{ ...th, textAlign: "right" }}>预报单数</th>
                        <th scope="col" style={th}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.missingAddress.map((r) => (
                        <tr key={`${r.planId}-${r.clientId}`}>
                          <td style={td}>{r.clientName || r.clientId}<div style={{ fontSize: 12, color: "var(--t-faint)" }}>{r.clientId}</div></td>
                          <td style={{ ...td, ...mono }}>{r.planNo}</td>
                          <td style={td}><StatusTag status={r.planStatus} /></td>
                          <td style={tdNum}>{r.prealertCount}</td>
                          <td style={td}><button type="button" style={btn} onClick={() => onOpenPlan(r.planId)}>看明细</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </Panel>

            <Panel title={`没付款（${data.caps?.unpaid.total ?? data.unpaid.length}）`}>
              <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--t-muted)" }}>仓库已签收、金额已算好，客户还没付款。不付款的货装不了柜，请催客户在客户端点「付款」（从集货余额里扣）。</p>
              <TruncatedNote {...data.caps?.unpaid} unit="张" which="最早的" hint={STUCK_HINT} />
              {data.unpaid.length === 0 ? <EmptyStateCard title="没有" description="名下客户签收的单都付款了。" /> : <PrealertTable rows={data.unpaid} showFee onOpenPlan={onOpenPlan} />}
            </Panel>
          </>
        )
      ) : null}
    </section>
  );
}
