import { zonedTime } from "../finance2-holds/client";

/**
 * 代理钱包（第 13 期）：读财务系统2 的三个只读接口，按约定第 10 节逐个字段核对、逐个字段挑出来给代理端页面。
 * ⚠️ 一律**明确列出给前端的字段**，不许 `...body` 整个转过去（CLAUDE.md 第 31 条：对方加了字段就会跟着漏）。
 * ⚠️ 金额照原样用字符串（两位小数、可以是负数），不转成数字（财务系统2 ADR 0006：浮点会出错）。
 * 格式不对（缺字段、金额是数字、时间不带时区……）一律当「财务系统返回的格式不对」，不猜。
 * 不认识的 kind / status 照收（约定 1.2：见到不认识的值照收），页面显示原值。
 */

const MONEY = /^-?\d{1,13}\.\d{2}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const LEDGER_KIND_ZH: Record<string, string> = {
  marginAccrued: "差价待结算",
  marginReleased: "转可用",
  marginReversed: "冲回",
  marginForfeited: "减项划掉", // 财务系统2 ADR 0163：账单减项减掉那部分的差价不给，直接划掉
  withdrawal: "提现",
  withdrawalVoided: "提现作废退回",
};

export const WITHDRAWAL_STATUS_ZH: Record<string, string> = {
  pending: "待审批",
  approved: "已同意，待付款",
  rejected: "已驳回",
  paid: "已付款",
  voided: "已作废（钱已退回钱包）",
};

export interface WalletBalanceView {
  currency: string;
  pending: string;
  available: string;
  withdrawn: string;
  lastSeq: number;
  lastEntryAt: string | null;
  serverTime: string | null;
}

export interface WalletLedgerItemView {
  seq: number;
  kind: string;
  kindLabel: string;
  pendingChange: string;
  availableChange: string;
  pendingAfter: string;
  availableAfter: string;
  waybillNo: string | null;
  customerMark: string | null;
  billNo: string | null;
  withdrawalId: string | null;
  createdAt: string;
}

export interface WalletWithdrawalView {
  withdrawalId: string;
  amount: string;
  status: string;
  statusLabel: string;
  requestedAt: string;
  decidedAt: string | null;
  paidOn: string | null;
  voidedAt: string | null;
}

export interface WalletPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function money(v: unknown): string | null {
  return typeof v === "string" && MONEY.test(v) ? v : null;
}
/** 时间原样返回财务给的字符串（泰国时间 +07:00），先确认认得出来、带时区 */
function time(v: unknown): string | null {
  return typeof v === "string" && zonedTime(v) ? v : null;
}
/** 能空的字符串字段：null 或者 1～128 个字、没有控制字符 */
function optText(v: unknown, max = 128): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string" || v.length === 0 || v.length > max || /[\x00-\x1f\x7f]/.test(v)) return undefined;
  return v;
}
function intNonNeg(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** 回的代理编号必须是问的那个（不拿别人的钱包给他看） */
function sameAgent(b: Obj, agentId: string): boolean {
  return b.agentId === agentId;
}

export function parseBalance(body: unknown, agentId: string): WalletBalanceView | string {
  if (!isObj(body)) return "不是 JSON 对象";
  if (!sameAgent(body, agentId)) return "回的代理编号跟问的不一样";
  const pending = money(body.pending);
  const available = money(body.available);
  const withdrawn = money(body.withdrawn);
  if (!pending || !available || !withdrawn) return "金额格式不对";
  if (body.currency !== "CNY") return "币种不是 CNY";
  const lastSeq = intNonNeg(body.lastSeq);
  if (lastSeq === null) return "lastSeq 不对";
  const lastEntryAt = body.lastEntryAt === null ? null : time(body.lastEntryAt);
  if (body.lastEntryAt !== null && !lastEntryAt) return "lastEntryAt 不对";
  return { currency: "CNY", pending, available, withdrawn, lastSeq, lastEntryAt, serverTime: time(body.serverTime) };
}

function parsePageMeta(body: Obj): { nextCursor: string | null; hasMore: boolean } | string {
  if (typeof body.hasMore !== "boolean") return "hasMore 不对";
  const nextCursor = optText(body.nextCursor, 512);
  if (nextCursor === undefined) return "nextCursor 不对";
  if (body.hasMore !== (nextCursor !== null)) return "hasMore 跟 nextCursor 对不上";
  return { nextCursor, hasMore: body.hasMore };
}

export function parseLedger(body: unknown, agentId: string): WalletPage<WalletLedgerItemView> | string {
  if (!isObj(body)) return "不是 JSON 对象";
  if (!sameAgent(body, agentId)) return "回的代理编号跟问的不一样";
  if (!Array.isArray(body.items)) return "items 不是数组";
  const items: WalletLedgerItemView[] = [];
  for (const [i, raw] of body.items.entries()) {
    if (!isObj(raw)) return `第 ${i + 1} 条不是对象`;
    const seq = intNonNeg(raw.seq);
    const kind = optText(raw.kind, 64);
    const pc = money(raw.pendingChange), ac = money(raw.availableChange), pa = money(raw.pendingAfter), aa = money(raw.availableAfter);
    const createdAt = time(raw.createdAt);
    const waybillNo = optText(raw.waybillNo), customerMark = optText(raw.customerMark), billNo = optText(raw.billNo), withdrawalId = optText(raw.withdrawalId);
    if (seq === null || seq === 0 || !kind || !pc || !ac || !pa || !aa || !createdAt
      || waybillNo === undefined || customerMark === undefined || billNo === undefined || withdrawalId === undefined) {
      return `第 ${i + 1} 条格式不对`;
    }
    items.push({
      seq, kind, kindLabel: LEDGER_KIND_ZH[kind] ?? `其他（${kind}）`,
      pendingChange: pc, availableChange: ac, pendingAfter: pa, availableAfter: aa,
      waybillNo, customerMark, billNo, withdrawalId, createdAt,
    });
  }
  const meta = parsePageMeta(body);
  if (typeof meta === "string") return meta;
  return { items, ...meta };
}

export function parseWithdrawals(body: unknown, agentId: string): WalletPage<WalletWithdrawalView> | string {
  if (!isObj(body)) return "不是 JSON 对象";
  if (!sameAgent(body, agentId)) return "回的代理编号跟问的不一样";
  if (!Array.isArray(body.items)) return "items 不是数组";
  const items: WalletWithdrawalView[] = [];
  for (const [i, raw] of body.items.entries()) {
    if (!isObj(raw)) return `第 ${i + 1} 条不是对象`;
    const withdrawalId = optText(raw.withdrawalId);
    const amount = money(raw.amount);
    const status = optText(raw.status, 64);
    const requestedAt = time(raw.requestedAt);
    const decidedAt = raw.decidedAt === null ? null : time(raw.decidedAt);
    const voidedAt = raw.voidedAt === null ? null : time(raw.voidedAt);
    const paidOn = raw.paidOn === null ? null : typeof raw.paidOn === "string" && DATE_ONLY.test(raw.paidOn) ? raw.paidOn : undefined;
    if (!withdrawalId || !amount || !status || !requestedAt || paidOn === undefined
      || (raw.decidedAt !== null && !decidedAt) || (raw.voidedAt !== null && !voidedAt)) {
      return `第 ${i + 1} 条格式不对`;
    }
    items.push({
      withdrawalId, amount, status, statusLabel: WITHDRAWAL_STATUS_ZH[status] ?? `其他（${status}）`,
      requestedAt, decidedAt, paidOn, voidedAt,
    });
  }
  const meta = parsePageMeta(body);
  if (typeof meta === "string") return meta;
  return { items, ...meta };
}
