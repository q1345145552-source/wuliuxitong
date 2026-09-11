import { parseCargoType, strictestCargoType, CARGO_TYPE_HINT, type CargoType } from "../../../../../packages/shared-types/cargo-type";
export interface StaffBatchProduct {
  itemName: string;
  packageCount: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  productQuantity?: number;
  weightKg?: number;
  cargoType?: CargoType;
  domesticTrackingNo?: string;
}

export interface StaffBatchOrder {
  clientId: string;
  trackingNo: string;
  warehouseId: string;
  itemName: string;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number;
  volumeM3?: number;
  arrivedAt: string;
  transportMode: "sea" | "land";
  domesticTrackingNo?: string;
  productQuantity?: number;
  /** 运单这一层的货型：多条产品行不一致时取最严的那个（见 strictestCargoType） */
  cargoType: CargoType;
  products: StaffBatchProduct[];
  sourceRows: number[];
}

export interface StaffBatchIssue {
  rowNumber?: number;
  trackingNo?: string;
  clientId?: string;
  message: string;
  /** "file" = 整份表的问题（比如缺了一整列），不属于某一行，界面上不加「第N行」前缀 */
  kind?: "file";
}

export interface StaffBatchParseResult {
  sourceRowCount: number;
  orders: StaffBatchOrder[];
  issues: StaffBatchIssue[];
}

/** 批量创建的每条错误都同时标出运单号和客户唛头。 */
export function formatStaffBatchErrorLocation(
  rowLabel: string,
  trackingNo?: string,
  clientId?: string,
): string {
  return `${rowLabel}（运单号 ${trackingNo?.trim() || "—"}，唛头 ${clientId?.trim() || "—"}）`;
}

interface GroupDraft {
  trackingNo: string;
  clientId?: string;
  warehouseId?: string;
  arrivedAt?: string;
  transportMode?: "sea" | "land";
  packageUnit?: "bag" | "box";
  products: StaffBatchProduct[];
  sourceRows: number[];
  issues: StaffBatchIssue[];
  /**
   * 已经就某个公共字段报过行级错误的字段名。
   * 用来压掉最后那轮「X为必填」的重复提示 —— 仓库填了「义乌」时，
   * 原来会同时报「只能填义乌仓/广州仓/…」和「仓库为必填」，
   * 员工明明填了东西却被说没填，比不报还糟。
   */
  reported: Set<string>;
}

export const WAREHOUSE_NAME_MAP: Record<string, string> = {
  义乌仓: "wh_yiwu_01",
  广州仓: "wh_guangzhou_01",
  东莞仓: "wh_dongguan_01",
  深圳仓: "wh_shenzhen_01",
  // 2026-09-02：仓库《上传系统数据》真表里写的是不带「仓」字的城市名——同一个意思，收进来。
  // 报错提示仍只列带「仓」的四个标准名（WAREHOUSE_NAMES 过滤掉这四个短别名，见下）。
  义乌: "wh_yiwu_01",
  广州: "wh_guangzhou_01",
  东莞: "wh_dongguan_01",
  深圳: "wh_shenzhen_01",
};
const WAREHOUSE_IDS = new Set(Object.values(WAREHOUSE_NAME_MAP));
const WAREHOUSE_NAMES = Object.keys(WAREHOUSE_NAME_MAP).filter((n) => n.endsWith("仓"));

/* ==========================================================================
   全角 → 半角
   --------------------------------------------------------------------------
   2026-08-29 加。员工用中文输入法打数字时很容易打出全角，
   实测「１2」（全角1+半角2）原来被读成 **2 箱**（应该 12 箱），一声不吭；
   而整串全角「１２」会报「箱数必须是正整数」——员工盯着单元格里明明写着 12，
   完全看不懂为什么说它不是正整数。两种都得先正规化掉。
   ========================================================================== */
function toHalfWidth(input: string): string {
  return input
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[　 ]/g, " ")
    .replace(/[，、]/g, ",")
    .replace(/[．。]/g, ".");
}

/* ==========================================================================
   表头匹配：**精确匹配别名表**，不再用「包含」
   --------------------------------------------------------------------------
   ⚠️ 这是 2026-08-29 这次改动里最要紧的一条，起因是实测出来的：

   原来 findValue 是 `Object.keys(row).find(c => keywords.some(k => c.includes(k)))`
   —— 在所有列里找**第一个**名字里含关键词的列。于是员工只要自己加一列，
   就能把整票货的数字全算错，而且预览页面一条提示都没有：

     基准：5箱 × 每箱7个 × 100×50×20cm × 单箱10kg  →  箱数5 总数35 重量50 方数0.5
     在「箱数」左边加一列「总箱数」=99  →  箱数99 总数693 重量990 方数9.9（差 19.8 倍）
     同一列加在右边                      →  完全正常
     左边加一列「货物长度cm」=999        →  方数 4.995
     左边加一列「客户品名备注」          →  品名被顶替成客户写的那串

   **对错取决于列的先后顺序**，而方数是算钱的。

   现在的做法：把表头正规化（去空格/星号/括号及括号里的说明/全角转半角），
   再跟下面这张别名表**全等**比对。员工自己加的列一律不认，也就碰不到。

   ⚠️ 别名表只收「确实是同一个意思」的写法。像「总箱数」这种是员工自己做小计用的，
      **绝对不能**收进「箱数」的别名，否则等于把上面那个 bug 原样搬回来。
   ⚠️ 同一个字段命中了两列（比如表里有两列都叫「箱数」）→ 直接报错让员工确认，
      不许自己挑一个。
   ========================================================================== */
