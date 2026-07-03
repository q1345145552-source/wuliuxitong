import type { ShipmentItem } from "../../services/business-api";
import type { RepairStaffShipmentOrderLinksResult } from "../../services/business-api";
import type { PrealertEditDraft, ShipmentOrderEditDraft } from "./types";

/** 与后端 STATUS_FLOW 完全一致。 */
export const SHIPMENT_STATUS_FLOW = [
  "created",
  "loaded",
  "delayDeparted",
  "departed",
  "arrivedPort",
  "customsTH",
  "customsCleared",
  "inWarehouseTH",
  "outForDelivery",
  "delivered",
] as const;

export const SHIPMENT_EXCEPTION_STATUSES = new Set(["exception", "returned", "cancelled"]);

/**
 * 运单系统状态转中文（列表展示）。
 */
export function shipmentStatusZh(status: string | undefined): string {
  if (!status) return "—";
  const value = status.toLowerCase();
  const map: Record<string, string> = {
    created: "已创建",
    pickedup: "已揽收",
    inwarehousecn: "国内仓已收货",
    receivedcn: "国内仓已收货",
    customspending: "报关中",
    loaded: "已装柜",
    delaydeparted: "延迟开船",
    departed: "已开船",
    arrivedport: "已到港",
    intransit: "运输中",
    customsth: "清关中",
    customscleared: "清关已放行",
    inwarehouseth: "已到仓",
    warehouseth: "已到仓",
    outfordelivery: "派送中",
    delivered: "派送完成",
    exception: "异常",
    returned: "已退回",
    cancelled: "已取消",
  };
  return map[value] ?? (value || "未知");
}

/**
 * 仓库 ID 转中文仓名。
 */
export function warehouseLabelFromId(warehouseId: string | undefined): string {
  if (!warehouseId) return "—";
  const map: Record<string, string> = {
    wh_yiwu_01: "义乌仓",
    wh_guangzhou_01: "广州仓",
    wh_dongguan_01: "东莞仓",
    wh_shenzhen_01: "深圳仓",
  };
  return map[warehouseId] ?? warehouseId;
}

/**
 * 运输方式展示。
 */
export function transportModeLabel(mode: string | undefined): string {
  if (mode === "sea") return "海运";
  if (mode === "land") return "陆运";
  return mode ?? "—";
}

/**
 * 截断过长文本。
 */
