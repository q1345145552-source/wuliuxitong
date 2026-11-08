"use client";

import { useState } from "react";
import AgentFormModal from "./AgentFormModal";
import { ErrorBar, Modal, StatusTag, btnCancel, btnConfirm, btnSmall, btnSmallDanger, fl, hint, tdS, thS } from "./agent-ui";
import { formatBeijingTimeShort } from "../../../modules/staff/utils";
import {
  rejectAdminAgentApplication,
  type AdminAgentApplicationItem,
  type AgentApplicationStatus,
} from "../../../services/agents-admin-api";

/**
 * 代理管理 →「代理申请」页签（2026-11-08，老板：「财务提交，物流审批」）。
 * 别的海外仓在海外仓财务系统里交的申请都在这里：待审的点「通过」（打开开代理弹窗，名字 / 账号 / 电话预先填好，
 * 价和密码超管填）或「驳回」（必须写原因）；处理过的显示结果和谁、什么时候处理的。
 * 老板定的：已经是客户的另开代理号；密码线下告诉对方；对方要在海外仓财务系统用新代理号授权登录一次才绑上。
 */
const STATUS_LABEL: Record<AgentApplicationStatus, string> = { pending: "待审", approved: "已通过", rejected: "已驳回" };
const t = (iso: string | null) => formatBeijingTimeShort(iso, "—");
const REJECT_REASON_MAX = 200;

