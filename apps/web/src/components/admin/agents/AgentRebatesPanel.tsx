"use client";

import { useCallback, useEffect, useState } from "react";
import { formatBeijingTimeShort } from "../../../modules/staff/utils";
import {
  fetchAgentRebateDetail,
  fetchAgentRebateStatements,
  markAgentRebatePaid,
  undoAgentRebatePaid,
  type AdminAgentItem,
  type AgentPriceTriple,
  type AgentRebateHistoryItem,
  type AgentRebateLineItem,
  type AgentRebateStatementItem,
} from "../../../services/agents-admin-api";
import { ErrorBar, Modal, StatusTag, btnCancel, btnConfirm, btnSmall, fi, fl, money, priceText, tdNum, tdS, thS } from "./agent-ui";

/**
 * 返现单（2026-09-16，B2；确认单 4.12 / 4.13 / 4.20 / 6.4）。
 * 按代理、按月看；点开看每一票明细；湘泰线下转完账点「已返」。
 * 单子是系统每月 1 号（北京时间）自动出的，这里不能改金额、不能删。
 *
 * 2026-09-18 老板拍板：「已返」**能撤回，但要看得到记录**。撤回要写一句原因，
 * 「已返」和「撤回」都记进操作记录，在明细弹窗最下面一条一条列出来。
 */

const BUCKETS: Array<[keyof AgentPriceTriple, string]> = [["normal", "普货"], ["inspection", "商检"], ["sensitive", "敏感"]];

/** 这一票有哪几种货型（方数大于 0 的档） */
function cargoLabel(v: AgentPriceTriple): string {
  const labels = BUCKETS.filter(([k]) => v[k] > 0).map(([, l]) => l);
  return labels.length > 0 ? labels.join(" + ") : "—";
}
/** 按货型逐档写：「普 1.235 / 商 0.5」，没有的档不写 */
function perBucket(v: AgentPriceTriple, volumes: AgentPriceTriple, fmt: (n: number) => string): string {
  const parts = BUCKETS.filter(([k]) => volumes[k] > 0).map(([k, l]) => `${l} ${fmt(v[k])}`);
  return parts.length > 0 ? parts.join(" / ") : "—";
}
const t = (iso: string | null) => formatBeijingTimeShort(iso, "—");

