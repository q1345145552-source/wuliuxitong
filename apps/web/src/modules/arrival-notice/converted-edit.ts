/**
 * 超管在到货通知里改「已转正式运单」的那条（2026-10-16 老板「让超管在到货通知里也能改」）。
 *
 * 改的其实是那张运单：弹窗打开时读的是运单现在的样子（后端 converted-detail），保存走超管「运单管理」改单那一条路
 * （/admin/orders/update，同一套闸），所以这里要把弹窗里的草稿翻成那条路认的样子 —— 口径照超管端「运单管理」编辑弹窗
 * （apps/web/src/app/admin/page.tsx 的保存那段）：
 *   - 只发改过的项（没改的不发，后端就不动它，两个人改不同的项不会互相盖）；
 *   - 产品行动过就整份发，带上原来的行号 id（留着的改、没带的删、不带 id 的新加），同时发品名（第一款）、件数合计、
 *     产品数量合计（单箱数量 × 件数；一款都没填单箱数量、原来也没有就不发，别把老单的产品数量清成 0）；
 *     产品行上国内单号空着写「货拉拉」（同「创建订单」）；**订单那一格国内单号不跟着产品行改**
 *     （同运单管理：那一格只在它自己的框改了才发；原来我拿第一款的号去盖，会把超管单独填的号改掉 —— 2026-10-16 Codex / dsh 审查）；
 *   - 带上打开时订单的 updatedAt（expectedOrderUpdatedAt），后端锁住订单后核对，期间有人改过就不存；
 *   - 总重量 / 总体积按「运单管理」那一套裁决（decideEditTotals：每行尺寸 / 单箱重都填齐 → 按产品行算；没填齐 → 以手填的为准），
 *     算出来跟运单原来的不一样、或者产品行动过，就发。到货通知弹窗平时那套「有几行能算就按产品行算」这里不用 ——
 *     不然别人在「运单管理」手填的总数，打开这里存一下就被悄悄换掉。
 * 单独放一个文件：组件带 JSX，测试隔离加载不了；这里的函数测试直接调。
 */
import type { ArrivalNoticeDraft, DraftProduct } from "../../services/arrival-notice-api";
import { isBlankNoticeProduct, missingForFormalNotice } from "../../../../../packages/shared-types/arrival-notice-products";
import { decideEditTotals } from "../orders/edit-totals";

/** 订单产品行上「国内单号空着」的写法（同后端 orderValuesOf / 超管编辑弹窗） */
export const BLANK_DOMESTIC_PLACEHOLDER = "货拉拉";

export interface AdminOrderPatchProduct {
  id?: string;
  itemName: string;
  packageCount: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  productQuantity?: number;
  cargoType: string;
  domesticTrackingNo: string;
  weightKg?: number;
}

/** 发给 /admin/orders/update 的那份（orderId 用运单 id，后端认运单 id 找订单） */
export interface AdminOrderPatch {
  orderId: string;
  clientId?: string;
  trackingNo?: string;
  warehouseId?: string;
  transportMode?: "sea" | "land";
  shipDate?: string;
  itemName?: string;
  packageCount?: number;
  productQuantity?: number;
  weightKg?: number | null;
  volumeM3?: number | null;
  products?: AdminOrderPatchProduct[];
  expectedOrderUpdatedAt?: string;
}

const t = (s: string | undefined | null) => (s ?? "").trim();
const POSITIVE_INT = /^[1-9]\d*$/;
const NON_NEG_NUMBER = /^\d+(\.\d+)?$/;

function filledProducts(d: ArrivalNoticeDraft): DraftProduct[] {
  return d.products.filter((p) => !isBlankNoticeProduct(p));
}

/** 总重量 / 总体积最后存多少（同超管「运单管理」编辑弹窗），notes 是给人看的说明（哪边生效） */
export function convertedTotals(d: ArrivalNoticeDraft): { finalWeight: number | null; finalVolume: number | null; notes: string[] } {
  return decideEditTotals(filledProducts(d), d.weightKg, d.volumeM3);
}

/**
 * 保存前先查一遍（后端也查，这里是为了不把乱填的数字发出去 —— 「abc」翻成数字是 NaN，JSON 里变成 null，后端会当成「没填」）。
 * 返回给人看的一句话；没问题返回 null。
 */
export function convertedDraftIssue(d: ArrivalNoticeDraft): string | null {
  const ps = filledProducts(d);
  // 手填的总数先查格式（填了乱码的话裁决会算出 NaN）
  if (t(d.weightKg) && !NON_NEG_NUMBER.test(t(d.weightKg))) return "总重量要填数字";
  if (t(d.volumeM3) && !NON_NEG_NUMBER.test(t(d.volumeM3))) return "总体积要填数字";
  const totals = convertedTotals(d);
  const missing = missingForFormalNotice({
    trackingNo: t(d.trackingNo), clientId: t(d.clientId), warehouseId: d.warehouseId, transportMode: d.transportMode,
    arrivedAt: t(d.arrivedAt),
    weightKg: totals.finalWeight === null ? "" : String(totals.finalWeight),
    volumeM3: totals.finalVolume === null ? "" : String(totals.finalVolume),
    products: ps.map((p) => ({ itemName: t(p.itemName), packageCount: t(p.packageCount), productQuantity: t(p.productQuantity) })),
  });
  if (missing.length > 0) return `这票已经是正式运单了，下面这几项不能空：${missing.join("、")}`;
  const label = (i: number, what: string) => (ps.length > 1 ? `第 ${i + 1} 款的${what}` : what);
  for (let i = 0; i < ps.length; i += 1) {
    const p = ps[i];
    if (!POSITIVE_INT.test(t(p.packageCount))) return `${label(i, "件数")}要填正整数`;
    if (t(p.productQuantity) && !POSITIVE_INT.test(t(p.productQuantity))) return `${label(i, "单箱数量")}要填正整数`;
    for (const [k, what] of [["lengthCm", "长"], ["widthCm", "宽"], ["heightCm", "高"], ["weightKg", "单箱重"]] as const) {
      if (t(p[k]) && !NON_NEG_NUMBER.test(t(p[k]))) return `${label(i, what)}要填数字`;
    }
  }
  return null;
}

