import * as crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { HttpRequest, HttpResponse, MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { BusinessError } from "../core/business-error";
import { canSeeOperatorIdentity } from "../core/operator-visibility";
import { parseNumericStrict, requirePositiveInt } from "../core/int-guard";
import { DECIMAL_10_2, DECIMAL_10_3, requireDecimal } from "../core/decimal-guard";
import { UPLOAD_IMAGE_MAX_BASE64, uploadTooLargeMessage } from "../core/upload-limit";
import { deleteImageFile, readImageAsBase64, saveImageToDisk } from "../orders/image-storage";
import { buildNewOrderRows } from "../orders/new-order-rows";
import { DEFAULT_STATUS_LABELS } from "../ai/ai-config-store";
import { ARRIVAL_WAREHOUSE_IDS, PENDING_INBOUND } from "./rules";

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

const TEXT_LIMITS = { trackingNo: 64, itemName: 200, domesticTrackingNo: 100, remark: 500 } as const;

/** 存进库之前、校验过的一行（null = 没填） */
interface NoticeFields {
  clientId: string | null;
  trackingNo: string | null;
  itemName: string | null;
  packageCount: number | null;
  weightKg: number | null;
  volumeM3: number | null;
  transportMode: "sea" | "land" | null;
  domesticTrackingNo: string | null;
  warehouseId: string | null;
  arrivedAt: string | null;
  remark: string | null;
}

type NoticeRow = Prisma.ArrivalNoticeGetPayload<{ include: { images: true } }>;

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

/**
 * 把请求里的各项理成 NoticeFields。只做「填了的填得对不对」，不管必填（必填看转到哪）。
 * ⚠️ 唛头不去空格：线上有「XPP-0015」和「XPP-0015 XHH-6698」这种带空格的账号（同「创建订单」的唛头框）。
 */
export function readNoticeFields(body: Record<string, unknown>): { fields: NoticeFields } | { error: string } {
  const out: Partial<NoticeFields> = {};

  const rawClient = body.clientId;
  if (rawClient === undefined || rawClient === null || rawClient === "") out.clientId = null;
  else if (typeof rawClient !== "string") return { error: "唛头要填文字" };
  else if (!rawClient.trim()) out.clientId = null;
  else if (rawClient.length > 100) return { error: "唛头太长了" };
  else out.clientId = rawClient;

  for (const [key, label] of [["trackingNo", "运单号"], ["itemName", "品名"], ["domesticTrackingNo", "国内快递单号"], ["remark", "备注"]] as const) {
    const r = readText(body[key], label, TEXT_LIMITS[key]);
    if ("error" in r) return r;
    out[key] = r.value;
  }

  if (body.packageCount === undefined || body.packageCount === null || body.packageCount === "") out.packageCount = null;
  else {
    const n = parseNumericStrict(body.packageCount);
    const issue = requirePositiveInt(n, "件数");
    if (issue) return { error: issue };
    out.packageCount = n;
  }

  for (const [key, label, rule] of [["weightKg", "重量", DECIMAL_10_2], ["volumeM3", "体积", DECIMAL_10_3]] as const) {
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

  return { fields: out as NoticeFields };
}

/** 转到哪还缺哪几项（中文名，按「创建订单」弹窗的顺序） */
export function missingForTarget(f: NoticeFields, to: "formal" | "inbound"): string[] {
  const missing: string[] = [];
  if (!f.trackingNo) missing.push("运单号");
  if (!f.clientId) missing.push("唛头");
  if (to === "inbound") return missing;
  if (!f.itemName) missing.push("品名");
  if (!f.warehouseId) missing.push("仓库");
  if (!f.transportMode) missing.push("运输方式");
  if (!f.arrivedAt) missing.push("到仓日期");
  if (f.packageCount === null) missing.push("件数");
  if (f.weightKg === null) missing.push("重量");
  if (f.volumeM3 === null) missing.push("体积");
  return missing;
}

function fieldsOf(n: NoticeRow): NoticeFields {
  return {
    clientId: n.clientId,
    trackingNo: n.trackingNo,
    itemName: n.itemName,
    packageCount: n.packageCount,
    weightKg: num(n.weightKg),
    volumeM3: num(n.volumeM3),
    transportMode: n.transportMode === "sea" || n.transportMode === "land" ? n.transportMode : null,
    domesticTrackingNo: n.domesticTrackingNo,
    warehouseId: n.warehouseId,
    arrivedAt: n.arrivedAt,
    remark: n.remark,
  };
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

/** 到货通知 → 订单 / 运单上的那几项（新建和同步共用一份，两边一个样） */
function orderValuesOf(f: NoticeFields) {
  return {
    clientId: f.clientId!,
    trackingNo: f.trackingNo!,
    itemName: f.itemName ?? "",
    packageCount: f.packageCount ?? 0,
    weightKg: f.weightKg,
    volumeM3: f.volumeM3,
    // 待入库时可能还没填：订单这两列不许空，先存空串（列表上显示「—」），转正式时一定齐
    transportMode: f.transportMode ?? "",
    warehouseId: f.warehouseId ?? "",
    shipDate: f.arrivedAt,
    domesticTrackingNo: f.domesticTrackingNo,
    /* 产品行：跟「创建订单」没分产品行时那条兜底行一样 —— 有品名才建一行，
       国内单号空着写「货拉拉」，不带长宽高（带了下游会按尺寸重算方数，CLAUDE.md 第 33 条） */
    products: f.itemName ? [{
      itemName: f.itemName,
      packageCount: f.packageCount ?? 0,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      productQuantity: null,
      cargoType: "normal",
      domesticTrackingNo: f.domesticTrackingNo || "货拉拉",
      weightKg: null,
      sortOrder: 0,
    }] : [],
  };
}

/** 锁住这一行再重读（CLAUDE.md 第 28 条：锁完必须重读，判断用锁里读到的） */
async function lockNotice(tx: Tx, companyId: string, id: string): Promise<NoticeRow> {
  await tx.$queryRaw`SELECT id FROM arrival_notices WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`;
  const n = await tx.arrivalNotice.findFirst({ where: { id, companyId }, include: { images: { orderBy: { createdAt: "asc" } } } });
  if (!n) throw new BusinessError("这条到货通知不存在了（可能刚被同事删掉），请刷新", 404, "NOT_FOUND");
  return n;
}

/** 转出去的那张运单（锁住）；运单已经被删了返回 null */
async function lockLinkedShipment(tx: Tx, n: NoticeRow) {
  if (!n.convertedTo || !n.shipmentId) return null;
  await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${n.shipmentId} AND company_id = ${n.companyId} FOR UPDATE`;
  return tx.shipment.findFirst({
    where: { id: n.shipmentId, companyId: n.companyId },
    select: { id: true, orderId: true, currentStatus: true, trackingNo: true },
  });
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
      packageCount: v.packageCount,
      weightKg: weight,
      volumeM3: volume,
      shipDate: v.shipDate,
      domesticTrackingNo: v.domesticTrackingNo,
      transportMode: v.transportMode,
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
      domesticTrackingNo: v.domesticTrackingNo,
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
 *   mode=uncopied：只补还没复制过的。复制过、又在运单那边被删掉的不补回来 —— 那是有人特意删的。
 * created 收集新写的文件，事务失败时调用方负责删掉。
 */
async function copyImagesToOrder(tx: Tx, n: NoticeRow, orderId: string, uploadedBy: string, mode: "all" | "uncopied", created: string[]): Promise<void> {
  for (const img of n.images) {
    if (mode === "uncopied" && img.orderImageId) continue;
    const b64 = readImageAsBase64(img.filePath);
    if (!b64) continue; // 文件在盘上找不到了：跳过这一张，不挡转运单
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

/** 运单号撞了数据库唯一约束（两个人同时转、或者查重和写库之间被别人用掉）→ 说人话 */
function translateUniqueClash(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    throw new BusinessError("这个运单号刚刚被用掉了，换一个号再转");
  }
  throw e;
}

/**
 * 列表 / 存完返回给页面的一行。
 * 登记人、通知人只给超管（老板 2026-09-15：员工也不能看到是哪个账号操作的，core/operator-visibility.ts）。
 */
function toDto(n: NoticeRow, ship: { currentStatus: string } | null | undefined, viewerRole: string) {
  const showWho = canSeeOperatorIdentity(viewerRole);
  // 转过、但那张运单已经被删了：当作没转（页面上提示一句，可以重转）
  const shipmentGone = Boolean(n.convertedTo && n.shipmentId && !ship);
  return {
    id: n.id,
    clientId: n.clientId,
    trackingNo: n.trackingNo,
    itemName: n.itemName,
    packageCount: n.packageCount,
    weightKg: num(n.weightKg),
    volumeM3: num(n.volumeM3),
    transportMode: n.transportMode,
    domesticTrackingNo: n.domesticTrackingNo,
    warehouseId: n.warehouseId,
    arrivedAt: n.arrivedAt,
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
    images: n.images.map((i) => ({ id: i.id, fileName: i.fileName, imageUrl: i.filePath })),
  };
}

async function loadDto(companyId: string, id: string, viewerRole: string) {
  const n = await prisma.arrivalNotice.findFirst({ where: { id, companyId }, include: { images: { orderBy: { createdAt: "asc" } } } });
  if (!n) return null;
  const ship = n.shipmentId
    ? await prisma.shipment.findFirst({ where: { id: n.shipmentId, companyId }, select: { currentStatus: true } })
    : null;
  return toDto(n, ship, viewerRole);
}

/** 页签：待通知 / 已通知（还没转）/ 待入库 / 已转正式 / 全部 */
const TABS = ["todo", "notified", "inbound", "formal", "all"] as const;
type Tab = (typeof TABS)[number];
function tabWhere(tab: Tab): Prisma.ArrivalNoticeWhereInput {
  if (tab === "todo") return { convertedTo: null, notifiedAt: null };
  if (tab === "notified") return { convertedTo: null, notifiedAt: { not: null } };
  if (tab === "inbound") return { convertedTo: "inbound" };
  if (tab === "formal") return { convertedTo: "formal" };
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
    const search: Prisma.ArrivalNoticeWhereInput = keyword
      ? {
          OR: [
            { clientId: { contains: keyword, mode: "insensitive" } },
            { trackingNo: { contains: keyword, mode: "insensitive" } },
            { domesticTrackingNo: { contains: keyword, mode: "insensitive" } },
            { itemName: { contains: keyword, mode: "insensitive" } },
          ],
        }
      : {};
    const where: Prisma.ArrivalNoticeWhereInput = { AND: [base, search, tabWhere(tab)] };
    const [total, rows, ...counts] = await Promise.all([
      prisma.arrivalNotice.count({ where }),
      prisma.arrivalNotice.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { images: { orderBy: { createdAt: "asc" } } },
      }),
      ...TABS.map((t) => prisma.arrivalNotice.count({ where: { AND: [base, search, tabWhere(t)] } })),
    ]);
    const shipIds = rows.map((r) => r.shipmentId).filter((v): v is string => Boolean(v));
    const ships = shipIds.length
      ? await prisma.shipment.findMany({ where: { id: { in: shipIds }, companyId: auth.companyId }, select: { id: true, currentStatus: true } })
      : [];
    const shipMap = new Map(ships.map((s) => [s.id, s]));
    ok(res, {
      items: rows.map((r) => toDto(r, r.shipmentId ? shipMap.get(r.shipmentId) : null, auth.role)),
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
    const f = parsed.fields;
    if (f.clientId) await assertClient(prisma, auth.companyId, f.clientId);

    if (!id) {
      // 新登记是纯插入一行：不用事务、也没有行可锁。运单号查重是「先提个醒」，
      // 两个人同一瞬间登记同一个号挡不住 —— 真正兜底的是转运单那一步（锁住这一行 + shipments.tracking_no 唯一约束）
      const newId = `an_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
      if (f.trackingNo) await assertTrackingNoFree(prisma, auth.companyId, f.trackingNo, null, null);
      await prisma.arrivalNotice.create({
        data: {
          id: newId,
          companyId: auth.companyId,
          ...noticeData(f),
          createdBy: auth.userId,
          createdByName: auth.name || null,
        },
      });
      ok(res, { item: await loadDto(auth.companyId, newId, auth.role) });
      return;
    }

    try {
      await prisma.$transaction(async (tx) => {
        const n = await lockNotice(tx, auth.companyId, id);
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
        await tx.arrivalNotice.update({
          where: { id: n.id },
          data: {
            ...noticeData(f),
            // 转出去的运单已经被删了：这次存的时候顺手把「转过」的记号清掉
            ...(n.convertedTo && !ship ? { convertedTo: null, shipmentId: null, convertedAt: null } : {}),
          },
        });
      }, { timeout: 30000, maxWait: 10000 });
    } catch (e) {
      translateUniqueClash(e);
    }
    ok(res, { item: await loadDto(auth.companyId, id, auth.role) });
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
    const r = await prisma.arrivalNotice.updateMany({
      where: { id, companyId: auth.companyId },
      data: notified
        ? { notifiedAt: new Date(), notifiedBy: auth.userId, notifiedByName: auth.name || null }
        : { notifiedAt: null, notifiedBy: null, notifiedByName: null },
    });
    if (r.count === 0) { fail(res, 404, "NOT_FOUND", "这条到货通知不存在了（可能刚被同事删掉），请刷新"); return; }
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
        const ship = await lockLinkedShipment(tx, n);
        if (ship && n.convertedTo === "formal") throw new BusinessError("这条已经转成正式运单了，不用再转");
        if (ship && n.convertedTo === "inbound" && to === "inbound") throw new BusinessError("这条已经是待入库了；资料补全后点「转正式运单」");
        const f = fieldsOf(n);
        const missing = missingForTarget(f, to);
        if (missing.length) {
          throw new BusinessError(`${to === "formal" ? "转正式运单" : "转待入库"}还缺：${missing.join("、")}。先点「修改」补上再转`);
        }
        await assertClient(tx, auth.companyId, f.clientId!);
        await assertTrackingNoFree(tx, auth.companyId, f.trackingNo!, n.id, ship?.id ?? null);
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
            // 到货通知没有「产品数量」这一项（老板 1A 的清单里没有），跟没填一样存 0
            productQuantity: 0,
            packageCount: v.packageCount,
            packageUnit: "box",
            weightKg: v.weightKg,
            volumeM3: v.volumeM3,
            shipDate: v.shipDate,
            domesticTrackingNo: v.domesticTrackingNo,
            cargoType: "normal",
            batchNo: null,
            // 内部备注不进运单：运单的备注员工端「运单管理」看得到，到货通知的备注留在到货通知里
            remark: null,
            products: v.products,
            initialStatus: to === "formal" ? "inWarehouseCN" : PENDING_INBOUND,
            now,
          });
          await tx.order.create({ data: rows.order });
          await tx.shipment.create({ data: rows.shipment });
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
      return n.images.map((i) => i.filePath);
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
    const mime = typeof body.mime === "string" ? body.mime.trim() : "";
    const contentBase64 = typeof body.contentBase64 === "string" ? body.contentBase64.trim() : "";
    if (!noticeId || !fileName || !mime || !contentBase64) { fail(res, 400, "BAD_REQUEST", "照片没传全，请重新选一次"); return; }
    if (!mime.startsWith("image/")) { fail(res, 400, "BAD_REQUEST", "只能传图片"); return; }
    if (contentBase64.length > UPLOAD_IMAGE_MAX_BASE64) { fail(res, 400, "BAD_REQUEST", uploadTooLargeMessage(contentBase64.length)); return; }
    if (Buffer.from(contentBase64, "base64").length === 0) { fail(res, 400, "BAD_REQUEST", "这张图片是空的，请换一张"); return; }
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
        const imageId = `ani_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        await tx.arrivalNoticeImage.create({
          data: { id: imageId, companyId: auth.companyId, noticeId, fileName, mime, filePath, uploadedBy: auth.userId },
        });
        // 已经是待入库的单：同一张照片也进那张运单的产品图片
        if (n.convertedTo === "inbound" && ship) {
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
      const toDelete = [row.filePath];
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

/** NoticeFields → 表里的列 */
function noticeData(f: NoticeFields) {
  return {
    clientId: f.clientId,
    trackingNo: f.trackingNo,
    itemName: f.itemName,
    packageCount: f.packageCount,
    weightKg: f.weightKg as unknown as Prisma.Decimal | null,
    volumeM3: f.volumeM3 as unknown as Prisma.Decimal | null,
    transportMode: f.transportMode,
    domesticTrackingNo: f.domesticTrackingNo,
    warehouseId: f.warehouseId,
    arrivedAt: f.arrivedAt,
    remark: f.remark,
  };
}
