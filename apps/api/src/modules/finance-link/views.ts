/* ==========================================================================
   给财务系统的运单数据怎么裁（2026-11-04）
   --------------------------------------------------------------------------
   ⚠️ 全是纯函数，不碰数据库，scripts/test-finance-link-source.ts 直接测。
   ⚠️ 每个字段**逐个列出**，绝不写 `...row`（CLAUDE.md #31）：代理端那份行里还有柜号以外的东西
      （收件人姓名电话地址、订单 id、运单 id、订单号），只有列在这里的才出得去。
   ⚠️ 一律不给：柜号（batchNo / containerNo）、金额（receivableAmountCny）、收件人资料、员工和操作人、内部备注、内部 id、客户名字。
      clientName 这个字段名沿用两边约定，值是唛头（2026-11-04 老板选全部填唛头）。
   ========================================================================== */

import { domesticNosLabel } from "../../../../../packages/shared-types/product-names";
import { remarkForAgent } from "../agent-portal/views";
import { maskLabeledContainerNo } from "../core/client-privacy";
import { waybillStatusZh } from "./status-zh";

/** loadShipmentRows 给出来的一行里，这里要用的那些字段 */
export interface WaybillSourceRow {
  trackingNo: string | null;
  clientId: string;
  productNames: string;
  packageCount: number;
  packageUnit: string;
  weightKg: number | null;
  volumeM3: number | null;
  totalWeightKg: number | null;
  totalVolumeM3: number | null;
  transportMode: string;
  domesticTrackingNo: string | null;
  products: ReadonlyArray<{ domesticTrackingNo?: string | null }>;
  currentStatus: string | null;
  partialAhead?: string | null;
  statusGroup: string;
  updatedAt: string;
}

export interface FinanceWaybill {
  trackingNo: string | null;
  clientId: string;
  clientName?: string;
  productNames: string;
  packageCount: number;
  packageUnit: string;
  weightKg: number | null;
  volumeM3: number | null;
  totalWeightKg: number | null;
  totalVolumeM3: number | null;
  transportMode: string;
  domesticTrackingNo: string | null;
  currentStatus: string | null;
  statusZh: string;
  partialAhead: string | null;
  statusGroup: string;
  updatedAt: string;
}

/** 运单列表一行。只有代理账号有 clientName（值是唛头）；普通客户不给（看的就是自己） */
export function mapWaybillRow(row: WaybillSourceRow, isAgent: boolean): FinanceWaybill {
  const item: FinanceWaybill = {
    trackingNo: row.trackingNo,
    clientId: row.clientId,
    productNames: row.productNames,
    packageCount: row.packageCount,
    packageUnit: row.packageUnit,
    weightKg: row.weightKg,
    volumeM3: row.volumeM3,
    totalWeightKg: row.totalWeightKg,
    totalVolumeM3: row.totalVolumeM3,
    transportMode: row.transportMode,
    // 一票多款产品时每款有自己的国内单号，跟代理端列表、客户端导出同一个函数拼
    domesticTrackingNo: domesticNosLabel(row.products, row.domesticTrackingNo) || null,
    currentStatus: row.currentStatus,
    statusZh: waybillStatusZh(row.currentStatus),
    partialAhead: row.partialAhead ?? null,
    statusGroup: row.statusGroup,
    updatedAt: row.updatedAt,
  };
  if (isAgent) item.clientName = row.clientId;
  return item;
}

/**
 * 「柜号：ABC-77」这种手写：号可能没录进系统、也不是标准柜号，只能认「柜号」这两个字后面跟的东西。
 * 后面是字母数字就连着抹（可能写了好几个：ABC-77、XYZ-88 / ABC-77 XYZ-88 / L26 0821 9129），碰到中文停，后半句留着。
 * 冒号后面不是字母数字（比如「柜号：七号柜」）走 core 那个函数，抹到标点为止。没有冒号又不是字母数字的（「柜号已隐藏」）不动。
 */
const LABELED_CONTAINER_NOS = /柜号\s*[:：]?\s*[A-Za-z0-9][A-Za-z0-9._\-/]*(?:[\s、，,/／和及]+[A-Za-z0-9][A-Za-z0-9._\-/]*)*/g;

export function maskHandwrittenContainerNos(text: string): string {
  return maskLabeledContainerNo(text.replace(LABELED_CONTAINER_NOS, "柜号（不对外显示）"));
}

export interface TrackLogSource {
  toStatus: string;
  remark: string | null;
  nextStop: string | null;
  changedAt: Date;
}

/**
 * 轨迹一条。备注和下一站都是员工随手写的：柜号、系统拼的「管理员」一起抹（containerNos 见 core/container-nos.ts）。
 * 先抹「柜号：XXX」这种手写（见 maskHandwrittenContainerNos）。
 */
export function mapTrackLog(log: TrackLogSource, containerNos: string[]) {
  return {
    at: log.changedAt.toISOString(),
    status: log.toStatus,
    statusZh: waybillStatusZh(log.toStatus),
    remark: remarkForAgent(maskHandwrittenContainerNos(log.remark ?? ""), containerNos),
    nextStop: remarkForAgent(maskHandwrittenContainerNos(log.nextStop ?? ""), containerNos),
  };
}

export function mapTrackChild(child: { trackingNo: string; currentStatus: string }) {
  return {
    trackingNo: child.trackingNo,
    currentStatus: child.currentStatus,
    statusZh: waybillStatusZh(child.currentStatus),
  };
}
