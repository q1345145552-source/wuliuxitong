"use client";

import type { CSSProperties, ReactNode } from "react";

/* 代理管理页共用的样式和弹窗（2026-09-16，B2）。
   外观照 app/admin/whr-consolidation/page.tsx（A3 外壳里的表格、按钮、弹窗同一套写法），不另起一套。 */

export const thS: CSSProperties = { padding: "6px 10px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--t-body)", borderBottom: "2px solid var(--l-soft)", whiteSpace: "nowrap" };
export const tdS: CSSProperties = { padding: "7px 10px", fontSize: 13, borderBottom: "1px solid var(--s-sunken)", verticalAlign: "middle" };
export const tdNum: CSSProperties = { ...tdS, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
export const btnConfirm: CSSProperties = { padding: "8px 18px", background: "var(--c-blue)", color: "var(--white)", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 };
export const btnCancel: CSSProperties = { padding: "8px 18px", border: "1px solid var(--l-strong)", color: "var(--t-muted)", background: "var(--white)", borderRadius: 6, cursor: "pointer", fontSize: 13 };
export const btnSmall: CSSProperties = { padding: "3px 10px", border: "1px solid var(--l-strong)", color: "var(--t-strong)", background: "var(--white)", borderRadius: 6, cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" };
export const btnSmallDanger: CSSProperties = { ...btnSmall, border: "1px solid var(--c-red)", color: "var(--c-red)" };
export const fl: CSSProperties = { display: "block", fontSize: 13, color: "var(--t-body)", fontWeight: 500, marginBottom: 3 };
export const fi: CSSProperties = { width: "100%", padding: "7px 10px", border: "1px solid var(--l-strong)", borderRadius: 6, fontSize: 13, boxSizing: "border-box" };
export const hint: CSSProperties = { fontSize: 12, color: "var(--t-muted)", marginTop: 3 };

export const money = (n: number): string => `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const priceText = (n: number): string => String(Number(n.toFixed(2)));

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--white)", borderRadius: 12, padding: 24, maxWidth: wide ? 1200 : 560, width: "92vw", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 8px 30px rgba(0,0,0,0.15)" }}
      >
        {children}
      </div>
    </div>
  );
}

export function ErrorBar({ message }: { message: string }) {
  if (!message) return null;
  return <div style={{ marginBottom: 12, padding: 10, background: "var(--c-red-bg)", borderRadius: 8, color: "var(--c-red-deep)", fontSize: 13, whiteSpace: "pre-wrap" }}>{message}</div>;
}

export function StatusTag({ tone, children }: { tone: "green" | "amber" | "grey"; children: ReactNode }) {
  const palette = {
    green: { bg: "var(--c-green-bg)", color: "var(--c-green-deep)" },
    amber: { bg: "var(--c-amber-bg)", color: "var(--c-amber-deep)" },
    grey: { bg: "var(--s-sunken)", color: "var(--t-muted)" },
  }[tone];
  return <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 12, background: palette.bg, color: palette.color, whiteSpace: "nowrap" }}>{children}</span>;
}

/** 读图片文件成 base64（不带 data: 前缀）。只收位图，最大 2MB —— 跟后端 agent-rules.ts 同一口径 */
export async function readLogoFile(file: File): Promise<{ mime: string; base64: string; previewUrl: string }> {
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!allowed.includes(file.type)) throw new Error("logo 只支持 PNG、JPG、WEBP、GIF 图片");
  if (file.size > 2 * 1024 * 1024) throw new Error("logo 图片太大了（最大 2MB）");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("文件读取失败"));
    r.readAsDataURL(file);
  });
  return { mime: file.type, base64: dataUrl.split(",")[1] ?? "", previewUrl: dataUrl };
}
