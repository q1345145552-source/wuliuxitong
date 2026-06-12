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
    const trackingNo = (req.query.trackingNo ?? "").trim();
    const status = (req.query.status ?? "").trim();
    const where: any = { companyId: auth.companyId };
    if (keyword) where.containerNo = { contains: keyword, mode: "insensitive" };
    if (status && status !== "ALL") where.currentStatus = status;
    // 按运单号过滤：查找包含该运单号的柜子
    if (trackingNo) {
      const matchingItems = await prisma.shipmentContainerItem.findMany({
        where: { shipment: { trackingNo: { contains: trackingNo, mode: "insensitive" } } },
        select: { containerId: true },
      });
      where.id = { in: [...new Set(matchingItems.map(i => i.containerId))] };
    }
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
    const body = (req.body ?? {}) as { warehouse?: string; carrierInfo?: string; containerNo?: string };
    if (!body.warehouse) { fail(res, 400, "BAD_REQUEST", "仓库参数无效"); return; }
    const containerNo = body.containerNo?.trim() || await issueManifestNo(new Date());
    // 查重
    const existed = await prisma.container.findUnique({ where: { containerNo }, select: { id: true } });
    if (existed) { fail(res, 409, "CONFLICT", `柜号 ${containerNo} 已存在`); return; }
    const container = await prisma.container.create({
      data: {
        id: `ctr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        companyId: auth.companyId,
        containerNo,
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
          orderBy: { createdAt: "asc" },
          include: {
            shipment: {
              select: {
                id: true, trackingNo: true, batchNo: true, currentStatus: true, parentTrackingNo: true,
                weightKg: true, volumeM3: true, packageCount: true, packageUnit: true,
                transportMode: true, domesticTrackingNo: true,
                order: { select: { itemName: true, clientId: true, productQuantity: true, cargoType: true } },
              },
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
        clientId: item.shipment?.order?.clientId ?? null,
        productQuantity: item.shipment?.order?.productQuantity ?? null,
        cargoType: item.shipment?.order?.cargoType ?? null,
        packageCount: item.shipment?.packageCount ?? null,
        transportMode: item.shipment?.transportMode ?? null,
        currentStatus: item.shipment?.currentStatus ?? null,
        parentTrackingNo: item.shipment?.parentTrackingNo ?? null,
        loadedPieces: item.loadedPieceCount,
        loadedVolume: Number(item.loadedVolumeM3),
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

  // 添加运单到装柜（通过运单号 trackingNo，可选 pieceCount 按件数分装）
  app.post("/staff/loading-manifests/add-shipment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const containerId = req.query.id as string;
    const body = (req.body ?? {}) as { trackingNo?: string; pieceCount?: number };
    if (!body.trackingNo?.trim()) { fail(res, 400, "BAD_REQUEST", "运单号不能为空"); return; }

    const result = await prisma.$transaction(async (tx) => {
      const container = await tx.container.findFirst({ where: { id: containerId, companyId: auth.companyId } });
      if (!container) throw new Error("装柜任务不存在");

      // 锁父运单防并发
      const shipment = await tx.shipment.findFirst({
        where: { trackingNo: body.trackingNo!.trim(), companyId: auth.companyId },
      });
      if (!shipment) throw new Error("未找到该运单号");
      if (shipment.parentTrackingNo) throw new Error("子运单不能再次装柜，请使用父运单号");

      await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${shipment.id} FOR UPDATE`;
      const locked = await tx.shipment.findUnique({ where: { id: shipment.id }, select: { packageCount: true, volumeM3: true } });
      const totalPkg = locked?.packageCount ?? 0;
      const reqPieces = typeof body.pieceCount === "number" && body.pieceCount > 0 ? body.pieceCount : totalPkg;
      if (reqPieces > totalPkg) throw new Error(`装柜件数(${reqPieces})超过运单总件数(${totalPkg})`);

      const vol = locked?.volumeM3 ? Number(locked.volumeM3) : 0;
      if (reqPieces === 0) throw new Error("装柜件数不能为0");

      let loadShipmentId = shipment.id;
      let loadTrackingNo = shipment.trackingNo;

      // 部分装 → 建子运单；全部装 → 父运单直装（但必须扣件数到0）
      if (reqPieces < totalPkg) {
        const children = await tx.shipment.findMany({
          where: { parentTrackingNo: shipment.trackingNo, companyId: auth.companyId },
          select: { trackingNo: true },
          orderBy: { trackingNo: "asc" },
        });
        let nextSeq = 1;
        for (const c of children) {
          const match = c.trackingNo.match(/-(\d+)$/);
          if (match) { const n = parseInt(match[1]); if (n >= nextSeq) nextSeq = n + 1; }
        }
        const childTrackingNo = `${shipment.trackingNo}-${nextSeq}`;
        const childId = `s_${Date.now()}`;
        const childVolume = Number(((vol * reqPieces) / totalPkg).toFixed(3));

        await tx.shipment.create({
          data: {
            id: childId, companyId: auth.companyId, orderId: shipment.orderId,
            trackingNo: childTrackingNo, parentTrackingNo: shipment.trackingNo,
            batchNo: shipment.batchNo, currentStatus: "loaded",
            packageCount: reqPieces, packageUnit: shipment.packageUnit,
            weightKg: shipment.weightKg, volumeM3: childVolume,
            transportMode: shipment.transportMode, domesticTrackingNo: shipment.domesticTrackingNo,
            warehouseId: shipment.warehouseId, itemName: shipment.itemName,
          },
        });

        await tx.shipment.update({
          where: { id: shipment.id },
          data: { packageCount: totalPkg - reqPieces, updatedAt: new Date() },
        });

        loadShipmentId = childId;
        loadTrackingNo = childTrackingNo;
      } else {
        // 全部装柜：父运单直装，件数扣到0
        await tx.shipment.update({
          where: { id: shipment.id },
          data: { packageCount: 0, updatedAt: new Date() },
        });
      }

      // 装柜
      const existing = await tx.shipmentContainerItem.findFirst({
        where: { containerId, shipmentId: loadShipmentId },
      });
      if (existing) throw new Error("该运单已在本柜中");

      const loadPieces = reqPieces;
      const loadVolume = Number(((totalPkg > 0 ? (vol * reqPieces) / totalPkg : 0)).toFixed(3));
      const itemId = `sci_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await tx.shipmentContainerItem.create({
        data: { id: itemId, containerId, shipmentId: loadShipmentId, loadedVolumeM3: loadVolume, loadedPieceCount: loadPieces },
      });

      // 状态同步
      const syncMap: Record<string, string> = {
        SEALED: "loaded", IN_TRANSIT: "departed", DELAY_DEPARTED: "delayDeparted",
        ARRIVED: "arrivedPort", CUSTOMS: "customsTH", CUSTOMS_CLEARED: "customsCleared",
        IN_WAREHOUSE_TH: "inWarehouseTH",
      };
      const syncStatus = syncMap[container.currentStatus] ?? null;
      const now = new Date();
      if (syncStatus) {
        await tx.shipment.update({ where: { id: loadShipmentId }, data: { currentStatus: syncStatus, updatedAt: now } });
        await tx.statusLog.create({
          data: { id: `sl_mnf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, companyId: auth.companyId, shipmentId: loadShipmentId, operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "", fromStatus: "loaded", toStatus: syncStatus, remark: `装入柜子 ${container.containerNo}${reqPieces < totalPkg ? `（分装 ${reqPieces}件）` : ""}`, changedAt: now },
        });
      } else {
        await tx.shipment.update({ where: { id: loadShipmentId }, data: { currentStatus: "loaded" } });
      }

      return { loadTrackingNo, isPartial: reqPieces < totalPkg, parentTrackingNo: reqPieces < totalPkg ? shipment.trackingNo : null };
    });

    ok(res, { message: "运单已添加到装柜", trackingNo: result.loadTrackingNo, isPartial: result.isPartial, parentTrackingNo: result.parentTrackingNo });
  });

  // 从装柜卸下运单（可选 pieceCount 部分卸柜）
  app.post("/staff/loading-manifests/remove-shipment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { itemId?: string; pieceCount?: number };
    if (!body.itemId) { fail(res, 400, "BAD_REQUEST", "itemId required"); return; }

    await prisma.$transaction(async (tx) => {
      const item = await tx.shipmentContainerItem.findFirst({
        where: { id: body.itemId, container: { companyId: auth.companyId } },
        include: { shipment: { select: { id: true, parentTrackingNo: true, packageCount: true, volumeM3: true } } },
      });
      if (!item) throw new Error("装柜记录不存在");

      const isChild = !!item.shipment.parentTrackingNo;
      const totalLoaded = item.loadedPieceCount;
      // 非子运单只能全量卸柜
      const reqPieces = isChild && typeof body.pieceCount === "number" && body.pieceCount > 0 && body.pieceCount < totalLoaded ? body.pieceCount : totalLoaded;
      const childPkg = item.shipment.packageCount ?? 0;
      const childVol = item.shipment.volumeM3 ? Number(item.shipment.volumeM3) : 0;

      // 部分卸柜：减子运单件数 + 减装柜件数 + 恢复父运单
      if (reqPieces < totalLoaded) {
        const newLoaded = totalLoaded - reqPieces;
        const newPkg = childPkg - reqPieces;
        const newVol = Number((newPkg > 0 && childPkg > 0 ? (childVol * newPkg) / childPkg : 0).toFixed(3));
        await tx.shipmentContainerItem.update({
          where: { id: body.itemId },
          data: { loadedPieceCount: newLoaded, loadedVolumeM3: newVol },
        });
        await tx.shipment.update({
          where: { id: item.shipment.id },
          data: { packageCount: newPkg, volumeM3: newVol as any, updatedAt: new Date() },
        });
        // 恢复父运单
        if (item.shipment.parentTrackingNo) {
          const parent = await tx.shipment.findFirst({
            where: { trackingNo: item.shipment.parentTrackingNo, companyId: auth.companyId },
            select: { id: true, packageCount: true },
          });
          if (parent) {
            await tx.shipment.update({
              where: { id: parent.id },
              data: { packageCount: (parent.packageCount ?? 0) + reqPieces, updatedAt: new Date() },
            });
          }
        }
      } else {
        // 全量卸柜
        await tx.shipmentContainerItem.delete({ where: { id: body.itemId } });
        if (!isChild) {
          // 父运单直装 → 恢复全部件数
          await tx.shipment.update({
            where: { id: item.shipment.id },
            data: { packageCount: (item.shipment.packageCount ?? 0) + item.loadedPieceCount, updatedAt: new Date() },
          });
        }
        if (item.shipment.parentTrackingNo) {
          const parent = await tx.shipment.findFirst({
            where: { trackingNo: item.shipment.parentTrackingNo, companyId: auth.companyId },
            select: { id: true, packageCount: true },
          });
          if (parent) {
            await tx.shipment.update({
              where: { id: parent.id },
              data: { packageCount: (parent.packageCount ?? 0) + (item.shipment.packageCount ?? 0), updatedAt: new Date() },
            });
          }
          await tx.shipment.delete({ where: { id: item.shipment.id } });
        }
      }
    });

    ok(res, { message: "运单已从装柜卸下" });
  });
}
