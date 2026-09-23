// B-6: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { lockShipmentsChildrenFirst } from "../shipments/lock-shipments";
import { parseNumericStrict, requireNonNegativeInt } from "../core/int-guard";
import { validateProductRows } from "../orders/product-row-guard";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { EXCLUDE_FCL_SHIPMENT, FCL_BLOCKED_MESSAGE } from "../core/fcl-scope";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { CONSOLIDATION_CURRENCY, recordRechargeCredit } from "../wallet/consolidation-balance";
import { loadProductImagesForOrders } from "../orders/product-images";
import { loadOrderProducts, readCargoTypes } from "../orders/routes";
import { hashPassword } from "../auth/crypto-utils";
import { countShipmentOverview } from "../shipments/overview-counts";
import { loadPartialAhead } from "../shipments/partial-status";
import { classifyStatusGroup } from "../../../../../packages/shared-types/shipment-status";
// 柜子状态中文名只有这一份（后端 status-flow.ts）。前端管理员页不再自己抄一份，
// 由接口直接下发中文 —— 抄第二份就一定会漏掉后加的状态。
import { CONTAINER_STATUS_LABEL } from "../containers/status-flow";
import { checkPasswordStrength } from "../auth/password-policy";
// 重置密码成功后要清登录失败计数（2026-08-31，排查报告第34条），键跟登录接口同一口径
import { clearLoginFailures } from "../core/rate-limit";
import {
  AGENT_CLIENT_PRICE_READONLY_MESSAGE,
  lockClientWhrPrice,
  parseWhrPriceInput,
  setNonAgentClientWhrPrice,
  LONG_TERM_PRICE_OFF_MESSAGE,
  LONG_TERM_PRICE_WRITE_ENABLED,
} from "../whr-consolidation/long-term-price";


/**
 * 开客户 / 改客户时传来的「所属代理」（2026-09-16，确认单 2.2 / 2.3 / 6.2）。
 * 不传、传空 = 湘泰自己的客户；传了就必须是本公司真实存在的代理。
 * @returns undefined 表示请求里压根没提这个字段（改客户时 = 不改归属）
 */
async function readAgentIdInput(
  raw: unknown,
  companyId: string,
): Promise<{ agentId: string | null; agentName: string | null } | { error: string } | undefined> {
  if (raw === undefined) return undefined;
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return { agentId: null, agentName: null };
  if (typeof raw !== "string") return { error: "所属代理不合法" };
  const agent = await prisma.agent.findFirst({
    where: { id: raw.trim(), companyId },
    select: { id: true, name: true },
  });
  if (!agent) return { error: "选的代理不存在，请刷新页面后重新选" };
  return { agentId: agent.id, agentName: agent.name };
}

/**
 * 这个客户名下有没有业务记录（运单 / 普通版集货任务 / 仓库版集货）。
 * 改归属只许在三样都没有的时候做（设计文档 1.2：不做划转，开错了且没业务数据才许改）。
 */
async function countClientBusinessRecords(
  tx: any,
  clientId: string,
  companyId: string,
): Promise<{ orders: number; consolidationTasks: number; whrPlans: number }> {
  const [orders, consolidationTasks, whrPlans] = await Promise.all([
    tx.order.count({ where: { clientId, companyId } }),
    tx.consolidationTask.count({ where: { clientId, companyId } }),
    tx.whrConsolidationPlanCustomer.count({ where: { clientId, companyId } }),
  ]);
  return { orders, consolidationTasks, whrPlans };
}
import { loadOrderTotalMetrics } from "../shipments/total-metrics";
import { BusinessError } from "../core/business-error";
import { loadOrderProductDims } from "../orders/routes";
import { strictestCargoType } from "../../../../../packages/shared-types/cargo-type";

/** Decimal | null → number | null */
function decToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value.toString());
}

/**
 * 根据仓库ID返回允许的运单号前缀（兼容短前缀与历史长前缀）。
 */
function allowedTrackingPrefixesByWarehouse(warehouseId: string): string[] {
  if (warehouseId === "wh_yiwu_01") return ["YW", "YWXT"];
  if (warehouseId === "wh_dongguan_01") return ["DG", "DGXT"];
  if (warehouseId === "wh_guangzhou_01") return ["GZ", "GZXT"];
  return ["XT"];
}

/**
 * 校验运单号是否与仓库前缀一致。
 */
function isTrackingNoMatchedWarehouse(warehouseId: string, trackingNo: string): boolean {
  const normalized = trackingNo.trim().toUpperCase();
  return allowedTrackingPrefixesByWarehouse(warehouseId).some((prefix) => normalized.startsWith(prefix));
}

/**
 * 在给定订单数组上"贴"上配套运单（兼容历史悬空 order_id 数据）。
 * 优先级：order_id 命中 > domestic_tracking_no 命中 > batch_no 命中。
 */
