/* ==========================================================================
   给财务系统2 的运单长什么样（2026-11-19，约定第 2.3～2.7 节、第 3 节样例）
   --------------------------------------------------------------------------
   ⚠️ 全是纯函数，不碰数据库，scripts/test-finance2-source.ts 直接测。
   ⚠️ 每个字段逐个列出，绝不写 `...row`（CLAUDE.md #31）：字段一个不多一个不少，null 不省略，数组没有给 []。
   ⚠️ 金额、体积、重量、尺寸一律字符串（约定 1.2）：整票 / 子运单 / 每柜体积 3 位、产品方数 6 位、重量 2 位、金额 2 位、
      尺寸按库里浮点最短的十进制写法原样给。时间一律 toISOString()（UTC，带 Z）；只有日期的给 UTC 的年月日。
   ⚠️ 能复用的不另写：整票体积重量用 shipments/total-metrics.ts 的 resolveOrderTotalMetric（跟 loadOrderTotalMetrics 同一个取法），
      产品方数用 finance-link/views.ts 的 declaredVolumeM3，货型用 cargoTypeOrNull，子单方数补算用 split-metrics.ts 的 metricByPieceShare。
   ========================================================================== */

import type { Prisma } from "@prisma/client";
import { cargoTypeOrNull, declaredVolumeM3 } from "../finance-link/views";
import { metricByPieceShare } from "../shipments/split-metrics";
import { resolveOrderTotalMetric } from "../shipments/total-metrics";

type Dec = Prisma.Decimal | null;

export interface SourceOrder {
  clientId: string;
  warehouseId: string;
  transportMode: string;
  cargoType: string;
  volumeM3: Dec;
  weightKg: Dec;
  packageCount: number;
  approvalStatus: string;
  receivableAmountCny: Dec;
  createdAt: Date;
}

export interface SourceShipment {
  id: string;
  trackingNo: string;
  parentTrackingNo: string | null;
  currentStatus: string;
  volumeM3: Dec;
  weightKg: Dec;
  packageCount: number | null;
}

export interface SourceProduct {
  id: string;
  cargoType: string;
  itemName: string;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  packageCount: number;
}

export interface SourceLog {
  toStatus: string;
  changedAt: Date;
}

export interface SourceContainerItem {
  /** 装进去的是哪张运单（母或子） */
  trackingNo: string;
  loadedVolumeM3: Prisma.Decimal;
  loadedPieceCount: number;
  createdAt: Date;
  container: {
    containerNo: string;
    containerType: string;
    loadingDate: Date | null;
    isFcl: boolean;
  };
}

/** 一票运单要用的全部原料（load.ts 查出来，这里只拼） */
export interface WaybillSource {
  order: SourceOrder;
  /** 客户现在属于哪个代理（users.agent_id） */
  agentId: string | null;
  mother: SourceShipment;
  /** 子运单（parent_tracking_no = 母运单号），已按运单号排好 */
  children: SourceShipment[];
  /** 已按 sortOrder 排好 */
  products: SourceProduct[];
  /** 每张运单（母和子，按 id）的轨迹，已按时间从早到晚排好 */
  logsByShipmentId: ReadonlyMap<string, readonly SourceLog[]>;
  /** 母运单和子运单的全部装柜明细 */
  containerItems: SourceContainerItem[];
  changedAt: Date;
}

export interface Finance2Product {
  productLineId: string;
  cargoType: string | null;
  name: string;
  lengthCm: string | null;
  widthCm: string | null;
  heightCm: string | null;
  pieces: number;
  volumeCbm: string | null;
}

export interface Finance2ContainerLoad {
  containerNo: string;
  trackingNo: string;
  volumeCbm: string;
  pieces: number;
  loadedAt: string;
}

export interface Finance2Split {
  trackingNo: string;
  status: string;
  statusChangedAt: string | null;
  volumeCbm: string | null;
  pieces: number | null;
}

export interface Finance2Fcl {
  containerNo: string;
  containerType: string;
  loadingDate: string | null;
  amountCny: string | null;
}

export interface Finance2Waybill {
  waybillNo: string;
  customerMark: string | null;
  agentId: string | null;
  warehouseCode: string | null;
  transportMode: string | null;
  cargoType: string | null;
  volumeCbm: string | null;
  weightKg: string | null;
  pieces: number | null;
  products: Finance2Product[];
  approvalStatus: string | null;
  status: string | null;
  statusChangedAt: string | null;
  statusHistory: Array<{ status: string; at: string }>;
  warehouseConfirmedAt: string | null;
  signedAt: string | null;
  isFcl: boolean;
  fcl: Finance2Fcl | null;
  containers: Finance2ContainerLoad[];
  splits: Finance2Split[];
  createdAt: string | null;
  changedAt: string;
  deletedAt: string | null;
}

