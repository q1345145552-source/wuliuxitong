/**
 * 「看转运单时的原样」（2026-10-19 老板选 B）：把转正式运单那一刻存下的到货通知，跟卡片现在的样子逐项比，
 * 不一样的标出来（「件数：原来 10 → 现在 12」）。纯逻辑，不碰页面，测试能直接跑。
 *
 * 「现在」= 卡片上显示的那条（转出去的运单还在时，后端已经把卡片对齐成运单现在的样子；运单号显示运单现在的号）。
 * 产品按顺序一款一款比（第 1 款比第 1 款），多出来 / 少了的款单独说。
 */
import { CARGO_TYPE_ZH } from "../../../../../packages/shared-types/cargo-type";
import { noticeProductsOf, type ArrivalNotice, type ArrivalNoticeProduct, type ArrivalNoticeSnapshotData } from "../../services/arrival-notice-api";
import { cargoTypeOf } from "./draft";
import { WAREHOUSE_ZH } from "./notice-text";

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
}

const modeZh = (v: string | null | undefined): string => (v === "sea" ? "海运" : v === "land" ? "陆运" : "");
const warehouseZh = (v: string | null | undefined): string => (v ? (WAREHOUSE_ZH[v] ?? v) : "");
const amount = (v: number | null | undefined, unit: string): string => (v === null || v === undefined ? "" : `${v} ${unit}`);
const text = (v: string | null | undefined): string => (v ?? "").trim();

function row(label: string, was: string, now: string): SnapshotDiffRow {
  return { label, was, now, changed: was !== now };
}

/** 整票那几项：唛头、运单号、仓库、运输方式、到仓日期、总重量、总体积、备注 */
export function snapshotMetaRows(snap: ArrivalNoticeSnapshotData, current: ArrivalNotice): SnapshotDiffRow[] {
  return [
    row("唛头", text(snap.clientId), text(current.clientId)),
    row("运单号", text(snap.trackingNo), text(current.trackingNo)),
    row("仓库", warehouseZh(snap.warehouseId), warehouseZh(current.warehouseId)),
    row("运输方式", modeZh(snap.transportMode), modeZh(current.transportMode)),
    row("到仓日期", text(snap.arrivedAt), text(current.arrivedAt)),
    row("总重量", amount(snap.weightKg, "kg"), amount(current.weightKg, "kg")),
    row("总体积", amount(snap.volumeM3, "m³"), amount(current.volumeM3, "m³")),
    row("备注", text(snap.remark), text(current.remark)),
  ];
}

/** 各款产品按顺序比：第 N 款原来 / 现在；原来有现在没有（或反过来）的那一边是空 */
export function snapshotProductRows(snap: ArrivalNoticeSnapshotData, current: ArrivalNotice): SnapshotDiffRow[] {
  const was = Array.isArray(snap.products) ? snap.products : [];
  const now = noticeProductsOf(current);
  const out: SnapshotDiffRow[] = [];
  for (let i = 0; i < Math.max(was.length, now.length); i++) {
    out.push(row(`第 ${i + 1} 款`, was[i] ? productLine(was[i]) : "", now[i] ? productLine(now[i]) : ""));
  }
  return out;
}

/** 跟现在比有几处不一样（标题上说「有 N 处跟现在不一样」/「跟现在一样」） */
export function snapshotChangeCount(snap: ArrivalNoticeSnapshotData, current: ArrivalNotice): number {
  return [...snapshotMetaRows(snap, current), ...snapshotProductRows(snap, current)].filter((r) => r.changed).length;
}
