/**
 * 整柜管理（2026-09-23 老板拍板新增）
 *
 * ⚠️ 接口路径必须比页面路径**深一层**（`/staff/fcl-containers/create`，不是
 * `/staff/fcl-containers`）—— next.config.ts 的 rewrite 是「页面匹配不上才转发给接口」，
 * 而 `/staff/fcl-containers` 本身就是一个页面，同名接口会被页面吃掉：
 * 请求照样回 200，但回的是 HTML，前端报一句看不懂的「invalid response」
 * （CLAUDE.md 第 5 条那个坑，2026-09-23 浏览器实测撞到）。
 * 集货那边也是这个规矩：页面 /staff/consolidation，接口 /staff/consolidation/tasks。
 * ============================================================================
 *
 * 业务：客户自己包一整个柜发货，我们只负责**追踪**。钱线下谈，系统里只手填一个金额。
 *
 * 老板逐条定的规格（别自己改，要改先问）：
 *   ① 货物明细要记 —— 客户发货物清单表格过来，员工在「整柜管理」里传进系统
 *   ② 追踪用**海运 23 步 / 陆运 17 步**那套细的（不是集货那套 5 步）
 *   ③ 柜号**不给客户看**（沿用 2026-08-07「客户不能看到柜号」那条老规矩）
 *   ④ 整柜的货**不走仓库收货流程** —— 系统里没有来源，全靠客户那份清单
 *   ⑤ 运单号**手动填**（不自动生成）
 *   ⑥ 轨迹从**「已装柜」**起步（整柜进系统时本来就装好柜了）
 *   ⑦ 建单**要选仓库**，用现有那四个仓
 *   ⑧ 钱线下走，系统里手填一个金额，**客户能看到**
 *   ⑨ **只有员工 / 超管能建**，客户只能看
 *
 * 实现思路：整柜 = **一张运单 + 一个柜子**，两样都是现成的表。
 *   · 清单每一行 → 这张运单的产品行（order_products）
 *   · 柜子上打 isFcl 标记 → 「整柜管理」和客户端「我的整柜」按它筛
 *   · 建完之后**完全交给现有的柜子那套机器**：员工推柜子状态 → 自动给这票货写轨迹
 *     （见 containers/routes.ts 的 /admin/containers/status）
 *
 * ⚠️ 数据库只加了 containers.is_fcl 这一列，别的表一个字段都没动。
 */
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { BusinessError } from "../core/business-error";
import { hideOperatorIdentity, operatorNameForDisplay } from "../core/operator-visibility";
import { DECIMAL_12_2, requireDecimal } from "../core/decimal-guard";
import { parseNumericStrict } from "../core/int-guard";
import {
  CONTAINER_TYPES,
  FCL_START_CONTAINER_STATUS,
  FCL_START_SHIPMENT_STATUS,
  parseFclProductRow,
  strictestCargoType,
  sumFclRows,
  type FclProductInput,
  type FclProductRow,
} from "./product-rows";

/** 内部端（员工 / 超管）看到的一个整柜 */
function formatFclForStaff(container: any, shipment: any) {
  return {
    containerId: container.id,
    containerNo: container.containerNo,
    containerType: container.containerType,
    transportMode: container.transportMode,
    containerStatus: container.currentStatus,
    loadingDate: container.loadingDate instanceof Date ? container.loadingDate.toISOString() : container.loadingDate ?? null,
    departureDate: container.departureDate instanceof Date ? container.departureDate.toISOString() : container.departureDate ?? null,
    eta: container.eta instanceof Date ? container.eta.toISOString() : container.eta ?? null,
    ata: container.ata instanceof Date ? container.ata.toISOString() : container.ata ?? null,
    remark: container.remark ?? null,
    createdAt: container.createdAt instanceof Date ? container.createdAt.toISOString() : container.createdAt,
    shipmentId: shipment?.id ?? null,
    trackingNo: shipment?.trackingNo ?? null,
    clientId: shipment?.order?.clientId ?? null,
    warehouseId: shipment?.warehouseId ?? null,
    shipmentStatus: shipment?.currentStatus ?? null,
    itemName: shipment?.order?.itemName ?? null,
    packageCount: shipment?.packageCount ?? null,
    weightKg: shipment?.weightKg == null ? null : Number(shipment.weightKg),
    volumeM3: shipment?.volumeM3 == null ? null : Number(shipment.volumeM3),
    amountCny: shipment?.order?.receivableAmountCny == null ? null : Number(shipment.order.receivableAmountCny),
  };
}

