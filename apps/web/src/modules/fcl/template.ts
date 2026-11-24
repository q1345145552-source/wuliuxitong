/**
 * 整柜货物清单模板（2026-09-23）。
 *
 * ⚠️ 单独放一个文件是为了**能被测试真的调到**（组件文件带 JSX，隔离加载不了）。
 * 客户发来的表格必须用这个模板填 —— 表头是**精确匹配**，改一个字就读不到那一列
 * （跟「批量下单」那套同一个规矩，2026-09-11）。
 */
import type { FclProductInput } from "../../services/business-api";
import { CARGO_TYPES, CARGO_TYPE_ZH, distinctCargoTypes } from "../../../../../packages/shared-types/cargo-type";

// 2026-10-11 加特别货；2026-10-16 老板「特别货改成特货」，旧模板里填的「特别货」照认
const CARGO_ZH_TO_CODE: Record<string, string> = { 普货: "normal", 商检货: "inspection", 敏感货: "sensitive", 特货: "special", 特别货: "special" };

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
  "货型（普货/商检货/敏感货/特货，默认普货）",
];

/**
 * 加特别货之前的「货型」表头（2026-10-11 改表头前的写法）。客户 / 员工手里下载过的旧模板还是这一句，
 * 表头又是精确匹配 —— 不认它的话旧模板一上传就报「少一列」。读表时把它当成新表头。
 */
const LEGACY_CARGO_HEADERS = [
  "货型（普货/商检货/敏感货，默认普货）",
  // 2026-10-11 ～ 10-16 的模板（「特别货」改叫「特货」之前下载的）
  "货型（普货/商检货/敏感货/特别货，默认普货）",
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
  const cargoHeader = FCL_TEMPLATE_HEADERS[8];
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    // 旧模板的货型表头当成新表头（新旧两列同时在的话，以新表头那列为准）
    if (LEGACY_CARGO_HEADERS.includes(key)) {
      if (!(cargoHeader in out)) out[cargoHeader] = v;
      continue;
    }
    out[key] = v;
  }
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

/**
 * 整柜就是一票，一票一个货型（2026-11-24 老板：「一票只会有一个货型，不能单独产品选择货型」）。
 * 传表格时「货型」那一格只看读进来的行、只看填了的：认不出来的、几行填得不一样的都不读，说清是第几行；
 * 都一样（或者只有几行填了）就是它，一行都没填按普货。
 *
 * ⚠️ 取那一格必须跟 fclRowFromSheet 走同一把尺子（normalizeKeys：表头两头空格、10-11 / 10-16 前的旧表头）——
 * dsh 11-24 第 1 轮抓到：原来页面上直接按新表头取，旧模板 / 表头带空格时那一格永远是空，
 * 整柜就按普货存了（敏感货被悄悄当普货）。
 *
 * @param rows 读进来的行：rowNo 是表格里的第几行（给人看），raw 是那一行原样
 */
export function fclSheetCargo(rows: ReadonlyArray<{ rowNo: number; raw: Record<string, unknown> }>): { cargoType: string } | { error: string } {
  const cells = rows
    .map(({ rowNo, raw }) => {
      const v = normalizeKeys(raw)[FCL_TEMPLATE_HEADERS[8]];
      const text = v === undefined || v === null ? "" : String(v).trim();
      return { rowNo, text, code: CARGO_ZH_TO_CODE[text] ?? text };
    })
    .filter((c) => c.text !== "");
  const unknown = cells.filter((c) => !(CARGO_TYPES as readonly string[]).includes(c.code));
  if (unknown.length > 0) {
    return { error: `表格第 ${unknown.map((c) => c.rowNo).join("、")} 行的货型（${unknown.map((c) => `「${c.text}」`).join("")}）认不出来，只能填普货、商检货、敏感货、特货，或者空着。改好再传一次。` };
  }
  const kinds = distinctCargoTypes(cells.map((c) => c.code));
  if (kinds.length > 1) {
    return { error: `一票只能有一个货型，表格里${cells.map((c) => `第 ${c.rowNo} 行填的「${CARGO_TYPE_ZH[distinctCargoTypes([c.code])[0]]}」`).join("、")}。改成同一个再传一次。` };
  }
  return { cargoType: kinds[0] ?? "normal" };
}

/**
 * 表格第一张工作表 → 一行一个对象，带上它在表格里是第几行（报错给人看的那个行号）。
 *
 * blankrows: true —— 表格中间整行空的也留着（调用方按「整行都空」跳过），下标才跟表格行号对得上；
 * 表头在第几行按表格的有效范围（!ref）算。原来 `sheet_to_json(..., { defval: "" })` 会把中间的整行空行丢掉，
 * 表头上面空了几行时也不算，报的「第几行」会错位（dsh 11-24 第 2 轮用 xlsx 0.18.5 实测）。
 * 只读到最后一行有字的地方：整列刷过格式的表格 !ref 能拉到第 100 万行，空行全留着会白占几百 MB 内存（dsh 11-24 第 3 轮）。
 */
/** 只用到 xlsx 的这几个函数（不直接引 xlsx 的类型：测试脚本那份类型检查不一定装了网页那边的依赖） */
type XlsxRange = { s: { r: number; c: number }; e: { r: number; c: number } };
type XlsxReader = {
  utils: {
    sheet_to_json<T>(sheet: unknown, opts: { defval: string; blankrows: boolean; range?: XlsxRange }): T[];
    decode_range(ref: string): XlsxRange;
    decode_cell(address: string): { r: number; c: number };
  };
};
export function fclSheetRows(XLSX: XlsxReader, sheet: { "!ref"?: string } & Record<string, unknown>): Array<{ rowNo: number; raw: Record<string, unknown> }> {
  const ref = sheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  // 最后一行有字的是第几行（只看真有值的格子；「!」开头的是表格自己的设置，不是格子）
  let lastRow = range.s.r;
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!")) continue;
    const v = (cell as { v?: unknown } | null)?.v;
    if (v === undefined || v === null || String(v).trim() === "") continue;
    lastRow = Math.max(lastRow, XLSX.utils.decode_cell(address).r);
  }
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "", blankrows: true, range: { s: range.s, e: { r: Math.min(range.e.r, lastRow), c: range.e.c } },
  });
  const headerRow = range.s.r + 1;
  return json.map((raw, i) => ({ rowNo: headerRow + 1 + i, raw }));
}
