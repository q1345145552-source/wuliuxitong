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

/**
 * 把一行的**列名两头的空格去掉**再用。
 *
 * ⚠️ 2026-09-23 第 2 轮复核实测抓到：核对表头时 trim 了、取值时没 trim，
 * 客户表格的表头末尾多打一个空格，`missingFclHeaders` 说「没缺列」，
 * 取值却全落空 —— 品名读成空、单箱重读成空、货型退回普货，一声不吭。
 * 两边必须走同一把尺子，所以核对和取值都先过这一道。
 */
function normalizeKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k.trim()] = v;
  return out;
}

/**
 * 核对表头：客户发来的表格是不是我们那份模板。
 *
 * ⚠️ 光靠「读不到就当空」不行（2026-09-23 复核抓到）：
 * 「货型」那一列表头改一个字，整张表的货型就静默变成普货；
 * 「单箱重量」表头改一个字，总重静默变成 0 —— 员工完全看不出来。
 * 所以上传时先整张核一遍，缺哪列就把列名说出来。
 *
 * @returns 缺的列名；都在就是空数组。
 */
export function missingFclHeaders(row: Record<string, unknown> | undefined): string[] {
  if (!row) return [...FCL_TEMPLATE_HEADERS];
  // 跟 fclRowFromSheet 走同一把尺子（都先去掉列名两头的空格），否则会出现「说齐了、取不到」
  const has = new Set(Object.keys(normalizeKeys(row)));
  return FCL_TEMPLATE_HEADERS.filter((h) => !has.has(h));
}

/** 表格里一行 → 后端要的那一行。表头精确匹配（两头空格不算），找不到的列按空处理 */
export function fclRowFromSheet(rawInput: Record<string, unknown>): FclProductInput {
  const raw = normalizeKeys(rawInput);
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
