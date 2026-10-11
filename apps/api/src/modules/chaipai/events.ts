import { createHash } from "node:crypto";

/**
 * 拆派仓回传状态的校验和规则（纯函数，不碰库）。2026-10-12。
 *
 * 格式照拆派仓 integrations/outbox.service.ts 的 recordOnTransition 和《对外接口对接说明》3.3 核过：
 *   { eventId, waybillNo, status, occurredAt, protocolVersion: 2, companyId, sourceShipmentId, parentWaybillNo,
 *     sourceUpdatedAt, sequence, batchKey, batchNo, containerNo, actualBoxCount?, shortage?, execution? }
 * 默认只在粗状态变了才发一条；sequence 每票递增但可能跳号（前面那条发失败就不再发）；
 * 拆派仓里「已签收」是终点，不会再往回走。
 */

export const CHAIPAI_STATUSES = ["ARRIVED", "LOADED", "OUT_FOR_DELIVERY", "DELIVERED"] as const;
export type ChaipaiStatus = (typeof CHAIPAI_STATUSES)[number];

export interface ChaipaiEvent {
  eventId: string;
  companyId: string;
  sourceShipmentId: string;
  sequence: number;
  status: ChaipaiStatus;
  /** 原文（UTC 毫秒 ISO） */
  occurredAt: string;
  /** 只有 ARRIVED 带、而且拆派仓点了数才有 */
  actualBoxCount: number | null;
  shortage: boolean | null;
  /** 只用来记日志 */
  waybillNo: string | null;
}

export type ParseResult =
  | { ok: true; event: ChaipaiEvent }
  | { ok: false; status: 400 | 409; message: string };

function idText(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

/** 校验一条回传。companyId 对不上是配置错了（回 409，不能当收到）；其他不合格回 400（拆派仓会重发、最后标失败） */
export function parseChaipaiEvent(raw: unknown, companyId: string): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, status: 400, message: "请求体要是 JSON 对象" };
  const v = raw as Record<string, unknown>;
  if (v.protocolVersion !== 2) return { ok: false, status: 400, message: "protocolVersion 要是 2" };
  if (typeof v.companyId !== "string") return { ok: false, status: 400, message: "companyId 要是文本" };
  if (v.companyId !== companyId) return { ok: false, status: 409, message: "companyId 跟湘泰配置的不一样" };
  const eventId = idText(v.eventId);
  const sourceShipmentId = idText(v.sourceShipmentId);
  if (!eventId || !sourceShipmentId) return { ok: false, status: 400, message: "eventId / sourceShipmentId 要是 1～128 字的文本" };
  const sequence = v.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2147483647) {
    return { ok: false, status: 400, message: "sequence 要是正整数" };
  }
  const status = v.status;
  if (typeof status !== "string" || !(CHAIPAI_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, status: 400, message: "status 不认识" };
  }
  const occurredAt = v.occurredAt;
  if (typeof occurredAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(occurredAt)
    || !Number.isFinite(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt) {
    return { ok: false, status: 400, message: "occurredAt 要是 UTC 毫秒时间（例 2026-10-12T03:00:00.000Z）" };
  }
  // 件数和少件是选填：带了但格式不对就当没带，不拒收（拆派仓「有数才带」）
  const box = v.actualBoxCount;
  const actualBoxCount = status === "ARRIVED" && typeof box === "number" && Number.isSafeInteger(box) && box >= 0 && box <= 2147483647 ? box : null;
  const shortage = status === "ARRIVED" && typeof v.shortage === "boolean" ? v.shortage : null;
  const waybillNo = typeof v.waybillNo === "string" ? v.waybillNo.slice(0, 128) : null;
  return {
    ok: true,
    event: { eventId, companyId, sourceShipmentId, sequence, status: status as ChaipaiStatus, occurredAt, actualBoxCount, shortage, waybillNo },
  };
}

/** 关键字段摘要：拆派仓重发的是发件箱里同一份内容，所以同一 eventId 摘要必定一样；不一样 = 编号被拿去发别的内容 */
export function eventHashOf(e: ChaipaiEvent): string {
  return createHash("sha256").update(JSON.stringify([
    e.eventId, e.companyId, e.sourceShipmentId, e.sequence, e.status, e.occurredAt, e.actualBoxCount, e.shortage,
  ])).digest("hex");
}

