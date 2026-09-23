/**
 * 运单筛选条件的**唯一一份判断逻辑**（2026-09-23）。
 *
 * 老板 2026-09-23：导出不能只让选日期，「还要拥有那些搜索、筛选应该有的条件」。
 * 做法是给导出弹窗一套自己的条件（打开时把列表上已经筛好的带进去，可以改）。
 * 那样就有两个地方要按同一套条件筛数据：**列表**和**导出**。
 * 所以把判断抽到这里，两边都调它 —— 免得以后改了列表忘了改导出，两边口径悄悄跑偏（CLAUDE.md #20）。
 *
 * ⚠️ 管理员端和员工端的数据形状不一样（到仓日期、国内单号、加收金额三处口径不同），
 *    所以「怎么把一行数据摊成可比的字符串」放在各自的 `*FilterRow` 里，判断本身共用一份。
 *    抽这份时是照着两个页面原来的写法逐条搬的，没有改判断口径 —— 改这里等于同时改列表和导出。
 *    唯一统一掉的小差别：条件里前后的空格一律先去掉再比（员工端本来就去，管理员端原来不去）。
 */
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";
import { shipmentStatusZh } from "./shipment-status";

/** 筛选条件（跟 ShipmentSearch 那个表单一一对应，全是字符串，空串 = 不限制） */
export interface ShipmentFilterValue {
  trackingNo: string;
  domesticTrackingNo: string;
  /** 「唛头 / 客户名」那一格：唛头和名字都能搜 */
  clientName: string;
  warehouseId: string;
  batchNo: string;
  itemName: string;
  packageCount: string;
  productQuantity: string;
  weightKg: string;
  volumeM3: string;
  arrivedAtFrom: string;
  arrivedAtTo: string;
  logisticsStatus: string;
  containerNo: string;
  transportMode: string;
  receiverAddress: string;
  shipDateFrom: string;
  shipDateTo: string;
  receivableAmount: string;
  statusRaw: string;
}

/** 一行数据摊平成可比的字符串（大小写不敏感的几项这里已经转成小写） */
export interface ShipmentFilterRow {
  trackingNo: string;
  domesticTrackingNo: string;
  clientName: string;
  warehouseId: string;
  batchNo: string;
  itemName: string;
  packageCount: string;
  productQuantity: string;
  weightKg: string;
  volumeM3: string;
  /** 「到仓日期」那一格比的值（管理员端没有到仓日期时退到建单日期，跟原来一样） */
  arrivedAt: string;
  /** 中文状态名（下拉里选的就是中文） */
  logisticsStatus: string;
  containerNo: string;
  transportMode: string;
  receiverAddress: string;
  /** 「发货日期」那一格比的值：库里就是 ship_date，导出的「到仓日期」列用的也是它 */
  shipDate: string;
  receivableAmount: string;
  statusRaw: string;
}

export const EMPTY_SHIPMENT_FILTER: ShipmentFilterValue = {
  trackingNo: "", domesticTrackingNo: "", clientName: "", warehouseId: "", batchNo: "",
  itemName: "", packageCount: "", productQuantity: "", weightKg: "", volumeM3: "",
  arrivedAtFrom: "", arrivedAtTo: "", logisticsStatus: "", containerNo: "", transportMode: "",
  receiverAddress: "", shipDateFrom: "", shipDateTo: "", receivableAmount: "", statusRaw: "",
};

const lower = (value: unknown): string => String(value ?? "").trim().toLowerCase();
const text = (value: unknown): string => String(value ?? "").trim();

/** 条件里真正填了东西的有几项（弹窗上「已设 N 个条件」用它） */
export function countShipmentFilters(value: ShipmentFilterValue): number {
  return Object.values(value).filter((v) => String(v ?? "").trim() !== "").length;
}

/** 日期范围填反了（起始晚于截止）—— 两对日期任意一对反了都算 */
export function shipmentFilterDateInvalid(value: ShipmentFilterValue): boolean {
  const bad = (from: string, to: string) => Boolean(from && to && from > to);
  return bad(value.arrivedAtFrom, value.arrivedAtTo) || bad(value.shipDateFrom, value.shipDateTo);
}

/**
 * 一行数据符不符合筛选条件。**判断顺序和口径跟两个页面原来的写法一致**：
 * 文本类是「包含」（不分大小写）、仓库和状态和运输方式是「完全相等」、日期是字符串比大小。
 */
