"use client";

/**
 * 发消息时选「说的是哪张单」（2026-10-02 老板：「可以选择是哪个运单，让客服或者客户发起，以此知道需要询问或处理的是哪个运单。整柜的也可以」）。
 * 聊天窗口点「选运单」弹出来：上面搜单号 / 品名，下面两栏 —— 运单（普通运单，父单）、整柜（显示提单号，不显示柜号）。
 * 客户那头列他自己的；客服那头列正在聊的这个客户的（后端按唛头卡死，不是这个客户的选不到也发不出去）。
 * 搜索交给后端（CLAUDE.md 第 19 条：别拉一页回来在前端筛），只列最近 30 张，到顶了写出来（第 21 条）。
 */
import { useEffect, useRef, useState } from "react";
import { fetchChatRefs, type ChatRefList, type ChatRefOption, type ChatScope } from "../../services/cs-chat-api";
import { CLIENT_STATUS_ZH_OVERRIDES, shipmentStatusZh } from "../shipment/shipment-status";
import { createRequestGate } from "../shared/request-gate";

export type PickedRef = { type: "shipment" | "fcl"; id: string; no: string; title: string | null };

/** 件数单位：后端给的是 box / bag，原来直接拼成「3box」 */
function unitZh(unit: string | null): string {
  return unit === "box" ? "箱" : unit === "bag" ? "袋" : unit ?? "";
}

/** 搜索框停手多久再去问（毫秒） */
const SEARCH_DEBOUNCE_MS = 300;

export default function ChatRefPicker(props: { scope: ChatScope; onPick: (ref: PickedRef) => void; onClose: () => void }) {
  const { scope, onPick, onClose } = props;
  const [q, setQ] = useState("");
  const [data, setData] = useState<ChatRefList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const gate = useRef(createRequestGate()).current;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const forClient = scope.kind === "client";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const ticket = gate.begin();
      setLoading(true);
      fetchChatRefs(scopeRef.current, q)
        .then((d) => { if (gate.isCurrent(ticket)) { setData(d); setError(""); } })
        .catch((e: unknown) => { if (gate.isCurrent(ticket)) setError(e instanceof Error ? e.message : "单子没取到"); })
        .finally(() => { if (gate.isCurrent(ticket)) setLoading(false); });
    }, q ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [q, gate]);

  const row = (type: "shipment" | "fcl", o: ChatRefOption) => (
    <button key={`${type}:${o.id}`} type="button" onClick={() => onPick({ type, id: o.id, no: o.no, title: o.title })}
      style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderBottom: "1px solid var(--s-cool-2)", background: "var(--white)", padding: "7px 10px", cursor: "pointer" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontFamily: "var(--a3-mono, monospace)", fontWeight: 600, fontSize: 13, color: "var(--t-heading)", whiteSpace: "nowrap" }}>{o.no}</span>
        <span style={{ fontSize: 11, color: "var(--c-blue)", whiteSpace: "nowrap" }}>{shipmentStatusZh(o.status, forClient ? CLIENT_STATUS_ZH_OVERRIDES : undefined)}</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--t-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {/* 到货通知转的「待入库」品名可能是空串、件数是 0（没填）：空串也算没填品名，件数只拼正数（2026-10-08 审查 F10） */}
        {o.title || "（没填品名）"}{typeof o.packageCount === "number" && o.packageCount > 0 ? ` · ${o.packageCount}${unitZh(o.packageUnit)}` : ""}
      </div>
    </button>
  );

  const section = (label: string, type: "shipment" | "fcl", list: ChatRefOption[], truncated: boolean) => (
    <div>
      <div style={{ padding: "6px 10px", fontSize: 12, fontWeight: 600, color: "var(--t-strong)", background: "var(--s-sunken)" }}>{label}（{list.length}{truncated ? "+" : ""}）</div>
      {list.length === 0 ? <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--t-faint)" }}>{q.trim() ? "没搜到" : "没有"}</div> : list.map((o) => row(type, o))}
      {truncated ? <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--c-amber-deep)", background: "var(--c-amber-bg)" }}>只列了最近 {list.length} 张，更早的请在上面搜单号或品名</div> : null}
    </div>
  );

  return (
    <div className="cs-ref-picker" role="dialog" aria-label="选运单"
      style={{ position: "absolute", left: 8, right: 8, bottom: "100%", marginBottom: 6, maxHeight: 360, display: "flex", flexDirection: "column", background: "var(--white)", border: "1px solid var(--l-strong)", borderRadius: 8, boxShadow: "var(--shadow-sm)", zIndex: 20, overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 6, padding: 8, borderBottom: "1px solid var(--l-soft)", alignItems: "center" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜运单号 / 提单号 / 快递单号 / 品名" aria-label="搜运单"
          autoFocus style={{ flex: 1, minWidth: 0, border: "1px solid var(--l-strong)", borderRadius: 6, padding: "6px 9px", fontSize: 13 }} />
        <button type="button" onClick={onClose} aria-label="关闭"
          style={{ border: "1px solid var(--l-strong)", borderRadius: 6, background: "var(--white)", padding: "5px 10px", fontSize: 12, color: "var(--t-strong)", cursor: "pointer", flexShrink: 0 }}>
          关闭
        </button>
      </div>
      <div style={{ overflowY: "auto", minHeight: 0 }}>
        {error ? <div role="alert" style={{ padding: 10, fontSize: 12, color: "var(--c-red-deep)" }}>单子没取到：{error}</div> : null}
        {!data && loading ? <div style={{ padding: 10, fontSize: 12, color: "var(--t-faint)" }}>加载中…</div> : null}
        {data ? (
          <>
            {section("运单", "shipment", data.shipments, data.shipmentsTruncated)}
            {section("整柜", "fcl", data.fcl, data.fclTruncated)}
          </>
        ) : null}
      </div>
    </div>
  );
}
