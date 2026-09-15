"use client";

/**
 * 代理：我的价格（3.4）。湘泰给代理的三档价、代理名字和 logo、客户登录用的前缀 / 专属域名。
 * 这些都只能由湘泰超级管理员在「代理管理」里改，这里只读。
 */
import { fetchAgentMe } from "../../services/agent-api";
import { LoadState, Panel, SectionHeader, TableWrap, td, tdNum, th, useAgentLoad } from "./agent-ui";

export default function AgentMe() {
  const { data, loading, error, reload } = useAgentLoad(fetchAgentMe, []);
  return (
    <section>
      <SectionHeader title="我的价格" desc="湘泰给你的仓库版集货价。要调整请联系湘泰超级管理员。" />
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data ? (
        <>
          <Panel title="湘泰给你的价">
            <TableWrap label="代理价">
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 320 }}>
                <thead>
                  <tr>
                    <th scope="col" style={th}>货型</th>
                    <th scope="col" style={{ ...th, textAlign: "right" }}>元/方</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td style={td}>普货</td><td style={tdNum}>{data.prices.normal}</td></tr>
                  <tr><td style={td}>商检货</td><td style={tdNum}>{data.prices.inspection}</td></tr>
                  <tr><td style={td}>敏感货</td><td style={tdNum}>{data.prices.sensitive}</td></tr>
                </tbody>
              </table>
            </TableWrap>
            <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--t-muted)" }}>返现 = 方数 ×（客户价 − 这个价），按货型分开算。例：10 方普货、客户价比这个价高 50 元/方，返现 500 元。</p>
          </Panel>
          <Panel title="名字和登录">
            <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
              {data.logoUrl ? <img src={data.logoUrl} alt={`${data.name} logo`} style={{ width: 56, height: 56, objectFit: "contain", borderRadius: 8, border: "1px solid var(--l-soft)" }} /> : null}
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{data.name}</div>
                <div style={{ color: "var(--t-muted)", marginTop: 4 }}>客户登录前缀：{data.slug ?? "未设置"}</div>
                <div style={{ color: "var(--t-muted)" }}>专属域名：{data.customDomain ?? "未设置"}</div>
              </div>
            </div>
          </Panel>
        </>
      ) : null}
    </section>
  );
}