export function matchesShipmentFilter(row: ShipmentFilterRow, s: ShipmentFilterValue): boolean {
  const has = (v: string) => v.trim() !== "";
  if (has(s.trackingNo) && !row.trackingNo.includes(lower(s.trackingNo))) return false;
  if (has(s.domesticTrackingNo) && !row.domesticTrackingNo.includes(lower(s.domesticTrackingNo))) return false;
  if (has(s.clientName) && !row.clientName.includes(lower(s.clientName))) return false;
  if (has(s.warehouseId) && row.warehouseId !== lower(s.warehouseId)) return false;
  if (has(s.batchNo) && !row.batchNo.includes(lower(s.batchNo))) return false;
  if (has(s.itemName) && !row.itemName.includes(lower(s.itemName))) return false;
  if (has(s.packageCount) && !row.packageCount.includes(text(s.packageCount))) return false;
  if (has(s.productQuantity) && !row.productQuantity.includes(text(s.productQuantity))) return false;
  if (has(s.weightKg) && !row.weightKg.includes(text(s.weightKg))) return false;
  if (has(s.volumeM3) && !row.volumeM3.includes(text(s.volumeM3))) return false;
  if (has(s.arrivedAtFrom) && row.arrivedAt < text(s.arrivedAtFrom)) return false;
  if (has(s.arrivedAtTo) && row.arrivedAt > text(s.arrivedAtTo)) return false;
  if (has(s.logisticsStatus) && row.logisticsStatus !== text(s.logisticsStatus)) return false;
  if (has(s.containerNo) && !row.containerNo.includes(lower(s.containerNo))) return false;
  if (has(s.transportMode) && row.transportMode !== text(s.transportMode)) return false;
  if (has(s.receiverAddress) && !row.receiverAddress.includes(lower(s.receiverAddress))) return false;
  if (has(s.shipDateFrom) && row.shipDate < text(s.shipDateFrom)) return false;
  if (has(s.shipDateTo) && row.shipDate > text(s.shipDateTo)) return false;
  if (has(s.receivableAmount) && !row.receivableAmount.includes(text(s.receivableAmount))) return false;
  if (has(s.statusRaw) && !row.statusRaw.includes(lower(s.statusRaw))) return false;
  return true;
}

type ProductLike = { itemName?: string | null; sortOrder?: number | null; domesticTrackingNo?: string | null };

/** 管理员端「运单管理」一行（/admin/orders 的形状） */
export function adminOrderFilterRow(item: {
  trackingNo?: string | null; domesticTrackingNo?: string | null; clientName?: string | null; clientId?: string | null;
  warehouseId?: string | null; batchNo?: string | null; itemName?: string | null; products?: ProductLike[] | null;
  packageCount?: number | string | null; productQuantity?: number | string | null;
  weightKg?: number | string | null; volumeM3?: number | string | null;
  shipDate?: string | null; createdAt?: string | null; currentStatus?: string | null;
  containerNo?: string | null; transportMode?: string | null; receiverAddressTh?: string | null;
  receivableAmountCny?: number | null;
}): ShipmentFilterRow {
  return {
    trackingNo: lower(item.trackingNo),
    domesticTrackingNo: lower(item.domesticTrackingNo),
    clientName: `${item.clientName ?? ""} ${item.clientId ?? ""}`.toLowerCase(),
    warehouseId: lower(item.warehouseId),
    batchNo: lower(item.batchNo),
    // 按品名搜要认**全部产品名**（2026-09-11）：itemName 只存了第一个产品名
    itemName: `${productNamesLabel(item.products ?? undefined, item.itemName ?? "")} ${item.itemName ?? ""}`.toLowerCase(),
    packageCount: item.packageCount == null ? "" : String(item.packageCount),
    productQuantity: item.productQuantity == null ? "" : String(item.productQuantity),
    weightKg: item.weightKg == null ? "" : String(item.weightKg),
    volumeM3: item.volumeM3 == null ? "" : String(item.volumeM3),
    // 管理员端原来的写法：没有到仓日期就退到建单日期
    arrivedAt: item.shipDate ?? item.createdAt?.slice(0, 10) ?? "",
    logisticsStatus: shipmentStatusZh(item.currentStatus ?? undefined),
    containerNo: lower(item.containerNo),
    transportMode: text(item.transportMode),
    receiverAddress: lower(item.receiverAddressTh),
    shipDate: (item.shipDate ?? "").slice(0, 10),
    receivableAmount: item.receivableAmountCny != null ? String(item.receivableAmountCny) : "",
    statusRaw: lower(item.currentStatus),
  };
}

