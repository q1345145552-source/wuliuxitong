/**
 * 货型（普货 / 商检货 / 敏感货 / 特货）—— 2026-09-11 老板：「批量上传运单的模板不正确，
 * 需要加一个货型，不然默认普货。」
 * 2026-10-11 老板：「新增一个货型，叫特别货」，存 `special`；混装时排最严（他回「按建议」）。
 * 2026-10-16 老板：「特别货改成特货吧」—— 只改显示的字，库里照旧存 `special`；
 * 导入时「特货」「特别货」「特别」都认（旧模板、旧习惯照样能用）。
 *
 * 库里存的是 `normal` / `inspection` / `sensitive` / `special`（2026-10-11 起四个），
 * 人填的是中文。批量导入原来**根本没有这一列**，一律写死 `cargoType: "normal"`，
 * 所以仓库表里填了「商检」的货导进系统全变普货，要人工一张张改回来。
 *
 * ⚠️ 认不出来的值**返回 null，让调用方报错**，绝不静默当普货 ——
 * 商检货被当普货走掉是真会出事的（清关要的单据完全不同），
 * 跟这个仓库其它地方一个规矩：宁可拦住让人改，也不偷偷填一个数。
 */
/** ⚠️ 顺序就是各处下拉的顺序：新加的往后放，别插在中间 */
export const CARGO_TYPES = ["normal", "inspection", "sensitive", "special"] as const;
export type CargoType = (typeof CARGO_TYPES)[number];

/** 存的值 → 中文（跟 ShipmentTableGrid 的 cargoTypeLabelOf 一致） */
export const CARGO_TYPE_ZH: Record<CargoType, string> = {
  normal: "普货",
  inspection: "商检货",
  sensitive: "敏感货",
  special: "特货",
};

/**
 * 特别货的默认单价，元/方（2026-10-11 老板：「特别货的价格是1250」→「1a2a」）—— 只有仓库版集货按货型算钱：
 *   · 建柜 / 加客户时特别货那一格先填 1250，能改（1A）；后端没收到这一格（老页面）也按 1250；
 *   · 新建代理时给代理的特别货价也默认 1250（2A，= 默认不产生返现，代理管理里能改）。
 * 库里那几列的默认值也是 1250（迁移 20261011_special_cargo_type），改这里要连迁移的默认值一起想。
 */
export const SPECIAL_CARGO_DEFAULT_PRICE = 1250;

/**
 * 存的值 → 中文。认不出来 / 没填按普货显示（各处原来各写一个三元表达式，加特别货时收成这一个，
 * 免得哪处漏了把特别货显示成普货）。
 */
export function cargoTypeZh(value: string | null | undefined): string {
  const zh = CARGO_TYPE_ZH as Record<string, string>;
  return zh[(value ?? "").trim().toLowerCase()] ?? CARGO_TYPE_ZH.normal;
}

/** Excel 里可能出现的各种写法。全角、空格、大小写都先抹平再比。 */
const CARGO_TYPE_ALIASES: Record<string, CargoType> = {
  普货: "normal",
  普通: "normal",
  普通货: "normal",
  一般货: "normal",
  normal: "normal",
  商检: "inspection",
  商检货: "inspection",
  需商检: "inspection",
  inspection: "inspection",
  敏感: "sensitive",
  敏感货: "sensitive",
  sensitive: "sensitive",
  特货: "special",
  特别: "special",
  特别货: "special", // 2026-10-16 前的叫法，旧模板 / 旧习惯照认
  special: "special",
};

export type CargoTypeParse = {
  value: CargoType;
  /** 这一格到底填了没有。没填时 value 是 normal，但调用方可以知道是「默认」来的 */
  filled: boolean;
};

/**
 * 把表格里那一格翻成系统的货型。
 *
 * - 留空 / 整格都是空白 → `{ value: "normal", filled: false }`（老板说的「默认普货」）
 * - 认得出来 → `{ value, filled: true }`
 * - 认不出来 → `null`，调用方必须报错，**不要**退回普货
 */
export function parseCargoType(raw: unknown): CargoTypeParse | null {
  if (raw === null || raw === undefined) return { value: "normal", filled: false };
  // 全角转半角，去掉空白和常见的分隔符号，再小写（英文写法用得上）
  const text = String(raw)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　]+/g, "")
    .toLowerCase();
  if (text === "") return { value: "normal", filled: false };
  const hit = Object.prototype.hasOwnProperty.call(CARGO_TYPE_ALIASES, text)
    ? CARGO_TYPE_ALIASES[text]
    : undefined;
  return hit ? { value: hit, filled: true } : null;
}