/** 已到泰国仓及以后（泰国段）的几个湘泰状态 */
const TH_STAGE = new Set(["inWarehouseTH", "deliveryBooked", "outForDelivery", "delivered"]);
/** 已经出车 / 签收的两个状态：拆派仓再说「已到仓」就是货拉回来了 */
const OUT_OR_SIGNED = new Set(["outForDelivery", "delivered"]);

export interface EventPlan {
  /** 湘泰运单要改成的状态（跟现在一样就是不改） */
  targetStatus: string;
  /** 货送出去又拉回仓（要撤掉派送中的派送单） */
  isReturn: boolean;
}

/**
 * 拆派仓状态 → 湘泰运单状态（老板第 244、253 条：以拆派仓为准、往回走也跟；只改成已到泰国仓 / 派送中 / 已签收）。
 *   ARRIVED          → 已到泰国仓（湘泰已经是派送中 / 已签收 = 送不成拉回仓）
 *   LOADED           → 只有还在已到泰国仓之前（清关、卸柜……）才提到已到泰国仓；已经在泰国段（含派送中、已签收）一律不动，
 *                      只记一条「泰国已装车」（修改清单第二节第 3 条表格：「否则不变」；10-12 Codex 审查纠正）
 *   OUT_FOR_DELIVERY → 派送中
 *   DELIVERED        → 已签收
 */
export function planForEvent(status: ChaipaiStatus, currentStatus: string): EventPlan {
  switch (status) {
    case "ARRIVED":
      return { targetStatus: "inWarehouseTH", isReturn: OUT_OR_SIGNED.has(currentStatus) };
    case "LOADED":
      return { targetStatus: TH_STAGE.has(currentStatus) ? currentStatus : "inWarehouseTH", isReturn: false };
    case "OUT_FOR_DELIVERY":
      return { targetStatus: "outForDelivery", isReturn: false };
    case "DELIVERED":
      return { targetStatus: "delivered", isReturn: false };
  }
}

/**
 * 轨迹备注（客户看得到，老板第 255 条：不出现「拆派仓」三个字）。
 * 派送中 / 签收两句照员工手工登记那条路（admin-ops 的 /admin/lastmile/orders、/admin/lastmile/status）的原话。
 */
export function arrivedRemark(actualBoxCount: number | null, shortage: boolean | null): string {
  if (actualBoxCount == null) return "已到泰国仓";
  return shortage ? `已到泰国仓，实到 ${actualBoxCount} 件（少件）` : `已到泰国仓，实到 ${actualBoxCount} 件`;
}
export const LOADED_REMARK = "泰国已装车";
export const RETURN_REMARK = "未送达，已回泰国仓";

export function departRemark(input: { driverName: string; deliveryNo: string; handoverCarrier: string | null; handoverTrackingNo: string | null }): string {
  if (input.handoverCarrier) {
    return input.handoverTrackingNo
      ? `已交给【${input.handoverCarrier}】派送，单号 ${input.handoverTrackingNo}，请注意查收`
      : `已交给【${input.handoverCarrier}】派送，请注意查收`;
  }
  // 拆派仓不给司机电话，只写名字（没名字就退回不带司机的那句，别弄出「司机【】」）
  return input.driverName
    ? `司机【${input.driverName}】正在为您派送，请注意查收`
    : `正在为您派送，请注意查收（${input.deliveryNo}）`;
}

export function signedRemark(deliveryNo: string): string {
  return `尾程派送已签收（${deliveryNo}）`;
}

export function unsignRemark(deliveryNo: string): string {
  return `撤销误签收（${deliveryNo}）：这票货还没送到，退回派送中`;
}

/** 派送日期（尾端派送单那一格是纯文本 YYYY-MM-DD）：按曼谷时间取日子；第一个时间认不出来就用第二个（回传的 occurredAt 校验过） */
export function bangkokDate(iso: string | null | undefined, fallbackIso: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  return new Date((Number.isFinite(t) ? t : Date.parse(fallbackIso)) + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 签收图：拆派仓先拍照才能签收，取签收那一刻之前最新的一张；都在之后（时钟差）就取最新一张 */
export function pickSignPhoto(photos: ReadonlyArray<{ id: string; createdAt: string }>, occurredAt: string): string | null {
  const valid = photos.filter((p) => Number.isFinite(Date.parse(p.createdAt)));
  if (valid.length === 0) return null;
  const byTimeDesc = [...valid].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1));
  const cutoff = Date.parse(occurredAt);
  return (byTimeDesc.find((p) => Date.parse(p.createdAt) <= cutoff) ?? byTimeDesc[0]).id;
}
