/**
 * 「看转运单时的原样」（2026-10-19 老板选 B）：把转正式运单那一刻存下的到货通知，跟卡片现在的样子逐项比，
 * 不一样的标出来（「件数：原来 10 → 现在 12」）。纯逻辑，不碰页面，测试能直接跑。
 *
 * 「现在」= 打开弹窗时后端按这条到货通知现读的那一份（跟列表上的卡片同一个口径：转出去的运单还在时，
 * 后端已经把卡片对齐成运单现在的样子；运单号显示运单现在的号）。
 * 产品按顺序一款一款比（第 1 款比第 1 款），多出来 / 少了的款单独说。
 *
 * 比的是**每个字段规范化以后的值**，不是拼出来的那一行字（审查第 1 轮 Codex：两种不同的填法可能拼出同一行字，
 * 改了却显示「同左」）。规范化跟后端同步卡片时一个口径：空白 = 没填；国内单号「货拉拉」= 没填
 * （运单那边空号就写「货拉拉」，同步回卡片时当没填，后端 arrival-notices/routes.ts 的 BLANK_DOMESTIC_PLACEHOLDER）；
 * 货型认不出来 = 普货。
 * 显示：那一行照卡片的写法写**原来存的 / 现在的**（不规范化，跟卡片上看到的一样，审查第 2 轮 Codex）；
 * 改过的产品另外逐项列出改了哪几项（「件数：12 件 → 15 件」），拼出来的一行字恰好一样时也看得出改了啥（审查第 2 轮两家）。
 */
import { CARGO_TYPE_ZH } from "../../../../../packages/shared-types/cargo-type";
import { noticeProductsOf, type ArrivalNotice, type ArrivalNoticeProduct, type ArrivalNoticeSnapshotData } from "../../services/arrival-notice-api";
import { cargoTypeOf } from "./draft";
import { WAREHOUSE_ZH } from "./notice-text";

/** 运单产品行「国内单号空着」写的占位（同后端 BLANK_DOMESTIC_PLACEHOLDER）：比对和显示都当没填 */
export const BLANK_DOMESTIC_PLACEHOLDER = "货拉拉";

/** 卡片上一款怎么写：「灯具 × 12 件 · 敏感货 · 国内单号 SF123 · 60×40×30cm · 单箱 5kg · 每箱 10 个」，空的项不写 */
export function productLine(p: ArrivalNoticeProduct): string {
  const cargo = cargoTypeOf(p.cargoType);
  const dims = p.lengthCm !== null || p.widthCm !== null || p.heightCm !== null
    ? `${p.lengthCm ?? "?"}×${p.widthCm ?? "?"}×${p.heightCm ?? "?"}cm`
    : "";
  return [
    `${p.itemName || "品名未填"}${p.packageCount !== null ? ` × ${p.packageCount} 件` : ""}`,
    p.packageCount === null ? "件数未填" : "",
    cargo !== "normal" ? CARGO_TYPE_ZH[cargo] : "",
    p.domesticTrackingNo ? `国内单号 ${p.domesticTrackingNo}` : "",
    dims,
    p.weightKg !== null ? `单箱 ${p.weightKg}kg` : "",
    p.productQuantity !== null ? `每箱 ${p.productQuantity} 个` : "",
  ].filter(Boolean).join(" · ");
}

export interface SnapshotDiffRow {
  label: string;
  /** 转运单时的（空 = 没填） */
  was: string;
  /** 现在的（空 = 没填 / 没有这一款） */
  now: string;
  changed: boolean;
  /** 改过的产品：逐项「件数：12 件 → 15 件」（两边都有这一款时才有；整票那几项一行就是一项，不用） */
  details?: string[];
}

/** 字符串：去掉前后空白，空的当没填 */
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** 数字：只认有限数字，别的当没填 */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const PRODUCT_KEYS = ["itemName", "packageCount", "lengthCm", "widthCm", "heightCm", "productQuantity", "weightKg", "cargoType", "domesticTrackingNo"] as const;

/** 一款规范化：比对和显示都用它 */
export function normalizedProduct(p: ArrivalNoticeProduct): ArrivalNoticeProduct {
  const domestic = str(p.domesticTrackingNo);
  return {
    itemName: str(p.itemName),
    packageCount: num(p.packageCount),
    lengthCm: num(p.lengthCm),
    widthCm: num(p.widthCm),
    heightCm: num(p.heightCm),
    productQuantity: num(p.productQuantity),
    weightKg: num(p.weightKg),
    cargoType: cargoTypeOf(p.cargoType),
    domesticTrackingNo: domestic === BLANK_DOMESTIC_PLACEHOLDER ? null : domestic,
  };
}

const modeZh = (v: string | null): string => (v === "sea" ? "海运" : v === "land" ? "陆运" : v ?? "");
const warehouseZh = (v: string | null): string => (v ? (WAREHOUSE_ZH[v] ?? v) : "");
const amount = (v: number | null, unit: string): string => (v === null ? "" : `${v} ${unit}`);

