/**
 * 整柜货物清单模板（2026-09-23）。
 *
 * ⚠️ 单独放一个文件是为了**能被测试真的调到**（组件文件带 JSX，隔离加载不了）。
 * 客户发来的表格必须用这个模板填 —— 表头是**精确匹配**，改一个字就读不到那一列
 * （跟「批量下单」那套同一个规矩，2026-09-11）。
 */
import type { FclProductInput } from "../../services/business-api";

const CARGO_ZH_TO_CODE: Record<string, string> = { 普货: "normal", 商检货: "inspection", 敏感货: "sensitive" };

/** 整柜货物清单模板的表头。⚠️ 新列只能加在最后（2026-09-11 的规矩），表头是精确匹配 */
export const FCL_TEMPLATE_HEADERS = [
  "品名 *",
  "箱数 *",
  "每箱数量（不填按 1 算）",
  "长cm *",
  "宽cm *",
  "高cm *",
  "单箱重量kg（选填）",
  "国内单号（选填）",
  "货型（普货/商检货/敏感货，默认普货）",
];

/** 表格里一行 → 后端要的那一行。表头精确匹配，找不到的列按空处理 */
export function fclRowFromSheet(raw: Record<string, unknown>): FclProductInput {
  const pick = (header: string) => {
    const v = raw[header];
    return v === undefined || v === null ? "" : String(v).trim();
  };
  const cargoZh = pick(FCL_TEMPLATE_HEADERS[8]);
  return {
    itemName: pick(FCL_TEMPLATE_HEADERS[0]),
    packageCount: pick(FCL_TEMPLATE_HEADERS[1]),
    quantityPerBox: pick(FCL_TEMPLATE_HEADERS[2]),
    lengthCm: pick(FCL_TEMPLATE_HEADERS[3]),
    widthCm: pick(FCL_TEMPLATE_HEADERS[4]),
    heightCm: pick(FCL_TEMPLATE_HEADERS[5]),
    unitWeightKg: pick(FCL_TEMPLATE_HEADERS[6]),
    domesticTrackingNo: pick(FCL_TEMPLATE_HEADERS[7]),
    cargoType: cargoZh ? (CARGO_ZH_TO_CODE[cargoZh] ?? cargoZh) : "normal",
  };
}
