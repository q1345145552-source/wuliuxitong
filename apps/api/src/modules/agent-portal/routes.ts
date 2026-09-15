/* ==========================================================================
   代理工作台接口 /agent/*（2026-09-16，B3）
   --------------------------------------------------------------------------
   需求：docs/交接文档-附件-代理账号确认单/final.md 第 3 节（不进 git）；做法见同目录「做法-技术设计.md」第 6 节。

   铁规矩（改这个文件前逐条看）：
   1. 每个接口第一句 requireAgent；数据一律按「这个代理名下的客户」查（users.agent_id = 代理、role=client、同公司）。
      服务端统一闸（server.ts）已经保证 agent 令牌只能碰 /agent/* 和 /auth/*，这里是第二道。
   2. 查不到统一回 404「…不存在」—— 不许区分「没有这个东西」和「不是你名下的」。
   3. 给代理的每个字段**逐个列出来**，不许 `...row`（CLAUDE.md #31）。
   4. 一律不给：柜号（containerNo / batchNo，3.11 暂缓）、员工名 / 操作人（3.5）、
      内部备注（运单 remark、client_notes、整柜询价备注，3.9）、整柜已用方数、别的客户（3.3）、
      谁改的价（updatedBy / updatedByRole）、谁点的「已返」（paidBy）。
   5. 代理只读（3.1）。唯一的写：POST /agent/clients/price 给名下客户填长期价（4.3 / 4.7）。
   6. 名下客户列表为空时直接回空，**绝不**把空数组塞进 `in: []` 以外的写法（CLAUDE.md #27）。
   ========================================================================== */

import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { HttpRequest, MinimalHttpApp } from "../../server";
import { fail, ok } from "../core/http-utils";
import { requireAgent, type AgentAuth } from "../core/agent-scope";
import { BusinessError } from "../core/business-error";
import { CONSOLIDATION_CURRENCY } from "../wallet/consolidation-balance";
import { lockClientWhrPrice, parseWhrPriceInput, setClientWhrPrice } from "../whr-consolidation/long-term-price";
import { buildFeeBreakdown, deriveLatestStatus } from "../whr-consolidation/utils";
import { loadOrderTotalMetrics } from "../shipments/total-metrics";
import { productNamesLabel } from "../../../../../packages/shared-types/product-names";
import { classifyStatusGroup, matchesShipmentListFilter } from "../../../../../packages/shared-types/shipment-status";
import {
  ADDRESS_NEEDED_PLAN_STATUSES,
  UNPAID_PREALERT_STATUSES,
  iso,
  isMissingSize,
  joinDims,
  mapProofs,
  mapRebateLine,
  mapRebateStatement,
  num,
  numOrNull,
  parseDateParam,
  parsePageParam,
  remarkForAgent,
} from "./views";

/** 运单列表口径跟 /client/orders 一致（CLAUDE.md #8b 三端对齐）：只列审过的单 */
const VISIBLE_APPROVAL_STATUSES = ["approved", "shipped"];
/** 导出一次最多多少条；超过让他缩小日期范围（前端提示），不静默截断（CLAUDE.md #21） */
const EXPORT_MAX_ROWS = 5000;
/** 查不到时统一的说法：不区分「不存在」和「不是你名下的」 */
const NOT_FOUND = "不存在或不在你名下";

interface AgentClientRow {
  id: string;
  name: string;
}

/** 这个代理名下的客户（id + 名字）。条件跟 core/agent-scope.ts 的 listAgentClientIds 完全一样 */
async function loadAgentClients(auth: AgentAuth): Promise<AgentClientRow[]> {
  if (!auth.agentId || !auth.companyId) return [];
  return prisma.user.findMany({
    where: { agentId: auth.agentId, companyId: auth.companyId, role: "client" },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });
}

function queryText(req: HttpRequest, key: string, maxLen = 100): string | undefined {
  const raw = req.query[key];
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  return text.slice(0, maxLen);
}

/* ─────────────── 运单 ─────────────── */

/** 'YYYY-MM-DD' 的第二天，同样格式（按日历算，不牵扯时区） */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

