/**
 * 整柜货物清单的校验和算式（2026-09-23）。
 *
 * ⚠️ 单独放一个文件是为了**能被测试真的调到** —— routes.ts 顶上 import 了 prisma，
 * 测试脚本隔离加载它会连带去连数据库，只能改成扫源码，而「扫源码证明不了行为」
 * 是这个项目踩过的坑（第十二轮的教训）。纯函数放这儿，测试直接调。
 */
import { DECIMAL_10_2, DECIMAL_10_3, requireDecimal } from "../core/decimal-guard";
import { parseNumericStrict, requirePositiveInt, requireProductWithinInt, requireSumWithinInt } from "../core/int-guard";

/** 货型取值，跟运单、集货两处保持一致 */
export const CARGO_TYPES = ["normal", "inspection", "sensitive"];

/** 柜型取值，跟「柜子管理」一致 */
export const CONTAINER_TYPES = ["20GP", "40HQ"];

/**
 * 整柜建进系统时的起点（老板 2026-09-23 定）。
 *
 * 柜子 SEALED（已封柜）⇄ 运单 loaded（已装柜）是现有那套映射里对应的一对
 * （见 containers/status-flow.ts 的 CONTAINER_TO_SHIPMENT）。两边必须一起对齐：
 * 只写运单不动柜子的话，员工一推柜子到「已封柜」就会给客户再写一条重复的「已装柜」。
 */
export const FCL_START_CONTAINER_STATUS = "SEALED";
export const FCL_START_SHIPMENT_STATUS = "loaded";

export interface FclProductInput {
  itemName?: string;
  packageCount?: number | string;
  quantityPerBox?: number | string;
  lengthCm?: number | string;
  widthCm?: number | string;
  heightCm?: number | string;
  unitWeightKg?: number | string;
  domesticTrackingNo?: string;
  cargoType?: string;
}

/** 一行货算出来的数（体积、重量、总数量），建单和预览共用 */
export interface FclProductRow {
  itemName: string;
  packageCount: number;
  quantityPerBox: number;
  productQuantity: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  unitWeightKg: number;
  weightKg: number;
  volumeM3: number;
  domesticTrackingNo: string | null;
  cargoType: string;
  sortOrder: number;
}

/**
 * 校验并算出一行货的数。
 *
 * ⚠️ 照抄集货那边 validateConsolidationProductRow 的教训：
 * 件数 / 每箱数量是数据库里的 Int，`!x || x < 1` 这种写法 **2.5 能过**；
 * 长宽高是 Decimal(10,2)，只判「填没填」会让负数、0、21 位小数全进得来。
 * 所以一律走 int-guard / decimal-guard 那两套现成的尺子。
 *
 * @returns 有问题返回给人看的中文提示；合格返回算好的行。
 */
