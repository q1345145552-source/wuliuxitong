/* ==========================================================================
   给财务系统的运单数据怎么裁（2026-11-04）
   --------------------------------------------------------------------------
   ⚠️ 全是纯函数，不碰数据库，scripts/test-finance-link-source.ts 直接测。
   ⚠️ 每个字段**逐个列出**，绝不写 `...row`（CLAUDE.md #31）：代理端那份行里还有柜号以外的东西
      （收件人姓名电话地址、订单 id、运单 id、订单号），只有列在这里的才出得去。
   ⚠️ 一律不给：柜号（batchNo / containerNo）、金额（receivableAmountCny）、收件人资料、员工和操作人、内部备注、内部 id、客户名字。
      clientName 这个字段名沿用两边约定，值是唛头（2026-11-04 老板选全部填唛头）。
   2026-11-07 代理利润第 1 轮：一行多给 orderedAt / cargoType / estimated / products 四个，老字段的名字和值一个不变
   （老版本的财务系统只认它认识的字段）。利润在财务系统那边算，这边照旧不给任何金额和价格。
   ========================================================================== */

import { CARGO_TYPES, type CargoType } from "../../../../../packages/shared-types/cargo-type";
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
  /** 已按 sortOrder 排好（loadShipmentRows 查的时候排的） */
  products: ReadonlyArray<WaybillSourceProduct>;
  currentStatus: string | null;
  partialAhead?: string | null;
  statusGroup: string;
  updatedAt: string;
  /** 订单的 createdAt，loadShipmentRows 已转成 ISO（UTC） */
  createdAt: string;
  approvalStatus: string;
  cargoType: string | null;
}

export interface WaybillSourceProduct {
  domesticTrackingNo?: string | null;
  cargoType?: string | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  packageCount?: number | null;
}

/** 产品行只给这两样：货型、客户报的方数；品名、国内单号、单箱重这轮不给 */
export interface FinanceWaybillProduct {
  cargoType: CargoType | null;
  declaredVolumeM3: number | null;
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
  orderedAt: string;
  cargoType: CargoType | null;
  estimated: boolean;
  products: FinanceWaybillProduct[];
}

/** 货型只认库里那四个值；认不出来给 null，绝不当普货（跟 shared-types/cargo-type.ts 一个规矩） */
export function cargoTypeOrNull(value: string | null | undefined): CargoType | null {
  return (CARGO_TYPES as readonly string[]).includes(value ?? "") ? (value as CargoType) : null;
}

/** 正数按它最短的十进制写法（String(x)，库里存的 16.9 就是 "16.9"）拆成「整数 ÷ 10^scale」，乘起来不带浮点误差 */
function toDecimalParts(x: number): { int: bigint; scale: number } {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(x));
  if (!m) throw new Error(`不是正数：${String(x)}`); // 调用前已挡掉非正数、NaN、无穷，走不到这里
  const frac = m[2] ?? "";
  let int = BigInt(m[1] + frac);
  let scale = frac.length - Number(m[3] ?? 0);
  if (scale < 0) { int *= 10n ** BigInt(-scale); scale = 0; }
  return { int, scale };
}

/**
 * 客户报的这一行方数：长 × 宽 × 高 × 件数 ÷ 1,000,000（跟 orders/routes.ts 算整票方数同一个公式），保留 6 位小数。
 * 只拿来按比例分整票方数：整票 volumeM3 落库是 3 位小数，各行加起来不一定正好等于它，别拿这个加总当整票。
 * 四样里有一样没填或不大于 0 就给 null，不当 0。
 * 6 位小数 = 整立方厘米：按十进制精确乘、四舍五入到整立方厘米再除。不能直接用浮点乘 ——
 * 10 × 1.5 × 4.1 应是 61.5 立方厘米，浮点乘出来是 61.499999…，会少舍 1 立方厘米（11-07 Codex 审查）。
 */
export function declaredVolumeM3(p: WaybillSourceProduct): number | null {
  const dims = [p.lengthCm, p.widthCm, p.heightCm, p.packageCount];
  if (!dims.every((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0)) return null;
  const parts = (dims as number[]).map(toDecimalParts);
  const num = parts.reduce((acc, d) => acc * d.int, 1n);
  const den = 10n ** BigInt(parts.reduce((acc, d) => acc + d.scale, 0));
  const cm3 = (num * 2n + den) / (den * 2n); // 正数的四舍五入（.5 进位）
  // 先拼成「整数.6 位」的十进制再转数字：整个 cm3 先转 Number 的话，超过 2^53 会先丢低位、再除一次又舍一次（第 2 轮审查）
  return Number(`${cm3 / 1_000_000n}.${(cm3 % 1_000_000n).toString().padStart(6, "0")}`);
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
    orderedAt: row.createdAt,
    cargoType: cargoTypeOrNull(row.cargoType),
    // 客户报的预报单、仓库还没确认收货：方数是客户报的，财务那边标「预估」
    estimated: row.approvalStatus === "shipped",
    // 没有产品行的老单给空数组，不补一行
    products: row.products.map((p) => ({ cargoType: cargoTypeOrNull(p.cargoType), declaredVolumeM3: declaredVolumeM3(p) })),
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
