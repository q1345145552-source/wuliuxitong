import JSZip from "jszip";
import { apiBaseUrl, authHeaders, parseApiResponse, fetchWithSession as fetch } from "../../services/core-api";

export type LastmileExportShipment = {
  lastmileOrderId: string;
  trackingNo: string;
  parentTrackingNo: string;
  itemName: string;
  packageCount: number;
  packageUnit: string;
  /** null = 这票货没填重量。⚠️ 后端会原样下发 null，别在类型上写死非空 */
  weightKg: number | null;
  /** null = 没填体积，同上 */
  volumeM3: number | null;
  /**
   * 这一票货的长/宽/高（2026-08-27 加）。
   * 装柜导出返回的 products 一直是空数组（柜里放的是分柜后的子运单，
   * 产品行属于原订单，展开会把件数重复算回整票），
   * 结果就是清单上那三列**从来没填过东西**。现在后端在运单这一层直接给尺寸。
   * 一票货有多个不同尺寸时后端会给 "60/50" 这样的字符串，那种情况留空（打印表格的格子放不下）。
   */
  lengthCm?: number | string | null;
  widthCm?: number | string | null;
  heightCm?: number | string | null;
  remark: string;
  status: string;
  containerNos: string[];
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  products: Array<{
    itemName: string;
    packageCount: number;
    lengthCm: number | null;
    widthCm: number | null;
    heightCm: number | null;
    weightKg: number | null;
  }>;
};

export type LastmileExportCustomer = {
  clientId: string;
  clientName: string;
  contactName: string;
  contactPhone: string;
  address: string;
  addressLabel: string;
  shipments: LastmileExportShipment[];
};

export type LastmileExportData = {
  containerId: string;
  containerNo: string;
  containerType: string;
  origin: string;
  destination: string;
  carrierInfo: string;
  deliveryNo: string;
  scope: "container" | "customer";
  carrierName: string;
  driverName: string;
  licensePlate: string;
  phoneNumber: string;
  deliveryDate: string;
  status: string;
  customerCount: number;
  shipmentCount: number;
  signedCount: number;
  totalPackageCount: number;
  totalVolumeM3: number;
  totalWeightKg: number;
  containerNos: string[];
  customers: LastmileExportCustomer[];
  generatedAt: string;
};

export type TemplateLine = {
  clientId: string;
  clientName: string;
  trackingNo: string;
  itemName: string;
  packageCount: number;
  /** null = 这票货压根没填体积，不是 0。导出时要留空格子，不能印成 0 */
  volumeM3: number | null;
  /** null = 没填重量，同上 */
  weightKg: number | null;
  /**
   * ⚠️ 可能是字符串。一票货里有好几个不同尺寸时，后端给的是「60/50」这种并排写法
   * （orders/routes.ts:1657）。原来这里只收数字、字符串一律丢成 null，
   * 结果**多尺寸的整柜导出，长宽高三格全是空白**（2026-08-28 老板实测；单尺寸正常）。
   * 现在原样留着，写进 Excel 时数字走数字格、字符串走文本格。
   * 长宽高不参与合计（lineTotal 从没拿这三个 key 调用过），所以不会影响任何求和。
   */
  lengthCm: number | string | null;
  widthCm: number | string | null;
  heightCm: number | string | null;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  remark: string;
};

const TEMPLATE_PATHS = {
  container: "/templates/lastmile/internal-dispatch-template.xlsx",
  customer: "/templates/lastmile/customer-receipt-template.xlsx",
} as const;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function fetchContainerExportData(containerId: string): Promise<LastmileExportData> {
  const query = new URLSearchParams({ id: containerId });
  const response = await fetch(`${apiBaseUrl()}/staff/loading-manifests/export-data?${query.toString()}`, {
    headers: { ...authHeaders() },
  });
  return parseApiResponse<LastmileExportData>(response);
}