/** 约定 2.3 的字段顺序（测试拿它钉「一个不多一个不少」） */
export const WAYBILL_KEYS = [
  "waybillNo", "customerMark", "agentId", "warehouseCode", "transportMode", "cargoType", "volumeCbm", "weightKg", "pieces",
  "products", "approvalStatus", "status", "statusChangedAt", "statusHistory", "warehouseConfirmedAt", "signedAt",
  "isFcl", "fcl", "containers", "splits", "createdAt", "changedAt", "deletedAt",
] as const;

/* ---------- 格式 ---------- */

/** 定点小数：Decimal 直接按位数给（库里已经是这个位数，不会再舍）；数字走 toFixed */
export function fixed(value: Prisma.Decimal | number | null | undefined, digits: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(digits) : null;
  return value.toFixed(digits);
}

/** 尺寸：库里是浮点，按它最短的十进制写法原样给（16.9 → "16.9"，50 → "50"），不补零不舍入 */
export function floatText(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return String(value);
}

export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** 只有日期的（整柜装柜日期）：库里存的是那天的 UTC 零点，取 UTC 年月日 */
export function utcDate(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/* ---------- 从轨迹取的几个时间 ---------- */

/** 这些状态下还没确认收货（约定 2.3「确认收货时间怎么取」） */
const NOT_CONFIRMED_STATUSES = new Set(["created", "pendingInbound"]);

/**
 * 仓库确认收货时间：母运单**最早**一条到 inWarehouseCN 的轨迹。卸柜退回仓里会再写一条，不算（取最早的）。
 * 预报单还没收货（approvalStatus = shipped）、状态还在 created / pendingInbound 的给 null。
 */
export function warehouseConfirmedAtOf(approvalStatus: string, motherStatus: string, motherLogs: readonly SourceLog[]): Date | null {
  if (approvalStatus === "shipped" || NOT_CONFIRMED_STATUSES.has(motherStatus)) return null;
  let earliest: Date | null = null;
  for (const log of motherLogs) {
    if (log.toStatus !== "inWarehouseCN") continue;
    if (!earliest || log.changedAt < earliest) earliest = log.changedAt;
  }
  return earliest;
}

/** 子运单退回 / 取消就不再往前走了，签收时不等它们（跟 shipments/parent-status.ts 推父单状态同一个口径） */
const SETTLED_CHILD_STATUSES = new Set(["delivered", "returned", "cancelled"]);

/**
 * 签收时间：母运单已签收、子运单都签收了（退回 / 取消的不等），取这一家最后一条到 delivered 的轨迹时间。
 * 母运单自己 0 件时它的状态是跟着最慢的子单推的、不写轨迹，所以要把子单的轨迹一起看。
 * 都签收了却一条 delivered 轨迹都没有（老数据、员工删过轨迹）给 null。
 */
export function signedAtOf(source: Pick<WaybillSource, "mother" | "children" | "logsByShipmentId">): Date | null {
  if (source.mother.currentStatus !== "delivered") return null;
  if (!source.children.every((c) => SETTLED_CHILD_STATUSES.has(c.currentStatus))) return null;
  let latest: Date | null = null;
  for (const shipment of [source.mother, ...source.children]) {
    for (const log of source.logsByShipmentId.get(shipment.id) ?? []) {
      if (log.toStatus === "delivered" && (!latest || log.changedAt > latest)) latest = log.changedAt;
    }
  }
  return latest;
}

function lastLogAt(logs: readonly SourceLog[] | undefined): Date | null {
  if (!logs || logs.length === 0) return null;
  let latest = logs[0].changedAt;
  for (const log of logs) if (log.changedAt > latest) latest = log.changedAt;
  return latest;
}

/* ---------- 拼一票 ---------- */

export function buildWaybill(source: WaybillSource): Finance2Waybill {
  const { order, mother, children } = source;
  const family = [mother, ...children];
  const motherLogs = source.logsByShipmentId.get(mother.id) ?? [];

  // 整票体积重量：订单上的优先，没有才合计父子运单（跟运单列表、原来那条财务接口同一个取法）
  const totalVolume = resolveOrderTotalMetric(order.volumeM3, family.map((s) => s.volumeM3));
  const totalWeight = resolveOrderTotalMetric(order.weightKg, family.map((s) => s.weightKg));

  const items = [...source.containerItems].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.trackingNo.localeCompare(b.trackingNo) || a.container.containerNo.localeCompare(b.container.containerNo),
  );
  const fclItem = items.find((it) => it.container.isFcl) ?? null;

  return {
    waybillNo: mother.trackingNo,
    customerMark: order.clientId,
    agentId: source.agentId,
    warehouseCode: order.warehouseId,
    transportMode: order.transportMode,
    cargoType: cargoTypeOrNull(order.cargoType),
    volumeCbm: fixed(totalVolume, 3),
    weightKg: fixed(totalWeight, 2),
    pieces: order.packageCount,
    products: source.products.map((p) => ({
      productLineId: p.id,
      cargoType: cargoTypeOrNull(p.cargoType),
      name: p.itemName,
      lengthCm: floatText(p.lengthCm),
      widthCm: floatText(p.widthCm),
      heightCm: floatText(p.heightCm),
      pieces: p.packageCount,
      volumeCbm: fixed(declaredVolumeM3(p), 6),
    })),
    approvalStatus: order.approvalStatus,
    status: mother.currentStatus,
    statusChangedAt: iso(lastLogAt(motherLogs)),
    statusHistory: motherLogs.map((log) => ({ status: log.toStatus, at: log.changedAt.toISOString() })),
    warehouseConfirmedAt: iso(warehouseConfirmedAtOf(order.approvalStatus, mother.currentStatus, motherLogs)),
    signedAt: iso(signedAtOf(source)),
    isFcl: fclItem !== null,
    fcl: fclItem
      ? {
          containerNo: fclItem.container.containerNo,
          containerType: fclItem.container.containerType,
          loadingDate: utcDate(fclItem.container.loadingDate),
          amountCny: fixed(order.receivableAmountCny, 2),
        }
      : null,
    containers: items.map((it) => ({
      containerNo: it.container.containerNo,
      trackingNo: it.trackingNo,
      volumeCbm: it.loadedVolumeM3.toFixed(3),
      pieces: it.loadedPieceCount,
      loadedAt: it.createdAt.toISOString(),
    })),
    splits: children.map((c) => ({
      trackingNo: c.trackingNo,
      status: c.currentStatus,
      statusChangedAt: iso(lastLogAt(source.logsByShipmentId.get(c.id))),
      // 老的手工分柜子单没存方数时按件数占比补算（跟物流系统导出一样）
      volumeCbm: fixed(c.volumeM3 ?? metricByPieceShare(order.volumeM3, c.packageCount, order.packageCount, 3), 3),
      pieces: c.packageCount,
    })),
    createdAt: order.createdAt.toISOString(),
    changedAt: source.changedAt.toISOString(),
    deletedAt: null,
  };
}