export default function AgentApplicationsPanel(props: {
  items: AdminAgentApplicationItem[];
  counts: Record<AgentApplicationStatus, number>;
  loading: boolean;
  error: string;
  /** 通过 / 驳回成功后：页面弹提示、重拉申请和代理列表 */
  onChanged: (message: string) => void;
  /** 出错（比如别的超管刚处理过 → 409）或关掉通过弹窗时：重拉一次申请，页面上的状态别停在旧的 */
  onReload: () => void;
}) {
  const { items, counts, loading, error, onChanged, onReload } = props;
  const [filter, setFilter] = useState<AgentApplicationStatus | "all">("all");
  const [approving, setApproving] = useState<AdminAgentApplicationItem | null>(null);
  const [rejecting, setRejecting] = useState<AdminAgentApplicationItem | null>(null);
  const [reason, setReason] = useState("");
  const [rejectError, setRejectError] = useState("");
  const [busy, setBusy] = useState(false);

  const shown = filter === "all" ? items : items.filter((a) => a.status === filter);
  const total = counts.pending + counts.approved + counts.rejected;

  const submitReject = async () => {
    if (!rejecting) return;
    const text = reason.trim();
    if (!text) { setRejectError("请填驳回原因"); return; }
    setBusy(true);
    setRejectError("");
    try {
      await rejectAdminAgentApplication(rejecting.id, text);
      setRejecting(null);
      setReason("");
      onChanged(`已驳回「${rejecting.agentName}」的申请，海外仓那边可以重新提交`);
    } catch (e) {
      setRejectError(e instanceof Error ? e.message : "驳回失败");
      onReload();
    } finally {
      setBusy(false);
    }
  };

  const filterBtn = (key: AgentApplicationStatus | "all", label: string, n: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      style={{ ...btnSmall, ...(filter === key ? { borderColor: "var(--c-blue)", color: "var(--c-blue)", fontWeight: 600 } : {}) }}
    >{label}（{n}）</button>
  );

  return (
    <>
      <ErrorBar message={error} />
      <p style={{ fontSize: 13, color: "var(--t-muted)", margin: "0 0 12px" }}>
        别的海外仓在海外仓财务系统里交的「当湘泰代理」申请。通过会马上开出代理号，密码请线下告诉对方；
        对方要在海外仓财务系统用新代理号授权登录一次才绑上。已经是客户的，另开代理号，原来的客户号不动。
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {filterBtn("all", "全部", total)}
        {filterBtn("pending", "待审", counts.pending)}
        {filterBtn("approved", "已通过", counts.approved)}
        {filterBtn("rejected", "已驳回", counts.rejected)}
      </div>

      {loading && items.length === 0 ? (
        <p style={{ color: "var(--t-faint)", fontSize: 14 }}>加载中...</p>
      ) : shown.length === 0 ? (
        <p style={{ color: "var(--t-faint)", fontSize: 14 }}>{filter === "all" ? "还没有代理申请" : `没有${STATUS_LABEL[filter]}的申请`}</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          {/* 列多：给个最小宽度，窄屏左右滑，别把备注、名字挤成一个字一行 */}
          <table className="a3-table" style={{ width: "100%", minWidth: 1180, borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--s-alt)" }}>
                <th style={thS}>提交时间</th>
                <th style={thS}>来自哪个海外仓</th>
                <th style={thS}>提交人</th>
                <th style={thS}>代理名字</th>
                <th style={thS}>联系人</th>
                <th style={thS}>电话</th>
                <th style={thS}>想用的账号</th>
                <th style={thS}>备注</th>
                <th style={thS}>状态</th>
                <th style={thS}>处理</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td style={{ ...tdS, whiteSpace: "nowrap" }}>{t(a.createdAt)}</td>
                  <td style={{ ...tdS, minWidth: 100 }}>{a.warehouseName}</td>
                  <td style={{ ...tdS, whiteSpace: "nowrap" }}>{a.submittedBy}</td>
                  <td style={{ ...tdS, fontWeight: 600, minWidth: 100 }}>{a.agentName}</td>
                  <td style={{ ...tdS, whiteSpace: "nowrap" }}>{a.contactName}</td>
                  <td style={{ ...tdS, whiteSpace: "nowrap" }}>{a.contactPhone}</td>
                  <td style={{ ...tdS, fontFamily: "monospace", whiteSpace: "nowrap", minWidth: 100 }}>{a.loginId}</td>
                  <td style={{ ...tdS, minWidth: 140, maxWidth: 240, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{a.remark || <span style={{ color: "var(--t-faint)" }}>—</span>}</td>
                  <td style={{ ...tdS, whiteSpace: "nowrap" }}>
                    {a.status === "pending" ? <StatusTag tone="amber">待审</StatusTag> : a.status === "approved" ? <StatusTag tone="green">已通过</StatusTag> : <StatusTag tone="grey">已驳回</StatusTag>}
                  </td>
                  <td style={{ ...tdS, fontSize: 12, minWidth: 150 }}>
                    {a.status === "pending" ? (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button type="button" onClick={() => setApproving(a)} style={btnSmall}>通过</button>
                        <button type="button" onClick={() => { setRejecting(a); setReason(""); setRejectError(""); }} style={btnSmallDanger}>驳回</button>
                      </div>
                    ) : (
                      <div>
                        {a.status === "approved" ? (
                          <div>开出账号 <span style={{ fontFamily: "monospace" }}>{a.approvedLoginId ?? "—"}</span></div>
                        ) : (
                          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxWidth: 240 }}>驳回：{a.rejectReason ?? "—"}</div>
                        )}
                        {/* 处理人账号被删了没有名字，就显示账号编号（Codex 审查） */}
                        <div style={{ color: "var(--t-muted)", whiteSpace: "nowrap" }}>{a.reviewedByName ?? a.reviewedById ?? "—"} · {t(a.reviewedAt)}</div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {approving && (
        <AgentFormModal
          mode="create"
          application={approving}
          onClose={() => { setApproving(null); onReload(); }}
          onSaved={(message) => { setApproving(null); onChanged(message); }}
        />
      )}

      {rejecting && (
        <Modal onClose={() => setRejecting(null)}>
          <h3 style={{ marginTop: 0 }}>驳回代理申请：{rejecting.agentName}</h3>
          <ErrorBar message={rejectError} />
          <div style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 10 }}>来自海外仓「{rejecting.warehouseName}」。原因会给海外仓那边看到，驳回后对方可以重新提交。</div>
          <label style={fl}>驳回原因</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REJECT_REASON_MAX} rows={3} style={{ width: "100%", padding: "7px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, boxSizing: "border-box", resize: "vertical" }} />
          <div style={hint}>必填，最多 {REJECT_REASON_MAX} 个字</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <button type="button" onClick={() => setRejecting(null)} style={btnCancel}>取消</button>
            <button type="button" onClick={() => void submitReject()} disabled={busy} style={{ ...btnConfirm, background: "var(--c-red)", opacity: busy ? 0.6 : 1 }}>{busy ? "提交中…" : "确认驳回"}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