export function parseFclProductRow(p: FclProductInput, index: number): { error: string } | { row: FclProductRow } {
  const label = `第 ${index + 1} 行`;
  const itemName = String(p.itemName ?? "").trim();
  if (!itemName) return { error: `${label}的品名没填` };

  const packageCount = parseNumericStrict(p.packageCount);
  const pkgIssue = requirePositiveInt(packageCount, `${label}的箱数`);
  if (pkgIssue) return { error: pkgIssue };

  // 每箱数量选填，不填按 1 算（客户清单上常常只有箱数）
  const quantityPerBox = p.quantityPerBox === undefined || p.quantityPerBox === null || String(p.quantityPerBox).trim() === ""
    ? 1
    : parseNumericStrict(p.quantityPerBox);
  const qpbIssue = requirePositiveInt(quantityPerBox, `${label}的每箱数量`);
  if (qpbIssue) return { error: qpbIssue };

  const totalIssue = requireProductWithinInt(packageCount, quantityPerBox, `${label}的总数量`);
  if (totalIssue) return { error: totalIssue };
  const productQuantity = packageCount * quantityPerBox;

  const dims: Array<[string, number]> = [
    ["长", parseNumericStrict(p.lengthCm)],
    ["宽", parseNumericStrict(p.widthCm)],
    ["高", parseNumericStrict(p.heightCm)],
  ];
  for (const [name, v] of dims) {
    const issue = requireDecimal(v, `${label}的${name}(cm)`, { ...DECIMAL_10_2, min: 0.01 });
    if (issue) return { error: issue };
  }
  const [lengthCm, widthCm, heightCm] = dims.map(([, v]) => v);

  // 单箱重量选填（清单上不一定有），不填按 0 算，总重就是 0
  const unitWeightKg = p.unitWeightKg === undefined || p.unitWeightKg === null || String(p.unitWeightKg).trim() === ""
    ? 0
    : parseNumericStrict(p.unitWeightKg);
  const weightIssue = requireDecimal(unitWeightKg, `${label}的单箱重量(kg)`, { ...DECIMAL_10_2, min: 0 });
  if (weightIssue) return { error: weightIssue };

  const cargoType = String(p.cargoType ?? "normal").trim() || "normal";
  if (!CARGO_TYPES.includes(cargoType)) return { error: `${label}的货型只能是普货 / 商检货 / 敏感货` };

  // 体积 = 长×宽×高÷1000000×箱数，口径跟集货和批量下单一致
  const volumeM3 = Number(((lengthCm * widthCm * heightCm) / 1_000_000 * packageCount).toFixed(6));
  const volIssue = requireDecimal(volumeM3, `${label}算出来的体积`, { ...DECIMAL_10_3, min: 0 });
  if (volIssue) return { error: `${label}的长宽高乘出来体积超出范围，请核对` };

  const weightKg = Number((unitWeightKg * packageCount).toFixed(2));
  const rowWeightIssue = requireDecimal(weightKg, `${label}算出来的总重`, { ...DECIMAL_10_2, min: 0 });
  if (rowWeightIssue) return { error: `${label}的单箱重量乘箱数超出范围，请核对` };

  return {
    row: {
      itemName,
      packageCount,
      quantityPerBox,
      productQuantity,
      lengthCm,
      widthCm,
      heightCm,
      unitWeightKg,
      weightKg,
      volumeM3,
      domesticTrackingNo: String(p.domesticTrackingNo ?? "").trim() || null,
      cargoType,
      sortOrder: index,
    },
  };
}

/** 整票汇总（件数、总重、总体积、总数量），并检查加起来会不会爆字段 */
export function sumFclRows(rows: FclProductRow[]): { error: string } | {
  packageCount: number; productQuantity: number; weightKg: number; volumeM3: number;
} {
  const pkgIssue = requireSumWithinInt(rows.map((r) => r.packageCount), "总箱数");
  if (pkgIssue) return { error: pkgIssue };
  const qtyIssue = requireSumWithinInt(rows.map((r) => r.productQuantity), "总数量");
  if (qtyIssue) return { error: qtyIssue };

  const weightKg = Number(rows.reduce((s, r) => s + r.weightKg, 0).toFixed(2));
  const volumeM3 = Number(rows.reduce((s, r) => s + r.volumeM3, 0).toFixed(3));
  const wIssue = requireDecimal(weightKg, "整柜总重", { ...DECIMAL_10_2, min: 0 });
  if (wIssue) return { error: wIssue };
  const vIssue = requireDecimal(volumeM3, "整柜总体积", { ...DECIMAL_10_3, min: 0 });
  if (vIssue) return { error: vIssue };

  return {
    packageCount: rows.reduce((s, r) => s + r.packageCount, 0),
    productQuantity: rows.reduce((s, r) => s + r.productQuantity, 0),
    weightKg,
    volumeM3,
  };
}

/** 一柜多行货时整票货型取最严的那个（敏感 > 商检 > 普货），跟建单、批量导入同一口径 */
export function strictestCargoType(types: string[]): string {
  if (types.includes("sensitive")) return "sensitive";
  if (types.includes("inspection")) return "inspection";
  return "normal";
}

