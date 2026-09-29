/**
 * 建单 / 下预报单时，产品行自动算出来的总体积、总重量怎么往表单里填（2026-09-29，员工页和客户页共用）。
 *
 * 跟后台口径对齐（orders/routes.ts：产品行算得出 > 0 就用产品行的，算不出才用表单上填的）：
 *   · 产品行算得出来（> 0）：框里就是产品行算的数，框只读（页面上用 productRowTotals 判断），
 *     不能手改 —— 手改了后台也不认，页面显示一个数、系统存另一个数（dsh 复查 2026-09-29 指出）。
 *   · 产品行算不出来（没行、没尺寸 / 没单箱重）：框能手填；框里还是「上一次自动填的」就清掉，人手填的不动。
 *   · 产品行全删光、表单上整票长宽高还在：总体积按整票长宽高 × 箱数重算（dsh 复查：原来直接清空，提交就没体积了）。
 *   · 原来的毛病：① 产品行删光时直接 return，旧合计留在框里照样提交；② 总重量框能手改、后台却按产品行存。
 *
 * 纯函数：只看传进来的值，重复调用结果一样（React 严格模式下 setState 的回调会被调两次）。
 */
import { formatVolumeM3String, volumeM3FromDimensionsCm } from "../staff/utils";

export interface AutoTotalsMemory {
  /** 上一次自动填进总体积框的值；null = 框里现在的值不是自动填的 */
  volumeM3: string | null;
  /** 上一次自动填进总重量框的值；null = 框里现在的值不是自动填的 */
  weightKg: string | null;
}

export interface ProductRowNumbers {
  packageCount: string | number;
  lengthCm: string | number;
  widthCm: string | number;
  heightCm: string | number;
  weightKg: string | number;
}

/** 产品行合计（格式化好的字符串）；算出来是 0 就是 null。页面拿 wtStr / volStr 是否为 null 决定框能不能手改 */
export function productRowTotals(rows: ProductRowNumbers[]): { volStr: string | null; wtStr: string | null } {
  const totalVol = rows.reduce((s, p) => {
    const pkg = Number(p.packageCount) || 0;
    const l = Number(p.lengthCm) || 0;
    const w = Number(p.widthCm) || 0;
    const h = Number(p.heightCm) || 0;
    return s + ((l > 0 && w > 0 && h > 0) ? (l * w * h * pkg) / 1_000_000 : 0);
  }, 0);
  const totalWt = rows.reduce((s, p) => s + (Number(p.weightKg) || 0) * (Number(p.packageCount) || 0), 0);
  return {
    volStr: totalVol > 0 ? String(totalVol.toFixed(6)) : null,
    wtStr: totalWt > 0 ? String(totalWt.toFixed(2)) : null,
  };
}

/** 表单上整票长宽高 × 箱数算出来的体积（跟页面上 updateOrderDimensions 同一个算法）；算不出来是 null */
export function orderDimsVolume(form: { lengthCm: string; widthCm: string; heightCm: string; packageCount: string }): string | null {
  const l = Number(String(form.lengthCm ?? "").trim());
  const w = Number(String(form.widthCm ?? "").trim());
  const h = Number(String(form.heightCm ?? "").trim());
  const pkg = Number(String(form.packageCount ?? "").trim());
  if (!(Number.isFinite(l) && Number.isFinite(w) && Number.isFinite(h) && l > 0 && w > 0 && h > 0)) return null;
  const single = volumeM3FromDimensionsCm(l, w, h);
  return formatVolumeM3String(Number.isFinite(pkg) && pkg > 0 ? single * pkg : single);
}

export function nextAutoTotals(
  current: { volumeM3: string; weightKg: string },
  memory: AutoTotalsMemory,
  /** 要自动填进总体积框的值（产品行算的，或删光产品行后按整票长宽高算的）；null = 没得填 */
  volStr: string | null,
  /** 产品行算出来的总重量；null = 算出来是 0 / 没有产品行 */
  wtStr: string | null,
): { volumeM3: string; weightKg: string; memory: AutoTotalsMemory } {
  const volIsAuto = memory.volumeM3 !== null && current.volumeM3 === memory.volumeM3;
  const wtIsAuto = memory.weightKg !== null && current.weightKg === memory.weightKg;
  return {
    volumeM3: volStr !== null ? volStr : (volIsAuto ? "" : current.volumeM3),
    weightKg: wtStr !== null ? wtStr : (wtIsAuto ? "" : current.weightKg),
    memory: { volumeM3: volStr, weightKg: wtStr },
  };
}
