/**
 * 货型（普货 / 商检 / 敏感）—— 2026-09-11 老板：「批量上传运单的模板不正确，
 * 需要加一个货型，不然默认普货。」
 *
 * 库里存的是 `normal` / `inspection` / `sensitive`（schema.prisma 上就写着这三个），
 * 人填的是中文。批量导入原来**根本没有这一列**，一律写死 `cargoType: "normal"`，
 * 所以仓库表里填了「商检」的货导进系统全变普货，要人工一张张改回来。
 *
 * ⚠️ 认不出来的值**返回 null，让调用方报错**，绝不静默当普货 ——
 * 商检货被当普货走掉是真会出事的（清关要的单据完全不同），
 * 跟这个仓库其它地方一个规矩：宁可拦住让人改，也不偷偷填一个数。
 */
export const CARGO_TYPES = ["normal", "inspection", "sensitive"] as const;
export type CargoType = (typeof CARGO_TYPES)[number];

/** 存的值 → 中文（跟 ShipmentTableGrid 的 cargoTypeLabelOf 一致） */
export const CARGO_TYPE_ZH: Record<CargoType, string> = {
  normal: "普货",
  inspection: "商检",
  sensitive: "敏感",
};

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
export const CARGO_TYPE_HINT = "货型只能填「普货」「商检」「敏感」之一，留空按普货";

/**
 * 一张运单上多条产品行货型不一样时，运单这一层记哪个。
 *
 * 取**最严**的那个（敏感 > 商检 > 普货）：少报一张商检单会卡在清关，
 * 多报一张只是多准备材料。跟父单状态取「最慢」是同一个保守方向。
 */
export function strictestCargoType(values: readonly CargoType[]): CargoType {
  if (values.includes("sensitive")) return "sensitive";
  if (values.includes("inspection")) return "inspection";
  return "normal";
}

/**
 * 一票货在列表/导出里显示的货型（2026-09-11）。
 *
 * 一张运单底下几条产品行可能货型不一样，导出是一票一行，所以去重后拼起来：
 * 「普货 / 商检」。没有产品行的老单退回运单（或订单）自己的货型。
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
