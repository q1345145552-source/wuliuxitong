/**
 * 到货通知弹窗的草稿（2026-10-16 从 ArrivalNoticesView.tsx 挪出来：组件带 JSX，测试要直接调这几个函数）。
 */
import { noticeProductsOf, type ArrivalNotice, type ArrivalNoticeDraft, type ConvertedNoticeDetail, type DraftProduct } from "../../services/arrival-notice-api";
import { CARGO_TYPES, type CargoType } from "../../../../../packages/shared-types/cargo-type";

/** 认不出来的值（含 null = 普货）一律按普货 */
export function cargoTypeOf(v: string | null | undefined): CargoType {
  return (CARGO_TYPES as readonly string[]).includes(v ?? "") ? (v as CargoType) : "normal";
}

/** 产品行的 React key（只在页面里用，draftToBody 会去掉） */
let productKeySeq = 0;
export function emptyProduct(): DraftProduct {
  productKeySeq += 1;
  return {
    key: `p${productKeySeq}`, itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "",
    productQuantity: "", weightKg: "", domesticTrackingNo: "", cargoType: "normal",
  };
}

export function draftOf(n: ArrivalNotice): ArrivalNoticeDraft {
  const s = (v: string | number | null) => (v === null || v === undefined ? "" : String(v));
  // 新后端给 products；老后端没给、平铺的有值就拼成一款（noticeProductsOf）；一款都没有就给一款空的
  const products = noticeProductsOf(n).map((p): DraftProduct => ({
    ...emptyProduct(),
    itemName: s(p.itemName),
    packageCount: s(p.packageCount),
    lengthCm: s(p.lengthCm),
    widthCm: s(p.widthCm),
    heightCm: s(p.heightCm),
    productQuantity: s(p.productQuantity),
    weightKg: s(p.weightKg),
    domesticTrackingNo: s(p.domesticTrackingNo),
    cargoType: cargoTypeOf(p.cargoType),
  }));
  return {
    clientId: n.clientId ?? "",
    trackingNo: s(n.trackingNo),
    weightKg: s(n.weightKg),
    volumeM3: s(n.volumeM3),
    transportMode: n.transportMode === "sea" || n.transportMode === "land" ? n.transportMode : "",
    warehouseId: n.warehouseId ?? "",
    arrivedAt: s(n.arrivedAt),
    remark: s(n.remark),
    products: products.length > 0 ? products : [emptyProduct()],
  };
}

/** 已转正式运单那种修改（2026-10-16）：草稿照常从 item 来（item 已经是运单现在的样子），每一款挂上对应的订单产品行 id */
export function convertedDraftOf(d: ConvertedNoticeDetail): ArrivalNoticeDraft {
  const draft = draftOf(d.item);
  return { ...draft, products: draft.products.map((p, i) => (d.productIds[i] ? { ...p, orderProductId: d.productIds[i] } : p)) };
}
