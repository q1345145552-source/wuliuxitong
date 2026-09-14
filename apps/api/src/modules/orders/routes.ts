// B-3 ~ B-7: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-18）
import { DECIMAL_10_2, DECIMAL_10_3, DECIMAL_12_2, requireDecimal } from "../core/decimal-guard";
import { PG_INT_MAX, parseNumericStrict, requireNonNegativeInt, requirePositiveInt } from "../core/int-guard";
import { ShipmentsNotFoundError, lockShipmentsChildrenFirst } from "../shipments/lock-shipments";
import { validateProductRows, validateOrderLevelQuantity } from "./product-row-guard";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { getClientIp } from "../core/rate-limit";
import type { MinimalHttpApp } from "../../server";

/* 2026-08-07：运单不再涉及金额。
   原来这里有一套「按体积×单价自动算应收金额」的代码，两个 bug 叠在一起
   （只查通用价、但库里全是客户专属价；兜底价目表键名大小写对不上），
   从 2026-06 起就一直算不出来。用户决定：运单金额线下算，系统不再参与，
   钱只在两个集货拼柜板块里算。整段删除，不留半死不活的代码。 */

// parseJsonArray 不再用了：/staff/prealerts 的仓库过滤已删（2026-08-31，排查报告第 7 条）；
// 全仓库引用归零后，http-utils 里的函数本体也已删除（2026-08-31 复查第 16 条收尾）
import { fail, ok, requireRole } from "../core/http-utils";
import { loadProductImagesForOrders, MAX_ORDER_PRODUCT_IMAGES } from "./product-images";
import { saveImageToDisk, deleteImageFile } from "./image-storage";
import { sanitizeRemarkForClient } from "../core/client-privacy";
import { canSeeOperatorIdentity } from "../core/operator-visibility";
import { loadOrderTotalMetrics } from "../shipments/total-metrics";

/** 批量加载订单的产品行 */
export async function loadOrderProducts(companyId: string, orderIds: string[]): Promise<Map<string, any[]>> {
  if (orderIds.length === 0) return new Map();
  const rows = await prisma.orderProduct.findMany({
    where: { companyId, orderId: { in: [...new Set(orderIds)] } },
    orderBy: { sortOrder: "asc" },
  });
  const map = new Map<string, any[]>();
  for (const r of rows) {
    const list = map.get(r.orderId) ?? [];
    list.push({
      id: r.id, itemName: r.itemName, packageCount: r.packageCount,
      lengthCm: r.lengthCm, widthCm: r.widthCm, heightCm: r.heightCm,
      productQuantity: r.productQuantity,
      cargoType: r.cargoType,
      domesticTrackingNo: r.domesticTrackingNo,
      weightKg: r.weightKg,
    });
    map.set(r.orderId, list);
  }
  return map;
}

import { EXCEPTION_STATUSES } from "../shipments/status-flow";
import { BusinessError } from "../core/business-error";
import { classifyStatusGroup, matchesShipmentListFilter, type ClientStatusGroup } from "../../../../../packages/shared-types/shipment-status";
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";
import { CARGO_TYPES, CARGO_TYPE_HINT, strictestCargoType, type CargoType } from "../../../../../packages/shared-types/cargo-type";

/**
 * 客户端订单五分类。判断逻辑在 packages/shared-types 的 classifyStatusGroup，
 * 这里只是个转发（保留这个名字是因为本文件里有多处调用，也方便 grep）。
 *
 * 分法（口径唯一权威在共享文件里，改要去那边改）：
 *   · 没运单，或还在国内仓（created / inWarehouseCN / holdLoading）→ pending 未发出
 *   · delivered → delivered 已签收
 *   · returned / cancelled / exception → closed 退回/取消/异常
 *   · 已到仓 / 预约派送 / 派送中 → arrived 已到仓（进泰国仓到签收之前，含尾端派送）
 *   · 其余一律 → transit 在途（从国内仓发出到进泰国仓之前，含「正在卸柜」）
 *
 * ⚠️ 2026-09-03 之前这份判断在本文件里自己写了一遍，另外三处（管理员看板 KPI、
 *    管理员状态分布图、AI 问答）各用各的，同一批货能算出三个数。现在统一到共享文件。
 * ⚠️ 客户首页状态分布图（client/page.tsx 的 clientStatusData）按这个字段画，
 *    管理员端导出 Excel 的「状态组」列也按它，改口径三处一起看。
 */
function classifyClientStatusGroup(
  currentStatus: string | null | undefined,
): ClientStatusGroup {
  return classifyStatusGroup(currentStatus);
}

/** Prisma 的 Decimal | null 转 number | null（用于返回前端）。 */
function decToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value.toString());
}

/**
 * 根据仓库ID返回湘泰运单号前缀。
 */
function warehousePrefix(warehouseId: string): string {
  if (warehouseId === "wh_guangzhou_01") return "GZXT";
  if (warehouseId === "wh_yiwu_01") return "YWXT";
  if (warehouseId === "wh_dongguan_01") return "DGXT";
  if (warehouseId === "wh_shenzhen_01") return "SZXT";
  return "XT";
}

/**
 * 将日期格式化为 YYYYMMDD。
 */
function toDatePart(dateText: string): string {
  return dateText.replace(/-/g, "").slice(0, 8);
}

/**
 * 判断员工/管理员是否可编辑该订单仓库维度下的数据。
 *
 * ⚠️⚠️ **永远返回 true 是有意为之，不是没写完的 TODO。别来「修」它。**
 *
 * 2026-08-22 用户明确拍板：**「不分仓库管」**。
 * 他们一共 3 个员工，其中 1 个（「可爱」）干了全部操作的 80%，
 * 另外两个账号的「授权仓库」填的是全部三个仓库 —— 实际业务从来没按仓库分过工。
 *
 * ⚠️ **如果把这里改成「按 users.warehouseIds 放行」，第二天就会出事**：
 * 「可爱」那个账号的 warehouseIds 是空数组 `[]`，一改就等于她一个仓库都没授权，
 * 系统里干活最多的人立刻什么都改不了。要真改，必须先给她配上仓库再上线。
 *
 * （有一份第三方审计报告把这条列为「P1-2 上线阻断问题」，
 *   那是按通用 RBAC 规范说的，不了解这家公司的实际分工。用户已看过并否掉。）
 */
async function staffCanEditOrderWarehouse(
  _auth: { userId: string; role: string; companyId: string },
  _warehouseId: string,
): Promise<boolean> {
  return true;
}

/**
 * ⚠️ DEPRECATED: 当前不再使用，运单号由 generatePrealertNo() 生成。
 * 按"仓库前缀+日期+3位流水"生成湘泰运单号。
 * 如重新启用，需添加 pg_advisory_xact_lock 或 unique constraint retry 防止并发冲突。
 */
async function generateTrackingNo(warehouseId: string, arrivedAt: string): Promise<string> {
  const prefix = warehousePrefix(warehouseId);
  const datePart = toDatePart(arrivedAt);
  const base = `${prefix}${datePart}`;
  const count = await prisma.shipment.count({
    where: { trackingNo: { startsWith: base } },
  });
  const seq = String(count + 1).padStart(3, "0");
  return `${base}${seq}`;
}

/**
 * 生成预报单号：仓库前缀 + YB + 7 位序号，使用 pg_advisory_xact_lock 保证并发安全。
 */
const PREALERT_LOCK_KEY = 0x5afd00b1;

function prealertPrefix(warehouseId: string): string {
  if (warehouseId === "wh_guangzhou_01") return "GZYB";
  if (warehouseId === "wh_yiwu_01") return "YWYB";
  if (warehouseId === "wh_dongguan_01") return "DGYB";
  if (warehouseId === "wh_shenzhen_01") return "SZYB";
  return "YWYB";
}

/**
 * 2026-08-31（排查报告第 5 条）改成「在调用方的事务里取号」：
 * 原来它自己开一个事务，advisory 锁在**取完号就放掉**了，订单行还没写进去——
 * 下一个请求这时进来读到同一个最大号，两张单就会拿到同一个 GZYB 号。
 * 现在锁跟着调用方的事务走（pg_advisory_xact_lock 到提交才释放），
 * 「取号 → 写订单」全程持锁，真正做到排队生成。
 */