/**
 * 一项：changed 按规范化以后的值比；显示用 show 拿原值写（跟卡片上看到的一样，审查第 3 轮 dsh：
 * 唛头保存时不去空格，卡片照原样显示，这里也照原样）
 */
function row<T extends string | number | null>(label: string, was: unknown, now: unknown, norm: (v: unknown) => T, show: (raw: unknown, v: T) => string): SnapshotDiffRow {
  const a = norm(was), b = norm(now);
  return { label, was: show(was, a), now: show(now, b), changed: a !== b };
}
/** 字符串原样显示（null = 没填） */
const asIs = (raw: unknown): string => (typeof raw === "string" ? raw : "");

/** 整票那几项：唛头、运单号、仓库、运输方式、到仓日期、总重量、总体积、备注 */
export function snapshotMetaRows(snap: ArrivalNoticeSnapshotData, current: ArrivalNotice): SnapshotDiffRow[] {
  return [
    row("唛头", snap.clientId, current.clientId, str, asIs),
    row("运单号", snap.trackingNo, current.trackingNo, str, asIs),
    row("仓库", snap.warehouseId, current.warehouseId, str, (_, v) => warehouseZh(v)),
    row("运输方式", snap.transportMode, current.transportMode, str, (_, v) => modeZh(v)),
    row("到仓日期", snap.arrivedAt, current.arrivedAt, str, asIs),
    row("总重量", snap.weightKg, current.weightKg, num, (_, v) => amount(v, "kg")),
    row("总体积", snap.volumeM3, current.volumeM3, num, (_, v) => amount(v, "m³")),
    row("备注", snap.remark, current.remark, str, asIs),
  ];
}

const unfilled = (v: string | null): string => v ?? "未填";
/** 逐项列改了什么：品名、件数、尺寸、单箱数量、单箱重、货型、国内单号（值按规范化以后的写，没填写「未填」） */
const PRODUCT_FIELDS: Array<{ label: string; keys: ReadonlyArray<(typeof PRODUCT_KEYS)[number]>; show: (p: ArrivalNoticeProduct) => string | null }> = [
  { label: "品名", keys: ["itemName"], show: (p) => p.itemName },
  { label: "件数", keys: ["packageCount"], show: (p) => (p.packageCount === null ? null : `${p.packageCount} 件`) },
  { label: "尺寸", keys: ["lengthCm", "widthCm", "heightCm"], show: (p) => (p.lengthCm === null && p.widthCm === null && p.heightCm === null ? null : `${p.lengthCm ?? "?"}×${p.widthCm ?? "?"}×${p.heightCm ?? "?"}cm`) },
  { label: "单箱数量", keys: ["productQuantity"], show: (p) => (p.productQuantity === null ? null : `每箱 ${p.productQuantity} 个`) },
  { label: "单箱重", keys: ["weightKg"], show: (p) => (p.weightKg === null ? null : `${p.weightKg}kg`) },
  { label: "货型", keys: ["cargoType"], show: (p) => CARGO_TYPE_ZH[cargoTypeOf(p.cargoType)] },
  { label: "国内单号", keys: ["domesticTrackingNo"], show: (p) => p.domesticTrackingNo },
];

/** 各款产品按顺序比：第 N 款原来 / 现在；原来有现在没有（或反过来）的那一边是空 */
export function snapshotProductRows(snap: ArrivalNoticeSnapshotData, current: ArrivalNotice): SnapshotDiffRow[] {
  const wasRaw = Array.isArray(snap.products) ? snap.products : [];
  const nowRaw = noticeProductsOf(current);
  const out: SnapshotDiffRow[] = [];
  for (let i = 0; i < Math.max(wasRaw.length, nowRaw.length); i++) {
    const a = wasRaw[i] ? normalizedProduct(wasRaw[i]) : null;
    const b = nowRaw[i] ? normalizedProduct(nowRaw[i]) : null;
    const changed = !a || !b || PRODUCT_KEYS.some((k) => a[k] !== b[k]);
    const details = a && b && changed
      ? PRODUCT_FIELDS.filter((f) => f.keys.some((k) => a[k] !== b[k])).map((f) => `${f.label}：${unfilled(f.show(a))} → ${unfilled(f.show(b))}`)
      : undefined;
    out.push({ label: `第 ${i + 1} 款`, was: wasRaw[i] ? productLine(wasRaw[i]) : "", now: nowRaw[i] ? productLine(nowRaw[i]) : "", changed, ...(details ? { details } : {}) });
  }
  return out;
}

/**
 * 跟现在比有几处不一样（标题上说「有 N 处跟现在不一样」/「跟现在一样」）。
 * 按下面实际列出来的项数算（审查第 3 轮 dsh：一款改了品名和件数，原来算 1 处、下面却列两行）：
 * 整票一项算 1；改过的产品按逐项列的条数；多出来 / 少了的一款算 1
 */
export function snapshotChangeCount(snap: ArrivalNoticeSnapshotData, current: ArrivalNotice): number {
  const meta = snapshotMetaRows(snap, current).filter((r) => r.changed).length;
  const products = snapshotProductRows(snap, current).filter((r) => r.changed).reduce((n, r) => n + (r.details?.length || 1), 0);
  return meta + products;
}