export function truncateText(s: string | undefined, max: number): string {
  if (!s?.trim()) return "—";
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * 数字列格式化。
 */
export function formatMetric(n: number | undefined | null, digits = 3): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

/**
 * 根据长宽高（厘米）计算体积（立方米）：长×宽×高÷1,000,000。
 */
export function volumeM3FromDimensionsCm(lengthCm: number, widthCm: number, heightCm: number): number {
  return (lengthCm * widthCm * heightCm) / 1_000_000;
}

/**
 * 时间格式化。
 */
export function formatDateTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * 将体积（立方米）格式化为字符串，便于提交表单。
 */
export function formatVolumeM3String(m3: number): string {
  if (!Number.isFinite(m3) || m3 <= 0) return "";
  return String(Number(m3.toFixed(6)));
}

export function shipmentShipDateToLocalInput(shipDate: string | undefined): string {
  if (!shipDate?.trim()) return "";
  const s = shipDate.trim();
  const datePart = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return "";
  if (s.length >= 16 && (s.includes("T") || s.includes(" "))) {
    const sep = s.includes("T") ? "T" : " ";
    const rest = sep === "T" ? s.slice(11) : s.slice(11);
    const hm = rest.slice(0, 5);
    if (/^\d{2}:\d{2}$/.test(hm)) return `${datePart}T${hm}`;
  }
  return `${datePart}T12:00`;
}

/**
 * 计算运单状态下拉可选目标（与后端 canTransit 规则一致）。
 */
export function getValidShipmentStatusTargets(fromStatus: string): string[] {
  const from = fromStatus?.trim() || "created";
  const out = new Set<string>();
  out.add(from);
  if (SHIPMENT_EXCEPTION_STATUSES.has(from)) {
    SHIPMENT_EXCEPTION_STATUSES.forEach((s) => out.add(s));
    return Array.from(out);
  }
  const fromIdx = SHIPMENT_STATUS_FLOW.indexOf(from as (typeof SHIPMENT_STATUS_FLOW)[number]);
  if (fromIdx >= 0 && fromIdx + 1 < SHIPMENT_STATUS_FLOW.length) {
    out.add(SHIPMENT_STATUS_FLOW[fromIdx + 1]!);
  }
  SHIPMENT_EXCEPTION_STATUSES.forEach((s) => out.add(s));
  return Array.from(out);
}

/**
 * 将「修复关联」接口结果转为用户可见的提示文案。
 */
export function formatRepairShipmentOrderLinkToast(result: RepairStaffShipmentOrderLinksResult): string {
  if (result.repairedCount > 0) {
    return result.repairedCount === 1
      ? "已补建订单并关联该运单，可保存订单信息"
      : `已补建订单并关联 ${result.repairedCount} 条运单`;
  }
  const first = result.skipped[0];
  if (!first) return "当前没有需要修复的运单";
  if (first.reason === "already_linked") return "该运单已有关联订单";
  if (first.reason === "shipment_not_found") return "未找到运单或无权访问";
  if (first.reason === "no_company_user") return "公司下无可用用户，无法补建订单";
  if (first.reason.startsWith("insert_failed:")) return `补建订单失败：${first.reason.slice("insert_failed:".length)}`;
  return `未能修复：${first.reason}`;
}

/**
 * 由运单行构造订单详情编辑草稿。
 */
export function buildShipmentOrderEditDraft(item: ShipmentItem): ShipmentOrderEditDraft {
  return {
    trackingNo: item.trackingNo ?? "",
    warehouseId: item.warehouseId ?? "wh_yiwu_01",
    batchNo: item.batchNo ?? "",
    itemName: item.itemName ?? "",
    domesticTrackingNo: item.domesticTrackingNo ?? "",
    productQuantity: item.productQuantity != null ? String(item.productQuantity) : "",
    packageCount: item.packageCount != null ? String(item.packageCount) : "",
    packageUnit: item.packageUnit === "bag" ? "bag" : "box",
    weightKg: item.weightKg != null ? String(item.weightKg) : "",
    volumeM3: item.volumeM3 != null ? String(item.volumeM3) : "",
    orderCreatedDate: item.arrivedAt ? item.arrivedAt.slice(0, 10) : "",
    transportMode: item.transportMode === "land" ? "land" : "sea",
    shipLocal: shipmentShipDateToLocalInput(item.shipDate),
    receiverAddressTh: item.receiverAddressTh ?? "",
    containerNo: item.containerNo ?? "",
    receivableAmountCny: item.receivableAmountCny != null ? String(item.receivableAmountCny) : "",
    receivableCurrency: item.receivableCurrency === "THB" ? "THB" : "CNY",
    paymentStatus: item.paymentStatus === "paid" ? "paid" : "unpaid",
    destinationCountry: "泰国",
    customsDeclaration: "none",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildPrealertDraft(item: any): PrealertEditDraft {
  const firstProduct = item.products?.[0];
  return {
    warehouseId: item.warehouseId ?? "",
    itemName: item.itemName ?? "",
    packageCount: item.packageCount ?? 0,
    packageUnit: (item.packageUnit as "bag" | "box") ?? "box",
    productQuantity: item.productQuantity ?? 0,
    weightKg: item.weightKg ?? 0,
    volumeM3: item.volumeM3 ?? 0,
    receivableAmountCny: item.receivableAmountCny ?? 0,
    receivableCurrency: (item.receivableCurrency as "CNY" | "THB") ?? "CNY",
    domesticTrackingNo: (firstProduct?.domesticTrackingNo || item.domesticTrackingNo) ?? "",
    transportMode: (item.transportMode as "sea" | "land") ?? "sea",
    shipDate: item.shipDate?.slice(0, 10) ?? "",
  };
}
