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
import { DEFAULT_STATUS_LABELS } from "../ai/ai-config-store";

/** 给员工/管理员看的货状态中文名（名单唯一来源在 ai-config-store） */
const SHIPMENT_STATUS_ZH: Record<string, string> = Object.fromEntries(DEFAULT_STATUS_LABELS.map((i) => [i.status, i.labelZh]));
import { loadOrderTotalMetrics } from "./total-metrics";
import { countShipmentOverview } from "./overview-counts";
import { loadPartialAhead } from "./partial-status";
import { CONTAINER_PUSH_LOG_MESSAGE, CURRENT_STATUS_LOG_MESSAGE, deleteBlockedReasonOf, MANAGED_LASTMILE_LOG_MESSAGE } from "./managed-lastmile-log";
import { findDeletedLogAudits } from "./deleted-log-audits";
import { BusinessError } from "../core/business-error";
import { canSeeOperatorIdentity, operatorNameForDisplay } from "../core/operator-visibility";

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
   * 管理员：查某票货被删过的轨迹（2026-09-17，推进账本做法）。
   * 删除接口删之前把原记录整条存进 audit_logs；按父单号查也把子单的一起列出来（9-15 删的「装入柜子」挂在子单上）。
   * 同一条记录删过多次只列最近一次；已经恢复回去（手动恢复或整柜撤销时自动放回）的标 restored。
   * 按运单 id 找存底，不按备注里的运单号（改过号也查得到）；全部列出、给总数，不截断（Codex 第三批 P2-1）。
   */
  app.get("/admin/shipments/track/deleted-logs", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const trackingNo = typeof req.query.trackingNo === "string" ? req.query.trackingNo.trim() : "";
    if (!trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
      return;
    }
    const shipmentIds = (await prisma.shipment.findMany({
      where: { companyId: auth.companyId, OR: [{ trackingNo }, { parentTrackingNo: trackingNo }] },
      select: { id: true },
    })).map((s) => s.id);
    const idSet = new Set(shipmentIds);
    const rows = await findDeletedLogAudits(prisma, auth.companyId, shipmentIds);
    const latestByLog = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (latestByLog.has(r.resourceId)) continue;
      let sid: unknown;
      try { sid = JSON.parse(r.beforeJson ?? "{}").shipmentId; } catch { continue; }
      if (typeof sid === "string" && idSet.has(sid)) latestByLog.set(r.resourceId, r);
    }
    const logIds = [...latestByLog.keys()];
    const stillThere = new Set((await prisma.statusLog.findMany({ where: { id: { in: logIds }, companyId: auth.companyId }, select: { id: true } })).map((l) => l.id));
    const actorIds = [...new Set([...latestByLog.values()].map((r) => r.actorId))];
    const names = new Map((await prisma.user.findMany({ where: { id: { in: actorIds }, companyId: auth.companyId }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    ok(res, {
      total: latestByLog.size,
      items: [...latestByLog.values()].map((r) => {
        let log: Record<string, unknown> = {};
        try { log = JSON.parse(r.beforeJson ?? "{}"); } catch { log = {}; }
        // 被删的那条如果是客户自己下预报那步，老记录里存的是客户名字 —— 发给页面前换成唛头（2026-09-19，Opus 第 3 轮）。
        // 只改发出去的这份，恢复用的是库里的 beforeJson 原文，不受影响
        if ("operatorName" in log) log = { ...log, operatorName: operatorNameForDisplay(log as Parameters<typeof operatorNameForDisplay>[0]) };
        return {
          auditId: r.id,
          deletedBy: r.actorId,
          deletedByName: names.get(r.actorId) ?? "",
          deletedAt: r.createdAt.toISOString(),
          restored: stillThere.has(r.resourceId),
          log,
        };
      }),
    });
  });

  /**
   * 管理员：把删掉的轨迹原样恢复（2026-09-17）。只放回记录，不改任何状态。
   * 这一步已经被整柜撤销撤掉了（记录的状态比货现在靠后）就不许恢复 —— 放回来客户会看到一条跟状态对不上的记录。
   */
  app.post("/admin/shipments/track/restore-log", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const auditId = typeof body.auditId === "string" ? body.auditId.trim() : "";
    const audit = await prisma.auditLog.findFirst({ where: { id: auditId, companyId: auth.companyId, action: "DELETE", resourceType: "StatusLog" } });
    let before: any = null;
    try { before = audit?.beforeJson ? JSON.parse(audit.beforeJson) : null; } catch { before = null; }
    if (!audit || !before) { fail(res, 404, "NOT_FOUND", "找不到这条删除记录"); return; }
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${before.shipmentId} FOR UPDATE`;
      const ship = await tx.shipment.findFirst({ where: { id: before.shipmentId, companyId: auth.companyId }, select: { id: true, currentStatus: true } });
      if (!ship) throw new BusinessError("这票货已经不在了，没法恢复", 409, "VALIDATION_ERROR");
      {
        // 海运、陆运两条流程都比，不按这票货的运输方式挑一条（Codex 第三批 P1-2）：老数据运单没填运输方式、订单后来改过，
        // 只按一条流程比会查不到记录的状态而放行，客户看到「已装柜」的货上面多一条「已开船」。
        //   · 哪条流程里两个状态都在、记录排在货现在的状态后面 → 这一步已经撤了，不许恢复；
        //   · 两条流程里都比不出先后（又不是同一个状态，比如货已退回）→ 说不准会不会跟状态对不上，也不许恢复。
        const rec = String(before.toStatus ?? "");
        const cur = ship.currentStatus;
        let comparable = rec === cur;
        let ahead = false;
        for (const flow of [STATUS_FLOW, STATUS_FLOW_LAND] as ReadonlyArray<readonly string[]>) {
          const a = flow.indexOf(rec);
          const b = flow.indexOf(cur);
          if (a >= 0 && b >= 0) {
            comparable = true;
            if (a > b) ahead = true;
          }
        }
        if (ahead) {
          throw new BusinessError(`这一步已经被撤销了（货现在是「${SHIPMENT_STATUS_ZH[cur] ?? cur}」），恢复回来会跟状态对不上，不能恢复`, 409, "VALIDATION_ERROR");
        }
        if (!comparable) {
          throw new BusinessError(`这条记录是「${SHIPMENT_STATUS_ZH[rec] ?? rec}」，货现在是「${SHIPMENT_STATUS_ZH[cur] ?? cur}」，比不出先后，恢复回来可能跟状态对不上，不能恢复`, 409, "VALIDATION_ERROR");
        }
      }
      // 状态没变的记录（比如重复的「已封柜」）光比状态挡不住：整柜撤销时把那一步的全部记录 id 记在撤销日志里，在里面就不许恢复
      {
        const undos = await tx.auditLog.findMany({
          where: { companyId: auth.companyId, action: "UNDO", resourceType: "Container", beforeJson: { contains: String(before.id) } },
          select: { beforeJson: true },
        });
        const undone = undos.some((u) => {
          try { return ((JSON.parse(u.beforeJson ?? "{}").undoneLogIds ?? []) as string[]).includes(String(before.id)); } catch { return false; }
        });
        if (undone) {
          throw new BusinessError("这条记录所在的那一步已经被整柜撤销了，恢复回来会跟柜子对不上，不能恢复", 409, "VALIDATION_ERROR");
        }
      }
      const exists = await tx.statusLog.findUnique({ where: { id: before.id }, select: { id: true } });
      if (exists) throw new BusinessError("这条记录已经恢复过了", 409, "VALIDATION_ERROR");
      await tx.statusLog.create({ data: {
        id: before.id, companyId: before.companyId, shipmentId: before.shipmentId,
        operatorId: before.operatorId, operatorRole: before.operatorRole, operatorName: before.operatorName ?? "",
        fromStatus: before.fromStatus, toStatus: before.toStatus, remark: before.remark ?? null, nextStop: before.nextStop ?? null,
        changedAt: new Date(before.changedAt),
      } });
      await tx.auditLog.create({ data: { companyId: auth.companyId, actorId: auth.userId, actorRole: auth.role, action: "RESTORE", resourceType: "StatusLog", resourceId: before.id, afterJson: audit.beforeJson, remark: `恢复物流轨迹 ${before.trackingNo ?? ""}` } });
      return { restored: true, logId: before.id };
    });
    ok(res, result);
  });

  /**
   * 删掉物流轨迹里的一条（员工和管理员都能用）。
   *
   * 2026-08-07 加的，原来删完会按剩下的最后一条记录把运单状态改回去。
   *
   * ⚠️⚠️ 2026-09-17 老板拍板改成：**只删记录，不改任何运单 / 父单的状态。**
   * 原因（生产只读核实）：很多记录的时间是按柜子日期补的，「剩下的最后一条」常常不是真实状态 ——
   *   · 9-15 员工在轨迹里删了父单那条「已从柜子卸下」，12 票父单被改成「已创建」（货其实在泰国清关），
   *     其中 6 票一直错到第二天推柜子；
   *   · 全库 953 张 0 件父单里 940 张，删它自己任何一条都会被改错；普通单也有 2 张。
   * 状态推错了走正规撤回：柜子推错到「装柜管理」撤销，派送/签收错了在尾端派送里撤。
   *
   * ⚠️ 显示当前状态的最后一条不许删（409）：状态不跟着退，删了它顶上的状态在轨迹里就对不上了。
   *    同一状态有两条时可以删掉一条。
   * ⚠️ 派送业务写的记录照旧不许单删（isManagedLastmileLog）。
   * ⚠️ 2026-09-17 老板定「推进账本」做法后又加两条：
   *    · 柜子推进 / 随柜补记里改了状态的记录不许删（isContainerPushTransitionLog），推错用装柜管理撤销；
   *    · 删之前把原记录整条存进 audit_logs（谁、什么时候删的），管理员能查能恢复，
   *      整柜撤销退回「已装柜」又找不到记录时会把「装入柜子」自动放回（containers/routes.ts autoRestoreDeletedLogs）。
   *    三道判断和轨迹弹窗共用 deleteBlockedReasonOf 的口径，顺序一样。
   * 回归：scripts/test-push-ledger-db.ts、test-track-delete-keeps-status-db.ts（真库按 9-15 操作重现）、test-shipment-track-actions.ts。
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
       * ⚠️ 先锁运单（2026-08-29 补；2026-09-17 不改状态了照样要锁）。
       * 「是不是当前状态的最后一条」要拿锁内的状态和条数判断（CLAUDE.md 第 28 条）：
       * 推柜子状态可能正同时改这票货的状态；两个人同时删同一状态的两条，
       * 不锁的话两边都看到「还有两条」，删完一条不剩。
       */
      await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${log.shipmentId} FOR UPDATE`;
      const lockedLog = await tx.statusLog.findFirst({
        where: { id: logId, shipmentId: log.shipmentId, companyId: auth.companyId },
      });
      if (!lockedLog) throw new BusinessError("这条轨迹已被处理，请刷新后重试", 404, "NOT_FOUND");
      const lockedShipment = await tx.shipment.findUnique({
        where: { id: log.shipmentId },
        select: { currentStatus: true },
      });
      if (!lockedShipment) throw new BusinessError("这票货已经不在了，请刷新后重试", 404, "NOT_FOUND");
      /**
       * 三道判断**直接调 deleteBlockedReasonOf**（managed-lastmile-log.ts），跟轨迹弹窗
       * （containers/routes.ts 的 GET /client/shipments/track）是同一份代码、同一个顺序。
       * 2026-09-18 复核提醒：这里原来是把那三个 if 内联抄了一遍，当时判断等价，但改一边漏一边时
       * 弹窗会说「能删」、点下去却 409。现在只有一份口径。
       */
      const sameStatusCount = await tx.statusLog.count({
        where: { shipmentId: log.shipmentId, toStatus: lockedShipment.currentStatus },
      });
      const blockedReason = deleteBlockedReasonOf(lockedLog, lockedShipment.currentStatus, sameStatusCount);
      if (blockedReason) {
        const message = blockedReason === "lastmile"
          ? MANAGED_LASTMILE_LOG_MESSAGE
          : blockedReason === "containerPush"
            ? CONTAINER_PUSH_LOG_MESSAGE
            : CURRENT_STATUS_LOG_MESSAGE;
        throw new BusinessError(message, 409, "VALIDATION_ERROR");
      }
      // 删之前把原记录整条存进操作日志：谁、什么时候删的，管理员能原样恢复
      await tx.auditLog.create({
        data: {
          companyId: auth.companyId,
          actorId: auth.userId,
          actorRole: auth.role,
          action: "DELETE",
          resourceType: "StatusLog",
          resourceId: logId,
          beforeJson: JSON.stringify({ ...lockedLog, trackingNo: log.shipment.trackingNo }),
          remark: `删除物流轨迹 ${log.shipment.trackingNo}`,
        },
      });
      await tx.statusLog.delete({ where: { id: logId } });
      return { currentStatus: lockedShipment.currentStatus };
    });

    // 轨迹是给客户看的记录，谁删了什么必须留痕（只记状态和时间，不记客户信息）
    logger.warn("删除物流轨迹", {
      操作人: auth.userId,
      角色: auth.role,
      运单号: log.shipment.trackingNo,
      删掉的状态: log.toStatus,
      那条的时间: log.changedAt.toISOString(),
      当前状态不变: result.currentStatus,
    });

    ok(res, {
      deleted: true,
      trackingNo: log.shipment.trackingNo,
      currentStatus: result.currentStatus,
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
