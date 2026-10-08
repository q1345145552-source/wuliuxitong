/**
 * 到货通知的「产品明细」（2026-10-09，老板 10-08：「到货通知只能填一款产品，很多时候有好几款」）。
 *
 * 一条到货通知 = 一票货，底下可以有好几款产品（品名、件数、货型、国内快递单号，外加选填的长宽高、单箱数量、单箱重），
 * 跟员工「创建订单」的产品行一一对应。这里放前后端都要用的几条纯规矩，**两边各写一份就会对不上**：
 *   · 合计（件数 / 总重量 / 总体积 / 产品数量）怎么从各款算出来 —— 跟「创建订单」同一套算法
 *     （页面 orders/auto-totals.ts 的 productRowTotals、后端 orders/routes.ts 的 prPkg / prWeight / prVol）；
 *   · 主表上那几列「镜像」（品名 / 件数 / 国内单号 / 货型）怎么汇总 —— 只给回滚后的旧代码、没刷新的老页面用；
 *   · 转正式运单还缺哪几项、缺的是第几款。
 *
 * 纯函数，不碰库、不碰 DOM。
 */
import { strictestCargoType, type CargoType } from "./cargo-type";
import { productNamesLabel } from "./product-names";

/** 一条到货通知最多几款（再多就是填错了 / 页面出毛病了） */
export const MAX_NOTICE_PRODUCTS = 50;

/** 校验过、存进库的一款（null = 没填）。weightKg 是**单箱重**（同 order_products），不是这一款的总重 */
export interface NoticeProductValues {
  itemName: string | null;
  packageCount: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  productQuantity: number | null;
  weightKg: number | null;
  cargoType: CargoType;
  domesticTrackingNo: string | null;
}

type Loose = unknown;

/** 「没填」：null / undefined / 空串 / 全是空白 */
function isEmptyValue(v: Loose): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

