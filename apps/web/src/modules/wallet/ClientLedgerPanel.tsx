"use client";

/**
 * 一个客户的余额流水（2026-11-27，财务系统2 ADR 0191 第 2 轮）。管理员「客户余额」页和员工「客户余额」那一栏共用。
 * 数据：GET /staff/wallet/ledger（新的在前、真分页，教训 21）。谁做的只有管理员拿得到（后端摘掉）。
 * 管理员（isAdmin）每一笔「管理员充值」后面有「冲掉」（已冲掉的写明谁、什么时候、为什么）和「看水单」；员工只能看。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAdminAdjustmentProof, fetchStaffWalletLedger, type StaffWalletLedgerItem } from "../../services/business-api";
import { useLiveRefresh } from "../realtime/useRealtime";
import { useNarrowBox } from "./useNarrowBox";

const PAGE_SIZE = 50;

export const yuan = (n: number) =>
  `${n < 0 ? "−" : ""}¥${Math.abs(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 北京时间（后端给的是带 Z 的 UTC） */
export const beijingTime = (iso: string) =>
  new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function ClientLedgerPanel({
  clientId,
  isAdmin,
  reloadKey = 0,
  onReverse,
  onBalance,
}: {
  clientId: string;
  isAdmin: boolean;
  /** 外面加 / 减 / 冲完了改一下这个数，这里重拉 */
  reloadKey?: number;
  /** 管理员点「冲掉」 */
  onReverse?: (row: StaffWalletLedgerItem) => void;
  /** 拉到的最新余额（外面显示用） */
  onBalance?: (balance: number) => void;
}) {
  const [items, setItems] = useState<StaffWalletLedgerItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [proof, setProof] = useState<{ id: string; src: string } | null>(null);
  const [proofError, setProofError] = useState("");
  // 窄（手机、平板带侧边栏）就一条一块，「冲掉」不用横着滚就点得到（2026-11-27）
  const { ref: boxRef, narrow } = useNarrowBox<HTMLDivElement>(860);
  // 只认最后一次发出去的（换客户 / 翻页很快时，晚到的旧结果不许盖新的）
  const seq = useRef(0);
  const onBalanceRef = useRef(onBalance);
  onBalanceRef.current = onBalance;

  const load = useCallback(async (p: number, opts?: { silent?: boolean }) => {
    const mine = ++seq.current;
    if (!opts?.silent) { setLoading(true); setError(""); }
    try {
      const data = await fetchStaffWalletLedger(clientId, p, PAGE_SIZE);
      if (mine !== seq.current) return;
      setItems(data.items);
      setTotal(data.total);
      setPage(data.page);
      setError("");
      onBalanceRef.current?.(data.balance);
    } catch (e) {
      if (mine !== seq.current) return;
      if (!opts?.silent) setError(e instanceof Error ? e.message : "流水没加载出来");
    } finally {
      if (mine === seq.current && !opts?.silent) setLoading(false);
    }
  }, [clientId]);

  // 换客户 / 外面办完一笔：回到第一页重拉
  useEffect(() => { void load(1); }, [load, reloadKey]);

  const pageRef = useRef(page);
  pageRef.current = page;
  useLiveRefresh({ topics: ["wallet", "consolidation", "whr"], refresh: () => load(pageRef.current, { silent: true }) });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const th = { padding: "8px 10px", textAlign: "left" as const, fontWeight: 600, color: "var(--t-body)", whiteSpace: "nowrap" as const };
  const td = { padding: "8px 10px", verticalAlign: "top" as const };
  const btn = { border: "1px solid var(--l-strong)", borderRadius: 6, padding: "3px 10px", background: "var(--white)", cursor: "pointer", fontSize: 12 };

  const showProof = async (adjustmentId: string) => {
    setProofError("");
    try {
      const data = await fetchAdminAdjustmentProof(adjustmentId);
      if (!data.proofImage) { setProofError("这一笔没有水单"); return; }
      setProof({ id: adjustmentId, src: data.proofImage });
    } catch (e) {
      setProofError(e instanceof Error ? e.message : "水单没取出来");
    }
  };

  /** 「冲掉」「看水单」两个按钮（表格和一条一块共用） */
  const actions = (r: StaffWalletLedgerItem) => (
    <>
      {r.adjustment?.canReverse && onReverse ? (
        <button type="button" style={{ ...btn, color: "var(--c-red-2)", borderColor: "#fca5a5" }} onClick={() => onReverse(r)}>冲掉</button>
      ) : null}
      {r.adjustment?.hasProof ? (
        <button type="button" style={{ ...btn, marginLeft: 6 }} onClick={() => void showProof(r.adjustment!.id)}>看水单</button>
      ) : null}
    </>
  );
  const reversedNote = (r: StaffWalletLedgerItem) => r.adjustment?.reversed ? (
    <div style={{ marginTop: 4, fontSize: 12, color: "var(--c-red-deep)" }}>
      已冲掉：{beijingTime(r.adjustment.reversed.at)}
      {r.adjustment.reversed.byName ? ` · ${r.adjustment.reversed.byName}` : ""}
      {` · 原因：${r.adjustment.reversed.reason}`}
    </div>
  ) : null;

  return (
    <div ref={boxRef}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: "var(--t-strong)" }}>共 {total} 条 · 第 {page}/{totalPages} 页</span>
        <button type="button" style={btn} disabled={loading || page <= 1} onClick={() => void load(page - 1)}>上一页</button>
        <button type="button" style={btn} disabled={loading || page >= totalPages} onClick={() => void load(page + 1)}>下一页</button>
        <button type="button" style={btn} disabled={loading} onClick={() => void load(page)}>{loading ? "加载中…" : "刷新"}</button>
      </div>
      {error ? (
        <p role="alert" style={{ color: "var(--c-red-deep)", fontSize: 13 }}>
          流水没加载出来：{error}
          <button type="button" style={{ ...btn, marginLeft: 8 }} onClick={() => void load(page)}>重试</button>
        </p>
      ) : null}
      {proofError ? <p role="alert" style={{ color: "var(--c-red-deep)", fontSize: 13 }}>{proofError}</p> : null}
      {items.length === 0 && !loading && !error ? (
        <p style={{ color: "var(--t-muted)", fontSize: 13 }}>这个客户还没有流水</p>
      ) : narrow ? (
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((r) => (
            <div key={r.id} style={{ border: "1px solid var(--l-soft)", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600 }}>{r.typeLabel}</span>
                <span style={{ fontWeight: 700, whiteSpace: "nowrap", color: r.amount < 0 ? "var(--c-red-deep)" : undefined }}>{r.amount >= 0 ? "+" : "−"}¥{Math.abs(r.amount).toFixed(2)}</span>
              </div>
              <div style={{ color: "var(--t-muted)", fontSize: 12, marginTop: 2, display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <span>{beijingTime(r.createdAt)} · {r.source || "—"}{r.refNo ? ` · ${r.refNo}` : ""}</span>
                <span style={{ whiteSpace: "nowrap", color: r.balanceAfter < 0 ? "var(--c-red-deep)" : undefined }}>余额 {yuan(r.balanceAfter)}</span>
              </div>
              {r.remark ? <div style={{ marginTop: 4, color: "var(--t-body)", wordBreak: "break-all" }}>{r.remark}</div> : null}
              {reversedNote(r)}
              {isAdmin && (r.operatorName || r.adjustment?.canReverse || r.adjustment?.hasProof) ? (
                <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "var(--t-muted)" }}>{r.operatorName ? `操作人：${r.operatorName}` : ""}</span>
                  <span>{actions(r)}</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="a3-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--s-alt)", borderBottom: "1px solid var(--l-soft)" }}>
                <th style={th}>时间</th>
                <th style={th}>类型</th>
                <th style={th}>来源</th>
                <th style={th}>单号</th>
                <th style={{ ...th, textAlign: "right" }}>金额</th>
                <th style={{ ...th, textAlign: "right" }}>余额</th>
                <th style={th}>备注 / 原因</th>
                {isAdmin ? <th style={th}>操作人</th> : null}
                {isAdmin ? <th style={th}>操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--s-sunken)" }}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{beijingTime(r.createdAt)}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{r.typeLabel}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{r.source || "—"}</td>
                  <td style={{ ...td, whiteSpace: "nowrap", fontFamily: "monospace", fontSize: 12 }}>{r.refNo || "—"}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap", color: r.amount < 0 ? "var(--c-red-deep)" : undefined }}>
                    {r.amount >= 0 ? "+" : "−"}¥{Math.abs(r.amount).toFixed(2)}
                  </td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", color: r.balanceAfter < 0 ? "var(--c-red-deep)" : "var(--t-muted)" }}>{yuan(r.balanceAfter)}</td>
                  <td style={{ ...td, color: "var(--t-muted)", maxWidth: 260 }}>
                    {r.remark || "—"}
                    {reversedNote(r)}
                  </td>
                  {isAdmin ? <td style={{ ...td, whiteSpace: "nowrap" }}>{r.operatorName || "—"}</td> : null}
                  {isAdmin ? (
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{actions(r)}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {proof ? (
        <div role="dialog" aria-label="水单" onClick={() => setProof(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--white)", borderRadius: 10, padding: 12, maxWidth: "90vw", maxHeight: "90vh", overflow: "auto" }}>
            {/* src 是后端核过格式的图片 data URL 或站内 /images/ 路径（跟充值凭证同一道闸） */}
            <img src={proof.src} alt="水单" style={{ maxWidth: "80vw", maxHeight: "75vh", display: "block" }} />
            <div style={{ textAlign: "right", marginTop: 8 }}>
              <button type="button" style={btn} onClick={() => setProof(null)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
