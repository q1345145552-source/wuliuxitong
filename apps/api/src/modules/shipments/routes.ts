// B-5: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { logger } from "../core/logger";
import { loadProductImagesForOrders } from "../orders/product-images";
import { checkRateLimit, rateLimitKey } from "../core/rate-limit";
import { STATUS_FLOW, STATUS_FLOW_LAND, EXCEPTION_STATUSES, SKIP_ON_ADVANCE_STATUSES, COMPLETED_STATUSES } from "./status-flow";
import { syncParentStatusFromChildren } from "./parent-status";
import { loadOrderTotalMetrics } from "./total-metrics";
import { countShipmentOverview } from "./overview-counts";
import { loadPartialAhead } from "./partial-status";
import { isManagedLastmileLog, MANAGED_LASTMILE_LOG_MESSAGE } from "./managed-lastmile-log";
import { BusinessError } from "../core/business-error";
import { canSeeOperatorIdentity } from "../core/operator-visibility";

interface Kuaidi100QueryPayload {
  com?: string;
  num: string;
}

interface Kuaidi100QueryResponse {
  status?: string;
  message?: string;
  state?: string;
  com?: string;
  nu?: string;
  data?: Array<{
    context?: string;
    ftime?: string;
    time?: string;
  }>;
}

interface Kuaidi100WebQueryResponse {
  status?: string;
  message?: string;
  state?: string;
  com?: string;
  nu?: string;
  data?: Array<{
    context?: string;
    ftime?: string;
    time?: string;
  }>;
}

export function canTransit(fromStatus: string, toStatus: string): boolean {
  if (fromStatus === toStatus) return true;
  if (EXCEPTION_STATUSES.has(toStatus)) return true;
  // STATUS_FLOW 是字面量元组，indexOf 只收流程内的那几个字面量；
  // 这里传进来的是运行时的任意字符串（可能是脏数据），当成普通字符串数组查就行，
  // 查不到返回 -1，下面本来就按 -1 处理（2026-08-27 修 tsc 报错）
  const flow = STATUS_FLOW as readonly string[];
  const fromIndex = flow.indexOf(fromStatus);
  const toIndex = flow.indexOf(toStatus);
  // 允许从异常状态恢复到任意正常状态（如取消→重新装柜）
  if (fromIndex < 0 && EXCEPTION_STATUSES.has(fromStatus) && toIndex >= 0) return true;
  if (fromIndex < 0 || toIndex < 0) return false;
  if (toIndex <= fromIndex) return false;
  // 一次只能往前一格，但中间隔着的如果全是「可跳过的中间态」（延迟类 + 已入库），
  // 可以直接跨过去 —— 没延误的单子不该被逼着先点「延迟开船」，
  // 停在 created 的老运单也不该被 2026-09-02 新插的「已入库」卡死（拍板：老单不回填）。
  for (let i = fromIndex + 1; i < toIndex; i += 1) {
    if (!SKIP_ON_ADVANCE_STATUSES.has(STATUS_FLOW[i]!)) return false;
  }
  return true;
}

/** 宽松版：只要求前进不后退，允许跳步（用于容器批量同步场景） */
export function canTransitLoose(fromStatus: string, toStatus: string): boolean {
  if (fromStatus === toStatus) return true;
  if (EXCEPTION_STATUSES.has(toStatus)) return true;
  // 2026-08-06：海运、陆运两条流程，**任意一条能走通就算合法**。
  // 一票货只会走其中一条（由柜子的运输方式决定），这里不需要知道是哪条 ——
  // 「该不该走这条流程」在柜子那层已经拦过了（containers/routes.ts 的 flowOf）。
  return canTransitInFlow(STATUS_FLOW, fromStatus, toStatus)
    || canTransitInFlow(STATUS_FLOW_LAND, fromStatus, toStatus);
}

function canTransitInFlow(flow: readonly string[], fromStatus: string, toStatus: string): boolean {
  const fromIndex = flow.indexOf(fromStatus);
  const toIndex = flow.indexOf(toStatus);
  if (fromIndex < 0 && EXCEPTION_STATUSES.has(fromStatus) && toIndex >= 0) return true;
  if (fromIndex < 0 || toIndex < 0) return false;
  return toIndex > fromIndex;
}