function normalizeHeader(raw: string): string {
  return toHalfWidth(String(raw))
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "")  // 去掉括号和括号里的说明文字
    .replace(/[*＊]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

type FieldKey =
  | "clientId" | "trackingNo" | "warehouse" | "itemName" | "packageCount"
  | "packageUnit" | "lengthCm" | "widthCm" | "heightCm" | "weightKg"
  | "arrivedAt" | "transportMode" | "domesticTrackingNo" | "perBoxQty" | "legacyQty"
  | "rowTotalWeightKg" | "dimensions" | "cargoType";

/**
 * 每个字段认哪些表头（正规化之后全等比对）。
 *
 * 2026-09-02 拿到仓库真实在用的《上传系统数据》表后补了三样：
 * 「件数」（=箱数）、「日期」（=到仓日期）、「单项重量」（行级总重，见下）。
 * 那张表里其余的列（单项体积/总体积/总重量/计费体积/总计费体积/单价/
 * 单项价格/订单总价/备注/结算状态）都**故意不认**——精确匹配下不认就碰不到，
 * 不会影响任何数字。
 *
 * 「货型」2026-09-11 开始认了（老板：模板要加货型，不然全变普货）。
 * 在这之前这一列不认、导进来一律是普货，仓库表里填了「商检」的货要人工改回来。
 */
const FIELD_ALIASES: Record<FieldKey, string[]> = {
  clientId:           ["唛头", "客户唛头"],
  trackingNo:         ["运单号", "运单号码"],
  warehouse:          ["仓库", "仓库名称", "发货仓库"],
  itemName:           ["品名", "货名", "货物名称", "商品名称"],
  // 「件数」是仓库《上传系统数据》表对箱数的叫法（2026-09-02 对过真表，同一个意思）。
  // ⚠️ 「总箱数」照旧**绝对不能**收 —— 那是员工自己做小计用的，见上面那段血泪史。
  packageCount:       ["箱数", "件数"],
  packageUnit:        ["包装类型", "包装"],
  lengthCm:           ["长cm", "长", "长度", "长度cm"],
  widthCm:            ["宽cm", "宽", "宽度", "宽度cm"],
  heightCm:           ["高cm", "高", "高度", "高度cm"],
  weightKg:           ["单箱重量kg", "单箱重量", "每箱重量kg", "每箱重量"],
  // 「日期」是仓库《上传系统数据》表对到仓日期的叫法（那张表里只有这一个日期列，不会歧义）。
  arrivedAt:          ["到仓日期", "入仓日期", "到仓时间", "日期"],
  transportMode:      ["运输方式"],
  domesticTrackingNo: ["国内单号", "国内快递单号", "国内物流单号"],
  /**
   * 仓库《上传系统数据》表的行级重量（2026-09-02 加）。
   * ⚠️ 语义是**这一行货的总重**、不是单箱重：真表实测 195kg ÷ 13件 ≈ 15kg/箱 才合理。
   *    解析时除以箱数换算成单箱重（见 parseStaffBatchRows 里的换算段）。
   * ⚠️ 「总重量」**绝对不能**收进这里 —— 那张表里它是跨行累计的**订单总重**，
   *    认了它等于把整张单的重量算到每一行头上，必错。同理「计费体积」那几列也都不认。
   */
  rowTotalWeightKg:   ["单项重量"],
  // 仓库表的长宽高连写在一格：「42.5*38*51.5」。只是多认一种写法，单独的长/宽/高照旧。
  dimensions:         ["尺寸"],
  // 「每箱几个」是现行模板的列名。「单箱数量」以前不敢用（含「箱数」会被包含匹配认错列），
  // 现在改成精确匹配之后可以安全地收进来。
  perBoxQty:          ["每箱几个", "单箱数量", "每箱数量"],
  // 老模板的列名。只在没有新列时才回落——顺序由 resolveColumns 保证，跟列的先后无关。
  legacyQty:          ["产品数量"],
  /**
   * 货型（2026-09-11 加）。**选填**：没有这一列、或这一列留空，都按普货 ——
   * 老模板下载过、正在用的文件不会因为这次改动报错。
   * ⚠️ 「类型」这种太泛的名字不收：表里已经有「包装类型」，虽然现在是精确匹配碰不到，
   *    但别给以后留雷。
   */
  cargoType:          ["货型", "货物类型", "货物类别"],
};

/** 自检：别名不许在两个字段之间重复，否则匹配结果取决于遍历顺序。 */
(() => {
  const seen = new Map<string, FieldKey>();
  for (const [field, names] of Object.entries(FIELD_ALIASES) as [FieldKey, string[]][]) {
    for (const name of names) {
      const owner = seen.get(name);
      if (owner) throw new Error(`表头别名「${name}」同时属于 ${owner} 和 ${field}，请改掉其中一个`);
      seen.set(name, field);
    }
  }
})();

/** 这些列必须存在，缺了整份表都没法用，直接报一条整表错误，不要刷 2000 行。 */
const REQUIRED_COLUMNS: { field: FieldKey; label: string }[] = [
  { field: "clientId", label: "唛头" },
  { field: "trackingNo", label: "运单号" },
  { field: "warehouse", label: "仓库" },
  { field: "itemName", label: "品名" },
  { field: "packageCount", label: "箱数" },
  // 2026-08-29 老板拍板：单箱重量**必填**（模板本来就标了 *，只有代码当选填）
  { field: "weightKg", label: "单箱重量kg" },
  { field: "arrivedAt", label: "到仓日期" },
  { field: "transportMode", label: "运输方式" },
];

type ColumnMap = Partial<Record<FieldKey, string>>;

function resolveColumns(rows: Record<string, unknown>[]): { columns: ColumnMap; issues: StaffBatchIssue[] } {
  const headers = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) headers.add(key);

  const columns: ColumnMap = {};
  const issues: StaffBatchIssue[] = [];

  // 报过「这一列重复了」的字段，后面就别再报「找不到这一列」—— 同一个毛病报两遍只会让人更懵
  const duplicated = new Set<FieldKey>();
  for (const [field, names] of Object.entries(FIELD_ALIASES) as [FieldKey, string[]][]) {
    const hits = [...headers].filter((h) => names.includes(normalizeHeader(h)));
    if (hits.length === 1) columns[field] = hits[0];
    else if (hits.length > 1) {
      duplicated.add(field);
      issues.push({
        kind: "file",
        message: `表里有 ${hits.length} 列都被认成「${names[0]}」（${hits.join("、")}），请只保留一列`,
      });
    }
  }

  for (const { field, label } of REQUIRED_COLUMNS) {
    // 仓库《上传系统数据》表没有「单箱重量kg」列，用行级的「单项重量」换算代替（2026-09-02）。
    // 有那一列（或它命中了重复列、马上要报重复错）就不再要求「单箱重量kg」。
    if (field === "weightKg" && (columns.rowTotalWeightKg !== undefined || duplicated.has("rowTotalWeightKg"))) continue;
    if (!columns[field] && !duplicated.has(field)) {
      issues.push({
        kind: "file",
        message: `表里找不到「${label}」这一列。请用系统的模板，或者把这一列的表头改成「${label}」`,
      });
    }
  }

  return { columns, issues };
}

