import { createHash } from "node:crypto";

/**
 * 拆派仓回传状态的校验和规则（纯函数，不碰库）。2026-10-12。
 *
 * 格式照拆派仓 integrations/outbox.service.ts 的 recordOnTransition 和《对外接口对接说明》3.3 核过：
 *   { eventId, waybillNo, status, occurredAt, protocolVersion: 2, companyId, sourceShipmentId, parentWaybillNo,
 *     sourceUpdatedAt, sequence, batchKey, batchNo, containerNo, actualBoxCount?, shortage?, execution?, delivery? }
 * （delivery 是 2026-11-09 加的，只有 DELIVERED 带，见 DELIVERY_KINDS）
 * 默认只在粗状态变了才发一条；sequence 每票递增但可能跳号（前面那条发失败就不再发）；
 * 拆派仓里「已签收」是终点，不会再往回走。
 */

export const CHAIPAI_STATUSES = ["ARRIVED", "LOADED", "OUT_FOR_DELIVERY", "DELIVERED"] as const;
export type ChaipaiStatus = (typeof CHAIPAI_STATUSES)[number];

/**
 * DELIVERED 带的件数（2026-11-09，老板第 54、56 条：少送、补送、确认丢失写进轨迹，客户看得到）：
 *   SIGNED            第一次签收（送齐了也带，missingBoxCount 0）
 *   SUPPLEMENT_SIGNED 少的那几件后来补送签收了（拆派仓以原票身份再发一条 DELIVERED）
 *   LOSS_CONFIRMED    少的那几件确认丢失（同上）
 * 字段照拆派仓任务书《湘泰物流系统任务-少送补送丢失写进轨迹-2026-11-09》。
 */
export const DELIVERY_KINDS = ["SIGNED", "SUPPLEMENT_SIGNED", "LOSS_CONFIRMED"] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export interface ChaipaiDelivery {
  kind: DeliveryKind;
  /** 这票清单应到件数 */
  expectedBoxCount: number;
  /** 到这一刻为止累计送到的件数（第一次签收 + 已签收的补送） */
  deliveredBoxCount: number;
  /** 还差几件（应到 - 累计送到，最小 0） */
  missingBoxCount: number;
  /** 只有 SUPPLEMENT_SIGNED：这次补送签收了几件 */
  supplementBoxCount: number | null;
  /** 只有 LOSS_CONFIRMED：这次确认丢失几件 */
  lostBoxCount: number | null;
}

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
  /** 只有 DELIVERED 认（2026-11-09）；没带、格式不对都是 null，照以前的签收办 */
  delivery: ChaipaiDelivery | null;
  /** 只用来记日志 */
  waybillNo: string | null;
  /** 协议里其余认得的字段原样（只进摘要：同一 eventId 这些变了也算「换了内容」） */
  extras: Record<string, unknown>;
}

/** 协议里认得、但湘泰不靠它办事的字段（照拆派仓 outbox.service.ts 的 recordOnTransition） */
const KNOWN_EXTRA_FIELDS = ["waybillNo", "parentWaybillNo", "sourceUpdatedAt", "batchKey", "batchNo", "containerNo", "execution"] as const;

/** 键排好序再转 JSON（对象里键的先后不影响摘要） */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v === undefined ? null : v;
}

export type ParseResult =
  | { ok: true; event: ChaipaiEvent }
  | { ok: false; status: 400 | 409; message: string };

function idText(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

/** 件数：安全整数且不小于 min，否则 null */
function countOf(value: unknown, min: 0 | 1): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : null;
}

/**
 * DELIVERED 带的 delivery：kind 不认识、三个件数不是非负安全整数、补送没有正整数的 supplementBoxCount、
 * 丢失没有正整数的 lostBoxCount —— 一律当没带（不拒收，跟到仓件数 actualBoxCount 一样）。
 * 只留认得的字段，别的不管（摘要也只算这几个）。
 */
function parseDelivery(raw: unknown): ChaipaiDelivery | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const kind = d.kind;
  if (typeof kind !== "string" || !(DELIVERY_KINDS as readonly string[]).includes(kind)) return null;
  const expectedBoxCount = countOf(d.expectedBoxCount, 0);
  const deliveredBoxCount = countOf(d.deliveredBoxCount, 0);
  const missingBoxCount = countOf(d.missingBoxCount, 0);
  if (expectedBoxCount === null || deliveredBoxCount === null || missingBoxCount === null) return null;
  const supplementBoxCount = kind === "SUPPLEMENT_SIGNED" ? countOf(d.supplementBoxCount, 1) : null;
  const lostBoxCount = kind === "LOSS_CONFIRMED" ? countOf(d.lostBoxCount, 1) : null;
  if (kind === "SUPPLEMENT_SIGNED" && supplementBoxCount === null) return null;
  if (kind === "LOSS_CONFIRMED" && lostBoxCount === null) return null;
  return { kind: kind as DeliveryKind, expectedBoxCount, deliveredBoxCount, missingBoxCount, supplementBoxCount, lostBoxCount };
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
  const delivery = status === "DELIVERED" ? parseDelivery(v.delivery) : null;
  const waybillNo = typeof v.waybillNo === "string" ? v.waybillNo.slice(0, 128) : null;
  const extras = Object.fromEntries(KNOWN_EXTRA_FIELDS.map((k) => [k, canonical(v[k])]));
  return {
    ok: true,
    event: { eventId, companyId, sourceShipmentId, sequence, status: status as ChaipaiStatus, occurredAt, actualBoxCount, shortage, delivery, waybillNo, extras },
  };
}