/** Decimal | null → number | null */
function decToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value.toString());
}

/**
 * 计算快递100签名（MD5 大写）。
 */
function createKuaidi100Sign(paramText: string, key: string, customer: string): string {
  return createHash("md5").update(`${paramText}${key}${customer}`).digest("hex").toUpperCase();
}

/**
 * 将快递100状态码映射为中文文案。
 */
function mapKuaidi100State(state?: string): string {
  if (state === "0") return "在途";
  if (state === "1") return "揽收";
  if (state === "2") return "疑难";
  if (state === "3") return "已签收";
  if (state === "4") return "退签";
  if (state === "5") return "派件";
  if (state === "6") return "退回";
  return "未知";
}

export function registerShipmentRoutes(app: MinimalHttpApp): void {
  app.get("/staff/inbound-photos", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const shipmentId = req.query.shipmentId?.trim();
    if (!shipmentId) {
      fail(res, 400, "BAD_REQUEST", "shipmentId is required");
      return;
    }
    const rows = await prisma.staffInboundPhoto.findMany({
      where: { companyId: auth.companyId, shipmentId },
      orderBy: { createdAt: "desc" },
    });
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        shipmentId: item.shipmentId,
        // 2026-09-15：上传人账号只给超级管理员（员工工作台「操作员 xxx」那一行跟着隐藏）
        operatorId: canSeeOperatorIdentity(auth.role) ? item.operatorId : undefined,
        fileName: item.fileName,
        mime: item.mime,
        contentBase64: item.contentBase64,
        note: item.note ?? undefined,
        createdAt: item.createdAt.toISOString(),
      })),
    });
  });

  app.post("/staff/inbound-photos", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      shipmentId?: string;
      fileName?: string;
      mime?: string;
      contentBase64?: string;
      note?: string;
    };
    const shipmentId = body.shipmentId?.trim();
    const fileName = body.fileName?.trim();
    const mime = body.mime?.trim();
    const contentBase64 = body.contentBase64?.trim();
    if (!shipmentId || !fileName || !mime || !contentBase64) {
      fail(res, 400, "BAD_REQUEST", "shipmentId, fileName, mime, contentBase64 are required");
      return;
    }
    const shipment = await prisma.shipment.findFirst({
      where: { id: shipmentId, companyId: auth.companyId },
      select: { id: true },
    });
    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }
    if (contentBase64.length > 4_000_000) {
      fail(res, 400, "BAD_REQUEST", "file too large (max 4MB base64)");
      return;
    }
    const id = `photo_${Date.now()}`;
    const created = await prisma.staffInboundPhoto.create({
      data: {
        id,
        companyId: auth.companyId,
        shipmentId,
        operatorId: auth.userId,
        fileName,
        mime,
        contentBase64,
        note: body.note?.trim() || null,
      },
      select: { id: true, createdAt: true },
    });
    ok(res, { id: created.id, shipmentId, createdAt: created.createdAt.toISOString() });
  });

  app.post("/staff/shipments/set-container", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentId?: string; containerNo?: string };
    const shipmentId = body.shipmentId?.trim();
    const containerNo = body.containerNo?.trim();
    if (!shipmentId || !containerNo) {
      fail(res, 400, "BAD_REQUEST", "shipmentId and containerNo are required");
      return;
    }
    const shipment = await prisma.shipment.findFirst({
      where: { id: shipmentId, companyId: auth.companyId },
      select: { id: true, warehouseId: true },
    });
    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }
    const updated = await prisma.shipment.update({
      where: { id: shipmentId },
      data: { containerNo },
      select: { updatedAt: true },
    });
    ok(res, { shipmentId, containerNo, updatedAt: updated.updatedAt.toISOString() });
  });

  // 2026-08-11 删除：/public/track（运单号 + 手机后4位的免登录查单接口）。
  // 前端从来没有任何页面调它 —— 客户端「查国内快递」跳的是快递100，跟它无关。
  // 但接口本身对公网开着，凑齐运单号+手机尾号的人能看到品名和国内快递单号（同行能看出走哪家渠道），
  // 属于「没人用、却开着、还会漏东西」的口子，按用户决定关掉。
  // 要恢复：git 历史里有完整实现（含速率限制 30次/分、手机尾号校验、柜号脱敏）。

  app.get("/client/express/universal", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;
    const trackingNo = req.query.trackingNo?.trim();
    const companyCode = req.query.companyCode?.trim();
    if (!trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
      return;
    }

    // 2026-08-31（排查报告第56条）：这个接口背后是快递100 —— 按查询次数收费的服务，
    // 原来登录用户能无限刷，单号还可以随便填，写个循环就能把付费额度刷光。
    // 照 AI 聊天（client-ai-routes.ts）的做法按账号限流：每分钟 10 次 + 每 24 小时 100 次。
    // 先限流再往下走，被拦下的请求一次都不会打到快递100。
    if (checkRateLimit(rateLimitKey(auth.userId, "express-query"), 10, 60_000)) {
      fail(res, 429, "BAD_REQUEST", "快递查询太频繁了，请稍等一分钟再查（每分钟最多 10 次）");
      return;
    }
    if (checkRateLimit(rateLimitKey(auth.userId, "express-query-day"), 100, 24 * 60 * 60_000)) {
      fail(res, 429, "BAD_REQUEST", "快递查询次数已达上限（24 小时内最多 100 次），请稍后再查");
      return;
    }

    const customer = process.env.KUAIDI100_CUSTOMER?.trim();
    const key = process.env.KUAIDI100_KEY?.trim();
    const endpoint = process.env.KUAIDI100_QUERY_URL?.trim() || "https://poll.kuaidi100.com/poll/query.do";
    const webQueryEndpoint = process.env.KUAIDI100_WEB_QUERY_URL?.trim() || "https://www.kuaidi100.com/query";

    if (customer && key) {
      const payload: Kuaidi100QueryPayload = {
        num: trackingNo,
      };
      if (companyCode) payload.com = companyCode;
      const paramText = JSON.stringify(payload);
      const sign = createKuaidi100Sign(paramText, key, customer);
      const body = new URLSearchParams();
      body.set("customer", customer);
      body.set("sign", sign);
      body.set("param", paramText);

      let providerData: Kuaidi100QueryResponse | null = null;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });
        providerData = (await response.json()) as Kuaidi100QueryResponse;
        if (!response.ok) {
          fail(res, 502, "INTERNAL_ERROR", `kuaidi100 request failed: HTTP ${response.status}`);
          return;
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : "unknown error";
        fail(res, 502, "INTERNAL_ERROR", `kuaidi100 request failed: ${text}`);
        return;
      }

      if (providerData?.status !== "200") {
        fail(res, 400, "BAD_REQUEST", providerData?.message ?? "kuaidi100 query failed");
        return;
      }

      ok(res, {
        trackingNo: providerData.nu ?? trackingNo,
        companyCode: providerData.com ?? companyCode ?? "",
        statusCode: providerData.state ?? "",
        statusText: mapKuaidi100State(providerData.state),
        events: (providerData.data ?? []).map((item) => ({
          time: item.ftime ?? item.time ?? "",
          content: item.context ?? "",
        })),
      });
      return;
    }

    if (!companyCode) {
      fail(res, 400, "BAD_REQUEST", "companyCode is required when KUAIDI100 key is not configured");
      return;
    }

    let webData: Kuaidi100WebQueryResponse | null = null;
    try {
      const query = new URLSearchParams();
      query.set("type", companyCode);
      query.set("postid", trackingNo);
      const response = await fetch(`${webQueryEndpoint}?${query.toString()}`, {
        method: "GET",
      });
      webData = (await response.json()) as Kuaidi100WebQueryResponse;
      if (!response.ok) {
        fail(res, 502, "INTERNAL_ERROR", `kuaidi100 web query failed: HTTP ${response.status}`);
        return;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "unknown error";
      fail(res, 502, "INTERNAL_ERROR", `kuaidi100 web query failed: ${text}`);
      return;
    }

    if (webData?.status !== "200") {
      fail(res, 400, "BAD_REQUEST", webData?.message ?? "kuaidi100 web query failed");
      return;
    }

    ok(res, {
      trackingNo: webData.nu ?? trackingNo,
      companyCode: webData.com ?? companyCode,
      statusCode: webData.state ?? "",
      statusText: mapKuaidi100State(webData.state),
      events: (webData.data ?? []).map((item) => ({
        time: item.ftime ?? item.time ?? "",
        content: item.context ?? "",
      })),
    });
  });

  app.get("/client/shipments/search", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const trackingNo = req.query.trackingNo?.trim();
    const domesticTrackingNo = req.query.domesticTrackingNo?.trim();
    const itemName = req.query.itemName?.trim();
    const transportMode = req.query.transportMode?.trim();

    const rows = await prisma.shipment.findMany({
      where: {
        companyId: auth.companyId,
        parentTrackingNo: null,
        order: { clientId: auth.userId },
      },
      orderBy: { updatedAt: "desc" },
      include: {
        order: {
          select: {
            id: true,
            clientId: true,
            itemName: true,
            transportMode: true,
            orderNo: true,
            volumeM3: true,
            weightKg: true,
          },
        },
      },
    });

    // 加载产品行，用于展示多产品国内单号
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    let productMap = new Map<string, Array<{ itemName: string; domesticTrackingNo: string }>>();
    if (orderIds.length > 0) {
      const products = await prisma.orderProduct.findMany({
        where: { orderId: { in: orderIds }, companyId: auth.companyId },
        orderBy: { sortOrder: "asc" },
        select: { orderId: true, itemName: true, domesticTrackingNo: true },
      });
      for (const p of products) {
        const list = productMap.get(p.orderId) ?? [];
        list.push({ itemName: p.itemName, domesticTrackingNo: p.domesticTrackingNo });
        productMap.set(p.orderId, list);
      }
    }

    const totalMetricsByOrderId = await loadOrderTotalMetrics(
      auth.companyId,
      rows.map((row) => ({
        orderId: row.orderId,
        orderVolumeM3: row.order.volumeM3,
        orderWeightKg: row.order.weightKg,
      })),
    );

    // 拆了子单、子单进度不一样时补一句「（部分已放行）」——主状态和分组口径一个字不动（2026-09-16 拍板）
    const partialAhead = await loadPartialAhead(
      auth.companyId,
      rows.map((r) => ({
        trackingNo: r.trackingNo,
        currentStatus: r.currentStatus,
        packageCount: r.packageCount,
        transportMode: r.transportMode ?? r.order.transportMode,
      })),
    );

    const items = rows
      .filter((r) => !trackingNo || r.trackingNo.includes(trackingNo))
      .filter((r) => {
        if (!domesticTrackingNo) return true;
        // 匹配运单级国内单号 或 任意产品行的国内单号
        if ((r.domesticTrackingNo ?? "").includes(domesticTrackingNo)) return true;
        const prods = productMap.get(r.orderId) ?? [];
        return prods.some((p) => p.domesticTrackingNo.includes(domesticTrackingNo));
      })
      .filter((r) => !itemName || r.order.itemName.includes(itemName))
      .filter((r) => !transportMode || r.order.transportMode === transportMode)
      .map((r) => ({
        id: r.id,
        orderId: r.orderId,
        orderNo: r.order.orderNo ?? undefined,
        trackingNo: r.trackingNo,
        // batchNo 存的就是柜号，客户端不下发（2026-08-11）。
        // 跟 /client/orders 8-07 那次一个道理 —— 前端不显示不算堵住，
        // 数据到了浏览器就是泄漏。见 core/client-privacy.ts。
        currentStatus: r.currentStatus,
        partialAhead: partialAhead.get(r.trackingNo),
        currentLocation: r.currentLocation ?? undefined,
        updatedAt: r.updatedAt.toISOString(),
        weightKg: decToNumber(r.weightKg),
        volumeM3: decToNumber(r.volumeM3),
        totalWeightKg: r.parentTrackingNo === null
          ? totalMetricsByOrderId.get(r.orderId)?.totalWeightKg
          : undefined,
        totalVolumeM3: r.parentTrackingNo === null
          ? totalMetricsByOrderId.get(r.orderId)?.totalVolumeM3
          : undefined,
        packageCount: r.packageCount,
        packageUnit: r.packageUnit,
        domesticTrackingNo: r.domesticTrackingNo,
        // 多产品国内单号
        products: (productMap.get(r.orderId) ?? []).map((p) => ({
          itemName: p.itemName,
          domesticTrackingNo: p.domesticTrackingNo,
        })),
      }));

    ok(res, { items, page: 1, pageSize: items.length, total: items.length });
  });

  app.get("/staff/shipments", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 500);
    const includeChildren = req.query.all === "1";
    const where: any = { companyId: auth.companyId };
    if (!includeChildren) where.parentTrackingNo = null;

    // 2026-08-06：按状态筛（逗号分隔，大小写不敏感）。**尾端派送就是因为没有它才漏货的**：
    // 页面原来拿「按更新时间排的前 500 条（所有状态混在一起）」回去自己筛，
    // 全库 1026 张运单里能派送的有 571 张，但排进前 500 的只有 126 张 —— 78% 根本没下发。
    // 不传这个参数时行为与以前完全一致，老调用方不受影响。
    const statusFilter = String(req.query.status ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (statusFilter.length > 0) {
      // 库里存的是 inWarehouseTH 这种驼峰写法，前端历史上一直用小写比对，
      // 这里用不区分大小写的等值匹配，两边怎么写都能对上
      where.OR = statusFilter.map((s) => ({ currentStatus: { equals: s, mode: "insensitive" } }));
    }

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

    // 同客户端：子单进度不一样时补一句「（部分已放行）」，主状态和分组不动
    const partialAheadStaff = await loadPartialAhead(
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
      orderNo: r.order?.orderNo ?? undefined,
      trackingNo: r.trackingNo,
      parentTrackingNo: r.parentTrackingNo ?? undefined,
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
      arrivedAt: r.order?.shipDate ?? undefined,
      currentStatus: r.currentStatus,
      partialAhead: partialAheadStaff.get(r.trackingNo),
      currentLocation: r.currentLocation ?? undefined,
      warehouseId: r.warehouseId,
      updatedAt: r.updatedAt.toISOString(),
      transportMode: r.order?.transportMode ?? undefined,
      shipDate: r.order?.shipDate ?? undefined,
      receiverNameTh: r.order?.receiverNameTh ?? undefined,
      receiverPhoneTh: r.order?.receiverPhoneTh ?? undefined,
      receiverAddressTh: r.order?.receiverAddressTh ?? undefined,
      receivableAmountCny: decToNumber(r.order?.receivableAmountCny ?? null) ?? undefined,
      receivableCurrency: r.order?.receivableCurrency ?? undefined,
      paymentStatus: (r.order?.paymentStatus === "paid" ? "paid" : "unpaid") as "paid" | "unpaid",
      packageUnit: ((r.order?.packageUnit === "bag" ? "bag" : "box") as "bag" | "box"),
      cargoType: r.order?.cargoType ?? "normal",
      canEdit: auth.role === "admin",
      remark: r.remark ?? undefined,
      productImages: undefined as any[] | undefined,
      products: undefined as any[] | undefined,
    }));

    // 批量加载产品明细 + 产品图
    const orderIds = [...new Set(items.map((i) => i.orderId).filter(Boolean) as string[])];
    if (orderIds.length > 0) {
      const [productRows, imageRows] = await Promise.all([
        prisma.orderProduct.findMany({
          where: { orderId: { in: orderIds } },
          orderBy: { sortOrder: "asc" },
        }),
        prisma.orderProductImage.findMany({
          where: { companyId: auth.companyId, orderId: { in: orderIds } },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      const pmap = new Map<string, any[]>();
      for (const r of productRows) {
        const list = pmap.get(r.orderId) ?? [];
        list.push({ id: r.id, itemName: r.itemName, packageCount: r.packageCount, lengthCm: r.lengthCm, widthCm: r.widthCm, heightCm: r.heightCm, productQuantity: r.productQuantity, cargoType: r.cargoType, domesticTrackingNo: r.domesticTrackingNo, weightKg: r.weightKg });
        pmap.set(r.orderId, list);
      }
      const imap = new Map<string, any[]>();
      for (const r of imageRows) {
        const list = imap.get(r.orderId) ?? [];
        list.push({ id: r.id, fileName: r.fileName, mime: r.mime, imageUrl: r.filePath || undefined, createdAt: r.createdAt.toISOString() });
        imap.set(r.orderId, list);
      }
      for (const item of items) {
        if (item.orderId) {
          item.products = pmap.get(item.orderId);
          item.productImages = imap.get(item.orderId);
        }
      }
    }

    // 补充父运单总件数：父剩余 + 所有子运单件数
    const parentIds = items.filter(i => !i.parentTrackingNo).map(i => i.trackingNo);
    // 本页父单里哪些已经分过柜（有子单）——尾端候选用它把「自己 0 件」的汇总父单筛掉（2026-09-10）
    const parentsWithChildren = new Set<string>();
    if (parentIds.length > 0) {
      const childRows = await prisma.shipment.findMany({
        where: { parentTrackingNo: { in: parentIds }, companyId: auth.companyId },
        select: { parentTrackingNo: true, packageCount: true },
      });
      const childSum = new Map<string, number>();
      for (const c of childRows) {
        parentsWithChildren.add(c.parentTrackingNo!);
        childSum.set(c.parentTrackingNo!, (childSum.get(c.parentTrackingNo!) ?? 0) + (c.packageCount ?? 0));
      }
      for (const item of items) {
        if (!item.parentTrackingNo) {
          (item as any).totalPackageCount = (item.packageCount ?? 0) + (childSum.get(item.trackingNo) ?? 0);
        }
      }
    }

    // 尾端候选需要区分汇总父单；普通列表保持原有查询和响应。
    // hasChildren 直接复用上面「补父单总件数」那次子单查询的结果，不再多查一次。
    if (includeChildren) {
      ok(res, {
        items: items.map((item) => ({ ...item, hasChildren: !item.parentTrackingNo && parentsWithChildren.has(item.trackingNo) })),
        page, pageSize, total,
      });
      return;
    }
    ok(res, { items, page, pageSize, total });
  });

  // 按需加载单个订单的产品图
  app.get("/staff/shipments/images", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin", "client"]);
    if (!auth) return;
    const orderId = req.query.orderId?.trim();
    if (!orderId) { fail(res, 400, "BAD_REQUEST", "orderId required"); return; }
    // 客户端只能看自己名下订单的图片
    if (auth.role === "client") {
      const own = await prisma.order.findFirst({ where: { id: orderId, clientId: auth.userId, companyId: auth.companyId }, select: { id: true } });
      if (!own) { fail(res, 403, "FORBIDDEN", "无权查看该订单图片"); return; }
    }
    const imageMap = await loadProductImagesForOrders(auth.companyId, [orderId]);
    ok(res, { images: imageMap.get(orderId) ?? [] });
  });

  /**
   * ⚠️ 这里原来有一条员工分柜接口（POST /staff/shipments/split），2026-08-31 删掉了。
   * 分柜功能早就搬到装柜管理页去了（/staff/loading-manifests/add-shipment 装柜时
   * 按件数自动切子单），这条老路唯一的前端入口是员工工作台里那个永远打不开的
   * 分柜弹窗（排查报告第 41 条）—— 弹窗和 business-api.ts 里的 splitStaffShipment
   * 封装函数已在同批一并删掉，grep 全仓库（apps/、scripts/、docs）无任何调用方残留。
   * 按 CLAUDE.md 第 35 条「给旧代码打补丁前，先问它该不该活着」：没人走的路直接下线，
   * 免得两套分柜算法各改各的、越走越远。
   * 要恢复：git 历史里有完整实现（含行级锁、reconcileFamilyMetric 家族守恒、
   * allocateSplitMetric 柜内记录同步分摊 —— 那两个函数还活在 split-metrics.ts，
   * 装柜/派送那几条路照常在用）。
   */

  /**
   * 历史「修复运单关联订单」接口：SQLite 时代的兼容补丁。
   * Postgres 数据通过 Prisma 严格管理，不再有悬空 order_id 问题，故停用。
   */
  app.post("/staff/shipments/repair-order-links", async (_req, res) => {
    ok(res, {
      ok: true,
      repairedCount: 0,
      repairedShipmentIds: [],
      skipped: [],
      note: "此功能在 Postgres 迁移后不再需要",
    });
  });

  /**
   * 删掉物流轨迹里写错的一条（员工和管理员都能用）。
   *
   * 2026-08-07 加的。柜子状态只能往前推，推错了既回不去也改不了 ——
   * 真实案例：运单 YW0001396 已开船之后被误推成「延迟运输」，
   * 客户看到的就是「运输中」突然变「延迟运输」。
   *
   * 删完把运单的当前状态退回到剩下的最后一条轨迹。
   * ⚠️ 如果一条都不剩，当前状态**保持不动** —— 生产库里有 219 张已签收的老运单
   * 压根没有轨迹记录，把它们重置成「已创建」比留着错状态更糟。
   * 唯一的例外（2026-09-02 终审整改 P2）：删掉的是**唯一一条「已入库」轨迹**、
   * 且运单当前状态就是「已入库」时，退回「已创建」—— 入库记录写错了删掉，
   * 状态不能还挂在「已入库」上。老单保护不受影响：那 219 张的状态是已签收。
   */
  app.post("/staff/shipments/track/delete-log", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const logId = typeof body.logId === "string" ? body.logId.trim() : "";
    if (!logId) {
      fail(res, 400, "BAD_REQUEST", "logId is required");
      return;
    }

    const log = await prisma.statusLog.findFirst({
      where: { id: logId, companyId: auth.companyId },
      include: { shipment: { select: { id: true, trackingNo: true, currentStatus: true } } },
    });
    if (!log) {
      fail(res, 404, "NOT_FOUND", "这条轨迹不存在，可能已经被删掉了");
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 先锁运单（2026-08-29 补）。
       * 这条路删掉一条轨迹之后，会**按剩下的最后一条把运单当前状态改回去**。
       * 推进柜子状态那条正在按锁后的清单改这批运单的状态、写轨迹，
       * 两边同时干，谁后写谁算数 —— 运单状态和轨迹就对不上了。
       * 锁序跟别处一致：柜 → 柜内记录 → 运单，这里只碰运单，锁它一个即可。
       */
      await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${log.shipmentId} FOR UPDATE`;
      const lockedLog = await tx.statusLog.findFirst({
        where: { id: logId, shipmentId: log.shipmentId, companyId: auth.companyId },
      });
      if (!lockedLog) throw new BusinessError("这条轨迹已被处理，请刷新后重试", 404, "NOT_FOUND");
      if (isManagedLastmileLog(lockedLog)) {
        throw new BusinessError(MANAGED_LASTMILE_LOG_MESSAGE, 409, "VALIDATION_ERROR");
      }
      await tx.statusLog.delete({ where: { id: logId } });

      // 剩下的最后一条决定当前状态；一条不剩就不动它
      const latest = await tx.statusLog.findFirst({
        where: { shipmentId: log.shipmentId },
        orderBy: { changedAt: "desc" },
        select: { toStatus: true },
      });
      if (latest) {
        await tx.shipment.update({
          where: { id: log.shipmentId },
          data: { currentStatus: latest.toStatus, updatedAt: new Date() },
        });

        /**
         * 2026-08-31（排查报告第21条）：删的是**子单**的轨迹时，上面把子单状态退回去了，
         * 父单的大状态却还挂着按旧子单状态推出来的值 —— 例：3 个子单全签收后父单自动
         * 「已签收」，员工删掉其中一个点错的签收记录，子单退回「派送中」，父单还挂着
         * 「已签收」，客户看到订单状态和轨迹两边打架。跟签收、删派送单那些入口保持一致，
         * 子单状态改完再按全部子单重算一次父单。
         * · parentTrackingNo 在锁内重读（CLAUDE.md 第 28 条：用锁内数据做决定）；
         * · 锁序 = 子单 → 父单，跟全系统「先子后父」的规矩一致（见 lock-shipments.ts）；
         * · 父单自己还留着货的那几张特例，syncParentStatusFromChildren 内部本来就不动它。
         */
        const lockedShipment = await tx.shipment.findUnique({
          where: { id: log.shipmentId },
          select: { parentTrackingNo: true },
        });
        if (lockedShipment?.parentTrackingNo) {
          await syncParentStatusFromChildren(tx, lockedShipment.parentTrackingNo, auth.companyId);
        }
      } else if (log.fromStatus && log.fromStatus !== log.toStatus) {
        /**
         * 2026-09-02 终审整改（P2）：删掉**唯一一条**轨迹后状态不回退的问题。
         * 上面「一条不剩就不动」的保护是给没有轨迹的已签收老单的（219 张）——
         * 它们的当前状态跟被删轨迹的 toStatus 对不上，不会走进这个分支。
         *
         * 2026-09-02 复核整改：上一版这里无论被删轨迹从哪来的，一律退到「已创建」——
         * 把「唯一一条 loaded→inWarehouseCN 的卸柜轨迹」删掉也被错退成「已创建」。
         * 改成退回**被删轨迹的 fromStatus**（轨迹本身记着它从哪来）：
         *   · created→inWarehouseCN 的入库轨迹删掉 → 退回 created；
         *   · loaded→inWarehouseCN 的卸柜轨迹删掉 → 退回 loaded。
         * fromStatus 为空或等于 toStatus（备注类轨迹）推不出来路 → 保持不动。
         * ⚠️ 状态用锁内重读的值判断（CLAUDE.md 第 28 条），不用事务外那份快照 ——
         * 只有当前状态确实还是被删轨迹的 toStatus 才退，别的状态一律照旧保持不动。
         */
        const lockedNow = await tx.shipment.findUnique({
          where: { id: log.shipmentId },
          select: { currentStatus: true, parentTrackingNo: true },
        });
        if (lockedNow?.currentStatus === log.toStatus) {
          await tx.shipment.update({
            where: { id: log.shipmentId },
            data: { currentStatus: log.fromStatus, updatedAt: new Date() },
          });
          // 子单状态变了照旧要重算父单大状态，口径跟上面 latest 分支一致
          if (lockedNow.parentTrackingNo) {
            await syncParentStatusFromChildren(tx, lockedNow.parentTrackingNo, auth.companyId);
          }
          return { newStatus: log.fromStatus, hasLogsLeft: false };
        }
      }
      return { newStatus: latest?.toStatus ?? log.shipment.currentStatus, hasLogsLeft: !!latest };
    });

    // 轨迹是给客户看的记录，谁删了什么必须留痕（只记状态和时间，不记客户信息）
    logger.warn("删除物流轨迹", {
      操作人: auth.userId,
      角色: auth.role,
      运单号: log.shipment.trackingNo,
      删掉的状态: log.toStatus,
      那条的时间: log.changedAt.toISOString(),
      删完当前状态: result.newStatus,
    });

    ok(res, {
      deleted: true,
      trackingNo: log.shipment.trackingNo,
      currentStatus: result.newStatus,
      hasLogsLeft: result.hasLogsLeft,
    });
  });


  /**
   * 客户端「我的订单」顶部那排数字（2026-08-10）。
   * where 比员工端多一条 `order.clientId = 自己`，其余口径完全一致 ——
   * 列表用的是 /client/shipments/search，那边的 where 也是这三条，改一边必须改另一边。
   */
  app.get("/client/shipments/overview", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    ok(res, await countShipmentOverview({
      companyId: auth.companyId,
      parentTrackingNo: null,
      order: { clientId: auth.userId },
    }));
  });

  /**
   * 员工端 / 管理员端运单列表顶部那排数字（2026-08-09，A3 方案 §3.2）。
   *
   * 用户选定要这四个：在途 / 延迟·查验 / 已到仓 / 本月已签收
   * （2026-09-03 起第三格由「已到仓待派送」改叫「已到仓」，口径含预约派送和派送中）。
   * 为什么值得做：有 7 张预报单从 8-01 挂到现在没人收货、有个柜子被误推成
   * 「延迟运输」也是事后才发现 —— 这排数字就是让这些一进来就看见。
   *
   * ⚠️ 「在途」用**减法**算，不要列举状态名。
   * 2026-08-08 管理员端柜子统计踩过：第一版列举在途状态，测试库 16 个柜子只数到 13 个，
   * 漏了两个老状态名，柜子凭空消失且没人发现。
   * 这里同理：精确认领「未发出 / 已到仓（含预约派送、派送中）/ 已完成 / 异常」几类，剩下的一律算在途，
   * 以后加了新状态也不会漏。返回里带上 total，各段相加应等于 total，一眼能看出有没有漏
   * （2026-09-02 起 exception 也从在途里扣掉了，对账时要把 exceptionCount 一起加上）。
   */
  app.get("/staff/shipments/overview", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    // 只数父运单，跟列表口径一致（子运单是分柜拆出来的，会重复计数）
    ok(res, await countShipmentOverview({
      companyId: auth.companyId,
      parentTrackingNo: null,
    }));
  });
}