/**
 * 客户看到的一个整柜。
 *
 * ⚠️ **不许带柜号**（老板 2026-08-07 定，整柜 2026-09-23 复述过一遍）。
 * 这里用「挑着给」而不是「摘掉几个」——照抄普通版集货那次的教训（CLAUDE.md 第 31 条）：
 * `...container` 展开整行等于「表里加什么字段就漏什么字段」，
 * 以后谁给柜子加个内部字段，客户那边自动就看见了。
 */
function formatFclForClient(container: any, shipment: any) {
  return {
    containerId: container.id,
    containerType: container.containerType,
    transportMode: container.transportMode,
    loadingDate: container.loadingDate instanceof Date ? container.loadingDate.toISOString() : container.loadingDate ?? null,
    createdAt: container.createdAt instanceof Date ? container.createdAt.toISOString() : container.createdAt,
    shipmentId: shipment?.id ?? null,
    trackingNo: shipment?.trackingNo ?? null,
    shipmentStatus: shipment?.currentStatus ?? null,
    itemName: shipment?.order?.itemName ?? null,
    packageCount: shipment?.packageCount ?? null,
    weightKg: shipment?.weightKg == null ? null : Number(shipment.weightKg),
    volumeM3: shipment?.volumeM3 == null ? null : Number(shipment.volumeM3),
    // 老板 2026-09-23：这笔钱线下走，但客户能看到（只在整柜这边显示，普通运单照旧不显示）
    amountCny: shipment?.order?.receivableAmountCny == null ? null : Number(shipment.order.receivableAmountCny),
  };
}

function formatProductRow(p: any) {
  return {
    id: p.id,
    itemName: p.itemName,
    packageCount: p.packageCount,
    productQuantity: p.productQuantity ?? null,
    lengthCm: p.lengthCm ?? null,
    widthCm: p.widthCm ?? null,
    heightCm: p.heightCm ?? null,
    weightKg: p.weightKg ?? null,
    domesticTrackingNo: p.domesticTrackingNo ?? null,
    cargoType: p.cargoType ?? "normal",
    sortOrder: p.sortOrder ?? 0,
  };
}

/**
 * 建整柜的排队锁（2026-09-23）。
 *
 * 这个事务是典型的「先读一个值 → 拿它做决定 → 再写」：先查柜号 / 运单号重不重，
 * 不重才建。可柜号那一行这时候还**不存在**，行锁锁不到 ——
 * 所以跟集货取号（83001/83002）、仓库版取号（83011）、客户长期价（83020）一样，
 * 用**咨询锁**让同一时刻的建整柜请求排队。
 *
 * 83030 这个号只有这一处在用，不会跟别的路互相等。整柜一天也就几个，排队不影响谁。
 * ⚠️ 必须是这个事务里的**第一句**，排在所有写语句前面（scripts/test-lock-order.ts 第 1 项）。
 */