interface ShipmentFilters {
  trackingNo?: string;
  clientId?: string;
  statusGroup?: string;
  keyword?: string;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * 按名下客户 + 筛选条件，拿到**全部**命中订单的 id（按建单时间倒序）。
 * 分组（在途 / 已到仓 …）是按运单状态实时算的，没法下推到 where，
 * 所以先只取 id + 父单状态这两样把全集筛完、数出真实 total，再按页去拉明细 ——
 * 不能「拉一页回来在前端筛」（CLAUDE.md #19，尾端派送丢过 445 张单）。
 */
async function listScopedOrderIds(
  auth: AgentAuth,
  clientIds: string[],
  filters: ShipmentFilters,
): Promise<string[]> {
  if (clientIds.length === 0) return [];
  if (filters.clientId && !clientIds.includes(filters.clientId)) return [];
  const where: Prisma.OrderWhereInput = {
    companyId: auth.companyId,
    clientId: filters.clientId ? filters.clientId : { in: clientIds },
    approvalStatus: { in: VISIBLE_APPROVAL_STATUSES },
    ...(filters.trackingNo ? { shipments: { some: { trackingNo: filters.trackingNo, companyId: auth.companyId } } } : {}),
    ...(filters.keyword
      ? {
          OR: [
            { itemName: { contains: filters.keyword } },
            { domesticTrackingNo: { contains: filters.keyword } },
            { products: { some: { itemName: { contains: filters.keyword } } } },
          ],
        }
      : {}),
    ...(filters.dateFrom || filters.dateTo
      ? {
          // 跟管理端「导出 Excel」同一个口径：按到仓日期 shipDate（'YYYY-MM-DD…' 字符串）比
          shipDate: {
            ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
            // shipDate 有的只存日期、有的带时间：用「小于第二天」而不是「小于等于当天」，当天带时间的也算进去
            ...(filters.dateTo ? { lt: nextDay(filters.dateTo) } : {}),
          },
        }
      : {}),
  };
  const rows = await prisma.order.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      shipments: {
        // 父单优先，跟 /client/orders 一样
        orderBy: [{ parentTrackingNo: { sort: "asc", nulls: "first" } }, { updatedAt: "desc" }],
        take: 1,
        select: { currentStatus: true },
      },
    },
  });
  const group = filters.statusGroup;
  return rows
    .filter((o) => {
      if (!group || group === "all") return true;
      const status = o.shipments[0]?.currentStatus;
      if (group === "attention") return matchesShipmentListFilter(status, "attention");
      return classifyStatusGroup(status) === group;
    })
    .map((o) => o.id);
}

/** 按 id 拉订单明细，逐字段给代理。顺序跟 orderIds 一致 */
async function loadShipmentRows(auth: AgentAuth, orderIds: string[], clientNames: Map<string, string>) {
  if (orderIds.length === 0) return [];
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds }, companyId: auth.companyId, clientId: { in: [...clientNames.keys()] } },
    select: {
      id: true,
      clientId: true,
      orderNo: true,
      approvalStatus: true,
      itemName: true,
      productQuantity: true,
      packageCount: true,
      packageUnit: true,
      weightKg: true,
      volumeM3: true,
      transportMode: true,
      domesticTrackingNo: true,
      cargoType: true,
      shipDate: true,
      receiverNameTh: true,
      receiverPhoneTh: true,
      receiverAddressTh: true,
      createdAt: true,
      updatedAt: true,
      // ⚠️ 不选 batchNo（柜号）、receivableAmountCny（湘泰给普通运单的加收，不在 3.2 能看的清单里）
      products: {
        orderBy: { sortOrder: "asc" },
        select: {
          itemName: true,
          packageCount: true,
          productQuantity: true,
          lengthCm: true,
          widthCm: true,
          heightCm: true,
          weightKg: true,
          cargoType: true,
          domesticTrackingNo: true,
          sortOrder: true,
        },
      },
      shipments: {
        orderBy: [{ parentTrackingNo: { sort: "asc", nulls: "first" } }, { updatedAt: "desc" }],
        take: 1,
        // ⚠️ 不选 remark（员工写的运单备注是内部的）、batchNo / containerNo（柜号）
        select: { id: true, trackingNo: true, currentStatus: true, updatedAt: true },
      },
    },
  });
  const metrics = await loadOrderTotalMetrics(
    auth.companyId,
    orders.map((o) => ({ orderId: o.id, orderVolumeM3: o.volumeM3, orderWeightKg: o.weightKg })),
  );
  const byId = new Map(orders.map((o) => [o.id, o]));
  return orderIds
    .map((id) => byId.get(id))
    .filter((o): o is (typeof orders)[number] => Boolean(o))
    .map((o) => {
      const ship = o.shipments[0];
      const m = metrics.get(o.id);
      return {
        id: o.id,
        clientId: o.clientId,
        clientName: clientNames.get(o.clientId) ?? "",
        orderNo: o.orderNo,
        approvalStatus: o.approvalStatus,
        shipmentId: ship?.id ?? null,
        trackingNo: ship?.trackingNo ?? null,
        currentStatus: ship?.currentStatus ?? null,
        statusGroup: classifyStatusGroup(ship?.currentStatus),
        itemName: o.itemName,
        productNames: productNamesLabel(o.products, o.itemName),
        productQuantity: o.productQuantity,
        packageCount: o.packageCount,
        packageUnit: o.packageUnit,
        weightKg: numOrNull(o.weightKg),
        volumeM3: numOrNull(o.volumeM3),
        totalWeightKg: numOrNull(m?.totalWeightKg),
        totalVolumeM3: numOrNull(m?.totalVolumeM3),
        lengthCm: joinDims(o.products.map((p) => p.lengthCm)),
        widthCm: joinDims(o.products.map((p) => p.widthCm)),
        heightCm: joinDims(o.products.map((p) => p.heightCm)),
        transportMode: o.transportMode,
        domesticTrackingNo: o.domesticTrackingNo,
        cargoType: o.cargoType,
        shipDate: o.shipDate,
        receiverNameTh: o.receiverNameTh,
        receiverPhoneTh: o.receiverPhoneTh,
        receiverAddressTh: o.receiverAddressTh,
        products: o.products.map((p) => ({
          itemName: p.itemName,
          packageCount: p.packageCount,
          productQuantity: p.productQuantity,
          lengthCm: p.lengthCm,
          widthCm: p.widthCm,
          heightCm: p.heightCm,
          weightKg: p.weightKg,
          cargoType: p.cargoType,
          domesticTrackingNo: p.domesticTrackingNo,
        })),
        createdAt: o.createdAt.toISOString(),
        updatedAt: (ship && ship.updatedAt > o.updatedAt ? ship.updatedAt : o.updatedAt).toISOString(),
      };
    });
}

