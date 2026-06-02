// B-6: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import type { DatabaseSync } from "node:sqlite";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { loadProductImagesForOrders } from "../orders/product-images";
import { hashPassword } from "../auth/crypto-utils";

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

export function registerAdminRoutes(app: MinimalHttpApp, _db: DatabaseSync): void {
  app.get("/admin/dashboard/overview", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [staff, client, newOrder, inTransit, volumeAgg] = await Promise.all([
      prisma.user.count({ where: { companyId: auth.companyId, role: "staff" } }),
      prisma.user.count({ where: { companyId: auth.companyId, role: "client" } }),
      prisma.order.count({
        where: { companyId: auth.companyId, createdAt: { gte: startOfToday } },
      }),
      prisma.shipment.count({
        where: { companyId: auth.companyId, currentStatus: "inTransit" },
      }),
      prisma.shipment.aggregate({
        where: { companyId: auth.companyId, updatedAt: { gte: startOfToday } },
        _sum: { volumeM3: true },
      }),
    ]);

    const totalVolume = volumeAgg._sum.volumeM3 ? Number(volumeAgg._sum.volumeM3.toString()) : 0;

    ok(res, {
      staffAccountCount: staff,
      clientAccountCount: client,
      newOrderCountToday: newOrder,
      inTransitOrderCount: inTransit,
      receivedVolumeM3Today: Number(totalVolume.toFixed(3)),
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
      })),
    });
  });

  app.get("/admin/orders", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const orders = await prisma.order.findMany({
      where: { companyId: auth.companyId },
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { name: true } },
      },
    });

    // 一次性查所有关联运单
    const shipmentMap = await attachLinkedShipments(
      auth.companyId,
      orders.map((o) => ({ id: o.id, batchNo: o.batchNo, domesticTrackingNo: o.domesticTrackingNo })),
    );

    const adminOrderItems = orders.map((o) => {
      const linked = shipmentMap.get(o.id);
      return {
        id: o.id,
        clientId: o.clientId,
        clientName: o.client?.name ?? null,
        warehouseId: o.warehouseId,
        orderNo: o.orderNo,
        itemName: o.itemName,
        transportMode: o.transportMode,
        domesticTrackingNo: o.domesticTrackingNo,
        batchNo: o.batchNo,
        approvalStatus: o.approvalStatus,
        productQuantity: o.productQuantity,
        packageCount: o.packageCount,
        packageUnit: o.packageUnit,
        weightKg: decToNumber(o.weightKg),
        volumeM3: decToNumber(o.volumeM3),
        receiverAddressTh: o.receiverAddressTh ?? undefined,
        receivableAmountCny: decToNumber(o.receivableAmountCny),
        receivableCurrency: o.receivableCurrency ?? "CNY",
        paymentStatus: o.paymentStatus ?? "unpaid",
        paidAt: o.paidAt ? o.paidAt.toISOString() : undefined,
        paidBy: o.paidBy ?? undefined,
        shipDate: o.shipDate,
        statusGroup: o.statusGroup,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
        shipmentId: linked?.id ?? undefined,
        trackingNo: linked?.trackingNo ?? undefined,
        currentStatus: linked?.currentStatus ?? undefined,
        containerNo: linked?.containerNo ?? undefined,
        canEdit: true,
      };
    });
    const adminOrderIds = adminOrderItems.map((item) => item.id);
    const adminImageMap = await loadProductImagesForOrders(auth.companyId, adminOrderIds);
    ok(res, {
      items: adminOrderItems.map((item) => ({
        ...item,
        productImages: adminImageMap.get(item.id) ?? [],
      })),
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
      itemName?: string;
      transportMode?: "sea" | "land";
      domesticTrackingNo?: string | null;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number | null;
      volumeM3?: number | null;
      receivableAmountCny?: number | null;
      receivableCurrency?: "CNY" | "THB";
      shipDate?: string | null;
      trackingNo?: string | null;
      batchNo?: string | null;
      warehouseId?: string;
      receiverAddressTh?: string;
      containerNo?: string | null;
      paymentStatus?: "paid" | "unpaid";
    };

    const orderId = body.orderId?.trim();
    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }

    const exists = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      select: {
        id: true,
        warehouseId: true,
        batchNo: true,
        domesticTrackingNo: true,
        receiverAddressTh: true,
        paymentStatus: true,
      },
    });
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

    const itemName = body.itemName?.trim();
    if (!itemName) {
      fail(res, 400, "BAD_REQUEST", "itemName is required");
      return;
    }

    const productQuantity = Number(body.productQuantity);
    const packageCount = Number(body.packageCount);
    if (!Number.isFinite(productQuantity) || productQuantity < 0) {
      fail(res, 400, "BAD_REQUEST", "invalid productQuantity");
      return;
    }
    if (!Number.isFinite(packageCount) || packageCount < 0) {
      fail(res, 400, "BAD_REQUEST", "invalid packageCount");
      return;
    }

    const packageUnit = body.packageUnit === "bag" ? "bag" : "box";
    const transportMode = body.transportMode === "land" ? "land" : "sea";
    const domesticTrackingNo = body.domesticTrackingNo?.trim() || null;
    const weightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    if (weightKg !== null && !Number.isFinite(weightKg)) {
      fail(res, 400, "BAD_REQUEST", "invalid weightKg");
      return;
    }
    if (volumeM3 !== null && !Number.isFinite(volumeM3)) {
      fail(res, 400, "BAD_REQUEST", "invalid volumeM3");
      return;
    }

    let receivableAmount: number | null = null;
    if (body.receivableAmountCny !== undefined && body.receivableAmountCny !== null) {
      const amount = Number(body.receivableAmountCny);
      if (!Number.isFinite(amount) || amount < 0) {
        fail(res, 400, "BAD_REQUEST", "invalid receivableAmountCny");
        return;
      }
      receivableAmount = amount === 0 ? null : amount;
    }
    const receivableCurrency = body.receivableCurrency === "THB" ? "THB" : "CNY";
    const warehouseId = body.warehouseId?.trim() || exists.warehouseId;
    const batchNo = body.batchNo === undefined ? exists.batchNo : body.batchNo?.trim() || null;
    const receiverAddressTh = body.receiverAddressTh === undefined
      ? (exists.receiverAddressTh ?? "")
      : body.receiverAddressTh.trim();
    const paymentStatus =
      body.paymentStatus === undefined
        ? ((exists.paymentStatus === "paid" ? "paid" : "unpaid") as "paid" | "unpaid")
        : body.paymentStatus;
    const trackingNo = body.trackingNo === undefined ? linkedShipment?.trackingNo ?? null : body.trackingNo?.trim() || null;
    const containerNo = body.containerNo === undefined ? linkedShipment?.containerNo ?? null : body.containerNo?.trim() || null;
    if (linkedShipment && !trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
      return;
    }
    if (trackingNo && !isTrackingNoMatchedWarehouse(warehouseId, trackingNo)) {
      fail(
        res,
        400,
        "BAD_REQUEST",
        `trackingNo prefix must match warehouse: ${allowedTrackingPrefixesByWarehouse(warehouseId).join("/")}`,
      );
      return;
    }
    if (trackingNo && linkedShipment) {
      const conflict = await prisma.shipment.findFirst({
        where: {
          companyId: auth.companyId,
          trackingNo,
          NOT: { id: linkedShipment.id },
        },
        select: { id: true },
      });
      if (conflict) {
        fail(res, 400, "BAD_REQUEST", "trackingNo already exists");
        return;
      }
    }

    let shipDate: string | null = null;
    if (body.shipDate !== undefined && body.shipDate !== null && String(body.shipDate).trim() !== "") {
      const raw = String(body.shipDate).trim().slice(0, 10);
      const parsed = new Date(`${raw}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) {
        fail(res, 400, "BAD_REQUEST", "invalid shipDate");
        return;
      }
      shipDate = raw;
    }

    const now = new Date();

    // 事务：订单 + 关联运单一致更新
    await prisma.$transaction([
      prisma.order.update({
        where: { id: orderId },
        data: {
          warehouseId,
          batchNo,
          itemName,
          transportMode,
          domesticTrackingNo,
          productQuantity,
          packageCount,
          packageUnit,
          weightKg,
          volumeM3,
          receivableAmountCny: receivableAmount,
          receivableCurrency,
          receiverAddressTh,
          paymentStatus,
          shipDate,
          updatedAt: now,
        },
      }),
      // 同步所有关联运单（按 order_id 关联的那些）
      prisma.shipment.updateMany({
        where: { orderId, companyId: auth.companyId },
        data: {
          warehouseId,
          ...(trackingNo ? { trackingNo } : {}),
          batchNo,
          transportMode,
          domesticTrackingNo,
          packageCount,
          packageUnit,
          weightKg,
          volumeM3,
          containerNo,
          updatedAt: now,
        },
      }),
    ]);

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
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!name || !phone) {
      fail(res, 400, "BAD_REQUEST", "name and phone are required");
      return;
    }

    const rawId = typeof body.id === "string" ? body.id.trim() : "";
    const id = rawId || `u_${body.role === "client" ? "client" : "staff"}_${Date.now()}`;
    const passwordHash = typeof body.password === "string" && body.password.trim() ? hashPassword(body.password.trim()) : null;
    const targetRole = body.role === "client" ? "client" : "staff";

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
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!name || !phone) {
      fail(res, 400, "BAD_REQUEST", "客户名字和电话号码为必填");
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
      },
      select: { id: true, name: true, companyName: true, phone: true, email: true, createdAt: true },
    });

    ok(res, {
      id: created.id,
      name: created.name,
      companyName: created.companyName,
      phone: created.phone,
      email: created.email,
      createdAt: created.createdAt.toISOString(),
    });
  });

  app.delete("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const id = typeof req.query?.id === "string" ? req.query.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "user id is required");
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
      fail(res, 403, "FORBIDDEN", "cannot delete user of another company");
      return;
    }
    if (row.role !== "staff") {
      fail(res, 403, "FORBIDDEN", "only staff can be deleted here");
      return;
    }

    await prisma.user.delete({ where: { id } });
    ok(res, { deleted: true, id });
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
    if (row.role !== "staff" && row.role !== "client") {
      fail(res, 403, "FORBIDDEN", "only staff or client password can be set here");
      return;
    }

    const passwordHash = hashPassword(password);
    await prisma.user.update({ where: { id }, data: { passwordHash } });
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
      select: { id: true, companyId: true, status: true },
    });
    if (!row) {
      fail(res, 404, "NOT_FOUND", "user not found");
      return;
    }
    if (row.companyId !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "cannot toggle user of another company");
      return;
    }

    const newStatus = row.status === "active" ? "inactive" : "active";
    await prisma.user.update({ where: { id }, data: { status: newStatus } });
    ok(res, { id, status: newStatus });
  });
}
