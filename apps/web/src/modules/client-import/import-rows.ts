/**
 * 客户「批量下单」读表格（2026-09-29 从 app/client/imports/page.tsx 挪出来，方便测试直接调用；
 * Next 的 page 文件不许导出别的东西）。逻辑原样搬过来，没有改。
 */
import { parseCargoType, type CargoType } from "../../../../../packages/shared-types/cargo-type";

export interface ImportRow {
  /** 表格里的第几行（表头是第 1 行），预览和失败明细都按它说，客户好对着表格找 */
  rowNo: number;
  /**
   * 这一行其它要改的地方（2026-09-29 Codex 全系统检查）：品名没填、箱数不是正整数、
   * 包装类型认不出来、长宽高 / 单箱重量不是数字。原来这些行被**悄悄丢掉**（品名空、箱数认不出），
   * 或者被**悄悄改掉**（「2箱3」当成 23 箱、「桶」当成箱）。现在都留在预览里标红、不许提交。
   */
  issues: string[];
  /** 箱数那一格原样（认不出来时回显给客户看） */
  packageCountRaw: string;
  /** null = 仓库那一格没填或认不出来，下面会拦住不让提交（2026-09-28） */
  warehouseId: string | null;
  /** 填错时原样回显给客户看 */
  warehouseRaw: string;
  itemName: string;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number;
  volumeM3?: number;
  shipDate?: string;
  domesticTrackingNo?: string;
  /** null = 运输方式没填或认不出来（2026-09-28），下面会拦住不让提交 —— 原来一律悄悄当海运 */
  transportMode: "sea" | "land" | null;
  /** 填错时原样回显给客户看 */
  transportModeRaw: string;
  /** 货型（2026-09-11）。null = 这一格填了认不出来的字，下面会拦住不让提交 */
  cargoType: CargoType | null;
  /** 填错时原样回显给客户看 */
  cargoTypeRaw: string;
}

/** 批量导入认的仓库写法：带不带「仓」字、直接写 id 都行（2026-09-28） */
export const WAREHOUSE_ZH: Record<string, string> = {
  wh_yiwu_01: "义乌仓", wh_guangzhou_01: "广州仓", wh_dongguan_01: "东莞仓", wh_shenzhen_01: "深圳仓",
};
export const WAREHOUSE_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(WAREHOUSE_ZH).flatMap(([id, zh]) => [[id, id], [zh, id], [zh.replace(/仓$/, ""), id]]),
);


/**
 * 严格读数字（2026-09-29）：只认「一个数」，后面可以跟一个单位（cm / kg / 箱 这类）。
 * 原来是把所有非数字字符删掉再拼 —— 「2箱3」变 23、「1.2.3」变 NaN 以外的怪数，客户看不出来。
 * 空格子 = 没填（undefined）；填了但认不出来 = bad。
 */
export function readStrictNumber(v: unknown): { value?: number; bad: boolean; raw: string } {
  if (v === undefined || v === null) return { bad: false, raw: "" };
  if (typeof v === "number") return Number.isFinite(v) ? { value: v, bad: false, raw: String(v) } : { bad: true, raw: String(v) };
  const raw = String(v).trim();
  if (!raw) return { bad: false, raw };
  /* 千分位的逗号当正常写法收下（「1,200」= 1200；dsh 复核 2026-09-29：原来会被标红）。
     逗号只许出现在整数部分、每组正好三位：原来先删逗号再认，「1.2,300」被删成 1.2300 = 1.23，
     一个写错的数悄悄变成另一个数、还不标红（Codex 复查 2026-09-30） */
  const m = /^(-?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?)\s*(cm|厘米|公分|kg|公斤|千克|箱|件|个|袋)?$/i.exec(raw);
  if (!m) return { bad: true, raw };
  const n = Number(m[1].replace(/[,，]/g, ""));
  return Number.isFinite(n) ? { value: n, bad: false, raw } : { bad: true, raw };
}

function isBlankRow(row: Record<string, unknown>): boolean {
  return Object.values(row).every((v) => v === undefined || v === null || String(v).trim() === "");
}

