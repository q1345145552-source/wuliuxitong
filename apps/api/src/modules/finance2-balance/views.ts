/* ==========================================================================
   财务系统2 客户余额接口：收进来的格式核对 + 发出去的字段（2026-11-27，约定第 12 节、1.2）
   --------------------------------------------------------------------------
   · 金额一律字符串、两位小数、人民币（约定 1.2）。JSON 数字、千分位、带单位、带空格、一位小数的都按格式错（400），不猜。
   · 给外面的字段在这里逐个列，不许 `...row`（CLAUDE.md 第 31 条）。
   · 请求内容的指纹：只算约定里那几个字段（多带的字段不算、也不存），同号再来时比它。
   ========================================================================== */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { operatorNameForDisplay } from "../core/operator-visibility";

/** 约定 12.0：财务这边生成，字母、数字、- _，最长 64 */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * 金额：两位小数的字符串。整数部分最多 12 位，跟库里 Decimal(14,2) 一样（再大进库会报错成 500）。
 * 前导零不收（"0530.00"），"0.00" 格式上收、再由调用方按「必须大于 0」挡掉。
 */
const MONEY_RE = /^(0|[1-9]\d{0,11})\.\d{2}$/;
/** 唛头 = users.id。库里没限长度，这里按 128 挡住离谱的；控制字符不收 */
const MARK_MAX_LEN = 128;
/** 账单号：约定没写长度，按 64 收（财务那边的号是 B202612-003 这种）；不许控制字符、不许首尾空白 */
const BILL_NO_MAX_LEN = 64;

export const BILL_KINDS = ["bulk", "fcl"] as const;
export const REFUND_REASONS = ["billVoided", "receiptVoided", "overCharged"] as const;
export type BillKind = (typeof BILL_KINDS)[number];
export type RefundReason = (typeof REFUND_REASONS)[number];

export interface ChargeRequest {
  requestId: string;
  customerMark: string;
  billNo: string;
  billKind: BillKind;
  /** 两位小数的字符串，大于 0 */
  maxAmount: string;
}