function readShipmentFilters(req: HttpRequest): ShipmentFilters | string {
  const statusGroup = queryText(req, "statusGroup", 20);
  if (statusGroup && !["all", "pending", "transit", "arrived", "delivered", "closed", "attention"].includes(statusGroup)) {
    return "状态分组不对";
  }
  const dateFrom = parseDateParam(req.query.dateFrom);
  const dateTo = parseDateParam(req.query.dateTo);
  if (dateFrom === null || dateTo === null) return "日期格式应为 YYYY-MM-DD";
  if (dateFrom && dateTo && dateFrom > dateTo) return "起始日期晚于截止日期";
  return {
    trackingNo: queryText(req, "trackingNo", 60),
    clientId: queryText(req, "clientId", 100),
    statusGroup,
    keyword: queryText(req, "keyword", 60),
    dateFrom,
    dateTo,
  };
}

/* ─────────────── 注册 ─────────────── */

export function registerAgentPortalRoutes(app: MinimalHttpApp): void {
  /* ===== 我的价格 / 品牌（3.4）。B4 的品牌钩子读这里的 name / logoUrl ===== */
  app.get("/agent/me", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const agent = await prisma.agent.findFirst({
      where: { id: auth.agentId, companyId: auth.companyId },
      select: {
        name: true,
        logoPath: true,
        slug: true,
        customDomain: true,
        priceNormal: true,
        priceInspection: true,
        priceSensitive: true,
      },
    });
    if (!agent) {
      fail(res, 404, "NOT_FOUND", `代理${NOT_FOUND}`);
      return;
    }
    ok(res, {
      name: agent.name,
      logoUrl: agent.logoPath ?? null,
      slug: agent.slug ?? null,
      customDomain: agent.customDomain ?? null,
      prices: { normal: num(agent.priceNormal), inspection: num(agent.priceInspection), sensitive: num(agent.priceSensitive) },
    });
  });

  /* ===== 首页：卡住的单（3.10） ===== */
  app.get("/agent/dashboard", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const clients = await loadAgentClients(auth);
    const clientNames = new Map(clients.map((c) => [c.id, c.name]));
    const clientIds = clients.map((c) => c.id);
    if (clientIds.length === 0) {
      ok(res, { clientCount: 0, missingSize: [], missingAddress: [], unpaid: [] });
      return;
    }

    const prealerts = await prisma.whrConsolidationPrealert.findMany({
      where: {
        companyId: auth.companyId,
        status: { in: ["pending", ...UNPAID_PREALERT_STATUSES] },
        planCustomer: { companyId: auth.companyId, clientId: { in: clientIds } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 2000,
      select: {
        id: true,
        trackingNo: true,
        mark: true,
        status: true,
        totalFee: true,
        signedAt: true,
        createdAt: true,
        planCustomer: { select: { clientId: true, planId: true, plan: { select: { planNo: true } } } },
        items: { select: { lengthCm: true, widthCm: true, heightCm: true, volumeM3: true } },
      },
    });
    const mapPrealert = (p: (typeof prealerts)[number]) => ({
      prealertId: p.id,
      trackingNo: p.trackingNo,
      mark: p.mark,
      status: p.status,
      clientId: p.planCustomer.clientId,
      clientName: clientNames.get(p.planCustomer.clientId) ?? "",
      planId: p.planCustomer.planId,
      planNo: p.planCustomer.plan.planNo,
      totalFee: numOrNull(p.totalFee),
      signedAt: iso(p.signedAt),
      createdAt: p.createdAt.toISOString(),
    });

    const noAddressRows = await prisma.whrConsolidationPlanCustomer.findMany({
      where: {
        companyId: auth.companyId,
        clientId: { in: clientIds },
        OR: [{ deliveryAddress: null }, { deliveryAddress: "" }],
        plan: { status: { in: [...ADDRESS_NEEDED_PLAN_STATUSES] } },
        prealerts: { some: { status: { not: "cancelled" } } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 500,
      select: {
        clientId: true,
        planId: true,
        plan: { select: { planNo: true, status: true } },
        prealerts: { where: { status: { not: "cancelled" } }, select: { id: true } },
      },
    });

    ok(res, {
      clientCount: clientIds.length,
      missingSize: prealerts.filter((p) => isMissingSize(p.status, p.items)).map(mapPrealert),
      missingAddress: noAddressRows
        .map((r) => ({
          clientId: r.clientId,
          clientName: clientNames.get(r.clientId) ?? "",
          planId: r.planId,
          planNo: r.plan.planNo,
          planStatus: r.plan.status,
          prealertCount: r.prealerts.length,
        })),
      unpaid: prealerts.filter((p) => (UNPAID_PREALERT_STATUSES as readonly string[]).includes(p.status)).map(mapPrealert),
    });
  });

  /* ===== 运单列表（3.2） ===== */
  app.get("/agent/shipments", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const page = parsePageParam(req.query.page, 1);
    if (page === null) { fail(res, 400, "BAD_REQUEST", "页码不合法"); return; }
    const pageSizeRaw = parsePageParam(req.query.pageSize, 50);
    if (pageSizeRaw === null) { fail(res, 400, "BAD_REQUEST", "每页条数不合法"); return; }
    const pageSize = Math.min(pageSizeRaw, 200);
    const filters = readShipmentFilters(req);
    if (typeof filters === "string") { fail(res, 400, "BAD_REQUEST", filters); return; }

    const clients = await loadAgentClients(auth);
    const clientNames = new Map(clients.map((c) => [c.id, c.name]));
    const allIds = await listScopedOrderIds(auth, clients.map((c) => c.id), filters);
    const pageIds = allIds.slice((page - 1) * pageSize, page * pageSize);
    const items = await loadShipmentRows(auth, pageIds, clientNames);
    ok(res, {
      items,
      page,
      pageSize,
      total: allIds.length,
      // 下拉筛选用：名下客户（唛头 + 名字）
      clients: clients.map((c) => ({ clientId: c.id, name: c.name })),
    });
  });

  /* ===== 导出 Excel 的数据（3.8）：跟列表同一套名下范围 ===== */
  app.get("/agent/shipments/export-data", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const filters = readShipmentFilters(req);
    if (typeof filters === "string") { fail(res, 400, "BAD_REQUEST", filters); return; }
    // 勾选导出：前端传勾中的订单 id（逗号分隔）；不在名下的 id 直接丢掉（等同查不到）
    const idsRaw = typeof req.query.orderIds === "string" ? req.query.orderIds : "";
    const pickedIds = idsRaw ? [...new Set(idsRaw.split(",").map((s) => s.trim()).filter(Boolean))] : null;
    if (pickedIds && pickedIds.length > EXPORT_MAX_ROWS) {
      fail(res, 400, "BAD_REQUEST", `一次最多导出 ${EXPORT_MAX_ROWS} 条`);
      return;
    }

    const clients = await loadAgentClients(auth);
    const clientNames = new Map(clients.map((c) => [c.id, c.name]));
    let ids = await listScopedOrderIds(auth, clients.map((c) => c.id), filters);
    if (pickedIds) {
      const picked = new Set(pickedIds);
      ids = ids.filter((id) => picked.has(id));
    }
    if (ids.length > EXPORT_MAX_ROWS) {
      fail(res, 400, "BAD_REQUEST", `符合条件的运单有 ${ids.length} 条，一次最多导出 ${EXPORT_MAX_ROWS} 条，请缩小日期范围`);
      return;
    }
    const items: Awaited<ReturnType<typeof loadShipmentRows>> = [];
    // 分批拉，避免 in 列表太长
    for (let i = 0; i < ids.length; i += 500) {
      items.push(...(await loadShipmentRows(auth, ids.slice(i, i + 500), clientNames)));
    }
    ok(res, { items, total: items.length });
  });

  /* ===== 物流轨迹（3.2 / 3.5 / 3.11）：先判归属，再给客户视角 ===== */
  app.get("/agent/shipments/track", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const shipmentId = queryText(req, "shipmentId", 100);
    const trackingNo = queryText(req, "trackingNo", 100);
    if (!shipmentId && !trackingNo) {
      fail(res, 400, "BAD_REQUEST", "shipmentId or trackingNo is required");
      return;
    }
    const clients = await loadAgentClients(auth);
    const clientIds = clients.map((c) => c.id);
    if (clientIds.length === 0) {
      fail(res, 404, "NOT_FOUND", `运单${NOT_FOUND}`);
      return;
    }

    // ⚠️ 归属条件直接写进 where：别家客户的单和不存在的单走同一条 404
    const shipment = await prisma.shipment.findFirst({
      where: {
        ...(shipmentId ? { id: shipmentId } : { trackingNo }),
        companyId: auth.companyId,
        order: { companyId: auth.companyId, clientId: { in: clientIds } },
      },
      select: {
        id: true,
        trackingNo: true,
        parentTrackingNo: true,
        currentStatus: true,
        volumeM3: true,
        createdAt: true,
        updatedAt: true,
        order: {
          select: {
            orderNo: true,
            clientId: true,
            itemName: true,
            cargoType: true,
            receiverNameTh: true,
            receiverAddressTh: true,
            products: { orderBy: { sortOrder: "asc" }, select: { itemName: true, packageCount: true, sortOrder: true } },
          },
        },
        // 混装柜：只取「这张运单自己」装进去的那几条，只要日期和状态，不要柜号、不要柜里别人的货
        containerItems: {
          orderBy: { createdAt: "asc" },
          select: {
            container: {
              select: {
                currentStatus: true,
                loadingDate: true,
                departureDate: true,
                ata: true,
                customsClearedAt: true,
              },
            },
          },
        },
        statusLogs: {
          orderBy: { changedAt: "asc" },
          // ⚠️ 不选 operatorId / operatorName / operatorRole（3.5）
          select: { fromStatus: true, toStatus: true, remark: true, nextStop: true, changedAt: true },
        },
      },
    });
    if (!shipment || !shipment.order) {
      fail(res, 404, "NOT_FOUND", `运单${NOT_FOUND}`);
      return;
    }

    const childShipments = shipment.parentTrackingNo
      ? []
      : await prisma.shipment.findMany({
          where: { parentTrackingNo: shipment.trackingNo, companyId: auth.companyId },
          orderBy: { trackingNo: "asc" },
          select: {
            trackingNo: true,
            packageCount: true,
            itemName: true,
            currentStatus: true,
            statusLogs: {
              orderBy: { changedAt: "asc" },
              select: { fromStatus: true, toStatus: true, remark: true, nextStop: true, changedAt: true },
            },
          },
        });

    // 派送单一车拉多家的货：只取这张运单自己那一行，派送单号（能串到别人）不给
    const lastmile = await prisma.adminLastmileOrder.findFirst({
      where: { shipmentId: shipment.id, companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
      select: { carrierName: true, driverName: true, licensePlate: true, phoneNumber: true, signImageBase64: true, status: true },
    });

    const mapLog = (
      log: { fromStatus: string; toStatus: string; remark: string | null; nextStop: string | null; changedAt: Date },
      no: string,
    ) => ({
      trackingNo: no,
      fromStatus: log.fromStatus,
      toStatus: log.toStatus,
      remark: remarkForAgent(log.remark),
      nextStop: log.nextStop ?? "",
      changedAt: log.changedAt.toISOString(),
    });
    // 父单轨迹 = 自己 + 全部子单，按时间合并（口径同 /client/shipments/track）
    const timeline = [
      ...shipment.statusLogs.map((l) => mapLog(l, shipment.trackingNo)),
      ...childShipments.flatMap((cs) => cs.statusLogs.map((l) => mapLog(l, cs.trackingNo))),
    ].sort((a, b) => a.changedAt.localeCompare(b.changedAt));

    ok(res, {
      viewerRole: "agent",
      trackingNo: shipment.trackingNo,
      orderNo: shipment.order.orderNo ?? null,
      clientId: shipment.order.clientId,
      itemName: shipment.order.itemName ?? null,
      products: shipment.order.products.map((p) => ({ itemName: p.itemName, packageCount: p.packageCount })),
      cargoType: shipment.order.cargoType ?? null,
      currentStatus: shipment.currentStatus,
      receiverNameTh: shipment.order.receiverNameTh ?? null,
      receiverAddressTh: shipment.order.receiverAddressTh ?? null,
      totalVolumeM3: num(shipment.volumeM3),
      containers: shipment.containerItems.map((it) => ({
        containerStatus: it.container.currentStatus,
        loadingDate: iso(it.container.loadingDate),
        departureDate: iso(it.container.departureDate),
        ata: iso(it.container.ata),
        customsClearedAt: iso(it.container.customsClearedAt),
      })),
      timeline,
      children:
        childShipments.length > 0
          ? childShipments.map((cs) => ({
              trackingNo: cs.trackingNo,
              batchNo: null,
              itemName: productNamesLabel(shipment.order!.products, cs.itemName) || null,
              packageCount: cs.packageCount,
              currentStatus: cs.currentStatus,
              timeline: cs.statusLogs.map((l) => mapLog(l, cs.trackingNo)),
            }))
          : undefined,
      lastmile: lastmile
        ? {
            carrierName: lastmile.carrierName,
            driverName: lastmile.driverName,
            licensePlate: lastmile.licensePlate,
            phoneNumber: lastmile.phoneNumber,
            signImageBase64: lastmile.signImageBase64 ? `data:image/jpeg;base64,${lastmile.signImageBase64}` : null,
            status: lastmile.status,
          }
        : null,
      createdAt: shipment.createdAt.toISOString(),
      updatedAt: shipment.updatedAt.toISOString(),
    });
  });

  /* ===== 仓库版集货：柜列表（3.2 / 3.3）。只列名下客户所在的柜，每个柜只带名下客户那几行 ===== */
  app.get("/agent/whr/plans", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const clients = await loadAgentClients(auth);
    const clientNames = new Map(clients.map((c) => [c.id, c.name]));
    const clientIds = clients.map((c) => c.id);
    if (clientIds.length === 0) {
      ok(res, { items: [] });
      return;
    }
    const rows = await prisma.whrConsolidationPlanCustomer.findMany({
      where: { companyId: auth.companyId, clientId: { in: clientIds } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 1000,
      select: {
        id: true,
        planId: true,
        clientId: true,
        unitPriceNormal: true,
        unitPriceInspection: true,
        unitPriceSensitive: true,
        totalVolumeM3: true,
        deliveryAddress: true,
        // ⚠️ 不选 plan.totalVolumeM3 / 已用方数（整柜用了多少会暴露别人的货量）、createdBy / creatorName（员工）
        plan: { select: { planNo: true, warehouse: true, containerType: true, destinationTh: true, status: true, createdAt: true } },
        prealerts: { select: { status: true, totalFee: true } },
      },
    });

    const plans = new Map<string, {
      planId: string;
      planNo: string;
      warehouse: string;
      containerType: string;
      destinationTh: string;
      planStatus: string;
      createdAt: string;
      customers: Array<Record<string, unknown>>;
    }>();
    for (const r of rows) {
      let plan = plans.get(r.planId);
      if (!plan) {
        plan = {
          planId: r.planId,
          planNo: r.plan.planNo,
          warehouse: r.plan.warehouse,
          containerType: r.plan.containerType,
          destinationTh: r.plan.destinationTh,
          planStatus: r.plan.status,
          createdAt: r.plan.createdAt.toISOString(),
          customers: [],
        };
        plans.set(r.planId, plan);
      }
      const active = r.prealerts.filter((p) => p.status !== "cancelled");
      plan.customers.push({
        customerId: r.id,
        clientId: r.clientId,
        clientName: clientNames.get(r.clientId) ?? "",
        unitPrices: { normal: num(r.unitPriceNormal), inspection: num(r.unitPriceInspection), sensitive: num(r.unitPriceSensitive) },
        totalVolumeM3: num(r.totalVolumeM3),
        totalFee: active.length > 0 ? Math.round(active.reduce((s, p) => s + num(p.totalFee), 0) * 100) / 100 : null,
        prealertCount: active.length,
        cancelledCount: r.prealerts.length - active.length,
        latestStatus: deriveLatestStatus(r.prealerts.map((p) => p.status)),
        deliveryAddress: r.deliveryAddress ?? null,
      });
    }
    ok(res, { items: [...plans.values()] });
  });

  /* ===== 仓库版集货：一个柜里名下客户的明细（单子、货品、状态、签收照片、地址） ===== */
  app.get("/agent/whr/plan-detail", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const planId = queryText(req, "planId", 100);
    if (!planId) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    const clients = await loadAgentClients(auth);
    const clientNames = new Map(clients.map((c) => [c.id, c.name]));
    const clientIds = clients.map((c) => c.id);
    const customers = clientIds.length === 0
      ? []
      : await prisma.whrConsolidationPlanCustomer.findMany({
          // ⚠️ 名下范围写在 where 里：柜里别的客户整行根本不会被查出来（3.3）
          where: { planId, companyId: auth.companyId, clientId: { in: clientIds } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            clientId: true,
            unitPriceNormal: true,
            unitPriceInspection: true,
            unitPriceSensitive: true,
            totalVolumeM3: true,
            totalFee: true,
            totalPackages: true,
            deliveryAddress: true,
            plan: { select: { planNo: true, warehouse: true, containerType: true, destinationTh: true, status: true, createdAt: true } },
            prealerts: {
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              take: 500,
              select: {
                id: true,
                trackingNo: true,
                expressNo: true,
                mark: true,
                status: true,
                signedAt: true,
                warehouseReceiptProofs: true,
                totalFee: true,
                paymentReviewedAt: true,
                paymentRejectReason: true,
                thailandReceiptProofs: true,
                thailandReceivedAt: true,
                cancelReason: true,
                cancelledAt: true,
                paidAgentId: true,
                rebateAmount: true,
                createdAt: true,
                // ⚠️ 不选 paymentReviewedBy（审核人）、paymentProofs（客户付款截图，里面有收款人，4.18 暂缓）
                items: {
                  orderBy: { sortOrder: "asc" },
                  select: {
                    id: true,
                    productName: true,
                    packageCount: true,
                    quantityPerBox: true,
                    totalQuantity: true,
                    lengthCm: true,
                    widthCm: true,
                    heightCm: true,
                    unitWeightKg: true,
                    totalWeightKg: true,
                    volumeM3: true,
                    material: true,
                    cargoValue: true,
                    cargoType: true,
                  },
                },
                statusLogs: {
                  orderBy: { createdAt: "desc" },
                  take: 50,
                  // ⚠️ 不选 operatorId / operatorName / operatorRole
                  select: { id: true, fromStatus: true, toStatus: true, remark: true, createdAt: true },
                },
              },
            },
          },
        });
    if (customers.length === 0) {
      fail(res, 404, "NOT_FOUND", `集货计划${NOT_FOUND}`);
      return;
    }
    const plan = customers[0].plan;
    ok(res, {
      planId,
      planNo: plan.planNo,
      warehouse: plan.warehouse,
      containerType: plan.containerType,
      destinationTh: plan.destinationTh,
      planStatus: plan.status,
      createdAt: plan.createdAt.toISOString(),
      customers: customers.map((c) => {
        const prices = {
          unitPriceNormal: c.unitPriceNormal,
          unitPriceInspection: c.unitPriceInspection,
          unitPriceSensitive: c.unitPriceSensitive,
        };
        return {
          customerId: c.id,
          clientId: c.clientId,
          clientName: clientNames.get(c.clientId) ?? "",
          unitPrices: { normal: num(c.unitPriceNormal), inspection: num(c.unitPriceInspection), sensitive: num(c.unitPriceSensitive) },
          totalVolumeM3: num(c.totalVolumeM3),
          totalFee: numOrNull(c.totalFee),
          totalPackages: c.totalPackages,
          deliveryAddress: c.deliveryAddress ?? null,
          prealerts: c.prealerts.map((pa) => {
            const bd = buildFeeBreakdown(pa.items, prices, pa.totalFee);
            return {
              id: pa.id,
              trackingNo: pa.trackingNo,
              expressNo: pa.expressNo,
              mark: pa.mark,
              status: pa.status,
              signedAt: iso(pa.signedAt),
              warehouseReceiptProofs: mapProofs(pa.warehouseReceiptProofs),
              totalFee: numOrNull(pa.totalFee),
              feeBreakdown: { rows: bd.rows, totalVolumeM3: bd.totalVolumeM3 },
              paidAt: iso(pa.paymentReviewedAt),
              paymentRejectReason: pa.paymentRejectReason,
              thailandReceiptProofs: mapProofs(pa.thailandReceiptProofs),
              thailandReceivedAt: iso(pa.thailandReceivedAt),
              cancelReason: pa.cancelReason,
              cancelledAt: iso(pa.cancelledAt),
              // 这一单他赚多少（3.4）：付款那一刻冻结的；没付款 / 不是记在他名下的给 null
              rebateAmount: pa.paidAgentId === auth.agentId ? numOrNull(pa.rebateAmount) : null,
              createdAt: pa.createdAt.toISOString(),
              items: pa.items.map((it) => ({
                id: it.id,
                productName: it.productName,
                packageCount: it.packageCount,
                quantityPerBox: it.quantityPerBox,
                totalQuantity: it.totalQuantity,
                lengthCm: numOrNull(it.lengthCm),
                widthCm: numOrNull(it.widthCm),
                heightCm: numOrNull(it.heightCm),
                unitWeightKg: numOrNull(it.unitWeightKg),
                totalWeightKg: numOrNull(it.totalWeightKg),
                volumeM3: numOrNull(it.volumeM3),
                material: it.material,
                cargoValue: it.cargoValue,
                cargoType: it.cargoType,
              })),
              statusLogs: pa.statusLogs.map((sl) => ({
                id: sl.id,
                fromStatus: sl.fromStatus,
                toStatus: sl.toStatus,
                remark: remarkForAgent(sl.remark),
                createdAt: sl.createdAt.toISOString(),
              })),
            };
          }),
        };
      }),
    });
  });

  /* ===== 客户和价格（4.3 / 4.7） ===== */
  app.get("/agent/clients", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const agent = await prisma.agent.findFirst({
      where: { id: auth.agentId, companyId: auth.companyId },
      select: { priceNormal: true, priceInspection: true, priceSensitive: true },
    });
    if (!agent) {
      fail(res, 404, "NOT_FOUND", `代理${NOT_FOUND}`);
      return;
    }
    const rows = await prisma.user.findMany({
      where: { agentId: auth.agentId, companyId: auth.companyId, role: "client" },
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        phone: true,
        status: true,
        createdAt: true,
        // ⚠️ 不选 updatedBy / updatedByRole（谁改的价只给超管看）
        whrPrice: { select: { priceNormal: true, priceInspection: true, priceSensitive: true, updatedAt: true } },
      },
    });
    ok(res, {
      agentPrices: { normal: num(agent.priceNormal), inspection: num(agent.priceInspection), sensitive: num(agent.priceSensitive) },
      items: rows.map((u) => ({
        clientId: u.id,
        name: u.name,
        phone: u.phone,
        status: u.status,
        createdAt: u.createdAt.toISOString(),
        price: u.whrPrice
          ? {
              normal: num(u.whrPrice.priceNormal),
              inspection: num(u.whrPrice.priceInspection),
              sensitive: num(u.whrPrice.priceSensitive),
              updatedAt: u.whrPrice.updatedAt.toISOString(),
            }
          : null,
      })),
    });
  });

  app.post("/agent/clients/price", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const body = (req.body ?? {}) as { clientId?: unknown; prices?: Record<"normal" | "inspection" | "sensitive", unknown> };
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    if (!clientId || clientId.length > 100) {
      fail(res, 400, "BAD_REQUEST", "请选择客户");
      return;
    }
    // 参数不合法在碰库之前就 400（BusinessError 由 server.ts 统一转成 400）
    parseWhrPriceInput(body.prices);

    const result = await prisma.$transaction(
      async (tx) => {
        /**
         * ⚠️ 归属判断必须在锁里做（CLAUDE.md #28）：超管改客户归属也先拿同一把客户价锁，
         * 事务外判完再进来，中间客户被改到别的代理名下，就成了「A 代理改了 B 代理客户的价」。
         * 锁序：客户价排队锁在最前，跟 setClientWhrPrice 一致（它里面再拿一次同一把锁，
         * PostgreSQL 事务级 advisory 锁同一会话可重入，不会自己等自己）。
         */
        await lockClientWhrPrice(tx, clientId);
        const owned = await tx.user.findFirst({
          where: { id: clientId, agentId: auth.agentId, companyId: auth.companyId, role: "client" },
          select: { id: true },
        });
        if (!owned) throw new BusinessError(`客户${NOT_FOUND}`, 404, "NOT_FOUND");
        return setClientWhrPrice(
          { companyId: auth.companyId, clientId, prices: body.prices!, actor: { userId: auth.userId, role: auth.role } },
          tx,
        );
      },
      { timeout: 30000, maxWait: 10000 },
    );
    const saved = await prisma.clientWhrPrice.findUnique({
      where: { clientId },
      select: { priceNormal: true, priceInspection: true, priceSensitive: true, updatedAt: true },
    });
    ok(res, {
      clientId,
      price: saved
        ? { normal: num(saved.priceNormal), inspection: num(saved.priceInspection), sensitive: num(saved.priceSensitive), updatedAt: saved.updatedAt.toISOString() }
        : null,
      updatedPlanRows: result.updatedPlanRows,
    });
  });

  /* ===== 集货余额和充值记录（3.7，只读，没有审核） ===== */
  app.get("/agent/wallet", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const page = parsePageParam(req.query.page, 1);
    if (page === null) { fail(res, 400, "BAD_REQUEST", "页码不合法"); return; }
    const pageSizeRaw = parsePageParam(req.query.pageSize, 50);
    if (pageSizeRaw === null) { fail(res, 400, "BAD_REQUEST", "每页条数不合法"); return; }
    const pageSize = Math.min(pageSizeRaw, 200);
    const filterClientId = queryText(req, "clientId", 100);

    const clients = await loadAgentClients(auth);
    const clientNames = new Map(clients.map((c) => [c.id, c.name]));
    const clientIds = clients.map((c) => c.id);
    if (clientIds.length === 0 || (filterClientId && !clientIds.includes(filterClientId))) {
      ok(res, { balances: clients.map((c) => ({ clientId: c.id, clientName: c.name, balance: 0, updatedAt: null })), recharges: { items: [], page, pageSize, total: 0 } });
      return;
    }

    const accounts = await prisma.clientWalletAccount.findMany({
      where: { companyId: auth.companyId, clientId: { in: clientIds }, currency: CONSOLIDATION_CURRENCY },
      select: { clientId: true, balance: true, updatedAt: true },
    });
    const accountByClient = new Map(accounts.map((a) => [a.clientId, a]));

    const rechargeWhere: Prisma.WalletRechargeWhereInput = {
      companyId: auth.companyId,
      clientId: filterClientId ? filterClientId : { in: clientIds },
    };
    const [total, recharges] = await Promise.all([
      prisma.walletRecharge.count({ where: rechargeWhere }),
      prisma.walletRecharge.findMany({
        where: rechargeWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        // ⚠️ 不选 proofImage（付款截图里有收款账户，4.18 暂缓）、reviewedBy（审核人）、
        //    reviewRemark（管理员审核时写的，属于湘泰内部备注，3.9）
        select: { id: true, clientId: true, amount: true, currency: true, paymentMethod: true, status: true, createdAt: true, updatedAt: true },
      }),
    ]);

    ok(res, {
      balances: clients.map((c) => {
        const a = accountByClient.get(c.id);
        return { clientId: c.id, clientName: c.name, balance: a ? num(a.balance) : 0, updatedAt: iso(a?.updatedAt) };
      }),
      recharges: {
        items: recharges.map((r) => ({
          id: r.id,
          clientId: r.clientId,
          clientName: clientNames.get(r.clientId) ?? "",
          amount: num(r.amount),
          currency: r.currency,
          paymentMethod: r.paymentMethod,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        page,
        pageSize,
        total,
      },
    });
  });

  /* ===== 返现单（3.4 / 4.12 / 4.20）。表由 B2 的定时任务生成，这里只读 ===== */
  app.get("/agent/rebates", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const rows = await prisma.agentRebateStatement.findMany({
      where: { agentId: auth.agentId, companyId: auth.companyId },
      orderBy: [{ month: "desc" }, { id: "desc" }],
      take: 240,
      select: { id: true, month: true, lineCount: true, totalVolumeM3: true, totalRebate: true, status: true, generatedAt: true, paidAt: true },
    });
    ok(res, { items: rows.map(mapRebateStatement) });
  });

  app.get("/agent/rebates/detail", async (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;
    const statementId = queryText(req, "statementId", 100);
    if (!statementId) {
      fail(res, 400, "BAD_REQUEST", "statementId 为必填");
      return;
    }
    const statement = await prisma.agentRebateStatement.findFirst({
      where: { id: statementId, agentId: auth.agentId, companyId: auth.companyId },
      select: { id: true, month: true, lineCount: true, totalVolumeM3: true, totalRebate: true, status: true, generatedAt: true, paidAt: true },
    });
    if (!statement) {
      fail(res, 404, "NOT_FOUND", `返现单${NOT_FOUND}`);
      return;
    }
    const lines = await prisma.agentRebateLine.findMany({
      where: { statementId: statement.id, companyId: auth.companyId },
      orderBy: [{ thailandReceivedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        trackingNo: true,
        planNo: true,
        clientId: true,
        mark: true,
        productNames: true,
        volumeNormalM3: true,
        volumeInspectionM3: true,
        volumeSensitiveM3: true,
        clientPriceNormal: true,
        clientPriceInspection: true,
        clientPriceSensitive: true,
        agentPriceNormal: true,
        agentPriceInspection: true,
        agentPriceSensitive: true,
        rebateAmount: true,
        prealertCreatedAt: true,
        signedAt: true,
        paidAt: true,
        loadedAt: true,
        shippedAt: true,
        thailandReceivedAt: true,
      },
    });
    ok(res, { statement: mapRebateStatement(statement), lines: lines.map(mapRebateLine) });
  });
}