function cellOf(row: Record<string, unknown>, columns: ColumnMap, field: FieldKey): unknown {
  const key = columns[field];
  return key === undefined ? undefined : row[key];
}

function textOf(row: Record<string, unknown>, columns: ColumnMap, field: FieldKey): string {
  const raw = cellOf(row, columns, field);
  if (raw === undefined || raw === null) return "";
  return toHalfWidth(String(raw)).trim();
}

/* ==========================================================================
   数字：只认「数字」和「数字+单位」，其余一律报错并把原文回显
   --------------------------------------------------------------------------
   2026-08-29 改。原来是 `String(raw).replace(/[^0-9.\-]/g, "")` ——
   把所有非数字字符抹掉，剩下什么就当什么数。实测（宽50 高20 箱数5，正确方数 0.5）：
     长cm 填「1米」   → 读成 1cm，方数 0.005，**差 100 倍**，无提示
     长cm 填「40*30」 → 读成 4030，方数 20.15，无提示
     箱数 填「2箱半」 → 读成 2，无提示
   方数是算钱的，这种静默算错比直接报错严重得多。

   现在：全角转半角 → 去空格 → 去千分位逗号 → 去掉一个**结尾**的单位 →
   必须整串是纯数字，否则报错，并且把员工填的原文写进提示里。
   「100cm」「100 厘米」「5箱」「12,000」这些原来能蒙对的写法照样能用。
   ========================================================================== */
const UNIT_SUFFIX = /(cm|厘米|公分|kg|千克|公斤|箱|个|件|袋|条|包|方)$/i;

function parseNumberCell(raw: unknown): { value?: number; badText?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw } : { badText: String(raw) };
  if (typeof raw === "boolean") return { badText: String(raw) };
  const original = String(raw).trim();
  if (original === "") return {};
  let t = toHalfWidth(original).replace(/\s+/g, "").replace(/,/g, "");
  t = t.replace(UNIT_SUFFIX, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { badText: original };
  const value = Number(t);
  return Number.isFinite(value) ? { value } : { badText: original };
}