/** 数字项：没填 = null；填了但不是数 = NaN（调用方自己决定怎么办，这里只做合计） */
function toNumber(v: Loose): number | null {
  if (isEmptyValue(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * 完全空白的一款：除货型外每项都没填，而且货型是普货（没选）。
 * 页面上「＋ 加一款」后什么都没填的那一行就是这种 —— 后端校验完丢掉，不存、不算缺。
 * 参数放宽成「随便什么值」：页面草稿里全是字符串，后端是 number / null，两边都能直接传。
 */
export function isBlankNoticeProduct(p: Partial<Record<keyof NoticeProductValues, Loose>>): boolean {
  const cargo = p.cargoType;
  if (!(isEmptyValue(cargo) || cargo === "normal")) return false;
  return (["itemName", "packageCount", "lengthCm", "widthCm", "heightCm", "productQuantity", "weightKg", "domesticTrackingNo"] as const)
    .every((k) => isEmptyValue(p[k]));
}

/**
 * 每款都齐了（至少一款，且每款都有品名、件数）。
 * 转运单时**齐了才建产品行、不齐一行都不建**（统一方案 2.5）：只建填齐的那几款，打标签会少打、
 * 件数会被当成整票件数。
 */
export function noticeProductsComplete(ps: ReadonlyArray<{ itemName?: Loose; packageCount?: Loose }>): boolean {
  return ps.length > 0 && ps.every((p) => !isEmptyValue(p.itemName) && !isEmptyValue(p.packageCount));
}

/**
 * 各款合计（跟「创建订单」同一套算法）：
 *   · packageCount：没有产品、或者任何一款件数没填 → null；否则各款件数之和
 *   · weightKg：只算单箱重和件数都有的款，Σ(单箱重 × 件数)；> 0 才返回，否则 null
 *   · volumeM3：只算长宽高都 > 0、件数也有的款，Σ(长 × 宽 × 高 × 件数 ÷ 1e6)；> 0 才返回，否则 null
 *   · productQuantity：每款都有单箱数量和件数时才算 Σ(单箱数量 × 件数)，否则 0
 * 求和后按数据库精度四舍五入（重量 2 位、体积 3 位），前后端同一个结果。
 * 正的微小体积舍成 0 时仍返回 0，不是 null：这是算出的合计，不能退回手填值。
 */
export function noticeProductTotals(ps: ReadonlyArray<{
  packageCount?: Loose; lengthCm?: Loose; widthCm?: Loose; heightCm?: Loose; productQuantity?: Loose; weightKg?: Loose;
}>): { packageCount: number | null; weightKg: number | null; volumeM3: number | null; productQuantity: number } {
  const pkgs = ps.map((p) => toNumber(p.packageCount));
  const packageCount = ps.length > 0 && pkgs.every((n) => n !== null) ? (pkgs as number[]).reduce((s, n) => s + n, 0) : null;

  let weight = 0;
  let volume = 0;
  ps.forEach((p, i) => {
    const pkg = pkgs[i];
    if (pkg === null) return;
    const w = toNumber(p.weightKg);
    if (w !== null) weight += w * pkg;
    const l = toNumber(p.lengthCm);
    const wd = toNumber(p.widthCm);
    const h = toNumber(p.heightCm);
    if (l !== null && wd !== null && h !== null && l > 0 && wd > 0 && h > 0) volume += (l * wd * h * pkg) / 1_000_000;
  });

  const qtys = ps.map((p) => toNumber(p.productQuantity));
  const productQuantity = ps.length > 0 && qtys.every((q) => q !== null) && pkgs.every((n) => n !== null)
    ? qtys.reduce<number>((s, q, i) => s + (q as number) * (pkgs[i] as number), 0)
    : 0;

  return {
    packageCount,
    weightKg: weight > 0 ? Math.round((weight + Number.EPSILON) * 100) / 100 : null,
    volumeM3: volume > 0 ? Math.round((volume + Number.EPSILON) * 1000) / 1000 : null,
    productQuantity,
  };
}

/** 各款的国内单号按顺序去重（文字去空格、空的不要） */
function domesticNos(ps: ReadonlyArray<{ domesticTrackingNo?: Loose }>): string[] {
  const out: string[] = [];
  for (const p of ps) {
    const t = isEmptyValue(p.domesticTrackingNo) ? "" : String(p.domesticTrackingNo).trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 按顺序第一个非空的国内单号（订单 / 运单上那一格用它，**不拼起来**：运单列表按整串相等筛国内单号） */
export function firstDomesticTrackingNo(ps: ReadonlyArray<{ domesticTrackingNo?: Loose }>): string | null {
  return domesticNos(ps)[0] ?? null;
}

/** 认得的货型；认不出 / 没填一律按普货（这里只做汇总，填错的拦截在后端校验那一步） */
function cargoOf(v: Loose): CargoType {
  return v === "inspection" || v === "sensitive" ? v : "normal";
}

/**
 * 主表上那几列「镜像」怎么写（只给回滚后的旧代码、部署期间的旧容器、没刷新的老页面看）：
 *   · itemName：各款品名拼起来「灯具 / 鞋」（同 productNamesLabel），没有就是 null
 *   · packageCount：上面合计出来的件数（有一款没填就是 null）
 *   · domesticTrackingNo：各款非空单号去重后用「、」拼起来 —— 老代码的 domesticNoTokens 认「、」，回滚后撞预报单照样能拆开比
 *   · cargoType：最严的那个；最严的是普货就存 null（主表上「没选」和「普货」一个意思）
 */
export function noticeLegacySummary(ps: ReadonlyArray<{
  itemName?: Loose; packageCount?: Loose; lengthCm?: Loose; widthCm?: Loose; heightCm?: Loose;
  productQuantity?: Loose; weightKg?: Loose; cargoType?: Loose; domesticTrackingNo?: Loose;
}>): { itemName: string | null; packageCount: number | null; domesticTrackingNo: string | null; cargoType: "inspection" | "sensitive" | null } {
  const name = productNamesLabel(ps.map((p) => ({ itemName: isEmptyValue(p.itemName) ? null : String(p.itemName) })));
  const nos = domesticNos(ps);
  const cargo = strictestCargoType(ps.map((p) => cargoOf(p.cargoType)));
  return {
    itemName: name || null,
    packageCount: noticeProductTotals(ps).packageCount,
    domesticTrackingNo: nos.length > 0 ? nos.join("、") : null,
    cargoType: cargo === "normal" ? null : cargo,
  };
}

/** 报错 / 缺项里的名字：两款及以上加「第N款」（index 从 0 数），只有一款时跟原来一样只写项目名 */
export function noticeFieldLabel(index: number, count: number, field: string): string {
  return count >= 2 ? `第${index + 1}款${field}` : field;
}

/**
 * 转正式运单还缺哪几项（中文名，按「创建订单」弹窗的顺序；前后端共用这一份，页面卡片上的「还缺：…」和后端拦截一字不差）：
 *   1. 运单号、唛头
 *   2. 品名：一款都没有报「品名」；有产品时每款缺品名各报一条（两款及以上带「第N款」）
 *   3. 仓库、运输方式、到仓日期
 *   4. 件数：同品名
 *   5. 单箱数量：只要有一款填了，没填的那几款各报一条（同「创建订单」产品行「全填或全空」）
 *   6. 重量、体积：看整票数（产品行算得出时已经被重算成产品行的合计）
 */
export function missingForFormalNotice(n: {
  trackingNo?: string | null;
  clientId?: string | null;
  warehouseId?: string | null;
  transportMode?: string | null;
  arrivedAt?: string | null;
  weightKg?: number | string | null;
  volumeM3?: number | string | null;
  products: ReadonlyArray<{ itemName?: Loose; packageCount?: Loose; productQuantity?: Loose }>;
}): string[] {
  const missing: string[] = [];
  const ps = n.products;
  const count = ps.length;
  if (isEmptyValue(n.trackingNo)) missing.push("运单号");
  if (isEmptyValue(n.clientId)) missing.push("唛头");
  if (count === 0) missing.push("品名");
  else ps.forEach((p, i) => { if (isEmptyValue(p.itemName)) missing.push(noticeFieldLabel(i, count, "品名")); });
  if (isEmptyValue(n.warehouseId)) missing.push("仓库");
  if (isEmptyValue(n.transportMode)) missing.push("运输方式");
  if (isEmptyValue(n.arrivedAt)) missing.push("到仓日期");
  if (count === 0) missing.push("件数");
  else ps.forEach((p, i) => { if (isEmptyValue(p.packageCount)) missing.push(noticeFieldLabel(i, count, "件数")); });
  if (ps.some((p) => !isEmptyValue(p.productQuantity))) {
    ps.forEach((p, i) => { if (isEmptyValue(p.productQuantity)) missing.push(noticeFieldLabel(i, count, "单箱数量")); });
  }
  if (isEmptyValue(n.weightKg)) missing.push("重量");
  if (isEmptyValue(n.volumeM3)) missing.push("体积");
  return missing;
}
