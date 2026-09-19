"use client";

import { useCallback, useEffect, useState } from "react";
import AgentFormModal from "../../../components/admin/agents/AgentFormModal";
import AgentRebatesPanel from "../../../components/admin/agents/AgentRebatesPanel";
import {
  ErrorBar,
  Modal,
  StatusTag,
  btnCancel,
  btnConfirm,
  btnSmall,
  btnSmallDanger,
  fi,
  fl,
  hint,
  priceText,
  tdS,
  thS,
} from "../../../components/admin/agents/agent-ui";
import {
  fetchAdminAgents,
  resetAdminAgentPassword,
  setAdminAgentLoginStatus,
  type AdminAgentItem,
} from "../../../services/agents-admin-api";

/**
 * 代理管理（2026-09-16，B2；确认单 2.1 / 2.7 / 2.8 / 2.9 / 4.2 / 6.1 / 6.4）。
 * 外壳（左边菜单、登录核验、只许超管进）由根布局的 WorkbenchFrame 统一套上，这页**不许**再包 RoleShell。
 * 两块：代理列表（开代理、编辑、重置密码、停用登录号）和返现单。
 * 代理的客户在「管理员工作台 → 客户管理」里开（选归属），不在这页。
 */
export default function AdminAgentsPage() {
  const [tab, setTab] = useState<"agents" | "rebates">("agents");
  const [agents, setAgents] = useState<AdminAgentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [form, setForm] = useState<{ mode: "create" | "edit"; agent: AdminAgentItem | null } | null>(null);
  const [resetFor, setResetFor] = useState<AdminAgentItem | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [resetError, setResetError] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setAgents(await fetchAdminAgents());
    } catch (e) {
      setError(`代理列表加载失败：${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const toggleLogin = async (a: AdminAgentItem) => {
    const next = a.loginStatus === "active" ? "inactive" : "active";
    const question = next === "inactive"
      ? `停用「${a.name}」的登录账号 ${a.loginId}？\n\n停用后代理马上登不进来；他名下的客户照常登录、照常下单。`
      : `启用「${a.name}」的登录账号 ${a.loginId}？`;
    if (!confirm(question)) return;
    setBusyId(a.id);
    try {
      await setAdminAgentLoginStatus(a.id, next);
      setToast(next === "inactive" ? `已停用 ${a.name} 的登录账号` : `已启用 ${a.name} 的登录账号`);
      await load();
    } catch (e) {
      setError(`操作失败：${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setBusyId("");
    }
  };

  const submitReset = async () => {
    if (!resetFor) return;
    if (!newPassword) { setResetError("请填新密码"); return; }
    setBusyId(resetFor.id);
    setResetError("");
    try {
      const r = await resetAdminAgentPassword(resetFor.id, newPassword);
      setToast(`${resetFor.name} 的密码已重置（账号 ${r.loginId}），代理手上已登录的页面会被要求重新登录`);
      setResetFor(null);
      setNewPassword("");
    } catch (e) {
      setResetError(e instanceof Error ? e.message : "重置失败");
    } finally {
      setBusyId("");
    }
  };

  const tabBtn = (key: "agents" | "rebates", label: string) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      style={{
        padding: "6px 16px", fontSize: 14, cursor: "pointer", background: "transparent", border: "none",
        borderBottom: tab === key ? "2px solid var(--c-blue)" : "2px solid transparent",
        color: tab === key ? "var(--c-blue)" : "var(--t-muted)", fontWeight: tab === key ? 600 : 400,
      }}
    >{label}</button>
  );

  return (
    <div style={{ maxWidth: "100%", padding: "20px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>代理管理</h2>
        {tab === "agents" && (
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => void load()} disabled={loading} style={btnCancel}>{loading ? "刷新中…" : "刷新"}</button>
            <button type="button" onClick={() => setForm({ mode: "create", agent: null })} style={btnConfirm}>+ 开代理</button>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--l-soft)", marginBottom: 16 }}>
        {tabBtn("agents", "代理")}
        {tabBtn("rebates", "返现单")}
      </div>

      {toast && (
        <div onClick={() => setToast("")} style={{ cursor: "pointer", marginBottom: 12, padding: "10px 16px", background: "var(--c-green-bg)", color: "var(--c-green-deep)", borderRadius: 8, fontSize: 13 }}>{toast}</div>
      )}

      {tab === "agents" ? (
        <>
          <ErrorBar message={error} />
          <p style={{ fontSize: 13, color: "var(--t-muted)", margin: "0 0 12px" }}>
            代理的客户在「管理员工作台 → 客户管理」里开，开的时候选归哪个代理。代理自己不能开客户。
          </p>
          {loading && agents.length === 0 ? (
            <p style={{ color: "var(--t-faint)", fontSize: 14 }}>加载中...</p>
          ) : agents.length === 0 ? (
            <p style={{ color: "var(--t-faint)", fontSize: 14 }}>还没有代理，点右上角「+ 开代理」</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--s-alt)" }}>
                    <th style={thS}>代理</th>
                    <th style={thS}>登录账号</th>
                    <th style={thS}>账号状态</th>
                    <th style={{ ...thS, textAlign: "right" }}>名下客户</th>
                    <th style={thS}>给代理的价（元/方）</th>
                    <th style={thS}>客户登录链接</th>
                    <th style={thS}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a) => (
                    <tr key={a.id}>
                      <td style={tdS}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {a.logoUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={a.logoUrl} alt="" style={{ width: 28, height: 28, objectFit: "contain", borderRadius: 4, border: "1px solid var(--l-soft)" }} />
                          ) : null}
                          <span style={{ fontWeight: 600 }}>{a.name}</span>
                        </div>
                      </td>
                      <td style={{ ...tdS, fontFamily: "monospace", whiteSpace: "nowrap", minWidth: 100 }}>{a.loginId || "—"}</td>
                      <td style={tdS}>{a.loginStatus === "active" ? <StatusTag tone="green">正常</StatusTag> : <StatusTag tone="grey">已停用</StatusTag>}</td>
                      <td style={{ ...tdS, textAlign: "right" }}>{a.clientCount}</td>
                      <td style={{ ...tdS, whiteSpace: "nowrap" }}>
                        普货 {priceText(a.prices.normal)} · 商检 {priceText(a.prices.inspection)} · 敏感 {priceText(a.prices.sensitive)}
                      </td>
                      <td style={{ ...tdS, fontSize: 12 }}>
                        {a.slug ? <div style={{ whiteSpace: "nowrap" }}>后缀：<span style={{ fontFamily: "monospace" }}>/{a.slug}</span></div> : null}
                        {a.customDomain ? <div style={{ whiteSpace: "nowrap" }}>域名：<span style={{ fontFamily: "monospace" }}>{a.customDomain}</span></div> : null}
                        {!a.slug && !a.customDomain ? <span style={{ color: "var(--t-faint)" }}>没设</span> : null}
                      </td>
                      <td style={tdS}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button type="button" onClick={() => setForm({ mode: "edit", agent: a })} style={btnSmall}>编辑</button>
                          <button type="button" onClick={() => { setResetFor(a); setNewPassword(""); setResetError(""); }} disabled={!a.loginId} style={btnSmall}>重置密码</button>
                          <button type="button" onClick={() => void toggleLogin(a)} disabled={busyId === a.id || !a.loginId} style={a.loginStatus === "active" ? btnSmallDanger : btnSmall}>
                            {a.loginStatus === "active" ? "停用账号" : "启用账号"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <AgentRebatesPanel agents={agents} />
      )}

      {form && (
        <AgentFormModal
          mode={form.mode}
          agent={form.agent}
          onClose={() => setForm(null)}
          onSaved={(message) => { setForm(null); setToast(message); void load(); }}
        />
      )}

      {resetFor && (
        <Modal onClose={() => setResetFor(null)}>
          <h3 style={{ marginTop: 0 }}>重置代理密码：{resetFor.name}</h3>
          <ErrorBar message={resetError} />
          <div style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 10 }}>登录账号 <span style={{ fontFamily: "monospace" }}>{resetFor.loginId}</span>。新密码由代理提供。</div>
          <label style={fl}>新密码</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={fi} autoComplete="new-password" />
          <div style={hint}>至少 8 位，不能全是数字，不能跟账号一样</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <button type="button" onClick={() => setResetFor(null)} style={btnCancel}>取消</button>
            <button type="button" onClick={() => void submitReset()} disabled={busyId === resetFor.id} style={btnConfirm}>重置</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
