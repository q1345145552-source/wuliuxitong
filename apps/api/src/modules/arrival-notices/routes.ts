import * as crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { BusinessError } from "../core/business-error";
import { canSeeOperatorIdentity } from "../core/operator-visibility";
import { parseNumericStrict, requirePositiveInt, requireSumWithinInt } from "../core/int-guard";
import { DECIMAL_10_2, DECIMAL_10_3, checkTotalsWritable, requireDecimal, requireSumWithinDecimal } from "../core/decimal-guard";
import { UPLOAD_IMAGE_MAX_BASE64, uploadTooLargeMessage } from "../core/upload-limit";
import { deleteImageFile, imageFileUsable, readImageAsBase64, saveImageToDisk } from "../orders/image-storage";
import { buildNewOrderRows } from "../orders/new-order-rows";
import { validateProductRows } from "../orders/product-row-guard";
import { DEFAULT_STATUS_LABELS } from "../ai/ai-config-store";
import { ARRIVAL_WAREHOUSE_IDS, PENDING_INBOUND } from "./rules";
import { lockTrackingNoForArrivalNotice } from "./follow-tracking-no";
import { CARGO_TYPES, strictestCargoType, type CargoType } from "../../../../../packages/shared-types/cargo-type";
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";
import {
  MAX_NOTICE_PRODUCTS,
  firstDomesticTrackingNo,
  isBlankNoticeProduct,
  missingForFormalNotice,
  noticeFieldLabel,
  noticeLegacySummary,
  noticeProductTotals,
  noticeProductsComplete,
  type NoticeProductValues,
} from "../../../../../packages/shared-types/arrival-notice-products";

/**
 * 到货通知（2026-10-06 老板拍板）。规格原话见 schema.prisma 里 ArrivalNotice 那段注释，这里说怎么做的：
 *
 * - 一行 = 国内仓到的一票货。每一项都能先空着存（老板 1A：跟「创建订单」那几项一样 + 照片 + 备注）。
 * - 「已通知客户」是一个开关，跟转没转运单无关（没通知也能转、转了也能补点通知）。
 * - 转运单员工自己选（老板：「我个人偏向员工手动来分类，怕系统出错」），系统只查必填项：
 *     转正式运单 = 跟「创建订单」一样齐（运单号、唛头、品名、仓库、运输方式、到仓日期、件数、重量、体积）；
 *     转待入库   = 至少有运单号 + 唛头（老板 10-06「必须填运单号才能转」；运单必须挂在某个客户名下）。
 *   订单 / 运单 / 第一条轨迹用的是跟「创建订单」同一份 buildNewOrderRows，写出来一个样。
 * - 转成「待入库」以后，这一行还是这票货的底稿：在这里改、传照片、删照片，会在同一个事务里同步到那张运单；
 *   「运单管理」那边不许改待入库的单（admin/orders/update、staff/orders/patch-shipment-bundle 都挡了），
 *   免得两边互相盖掉。资料补全后在这里点「转正式运单」，运单从「待入库」变「已入库」，写一条轨迹。
 * - 转成正式运单后这一行只读（除了「已通知客户」开关）；要改去「运单管理」。
 * - 一票货可以有好几款产品（2026-10-09，老板 10-08「很多时候有好几款」）：产品在子表 arrival_notice_products，
 *   跟「创建订单」的产品行一一对应；整票总重量 / 总体积留在主表、产品行算得出就按产品行算。
 *   前后端共用的规矩（合计、主表镜像列、转正式缺什么）在 packages/shared-types/arrival-notice-products.ts。
 * - 转出去的运单在「运单管理」里被删了：这一行当作「没转」，可以重新转（不加外键，删运单那条路不用改）。
 *
 * 全部接口只给员工 / 超管。
 * ⚠️ 网址都比页面 /staff/arrival-notices 多一段：Next 先匹配页面再转发接口（next.config.ts），
 *    GET /staff/arrival-notices 会被页面接走，所以列表叫 /staff/arrival-notices/list。
 */

type Tx = Prisma.TransactionClient;

const STATUS_ZH: Record<string, string> = Object.fromEntries(DEFAULT_STATUS_LABELS.map((i) => [i.status, i.labelZh]));
function statusZh(status: string): string {
  return STATUS_ZH[status] ?? status;
}

/** 一条通知最多几张照片（够拍一票货的各个面；再多就是传错了） */
export const MAX_NOTICE_IMAGES = 20;

/** 到货照片只收这几种（电脑浏览器显示得了、image-storage.ts 认得扩展名）；跟页面 photo-upload.ts 的 DISPLAYABLE_PHOTO_TYPES 同一份（测试钉住） */
export const PHOTO_MIME_ALLOWED: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"];

const TEXT_LIMITS = { trackingNo: 64, itemName: 200, domesticTrackingNo: 100, remark: 500 } as const;

/** 照片小图（G03）最大多少（base64 字符数）：页面压成长边 360 的 JPEG，一般 20~40KB；超了说明传的不是小图，不收 */
export const THUMB_MAX_BASE64 = 200_000;

/**
 * 查到货通知一律带上照片和产品行（2026-10-09 多款产品）。
 * 所有 findFirst / findMany / create / update 回读都用这一份，免得哪一处漏带产品行、页面上那条通知「一款都没有」。
 */
const NOTICE_INCLUDE = {
  images: { orderBy: { createdAt: "asc" as const } },
  products: { orderBy: { sortOrder: "asc" as const } },
};

/**
 * 存进库之前、校验过的一行（null = 没填）。
 * 2026-10-09 多款产品：品名 / 件数 / 国内单号 / 货型挪进 products（一款一行）；
 * weightKg / volumeM3 是**整票**总重量、总体积（产品行算得出时按产品行重算，见 withDerivedTotals）。
 */
interface NoticeFields {
  clientId: string | null;
  trackingNo: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  transportMode: "sea" | "land" | null;
  warehouseId: string | null;
  arrivedAt: string | null;
  remark: string | null;
  /** 各款产品，按页面上的顺序；完全空白的款已经丢掉 */
  products: NoticeProductValues[];
}

/**
 * 没刷新的老页面（上线前打开的）平铺传上来的那一款：只有品名 / 件数 / 国内单号 / 货型四项。
 * 改资料时不能拿它整个替换库里那一款（会把长宽高、单箱数量、单箱重抹掉），要在锁里「盖」到库里那一款上（overlayLegacy）。
 */
interface LegacyProduct {
  values: NoticeProductValues;
  /** 请求里没有 cargoType 这个键（F11 之前的页面）：货型沿用库里的 */
  cargoOmitted: boolean;
}

type NoticeRow = Prisma.ArrivalNoticeGetPayload<{ include: typeof NOTICE_INCLUDE }>;

function num(v: Prisma.Decimal | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v.toString());
}

/** 文字项：空串当没填；超长给中文提示 */
function readText(raw: unknown, label: string, max: number): { value: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) raw = String(raw);
  if (typeof raw !== "string") return { error: `${label}要填文字` };
  const t = raw.trim();
  if (!t) return { value: null };
  if (t.length > max) return { error: `${label}太长了（最多 ${max} 个字）` };
  return { value: t };
}