/** 产品行比较用的样子（含原来的行号 id；空白的款不算） */
function productsKey(d: ArrivalNoticeDraft): string {
  return JSON.stringify(filledProducts(d).map((p) => [
    p.orderProductId ?? null, t(p.itemName), t(p.packageCount), t(p.lengthCm), t(p.widthCm), t(p.heightCm),
    t(p.productQuantity), t(p.weightKg), p.cargoType, t(p.domesticTrackingNo),
  ]));
}

/**
 * 两份草稿是不是同一份资料（备注除外 —— 备注是到货通知自己的，不进运单）。
 * 保存前拿「打开弹窗时看到的」跟「运单现在的」比：不一样说明这期间有人在「运单管理」或这里改过，不存。
 */
export function sameConvertedDraft(a: ArrivalNoticeDraft, b: ArrivalNoticeDraft): boolean {
  return t(a.clientId) === t(b.clientId)
    && t(a.trackingNo) === t(b.trackingNo)
    && t(a.weightKg) === t(b.weightKg)
    && t(a.volumeM3) === t(b.volumeM3)
    && a.transportMode === b.transportMode
    && a.warehouseId === b.warehouseId
    && t(a.arrivedAt) === t(b.arrivedAt)
    && productsKey(a) === productsKey(b);
}

/** 备注改没改（备注是到货通知自己的，单独存） */
export function remarkChanged(base: ArrivalNoticeDraft, draft: ArrivalNoticeDraft): boolean {
  return t(base.remark) !== t(draft.remark);
}

/**
 * 草稿 → 超管改单那条路的请求（只放改过的项）。changed=false 表示运单这边什么都没改（可能只改了备注）。
 * expectedOrderUpdatedAt：保存前重读到的订单 updatedAt，有改动时带上，后端锁里核对。
 */
export function buildAdminOrderPatch(shipmentId: string, base: ArrivalNoticeDraft, draft: ArrivalNoticeDraft, expectedOrderUpdatedAt?: string): { patch: AdminOrderPatch; changed: boolean } {
  const patch: AdminOrderPatch = { orderId: shipmentId };
  if (t(draft.clientId) !== t(base.clientId)) patch.clientId = t(draft.clientId);
  if (t(draft.trackingNo) !== t(base.trackingNo)) patch.trackingNo = t(draft.trackingNo);
  if (draft.warehouseId !== base.warehouseId) patch.warehouseId = draft.warehouseId;
  if (draft.transportMode !== base.transportMode && draft.transportMode) patch.transportMode = draft.transportMode;
  if (t(draft.arrivedAt) !== t(base.arrivedAt)) patch.shipDate = t(draft.arrivedAt);

  const productsChanged = productsKey(draft) !== productsKey(base);
  if (productsChanged) {
    const ps = filledProducts(draft);
    const optional = (s: string) => (t(s) === "" ? undefined : Number(t(s)));
    patch.products = ps.map((p) => ({
      ...(p.orderProductId ? { id: p.orderProductId } : {}),
      itemName: t(p.itemName),
      packageCount: Number(t(p.packageCount)),
      lengthCm: optional(p.lengthCm),
      widthCm: optional(p.widthCm),
      heightCm: optional(p.heightCm),
      productQuantity: optional(p.productQuantity),
      cargoType: p.cargoType || "normal",
      domesticTrackingNo: t(p.domesticTrackingNo) || BLANK_DOMESTIC_PLACEHOLDER,
      weightKg: optional(p.weightKg),
    }));
    patch.itemName = t(ps[0]?.itemName);
    patch.packageCount = ps.reduce((s, p) => s + Number(t(p.packageCount)), 0);
    /* 「单箱数量」是每箱几个，合计要乘件数（同超管编辑弹窗，2026-08-28 那条）。
       一款都没填、打开时也一款都没有：不发（没有产品行的老单订单上可能有产品数量，发 0 会把它清掉 —— Codex 审查） */
    const anyQty = (d: ArrivalNoticeDraft) => filledProducts(d).some((p) => t(p.productQuantity) !== "");
    if (anyQty(draft) || anyQty(base)) {
      patch.productQuantity = ps.reduce((s, p) => s + (Number(t(p.productQuantity)) || 0) * Number(t(p.packageCount)), 0);
    }
  }
  // 总数：按「运单管理」的裁决算出最后存多少，跟运单原来的比（重量到分、体积到 0.001 方，同库里的小数位）
  const { finalWeight, finalVolume } = convertedTotals(draft);
  const asNum = (s: string) => (t(s) === "" ? null : Number(t(s)));
  const round = (v: number | null, digits: number) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
  if (productsChanged || round(finalWeight, 2) !== round(asNum(base.weightKg), 2)) patch.weightKg = finalWeight;
  if (productsChanged || round(finalVolume, 3) !== round(asNum(base.volumeM3), 3)) patch.volumeM3 = finalVolume;
  const changed = Object.keys(patch).length > 1;
  if (changed && expectedOrderUpdatedAt) patch.expectedOrderUpdatedAt = expectedOrderUpdatedAt;
  return { patch, changed };
}
