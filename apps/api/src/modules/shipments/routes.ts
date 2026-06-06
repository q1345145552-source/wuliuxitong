// B-5: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, parseJsonArray, requireRole } from "../core/http-utils";


const STATUS_FLOW = [
  "loaded",
  "delayDeparted",
  "departed",
  "arrivedPort",
  "customsTH",
  "customsCleared",
  "inWarehouseTH",
  "outForDelivery",
  "delivered",
];
const EXCEPTION_STATUSES = new Set(["exception", "returned", "cancelled"]);

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

function canTransit(fromStatus: string, toStatus: string): boolean {
  if (fromStatus === toStatus) return true;
  if (EXCEPTION_STATUSES.has(toStatus)) return true;
  const fromIndex = STATUS_FLOW.indexOf(fromStatus);
  const toIndex = STATUS_FLOW.indexOf(toStatus);
  if (fromIndex < 0 || toIndex < 0) return false;
  return toIndex === fromIndex + 1;
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
        operatorId: item.operatorId,
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

  app.get("/public/track", async (req, res) => {
    const trackingNo = req.query.trackingNo?.trim();
    const phoneLast4 = req.query.phoneLast4?.trim();
    if (!trackingNo || !phoneLast4 || phoneLast4.length !== 4) {
      fail(res, 400, "BAD_REQUEST", "trackingNo and phoneLast4(4 digits) are required");
      return;
    }
    const shipment = await prisma.shipment.findUnique({
      where: { trackingNo },
      include: {
        order: {
          select: {
            id: true,
            itemName: true,
            receiverPhoneTh: true,
            client: { select: { phone: true } },
          },
        },
      },
    });
    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }
    const receiverTail = (shipment.order.receiverPhoneTh ?? "").slice(-4);
    const clientTail = (shipment.order.client?.phone ?? "").slice(-4);
    if (phoneLast4 !== receiverTail && phoneLast4 !== clientTail) {
      fail(res, 403, "FORBIDDEN", "phone verification failed");
      return;
    }
    const logs = await prisma.statusLog.findMany({
      where: { shipmentId: shipment.id },
      orderBy: { changedAt: "asc" },
    });
    ok(res, {
      trackingNo: shipment.trackingNo,
      domesticTrackingNo: shipment.domesticTrackingNo ?? undefined,
      batchNo: shipment.batchNo ?? undefined,
      orderId: shipment.order.id,
      itemName: shipment.order.itemName,
      currentStatus: shipment.currentStatus,
      currentLocation: shipment.currentLocation ?? undefined,
      updatedAt: shipment.updatedAt.toISOString(),
      events: logs.map((item) => ({
        fromStatus: item.fromStatus,
        toStatus: item.toStatus,
        remark: item.remark ?? "",
        changedAt: item.changedAt.toISOString(),
      })),
    });
  });

  app.get("/client/express/universal", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;
    const trackingNo = req.query.trackingNo?.trim();
    const companyCode = req.query.companyCode?.trim();
    if (!trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
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
        order: { clientId: auth.userId },
      },
      orderBy: { updatedAt: "desc" },
      include: {
        order: {
          select: { id: true, clientId: true, itemName: true, transportMode: true },
        },
      },
    });

    const items = rows
      .filter((r) => !trackingNo || r.trackingNo.includes(trackingNo))
      .filter((r) => !domesticTrackingNo || r.domesticTrackingNo.includes(domesticTrackingNo))
      .filter((r) => !itemName || r.order.itemName.includes(itemName))
      .filter((r) => !transportMode || r.order.transportMode === transportMode)
      .map((r) => ({
        id: r.id,
        orderId: r.orderId,
        orderNo: r.order.orderNo ?? undefined,
        trackingNo: r.trackingNo,
        batchNo: r.batchNo,
        currentStatus: r.currentStatus,
        currentLocation: r.currentLocation,
        updatedAt: r.updatedAt.toISOString(),
        weightKg: decToNumber(r.weightKg),
        volumeM3: decToNumber(r.volumeM3),
        packageCount: r.packageCount,
        packageUnit: r.packageUnit,
        domesticTrackingNo: r.domesticTrackingNo,
      }));

    ok(res, { items, page: 1, pageSize: items.length, total: items.length });
  });

  app.get("/staff/shipments", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const rows = await prisma.shipment.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        order: {
          include: {
            client: { select: { name: true } },
          },
        },
      },
    });

    const items = rows.map((r) => ({
      id: r.id,
      orderId: r.order?.id ?? undefined,
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
      arrivedAt: r.order?.createdAt.toISOString() ?? undefined,
      currentStatus: r.currentStatus,
      warehouseId: r.warehouseId,
      updatedAt: r.updatedAt.toISOString(),
      transportMode: r.order?.transportMode ?? undefined,
      shipDate: r.order?.shipDate ?? undefined,
      receiverAddressTh: r.order?.receiverAddressTh ?? undefined,
      receivableAmountCny: decToNumber(r.order?.receivableAmountCny ?? null) ?? undefined,
      receivableCurrency: r.order?.receivableCurrency ?? undefined,
      paymentStatus: (r.order?.paymentStatus === "paid" ? "paid" : "unpaid") as "paid" | "unpaid",
      packageUnit: ((r.order?.packageUnit === "bag" ? "bag" : "box") as "bag" | "box"),
      cargoType: r.order?.cargoType ?? "NORMAL",
      canEdit: auth.role === "admin",
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
        list.push({ id: r.id, itemName: r.itemName, packageCount: r.packageCount, lengthCm: r.lengthCm, widthCm: r.widthCm, heightCm: r.heightCm, productQuantity: r.productQuantity, cargoType: r.cargoType });
        pmap.set(r.orderId, list);
      }
      const imap = new Map<string, any[]>();
      for (const r of imageRows) {
        const list = imap.get(r.orderId) ?? [];
        list.push({ id: r.id, fileName: r.fileName, mime: r.mime, contentBase64: r.contentBase64, createdAt: r.createdAt.toISOString() });
        imap.set(r.orderId, list);
      }
      for (const item of items) {
        if (item.orderId) {
          item.products = pmap.get(item.orderId);
          item.productImages = imap.get(item.orderId);
        }
      }
    }

    ok(res, { items, page: 1, pageSize: items.length, total: items.length });
  });

  // 按需加载单个订单的产品图
  app.get("/staff/shipments/images", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const orderId = req.query.orderId?.trim();
    if (!orderId) { fail(res, 400, "BAD_REQUEST", "orderId required"); return; }
    const imageMap = await loadProductImagesForOrders(auth.companyId, [orderId]);
    ok(res, { images: imageMap.get(orderId) ?? [] });
  });

  app.post("/staff/shipments/update-status", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      shipmentId?: string;
      batchNo?: string;
      toStatus?: string;
      remark?: string;
      updateByBatch?: boolean;
    };
    if (!body.toStatus) {
      fail(res, 400, "BAD_REQUEST", "toStatus is required");
      return;
    }
    const updateByBatch = Boolean(body.updateByBatch || body.batchNo?.trim());
    if (!updateByBatch && !body.shipmentId) {
      fail(res, 400, "BAD_REQUEST", "shipmentId is required when updateByBatch=false");
      return;
    }
    if (updateByBatch && !body.batchNo?.trim()) {
      fail(res, 400, "BAD_REQUEST", "batchNo is required when updateByBatch=true");
      return;
    }

    const targetShipments = updateByBatch
      ? await prisma.shipment.findMany({
          where: { batchNo: body.batchNo?.trim(), companyId: auth.companyId },
          select: { id: true, currentStatus: true, warehouseId: true },
        })
      : await prisma.shipment.findMany({
          where: { id: body.shipmentId, companyId: auth.companyId },
          select: { id: true, currentStatus: true, warehouseId: true },
        });
    if (targetShipments.length === 0) {
      fail(res, 404, "NOT_FOUND", updateByBatch ? "batch shipments not found" : "shipment not found");
      return;
    }


    const invalid = targetShipments.some((shipment) => !canTransit(shipment.currentStatus, body.toStatus!));
    if (invalid) {
      fail(res, 400, "VALIDATION_ERROR", "invalid status transition");
      return;
    }

    const now = new Date();
    await prisma.$transaction(
      targetShipments.flatMap((shipment, idx) => [
        prisma.shipment.update({
          where: { id: shipment.id },
          data: { currentStatus: body.toStatus!, updatedAt: now },
        }),
        prisma.statusLog.create({
          data: {
            id: `sl_${Date.now()}_${idx}`,
            companyId: auth.companyId,
            shipmentId: shipment.id,
            operatorId: auth.userId,
            operatorRole: auth.role,
            fromStatus: shipment.currentStatus,
            toStatus: body.toStatus!,
            remark: body.remark ?? null,
            changedAt: now,
          },
        }),
      ]),
    );

    ok(res, {
      mode: updateByBatch ? "batch" : "single",
      batchNo: body.batchNo?.trim() || null,
      shipmentId: updateByBatch ? null : targetShipments[0]?.id,
      shipmentIds: targetShipments.map((s) => s.id),
      fromStatus: targetShipments[0]?.currentStatus ?? null,
      toStatus: body.toStatus,
      updatedCount: targetShipments.length,
      changedAt: now.toISOString(),
    });
  });

  /**
   * 运单分柜：从父单拆出子单，父单扣除件数，子单独立追踪。
   */
  app.post("/staff/shipments/split", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      parentShipmentId?: string;
      splits?: Array<{
        trackingNo: string;
        batchNo: string;
        itemName: string;
        packageCount: number;
      }>;
    };

    const parentId = body.parentShipmentId?.trim();
    const splits = body.splits ?? [];
    if (!parentId || splits.length === 0) {
      fail(res, 400, "BAD_REQUEST", "parentShipmentId and at least one split are required");
      return;
    }
    if (splits.some((s) => !s.trackingNo?.trim())) {
      fail(res, 400, "BAD_REQUEST", "每一条分柜运单号均为必填");
      return;
    }
    // 检查分柜运单号是否重复
    const splitNos = splits.map((s) => s.trackingNo.trim());
    if (new Set(splitNos).size !== splitNos.length) {
      fail(res, 400, "BAD_REQUEST", "分柜运单号不可重复");
      return;
    }
    const existingNos = await prisma.shipment.findMany({
      where: { trackingNo: { in: splitNos }, companyId: auth.companyId },
      select: { trackingNo: true },
    });
    if (existingNos.length > 0) {
      fail(res, 409, "CONFLICT", `运单号 ${existingNos.map((s) => s.trackingNo).join(", ")} 已存在`);
      return;
    }

    const parent = await prisma.shipment.findUnique({
      where: { id: parentId },
      include: { order: { select: { id: true, companyId: true } } },
    });
    if (!parent || parent.companyId !== auth.companyId) {
      fail(res, 404, "NOT_FOUND", "parent shipment not found");
      return;
    }
    if (parent.parentTrackingNo) {
      fail(res, 400, "BAD_REQUEST", "cannot split a child shipment");
      return;
    }

    const totalSplitCount = splits.reduce((sum, s) => sum + s.packageCount, 0);
    const parentPackageCount = parent.packageCount ?? 0;
    if (totalSplitCount > parentPackageCount) {
      fail(res, 400, "BAD_REQUEST", `split total (${totalSplitCount}) exceeds parent package count (${parentPackageCount})`);
      return;
    }

    const results: Array<{ trackingNo: string; shipmentId: string }> = [];

    await prisma.$transaction(async (tx) => {
      // 更新父单：扣减件数
      await tx.shipment.update({
        where: { id: parent.id },
        data: {
          packageCount: parentPackageCount - totalSplitCount,
        },
      });

      // 创建子单
      for (let i = 0; i < splits.length; i++) {
        const split = splits[i];
        const childId = `s_${Date.now()}_${i}`;
        const childTrackingNo = split.trackingNo.trim();

        await tx.shipment.create({
          data: {
            id: childId,
            companyId: auth.companyId,
            orderId: parent.orderId,
            trackingNo: childTrackingNo,
            parentTrackingNo: parent.trackingNo,
            batchNo: split.batchNo,
            itemName: split.itemName,
            currentStatus: parent.currentStatus,
            packageCount: split.packageCount,
            packageUnit: parent.packageUnit,
            transportMode: parent.transportMode,
            warehouseId: parent.warehouseId,
          },
        });

        results.push({ trackingNo: childTrackingNo, shipmentId: childId });
      }
    });

    ok(res, { parentTrackingNo: parent.trackingNo, children: results });
  });

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
}
