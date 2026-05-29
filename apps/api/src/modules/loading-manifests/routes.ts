import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

/**
 * 生成装柜单号：CN-TH-YYYYMMDDNNN。
 */
async function issueManifestNo(now: Date): Promise<string> {
  const dateKey = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const prefix = `CN-TH-${dateKey}`;
  const list = await prisma.container.findMany({
    where: { containerNo: { startsWith: prefix } },
    select: { containerNo: true },
  });
  let max = 0;
  for (const item of list) {
    const n = Number.parseInt(item.containerNo.slice(prefix.length), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

/**
 * 注册装柜管理接口。
 */
export function registerLoadingManifestRoutes(app: MinimalHttpApp): void {
  // 装柜任务列表
  app.get("/staff/loading-manifests", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const keyword = (req.query.query ?? "").trim();
    const status = (req.query.status ?? "").trim();
    const where: any = { companyId: auth.companyId };
    if (keyword) where.containerNo = { contains: keyword, mode: "insensitive" };
    if (status && status !== "ALL") where.currentStatus = status;
    const list = await prisma.container.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { items: { select: { id: true } } },
    });
    ok(res, {
      items: list.map((c) => ({
        id: c.id,
        manifestNo: c.containerNo,
        warehouse: c.warehouseId ?? "未知",
        status: c.currentStatus ?? "LOADING",
        carrierInfo: c.carrierName ?? null,
        sealedAt: c.sealedAt?.toISOString() ?? null,
        totalBills: c.items.length,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  });

  // 新建装柜任务
  app.post("/staff/loading-manifests", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { warehouse?: string; carrierInfo?: string };
    if (!body.warehouse) { fail(res, 400, "BAD_REQUEST", "仓库参数无效"); return; }
    const manifestNo = await issueManifestNo(new Date());
    const container = await prisma.container.create({
      data: {
        id: `ctr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        companyId: auth.companyId,
        containerNo: manifestNo,
        containerType: body.warehouse === "wh_dongguan_01" ? "40HQ" : "20GP",
        warehouseId: body.warehouse,
        currentStatus: "LOADING",
        carrierName: body.carrierInfo?.trim() || null,
      },
    });
    ok(res, { message: "装柜任务已创建", manifest: { id: container.id, manifestNo: container.containerNo } });
  });

  // 装柜详情
  app.get("/staff/loading-manifests/detail", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id as string;
    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      include: {
        items: {
          include: {
            shipment: {
              select: { id: true, trackingNo: true, batchNo: true, currentStatus: true, weightKg: true, volumeM3: true, order: { select: { itemName: true } } },
            },
          },
        },
      },
    });
    if (!container) { fail(res, 404, "NOT_FOUND", "装柜任务不存在"); return; }
    ok(res, {
      id: container.id,
      manifestNo: container.containerNo,
      warehouse: container.warehouseId,
      status: container.currentStatus ?? "LOADING",
      carrierInfo: container.carrierName ?? null,
      sealedAt: container.sealedAt?.toISOString() ?? null,
      bills: container.items.map((item) => ({
        id: item.id,
        shipmentId: item.shipmentId,
        trackingNo: item.shipment?.trackingNo ?? null,
        batchNo: item.shipment?.batchNo ?? null,
        itemName: item.shipment?.order?.itemName ?? null,
        currentStatus: item.shipment?.currentStatus ?? null,
      })),
    });
  });

  // 封柜
  app.post("/staff/loading-manifests/seal", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id as string;
    const container = await prisma.container.findFirst({ where: { id, companyId: auth.companyId } });
    if (!container) { fail(res, 404, "NOT_FOUND", "装柜任务不存在"); return; }
    if (container.currentStatus === "SEALED" || container.currentStatus === "IN_TRANSIT" || container.currentStatus === "ARRIVED") {
      fail(res, 400, "BAD_REQUEST", "该柜已封柜或已运输/到达"); return;
    }
    const updated = await prisma.container.update({
      where: { id },
      data: { currentStatus: "SEALED", sealedAt: new Date() },
    });
    ok(res, { message: "封柜成功", manifest: { id: updated.id, status: updated.currentStatus } });
  });

  // 添加运单到装柜（通过运单号 trackingNo）
  app.post("/staff/loading-manifests/add-shipment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id as string;
    const body = (req.body ?? {}) as { trackingNo?: string };
    if (!body.trackingNo?.trim()) { fail(res, 400, "BAD_REQUEST", "运单号不能为空"); return; }
    // 按运单号查找 shipment
    const shipment = await prisma.shipment.findFirst({
      where: { trackingNo: body.trackingNo.trim(), companyId: auth.companyId },
    });
    if (!shipment) { fail(res, 404, "NOT_FOUND", "未找到该运单号"); return; }
    const container = await prisma.container.findFirst({ where: { id, companyId: auth.companyId } });
    if (!container) { fail(res, 404, "NOT_FOUND", "装柜任务不存在"); return; }
    if (container.currentStatus !== "LOADING") { fail(res, 400, "BAD_REQUEST", "只能在装柜中状态添加运单"); return; }
    // Check if already added
    const existing = await prisma.shipmentContainerItem.findFirst({
      where: { containerId: id, shipmentId: shipment.id },
    });
    if (existing) { fail(res, 400, "BAD_REQUEST", "该运单已在本柜中"); return; }
    // 计算体积和件数（取 shipment 上的值，无则默认为 0）
    const loadedVolume = shipment.volumeM3 ? Number(shipment.volumeM3) : 0;
    const loadedPieces = shipment.packageCount ?? 0;
    await prisma.shipmentContainerItem.create({
      data: {
        id: `sci_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        containerId: id,
        shipmentId: shipment.id,
        loadedVolumeM3: loadedVolume,
        loadedPieceCount: loadedPieces,
      },
    });
    // 更新运单状态为 loaded（已装柜）
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { currentStatus: "loaded" },
    });
    ok(res, { message: "运单已添加到装柜", trackingNo: body.trackingNo });
  });

  // 从装柜删除运单
  app.post("/staff/loading-manifests/remove-shipment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id as string;
    const body = (req.body ?? {}) as { itemId?: string };
    if (!body.itemId) { fail(res, 400, "BAD_REQUEST", "itemId required"); return; }
    const item = await prisma.shipmentContainerItem.findFirst({
      where: { id: body.itemId, container: { companyId: auth.companyId } },
    });
    if (!item) { fail(res, 404, "NOT_FOUND", "装柜记录不存在"); return; }
    await prisma.shipmentContainerItem.delete({ where: { id: body.itemId } });
    ok(res, { message: "运单已从装柜删除" });
  });
}
