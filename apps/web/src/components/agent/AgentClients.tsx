"use client";

/**
 * 代理：名下客户和客户价（4.3 / 4.4 / 4.7）。
 * 这是代理唯一能改的东西。每档不能低于湘泰给代理的价（后端锁里再判一次，这里只是早点提示）。
 * 改了以后：客户在还没发运的柜里没付款的单按新价重算，已付款的不变（4.14）。
 */
import { useState } from "react";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import { fetchAgentClients, saveAgentClientPrice, type AgentClientItem, type PriceTriple } from "../../services/agent-api";
import { LoadState, Panel, SectionHeader, TableWrap, btn, btnPrimary, fmtTime, input, priceText, td, th, useAgentLoad } from "./agent-ui";

const KEYS = [
  { key: "normal", label: "普货" },
  { key: "inspection", label: "商检货" },
  { key: "sensitive", label: "敏感货" },
] as const;

function PriceEditor({ client, agentPrices, onSaved, onCancel }: { client: AgentClientItem; agentPrices: PriceTriple; onSaved: (msg: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Record<keyof PriceTriple, string>>({
    normal: client.price ? String(client.price.normal) : "",
    inspection: client.price ? String(client.price.inspection) : "",
    sensitive: client.price ? String(client.price.sensitive) : "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const localIssue = (): string => {
    const issues: string[] = [];
    for (const { key, label } of KEYS) {
      const text = draft[key].trim();
      if (!text) { issues.push(`${label}单价为必填`); continue; }
      if (!/^\d+(\.\d{1,2})?$/.test(text)) { issues.push(`${label}单价要填数字，最多两位小数`); continue; }
      if (Math.round(Number(text) * 100) < Math.round(agentPrices[key] * 100)) issues.push(`${label}不能低于湘泰给你的价 ${agentPrices[key]} 元/方`);
    }
    return issues.join("；");
  };

  const save = async () => {
    const issue = localIssue();
    if (issue) { setErr(issue); return; }
    setSaving(true);
    setErr("");
    try {
      const r = await saveAgentClientPrice({
        clientId: client.clientId,
        prices: { normal: Number(draft.normal), inspection: Number(draft.inspection), sensitive: Number(draft.sensitive) },
      });
      onSaved(r.updatedPlanRows > 0 ? `已保存。这个客户在 ${r.updatedPlanRows} 个还没发运的柜里没付款的单已按新价重算，已付款的不变。` : "已保存。以后加进柜子时自动带出这个价。");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: "10px 0" }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        {KEYS.map(({ key, label }) => (
          <label key={key} style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 3 }}>
            <span>{label}（不低于 {agentPrices[key]}）</span>
            <input style={{ ...input, width: 120 }} inputMode="decimal" value={draft[key]} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} aria-label={`${client.clientId} ${label}单价`} />
          </label>
        ))}
        <button type="button" style={btnPrimary} disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button>
        <button type="button" style={btn} disabled={saving} onClick={onCancel}>取消</button>
      </div>
      {err ? <p role="alert" style={{ margin: "6px 0 0", color: "var(--c-red-dark)", fontSize: 13 }}>{err}</p> : null}
    </div>
  );
}

export default function AgentClients() {
  const { data, loading, error, reload } = useAgentLoad(fetchAgentClients, []);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  return (
    <section>
      <SectionHeader title="客户和价格" desc="给名下客户填仓库版集货的价（按方、分三档）。填一次长期用，员工把客户加进柜时自动带出。没填价的客户用不了仓库版集货。" />
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {notice ? <div role="status" style={{ padding: "8px 12px", borderRadius: 8, background: "var(--c-green-bg)", color: "var(--c-green-deep)", fontSize: 13, marginBottom: 12 }}>{notice}</div> : null}
      {data ? (
        <>
          <Panel title="湘泰给你的价">
            <div style={{ fontSize: 14 }}>{priceText(data.agentPrices)}</div>
            <div style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 4 }}>客户价每一档都不能低于这个价。返现 = 方数 ×（客户价 − 这个价）。</div>
          </Panel>
          {data.items.length === 0 ? (
            <EmptyStateCard title="你名下还没有客户" description="客户账号由湘泰超级管理员开在你名下。" />
          ) : (
            <TableWrap label="名下客户">
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
                <thead>
                  <tr>
                    <th scope="col" style={th}>唛头</th>
                    <th scope="col" style={th}>名字 / 电话</th>
                    <th scope="col" style={th}>账号状态</th>
                    <th scope="col" style={th}>仓库版集货价</th>
                    <th scope="col" style={th}>上次改价</th>
                    <th scope="col" style={th}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((c) => (
                    <tr key={c.clientId}>
                      <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 600 }}>{c.clientId}</td>
                      <td style={td}>{c.name}<div style={{ fontSize: 12, color: "var(--t-muted)" }}>{c.phone}</div></td>
                      <td style={td}>{c.status === "active" ? "正常" : "已停用"}</td>
                      <td style={td}>
                        {editing === c.clientId ? (
                          <PriceEditor
                            client={c}
                            agentPrices={data.agentPrices}
                            onCancel={() => setEditing(null)}
                            onSaved={(msg) => { setEditing(null); setNotice(msg); reload(); }}
                          />
                        ) : c.price ? (
                          priceText(c.price)
                        ) : (
                          <span style={{ color: "var(--c-amber-deep)", fontWeight: 600 }}>未填价</span>
                        )}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{c.price ? fmtTime(c.price.updatedAt) : "—"}</td>
                      <td style={td}>
                        {editing === c.clientId ? null : (
                          <button type="button" style={btn} onClick={() => { setNotice(""); setEditing(c.clientId); }}>{c.price ? "改价" : "填价"}</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </>
      ) : null}
    </section>
  );
}
