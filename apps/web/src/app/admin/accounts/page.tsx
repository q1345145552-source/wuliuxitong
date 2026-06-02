"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import RoleShell from "../../../modules/layout/RoleShell";
import Toast from "../../../modules/layout/Toast";
import {
  fetchManagedUsers,
  createManagedUser,
  resetUserPassword,
  toggleUserBan,
  type ManagedUser,
} from "../../../services/business-api";

export default function AdminAccountsPage() {
  const [list, setList] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", password: "", role: "client" as string, phone: "" });
  const [creating, setCreating] = useState(false);
  const [pwdModal, setPwdModal] = useState<ManagedUser | null>(null);
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [pwdSubmitting, setPwdSubmitting] = useState(false);
  const [pwdError, setPwdError] = useState("");
  const [actionId, setActionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await fetchManagedUsers();
      setList(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((u) => u.name.toLowerCase().includes(q));
  }, [list, search]);

  const handleCreate = async () => {
    if (!createForm.name.trim() || !createForm.password.trim()) return;
    setCreating(true);
    try {
      await createManagedUser(createForm);
      setToast("账号创建成功");
      setShowCreate(false);
      setCreateForm({ name: "", password: "", role: "client", phone: "" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const handleResetPwd = async () => {
    if (!pwdModal || !newPwd.trim() || newPwd.trim().length < 6) { setPwdError("密码至少 6 位"); return; }
    if (newPwd !== confirmPwd) { setPwdError("两次密码不一致"); return; }
    setPwdSubmitting(true);
    setPwdError("");
    try {
      await resetUserPassword(pwdModal.id, newPwd.trim());
      setToast("密码修改成功");
      setPwdModal(null);
      setNewPwd("");
      setConfirmPwd("");
    } catch (e) {
      setPwdError(e instanceof Error ? e.message : "修改失败");
    } finally {
      setPwdSubmitting(false);
    }
  };

  const handleToggleBan = async (user: ManagedUser) => {
    setActionId(user.id);
    try {
      const result = await toggleUserBan(user.id);
      setToast(result.status === "active" ? "已解除封禁" : "已封禁");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setActionId(null);
    }
  };

  return (
    <RoleShell allowedRole="admin" title="账号管理">
      <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--ink)", margin: "0 0 16px" }}>账号管理</h1>

      {/* 创建账号 */}
      <div style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-lg)", padding: 16, background: "var(--canvas)", marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 600, color: "var(--ink)" }}>创建新账号</span>
          <button onClick={() => setShowCreate(!showCreate)} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "6px 14px", background: "var(--canvas)", cursor: "pointer", fontSize: 13, fontWeight: 500, color: "#000000" }}>
            {showCreate ? "收起" : "展开"}
          </button>
        </div>
        {showCreate && (
          <div style={{ marginTop: 12, display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <input value={createForm.name} onChange={(e) => setCreateForm((v) => ({ ...v, name: e.target.value }))} placeholder="姓名" style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 14 }} />
            <input type="password" value={createForm.password} onChange={(e) => setCreateForm((v) => ({ ...v, password: e.target.value }))} placeholder="密码（至少 6 位）" style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 14 }} />
            <select value={createForm.role} onChange={(e) => setCreateForm((v) => ({ ...v, role: e.target.value }))} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 14 }}>
              <option value="client">客户</option>
              <option value="staff">员工</option>
            </select>
            <input value={createForm.phone} onChange={(e) => setCreateForm((v) => ({ ...v, phone: e.target.value }))} placeholder="手机号" style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 14 }} />
            <button disabled={creating} onClick={handleCreate} style={{ border: "none", borderRadius: "var(--radius-sm)", padding: "8px 16px", background: "var(--brand)", color: "#fff", fontWeight: 500, fontSize: 14, cursor: creating ? "not-allowed" : "pointer" }}>
              {creating ? "创建中…" : "创建账号"}
            </button>
          </div>
        )}
      </div>

      {/* 搜索 */}
      <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索账号或姓名…" style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 13, flex: 1, maxWidth: 320 }} />
      </div>

      {/* 列表 */}
      {error && <p style={{ color: "var(--accent-crimson)", fontSize: 13, marginBottom: 8 }}>{error}</p>}
      {loading ? <p style={{ color: "var(--ink-mute)", fontSize: 13 }}>加载中…</p> : (
        <div style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-lg)", overflow: "hidden", background: "var(--canvas)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--canvas-soft)" }}>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>账号</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>角色</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>真实姓名</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>状态</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>创建时间</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 500, color: "var(--ink-mute)" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id} style={{ borderTop: "1px solid var(--hairline-cool)" }}>
                  <td style={{ padding: "10px 12px", fontWeight: 500 }}>{u.name}</td>
                  <td style={{ padding: "10px 12px" }}>{u.role === "staff" ? "员工" : "客户"}</td>
                  <td style={{ padding: "10px 12px" }}>{u.name || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>
                    {u.status === "inactive"
                      ? <span style={{ color: "var(--accent-crimson)", fontWeight: 500, fontSize: 12 }}>已封禁</span>
                      : <span style={{ color: "var(--success)", fontWeight: 500, fontSize: 12 }}>正常</span>
                    }
                  </td>
                  <td style={{ padding: "10px 12px", color: "var(--ink-mute)" }}>{u.createdAt.slice(0, 10)}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button disabled={actionId === u.id} onClick={() => { setPwdModal(u); setNewPwd(""); setConfirmPwd(""); setPwdError(""); }} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-xs)", padding: "4px 10px", fontSize: 12, background: "var(--canvas)", cursor: "pointer", fontWeight: 500, color: "#000000" }}>
                        修改密码
                      </button>
                      <button disabled={actionId === u.id} onClick={() => void handleToggleBan(u)} style={{ border: `1px solid ${u.status === "inactive" ? "var(--success)" : "var(--accent-crimson)"}`, borderRadius: "var(--radius-xs)", padding: "4px 10px", fontSize: 12, background: "var(--canvas)", cursor: "pointer", fontWeight: 500, color: u.status === "inactive" ? "var(--success)" : "var(--accent-crimson)" }}>
                        {u.status === "inactive" ? "解除封禁" : "封禁"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 20, textAlign: "center", color: "var(--ink-mute)" }}>暂无账号</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 修改密码弹窗 */}
      {pwdModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", padding: 16 }}>
          <div style={{ width: "100%", maxWidth: 420, background: "var(--canvas)", borderRadius: "var(--radius-xl)", border: "1px solid var(--hairline)", padding: 24, boxShadow: "var(--shadow-lg)" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>修改密码</h3>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--ink-mute)" }}>账号「{pwdModal.name}」将使用新密码登录</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} placeholder="新密码（至少 6 位）" style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 14 }} />
              <input type="password" value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)} placeholder="确认新密码" style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 12px", fontSize: 14 }} />
              {pwdError && <p style={{ color: "var(--accent-crimson)", fontSize: 13, margin: 0 }}>{pwdError}</p>}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                <button onClick={() => setPwdModal(null)} style={{ border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px 16px", fontSize: 13, background: "var(--canvas)", cursor: "pointer", color: "#000000" }}>取消</button>
                <button disabled={pwdSubmitting} onClick={handleResetPwd} style={{ border: "none", borderRadius: "var(--radius-sm)", padding: "8px 16px", fontSize: 13, background: "var(--brand)", color: "#fff", fontWeight: 500, cursor: pwdSubmitting ? "not-allowed" : "pointer" }}>
                  {pwdSubmitting ? "提交中…" : "确认修改"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <Toast open={toast.length > 0} message={toast} />
    </RoleShell>
  );
}