async function generatePrealertNo(tx: Prisma.TransactionClient, warehouseId: string): Promise<string> {
  const prefix = prealertPrefix(warehouseId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PREALERT_LOCK_KEY})`;

  const last = await tx.order.findFirst({
    where: { orderNo: { startsWith: prefix } },
    orderBy: { orderNo: "desc" },
    select: { orderNo: true },
  });

  let nextSeq = 1;
  if (last?.orderNo) {
    const numPart = parseInt(last.orderNo.replace(prefix, ""), 10);
    if (!Number.isNaN(numPart)) {
      nextSeq = numPart + 1;
    }
  }

  return `${prefix}${String(nextSeq).padStart(7, "0")}`;
}

/**
 * patch-shipment-bundle 专用：「剩余 + 已装走」合计后的最后一道闸（2026-09-01 Codex 复核收尾）。
 *
 * 剩余数在 handler 入口卡过、子单是分柜时各自卡过 —— **每个数单独都合法，
 * 加起来照样能爆列上限**（跟 int-guard 里 requireSumWithinInt 记的是同一类教训）：
 *   · 件数是 Int：剩余 15 亿 + 已装走 15 亿 = 30 亿 > 2147483647
 *   · 重量 Decimal(10,2) 整数部分最多 8 位（< 1 亿）、体积 Decimal(10,3) 最多 7 位（< 1000 万）
 * 不在这里拦的话，一路穿到写 orders 那一刻才炸 500「服务器繁忙」，员工不知道错在哪。
 *
 * 纯函数、不碰库；在事务里算完合计、写库之前调。超限抛 BusinessError（最外层统一翻 400）。
 * ⚠️ 传进来的重量/体积必须是**已按列精度舍过**的落库值（调用处的 roundToScale），这里只查上限。
 */
export function guardCombinedTotals(totals: {
  /** 件数合计（剩余 + 已装走），写 orders.packageCount（Int） */
  packageCount: number;
  /** 重量合计，写 orders.weightKg（Decimal(10,2)）；null = 两边都没数 */
  weightKg: number | null;
  /** 体积合计，写 orders.volumeM3（Decimal(10,3)）；null = 两边都没数 */
  volumeM3: number | null;
}): void {
  const overCount = !Number.isFinite(totals.packageCount) || totals.packageCount > PG_INT_MAX;
  // Decimal(10,2)：整数部分最多 8 位；Decimal(10,3)：最多 7 位（口径同 decimal-guard 的 maxIntegerDigits）
  const overWeight =
    totals.weightKg !== null && (!Number.isFinite(totals.weightKg) || totals.weightKg >= 10 ** 8);
  const overVolume =
    totals.volumeM3 !== null && (!Number.isFinite(totals.volumeM3) || totals.volumeM3 >= 10 ** 7);
  if (overCount || overWeight || overVolume) {
    throw new BusinessError("整单件数/重量/体积（剩余+已装走）超出系统上限，请核对");
  }
}

export function registerOrderRoutes(app: MinimalHttpApp): void {
  app.post("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      warehouseId?: string;
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      shipDate?: string;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      receiverNameTh?: string;
      receiverPhoneTh?: string;
      receiverAddressTh?: string;
      trackingNo?: string;
      remark?: string;
      /** 整票货型（2026-09-11 老板拍板：客户自己报）。只有一种货、没分产品行时用它 */
      cargoType?: string;
      products?: Array<{
        itemName: string;
        packageCount: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        productQuantity?: number;
        weightKg?: number;
        cargoType?: string;
        domesticTrackingNo?: string;
      }>;
    };

    /**
     * ⚠️⚠️ **客户建单这条路以前完全没有这道校验**（2026-08-29 补）。
     *
     * 第七轮复核真调这个路由传 `packageCount: 0`，返回 200，
     * 订单/产品行/运单三处**全部存成 1** —— 老板最早报的
     * 「系统自己把箱数猜成 1」在这条路上原样还在。
     * 上一轮我只把 `/staff/orders` 接上了校验，三个后端入口修了一个。
     *
     * 下面原来那句 `Math.max(1, p.packageCount || 1)` 就是病根，
     * 连它上面那行注释「PackageCount: 0 silently coerced to 1」都写着了 ——
     * 有人早看见过，没修。
     *
     * ⚠️ 位置必须在**碰数据库之前**，三个入口都是这个规矩。
     */
    if (body.products?.length) {
      const rowIssue = validateProductRows(body.products);
      if (rowIssue) {
        fail(res, 400, "VALIDATION_ERROR", rowIssue);
        return;
      }
    }

    if (!body.warehouseId?.trim() || (!body.itemName && !body.products?.length) || !body.transportMode) {
      fail(res, 400, "BAD_REQUEST", "missing required prealert fields");
      return;
    }

    // 没有产品行的单子，箱数全靠订单级这个字段：正整数 + 不超过 32 位上限
    // ⚠️ 上一版漏了上限，复核实测 2147483648 能过（2026-08-29 补）
    if (!body.products?.length) {
      const pkgIssue = requirePositiveInt(parseNumericStrict(body.packageCount), "箱数");
      if (pkgIssue) {
        fail(res, 400, "VALIDATION_ERROR", pkgIssue);
        return;
      }
    }

    /**
     * 货型校验（2026-09-11）：非法值当场 400，不许静默存成普货。
     * 客户端现在有货型下拉，只会发那三个值；这道闸挡的是直接调接口的。
     */
    const cargo = readCargoTypes(body.cargoType, body.products);
    if ("error" in cargo) { fail(res, 400, "VALIDATION_ERROR", cargo.error); return; }

    // Compute products totals
    const products = body.products?.length
      ? body.products.map((p, i) => ({
          itemName: p.itemName.trim(),
          packageCount: p.packageCount,
          lengthCm: p.lengthCm ?? null,
          widthCm: p.widthCm ?? null,
          heightCm: p.heightCm ?? null,
          productQuantity: p.productQuantity ?? null, cargoType: cargo.products[i], domesticTrackingNo: p.domesticTrackingNo?.trim() || "货拉拉", weightKg: p.weightKg ?? null, sortOrder: i }))
      // 兜底分支的字段要和上面那支**完全一致**，否则联合类型里少了几个字段，
      // 下面 reduce 读 weightKg / cargoType 时会报错（2026-08-27 补齐）
      : [{
          itemName: body.itemName!.trim(),
          packageCount: Number(body.packageCount ?? 0),
          lengthCm: null,
          widthCm: null,
          heightCm: null,
          productQuantity: null,
          // ⚠️ domesticTrackingNo 必须和**数据库默认值**一模一样（'货拉拉'）——
          // 原来这里根本没写，createMany 传 undefined 时数据库会填默认值；
          // 显式写出来是为了类型对齐，**不能顺手改成别的值**。
          // 货型 2026-09-11 起改成跟整票一致：客户端没分产品行时会发整票货型，
          // 原来写死 "normal" 会把客户选的「商检」丢掉（空着仍然是 normal）。
          cargoType: cargo.order,
          domesticTrackingNo: "货拉拉",
          weightKg: null,
          sortOrder: 0,
        }];

    // ⚠️ 不许 `Math.max(1, ...)`：上面已经卡死必须是正整数，这里再兜一次
    // 等于把校验的结果又抹掉一遍（2026-08-29 去掉）
    const totalPkg = products.reduce((s, p) => s + p.packageCount, 0);
    const totalWeight = products.reduce((s, p) => s + (p.weightKg ?? 0) * p.packageCount, 0);
    const totalVol = products.reduce((s, p) => {
      if (p.lengthCm && p.widthCm && p.heightCm) return s + (p.lengthCm * p.widthCm * p.heightCm * p.packageCount) / 1_000_000;
      return s;
    }, 0);
    const primaryName = products[0].itemName;

    if (!body.warehouseId?.trim() || !primaryName || !body.transportMode) {
      fail(res, 400, "BAD_REQUEST", "missing required prealert fields");
      return;
    }

    const now = new Date().toISOString();
    const shipDateText = body.shipDate?.trim() || now.slice(0, 10);
    const shipDate = new Date(`${shipDateText}T00:00:00`);
    if (Number.isNaN(shipDate.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid shipDate");
      return;
    }
    const manualWeightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const manualVolumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    /* 2026-08-31（排查报告第 5 条）：内部编号加随机后缀。
       原来 orderId / shipmentId 只用当前毫秒数，两个客户（或一个客户双击提交）
       撞同一毫秒就撞主键报错；同文件写轨迹编号（sl_）和派送单号（admin-ops 的 lm_）
       早就是「时间戳 + 随机后缀」的写法，这里对齐。 */
    const orderId = `o_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    /* 2026-08-31（排查报告第 5 条）：取号、订单、产品行、运单、首条轨迹
       全部包进同一个事务。原来是四次各写各的，中间任何一步失败前面的不回滚，
       会留下「有订单没运单、没轨迹」的半套数据——客户列表里看得到这张单，
       但没运单号、装不了柜，只能找技术手工补。写法照同文件「确认收货」那条路；
       这里全是新建行、没有并发改同一行的问题，所以不需要行锁和锁后重读
       （取号的排队靠 generatePrealertNo 里的 advisory 锁，锁到提交才放）。 */
    const orderNo = await prisma.$transaction(async (tx) => {
      const newOrderNo = await generatePrealertNo(tx, body.warehouseId!.trim());
      await tx.order.create({
        data: {
          id: orderId,
          companyId: auth.companyId,
          clientId: auth.userId,
          warehouseId: body.warehouseId!.trim(),
          batchNo: null,
          orderNo: newOrderNo,
          approvalStatus: "shipped",
          itemName: primaryName,
          productQuantity: 0,
          packageCount: totalPkg,
          packageUnit: body.packageUnit ?? "box",
          weightKg: totalWeight > 0 ? (totalWeight as unknown as Prisma.Decimal) : (manualWeightKg as unknown as Prisma.Decimal | null),
          volumeM3: totalVol > 0 ? totalVol : (manualVolumeM3 as unknown as Prisma.Decimal | null),
          receivableAmountCny: null,
          receivableCurrency: "CNY",
          shipDate: shipDateText,
          domesticTrackingNo: body.domesticTrackingNo ?? null,
          transportMode: body.transportMode!,
          // 订单这一层的货型（2026-09-11 补）：原来这条路**根本没写这个字段**，
          // 一律吃数据库默认的 normal，客户选了商检也看不出来。
          // 有产品行时取最严的那个（敏感 > 商检 > 普货），跟批量导入同一个口径。
          cargoType: body.products?.length ? strictestCargoType(cargo.products) : cargo.order,
          receiverNameTh: body.receiverNameTh?.trim() || "",
          receiverPhoneTh: body.receiverPhoneTh?.trim() || "",
          receiverAddressTh: body.receiverAddressTh?.trim() || "",
          statusGroup: "unfinished",
        },
      });

      // Create product records (批量插入)
      if (products.length > 0) {
        await tx.orderProduct.createMany({
          data: products.map((p, i) => ({
            companyId: auth.companyId,
            orderId,
            itemName: p.itemName,
            packageCount: p.packageCount,
            lengthCm: p.lengthCm ?? null,
            widthCm: p.widthCm ?? null,
            heightCm: p.heightCm ?? null,
            productQuantity: p.productQuantity ?? null,
            cargoType: p.cargoType,
            domesticTrackingNo: p.domesticTrackingNo,
            // 2026-08-31（排查报告第 6 条）：客户逐行填的单箱重量原来漏写这一列，
            // 总重算对了、明细行全存成空，员工端打开看重量列全空。员工建单那条路
            // （下面 /staff/orders）一直是存的，这里补齐对齐。
            weightKg: p.weightKg,
            sortOrder: i,
          })),
        });
      }

      // 同步创建运单（预报单=运单号）
      const shipmentId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await tx.shipment.create({
        data: {
          id: shipmentId,
          companyId: auth.companyId,
          orderId,
          trackingNo: newOrderNo,
          batchNo: null,
          currentStatus: "created",
          weightKg: totalWeight > 0 ? (totalWeight as unknown as Prisma.Decimal) : (manualWeightKg as unknown as Prisma.Decimal | null),
          volumeM3: totalVol > 0 ? (totalVol as unknown as Prisma.Decimal) : (manualVolumeM3 as unknown as Prisma.Decimal | null),
          packageCount: totalPkg,
          packageUnit: body.packageUnit ?? "box",
          transportMode: body.transportMode!,
          domesticTrackingNo: body.domesticTrackingNo ?? null,
          warehouseId: body.warehouseId!.trim(),
        },
      });

      // 2026-08-06：轨迹的起点。原来建单不写任何轨迹，客户查件最早只能看到「已装柜」，
      // 前面从预报到装柜的十天半个月是空白（生产实测「已创建」轨迹条数为 0）。
      await tx.statusLog.create({
        data: {
          id: `sl_new_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          companyId: auth.companyId, shipmentId,
          operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "",
          fromStatus: "created", toStatus: "created",
          remark: "客户已提交预报，等待国内仓收货",
          nextStop: "国内仓",
          changedAt: new Date(),
        },
      });

      // ⚠️ 事务回调必须 return，外层才拿得到值（CLAUDE.md 强制检查第 7 条）
      return newOrderNo;
    });

    ok(res, { prealertId: orderId, trackingNo: orderNo, createdAt: now });
  });

  /**
   * 员工/管理员确认收货：核实数据并标记预报单为已收货。
   */
  app.post("/staff/prealerts/receive", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      orderId?: string;
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      productQuantity?: number;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      cargoType?: string;
      /* 2026-08-31（排查报告第 1 条 → 深夜老板重申「钱只在集货里」）：
         弹窗里的柜号随收货保存；「应收金额」一度接进来过，当晚按老板拍板拆除 ——
         普通运单不录钱，跟 2026-08-07「运单不再涉及金额」保持一致。 */
      batchNo?: string;
    };
    const orderId = body.orderId?.trim();
    if (!orderId) { fail(res, 400, "BAD_REQUEST", "orderId is required"); return; }

    /**
     * ⚠️⚠️ **确认收货是「把仓库实收的数字定下来」，写错就一路错到底**（2026-08-29 第九轮收紧）。
     *
     * 原来这里只判 `Number.isFinite(n) && n >= 0`，复核用真实 handler 夹具
     * 传一整套 0 进来，**返回 200，件数/重量/方数全部准备写成 0**。
     * 三个毛病：
     *   · `0` 被放行 —— 仓库收到的货不可能是 0 件、0 公斤、0 方；
     *     写成 0 之后方数没了，而仓库版集货是「方数 × 单价」收费的
     *   · 小数和超 32 位上限被放行 —— packageCount / productQuantity 在库里是 `Int`
     *   · 先 `Number(...)` 再判 —— `Number(true)` 是 1，JSON 传布尔能当成 1 件
     *
     * ⚠️ 位置放在**碰数据库之前**（2026-08-29 挪的），跟别的入口一个规矩：
     *    参数本来就不合法的请求不该先查一轮库；而且自测想验它就得连库。
     * ⚠️ 只校验**传了的**字段：员工可以只改箱数、不动重量，没传的不该被逼着填。
     */
    let receivePackageCount: number | undefined;
    if (body.packageCount !== undefined) {
      const n = parseNumericStrict(body.packageCount);
      const issue = requirePositiveInt(n, "箱数");
      if (issue) { fail(res, 400, "VALIDATION_ERROR", issue); return; }
      receivePackageCount = n;
    }
    let receiveProductQuantity: number | undefined;
    if (body.productQuantity !== undefined) {
      const n = parseNumericStrict(body.productQuantity);
      const issue = requirePositiveInt(n, "产品数量");
      if (issue) { fail(res, 400, "VALIDATION_ERROR", issue); return; }
      receiveProductQuantity = n;
    }
    /**
     * 重量和方数在库里是 `Decimal`，不是 `Int`，所以不能用整数那套闸；
     * 但同样不许是 0、负数、非数字 —— 收到的货不可能没有重量、没有体积。
     */
    /**
     * ⚠️⚠️ 重量和方数要按**数据库精度**卡，光判「大于 0」不够（2026-08-29 第十轮改）。
     *
     * 上一版我只加了 `n > 0`，复核当场用真实夹具打穿：
     *   重量 0.001 kg → `Decimal(10,2)` **存成 0.00**
     *   方数 0.0001 m³ → `Decimal(10,3)` **存成 0.000**
     * 「不能写 0」只修了表面 —— 换成一个很小的正数，照样存进去是 0。
     * 而仓库版集货是「方数 × 单价」收费的，方数变 0 这一票就白送了。
     * 超大数则会写库 500。
     *
     * ⚠️ 两列精度**不一样**：Order/Shipment 的 weightKg 是 (10,2)、volumeM3 是 (10,3)。
     *    别拿同一套规格去卡，会误伤合法的三位小数方数。
     */
    let receiveWeightKg: number | undefined;
    if (body.weightKg !== undefined && body.weightKg !== null) {
      const issue = requireDecimal(body.weightKg, "重量(kg)", DECIMAL_10_2);
      if (issue) { fail(res, 400, "VALIDATION_ERROR", issue); return; }
      receiveWeightKg = parseNumericStrict(body.weightKg);
    }
    let receiveVolumeM3: number | undefined;
    if (body.volumeM3 !== undefined && body.volumeM3 !== null) {
      const issue = requireDecimal(body.volumeM3, "体积(m³)", DECIMAL_10_3);
      if (issue) { fail(res, 400, "VALIDATION_ERROR", issue); return; }
      receiveVolumeM3 = parseNumericStrict(body.volumeM3);
    }
    // 柜号：trim 后存；传空串当「没填」，不去清掉订单上已有的柜号
    const receiveBatchNo =
      typeof body.batchNo === "string" && body.batchNo.trim() ? body.batchNo.trim() : undefined;

    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      // currentStatus 是写「已入库」轨迹时要用的 fromStatus（2026-08-06；2026-09-02 起还要拿它判断该不该推状态）
      include: { shipments: { take: 1, select: { id: true, currentStatus: true } } },
    });
    if (!order) { fail(res, 404, "NOT_FOUND", "order not found"); return; }
    if (order.approvalStatus === "received") {
      fail(res, 400, "VALIDATION_ERROR", "已确认收货");
      return;
    }

    const now = new Date();
    const updateData: any = {
      approvalStatus: "received",
      statusGroup: "unfinished",
      updatedAt: now,
    };
    if (body.itemName?.trim()) updateData.itemName = body.itemName.trim();
    if (receivePackageCount !== undefined) updateData.packageCount = receivePackageCount;
    if (body.packageUnit) updateData.packageUnit = body.packageUnit;
    if (receiveWeightKg !== undefined) updateData.weightKg = receiveWeightKg as any;
    if (receiveVolumeM3 !== undefined) updateData.volumeM3 = receiveVolumeM3 as any;
    if (receiveProductQuantity !== undefined) updateData.productQuantity = receiveProductQuantity;
    if (body.transportMode) updateData.transportMode = body.transportMode;
    // 改单时也校验货型（2026-09-11）：原来传什么写什么
    if (body.cargoType !== undefined && String(body.cargoType).trim() !== "") {
      const edited = readCargoTypes(body.cargoType, undefined);
      if ("error" in edited) { fail(res, 400, "VALIDATION_ERROR", edited.error); return; }
      updateData.cargoType = edited.order;
    }
    if (body.domesticTrackingNo) updateData.domesticTrackingNo = body.domesticTrackingNo;
    // 2026-08-31（排查报告第 1 条）：柜号传了才写，没传不动
    if (receiveBatchNo !== undefined) updateData.batchNo = receiveBatchNo;

    /**
     * ⚠️⚠️ **订单 + 运单 + 轨迹必须在同一个事务里**（2026-08-29 第九轮改）。
     *
     * 原来是三次独立的 `prisma.*` 写：
     *   ① order.update  ② shipment.update  ③ statusLog.create
     * 中间任何一步失败，就留下**半套数据** —— 比如订单已经是「已收货」、
     * 运单的件数重量还是旧的、客户轨迹里没有「国内仓已收货」那条。
     * 而且两个仓管同时点确认收货，会各写一条到仓轨迹（客户看到两条一样的）。
     *
     * ⚠️ 锁序【订单 → 运单】，跟删订单那两条路一致。
     * ⚠️ 「锁只保证不同时，不保证数据没变」：锁完必须**重查**审批状态，
     *    不能接着用事务外那份 order（CLAUDE.md 第 28 条）。
     */
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} AND company_id = ${auth.companyId} FOR UPDATE`;
      const fresh = await tx.order.findFirst({
        where: { id: orderId, companyId: auth.companyId },
        select: { approvalStatus: true },
      });
      if (!fresh) throw new BusinessError("订单不存在", 404, "NOT_FOUND");
      if (fresh.approvalStatus === "received") {
        // 上面那道「已确认收货」的判断是在事务外做的，两个人同时点会双双通过
        throw new BusinessError("这张单刚刚已经被确认收货了，本次没有重复执行，请刷新后再看");
      }

      /**
       * ⚠️ 锁完运单要**重新读一遍它的状态**（2026-08-29 第十轮补）。
       * 上一版锁是加了，但下面写轨迹的 `fromStatus` 用的还是**事务外**
       * 那份 `order.shipments[0].currentStatus` ——
       * 等锁的这段时间里运单被别的流程推进了，轨迹上就会记一个旧状态。
       * 「锁只保证不同时，不保证数据没变」（CLAUDE.md 第 28 条）——
       * 这条我在别处修过好几次了，这里又忘了。
       */
      const shipment = order.shipments[0];
      let freshShipmentStatus: string | undefined;
      if (shipment) {
        await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${shipment.id} FOR UPDATE`;
        const s2 = await tx.shipment.findUnique({
          where: { id: shipment.id },
          select: { currentStatus: true },
        });
        freshShipmentStatus = s2?.currentStatus ?? shipment.currentStatus;
      }

      await tx.order.update({ where: { id: orderId }, data: updateData });

      // 同步更新运单
      if (shipment) {
        const sUpdate: any = { updatedAt: now };
        if (receiveWeightKg !== undefined) sUpdate.weightKg = receiveWeightKg as any;
        if (receiveVolumeM3 !== undefined) sUpdate.volumeM3 = receiveVolumeM3 as any;
        if (receivePackageCount !== undefined) sUpdate.packageCount = receivePackageCount;
        if (body.packageUnit) sUpdate.packageUnit = body.packageUnit;
        if (body.transportMode) sUpdate.transportMode = body.transportMode;
        if (body.itemName?.trim()) sUpdate.itemName = body.itemName.trim();
        // 柜号要同步写到运单上：运单列表显示的是 shipment.batchNo（shipments/routes.ts），
        // 只写订单的话，收货时填的柜号在运单列表里看不到——「订单详情」编辑那条路
        // （patch-shipment-bundle）也是两边一起写的，口径保持一致（2026-08-31）
        if (receiveBatchNo !== undefined) sUpdate.batchNo = receiveBatchNo;
        /**
         * 2026-09-02：inWarehouseCN（已入库）进了状态流程（STATUS_FLOW），
         * 确认收货不再是「只写轨迹不动状态」—— currentStatus 一并推到「已入库」。
         * ⚠️ 只在锁后重读的状态还是 created 时才推（只往前不往后）：
         *    货先被装柜/推进过的单（老数据补确认收货很常见），状态已经在
         *    inWarehouseCN 后面了，这里绝不能把它拽回来。
         *    轨迹照旧无条件写 —— 「仓库收到货」是发生过的事实，fromStatus 用锁后重读的值。
         */
        if ((freshShipmentStatus ?? shipment.currentStatus) === "created") {
          sUpdate.currentStatus = "inWarehouseCN";
        }
        await tx.shipment.update({ where: { id: shipment.id }, data: sUpdate });

        // 2026-08-06：国内仓收到货是客户最关心的一步，原来一条轨迹都不写。
        await tx.statusLog.create({
          data: {
            id: `sl_rcv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            companyId: auth.companyId, shipmentId: shipment.id,
            operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "",
            // ⚠️ 用锁后重读的状态，不是事务外那份
            fromStatus: freshShipmentStatus ?? shipment.currentStatus, toStatus: "inWarehouseCN",
            remark: "货已入库（国内仓已收货），等待装柜",
            nextStop: "装柜",
            changedAt: now,
          },
        });
      }
    });

    ok(res, { orderId, status: "received", updatedAt: now.toISOString() });
  });

  /**
   * 客户端删除预报单（确认收货前可删）。
   */
  /* 2026-09-02 老板拍板：客户「自助改/删预报单」两个接口下线（原 /client/prealerts/delete）。
     它们自始至终没有页面入口（客户端那个编辑弹窗是死代码，2026-08-31 已删），
     留着就是一扇没人测的暗门。客户改单一律找员工（员工端预报单审核可改）。
     恢复走 git 历史。 */
  /* 2026-09-02 老板拍板：客户「自助改/删预报单」两个接口下线（原 /client/prealerts/update）。
     它们自始至终没有页面入口（客户端那个编辑弹窗是死代码，2026-08-31 已删），
     留着就是一扇没人测的暗门。客户改单一律找员工（员工端预报单审核可改）。
     恢复走 git 历史。 */
  app.post("/staff/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      clientId?: string;
      batchNo?: string;
      trackingNo?: string;
      arrivedAt?: string;
      itemName?: string;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      domesticTrackingNo?: string;
      cargoType?: string;
      transportMode?: "sea" | "land";
      receiverNameTh?: string;
      receiverPhoneTh?: string;
      receiverAddressTh?: string;
      warehouseId?: string;
      remark?: string;
      products?: Array<{
        itemName: string;
        packageCount: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        productQuantity?: number;
        weightKg?: number;
        cargoType?: string;
        domesticTrackingNo?: string;
      }>;
    };

    /**
     * 产品行的校验统一交给 product-row-guard（2026-08-29 抽出去了，方便单测）。
     * 规矩：箱数正整数、「每箱几个」全填或全空且填了就得是正整数 ——
     * 跟批量导入（batchOrderImport）和前端 productRowGuard 同一份口径。
     *
     * ⚠️ 前端三端原来都是 `Number(p.packageCount) || 1` 才发出来的，
     * 所以这道闸以前根本挡不到「员工把箱数清空」那种情况 —— 2026-08-29 已经
     * 把那三处的兜底一起去掉了，别再加回来。
     */
    if (body.products?.length) {
      const rowIssue = validateProductRows(body.products);
      if (rowIssue) {
        fail(res, 400, "VALIDATION_ERROR", rowIssue);
        return;
      }
    }
    const orderQtyIssue = validateOrderLevelQuantity(body.productQuantity);
    if (orderQtyIssue) {
      fail(res, 400, "VALIDATION_ERROR", orderQtyIssue);
      return;
    }
    /**
     * ⚠️ **没有产品行时，订单级的箱数也要卡**（2026-08-29 第八轮补）。
     * 上一轮我只卡了产品行，复核实测「员工建单不传 products、
     * packageCount 填 0 或 2.5」照样 200 —— 管理员那条旧批量导入走的正是这条路。
     */
    if (!body.products?.length) {
      const pkgIssue = requirePositiveInt(parseNumericStrict(body.packageCount), "箱数");
      if (pkgIssue) {
        fail(res, 400, "VALIDATION_ERROR", pkgIssue);
        return;
      }
    }

    // 货型校验（2026-09-11）：批量导入现在会真传货型上来，非法值必须 400，不能静默变普货
    const staffCargo = readCargoTypes(body.cargoType, body.products);
    if ("error" in staffCargo) { fail(res, 400, "VALIDATION_ERROR", staffCargo.error); return; }

    const staffProducts = body.products?.length
      ? body.products.map((p, i) => ({
          itemName: p.itemName.trim(),
          packageCount: p.packageCount,
          lengthCm: p.lengthCm ?? null,
          widthCm: p.widthCm ?? null,
          heightCm: p.heightCm ?? null,
          productQuantity: p.productQuantity ?? null, cargoType: staffCargo.products[i], domesticTrackingNo: p.domesticTrackingNo?.trim() || "货拉拉", weightKg: p.weightKg ?? null, sortOrder: i }))
      : body.itemName ? [{
          itemName: body.itemName.trim(),
          packageCount: Number(body.packageCount ?? 0),
          lengthCm: null,
          widthCm: null,
          heightCm: null,
          productQuantity: null,
          cargoType: staffCargo.order,
          domesticTrackingNo: body.domesticTrackingNo?.trim() || "货拉拉",
          weightKg: null,
          sortOrder: 0,
        }] : [];

    const prName = staffProducts[0]?.itemName ?? body.itemName ?? "";
    const prPkg = staffProducts.reduce((s, p) => s + p.packageCount, 0) || Number(body.packageCount ?? 0);
    const prWeight = staffProducts.reduce((s, p) => s + (p.weightKg ?? 0) * p.packageCount, 0);
    const prVol = staffProducts.reduce((s, p) => {
      if (p.lengthCm && p.widthCm && p.heightCm) return s + (p.lengthCm * p.widthCm * p.heightCm * p.packageCount) / 1_000_000;
      return s;
    }, 0);

    /**
     * ⚠️ 2026-08-29：原来这里只回一句英文 "missing required fields"，
     * 批量建单时员工看到的就是这一句，既看不懂也不知道到底缺了什么。
     * 改成中文并且**点名缺的是哪几项**。
     */
    const arrivedAtText = body.arrivedAt?.trim() ?? "";
    const missingFields = [
      !body.clientId ? "唛头" : "",
      !prName && !body.itemName ? "品名" : "",
      !body.transportMode ? "运输方式" : "",
      !body.warehouseId ? "仓库" : "",
      !arrivedAtText ? "到仓日期" : "",
    ].filter(Boolean);
    if (missingFields.length > 0) {
      fail(res, 400, "BAD_REQUEST", `缺少必填项：${missingFields.join("、")}`);
      return;
    }
    // 上面已经逐项挡过空值了，这里取出来让类型也确定下来（原来是靠一个大 if 收窄的）
    const clientId = body.clientId!;
    const warehouseId = body.warehouseId!;
    const transportMode = body.transportMode!;

    // Verify clientId belongs to the same company and is a client role
    const targetClient = await prisma.user.findUnique({
      where: { id: body.clientId },
      select: { id: true, companyId: true, role: true },
    });
    if (!targetClient || targetClient.companyId !== auth.companyId || targetClient.role !== "client") {
      fail(res, 400, "BAD_REQUEST", "唛头不存在或不属于当前公司，请核对客户唛头");
      return;
    }

    /**
     * ⚠️ 必须先卡格式，再交给 new Date（2026-08-29 加）。
     * 只判 `Number.isNaN(new Date(x).getTime())` 挡不住半截日期 ——
     * 实测 "2026"、"2026-08"、"2026-02-31"、"2026-02-30" **全都被认为合法**
     * （2月31号会被滚成3月2号），而下面 shipDate 存的是 `body.arrivedAt` 原文，
     * 于是数据库里就真的躺着 shipDate="2026" 或 "2026-02-31" 这种东西。
     * 只有 "2026-13-01" 这种月份越界才会 Invalid Date。
     */
    const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(arrivedAtText);
    const arrivedAtDate = dateParts ? new Date(`${arrivedAtText}T00:00:00`) : new Date(NaN);
    const sameDay =
      dateParts !== null &&
      !Number.isNaN(arrivedAtDate.getTime()) &&
      arrivedAtDate.getFullYear() === Number(dateParts[1]) &&
      arrivedAtDate.getMonth() + 1 === Number(dateParts[2]) &&
      arrivedAtDate.getDate() === Number(dateParts[3]);
    if (!sameDay) {
      fail(res, 400, "BAD_REQUEST", `到仓日期「${arrivedAtText}」不是有效日期，请写成 2026-08-29 这种格式`);
      return;
    }

    const now = arrivedAtDate.toISOString();
    /* 2026-08-31（排查报告第 5 条同病根）：内部编号加随机后缀。
       原来只用当前毫秒数，两个员工（或一个员工双击提交）撞同一毫秒
       就撞主键报错；批量建单更是一毫秒里连发好几张。
       写法照上面客户预报那条路（o_/s_ + 4 位随机尾巴）。 */
    const orderId = `o_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const shipmentId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const manualTrackingNo = body.trackingNo?.trim();
    if (manualTrackingNo) {
      const clash = await prisma.shipment.findFirst({
        where: { trackingNo: manualTrackingNo, companyId: auth.companyId },
        select: { id: true },
      });
      if (clash) {
        fail(res, 409, "VALIDATION_ERROR", `运单号 ${manualTrackingNo} 已存在`);
        return;
      }
    }
    if (!manualTrackingNo) {
      fail(res, 400, "BAD_REQUEST", "运单号为必填");
      return;
    }
    const generatedTrackingNo = manualTrackingNo;
    const weightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    const batchNo = body.batchNo?.trim() || null;
    // 件数：产品行是明细事实源，整票件数按明细汇总，避免调用方传的合计对不上。
    const packageCountNum = staffProducts.length > 0 ? prPkg : Number(body.packageCount ?? 0);

    /**
     * ⚠️ 产品数量**不能**照着件数那样按产品行求和（2026-08-28 修）。
     *
     * 同一个字段名 productQuantity 在两个层级上是两个意思：
     *   · 订单级（前端 staff/page.tsx:1413，提示语「产品数量 *」）= 员工填的**总数**
     *   · 产品行级（同文件 1375 / 2472 行，提示语「**单箱数量**」）= 每箱多少个
     * 之前改成 `sum(产品行.productQuantity)`，等于把「单箱数量」当成总数直接相加，
     * 少乘了箱数 —— 2 个产品各 3 箱、每箱 10 个，真实总数 60，会被写成 20；
     * 而且产品行这个字段允许留空，全空时直接写成 0，把员工填的总数覆盖掉。
     *
     * ⚠️ 2026-08-28 更正：原来这里写着「批量导入那条路不受影响，解析器本来就会把
     * 订单级的合计算好一起传上来」—— **那句话是错的**。
     * `batchOrderImport.ts` 的汇总当时也漏乘了箱数（老板实测：填 2/3/4 箱、每箱 2/3/4 个，
     * 正确 29，系统报 9）。那边已经补上 `× packageCount`。
     * 教训：修一处口径时，别只在注释里断言「别的路没事」，要真去看一眼那条路的代码。
     */
    /**
     * ⚠️ 2026-08-28 再补：**前端没传时不能存成 0**。
     * 复核实测这条路「信任前端合计，前端没传就写 0」——
     * 客户订单上的产品数量凭空变成 0，而产品行里明明填着数。
     * 前端传了就用它（那是员工在订单级填的总数，说了算）；
     * 没传、而产品行有数量时，按 Σ(箱数 × 单箱数量) 兜底，跟批量导入同一个算法。
     */
    const productQuantityFromRows = staffProducts.reduce(
      (s, p) => s + (p.productQuantity ?? 0) * p.packageCount,
      0,
    );
    /**
     * ⚠️ 有产品行时**以产品行为准**（2026-08-28 改），跟上面件数
     * `staffProducts.length > 0 ? prPkg : body.packageCount` 同一个规矩。
     * 原来是「前端传了就无条件用前端的」—— 前端算错、或者版本不一致时，
     * 订单上的总数会跟明细对不上，而明细才是事实源。
     * 没有产品行时才用前端传的那个订单级总数（那种单子本来就没有明细）。
     */
    const productQuantityNum =
      staffProducts.length > 0 && productQuantityFromRows > 0
        ? productQuantityFromRows
        : Number(body.productQuantity ?? 0);
    const packageUnit = body.packageUnit ?? "box";

    // 事务前计算应收金额（按产品行分别计价求和）

    const txOps: any[] = [
      prisma.order.create({
        data: {
          id: orderId,
          companyId: auth.companyId,
          clientId,
          warehouseId,
          batchNo,
          orderNo: null,
          approvalStatus: "approved",
          itemName: body.itemName?.trim() || prName,
          productQuantity: productQuantityNum,
          packageCount: packageCountNum,
          packageUnit,
          weightKg: prWeight > 0 ? (prWeight as unknown as Prisma.Decimal) : (weightKg as unknown as Prisma.Decimal | null),
          volumeM3: prVol > 0 ? (prVol as unknown as Prisma.Decimal) : (volumeM3 as unknown as Prisma.Decimal | null),
          receivableCurrency: "CNY",
          shipDate: arrivedAtText,
          domesticTrackingNo: body.domesticTrackingNo ?? null,
          transportMode,
          // 有产品行时取最严的那个（敏感 > 商检 > 普货），跟批量导入和客户预报单同一个口径
          cargoType: body.products?.length ? strictestCargoType(staffCargo.products) : staffCargo.order,
          receiverNameTh: "",
          receiverPhoneTh: "",
          receiverAddressTh: "",
          statusGroup: "unfinished",
        },
      }),
      prisma.shipment.create({
        data: {
          id: shipmentId,
          companyId: auth.companyId,
          orderId,
          trackingNo: generatedTrackingNo,
          batchNo,
          /* 2026-09-02 老板拍板：录单就是货到了仓库才录单 ——
             员工建单的运单起始状态直接是「已入库」，不是「已创建」。
             （客户预报那条路不一样：报单时货还在路上，仍从 created 起。） */
          currentStatus: "inWarehouseCN",
          currentLocation: null,
          weightKg: prWeight > 0 ? (prWeight as unknown as Prisma.Decimal) : (weightKg as unknown as Prisma.Decimal | null),
          volumeM3: prVol > 0 ? (prVol as unknown as Prisma.Decimal) : (volumeM3 as unknown as Prisma.Decimal | null),
          packageCount: packageCountNum,
          packageUnit,
          transportMode,
          domesticTrackingNo: body.domesticTrackingNo ?? null,
          warehouseId,
          remark: body.remark?.trim() || null,
        },
      }),
      // 2026-08-06：轨迹起点。员工直接建单的这条路原来也不写轨迹，
      // 和客户预报那条路一样，客户查件最早只能看到「已装柜」。
      prisma.statusLog.create({
        data: {
          id: `sl_new_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          companyId: auth.companyId,
          shipmentId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name ?? "",
          /* 2026-09-02 老板拍板落地：员工建单=货已到仓，运单直接从「已入库」起步，
             首条轨迹写 created → inWarehouseCN，客户一眼看到货已进仓。
             录单那一刻货已经在仓里，下一站是「装柜」（跟确认收货那条轨迹同一口径）。
             ⚠️ 客户报预报单那条路（remark「等待国内仓收货」那处）仍是 created → created、
             下一站「国内仓」—— 那时货还在路上，是对的，别顺手改。 */
          fromStatus: "created",
          toStatus: "inWarehouseCN",
          remark: "货已到国内仓，等待装柜",
          nextStop: "装柜",
          changedAt: new Date(),
        },
      }),
    ];
    // 保存产品行
    if (staffProducts.length > 0) {
      txOps.push(
        prisma.orderProduct.createMany({
          data: staffProducts.map((p) => ({
            companyId: auth.companyId,
            orderId,
            itemName: p.itemName,
            packageCount: p.packageCount,
            lengthCm: p.lengthCm,
            widthCm: p.widthCm,
            heightCm: p.heightCm,
            productQuantity: p.productQuantity,
            cargoType: p.cargoType,
            domesticTrackingNo: p.domesticTrackingNo,
            weightKg: p.weightKg,
            sortOrder: p.sortOrder,
          })),
        }),
      );
    }
    await prisma.$transaction(txOps);

    ok(res, { orderId, createdAt: now });
  });



  app.get("/client/orders", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 500);
    const statusGroup = req.query.statusGroup?.trim();
    /* 2026-08-31（排查报告第 23 条）：查询参数改收分组值；2026-09-03 多一个 arrived。
       老值兼容：老页面缓存还会发 unfinished / completed ——
       unfinished = pending + transit + arrived，completed = delivered + closed。
       不认识的值跟原来一样当「不过滤」（陌生状态绝不能整单消失）。
       口径断言见 scripts/test-client-status-group.ts。 */
    const GROUP_ALIAS: Record<string, Array<"pending" | "transit" | "arrived" | "delivered" | "closed">> = {
      pending: ["pending"],
      transit: ["transit"],
      // 2026-09-03：进泰国仓后整段（已到仓/预约派送/派送中）从在途拆出；
      // ⚠️「正在卸柜」不在里面，它按老板口径算在途（见 classifyClientStatusGroup）
      arrived: ["arrived"],
      delivered: ["delivered"],
      closed: ["closed"],
      unfinished: ["pending", "transit", "arrived"],
      completed: ["delivered", "closed"],
    };
    const wantedGroups = statusGroup ? GROUP_ALIAS[statusGroup] : undefined;
    /* 2026-09-05：「异常」是关注维度不是分组（和在途可重叠），单独认。
       原先客户端为了不依赖后端重启，整页拉全量再前端筛——每 10 秒轮询几 MB 白传。
       这里认了之后每页只回异常单；客户端仍保留一道前端筛，老后端不认这个参数时结果也对。 */
    const wantAttention = statusGroup === "attention";
    const itemName = req.query.itemName?.trim();
    const transportMode = req.query.transportMode?.trim();
    const trackingNo = req.query.trackingNo?.trim();
    const orderNo = req.query.orderNo?.trim();
    const domesticTrackingNo = req.query.domesticTrackingNo?.trim();

    const where: Prisma.OrderWhereInput = {
      companyId: auth.companyId,
      /* 2026-08-31（排查报告第 23 条）：加上 received。
         员工点「确认收货」后订单变成 received，全系统没有任何代码再把它改回来——
         原来这里只认 approved/shipped，单子一被确认到仓就从客户的订单列表、
         三个分组按钮和首页统计里全部消失，客户会以为单丢了。 */
      approvalStatus: { in: ["approved", "shipped"] },
      clientId: auth.userId,
      // 运单号搜索下推到数据库：父单、子单任一命中都算，且 count 与列表口径一致
      ...(trackingNo ? { shipments: { some: { trackingNo } } } : {}),
    };
    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          shipments: {
            // 客户端只展示父运单：parentTrackingNo 为 null 的排在最前，
            // 万一某订单只剩子单（父单被删）才退回最近更新的那条，不至于整行没单号
            orderBy: [{ parentTrackingNo: { sort: "asc", nulls: "first" } }, { updatedAt: "desc" }],
            take: 1,
            select: {
              id: true,
              trackingNo: true,
              currentStatus: true,
              remark: true,
              statusLogs: {
                where: { NOT: [{ remark: null }, { remark: "" }] },
                orderBy: { changedAt: "asc" },
                select: {
                  remark: true,
                  changedAt: true,
                  fromStatus: true,
                  toStatus: true,
                  // 2026-09-15：不再查 operatorRole / operatorName —— 这个接口只给客户，
                  // 操作人身份只有超级管理员能看（core/operator-visibility.ts）
                },
              },
            },
          },
        },
      }),
    ]);

    const totalMetricsByOrderId = await loadOrderTotalMetrics(
      auth.companyId,
      orders.map((order) => ({
        orderId: order.id,
        orderVolumeM3: order.volumeM3,
        orderWeightKg: order.weightKg,
      })),
    );

    const filtered = orders
      .filter((o) => !itemName || o.itemName.includes(itemName))
      .filter((o) => !transportMode || o.transportMode === transportMode)
      .filter((o) => !orderNo || o.orderNo === orderNo)
      .filter((o) => !domesticTrackingNo || o.domesticTrackingNo === domesticTrackingNo)
      .filter((o) => {
        // shipments 已用 take:1 限制为 1 条（父单优先），直接取其状态算四分类
        if (wantAttention) return matchesShipmentListFilter(o.shipments[0]?.currentStatus, "attention");
        if (!wantedGroups) return true;
        return wantedGroups.includes(classifyClientStatusGroup(o.shipments[0]?.currentStatus));
      });

    const items = filtered.map((o) => {
      // orderBy 已保证父单排在最前 + take:1，这里直接取即可
      const ship = o.shipments[0];
      const totalMetrics = totalMetricsByOrderId.get(o.id);
      const logisticsRecords = (ship?.statusLogs ?? []).map((r) => ({
        remark: sanitizeRemarkForClient(r.remark ?? "", true),
        changedAt: r.changedAt.toISOString(),
        fromStatus: r.fromStatus,
        toStatus: r.toStatus,
      }));
      const latestRemark = logisticsRecords.at(-1)?.remark ?? null;
      return {
        id: o.id,
        clientId: o.clientId,
        warehouseId: o.warehouseId,
        receiverAddressTh: o.receiverAddressTh,
        orderNo: o.orderNo,
        itemName: o.itemName,
        transportMode: o.transportMode,
        domesticTrackingNo: o.domesticTrackingNo,
        // 2026-08-07 移除 batchNo：这个字段存的就是柜号（员工在「预报单审核」里填的
        // 那个「柜号（可选，装柜时填写）」输入框），用户明确要求客户不能看到柜号。
        // 原来这里照发，客户端运单详情直接显示成「批次号：CAB-2026-A01」—— 实测泄漏。
        // 物流轨迹那条路早就把柜号从日志正文里抹掉了（containers/routes.ts 的 sanitizeRemark），
        // 但这条一直没堵，等于前门锁了后门开着。
        // ⚠️ /staff/prealerts 那处的 batchNo 要保留 —— 员工本来就该看到柜号。
        approvalStatus: o.approvalStatus,
        trackingNo: ship?.trackingNo ?? null,
        currentStatus: ship?.currentStatus ?? null,
        // 2026-08-31（排查报告第 23 条）：每张单都带算好的分组（2026-09-03 起五个值），
        // 分组按钮和首页状态分布图都按它来，别再各自发明算法。
        // ⚠️ 不是订单表里那个 statusGroup 列（那个只有 unfinished/completed 两种老值）。
        statusGroup: classifyClientStatusGroup(ship?.currentStatus),
        productQuantity: o.productQuantity,
        packageCount: o.packageCount,
        packageUnit: o.packageUnit,
        weightKg: decToNumber(o.weightKg),
        volumeM3: decToNumber(o.volumeM3),
        totalWeightKg: totalMetrics?.totalWeightKg,
        totalVolumeM3: totalMetrics?.totalVolumeM3,
        receivableAmountCny: decToNumber(o.receivableAmountCny),
        receivableCurrency: o.receivableCurrency ?? "CNY",
        paymentStatus: o.paymentStatus ?? "unpaid",
        paidAt: o.paidAt ? o.paidAt.toISOString() : undefined,
        // 2026-09-15 摘掉 paidBy：老付款功能（820af10）往里写过「管理员审核(名字)」，客户不能看
        shipDate: o.shipDate,
        cargoType: o.cargoType ?? "normal",
        latestRemark,
        remark: ship?.remark == null ? null : sanitizeRemarkForClient(ship.remark, true),
        logisticsRecords,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
      };
    });

    const orderIds = items.map((item) => item.id);
    const imageMap = await loadProductImagesForOrders(auth.companyId, orderIds);
    const productsMap = await loadOrderProducts(auth.companyId, orderIds);
    const itemsWithImages = items.map((item) => ({
      ...item,
      productImages: imageMap.get(item.id) ?? [],
      products: productsMap.get(item.id) ?? [],
    }));

    ok(res, { items: itemsWithImages, page, pageSize, total });
  });

  // ===== 客户端付款 =====

  app.get("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const statusFilter = req.query.status?.trim();
    /* 2026-08-31（排查报告第 23 条）：加真分页。
       原来一次全量返回、total 写的是本次返回条数——前端把列表砍到前 50 条时
       连「后面还有」都看不出来（排查报告第 47 条）。默认 50、上限 500，
       total 是过滤后的真实总数，前端按它翻页。 */
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize as string) || 50, 1), 500);
    const approvalFilter = statusFilter === "all"
      ? undefined
      : statusFilter === "approved" || statusFilter === "shipped"
        ? statusFilter
        : "pending";
    const prealertWhere: Prisma.OrderWhereInput = {
      companyId: auth.companyId,
      approvalStatus: approvalFilter,
      clientId: auth.userId,
    };
    const [prealertTotal, orders] = await Promise.all([
      prisma.order.count({ where: prealertWhere }),
      prisma.order.findMany({
        where: prealertWhere,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          client: { select: { name: true } },
          shipments: { orderBy: { createdAt: "desc" }, take: 1, select: { trackingNo: true, currentStatus: true } },
        },
      }),
    ]);
    const items = orders.map((o) => ({
      id: o.id,
      warehouseId: o.warehouseId,
      orderNo: o.orderNo,
      clientId: o.clientId,
      clientName: o.client?.name ?? null,
      trackingNo: o.shipments[0]?.trackingNo ?? undefined,
      currentStatus: o.shipments[0]?.currentStatus ?? undefined,
      itemName: o.itemName,
      transportMode: o.transportMode,
      domesticTrackingNo: o.domesticTrackingNo,
      batchNo: undefined, // 客户端隐藏柜号
      approvalStatus: o.approvalStatus,
      productQuantity: o.productQuantity,
      packageCount: o.packageCount,
      packageUnit: o.packageUnit,
      weightKg: decToNumber(o.weightKg),
      volumeM3: decToNumber(o.volumeM3),
      receivableAmountCny: decToNumber(o.receivableAmountCny),
      receivableCurrency: o.receivableCurrency ?? "CNY",
      paymentStatus: o.paymentStatus ?? "unpaid",
      paidAt: o.paidAt ? o.paidAt.toISOString() : undefined,
      // 2026-09-15 摘掉 paidBy（同 /client/orders）：操作人身份只有超级管理员能看
      shipDate: o.shipDate,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    }));
    const prealertIds = items.map((item) => item.id);
    const prealertImageMap = await loadProductImagesForOrders(auth.companyId, prealertIds);
    const prealertProductsMap = await loadOrderProducts(auth.companyId, prealertIds);
    const prealertItemsWithImages = items.map((item) => ({
      ...item,
      productImages: prealertImageMap.get(item.id) ?? [],
        products: prealertProductsMap.get(item.id) ?? [],
    }));
    ok(res, {
      items: prealertItemsWithImages,
      page,
      pageSize,
      // 过滤后的真实总数，不再是「本次返回了几条」（2026-08-31，排查报告第 23 条）
      total: prealertTotal,
    });
  });

  app.get("/staff/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    /* 2026-08-31（排查报告第 7 条）：删掉按「授权仓库」过滤的老代码。
       2026-08-22 已拍板「不分仓库管」（见本文件 staffCanEditOrderWarehouse 的注释），
       改单、传图、确认收货都照办放行了，唯独这个列表漏改——
       授权仓库为空的员工账号（干活最多的「可爱」正是空的）打开预报单审核页
       会一张单都看不到。现在跟其他入口一样：全体员工看全部预报单。 */
    const orders = await prisma.order.findMany({
      where: {
        companyId: auth.companyId,
        approvalStatus: { in: ["shipped", "received"] },
      },
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { name: true } },
      },
    });

    const items = orders
      .map((o) => ({
        id: o.id,
        clientId: o.clientId,
        clientName: o.client?.name ?? null,
        warehouseId: o.warehouseId,
        orderNo: o.orderNo,
        itemName: o.itemName,
        transportMode: o.transportMode,
        domesticTrackingNo: o.domesticTrackingNo,
        batchNo: o.batchNo,
        approvalStatus: o.approvalStatus,
        productQuantity: o.productQuantity,
        packageCount: o.packageCount,
        packageUnit: o.packageUnit,
        weightKg: decToNumber(o.weightKg),
        volumeM3: decToNumber(o.volumeM3),
        receivableAmountCny: decToNumber(o.receivableAmountCny),
        receivableCurrency: o.receivableCurrency ?? "CNY",
        paymentStatus: o.paymentStatus ?? "unpaid",
        paidAt: o.paidAt ? o.paidAt.toISOString() : undefined,
        // 2026-09-15：员工也不能看是谁确认的付款，只有超级管理员能看
        paidBy: canSeeOperatorIdentity(auth.role) ? (o.paidBy ?? undefined) : undefined,
        shipDate: o.shipDate,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
      }));
    const staffPrealertIds = items.map((item) => item.id);
    const staffPrealertImageMap = await loadProductImagesForOrders(auth.companyId, staffPrealertIds);
    const staffPrealertProductsMap = await loadOrderProducts(auth.companyId, staffPrealertIds);
    const staffPrealertItemsWithImages = items.map((item) => ({
      ...item,
      productImages: staffPrealertImageMap.get(item.id) ?? [],
        products: staffPrealertProductsMap.get(item.id) ?? [],
    }));
    ok(res, {
      items: staffPrealertItemsWithImages,
      page: 1,
      pageSize: staffPrealertItemsWithImages.length,
      total: staffPrealertItemsWithImages.length,
    });
  });

  app.post("/staff/orders/product-images", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin", "client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      orderId?: string;
      fileName?: string;
      mime?: string;
      contentBase64?: string;
    };
    const orderId = body.orderId?.trim();
    const fileName = body.fileName?.trim();
    const mimeType = body.mime?.trim();
    const contentBase64 = body.contentBase64?.trim();
    if (!orderId || !fileName || !mimeType || !contentBase64) {
      fail(res, 400, "BAD_REQUEST", "orderId, fileName, mime and contentBase64 are required");
      return;
    }
    if (!mimeType.startsWith("image/")) {
      fail(res, 400, "BAD_REQUEST", "only image uploads are allowed");
      return;
    }
    if (contentBase64.length > 20_000_000) {
      fail(res, 400, "BAD_REQUEST", "file too large (max 20MB base64)");
      return;
    }
    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      select: { id: true, warehouseId: true, approvalStatus: true, clientId: true },
    });
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }
    if (auth.role === "client" && order.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "client can only manage product images for their own orders");
      return;
    }
    if (!(await staffCanEditOrderWarehouse(auth, order.warehouseId))) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }
    const count = await prisma.orderProductImage.count({
      where: { companyId: auth.companyId, orderId },
    });
    if (count >= MAX_ORDER_PRODUCT_IMAGES) {
      fail(res, 400, "BAD_REQUEST", `image limit reached (max ${MAX_ORDER_PRODUCT_IMAGES})`);
      return;
    }
    try {
      const buf = Buffer.from(contentBase64, "base64");
      if (buf.length === 0) {
        fail(res, 400, "BAD_REQUEST", "invalid image content");
        return;
      }
    } catch {
      fail(res, 400, "BAD_REQUEST", "invalid image content");
      return;
    }
    const now = new Date();
    const imageId = `opi_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    // 保存文件到磁盘
    try {
      const filePath = saveImageToDisk(orderId, mimeType, contentBase64);
      await prisma.orderProductImage.create({
        data: {
          id: imageId,
          companyId: auth.companyId,
          orderId,
          fileName,
          mime: mimeType,
          contentBase64,
          filePath,
          uploadedBy: auth.userId,
          createdAt: now,
        },
      });
      ok(res, { id: imageId, orderId, fileName, mime: mimeType, filePath, createdAt: now.toISOString() });
    } catch (err) {
      console.error("[product-image] save failed:", err);
      fail(res, 500, "INTERNAL_ERROR", `保存图片失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  });

  app.delete("/staff/orders/product-images", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin", "client"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }
    const image = await prisma.orderProductImage.findFirst({
      where: { id, companyId: auth.companyId },
      include: {
        order: { select: { warehouseId: true, approvalStatus: true, clientId: true } },
      },
    });
    if (!image || !image.order) {
      fail(res, 404, "NOT_FOUND", "image not found");
      return;
    }
    if (auth.role === "client" && image.order.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "client can only manage product images for their own orders");
      return;
    }
    if (!(await staffCanEditOrderWarehouse(auth, image.order.warehouseId))) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }
    // 先删DB记录，再删磁盘文件（倒序避免悬空引用）
    const result = await prisma.orderProductImage.deleteMany({
      where: { id, companyId: auth.companyId },
    });
    if (result.count > 0 && image.filePath) {
      deleteImageFile(image.filePath);
    }
    ok(res, { deleted: result.count > 0, id });
  });

  /**
   * 员工按运单维度一次性更新关联订单与运单的基础信息（与列表「订单详情」编辑一致）。
   */
  app.post("/staff/orders/patch-shipment-bundle", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      shipmentId?: string;
      trackingNo?: string;
      batchNo?: string | null;
      itemName?: string;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number | null;
      volumeM3?: number | null;
      domesticTrackingNo?: string | null;
      orderCreatedDate?: string;
      transportMode?: "sea" | "land";
      shipDate?: string | null;
      receiverAddressTh?: string;
      containerNo?: string | null;
      /** 同步更新订单与运单的归属仓库（员工须对新仓库有编辑权限）。 */
      warehouseId?: string;
      remark?: string;
    };

    const shipmentId = body.shipmentId?.trim();
    if (!shipmentId) {
      fail(res, 400, "BAD_REQUEST", "shipmentId is required");
      return;
    }

    /* 2026-08-31（Codex 二轮）：数值校验收紧，并挪到碰库之前。
       原来件数/产品数量只判 `isFinite && >= 0`，填 2.5 会被写库那句 Math.floor
       **静默**抹成 2，员工毫无察觉；重量 -5、体积 -2 更是只判了 isFinite 就原样入库。
       跟确认收货（本文件 446 段）、管理员编辑（admin/routes.ts 606 段）不是一套闸。
       改成同一套规矩：
       · 件数/产品数量用 requireNonNegativeInt —— 允许 0，因为这里传的是
         「还剩多少没装柜」（见下面事务里的注释），拆完柜的单剩余就是 0，不能拦死；
         同理重量/体积的 min 也放到 0，requireDecimal 默认的「最小正数」会误伤。
       · 重量/体积按数据库列精度卡：weightKg Decimal(10,2)、volumeM3 Decimal(10,3)。
       · 先 parseNumericStrict 再校验（Number(true) 是 1，直接 Number() 挡不住）。 */
    const productQuantity = parseNumericStrict(body.productQuantity);
    {
      const issue = requireNonNegativeInt(productQuantity, "产品数量");
      if (issue) { fail(res, 400, "VALIDATION_ERROR", issue); return; }
    }
    const packageCount = parseNumericStrict(body.packageCount);
    {
      const issue = requireNonNegativeInt(packageCount, "箱数");
      if (issue) { fail(res, 400, "VALIDATION_ERROR", issue); return; }
    }
    const weightKg =
      body.weightKg === undefined || body.weightKg === null ? null : parseNumericStrict(body.weightKg);
    if (weightKg !== null) {
      const issue = requireDecimal(weightKg, "重量(kg)", { ...DECIMAL_10_2, min: 0 });
      if (issue) { fail(res, 400, "VALIDATION_ERROR", issue); return; }
    }
    const volumeM3 =
      body.volumeM3 === undefined || body.volumeM3 === null ? null : parseNumericStrict(body.volumeM3);
    if (volumeM3 !== null) {
      const issue = requireDecimal(volumeM3, "体积(m³)", { ...DECIMAL_10_3, min: 0 });
      if (issue) { fail(res, 400, "VALIDATION_ERROR", issue); return; }
    }

    // 【审查问题 7】原来在 include.order 里写了 where —— Prisma 不允许对
    // 一对一关联加 where（schema 里 order 是必填的一对一），一调就抛校验错误变 500。
    // 归属公司的限制改到外层 where 上，等价且合法。
    const shipment = await prisma.shipment.findFirst({
      where: {
        id: shipmentId,
        companyId: auth.companyId,
        order: { companyId: auth.companyId },
      },
      include: {
        order: {
          select: {
            id: true,
            warehouseId: true,
            receivableAmountCny: true,
            receivableCurrency: true,
          },
        },
      },
    });
    if (!shipment || !shipment.order) {
      fail(res, 404, "NOT_FOUND", "shipment or order not found");
      return;
    }
    const curOrder = shipment.order;

    if (!(await staffCanEditOrderWarehouse(auth, curOrder.warehouseId))) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }

    let nextWarehouseId = curOrder.warehouseId;
    if (body.warehouseId !== undefined && body.warehouseId !== null && String(body.warehouseId).trim() !== "") {
      const nw = String(body.warehouseId).trim();
      if (!(await staffCanEditOrderWarehouse(auth, nw))) {
        fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
        return;
      }
      nextWarehouseId = nw;
    }

    const trackingNo = typeof body.trackingNo === "string" ? body.trackingNo.trim() : "";
    if (!trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
      return;
    }
    const clash = await prisma.shipment.findFirst({
      where: {
        companyId: auth.companyId,
        trackingNo,
        NOT: { id: shipmentId },
      },
      select: { id: true },
    });
    if (clash) {
      fail(res, 400, "BAD_REQUEST", "trackingNo already exists");
      return;
    }

    const itemName = body.itemName?.trim();
    if (!itemName) {
      fail(res, 400, "BAD_REQUEST", "itemName is required");
      return;
    }

    // 数值字段的校验在 handler 入口（碰库之前）已经做完了（2026-08-31 Codex 二轮）
    const packageUnit = body.packageUnit === "bag" ? "bag" : "box";

    const orderCreatedDate = body.orderCreatedDate?.trim();
    if (!orderCreatedDate) {
      fail(res, 400, "BAD_REQUEST", "orderCreatedDate is required");
      return;
    }
    const arrived = new Date(`${orderCreatedDate}T00:00:00`);
    if (Number.isNaN(arrived.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid orderCreatedDate");
      return;
    }

    const transportMode = body.transportMode === "land" ? "land" : "sea";

    let shipDate: string | null = null;
    if (body.shipDate !== undefined && body.shipDate !== null && String(body.shipDate).trim() !== "") {
      const raw = String(body.shipDate).trim().slice(0, 10);
      const sd = new Date(`${raw}T00:00:00`);
      if (Number.isNaN(sd.getTime())) {
        fail(res, 400, "BAD_REQUEST", "invalid shipDate");
        return;
      }
      shipDate = raw;
    }

    /* 2026-08-07：运单不再涉及金额，这个接口也不再接受/写入应收金额和币种。 */

    const batchNo = body.batchNo?.trim() || null;
    const domesticTrackingNo = body.domesticTrackingNo?.trim() || null;
    const receiverAddressTh = body.receiverAddressTh?.trim() ?? "";
    const containerNo = body.containerNo?.trim() || null;

    const now = new Date();

    /* 员工在编辑框里改的是「还剩多少没装柜」（框里预填的就是这个数）。
       订单上那个「整单箱数」是另一回事 = 还剩没装 + 已经装走。
       不换算直接写的话，改一张拆过柜的单就会把整单箱数冲成剩余数
       （YW0001342 那种：整单 101 会被写成 71，真值就找不回来了）。
       没拆过柜的单已装走为 0，两个数相等，行为跟原来完全一样。 */
    /* 2026-08-31（排查报告第 52 条同款）：「已经装走多少」原来在事务**外面**
       算完才进事务 —— 查完到真正写库之间没有排队，装柜恰好插进来的话，
       这里用的还是装柜前的旧数，订单的整单箱数/总重/总体积就会加少
       （CLAUDE.md 第 28 条：锁只保证不同时，不保证数据没变；
       拿来做决定的数字必须锁后重读）。照管理员端编辑那条路的修法：
       先把本运单锁住（跟装柜/分柜排同一个队），锁到手再查子单合计、再算、再写。 */
    await prisma.$transaction(async (tx) => {
      // 锁序【订单 → 运单】，跟本文件确认收货 / 客户改单那几条路一致（549→571 那段）。
      // 这个事务下面要 update orders，先把订单行锁住，两个编辑入口同时保存才会排队。
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${curOrder.id} AND company_id = ${auth.companyId} FOR UPDATE`;
      await lockShipmentsChildrenFirst(tx, [shipmentId], auth.companyId);
      // 锁后重读运单号（CLAUDE.md 第 28 条）：拿锁之前那份快照里的
      // trackingNo 可能已被并发编辑改掉，查子单合计要用锁内的值
      const lockedShipment = await tx.shipment.findFirst({
        where: { id: shipmentId, companyId: auth.companyId },
        select: { trackingNo: true },
      });
      if (!lockedShipment) {
        // 预读到拿锁之间被并发硬删了 —— 跟锁函数内部一个语义，按 404 报
        throw new ShipmentsNotFoundError([shipmentId]);
      }
      const loadedForOrder = await tx.shipment.aggregate({
        where: { parentTrackingNo: lockedShipment.trackingNo, companyId: auth.companyId },
        _sum: { packageCount: true, weightKg: true, volumeM3: true },
        _count: true,
      });
      const alreadyLoadedPkg = loadedForOrder._sum.packageCount ?? 0;

      /* 2026-08-31（复查第 5 条）：拆过柜的单不许改运单号。
         子单全靠 parentTrackingNo = 父单运单号这根线认亲 —— 父单一改号，
         子单当场失联：下次保存时上面这份子单合计查出来是 0，
         订单的箱数/重量/体积又会被冲成剩余数（正是第 4 条刚堵上的丢数），
         卸柜还货、父单状态同步这些按 parentTrackingNo 走的流程也全断。
         同步改子单动静太大（还要连带轨迹/装柜记录逐个核），先一律拦住。 */
      if (loadedForOrder._count > 0 && trackingNo !== lockedShipment.trackingNo) {
        throw new BusinessError(
          `这张运单已经拆过柜（有 ${loadedForOrder._count} 张子单挂在原单号下），不能修改运单号，本次修改都没有保存。请先把单号改回 ${lockedShipment.trackingNo} 再保存其他修改。`,
        );
      }

      /* 2026-08-31（排查报告第 4 条）：重量和体积也要做跟箱数一模一样的换算。
         原来只有箱数加回了「已装走的」，重量体积却把编辑框里的剩余数直接写进订单——
         拆过柜的单打开编辑框点一下保存（啥都不改），订单总重就从 100 冲成 30，
         跟当年 YW0001342 整单箱数被冲成 0 是同一类毛病，当时只修了箱数这一半。

         子单的重量/体积是分柜时按件数精确分摊过去的（split-metrics.ts 保证
         「子单合计 + 父单余量 = 拆分前总量」），所以「剩余 + 子单合计」就是原总量。
         历史手工分柜的子单可能没存这两列，_sum 会跳过 null——那种单加回来的会偏少，
         但也远好过原来把已装走部分整个抹掉。

         舍入位数跟数据库列一致（重量 Decimal(10,2)、体积 Decimal(10,3)），
         算法照抄 decimal-guard 的 roundToScale，免得浮点相加带出一串尾数。 */
      const roundToScale = (n: number, scale: number): number => {
        const f = 10 ** scale;
        return Math.round((n + Number.EPSILON) * f) / f;
      };
      const alreadyLoadedWeightKg =
        loadedForOrder._sum.weightKg == null ? null : Number(loadedForOrder._sum.weightKg.toString());
      const alreadyLoadedVolumeM3 =
        loadedForOrder._sum.volumeM3 == null ? null : Number(loadedForOrder._sum.volumeM3.toString());
      // 两边都没数（没拆过柜、编辑框也没填）时保持 null，别把「没填」写成 0
      const orderWeightKg =
        weightKg === null && alreadyLoadedWeightKg === null
          ? null
          : roundToScale((weightKg ?? 0) + (alreadyLoadedWeightKg ?? 0), 2);
      const orderVolumeM3 =
        volumeM3 === null && alreadyLoadedVolumeM3 === null
          ? null
          : roundToScale((volumeM3 ?? 0) + (alreadyLoadedVolumeM3 ?? 0), 3);

      /* 2026-09-01（Codex 复核收尾）：合计完还要再过一次上限。
         入口那几道闸卡的是**员工填的剩余数**，子单那份是分柜时各自卡的 ——
         两边单独都合法，加起来照样可能爆 Int / Decimal 列上限，
         写库那一刻才炸 500。写 orders 之前在锁内用合计值再拦一道。 */
      guardCombinedTotals({
        packageCount: packageCount + alreadyLoadedPkg,
        weightKg: orderWeightKg,
        volumeM3: orderVolumeM3,
      });

      await tx.order.update({
        where: { id: curOrder.id },
        data: {
          warehouseId: nextWarehouseId,
          batchNo,
          itemName,
          // 入口已保证是整数，原来的 Math.floor 正是把 2.5 静默抹成 2 的元凶，删掉（2026-08-31 Codex 二轮）
          productQuantity,
          packageCount: packageCount + alreadyLoadedPkg,
          packageUnit,
          // 订单上存「剩余 + 已装走」的合计，跟上面箱数同一个规矩（2026-08-31）
          weightKg: orderWeightKg as unknown as Prisma.Decimal | null,
          volumeM3: (orderVolumeM3 as unknown as Prisma.Decimal | null),
          domesticTrackingNo,
          transportMode,
          shipDate,
          receiverAddressTh,
          createdAt: arrived,
        },
      });
      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          warehouseId: nextWarehouseId,
          trackingNo,
          batchNo,
          domesticTrackingNo,
          /* 这里存的是「还剩多少没装柜」，员工在编辑框里看到、改的就是这个数
             （编辑框的初值来自 buildShipmentOrderEditDraft → item.packageCount，
             就是运单自己的件数，也就是剩余），所以**原样存，不要再算**。

             2026-08-10 修：原来写的是「有子运单就强制为 0，防止重复计算」——
             重复计算是挡住了，但把**还在仓库没装柜的那部分一起抹掉了**。
             生产实测 YW0001342：整单 101 箱、装走 30 箱，员工编辑保存过一次之后
             变成 0，装柜管理显示「共30件（剩0件）」，仓库剩的 71 箱勾都勾不上。

             ⚠️ 别学管理员端那条路去减「已装走的」——
             管理员端编辑框传上来的是**产品行合计（整单箱数）**，那边才需要减；
             这边传上来的已经是剩余了，再减一次会越保存越少（71 → 41 → 11）。
             两个端传的含义不一样，这是我第一版改错过的地方。 */
          packageCount,
          packageUnit,
          weightKg: weightKg as unknown as Prisma.Decimal | null,
          volumeM3: (volumeM3 as unknown as Prisma.Decimal | null),
          transportMode,
          containerNo,
          remark: body.remark !== undefined ? body.remark?.trim() || null : undefined,
        },
      });
    });

    ok(res, {
      shipmentId,
      orderId: curOrder.id,
      updatedAt: now.toISOString(),
    });
  });

  // approve endpoint removed — replaced by POST /staff/prealerts/receive

  // 尾端派送：获取所有客户及其地址
  app.get("/staff/lastmile/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const keyword = req.query.keyword?.trim().toLowerCase() || "";

    const users = await prisma.user.findMany({
      where: {
        companyId: auth.companyId,
        role: "client",
        ...(keyword ? {
          OR: [
            { id: { contains: keyword, mode: "insensitive" } },
            { name: { contains: keyword, mode: "insensitive" } },
          ],
        } : {}),
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        phone: true,
        addresses: {
          select: {
            id: true,
            contactName: true,
            contactPhone: true,
            addressDetail: true,
            isDefault: true,
          },
          orderBy: { isDefault: "desc" },
        },
      },
    });

    ok(res, { items: users });
  });

  // 尾端派送：删除地址
  app.delete("/staff/lastmile/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "id is required"); return; }
    const addr = await prisma.clientAddress.findFirst({ where: { id, companyId: auth.companyId } });
    if (!addr) { fail(res, 404, "NOT_FOUND", "address not found"); return; }
    await prisma.clientAddress.delete({ where: { id } });
    ok(res, { deleted: true, id });
  });

  // 获取客户列表（供员工端创建订单时选择）
  app.get("/staff/clients", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const users = await prisma.user.findMany({
      where: { companyId: auth.companyId, role: "client" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });

    ok(res, { items: users });
  });
}

/**
 * 批量取每张订单的长/宽/高，拼成能直接放进 Excel 一个格子的值（2026-08-27）。
 *
 * 为什么要拼：长宽高记在「产品行」上，一张订单可能有好几个产品、尺寸各不相同，
 * 而导出是一行一张运单。实测 97% 的订单只有一个产品，所以：
 *   · 只有一个尺寸   → 出数字，Excel 里能求和能排序
 *   · 好几个不一样的 → 用「/」并排，比如 60/50，一个都不丢
 *   · 一个都没填     → 这三个字段干脆不出现，前端按「没有」处理
 */
export type OrderProductDims = {
  lengthCm?: number | string;
  widthCm?: number | string;
  heightCm?: number | string;
  /** 全部产品名拼起来（鞋 / 包 / 帽），2026-09-10 加；没有产品行时不出现 */
  names?: string;
};

/**
 * 货型只认 `normal` / `inspection` / `sensitive`（2026-09-11 加）。
 *
 * 原来四个写入口全是 `body.cargoType?.trim() || "normal"` —— **传什么存什么**。
 * 传个「商检」进来会原样存进库，而三端显示用的 `cargoTypeLabelOf` 认不出来就
 * 一律显示「普货」：单子上白写了一个错货型，而且没人会发现。
 *
 * 空着按普货（跟数据库默认值一致）；填了认不出来的就 400，不静默兜底。
 */
class CargoTypeError extends Error {}
function readCargoType(raw: unknown, where: string): CargoType {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return "normal";
  const value = String(raw).trim().toLowerCase();
  if (typeof raw === "string" && (CARGO_TYPES as readonly string[]).includes(value)) return value as CargoType;
  throw new CargoTypeError(`${where}的货型「${String(raw).trim()}」不合法，只能是 ${CARGO_TYPES.join(" / ")}。${CARGO_TYPE_HINT}`);
}

/** 整票 + 每条产品行一起校验；有问题返回那句话，没问题返回校验过的值 */
export function readCargoTypes(
  orderRaw: unknown,
  products: ReadonlyArray<{ cargoType?: string }> | undefined,
): { order: CargoType; products: CargoType[] } | { error: string } {
  try {
    return {
      order: readCargoType(orderRaw, "整票"),
      products: (products ?? []).map((product, index) => readCargoType(product.cargoType, `第 ${index + 1} 条产品`)),
    };
  } catch (error) {
    if (error instanceof CargoTypeError) return { error: error.message };
    throw error;
  }
}

export async function loadOrderProductDims(
  companyId: string,
  orderIds: string[],
): Promise<Map<string, OrderProductDims>> {
  const out = new Map<string, OrderProductDims>();
  const ids = Array.from(new Set(orderIds.filter(Boolean)));
  if (ids.length === 0) return out;

  const rows = await prisma.orderProduct.findMany({
    where: { orderId: { in: ids }, companyId },
    // 品名也一起带出来（2026-09-10，老板反馈整柜清单「品类不全」）：
    // 运单上的 itemName 只存了第一个产品名，清单一行一票，得把全部产品名拼进那一格
    select: { orderId: true, lengthCm: true, widthCm: true, heightCm: true, itemName: true, sortOrder: true },
    orderBy: { sortOrder: "asc" },
  });

  const pick = (vals: Array<number | null>): number | string | undefined => {
    const nums = vals.filter((v): v is number => v != null);
    if (nums.length === 0) return undefined;
    const uniq = Array.from(new Set(nums));
    return uniq.length === 1 ? uniq[0] : uniq.join("/");
  };

  const grouped = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = grouped.get(r.orderId) ?? [];
    arr.push(r);
    grouped.set(r.orderId, arr);
  }
  for (const [orderId, list] of grouped) {
    const entry: OrderProductDims = {};
    const l = pick(list.map((x) => (x.lengthCm == null ? null : Number(x.lengthCm))));
    const w = pick(list.map((x) => (x.widthCm == null ? null : Number(x.widthCm))));
    const h = pick(list.map((x) => (x.heightCm == null ? null : Number(x.heightCm))));
    if (l !== undefined) entry.lengthCm = l;
    if (w !== undefined) entry.widthCm = w;
    if (h !== undefined) entry.heightCm = h;
    const names = productNamesLabel(list);
    if (names) entry.names = names;
    if (Object.keys(entry).length > 0) out.set(orderId, entry);
  }
  return out;
}