/** 到仓日期：只认 YYYY-MM-DD 且真有这一天（同「创建订单」那道闸：2026-02-31 这种 new Date 不报错、会顺延） */
function readDate(raw: unknown): { value: string | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  if (typeof raw !== "string") return { error: "到仓日期要写成 2026-10-06 这种格式" };
  const t = raw.trim();
  if (!t) return { value: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const d = m ? new Date(`${t}T00:00:00`) : new Date(NaN);
  if (!m || Number.isNaN(d.getTime()) || d.getFullYear() !== Number(m[1]) || d.getMonth() + 1 !== Number(m[2]) || d.getDate() !== Number(m[3])) {
    return { error: `到仓日期「${t}」不是有效日期，请写成 2026-10-06 这种格式` };
  }
  return { value: t };
}

const PRODUCTS_SHAPE_ERROR = "产品明细格式不对，请刷新页面";

/** 数字项「没填」：undefined / null / 空串（跟原来 packageCount 那一格一样；全是空格的串照旧算填错） */
function blankRaw(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/**
 * 读一款产品（只做「填了的填得对不对」，不管必填）。
 * index / count 只用来在报错里写「第几款」：count 是**请求里原来的款数**（空白款也算），两款及以上才加「第N款」，
 * 只有一款时提示跟改版前一字不差。
 */
function readProduct(raw: Record<string, unknown>, index: number, count: number): { value: NoticeProductValues } | { error: string } {
  const label = (field: string) => noticeFieldLabel(index, count, field);
  const name = readText(raw.itemName, label("品名"), TEXT_LIMITS.itemName);
  if ("error" in name) return name;
  const dom = readText(raw.domesticTrackingNo, label("国内快递单号"), TEXT_LIMITS.domesticTrackingNo);
  if ("error" in dom) return dom;

  const ints = { packageCount: null as number | null, productQuantity: null as number | null };
  for (const [key, field] of [["packageCount", "件数"], ["productQuantity", "单箱数量"]] as const) {
    if (blankRaw(raw[key])) continue;
    const n = parseNumericStrict(raw[key]);
    const issue = requirePositiveInt(n, label(field));
    if (issue) return { error: issue };
    ints[key] = n;
  }

  let weightKg: number | null = null;
  if (!blankRaw(raw.weightKg)) {
    const issue = requireDecimal(raw.weightKg, label("单箱重"), DECIMAL_10_2);
    if (issue) return { error: issue };
    weightKg = parseNumericStrict(raw.weightKg);
  }

  // 长宽高：同「创建订单」产品行那道闸（orders/product-row-guard.ts）—— 只卡不是数 / 负数 / 大得离谱，不卡小数位
  const dims = { lengthCm: null as number | null, widthCm: null as number | null, heightCm: null as number | null };
  for (const [key, field] of [["lengthCm", "长"], ["widthCm", "宽"], ["heightCm", "高"]] as const) {
    if (blankRaw(raw[key])) continue;
    const v = parseNumericStrict(raw[key]);
    if (!Number.isFinite(v) || v < 0) return { error: `${label(field)}(cm)必须是不小于 0 的数字` };
    if (v >= 10 ** 8) return { error: `${label(field)}(cm)太大了，请核对` };
    dims[key] = v;
  }

  // 货型（F11）：不选 = 普货；认不出的值报错，绝不静默当普货（cargo-type.ts 的规矩）
  const cargo = raw.cargoType;
  let cargoType: CargoType;
  if (cargo === undefined || cargo === null || cargo === "") cargoType = "normal";
  else if (typeof cargo === "string" && (CARGO_TYPES as readonly string[]).includes(cargo)) cargoType = cargo as CargoType;
  else return { error: `${label("货型")}只能选普货、商检货、敏感货` };

  return {
    value: {
      itemName: name.value,
      packageCount: ints.packageCount,
      ...dims,
      productQuantity: ints.productQuantity,
      weightKg,
      cargoType,
      domesticTrackingNo: dom.value,
    },
  };
}

/**
 * 各款加起来也不许溢出（同「创建订单」product-row-guard.ts 的合计那几道：单款都合法、加起来爆 Int / Decimal 的要在门口拦，
 * 不然写库那一刻才炸成「服务器繁忙」）。
 */
function productSumsIssue(ps: NoticeProductValues[]): string | null {
  return requireSumWithinInt(ps.map((p) => p.packageCount ?? 0), "件数")
    ?? requireSumWithinInt(ps.map((p) => (p.packageCount !== null && p.productQuantity !== null ? p.packageCount * p.productQuantity : 0)), "产品数量")
    ?? requireSumWithinDecimal(ps.map((p) => (p.packageCount !== null && p.weightKg !== null ? p.weightKg * p.packageCount : 0)), "总重量", DECIMAL_10_2)
    ?? checkTotalsWritable({ volumes: [["总体积", noticeProductTotals(ps).volumeM3 ?? 0]] });
}

/**
 * 整票总重量 / 总体积：产品行算得出就用产品行算的（Σ 单箱重 × 件数、Σ 长 × 宽 × 高 × 件数），算不出才用手填的。
 * 跟「创建订单」一个口径（orders/routes.ts 的 prWeight / prVol > 0 就盖掉手填值）。保存时后端一定重算，不信页面传的合计。
 */
function withDerivedTotals(f: NoticeFields): NoticeFields {
  const t = noticeProductTotals(f.products);
  return { ...f, weightKg: t.weightKg ?? f.weightKg, volumeM3: t.volumeM3 ?? f.volumeM3 };
}

/**
 * 把请求里的各项理成 NoticeFields。只做「填了的填得对不对」，不管必填（必填看转到哪）。
 * ⚠️ 唛头不去空格：线上有「XPP-0015」和「XPP-0015 XHH-6698」这种带空格的账号（同「创建订单」的唛头框）。
 *
 * 产品（2026-10-09 多款）：
 *   · 带 products 这个键 = 新页面：逐款读，完全空白的款校验完丢掉；平铺的 itemName / packageCount / domesticTrackingNo / cargoType
 *     是给回滚后旧后端看的镜像，**一律不读、不校验**（拼起来的品名可能超 200 字，不能因为它报错）；
 *   · 不带 = 没刷新的老页面：平铺那四项拼成一款，legacy 里带回去，改资料时在锁里盖到库里那一款上。
 * 新页面的合计先按产品行重算；老页面在锁里沿用尺寸后再 withDerivedTotals。
 */
export function readNoticeFields(body: Record<string, unknown>): { fields: NoticeFields; legacy: LegacyProduct | null } | { error: string } {
  const out: Partial<NoticeFields> = {};

  const rawClient = body.clientId;
  if (rawClient === undefined || rawClient === null || rawClient === "") out.clientId = null;
  else if (typeof rawClient !== "string") return { error: "唛头要填文字" };
  else if (!rawClient.trim()) out.clientId = null;
  else if (rawClient.length > 100) return { error: "唛头太长了" };
  else out.clientId = rawClient;

  for (const [key, label] of [["trackingNo", "运单号"], ["remark", "备注"]] as const) {
    const r = readText(body[key], label, TEXT_LIMITS[key]);
    if ("error" in r) return r;
    out[key] = r.value;
  }

  let legacy: LegacyProduct | null = null;
  if (Object.prototype.hasOwnProperty.call(body, "products")) {
    const raw = body.products;
    if (!Array.isArray(raw)) return { error: PRODUCTS_SHAPE_ERROR };
    if (raw.length > MAX_NOTICE_PRODUCTS) return { error: `一条到货通知最多 ${MAX_NOTICE_PRODUCTS} 款产品` };
    const kept: NoticeProductValues[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const item = raw[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) return { error: PRODUCTS_SHAPE_ERROR };
      // 先校验、后丢空白款：报错里的「第几款」按请求里原来的位置数，跟页面上对得上
      const r = readProduct(item as Record<string, unknown>, i, raw.length);
      if ("error" in r) return r;
      if (!isBlankNoticeProduct(r.value)) kept.push(r.value);
    }
    out.products = kept;
  } else {
    const r = readProduct({ itemName: body.itemName, packageCount: body.packageCount, domesticTrackingNo: body.domesticTrackingNo, cargoType: body.cargoType }, 0, 1);
    if ("error" in r) return r;
    legacy = { values: r.value, cargoOmitted: !Object.prototype.hasOwnProperty.call(body, "cargoType") };
    out.products = isBlankNoticeProduct(r.value) ? [] : [r.value];
  }
  const sums = productSumsIssue(out.products);
  if (sums) return { error: sums };

  const derived = noticeProductTotals(out.products);
  for (const [key, label, rule] of [["weightKg", "重量", DECIMAL_10_2], ["volumeM3", "体积", DECIMAL_10_3]] as const) {
    // 自动合计不是手填数：旧页面可能发六位小数，小样也可能舍成 0。
    // 产品已逐项校验且合计已查溢出，忽略页面传的旧合计；无自动值时原手填校验不变。
    if (derived[key] !== null) { out[key] = derived[key]; continue; }
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") { out[key] = null; continue; }
    const issue = requireDecimal(raw, label, rule);
    if (issue) return { error: issue };
    out[key] = parseNumericStrict(raw);
  }

  const mode = body.transportMode;
  if (mode === undefined || mode === null || mode === "") out.transportMode = null;
  else if (mode === "sea" || mode === "land") out.transportMode = mode;
  else return { error: "运输方式只能选海运或陆运" };

  const wh = body.warehouseId;
  if (wh === undefined || wh === null || wh === "") out.warehouseId = null;
  else if (typeof wh === "string" && (ARRIVAL_WAREHOUSE_IDS as readonly string[]).includes(wh)) out.warehouseId = wh;
  else return { error: "仓库只能选义乌仓、广州仓、东莞仓、深圳仓" };

  const date = readDate(body.arrivedAt);
  if ("error" in date) return date;
  out.arrivedAt = date.value;

  return { fields: out as NoticeFields, legacy };
}

const EMPTY_PRODUCT: NoticeProductValues = {
  itemName: null, packageCount: null, lengthCm: null, widthCm: null, heightCm: null, productQuantity: null, weightKg: null, cargoType: "normal", domesticTrackingNo: null,
};

/**
 * 老页面那一款盖到库里那一款上：品名 / 件数 / 国内单号照老页面的（老页面一直是整份存，没填就是清空），
 * 长宽高、单箱数量、单箱重老页面根本看不到，沿用库里的；老页面没传货型这个键就沿用库里的货型。
 * 调用方先确认库里不超过一款（两款及以上老页面只看得到一款，不许存）。
 */
function overlayLegacy(legacy: LegacyProduct, current: NoticeProductValues[]): NoticeProductValues[] {
  const cur = current[0] ?? EMPTY_PRODUCT;
  const merged: NoticeProductValues = {
    ...cur,
    itemName: legacy.values.itemName,
    packageCount: legacy.values.packageCount,
    domesticTrackingNo: legacy.values.domesticTrackingNo,
    cargoType: legacy.cargoOmitted ? cur.cargoType : legacy.values.cargoType,
  };
  return isBlankNoticeProduct(merged) ? [] : [merged];
}

/** 转到哪还缺哪几项（中文名，按「创建订单」弹窗的顺序；转正式那份跟页面共用 missingForFormalNotice，按款点名） */
export function missingForTarget(f: NoticeFields, to: "formal" | "inbound"): string[] {
  if (to === "formal") return missingForFormalNotice(f);
  const missing: string[] = [];
  if (!f.trackingNo) missing.push("运单号");
  if (!f.clientId) missing.push("唛头");
  return missing;
}

const FIELD_ZH: Record<keyof NoticeFields, string> = {
  clientId: "唛头", trackingNo: "运单号", products: "产品明细", weightKg: "重量", volumeM3: "体积",
  transportMode: "运输方式", warehouseId: "仓库", arrivedAt: "到仓日期", remark: "备注",
};

/**
 * 产品明细整理成同一种写法再比：去掉空白款，每款按固定顺序排成数组。
 * NaN（base 里读不懂的数）单独写成一个记号 —— JSON.stringify 会把 NaN 写成 null，那样「读不懂」会被当成「没填」、比对就放过去了。
 */
function productsKey(ps: NoticeProductValues[]): string {
  const n = (v: number | null) => (v !== null && Number.isNaN(v) ? "NaN" : v);
  return JSON.stringify(ps.filter((p) => !isBlankNoticeProduct(p)).map((p) => [
    p.itemName, n(p.packageCount), n(p.lengthCm), n(p.widthCm), n(p.heightCm), n(p.productQuantity), n(p.weightKg), p.cargoType, p.domesticTrackingNo,
  ]));
}

/**
 * 打开「修改」弹窗那一刻看到的资料（base）跟库里现在的比，哪几项被别人改了（中文名）。
 * 防两个人同时改、后保存的把先保存的整份盖掉（2026-10-06 dsh 审查 S1）。
 * 只比资料、不比 updatedAt：同事这时点「标已通知」或传照片不算冲突，不该挡住正在改资料的人。
 * 产品明细整份比（任何一款任何一项变了都算「产品明细变了」）。
 */
export function changedSinceOpened(base: NoticeFields, now: NoticeFields): string[] {
  return (Object.keys(FIELD_ZH) as Array<keyof NoticeFields>)
    .filter((k) => (k === "products" ? productsKey(base.products) !== productsKey(now.products) : base[k] !== now[k]))
    .map((k) => FIELD_ZH[k]);
}

/** base 里的文字 / 数字：只整理不校验（空串当没填、文字去空格、数字转数字；读不懂的数是 NaN，跟谁都不相等 = 算变了） */
function baseText(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function baseNumber(v: unknown): number | null {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return null;
  return typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
}
function baseProduct(b: Record<string, unknown>): NoticeProductValues {
  return {
    itemName: baseText(b.itemName),
    packageCount: baseNumber(b.packageCount),
    lengthCm: baseNumber(b.lengthCm),
    widthCm: baseNumber(b.widthCm),
    heightCm: baseNumber(b.heightCm),
    productQuantity: baseNumber(b.productQuantity),
    weightKg: baseNumber(b.weightKg),
    // 认不出的货型按普货整理（这里只拿来比，填写校验在 readProduct）
    cargoType: b.cargoType === "inspection" || b.cargoType === "sensitive" ? b.cargoType : "normal",
    domesticTrackingNo: baseText(b.domesticTrackingNo),
  };
}

/**
 * 读页面传上来的 base：只做「跟库里比」要的整理（空串当没填、文字去空格、数字转数字），**不做填写校验**。
 * 不能拿 readNoticeFields 读：base 是库里原样的旧值，哪天仓库名单 / 字数上限改了，老记录的 base 过不了校验，
 * 会被当成「读不懂」一直挡、怎么存都存不上。读不成对象（或者 products 不是数组、里面有不是对象的）才算读不懂。
 * 老页面的 base 没有 products：平铺那四项拼成一款，跟 body 一样在锁里盖到库里那一款上再比（legacy 不为 null）。
 */
export function readOpenedBase(raw: unknown): { fields: NoticeFields; legacy: LegacyProduct | null } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  let products: NoticeProductValues[];
  let legacy: LegacyProduct | null = null;
  if (Object.prototype.hasOwnProperty.call(b, "products")) {
    if (!Array.isArray(b.products)) return null;
    if (b.products.some((p) => !p || typeof p !== "object" || Array.isArray(p))) return null;
    products = (b.products as Array<Record<string, unknown>>).map(baseProduct).filter((p) => !isBlankNoticeProduct(p));
  } else {
    const p = baseProduct({ itemName: b.itemName, packageCount: b.packageCount, domesticTrackingNo: b.domesticTrackingNo, cargoType: b.cargoType });
    legacy = { values: p, cargoOmitted: !Object.prototype.hasOwnProperty.call(b, "cargoType") };
    products = isBlankNoticeProduct(p) ? [] : [p];
  }
  return {
    fields: {
      // 唛头不去空格（同 readNoticeFields）
      clientId: typeof b.clientId === "string" && b.clientId.trim() ? b.clientId : null,
      trackingNo: baseText(b.trackingNo),
      weightKg: baseNumber(b.weightKg),
      volumeM3: baseNumber(b.volumeM3),
      transportMode: b.transportMode === "sea" || b.transportMode === "land" ? b.transportMode : null,
      warehouseId: baseText(b.warehouseId),
      arrivedAt: baseText(b.arrivedAt),
      remark: baseText(b.remark),
      products,
    },
    legacy,
  };
}

/** 库里那一款 → NoticeProductValues（货型认不出的按普货，同 cargoTypeLabel 的口径） */
function productOfRow(p: NoticeRow["products"][number]): NoticeProductValues {
  return {
    itemName: p.itemName,
    packageCount: p.packageCount,
    lengthCm: p.lengthCm,
    widthCm: p.widthCm,
    heightCm: p.heightCm,
    productQuantity: p.productQuantity,
    weightKg: p.weightKg,
    cargoType: p.cargoType === "inspection" || p.cargoType === "sensitive" ? p.cargoType : "normal",
    domesticTrackingNo: p.domesticTrackingNo,
  };
}

/**
 * 库里这一行 → NoticeFields。产品从产品行读；主表那几列镜像只在一种情况下读：
 * **没有产品行、但镜像列有值** —— 那是部署窗口里（迁移跑完、旧容器还没换下）旧代码新登记的，当成一款（统一方案 1 节「兜底」）。
 */
function fieldsOf(n: NoticeRow): NoticeFields {
  let products = n.products.map(productOfRow);
  if (products.length === 0) {
    const mirror: NoticeProductValues = {
      ...EMPTY_PRODUCT,
      itemName: n.itemName,
      packageCount: n.packageCount,
      domesticTrackingNo: n.domesticTrackingNo,
      cargoType: n.cargoType === "inspection" || n.cargoType === "sensitive" ? n.cargoType : "normal",
    };
    if (!isBlankNoticeProduct(mirror)) products = [mirror];
  }
  return {
    clientId: n.clientId,
    trackingNo: n.trackingNo,
    weightKg: num(n.weightKg),
    volumeM3: num(n.volumeM3),
    transportMode: n.transportMode === "sea" || n.transportMode === "land" ? n.transportMode : null,
    warehouseId: n.warehouseId,
    arrivedAt: n.arrivedAt,
    remark: n.remark,
    products,
  };
}

/** 回滚 / 新旧容器交接时旧版只写镜像：在通知行锁内拒绝覆盖，不猜两份数据哪边正确。
 * 无产品行是旧版新登记的合法形状，仍走 fieldsOf 兜底；纯手填总量不做派生比较。
 */
function assertProductSnapshotConsistent(n: NoticeRow): void {
  if (n.products.length === 0) return;
  const ps = n.products.map(productOfRow);
  const mirror = noticeLegacySummary(ps);
  const totals = noticeProductTotals(ps);
  const mismatch = n.itemName !== mirror.itemName || n.packageCount !== mirror.packageCount
    || n.domesticTrackingNo !== mirror.domesticTrackingNo || (n.cargoType === "normal" ? null : n.cargoType) !== mirror.cargoType
    || (totals.weightKg !== null && num(n.weightKg) !== totals.weightKg)
    || (totals.volumeM3 !== null && num(n.volumeM3) !== totals.volumeM3);
  if (mismatch) throw new BusinessError("这条到货通知的产品明细和旧版数据不一致，这次没有保存或转单。请联系管理员核对两份数据后再操作", 409, "VALIDATION_ERROR");
}

/** 撞预报单要比的那几个国内单号（每款各自的；fieldsOf 里含部署窗口的兜底那一款） */
function prealertKeyOf(n: NoticeRow): { id: string; domesticTrackingNos: Array<string | null> } {
  return { id: n.id, domesticTrackingNos: fieldsOf(n).products.map((p) => p.domesticTrackingNo) };
}

/** 唛头得是本公司的客户账号（同「创建订单」：不存在 / 别家公司 / 不是客户都挡） */
async function assertClient(tx: Tx | typeof prisma, companyId: string, clientId: string): Promise<void> {
  const u = await tx.user.findUnique({ where: { id: clientId }, select: { companyId: true, role: true } });
  if (!u || u.companyId !== companyId || u.role !== "client") {
    throw new BusinessError(`唛头「${clientId}」不存在，请核对（要选系统里已有的客户唛头）`);
  }
}

/** 运单号不能跟别的运单、别的到货通知重（自己转出去的那张运单不算） */
async function assertTrackingNoFree(tx: Tx | typeof prisma, companyId: string, trackingNo: string, selfNoticeId: string | null, selfShipmentId: string | null): Promise<void> {
  // 运单号在库里是全局唯一的（shipments.tracking_no @unique），所以查重不分公司，提示里不说是哪家的
  const ship = await tx.shipment.findFirst({
    where: { trackingNo, ...(selfShipmentId ? { NOT: { id: selfShipmentId } } : {}) },
    select: { companyId: true },
  });
  if (ship) {
    throw new BusinessError(ship.companyId === companyId
      ? `运单号 ${trackingNo} 已经有运单了（「运单管理」里搜得到），换一个号或核对一下`
      : `运单号 ${trackingNo} 已经被用过了，换一个号`);
  }
  const other = await tx.arrivalNotice.findFirst({
    where: { companyId, trackingNo, ...(selfNoticeId ? { NOT: { id: selfNoticeId } } : {}) },
    select: { id: true },
  });
  if (other) throw new BusinessError(`运单号 ${trackingNo} 已经登记在另一条到货通知里了，换一个号或核对一下`);
}

/**
 * 到货通知 → 订单 / 运单上的那几项（新建和同步共用一份，两边一个样）。
 * 2026-10-09 多款产品：产品行「要么全建、要么全不建」（统一方案 2.5）——
 *   每款都有品名和件数（noticeProductsComplete）才每款建一行，否则一行都不建。
 *   **绝不能只建填齐的那几款**：打标签会按产品行放行、少打；整票件数会被当成已填那几款的合计。
 */
function orderValuesOf(f: NoticeFields) {
  const totals = noticeProductTotals(f.products);
  const complete = noticeProductsComplete(f.products);
  /* 产品行照抄本款（同「创建订单」的产品行）：长宽高、单箱数量、单箱重员工填了才有 —— 填了下游会按尺寸算方数，
     跟「创建订单」分了产品行时一个样（原来只建一条不带长宽高的兜底行，CLAUDE.md 第 33 条说的是兜底行，不是这里）。
     国内单号空着写「货拉拉」（同「创建订单」）。 */
  const products = complete
    ? f.products.map((p, i) => ({
        itemName: p.itemName!,
        packageCount: p.packageCount!,
        lengthCm: p.lengthCm,
        widthCm: p.widthCm,
        heightCm: p.heightCm,
        productQuantity: p.productQuantity,
        cargoType: p.cargoType,
        domesticTrackingNo: p.domesticTrackingNo || "货拉拉",
        weightKg: p.weightKg,
        sortOrder: i,
      }))
    : [];
  return {
    clientId: f.clientId!,
    trackingNo: f.trackingNo!,
    /* 建了产品行：第一款的品名（同「创建订单」prName）；没建：各款品名拼起来「灯具 / 鞋」，
       列表 / 详情没有产品行时显示订单的品名，这样看得到全部品名。一款都没有就是空串（同改版前） */
    itemName: complete ? products[0].itemName : productNamesLabel(f.products),
    /* 件数：每款都填了才有合计，有一款没填 = null（F03）：运单这一列存 null（页面显示「—」）；订单那一列不许空，写库时再落成 0
       （syncToPendingShipment / buildNewOrderRows 里 `?? 0`）。0 在全系统都不是合法件数（各入口都要求正整数），
       所以订单上的 0 只会是「没填」，页面一律按「没填」显示（knownPackageCount），接口照旧给 0（统一方案 R6） */
    packageCount: totals.packageCount,
    // 整票重量 / 体积：主表上存的整票数（保存时已经按产品行重算过）
    weightKg: f.weightKg,
    volumeM3: f.volumeM3,
    // 产品数量：建了产品行才按 Σ 单箱数量 × 件数（单箱数量没填全就是 0，同「创建订单」）；没建是 0（到货通知没有整票的产品数量）
    productQuantity: complete ? totals.productQuantity : 0,
    // 待入库时可能还没填：订单这两列不许空，先存空串（列表上显示「—」），转正式时一定齐
    transportMode: f.transportMode ?? "",
    warehouseId: f.warehouseId ?? "",
    shipDate: f.arrivedAt,
    // 订单 / 运单上的国内单号取第一款的，**不拼起来**：运单列表按整串相等筛国内单号（orders/routes.ts）；各款自己的号在产品行上
    domesticTrackingNo: firstDomesticTrackingNo(f.products),
    // 不完整时没有订单产品行可供查询：运单保留全部单号，订单仍只存第一款（兼容其整串相等筛选）。
    shipmentDomesticTrackingNo: complete ? firstDomesticTrackingNo(f.products) : noticeLegacySummary(f.products).domesticTrackingNo,
    // 货型（F11）：各款取最严的（敏感 > 商检 > 普货），没有产品就是普货（同「创建订单」）
    cargoType: strictestCargoType(f.products.map((p) => p.cargoType)),
    products,
  };
}

/** 锁住这一行再重读（CLAUDE.md 第 28 条：锁完必须重读，判断用锁里读到的）。产品行只在这把锁里写，重读时一起带上 */
async function lockNotice(tx: Tx, companyId: string, id: string): Promise<NoticeRow> {
  await tx.$queryRaw`SELECT id FROM arrival_notices WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`;
  const n = await tx.arrivalNotice.findFirst({ where: { id, companyId }, include: NOTICE_INCLUDE });
  if (!n) throw new BusinessError("这条到货通知不存在了（可能刚被同事删掉），请刷新", 404, "NOT_FOUND");
  return n;
}

/**
 * 转出去的那张运单（连它的订单一起锁住）；运单已经被删了返回 null。
 *
 * ⚠️ 锁序跟全系统一样「订单 → 运单」（删订单、改单、确认收货都是先锁订单再锁运单）。
 * 第一版是「运单 → 订单」（先锁运单，同步时再去改订单），跟删订单正好反着，两人同时点会死锁
 * （2026-10-06 dsh / Codex 审查都报了）。所以先不加锁读出它挂在哪张订单上，锁订单，再锁运单，最后重读核对。
 * 订单用 FOR NO KEY UPDATE：不挡装柜插子单时对订单的外键检查（同 orders/routes.ts 确认收货那处）。
 */
async function lockLinkedShipment(tx: Tx, n: NoticeRow) {
  if (!n.convertedTo || !n.shipmentId) return null;
  const peek = await tx.shipment.findFirst({ where: { id: n.shipmentId, companyId: n.companyId }, select: { orderId: true } });
  if (!peek) return null;
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${peek.orderId} AND company_id = ${n.companyId} FOR NO KEY UPDATE`;
  await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${n.shipmentId} AND company_id = ${n.companyId} FOR UPDATE`;
  const ship = await tx.shipment.findFirst({
    where: { id: n.shipmentId, companyId: n.companyId },
    select: { id: true, orderId: true, currentStatus: true, trackingNo: true },
  });
  // 读订单号和上锁之间运单被删了：当作已删（下面按「没转」处理）
  if (!ship) return null;
  if (ship.orderId !== peek.orderId) throw new BusinessError("这张运单刚刚被别人改动过，请刷新后再试");
  return ship;
}

/** 运单不在「待入库」了（比如轨迹被删、状态被改）：到货通知不能再往它身上写 */
function assertStillPendingInbound(ship: { currentStatus: string }): void {
  if (ship.currentStatus !== PENDING_INBOUND) {
    throw new BusinessError(`那张运单现在是「${statusZh(ship.currentStatus)}」，不是待入库了，到货通知这边不能再改它；要改请到「运单管理」`);
  }
}


/** 把到货通知的当前内容写到「待入库」那张运单上（订单、运单、产品行；照片另算） */
async function syncToPendingShipment(tx: Tx, companyId: string, f: NoticeFields, ship: { id: string; orderId: string }): Promise<void> {
  const v = orderValuesOf(f);
  const weight = v.weightKg as unknown as Prisma.Decimal | null;
  const volume = v.volumeM3 as unknown as Prisma.Decimal | null;
  await tx.order.update({
    where: { id: ship.orderId },
    data: {
      clientId: v.clientId,
      warehouseId: v.warehouseId,
      itemName: v.itemName,
      // 产品数量（2026-10-09 多款）：原来这里不写，待入库时补齐产品行订单上的产品数量还是 0
      productQuantity: v.productQuantity,
      packageCount: v.packageCount ?? 0, // 订单这一列不许空：0 = 还没填（见 orderValuesOf）
      weightKg: weight,
      volumeM3: volume,
      shipDate: v.shipDate,
      domesticTrackingNo: v.domesticTrackingNo,
      transportMode: v.transportMode,
      cargoType: v.cargoType, // F11：原来漏写，待入库时改了货型订单上不跟
    },
  });
  await tx.shipment.update({
    where: { id: ship.id },
    data: {
      trackingNo: v.trackingNo,
      packageCount: v.packageCount,
      weightKg: weight,
      volumeM3: volume,
      transportMode: v.transportMode,
      domesticTrackingNo: v.shipmentDomesticTrackingNo,
      warehouseId: v.warehouseId,
    },
  });
  // 待入库那张单的产品行只从这里来（运单管理那边不许改它），整份换掉最省事也最不会错
  await tx.orderProduct.deleteMany({ where: { orderId: ship.orderId, companyId } });
  if (v.products.length > 0) {
    await tx.orderProduct.createMany({ data: v.products.map((p) => ({ ...p, companyId, orderId: ship.orderId })) });
  }
}

/**
 * 到货照片复制一份成运单的「产品图片」（运单详情、客户「运单查询」里看得到；客户本来就收到了这些照片）。
 * 复制文件而不是共用：运单那边删产品图会连文件一起删（orders/routes.ts DELETE product-images），共用的话到货通知这边就裂图了。
 *   mode=all：新建的运单，每张都复制（之前转过、运单被删了的那些 orderImageId 是死的，一起重来）；
 *   mode=uncopied：待入库那张运单上已有的就不重复复制，但要**核实那份真的还在**（记录在、文件在）才算数
 *     （2026-10-06 Codex 第二轮 M1：原来见了 orderImageId 就跳过，运单那份文件丢了照样转正式，正式运单永远缺这张图）。
 *     那份没了就从到货照片重新复制一份；到货照片的文件也没了，整个转运单不做、点名是哪张。
 *     （待入库的单在「运单管理」那边删不了产品图 —— 后端挡了 —— 所以「那份没了」只会是异常，不是有人特意删的。）
 * created 收集新写的文件，事务失败时调用方负责删掉。
 */
async function copyImagesToOrder(tx: Tx, n: { companyId: string; images: NoticeRow["images"] }, orderId: string, uploadedBy: string, mode: "all" | "uncopied", created: string[]): Promise<void> {
  for (const img of n.images) {
    if (mode === "uncopied" && img.orderImageId) {
      const copy = await tx.orderProductImage.findFirst({ where: { id: img.orderImageId, companyId: n.companyId, orderId }, select: { id: true, filePath: true } });
      if (copy?.filePath && imageFileUsable(copy.filePath)) continue; // 运单那份好好的（文件在、不是空的；只看大小不读整张图）
      // 记录还在、文件没了：先删掉这条坏记录（不然运单详情里一直挂着一张裂图），下面重新复制
      if (copy) await tx.orderProductImage.delete({ where: { id: copy.id } });
    }
    const b64 = readImageAsBase64(img.filePath);
    /* 文件在盘上找不到了：整个转运单回滚、说清楚是哪张（Codex 审查：原来跳过这张照样转成功，
       转完到货通知就只读了，运单永远缺这张图，谁也不知道） */
    if (!b64) throw new BusinessError(`照片「${img.fileName}」的文件找不到了，请点「修改」把这张删掉重新传，再转`);
    const filePath = saveImageToDisk(orderId, img.mime, b64);
    created.push(filePath);
    const opiId = `opi_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    await tx.orderProductImage.create({
      data: {
        id: opiId,
        companyId: n.companyId,
        orderId,
        fileName: img.fileName,
        mime: img.mime,
        // 这一列是老的「图片存库里」写法，现在页面全按 file_path 取图（orders/product-images.ts），复制的不再塞一份进库
        contentBase64: "",
        filePath,
        uploadedBy,
        createdAt: new Date(),
      },
    });
    await tx.arrivalNoticeImage.update({ where: { id: img.id }, data: { orderImageId: opiId } });
  }
}

/** 事务里写了文件、事务又失败了：把这次新写的文件删掉，盘上不留孤儿 */
function removeFiles(paths: string[]): void {
  for (const p of paths) {
    try { deleteImageFile(p); } catch { /* 删不掉就算了，不影响报错本身 */ }
  }
}

/**
 * 运单号撞了数据库唯一约束 → 说人话。两种：
 *   · 到货通知自己的（同公司同一个号只能登记一条）：两个人同时登记 / 改成同一个号；
 *   · 运单的（shipments.tracking_no 全局唯一）：查重和写库之间被别人用掉。
 */
export function translateUniqueClash(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    const meta = (e.meta ?? {}) as { modelName?: string; target?: unknown };
    // Prisma 5 的 target 是字段名数组（["companyId","trackingNo"]），也可能是列名 / 索引名，两种写法都认（dsh 第二轮：原来只认 company_id 那半是死的）
    if (meta.modelName === "ArrivalNotice" || /companyId|company_id/.test(String(meta.target ?? ""))) {
      throw new BusinessError("这个运单号刚刚被另一条到货通知登记了，换一个号或核对一下");
    }
    throw new BusinessError("这个运单号刚刚被用掉了，换一个号再转");
  }
  throw e;
}

/**
 * 同一个国内快递单号，客户已经报过预报单（F01，2026-10-08）。
 * 老板 5A：有预报单的货在「预报单审核」点「确认收货」，到货通知只登记没预报单的货 —— 原来全靠员工自己记，
 * 记漏了就会同一票货两张运单（客户看到两票、装柜能装两遍）。这里只提醒不拦（规则 1：系统不替员工分）：
 * 卡片上一直挂着，转运单要在确认框里点「确定」、带着这几张预报单的 id 来。
 * 只比「客户预报单」（approvalStatus shipped = 还没确认收货、received = 已经确认收货），不比员工「创建订单」建的单（原来就不查，不在这次范围）。
 */
export interface PrealertMatch {
  orderId: string;
  /** 预报单的运单号（YWYB…）；老数据没有运单时用订单号 */
  trackingNo: string | null;
  /** 预报单的唛头（可能跟这条到货通知填的不一样 —— 那多半是唛头填错了） */
  clientId: string;
  /** 撞上的那个国内单号（已大写） */
  domesticTrackingNo: string;
  /** true = 那张预报单已经在「预报单审核」确认收货了（再转就是第二张运单） */
  received: boolean;
}

/**
 * 国内单号拆成几个号来比：客户有时一格里填好几个（空格 / 逗号 / 顿号 / 分号 / 斜杠隔开）。
 * 不带数字的（「货拉拉」「无」）、短于 6 位的不拿去比，免得乱撞。统一大写，整号相等才算撞上。
 */
export function domesticNoTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[\s,，、;；/]+/).map((t) => t.trim().toUpperCase()).filter((t) => t.length >= 6 && /\d/.test(t)))].slice(0, 10);
}

/**
 * 一批到货通知各自撞上了哪些预报单（列表一页一次查完；只读、不加锁）。
 * 2026-10-09 多款产品：每条通知带的是各款各自的国内单号，各自拆号后合并去重。每款仍然最多取 10 个号（domesticNoTokens），
 * 合并以后**不再截断**（最多 50 款 × 10 个）—— 截了就会悄悄漏比后面几款。
 */
export async function findPrealertMatches(
  db: Tx | typeof prisma,
  companyId: string,
  notices: ReadonlyArray<{ id: string; domesticTrackingNos: ReadonlyArray<string | null> }>,
): Promise<Map<string, PrealertMatch[]>> {
  const out = new Map<string, PrealertMatch[]>();
  const tokensById = new Map(notices.map((n) => [n.id, [...new Set(n.domesticTrackingNos.flatMap((v) => domesticNoTokens(v)))]]));
  const all = [...new Set([...tokensById.values()].flat())];
  if (all.length === 0) return out;
  // 先用 contains 粗筛（预报单那一格也可能写了好几个号），下面再按整号比。
  // 200 只是每批大小，不能截断候选当作没有撞单；短号的精确匹配可能在第 201 条以后。
  const PREALERT_SCAN_LIMIT = 200;
  const loadPage = (cursor?: string) => db.order.findMany({
    where: {
      companyId,
      approvalStatus: { in: ["shipped", "received"] },
      OR: all.flatMap((t) => [
        { domesticTrackingNo: { contains: t, mode: "insensitive" as const } },
        { products: { some: { companyId, domesticTrackingNo: { contains: t, mode: "insensitive" as const } } } },
      ]),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: PREALERT_SCAN_LIMIT,
    select: {
      id: true, clientId: true, orderNo: true, approvalStatus: true, domesticTrackingNo: true,
      products: { where: { companyId }, select: { domesticTrackingNo: true } },
      shipments: { where: { parentTrackingNo: null }, orderBy: { createdAt: "asc" }, take: 1, select: { trackingNo: true } },
    },
  });
  const orders = await loadPage();
  let page = orders;
  while (page.length === PREALERT_SCAN_LIMIT) {
    page = await loadPage(page[page.length - 1].id);
    orders.push(...page);
  }
  for (const [id, tokens] of tokensById) {
    if (tokens.length === 0) continue;
    const hits: PrealertMatch[] = [];
    for (const o of orders) {
      const theirs = new Set([o.domesticTrackingNo, ...o.products.map((p) => p.domesticTrackingNo)].flatMap((v) => domesticNoTokens(v)));
      const hit = tokens.find((t) => theirs.has(t));
      if (hit) hits.push({ orderId: o.id, trackingNo: o.shipments[0]?.trackingNo ?? o.orderNo, clientId: o.clientId, domesticTrackingNo: hit, received: o.approvalStatus === "received" });
    }
    if (hits.length) out.set(id, hits);
  }
  return out;
}

/**
 * 列表 / 存完返回给页面的一行。
 * 登记人、通知人只给超管（老板 2026-09-15：员工也不能看到是哪个账号操作的，core/operator-visibility.ts）。
 */
function toDto(n: NoticeRow, ship: { currentStatus: string; trackingNo?: string } | null | undefined, viewerRole: string, prealertMatches: PrealertMatch[] = []) {
  const showWho = canSeeOperatorIdentity(viewerRole);
  const f = fieldsOf(n);
  /* 顶层的品名 / 件数 / 国内单号 / 货型（2026-10-09）：按各款汇总，只给没刷新的老页面看（新页面看 products）。
     只有一款时就是那一款自己的值，跟改版前一样 */
  const legacy = noticeLegacySummary(f.products);
  // 转过、但那张运单已经被删了：当作没转（页面上提示一句，可以重转）
  const shipmentGone = Boolean(n.convertedTo && n.shipmentId && !ship);
  return {
    id: n.id,
    clientId: n.clientId,
    /* 转出去的运单还在：显示运单**现在**的号（F06）—— 转正式后在「运单管理」改过号，这里还写旧号，
       按新号搜不到、点「物流轨迹」也对不上。没转 / 运单被删了：显示自己登记的那个 */
    trackingNo: !shipmentGone && ship?.trackingNo ? ship.trackingNo : n.trackingNo,
    itemName: legacy.itemName,
    packageCount: legacy.packageCount,
    /** 整票总重量 / 总体积（库里存的，保存时已按产品行重算） */
    weightKg: num(n.weightKg),
    volumeM3: num(n.volumeM3),
    transportMode: n.transportMode,
    domesticTrackingNo: legacy.domesticTrackingNo,
    warehouseId: n.warehouseId,
    arrivedAt: n.arrivedAt,
    /** 货型（F11）；null = 普货（各款最严的那个，只会是 inspection / sensitive / null） */
    cargoType: legacy.cargoType,
    /** 各款产品（2026-10-09），按顺序；不带 id。部署窗口里旧代码登记、还没产品行的，按主表那几列当一款 */
    products: f.products.map((p) => ({
      itemName: p.itemName,
      packageCount: p.packageCount,
      lengthCm: p.lengthCm,
      widthCm: p.widthCm,
      heightCm: p.heightCm,
      productQuantity: p.productQuantity,
      weightKg: p.weightKg,
      cargoType: p.cargoType,
      domesticTrackingNo: p.domesticTrackingNo,
    })),
    remark: n.remark,
    notifiedAt: n.notifiedAt?.toISOString() ?? null,
    notifiedByName: showWho ? n.notifiedByName : null,
    convertedTo: shipmentGone ? null : (n.convertedTo as "inbound" | "formal" | null),
    shipmentId: shipmentGone ? null : n.shipmentId,
    shipmentStatus: shipmentGone ? null : (ship?.currentStatus ?? null),
    shipmentGone,
    convertedAt: shipmentGone ? null : (n.convertedAt?.toISOString() ?? null),
    createdByName: showWho ? n.createdByName : null,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
    // thumbUrl（G03）：列表卡片显示小图；老照片 / 老页面传的没有小图，给原图
    images: n.images.map((i) => ({ id: i.id, fileName: i.fileName, imageUrl: i.filePath, thumbUrl: i.thumbPath ?? i.filePath })),
    /** 同一国内单号的客户预报单（F01）；空数组 = 没撞上 */
    prealertMatches,
  };
}

async function loadDto(companyId: string, id: string, viewerRole: string) {
  const n = await prisma.arrivalNotice.findFirst({ where: { id, companyId }, include: NOTICE_INCLUDE });
  if (!n) return null;
  const ship = n.shipmentId
    ? await prisma.shipment.findFirst({ where: { id: n.shipmentId, companyId }, select: { currentStatus: true, trackingNo: true } })
    : null;
  const matches = await findPrealertMatches(prisma, companyId, [prealertKeyOf(n)]);
  return toDto(n, ship, viewerRole, matches.get(n.id) ?? []);
}

/** 页签：待通知（没通知的全部，转没转都算）/ 已通知（还没转）/ 待入库 / 已转正式 / 全部。待通知跟后两个会有重叠，数字加起来不等于全部 */
const TABS = ["todo", "notified", "inbound", "formal", "all"] as const;
type Tab = (typeof TABS)[number];
/**
 * 页签条件。gone = 转过、但那张运单已经在「运单管理」里被删了的那几条：按「没转」算，
 * 跟每一行 toDto 的显示同一个口径（Codex 审查：原来页签按库里的 convertedTo 分，它们卡在「待入库 / 已转运单」里，
 * 行上却显示「可以重新转」，两边说法打架）。
 */
function tabWhere(tab: Tab, gone: string[]): Prisma.ArrivalNoticeWhereInput {
  const notConverted: Prisma.ArrivalNoticeWhereInput = { OR: [{ convertedTo: null }, { id: { in: gone } }] };
  /* 待通知 = 还没点「已通知客户」的全部（F02，2026-10-08）：转了单不等于通知了客户 ——
     先转单、后通知是允许的（老板「然后还可以转」，不卡先后），原来转过单的就从这里消失，客服按这个页签干活会漏发。
     已通知 / 待入库 / 已转运单三个页签不变（已通知 = 通知过、还等着转的那批） */
  if (tab === "todo") return { notifiedAt: null };
  if (tab === "notified") return { AND: [notConverted, { notifiedAt: { not: null } }] };
  if (tab === "inbound") return { convertedTo: "inbound", id: { notIn: gone } };
  if (tab === "formal") return { convertedTo: "formal", id: { notIn: gone } };
  return {};
}

function bodyOf(req: HttpRequest): Record<string, unknown> {
  const b = req.body;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

function idOf(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export function registerArrivalNoticeRoutes(app: MinimalHttpApp): void {
  /** 列表：按登记时间倒序，带页签数字 */
  app.get("/staff/arrival-notices/list", async (req: HttpRequest, res: HttpResponse) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const tab: Tab = (TABS as readonly string[]).includes(req.query.tab ?? "") ? (req.query.tab as Tab) : "all";
    const keyword = (req.query.keyword ?? "").trim().slice(0, 100);
    const page = Math.max(parseInt(req.query.page ?? "", 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize ?? "", 10) || 50, 1), 200);
    const base: Prisma.ArrivalNoticeWhereInput = { companyId: auth.companyId };
    /* 搜索词里的 % _ \ 按字面算（2026-10-08 模拟数据测试）：Prisma 的 contains 不转义，原样拼进 ILIKE，
       搜一个「_」或「%」几乎全出来。PostgreSQL 的 LIKE 默认用反斜杠转义 */
    const like = keyword.replace(/[\\%_]/g, "\\$&");
    /* 转过、但运单已经被删了的（通常一条都没有）：页签按「没转」算。
       下面这几句放在同一个「可重复读」快照里：不然算 gone、数页签、拉这一页、查运单状态之间正好有人删 / 转了一张，
       同一次返回里页签数字和行上的说法会打架（2026-10-06 Codex 第二轮 S1；只读，不锁任何行） */
    const { total, rows, counts, shipMap, matches } = await prisma.$transaction(async (tx) => {
      const goneRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT n.id FROM arrival_notices n
        LEFT JOIN shipments s ON s.id = n.shipment_id
        WHERE n.company_id = ${auth.companyId} AND n.converted_to IS NOT NULL AND n.shipment_id IS NOT NULL AND s.id IS NULL`;
      const gone = goneRows.map((r) => r.id);
      /* 运单号按卡片上**显示**的那个号搜（2026-10-08 模拟数据测试）：转出去的运单还在时，卡片显示运单现在的号（toDto，F06），
         原来却只比到货通知自己存的号 —— 迁移跳过的老数据（两张运单互换了号、改成了另一条到货通知登记着的号）
         按卡片上的号搜不到，或者搜出另一张卡。现在：运单还在的按运单现在的号比；没转 / 运单被删了按自己存的号比（同 toDto 的判断） */
      /* ⚠️ 不能把「运单现在的号搜得上的已转通知」整串 id 带进下面 7 句（2026-10-08 模拟数据测试第 2 轮）：
         关键词一宽（输个「2」「YW」），已转的几乎全命中，id 清单随数据量线性变长 —— 实测 8 千条慢 5 倍，
         3.3 万条撞 Prisma 绑定参数上限 32767 直接 500，已转的到货通知只增不减，早晚撞上。
         改成只把「存的号跟运单现在的号对不上」的那几条单独拎出来（正常情况下 followShipmentTrackingNos 一直跟着，只有迁移跳过的老数据，个位数）：
         对得上的照旧按自己存的号比（跟按运单号比是一回事）；对不上的按运单现在的号比，由 staleHit 带进去。 */
      const staleRows = keyword
        ? await tx.$queryRaw<Array<{ id: string; hit: boolean }>>`
            SELECT n.id, (s.company_id = n.company_id AND s.tracking_no ILIKE ${`%${like}%`}) AS hit
            FROM arrival_notices n
            JOIN shipments s ON s.id = n.shipment_id
            WHERE n.company_id = ${auth.companyId} AND n.converted_to IS NOT NULL
              AND (s.company_id <> n.company_id OR s.tracking_no IS DISTINCT FROM n.tracking_no)`
        : [];
      const staleIds = staleRows.map((r) => r.id);
      const staleHit = staleRows.filter((r) => r.hit).map((r) => r.id);
      const search: Prisma.ArrivalNoticeWhereInput = keyword
        ? {
            OR: [
              { clientId: { contains: like, mode: "insensitive" } },
              { id: { in: staleHit } },
              { trackingNo: { contains: like, mode: "insensitive" }, ...(staleIds.length ? { id: { notIn: staleIds } } : {}) },
              // 主表这两列（镜像）留着：部署窗口里旧代码登记、还没产品行的那几条靠它们搜到
              { domesticTrackingNo: { contains: like, mode: "insensitive" } },
              { itemName: { contains: like, mode: "insensitive" } },
              // 2026-10-09 多款产品：按任何一款的品名 / 国内单号都搜得到（镜像列里的品名、单号拼过，但别指望它）
              { products: { some: { OR: [{ itemName: { contains: like, mode: "insensitive" } }, { domesticTrackingNo: { contains: like, mode: "insensitive" } }] } } },
            ],
          }
        : {};
      const where: Prisma.ArrivalNoticeWhereInput = { AND: [base, search, tabWhere(tab, gone)] };
      const total = await tx.arrivalNotice.count({ where });
      const rows = await tx.arrivalNotice.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: NOTICE_INCLUDE,
      });
      const counts: number[] = [];
      for (const t of TABS) counts.push(await tx.arrivalNotice.count({ where: { AND: [base, search, tabWhere(t, gone)] } }));
      const shipIds = rows.map((r) => r.shipmentId).filter((v): v is string => Boolean(v));
      const ships = shipIds.length
        ? await tx.shipment.findMany({ where: { id: { in: shipIds }, companyId: auth.companyId }, select: { id: true, currentStatus: true, trackingNo: true } })
        : [];
      const matches = await findPrealertMatches(tx, auth.companyId, rows.map(prealertKeyOf));
      return { total, rows, counts, shipMap: new Map(ships.map((s) => [s.id, s])), matches };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000, maxWait: 10000 });
    ok(res, {
      items: rows.map((r) => toDto(r, r.shipmentId ? shipMap.get(r.shipmentId) : null, auth.role, matches.get(r.id) ?? [])),
      total,
      page,
      pageSize,
      counts: Object.fromEntries(TABS.map((t, i) => [t, counts[i]])) as Record<Tab, number>,
    });
  });

  /** 登记 / 修改（不带 id = 新登记） */
  app.post("/staff/arrival-notices/save", async (req: HttpRequest, res: HttpResponse) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = bodyOf(req);
    const id = idOf(body.id);
    const parsed = readNoticeFields(body);
    if ("error" in parsed) { fail(res, 400, "VALIDATION_ERROR", parsed.error); return; }
    /* 整票重量 / 体积按产品行重算（算得出就用算出来的）。老页面改资料时那一款要在锁里盖到库里那一款上、再算一遍（见下面） */
    let f = withDerivedTotals(parsed.fields);
    if (f.clientId) await assertClient(prisma, auth.companyId, f.clientId);

    if (!id) {
      /* 新登记是插入一行，没有现成的行可锁。两个人同一瞬间登记同一个号，由表上的唯一约束（公司 + 运单号）兜底，撞了翻成中文。
         但「运单表里有没有这个号」没有唯一约束兜（两张表各管各的）：同事在「运单管理」把某张运单改成这个号的同一瞬间，
         两边各查各的都放行，运单和这条到货通知就成了同一个号，这条从此转不了（修复第 3 轮实测 15 次 14~15 次复现）。
         所以带运单号的登记先拿号锁（跟两条改号路同一把，lockTrackingNoForArrivalNotice），在锁里查重、插入，到提交才放。
         老页面新登记：平铺那四项已经拼成一款（readNoticeFields），不用看库 */
      const newId = `an_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
      // 撞没撞预报单只看各款的国内单号：在 create 之前查（create 之后到回给页面之间不许再碰库，测试 A7）
      const newMatches = (await findPrealertMatches(prisma, auth.companyId, [{ id: newId, domesticTrackingNos: f.products.map((p) => p.domesticTrackingNo) }])).get(newId) ?? [];
      let created: NoticeRow;
      try {
        created = await prisma.$transaction(async (tx) => {
          if (f.trackingNo) {
            await lockTrackingNoForArrivalNotice(tx, f.trackingNo);
            await assertTrackingNoFree(tx, auth.companyId, f.trackingNo, null, null);
          }
          return tx.arrivalNotice.create({
            data: {
              id: newId,
              companyId: auth.companyId,
              ...noticeData(f),
              products: { create: productRowsOf(auth.companyId, f) },
              createdBy: auth.userId,
              createdByName: auth.name || null,
            },
            include: NOTICE_INCLUDE,
          });
        });
      } catch (e) {
        translateUniqueClash(e);
      }
      // 回给页面的就是刚插进去的那一行（页面拿它当下次保存的 base，见下面修改那段的说明）
      ok(res, { item: toDto(created, null, auth.role, newMatches) });
      return;
    }

    /* 页面把打开弹窗时看到的那份一起传上来（base，跟 body 同一种写法）。没传 = 上线前打开的老页面，不比（照旧整份存）；
       传了但读不懂 = 当成冲突，让他重开（不能因为读不懂就放过去盖掉别人的） */
    const openedBase = body.base !== undefined && body.base !== null ? (readOpenedBase(body.base) ?? "unreadable") : null;

    /* 回给页面的那一行必须是**这次存进去的那份**、在锁里读的：页面拿它当下次保存的 base。
       原来是事务提交以后再去库里读 —— 提交和读之间同事又存了一次的话，读到的是同事那份，页面把它当 base、
       手里的却还是自己那份，照片没传完再点「保存」时比对就通过了，把同事的整份盖掉（2026-10-06 Codex 第二轮 M3）。 */
    let saved: ReturnType<typeof toDto>;
    try {
      saved = await prisma.$transaction(async (tx) => {
        // 号锁先拿、在锁这条到货通知之前（拿它时手里不能有行锁）：跟两条改号路按同一个号排队，下面 assertTrackingNoFree 在锁里查（修复第 3 轮，同新登记）
        if (f.trackingNo) {
          await lockTrackingNoForArrivalNotice(tx, f.trackingNo);
        }
        const n = await lockNotice(tx, auth.companyId, id);
        assertProductSnapshotConsistent(n);
        const current = fieldsOf(n);
        /* 没刷新的老页面（不带 products）：它只看得到一款。库里已经两款及以上 —— 存了就把别的几款抹掉，挡住、叫他刷新；
           这一条排在 base 比对之前（不管有没有人改过，老页面都存不了多款的通知）。
           库里 0 / 1 款：平铺那四项盖到那一款上（长宽高、单箱数量、单箱重沿用库里的；没传货型这个键就沿用库里的货型，F11），
           盖完再按产品行重算整票重量 / 体积、再卡一遍合计（锁里读到的那一款可能带着单箱重） */
        if (parsed.legacy) {
          if (current.products.length >= 2) {
            throw new BusinessError(`这条到货通知现在有 ${current.products.length} 款产品，你的页面是旧版的、只显示得了一款，这次没有保存。请刷新页面后再改`);
          }
          f = withDerivedTotals({ ...parsed.fields, products: overlayLegacy(parsed.legacy, current.products) });
          const sums = productSumsIssue(f.products);
          if (sums) throw new BusinessError(sums);
        }
        // 锁住以后再比（CLAUDE.md 第 28 条：判断用锁里读到的）。老页面的 base 也按同样的办法盖到库里那一款上再比（不带货型就不比货型）
        if (openedBase !== null) {
          const base = openedBase === "unreadable" ? null
            : openedBase.legacy ? { ...openedBase.fields, products: overlayLegacy(openedBase.legacy, current.products) }
            : openedBase.fields;
          const changed = base === null ? [] : changedSinceOpened(base, current);
          if (base === null || changed.length > 0) {
            throw new BusinessError(`这条刚刚被同事改过${changed.length ? `（${changed.join("、")}变了）` : ""}，你这次没有保存。请点「取消」关掉，重新点「修改」看最新的再改`);
          }
        }
        const ship = await lockLinkedShipment(tx, n);
        if (n.convertedTo === "formal" && ship) {
          throw new BusinessError("这条已经转成正式运单了，这里不能再改；要改运单请到「运单管理」");
        }
        if (f.trackingNo) await assertTrackingNoFree(tx, auth.companyId, f.trackingNo, n.id, ship?.id ?? null);
        if (n.convertedTo === "inbound" && ship) {
          assertStillPendingInbound(ship);
          // 已经是待入库的单：运单号、唛头不能清空（运单得有号、得有主）
          const missing = missingForTarget(f, "inbound");
          if (missing.length) throw new BusinessError(`已经转成待入库了，${missing.join("、")}不能空着`);
          await syncToPendingShipment(tx, auth.companyId, f, ship);
        }
        /* 唛头换了人（原来有唛头、这次改成别的或清空）：原来那次「已通知」通知的是旧唛头的客户，新唛头的客户没收到 ——
           改回「未通知」，回到「待通知」页签等客服重新通知（G01，2026-10-08）。原来没唛头、这次补上的不动 */
        const clientChanged = n.clientId !== null && n.clientId !== f.clientId;
        const row = await tx.arrivalNotice.update({
          where: { id: n.id },
          data: {
            ...noticeData(f),
            // 产品行整份换掉（都在这条通知的行锁里写，锁序不变：先通知、再子表）
            products: { deleteMany: {}, create: productRowsOf(auth.companyId, f) },
            ...(clientChanged && n.notifiedAt ? { notifiedAt: null, notifiedBy: null, notifiedByName: null } : {}),
            // 转出去的运单已经被删了：这次存的时候顺手把「转过」的记号清掉
            ...(n.convertedTo && !ship ? { convertedTo: null, shipmentId: null, convertedAt: null } : {}),
          },
          include: NOTICE_INCLUDE,
        });
        const matches = (await findPrealertMatches(tx, auth.companyId, [prealertKeyOf(row)])).get(row.id) ?? [];
        // 运单这次只改资料不改状态（转正式不走这里），锁里读到的状态就是现在的；号是这次同步过去的那个
        return toDto(row, ship ? { currentStatus: ship.currentStatus, trackingNo: f.trackingNo ?? ship.trackingNo } : null, auth.role, matches);
      }, { timeout: 30000, maxWait: 10000 });
    } catch (e) {
      translateUniqueClash(e);
    }
    ok(res, { item: saved });
  });

  /** 「已通知客户」开关：notified=true 标上，false 改回未通知 */
  app.post("/staff/arrival-notices/notify", async (req: HttpRequest, res: HttpResponse) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = bodyOf(req);
    const id = idOf(body.id);
    if (!id) { fail(res, 400, "BAD_REQUEST", "缺少到货通知 id"); return; }
    if (typeof body.notified !== "boolean") { fail(res, 400, "BAD_REQUEST", "notified 要传 true 或 false"); return; }
    const notified = body.notified;
    /* 页面带上「我看到的唛头」（G01）：标已通知那一刻唛头刚被同事改了，就别标 —— 客服通知的是旧唛头的客户。
       没带（老页面）照旧。放在 updateMany 的条件里，一句话判断 + 写，不用锁 */
    const expectsClient = notified && Object.prototype.hasOwnProperty.call(body, "clientId");
    if (expectsClient && body.clientId !== null && typeof body.clientId !== "string") { fail(res, 400, "BAD_REQUEST", "clientId 要传唛头或 null"); return; }
    const expectedClient = expectsClient ? ((body.clientId as string | null) || null) : undefined;
    const r = await prisma.arrivalNotice.updateMany({
      where: { id, companyId: auth.companyId, ...(expectsClient ? { clientId: expectedClient } : {}) },
      data: notified
        ? { notifiedAt: new Date(), notifiedBy: auth.userId, notifiedByName: auth.name || null }
        : { notifiedAt: null, notifiedBy: null, notifiedByName: null },
    });
    if (r.count === 0) {
      const still = expectsClient ? await prisma.arrivalNotice.findFirst({ where: { id, companyId: auth.companyId }, select: { clientId: true } }) : null;
      if (still) { fail(res, 409, "VALIDATION_ERROR", `这条的唛头刚被同事改成「${still.clientId ?? "空"}」了，没有标已通知。请刷新看最新的，通知过新唛头的客户再点`); return; }
      fail(res, 404, "NOT_FOUND", "这条到货通知不存在了（可能刚被同事删掉），请刷新");
      return;
    }
    ok(res, { item: await loadDto(auth.companyId, id, auth.role) });
  });

  /**
   * 转运单：to=formal 转正式运单（已入库）/ to=inbound 转待入库。
   * 待入库的再转正式：同一张运单从「待入库」变「已入库」，不另建。
   */
  app.post("/staff/arrival-notices/convert", async (req: HttpRequest, res: HttpResponse) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = bodyOf(req);
    const id = idOf(body.id);
    const to = body.to;
    if (!id) { fail(res, 400, "BAD_REQUEST", "缺少到货通知 id"); return; }
    if (to !== "formal" && to !== "inbound") { fail(res, 400, "BAD_REQUEST", "要选「转正式运单」还是「转待入库」"); return; }
    const created: string[] = [];
    try {
      await prisma.$transaction(async (tx) => {
        const n = await lockNotice(tx, auth.companyId, id);
        assertProductSnapshotConsistent(n);
        const ship = await lockLinkedShipment(tx, n);
        if (ship && n.convertedTo === "formal") throw new BusinessError("这条已经转成正式运单了，不用再转");
        if (ship && n.convertedTo === "inbound" && to === "inbound") throw new BusinessError("这条已经是待入库了；资料补全后点「转正式运单」");
        const f = fieldsOf(n);
        const missing = missingForTarget(f, to);
        if (missing.length) {
          throw new BusinessError(`${to === "formal" ? "转正式运单" : "转待入库"}还缺：${missing.join("、")}。先点「修改」补上再转`);
        }
        /* 兜底（2026-10-09 多款产品）：转正式要建的产品行再过一遍「创建订单」那道闸（orders/product-row-guard.ts）。
           正常情况上面「还缺」已经拦住了（单箱数量填一半会点名），这里不该触发；触发了说明两边规矩对不上，宁可拦住 */
        if (to === "formal") {
          const rowIssue = validateProductRows(orderValuesOf(f).products);
          if (rowIssue) throw new BusinessError(`转正式运单前请先改：${rowIssue}`);
        }
        await assertClient(tx, auth.companyId, f.clientId!);
        await assertTrackingNoFree(tx, auth.companyId, f.trackingNo!, n.id, ship?.id ?? null);
        /* 撞上客户预报单（F01）：只提醒不拦 —— 页面确认框里列出来、员工点了「确定」才带着这几张预报单的 id 来。
           锁里重查：页面打开以后客户才报的预报单、或者没带确认的老页面，都要先说一声。待入库转正式也照样查 */
        const matches = (await findPrealertMatches(tx, auth.companyId, [prealertKeyOf(n)])).get(n.id) ?? [];
        const acked = new Set(Array.isArray(body.acknowledgedPrealertIds) ? body.acknowledgedPrealertIds.filter((v): v is string => typeof v === "string") : []);
        const unacked = matches.filter((m) => !acked.has(m.orderId));
        if (unacked.length) {
          throw new BusinessError(
            `国内单号 ${unacked[0].domesticTrackingNo} 客户报过预报单（${unacked.map((m) => `${m.trackingNo ?? "预报单"}，唛头 ${m.clientId}${m.received ? "，已确认收货" : ""}`).join("；")}）。` +
            // 待入库 → 正式用的是同一张运单（下面 if (ship) 那段），不会再多一张：别说「再转会多出一张」（修复第 1 轮）
            (ship
              ? "转待入库时已经建过运单，现在可能有两张运单；转正式用的是同一张、不会再多建，转完请到「运单管理」核对、删掉多的那张。请刷新后再点转、在确认框里确认"
              : "有预报单的货应在「预报单审核」点「确认收货」，这里再转会多出一张运单。确定是两票不同的货，请刷新后再点转、在确认框里确认"),
            409, "VALIDATION_ERROR",
          );
        }
        const now = new Date();
        let shipmentId: string;
        if (ship) {
          // 待入库 → 正式：同一张运单补全资料、状态推到「已入库」，写一条轨迹
          assertStillPendingInbound(ship);
          await syncToPendingShipment(tx, auth.companyId, f, ship);
          await tx.shipment.update({ where: { id: ship.id }, data: { currentStatus: "inWarehouseCN" } });
          await tx.statusLog.create({
            data: {
              id: `sl_an_${now.getTime()}_${crypto.randomBytes(3).toString("hex")}`,
              companyId: auth.companyId,
              shipmentId: ship.id,
              operatorId: auth.userId,
              operatorRole: auth.role,
              operatorName: auth.name ?? "",
              fromStatus: PENDING_INBOUND,
              toStatus: "inWarehouseCN",
              // 跟「创建订单」第一条轨迹同一句话（new-order-rows.ts 的 FIRST_TRACK）
              remark: "货已到国内仓，等待装柜",
              nextStop: "装柜",
              changedAt: now,
            },
          });
          await copyImagesToOrder(tx, n, ship.orderId, auth.userId, "uncopied", created);
          shipmentId = ship.id;
        } else {
          const v = orderValuesOf(f);
          const orderId = `o_${now.getTime()}_${crypto.randomBytes(3).toString("hex")}`;
          shipmentId = `s_${now.getTime()}_${crypto.randomBytes(3).toString("hex")}`;
          const rows = buildNewOrderRows({
            companyId: auth.companyId,
            operator: { userId: auth.userId, role: auth.role, name: auth.name ?? "" },
            orderId,
            shipmentId,
            clientId: v.clientId,
            warehouseId: v.warehouseId,
            trackingNo: v.trackingNo,
            transportMode: v.transportMode,
            itemName: v.itemName,
            // 产品数量：建了产品行按 Σ 单箱数量 × 件数（2026-10-09 多款产品，原来写死 0）；没建产品行是 0
            productQuantity: v.productQuantity,
            packageCount: v.packageCount,
            packageUnit: "box",
            weightKg: v.weightKg,
            volumeM3: v.volumeM3,
            shipDate: v.shipDate,
            domesticTrackingNo: v.domesticTrackingNo,
            cargoType: v.cargoType, // F11：原来写死普货
            batchNo: null,
            // 内部备注不进运单：运单的备注员工端「运单管理」看得到，到货通知的备注留在到货通知里
            remark: null,
            products: v.products,
            initialStatus: to === "formal" ? "inWarehouseCN" : PENDING_INBOUND,
            now,
          });
          await tx.order.create({ data: rows.order });
          await tx.shipment.create({ data: { ...rows.shipment, domesticTrackingNo: v.shipmentDomesticTrackingNo } });
          await tx.statusLog.create({ data: rows.statusLog });
          if (rows.products.length > 0) await tx.orderProduct.createMany({ data: rows.products });
          await copyImagesToOrder(tx, n, orderId, auth.userId, "all", created);
        }
        await tx.arrivalNotice.update({
          where: { id: n.id },
          data: { convertedTo: to, shipmentId, convertedAt: now },
        });
      }, { timeout: 30000, maxWait: 10000 });
    } catch (e) {
      removeFiles(created);
      translateUniqueClash(e);
    }
    ok(res, { item: await loadDto(auth.companyId, id, auth.role) });
  });

  /** 删除：只能删还没转运单的（转了的删运单要去「运单管理」） */
  app.post("/staff/arrival-notices/delete", async (req: HttpRequest, res: HttpResponse) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = idOf(bodyOf(req).id);
    if (!id) { fail(res, 400, "BAD_REQUEST", "缺少到货通知 id"); return; }
    const files = await prisma.$transaction(async (tx) => {
      const n = await lockNotice(tx, auth.companyId, id);
      const ship = await lockLinkedShipment(tx, n);
      if (ship) throw new BusinessError("这条已经转成运单了，不能删；要删请到「运单管理」删那张运单");
      await tx.arrivalNotice.delete({ where: { id: n.id } }); // 照片记录跟着删（外键 ON DELETE CASCADE）
      return n.images.flatMap((i) => (i.thumbPath ? [i.filePath, i.thumbPath] : [i.filePath])); // 小图文件一起删（G03）
    }, { timeout: 30000, maxWait: 10000 });
    removeFiles(files);
    ok(res, { deleted: true, id });
  });

  /** 传一张到货照片（页面先压缩再传，一次一张） */
  app.post("/staff/arrival-notices/images", async (req: HttpRequest, res: HttpResponse) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = bodyOf(req);
    const noticeId = idOf(body.noticeId);
    const fileName = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 200) : "";
    // 类型统一小写（MIME 不分大小写）：下面白名单按小写比，存盘时扩展名也按小写认（image-storage.ts 的 mimeToExt）
    const mime = typeof body.mime === "string" ? body.mime.trim().toLowerCase() : "";
    const contentBase64 = typeof body.contentBase64 === "string" ? body.contentBase64.trim() : "";
    if (!noticeId || !fileName || !mime || !contentBase64) { fail(res, 400, "BAD_REQUEST", "照片没传全，请重新选一次"); return; }
    if (!mime.startsWith("image/")) { fail(res, 400, "BAD_REQUEST", "只能传图片"); return; }
    /* HEIC（苹果手机原图）：电脑浏览器显示不了，存下来卡片 / 大图都是破图、也复制不了（修复第 1 轮）。
       页面选图时已经挡了（photo-upload.ts 的 pickPhotos），这里兜住上线前打开的老页面 */
    if (/^image\/hei[cf]/i.test(mime)) { fail(res, 400, "BAD_REQUEST", "这张是 HEIC 格式（苹果手机原图），电脑浏览器显示不了。请在手机上直接传，或先转成 JPG 再传"); return; }
    /* 别的电脑上显示不了的格式（TIFF、SVG……）同样挡（修复第 2 轮）：原来只挡 HEIC，.tif / .svg 照样存进来，
       认不出的类型一律存成 .jpg、按 image/jpeg 发出去，卡片 / 大图破图、复制不了。跟页面 photo-upload.ts 的 DISPLAYABLE_PHOTO_TYPES 同一份 */
    if (!PHOTO_MIME_ALLOWED.includes(mime)) { fail(res, 400, "BAD_REQUEST", `这张图片的格式（${mime}）电脑上显示不了，只能传 JPG / PNG / GIF / WebP / BMP。请先转成 JPG 再传`); return; }
    if (contentBase64.length > UPLOAD_IMAGE_MAX_BASE64) { fail(res, 400, "BAD_REQUEST", uploadTooLargeMessage(contentBase64.length)); return; }
    if (Buffer.from(contentBase64, "base64").length === 0) { fail(res, 400, "BAD_REQUEST", "这张图片是空的，请换一张"); return; }
    /* 小图（G03）：页面顺手压的一张长边 360 的，列表卡片只显示它。可以不带（老页面 / 压小图失败），带了就得像样 */
    const thumbBase64 = typeof body.thumbBase64 === "string" ? body.thumbBase64.trim() : "";
    const thumbMime = typeof body.thumbMime === "string" ? body.thumbMime.trim() : "";
    if (thumbBase64 && (!thumbMime.startsWith("image/") || thumbBase64.length > THUMB_MAX_BASE64 || Buffer.from(thumbBase64, "base64").length === 0)) {
      fail(res, 400, "BAD_REQUEST", "照片小图不对，请刷新页面后重新传");
      return;
    }
    const created: string[] = [];
    try {
      await prisma.$transaction(async (tx) => {
        const n = await lockNotice(tx, auth.companyId, noticeId);
        const ship = await lockLinkedShipment(tx, n);
        if (n.convertedTo === "formal" && ship) throw new BusinessError("这条已经转成正式运单了，照片请到「运单管理」那张运单里传");
        if (n.images.length >= MAX_NOTICE_IMAGES) throw new BusinessError(`一条到货通知最多 ${MAX_NOTICE_IMAGES} 张照片`);
        if (n.convertedTo === "inbound" && ship) assertStillPendingInbound(ship);
        const filePath = saveImageToDisk(noticeId, mime, contentBase64);
        created.push(filePath);
        const thumbPath = thumbBase64 ? saveImageToDisk(noticeId, thumbMime, thumbBase64) : null;
        if (thumbPath) created.push(thumbPath);
        const imageId = `ani_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        await tx.arrivalNoticeImage.create({
          data: { id: imageId, companyId: auth.companyId, noticeId, fileName, mime, filePath, thumbPath, uploadedBy: auth.userId },
        });
        // 已经是待入库的单：同一张照片也进那张运单的产品图片
        if (n.convertedTo === "inbound" && ship) {
          // 只要刚传的这一张（copyImagesToOrder 只看 companyId 和 images）
          const fresh = await tx.arrivalNotice.findFirst({ where: { id: noticeId }, include: { images: { where: { id: imageId } } } });
          if (fresh) await copyImagesToOrder(tx, fresh, ship.orderId, auth.userId, "uncopied", created);
        }
      }, { timeout: 30000, maxWait: 10000 });
    } catch (e) {
      removeFiles(created);
      throw e;
    }
    ok(res, { item: await loadDto(auth.companyId, noticeId, auth.role) });
  });

  /** 删一张到货照片（待入库的单，运单那边的副本一起删） */
  app.post("/staff/arrival-notices/images/delete", async (req: HttpRequest, res: HttpResponse) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const imageId = idOf(bodyOf(req).id);
    if (!imageId) { fail(res, 400, "BAD_REQUEST", "缺少照片 id"); return; }
    const img = await prisma.arrivalNoticeImage.findFirst({ where: { id: imageId, companyId: auth.companyId }, select: { noticeId: true } });
    if (!img) { fail(res, 404, "NOT_FOUND", "这张照片不存在了（可能刚被同事删掉），请刷新"); return; }
    const files = await prisma.$transaction(async (tx) => {
      const n = await lockNotice(tx, auth.companyId, img.noticeId);
      const ship = await lockLinkedShipment(tx, n);
      if (n.convertedTo === "formal" && ship) throw new BusinessError("这条已经转成正式运单了，照片请到「运单管理」那张运单里删");
      const row = n.images.find((i) => i.id === imageId);
      if (!row) throw new BusinessError("这张照片不存在了（可能刚被同事删掉），请刷新", 404, "NOT_FOUND");
      const toDelete = row.thumbPath ? [row.filePath, row.thumbPath] : [row.filePath]; // 小图文件一起删（G03）
      if (n.convertedTo === "inbound" && ship) {
        assertStillPendingInbound(ship);
        if (row.orderImageId) {
          const copy = await tx.orderProductImage.findFirst({ where: { id: row.orderImageId, orderId: ship.orderId }, select: { filePath: true } });
          if (copy) {
            await tx.orderProductImage.delete({ where: { id: row.orderImageId } });
            if (copy.filePath) toDelete.push(copy.filePath);
          }
        }
      }
      await tx.arrivalNoticeImage.delete({ where: { id: imageId } });
      return toDelete;
    }, { timeout: 30000, maxWait: 10000 });
    removeFiles(files);
    ok(res, { item: await loadDto(auth.companyId, img.noticeId, auth.role) });
  });
}

