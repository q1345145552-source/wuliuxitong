"use client";

/**
 * 员工端「客户账号」（2026-10-19 老板拍板「给员工加权限」）：客户忘了密码，员工在这里重置，不用再找超管。
 * 只列客户号、只显示唛头（2026-09-19「显示唛头就行了」）；后端 /staff/clients/set-password 只认客户号，
 * 员工 / 超管 / 代理的号照旧找超管。客户密码不卡强度（2026-08-07 客户端不动），密码框默认看得见（2026-10-11 建号框同款）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import DetailModal from "../layout/DetailModal";
import Toast from "../layout/Toast";
import { fetchStaffClients, resetStaffClientPassword, type StaffClientItem } from "../../services/business-api";
import { isBannedClient } from "../shared/client-ban";

export default function ClientAccountsView() {
  const [clients, setClients] = useState<StaffClientItem[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [resetting, setResetting] = useState<{ seq: number; id: string } | null>(null);
  const resetSeqRef = useRef(0);
  const [toast, setToast] = useState<{ seq: number; message: string }>({ seq: 0, message: "" });
  /* 第几次拉名单：点了「刷新」又点一次，先发的晚回来不许盖掉后发的 */
  const loadSeqRef = useRef(0);

  const load = async () => {
    const seq = ++loadSeqRef.current;
    setLoadError("");
    try {
      const items = await fetchStaffClients();
      if (seq === loadSeqRef.current) setClients(items);
    } catch (e) {
      if (seq === loadSeqRef.current) setLoadError(e instanceof Error ? e.message : "客户名单没拉下来");
    }
  };
  useEffect(() => {
    void load();
    return () => { loadSeqRef.current += 1; }; // 离开这一页，晚回来的不管
  }, []);

  const shown = useMemo(() => {
    const k = keyword.trim().toUpperCase();
    return (clients ?? []).filter((c) => !k || c.id.toUpperCase().includes(k));
  }, [clients, keyword]);

  return (
    <div className="ca-page">
      <div className="ca-toolbar">
        <p className="ca-hint">客户忘了密码在这里重置。只能重置客户的密码；员工、超管、代理的密码请找超管。</p>
        <div className="ca-toolbar-right">
          <input className="ca-search" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜唛头" aria-label="搜唛头" />
          <button type="button" className="ca-btn" onClick={() => void load()}>刷新</button>
        </div>
      </div>
      {loadError ? <p className="ca-error" role="alert">客户名单没拉下来：{loadError}（点「刷新」再试）</p> : null}
      {!loadError && clients === null ? <p className="ca-muted">读取中…</p> : null}
      {clients !== null ? (
        shown.length === 0 ? (
          <p className="ca-muted">{keyword.trim() ? "没有这个唛头" : "还没有客户"}</p>
        ) : (
          <table className="a3-table ca-table">
            <thead>
              <tr><th scope="col">唛头</th><th scope="col">状态</th><th scope="col">操作</th></tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  <td>{c.id}</td>
                  <td>{isBannedClient(c) ? <span className="ca-banned">已封禁</span> : "正常"}</td>
                  <td>
                    <button
                      type="button"
                      className="ca-btn"
                      onClick={() => { resetSeqRef.current += 1; setResetting({ seq: resetSeqRef.current, id: c.id }); }}
                    >
                      重置密码
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
      {clients !== null ? <p className="ca-muted">共 {clients.length} 个客户{keyword.trim() ? `，搜到 ${shown.length} 个` : ""}</p> : null}

      {resetting ? (
        <ResetPasswordModal
          // 加前缀：同一层有 <Toast key={toast.seq}>，两个都是从 1 数起的数字（CLAUDE.md 教训 39）
          key={`reset-${resetting.seq}`}
          clientId={resetting.id}
          onClose={() => { const seq = resetting.seq; setResetting((v) => (v && v.seq === seq ? null : v)); }}
          onDone={(message) => {
            const seq = resetting.seq;
            setResetting((v) => (v && v.seq === seq ? null : v));
            setToast((t) => ({ seq: t.seq + 1, message }));
          }}
        />
      ) : null}
      <Toast key={toast.seq} open={toast.message.length > 0} message={toast.message} />
    </div>
  );
}

function ResetPasswordModal(props: { clientId: string; onClose: () => void; onDone: (message: string) => void }) {
  const { clientId, onClose, onDone } = props;
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /* 关掉以后才回来的结果不再往这个弹窗里写。
     ⚠️ 挂上时要重新置 true：开发环境（严格模式）会「挂上 → 卸掉 → 再挂上」各跑一遍，只在卸掉时置 false 的话
     第二次挂上以后一直是 false，点了重置永远卡在「重置中…」（2026-10-19 浏览器实点发现） */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const submit = async () => {
    if (saving) return;
    const value = password.trim();
    if (!value) { setError("请填新密码"); return; }
    if (value.length > 128) { setError("密码太长了（最多 128 位）"); return; }
    setSaving(true);
    setError("");
    try {
      await resetStaffClientPassword(clientId, value);
      if (aliveRef.current) onDone(`唛头 ${clientId} 的密码已重置，请把新密码告诉客户`);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : "重置失败，请稍后再试");
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  };

  return (
    <DetailModal title="重置密码" subtitle={`唛头 ${clientId}`} onClose={onClose}>
      <form className="ca-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="ca-field">
          <span>新密码</span>
          {/* 默认看得见：员工要把新密码告诉客户，看不见容易打错（2026-10-11 建号框同款） */}
          <input type="text" autoComplete="off" value={password} disabled={saving} onChange={(e) => setPassword(e.target.value)} placeholder="客户的新密码" />
        </label>
        <p className="ca-muted">重置以后，客户已经登录的手机、电脑会退出，要用新密码重新登录。</p>
        {error ? <p className="ca-error" role="alert">{error}</p> : null}
        <div className="ca-actions">
          <button type="button" className="ca-btn" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="ca-btn ca-btn-primary" disabled={saving}>{saving ? "重置中…" : "确认重置"}</button>
        </div>
      </form>
    </DetailModal>
  );
}