/** 删除记录（约定 3.9）：只有运单号、删除时间、改动时间有值 */
export function deletedWaybill(waybillNo: string, deletedAt: Date, changedAt: Date): Finance2Waybill {
  return {
    waybillNo,
    customerMark: null,
    agentId: null,
    warehouseCode: null,
    transportMode: null,
    cargoType: null,
    volumeCbm: null,
    weightKg: null,
    pieces: null,
    products: [],
    approvalStatus: null,
    status: null,
    statusChangedAt: null,
    statusHistory: [],
    warehouseConfirmedAt: null,
    signedAt: null,
    isFcl: false,
    fcl: null,
    containers: [],
    splits: [],
    createdAt: null,
    changedAt: changedAt.toISOString(),
    deletedAt: deletedAt.toISOString(),
  };
}

/* ---------- 客户、代理 ---------- */

export function mapCustomer(user: { id: string; name: string; agentId: string | null; status: string }) {
  return { customerMark: user.id, name: user.name === "" ? null : user.name, agentId: user.agentId, active: user.status === "active" };
}

export function mapAgent(agent: { id: string; name: string }) {
  return { agentId: agent.id, name: agent.name };
}

/* ---------- 游标（不透明，财务原样带回来） ---------- */

export interface ChangeCursor { t: Date; w: string }

export function encodeCursor(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** 解不开、字段不对给 null（接口回 400） */
export function decodeCursor(raw: string, keys: readonly string[]): Record<string, string> | null {
  if (raw.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    if (Object.keys(obj).sort().join(",") !== [...keys].sort().join(",")) return null;
    for (const k of keys) if (typeof obj[k] !== "string" || !(obj[k] as string)) return null;
    return obj as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * 时间参数：必须带时区（Z 或 ±hh:mm），不带时区的不猜（约定 1.2）。
 * 年月日时分秒逐个核：2 月 31 日、24 点这种 JS 会悄悄顺延的不收；年份只认 1970～9999（0000 年进库会报错成 500，审查实测）
 */
export function parseZonedTime(raw: string | undefined): Date | null {
  if (!raw || raw.length > 40) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  if (y < 1970 || h > 23 || mi > 59 || sec > 59) return null;
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  if (local.getUTCFullYear() !== y || local.getUTCMonth() !== mo - 1 || local.getUTCDate() !== d) return null;
  if (m[9] && (Number(m[10]) > 23 || Number(m[11]) > 59)) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}
