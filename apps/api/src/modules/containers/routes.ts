// 任务 #10: Container & 拆柜 API（2026-05-20）
// 实现湘泰物流 P0 阶段最核心的"出柜追踪"业务能力
//
// 数据模型：
//   Container（柜子）─┬─< ShipmentContainerItem（拆柜关系）>─┬─ Shipment（运单）
//                    │   loadedVolumeM3 + loadedPieceCount  │
// 一票货可拆到多个柜子（N:N）；柜子的状态自成一套状态机
//
// 柜子状态：LOADING → IN_TRANSIT → ARRIVED → CUSTOMS → DELIVERING → SIGNED

import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

const CONTAINER_STATUS_FLOW = [
  "LOADING",
  "IN_TRANSIT",
  "ARRIVED",
  "CUSTOMS",
  "DELIVERING",
  "SIGNED",
] as const;

const CONTAINER_STATUS_LABEL: Record<string, string> = {
  LOADING: "装柜中",
  IN_TRANSIT: "在途",
  ARRIVED: "到港",
  CUSTOMS: "清关中",
  DELIVERING: "派送中",
  SIGNED: "全部签收",
};

/** 判断状态切换是否合法（只能往前推进，不能倒退；可同状态续写）。 */
function canContainerTransit(from: string, to: string): boolean {
  if (from === to) return true;
  const fromIdx = CONTAINER_STATUS_FLOW.indexOf(from as typeof CONTAINER_STATUS_FLOW[number]);
  const toIdx = CONTAINER_STATUS_FLOW.indexOf(to as typeof CONTAINER_STATUS_FLOW[number]);
  if (fromIdx < 0 || toIdx < 0) return false;
  return toIdx === fromIdx + 1;
}

function decToNumber(value: Prisma.Decimal | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value.toString());
}

