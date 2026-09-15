"use client";

/**
 * 代理工作台各分区共用的小件（2026-09-16）。外观照现有 A3 工作台：白底、细线表格、不放顶部数字条。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { formatBeijingTime } from "../../modules/staff/utils";

export const PREALERT_STATUS_ZH: Record<string, string> = {
  pending: "待签收",
  received_pending_payment: "待付款",
  payment_submitted: "待审核",
  paid: "已付款",
  loading: "装柜中",
  shipped: "已发运",
  thailand_received: "泰国已签收",
  cancelled: "已取消",
};

export const PLAN_STATUS_ZH: Record<string, string> = {
  planning: "计划中",
  collecting: "集货中",
  loading: "装柜中",
  shipped: "已发运",
  completed: "已完成",
  cancelled: "已取消",
};

export const CARGO_ZH: Record<string, string> = { normal: "普货", inspection: "商检货", sensitive: "敏感货" };

const TAG: Record<string, { bg: string; color: string }> = {
  planning: { bg: "#EEF2FB", color: "#1e3a8a" },
  collecting: { bg: "var(--c-blue-bg-2)", color: "var(--c-blue-deep)" },
  loading: { bg: "#EEF2FB", color: "#1e3a8a" },
  shipped: { bg: "#EEF2FB", color: "#1e3a8a" },
  completed: { bg: "var(--c-green-bg)", color: "var(--c-green-deep)" },
  cancelled: { bg: "var(--c-red-bg)", color: "var(--c-red-dark)" },
  pending: { bg: "var(--c-amber-bg)", color: "var(--c-amber-deep)" },
  received_pending_payment: { bg: "var(--c-amber-bg)", color: "var(--c-amber-deep)" },
  payment_submitted: { bg: "var(--c-blue-bg-2)", color: "var(--c-blue-deep)" },
  paid: { bg: "var(--c-green-bg)", color: "var(--c-green-deep)" },
  thailand_received: { bg: "var(--c-green-bg)", color: "var(--c-green-deep)" },
  unpaid: { bg: "var(--c-amber-bg)", color: "var(--c-amber-deep)" },
};

export function StatusTag({ status, label }: { status: string; label?: string }) {
  const c = TAG[status] ?? { bg: "var(--s-sunken)", color: "var(--t-muted)" };
  return (
    <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 4, fontSize: 12, background: c.bg, color: c.color, whiteSpace: "nowrap" }}>
      {label ?? PREALERT_STATUS_ZH[status] ?? PLAN_STATUS_ZH[status] ?? status}
    </span>
  );
}

export const th: CSSProperties = { padding: "8px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--t-body)", borderBottom: "1px solid var(--l-soft)", whiteSpace: "nowrap" };
export const td: CSSProperties = { padding: "8px 10px", fontSize: 13, borderBottom: "1px solid var(--s-sunken)", verticalAlign: "top" };
export const tdNum: CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
export const mono: CSSProperties = { fontFamily: "var(--a3-mono, monospace)", whiteSpace: "nowrap" };
export const btn: CSSProperties = { padding: "6px 14px", border: "1px solid var(--l-strong)", background: "var(--white)", color: "var(--t-body)", borderRadius: 6, cursor: "pointer", fontSize: 13 };
export const btnPrimary: CSSProperties = { ...btn, background: "var(--c-blue)", borderColor: "var(--c-blue)", color: "var(--white)", fontWeight: 600 };
export const input: CSSProperties = { padding: "6px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };

export function fmtTime(value: string | null | undefined): string {
  return formatBeijingTime(value ?? null, "—");
}
export function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `¥${n.toFixed(2)}`;
}
export function fmtM3(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return String(Number(n.toFixed(3)));
}
export function priceText(p: { normal: number; inspection: number; sensitive: number }): string {
  return `普货 ${p.normal} / 商检 ${p.inspection} / 敏感 ${p.sensitive} 元/方`;
}

export function SectionHeader({ title, desc, actions }: { title: string; desc?: string; actions?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--t-heading)" }}>{title}</h2>
        {desc ? <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--t-muted)" }}>{desc}</p> : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div> : null}
    </div>
  );
}

export function Panel({ title, children, extra }: { title?: ReactNode; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="dashboard-panel" style={{ marginBottom: 14, padding: 16 }}>
      {title || extra ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
          {title ? <div className="dashboard-panel-title" style={{ marginBottom: 0 }}>{title}</div> : <span />}
          {extra}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function LoadState({ loading, error, onRetry }: { loading: boolean; error: string; onRetry?: () => void }) {
  if (error) {
    return (
      <div role="alert" style={{ padding: "12px 14px", borderRadius: 8, background: "var(--c-red-bg)", color: "var(--c-red-dark)", fontSize: 13, marginBottom: 12 }}>
        加载失败：{error}
        {onRetry ? <button type="button" style={{ ...btn, marginLeft: 12, padding: "2px 10px" }} onClick={onRetry}>重试</button> : null}
      </div>
    );
  }
  if (loading) return <div style={{ padding: "12px 0", fontSize: 13, color: "var(--t-muted)" }}>加载中…</div>;
  return null;
}

/** 表格外面包一层可横向滚动的框（手机上宽表不撑破页面） */
export function TableWrap({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="table-card" role="region" aria-label={label} tabIndex={0} style={{ overflowX: "auto" }}>
      {children}
    </div>
  );
}

/**
 * 拉一次接口的小钩子：只认最后一次请求的结果（切得快时旧请求晚回来不许盖掉新的）。
 */
export function useAgentLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    run()
      .then((d) => { if (mine === seq.current) setData(d); })
      .catch((e: unknown) => { if (mine === seq.current) setError(e instanceof Error ? e.message : "请稍后重试"); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [run]);
  useEffect(() => { reload(); }, [reload]);
  return { data, loading, error, reload };
}

/** 签收照片缩略图，点开看大图 */
export function ProofThumbs({ proofs, label }: { proofs: Array<{ base64Path: string; mime: string }>; label: string }) {
  const [zoom, setZoom] = useState<string | null>(null);
  if (proofs.length === 0) return null;
  const src = (p: { base64Path: string; mime: string }) =>
    p.base64Path.startsWith("data:") || p.base64Path.startsWith("/") || p.base64Path.startsWith("http")
      ? p.base64Path
      : `data:${p.mime || "image/jpeg"};base64,${p.base64Path}`;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 12, color: "var(--t-muted)", marginBottom: 4 }}>{label}（{proofs.length}张）</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {proofs.map((p, i) => (
          <img key={i} src={src(p)} alt={`${label} ${i + 1}`} onClick={() => setZoom(src(p))} style={{ width: 96, height: 72, objectFit: "cover", borderRadius: 6, border: "1px solid var(--l-soft)", cursor: "zoom-in" }} />
        ))}
      </div>
      {zoom ? (
        <div onClick={() => setZoom(null)} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, cursor: "zoom-out" }}>
          <img src={zoom} alt="查看大图" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }} />
        </div>
      ) : null}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav aria-label="分页" style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, fontSize: 13, color: "var(--t-muted)", flexWrap: "wrap" }}>
      <span>共 {total} 条</span>
      <button type="button" style={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
      <span>{page} / {pages}</span>
      <button type="button" style={btn} disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button>
    </nav>
  );
}