/** 填错时给人看的那句话 —— 三处调用方共用一份，别各写一句 */
export const CARGO_TYPE_HINT = "货型只能填「普货」「商检货」「敏感货」「特货」之一，留空按普货";

/**
 * 一张运单上多条产品行货型不一样时，运单这一层记哪个。
 *
 * 取**最严**的那个（特别 > 敏感 > 商检 > 普货）：少报一张商检单会卡在清关，
 * 多报一张只是多准备材料。跟父单状态取「最慢」是同一个保守方向。
 * 2026-10-11 特别货排最前（老板「按建议」：一票里只要有一件特别货，整票就算特别货）。
 */
export function strictestCargoType(values: readonly CargoType[]): CargoType {
  if (values.includes("special")) return "special";
  if (values.includes("sensitive")) return "sensitive";
  if (values.includes("inspection")) return "inspection";
  return "normal";
}

/**
 * 一票货在列表/导出里显示的货型（2026-09-11）。
 *
 * 一张运单底下几条产品行可能货型不一样，导出是一票一行，所以去重后拼起来：
 * 「普货 / 商检货」。没有产品行的老单退回运单（或订单）自己的货型。
 * ⚠️ 认不出来的值按普货显示 —— 跟三端的 cargoTypeLabelOf 口径保持一致，
 *    别在导出里冒出第四种说法。
 */
export function cargoTypeLabel(
  values: ReadonlyArray<string | null | undefined>,
  fallback?: string | null,
): string {
  const zh = CARGO_TYPE_ZH as Record<string, string>;
  const labels: string[] = [];
  for (const raw of values) {
    const label = zh[(raw ?? "").trim().toLowerCase()] ?? CARGO_TYPE_ZH.normal;
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length > 0) return labels.join(" / ");
  return zh[(fallback ?? "").trim().toLowerCase()] ?? CARGO_TYPE_ZH.normal;
}

/*
 * ── 一票只有一个货型（2026-11-24 老板：「改一下逻辑，一票只会有一个货型，不能单独产品选择货型」）──
 *
 * 原来每条产品行各选各的货型、整票记最严的那个（上面 strictestCargoType）。从这天起：
 *   · 页面上只在整票那一层选一次货型，产品行不再有货型那一格；存的时候每条产品行都写成整票这一个；
 *   · 后端收到产品行货型不止一种（没刷新的老页面、导入表格同一票几行填得不一样）→ 拦住，不猜、不取最严；
 *   · 老单（上线前就混着几种的，线上 101 票）**不去改库**（9-17「不改线上数据」）：列表照旧把几种都列出来；
 *     有人打开编辑、改了货型或产品行再保存，才统一成整票选的那一个。
 */

/** 认得出来的货型去重（顺序按第一次出现；认不出来 / 没填的按普货，跟 cargoTypeLabel 一个口径） */
export function distinctCargoTypes(values: ReadonlyArray<string | null | undefined>): CargoType[] {
  const out: CargoType[] = [];
  for (const raw of values) {
    const v = (raw ?? "").trim().toLowerCase();
    const known: CargoType = (CARGO_TYPES as readonly string[]).includes(v) ? (v as CargoType) : "normal";
    if (!out.includes(known)) out.push(known);
  }
  return out;
}

/**
 * 一票的产品行货型不止一种时给人看的那句话（页面和后端共用一份）；只有一种 / 没有产品行返回 null。
 * 只拿「填了的」来比 —— 空着的由调用方决定跟着整票走，别在这里当成普货去比。
 */
export function mixedCargoTypeIssue(values: ReadonlyArray<string | null | undefined>): string | null {
  const types = distinctCargoTypes(values);
  if (types.length <= 1) return null;
  return `一票只能有一个货型，现在这票的产品里有${types.map((t) => `「${CARGO_TYPE_ZH[t]}」`).join("")}${types.length} 种`;
}

/**
 * 打开一票来改时，整票那一格货型先显示哪个：有产品行看产品行（混着几种的老单取最严的 —— 跟原来整票记的是同一个），
 * 没有产品行看整票自己存的。认不出来的按普货。
 */
export function waybillCargoTypeOf(productTypes: ReadonlyArray<string | null | undefined>, orderType?: string | null): CargoType {
  if (productTypes.length > 0) return strictestCargoType(distinctCargoTypes(productTypes));
  return distinctCargoTypes([orderType])[0];
}