export function registerContainerRoutes(app: MinimalHttpApp): void {
  // ============ 柜子列表 ============
  app.get("/admin/containers", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const statusFilter = req.query.status?.trim();
    const where: Prisma.ContainerWhereInput = { companyId: auth.companyId };
    if (statusFilter) where.currentStatus = statusFilter;

    const containers = await prisma.container.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { items: true } },
        items: { select: { loadedVolumeM3: true, loadedPieceCount: true } },
      },
    });

    const items = containers.map((c) => {
      const totalVolume = c.items.reduce((sum, it) => sum + decToNumber(it.loadedVolumeM3), 0);
      const totalPieces = c.items.reduce((sum, it) => sum + it.loadedPieceCount, 0);
      return {
        id: c.id,
        containerNo: c.containerNo,
        containerType: c.containerType,
        loadingDate: c.loadingDate?.toISOString() ?? null,
        departureDate: c.departureDate?.toISOString() ?? null,
        eta: c.eta?.toISOString() ?? null,
        ata: c.ata?.toISOString() ?? null,
        customsClearedAt: c.customsClearedAt?.toISOString() ?? null,
        currentStatus: c.currentStatus,
        currentStatusLabel: CONTAINER_STATUS_LABEL[c.currentStatus] ?? c.currentStatus,
        shipmentCount: c._count.items,
        totalLoadedVolumeM3: Number(totalVolume.toFixed(3)),
        totalLoadedPieceCount: totalPieces,
        remark: c.remark ?? undefined,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      };
    });

    ok(res, { items, total: items.length });
  });

  // ============ 柜子详情（含装载的所有运单）============
  app.get("/admin/containers/detail", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff", "client"]);
    if (!auth) return;

    const id = req.query.id?.trim();
    const containerNo = req.query.containerNo?.trim();
    if (!id && !containerNo) {
      fail(res, 400, "BAD_REQUEST", "id or containerNo is required");
      return;
    }

    const container = await prisma.container.findFirst({
      where: id ? { id, companyId: auth.companyId } : { containerNo, companyId: auth.companyId },
      include: {
        items: {
          include: {
            shipment: {
              include: {
                order: {
                  select: {
                    id: true,
                    orderNo: true,
                    itemName: true,
                    clientId: true,
                    receiverNameTh: true,
                    receiverAddressTh: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "container not found");
      return;
    }

    // 客户角色：只能看到含自己货的柜子
    if (auth.role === "client") {
      const isOwn = container.items.some((it) => it.shipment.order?.clientId === auth.userId);
      if (!isOwn) {
        fail(res, 403, "FORBIDDEN", "you have no shipment in this container");
        return;
      }
    }

    const totalVolume = container.items.reduce((sum, it) => sum + decToNumber(it.loadedVolumeM3), 0);
    const totalPieces = container.items.reduce((sum, it) => sum + it.loadedPieceCount, 0);

    ok(res, {
      id: container.id,
      containerNo: container.containerNo,
      containerType: container.containerType,
      loadingDate: container.loadingDate?.toISOString() ?? null,
      departureDate: container.departureDate?.toISOString() ?? null,
      eta: container.eta?.toISOString() ?? null,
      ata: container.ata?.toISOString() ?? null,
      customsClearedAt: container.customsClearedAt?.toISOString() ?? null,
      currentStatus: container.currentStatus,
      currentStatusLabel: CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus,
      remark: container.remark ?? undefined,
      totalLoadedVolumeM3: Number(totalVolume.toFixed(3)),
      totalLoadedPieceCount: totalPieces,
      // 客户视角下隐藏其他客户的货
      shipments: container.items
        .filter((it) => auth.role !== "client" || it.shipment.order?.clientId === auth.userId)
        .map((it) => ({
          shipmentId: it.shipmentId,
          trackingNo: it.shipment.trackingNo,
          orderId: it.shipment.order?.id ?? null,
          orderNo: it.shipment.order?.orderNo ?? null,
          itemName: it.shipment.order?.itemName ?? null,
          receiverNameTh: it.shipment.order?.receiverNameTh ?? null,
          receiverAddressTh: it.shipment.order?.receiverAddressTh ?? null,
          loadedVolumeM3: decToNumber(it.loadedVolumeM3),
          loadedPieceCount: it.loadedPieceCount,
          shipmentTotalVolumeM3: it.shipment.volumeM3 ? decToNumber(it.shipment.volumeM3) : null,
          // 拆柜提示：本运单装载量小于总量 = 拆柜
          isSplit:
            it.shipment.volumeM3 !== null &&
            decToNumber(it.loadedVolumeM3) < decToNumber(it.shipment.volumeM3) - 0.001,
          currentStatus: it.shipment.currentStatus,
        })),
      createdAt: container.createdAt.toISOString(),
      updatedAt: container.updatedAt.toISOString(),
    });
  });

  // ============ 新建柜子 ============
  app.post("/admin/containers", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      containerNo?: string;
      containerType?: "20GP" | "40HQ" | string;
      loadingDate?: string;
      departureDate?: string;
      eta?: string;
      remark?: string;
    };
    const containerNo = body.containerNo?.trim();
    const containerType = body.containerType?.trim();
    if (!containerNo || !containerType) {
      fail(res, 400, "BAD_REQUEST", "containerNo and containerType are required");
      return;
    }

    const existed = await prisma.container.findUnique({
      where: { containerNo },
      select: { id: true },
    });
    if (existed) {
      fail(res, 409, "CONFLICT", "containerNo already exists");
      return;
    }

    const created = await prisma.container.create({
      data: {
        companyId: auth.companyId,
        containerNo,
        containerType,
        loadingDate: body.loadingDate ? new Date(body.loadingDate) : null,
        departureDate: body.departureDate ? new Date(body.departureDate) : null,
        eta: body.eta ? new Date(body.eta) : null,
        currentStatus: "LOADING",
        remark: body.remark?.trim() || null,
      },
    });

    ok(res, {
      id: created.id,
      containerNo: created.containerNo,
      currentStatus: created.currentStatus,
      createdAt: created.createdAt.toISOString(),
    });
  });

  // ============ 变更柜子状态（含自动连带）============
  // - IN_TRANSIT 时记录 departureDate（若未填）
  // - ARRIVED 时记录 ata（实际到港）
  // - CUSTOMS 完成 → 自动写 customsClearedAt
  // - DELIVERING 时把柜内所有运单的 currentStatus 推进到 outForDelivery
  // - SIGNED 时把柜内所有运单的 currentStatus 推进到 delivered
  app.post("/admin/containers/status", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { id?: string; toStatus?: string; remark?: string };
    const id = body.id?.trim();
    const toStatus = body.toStatus?.trim();
    if (!id || !toStatus) {
      fail(res, 400, "BAD_REQUEST", "id and toStatus are required");
      return;
    }
    if (!CONTAINER_STATUS_FLOW.includes(toStatus as typeof CONTAINER_STATUS_FLOW[number])) {
      fail(res, 400, "VALIDATION_ERROR", `invalid status: ${toStatus}`);
      return;
    }

    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      include: { items: { select: { shipmentId: true } } },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "container not found");
      return;
    }

    if (!canContainerTransit(container.currentStatus, toStatus)) {
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        `invalid transition: ${container.currentStatus} → ${toStatus}`,
      );
      return;
    }

    const now = new Date();
    const updateData: Prisma.ContainerUpdateInput = {
      currentStatus: toStatus,
      updatedAt: now,
    };
    if (toStatus === "IN_TRANSIT" && !container.departureDate) updateData.departureDate = now;
    if (toStatus === "ARRIVED" && !container.ata) updateData.ata = now;
    if (toStatus === "DELIVERING" && !container.customsClearedAt) updateData.customsClearedAt = now;

    // 推进柜内每个运单的状态（仅在 DELIVERING / SIGNED 时）
    const shipmentIds = container.items.map((it) => it.shipmentId);
    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.container.update({ where: { id: container.id }, data: updateData }),
    ];

    let shipmentNextStatus: string | null = null;
    if (toStatus === "IN_TRANSIT") shipmentNextStatus = "inTransit";
    else if (toStatus === "ARRIVED") shipmentNextStatus = "customsTH";
    else if (toStatus === "DELIVERING") shipmentNextStatus = "outForDelivery";
    else if (toStatus === "SIGNED") shipmentNextStatus = "delivered";

    if (shipmentNextStatus && shipmentIds.length > 0) {
      ops.push(
        prisma.shipment.updateMany({
          where: { id: { in: shipmentIds }, companyId: auth.companyId },
          data: { currentStatus: shipmentNextStatus, updatedAt: now },
        }),
      );
      // 写状态日志（每个运单一条）
      for (let i = 0; i < shipmentIds.length; i++) {
        ops.push(
          prisma.statusLog.create({
            data: {
              id: `sl_ctn_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
              companyId: auth.companyId,
              shipmentId: shipmentIds[i],
              operatorId: auth.userId,
              operatorRole: auth.role,
              fromStatus: "(container-driven)",
              toStatus: shipmentNextStatus,
              remark: `柜子 ${container.containerNo} → ${toStatus}${body.remark ? ` · ${body.remark}` : ""}`,
              changedAt: now,
            },
          }),
        );
      }
    }

    await prisma.$transaction(ops);

    ok(res, {
      id: container.id,
      containerNo: container.containerNo,
      fromStatus: container.currentStatus,
      toStatus,
      affectedShipmentCount: shipmentNextStatus ? shipmentIds.length : 0,
      updatedAt: now.toISOString(),
    });
  });

  // ============ 装柜（把某个运单装进某个柜子）============
  // 支持拆柜：同一 shipmentId 不能在同一柜子里出现两次（unique 约束）
  // 但可以在不同柜子里出现多次
  app.post("/admin/containers/load", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      containerId?: string;
      shipmentId?: string;
      loadedVolumeM3?: number;
      loadedPieceCount?: number;
    };
    const containerId = body.containerId?.trim();
    const shipmentId = body.shipmentId?.trim();
    const volume = Number(body.loadedVolumeM3);
    const pieces = Number(body.loadedPieceCount);
    if (!containerId || !shipmentId || !Number.isFinite(volume) || volume <= 0 || !Number.isFinite(pieces) || pieces <= 0) {
      fail(res, 400, "BAD_REQUEST", "containerId, shipmentId, loadedVolumeM3>0, loadedPieceCount>0 are required");
      return;
    }

    const [container, shipment] = await Promise.all([
      prisma.container.findFirst({ where: { id: containerId, companyId: auth.companyId } }),
      prisma.shipment.findFirst({
        where: { id: shipmentId, companyId: auth.companyId },
        include: {
          containerItems: { select: { loadedVolumeM3: true } },
        },
      }),
    ]);
    if (!container) {
      fail(res, 404, "NOT_FOUND", "container not found");
      return;
    }
    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }
    if (container.currentStatus !== "LOADING") {
      fail(res, 400, "VALIDATION_ERROR", "container is not in LOADING status");
      return;
    }

    // 检查体积是否超过运单总体积（已装 + 本次 <= 总量）
    if (shipment.volumeM3 !== null) {
      const alreadyLoaded = shipment.containerItems.reduce(
        (sum, it) => sum + decToNumber(it.loadedVolumeM3),
        0,
      );
      const shipmentTotal = decToNumber(shipment.volumeM3);
      if (alreadyLoaded + volume > shipmentTotal + 0.01) {
        fail(
          res,
          400,
          "VALIDATION_ERROR",
          `loaded ${(alreadyLoaded + volume).toFixed(3)}m³ exceeds shipment total ${shipmentTotal.toFixed(3)}m³`,
        );
        return;
      }
    }

    try {
      const item = await prisma.shipmentContainerItem.create({
        data: {
          shipmentId,
          containerId,
          loadedVolumeM3: volume,
          loadedPieceCount: pieces,
        },
      });
      ok(res, {
        id: item.id,
        containerId,
        shipmentId,
        loadedVolumeM3: volume,
        loadedPieceCount: pieces,
        createdAt: item.createdAt.toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unique constraint")) {
        fail(res, 409, "CONFLICT", "this shipment is already loaded in this container");
        return;
      }
      throw err;
    }
  });

  // ============ 卸柜（移除装柜关系）============
  app.delete("/admin/containers/load", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }

    const item = await prisma.shipmentContainerItem.findUnique({
      where: { id },
      include: { container: true },
    });
    if (!item || item.container.companyId !== auth.companyId) {
      fail(res, 404, "NOT_FOUND", "load item not found");
      return;
    }
    if (item.container.currentStatus !== "LOADING") {
      fail(res, 400, "VALIDATION_ERROR", "container is not in LOADING status; cannot unload");
      return;
    }

    await prisma.shipmentContainerItem.delete({ where: { id } });
    ok(res, { deleted: true, id });
  });

  // ============ 客户追踪：根据运单 ID 查看完整的"出柜"信息 ============
  // 返回：运单基础信息 + 所属的所有柜子 + 状态时间线
  app.get("/client/shipments/track", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;

    const shipmentId = req.query.shipmentId?.trim();
    const trackingNo = req.query.trackingNo?.trim();
    if (!shipmentId && !trackingNo) {
      fail(res, 400, "BAD_REQUEST", "shipmentId or trackingNo is required");
      return;
    }

    const shipment = await prisma.shipment.findFirst({
      where: shipmentId
        ? { id: shipmentId, companyId: auth.companyId }
        : { trackingNo, companyId: auth.companyId },
      include: {
        order: {
          select: {
            id: true,
            orderNo: true,
            itemName: true,
            clientId: true,
            receiverNameTh: true,
            receiverAddressTh: true,
            cargoType: true,
          },
        },
        containerItems: {
          include: {
            container: true,
          },
        },
        statusLogs: {
          orderBy: { changedAt: "asc" },
        },
      },
    });

    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }

    // 客户角色：只能看自己的货
    if (auth.role === "client" && shipment.order.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "this shipment does not belong to you");
      return;
    }

    const totalVolume = shipment.volumeM3 ? decToNumber(shipment.volumeM3) : 0;
    const totalLoaded = shipment.containerItems.reduce(
      (sum, it) => sum + decToNumber(it.loadedVolumeM3),
      0,
    );
    const isSplit = shipment.containerItems.length > 1;

    const childShipments = shipment.parentTrackingNo
      ? []
      : await prisma.shipment.findMany({
          where: { parentTrackingNo: shipment.trackingNo, companyId: auth.companyId },
          include: {
            statusLogs: { orderBy: { changedAt: "asc" } },
          },
          orderBy: { trackingNo: "asc" },
        });

    ok(res, {
      trackingNo: shipment.trackingNo,
      orderId: shipment.order.id,
      orderNo: shipment.order.orderNo,
      itemName: shipment.order.itemName,
      cargoType: shipment.order.cargoType,
      currentStatus: shipment.currentStatus,
      currentLocation: shipment.currentLocation ?? undefined,
      receiverNameTh: shipment.order.receiverNameTh,
      receiverAddressTh: shipment.order.receiverAddressTh,
      totalVolumeM3: totalVolume,
      totalLoadedM3: Number(totalLoaded.toFixed(3)),
      isSplit,
      splitCount: shipment.containerItems.length,
      // 所属的所有柜子（拆柜情况下会有多个）
      containers: shipment.containerItems
        .sort((a, b) => a.container.createdAt.getTime() - b.container.createdAt.getTime())
        .map((it) => ({
          containerId: it.containerId,
          containerNo: it.container.containerNo,
          containerType: it.container.containerType,
          loadedVolumeM3: decToNumber(it.loadedVolumeM3),
          loadedPieceCount: it.loadedPieceCount,
          containerStatus: it.container.currentStatus,
          containerStatusLabel:
            CONTAINER_STATUS_LABEL[it.container.currentStatus] ?? it.container.currentStatus,
          loadingDate: it.container.loadingDate?.toISOString() ?? null,
          departureDate: it.container.departureDate?.toISOString() ?? null,
          eta: it.container.eta?.toISOString() ?? null,
          ata: it.container.ata?.toISOString() ?? null,
          customsClearedAt: it.container.customsClearedAt?.toISOString() ?? null,
        })),
      // 状态时间线
      timeline: shipment.statusLogs.map((log) => ({
        fromStatus: log.fromStatus,
        toStatus: log.toStatus,
        remark: log.remark ?? "",
        changedAt: log.changedAt.toISOString(),
        operatorRole: log.operatorRole,
      })),
      // 子单信息（分柜后运单才有）
      // 子单信息
      children: childShipments.length > 0
        ? childShipments.map((cs) => ({
            trackingNo: cs.trackingNo,
            batchNo: cs.batchNo,
            itemName: cs.itemName,
            packageCount: cs.packageCount,
            currentStatus: cs.currentStatus,
            timeline: cs.statusLogs.map((log) => ({
              fromStatus: log.fromStatus,
              toStatus: log.toStatus,
              remark: log.remark ?? "",
              changedAt: log.changedAt.toISOString(),
              operatorRole: log.operatorRole,
            })),
          }))
        : undefined,
      createdAt: shipment.createdAt.toISOString(),
      updatedAt: shipment.updatedAt.toISOString(),
    });
  });
}