async function lockFclCreate(tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(83030)`;
}

export function registerFclContainerRoutes(app: MinimalHttpApp): void {
  // ==========================================================================
  // 员工 / 超管：建整柜
  // ==========================================================================
  app.post("/staff/fcl-containers/create", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      clientId?: string;
      trackingNo?: string;
      containerNo?: string;
      containerType?: string;
      transportMode?: string;
      warehouseId?: string;
      loadingDate?: string;
      amountCny?: number | string;
      remark?: string;
      products?: FclProductInput[];
    };

    const clientId = String(body.clientId ?? "").trim();
    const trackingNo = String(body.trackingNo ?? "").trim();
    const containerNo = String(body.containerNo ?? "").trim();
    const containerType = String(body.containerType ?? "").trim();
    const transportMode = String(body.transportMode ?? "").trim();
    const warehouseId = String(body.warehouseId ?? "").trim();

    if (!clientId) { fail(res, 400, "BAD_REQUEST", "请选择客户唛头"); return; }
    // 老板 2026-09-23：运单号手动填，不自动生成
    if (!trackingNo) { fail(res, 400, "BAD_REQUEST", "运单号为必填（整柜的运单号是手填的）"); return; }
    if (!containerNo) { fail(res, 400, "BAD_REQUEST", "柜号为必填"); return; }
    if (!CONTAINER_TYPES.includes(containerType)) { fail(res, 400, "BAD_REQUEST", "柜型只能是 20GP 或 40HQ"); return; }
    /* ⚠️ 运输方式必填而且只能是 sea / land（照抄建柜接口 2026-08-27 补的那道）：
       它决定这个柜走海运 23 步还是陆运 17 步，空着会被默认当海运，
       陆运柜推「过境越南」会被拒。 */
    if (transportMode !== "sea" && transportMode !== "land") {
      fail(res, 400, "BAD_REQUEST", "请选择运输方式：海运或陆运");
      return;
    }
    // 老板 2026-09-23：整柜也要选仓库，用现有那四个仓
    if (!warehouseId) { fail(res, 400, "BAD_REQUEST", "请选择仓库"); return; }

    const productsInput = Array.isArray(body.products) ? body.products : [];
    if (productsInput.length === 0) { fail(res, 400, "BAD_REQUEST", "货物清单至少要有一行"); return; }
    if (productsInput.length > 500) { fail(res, 400, "BAD_REQUEST", "一个柜的货物清单最多 500 行，请分开录"); return; }

    // 先把清单逐行算清楚（碰数据库之前，跟集货那边同一个规矩）
    const rows: FclProductRow[] = [];
    for (let i = 0; i < productsInput.length; i++) {
      const parsed = parseFclProductRow(productsInput[i], i);
      if ("error" in parsed) { fail(res, 400, "BAD_REQUEST", parsed.error); return; }
      rows.push(parsed.row);
    }
    const totals = sumFclRows(rows);
    if ("error" in totals) { fail(res, 400, "BAD_REQUEST", totals.error); return; }

    // 金额：老板说线下走，系统里手填一个数；不填就空着
    let amountCny: number | null = null;
    if (body.amountCny !== undefined && body.amountCny !== null && String(body.amountCny).trim() !== "") {
      const n = parseNumericStrict(body.amountCny);
      const issue = requireDecimal(n, "金额", { ...DECIMAL_12_2, min: 0 });
      if (issue) { fail(res, 400, "BAD_REQUEST", issue); return; }
      amountCny = n;
    }

    let loadingDate: Date | null = null;
    if (body.loadingDate?.trim()) {
      const d = new Date(body.loadingDate.trim());
      if (Number.isNaN(d.getTime())) { fail(res, 400, "BAD_REQUEST", "装柜日期不是有效日期，请写成 2026-09-23 这种格式"); return; }
      loadingDate = d;
    }

    // 客户必须是本公司的 client（跟员工建单那条路同一句提示）
    const client = await prisma.user.findFirst({
      where: { id: clientId, companyId: auth.companyId, role: "client" },
      select: { id: true },
    });
    if (!client) { fail(res, 400, "BAD_REQUEST", "唛头不存在或不属于当前公司，请核对客户唛头"); return; }

    const orderId = `o_fcl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const shipmentId = `s_fcl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date();
    /* 「已装柜」这一步的时间：填了装柜日期就用它，没填才退到录入时刻。
       ⚠️ 用录入时刻是错的 —— 整柜都是装完柜之后才录进系统的，
       拿录入时刻当装柜时间，客户轨迹里会看到「开船比装柜还早」这种自相矛盾的排序
       （2026-09-23 浏览器实测撞到：装柜日期填 9-20，轨迹却写成录入那天 9-23）。
       口径跟柜子那边一致：装柜时间取柜子日期（见「轨迹时间是回填的」那条）。 */
    const sealedAt = loadingDate ?? now;
    const itemNameSummary = rows.length === 1 ? rows[0].itemName : `${rows[0].itemName} 等 ${rows.length} 项`;

    /* BusinessError 直接往外抛：server.ts 那层会按它的 httpStatus / code 回给前端。
       这里只额外接一下 P2002（撞唯一约束）——
       两个员工同时录同一个柜号 / 运单号时，两边的查重都说「没重复」，
       后提交的那个会被数据库拦住。数据是对的，但不接的话前端看到的是
       一句看不懂的「服务器错误」，员工不知道该改什么（CLAUDE.md 第 17 条的教训）。 */
    try {
      const created = await prisma.$transaction(async (tx) => {
        // 排队锁排在所有写语句前面（说明见 lockFclCreate）
        await lockFclCreate(tx);

        /* 查重在锁里做（CLAUDE.md 第 17、28 条）：
           没有上面那把锁的话，两个员工同时录同一个柜号，事务外面查都说「没重复」，
           进来各插一条，后一个撞唯一约束报的是看不懂的「服务器错误」。 */
        const dupContainer = await tx.container.findUnique({ where: { containerNo }, select: { id: true } });
        if (dupContainer) throw new BusinessError(`柜号 ${containerNo} 已存在，请核对`, 409, "VALIDATION_ERROR");
        const dupShipment = await tx.shipment.findUnique({ where: { trackingNo }, select: { id: true } });
        if (dupShipment) throw new BusinessError(`运单号 ${trackingNo} 已存在，请换一个`, 409, "VALIDATION_ERROR");

        await tx.order.create({
          data: {
            id: orderId,
            companyId: auth.companyId,
            clientId,
            warehouseId,
            batchNo: null,
            orderNo: null,
            approvalStatus: "approved",
            itemName: itemNameSummary,
            productQuantity: totals.productQuantity,
            packageCount: totals.packageCount,
            packageUnit: "box",
            weightKg: totals.weightKg as any,
            volumeM3: totals.volumeM3 as any,
            // 老板 2026-09-23：钱线下走，这里只记一个手填的数；系统只用人民币
            receivableAmountCny: amountCny as any,
            receivableCurrency: "CNY",
            shipDate: loadingDate ? loadingDate.toISOString().slice(0, 10) : null,
            domesticTrackingNo: null,
            transportMode,
            cargoType: strictestCargoType(rows.map((r) => r.cargoType)),
            receiverNameTh: "",
            receiverPhoneTh: "",
            receiverAddressTh: "",
            statusGroup: "unfinished",
          },
        });

        await tx.orderProduct.createMany({
          data: rows.map((r) => ({
            companyId: auth.companyId,
            orderId,
            itemName: r.itemName,
            packageCount: r.packageCount,
            lengthCm: r.lengthCm,
            widthCm: r.widthCm,
            heightCm: r.heightCm,
            productQuantity: r.quantityPerBox,
            cargoType: r.cargoType,
            domesticTrackingNo: r.domesticTrackingNo ?? "货拉拉",
            weightKg: r.weightKg,
            sortOrder: r.sortOrder,
          })),
        });

        await tx.shipment.create({
          data: {
            id: shipmentId,
            companyId: auth.companyId,
            orderId,
            trackingNo,
            batchNo: null,
            /* 老板 2026-09-23：整柜的轨迹从「已装柜」起步 ——
               整柜进系统的时候货本来就已经装好柜了，没有「到国内仓」这一段。 */
            currentStatus: FCL_START_SHIPMENT_STATUS,
            currentLocation: null,
            weightKg: totals.weightKg as any,
            volumeM3: totals.volumeM3 as any,
            packageCount: totals.packageCount,
            packageUnit: "box",
            transportMode,
            domesticTrackingNo: null,
            warehouseId,
            remark: body.remark?.trim() || null,
          },
        });

        await tx.statusLog.create({
          data: {
            id: `sl_fcl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            companyId: auth.companyId,
            shipmentId,
            operatorId: auth.userId,
            operatorRole: auth.role,
            operatorName: auth.name ?? "",
            fromStatus: "created",
            toStatus: FCL_START_SHIPMENT_STATUS,
            remark: "整柜已装柜",
            nextStop: transportMode === "land" ? "凭祥口岸" : "开船",
            changedAt: sealedAt,
          },
        });

        const container = await tx.container.create({
          data: {
            companyId: auth.companyId,
            containerNo,
            containerType,
            transportMode,
            isFcl: true,
            /* 柜子和运单必须落在对应的一对状态上（SEALED ⇄ loaded）。
               柜子留在 LOADING 的话，员工一推到「已封柜」就会给客户再写一条重复的「已装柜」。 */
            currentStatus: FCL_START_CONTAINER_STATUS,
            // statusDates 记「真的走过的那几步」，随柜补轨迹和撤销状态都要读它
            statusDates: JSON.stringify({ [FCL_START_CONTAINER_STATUS]: sealedAt.toISOString() }),
            sealedAt,
            loadingDate,
            warehouseId,
            remark: body.remark?.trim() || null,
          },
        });

        await tx.shipmentContainerItem.create({
          data: {
            id: `sci_fcl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            containerId: container.id,
            shipmentId,
            loadedVolumeM3: totals.volumeM3 as any,
            loadedPieceCount: totals.packageCount,
          },
        });

        return container;
      });

      ok(res, {
        containerId: created.id,
        containerNo: created.containerNo,
        shipmentId,
        trackingNo,
        rowCount: rows.length,
        packageCount: totals.packageCount,
        volumeM3: totals.volumeM3,
        weightKg: totals.weightKg,
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        const target = String(e?.meta?.target ?? "");
        const what = target.includes("tracking") ? `运单号 ${trackingNo}` : `柜号 ${containerNo}`;
        fail(res, 409, "VALIDATION_ERROR", `${what} 刚刚被别人录进去了，请核对后换一个`);
        return;
      }
      throw e;
    }
  });

  // ==========================================================================
  // 员工 / 超管：整柜列表
  // ==========================================================================
  app.get("/staff/fcl-containers/list", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const q = (req.query ?? {}) as { clientId?: string; containerNo?: string; trackingNo?: string; status?: string };
    const where: any = { companyId: auth.companyId, isFcl: true };
    if (q.containerNo?.trim()) where.containerNo = { contains: q.containerNo.trim() };
    if (q.status?.trim()) where.currentStatus = q.status.trim();

    const containers = await prisma.container.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        items: {
          include: {
            shipment: {
              include: { order: { select: { clientId: true, itemName: true, receivableAmountCny: true } } },
            },
          },
        },
      },
    });

    // 客户唛头 / 运单号的筛选在这里做：它们挂在柜里那张单上，写不进上面的 where
    const clientFilter = q.clientId?.trim().toLowerCase();
    const trackingFilter = q.trackingNo?.trim().toLowerCase();
    const rows = containers
      .map((c) => formatFclForStaff(c, c.items[0]?.shipment))
      .filter((r) => !clientFilter || (r.clientId ?? "").toLowerCase().includes(clientFilter))
      .filter((r) => !trackingFilter || (r.trackingNo ?? "").toLowerCase().includes(trackingFilter));

    ok(res, { items: rows, total: rows.length });
  });

  // ==========================================================================
  // 员工 / 超管：整柜详情（货物清单 + 轨迹）
  // ==========================================================================
  app.get("/staff/fcl-containers/detail", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const containerId = String((req.query as any)?.containerId ?? "").trim();
    if (!containerId) { fail(res, 400, "BAD_REQUEST", "containerId 为必填"); return; }

    const container = await prisma.container.findFirst({
      where: { id: containerId, companyId: auth.companyId, isFcl: true },
      include: {
        items: {
          include: {
            shipment: {
              include: {
                order: { select: { clientId: true, itemName: true, receivableAmountCny: true, products: { orderBy: { sortOrder: "asc" } } } },
                statusLogs: { orderBy: { changedAt: "asc" } },
              },
            },
          },
        },
      },
    });
    if (!container) { fail(res, 404, "NOT_FOUND", "整柜不存在"); return; }

    const shipment = container.items[0]?.shipment;
    ok(res, {
      ...formatFclForStaff(container, shipment),
      products: (shipment?.order?.products ?? []).map(formatProductRow),
      // 操作人身份只给超管看（2026-09-19 那条规矩，客户那步显示唛头）
      timeline: (shipment?.statusLogs ?? []).map((log: any) => hideOperatorIdentity({
        id: log.id,
        fromStatus: log.fromStatus,
        toStatus: log.toStatus,
        remark: log.remark,
        nextStop: log.nextStop,
        operatorName: operatorNameForDisplay(log),
        operatorId: log.operatorId,
        operatorRole: log.operatorRole,
        changedAt: log.changedAt instanceof Date ? log.changedAt.toISOString() : log.changedAt,
      }, auth.role)),
    });
  });

  // ==========================================================================
  // 客户：我的整柜（只读，看不到柜号）
  // ==========================================================================
  app.get("/client/fcl-containers/list", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const containers = await prisma.container.findMany({
      where: {
        companyId: auth.companyId,
        isFcl: true,
        // 只给这个客户自己的：柜里那张单的归属客户必须是他
        items: { some: { shipment: { order: { clientId: auth.userId } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        items: {
          include: {
            shipment: {
              include: { order: { select: { clientId: true, itemName: true, receivableAmountCny: true } } },
            },
          },
        },
      },
    });

    const rows = containers
      // 再兜一道：只留下那张单确实属于自己的（上面 some 是「柜里有一张是他的」）
      .filter((c) => c.items[0]?.shipment?.order?.clientId === auth.userId)
      .map((c) => formatFclForClient(c, c.items[0]?.shipment));

    ok(res, { items: rows, total: rows.length });
  });

  // ==========================================================================
  // 客户：我的整柜详情（货物清单 + 轨迹，没有柜号）
  // ==========================================================================
  app.get("/client/fcl-containers/detail", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const containerId = String((req.query as any)?.containerId ?? "").trim();
    if (!containerId) { fail(res, 400, "BAD_REQUEST", "containerId 为必填"); return; }

    const container = await prisma.container.findFirst({
      where: { id: containerId, companyId: auth.companyId, isFcl: true },
      include: {
        items: {
          include: {
            shipment: {
              include: {
                order: { select: { clientId: true, itemName: true, receivableAmountCny: true, products: { orderBy: { sortOrder: "asc" } } } },
                statusLogs: { orderBy: { changedAt: "asc" } },
              },
            },
          },
        },
      },
    });
    const shipment = container?.items[0]?.shipment;
    // 不是自己的整柜，一律当作不存在（别让客户从提示语里试出哪些 id 是真的）
    if (!container || shipment?.order?.clientId !== auth.userId) {
      fail(res, 404, "NOT_FOUND", "整柜不存在");
      return;
    }

    ok(res, {
      ...formatFclForClient(container, shipment),
      products: (shipment?.order?.products ?? []).map(formatProductRow),
      timeline: (shipment?.statusLogs ?? []).map((log: any) => hideOperatorIdentity({
        id: log.id,
        fromStatus: log.fromStatus,
        toStatus: log.toStatus,
        remark: log.remark,
        nextStop: log.nextStop,
        operatorName: operatorNameForDisplay(log),
        operatorId: log.operatorId,
        operatorRole: log.operatorRole,
        changedAt: log.changedAt instanceof Date ? log.changedAt.toISOString() : log.changedAt,
      }, "client")),
    });
  });
}