/** 补送签收 / 确认丢失（第一次签收以后的事）：只记轨迹，不改状态、不动派送单、不去拆派仓取照片、不推进回传进度 */
export function followUpOf(e: ChaipaiEvent): ChaipaiDelivery | null {
  return e.status === "DELIVERED" && e.delivery && e.delivery.kind !== "SIGNED" ? e.delivery : null;
}

/**
 * 内容摘要：拆派仓重发的是发件箱里同一份内容，所以同一 eventId 摘要必定一样；不一样 = 编号被拿去发别的内容（回 409）。
 * 协议里认得的字段全算进去（10-12 Codex 审查：原来只算办事用的几个，改了批次号 / 运单号照样当重复收下）；认不得的扩展字段不算。
 * delivery（2026-11-09）认得了才放进去：没带的摘要跟以前一字不差 —— 上线前已收下的消息拆派仓再重发，
 * 照样认成 DUPLICATE，不会变成 409。
 */
export function eventHashOf(e: ChaipaiEvent): string {
  const parts: unknown[] = [
    e.eventId, e.companyId, e.sourceShipmentId, e.sequence, e.status, e.occurredAt, e.actualBoxCount, e.shortage,
    KNOWN_EXTRA_FIELDS.map((k) => e.extras[k] ?? null),
  ];
  if (e.delivery) parts.push(canonical(e.delivery));
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
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

/** 第一次签收；少送了（第 54 条）后面接「实送 N 件，少 M 件」，送齐或没带件数照旧 */
export function signedRemark(deliveryNo: string, delivery: ChaipaiDelivery | null = null): string {
  const base = `尾程派送已签收（${deliveryNo}）`;
  return delivery?.kind === "SIGNED" && delivery.missingBoxCount > 0
    ? `${base}，实送 ${delivery.deliveredBoxCount} 件，少 ${delivery.missingBoxCount} 件`
    : base;
}

/** 补送签收 / 确认丢失那一句（第 54 条；客户看得到，第 56 条） */
export function followUpRemark(d: ChaipaiDelivery): string {
  if (d.kind === "LOSS_CONFIRMED") return `少的 ${d.lostBoxCount} 件确认丢失，累计送到 ${d.deliveredBoxCount} 件`;
  const head = `补送 ${d.supplementBoxCount} 件已签收，累计送到 ${d.deliveredBoxCount} 件`;
  return d.missingBoxCount > 0 ? `${head}，还少 ${d.missingBoxCount} 件` : head;
}

export function unsignRemark(deliveryNo: string): string {
  return `撤销误签收（${deliveryNo}）：这票货还没送到，退回派送中`;
}

/** 派送日期（尾端派送单那一格是纯文本 YYYY-MM-DD）：按曼谷时间取日子；第一个时间认不出来就用第二个（回传的 occurredAt 校验过） */
export function bangkokDate(iso: string | null | undefined, fallbackIso: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  return new Date((Number.isFinite(t) ? t : Date.parse(fallbackIso)) + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 签收图：拆派仓先拍照才能签收，取签收那一刻之前最新的一张；都在之后（时钟差）就取最新一张。
 * 2026-11-12 拆派仓 flow23 起照片带 kind（拆派仓全面排查第四份报告第 2 条）：列表里除了司机签收照，还有拆派仓员工
 * 到仓 / 派送中补传的照片，只按时间挑会把员工照当签收图。所以列表里只要有一张带了 kind，就只在 SIGN_OFF 里挑；
 * 一张 SIGN_OFF 都没有就不配签收图（不拿员工照顶）。整个列表都没有 kind（拆派仓还是旧版本）照旧按时间挑。
 * 「派送照片」（员工看，photo-routes.ts）不经过这里，照旧给全部照片（第 256 条）。
 * ⚠️ 拆派仓的 SIGN_OFF 也包括司机在停靠点拍了、那次没送成的照片（拆派仓 photos/photo-policy.ts）。换一趟再送时
 * 新一趟必须重拍、时间更晚，挑得对；同一趟先点「送不成」又改成签收、没重拍时，挑到的就是那张 —— 湘泰这边分不出来（11-12 dsh）。
 */
export function pickSignPhoto(
  photos: ReadonlyArray<{ id: string; createdAt: string; kind?: "SIGN_OFF" | "STAFF" | null }>,
  occurredAt: string,
): string | null {
  const pool = photos.some((p) => p.kind != null) ? photos.filter((p) => p.kind === "SIGN_OFF") : photos;
  const valid = pool.filter((p) => Number.isFinite(Date.parse(p.createdAt)));
  if (valid.length === 0) return null;
  const byTimeDesc = [...valid].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1));
  const cutoff = Date.parse(occurredAt);
  return (byTimeDesc.find((p) => Date.parse(p.createdAt) <= cutoff) ?? byTimeDesc[0]).id;
}
