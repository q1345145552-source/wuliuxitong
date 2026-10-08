/**
 * 到货通知「转正式运单还缺哪几项」（2026-10-06）—— 页面上先提示一句，真正说了算的是后端
 * （apps/api/src/modules/arrival-notices/routes.ts 的 missingForTarget）。
 *
 * 2026-10-09 多款：规则挪进前后端共用的 packages/shared-types/arrival-notice-products.ts 的 missingForFormalNotice，
 * 这里只转调（两边各写一份就会对不上）。缺的是第几款会点名：「第2款件数」。
 * 入参就是接口回来的那条到货通知；老后端没回 products 时用平铺的品名 / 件数拼成一款（noticeProductsOf）。
 */
import { missingForFormalNotice } from "../../../../../packages/shared-types/arrival-notice-products";
import { noticeProductsOf, type ArrivalNotice } from "../../services/arrival-notice-api";

export type MissingInput = Pick<
  ArrivalNotice,
  "trackingNo" | "clientId" | "warehouseId" | "transportMode" | "arrivedAt" | "weightKg" | "volumeM3"
  | "products" | "itemName" | "packageCount" | "domesticTrackingNo" | "cargoType"
>;

export function missingForFormal(n: MissingInput): string[] {
  return missingForFormalNotice({
    trackingNo: n.trackingNo,
    clientId: n.clientId,
    warehouseId: n.warehouseId,
    transportMode: n.transportMode,
    arrivedAt: n.arrivedAt,
    weightKg: n.weightKg,
    volumeM3: n.volumeM3,
    products: noticeProductsOf(n),
  });
}
