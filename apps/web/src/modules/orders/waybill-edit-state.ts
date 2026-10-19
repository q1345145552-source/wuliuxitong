/**
 * 「编辑运单」弹窗的纯逻辑那一半（2026-10-20 从 WaybillEditDialog.tsx 拆出来）：编辑框读哪几项、打开时怎么建表单 / 产品行 / 「打开时的样子」。
 * 拆开的原因：连库测试要拿员工列表那一条真跑 waybillEditStateOf，GitHub 自动检查的连库那组没装网页那边的 react，
 * 引带页面的 .tsx 会报「Cannot find module 'react'」（dfe7a88 那次检查红在这）。这里只引类型，不引 react。
 */
import type { OrderProductImageItem, OrderProductItem } from "../../services/business-api";

/** 编辑框要读的那几项：超管列表（AdminOrderItem）和员工列表（ShipmentItem）一条都有，口径一样（都是父单那一行） */
export interface WaybillEditSource {
  id: string;
  orderId?: string;
  orderNo?: string | null;
  orderUpdatedAt?: string;
  clientId?: string;
  trackingNo?: string;
  batchNo?: string | null;
  warehouseId?: string;
  itemName?: string;
  transportMode?: string;
  domesticTrackingNo?: string | null;
  receiverAddressTh?: string;
  containerNo?: string;
  productQuantity?: number;
  packageCount?: number;
  packageUnit?: string;
  weightKg?: number | null;
  volumeM3?: number | null;
  totalWeightKg?: number | null;
  totalVolumeM3?: number | null;
  cargoType?: string;
  paymentStatus?: "paid" | "unpaid";
  shipDate?: string | null;
  remark?: string | null;
  products?: OrderProductItem[];
  productImages?: OrderProductImageItem[];
}

export type WaybillEditForm = {
  clientId: string;
  trackingNo: string;
  batchNo: string;
  warehouseId: string;
  itemName: string;
  transportMode: "sea" | "land";
  domesticTrackingNo: string;
  receiverAddressTh: string;
  containerNo: string;
  productQuantity: string;
  packageCount: string;
  packageUnit: "bag" | "box";
  weightKg: string;
  volumeM3: string;
  paymentStatus: "paid" | "unpaid";
  shipDate: string;
  cargoType: string;
  remark: string;
};

export type WaybillEditProduct = {
  /** 已有产品行的编号；新加的行为空，后端据此判断是改还是新增 */
  id?: string;
  itemName: string; packageCount: string; lengthCm: string; widthCm: string; heightCm: string; productQuantity: string; weightKg: string; cargoType: string; domesticTrackingNo: string;
};

/** 打开弹窗那一刻的原始数据，用于保存时算出「哪些项被改过」 */
/* orderUpdatedAt（2026-10-18 全系统审查第一档第 6 条）：打开弹窗时订单的版本。改了产品行 / 合计保存时带回去，
   这期间别人存过就 409 —— 产品行是整组发的（没带回来的行后端会删），拿旧弹窗存会把别人刚加的行删掉、改的盖回去 */
export type WaybillEditSnapshot = { form: Record<string, string>; productsJson: string; orderUpdatedAt?: string };

/** 打开弹窗：从列表那一行建表单、产品行和「打开时的样子」（原 admin/page.tsx 的 startEditOrder） */
export function waybillEditStateOf(order: WaybillEditSource): { form: WaybillEditForm; products: WaybillEditProduct[]; snapshot: WaybillEditSnapshot } {
  const form: WaybillEditForm = {
    clientId: order.clientId ?? "",
    trackingNo: order.trackingNo ?? "",
    batchNo: order.batchNo ?? "",
    warehouseId: order.warehouseId ?? "wh_yiwu_01",
    itemName: order.itemName ?? "",
    transportMode: order.transportMode === "land" ? "land" : "sea",
    domesticTrackingNo: order.domesticTrackingNo ?? "",
    receiverAddressTh: order.receiverAddressTh ?? "",
    containerNo: order.containerNo ?? "",
    productQuantity: String(order.productQuantity ?? 0),
    packageCount: String(order.packageCount ?? 0),
    packageUnit: order.packageUnit === "bag" ? "bag" : "box",
    // 拆过柜的单：列表接口的 weightKg/volumeM3 是父单**剩余量**，整票在 totalWeightKg/totalVolumeM3。
    // 编辑框必须填整票（后端按整票算，2026-09-28 审查修复 #1：原来预填剩余量，一保存订单总重就被改小）
    weightKg: (order.totalWeightKg ?? order.weightKg) == null ? "" : String(order.totalWeightKg ?? order.weightKg),
    volumeM3: (order.totalVolumeM3 ?? order.volumeM3) == null ? "" : String(order.totalVolumeM3 ?? order.volumeM3),
    cargoType: order.cargoType ?? "normal",
    paymentStatus: order.paymentStatus === "paid" ? "paid" : "unpaid",
    shipDate: order.shipDate ?? "",
    remark: order.remark ?? "",
  };
  const products: WaybillEditProduct[] = (order.products ?? []).map((p) => ({
    id: p.id,
    itemName: p.itemName ?? "",
    packageCount: String(p.packageCount ?? ""),
    lengthCm: p.lengthCm != null ? String(p.lengthCm) : "",
    widthCm: p.widthCm != null ? String(p.widthCm) : "",
    heightCm: p.heightCm != null ? String(p.heightCm) : "",
    productQuantity: p.productQuantity != null ? String(p.productQuantity) : "",
    weightKg: p.weightKg != null ? String(p.weightKg) : "",
    cargoType: p.cargoType ?? "normal",
    domesticTrackingNo: p.domesticTrackingNo ?? "货拉拉",
  }));
  return {
    form,
    products,
    // 记下打开弹窗那一刻的样子，保存时只把改动过的项发出去，避免把别人在这期间改的字段一起覆盖掉；
    // 产品行的快照直接用表单自己的格式，比对时不会因为格式差异误判
    snapshot: { form: { ...form } as Record<string, string>, productsJson: JSON.stringify(products), orderUpdatedAt: order.orderUpdatedAt },
  };
}
