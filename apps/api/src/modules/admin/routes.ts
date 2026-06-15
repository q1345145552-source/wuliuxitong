// B-6: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { loadProductImagesForOrders } from "../orders/product-images";
import { loadOrderProducts } from "../orders/routes";
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

export function registerAdminRoutes(app: MinimalHttpApp): void {
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

    const rows = await prisma.shipment.findMany({
      where: { companyId: auth.companyId, parentTrackingNo: null },
      orderBy: { updatedAt: "desc" },
      take: 500,
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
      canEdit: true,
      approvalStatus: r.order?.approvalStatus ?? undefined,
      statusGroup: r.order?.statusGroup ?? undefined,
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
      receivableAmountCny?: number | null;
      receivableCurrency?: "CNY" | "THB";
      shipDate?: string | null;
      trackingNo?: string | null;
      batchNo?: string | null;
      warehouseId?: string;
      receiverAddressTh?: string;
      containerNo?: string | null;
      paymentStatus?: "paid" | "unpaid";
      products?: Array<{
        itemName: string;
        packageCount: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        productQuantity?: number;
        cargoType?: string;
        domesticTrackingNo?: string;
      }>;
    };

    const rawId = body.orderId?.trim();
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
      const shipment = await prisma.shipment.findUnique({
        where: { id: rawId },
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
    const domesticTrackingNo = body.domesticTrackingNo?.trim() || null; // 空字符串 = 清空
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

    const txOps: any[] = [
      prisma.order.update({
        where: { id: orderId },
        data: {
          warehouseId,
          batchNo,
          clientId: body.clientId?.trim() || null,
          itemName,
          cargoType: body.cargoType?.trim() || undefined,
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
        where: { orderId, companyId: auth.companyId, parentTrackingNo: null },
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
    ];
    // 如果传了 products 数组，则删除旧产品行并重建
    if (body.products && body.products.length > 0) {
      txOps.push(
        prisma.orderProduct.deleteMany({ where: { orderId, companyId: auth.companyId } }),
      );
      txOps.push(
        prisma.orderProduct.createMany({
          data: body.products.map((p, i) => ({
            companyId: auth.companyId,
            orderId,
            itemName: p.itemName.trim(),
            packageCount: p.packageCount || 1,
            lengthCm: p.lengthCm ?? null,
            widthCm: p.widthCm ?? null,
            heightCm: p.heightCm ?? null,
            productQuantity: p.productQuantity ?? null,
            cargoType: p.cargoType?.trim() || "NORMAL",
            domesticTrackingNo: p.domesticTrackingNo?.trim() || "货拉拉",
            sortOrder: i,
          })),
        }),
      );
    }
    // 事务：订单 + 关联运单 + 产品行一致更新
    await prisma.$transaction(txOps);

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
    };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "客户ID为必填");
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

    if (Object.keys(updateData).length === 0) {
      fail(res, 400, "BAD_REQUEST", "没有需要更新的字段");
      return;
    }

    const updated = await prisma.user.update({
      where: { id },
      data: updateData,
      select: { id: true, name: true, companyName: true, phone: true, email: true, createdAt: true },
    });

    ok(res, {
      id: updated.id,
      name: updated.name,
      companyName: updated.companyName,
      phone: updated.phone,
      email: updated.email,
      createdAt: updated.createdAt.toISOString(),
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
    if (row.role !== "staff" && row.role !== "client") {
      fail(res, 403, "FORBIDDEN", "only staff and client can be deleted");
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
      for (const s of order.shipments) {
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

}