export interface RefundRequest {
  requestId: string;
  chargeRequestId: string;
  /** 两位小数的字符串，大于 0 */
  amount: string;
  reason: RefundReason;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function isRequestId(v: unknown): v is string {
  return typeof v === "string" && REQUEST_ID_RE.test(v);
}

/** 唛头格式：字符串、1～128 个字、没有控制字符、首尾没有空白（格式不对 400；格式对但库里没有 = 不认识） */
export function isMarkShaped(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= MARK_MAX_LEN && v === v.trim() && !/[\x00-\x1f\x7f]/.test(v);
}

/** 大于 0 的两位小数金额字符串 */
export function isPositiveMoney(v: unknown): v is string {
  return typeof v === "string" && MONEY_RE.test(v) && new Prisma.Decimal(v).gt(0);
}

function isBillNo(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= BILL_NO_MAX_LEN && v === v.trim() && !/[\x00-\x1f\x7f]/.test(v);
}

export function parseChargeBody(body: unknown): Parsed<ChargeRequest> {
  if (!isPlainObject(body)) return { ok: false, message: "请求体要是 JSON 对象" };
  const { requestId, customerMark, billNo, billKind, maxAmount } = body;
  if (!isRequestId(requestId)) return { ok: false, message: "requestId 要是 1～64 位的字母、数字、- 或 _" };
  if (!isMarkShaped(customerMark)) return { ok: false, message: `customerMark 要是 1～${MARK_MAX_LEN} 个字的字符串（不带首尾空白、控制字符）` };
  if (!isBillNo(billNo)) return { ok: false, message: `billNo 要是 1～${BILL_NO_MAX_LEN} 个字的字符串（不带首尾空白、控制字符）` };
  if (typeof billKind !== "string" || !(BILL_KINDS as readonly string[]).includes(billKind)) return { ok: false, message: "billKind 只能是 bulk 或 fcl" };
  if (!isPositiveMoney(maxAmount)) return { ok: false, message: "maxAmount 要是大于 0 的两位小数字符串，比如 \"530.00\"" };
  return { ok: true, value: { requestId, customerMark, billNo, billKind: billKind as BillKind, maxAmount } };
}

export function parseRefundBody(body: unknown): Parsed<RefundRequest> {
  if (!isPlainObject(body)) return { ok: false, message: "请求体要是 JSON 对象" };
  const { requestId, chargeRequestId, amount, reason } = body;
  if (!isRequestId(requestId)) return { ok: false, message: "requestId 要是 1～64 位的字母、数字、- 或 _" };
  if (!isRequestId(chargeRequestId)) return { ok: false, message: "chargeRequestId 要是 1～64 位的字母、数字、- 或 _" };
  if (!isPositiveMoney(amount)) return { ok: false, message: "amount 要是大于 0 的两位小数字符串，比如 \"530.00\"" };
  if (typeof reason !== "string" || !(REFUND_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, message: "reason 只能是 billVoided、receiptVoided 或 overCharged" };
  }
  return { ok: true, value: { requestId, chargeRequestId, amount, reason: reason as RefundReason } };
}

/** 请求内容的指纹：种类 + 约定里那几个字段，按固定顺序。同号再来时内容一样 ⇔ 指纹一样 */
export function chargeFingerprint(r: ChargeRequest): string {
  return sha256Hex(JSON.stringify(["charge", r.customerMark, r.billNo, r.billKind, r.maxAmount]));
}
export function refundFingerprint(r: RefundRequest): string {
  return sha256Hex(JSON.stringify(["refund", r.chargeRequestId, r.amount, r.reason]));
}
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** 金额 → 两位小数的字符串（"-120.00"）。零一律 "0.00"（Decimal 的负零不往外给） */
export function money(v: Prisma.Decimal | string | number): string {
  const d = new Prisma.Decimal(v);
  return d.isZero() ? "0.00" : d.toFixed(2);
}

/* ===== 12.4 流水 ===== */

/** 流水一行（ledger.ts 的 SQL 读出来的样子，列名是库里的下划线名） */
export interface LedgerSqlRow {
  id: string;
  client_id: string;
  type: string;
  amount: string;
  balance_after: string;
  ref_type: string | null;
  ref_id: string | null;
  ref_no: string | null;
  remark: string | null;
  operator_id: string | null;
  operator_name: string | null;
  created_at: string;
  tx_id: string;
}

/** 约定 12.4 的字段，就这 11 个，一个不多 */
export const LEDGER_ITEM_KEYS = ["id", "customerMark", "type", "amount", "balanceAfter", "refType", "refId", "refNo", "remark", "operatorName", "createdAt"] as const;

export function mapLedgerRow(r: LedgerSqlRow) {
  /* 谁做的：客户自己付款那一笔显示唛头（2026-09-19 老板「客户那步显示唛头」，跟超管看记录同一条规则 operatorNameForDisplay；
     流水表没存角色，「操作人就是这个客户自己」= 客户那步）。系统自动的、财务来扣的没有操作人，给 null（约定 12.4） */
  const shown = operatorNameForDisplay({
    operatorRole: r.operator_id !== null && r.operator_id === r.client_id ? "client" : "staff",
    operatorId: r.operator_id,
    operatorName: r.operator_name,
  });
  return {
    id: r.id,
    customerMark: r.client_id,
    type: r.type,
    amount: money(r.amount),
    balanceAfter: money(r.balance_after),
    refType: r.ref_type,
    refId: r.ref_id,
    refNo: r.ref_no,
    remark: r.remark,
    operatorName: shown === "" ? null : shown,
    createdAt: r.created_at,
  };
}

/* ===== 游标 ===== */

/**
 * /ledger 的游标：上一页最后一条的（事务号, 时间, 编号）。排序也是这三样（ledger.ts）。
 * 不带游标 = 从头：等于 (-1, 1970-01-01, "")，比所有流水都小（老流水的事务号是 0）。
 */
export interface LedgerCursor {
  /** 事务号（十进制字符串，可以是 -1） */
  x: string;
  /** 时间（带 Z 的 ISO，毫秒） */
  t: string;
  /** 流水编号（可以是空串） */
  i: string;
}

export const LEDGER_START: LedgerCursor = { x: "-1", t: "1970-01-01T00:00:00.000Z", i: "" };

export function encodeLedgerCursor(c: LedgerCursor): string {
  return Buffer.from(JSON.stringify({ x: c.x, t: c.t, i: c.i }), "utf8").toString("base64url");
}

/** 解不开、字段不对给 null（接口回 400） */
export function decodeLedgerCursor(raw: string): LedgerCursor | null {
  if (raw.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!isPlainObject(v)) return null;
    if (Object.keys(v).sort().join(",") !== "i,t,x") return null;
    const { x, t, i } = v;
    if (typeof x !== "string" || !/^(-1|0|[1-9]\d{0,18})$/.test(x)) return null;
    if (BigInt(x) > 9223372036854775807n) return null;
    if (typeof t !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t) || Number.isNaN(new Date(t).getTime())) return null;
    if (new Date(t).toISOString() !== t) return null;
    // 流水编号现在都是 cuid，这里不卡字符集（只挡控制字符和离谱的长度），以后换了编号写法游标照样能用
    if (typeof i !== "string" || i.length > 128 || /[\x00-\x1f\x7f]/.test(i)) return null;
    return { x, t, i };
  } catch {
    return null;
  }
}