async function attachLinkedShipments(
  companyId: string,
  orders: Array<{
    id: string;
    batchNo: string | null;
    domesticTrackingNo: string | null;
  }>,
): Promise<Map<string, { id: string; trackingNo: string; currentStatus: string; containerNo: string | null }>> {
  if (orders.length === 0) return new Map();

  const orderIds = orders.map((o) => o.id);
  const domesticNos = orders.map((o) => o.domesticTrackingNo).filter((v): v is string => Boolean(v));
  const batchNos = orders.map((o) => o.batchNo).filter((v): v is string => Boolean(v));

  // 一次性把可能匹配的运单全捞出来
  const candidates = await prisma.shipment.findMany({
    where: {
      companyId,
      OR: [
        { orderId: { in: orderIds } },
        ...(domesticNos.length > 0 ? [{ domesticTrackingNo: { in: domesticNos } }] : []),
        ...(batchNos.length > 0 ? [{ batchNo: { in: batchNos } }] : []),
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      orderId: true,
      trackingNo: true,
      currentStatus: true,
      containerNo: true,
      batchNo: true,
      domesticTrackingNo: true,
    },
  });

  const result = new Map<string, { id: string; trackingNo: string; currentStatus: string; containerNo: string | null }>();

  for (const order of orders) {
    // 优先级 1: order_id 命中
    const byOrderId = candidates.find((s) => s.orderId === order.id);
    if (byOrderId) {
      result.set(order.id, {
        id: byOrderId.id,
        trackingNo: byOrderId.trackingNo,
        currentStatus: byOrderId.currentStatus,
        containerNo: byOrderId.containerNo,
      });
      continue;
    }
    // 优先级 2: domestic_tracking_no 命中（且运单本身 order_id 为空）
    if (order.domesticTrackingNo) {
      const byDomestic = candidates.find(
        (s) => !s.orderId && s.domesticTrackingNo === order.domesticTrackingNo,
      );
      if (byDomestic) {
        result.set(order.id, {
          id: byDomestic.id,
          trackingNo: byDomestic.trackingNo,
          currentStatus: byDomestic.currentStatus,
          containerNo: byDomestic.containerNo,
        });
        continue;
      }
    }
    // 优先级 3: batch_no 命中
    if (order.batchNo) {
      const byBatch = candidates.find((s) => !s.orderId && s.batchNo === order.batchNo);
      if (byBatch) {
        result.set(order.id, {
          id: byBatch.id,
          trackingNo: byBatch.trackingNo,
          currentStatus: byBatch.currentStatus,
          containerNo: byBatch.containerNo,
        });
      }
    }
  }

  return result;
}

export function registerAdminRoutes(app: MinimalHttpApp): void {
  app.get("/admin/dashboard/overview", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    /**
     * 「今天」按**北京时间**算（2026-08-21 改）。
     *
     * 后端容器跑在 UTC（实测 `TZ` 是空的），原来 `setHours(0,0,0,0)` 得到的是
     * UTC 零点 = **北京时间早上 8 点**。结果半夜到早 8 点之间下的单，
     * 在看板上会被算进「昨天」，老板早上看这个数字永远是不准的。
     *
     * ⚠️ 这里**故意不去改容器的 TZ 环境变量** —— 那会影响所有跟时间有关的东西
     * （备份文件名的日期、日志时间戳、定时任务），风险面大得多。
     * 只在这一处按 UTC+8 换算，影响范围可控。中国不实行夏令时，偏移固定 8 小时。
     */
    const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
    const startOfToday = (() => {
      const beijing = new Date(Date.now() + CHINA_OFFSET_MS);
      beijing.setUTCHours(0, 0, 0, 0);
      return new Date(beijing.getTime() - CHINA_OFFSET_MS);
    })();

    /**
     * 柜子分三段统计（2026-08-07 新增）。
     *
     * 原来管理员端首页那行「当前在途柜量」是前端自己算的：
     * 把未完成订单的「柜号」去重数个数。但那个柜号来自员工在「预报单审核」里
     * 手填的「柜号（可选，装柜时填写）」框，生产库 357 张在途单里只有 1 张填了，
     * 所以那个数常年是 0 或 1，跟真实柜数（94 个）完全不是一回事，
     * 而且填什么就数什么（测试库里出现过「uii」「暂无」这种）。
     *
     * 改成直接数 containers 表，按柜子自己的状态分段：
     *   在路上 = 已封柜出发、还没到泰国仓
     *   已到仓 = 到了泰国仓，还没派完
     *   已完成 = 已签收
     * ⚠️ 状态清单跟 containers/status-flow.ts 对齐，那边加了新状态要回来同步。
     */
    // ⚠️ 用「减法」算在路上，不要列举状态名。
    // 第一版是把在路上的状态一个个列出来，结果测试库 16 个柜子只数到 13 个：
    // 漏了 LOADING（装柜中）和 DELIVERING（老状态名，现在叫 OUT_FOR_DELIVERY）。
    // 列举法只要漏一个状态，柜子就凭空消失且没人发现（CLAUDE.md 第 19/21 条：不许静默丢数据）。
    // 现在只精确列举「装柜中 / 已到仓 / 已完成」三类，其余一律算在路上，
    // 以后加了新状态也不会漏掉。
    // ⚠️ 2026-08-21 补上 DELIVERY_BOOKED（预约派送）。
    // 它是 08-13 新加的状态，位置在「已到仓」之后、「派送中」之前 —— 货已经在泰国仓了。
    // 当时没回来同步这份清单，生产实测有 3 个柜子被算成了「在路上」。
    // 上面那条注释早就警告过「加了新状态要回来同步」，还是漏了 —— 这就是写死清单的代价。
    const AT_WAREHOUSE = ["IN_WAREHOUSE_TH", "DELIVERY_BOOKED", "OUT_FOR_DELIVERY", "DELIVERING"];

    const [staff, client, newOrder, inTransit, volumeAgg,
           ctnTotal, ctnLoading, ctnAtWarehouse, ctnDone] = await Promise.all([
      prisma.user.count({ where: { companyId: auth.companyId, role: "staff" } }),
      prisma.user.count({ where: { companyId: auth.companyId, role: "client" } }),
      prisma.order.count({
        where: { companyId: auth.companyId, createdAt: { gte: startOfToday } },
      }),
      /* ⚠️ 2026-08-21 修：原来数的是 currentStatus === "inTransit"，
         但**系统里根本没有 inTransit 这个状态**，这个数字从上线起一直是 0
         （生产实测：显示 0，实际在途 366 张）。当时改成 IN_TRANSIT_STATUSES 白名单。

         2026-09-03 再修：白名单跟运单列表顶部那排数字（减法口径）**对不上**——
         白名单只认流程表里的状态，老数据里的 pickedUp / customsPending / inTransit
         一张都数不到（测试库实测：这里 14、顶部 17，差的就是那三张老状态）。
         同一个管理员后台，看板一个「在途」、运单列表另一个「在途」。
         现在直接调顶部那排数字用的同一个函数，取它算出来的在途 —— 两处不可能再分家。
         口径：总数 − 未发出 − 已到仓 − 已完成 − 异常，剩下的全算在途（新状态自动跟上）。 */
      countShipmentOverview({
        companyId: auth.companyId,
        parentTrackingNo: null,
      }).then((o) => o.inTransitCount),
      // ⚠️ 2026-08-21 修：原来是 updatedAt >= 今天，等于「今天被改动过的运单」——
      // 员工改一张三个月前的老单，那单的方数也会加进来，而且父单子单都算、同一批货算两遍。
      // 生产实测：显示 526.478 方，去掉子单只有 295.332 方。
      // 现在按用户的业务口径（交接文档 1.5「运单出现在运单列表 = 货已经到国内仓库了」）
      // 改成「今天新进国内仓的货」= 今天创建的父单方数。
      prisma.shipment.aggregate({
        where: {
          companyId: auth.companyId,
          parentTrackingNo: null,
          createdAt: { gte: startOfToday },
        },
        _sum: { volumeM3: true },
      }),
      prisma.container.count({ where: { companyId: auth.companyId } }),
      prisma.container.count({
        where: { companyId: auth.companyId, currentStatus: "LOADING" },
      }),
      prisma.container.count({
        where: { companyId: auth.companyId, currentStatus: { in: AT_WAREHOUSE } },
      }),
      prisma.container.count({
        where: { companyId: auth.companyId, currentStatus: "SIGNED" },
      }),
    ]);

    // 剩下的全算「在路上」——这样任何没被上面三类认领的状态都不会凭空消失
    const ctnOnWay = ctnTotal - ctnLoading - ctnAtWarehouse - ctnDone;

    const totalVolume = volumeAgg._sum.volumeM3 ? Number(volumeAgg._sum.volumeM3.toString()) : 0;

    /**
     * 卡住的柜子（2026-08-21 新增）。
     *
     * 起因：生产上有个柜子 UETU7068621（9 票货）7-22 装柜，中间 28 天没推过任何状态，
     * 8-19 才被推到「国内海关查验」，到今天装柜满 30 天还没到仓 —— 而海运平均 14.7 天就到了。
     * 这种事系统里查得到，但**看板上没有任何地方会告诉你**，只能靠人去翻。
     *
     * 两条规则并用，缺一个就会漏：
     *   ① 超期未到仓：装柜到现在太久了还没到仓（海运 21 天 / 陆运 7 天）—— 抓「一直在路上」的
     *   ② 长时间没推进：距上次推状态太久（海运 14 天 / 陆运 7 天）
     *      —— 抓「刚封柜就没人管了」的（Y2608067567 就只有这条能抓到）
     *
     * 阈值是拿生产数据试出来的：海运在途 60 个柜，超 14 天有 8 个（平均 14.7 天，太宽），
     * 超 21 天只有 1 个 —— 那个才是真异常；陆运在途 3 个柜，超 7 天 0 个。
     * 两条合起来正好命中 2 个柜。**改阈值前先拿生产数据重新试一遍命中数。**
     *
     * ⚠️ 柜子和货的关系在 shipment_container_items，**不是** shipments.batch_no ——
     * 那个柜号是员工手填的可选字段，全库 1830 张单只有 38 张填了，拿它 join 等于白查。
     * ⚠️ 已到泰国仓（含预约派送/派送中/已签收）的不算卡住，那是尾端派送的事。
     */
    const stalledRows = await prisma.$queryRaw<
      Array<{
        container_no: string; transport_mode: string; current_status: string;
        loaded_days: number | null; idle_days: number | null;
        shipment_count: bigint; reason: string;
      }>
    >`
      WITH ld AS (
        SELECT i.container_id,
               MIN(l.changed_at) FILTER (WHERE l.to_status = 'loaded') AS loaded_at,
               MAX(l.changed_at) AS last_at
        FROM shipment_container_items i
        JOIN status_logs l ON l.shipment_id = i.shipment_id
        GROUP BY i.container_id
      )
      SELECT c.container_no, c.transport_mode, c.current_status,
             EXTRACT(DAY FROM now() - ld.loaded_at)::int AS loaded_days,
             EXTRACT(DAY FROM now() - ld.last_at)::int   AS idle_days,
             COUNT(i.id) AS shipment_count,
             CASE WHEN now() - ld.loaded_at >
                       (CASE WHEN c.transport_mode = 'land' THEN interval '7 days' ELSE interval '21 days' END)
                  THEN 'overdue' ELSE 'idle' END AS reason
      FROM containers c
      JOIN ld ON ld.container_id = c.id
      JOIN shipment_container_items i ON i.container_id = c.id
      WHERE c.company_id = ${auth.companyId}
        AND c.current_status NOT IN ('SIGNED', 'IN_WAREHOUSE_TH', 'DELIVERY_BOOKED', 'OUT_FOR_DELIVERY', 'DELIVERING')
        AND (
          now() - ld.loaded_at > (CASE WHEN c.transport_mode = 'land' THEN interval '7 days'  ELSE interval '21 days' END)
          OR
          now() - ld.last_at   > (CASE WHEN c.transport_mode = 'land' THEN interval '7 days'  ELSE interval '14 days' END)
        )
      GROUP BY c.container_no, c.transport_mode, c.current_status, ld.loaded_at, ld.last_at
      ORDER BY EXTRACT(DAY FROM now() - ld.loaded_at)::int DESC
      LIMIT 10
    `;

    const stalledContainers = stalledRows.map((r) => ({
      containerNo: r.container_no,
      transportMode: r.transport_mode,
      currentStatus: r.current_status,
      currentStatusZh: CONTAINER_STATUS_LABEL[r.current_status] ?? r.current_status,
      loadedDays: r.loaded_days ?? null,
      idleDays: r.idle_days ?? null,
      shipmentCount: Number(r.shipment_count),
      reason: r.reason as "overdue" | "idle",
    }));

    ok(res, {
      staffAccountCount: staff,
      clientAccountCount: client,
      newOrderCountToday: newOrder,
      inTransitOrderCount: inTransit,
      receivedVolumeM3Today: Number(totalVolume.toFixed(3)),
      containerLoadingCount: ctnLoading,
      containerOnTheWayCount: ctnOnWay,
      containerAtWarehouseCount: ctnAtWarehouse,
      containerDoneCount: ctnDone,
      containerTotalCount: ctnTotal,
      stalledContainers,
    });
  });

  app.get("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const role = typeof req.query?.role === "string" ? req.query.role : undefined;
    if (role !== "staff" && role !== "client") {
      // 无 role 过滤时返回所有 staff + client
      const allRows = await prisma.user.findMany({
        where: { companyId: auth.companyId, role: { in: ["staff", "client"] } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          companyId: true,
          role: true,
          name: true,
          phone: true,
          status: true,
          createdAt: true,
          companyName: true,
          email: true,
        },
      });
      ok(res, { items: allRows });
      return;
    }

    const rows = await prisma.user.findMany({
      where: { companyId: auth.companyId, role },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        companyId: true,
        role: true,
        name: true,
        phone: true,
        status: true,
        createdAt: true,
        companyName: true,
        email: true,
        // 2026-09-16 代理账号：所属代理和长期价只在这个**只给超管**的接口里给（requireRole admin）。
        // 员工端客户下拉走 /staff/clients，那边只有 id + name，不带这些。
        agentId: true,
        agent: { select: { name: true } },
        whrPrice: {
          select: { priceNormal: true, priceInspection: true, priceSensitive: true, updatedByRole: true, updatedAt: true },
        },
      },
    });

    ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        role: r.role,
        name: r.name,
        phone: r.phone,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        companyName: r.companyName ?? undefined,
        email: r.email ?? undefined,
        ...(role === "client"
          ? {
              agentId: r.agentId ?? null,
              agentName: r.agent?.name ?? null,
              whrPrice: r.whrPrice
                ? {
                    normal: Number(r.whrPrice.priceNormal),
                    inspection: Number(r.whrPrice.priceInspection),
                    sensitive: Number(r.whrPrice.priceSensitive),
                    // 谁填的：admin / agent；null = 上线时按最近一个柜的价自动回填的那批
                    filledByRole: r.whrPrice.updatedByRole ?? null,
                    updatedAt: r.whrPrice.updatedAt.toISOString(),
                  }
                : null,
            }
          : {}),
      })),
    });
  });

  app.get("/admin/orders", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 500);
    // 整柜的单不进超管「运单管理」（老板 2026-09-23），走「整柜管理」那一页
    const where = { ...EXCLUDE_FCL_SHIPMENT, companyId: auth.companyId, parentTrackingNo: null } as const;

    const [total, rows] = await Promise.all([
      prisma.shipment.count({ where }),
      prisma.shipment.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          order: {
            include: {
              client: { select: { name: true } },
            },
          },
        },
      }),
    ]);

    const totalMetricsByOrderId = await loadOrderTotalMetrics(
      auth.companyId,
      rows.map((row) => ({
        orderId: row.orderId,
        orderVolumeM3: row.order?.volumeM3,
        orderWeightKg: row.order?.weightKg,
      })),
    );

    /**
     * 顺带把每张单的「长宽高」带上（2026-08-27 加）。
     * 长宽高记在产品行上，运单本身没有这三个字段，而管理员端的导出要用。
     * 这里只取三个尺寸、不带整条产品行（产品名、单号那些列表里用不到），
     * 一张单大概多几十字节；而且这个接口本来就是分页的，一次只查当前这页。
     */
    const dimsByOrderId = await loadOrderProductDims(
      auth.companyId,
      rows.map((r) => r.orderId).filter((v): v is string => Boolean(v)),
    );

    // 同客户端/员工端：子单进度不一样时补一句「（部分已放行）」，主状态和分组不动
    const partialAheadAdmin = await loadPartialAhead(
      auth.companyId,
      rows.map((r) => ({
        trackingNo: r.trackingNo,
        currentStatus: r.currentStatus,
        packageCount: r.packageCount,
        transportMode: r.transportMode ?? r.order?.transportMode,
      })),
    );

    const items = rows.map((r) => ({
      id: r.id,
      orderId: r.order?.id ?? undefined,
      ...(dimsByOrderId.get(r.orderId) ?? {}),
      orderNo: r.order?.orderNo ?? undefined,
      trackingNo: r.trackingNo,
      batchNo: r.batchNo,
      containerNo: r.containerNo ?? undefined,
      clientId: r.order?.clientId ?? undefined,
      clientName: r.order?.client?.name ?? undefined,
      itemName: r.order?.itemName ?? undefined,
      domesticTrackingNo: r.domesticTrackingNo ?? undefined,
      packageCount: r.packageCount ?? undefined,
      productQuantity: r.order?.productQuantity ?? undefined,
      weightKg: decToNumber(r.weightKg) ?? undefined,
      volumeM3: decToNumber(r.volumeM3) ?? undefined,
      totalWeightKg: r.parentTrackingNo === null
        ? totalMetricsByOrderId.get(r.orderId)?.totalWeightKg
        : undefined,
      totalVolumeM3: r.parentTrackingNo === null
        ? totalMetricsByOrderId.get(r.orderId)?.totalVolumeM3
        : undefined,
      currentStatus: r.currentStatus,
      partialAhead: partialAheadAdmin.get(r.trackingNo),
      warehouseId: r.warehouseId,
      updatedAt: r.updatedAt.toISOString(),
      transportMode: r.order?.transportMode ?? undefined,
      shipDate: r.order?.shipDate ?? undefined,
      receiverAddressTh: r.order?.receiverAddressTh ?? undefined,
      receivableAmountCny: decToNumber(r.order?.receivableAmountCny ?? null) ?? undefined,
      receivableCurrency: r.order?.receivableCurrency ?? undefined,
      paymentStatus: (r.order?.paymentStatus === "paid" ? "paid" : "unpaid") as "paid" | "unpaid",
      packageUnit: ((r.order?.packageUnit === "bag" ? "bag" : "box") as "bag" | "box"),
      cargoType: r.order?.cargoType ?? "normal",
      canEdit: true,
      approvalStatus: r.order?.approvalStatus ?? undefined,
      remark: r.remark ?? undefined,
      /* 2026-09-03 修：原来直接发数据库 orders.status_group 那一列，
         但**从来没有任何代码更新过它** —— 生产库 1252 张单全是 "unfinished"。
         管理员导出 Excel 的「状态组」那列因此永远是同一个英文单词，等于废列。
         现在按运单当前状态实时算，跟客户端分组按钮同一份口径。 */
      statusGroup: classifyStatusGroup(r.currentStatus),
      paidAt: r.order?.paidAt ? r.order?.paidAt.toISOString() : undefined,
      paidBy: r.order?.paidBy ?? undefined,
      createdAt: r.order?.createdAt.toISOString() ?? r.createdAt.toISOString(),
      productImages: [] as any[],
      products: [] as any[],
    }));

    // 按需加载产品图和产品行
    const orderIds = [...new Set(items.map((i) => i.orderId).filter(Boolean) as string[])];
    const imageMap = await loadProductImagesForOrders(auth.companyId, orderIds);
    const productsMap = await loadOrderProducts(auth.companyId, orderIds);

    ok(res, {
      items: items.map((item) => ({
        ...item,
        productImages: item.orderId ? (imageMap.get(item.orderId) ?? []) : [],
        products: item.orderId ? (productsMap.get(item.orderId) ?? []) : [],
      })),
      page,
      pageSize,
      total,
    });
  });

  /**
   * 管理员更新客户端订单基础信息，并同步到关联运单的同名字段。
   */
  app.post("/admin/orders/update", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      orderId?: string;
      clientId?: string;
      itemName?: string;
      cargoType?: string;
      transportMode?: "sea" | "land";
      domesticTrackingNo?: string | null;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number | null;
      volumeM3?: number | null;
      shipDate?: string | null;
      trackingNo?: string | null;
      batchNo?: string | null;
      warehouseId?: string;
      receiverAddressTh?: string;
      containerNo?: string | null;
      remark?: string | null;
      products?: Array<{
        /** 已有产品行的编号；不传表示这是新增的一行 */
        id?: string;
        itemName: string;
        packageCount: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        productQuantity?: number;
        cargoType?: string;
        domesticTrackingNo?: string;
        weightKg?: number;
      }>;
    };

    const rawId = body.orderId?.trim();
    const cargo = readCargoTypes(body.cargoType, body.products);
    if ("error" in cargo) {
      fail(res, 400, "VALIDATION_ERROR", cargo.error);
      return;
    }
    /**
     * ⚠️⚠️ **管理员改单这条路以前没有这道校验**（2026-08-29 补）。
     * 第七轮复核点名：三个后端入口（员工建单 / 客户建单 / 管理员改单），
     * 上一轮我只接上了员工建单那个。下面 orderProduct 那句
     * `p.packageCount || 1` 就是把「箱数填 0」悄悄变成 1 箱的病根。
     *
     * ⚠️ 位置要放在**碰数据库之前**：放后面的话，参数本来就不合法的请求
     * 还是会先去查一轮库；而且自测想验它就得连库。
     */
    if (body.products && body.products.length > 0) {
      const rowIssue = validateProductRows(body.products);
      if (rowIssue) {
        fail(res, 400, "VALIDATION_ERROR", rowIssue);
        return;
      }
    }

    /**
     * ⚠️ 用 parseNumericStrict 而不是 Number（2026-08-29 第九轮补）：
     * `Number(true)` 是 1、`Number([5])` 是 5，JSON 里传布尔或数组能直接穿过校验。
     * ⚠️ 位置挪到了**碰数据库之前**（2026-08-29）：原来夹在查库之后，
     *    参数本来就不合法的请求还是会先查一轮库；而且自测想验它就得连库。
     * ⚠️ 校验用 requireNonNegativeInt：原来只判 `isFinite && >= 0`，
     * 复核实测 **2.5 和超过 32 位上限的数都能过** —— 这两个字段在库里都是 `Int`。
     */
    const productQuantity =
      body.productQuantity !== undefined ? parseNumericStrict(body.productQuantity) : undefined;
    const packageCount =
      body.packageCount !== undefined ? parseNumericStrict(body.packageCount) : undefined;
    if (productQuantity !== undefined) {
      const issue = requireNonNegativeInt(productQuantity, "产品数量");
      if (issue) { fail(res, 400, "VALIDATION_ERROR", issue); return; }
    }
    if (packageCount !== undefined) {
      const issue = requireNonNegativeInt(packageCount, "箱数");
      if (issue) { fail(res, 400, "VALIDATION_ERROR", issue); return; }
    }

    if (!rawId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }

    // 支持传入运单ID（shipment id），自动查找关联订单
    let orderId = rawId;
    let exists = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      select: { id: true, warehouseId: true, batchNo: true, domesticTrackingNo: true, receiverAddressTh: true, paymentStatus: true },
    });
    if (!exists) {
      // 尝试通过运单ID查找
      // ⚠️ 这条「退一步按运单 ID 找」的路也必须带公司（2026-08-27 补）。
      // 上面那次查订单是带了 companyId 的，唯独这条退路没带 ——
      // 拿别家公司的运单 ID 进来就能绕过去，改到别家的订单。
      const shipment = await prisma.shipment.findFirst({
        where: { id: rawId, companyId: auth.companyId },
        select: { orderId: true, order: { select: { id: true, warehouseId: true, batchNo: true, domesticTrackingNo: true, receiverAddressTh: true, paymentStatus: true } } },
      });
      if (shipment?.order) {
        exists = shipment.order;
        orderId = shipment.order.id;
      }
    }
    if (!exists) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }

    // 查关联运单（与列表逻辑相同的容错优先级）
    const shipmentMap = await attachLinkedShipments(auth.companyId, [{
      id: exists.id,
      batchNo: exists.batchNo,
      domesticTrackingNo: exists.domesticTrackingNo,
    }]);
    const linkedShipment = shipmentMap.get(exists.id) ?? null;

    // ────────────────────────────────────────────────────────────────
    // 增量更新：只处理本次真正提交上来的字段。
    // 没提交的字段一律不写，避免把别人在这期间的改动覆盖掉。
    // 注意：不能改成「没提交就写默认值/null」，那会静默清空数据。
    // ────────────────────────────────────────────────────────────────
    const has = (k: keyof typeof body) => body[k] !== undefined;

    const itemName = body.itemName?.trim();
    if (has("itemName") && !itemName) {
      fail(res, 400, "BAD_REQUEST", "itemName is required");
      return;
    }

    const packageUnit = has("packageUnit") ? (body.packageUnit === "bag" ? "bag" : "box") : undefined;
    const transportMode = has("transportMode") ? (body.transportMode === "land" ? "land" : "sea") : undefined;
    const domesticTrackingNo = has("domesticTrackingNo") ? (body.domesticTrackingNo?.trim() || null) : undefined; // 传空字符串 = 主动清空
    const weightKg = has("weightKg") ? (body.weightKg === null ? null : Number(body.weightKg)) : undefined;
    const volumeM3 = has("volumeM3") ? (body.volumeM3 === null ? null : Number(body.volumeM3)) : undefined;
    /**
     * ⚠️ 负数也要挡（2026-08-31，排查报告第36条）：同一个接口里箱数、产品数量
     * 都有「不能是负数」的把关，唯独重量体积原来只判了 isFinite —— 填 -5 照样
     * 收下并同步到关联运单，一路流进首页方数合计、签收单打印和分柜分摊，
     * 全程没有任何报错。这两个字段是小数，不能套 requireNonNegativeInt（那是整数用的）。
     */
    if (weightKg !== undefined && weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 0)) {
      fail(res, 400, "BAD_REQUEST", "重量必须是不小于 0 的数字");
      return;
    }
    if (volumeM3 !== undefined && volumeM3 !== null && (!Number.isFinite(volumeM3) || volumeM3 < 0)) {
      fail(res, 400, "BAD_REQUEST", "体积必须是不小于 0 的数字");
      return;
    }

    /* 2026-08-07：运单不再涉及金额，应收金额/币种/付款状态不再接受修改。
       字段还留在表里（为了保住历史数据），但没有任何接口能再写它们。 */
    const warehouseId = has("warehouseId") ? (body.warehouseId?.trim() || exists.warehouseId) : undefined;
    const batchNo = has("batchNo") ? (body.batchNo?.trim() || null) : undefined;
    const receiverAddressTh = has("receiverAddressTh") ? (body.receiverAddressTh ?? "").trim() : undefined;
    // trackingNo 本次没提交就沿用现有值（查重仍要用到），但不会再写回运单
    const trackingNo = has("trackingNo") ? (body.trackingNo?.trim() || null) : (linkedShipment?.trackingNo ?? null);
    const containerNo = has("containerNo") ? (body.containerNo?.trim() || null) : undefined;
    if (!trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
      return;
    }
    // 查重：排除当前订单下的所有运单
    const orderShipments = await prisma.shipment.findMany({
      where: { orderId: orderId, companyId: auth.companyId },
      select: { id: true },
    });
    const excludeIds = orderShipments.map(s => s.id);
    const conflict = await prisma.shipment.findFirst({
      where: {
        companyId: auth.companyId,
        trackingNo,
        ...(excludeIds.length > 0 ? { NOT: { id: { in: excludeIds } } } : {}),
      },
      select: { id: true },
    });
    if (conflict) {
      fail(res, 400, "BAD_REQUEST", "trackingNo already exists");
      return;
    }

    let shipDate: string | null | undefined = undefined;
    if (has("shipDate")) {
      const rawInput = body.shipDate === null ? "" : String(body.shipDate).trim();
      if (rawInput === "") {
        shipDate = null; // 传了空 = 主动清空
      } else {
        const raw = rawInput.slice(0, 10);
        const parsed = new Date(`${raw}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) {
          fail(res, 400, "BAD_REQUEST", "invalid shipDate");
          return;
        }
        shipDate = raw;
      }
    }

    /**
     * ⚠️ 改「唛头归属」前必须核对目标账号（2026-08-31，排查报告第55条）。
     * 员工建单那条路早就有这道检查，唯独管理员编辑这里漏了：
     * 打错成员工账号，客户的单就挂到员工名下、原客户再也看不到；
     * 打一个不存在的号，外键报错只显示「服务器繁忙」，管理员不知道是自己打错。
     * 规则跟员工建单保持一致：必须存在、属于本公司、角色是客户。
     */
    const nextClientId = body.clientId?.trim();
    if (nextClientId) {
      const targetClient = await prisma.user.findUnique({
        where: { id: nextClientId },
        select: { id: true, companyId: true, role: true },
      });
      if (!targetClient || targetClient.companyId !== auth.companyId || targetClient.role !== "client") {
        fail(res, 400, "BAD_REQUEST", "唛头不存在或不属于当前公司，请核对客户唛头");
        return;
      }
    }

    const now = new Date();

    /* ==================================================================
       保存运单时，「还剩多少没装柜」不能直接写成整张单的箱数（2026-08-10）

       现象：运单管理里那张单写着 101 箱，装柜管理里却显示「共30件（剩0件）」，
       仓库里还有 71 箱装不进柜子（勾选框是灰的）。

       原因就在这里：前端把**产品行的箱数合计**当 packageCount 传上来，
       后端原样写进运单，**完全不管这张单已经装走了多少**。
       只要一张已经装过柜的运单被编辑保存过一次，「还剩多少没装」就被冲掉。
       生产上因此坏了 43 张（表现为父单和子单加起来比订单还多一倍）。

       正确算法：还剩多少没装 = 整张单的箱数 − 已经装走的件数。
       没拆过柜的运单（绝大多数）子单合计为 0，结果跟原来一模一样。

       ⚠️ 2026-08-31（排查报告第52条）：「已经装走多少件」原来是在事务**外面**
       查的 —— 查完到真正写库之间没有排队，装柜恰好插进来的话，这里用的还是
       装柜前的旧数，父单「还剩多少没装」就会被写多（CLAUDE.md 第 28 条：
       锁只保证不同时，不保证数据没变；拿来做决定的数字必须锁后重读）。
       所以整段挪进了下面的事务里：先把这张单的父运单行锁住（跟装柜那条路
       排同一个队），锁到手再查子单合计、再算剩余。
       ================================================================== */

    // 事务：锁父运单 → 锁内重算剩余件数 → 订单 + 关联运单 + 产品行一致更新
    await prisma.$transaction(async (tx) => {
      // 锁序【订单 → 运单】，跟 orders/routes.ts 确认收货那条路一致。
      // 这个事务下面要 update orders，先锁订单行，两个入口同时改同一张单才会排队。
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} AND company_id = ${auth.companyId} FOR UPDATE`;
      const savedProductCargo = async () => {
        const products = await tx.orderProduct.findMany({
          where: { orderId, companyId: auth.companyId },
          select: { cargoType: true },
        });
        const savedCargo = readCargoTypes(undefined, products);
        if ("error" in savedCargo) throw new BusinessError(savedCargo.error);
        return products.length > 0 ? strictestCargoType(savedCargo.products) : undefined;
      };
      // 只改整票货型不应偷偷覆盖明细；已有产品时请在产品行修改，再按最严同步。
      if (has("cargoType") && !body.products?.length) {
        const productCargo = await savedProductCargo();
        if (productCargo !== undefined && productCargo !== cargo.order) {
          throw new BusinessError("整票货型须与产品明细的最严货型一致，请在产品行修改货型后保存");
        }
      }
      let parentPackageCount = packageCount;
      let parentWeightKg = weightKg;
      let parentVolumeM3 = volumeM3;
      /* ⚠️ 2026-08-31（复查）：重量/体积也要做跟箱数一模一样的「整单减已装走」。
         原来只有箱数换算了，weightKg/volumeM3 却把整单值原样写进父运单 ——
         而全系统口径是「运单存剩余、订单存整单」。管理员编辑一张 100kg、
         已装走 70kg 的单，父运单重量会被写成 100（应为 30）；之后员工端
         编辑再按「剩余 + 子单合计」回算订单总重，就成了 100 + 70 = 170，
         凭空多出 70kg。修法跟员工端 orders/routes.ts 那条路对齐。
         注意：前端「只改手填的总重量/总体积」时可以不带箱数，所以查子单
         合计的条件不能只看 packageCount。
         2026-08-31（Codex 复核）：改运单号也必须进这段锁 —— 原来只改单号
         不带箱数/重量/体积时整段被跳过，拆过柜的父单被改号后子单当场失联
         （子单全靠 parentTrackingNo = 父单运单号这根线认亲），下面还有
         「拆过柜不许改号」的拦截要在锁内做。 */
      if (
        packageCount !== undefined ||
        (weightKg !== undefined && weightKg !== null) ||
        (volumeM3 !== undefined && volumeM3 !== null) ||
        (has("trackingNo") && trackingNo !== null)
      ) {
        const parents = await tx.shipment.findMany({
          where: { orderId, companyId: auth.companyId, parentTrackingNo: null },
          select: { id: true, trackingNo: true },
        });
        if (parents.length > 0) {
          // 这批全是父单（parentTrackingNo: null），锁的是父单层，
          // 锁序跟全系统「子单先、父单后、层内按 id 排」一致
          await lockShipmentsChildrenFirst(tx, parents.map((p) => p.id), auth.companyId);
          // 锁后重读运单号（CLAUDE.md 第 28 条）：拿锁之前那份快照里的
          // trackingNo 可能已经被并发编辑改掉，查子单合计要用锁内的值
          const lockedParents = await tx.shipment.findMany({
            where: { id: { in: parents.map((p) => p.id) }, companyId: auth.companyId },
            select: { trackingNo: true },
          });
          const loadedRows = await tx.shipment.groupBy({
            by: ["parentTrackingNo"],
            where: {
              companyId: auth.companyId,
              parentTrackingNo: { in: lockedParents.map((p) => p.trackingNo) },
            },
            _sum: { packageCount: true, weightKg: true, volumeM3: true },
            _count: true,
          });
          /* 2026-08-31（Codex 复核，员工端 orders/routes.ts 同款拦截）：
             拆过柜的单不许改运单号。子单全靠 parentTrackingNo = 父单运单号
             这根线认亲 —— 父单一改号，子单当场失联：上面这份子单合计下次
             查出来是 0，「还剩多少没装」会被冲错，卸柜还货、父单状态同步
             这些按 parentTrackingNo 走的流程也全断。比较必须用锁内重读的
             运单号（CLAUDE.md 第 28 条），不能用锁前那份快照。
             同步改子单动静太大（还要连带轨迹/装柜记录逐个核），先一律拦住。 */
          if (has("trackingNo") && trackingNo !== null) {
            for (const parent of lockedParents) {
              const childRow = loadedRows.find((r) => r.parentTrackingNo === parent.trackingNo);
              if (childRow && trackingNo !== parent.trackingNo) {
                throw new BusinessError(
                  `这张运单已经拆过柜（有 ${childRow._count} 张子单挂在原单号下），不能修改运单号，本次修改都没有保存。请先把单号改回 ${parent.trackingNo} 再保存其他修改。`,
                );
              }
            }
          }
          const alreadyLoaded = loadedRows.reduce(
            (s: number, r: { _sum: { packageCount: number | null } }) => s + (r._sum.packageCount ?? 0),
            0,
          );
          if (packageCount !== undefined && alreadyLoaded > 0) {
            parentPackageCount = Math.max(0, packageCount - alreadyLoaded);
          }
          // 舍入位数跟数据库列一致（重量 Decimal(10,2)、体积 Decimal(10,3)），
          // 算法照抄 decimal-guard 的 roundToScale，免得浮点相减带出一串尾数。
          // 历史手工分柜的子单可能没存这两列，null 按 0 算 —— 那种单减掉的会偏少，
          // 但也远好过把整单值原样写进父运单。
          const roundToScale = (n: number, scale: number): number => {
            const f = 10 ** scale;
            return Math.round((n + Number.EPSILON) * f) / f;
          };
          let alreadyLoadedWeightKg = 0;
          let alreadyLoadedVolumeM3 = 0;
          for (const r of loadedRows) {
            alreadyLoadedWeightKg += r._sum.weightKg == null ? 0 : Number(r._sum.weightKg.toString());
            alreadyLoadedVolumeM3 += r._sum.volumeM3 == null ? 0 : Number(r._sum.volumeM3.toString());
          }
          if (typeof weightKg === "number" && alreadyLoadedWeightKg > 0) {
            parentWeightKg = Math.max(0, roundToScale(weightKg - alreadyLoadedWeightKg, 2));
          }
          if (typeof volumeM3 === "number" && alreadyLoadedVolumeM3 > 0) {
            parentVolumeM3 = Math.max(0, roundToScale(volumeM3 - alreadyLoadedVolumeM3, 3));
          }
        }
      }

      await tx.order.update({
        where: { id: orderId },
        data: {
          warehouseId,
          batchNo,
          // clientId 在库里是必填，给 null 会直接抛错。
          // 传了非空值才改归属，传空串/不传就保持原样。
          // （非空值在事务外面已经核对过：本公司、client 角色 —— 见上面第55条那段）
          ...(nextClientId ? { clientId: nextClientId } : {}),
          itemName,
          cargoType: body.cargoType !== undefined ? cargo.order : undefined,
          transportMode,
          domesticTrackingNo,
          productQuantity,
          packageCount,
          packageUnit,
          weightKg,
          volumeM3,
          receiverAddressTh,
          shipDate,
          updatedAt: now,
        },
      });
      // 同步所有关联运单（按 order_id 关联的那些）
      // data 里凡是 undefined 的键，Prisma 会跳过不写 —— 也就是「本次没改就不碰」
      await tx.shipment.updateMany({
        where: { orderId, companyId: auth.companyId, parentTrackingNo: null },
        data: {
          warehouseId,
          ...(has("trackingNo") && trackingNo ? { trackingNo } : {}),
          batchNo,
          transportMode,
          domesticTrackingNo,
          // ⚠️ 这里是「还剩多少没装柜」，不是整张单的箱数 —— 见上面那段说明。
          // 订单上那个 packageCount 仍然是整张单的总箱数，两者不是一回事。
          packageCount: parentPackageCount,
          packageUnit,
          // ⚠️ 重量/体积同上：父运单存「整单减已装走」的剩余数（2026-08-31 复查补齐）
          weightKg: parentWeightKg,
          volumeM3: parentVolumeM3,
          containerNo,
          remark: body.remark !== undefined ? body.remark?.trim() || null : undefined,
          updatedAt: now,
        },
      });
      // 产品行按行增量同步：带 id 的改、不带 id 的新增、本次没提交的才删。
      // 不再整批删除重建 —— 重建一旦漏字段（曾漏过 weightKg）就会静默丢数据。
      if (body.products && body.products.length > 0) {
        const keepIds = body.products
          .map((p) => p.id?.trim())
          .filter((v): v is string => Boolean(v));

        await tx.orderProduct.deleteMany({
          where: {
            orderId,
            companyId: auth.companyId,
            ...(keepIds.length > 0 ? { id: { notIn: keepIds } } : {}),
          },
        });

        for (let i = 0; i < body.products.length; i++) {
          const p = body.products[i];
          const data = {
            itemName: p.itemName.trim(),
            // ⚠️ 不许 `|| 1`：上面已经卡死必须是正整数（2026-08-29 去掉兜底）
            packageCount: p.packageCount,
            lengthCm: p.lengthCm ?? null,
            widthCm: p.widthCm ?? null,
            heightCm: p.heightCm ?? null,
            productQuantity: p.productQuantity ?? null,
            cargoType: p.cargoType !== undefined || !p.id?.trim() ? cargo.products[i] : undefined,
            domesticTrackingNo: p.domesticTrackingNo?.trim() || "货拉拉",
            weightKg: p.weightKg ?? null,
            sortOrder: i,
          };
          const rowId = p.id?.trim();
          if (rowId) {
            // 用 updateMany 而不是 update：where 里带上 orderId + companyId，
            // 传了别的订单的行号也只会匹配不到，不会被改动
            await tx.orderProduct.updateMany({
              where: { id: rowId, orderId, companyId: auth.companyId },
              data,
            });
          } else {
            await tx.orderProduct.create({
              data: { companyId: auth.companyId, orderId, ...data },
            });
          }
        }
        // 从锁内实际保存的完整集合汇总，包含未改货型的旧行，不从请求字段猜测。
        const productCargo = await savedProductCargo();
        if (productCargo !== undefined) {
          await tx.order.update({ where: { id: orderId }, data: { cargoType: productCargo } });
        }
      }
    });

    ok(res, {
      orderId,
      updatedAt: now.toISOString(),
    });
  });

  app.post("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      phone?: string;
      password?: string;
      role?: string;
      agentId?: string | null;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!name || !phone) {
      fail(res, 400, "BAD_REQUEST", "name and phone are required");
      return;
    }
    // 2026-09-16：这个入口开客户时也认「所属代理」（设计文档第 3 节：两个开客户入口都要带）；开员工不认
    const agentInput = body.role === "client" ? await readAgentIdInput(body.agentId, auth.companyId) : undefined;
    if (agentInput && "error" in agentInput) {
      fail(res, 400, "BAD_REQUEST", agentInput.error);
      return;
    }

    const rawId = typeof body.id === "string" ? body.id.trim() : "";
    const id = rawId || `u_${body.role === "client" ? "client" : "staff"}_${Date.now()}`;
    const targetRole = body.role === "client" ? "client" : "staff";
    const rawPassword = typeof body.password === "string" ? body.password.trim() : "";

    // 新开的员工账号不许用弱口令（客户账号不管，见 set-password 那里的说明）
    if (targetRole === "staff" && rawPassword) {
      const weakReason = checkPasswordStrength(rawPassword, undefined, id);
      if (weakReason) {
        fail(res, 400, "BAD_REQUEST", weakReason);
        return;
      }
    }
    const passwordHash = rawPassword ? hashPassword(rawPassword) : null;

    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (existing) {
      fail(res, 400, "BAD_REQUEST", "user id already exists");
      return;
    }

    const created = await prisma.user.create({
      data: {
        id,
        companyId: auth.companyId,
        role: targetRole,
        name,
        phone,
        status: "active",
        warehouseIds: "[]",
        passwordHash,
        agentId: agentInput?.agentId ?? null,
      },
      select: { id: true, name: true, role: true, phone: true, createdAt: true },
    });

    ok(res, { id: created.id, name: created.name, phone: created.phone, createdAt: created.createdAt.toISOString() });
  });

  app.post("/admin/users/client", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      companyName?: string;
      phone?: string;
      email?: string;
      password?: string;
      /** 2026-09-16：开在哪个代理名下；不传 / 空 = 湘泰自己的客户（确认单 2.2 / 2.3） */
      agentId?: string | null;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!name || !phone) {
      fail(res, 400, "BAD_REQUEST", "客户名字和电话号码为必填");
      return;
    }
    const agentInput = await readAgentIdInput(body.agentId, auth.companyId);
    if (agentInput && "error" in agentInput) {
      fail(res, 400, "BAD_REQUEST", agentInput.error);
      return;
    }

    const rawId = typeof body.id === "string" ? body.id.trim() : "";
    const id = rawId || `u_client_${Date.now()}`;
    const companyName = typeof body.companyName === "string" ? body.companyName.trim() || null : null;
    const email = typeof body.email === "string" ? body.email.trim() || null : null;

    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (existing) {
      fail(res, 400, "BAD_REQUEST", "该客户账号已存在");
      return;
    }

    const passwordHash = typeof body.password === "string" && body.password.trim()
      ? hashPassword(body.password.trim()) : null;

    const created = await prisma.user.create({
      data: {
        id,
        companyId: auth.companyId,
        role: "client",
        name,
        phone,
        status: "active",
        warehouseIds: "[]",
        passwordHash,
        companyName,
        email,
        agentId: agentInput?.agentId ?? null,
      },
      select: { id: true, name: true, companyName: true, phone: true, email: true, createdAt: true, agentId: true },
    });

    ok(res, {
      id: created.id,
      name: created.name,
      companyName: created.companyName,
      phone: created.phone,
      email: created.email,
      createdAt: created.createdAt.toISOString(),
      agentId: created.agentId ?? null,
      agentName: agentInput?.agentName ?? null,
    });
  });

  app.post("/admin/users/client/update", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      companyName?: string;
      phone?: string;
      email?: string;
      password?: string;
      /** 2026-09-16：改所属代理。不传 = 不改；空 = 改回湘泰；只许客户还没有任何业务记录时改 */
      agentId?: string | null;
    };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "客户ID为必填");
      return;
    }
    const agentInput = await readAgentIdInput(body.agentId, auth.companyId);
    if (agentInput && "error" in agentInput) {
      fail(res, 400, "BAD_REQUEST", agentInput.error);
      return;
    }

    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, companyId: true, role: true },
    });
    if (!existing) {
      fail(res, 404, "NOT_FOUND", "客户不存在");
      return;
    }
    if (existing.companyId !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "无权修改其他公司的客户");
      return;
    }
    if (existing.role !== "client") {
      fail(res, 400, "BAD_REQUEST", "只能编辑客户账号");
      return;
    }

    const updateData: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) {
      updateData.name = body.name.trim();
    }
    if (body.companyName !== undefined) {
      updateData.companyName = typeof body.companyName === "string" ? body.companyName.trim() || null : null;
    }
    if (typeof body.phone === "string" && body.phone.trim()) {
      updateData.phone = body.phone.trim();
    }
    if (body.email !== undefined) {
      updateData.email = typeof body.email === "string" ? body.email.trim() || null : null;
    }
    if (typeof body.password === "string" && body.password.trim()) {
      updateData.passwordHash = hashPassword(body.password.trim());
    }

    if (Object.keys(updateData).length === 0 && !agentInput) {
      fail(res, 400, "BAD_REQUEST", "没有需要更新的字段");
      return;
    }

    const selectOut = { id: true, name: true, companyName: true, phone: true, email: true, createdAt: true, agentId: true } as const;
    const updated = !agentInput
      ? await prisma.user.update({ where: { id }, data: updateData, select: selectOut })
      : await prisma.$transaction(async (tx) => {
          /**
           * 改所属代理（2026-09-16）。锁序照 long-term-price.ts 文件头：**先拿客户价排队锁**，
           * 改长期价那边在锁里读 agentId 判代理价下限，两边排队才不会出现「按旧归属判下限、存进新归属」。
           * 往仓库版柜里加这个客户（customers/add、建柜）也先拿同一把锁，所以「查业务记录 → 改归属」
           * 这段不会被新加进柜的记录插队。建普通版集货任务（/client/consolidation/tasks）从 2026-09-16 第 2 轮审查起
           * 也先拿同一把锁、锁里现读 agentId，所以也不会插队。
           *
           * ⚠️ 新建运单不走这把锁（客户预报、员工建单、批量导入、改运单客户好几条路），所以还要**锁住客户这一行**
           * （2026-09-15，Codex 审查 P2-1 在测试库实测：锁里数完「0 张运单」、改归属提交之前插进一张运单，两边都成功）。
           * 靠的是 orders.client_id 指向 users 的外键（init 迁移 orders_client_id_fkey）：往 orders 写这个客户时，
           * PostgreSQL 会自动给客户这一行加 FOR KEY SHARE，跟这里的 FOR UPDATE 互斥 ——
           * 运单先写进来的，这里等它提交完再数，数得到；这里先锁住的，建单要等改归属提交完才写得进去（那就是改完归属才下的单）。
           * 生产库有没有这个外键，上线方案第 4 步在恢复库上核对；scripts/test-agent-portal-isolation.ts 用真 PostgreSQL 测这个时序。
           */
          await lockClientWhrPrice(tx, id);
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
          const fresh = await tx.user.findFirst({
            where: { id, companyId: auth.companyId, role: "client" },
            select: { agentId: true },
          });
          if (!fresh) throw new BusinessError("客户不存在", 404, "NOT_FOUND");
          const target = agentInput.agentId;
          if ((fresh.agentId ?? null) !== target) {
            const rec = await countClientBusinessRecords(tx, id, auth.companyId);
            if (rec.orders + rec.consolidationTasks + rec.whrPlans > 0) {
              const parts = [
                rec.orders > 0 ? `运单 ${rec.orders} 张` : "",
                rec.consolidationTasks > 0 ? `普通版集货 ${rec.consolidationTasks} 个` : "",
                rec.whrPlans > 0 ? `仓库版集货 ${rec.whrPlans} 个柜` : "",
              ].filter(Boolean);
              throw new BusinessError(
                `这个客户已经有业务记录（${parts.join("、")}），不能再改所属代理。只有刚开、还没下过单的客户才能改。`,
                409,
                "VALIDATION_ERROR",
              );
            }
            if (target) {
              /**
               * 只为确认「选的这个代理真存在、而且是本公司的」，顺手对 agents 那一行拿共享锁
               * （跟 setClientWhrPrice / assertPlanPricesNotBelowAgent 同一个锁法，锁序一致）。
               * ⚠️ 这里**不再核任何价格**（原因见下面那段），所以只查 id，别再顺手取那三档价
               *（取了会让下一个人以为这里还在比价 —— Opus 第三轮复核第 5 条）。
               */
              const agentRows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM agents WHERE id = ${target} AND company_id = ${auth.companyId} FOR SHARE`;
              if (!agentRows || agentRows.length === 0) {
                throw new BusinessError("选的代理不存在，请刷新页面后重新选", 400, "BAD_REQUEST");
              }
              /**
               * 2026-09-18：这里原来还有一道闸 ——「这个客户的**长期价**不能低于新代理价」。删掉了，原因：
               *  ① 长期价那套 9-18 已按老板要求停用（写接口一律 400、前端没入口、没人拿它定价），
               *     拿一个冻住的数去拦改归属，拦下来也没有人能去把它改高 —— 提示指向一条走不通的路。
               *  ② 真正要守的是「**柜里**的价不能低于代理价」，而那种客户根本走不到这里：
               *     上面「有业务记录就不许改归属」已经把「进过任何一个仓库版集货柜」的客户挡住了
               *     （countClientBusinessRecords 数的就是 whr_consolidation_plan_customers，不分状态）。
               * ⚠️ 这是**行为变化**，不是纯删死代码（Opus 第三轮复核第 9 条）：
               *   「有长期价那一行、但一张单一个柜都没有」的客户，以前 409 拦、现在放过。
               *   这种客户改归属之后不影响算钱（他名下没有柜，新柜的价由建柜 / 加客户当场填并过下限闸）。
               * 现在真正把关的是建柜 / 加客户 / 改单价那三处的 assertPlanPricesNotBelowAgent。
               */
            }
          }
          return tx.user.update({ where: { id }, data: { ...updateData, agentId: target }, select: selectOut });
        }, { timeout: 30000, maxWait: 10000 });

    // 这条路也能给客户重置密码 —— 跟 set-password 一样，重置成功就把
    // 登录失败计数清掉（2026-08-31，排查报告第34条），不然新密码照样被计数挡住。
    if (updateData.passwordHash) {
      clearLoginFailures(id);
    }

    ok(res, {
      id: updated.id,
      name: updated.name,
      companyName: updated.companyName,
      phone: updated.phone,
      email: updated.email,
      createdAt: updated.createdAt.toISOString(),
      agentId: updated.agentId ?? null,
    });
  });

  /**
   * 超管填 / 改客户长期价（2026-09-16，确认单 4.4 / 4.7 / 4.19）。
   *
   * 只许改**湘泰自己的客户**；客户归代理 → 403（代理的客户价只有代理能改，超管也不改）。
   * 改完「计划中/收货中/装柜中」柜里这位客户的单价跟着改，没付款的单重算（setClientWhrPrice 负责）。
   *
   * ⚠️ 「是不是代理的客户」必须在**客户价排队锁里**再判一次（CLAUDE.md #28）：
   *    事务外那次判断只配给个快提示；锁之前归属被改成代理，锁里不重判就会让超管改掉代理客户的价。
   *    setClientWhrPrice 里面还会再拿同一把锁（事务级 advisory 锁可重入，不会自己卡自己）。
   */
  app.post("/admin/clients/whr-price", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    // 同代理那条：功能关闭期间不许再从这里覆盖柜里当场填的价（2026-09-18）
    if (!LONG_TERM_PRICE_WRITE_ENABLED) return fail(res, 400, "BAD_REQUEST", LONG_TERM_PRICE_OFF_MESSAGE);

    const body = (req.body ?? {}) as {
      clientId?: string;
      unitPriceNormal?: unknown;
      unitPriceInspection?: unknown;
      unitPriceSensitive?: unknown;
    };
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!clientId) {
      fail(res, 400, "BAD_REQUEST", "请选择客户");
      return;
    }
    const rawPrices = { normal: body.unitPriceNormal, inspection: body.unitPriceInspection, sensitive: body.unitPriceSensitive };
    // 价不合法就别碰数据库（跟 setClientWhrPrice 同一套校验）
    let prices;
    try {
      prices = parseWhrPriceInput(rawPrices);
    } catch (e) {
      if (e instanceof BusinessError) {
        fail(res, 400, "BAD_REQUEST", e.message);
        return;
      }
      throw e;
    }

    const client = await prisma.user.findFirst({
      where: { id: clientId, companyId: auth.companyId, role: "client" },
      select: { id: true, agentId: true },
    });
    if (!client) {
      fail(res, 404, "NOT_FOUND", "客户不存在");
      return;
    }
    if (client.agentId) {
      fail(res, 403, "FORBIDDEN", AGENT_CLIENT_PRICE_READONLY_MESSAGE);
      return;
    }

    /**
     * 剩下的（客户价锁 → 锁里重判「是不是代理客户」→ 改价重算）在 long-term-price.ts 的
     * setNonAgentClientWhrPrice 里，这样功能关着的时候测试还能绕开开关直接测那道闸
     *（Opus 第三轮复核第 6 条）。
     */
    const result = await setNonAgentClientWhrPrice({
      companyId: auth.companyId,
      clientId,
      prices: rawPrices,
      actor: { userId: auth.userId, role: auth.role },
    });

    ok(res, {
      clientId,
      whrPrice: { normal: prices.normal, inspection: prices.inspection, sensitive: prices.sensitive },
      updatedPlanRows: result.updatedPlanRows,
    });
  });

  /**
   * 删除账号 —— 已停用（2026-08-07，用户决定）。
   *
   * 这条路本来就走不通：数据库有 15 张表以 RESTRICT 认着账号
   * （orders / client_addresses / client_wallet_accounts / order_product_images /
   *   audit_logs / consolidation_* / invoices …），名下有任何一条记录就删不掉，
   * 报出来是英文的 500，用户只看到「删除失败」。71 个客户里 62 个有订单，
   * 员工 888888 有 60 张上传过的产品图 —— 实际上谁都删不掉。
   *
   * 用户要的只是「让这个账号登不进来」，那是封禁（/admin/users/toggle-ban）的事，
   * 而且单据、图片、流水全留着，随时能解封。前端入口已改成封禁。
   *
   * ⚠️ 这里保留路由并明确拒绝，而不是直接删掉 —— 万一还有别的调用方，
   * 让它得到一句看得懂的中文，而不是 404。
   */
  app.delete("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    fail(
      res,
      403,
      "FORBIDDEN",
      "账号不支持删除（名下的订单、图片、流水都认着它）。请改用「封禁」——账号立刻登不进来，数据全留着，随时可以解除。",
    );
  });

  app.post("/admin/users/set-password", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { id?: string; password?: string };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "user id is required");
      return;
    }

    const password = body.password?.trim();
    if (!password) {
      fail(res, 400, "BAD_REQUEST", "password is required");
      return;
    }

    const row = await prisma.user.findUnique({
      where: { id },
      select: { id: true, companyId: true, role: true },
    });
    if (!row) {
      fail(res, 404, "NOT_FOUND", "user not found");
      return;
    }
    if (row.companyId !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "cannot update user of another company");
      return;
    }
    /**
     * ⚠️ 2026-08-31（复查）：白名单放开 admin —— 管理员锁号原来无解才加的。
     * 管理员账号被连错 20 次锁 30 分钟时，登录提示照样说「找管理员重置密码」，
     * 但这条路原来写死只收 staff/client，client/update 又只收客户 ——
     * 系统里没有任何一条路能给管理员账号重置密码顺带清计数，唯一逃生口
     * 是他恰好在别处还留着已登录的会话去自助改密码。现在另一个管理员
     * 可以在这里救他。操作者必须是 admin 这一层，上面的 requireRole 已经保证；
     * 且只能动本公司账号（上面的 companyId 检查）。
     */
    // 2026-09-16：白名单加 agent（确认单 2.9：代理忘了密码找超管重置）
    if (row.role !== "staff" && row.role !== "client" && row.role !== "admin" && row.role !== "agent") {
      fail(res, 403, "FORBIDDEN", "only staff, client, admin or agent password can be set here");
      return;
    }

    // 2026-08-07：员工账号不许再设弱口令。当天普查出 3 个员工账号的密码
    // 是「888888」「跟账号名一样」这种，员工端能看到全部客户和运单，风险比客户账号大。
    // ⚠️ 客户账号沿用旧规则（不校验强度）—— 用户明确要求先不动客户那边，
    //    他们的密码普遍就是唛头本身，一刀切会让 66 个客户当场登不进去。
    // 2026-08-31：admin 走这条路后也要卡强度 —— 管理员能看到的比员工还多，
    // 不能反过来允许给管理员账号设弱口令。
    // 2026-09-16：代理账号也卡强度（确认单 2.9：他能看到名下所有客户和返现）；代理的客户照客户规矩不卡
    if (row.role === "staff" || row.role === "admin" || row.role === "agent") {
      const weakReason = checkPasswordStrength(password, undefined, id);
      if (weakReason) {
        fail(res, 400, "BAD_REQUEST", weakReason);
        return;
      }
    }

    const passwordHash = hashPassword(password);
    await prisma.user.update({ where: { id }, data: { passwordHash } });
    /**
     * ⚠️ 重置成功要顺手把登录失败计数清零（2026-08-31，排查报告第34条）。
     * 账号被连错 20 次锁 30 分钟时，登录提示让人「找管理员重置密码」——
     * 但原来重置只换密码不清计数，拿着新密码来还是被计数挡回去，
     * 提示指的是条死路。计数的键就是登录账号原样（见 core/rate-limit.ts），
     * 和这里的 id 同一口径，清的正是这个人的桶。
     */
    clearLoginFailures(id);
    ok(res, { updated: true, id });
  });

  /**
   * 禁用/启用用户（管理员）。
   */
  app.post("/admin/users/toggle-ban", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { id?: string };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "user id is required");
      return;
    }

    const row = await prisma.user.findUnique({
      where: { id },
      select: { id: true, companyId: true, status: true, role: true },
    });
    if (!row) {
      fail(res, 404, "NOT_FOUND", "user not found");
      return;
    }
    if (row.companyId !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "cannot toggle user of another company");
      return;
    }
    // 2026-08-07：封禁成了停用账号的唯一手段，这道保险更要紧了。
    // 全系统只有一个管理员账号，一旦把它封了就再也登不进后台，
    // 只能直接进数据库改状态才能救回来。管理员一律不许封。
    if (row.role === "admin") {
      fail(res, 403, "FORBIDDEN", "管理员账号不能封禁，否则会把自己锁在系统外面");
      return;
    }

    const newStatus = row.status === "active" ? "inactive" : "active";
    await prisma.user.update({ where: { id }, data: { status: newStatus } });
    ok(res, { id, status: newStatus });
  });

  /**
   * 管理员删除运单（级联删除状态日志、产品图、产品行、运单本身、订单）
   */
  app.post("/admin/orders/delete", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { orderId?: string };
    const orderId = body.orderId?.trim();
    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      include: { shipments: { select: { id: true } } },
    });
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }

    // 事务：级联清理所有关联记录后删除订单
    await prisma.$transaction(async (tx) => {
      /**
       * ⚠️⚠️ **先锁订单，再把运单清单在锁里重读一遍**（2026-08-29 补）。
       *
       * 原来这条路一把锁都没有，而且拿的是**事务外**读到的那份 order.shipments：
       *   · 读完到删完之间新分出来的子单不在清单里 → 它还挂着这个 orderId，
       *     最后那句 order.delete 撞外键 → 整个请求 500，员工只看到「服务器繁忙」；
       *   · 两个人同时删同一张订单，第二个人删已经不存在的行 → 同样 500；
       *   · 逐个删运单时行锁是按循环顺序取的，而装柜/推进柜子是
       *     `[...ids].sort()` 有序取 —— 方向不固定，会跟它们死锁。
       *
       * 「锁只保证不同时，不保证数据没变」（CLAUDE.md 第 28 条）：
       * 所以锁完必须**重读**，不能接着用锁之前那份清单。
       */
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} AND company_id = ${auth.companyId} FOR UPDATE`;
      const freshShipments = await tx.shipment.findMany({
        where: { orderId, companyId: auth.companyId },
        select: {
          id: true,
          parentTrackingNo: true,
          containerItems: { select: { container: { select: { isFcl: true } } } },
        },
      });
      /* 整柜的单不许从这里删（2026-09-23 复核抓到）：
         删完运单和订单，那个 isFcl 的柜子还留着 —— 客户那边整柜当场消失，
         而柜子状态已经不是「装柜中」、删柜又只允许「装柜中」，
         于是留下一个永远删不掉的空壳柜，还一直占着柜号。
         锁内重读判断（CLAUDE.md 第 28 条）。 */
      if (freshShipments.some((s) => s.containerItems.some((it) => it.container?.isFcl))) {
        throw new BusinessError(FCL_BLOCKED_MESSAGE, 400, "VALIDATION_ERROR");
      }
      const shipmentIdsToDelete = freshShipments.map((s) => s.id);
      /**
       * 按 id 排序逐个上锁 —— 顺序必须跟装柜/推进柜子那两条路一致，不然会反向等待。
       * ⚠️ 排序写在 `.sort()` 上、不靠 SQL 的 orderBy：test-lock-order 第 6 项
       * 就是按「取锁的循环里必须看得见 .sort()」查的，规则统一才不会有人漏。
       */
      /**
       * 锁序【订单 → 派送单 → 运单 → 父单】（2026-08-29 补）。
       * 派送单要排在运单**前面**：签收那条路（admin-ops/routes.ts）是
       * 先锁派送单再锁运单，这里反过来的话，删单和签收同时点就成环。
       */
      const lastmileIds = (
        await tx.adminLastmileOrder.findMany({
          where: { shipmentId: { in: shipmentIdsToDelete } },
          select: { id: true },
        })
      ).map((r) => r.id);
      for (const lid of [...lastmileIds].sort()) {
        await tx.$queryRaw`SELECT id FROM admin_lastmile_orders WHERE id = ${lid} FOR UPDATE`;
      }
      /**
       * ⚠️⚠️ **必须「先锁完全部子单，再锁全部父单」**（2026-08-29 第七轮复核之后改的）。
       *
       * 上一轮我是把父单子单**混在一起按 id 排序**逐个锁。
       * 而系统里其它所有路径都是「子单（按 id 排）→ 父单（按单号排）」
       * （containers/routes.ts ~429/490、admin-ops 建派送单、
       *   syncParentStatusFromChildren 内部那把）。
       * 一旦某个父单的 id 恰好排在它子单前面，这条路就先拿父单、别处先拿子单，
       * **方向相反**。复核在本地库开两个连接实测，PostgreSQL 报 `deadlock detected`。
       *
       * 「按 id 全排一遍」看着很整齐，但整齐 ≠ 跟别人一致 —— 锁序只有
       * **全系统同一个顺序**才有意义，自己一套排法等于没排。
       */
      // 走共用函数（2026-08-29 第八轮统一）：分层逻辑只留一份，
      // 免得每个调用点各写各的、又出现「我推理说这里不会有父单」那种事
      await lockShipmentsChildrenFirst(tx, shipmentIdsToDelete, auth.companyId);
      for (const s of freshShipments) {
        await tx.adminCustomsCase.updateMany({ where: { shipmentId: s.id }, data: { shipmentId: null } });
        await tx.adminLastmileOrder.deleteMany({ where: { shipmentId: s.id } });
        await tx.warehouseLocation.updateMany({ where: { shipmentId: s.id }, data: { shipmentId: null } });
        await tx.staffInboundPhoto.deleteMany({ where: { shipmentId: s.id } });
        await tx.statusLog.deleteMany({ where: { shipmentId: s.id } });
        await tx.shipmentContainerItem.deleteMany({ where: { shipmentId: s.id } });
        await tx.delivery.deleteMany({ where: { shipmentId: s.id } });
        await tx.shipment.delete({ where: { id: s.id } });
      }
      // Order 级别的 FK 清理
      await tx.adminCustomsCase.updateMany({ where: { orderId }, data: { orderId: null } });
      await tx.invoiceLine.updateMany({ where: { orderId }, data: { orderId: null } });
      await tx.adminSettlementEntry.deleteMany({ where: { orderId } });
      await tx.orderProductImage.deleteMany({ where: { orderId } });
      await tx.orderProduct.deleteMany({ where: { orderId } });
      await tx.order.delete({ where: { id: orderId } });
    });

    ok(res, { deleted: true, orderId, itemName: order.itemName });
  });

  // ===== 管理员：充值审核列表 =====
  app.get("/admin/wallet/recharges", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const statusFilter = (req.query?.status ?? "") as string;
    const where: any = { companyId: auth.companyId };
    if (statusFilter && ["PENDING", "APPROVED", "REJECTED"].includes(statusFilter)) {
      where.status = statusFilter;
    }
    const rows = await prisma.walletRecharge.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        clientId: true,
        currency: true,
        amount: true,
        paymentMethod: true,
        proofImage: true,
        status: true,
        remark: true,
        reviewRemark: true,
        reviewedBy: true,
        createdAt: true,
        updatedAt: true,
        client: { select: { companyName: true } },
        reviewer: { select: { name: true } },
      },
    });
    ok(res, {
      recharges: rows.map((r) => ({
        id: r.id,
        clientId: r.clientId,
        companyName: r.client.companyName,
        currency: r.currency,
        amount: Number(r.amount.toString()),
        paymentMethod: r.paymentMethod,
        proofImage: r.proofImage,
        status: r.status,
        remark: r.remark,
        reviewRemark: r.reviewRemark,
        reviewedBy: r.reviewedBy,
        reviewerName: r.reviewer?.name ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  });

  // ===== 管理员：通过充值申请 =====
  app.post("/admin/wallet/recharges/approve", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { id?: string };
    const id = body.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "缺少充值ID"); return; }

    const recharge = await prisma.walletRecharge.findFirst({
      where: { id, companyId: auth.companyId },
    });
    if (!recharge) { fail(res, 404, "NOT_FOUND", "充值记录不存在"); return; }
    if (recharge.status !== "PENDING") {
      fail(res, 400, "BAD_REQUEST", "该充值申请已处理过");
      return;
    }

    await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁住再复查一遍状态（2026-08-27 补）。
       * 上面那道「已处理过就拦」是在事务外面做的：两个管理员同时点「通过」，
       * 两边都读到 PENDING，各自给客户加一次钱 —— **客户余额凭空多一倍**，
       * 流水也多一行。跟「重复退款」是同一类洞，只是这条是往里加钱。
       */
      await tx.$queryRaw`SELECT id FROM wallet_recharges WHERE id = ${id} FOR UPDATE`;
      const fresh = await tx.walletRecharge.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!fresh) throw new BusinessError("充值记录不存在", 404, "NOT_FOUND");
      if (fresh.status !== "PENDING") {
        throw new BusinessError("这笔充值刚刚已经被处理过了，没有重复入账，请刷新后再看");
      }

      // 更新充值状态
      await tx.walletRecharge.update({
        where: { id },
        data: { status: "APPROVED", reviewedBy: auth.userId },
      });
      // 增加客户端对应币种余额
      await tx.clientWalletAccount.upsert({
        where: {
          clientId_currency: {
            clientId: recharge.clientId,
            currency: recharge.currency,
          },
        },
        create: {
          clientId: recharge.clientId,
          companyId: recharge.companyId,
          currency: recharge.currency,
          balance: recharge.amount,
        },
        update: {
          balance: { increment: recharge.amount },
        },
      });
      // 2026-08-07：钱到账要记一行流水，客户才对得上账。
      // 只有人民币才是集货余额，历史遗留的其它币种不记流水。
      if (recharge.currency === CONSOLIDATION_CURRENCY) {
        await recordRechargeCredit(tx as any, {
          companyId: recharge.companyId,
          clientId: recharge.clientId,
          amount: Number(recharge.amount),
          refType: "recharge",
          refId: recharge.id,
          refNo: recharge.id,
          remark: "充值审核通过",
          operatorId: auth.userId,
          operatorName: auth.name || auth.userId,
        });
      }
    });

    ok(res, { approved: true, id });
  });

  // ===== 管理员：拒绝充值申请 =====
  app.post("/admin/wallet/recharges/reject", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { id?: string; reviewRemark?: string };
    const id = body.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "缺少充值ID"); return; }
    const reviewRemark = (body.reviewRemark ?? "").trim();
    if (!reviewRemark) {
      fail(res, 400, "BAD_REQUEST", "请填写拒绝原因");
      return;
    }

    const recharge = await prisma.walletRecharge.findFirst({
      where: { id, companyId: auth.companyId },
    });
    if (!recharge) { fail(res, 404, "NOT_FOUND", "充值记录不存在"); return; }
    if (recharge.status !== "PENDING") {
      fail(res, 400, "BAD_REQUEST", "该充值申请已处理过");
      return;
    }

    /**
     * ⚠️ 必须「只有还是待处理才改得动」（2026-08-27 补）。
     * 原来是无条件改成 REJECTED：另一个管理员正好同时点了「通过」，
     * 钱已经加进客户账户了，这边再把记录改成「已拒绝」——
     * 账面上是拒了，钱却实实在在进去了，对不上账还查不出来。
     * 把 status 写进 where，数据库自己保证只有一个人能改成功。
     */
    const rejected = await prisma.walletRecharge.updateMany({
      where: { id, companyId: auth.companyId, status: "PENDING" },
      data: { status: "REJECTED", reviewRemark, reviewedBy: auth.userId },
    });
    if (rejected.count === 0) {
      fail(res, 400, "BAD_REQUEST", "这笔充值刚刚已经被处理过了，请刷新后再看");
      return;
    }

    ok(res, { rejected: true, id });
  });

  // ===== 员工端：查看所有客户余额 =====
  app.get("/staff/wallet/balances", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const accounts = await prisma.clientWalletAccount.findMany({
      where: { companyId: auth.companyId },
      orderBy: { clientId: "asc" },
      select: {
        clientId: true,
        currency: true,
        balance: true,
        updatedAt: true,
      },
    });
    // 查客户公司名（页面上客户只显示唛头，不查名字，2026-09-19）
    const clientIds = [...new Set(accounts.map((a) => a.clientId))];
    const users = await prisma.user.findMany({
      where: { id: { in: clientIds }, companyId: auth.companyId },
      select: { id: true, companyName: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    // 按客户分组
    const map = new Map<string, { cny: number; thb: number }>();
    for (const a of accounts) {
      if (!map.has(a.clientId)) map.set(a.clientId, { cny: 0, thb: 0 });
      const entry = map.get(a.clientId)!;
      if (a.currency === "CNY") entry.cny = Number(a.balance.toString());
      if (a.currency === "THB") entry.thb = Number(a.balance.toString());
    }

    ok(res, {
      balances: [...map.entries()].map(([clientId, b]) => ({
        clientId,
        companyName: userMap.get(clientId)?.companyName ?? "",
        cny: b.cny,
        thb: b.thb,
      })),
    });
  });

  // ===== 管理员：线下付款审核列表 =====

  // ===== 管理员：通过线下付款 =====

  // ===== 管理员：拒绝线下付款 =====

}
