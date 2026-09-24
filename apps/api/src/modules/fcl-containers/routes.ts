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
import { logger } from "../core/logger";
import { lockShipmentsChildrenFirst } from "../shipments/lock-shipments";
import { hideOperatorIdentity, hideOperatorInRemark, operatorNameForDisplay } from "../core/operator-visibility";
import { sanitizeRemarkForClient } from "../core/client-privacy";
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

/**
 * 仓库取值，跟运单那边一致（老板 2026-09-23：整柜也要选仓库，用现有那四个）。
 * ⚠️ 后端必须按名单卡（2026-09-23 复核抓到）：原来只判非空，
 * 直接调接口传任意字符串也能写进库，之后列表、导出、派送单上的仓库就是乱的。
 */
const WAREHOUSE_IDS = ["wh_yiwu_01", "wh_guangzhou_01", "wh_dongguan_01", "wh_shenzhen_01"];

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
    if (!trackingNo) { fail(res, 400, "BAD_REQUEST", "提单号为必填（整柜的提单号是手填的）"); return; }
    if (!containerNo) { fail(res, 400, "BAD_REQUEST", "柜号为必填"); return; }
    /* 提单号跟柜号不许填成同一个（2026-09-23 复核提的）：提单号客户看得到、柜号客户看不到，
       填成一样等于把柜号从提单号那一栏发出去了。 */
    if (trackingNo.toLowerCase() === containerNo.toLowerCase()) {
      fail(res, 400, "BAD_REQUEST", "提单号不能跟柜号填成同一个（柜号不能让客户看到）");
      return;
    }
    if (!CONTAINER_TYPES.includes(containerType)) { fail(res, 400, "BAD_REQUEST", "柜型只能是 20GP 或 40HQ"); return; }
    /* ⚠️ 运输方式必填而且只能是 sea / land（照抄建柜接口 2026-08-27 补的那道）：
       它决定这个柜走海运 23 步还是陆运 17 步，空着会被默认当海运，
       陆运柜推「过境越南」会被拒。 */
    if (transportMode !== "sea" && transportMode !== "land") {
      fail(res, 400, "BAD_REQUEST", "请选择运输方式：海运或陆运");
      return;
    }
    /* 老板 2026-09-23：整柜也要选仓库，用现有那四个仓。
       ⚠️ 只判非空不够（2026-09-23 复核抓到）：直接调接口传任意字符串也能写进库，
       之后运单列表、导出、派送单上的仓库名就都是空的或乱的。 */
    if (!WAREHOUSE_IDS.includes(warehouseId)) {
      fail(res, 400, "BAD_REQUEST", "请选择仓库（义乌 / 广州 / 东莞 / 深圳）");
      return;
    }

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
      /* 不许填未来（2026-09-23 复核抓到）：装柜日期就是「已装柜」那条轨迹的时间，
         填成未来的话，后面推开船、到港会排在它前面，客户看到的顺序是乱的。
         ⚠️ 界线放到「服务器明天」那一刻，不是「今天 23:59」（2026-09-23 第 2 轮复核抓到）：
         生产容器跑在 **UTC**（实查 `docker exec mywebsite-api-1 date` 是 UTC），
         而人在中国（UTC+8）和泰国（UTC+7）。当地凌晨那几个小时，员工选的「今天」
         按 UTC 算已经是明天了，会被一句「不能填未来」莫名其妙挡住。
         放宽一天，真正往后填好几天还是拦得住。 */
      const tomorrowEnd = new Date();
      tomorrowEnd.setUTCDate(tomorrowEnd.getUTCDate() + 1);
      tomorrowEnd.setUTCHours(23, 59, 59, 999);
      if (d.getTime() > tomorrowEnd.getTime()) {
        fail(res, 400, "BAD_REQUEST", "装柜日期不能填未来的日期");
        return;
      }
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
        if (dupShipment) throw new BusinessError(`提单号 ${trackingNo} 已存在，请换一个`, 409, "VALIDATION_ERROR");

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
            /* ⚠️ 这一列的语义是**单箱重**，不是整行总重（2026-09-23 复核抓到，我原来写错了）。
               全系统都按单箱重用它：
                 · 校验文案 product-row-guard.ts:74「产品行N的单箱重量(kg)」
                 · 汇总 orders/routes.ts:325「总重 = Σ(weightKg × packageCount)」
                 · 客户派送签收单 exportDispatchWorkbooks.ts:531「weightKg × packageCount」
                   —— 存成整行总重的话，签收单上印的是「单箱重 × 箱数²」，
                   10 箱 2.5kg 的货会印成 250kg，而那是要给客户签字的纸。 */
            weightKg: r.unitWeightKg,
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
        const what = target.includes("tracking") ? `提单号 ${trackingNo}` : `柜号 ${containerNo}`;
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
    // 柜号也要忽略大小写（跟下面唛头/提单号一个口径）：柜号是「MEDU1234567」这种大写，
    // 员工顺手打小写就该搜得到（2026-09-24 上线前自审发现，原来只有这一处漏了 mode）
    if (q.containerNo?.trim()) where.containerNo = { contains: q.containerNo.trim(), mode: "insensitive" };
    if (q.status?.trim()) where.currentStatus = q.status.trim();
    /* ⚠️ 唛头 / 提单号的筛选必须写进 where，不能拿回来再在内存里筛（2026-09-23 复核抓到）。
       原来是先 take 500 再在内存里过滤 —— 整柜超过 500 个之后，搜更早的柜会**静默搜不到**，
       而页面上「共 N 个」写的还是筛完的数，用户根本不知道还有没有。
       这就是 CLAUDE.md 第 19 条那个坑（前端筛只对「已经全拿到」的数据成立）。
       两个条件要各自成条进 AND，写成同一个 items 会互相覆盖。 */
    const and: any[] = [];
    if (q.clientId?.trim()) {
      and.push({ items: { some: { shipment: { order: { clientId: { contains: q.clientId.trim(), mode: "insensitive" } } } } } });
    }
    if (q.trackingNo?.trim()) {
      and.push({ items: { some: { shipment: { trackingNo: { contains: q.trackingNo.trim(), mode: "insensitive" } } } } });
    }
    if (and.length > 0) where.AND = and;

    const containers = await prisma.container.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        items: {
          orderBy: { createdAt: "asc" },
          include: {
            shipment: {
              include: { order: { select: { clientId: true, itemName: true, receivableAmountCny: true } } },
            },
          },
        },
      },
    });

    const rows = containers.map((c) => formatFclForStaff(c, c.items[0]?.shipment));
    /* 到顶了要显式说一声，不能静默截断（CLAUDE.md 第 21 条：
       看不到的数据，用户得有办法知道它存在）。 */
    ok(res, {
      items: rows,
      total: rows.length,
      truncated: rows.length >= 500,
      ...(rows.length >= 500 ? { note: "只显示最近 500 个整柜，请用上面的条件缩小范围" } : {}),
    });
  });

  // ==========================================================================
  // 员工 / 超管：整柜看板（老板 2026-09-23：「运营看板再单独在整柜里面加一个」）
  // ==========================================================================
  app.get("/staff/fcl-containers/overview", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    /* ⚠️ 按**运单状态**分堆，不是柜子状态（2026-09-24 实测发现）。
       整柜的签收走的是尾端派送，它只把运单推到 delivered，**不动柜子状态** ——
       柜子会一直停在「已到仓」。按柜子状态统计的话，明明签收了的整柜，
       看板上还显示「已到仓 1、已签收 0」，跟客户看到的对不上。
       （普通拼柜不一样：一个柜里好几票货，要全签完柜子才推 SIGNED，
       所以那边按柜子状态是对的。整柜就一张单，单签收了就是整柜签收了。） */
    const AT_WAREHOUSE_SHIPMENT = ["inWarehouseTH", "deliveryBooked", "outForDelivery"];
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);

    const containers = await prisma.container.findMany({
      where: { companyId: auth.companyId, isFcl: true },
      select: {
        createdAt: true,
        items: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: {
            shipment: {
              select: {
                currentStatus: true, volumeM3: true, packageCount: true,
                order: { select: { receivableAmountCny: true } },
              },
            },
          },
        },
      },
    });

    let atWarehouse = 0, signed = 0, thisMonth = 0;
    let volumeM3 = 0, onTheWayVolume = 0, packageCount = 0, amountCny = 0;
    for (const c of containers) {
      const ship = c.items[0]?.shipment;
      const st = ship?.currentStatus ?? "";
      const v = ship?.volumeM3 == null ? 0 : Number(ship.volumeM3);
      volumeM3 += v;
      packageCount += ship?.packageCount ?? 0;
      amountCny += ship?.order?.receivableAmountCny == null ? 0 : Number(ship.order.receivableAmountCny);
      if (c.createdAt >= startOfMonth) thisMonth += 1;
      if (st === "delivered") signed += 1;
      else if (AT_WAREHOUSE_SHIPMENT.includes(st)) atWarehouse += 1;
      else onTheWayVolume += v;   // 剩下的全算在路上，新状态自动跟上
    }
    const total = containers.length;

    ok(res, {
      total,
      onTheWay: total - atWarehouse - signed,
      atWarehouse,
      signed,
      thisMonth,
      volumeM3: Number(volumeM3.toFixed(3)),
      onTheWayVolumeM3: Number(onTheWayVolume.toFixed(3)),
      packageCount,
      amountCny: Number(amountCny.toFixed(2)),
    });
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
          orderBy: { createdAt: "asc" },
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
  // 超管：删整柜（老板 2026-09-24：「可以删吧」）
  // ==========================================================================
  app.post("/admin/fcl-containers/delete", async (req, res) => {
    /* 只给超管：这一下会把柜子、运单、订单、货物明细、轨迹一起删掉，
       跟「删运单」那条路同一个权限档（admin/routes.ts 的 /admin/orders/delete）。 */
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { containerId?: string; confirmContainerNo?: string };
    const containerId = String(body.containerId ?? "").trim();
    if (!containerId) { fail(res, 400, "BAD_REQUEST", "containerId 为必填"); return; }

    const container = await prisma.container.findFirst({
      where: { id: containerId, companyId: auth.companyId, isFcl: true },
      select: {
        id: true, containerNo: true,
        items: {
          orderBy: { createdAt: "asc" },
          select: { id: true, shipment: { select: { id: true, orderId: true, trackingNo: true, currentStatus: true } } },
        },
      },
    });
    if (!container) { fail(res, 404, "NOT_FOUND", "整柜不存在"); return; }

    /* ⚠️ 手打柜号确认（防手滑）。跟集货那边「删任务要管理员密码」是同一个用意：
       这一下删掉的东西找不回来，得让人停一下、看清自己删的是哪个柜。
       用柜号而不是密码 —— 柜号就在屏幕上，比翻密码顺手，照样防得住误点。 */
    if (String(body.confirmContainerNo ?? "").trim() !== container.containerNo) {
      fail(res, 400, "VALIDATION_ERROR", `要删这个整柜，请把柜号 ${container.containerNo} 原样填一遍确认`);
      return;
    }

    const shipmentIds = container.items.map((it) => it.shipment?.id).filter((x): x is string => !!x);
    const orderIds = [...new Set(container.items.map((it) => it.shipment?.orderId).filter((x): x is string => !!x))];

    const deleted = await prisma.$transaction(async (tx) => {
      /* 锁序跟全系统一致：【柜 → 运单 → 订单】。
         ⚠️ 只锁柜子不够（2026-09-24 锁序测试抓到）：下面要删运单和订单，
         两个超管同时删、或者删的同时有人在改那张单，就会撞车。
         运单走共用的 lockShipmentsChildrenFirst（子单在前、层内按 id 排），
         跟装柜、删运单那几条路用的是同一把钥匙，不会反向等待。 */
      await tx.$queryRaw`SELECT id FROM containers WHERE id = ${containerId} FOR UPDATE`;
      if (shipmentIds.length > 0) {
        await lockShipmentsChildrenFirst(tx, shipmentIds, auth.companyId);
      }
      for (const oid of [...orderIds].sort()) {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${oid} AND company_id = ${auth.companyId} FOR UPDATE`;
      }
      /* 锁内重读再判（CLAUDE.md 第 28 条）：这几秒里货可能刚被签收，
         事务外那份快照说「还没签收」是不算数的。 */
      const fresh = await tx.shipment.findMany({
        where: { id: { in: shipmentIds } },
        select: { id: true, trackingNo: true, currentStatus: true },
      });
      const signed = fresh.filter((sp) => sp.currentStatus === "delivered");
      if (signed.length > 0) {
        throw new BusinessError(
          `这个整柜的货已经签收了（${signed.map((x) => x.trackingNo).join("、")}），不能删 —— 删掉等于把交付记录也抹了。`,
          400, "VALIDATION_ERROR",
        );
      }
      const lm = await tx.adminLastmileOrder.findMany({
        where: { shipmentId: { in: shipmentIds } },
        select: { deliveryNo: true },
      });
      if (lm.length > 0) {
        throw new BusinessError(
          `这个整柜已经排了派送单（${[...new Set(lm.map((x) => x.deliveryNo))].join("、")}），请先在「尾端派送」里把那张单删掉再来删柜。`,
          400, "VALIDATION_ERROR",
        );
      }

      // 清理顺序照抄「删运单」那条路（admin/routes.ts），少一张表都会被外键挡住
      for (const sid of shipmentIds) {
        await tx.adminCustomsCase.updateMany({ where: { shipmentId: sid }, data: { shipmentId: null } });
        await tx.warehouseLocation.updateMany({ where: { shipmentId: sid }, data: { shipmentId: null } });
        await tx.staffInboundPhoto.deleteMany({ where: { shipmentId: sid } });
        await tx.statusLog.deleteMany({ where: { shipmentId: sid } });
        await tx.delivery.deleteMany({ where: { shipmentId: sid } });
      }
      await tx.shipmentContainerItem.deleteMany({ where: { containerId } });
      await tx.containerPushEntry.deleteMany({ where: { batch: { containerId } } });
      await tx.containerPushBatch.deleteMany({ where: { containerId } });
      await tx.shipment.deleteMany({ where: { id: { in: shipmentIds } } });
      for (const oid of orderIds) {
        await tx.adminCustomsCase.updateMany({ where: { orderId: oid }, data: { orderId: null } });
        await tx.invoiceLine.updateMany({ where: { orderId: oid }, data: { orderId: null } });
        await tx.adminSettlementEntry.deleteMany({ where: { orderId: oid } });
        await tx.orderProductImage.deleteMany({ where: { orderId: oid } });
        await tx.orderProduct.deleteMany({ where: { orderId: oid } });
      }
      await tx.order.deleteMany({ where: { id: { in: orderIds } } });
      await tx.container.delete({ where: { id: containerId } });
      return { containerNo: container.containerNo, trackingNos: fresh.map((x) => x.trackingNo) };
    });

    // 谁删的、删了什么，留一条日志（事后查得到）
    logger.warn("删除整柜", {
      操作人: auth.userId, 角色: auth.role,
      柜号: deleted.containerNo, 提单号: deleted.trackingNos.join("、"),
    });

    ok(res, { deleted: true, containerNo: deleted.containerNo });
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
          orderBy: { createdAt: "asc" },
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

    // 到顶了也要说一声，跟内部端一个口径（CLAUDE.md 第 21 条，2026-09-24 复核补）
    ok(res, {
      items: rows,
      total: rows.length,
      truncated: containers.length >= 500,
      ...(containers.length >= 500 ? { note: "只显示最近 500 个整柜" } : {}),
    });
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
          orderBy: { createdAt: "asc" },
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
        /* ⚠️ 备注要脱敏再给客户（2026-09-23 复核抓到）：员工在「装柜管理」推状态时
           备注框里写「柜号 MEDU1234567 已封」之类，原样发出去客户就看到柜号了。
           全系统给客户的备注都过这道（/client/orders、/client/shipments/track、代理端），
           只有这两个新接口漏了。 */
        remark: hideOperatorInRemark(sanitizeRemarkForClient(log.remark ?? "", true), "client") || null,
        /* 「下一站」是员工手填的（最多 50 字），也过一道脱敏（2026-09-23 第 2 轮复核提的）。
           ⚠️ 现有的 /client/shipments/track 对这个字段是**原样下发**的（containers/routes.ts:1496）——
           那是全系统的老口径，要不要统一得单独拍板；整柜这边先按严的来。 */
        nextStop: sanitizeRemarkForClient(log.nextStop ?? "", true) || null,
        operatorName: operatorNameForDisplay(log),
        operatorId: log.operatorId,
        operatorRole: log.operatorRole,
        changedAt: log.changedAt instanceof Date ? log.changedAt.toISOString() : log.changedAt,
      }, "client")),
    });
  });
}