/** 数字进提示语前收到 2 位小数，免得出现「45.300000000000004kg」这种吓人的尾巴。 */
function fmt2(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/* ==========================================================================
   日期：认全常见写法，认不出**在解析阶段就报错**
   --------------------------------------------------------------------------
   2026-08-29 改。原来只认「5 位数字的 Excel 序列号」，别的一律原样透传、
   而且不产生任何 issue。实测后果：
     填 2026/08/29、2026-8-9、2026.08.29、20260829、或者日期带了时分秒
     → 解析阶段全绿放行 → 点「确认创建」之后 100 张单排队跑完才一张张失败，
       员工看到的还是后端的英文 invalid arrivedAt
     填 2026 或 2026-02-31 → 后端居然认，原样存进 Order.shipDate
   现在全部在解析阶段解决：认得出的统一转成 YYYY-MM-DD，认不出的当场中文报错。

   ⚠️ 「29/08/2026」这种日/月/年**故意不猜**——猜错就是把 8 月 29 号存成 8 月 29 日
      还是 29 月？两可的东西宁可让员工改，不要替他决定。
   ========================================================================== */
function serialToDate(serial: number): string | undefined {
  // Excel 的 0 号是 1899-12-30（含那个著名的 1900 闰年 bug 补偿）
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseDateCell(raw: unknown): { value?: string; badText?: string } {
  if (raw === undefined || raw === null) return {};
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime())
      ? { badText: String(raw) }
      : { value: `${raw.getFullYear()}-${pad2(raw.getMonth() + 1)}-${pad2(raw.getDate())}` };
  }
  if (typeof raw === "number") {
    // 带时分秒的单元格序列号是小数（46265.5），取整数部分就是那一天
    const iso = Number.isFinite(raw) ? serialToDate(raw) : undefined;
    return iso ? { value: iso } : { badText: String(raw) };
  }
  const original = String(raw).trim();
  if (original === "") return {};
  const t = toHalfWidth(original).replace(/\s+/g, "");

  // 纯数字 = Excel 序列号（可能带小数）。20000≈1954年，60000≈2064年，超出这个范围当写错处理。
  if (/^\d+(\.\d+)?$/.test(t) && !/^\d{8}$/.test(t)) {
    const n = Number(t);
    if (n >= 20_000 && n <= 60_000) {
      const iso = serialToDate(n);
      if (iso) return { value: iso };
    }
    return { badText: original };
  }

  // 2026-08-29 / 2026/8/9 / 2026.08.29 / 2026年8月29日
  const m1 = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(t);
  // 20260829
  const m2 = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  const m = m1 ?? m2;
  if (!m) return { badText: original };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isRealDate(y, mo, d)) return { badText: original };
  return { value: `${y}-${pad2(mo)}-${pad2(d)}` };
}

function normalizeTransport(raw: string): "sea" | "land" | undefined {
  const value = raw.toLowerCase();
  if (value.includes("海运") || value === "sea") return "sea";
  if (value.includes("陆运") || value === "land") return "land";
  return undefined;
}

function normalizePackageUnit(raw: string): "bag" | "box" | undefined {
  const value = raw.toLowerCase();
  if (value.includes("袋") || value === "bag") return "bag";
  if (value.includes("箱") || value === "box") return "box";
  return undefined;
}

function setSharedField<K extends "clientId" | "warehouseId" | "arrivedAt" | "transportMode" | "packageUnit">(
  draft: GroupDraft,
  key: K,
  rawValue: GroupDraft[K] | undefined,
  label: string,
  rowNumber: number,
): void {
  if (rawValue === undefined || rawValue === "") return;
  const existing = draft[key];
  if (existing !== undefined && existing !== rawValue) {
    draft.issues.push({ rowNumber, trackingNo: draft.trackingNo, message: `同一运单的${label}不一致` });
    return;
  }
  (draft[key] as GroupDraft[K]) = rawValue;
}

/** 读一个数字格：看不懂就报错（带原文），负数/零/非整数按规矩报错，必填空着也报错。 */
function readNumber(
  draft: GroupDraft,
  rowNumber: number,
  label: string,
  raw: unknown,
  options: { required?: boolean; integer?: boolean } = {},
): number | undefined {
  const parsed = parseNumberCell(raw);
  if (parsed.badText !== undefined) {
    draft.issues.push({
      rowNumber,
      trackingNo: draft.trackingNo,
      message: `${label}填的是「${parsed.badText}」，看不懂，这一格只能填数字`,
    });
    return undefined;
  }
  if (parsed.value === undefined) {
    if (options.required) {
      draft.issues.push({ rowNumber, trackingNo: draft.trackingNo, message: `${label}为必填` });
    }
    return undefined;
  }
  if (parsed.value <= 0 || (options.integer && !Number.isInteger(parsed.value))) {
    draft.issues.push({
      rowNumber,
      trackingNo: draft.trackingNo,
      message: `${label}必须是${options.integer ? "正整数" : "正数"}`,
    });
    return undefined;
  }
  return parsed.value;
}

/**
 * 页面读 Excel 时必须用这组参数。
 *
 * ⚠️ blankrows:true 不能去掉：默认会把完全空白的行丢掉，而行号是「下标+2」——
 * 丢一行，下面所有报错的行号全部少 1（实测错误在第 5 行、系统报第 4 行）。
 * ⚠️ 提取成常量是为了让测试能盯住它。但要说清楚：这只挡得住「有人把 blankrows 删了」，
 *    挡不住「有人不用这个常量、自己再写一份参数」—— 后者只能靠 code review。
 */