/** 员工端「运单管理」一行（/staff/shipments 的形状） */
export function staffShipmentFilterRow(item: {
  trackingNo?: string | null; domesticTrackingNo?: string | null; clientName?: string | null; clientId?: string | null;
  warehouseId?: string | null; batchNo?: string | null; itemName?: string | null; products?: ProductLike[] | null;
  packageCount?: number | string | null; productQuantity?: number | string | null;
  weightKg?: number | string | null; volumeM3?: number | string | null;
  arrivedAt?: string | null; shipDate?: string | null; currentStatus?: string | null;
  containerNo?: string | null; transportMode?: string | null; receiverAddressTh?: string | null;
  receivableAmountCny?: number | null;
}): ShipmentFilterRow {
  return {
    trackingNo: lower(item.trackingNo),
    // 员工端原来的写法：产品行上的国内单号也要能搜到
    domesticTrackingNo: (
      (item.domesticTrackingNo ?? "") + (item.products?.map((p) => p.domesticTrackingNo ?? "").join(" ") ?? "")
    ).toLowerCase(),
    clientName: `${item.clientName ?? ""} ${item.clientId ?? ""}`.toLowerCase(),
    warehouseId: lower(item.warehouseId),
    batchNo: lower(item.batchNo),
    itemName: `${productNamesLabel(item.products ?? undefined, item.itemName ?? "")} ${item.itemName ?? ""}`.toLowerCase(),
    packageCount: item.packageCount == null ? "" : String(item.packageCount),
    productQuantity: item.productQuantity == null ? "" : String(item.productQuantity),
    weightKg: item.weightKg == null ? "" : String(item.weightKg),
    volumeM3: item.volumeM3 == null ? "" : String(item.volumeM3),
    arrivedAt: item.arrivedAt ? item.arrivedAt.slice(0, 10) : "",
    logisticsStatus: shipmentStatusZh(item.currentStatus ?? undefined),
    containerNo: lower(item.containerNo),
    transportMode: text(item.transportMode),
    receiverAddress: lower(item.receiverAddressTh),
    shipDate: (item.shipDate ?? "").trim().slice(0, 10),
    // 员工端原来的写法：加收金额按两位小数比（列表里显示的就是两位）
    receivableAmount: item.receivableAmountCny == null ? "" : item.receivableAmountCny.toFixed(2),
    statusRaw: lower(item.currentStatus),
  };
}

/**
 * 客户端「我的运单查询」一行（/client/orders 的形状）。
 * 客户能看的字段少，另外两点不一样：
 *   · 状态名用客户那套说法（`CLIENT_STATUS_ZH_OVERRIDES`，比如「已签收」在客户端叫别的）；
 *   · 客户列表原来那组日期筛的是**建单日期**，所以这里 `arrivedAt` 放建单日期、`shipDate` 放到仓日期，
 *     弹窗里两组日期就各管各的（老板 2026-09-23 定：导出按到仓日期，建单日期放「更多条件」）。
 */
export function clientOrderFilterRow(
  item: {
    trackingNo?: string | null; domesticTrackingNo?: string | null; itemName?: string | null; products?: ProductLike[] | null;
    warehouseId?: string | null; packageCount?: number | string | null; productQuantity?: number | string | null;
    weightKg?: number | string | null; volumeM3?: number | string | null;
    shipDate?: string | null; createdAt?: string | null; currentStatus?: string | null;
    transportMode?: string | null;
  },
  statusOverrides?: Record<string, string>,
): ShipmentFilterRow {
  return {
    trackingNo: lower(item.trackingNo),
    // 客户列表原来就连产品行上的国内单号一起搜
    domesticTrackingNo: (
      (item.domesticTrackingNo ?? "") + (item.products?.map((p) => p.domesticTrackingNo ?? "").join(" ") ?? "")
    ).toLowerCase(),
    clientName: "",
    warehouseId: lower(item.warehouseId),
    batchNo: "",
    itemName: `${productNamesLabel(item.products ?? undefined, item.itemName ?? "")} ${item.itemName ?? ""}`.toLowerCase(),
    packageCount: item.packageCount == null ? "" : String(item.packageCount),
    productQuantity: item.productQuantity == null ? "" : String(item.productQuantity),
    weightKg: item.weightKg == null ? "" : String(item.weightKg),
    volumeM3: item.volumeM3 == null ? "" : String(item.volumeM3),
    arrivedAt: (item.createdAt ?? "").slice(0, 10),
    logisticsStatus: shipmentStatusZh(item.currentStatus ?? undefined, statusOverrides),
    containerNo: "",
    transportMode: text(item.transportMode),
    receiverAddress: "",
    shipDate: (item.shipDate ?? "").slice(0, 10),
    receivableAmount: "",
    statusRaw: lower(item.currentStatus),
  };
}