export default function AgentRebatesPanel({ agents }: { agents: AdminAgentItem[] }) {
  const [agentId, setAgentId] = useState("");
  const [month, setMonth] = useState("");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<AgentRebateStatementItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [detail, setDetail] = useState<{ statement: AgentRebateStatementItem; lines: AgentRebateLineItem[]; history: AgentRebateHistoryItem[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState("");
  const [paying, setPaying] = useState("");
  /** 正在撤回哪张单（要先写原因）；原因框的内容；撤回弹框里自己的报错 */
  const [undoing, setUndoing] = useState<AgentRebateStatementItem | null>(null);
  const [undoReason, setUndoReason] = useState("");
  /** ⚠️ 弹框里的报错必须渲染在弹框**里面**：Modal 是 inset:0 + zIndex 9999 的遮罩，
   *  页面上那条 ErrorBar 会被它压在后面，员工只看到「点了没反应」（Opus 复核 2026-09-18 第 1 条）。 */
  const [undoError, setUndoError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setItems(await fetchAgentRebateStatements({ agentId, month, status }));
    } catch (e) {
      setError(`返现单加载失败：${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  }, [agentId, month, status]);
  useEffect(() => { void load(); }, [load]);

  const openDetail = async (id: string) => {
    setDetailLoading(id);
    try {
      setDetail(await fetchAgentRebateDetail(id));
    } catch (e) {
      setError(`明细加载失败：${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setDetailLoading("");
    }
  };

  const markPaid = async (s: AgentRebateStatementItem) => {
    if (!confirm(`确认已经把 ${money(s.totalRebate)} 转给「${s.agentName}」（${s.month} 返现单）？\n\n点了以后这张单显示「已返」。点错了可以撤回，撤回要写原因、会留操作记录。`)) return;
    setPaying(s.id);
    let done = false;
    try {
      const r = await markAgentRebatePaid(s.id);
      setToast(r.alreadyPaid ? "这张单刚刚已经被点过「已返」了" : `${s.agentName} ${s.month} 已标记已返`);
      done = true;
    } catch (e) {
      setError(`标记失败：${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setPaying("");
    }
    if (!done) return;
    // 同撤回：刷新失败不能说成「标记失败」（已返已经记上了）
    try {
      await load();
      if (detail?.statement.id === s.id) setDetail(await fetchAgentRebateDetail(s.id));
    } catch (e) {
      setError(`已返已经记上了，但页面没刷新出来（${e instanceof Error ? e.message : "未知错误"}），点一下「刷新」`);
    }
  };

  /** 撤回「已返」：原因必填（后端也卡），成功后这张单回到「未返」，操作记录里多一条 */
  const undoPaid = async () => {
    const s = undoing;
    const reason = undoReason.trim();
    if (!s) return;
    if (!reason) {
      setUndoError("撤回要写一句原因（比如「转错账号」），会记进操作记录");
      return;
    }
    setPaying(s.id);
    setUndoError("");
    let done = false;
    try {
      const r = await undoAgentRebatePaid(s.id, reason);
      setToast(r.alreadyUnpaid ? "这张单刚刚已经被撤回了" : `${s.agentName} ${s.month} 已撤回「已返」，回到未返`);
      done = true;
    } catch (e) {
      // 报错留在弹框里，别关框 —— 员工能看见原因、改完再点
      setUndoError(`撤回失败：${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setPaying("");
    }
    if (!done) return;
    setUndoing(null);
    setUndoReason("");
    // ⚠️ 刷新失败不能说成「撤回失败」：库里已经改了、流水也写了（Opus 复核 2026-09-18 第 2 条）
    try {
      await load();
      if (detail?.statement.id === s.id) setDetail(await fetchAgentRebateDetail(s.id));
    } catch (e) {
      setError(`撤回已经成功了，但页面没刷新出来（${e instanceof Error ? e.message : "未知错误"}），点一下「刷新」`);
    }
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: "var(--t-muted)", margin: "0 0 12px" }}>
        每月 1 号（北京时间）系统自动出上个月的返现单，按员工点「泰国签收」的时间算月份；单子出了就不再改，之后才点签收的算进下个月。
        湘泰线下转完账，在这里点「已返」。
      </p>

      {toast && (
        <div onClick={() => setToast("")} style={{ cursor: "pointer", marginBottom: 12, padding: "10px 16px", background: "var(--c-green-bg)", color: "var(--c-green-deep)", borderRadius: 8, fontSize: 13 }}>{toast}</div>
      )}
      <ErrorBar message={error} />

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
        <div style={{ minWidth: 180 }}>
          <label style={fl}>代理</label>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} style={fi}>
            <option value="">全部代理</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 160 }}>
          <label style={fl}>月份</label>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={fi} />
        </div>
        <div style={{ minWidth: 120 }}>
          <label style={fl}>状态</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={fi}>
            <option value="">全部</option>
            <option value="unpaid">未返</option>
            <option value="paid">已返</option>
          </select>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} style={btnCancel}>{loading ? "刷新中…" : "刷新"}</button>
      </div>

      {loading && items.length === 0 ? (
        <p style={{ color: "var(--t-faint)", fontSize: 14 }}>加载中...</p>
      ) : items.length === 0 ? (
        <p style={{ color: "var(--t-faint)", fontSize: 14 }}>暂无返现单</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--s-alt)" }}>
                <th style={thS}>月份</th>
                <th style={thS}>代理</th>
                <th style={{ ...thS, textAlign: "right" }}>票数</th>
                <th style={{ ...thS, textAlign: "right" }}>总方数</th>
                <th style={{ ...thS, textAlign: "right" }}>返现金额</th>
                <th style={thS}>状态</th>
                <th style={thS}>出单时间</th>
                <th style={thS}>已返时间</th>
                <th style={thS}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td style={{ ...tdS, fontFamily: "monospace" }}>{s.month}</td>
                  <td style={tdS}>{s.agentName}</td>
                  <td style={tdNum}>{s.lineCount}</td>
                  <td style={tdNum}>{s.totalVolumeM3.toFixed(3)}</td>
                  <td style={{ ...tdNum, fontWeight: 600 }}>{money(s.totalRebate)}</td>
                  <td style={tdS}>{s.status === "paid" ? <StatusTag tone="green">已返</StatusTag> : <StatusTag tone="amber">未返</StatusTag>}</td>
                  <td style={{ ...tdS, whiteSpace: "nowrap" }}>{t(s.generatedAt)}</td>
                  <td style={{ ...tdS, whiteSpace: "nowrap" }}>{t(s.paidAt)}</td>
                  <td style={tdS}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="button" onClick={() => void openDetail(s.id)} disabled={detailLoading === s.id} style={btnSmall}>{detailLoading === s.id ? "打开中…" : "看明细"}</button>
                      {s.status === "unpaid" ? (
                        <button type="button" onClick={() => void markPaid(s)} disabled={paying === s.id} style={{ ...btnSmall, border: "1px solid var(--c-green)", color: "var(--c-green)" }}>{paying === s.id ? "提交中…" : "已返"}</button>
                      ) : (
                        <button type="button" onClick={() => { setUndoing(s); setUndoReason(""); setUndoError(""); }} disabled={paying === s.id} style={{ ...btnSmall, border: "1px solid var(--c-amber)", color: "var(--c-amber-deep)" }}>撤回</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <Modal wide onClose={() => setDetail(null)}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <div>
              <h3 style={{ margin: "0 0 4px" }}>{detail.statement.agentName} · {detail.statement.month} 返现单</h3>
              <div style={{ fontSize: 13, color: "var(--t-muted)" }}>
                共 {detail.statement.lineCount} 票 · {detail.statement.totalVolumeM3.toFixed(3)} 方 · 返现 <strong style={{ color: "var(--t-strong)" }}>{money(detail.statement.totalRebate)}</strong>
                {" · "}{detail.statement.status === "paid" ? `已返（${t(detail.statement.paidAt)}）` : "未返"}
                {" · "}出单 {t(detail.statement.generatedAt)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {detail.statement.status === "unpaid" ? (
                <button type="button" onClick={() => void markPaid(detail.statement)} disabled={paying === detail.statement.id} style={btnConfirm}>已返</button>
              ) : (
                <button type="button" onClick={() => { setUndoing(detail.statement); setUndoReason(""); setUndoError(""); }} disabled={paying === detail.statement.id} style={btnCancel}>撤回「已返」</button>
              )}
              <button type="button" onClick={() => setDetail(null)} style={btnCancel}>关闭</button>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--t-muted)", margin: "8px 0" }}>
            返现 = 方数 ×（客户价 − 给代理的价），按货型分档算；价格是客户付款那一刻定下的。时间都是北京时间。
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--s-alt)" }}>
                  {["运单号", "唛头", "品名", "货型", "方数", "客户价", "给代理的价", "这票返现", "建单", "仓库签收", "付款", "装柜", "发运", "泰国签收"].map((h) => (
                    <th key={h} style={{ ...thS, ...(h === "这票返现" ? { textAlign: "right" } : {}) }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id}>
                    <td style={{ ...tdS, fontFamily: "monospace", whiteSpace: "nowrap" }}>{l.trackingNo}</td>
                    <td style={{ ...tdS, whiteSpace: "nowrap", minWidth: 100 }}>{l.mark}</td>
                    <td style={{ ...tdS, minWidth: 120 }}>{l.productNames || "—"}</td>
                    <td style={{ ...tdS, whiteSpace: "nowrap" }}>{cargoLabel(l.volumes)}</td>
                    <td style={{ ...tdS, whiteSpace: "nowrap" }}>{perBucket(l.volumes, l.volumes, (n) => n.toFixed(3))}</td>
                    <td style={{ ...tdS, whiteSpace: "nowrap" }}>{perBucket(l.clientPrices, l.volumes, priceText)}</td>
                    <td style={{ ...tdS, whiteSpace: "nowrap" }}>{perBucket(l.agentPrices, l.volumes, priceText)}</td>
                    <td style={{ ...tdNum, fontWeight: 600 }}>{money(l.rebateAmount)}</td>
                    <td style={{ ...tdS, whiteSpace: "nowrap" }}>{t(l.prealertCreatedAt)}</td>
                    <td style={{ ...tdS, whiteSpace: "nowrap" }}>{t(l.signedAt)}</td>
                    <td style={{ ...tdS, whiteSpace: "nowrap" }}>{t(l.paidAt)}</td>
                    <td style={{ ...tdS, whiteSpace: "nowrap" }}>{t(l.loadedAt)}</td>
                    <td style={{ ...tdS, whiteSpace: "nowrap" }}>{t(l.shippedAt)}</td>
                    <td style={{ ...tdS, whiteSpace: "nowrap" }}>{t(l.thailandReceivedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 操作记录（2026-09-18 老板要的流水）：谁、什么时候、点了已返还是撤回、撤回写的原因 */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>操作记录</div>
            {detail.history.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--t-muted)" }}>
                {detail.statement.status === "paid"
                  ? "没有记录：这张单的「已返」是这个功能上线之前点的，那时候还没开始记。"
                  : "还没有人点过「已返」。"}
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--s-alt)" }}>
                    {["时间", "操作", "操作人", "金额", "原因"].map((h) => (
                      <th key={h} style={thS}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.history.map((h, i) => (
                    <tr key={`${h.at}-${i}`}>
                      <td style={{ ...tdS, whiteSpace: "nowrap" }}>{t(h.at)}</td>
                      <td style={tdS}>
                        {h.action === "paid" ? <StatusTag tone="green">已返</StatusTag> : h.action === "undoPaid" ? <StatusTag tone="amber">撤回已返</StatusTag> : <StatusTag tone="grey">改动</StatusTag>}
                        {h.action === "undoPaid" && h.undonePaidAt ? (
                          <div style={{ fontSize: 11, color: "var(--t-muted)", marginTop: 2 }}>撤的是 {t(h.undonePaidAt)} 那次</div>
                        ) : null}
                      </td>
                      <td style={{ ...tdS, whiteSpace: "nowrap" }}>{h.actorName || "—"}</td>
                      <td style={{ ...tdS, whiteSpace: "nowrap" }}>{h.amount === null ? "—" : money(h.amount)}</td>
                      <td style={tdS}>{h.reason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {detail.history.length >= 50 && (
              <div style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 6 }}>只显示最近 50 条。</div>
            )}
          </div>
        </Modal>
      )}

      {undoing && (
        <Modal onClose={() => { setUndoing(null); setUndoReason(""); setUndoError(""); }}>
          <h3 style={{ margin: "0 0 8px" }}>撤回「已返」</h3>
          <ErrorBar message={undoError} />
          <div style={{ fontSize: 13, color: "var(--t-muted)", marginBottom: 12 }}>
            {undoing.agentName} · {undoing.month} 返现单 · {money(undoing.totalRebate)}
            <br />
            撤回后这张单回到「未返」（代理那边也看得到变回未返），金额和明细一个字不动；这次撤回会记进操作记录。
          </div>
          <label style={fl} htmlFor="rebate-undo-reason">为什么撤回（必填，会留在记录里）</label>
          <input
            id="rebate-undo-reason"
            style={fi}
            value={undoReason}
            maxLength={200}
            placeholder="例如：转错账号，钱退回来了"
            onChange={(e) => setUndoReason(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button type="button" onClick={() => { setUndoing(null); setUndoReason(""); setUndoError(""); }} style={btnCancel}>算了</button>
            <button type="button" onClick={() => void undoPaid()} disabled={paying === undoing.id || undoReason.trim() === ""} style={btnConfirm}>
              {paying === undoing.id ? "提交中…" : "确认撤回"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