export const BATCH_SHEET_TO_JSON_OPTIONS = { defval: "", blankrows: true } as const;

/**
 * 工作表里**真正有单元格**的最后一行（1 起算；没有就返回 0）。
 *
 * ⚠️ 为什么非要这个（2026-08-29 加，是我自己上一版捅的娄子）：
 * 加了 blankrows:true 之后要按 `!ref` 逐行产出。而 Excel 的「已用区域」经常
 * 被拖到整张表的底 —— 老板真实在用的《副本上传系统数据东莞5月》就是
 * `!ref = A1:AF1048565`，实际只有 67 行数据。实测：
 *     默认（丢空行）     67 行，  86 MB
 *     blankrows:true  1048564 行，**1934 MB**、多花 2.4 秒
 * 这个表是在**浏览器里**解析的，1.9GB 足够把标签页搞崩。
 * 所以按真实单元格算出末行，只读到那里为止 —— 行号仍然从第 1 行开始，
 * 前面的行下标一个都没动，报错行号照样是对的。
 */
export function lastRowWithCells(cellKeys: string[]): number {
  let max = 0;
  for (const key of cellKeys) {
    if (key.charCodeAt(0) === 33) continue;   // "!ref" / "!cols" 这类元信息
    const m = /^[A-Z]+(\d+)$/.exec(key);
    if (!m) continue;
    const row = Number(m[1]);
    if (row > max) max = row;
  }
  return max;
}

/**
 * Excel 一行代表一种产品规格；同一运单号的多行会合并成一张订单。
 * 连续明细行可省略运单号及公共字段，解析时继承上一行所属运单的数据。
 *
 * ⚠️ 入参必须是**保留空行**的行数组（页面用 sheet_to_json 的 blankrows:true）。
 * 2026-08-29 之前空行会被 sheet_to_json 丢掉，导致 rowNumber = 下标+2 全部错位：
 * 实测错误真实在 Excel 第 5 行，系统报的是「第 4 行」，员工去看那一行是好的。
 */