/**
 * NoticeFields → 主表的列。
 * 品名 / 件数 / 国内单号 / 货型四列是「镜像」（2026-10-09 多款产品）：按各款汇总写一遍（noticeLegacySummary），
 * 只给回滚后的旧代码、部署期间的旧容器、没刷新的老页面看；新代码自己读产品行（fieldsOf）。
 */
function noticeData(f: NoticeFields) {
  const legacy = noticeLegacySummary(f.products);
  return {
    clientId: f.clientId,
    trackingNo: f.trackingNo,
    itemName: legacy.itemName,
    packageCount: legacy.packageCount,
    weightKg: f.weightKg as unknown as Prisma.Decimal | null,
    volumeM3: f.volumeM3 as unknown as Prisma.Decimal | null,
    transportMode: f.transportMode,
    domesticTrackingNo: legacy.domesticTrackingNo,
    warehouseId: f.warehouseId,
    arrivedAt: f.arrivedAt,
    cargoType: legacy.cargoType,
    remark: f.remark,
  };
}

/** NoticeFields → 产品行（每行带公司；sort_order 按 0..n-1 重新编，空白款已经丢掉了） */
function productRowsOf(companyId: string, f: NoticeFields) {
  return f.products.map((p, i) => ({ ...p, companyId, sortOrder: i }));
}