export function normalizeRows(rows: Record<string, unknown>[]): ImportRow[] {
  function findCol(row: Record<string, unknown>, keywords: string[]): string {
    const keys = Object.keys(row);
    for (const kw of keywords) {
      const found = keys.find((k) => k.includes(kw));
      if (found) return String(row[found] ?? "").trim();
    }
    return "";
  }
  function findNum(row: Record<string, unknown>, keywords: string[]): { value?: number; bad: boolean; raw: string } {
    const keys = Object.keys(row);
    for (const kw of keywords) {
      const found = keys.find((k) => k.includes(kw));
      if (found) return readStrictNumber(row[found]);
    }
    return { bad: false, raw: "" };
  }
  return rows
    .map((row, index) => ({ row, rowNo: index + 2 })) // sheet_to_json 从表头下一行算起：第 1 条数据是表格第 2 行
    // 整行都空着的（模板里多拉出来的空行）才跳过；只要填了一格，就留在预览里，有问题标红
    .filter(({ row }) => !isBlankRow(row))
    .map(({ row, rowNo }) => {
      const issues: string[] = [];
      /* 运输方式是必填（模板表头带 *）。原来只看「包不包含 land」：没填、写错（比如「空运」「海陆」）一律悄悄当海运建单
         （2026-09-28 分支审查）。现在只认 海运 / 海 / sea、陆运 / 陆 / land，别的标红不许提交。 */
      const transportModeRaw = findCol(row, ["运输方式"]);
      const transportModeKey = transportModeRaw.replace(/\s+/g, "").toLowerCase();
      const transportMode: "sea" | "land" | null =
        ["海运", "海", "sea"].includes(transportModeKey) ? "sea"
        : ["陆运", "陆", "land"].includes(transportModeKey) ? "land"
        : null;
      /* 包装类型只认「箱 / 袋」（和 box / bag），空着就是箱。原来包含 bag 就算袋、其余一律算箱 ——
         填「桶」「托」也悄悄变成箱（2026-09-29）。 */
      const packageUnitRawText = findCol(row, ["包装类型"]);
      const unitKey = packageUnitRawText.replace(/\s+/g, "").toLowerCase();
      const packageUnit: "bag" | "box" | null =
        unitKey === "" || ["箱", "box", "箱子", "纸箱"].includes(unitKey) ? "box"
        : ["袋", "bag", "袋子", "编织袋"].includes(unitKey) ? "bag"
        : null;
      if (packageUnit === null) issues.push(`包装类型「${packageUnitRawText}」认不出来（只能填 箱 或 袋）`);
      /* 2026-09-28 审查报告：原来只认「义乌仓」这种带「仓」字的全称，写成「义乌」就把「义乌」原样当仓库 id 存进去，
         员工按仓库筛哪个仓都筛不出这张单。现在带不带「仓」字、直接写 id 都认；认不出来的标红、不让提交。 */
      const rawWarehouse = findCol(row, ["仓库"]);
      // 只认表里自己的键：写成 constructor / toString 这种字会从对象原型上查出东西来，不是 null（2026-09-28 分支审查）
      const warehouseKey = rawWarehouse.replace(/\s+/g, "");
      const warehouseId = Object.prototype.hasOwnProperty.call(WAREHOUSE_BY_NAME, warehouseKey) ? WAREHOUSE_BY_NAME[warehouseKey] : null;
      const itemName = findCol(row, ["品名"]);
      if (!itemName) issues.push("品名没填");
      const pkgRead = findNum(row, ["箱数"]);
      const packageCount = pkgRead.value ?? 0;
      if (pkgRead.bad || !(Number.isInteger(packageCount) && packageCount > 0)) {
        issues.push(pkgRead.raw ? `箱数「${pkgRead.raw}」不对（要填正整数）` : "箱数没填");
      }
      const numOrIssue = (label: string, r: { value?: number; bad: boolean; raw: string }): number | undefined => {
        if (r.bad || (r.value !== undefined && r.value < 0)) {
          issues.push(`${label}「${r.raw}」不对（要填不小于 0 的数字）`);
          return undefined;
        }
        return r.value;
      };
      const perBoxWeight = numOrIssue("单箱重量", findNum(row, ["单箱重量"]));
      const weightKg = perBoxWeight != null && packageCount > 0 ? perBoxWeight * packageCount : perBoxWeight;
      const lengthCm = numOrIssue("长", findNum(row, ["长cm", "长"]));
      const widthCm = numOrIssue("宽", findNum(row, ["宽cm", "宽"]));
      const heightCm = numOrIssue("高", findNum(row, ["高cm", "高"]));
      let volumeM3: number | undefined;
      if (lengthCm && widthCm && heightCm && lengthCm > 0 && widthCm > 0 && heightCm > 0) {
        volumeM3 = (lengthCm * widthCm * heightCm * packageCount) / 1_000_000;
      }
      const cargoTypeRaw = findCol(row, ["货型"]);
      let shipDate = findCol(row, ["发货日期"]);
      if (/^\d{5}$/.test(shipDate)) {
        const d = new Date((Number(shipDate) - 25569) * 86400000);
        shipDate = d.toISOString().slice(0, 10);
      }
      return {
        rowNo,
        issues,
        packageCountRaw: pkgRead.raw,
        warehouseId,
        warehouseRaw: rawWarehouse,
        itemName,
        packageCount,
        packageUnit: packageUnit ?? "box",
        weightKg,
        volumeM3,
        shipDate: shipDate || undefined,
        domesticTrackingNo: findCol(row, ["国内单号"]) || undefined,
        transportMode,
        transportModeRaw,
        // 货型（2026-09-11）：留空按普货；认不出来的先留 null，预览里标红并禁掉提交，
        // **不许**静默当普货 —— 商检货按普货走，清关要的单据是另一套
        cargoType: parseCargoType(cargoTypeRaw)?.value ?? null,
        cargoTypeRaw,
      };
    });
  // 有问题的行一律不丢（2026-09-29）：原来品名空、箱数认不出的行在这里被悄悄过滤掉，
  // 客户只看到「已读取 1 条」，不知道另外两行没了。现在留在预览里标红、写清楚哪里不对。
}

/** 这一行能不能提交：仓库 / 运输方式 / 货型认得出来，而且没有别的问题 */
export function isRowBad(r: ImportRow): boolean {
  return r.cargoType === null || r.warehouseId === null || r.transportMode === null || r.issues.length > 0;
}