export function parseStaffBatchRows(rows: Record<string, unknown>[]): StaffBatchParseResult {
  const { columns, issues: fileIssues } = resolveColumns(rows);
  // 缺列/重列这种整表问题，再往下解析只会刷出几千条无意义的行级错误
  if (fileIssues.length > 0) return { sourceRowCount: 0, orders: [], issues: fileIssues };

  const groups = new Map<string, GroupDraft>();
  const looseIssues: StaffBatchIssue[] = [];
  let previousTrackingNo = "";
  let dataRowCount = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;

    /**
     * 整行都是空的就直接跳过 —— 不继承运单号、不产生任何错误。
     * 2026-08-29 加。原来只要这一行还留着单元格（员工敲了个空格、留了个旧值、
     * 写了行「小计」），它就会继承上一行的运单号，然后因为没品名没箱数
     * 产生两条错误挂到**上一张单**头上，把那张完全填对的单整个作废。
     * 实测：T001 / T002 / 一行空白 / T003 → T002 直接消失，
     * 报「第4行 T002：品名为必填、箱数为必填」，而员工看第 4 行 T002 明明是填好的。
     */
    const anyValue = (Object.keys(FIELD_ALIASES) as FieldKey[])
      .some((field) => textOf(row, columns, field) !== "");
    if (!anyValue) return;
    dataRowCount += 1;

    const rawClientId = textOf(row, columns, "clientId");
    const explicitTrackingNo = textOf(row, columns, "trackingNo");
    const trackingNo = explicitTrackingNo || previousTrackingNo;
    if (explicitTrackingNo) previousTrackingNo = explicitTrackingNo;
    if (!trackingNo) {
      looseIssues.push({
        rowNumber,
        clientId: rawClientId || undefined,
        message: "运单号为必填；后续明细行可留空并继承上一行",
      });
      return;
    }

    const draft = groups.get(trackingNo) ?? {
      trackingNo,
      products: [],
      sourceRows: [],
      issues: [],
      reported: new Set<string>(),
    };
    groups.set(trackingNo, draft);
    draft.sourceRows.push(rowNumber);

    const rawWarehouse = textOf(row, columns, "warehouse");
    const rawTransport = textOf(row, columns, "transportMode");
    const rawPackageUnit = textOf(row, columns, "packageUnit");

    setSharedField(draft, "clientId", rawClientId || undefined, "唛头", rowNumber);

    /**
     * 仓库必须是这四个之一（2026-08-29 加）。
     * 原来认不出的名字**原样透传**给后端，而后端只检查「仓库不为空」、
     * 数据库那一列也没有外键 —— 少打一个「仓」字就会静默存进库，
     * 运单列表那一格显示的是填错的原文，按仓库筛选时这张单还不出现。
     */
    if (rawWarehouse) {
      const warehouseId = WAREHOUSE_NAME_MAP[rawWarehouse] ?? (WAREHOUSE_IDS.has(rawWarehouse) ? rawWarehouse : undefined);
      if (warehouseId) setSharedField(draft, "warehouseId", warehouseId, "仓库", rowNumber);
      else {
        draft.reported.add("仓库");
        draft.issues.push({
          rowNumber,
          trackingNo,
          message: `仓库填的是「${rawWarehouse}」，只能填：${WAREHOUSE_NAMES.join(" / ")}`,
        });
      }
    }

    const parsedDate = parseDateCell(cellOf(row, columns, "arrivedAt"));
    if (parsedDate.badText !== undefined) {
      draft.reported.add("到仓日期");
      draft.issues.push({
        rowNumber,
        trackingNo,
        message: `到仓日期填的是「${parsedDate.badText}」，看不懂，请写成 2026-08-29 这种格式`,
      });
    } else if (parsedDate.value) {
      setSharedField(draft, "arrivedAt", parsedDate.value, "到仓日期", rowNumber);
    }

    if (rawTransport) {
      const transportMode = normalizeTransport(rawTransport);
      if (transportMode) setSharedField(draft, "transportMode", transportMode, "运输方式", rowNumber);
      else {
        draft.reported.add("运输方式");
        draft.issues.push({ rowNumber, trackingNo, message: `运输方式填的是「${rawTransport}」，只能填海运或陆运` });
      }
    }
    if (rawPackageUnit) {
      const packageUnit = normalizePackageUnit(rawPackageUnit);
      if (packageUnit) setSharedField(draft, "packageUnit", packageUnit, "包装类型", rowNumber);
      else draft.issues.push({ rowNumber, trackingNo, message: `包装类型填的是「${rawPackageUnit}」，只能填箱或袋` });
    } else if (!draft.packageUnit) {
      // 模板约定空值默认“箱”；第一条明细一旦采用默认值，后续显式填“袋”应当报冲突，
      // 不能把前面已经按箱填写的行静默改成袋。
      draft.packageUnit = "box";
    }

    const itemName = textOf(row, columns, "itemName");
    if (!itemName) draft.issues.push({ rowNumber, trackingNo, message: "品名为必填" });
    const packageCount = readNumber(draft, rowNumber, "箱数", cellOf(row, columns, "packageCount"), { required: true, integer: true });
    const issuesBeforeDimensions = draft.issues.length;
    let lengthCm = readNumber(draft, rowNumber, "长cm", cellOf(row, columns, "lengthCm"));
    let widthCm = readNumber(draft, rowNumber, "宽cm", cellOf(row, columns, "widthCm"));
    let heightCm = readNumber(draft, rowNumber, "高cm", cellOf(row, columns, "heightCm"));
    /**
     * 「尺寸」一格连写（2026-09-02 加）：仓库《上传系统数据》表就这么填，「42.5*38*51.5」。
     * 长宽高本来就是选填、缺列不报错，所以这只是**多认一种写法**，原有路径一条没动。
     * 分隔符收 * × x（全角＊、Ｘ、ｘ 会先被 toHalfWidth 转成半角）；
     * 解析不出报错并回显原文，不许静默丢掉。
     * 跟单独的长/宽/高同一行都填了 → 报错让员工留一种，不悄悄选边。
     */
    const rawDimensions = textOf(row, columns, "dimensions");
    if (rawDimensions) {
      if (lengthCm !== undefined || widthCm !== undefined || heightCm !== undefined) {
        draft.issues.push({
          rowNumber,
          trackingNo,
          message: "这一行同时填了「尺寸」和单独的长/宽/高，请只保留一种写法",
        });
      } else {
        const parts = rawDimensions.replace(/\s+/g, "").split(/[*×x]/i);
        const numbers = parts.map((part) => parseNumberCell(part).value);
        if (parts.length !== 3 || numbers.some((value) => value === undefined || value <= 0)) {
          draft.issues.push({
            rowNumber,
            trackingNo,
            message: `尺寸填的是「${rawDimensions}」，看不懂，请写成 长*宽*高，比如 42.5*38*51.5`,
          });
        } else {
          [lengthCm, widthCm, heightCm] = numbers as [number, number, number];
        }
      }
    }
    // 三格里已经有一格「看不懂」了，就别再补一句「长宽高需要同时填写」——
    // 员工三格都填了，被告知没填全只会更糊涂。「尺寸」解析失败同理。
    const dimensionHadError = draft.issues.length > issuesBeforeDimensions;
    /**
     * 2026-08-29 老板拍板：单箱重量**必填**。
     * 模板那一列本来就写着「单箱重量kg *（数字）」带星号，只有代码一直当选填 ——
     * 整列留空照样建单、重量存 null、一句提示都没有，两边口径终于对上了。
     * ⚠️ 必填之后原来那条「同一运单的单箱重量要么全填要么全空」就没用了（不可能只填一半），
     *    留着只会在漏填时多报一条重复的错，所以删掉了。
     *
     * 2026-09-02 加「单项重量」换算：仓库《上传系统数据》表没有单箱重量列，
     * 只有行级总重「单项重量」（实测 195kg ÷ 13件 ≈ 15kg/箱 才合理）。规矩：
     *   - 单箱重量没填、单项重量有值 → 单箱重 = 单项重量 ÷ 箱数，四舍五入到 2 位；
     *     换算前单项重量得是合法正数（parseNumberCell 那套照旧）、箱数得已解析成正整数；
     *     换算结果 < 0.01（会被抹成 0）或 ≥ 1 亿（数据库 Decimal(10,2) 装不下，
     *     见 apps/api routes.ts 里 10**8 那道闸）→ 报错回显原文和算式。
     *   - 两列都填了且对不上（单箱重×箱数 和单项重量差超过 1%）→ 报错让员工核对，
     *     不悄悄选边。对得上就用员工亲手填的单箱重量。
     *   - 两列都空 → 照旧必填报错；提示按表里实际有哪列来说，别让用仓库表的员工
     *     去找一个他表里根本没有的「单箱重量kg」。
     */
    const issuesBeforeWeight = draft.issues.length;
    const perBoxWeightInput = readNumber(draft, rowNumber, "单箱重量kg", cellOf(row, columns, "weightKg"));
    const rowTotalWeight = readNumber(draft, rowNumber, "单项重量", cellOf(row, columns, "rowTotalWeightKg"));
    const weightHadError = draft.issues.length > issuesBeforeWeight;
    let weightKg = perBoxWeightInput;
    if (perBoxWeightInput !== undefined && rowTotalWeight !== undefined) {
      // 箱数那格没解析出来时它自己已经报过错、这一行本来就过不去，核对不了就不硬核对
      if (packageCount !== undefined) {
        const expected = perBoxWeightInput * packageCount;
        if (Math.abs(expected - rowTotalWeight) > rowTotalWeight * 0.01) {
          draft.issues.push({
            rowNumber,
            trackingNo,
            message: `单箱重量${fmt2(perBoxWeightInput)}×${packageCount}件=${fmt2(expected)}kg，跟单项重量${fmt2(rowTotalWeight)}对不上，请核对后把错的那列改掉`,
          });
        }
      }
    } else if (perBoxWeightInput === undefined && rowTotalWeight !== undefined) {
      if (packageCount !== undefined) {
        const quotient = rowTotalWeight / packageCount;
        const converted = Math.round(quotient * 100) / 100;
        if (converted < 0.01 || converted >= 10 ** 8) {
          draft.issues.push({
            rowNumber,
            trackingNo,
            message: `单项重量${textOf(row, columns, "rowTotalWeightKg")}÷${packageCount}件=${Math.round(quotient * 10000) / 10000}/箱，这个单箱重不合理（要在 0.01 ~ 99999999.99 kg 之间），请核对单项重量和件数`,
          });
        } else {
          weightKg = converted;
        }
      }
    } else if (weightKg === undefined && !weightHadError) {
      draft.issues.push({
        rowNumber,
        trackingNo,
        message: columns.weightKg !== undefined ? "单箱重量kg为必填" : "单项重量为必填",
      });
    }
    /**
     * ⚠️ 两个表头都要认。
     * 模板原来这一列叫「产品数量」，跟旁边的「**单箱**重量kg」口径不一致，
     * 员工很容易当成「这一行一共几个」来填 —— 而代码要的是「每箱几个」。
     * 2026-08-28 把模板表头改成「每箱几个」，
     * 但**老模板下载过、正在用的文件还认「产品数量」**，两个都得收。
     *
     * ⚠️ 新列优先、没有新列才回落到老列。改成精确匹配之后这个优先级由
     *    FIELD_ALIASES 的 perBoxQty / legacyQty 两个字段各自解析，
     *    跟列在表里的先后顺序无关（原来用包含匹配时，同一份数据因为列序不同
     *    能算出 10 或 200，2026-08-28 实测过，有报大风险）。
     */
    const quantityRaw = columns.perBoxQty !== undefined
      ? cellOf(row, columns, "perBoxQty")
      : cellOf(row, columns, "legacyQty");
    const productQuantity = readNumber(draft, rowNumber, "每箱几个", quantityRaw, { integer: true });
    const dimensionCount = [lengthCm, widthCm, heightCm].filter((value) => value !== undefined).length;
    if (!dimensionHadError && dimensionCount > 0 && dimensionCount < 3) {
      draft.issues.push({ rowNumber, trackingNo, message: "长、宽、高需要同时填写" });
    }

    /**
     * 货型（2026-09-11 加）。留空按普货；填了认不出来的值**当场报错**，
     * 不许静默变普货 —— 商检货被当普货走掉，清关要的单据就是另一套。
     */
    const cargoTypeRaw = columns.cargoType !== undefined ? cellOf(row, columns, "cargoType") : undefined;
    const cargoTypeParsed = parseCargoType(cargoTypeRaw);
    if (cargoTypeParsed === null) {
      draft.issues.push({
        rowNumber,
        trackingNo,
        message: `货型「${String(cargoTypeRaw ?? "").trim()}」认不出来。${CARGO_TYPE_HINT}`,
      });
    }
    const cargoType: CargoType = cargoTypeParsed?.value ?? "normal";

    if (itemName && packageCount !== undefined) {
      draft.products.push({
        itemName,
        packageCount,
        lengthCm,
        widthCm,
        heightCm,
        productQuantity,
        weightKg,
        cargoType,
        domesticTrackingNo: textOf(row, columns, "domesticTrackingNo") || undefined,
      });
    }
  });

  const orders: StaffBatchOrder[] = [];
  const issues: StaffBatchIssue[] = [...looseIssues];
  for (const draft of groups.values()) {
    if (!draft.clientId && !draft.reported.has("唛头")) draft.issues.push({ trackingNo: draft.trackingNo, message: "唛头为必填" });
    if (!draft.warehouseId && !draft.reported.has("仓库")) draft.issues.push({ trackingNo: draft.trackingNo, message: "仓库为必填" });
    if (!draft.arrivedAt && !draft.reported.has("到仓日期")) draft.issues.push({ trackingNo: draft.trackingNo, message: "到仓日期为必填" });
    if (!draft.transportMode && !draft.reported.has("运输方式")) draft.issues.push({ trackingNo: draft.trackingNo, message: "运输方式为必填" });
    if (draft.products.length === 0) draft.issues.push({ trackingNo: draft.trackingNo, message: "至少需要一条有效产品明细" });

    const weights = draft.products.map((product) => product.weightKg);
    const dimensions = draft.products.map((product) => product.lengthCm !== undefined && product.widthCm !== undefined && product.heightCm !== undefined);
    if (dimensions.some(Boolean) && dimensions.some((complete) => !complete)) {
      draft.issues.push({ trackingNo: draft.trackingNo, message: "同一运单的产品尺寸需要全部填写或全部留空" });
    }
    /**
     * ⚠️ 「要么全填、要么全空」——跟上面尺寸同一个规矩（2026-08-28 补）。
     * 原来只要有**一行**填了数量，其余空行就按 0 静默计入，总数偏小而且没人知道。
     * 数字算错比导入失败严重得多，宁可拦住让他补齐。
     */
    const quantities = draft.products.map((product) => product.productQuantity);
    if (quantities.some((q) => q !== undefined) && quantities.some((q) => q === undefined)) {
      draft.issues.push({
        trackingNo: draft.trackingNo,
        message: "同一运单的每箱几个需要全部填写或全部留空",
      });
    }
    if (draft.issues.length > 0) {
      issues.push(...draft.issues.map((issue) => ({
        ...issue,
        trackingNo: issue.trackingNo ?? draft.trackingNo,
        clientId: issue.clientId ?? draft.clientId,
      })));
      continue;
    }

    const packageCount = draft.products.reduce((sum, product) => sum + product.packageCount, 0);
    const weightKg = weights.every((weight) => weight !== undefined)
      ? draft.products.reduce((sum, product) => sum + (product.weightKg ?? 0) * product.packageCount, 0)
      : undefined;
    const volumeM3 = dimensions.every(Boolean)
      ? draft.products.reduce((sum, product) => sum + ((product.lengthCm ?? 0) * (product.widthCm ?? 0) * (product.heightCm ?? 0) * product.packageCount) / 1_000_000, 0)
      : undefined;
    /**
     * ⚠️ 产品数量必须**乘箱数**：这一列填的是「单箱几个」，不是这一行的总数。
     *
     * 2026-08-28 老板在真页面上实测：三行明细各填 2/3/4 箱、每箱 2/3/4 个，
     * 正确总数是 2×2 + 3×3 + 4×4 = 29，系统报的是 9（= 2+3+4）。
     * 口径见 apps/api/src/modules/orders/routes.ts:833 的注释：
     * 同一个字段名在产品行上是「单箱数量」、在订单上才是「总数」。
     * 上面重量和体积两行都乘了 packageCount，唯独这一行漏了。
     */
    const hasProductQuantity = draft.products.some((product) => product.productQuantity !== undefined);
    const productQuantity = hasProductQuantity
      ? draft.products.reduce(
          (sum, product) => sum + (product.productQuantity ?? 0) * product.packageCount,
          0,
        )
      : undefined;
    const itemNames = Array.from(new Set(draft.products.map((product) => product.itemName)));
    const domesticTrackingNos = Array.from(new Set(draft.products.map((product) => product.domesticTrackingNo).filter((value): value is string => Boolean(value))));

    orders.push({
      clientId: draft.clientId!,
      trackingNo: draft.trackingNo,
      warehouseId: draft.warehouseId!,
      itemName: itemNames.join(" / "),
      packageCount,
      packageUnit: draft.packageUnit ?? "box",
      weightKg,
      volumeM3,
      arrivedAt: draft.arrivedAt!,
      transportMode: draft.transportMode!,
      domesticTrackingNo: domesticTrackingNos.length > 0 ? domesticTrackingNos.join(" / ") : undefined,
      productQuantity,
      // 同一运单几条产品行货型不一样时，运单这一层记最严的那个（宁可多准备材料）
      cargoType: strictestCargoType(draft.products.map((product) => product.cargoType ?? "normal")),
      products: draft.products,
      sourceRows: draft.sourceRows,
    });
  }

  return { sourceRowCount: dataRowCount, orders, issues };
}