export async function fetchLastmileCustomerExportData(deliveryNo: string, clientId: string): Promise<LastmileExportData> {
  const query = new URLSearchParams({ deliveryNo, clientId });
  const response = await fetch(`${apiBaseUrl()}/admin/lastmile/customer-export-data?${query.toString()}`, {
    headers: { ...authHeaders() },
  });
  return parseApiResponse<LastmileExportData>(response);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class SharedStringsEditor {
  private readonly additions: string[] = [];
  private readonly originalCount: number;
  private readonly originalUniqueCount: number;
  private readonly prefix: string;

  constructor(private xml: string) {
    this.prefix = /<([A-Za-z_][\w.-]*:)?sst\b/.exec(xml)?.[1] ?? "";
    const itemCount = [...xml.matchAll(new RegExp(`<${escapeRegExp(this.prefix)}si\\b`, "g"))].length;
    this.originalCount = Number(/\bcount="(\d+)"/.exec(xml)?.[1] ?? itemCount);
    this.originalUniqueCount = Number(/\buniqueCount="(\d+)"/.exec(xml)?.[1] ?? itemCount);
  }

  /**
   * 把模板里**原有**的、文字满足 match 的共享字符串清成空串，返回它们的下标（2026-09-15）。
   *
   * ⚠️ 只清内容、**不删 `<si>`**：单元格是按「第几条」引用共享字符串的，
   *    删掉一条，后面所有编号整体前移，整张表串字；add() 给新字符串编号也是按原条数算的。
   */
  blankOriginal(match: (text: string) => boolean): Set<number> {
    const p = escapeRegExp(this.prefix);
    const blanked = new Set<number>();
    let index = 0;
    this.xml = this.xml.replace(new RegExp(`<${p}si\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${p}si>)`, "g"), (block) => {
      const current = index;
      index += 1;
      const text = [...block.matchAll(new RegExp(`<${p}t\\b[^>]*>([\\s\\S]*?)<\\/${p}t>`, "g"))].map((m) => m[1]).join("");
      if (!match(unescapeXml(text))) return block;
      blanked.add(current);
      return `<${this.prefix}si><${this.prefix}t xml:space="preserve"></${this.prefix}t></${this.prefix}si>`;
    });
    return blanked;
  }

  /**
   * 把模板里**原有**共享字符串中的一段文字换成另一段（2026-09-15）。
   * 只改 `<t>` 里的字，不增删 `<si>`，编号不变。必须在任何 add() 之前调用，
   * 这样只会改到模板自带的字，不会碰到导出时写进去的客户数据。返回改了几处。
   */
  replaceInOriginal(from: string, to: string): number {
    const p = escapeRegExp(this.prefix);
    let changed = 0;
    this.xml = this.xml.replace(new RegExp(`(<${p}t\\b[^>]*>)([\\s\\S]*?)(<\\/${p}t>)`, "g"), (whole, open: string, body: string, close: string) => {
      if (!body.includes(from)) return whole;
      changed += 1;
      return `${open}${body.split(from).join(to)}${close}`;
    });
    return changed;
  }

  add(value: string | number | null | undefined): number {
    const index = this.originalUniqueCount + this.additions.length;
    this.additions.push(String(value ?? ""));
    return index;
  }

  finish(): string {
    if (this.additions.length === 0) return this.xml;
    const items = this.additions.map((value) => `<${this.prefix}si><${this.prefix}t xml:space="preserve">${escapeXml(value)}</${this.prefix}t></${this.prefix}si>`).join("");
    const count = this.originalCount + this.additions.length;
    const uniqueCount = this.originalUniqueCount + this.additions.length;
    let output = this.xml;
    output = /\bcount="\d+"/.test(output)
      ? output.replace(/\bcount="\d+"/, `count="${count}"`)
      : output.replace(`<${this.prefix}sst`, `<${this.prefix}sst count="${count}"`);
    output = /\buniqueCount="\d+"/.test(output)
      ? output.replace(/\buniqueCount="\d+"/, `uniqueCount="${uniqueCount}"`)
      : output.replace(`<${this.prefix}sst`, `<${this.prefix}sst uniqueCount="${uniqueCount}"`);
    return output.replace(`</${this.prefix}sst>`, `${items}</${this.prefix}sst>`);
  }
}

function xmlPrefix(xml: string, localName: string): string {
  return new RegExp(`<([A-Za-z_][\\w.-]*:)?${localName}\\b`).exec(xml)?.[1] ?? "";
}

function withCellType(attributes: string, type: "s" | "n"): string {
  return `${attributes.replace(/\s+t="[^"]*"/g, "")} t="${type}"`;
}

function withoutCellType(attributes: string): string {
  return attributes.replace(/\s+t="[^"]*"/g, "");
}

function replaceCellXml(sheetXml: string, ref: string, type: "s" | "n", innerXml: string): string {
  const escapedRef = escapeRegExp(ref);
  const prefix = xmlPrefix(sheetXml, "c");
  const tag = `${prefix}c`;
  const emptyCell = new RegExp(`<${escapeRegExp(tag)}\\b([^>]*\\br="${escapedRef}"[^>]*)\\s*\\/>`);
  if (emptyCell.test(sheetXml)) {
    return sheetXml.replace(emptyCell, (_match, attributes: string) => `<${tag}${withCellType(attributes, type)}>${innerXml}</${tag}>`);
  }
  const fullCell = new RegExp(`<${escapeRegExp(tag)}\\b([^>]*\\br="${escapedRef}"[^>]*)>[\\s\\S]*?<\\/${escapeRegExp(tag)}>`);
  if (fullCell.test(sheetXml)) {
    return sheetXml.replace(fullCell, (_match, attributes: string) => `<${tag}${withCellType(attributes, type)}>${innerXml}</${tag}>`);
  }
  throw new Error(`模板格式不符：找不到单元格 ${ref}`);
}

function clearCellXml(sheetXml: string, ref: string): string {
  const escapedRef = escapeRegExp(ref);
  const prefix = xmlPrefix(sheetXml, "c");
  const tag = `${prefix}c`;
  const emptyCell = new RegExp(`<${escapeRegExp(tag)}\\b([^>]*\\br="${escapedRef}"[^>]*)\\s*\\/>`);
  if (emptyCell.test(sheetXml)) {
    return sheetXml.replace(emptyCell, (_match, attributes: string) => `<${tag}${withoutCellType(attributes)}/>`);
  }
  const fullCell = new RegExp(`<${escapeRegExp(tag)}\\b([^>]*\\br="${escapedRef}"[^>]*)>[\\s\\S]*?<\\/${escapeRegExp(tag)}>`);
  if (fullCell.test(sheetXml)) {
    return sheetXml.replace(fullCell, (_match, attributes: string) => `<${tag}${withoutCellType(attributes)}/>`);
  }
  throw new Error(`模板格式不符：找不到单元格 ${ref}`);
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * 客户签收单底部那句「📧 请签收后拍照/扫描回传至湘泰货运 | กรุณาถ่ายรูปหรือสแกนส่งกลับ | 微信/Line：____」。
 *
 * 老板 2026-09-15：「直接把这句话去掉，尾端的拆派仓会跟司机对接的」。
 * 模板里有两条：中文页 sheet1!A55（共享字符串第 41 条）、泰文页 sheet2!A64（第 82 条，泰文在前的同义句
 * 「📧 กรุณาถ่ายรูปหรือสแกนส่งกลับ | 请签收后回传 | 微信/Line：____」），两条都认。
 * 上面那句「⚠️ 签字即代表已阅读并同意以上全部条款」不认，要留着。
 */
function isReturnInstructionText(text: string): boolean {
  return /微信\s*\/\s*Line/i.test(text) && /回传|ส่งกลับ/.test(text);
}

/**
 * 删掉引用了指定共享字符串的单元格（整个 `<c>` 去掉）。
 *
 * 为什么是删格子而不是清空：那一格的样式（s=20）带浅黄底色，只清文字会在纸上留一条空黄条。
 * 行本身、行高、合并区域（A55:H55 / A64:J64）、样式表都不动 ——
 * test-dispatch-wrap 第 4 项逐项比对「行高 / 合并 / 打印设置跟模板一致」，动了就红。
 */
function removeSharedStringCells(sheetXml: string, indexes: Set<number>): string {
  if (indexes.size === 0) return sheetXml;
  const p = escapeRegExp(xmlPrefix(sheetXml, "c"));
  return sheetXml.replace(
    new RegExp(`<${p}c\\b([^>]*)>\\s*<${p}v>(\\d+)<\\/${p}v>\\s*<\\/${p}c>`, "g"),
    (cell, attributes: string, value: string) => (/\bt="s"/.test(attributes) && indexes.has(Number(value)) ? "" : cell),
  );
}

function setTextCell(sheetXml: string, ref: string, value: string | number | null | undefined, strings: SharedStringsEditor): string {
  if (String(value ?? "") === "") return clearCellXml(sheetXml, ref);
  const prefix = xmlPrefix(sheetXml, "c");
  return replaceCellXml(sheetXml, ref, "s", `<${prefix}v>${strings.add(value)}</${prefix}v>`);
}

function setNumberCell(sheetXml: string, ref: string, value: number): string {
  const prefix = xmlPrefix(sheetXml, "c");
  return replaceCellXml(sheetXml, ref, "n", `<${prefix}v>${Number.isFinite(value) ? String(value) : "0"}</${prefix}v>`);
}

/**
 * 数值格子，但**没值时留空而不是写 0**（2026-08-25 新增）。
 *
 * 客户派送签收单是给客户签字的纸质单据。这票货没填体积重量时，
 * 原来会印成「0 m³ / 0 kg」—— 等于白纸黑字告诉客户这箱货没有重量。
 * 空着才是诚实的：不知道就是不知道。
 */
function setOptionalNumberCell(sheetXml: string, ref: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return clearCellXml(sheetXml, ref);
  return setNumberCell(sheetXml, ref, value);
}

/**
 * 长/宽/高专用：一票多尺寸时值是「60/50」这种字符串，
 * 塞进数字格会把 xlsx 写坏，所以字符串走文本格。null 就留空。
 */
function setDimensionCell(
  sheetXml: string,
  ref: string,
  value: number | string | null | undefined,
  strings: SharedStringsEditor,
): string {
  if (value == null || value === "") return sheetXml;
  if (typeof value === "number") return Number.isFinite(value) ? setNumberCell(sheetXml, ref, value) : sheetXml;
  return setTextCell(sheetXml, ref, value, strings);
}

function setFormulaCell(sheetXml: string, ref: string, formula: string, cachedValue: number): string {
  const prefix = xmlPrefix(sheetXml, "c");
  return replaceCellXml(sheetXml, ref, "n", `<${prefix}f>${escapeXml(formula)}</${prefix}f><${prefix}v>${Number.isFinite(cachedValue) ? String(cachedValue) : "0"}</${prefix}v>`);
}

/** 半字宽单位的保守字形预算；不把窄字母、泰文声调或组合重音当成宽字。 */
function characterWidth(char: string): number {
  if (/[\p{Nonspacing_Mark}\p{Enclosing_Mark}\u200C\u200D]/u.test(char)) return 0;
  if (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char) || /\p{Extended_Pictographic}/u.test(char)) return 2;
  if (char === "\t") return 4;
  if (/[MWmw@%&]/.test(char)) return 2;
  if (/[ilI1.,'`!|:;\s]/.test(char)) return 0.6;
  if (/[A-Z]/.test(char) || /[\u0E00-\u0E7F]/.test(char)) return 1.5;
  return 1.2;
}

/** 按模板实际字号和列宽估算品名折行；短名不降低或覆盖模板行高。 */
function wrappedLineCount(text: string, columnWidthChars: number): number {
  // Excel 的列宽单位是「默认字体下的字符宽」，中日韩文字大约占两个单位
  const capacity = Math.max(1, Math.floor(columnWidthChars));
  let lines = 0;
  // 显式换行独立成段，CRLF 只算一次；空段同样占一行。
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    lines += 1;
    let used = 0;
    for (const char of paragraph) {
      const width = characterWidth(char);
      if (used > 0 && used + width > capacity) {
        lines += 1;
        used = width;
      } else {
        used += width;
      }
    }
  }
  return lines;
}

/** 字号的 1.35 倍留出字形行距；这里只估高，不改模板字体。 */
const WRAP_LINE_SPACING = 1.35;
/** 超过 20 行保留完整单元格文本但限制行高；极长内容仍需在 Excel 内展开查看。 */
const WRAP_MAX_LINES = 20;

/**
 * 这一行要多高才放得下这段文字。放得下就返回 null —— 不动模板原来的行高，
 * 短品名的单子导出来和以前一模一样。
 */
function wrapRowHeight(text: string, columnWidthChars: number, baseHeight: number, fontSize: number): number | null {
  if (!text) return null;
  const needed = Math.min(wrappedLineCount(text, columnWidthChars), WRAP_MAX_LINES);
  const height = Math.ceil(needed * fontSize * WRAP_LINE_SPACING + 4);
  return height > baseHeight ? height : null;
}

function rowPattern(sheetXml: string, row: number): RegExp {
  const tag = `${xmlPrefix(sheetXml, "row")}row`;
  return new RegExp(`<${escapeRegExp(tag)}\\b([^>]*\\br="${row}"[^>]*?)(\\s*\\/?)>`);
}

/** 改某一行的行高；顺手把 customHeight 置上，不然 Excel 会忽略 ht */
function setRowHeight(sheetXml: string, row: number, height: number): string {
  const tag = `${xmlPrefix(sheetXml, "row")}row`;
  const pattern = rowPattern(sheetXml, row);
  // 模板里没这一行就原样返回 —— 别为了行高把整个导出搞挂
  if (!pattern.test(sheetXml)) return sheetXml;
  return sheetXml.replace(pattern, (_match, attributes: string, closing: string) => {
    const kept = attributes.replace(/\s+ht="[^"]*"/g, "").replace(/\s+customHeight="[^"]*"/g, "");
    return `<${tag}${kept} ht="${height}" customHeight="1"${closing}>`;
  });
}

/**
 * 模板自己写的列宽 / 行高 —— 不在代码里抄死数字，模板改了这边跟着变。
 * 读不到就用 Excel 的默认值（列宽 8.43、行高 15）。
 */
function columnWidthOf(sheetXml: string, column: string): number {
  const index = column.split("").reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
  const colsBlock = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?cols>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?cols>`).exec(sheetXml);
  if (colsBlock) {
    for (const match of colsBlock[1].matchAll(/min="(\d+)"[^>]*?max="(\d+)"[^>]*?width="([\d.]+)"/g)) {
      if (index >= Number(match[1]) && index <= Number(match[2])) return Number(match[3]);
    }
  }
  const fallback = /defaultColWidth="([\d.]+)"/.exec(sheetXml);
  return fallback ? Number(fallback[1]) : 8.43;
}

function rowHeightOf(sheetXml: string, row: number): number {
  const match = rowPattern(sheetXml, row).exec(sheetXml);
  const ht = match ? /\bht="([\d.]+)"/.exec(match[1]) : null;
  if (ht) return Number(ht[1]);
  const fallback = /defaultRowHeight="([\d.]+)"/.exec(sheetXml);
  return fallback ? Number(fallback[1]) : 15;
}

type TemplateFonts = { normalSize: number; cellSizes: number[] };

function xmlBlock(xml: string, name: string): string {
  return new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${name}>`).exec(xml)?.[1] ?? "";
}

/** XLSX 的列宽基于 Normal 字体，明细格的字号则由 cellXfs/fontId 指向。 */
function templateFonts(stylesXml: string): TemplateFonts {
  const fonts = [...xmlBlock(stylesXml, "fonts").matchAll(/<(?:[A-Za-z_][\w.-]*:)?font\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?font>/g)]
    .map((match) => Number(/<(?:[A-Za-z_][\w.-]*:)?sz\b[^>]*\bval="([\d.]+)"/.exec(match[1])?.[1]) || 11);
  const styleXfs = [...xmlBlock(stylesXml, "cellStyleXfs").matchAll(/<(?:[A-Za-z_][\w.-]*:)?xf\b([^>]*)/g)]
    .map((match) => Number(/\bfontId="(\d+)"/.exec(match[1])?.[1] ?? 0));
  const normalStyle = [...xmlBlock(stylesXml, "cellStyles").matchAll(/<(?:[A-Za-z_][\w.-]*:)?cellStyle\b([^>]*)/g)]
    .find((match) => /\bname="Normal"/.test(match[1]) || /\bbuiltinId="0"/.test(match[1]));
  const normalIndex = Number(/\bxfId="(\d+)"/.exec(normalStyle?.[1] ?? "")?.[1] ?? 0);
  const normalSize = fonts[styleXfs[normalIndex] ?? 0] ?? 11;
  const cellSizes = [...xmlBlock(stylesXml, "cellXfs").matchAll(/<(?:[A-Za-z_][\w.-]*:)?xf\b([^>]*)/g)].map((match) => {
    const inherited = styleXfs[Number(/\bxfId="(\d+)"/.exec(match[1])?.[1] ?? 0)] ?? 0;
    const fontId = /\bapplyFont="0"/.test(match[1]) ? inherited : Number(/\bfontId="(\d+)"/.exec(match[1])?.[1] ?? inherited);
    return fonts[fontId] ?? normalSize;
  });
  return { normalSize, cellSizes };
}

function cellFontSize(sheetXml: string, ref: string, fonts: TemplateFonts): number {
  const cell = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?c\\b([^>]*\\br="${escapeRegExp(ref)}"[^>]*)`).exec(sheetXml);
  const style = Number(/\bs="(\d+)"/.exec(cell?.[1] ?? "")?.[1] ?? 0);
  return fonts.cellSizes[style] ?? fonts.normalSize;
}

/** 写品名，并在一行放不下时把行高撑开（列宽和原行高都从模板里读） */
function setItemNameCell(
  sheetXml: string,
  column: string,
  row: number,
  itemName: string,
  strings: SharedStringsEditor,
  fonts: TemplateFonts,
): string {
  const fontSize = cellFontSize(sheetXml, `${column}${row}`, fonts);
  // 大于 Normal 字体时同列容纳的字变少；小字号仍保留原来的保守宽度预算。
  const width = columnWidthOf(sheetXml, column) * Math.min(1, fonts.normalSize / fontSize);
  const height = wrapRowHeight(itemName ?? "", width, rowHeightOf(sheetXml, row), fontSize);
  const xml = setTextCell(sheetXml, `${column}${row}`, itemName, strings);
  return height == null ? xml : setRowHeight(xml, row, height);
}

function columnName(index: number): string {
  let value = index;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function clearRange(sheetXml: string, startRow: number, endRow: number, startColumn: number, endColumn: number, strings: SharedStringsEditor): string {
  let output = sheetXml;
  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startColumn; column <= endColumn; column += 1) {
      output = setTextCell(output, `${columnName(column)}${row}`, "", strings);
    }
  }
  return output;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** 导出给自测脚本用（scripts/test-lastmile-export.ts）—— 这一层是纯计算，不碰网络不碰 DOM */
export function expandTemplateLines(data: LastmileExportData): TemplateLine[] {
  const lines: TemplateLine[] = [];
  for (const customer of data.customers) {
    for (const shipment of customer.shipments) {
      /**
       * ⚠️ 2026-08-28 改：原来「只认数字」，后端遇到「一票多个不同尺寸」给的是
       * "60/50" 这种字符串，被整个丢成 null —— 多尺寸的单子长宽高三格全空白。
       * 现在原样留着，写单元格时再按类型分流（数字走数字格、字符串走文本格）。
       */
      const dimOrNull = (v: number | string | null | undefined): number | string | null => {
        if (typeof v === "number") return Number.isFinite(v) ? v : null;
        if (typeof v === "string") {
          const trimmed = v.trim();
          return trimmed ? trimmed : null;
        }
        return null;
      };
      /**
       * ⚠️ 这个标记很重要：下面算方数时，「有长宽高就按尺寸重算」这条路
       * **只能给真实产品行走**。装柜这一票的方数是后端按**实际装柜体积**给的，
       * 才是客户单上该出现的数；用尺寸重算出来的是另一个数，两边会对不上。
       * 所以补尺寸只是为了「让那三列有内容」，绝不能顺带把方数也改了。
       */
      const usingFallback = shipment.products.length === 0;
      const products = shipment.products.length > 0 ? shipment.products : [{
        itemName: shipment.itemName,
        packageCount: shipment.packageCount,
        lengthCm: dimOrNull(shipment.lengthCm),
        widthCm: dimOrNull(shipment.widthCm),
        heightCm: dimOrNull(shipment.heightCm),
        // 运单 weightKg 是整票总重；只有真实产品的 weightKg 才是单箱重。
        weightKg: null,
      }];
      const packageTotal = products.reduce((sum, product) => sum + Number(product.packageCount || 0), 0) || 1;
      products.forEach((product) => {
        const share = Number(product.packageCount || 0) / packageTotal;
        // ⚠️ shipment.volumeM3 可能是 null（这票货没填）。`null * share` 在 JS 里等于 0，
        // 直接算就会把「没填」变成「0 方」，所以必须先判空。重量同理。
        // 尺寸现在可能是「60/50」这种字符串，拿它做乘法会得到 NaN —— 只有三个都是数字才重算
        const dimsAreNumbers =
          typeof product.lengthCm === "number" &&
          typeof product.widthCm === "number" &&
          typeof product.heightCm === "number";
        const volume = !usingFallback && dimsAreNumbers && product.lengthCm && product.widthCm && product.heightCm
          ? Number(product.packageCount || 0) * Number(product.lengthCm) * Number(product.widthCm) * Number(product.heightCm) / 1_000_000
          : (shipment.volumeM3 == null ? null : Number(shipment.volumeM3) * share);
        const weight = product.weightKg == null
          ? (shipment.weightKg == null ? null : Number(shipment.weightKg) * share)
          : Number(product.weightKg) * Number(product.packageCount || 0);
        const receiverName = shipment.receiverName || customer.contactName;
        const phone = shipment.receiverPhone || customer.contactPhone;
        const address = shipment.receiverAddress || customer.address;
        lines.push({
          clientId: customer.clientId,
          clientName: customer.clientName,
          trackingNo: shipment.trackingNo,
          itemName: product.itemName || shipment.itemName,
          packageCount: Number(product.packageCount || 0),
          volumeM3: volume == null ? null : round(volume, 6),
          weightKg: weight == null ? null : round(weight, 2),
          lengthCm: product.lengthCm,
          widthCm: product.widthCm,
          heightCm: product.heightCm,
          receiverName,
          receiverPhone: phone,
          receiverAddress: address,
          remark: shipment.remark || "",
        });
      });
    }
  }
  return lines;
}

function paginate<T>(items: T[], pageSize: number): T[][] {
  if (items.length === 0) return [[]];
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += pageSize) pages.push(items.slice(index, index + pageSize));
  return pages;
}

/**
 * 同一客户可能有多个收货人或地址。客户模板的表头只有一个地址栏，不能把不同站点
 * 硬塞进固定行高的备注格（会遮挡下一行），所以先按站点分组，再按模板容量分页。
 * 每组保留第一次出现的顺序，组内保留原运单顺序。
 */
function paginateCustomerLines(lines: TemplateLine[], pageSize: number): TemplateLine[][] {
  if (lines.length === 0) return [[]];
  const stops = new Map<string, TemplateLine[]>();
  for (const line of lines) {
    const key = JSON.stringify([line.receiverName, line.receiverPhone, line.receiverAddress]);
    const stopLines = stops.get(key);
    if (stopLines) stopLines.push(line);
    else stops.set(key, [line]);
  }
  return [...stops.values()].flatMap((stopLines) => paginate(stopLines, pageSize));
}

/**
 * 合计，但**整列一个值都没有时返回 null**（留空），而不是合计成 0。
 * 跟 setOptionalNumberCell 是同一个道理：一行都没填，合计栏印个 0 更误导人。
 */
function optionalLineTotal(lines: TemplateLine[], key: "volumeM3" | "weightKg"): number | null {
  if (!lines.some((line) => line[key] != null)) return null;
  return lineTotal(lines, key);
}

/** ⚠️ 只用于会求和的列。长宽高**不在这里** —— 对尺寸求和是没意义的数，而且它可能是「60/50」这种字符串 */
function lineTotal(lines: TemplateLine[], key: "packageCount" | "volumeM3" | "weightKg"): number {
  return round(
    lines.reduce((sum, line) => sum + Number(line[key] || 0), 0),
    key === "volumeM3" ? 6 : 2,
  );
}

function patchInternalTemplate(
  sheetXml: string,
  strings: SharedStringsEditor,
  fonts: TemplateFonts,
  data: LastmileExportData,
  lines: TemplateLine[],
  sequenceStart: number,
  allLines: TemplateLine[],
): string {
  let xml = clearRange(sheetXml, 10, 34, 1, 14, strings);
  xml = setTextCell(xml, "B3", data.containerNo, strings);
  // 当前系统没有提单号和封条号字段，模板对应业务值保持空白。
  xml = setTextCell(xml, "B5", "", strings);
  xml = setTextCell(xml, "E3", data.origin, strings);
  xml = setTextCell(xml, "E5", data.destination, strings);
  xml = setTextCell(xml, "I3", data.carrierInfo, strings);
  // 当前数据模型没有封条号，原模板的封条号值保持空白。
  xml = setTextCell(xml, "I5", "", strings);
  // “总票数 / 总件数”是整柜汇总；分页后的每一张工作表都显示同一个整柜总数。
  xml = setNumberCell(xml, "L3", new Set(allLines.map((line) => line.trackingNo)).size);
  xml = setNumberCell(xml, "L5", lineTotal(allLines, "packageCount"));
  lines.forEach((line, index) => {
    const row = 10 + index;
    xml = setTextCell(xml, `B${row}`, line.trackingNo, strings);
    // 同客户签收单：品名按实际换行行数撑开行高（2026-09-11）
    xml = setItemNameCell(xml, "C", row, line.itemName, strings, fonts);
    xml = setNumberCell(xml, `D${row}`, line.packageCount);
    xml = setOptionalNumberCell(xml, `E${row}`, line.volumeM3);
    xml = setOptionalNumberCell(xml, `F${row}`, line.weightKg);
    // 数字走数字格，「60/50」这种多尺寸走文本格（塞进数字格会把文件写坏）
    xml = setDimensionCell(xml, `G${row}`, line.lengthCm, strings);
    xml = setDimensionCell(xml, `H${row}`, line.widthCm, strings);
    xml = setDimensionCell(xml, `I${row}`, line.heightCm, strings);
    xml = setTextCell(xml, `J${row}`, line.receiverPhone, strings);
    xml = setTextCell(xml, `L${row}`, line.receiverAddress, strings);
    /**
     * ⚠️ 备注格只放**真备注**（2026-08-29 改，老板反馈）。
     *
     * 原来这里是 `[「唛头：XXX」, 备注].join("；")` —— 唛头被塞进备注格，
     * 于是备注这一列常年只看得到「唛头：XHH6651」，而司机真正要看的
     * 「周一不收货」这类交代要么被挤在唛头后面、要么整格读起来像系统信息。
     * 唛头已经挪到 A 列（原「序列号」那一格），这里就不该再重复一遍。
     */
    xml = setTextCell(xml, `N${row}`, line.remark, strings);
  });
  /**
   * A 列放**唛头**，不再放序列号（2026-08-29 改，老板反馈）。
   *
   * 序列号只是 1、2、3…，看清单的人（司机、仓库）真正要认的是唛头 ——
   * 哪几票是同一个客户的、该一起卸给谁，全靠它。
   * 表头 A9 也要跟着从「序列号」改成「唛头」，否则列名和内容对不上。
   * ⚠️ A9 在模板里，clearRange 只清 10~34 行，所以必须显式写。
   */
  xml = setTextCell(xml, "A9", "唛头", strings);
  lines.forEach((line, index) => {
    xml = setTextCell(xml, `A${10 + index}`, line.clientId && line.clientId !== "未关联客户" ? line.clientId : "", strings);
  });
  xml = setFormulaCell(xml, "E35", "SUM(E10:E34)", lineTotal(lines, "volumeM3"));
  xml = setFormulaCell(xml, "F35", "SUM(F10:F34)", lineTotal(lines, "weightKg"));
  /**
   * ⚠️ 长/宽/高**不做合计** —— 而且必须**动手把模板里那三个 SUM 清掉**（2026-08-28 修）。
   *
   * 把各行的长加起来（60+50+20=130cm）是个没有意义的数，
   * 会被当成「这一柜的总长」误读 —— 件数、方数、重量才该有合计。
   *
   * ⚠️ 上一版这里只写了这段注释、**代码一行没动**，模板自带的
   * `G35=SUM(G10:G34)` / `H35` / `I35` 原样留在导出文件里。
   * 复核用真模板生成、LibreOffice 打开，那三格显示的是 **0** ——
   * 多尺寸时长宽高是文本（"60/50"），SUM 对文本求和就是 0，
   * 等于在客户签收单上印了三个假数。「宁可留空，也不能报错的数」。
   * 现在显式清空这三格（clearRange 会把公式和值一起去掉）。
   */
  xml = clearRange(xml, 35, 35, 7, 9, strings); // G..I 第 35 行
  return xml;
}

function patchCustomerChineseTemplate(
  sheetXml: string,
  strings: SharedStringsEditor,
  fonts: TemplateFonts,
  data: LastmileExportData,
  lines: TemplateLine[],
  sequenceStart: number,
): string {
  const customer = data.customers[0];
  if (!customer) throw new Error("客户派送单没有客户数据");
  const stop = lines[0];
  let xml = clearRange(sheetXml, 6, 15, 1, 8, strings);
  xml = setTextCell(xml, "C3", customer.clientId, strings);
  xml = setTextCell(xml, "H3", stop?.receiverPhone || customer.contactPhone, strings);
  xml = setTextCell(xml, "C4", stop?.receiverAddress || customer.address, strings);
  xml = setTextCell(xml, "A6", customer.clientId, strings);
  lines.forEach((line, index) => {
    const row = 6 + index;
    xml = setNumberCell(xml, `B${row}`, sequenceStart + index + 1);
    xml = setTextCell(xml, `C${row}`, line.trackingNo, strings);
    // 品名一行放不下就把行高撑开（2026-09-11：数据早就全了，是纸上被行高切掉）
    xml = setItemNameCell(xml, "D", row, line.itemName, strings, fonts);
    xml = setNumberCell(xml, `E${row}`, line.packageCount);
    xml = setOptionalNumberCell(xml, `F${row}`, line.volumeM3);
    xml = setOptionalNumberCell(xml, `G${row}`, line.weightKg);
    xml = setTextCell(xml, `H${row}`, line.remark, strings);
  });
  xml = setFormulaCell(xml, "E16", "SUM(E6:E15)", lineTotal(lines, "packageCount"));
  /* 体积、重量合计（2026-08-31 排查报告第 49 条，改法收窄过一次）：
     整页一个值都没填时留空、不印 0——明细格空着、合计栏写 0 自相矛盾还误导客户。
     但有值时必须保留 SUM 活公式（test-lastmile-export 第 12 项盯着这个）：
     客户在 Excel 里改一行数字，合计要跟着变；写死的数就不会变了。 */
  const cnVolTotal = optionalLineTotal(lines, "volumeM3");
  const cnWeightTotal = optionalLineTotal(lines, "weightKg");
  xml = cnVolTotal === null
    ? setOptionalNumberCell(xml, "F16", null)
    : setFormulaCell(xml, "F16", "SUM(F6:F15)", cnVolTotal);
  xml = cnWeightTotal === null
    ? setOptionalNumberCell(xml, "G16", null)
    : setFormulaCell(xml, "G16", "SUM(G6:G15)", cnWeightTotal);
  xml = setTextCell(xml, "H16", "", strings);
  xml = setTextCell(xml, "G18", data.deliveryDate, strings);
  return setTextCell(xml, "G19", [data.driverName, data.phoneNumber].filter(Boolean).join(" / "), strings);
}

function patchCustomerThaiTemplate(
  sheetXml: string,
  strings: SharedStringsEditor,
  fonts: TemplateFonts,
  data: LastmileExportData,
  lines: TemplateLine[],
  sequenceStart: number,
): string {
  const customer = data.customers[0];
  if (!customer) throw new Error("客户派送单没有客户数据");
  const stop = lines[0];
  // 泰文模板 A8:A27 预置了 1..20。必须连序号列一起清空，否则短页/续页的
  // 空白明细行会残留假序号，看起来像还有未填内容的货物。
  let xml = clearRange(sheetXml, 8, 27, 1, 10, strings);
  xml = setTextCell(xml, "C3", customer.clientId, strings);
  xml = setTextCell(xml, "I3", stop?.receiverPhone || customer.contactPhone, strings);
  xml = setTextCell(xml, "C4", stop?.receiverAddress || customer.address, strings);
  lines.forEach((line, index) => {
    const row = 8 + index;
    xml = setNumberCell(xml, `A${row}`, sequenceStart + index + 1);
    xml = setTextCell(xml, `B${row}`, line.clientName, strings);
    xml = setTextCell(xml, `C${row}`, line.clientId, strings);
    // 品名一行放不下就把行高撑开（2026-09-11：数据早就全了，是纸上被行高切掉）
    xml = setItemNameCell(xml, "D", row, line.itemName, strings, fonts);
    xml = setNumberCell(xml, `E${row}`, line.packageCount);
    xml = setOptionalNumberCell(xml, `F${row}`, line.volumeM3);
    xml = setOptionalNumberCell(xml, `G${row}`, line.weightKg);
    xml = setTextCell(xml, `H${row}`, "", strings);
    xml = setTextCell(xml, `I${row}`, line.remark, strings);
    xml = setTextCell(xml, `J${row}`, "", strings);
  });
  xml = setFormulaCell(xml, "E28", "SUM(E8:E27)", lineTotal(lines, "packageCount"));
  // 泰文模板的体积、重量合计原本就是数值单元格，保留原结构，仅改成页内明细合计。
  xml = setOptionalNumberCell(xml, "F28", optionalLineTotal(lines, "volumeM3"));
  xml = setOptionalNumberCell(xml, "G28", optionalLineTotal(lines, "weightKg"));
  for (const ref of ["D28", "H28", "I28", "J28"]) xml = setTextCell(xml, ref, "", strings);
  xml = setTextCell(xml, "B31", data.deliveryDate, strings);
  xml = setTextCell(xml, "E31", stop?.receiverName || customer.contactName, strings);
  xml = setTextCell(xml, "H31", stop?.receiverPhone || customer.contactPhone, strings);
  return xml;
}

type WorksheetClone = {
  name: string;
  xml: string;
};

const WORKSHEET_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const WORKSHEET_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function workbookSheetNames(workbookXml: string): string[] {
  const prefix = xmlPrefix(workbookXml, "sheet");
  const tag = `${prefix}sheet`;
  return [...workbookXml.matchAll(new RegExp(`<${escapeRegExp(tag)}\\b([^>]*)\\/?>`, "g"))]
    .map((match) => /\bname="([^"]*)"/.exec(match[1])?.[1])
    .filter((name): name is string => name != null)
    .map(decodeXmlAttribute);
}

function pageWorksheetName(baseName: string, pageNumber: number, existingNames: Set<string>): string {
  const suffix = `-${pageNumber}`;
  const sanitizedBase = baseName.replace(/[\\/*?:[\]]/g, "_") || "Sheet";
  let candidate = `${sanitizedBase.slice(0, 31 - suffix.length)}${suffix}`;
  let duplicate = 2;
  while (existingNames.has(candidate)) {
    const duplicateSuffix = `${suffix}-${duplicate}`;
    candidate = `${sanitizedBase.slice(0, 31 - duplicateSuffix.length)}${duplicateSuffix}`;
    duplicate += 1;
  }
  existingNames.add(candidate);
  return candidate;
}

function insertBeforeClosingTag(xml: string, localName: string, addition: string): string {
  const tag = `${xmlPrefix(xml, localName)}${localName}`;
  const closingTag = `</${tag}>`;
  if (!xml.includes(closingTag)) throw new Error(`模板格式不符：缺少 ${localName}`);
  return xml.replace(closingTag, `${addition}${closingTag}`);
}

async function appendWorksheetClones(zip: JSZip, originalWorkbookXml: string, clones: WorksheetClone[]): Promise<void> {
  if (clones.length === 0) return;
  const relationshipsPath = "xl/_rels/workbook.xml.rels";
  const contentTypesPath = "[Content_Types].xml";
  const [originalRelationshipsXml, originalContentTypesXml] = await Promise.all([
    zip.file(relationshipsPath)?.async("string"),
    zip.file(contentTypesPath)?.async("string"),
  ]);
  if (!originalRelationshipsXml || !originalContentTypesXml) {
    throw new Error("模板格式不符：缺少工作簿关系或内容类型");
  }

  const existingWorksheetNumbers = Object.keys(zip.files)
    .map((path) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(path)?.[1])
    .filter((value): value is string => value != null)
    .map(Number);
  let nextWorksheetNumber = Math.max(0, ...existingWorksheetNumbers) + 1;
  const existingSheetIds = [...originalWorkbookXml.matchAll(/\bsheetId="(\d+)"/g)].map((match) => Number(match[1]));
  let nextSheetId = Math.max(0, ...existingSheetIds) + 1;
  const existingRelationshipIds = new Set(
    [...originalRelationshipsXml.matchAll(/\bId="([^"]+)"/g)].map((match) => match[1]),
  );
  let relationshipSequence = 1;
  let workbookXml = originalWorkbookXml;
  let relationshipsXml = originalRelationshipsXml;
  let contentTypesXml = originalContentTypesXml;
  const sheetTag = `${xmlPrefix(workbookXml, "sheet")}sheet`;
  const relationshipTag = `${xmlPrefix(relationshipsXml, "Relationship")}Relationship`;
  const overrideTag = `${xmlPrefix(contentTypesXml, "Override")}Override`;

  for (const clone of clones) {
    while (existingRelationshipIds.has(`rIdExport${relationshipSequence}`)) relationshipSequence += 1;
    const relationshipId = `rIdExport${relationshipSequence}`;
    relationshipSequence += 1;
    existingRelationshipIds.add(relationshipId);
    const worksheetPath = `xl/worksheets/sheet${nextWorksheetNumber}.xml`;
    const relationshipTarget = `worksheets/sheet${nextWorksheetNumber}.xml`;
    // 克隆页不能继续保持模板首页的“已选中”状态，否则 Excel 会把多页成组选择，
    // 用户在一页输入签收内容时会同步改到所有选中页。该状态不影响样式或打印结构。
    zip.file(worksheetPath, clone.xml.replace(/\s+tabSelected="1"/g, ""));
    workbookXml = insertBeforeClosingTag(
      workbookXml,
      "sheets",
      `<${sheetTag} name="${escapeXml(clone.name)}" sheetId="${nextSheetId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${relationshipId}"/>`,
    );
    relationshipsXml = insertBeforeClosingTag(
      relationshipsXml,
      "Relationships",
      `<${relationshipTag} Id="${relationshipId}" Type="${WORKSHEET_RELATIONSHIP_TYPE}" Target="${relationshipTarget}"/>`,
    );
    contentTypesXml = insertBeforeClosingTag(
      contentTypesXml,
      "Types",
      `<${overrideTag} PartName="/${worksheetPath}" ContentType="${WORKSHEET_CONTENT_TYPE}"/>`,
    );
    nextWorksheetNumber += 1;
    nextSheetId += 1;
  }

  zip.file("xl/workbook.xml", workbookXml);
  zip.file(relationshipsPath, relationshipsXml);
  zip.file(contentTypesPath, contentTypesXml);

  // 部分模板带扩展属性中的工作表数量/标题清单。克隆后同步元数据，避免包内仍宣称只有首页。
  const appPropertiesPath = "docProps/app.xml";
  const appPropertiesXml = await zip.file(appPropertiesPath)?.async("string");
  if (appPropertiesXml) {
    const sheetNames = [...workbookSheetNames(originalWorkbookXml), ...clones.map((clone) => clone.name)];
    const vectorPrefix = xmlPrefix(appPropertiesXml, "vector");
    const lpstrTag = `${xmlPrefix(appPropertiesXml, "lpstr")}lpstr`;
    const headingTag = `${xmlPrefix(appPropertiesXml, "HeadingPairs")}HeadingPairs`;
    const titlesTag = `${xmlPrefix(appPropertiesXml, "TitlesOfParts")}TitlesOfParts`;
    const vectorTag = `${vectorPrefix}vector`;
    const integerTag = `${xmlPrefix(appPropertiesXml, "i4")}i4`;
    let patched = appPropertiesXml;
    const headingPattern = new RegExp(`(<${escapeRegExp(headingTag)}\\b[^>]*>[\\s\\S]*?<${escapeRegExp(integerTag)}>)(?:-?\\d+)(<\\/${escapeRegExp(integerTag)}>[\\s\\S]*?<\\/${escapeRegExp(headingTag)}>)`);
    patched = patched.replace(headingPattern, `$1${sheetNames.length}$2`);
    const titlesPattern = new RegExp(`(<${escapeRegExp(titlesTag)}\\b[^>]*>\\s*<${escapeRegExp(vectorTag)}\\b)([^>]*)(>)[\\s\\S]*?(<\\/${escapeRegExp(vectorTag)}>\\s*<\\/${escapeRegExp(titlesTag)}>)`);
    const titleItems = sheetNames.map((name) => `<${lpstrTag}>${escapeXml(name)}</${lpstrTag}>`).join("");
    patched = patched.replace(titlesPattern, (_match, opening: string, attributes: string, close: string, ending: string) => {
      const sizedAttributes = /\bsize="\d+"/.test(attributes)
        ? attributes.replace(/\bsize="\d+"/, `size="${sheetNames.length}"`)
        : `${attributes} size="${sheetNames.length}"`;
      return `${opening}${sizedAttributes}${close}${titleItems}${ending}`;
    });
    zip.file(appPropertiesPath, patched);
  }
}

/**
 * 只替换原始 XLSX 压缩包内的业务值；超出单页容量时克隆完整工作表。
 * styles.xml、合并范围、列宽、页边距、打印设置和声明文案使用原模板；仅长品名明细行增高。
 */
export async function buildLastmileTemplateWorkbook(data: LastmileExportData, templateBytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(templateBytes);
  const sharedPath = "xl/sharedStrings.xml";
  const workbookPath = "xl/workbook.xml";
  const [sharedXml, originalWorkbookXml, stylesXml] = await Promise.all([
    zip.file(sharedPath)?.async("string"),
    zip.file(workbookPath)?.async("string"),
    zip.file("xl/styles.xml")?.async("string"),
  ]);
  if (!sharedXml || !originalWorkbookXml) throw new Error("模板格式不符：缺少 sharedStrings.xml 或 workbook.xml");
  const strings = new SharedStringsEditor(sharedXml);
  // 2026-09-15 老板：模板里写死的公司名「新泓瀚」改成「我司」—— 代理的客户也会拿到这张单，不能印我们的公司名。
  // 目前只出现在客户签收单泰文页标题（sheet2!A1，共享字符串第 42 条）。模板文件本身不动，导出时换；
  // 在任何 add() 之前做，只改模板自带的字。
  strings.replaceInOriginal("新泓瀚", "我司");
  const fonts = templateFonts(stylesXml ?? "");
  const sheetNames = workbookSheetNames(originalWorkbookXml);
  const existingSheetNames = new Set(sheetNames);
  const lines = expandTemplateLines(data);
  const clones: WorksheetClone[] = [];
  if (data.scope === "container") {
    const path = "xl/worksheets/sheet1.xml";
    const xml = await zip.file(path)?.async("string");
    if (!xml) throw new Error("整柜模板缺少主工作表");
    const pages = paginate(lines, 25);
    let sequenceStart = 0;
    zip.file(path, patchInternalTemplate(xml, strings, fonts, data, pages[0], sequenceStart, lines));
    sequenceStart += pages[0].length;
    for (let pageIndex = 1; pageIndex < pages.length; pageIndex += 1) {
      clones.push({
        name: pageWorksheetName(sheetNames[0] || "整柜派送清单", pageIndex + 1, existingSheetNames),
        xml: patchInternalTemplate(xml, strings, fonts, data, pages[pageIndex], sequenceStart, lines),
      });
      sequenceStart += pages[pageIndex].length;
    }
  } else {
    const chinesePath = "xl/worksheets/sheet1.xml";
    const thaiPath = "xl/worksheets/sheet2.xml";
    const [rawChineseXml, rawThaiXml] = await Promise.all([zip.file(chinesePath)?.async("string"), zip.file(thaiPath)?.async("string")]);
    if (!rawChineseXml || !rawThaiXml) throw new Error("客户模板缺少中文或泰文工作表");
    // 2026-09-15：去掉底部「请签收后拍照/扫描回传…微信/Line」那句——共享字符串清空 + 引用它的格子删掉。
    // 在打补丁、克隆续页**之前**做，所以每一页中文页、泰文页都没有这句。
    const returnInstruction = strings.blankOriginal(isReturnInstructionText);
    const chineseXml = removeSharedStringCells(rawChineseXml, returnInstruction);
    const thaiXml = removeSharedStringCells(rawThaiXml, returnInstruction);
    const pages = paginateCustomerLines(lines, 10);
    let sequenceStart = 0;
    zip.file(chinesePath, patchCustomerChineseTemplate(chineseXml, strings, fonts, data, pages[0], sequenceStart));
    zip.file(thaiPath, patchCustomerThaiTemplate(thaiXml, strings, fonts, data, pages[0], sequenceStart));
    sequenceStart += pages[0].length;
    for (let pageIndex = 1; pageIndex < pages.length; pageIndex += 1) {
      clones.push(
        {
          name: pageWorksheetName(sheetNames[0] || "客户签收单-中文", pageIndex + 1, existingSheetNames),
          xml: patchCustomerChineseTemplate(chineseXml, strings, fonts, data, pages[pageIndex], sequenceStart),
        },
        {
          name: pageWorksheetName(sheetNames[1] || "客户签收单-泰文", pageIndex + 1, existingSheetNames),
          xml: patchCustomerThaiTemplate(thaiXml, strings, fonts, data, pages[pageIndex], sequenceStart),
        },
      );
      sequenceStart += pages[pageIndex].length;
    }
  }
  await appendWorksheetClones(zip, originalWorkbookXml, clones);
  zip.file(sharedPath, strings.finish());
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

function safeFilePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
}

function downloadBytes(bytes: Uint8Array, filename: string): void {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([buffer], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function fetchTemplate(path: string): Promise<ArrayBuffer> {
  const templateResponse = await fetch(path);
  if (!templateResponse.ok) throw new Error(`导出模板加载失败：${templateResponse.status}`);
  return templateResponse.arrayBuffer();
}

export async function downloadContainerDispatchWorkbook(containerId: string): Promise<void> {
  const data = await fetchContainerExportData(containerId);
  const bytes = await buildLastmileTemplateWorkbook(data, await fetchTemplate(TEMPLATE_PATHS.container));
  downloadBytes(bytes, `${safeFilePart(data.containerNo)}_整柜拆柜派送清单.xlsx`);
}

export async function downloadLastmileCustomerWorkbook(deliveryNo: string, clientId: string): Promise<void> {
  const data = await fetchLastmileCustomerExportData(deliveryNo, clientId);
  const bytes = await buildLastmileTemplateWorkbook(data, await fetchTemplate(TEMPLATE_PATHS.customer));
  downloadBytes(bytes, `${safeFilePart(deliveryNo)}_${safeFilePart(clientId)}_客户派送签收单.xlsx`);
}
