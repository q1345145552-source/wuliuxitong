// B-7: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

/** Decimal | null → number */
function decToNumber(value: Prisma.Decimal | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value.toString());
}

/**
 * 注册管理员运营侧（LMP/关务/末端/结算）接口。
 */
export function registerAdminOpsRoutes(app: MinimalHttpApp): void {
  app.get("/admin/lmp/rates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = await prisma.adminLmpRate.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
    });
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        routeCode: item.routeCode,
        supplierName: item.supplierName,
        transportMode: item.transportMode,
        seasonTag: item.seasonTag,
        supplierCost: decToNumber(item.supplierCost),
        quotePrice: decToNumber(item.quotePrice),
        currency: item.currency,
        effectiveFrom: item.effectiveFrom,
        effectiveTo: item.effectiveTo ?? undefined,
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  app.post("/admin/lmp/rates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      routeCode?: string;
      supplierName?: string;
      transportMode?: string;
      seasonTag?: string;
      supplierCost?: number;
      quotePrice?: number;
      currency?: string;
      effectiveFrom?: string;
      effectiveTo?: string;
    };
    const routeCode = body.routeCode?.trim();
    const supplierName = body.supplierName?.trim();
    const transportMode = body.transportMode?.trim();
    const seasonTag = body.seasonTag?.trim();
    const supplierCost = Number(body.supplierCost);
    const quotePrice = Number(body.quotePrice);
    if (!routeCode || !supplierName || !transportMode || !seasonTag || !Number.isFinite(supplierCost) || !Number.isFinite(quotePrice)) {
      fail(res, 400, "BAD_REQUEST", "invalid lmp rate payload");
      return;
    }
    const id = `lmp_${Date.now()}`;
    const created = await prisma.adminLmpRate.create({
      data: {
        id,
        companyId: auth.companyId,
        routeCode,
        supplierName,
        transportMode,
        seasonTag,
        supplierCost,
        quotePrice,
        currency: body.currency?.trim() || "CNY",
        effectiveFrom: body.effectiveFrom?.trim() || new Date().toISOString().slice(0, 10),
        effectiveTo: body.effectiveTo?.trim() || null,
      },
      select: { id: true, updatedAt: true },
    });
    ok(res, { id: created.id, updatedAt: created.updatedAt.toISOString() });
  });

  app.get("/admin/customs/cases", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = await prisma.adminCustomsCase.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
    });
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        shipmentId: item.shipmentId ?? undefined,
        orderId: item.orderId ?? undefined,
        status: item.status,
        remark: item.remark ?? undefined,
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  app.post("/admin/customs/cases", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentId?: string; orderId?: string; status?: string; remark?: string };
    const status = body.status?.trim();
    if (!status) {
      fail(res, 400, "BAD_REQUEST", "status is required");
      return;
    }
    const id = `cus_${Date.now()}`;
    const created = await prisma.adminCustomsCase.create({
      data: {
        id,
        companyId: auth.companyId,
        shipmentId: body.shipmentId?.trim() || null,
        orderId: body.orderId?.trim() || null,
        status,
        remark: body.remark?.trim() || null,
      },
      select: { id: true, updatedAt: true },
    });
    ok(res, { id: created.id, updatedAt: created.updatedAt.toISOString() });
  });

  app.get("/admin/lastmile/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const rows = await prisma.adminLastmileOrder.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
      include: { shipment: { select: { trackingNo: true, order: { select: { clientId: true } } } } },
    });
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        deliveryNo: item.deliveryNo,
        shipmentId: item.shipmentId,
        trackingNo: item.shipment?.trackingNo ?? item.shipmentId,
        clientId: item.shipment?.order?.clientId ?? null,
        deliveryDate: item.deliveryDate,
        carrierName: item.carrierName,
        externalTrackingNo: item.externalTrackingNo,
        driverName: item.driverName,
        licensePlate: item.licensePlate,
        phoneNumber: item.phoneNumber,
        signImageBase64: item.signImageBase64,
        status: item.status,
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  app.post("/admin/lastmile/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentIds?: string[]; driverName?: string; licensePlate?: string; phoneNumber?: string; status?: string; deliveryNo?: string; deliveryDate?: string };
    const shipmentIds = (body.shipmentIds ?? []).map(s => s.trim()).filter(Boolean);
    let driverName = body.driverName?.trim() || "";
    let licensePlate = body.licensePlate?.trim() || "";
    let phoneNumber = body.phoneNumber?.trim() || "";
    let deliveryDate = body.deliveryDate?.trim() || "";
    const status = body.status?.trim() || "DELIVERING";
    const existingDeliveryNo = body.deliveryNo?.trim();
    if (shipmentIds.length === 0) {
      fail(res, 400, "BAD_REQUEST", "at least one shipmentId is required");
      return;
    }
    // 生成或复用派送单号
    let deliveryNo: string;
    if (existingDeliveryNo) {
      // 追加到已有派送单，继承司机信息
      const exist = await prisma.adminLastmileOrder.findFirst({ where: { deliveryNo: existingDeliveryNo, companyId: auth.companyId }, select: { deliveryNo: true, driverName: true, licensePlate: true, phoneNumber: true, deliveryDate: true } });
      if (!exist) { fail(res, 404, "NOT_FOUND", "deliveryNo not found"); return; }
      deliveryNo = existingDeliveryNo;
      // 追加时不传司机信息则继承已有值
      if (!driverName) driverName = exist.driverName ?? "";
      if (!licensePlate) licensePlate = exist.licensePlate ?? "";
      if (!phoneNumber) phoneNumber = exist.phoneNumber ?? "";
      if (!deliveryDate) deliveryDate = exist.deliveryDate ?? "";
    } else {
      deliveryNo = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(2901)');
        const count = await tx.adminLastmileOrder.count({ where: { deliveryNo: { startsWith: "WD" } } });
        return `WD${String(count + 1).padStart(6, "0")}`;
      });
    }
    
    const results: Array<{ id: string; shipmentId: string }> = [];
    for (const sid of shipmentIds) {
      const id = `lm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await prisma.adminLastmileOrder.create({
        data: { id, companyId: auth.companyId, deliveryNo, shipmentId: sid, carrierName: "自营", driverName, licensePlate, phoneNumber, deliveryDate, externalTrackingNo: "", status },
      });
      results.push({ id, shipmentId: sid });
      // 同步运单状态 + 日志
      const now = new Date();
      const ship = await prisma.shipment.findUnique({ where: { id: sid }, select: { currentStatus: true, parentTrackingNo: true } });
      if (ship) {
        await prisma.shipment.update({ where: { id: sid }, data: { currentStatus: "outForDelivery", updatedAt: now } });
        await prisma.statusLog.create({
          data: { id: `sl_lm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, companyId: auth.companyId, shipmentId: sid, operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "", fromStatus: ship.currentStatus, toStatus: "outForDelivery", remark: `尾程派送出车（${deliveryNo}）`, changedAt: now },
        });
        if (ship.parentTrackingNo) {
          const parent = await prisma.shipment.findFirst({ where: { trackingNo: ship.parentTrackingNo, companyId: auth.companyId }, select: { id: true } });
          if (parent) { await prisma.shipment.update({ where: { id: parent.id }, data: { currentStatus: "outForDelivery", updatedAt: now } }); }
        }
      }
    }
    ok(res, { deliveryNo, count: results.length });
  });

  // 尾程派送状态更新
  app.post("/admin/lastmile/status", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { id?: string; status?: string; signImageBase64?: string };
    if (!body.id || !body.status) { fail(res, 400, "BAD_REQUEST", "id and status required"); return; }
    const updateData: any = { status: body.status };
    if (body.signImageBase64) updateData.signImageBase64 = body.signImageBase64;
    const updated = await prisma.adminLastmileOrder.update({
      where: { id: body.id },
      data: updateData,
    });
    const now = new Date();
    if (body.status === "SIGNED") {
      const shipment = await prisma.shipment.findUnique({ where: { id: updated.shipmentId }, select: { id: true, currentStatus: true, parentTrackingNo: true } });
      if (shipment) {
        await prisma.shipment.update({ where: { id: shipment.id }, data: { currentStatus: "delivered", updatedAt: now } });
        await prisma.statusLog.create({
          data: {
            id: `sl_lm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            companyId: auth.companyId, shipmentId: shipment.id,
            operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "",
            fromStatus: shipment.currentStatus, toStatus: "delivered",
            remark: `尾程派送已签收（${updated.deliveryNo ?? updated.id}）`,
            changedAt: now,
          },
        });
        // 同步父运单
        if (shipment.parentTrackingNo) {
          const parent = await prisma.shipment.findFirst({ where: { trackingNo: shipment.parentTrackingNo, companyId: auth.companyId }, select: { id: true } });
          if (parent) {
            await prisma.shipment.update({ where: { id: parent.id }, data: { currentStatus: "delivered", updatedAt: now } });
          }
        }
      }
    }
    ok(res, { id: updated.id, status: updated.status });
  });

  // 删除派送单
  app.delete("/admin/lastmile/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id as string;
    if (!id) { fail(res, 400, "BAD_REQUEST", "id required"); return; }
    await prisma.adminLastmileOrder.deleteMany({ where: { id, companyId: auth.companyId } });
    ok(res, { deleted: true });
  });

  app.get("/admin/settlement/entries", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = await prisma.adminSettlementEntry.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
    });
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        orderId: item.orderId,
        clientReceivable: decToNumber(item.clientReceivable),
        supplierPayable: decToNumber(item.supplierPayable),
        taxFee: decToNumber(item.taxFee),
        currency: item.currency,
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  app.post("/admin/settlement/entries", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      orderId?: string;
      clientReceivable?: number;
      supplierPayable?: number;
      taxFee?: number;
      currency?: string;
    };
    const orderId = body.orderId?.trim();
    const clientReceivable = Number(body.clientReceivable);
    const supplierPayable = Number(body.supplierPayable);
    const taxFee = Number(body.taxFee);
    if (!orderId || !Number.isFinite(clientReceivable) || !Number.isFinite(supplierPayable) || !Number.isFinite(taxFee)) {
      fail(res, 400, "BAD_REQUEST", "invalid settlement payload");
      return;
    }
    const id = `set_${Date.now()}`;
    const created = await prisma.adminSettlementEntry.create({
      data: {
        id,
        companyId: auth.companyId,
        orderId,
        clientReceivable,
        supplierPayable,
        taxFee,
        currency: body.currency?.trim() || "CNY",
      },
      select: { id: true, updatedAt: true },
    });
    ok(res, { id: created.id, updatedAt: created.updatedAt.toISOString() });
  });

  app.get("/admin/settlement/profit", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = await prisma.adminSettlementEntry.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
    });
    ok(res, {
      items: rows.map((item) => {
        const cr = decToNumber(item.clientReceivable);
        const sp = decToNumber(item.supplierPayable);
        const tf = decToNumber(item.taxFee);
        return {
          orderId: item.orderId,
          clientReceivable: cr,
          supplierPayable: sp,
          taxFee: tf,
          profit: Number((cr - sp - tf).toFixed(2)),
          currency: item.currency,
          updatedAt: item.updatedAt.toISOString(),
        };
      }),
    });
  });

  app.get("/admin/ops/overview", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const profitRows = await prisma.adminSettlementEntry.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
    const profitNumeric = profitRows.map((item) => ({
      orderId: item.orderId,
      clientReceivable: decToNumber(item.clientReceivable),
      supplierPayable: decToNumber(item.supplierPayable),
      taxFee: decToNumber(item.taxFee),
      updatedAt: item.updatedAt.toISOString(),
    }));
    const totalRevenue = profitNumeric.reduce((sum, item) => sum + item.clientReceivable, 0);
    const totalCost = profitNumeric.reduce((sum, item) => sum + item.supplierPayable + item.taxFee, 0);
    const totalProfit = totalRevenue - totalCost;
    const grossMarginPercent = totalRevenue > 0 ? Number(((totalProfit / totalRevenue) * 100).toFixed(2)) : 0;
    const profitTrend = profitNumeric.slice(0, 7).map((item) => ({
      orderId: item.orderId,
      profit: Number((item.clientReceivable - item.supplierPayable - item.taxFee).toFixed(2)),
      updatedAt: item.updatedAt,
    }));

    const customsRows = await prisma.adminCustomsCase.findMany({
      where: { companyId: auth.companyId, status: { in: ["inspection", "pending"] } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });

    const lmpRows = await prisma.adminLmpRate.findMany({
      where: { companyId: auth.companyId },
      orderBy: [{ routeCode: "asc" }, { supplierName: "asc" }, { updatedAt: "desc" }],
    });
    const latestByKey = new Map<string, { quotePrice: number; updatedAt: string }>();
    const previousByKey = new Map<string, { quotePrice: number; updatedAt: string }>();
    lmpRows.forEach((item) => {
      const key = `${item.routeCode}__${item.supplierName}`;
      const snapshot = { quotePrice: decToNumber(item.quotePrice), updatedAt: item.updatedAt.toISOString() };
      if (!latestByKey.has(key)) {
        latestByKey.set(key, snapshot);
      } else if (!previousByKey.has(key)) {
        previousByKey.set(key, snapshot);
      }
    });
    const supplierPriceAlerts = Array.from(latestByKey.entries())
      .map(([key, latest]) => {
        const previous = previousByKey.get(key);
        if (!previous) return null;
        const [routeCode, supplierName] = key.split("__");
        const delta = Number((latest.quotePrice - previous.quotePrice).toFixed(2));
        if (Math.abs(delta) < 0.01) return null;
        return {
          routeCode,
          supplierName,
          previousQuotePrice: previous.quotePrice,
          latestQuotePrice: latest.quotePrice,
          delta,
          updatedAt: latest.updatedAt,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .slice(0, 10);

    ok(res, {
      profitSummary: {
        totalRevenue: Number(totalRevenue.toFixed(2)),
        totalCost: Number(totalCost.toFixed(2)),
        totalProfit: Number(totalProfit.toFixed(2)),
        grossMarginPercent,
      },
      profitTrend,
      customsAlerts: customsRows.map((item) => ({
        id: item.id,
        shipmentId: item.shipmentId ?? undefined,
        orderId: item.orderId ?? undefined,
        status: item.status,
        remark: item.remark ?? undefined,
        updatedAt: item.updatedAt.toISOString(),
      })),
      supplierPriceAlerts,
    });
  });
}
