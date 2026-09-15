/* ==========================================================================
   代理工作台：给代理看的数据怎么裁（2026-09-16，B3）
   --------------------------------------------------------------------------
   需求：docs/交接文档-附件-代理账号确认单/final.md（不进 git）第 3 节。

   ⚠️ 这里全是纯函数，不碰数据库，方便 scripts/test-agent-portal-isolation.ts 直接测。
   ⚠️ 每个 map* 函数**逐个字段列出**要给代理的东西（CLAUDE.md #31）——
      表里以后加了新列，不改这里就一个都漏不出去。绝不许写 `...row`。
   ⚠️ 一律不给：柜号（containerNo / batchNo，3.11 暂缓）、员工名 / 操作人（3.5）、
      内部备注（运单 remark、client_notes，3.9）、整柜已用方数（3.3）、谁改的价（updatedBy）。
   ========================================================================== */

import { sanitizeRemarkForClient } from "../core/client-privacy";
import { hideOperatorInRemark } from "../core/operator-visibility";

/** Prisma Decimal | number | string | null → number | null（null 保持 null，不把「没填」变成 0） */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof (v as { toNumber?: unknown }).toNumber === "function") return (v as { toNumber: () => number }).toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 同 numOrNull，但 null 当 0（汇总金额、方数用） */
export function num(v: unknown): number {
  return numOrNull(v) ?? 0;
}

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** 轨迹 / 状态日志的备注：柜号抹掉 + 代码拼进去的「管理员…」抹掉。代理看到的跟客户一样 */
export function remarkForAgent(remark: string | null | undefined): string {
  return hideOperatorInRemark(sanitizeRemarkForClient(remark ?? "", true), "agent");
}

/**
 * 仓库版集货的签收照片（仓库签收 / 泰国签收）。
 * 库里是 JSON 数组 `{ fileName, mime, base64Path, uploadedAt }`，只挑这四个字段给，
 * 数组里有别的键（将来谁往里塞了操作人）也带不出去。
 */
export interface AgentProof {
  base64Path: string;
  fileName: string;
  mime: string;
  uploadedAt: string | null;
}
export function mapProofs(raw: unknown): AgentProof[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentProof[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const path = typeof r.base64Path === "string" ? r.base64Path : typeof r.base64 === "string" ? r.base64 : "";
    if (!path) continue;
    out.push({
      base64Path: path,
      fileName: typeof r.fileName === "string" ? r.fileName : "",
      mime: typeof r.mime === "string" ? r.mime : "",
      uploadedAt: typeof r.uploadedAt === "string" ? r.uploadedAt : null,
    });
  }
  return out;
}

/* ─────────────── 首页：卡住的单（3.10） ─────────────── */

export interface StuckItemInput {
  lengthCm: unknown;
  widthCm: unknown;
  heightCm: unknown;
  volumeM3: unknown;
}

/**
 * 「没填尺寸」：还在待签收（pending）的单，没有货品行，或者有任何一行长宽高缺一个 / 方数为 0。
 * 仓库签收时是按客户自己填的长宽高算方数收钱的（4.8），尺寸不全签收那一下金额就是错的。
 */
export function isMissingSize(status: string, items: readonly StuckItemInput[]): boolean {
  if (status !== "pending") return false;
  if (items.length === 0) return true;
  return items.some((it) => {
    const l = num(it.lengthCm);
    const w = num(it.widthCm);
    const h = num(it.heightCm);
    return !(l > 0 && w > 0 && h > 0) || num(it.volumeM3) <= 0;
  });
}

/** 「没付款」：仓库已签收、等客户付款（payment_submitted 是老流程的待审核，一并算） */
export const UNPAID_PREALERT_STATUSES = ["received_pending_payment", "payment_submitted"] as const;
export function isUnpaid(status: string): boolean {
  return (UNPAID_PREALERT_STATUSES as readonly string[]).includes(status);
}

/** 「没填泰国地址」只看还没发运的柜（发运后地址已经不能改了，催也没用） */
export const ADDRESS_NEEDED_PLAN_STATUSES = ["planning", "collecting", "loading"] as const;

/* ─────────────── 返现单（3.4 / 4.12 / 4.20） ─────────────── */

export function mapRebateStatement(s: {
  id: string;
  month: string;
  lineCount: number;
  totalVolumeM3: unknown;
  totalRebate: unknown;
  status: string;
  generatedAt: Date;
  paidAt: Date | null;
}) {
  return {
    id: s.id,
    month: s.month,
    lineCount: s.lineCount,
    totalVolumeM3: num(s.totalVolumeM3),
    totalRebate: num(s.totalRebate),
    status: s.status,
    generatedAt: s.generatedAt.toISOString(),
    // paidBy（谁点的「已返」）是湘泰内部的人，不给
    paidAt: iso(s.paidAt),
  };
}

export function mapRebateLine(l: {
  id: string;
  trackingNo: string;
  planNo: string;
  clientId: string;
  mark: string;
  productNames: string;
  volumeNormalM3: unknown;
  volumeInspectionM3: unknown;
  volumeSensitiveM3: unknown;
  clientPriceNormal: unknown;
  clientPriceInspection: unknown;
  clientPriceSensitive: unknown;
  agentPriceNormal: unknown;
  agentPriceInspection: unknown;
  agentPriceSensitive: unknown;
  rebateAmount: unknown;
  prealertCreatedAt: Date;
  signedAt: Date | null;
  paidAt: Date | null;
  loadedAt: Date | null;
  shippedAt: Date | null;
  thailandReceivedAt: Date;
}) {
  return {
    id: l.id,
    trackingNo: l.trackingNo,
    planNo: l.planNo,
    clientId: l.clientId,
    mark: l.mark,
    productNames: l.productNames,
    volumes: { normal: num(l.volumeNormalM3), inspection: num(l.volumeInspectionM3), sensitive: num(l.volumeSensitiveM3) },
    clientPrices: { normal: num(l.clientPriceNormal), inspection: num(l.clientPriceInspection), sensitive: num(l.clientPriceSensitive) },
    agentPrices: { normal: num(l.agentPriceNormal), inspection: num(l.agentPriceInspection), sensitive: num(l.agentPriceSensitive) },
    rebateAmount: num(l.rebateAmount),
    prealertCreatedAt: l.prealertCreatedAt.toISOString(),
    signedAt: iso(l.signedAt),
    paidAt: iso(l.paidAt),
    loadedAt: iso(l.loadedAt),
    shippedAt: iso(l.shippedAt),
    thailandReceivedAt: l.thailandReceivedAt.toISOString(),
  };
}

/* ─────────────── 分页参数（照抄 client-compliance/routes.ts 的严格校验） ─────────────── */

/**
 * 没传 / 传空串用默认值；传了就必须是正的安全整数，不是就返回 null（调用处 400）。
 * 原因见 client-compliance/routes.ts 的 parsePageParam：宽松转换 1e400 会打出 500。
 */
export function parsePageParam(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return fallback;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

/** 'YYYY-MM-DD'，不合法返回 null；没传返回 undefined */
export function parseDateParam(raw: string | undefined): string | null | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/** 一张单多个产品行长宽高不同时拼成「60/50」，全空给 null（跟管理端导出同一个口径） */
export function joinDims(values: ReadonlyArray<number | null | undefined>): string | null {
  const seen: string[] = [];
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    const text = String(Number(v.toFixed(2)));
    if (!seen.includes(text)) seen.push(text);
  }
  return seen.length > 0 ? seen.join("/") : null;
}
