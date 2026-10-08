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
   * 装柜导出原来 products 一直是空数组（柜里放的是分柜后的子运单，
   * 产品行属于原订单，展开会把件数重复算回整票），
   * 结果就是清单上那三列**从来没填过东西**。现在后端在运单这一层直接给尺寸。
   * （2026-10-07 起整张订单都在这一票时会带产品行、按产品展开，见 productLinesKeepTotals；
   *  货拆在几个柜时仍是空数组，走这里的运单级尺寸。）
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
  /**
   * true = 这是分柜后的单，因为整张订单的货都在这一票里才展开了产品行（2026-10-07 加）。
   * 这时每行的方数/重量**不按产品行自己重算**，而是把本票的 volumeM3 / weightKg 按产品分摊 ——
   * 展开前印的是哪个合计，展开后加起来还是哪个（整柜清单上那是实际装柜体积，CLAUDE.md 第 33 条）。
   * 不传 / false：照旧（没分过柜的整票按产品行自己算）。
   */
  productLinesKeepTotals?: boolean;
};

export type LastmileExportCustomer = {
  clientId: string;
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
  /**
   * 这一行来自第几票（整份数据里所有 shipments 的出现顺序，跨客户连续编号，从 0 数，2026-10-07 加）。
   * 一票按产品展开成几行时，这几行的 shipmentIndex 相同 —— 整柜清单和客户签收单都靠它判断「哪几行是同一票」，
   * 好把唛头/运单号等格子合并、整票不跨页、（签收单）序号按票编。按出现顺序编号，不依赖运单号是否唯一。
   * ⚠️ 不能每个客户从 0 重数：上一个客户最后一票和下一个客户第一票会撞号，两票被合并成一格（test-lastmile-export 第 28 项）。
   */
  shipmentIndex: number;
  clientId: string;
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

/** 往 styles.xml 的某个列表（borders / cellXfs）末尾追加条目，并把 count 改成新的总数 */
function appendToStyleList(xml: string, name: string, items: string[], count: number): string {
  const pattern = new RegExp(`(<(?:[A-Za-z_][\\w.-]*:)?${name}\\b)([^>]*)>([\\s\\S]*?)(<\\/(?:[A-Za-z_][\\w.-]*:)?${name}>)`);
  if (!pattern.test(xml)) throw new Error(`模板格式不符：样式表缺少 ${name}`);
  return xml.replace(pattern, (_match, open: string, attributes: string, body: string, close: string) => {
    const counted = /\bcount="\d+"/.test(attributes) ? attributes.replace(/\bcount="\d+"/, `count="${count}"`) : `${attributes} count="${count}"`;
    return `${open}${counted}>${body}${items.join("")}${close}`;
  });
}

/**
 * styles.xml 编辑器：按需克隆出「去掉某几条边框 / 换底色」的单元格样式（2026-10-07）。
 *
 * 为什么要有：模板的格子大多四周都是细边框，合并以后，块里面那些格子之间的边还留在文件里。
 * Excel、苹果预览会把合并块里面的边藏起来，可老板用的看表软件照画 —— 合并格中间一条线，跟没合并一样
 * （2026-10-07：「并没有真的实现合并，因为我发现还有一条线」，接着又指出表头柜号那几格「也还是不合并状态」）。
 * 做法：把合并区域里面那几条边从格子的样式上真正去掉（见 clearMergedInteriorBorders，那里写了取舍：
 *   「每格各画各的」和「只按左上角画整块框」两类软件没法同时照顾，按老板在用的前一类来）。
 *
 * ⚠️ 只在末尾追加、不改原有条目：单元格是按「第几个样式」引用的，改原来的会连带改掉模板别处的格子。
 *    去不去都一样的（那条边本来就没有）不克隆，原样返回。
 */
const BORDER_EDGES = ["left", "right", "top", "bottom"] as const;
type BorderEdge = (typeof BORDER_EDGES)[number];

class CellStyleEditor {
  private readonly prefix: string;
  private readonly borders: string[];
  private readonly xfs: string[];
  private readonly addedBorders: string[] = [];
  private readonly addedXfs: string[] = [];
  private readonly cache = new Map<string, number>();
  /** 同一条原边框去掉同样的边，只追加一次（好几个样式共用 borderId=1） */
  private readonly borderCache = new Map<string, number>();

  constructor(private readonly xml: string) {
    this.prefix = xmlPrefix(xml, "styleSheet");
    const p = escapeRegExp(this.prefix);
    this.borders = [...xmlBlock(xml, "borders").matchAll(new RegExp(`<${p}border\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${p}border>)`, "g"))].map((m) => m[0]);
    this.xfs = [...xmlBlock(xml, "cellXfs").matchAll(new RegExp(`<${p}xf\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${p}xf>)`, "g"))].map((m) => m[0]);
  }

  /** 第 index 号样式（模板原有的或这次追加的；补格子算出的新样式会被再处理一次，必须查得到 —— 复核实测会崩） */
  private xfAt(index: number): string | undefined {
    return index < this.xfs.length ? this.xfs[index] : this.addedXfs[index - this.xfs.length];
  }

  private borderAt(index: number): string | undefined {
    return index < this.borders.length ? this.borders[index] : this.addedBorders[index - this.borders.length];
  }

  /** 第 style 号样式的底色（fillId）；样式不存在当 0（没有底色） */
  fillIdOf(style: number): number {
    return Number(/\bfillId="(\d+)"/.exec(this.xfAt(style) ?? "")?.[1] ?? 0);
  }

  /**
   * 跟 style 一模一样、只是去掉 drop 里那几条边、（给了 fillId 时）底色换成 fillId 的样式下标；同一种要求只克隆一次。
   * 跟原样式没区别时（边本来就没画、底色本来就一样）不克隆，直接返回原样式。
   */
  restyle(style: number, drop: ReadonlySet<BorderEdge>, fillId?: number): number {
    const edges = BORDER_EDGES.filter((edge) => drop.has(edge));
    const xf = this.xfAt(style);
    if (!xf) throw new Error(`模板格式不符：找不到第 ${style} 号单元格样式`);
    const fillChanges = fillId !== undefined && fillId !== this.fillIdOf(style);
    if (edges.length === 0 && !fillChanges) return style;
    const key = `${style}:${edges.join(",")}:${fillChanges ? fillId : ""}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const borderId = Number(/\bborderId="(\d+)"/.exec(xf)?.[1] ?? 0);
    const borderKey = `${borderId}:${edges.join(",")}`;
    let newBorderId = this.borderCache.get(borderKey);
    if (newBorderId === undefined) {
      const original = this.borderAt(borderId);
      if (!original) throw new Error(`模板格式不符：找不到第 ${borderId} 号边框`);
      const p = escapeRegExp(this.prefix);
      let border = original;
      for (const edge of edges) {
        border = border.replace(new RegExp(`<${p}${edge}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${p}${edge}>)`), `<${this.prefix}${edge}/>`);
      }
      // 去完边以后跟已有的某条一模一样（模板原有的或刚追加的）就直接用它，不再追加重复条目
      const existing = this.borders.indexOf(border);
      const added = this.addedBorders.indexOf(border);
      if (existing >= 0) {
        newBorderId = existing;
      } else if (added >= 0) {
        newBorderId = this.borders.length + added;
      } else {
        newBorderId = this.borders.length + this.addedBorders.length;
        this.addedBorders.push(border);
      }
      this.borderCache.set(borderKey, newBorderId);
    }
    if (newBorderId === borderId && !fillChanges) {
      this.cache.set(key, style);
      return style;
    }
    const setAttribute = (element: string, name: string, value: string): string => (
      new RegExp(`\\b${name}="[^"]*"`).test(element)
        ? element.replace(new RegExp(`\\b${name}="[^"]*"`), `${name}="${value}"`)
        : element.replace(/^<([\w.:-]+)/, `<$1 ${name}="${value}"`)
    );
    let clone = xf;
    if (newBorderId !== borderId) clone = setAttribute(setAttribute(clone, "borderId", String(newBorderId)), "applyBorder", "1");
    if (fillChanges) clone = setAttribute(setAttribute(clone, "fillId", String(fillId)), "applyFill", "1");
    const index = this.xfs.length + this.addedXfs.length;
    this.addedXfs.push(clone);
    this.cache.set(key, index);
    return index;
  }

  finish(): string {
    if (this.addedXfs.length === 0) return this.xml;
    const withBorders = appendToStyleList(this.xml, "borders", this.addedBorders, this.borders.length + this.addedBorders.length);
    return appendToStyleList(withBorders, "cellXfs", this.addedXfs, this.xfs.length + this.addedXfs.length);
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
 * 行本身、行高、合并区域（A55:H55 / A64:J64）都不动（test-dispatch-wrap 第 4 项比对行高 / 打印设置；
 * 一票一行时合并区域也跟模板一样）。2026-10-07 起样式表会在末尾追加「合并格去线、统一底色」用的样式
 * （见 clearMergedInteriorBorders）：A55 删掉后左上角没有格子，这一条合并格整条就是没有底色，跟 Excel 显示一致。
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
  const index = columnNumber(column);
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

/**
 * 把一票的合计按占比分给它的各个产品行（2026-10-07 加，给 productLinesKeepTotals 用）。
 *
 * 累计取整：各行加起来**严格等于**合计，不会因为每行各自四舍五入多出或少掉 0.001。
 * preferred 是首选占比（方数用「件数×长×宽×高」、重量用「件数×单件重」），
 * 有一行缺了（null / 不大于 0）就整票退回按件数分 —— 两种口径混着用会把占比算歪。
 * 件数为 0 的行本来就分不到东西，不拿它去否决整票。
 */
function allocateTotal(total: number, preferred: Array<number | null>, pieces: number[], digits: number): number[] {
  const usable = (value: number | null): value is number => value != null && Number.isFinite(value) && value > 0;
  const preferredOk = preferred.every((value, index) => pieces[index] <= 0 || usable(value));
  const shares = preferred.map((value, index) => (pieces[index] <= 0 ? 0 : (preferredOk ? Number(value) : pieces[index])));
  const shareSum = shares.reduce((sum, share) => sum + share, 0);
  const factor = 10 ** digits;
  const totalUnits = Math.round(total * factor);
  let cumulative = 0;
  let allocated = 0;
  return shares.map((share, index) => {
    cumulative += share;
    const target = shareSum > 0
      ? Math.round((totalUnits * cumulative) / shareSum)
      : (index === shares.length - 1 ? totalUnits : 0);
    const units = target - allocated;
    allocated = target;
    return units / factor;
  });
}

/** 导出给自测脚本用（scripts/test-lastmile-export.ts）—— 这一层是纯计算，不碰网络不碰 DOM */
export function expandTemplateLines(data: LastmileExportData): TemplateLine[] {
  const lines: TemplateLine[] = [];
  let shipmentIndex = -1;
  for (const customer of data.customers) {
    for (const shipment of customer.shipments) {
      shipmentIndex += 1;
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
      /**
       * 分柜单展开的产品行（productLinesKeepTotals）：方数/重量**只分摊、不重算**（2026-10-07）。
       * 本票合计是后端算好的（整柜清单上是实际装柜体积），展开成几行后加起来必须还是它，
       * 否则同一票货在清单上和系统里是两个数。方数保留 3 位、重量 2 位，跟数据库存的位数一致。
       */
      const keepTotals = !usingFallback && shipment.productLinesKeepTotals === true;
      const pieces = products.map((product) => Number(product.packageCount || 0));
      const keptVolumes = keepTotals && shipment.volumeM3 != null
        ? allocateTotal(
          Number(shipment.volumeM3),
          products.map((product, index) => (
            typeof product.lengthCm === "number" && typeof product.widthCm === "number" && typeof product.heightCm === "number"
              ? pieces[index] * product.lengthCm * product.widthCm * product.heightCm
              : null
          )),
          pieces,
          3,
        )
        : null;
      const keptWeights = keepTotals && shipment.weightKg != null
        ? allocateTotal(
          Number(shipment.weightKg),
          products.map((product, index) => (product.weightKg == null ? null : pieces[index] * Number(product.weightKg))),
          pieces,
          2,
        )
        : null;
      products.forEach((product, index) => {
        const share = Number(product.packageCount || 0) / packageTotal;
        // ⚠️ shipment.volumeM3 可能是 null（这票货没填）。`null * share` 在 JS 里等于 0，
        // 直接算就会把「没填」变成「0 方」，所以必须先判空。重量同理。
        // 尺寸现在可能是「60/50」这种字符串，拿它做乘法会得到 NaN —— 只有三个都是数字才重算
        const dimsAreNumbers =
          typeof product.lengthCm === "number" &&
          typeof product.widthCm === "number" &&
          typeof product.heightCm === "number";
        const volume = keepTotals
          ? (keptVolumes ? keptVolumes[index] : null)
          : (!usingFallback && dimsAreNumbers && product.lengthCm && product.widthCm && product.heightCm
            ? Number(product.packageCount || 0) * Number(product.lengthCm) * Number(product.widthCm) * Number(product.heightCm) / 1_000_000
            : (shipment.volumeM3 == null ? null : Number(shipment.volumeM3) * share));
        const weight = keepTotals
          ? (keptWeights ? keptWeights[index] : null)
          : (product.weightKg == null
            ? (shipment.weightKg == null ? null : Number(shipment.weightKg) * share)
            : Number(product.weightKg) * Number(product.packageCount || 0));
        const receiverName = shipment.receiverName || customer.contactName;
        const phone = shipment.receiverPhone || customer.contactPhone;
        const address = shipment.receiverAddress || customer.address;
        lines.push({
          shipmentIndex,
          clientId: customer.clientId,
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

/** 把连续的、同一票（shipmentIndex 相同）的行分成一组 */
function groupByShipment(lines: TemplateLine[]): TemplateLine[][] {
  const groups: TemplateLine[][] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && last[0].shipmentIndex === line.shipmentIndex) last.push(line);
    else groups.push([line]);
  }
  return groups;
}

/**
 * 分页：一票的几行**不拆到两页**（2026-10-07，老板：参考仓库装柜表，一票的唛头/运单号合并成一格；整柜清单和客户签收单都用）。
 *
 * 合并格子不能跨工作表，原来按 25 行硬切会把「驱蚊饼 / 挂帽架」这种一票两行切到两页，
 * 司机翻页才看得到同一票的另一半。现在这一页放不下整票就整票挪到下一页（本页留空行）。
 * 一票自己就超过一页（> pageSize 行）时没法不拆，只能按页切开，每页各自合并。
 * 每票只有一行时，跟原来每满 pageSize 行切一刀的分法结果完全一样。
 */
function paginateKeepingShipments(lines: TemplateLine[], pageSize: number): TemplateLine[][] {
  if (lines.length === 0) return [[]];
  const pages: TemplateLine[][] = [];
  let current: TemplateLine[] = [];
  for (const group of groupByShipment(lines)) {
    if (current.length > 0 && current.length + group.length > pageSize) {
      pages.push(current);
      current = [];
    }
    let rest = group;
    while (current.length + rest.length > pageSize) {
      const room = pageSize - current.length;
      pages.push([...current, ...rest.slice(0, room)]);
      current = [];
      rest = rest.slice(room);
    }
    current.push(...rest);
  }
  if (current.length > 0) pages.push(current);
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
  // 同一票的几行不拆到两页（2026-10-07，同整柜清单，见 paginateKeepingShipments）；同一票的收货人/地址相同，一定在同一个站点组里
  return [...stops.values()].flatMap((stopLines) => paginateKeepingShipments(stopLines, pageSize));
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

/**
 * 整柜清单里「属于这一票」的列（2026-10-07，老板：参考仓库装柜表）。
 * 仓库表里一票几个产品时，日期/唛头/运单号竖着合并成一格，产品各占一行；这里照做：
 * 唛头、运单号、电话、地址、备注是这一票的，合并；品名、件数、方数、重量、长宽高是产品的，每行各一格。
 */
const SHIPMENT_MERGE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["A", "A"], // 唛头
  ["B", "B"], // 运单号
  ["J", "K"], // 收件人电话（模板里每行本来就是 J:K 横向合并）
  ["L", "M"], // 收件人地址（模板里每行本来就是 L:M 横向合并）
  ["N", "N"], // 备注
];

/**
 * 客户签收单里「属于这一票」的列（2026-10-07，老板：客户签收单也「合并去线」）。
 * 中文页：B 序号、C 单号、H 备注（A 列唛头模板里本来就整列 A6:A15 合并）；
 * 泰文页：A 序号、B 客户（印唛头）、C 唛头、I 备注。
 * 品名/件数/体积/重量每个产品一格；泰文页 H「สภาพบรรจุ（包装状况）」和 J（5 个字宽的空列）是给收货人逐行手写/打勾的，也保留每行一格。
 */
const CUSTOMER_CN_SHIPMENT_COLUMNS: ReadonlyArray<readonly [string, string]> = [["B", "B"], ["C", "C"], ["H", "H"]];
const CUSTOMER_TH_SHIPMENT_COLUMNS: ReadonlyArray<readonly [string, string]> = [["A", "A"], ["B", "B"], ["C", "C"], ["I", "I"]];

/**
 * 这一格要不要写值（2026-10-07）：同一票合并的列（columns）只在这一票本页的第一行写，下面几行留给合并。
 * 规则从 columns 推出来，跟 mergeShipmentRows 用的是同一份清单。
 * 不写而不是写了再清：写过的字会留在共享字符串表里成为没人引用的垃圾。
 */
function shipmentCellWriter(lines: TemplateLine[], columns: ReadonlyArray<readonly [string, string]>): (column: string, index: number) => boolean {
  const merged = new Set(columns.flatMap(([from, to]) => {
    const names: string[] = [];
    for (let column = columnNumber(from); column <= columnNumber(to); column += 1) names.push(columnName(column));
    return names;
  }));
  return (column, index) => !merged.has(column) || index === 0 || lines[index - 1].shipmentIndex !== lines[index].shipmentIndex;
}

/** 本页每一票占哪几行（firstRow 是本页第一条明细所在的行） */
function shipmentBlocks(lines: TemplateLine[], firstRow: number): Array<{ firstRow: number; lastRow: number }> {
  let row = firstRow;
  return groupByShipment(lines).map((group) => {
    const block = { firstRow: row, lastRow: row + group.length - 1 };
    row += group.length;
    return block;
  });
}

type CellRange = { c1: number; r1: number; c2: number; r2: number };

function columnNumber(column: string): number {
  return column.split("").reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
}

function parseRange(ref: string): CellRange | null {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(ref);
  if (!m) return null;
  const c1 = columnNumber(m[1]);
  const r1 = Number(m[2]);
  const c2 = m[3] ? columnNumber(m[3]) : c1;
  const r2 = m[4] ? Number(m[4]) : r1;
  return { c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) };
}

function rangesOverlap(a: CellRange, b: CellRange): boolean {
  return a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2;
}

function rangeContains(outer: CellRange, inner: CellRange): boolean {
  return outer.c1 <= inner.c1 && inner.c2 <= outer.c2 && outer.r1 <= inner.r1 && inner.r2 <= outer.r2;
}

/** 工作表里现有的全部合并区域（ref 原文），按出现顺序 */
function mergeRefsOf(sheetXml: string): string[] {
  return [...sheetXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?mergeCell\b[^>]*?\bref="([^"]+)"/g)].map((match) => match[1]);
}

/**
 * 往工作表里加合并区域（2026-10-07）。
 *
 * 被新区域整个包住的旧合并（如明细行每行的 J:K、L:M）先删掉再加 —— 留着就是重叠合并，Excel 打开报「文件已损坏」。
 * 包不住以外的旧合并一个不动；跟新区域「交叉但没被包住」的直接报错，宁可导不出也不出一张错乱的表。
 * refs 为空时原样返回（mergeShipmentRows 遇到全是一行的票就是这样；整柜清单另外还会补表头 C3:C4、C5:C6，见 addMissingHeaderMerges）。
 */
function addMergeRanges(sheetXml: string, refs: string[]): string {
  if (refs.length === 0) return sheetXml;
  const tag = `${xmlPrefix(sheetXml, "mergeCells")}mergeCells`;
  const cellTag = `${xmlPrefix(sheetXml, "mergeCell")}mergeCell`;
  const pattern = new RegExp(`<${escapeRegExp(tag)}\\b([^>]*)>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`);
  const found = pattern.exec(sheetXml);
  if (!found) throw new Error("模板格式不符：工作表缺少合并区域（mergeCells）");
  const addedRanges = refs.map((ref) => parseRange(ref) as CellRange);
  const existing = [...found[2].matchAll(new RegExp(`<${escapeRegExp(cellTag)}\\b[^>]*?\\bref="([^"]+)"[^>]*?\\/>`, "g"))];
  const declared = (found[2].match(new RegExp(`<${escapeRegExp(cellTag)}\\b`, "g")) ?? []).length;
  if (existing.length !== declared) throw new Error("模板格式不符：合并区域写法认不出来");
  const kept: string[] = [];
  for (const [element, ref] of existing) {
    const range = parseRange(ref);
    const covering = range ? addedRanges.find((candidate) => rangesOverlap(candidate, range)) : undefined;
    if (!covering) {
      kept.push(element);
      continue;
    }
    if (!rangeContains(covering, range as CellRange)) throw new Error(`模板格式不符：合并区域 ${ref} 跟同一票的合并交叉`);
  }
  const items = [...kept, ...refs.map((ref) => `<${cellTag} ref="${ref}"/>`)];
  const attributes = /\bcount="\d+"/.test(found[1])
    ? found[1].replace(/\bcount="\d+"/, `count="${items.length}"`)
    : `${found[1]} count="${items.length}"`;
  return sheetXml.replace(pattern, () => `<${tag}${attributes}>${items.join("")}</${tag}>`);
}

/**
 * 同一票占了 firstRow..lastRow 几行时，把这一票的列（columns）竖着合并（2026-10-07）；只有一行的票不合并。
 * 合并以后这几列只留这一票第一行的值 —— 写值时已经按 shipmentCellWriter 跳过了下面几行（同一份 columns），
 * 明细区写值前又整块清空过，所以被合并的格子里不会藏着重复值。
 */
function mergeShipmentRows(
  sheetXml: string,
  blocks: Array<{ firstRow: number; lastRow: number }>,
  columns: ReadonlyArray<readonly [string, string]>,
): string {
  const refs = blocks
    .filter((block) => block.lastRow > block.firstRow)
    .flatMap(({ firstRow, lastRow }) => columns.map(([from, to]) => `${from}${firstRow}:${to}${lastRow}`));
  return addMergeRanges(sheetXml, refs);
}

/**
 * 整柜清单表头漏合并的两格（2026-10-07，老板截图：柜号那一片「也还是不合并状态」）。
 * 模板第 3~4、5~6 行别的列都是上下两格合并（A3:A4 柜号、B3:B4 柜号值、D3:D4 起运地…），唯独 C 列是四个独立的空格子，
 * 每格四周都有边框 —— 柜号右边那格中间一条线，Excel 里也看得见。导出时补上，跟左右列一致。
 * 模板哪天自己合并了（或改成别的合并跟它交叉）就不动；格子里有字也不动（合并会把下半格的字藏起来）。
 */
const HEADER_MISSING_MERGES = ["C3:C4", "C5:C6"];

function addMissingHeaderMerges(sheetXml: string): string {
  const existing = mergeRefsOf(sheetXml).map(parseRange).filter((range): range is CellRange => range != null);
  // 只看这一个格子自己：自封闭的 <c r="C4" s="8"/> 就是空的；有 <v> / <is> / <f> 才算有字
  const cellHasValue = (ref: string): boolean => {
    const match = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?c\\b[^>]*?\\br="${ref}"[^>]*?(\\/>|>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?c>)`).exec(sheetXml);
    return Boolean(match && match[1] !== "/>" && /<(?:[A-Za-z_][\w.-]*:)?(?:v|is|f)\b/.test(match[2] ?? ""));
  };
  const refs = HEADER_MISSING_MERGES.filter((ref) => {
    const range = parseRange(ref) as CellRange;
    if (existing.some((other) => rangesOverlap(other, range))) return false;
    for (let row = range.r1 + 1; row <= range.r2; row += 1) {
      for (let column = range.c1; column <= range.c2; column += 1) if (cellHasValue(`${columnName(column)}${row}`)) return false;
    }
    return true;
  });
  return addMergeRanges(sheetXml, refs);
}

/**
 * 去掉工作表里**每一个**合并区域里面的边框，只留合并区域外面一圈（2026-10-07，原因见 CellStyleEditor）。
 *
 * 合并区域里每个格子：不在第一行的去上边框、不在最后一行的去下边框、不在第一列的去左边框、不在最后一列的去右边框；
 * 底色统一成左上角那一格的（泰文签收单明细是隔行浅蓝底色，合并块里不统一的话，逐格画的软件里会出现深浅横条，
 * 看着跟中间一条线差不多 —— 复核指出）。Excel 显示合并格本来就用左上角那格的底色，所以 Excel 里看不出变化。
 * 带底色的合并区域里模板缺的格子先补上（fillMissingMergedCells），不然整行横幅只涂得到 A 那一格。
 * 管的不只是这次新加的「同一票」合并块 —— 模板自带的合并（表头柜号/起运地/标题、签收单的标题/地址/签字栏…）在老板的看表软件里一样被线切开
 * （他截图指出表头「也还是不合并状态」）。Excel 本来就不画合并区域里面的边，所以 Excel 里合并格的样子不变；
 * 本来就没有内部边的合并（如明细行的 J:K）一个字不动。产品那几列不在合并区域里，行与行之间的线照旧。
 *
 * 整柜清单和客户签收单都用（客户签收单 2026-10-07 老板定的：「合并去线」）。
 * ⚠️ 少数看表软件只按合并区域左上角那一格画整块的框，这种软件里去掉左上格的右/下边后，
 *    合并区域靠右/靠下、外面又没有相邻格子补线的那条外框会看不到（如标题 A1:N2 的右边）。两类软件没法同时照顾，
 *    这里按老板实际在用的那类（每格各画各的）来。
 *
 * 一遍扫完整张表（不对每个格子各编一次正则、各扫一次全文 —— 50 页的单子会慢好几秒）。
 */
/**
 * 给「带底色的合并区域」补上模板里缺的格子（2026-10-07，复核指出）。
 * 客户签收单模板是稀疏写法：「重要声明」「签字即代表…」这种整行横幅（深红底白字）只有 A 列那一格，B..H 根本没有 <c>。
 * Excel 按左上角那格把整条横幅涂满；逐格画的软件只涂 A 那一格，后面白底、白字看不见。
 * 补的格子：底色跟左上角一样、不带任何边框（Excel 里那些位置本来就没有格子、没有边），值留空。
 * 左上角没有底色的合并不补（补了也是白格子，没区别）；那一行压根没有 <row> 的也不补（现有模板没有这种情况）。
 */
function fillMissingMergedCells(sheetXml: string, styles: CellStyleEditor): string {
  const cellTag = `${xmlPrefix(sheetXml, "c")}c`;
  const rowTag = `${xmlPrefix(sheetXml, "row")}row`;
  const styleByRef = new Map<string, number>();
  for (const match of sheetXml.matchAll(new RegExp(`<${escapeRegExp(cellTag)}\\b([^>]*?)\\s*\\/?>`, "g"))) {
    const ref = /\br="([A-Z]+\d+)"/.exec(match[1])?.[1];
    if (ref) styleByRef.set(ref, Number(/\bs="(\d+)"/.exec(match[1])?.[1] ?? 0));
  }
  const missingByRow = new Map<number, Array<{ column: number; style: number }>>();
  for (const ref of mergeRefsOf(sheetXml)) {
    const range = parseRange(ref);
    if (!range) continue;
    const topLeft = styleByRef.get(`${columnName(range.c1)}${range.r1}`);
    if (topLeft === undefined || styles.fillIdOf(topLeft) === 0) continue;
    const blank = styles.restyle(topLeft, new Set(BORDER_EDGES));
    for (let row = range.r1; row <= range.r2; row += 1) {
      for (let column = range.c1; column <= range.c2; column += 1) {
        if (styleByRef.has(`${columnName(column)}${row}`)) continue;
        const list = missingByRow.get(row) ?? [];
        list.push({ column, style: blank });
        missingByRow.set(row, list);
      }
    }
  }
  if (missingByRow.size === 0) return sheetXml;
  const cellElement = new RegExp(`<${escapeRegExp(cellTag)}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${escapeRegExp(cellTag)}>)`, "g");
  return sheetXml.replace(
    new RegExp(`<${escapeRegExp(rowTag)}\\b([^>]*?\\br="(\\d+)"[^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${escapeRegExp(rowTag)}>)`, "g"),
    (whole, attributes: string, rowNumber: string, body: string | undefined) => {
      const missing = missingByRow.get(Number(rowNumber));
      if (!missing) return whole;
      const cells = [...(body ?? "").matchAll(cellElement)].map((match) => ({
        column: columnNumber(/\br="([A-Z]+)\d+"/.exec(match[0])?.[1] ?? "A"),
        xml: match[0],
      }));
      for (const { column, style } of missing) cells.push({ column, xml: `<${cellTag} r="${columnName(column)}${rowNumber}" s="${style}"/>` });
      cells.sort((x, y) => x.column - y.column);
      // 行上写了 spans（这一行格子的列范围，优化提示）的，扩到覆盖补上的格子，免得跟实际格子对不上
      const widened = attributes.replace(/\bspans="(\d+):(\d+)"/, (_match, from: string, to: string) =>
        `spans="${Math.min(Number(from), cells[0].column)}:${Math.max(Number(to), cells[cells.length - 1].column)}"`);
      return `<${rowTag}${widened.replace(/\s+$/, "")}>${cells.map((cell) => cell.xml).join("")}</${rowTag}>`;
    },
  );
}

function clearMergedInteriorBorders(rawSheetXml: string, styles: CellStyleEditor): string {
  const sheetXml = fillMissingMergedCells(rawSheetXml, styles);
  const tag = `${xmlPrefix(sheetXml, "c")}c`;
  const cellPatternAll = new RegExp(`<${escapeRegExp(tag)}\\b([^>]*?)(\\s*\\/?)>`, "g");
  const styleByRef = new Map<string, number>();
  for (const match of sheetXml.matchAll(cellPatternAll)) {
    const ref = /\br="([A-Z]+\d+)"/.exec(match[1])?.[1];
    if (ref) styleByRef.set(ref, Number(/\bs="(\d+)"/.exec(match[1])?.[1] ?? 0));
  }
  const planByRef = new Map<string, { drop: Set<BorderEdge>; fillId: number }>();
  for (const ref of mergeRefsOf(sheetXml)) {
    const range = parseRange(ref);
    if (!range) continue;
    // 底色跟左上角那格走（Excel 显示合并格就是用左上角那格的样式）；左上角那格不存在就是没有底色
    const fillId = styles.fillIdOf(styleByRef.get(`${columnName(range.c1)}${range.r1}`) ?? 0);
    for (let row = range.r1; row <= range.r2; row += 1) {
      for (let column = range.c1; column <= range.c2; column += 1) {
        const drop = new Set<BorderEdge>();
        if (row > range.r1) drop.add("top");
        if (row < range.r2) drop.add("bottom");
        if (column > range.c1) drop.add("left");
        if (column < range.c2) drop.add("right");
        planByRef.set(`${columnName(column)}${row}`, { drop, fillId });
      }
    }
  }
  if (planByRef.size === 0) return sheetXml;
  return sheetXml.replace(cellPatternAll, (whole, attributes: string, closing: string) => {
    const ref = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
    const plan = ref ? planByRef.get(ref) : undefined;
    if (!plan) return whole;
    const style = Number(/\bs="(\d+)"/.exec(attributes)?.[1] ?? 0);
    const next = styles.restyle(style, plan.drop, plan.fillId);
    if (next === style) return whole;
    return `<${tag}${attributes.replace(/\s+s="\d+"/, "")} s="${next}"${closing}>`;
  });
}

function patchInternalTemplate(
  sheetXml: string,
  strings: SharedStringsEditor,
  styles: CellStyleEditor,
  fonts: TemplateFonts,
  data: LastmileExportData,
  lines: TemplateLine[],
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
  // 唛头/运单号/电话/地址/备注只写在这一票的第一行，下面几行留给合并（SHIPMENT_MERGE_COLUMNS，2026-10-07）
  const writes = shipmentCellWriter(lines, SHIPMENT_MERGE_COLUMNS);
  lines.forEach((line, index) => {
    const row = 10 + index;
    if (writes("B", index)) xml = setTextCell(xml, `B${row}`, line.trackingNo, strings);
    // 同客户签收单：品名按实际换行行数撑开行高（2026-09-11）
    xml = setItemNameCell(xml, "C", row, line.itemName, strings, fonts);
    xml = setNumberCell(xml, `D${row}`, line.packageCount);
    xml = setOptionalNumberCell(xml, `E${row}`, line.volumeM3);
    xml = setOptionalNumberCell(xml, `F${row}`, line.weightKg);
    // 数字走数字格，「60/50」这种多尺寸走文本格（塞进数字格会把文件写坏）
    xml = setDimensionCell(xml, `G${row}`, line.lengthCm, strings);
    xml = setDimensionCell(xml, `H${row}`, line.widthCm, strings);
    xml = setDimensionCell(xml, `I${row}`, line.heightCm, strings);
    if (writes("J", index)) xml = setTextCell(xml, `J${row}`, line.receiverPhone, strings);
    if (writes("L", index)) xml = setTextCell(xml, `L${row}`, line.receiverAddress, strings);
    /**
     * ⚠️ 备注格只放**真备注**（2026-08-29 改，老板反馈）。
     *
     * 原来这里是 `[「唛头：XXX」, 备注].join("；")` —— 唛头被塞进备注格，
     * 于是备注这一列常年只看得到「唛头：XHH6651」，而司机真正要看的
     * 「周一不收货」这类交代要么被挤在唛头后面、要么整格读起来像系统信息。
     * 唛头已经挪到 A 列（原「序列号」那一格），这里就不该再重复一遍。
     */
    if (writes("N", index)) xml = setTextCell(xml, `N${row}`, line.remark, strings);
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
    if (writes("A", index)) xml = setTextCell(xml, `A${10 + index}`, line.clientId && line.clientId !== "未关联客户" ? line.clientId : "", strings);
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
  const merged = mergeShipmentRows(xml, shipmentBlocks(lines, 10), SHIPMENT_MERGE_COLUMNS);
  return clearMergedInteriorBorders(addMissingHeaderMerges(merged), styles);
}

/**
 * 客户签收单的序号按「票」编（2026-10-07）：一票展开成几行时这几行合并成一个序号，下一票接着往下数，跨页连续。
 * 按页面上出现的先后编号（多地址时先按站点分组，顺序可能跟数据里不同）。
 */
function shipmentNumbers(pages: TemplateLine[][]): Map<number, number> {
  const numbers = new Map<number, number>();
  for (const line of pages.flat()) if (!numbers.has(line.shipmentIndex)) numbers.set(line.shipmentIndex, numbers.size + 1);
  return numbers;
}

function patchCustomerChineseTemplate(
  sheetXml: string,
  strings: SharedStringsEditor,
  styles: CellStyleEditor,
  fonts: TemplateFonts,
  data: LastmileExportData,
  lines: TemplateLine[],
  numbers: Map<number, number>,
): string {
  const customer = data.customers[0];
  if (!customer) throw new Error("客户派送单没有客户数据");
  const stop = lines[0];
  let xml = clearRange(sheetXml, 6, 15, 1, 8, strings);
  xml = setTextCell(xml, "C3", customer.clientId, strings);
  xml = setTextCell(xml, "H3", stop?.receiverPhone || customer.contactPhone, strings);
  xml = setTextCell(xml, "C4", stop?.receiverAddress || customer.address, strings);
  xml = setTextCell(xml, "A6", customer.clientId, strings);
  const writes = shipmentCellWriter(lines, CUSTOMER_CN_SHIPMENT_COLUMNS);
  lines.forEach((line, index) => {
    const row = 6 + index;
    // 序号、单号、备注是这一票的：只写在这一票的第一行，下面几行留给合并（CUSTOMER_CN_SHIPMENT_COLUMNS）
    if (writes("B", index)) xml = setNumberCell(xml, `B${row}`, numbers.get(line.shipmentIndex) ?? 0);
    if (writes("C", index)) xml = setTextCell(xml, `C${row}`, line.trackingNo, strings);
    // 品名一行放不下就把行高撑开（2026-09-11：数据早就全了，是纸上被行高切掉）
    xml = setItemNameCell(xml, "D", row, line.itemName, strings, fonts);
    xml = setNumberCell(xml, `E${row}`, line.packageCount);
    xml = setOptionalNumberCell(xml, `F${row}`, line.volumeM3);
    xml = setOptionalNumberCell(xml, `G${row}`, line.weightKg);
    if (writes("H", index)) xml = setTextCell(xml, `H${row}`, line.remark, strings);
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
  xml = setTextCell(xml, "G19", [data.driverName, data.phoneNumber].filter(Boolean).join(" / "), strings);
  return clearMergedInteriorBorders(mergeShipmentRows(xml, shipmentBlocks(lines, 6), CUSTOMER_CN_SHIPMENT_COLUMNS), styles);
}

function patchCustomerThaiTemplate(
  sheetXml: string,
  strings: SharedStringsEditor,
  styles: CellStyleEditor,
  fonts: TemplateFonts,
  data: LastmileExportData,
  lines: TemplateLine[],
  numbers: Map<number, number>,
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
  const writes = shipmentCellWriter(lines, CUSTOMER_TH_SHIPMENT_COLUMNS);
  lines.forEach((line, index) => {
    const row = 8 + index;
    // 序号、客户、唛头、备注是这一票的：只写在这一票的第一行，下面几行留给合并（CUSTOMER_TH_SHIPMENT_COLUMNS）
    if (writes("A", index)) xml = setNumberCell(xml, `A${row}`, numbers.get(line.shipmentIndex) ?? 0);
    // 「ลูกค้า（客户）」这一列原来印客户名字 —— 这张签收单要交给收货人签字，名字只给内部看，改印唛头
    //（2026-09-18 老板：「唛头=账号，客户名字是只有我们内部看的」）
    if (writes("B", index)) xml = setTextCell(xml, `B${row}`, line.clientId, strings);
    if (writes("C", index)) xml = setTextCell(xml, `C${row}`, line.clientId, strings);
    // 品名一行放不下就把行高撑开（2026-09-11：数据早就全了，是纸上被行高切掉）
    xml = setItemNameCell(xml, "D", row, line.itemName, strings, fonts);
    xml = setNumberCell(xml, `E${row}`, line.packageCount);
    xml = setOptionalNumberCell(xml, `F${row}`, line.volumeM3);
    xml = setOptionalNumberCell(xml, `G${row}`, line.weightKg);
    // H「สภาพบรรจุ（包装状况）」、J 留给收货人逐行写 / 打勾：上面 clearRange 已经清空，这里不写
    if (writes("I", index)) xml = setTextCell(xml, `I${row}`, line.remark, strings);
  });
  xml = setFormulaCell(xml, "E28", "SUM(E8:E27)", lineTotal(lines, "packageCount"));
  // 泰文模板的体积、重量合计原本就是数值单元格，保留原结构，仅改成页内明细合计。
  xml = setOptionalNumberCell(xml, "F28", optionalLineTotal(lines, "volumeM3"));
  xml = setOptionalNumberCell(xml, "G28", optionalLineTotal(lines, "weightKg"));
  for (const ref of ["D28", "H28", "I28", "J28"]) xml = setTextCell(xml, ref, "", strings);
  xml = setTextCell(xml, "B31", data.deliveryDate, strings);
  xml = setTextCell(xml, "E31", stop?.receiverName || customer.contactName, strings);
  xml = setTextCell(xml, "H31", stop?.receiverPhone || customer.contactPhone, strings);
  return clearMergedInteriorBorders(mergeShipmentRows(xml, shipmentBlocks(lines, 8), CUSTOMER_TH_SHIPMENT_COLUMNS), styles);
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
 * 列宽、页边距、打印设置和声明文案使用原模板；仅长品名明细行增高。另外（2026-10-07 起，两种单子都做）：
 *   · 一票展开成几行时，这一票的格子竖着合并（mergeShipmentRows），一票不拆到两页；客户签收单的序号按票编；
 *   · 整柜清单表头补上漏合并的 C3:C4、C5:C6；
 *   · 每个合并区域里面的边框去掉、底色统一成左上角那格的，靠 styles.xml 末尾追加克隆样式（CellStyleEditor / clearMergedInteriorBorders，原有样式条目不动）。
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
  // 合并区域里面去边框、统一底色要靠追加的克隆样式（见 CellStyleEditor）；两种单子共用一个，同一种样式只克隆一次
  const styles = new CellStyleEditor(stylesXml ?? "");
  if (data.scope === "container") {
    const path = "xl/worksheets/sheet1.xml";
    const xml = await zip.file(path)?.async("string");
    if (!xml) throw new Error("整柜模板缺少主工作表");
    const pages = paginateKeepingShipments(lines, 25);
    zip.file(path, patchInternalTemplate(xml, strings, styles, fonts, data, pages[0], lines));
    for (let pageIndex = 1; pageIndex < pages.length; pageIndex += 1) {
      clones.push({
        name: pageWorksheetName(sheetNames[0] || "整柜派送清单", pageIndex + 1, existingSheetNames),
        xml: patchInternalTemplate(xml, strings, styles, fonts, data, pages[pageIndex], lines),
      });
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
    const numbers = shipmentNumbers(pages);
    zip.file(chinesePath, patchCustomerChineseTemplate(chineseXml, strings, styles, fonts, data, pages[0], numbers));
    zip.file(thaiPath, patchCustomerThaiTemplate(thaiXml, strings, styles, fonts, data, pages[0], numbers));
    for (let pageIndex = 1; pageIndex < pages.length; pageIndex += 1) {
      clones.push(
        {
          name: pageWorksheetName(sheetNames[0] || "客户签收单-中文", pageIndex + 1, existingSheetNames),
          xml: patchCustomerChineseTemplate(chineseXml, strings, styles, fonts, data, pages[pageIndex], numbers),
        },
        {
          name: pageWorksheetName(sheetNames[1] || "客户签收单-泰文", pageIndex + 1, existingSheetNames),
          xml: patchCustomerThaiTemplate(thaiXml, strings, styles, fonts, data, pages[pageIndex], numbers),
        },
      );
    }
  }
  const finishedStyles = styles.finish();
  if (stylesXml && finishedStyles !== stylesXml) zip.file("xl/styles.xml", finishedStyles);
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
