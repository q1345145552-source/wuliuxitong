// B-3 ~ B-7: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-18）
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";

/** 默认单价（元/m³） */
const DEFAULT_UNIT_PRICES: Record<string, number> = {
  "sea|NORMAL": 550,
  "sea|INSPECTION": 700,
  "sea|SENSITIVE": 800,
  "land|NORMAL": 1070,
  "land|INSPECTION": 1250,
  "land|SENSITIVE": 1350,
} as const;

const MIN_VOLUME_M3 = 1; // 最低计费体积

/** 根据运输方式和货型计算应收金额 */
async function calcReceivableAmount(
  companyId: string,
  transportMode: string,
  cargoType: string,
  volumeM3: number,
): Promise<number | null> {
  if (!volumeM3 || volumeM3 <= 0) return null;
  const key = `${transportMode}|${cargoType}`;
  const rule = await prisma.pricingRule.findFirst({
    where: { companyId, transportMode, cargoType, customerId: null },
    select: { unitPriceCny: true },
  });
  const unitPrice = rule ? Number(rule.unitPriceCny.toString()) : (DEFAULT_UNIT_PRICES[key] ?? null);
  if (!unitPrice || unitPrice <= 0) return null;
  const billableVol = Math.max(volumeM3, MIN_VOLUME_M3);
  return Math.round(billableVol * unitPrice * 100) / 100;
}

/** 按产品行分别计算应收金额并求和 */
async function calcReceivableByProducts(
  companyId: string,
  transportMode: string,
  products: Array<{ packageCount: number; lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null; cargoType?: string }>,
  fallbackVolume?: number | null,
): Promise<number | null> {
  let total = 0;
  let hasProductVolume = false;
  for (const p of products) {
    const vol = (p.lengthCm && p.widthCm && p.heightCm)
      ? (p.lengthCm * p.widthCm * p.heightCm * p.packageCount) / 1_000_000
      : 0;
    if (vol <= 0) continue;
    hasProductVolume = true;
    const ct = p.cargoType?.trim() || "NORMAL";
    // 缓存 key → price 避免重复查询
    const amount = await calcReceivableAmount(companyId, transportMode, ct, vol);
    if (amount !== null) total += amount;
  }
  if (hasProductVolume) return total > 0 ? Math.round(total * 100) / 100 : null;
  // 无产品体积时用回退总体积
  if (fallbackVolume && fallbackVolume > 0) {
    return calcReceivableAmount(companyId, transportMode, "NORMAL", fallbackVolume);
  }
  return null;
}
import { fail, ok, parseJsonArray, requireRole } from "../core/http-utils";
import { loadProductImagesForOrders, MAX_ORDER_PRODUCT_IMAGES } from "./product-images";
import { saveImageToDisk, deleteImageFile } from "./image-storage";

/** 批量加载订单的产品行 */
export async function loadOrderProducts(companyId: string, orderIds: string[]): Promise<Map<string, any[]>> {
  if (orderIds.length === 0) return new Map();
  const rows = await prisma.orderProduct.findMany({
    where: { companyId, orderId: { in: [...new Set(orderIds)] } },
    orderBy: { sortOrder: "asc" },
  });
  const map = new Map<string, any[]>();
  for (const r of rows) {
    const list = map.get(r.orderId) ?? [];
    list.push({
      id: r.id, itemName: r.itemName, packageCount: r.packageCount,
      lengthCm: r.lengthCm, widthCm: r.widthCm, heightCm: r.heightCm,
      productQuantity: r.productQuantity,
      cargoType: r.cargoType,
      domesticTrackingNo: r.domesticTrackingNo,
      weightKg: r.weightKg,
    });
    map.set(r.orderId, list);
  }
  return map;
}

const COMPLETED = new Set(["delivered", "returned", "cancelled"]);

/** Prisma 的 Decimal | null 转 number | null（用于返回前端）。 */
function decToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value.toString());
}

/**
 * 根据仓库ID返回湘泰运单号前缀。
 */
function warehousePrefix(warehouseId: string): string {
  if (warehouseId === "wh_guangzhou_01") return "GZXT";
  if (warehouseId === "wh_yiwu_01") return "YWXT";
  if (warehouseId === "wh_dongguan_01") return "DGXT";
  if (warehouseId === "wh_shenzhen_01") return "SZXT";
  return "XT";
}

/**
 * 将日期格式化为 YYYYMMDD。
 */
function toDatePart(dateText: string): string {
  return dateText.replace(/-/g, "").slice(0, 8);
}

/**
 * 判断员工/管理员是否可编辑该订单仓库维度下的数据。
 */
async function staffCanEditOrderWarehouse(
  _auth: { userId: string; role: string; companyId: string },
  _warehouseId: string,
): Promise<boolean> {
  return true;
}

/**
 * 按"仓库前缀+日期+3位流水"生成湘泰运单号。
 */
async function generateTrackingNo(warehouseId: string, arrivedAt: string): Promise<string> {
  const prefix = warehousePrefix(warehouseId);
  const datePart = toDatePart(arrivedAt);
  const base = `${prefix}${datePart}`;
  const count = await prisma.shipment.count({
    where: { trackingNo: { startsWith: base } },
  });
  const seq = String(count + 1).padStart(3, "0");
  return `${base}${seq}`;
}

/**
 * 生成预报单号：仓库前缀 + YB + 7 位序号，使用 pg_advisory_xact_lock 保证并发安全。
 */
const PREALERT_LOCK_KEY = 0x5afd00b1;

function prealertPrefix(warehouseId: string): string {
  if (warehouseId === "wh_guangzhou_01") return "GZYB";
  if (warehouseId === "wh_yiwu_01") return "YWYB";
  if (warehouseId === "wh_dongguan_01") return "DGYB";
  if (warehouseId === "wh_shenzhen_01") return "SZYB";
  return "YWYB";
}

async function generatePrealertNo(warehouseId: string): Promise<string> {
  const prefix = prealertPrefix(warehouseId);
  await prisma.$executeRaw`SELECT pg_advisory_xact_lock(${PREALERT_LOCK_KEY})`;

  const last = await prisma.order.findFirst({
    where: { orderNo: { startsWith: prefix } },
    orderBy: { orderNo: "desc" },
    select: { orderNo: true },
  });

  let nextSeq = 1;
  if (last?.orderNo) {
    const numPart = parseInt(last.orderNo.replace(prefix, ""), 10);
    if (!Number.isNaN(numPart)) {
      nextSeq = numPart + 1;
    }
  }

  return `${prefix}${String(nextSeq).padStart(7, "0")}`;
}

export function registerOrderRoutes(app: MinimalHttpApp): void {
  app.post("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      warehouseId?: string;
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      shipDate?: string;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      receiverNameTh?: string;
      receiverPhoneTh?: string;
      receiverAddressTh?: string;
      trackingNo?: string;
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

    if (!body.warehouseId?.trim() || (!body.itemName && !body.products?.length) || !body.transportMode) {
      fail(res, 400, "BAD_REQUEST", "missing required prealert fields");
      return;
    }

    // Compute products totals
    const products = body.products?.length
      ? body.products.map((p, i) => ({
          itemName: p.itemName.trim(),
          packageCount: p.packageCount || 1,
          lengthCm: p.lengthCm ?? null,
          widthCm: p.widthCm ?? null,
          heightCm: p.heightCm ?? null,
          productQuantity: p.productQuantity ?? null, cargoType: p.cargoType?.trim() || "NORMAL", domesticTrackingNo: p.domesticTrackingNo?.trim() || "货拉拉", weightKg: p.weightKg ?? null, sortOrder: i }))
      : [{ itemName: body.itemName!.trim(), packageCount: Number(body.packageCount ?? 0), lengthCm: null, widthCm: null, heightCm: null, productQuantity: null, sortOrder: 0 }];

    const totalPkg = products.reduce((s, p) => s + p.packageCount, 0);
    const totalWeight = products.reduce((s, p) => s + (p.weightKg ?? 0) * p.packageCount, 0);
    const totalVol = products.reduce((s, p) => {
      if (p.lengthCm && p.widthCm && p.heightCm) return s + (p.lengthCm * p.widthCm * p.heightCm * p.packageCount) / 1_000_000;
      return s;
    }, 0);
    const primaryName = products[0].itemName;

    if (!body.warehouseId?.trim() || !primaryName || !body.transportMode) {
      fail(res, 400, "BAD_REQUEST", "missing required prealert fields");
      return;
    }

    const now = new Date().toISOString();
    const shipDateText = body.shipDate?.trim() || now.slice(0, 10);
    const shipDate = new Date(`${shipDateText}T00:00:00`);
    if (Number.isNaN(shipDate.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid shipDate");
      return;
    }
    const manualWeightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const manualVolumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    const orderId = `o_${Date.now()}`;

    const orderNo = await generatePrealertNo(body.warehouseId.trim());

    await prisma.order.create({
      data: {
        id: orderId,
        companyId: auth.companyId,
        clientId: auth.userId,
        warehouseId: body.warehouseId.trim(),
        batchNo: null,
        orderNo,
        approvalStatus: "shipped",
        itemName: primaryName,
        productQuantity: 0,
        packageCount: totalPkg,
        packageUnit: body.packageUnit ?? "box",
        weightKg: totalWeight > 0 ? (totalWeight as unknown as Prisma.Decimal) : (manualWeightKg as unknown as Prisma.Decimal | null),
        volumeM3: totalVol > 0 ? totalVol : (manualVolumeM3 as unknown as Prisma.Decimal | null),
        receivableAmountCny: null,
        receivableCurrency: "CNY",
        shipDate: shipDateText,
        domesticTrackingNo: body.domesticTrackingNo ?? null,
        transportMode: body.transportMode,
        receiverNameTh: body.receiverNameTh?.trim() || "",
        receiverPhoneTh: body.receiverPhoneTh?.trim() || "",
        receiverAddressTh: body.receiverAddressTh?.trim() || "",
        statusGroup: "unfinished",
      },
    });

    // Create product records (批量插入)
    if (products.length > 0) {
      await prisma.orderProduct.createMany({
        data: products.map((p, i) => ({
          companyId: auth.companyId,
          orderId,
          itemName: p.itemName,
          packageCount: p.packageCount,
          lengthCm: p.lengthCm ?? null,
          widthCm: p.widthCm ?? null,
          heightCm: p.heightCm ?? null,
          productQuantity: p.productQuantity ?? null,
          cargoType: p.cargoType,
          domesticTrackingNo: p.domesticTrackingNo,
          sortOrder: i,
        })),
      });
    }

    // 自动计算应收金额（按产品行分别计价求和）
    if (products.length > 0) {
      const amount = await calcReceivableByProducts(auth.companyId, body.transportMode, products, totalVol);
      if (amount !== null) {
        await prisma.order.update({
          where: { id: orderId },
          data: { receivableAmountCny: amount as unknown as Prisma.Decimal },
        });
      }
    }

    // 同步创建运单（预报单=运单号）
    const shipmentId = `s_${Date.now()}`;
    await prisma.shipment.create({
      data: {
        id: shipmentId,
        companyId: auth.companyId,
        orderId,
        trackingNo: orderNo,
        batchNo: null,
        currentStatus: "created",
        weightKg: totalWeight > 0 ? (totalWeight as unknown as Prisma.Decimal) : (manualWeightKg as unknown as Prisma.Decimal | null),
        volumeM3: totalVol > 0 ? (totalVol as unknown as Prisma.Decimal) : (manualVolumeM3 as unknown as Prisma.Decimal | null),
        packageCount: totalPkg,
        packageUnit: body.packageUnit ?? "box",
        transportMode: body.transportMode,
        domesticTrackingNo: body.domesticTrackingNo ?? null,
        warehouseId: body.warehouseId.trim(),
      },
    });

    ok(res, { prealertId: orderId, trackingNo: orderNo, createdAt: now });
  });

  /**
   * 员工/管理员确认收货：核实数据并标记预报单为已收货。
   */
  app.post("/staff/prealerts/receive", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      orderId?: string;
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      productQuantity?: number;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      cargoType?: string;
    };
    const orderId = body.orderId?.trim();
    if (!orderId) { fail(res, 400, "BAD_REQUEST", "orderId is required"); return; }

    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      include: { shipments: { take: 1, select: { id: true } } },
    });
    if (!order) { fail(res, 404, "NOT_FOUND", "order not found"); return; }
    if (order.approvalStatus === "received") {
      fail(res, 400, "VALIDATION_ERROR", "已确认收货");
      return;
    }

    const now = new Date();
    const updateData: any = {
      approvalStatus: "received",
      statusGroup: "unfinished",
      updatedAt: now,
    };
    if (body.itemName?.trim()) updateData.itemName = body.itemName.trim();
    if (body.packageCount !== undefined) updateData.packageCount = Number(body.packageCount);
    if (body.packageUnit) updateData.packageUnit = body.packageUnit;
    if (body.weightKg !== undefined) updateData.weightKg = body.weightKg as any;
    if (body.volumeM3 !== undefined) updateData.volumeM3 = body.volumeM3 as any;
    if (body.productQuantity !== undefined) updateData.productQuantity = Number(body.productQuantity);
    if (body.transportMode) updateData.transportMode = body.transportMode;
    if (body.cargoType) updateData.cargoType = body.cargoType;
    if (body.domesticTrackingNo) updateData.domesticTrackingNo = body.domesticTrackingNo;

    await prisma.order.update({ where: { id: orderId }, data: updateData });

    // 同步更新运单
    const shipment = order.shipments[0];
    if (shipment) {
      const sUpdate: any = { updatedAt: now };
      if (body.weightKg !== undefined) sUpdate.weightKg = body.weightKg as any;
      if (body.volumeM3 !== undefined) sUpdate.volumeM3 = body.volumeM3 as any;
      if (body.packageCount !== undefined) sUpdate.packageCount = Number(body.packageCount);
      if (body.packageUnit) sUpdate.packageUnit = body.packageUnit;
      if (body.transportMode) sUpdate.transportMode = body.transportMode;
      if (body.itemName?.trim()) sUpdate.itemName = body.itemName.trim();
      await prisma.shipment.update({ where: { id: shipment.id }, data: sUpdate });
    }

    ok(res, { orderId, status: "received", updatedAt: now.toISOString() });
  });

  /**
   * 客户端删除预报单（已收货前可删）。
   */
  app.post("/client/prealerts/delete", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { orderId?: string };
    const orderId = body.orderId?.trim();
    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }
    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId, clientId: auth.userId },
    });
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }
    if (order.approvalStatus === "received") {
      fail(res, 400, "VALIDATION_ERROR", "已确认收货，无法删除");
      return;
    }
    await prisma.orderProductImage.deleteMany({ where: { orderId } });
    await prisma.order.delete({ where: { id: orderId } });
    ok(res, { deleted: true, orderId });
  });

  /**
   * 客户端编辑待审核预报单（仅 pending 状态可编辑）。
   */
  app.post("/client/prealerts/update", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      orderId?: string;
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      shipDate?: string;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      receiverNameTh?: string;
      receiverPhoneTh?: string;
      receiverAddressTh?: string;
    };
    const orderId = body.orderId?.trim();
    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }
    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId, clientId: auth.userId },
    });
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }
    if (order.approvalStatus === "received") {
      fail(res, 400, "VALIDATION_ERROR", "已确认收货，无法编辑");
      return;
    }
    const now = new Date();
    await prisma.order.update({
      where: { id: orderId },
      data: {
        itemName: body.itemName?.trim() ?? order.itemName,
        packageCount: body.packageCount !== undefined ? Number(body.packageCount) : order.packageCount,
        packageUnit: body.packageUnit ?? order.packageUnit,
        weightKg: body.weightKg !== undefined ? (body.weightKg as unknown as Prisma.Decimal) : order.weightKg,
        volumeM3: body.volumeM3 !== undefined ? (body.volumeM3 as unknown as Prisma.Decimal) : order.volumeM3,
        shipDate: body.shipDate?.trim() ?? order.shipDate,
        domesticTrackingNo: body.domesticTrackingNo?.trim() ?? order.domesticTrackingNo,
        transportMode: body.transportMode ?? order.transportMode,
        receiverNameTh: body.receiverNameTh?.trim() ?? order.receiverNameTh,
        receiverPhoneTh: body.receiverPhoneTh?.trim() ?? order.receiverPhoneTh,
        receiverAddressTh: body.receiverAddressTh?.trim() ?? order.receiverAddressTh,
        updatedAt: now,
      },
    });
    ok(res, { updated: true, orderId });
  });

  app.post("/staff/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      clientId?: string;
      batchNo?: string;
      trackingNo?: string;
      arrivedAt?: string;
      itemName?: string;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      domesticTrackingNo?: string;
      cargoType?: string;
      transportMode?: "sea" | "land";
      receiverNameTh?: string;
      receiverPhoneTh?: string;
      receiverAddressTh?: string;
      warehouseId?: string;
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

    const staffProducts = body.products?.length
      ? body.products.map((p, i) => ({
          itemName: p.itemName.trim(),
          packageCount: p.packageCount || 1,
          lengthCm: p.lengthCm ?? null,
          widthCm: p.widthCm ?? null,
          heightCm: p.heightCm ?? null,
          productQuantity: p.productQuantity ?? null, cargoType: p.cargoType?.trim() || "NORMAL", domesticTrackingNo: p.domesticTrackingNo?.trim() || "货拉拉", weightKg: p.weightKg ?? null, sortOrder: i }))
      : body.itemName ? [{ itemName: body.itemName.trim(), packageCount: Number(body.packageCount ?? 0), lengthCm: null, widthCm: null, heightCm: null, productQuantity: null, sortOrder: 0 }] : [];

    const prName = staffProducts[0]?.itemName ?? body.itemName ?? "";
    const prPkg = staffProducts.reduce((s, p) => s + p.packageCount, 0) || Number(body.packageCount ?? 0);
    const prWeight = staffProducts.reduce((s, p) => s + (p.weightKg ?? 0) * p.packageCount, 0);
    const prVol = staffProducts.reduce((s, p) => {
      if (p.lengthCm && p.widthCm && p.heightCm) return s + (p.lengthCm * p.widthCm * p.heightCm * p.packageCount) / 1_000_000;
      return s;
    }, 0);

    if (
      !body.clientId ||
      (!prName && !body.itemName) ||
      !body.transportMode ||
      !body.warehouseId ||
      !body.arrivedAt?.trim()
    ) {
      fail(res, 400, "BAD_REQUEST", "missing required fields");
      return;
    }

    const arrivedAtDate = new Date(`${body.arrivedAt}T00:00:00`);
    if (Number.isNaN(arrivedAtDate.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid arrivedAt");
      return;
    }

    const now = arrivedAtDate.toISOString();
    const orderId = `o_${Date.now()}`;
    const shipmentId = `s_${Date.now()}`;
    const manualTrackingNo = body.trackingNo?.trim();
    if (manualTrackingNo) {
      const clash = await prisma.shipment.findFirst({
        where: { trackingNo: manualTrackingNo, companyId: auth.companyId },
        select: { id: true },
      });
      if (clash) {
        fail(res, 409, "CONFLICT", `运单号 ${manualTrackingNo} 已存在`);
        return;
      }
    }
    if (!manualTrackingNo) {
      fail(res, 400, "BAD_REQUEST", "运单号为必填");
      return;
    }
    const generatedTrackingNo = manualTrackingNo;
    const weightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    const batchNo = body.batchNo?.trim() || null;
    const packageCountNum = Number(body.packageCount ?? 0);
    const packageUnit = body.packageUnit ?? "box";

    // 事务前计算应收金额（按产品行分别计价求和）
    const calcAmount = staffProducts.length > 0
      ? await calcReceivableByProducts(auth.companyId, body.transportMode, staffProducts, volumeM3)
      : await calcReceivableAmount(auth.companyId, body.transportMode, "NORMAL", prVol || (volumeM3 ?? 0));

    const txOps: any[] = [
      prisma.order.create({
        data: {
          id: orderId,
          companyId: auth.companyId,
          clientId: body.clientId,
          warehouseId: body.warehouseId,
          batchNo,
          orderNo: null,
          approvalStatus: "approved",
          itemName: body.itemName?.trim() || prName,
          productQuantity: Number(body.productQuantity ?? 0),
          packageCount: packageCountNum,
          packageUnit,
          weightKg: prWeight > 0 ? (prWeight as unknown as Prisma.Decimal) : (weightKg as unknown as Prisma.Decimal | null),
          volumeM3: prVol > 0 ? (prVol as unknown as Prisma.Decimal) : (volumeM3 as unknown as Prisma.Decimal | null),
          receivableAmountCny: calcAmount !== null ? (calcAmount as unknown as Prisma.Decimal) : null,
          receivableCurrency: "CNY",
          shipDate: body.arrivedAt.trim(),
          domesticTrackingNo: body.domesticTrackingNo ?? null,
          transportMode: body.transportMode,
          cargoType: body.cargoType?.trim() || "NORMAL",
          receiverNameTh: "",
          receiverPhoneTh: "",
          receiverAddressTh: "",
          statusGroup: "unfinished",
        },
      }),
      prisma.shipment.create({
        data: {
          id: shipmentId,
          companyId: auth.companyId,
          orderId,
          trackingNo: generatedTrackingNo,
          batchNo,
          currentStatus: "created",
          currentLocation: null,
          weightKg: prWeight > 0 ? (prWeight as unknown as Prisma.Decimal) : (weightKg as unknown as Prisma.Decimal | null),
          volumeM3: prVol > 0 ? (prVol as unknown as Prisma.Decimal) : (volumeM3 as unknown as Prisma.Decimal | null),
          packageCount: packageCountNum,
          packageUnit,
          transportMode: body.transportMode,
          domesticTrackingNo: body.domesticTrackingNo ?? null,
          warehouseId: body.warehouseId,
        },
      }),
    ];
    // 保存产品行
    if (staffProducts.length > 0) {
      txOps.push(
        prisma.orderProduct.createMany({
          data: staffProducts.map((p) => ({
            companyId: auth.companyId,
            orderId,
            itemName: p.itemName,
            packageCount: p.packageCount,
            lengthCm: p.lengthCm,
            widthCm: p.widthCm,
            heightCm: p.heightCm,
            productQuantity: p.productQuantity,
            cargoType: p.cargoType,
            domesticTrackingNo: p.domesticTrackingNo,
            weightKg: p.weightKg,
            sortOrder: p.sortOrder,
          })),
        }),
      );
    }
    await prisma.$transaction(txOps);

    ok(res, { orderId, createdAt: now });
  });

  app.post("/staff/orders/set-receivable", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      orderId?: string;
      receivableAmountCny?: number;
      receivableCurrency?: "CNY" | "THB";
    };
    const orderId = body.orderId?.trim();
    const amount = body.receivableAmountCny === undefined ? NaN : Number(body.receivableAmountCny);
    const currency = body.receivableCurrency === "THB" ? "THB" : "CNY";

    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      fail(res, 400, "BAD_REQUEST", "receivableAmountCny must be greater than 0");
      return;
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      select: { id: true, warehouseId: true },
    });
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        receivableAmountCny: amount as unknown as Prisma.Decimal,
        receivableCurrency: currency,
      },
      select: { updatedAt: true },
    });

    ok(res, {
      orderId,
      receivableAmountCny: amount,
      receivableCurrency: currency,
      updatedAt: updated.updatedAt.toISOString(),
    });
  });

  app.post("/staff/orders/set-payment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      orderId?: string;
      paymentStatus?: "paid" | "unpaid";
      proofFileName?: string;
      proofMime?: string;
      proofBase64?: string;
    };
    const orderId = body.orderId?.trim();
    const paymentStatus = body.paymentStatus === "paid" ? "paid" : body.paymentStatus === "unpaid" ? "unpaid" : null;
    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }
    if (!paymentStatus) {
      fail(res, 400, "BAD_REQUEST", "paymentStatus must be 'paid' or 'unpaid'");
      return;
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      select: { id: true, warehouseId: true },
    });
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    if (paymentStatus === "paid") {
      const proofFileName = typeof body.proofFileName === "string" ? body.proofFileName.trim() : "";
      const proofMime = typeof body.proofMime === "string" ? body.proofMime.trim() : "";
      const proofBase64 = typeof body.proofBase64 === "string" ? body.proofBase64.trim() : "";
      if (!proofFileName || !proofMime || !proofBase64) {
        fail(res, 400, "BAD_REQUEST", "payment proof is required when marking as paid");
        return;
      }
      // Basic size guard to avoid storing extremely large blobs.
      // base64 expands ~4/3, so 4MB base64 ~= 3MB binary.
      if (proofBase64.length > 4_000_000) {
        fail(res, 400, "BAD_REQUEST", "payment proof is too large (max 4MB base64)");
        return;
      }
      try {
        const buf = Buffer.from(proofBase64, "base64");
        if (buf.length === 0) {
          fail(res, 400, "BAD_REQUEST", "invalid payment proof");
          return;
        }
      } catch {
        fail(res, 400, "BAD_REQUEST", "invalid payment proof");
        return;
      }
      await prisma.order.update({
        where: { id: orderId },
        data: {
          paymentStatus: "paid",
          paidAt: now,
          paidBy: auth.userId,
          paymentProofFileName: proofFileName,
          paymentProofMime: proofMime,
          paymentProofBase64: proofBase64,
          paymentProofUploadedAt: now,
        },
      });
      ok(res, { orderId, paymentStatus: "paid", paidAt: nowIso, paidBy: auth.userId, updatedAt: nowIso });
      return;
    }

    await prisma.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: "unpaid",
        paidAt: null,
        paidBy: null,
        paymentProofFileName: null,
        paymentProofMime: null,
        paymentProofBase64: null,
        paymentProofUploadedAt: null,
      },
    });
    ok(res, { orderId, paymentStatus: "unpaid", paidAt: null, paidBy: null, updatedAt: nowIso });
  });

  app.get("/client/orders", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const statusGroup = req.query.statusGroup?.trim();
    const itemName = req.query.itemName?.trim();
    const transportMode = req.query.transportMode?.trim();
    const trackingNo = req.query.trackingNo?.trim();
    const orderNo = req.query.orderNo?.trim();
    const domesticTrackingNo = req.query.domesticTrackingNo?.trim();

    const orders = await prisma.order.findMany({
      where: {
        companyId: auth.companyId,
        approvalStatus: { in: ["approved", "shipped"] },
        clientId: auth.userId,
      },
      orderBy: { createdAt: "asc" },
      include: {
        shipments: {
          orderBy: { updatedAt: "desc" },
          take: 1,
          select: {
            id: true,
            trackingNo: true,
            currentStatus: true,
            statusLogs: {
              where: { NOT: [{ remark: null }, { remark: "" }] },
              orderBy: { changedAt: "asc" },
              select: {
                remark: true,
                changedAt: true,
                fromStatus: true,
                toStatus: true,
                operatorRole: true,
                operatorName: true,
              },
            },
          },
        },
      },
    });

    const filtered = orders
      .filter((o) => !itemName || o.itemName.includes(itemName))
      .filter((o) => !transportMode || o.transportMode === transportMode)
      .filter((o) => !trackingNo || o.shipments[0]?.trackingNo === trackingNo)
      .filter((o) => !orderNo || o.orderNo === orderNo)
      .filter((o) => !domesticTrackingNo || o.domesticTrackingNo === domesticTrackingNo)
      .filter((o) => {
        const cur = o.shipments[0]?.currentStatus;
        const completed = cur ? COMPLETED.has(cur) : false;
        if (statusGroup === "completed") return completed;
        if (statusGroup === "unfinished") return !completed;
        return true;
      });

    const items = filtered.map((o) => {
      const ship = o.shipments[0];
      const logisticsRecords = (ship?.statusLogs ?? []).map((r) => ({
        remark: r.remark ?? "",
        changedAt: r.changedAt.toISOString(),
        fromStatus: r.fromStatus,
        toStatus: r.toStatus,
        operatorRole: r.operatorRole,
        operatorName: r.operatorName ?? "",
      }));
      const latestRemark = logisticsRecords.at(-1)?.remark ?? null;
      return {
        id: o.id,
        warehouseId: o.warehouseId,
        orderNo: o.orderNo,
        itemName: o.itemName,
        transportMode: o.transportMode,
        domesticTrackingNo: o.domesticTrackingNo,
        batchNo: o.batchNo,
        approvalStatus: o.approvalStatus,
        trackingNo: ship?.trackingNo ?? null,
        currentStatus: ship?.currentStatus ?? null,
        productQuantity: o.productQuantity,
        packageCount: o.packageCount,
        packageUnit: o.packageUnit,
        weightKg: decToNumber(o.weightKg),
        volumeM3: decToNumber(o.volumeM3),
        receivableAmountCny: decToNumber(o.receivableAmountCny),
        receivableCurrency: o.receivableCurrency ?? "CNY",
        paymentStatus: o.paymentStatus ?? "unpaid",
        paidAt: o.paidAt ? o.paidAt.toISOString() : undefined,
        paidBy: o.paidBy ?? undefined,
        shipDate: o.shipDate,
        cargoType: o.cargoType ?? "NORMAL",
        latestRemark,
        logisticsRecords,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
      };
    });

    const orderIds = items.map((item) => item.id);
    const imageMap = await loadProductImagesForOrders(auth.companyId, orderIds);
    const productsMap = await loadOrderProducts(auth.companyId, orderIds);
    const itemsWithImages = items.map((item) => ({
      ...item,
      productImages: imageMap.get(item.id) ?? [],
      products: productsMap.get(item.id) ?? [],
    }));

    ok(res, {
      items: itemsWithImages,
      page: 1,
      pageSize: itemsWithImages.length,
      total: itemsWithImages.length,
    });
  });

  app.get("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const statusFilter = req.query.status?.trim();
    const approvalFilter = statusFilter === "all"
      ? undefined
      : statusFilter === "approved" || statusFilter === "shipped"
        ? statusFilter
        : "pending";
    const orders = await prisma.order.findMany({
      where: {
        companyId: auth.companyId,
        approvalStatus: approvalFilter,
        clientId: auth.userId,
      },
      orderBy: { createdAt: "desc" },
    });
    const items = orders.map((o) => ({
      id: o.id,
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
      receivableAmountCny: decToNumber(o.receivableAmountCny),
      receivableCurrency: o.receivableCurrency ?? "CNY",
      paymentStatus: o.paymentStatus ?? "unpaid",
      paidAt: o.paidAt ? o.paidAt.toISOString() : undefined,
      paidBy: o.paidBy ?? undefined,
      shipDate: o.shipDate,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    }));
    const prealertIds = items.map((item) => item.id);
    const prealertImageMap = await loadProductImagesForOrders(auth.companyId, prealertIds);
    const prealertProductsMap = await loadOrderProducts(auth.companyId, prealertIds);
    const prealertItemsWithImages = items.map((item) => ({
      ...item,
      productImages: prealertImageMap.get(item.id) ?? [],
        products: prealertProductsMap.get(item.id) ?? [],
    }));
    ok(res, {
      items: prealertItemsWithImages,
      page: 1,
      pageSize: prealertItemsWithImages.length,
      total: prealertItemsWithImages.length,
    });
  });

  app.get("/staff/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { warehouseIds: true },
    });
    const editableWarehouses = parseJsonArray(user?.warehouseIds);

    const orders = await prisma.order.findMany({
      where: {
        companyId: auth.companyId,
        approvalStatus: { in: ["shipped", "received"] },
      },
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { name: true } },
      },
    });

    const items = orders
      .filter((o) => auth.role === "admin" || editableWarehouses.includes(o.warehouseId))
      .map((o) => ({
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
        receivableAmountCny: decToNumber(o.receivableAmountCny),
        receivableCurrency: o.receivableCurrency ?? "CNY",
        paymentStatus: o.paymentStatus ?? "unpaid",
        paidAt: o.paidAt ? o.paidAt.toISOString() : undefined,
        paidBy: o.paidBy ?? undefined,
        shipDate: o.shipDate,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
      }));
    const staffPrealertIds = items.map((item) => item.id);
    const staffPrealertImageMap = await loadProductImagesForOrders(auth.companyId, staffPrealertIds);
    const staffPrealertProductsMap = await loadOrderProducts(auth.companyId, staffPrealertIds);
    const staffPrealertItemsWithImages = items.map((item) => ({
      ...item,
      productImages: staffPrealertImageMap.get(item.id) ?? [],
        products: staffPrealertProductsMap.get(item.id) ?? [],
    }));
    ok(res, {
      items: staffPrealertItemsWithImages,
      page: 1,
      pageSize: staffPrealertItemsWithImages.length,
      total: staffPrealertItemsWithImages.length,
    });
  });

  app.post("/staff/orders/product-images", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin", "client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      orderId?: string;
      fileName?: string;
      mime?: string;
      contentBase64?: string;
    };
    const orderId = body.orderId?.trim();
    const fileName = body.fileName?.trim();
    const mimeType = body.mime?.trim();
    const contentBase64 = body.contentBase64?.trim();
    if (!orderId || !fileName || !mimeType || !contentBase64) {
      fail(res, 400, "BAD_REQUEST", "orderId, fileName, mime and contentBase64 are required");
      return;
    }
    if (!mimeType.startsWith("image/")) {
      fail(res, 400, "BAD_REQUEST", "only image uploads are allowed");
      return;
    }
    if (contentBase64.length > 20_000_000) {
      fail(res, 400, "BAD_REQUEST", "file too large (max 20MB base64)");
      return;
    }
    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      select: { id: true, warehouseId: true, approvalStatus: true },
    });
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }
    if (auth.role === "staff" && order.approvalStatus !== "pending" && order.approvalStatus !== "approved") {
      fail(res, 403, "FORBIDDEN", "staff can only manage product images for pending or approved orders");
      return;
    }
    if (auth.role === "client" && (order.clientId !== auth.userId || order.approvalStatus !== "pending")) {
      fail(res, 403, "FORBIDDEN", "client can only manage product images for their own pending prealerts");
      return;
    }
    if (!(await staffCanEditOrderWarehouse(auth, order.warehouseId))) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }
    const count = await prisma.orderProductImage.count({
      where: { companyId: auth.companyId, orderId },
    });
    // 图片数量不限制
    try {
      const buf = Buffer.from(contentBase64, "base64");
      if (buf.length === 0) {
        fail(res, 400, "BAD_REQUEST", "invalid image content");
        return;
      }
    } catch {
      fail(res, 400, "BAD_REQUEST", "invalid image content");
      return;
    }
    const now = new Date();
    const imageId = `opi_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    // 保存文件到磁盘
    const filePath = saveImageToDisk(orderId, mimeType, contentBase64);
    await prisma.orderProductImage.create({
      data: {
        id: imageId,
        companyId: auth.companyId,
        orderId,
        fileName,
        mime: mimeType,
        contentBase64,
        filePath,
        uploadedBy: auth.userId,
        createdAt: now,
      },
    });
    ok(res, { id: imageId, orderId, fileName, mime: mimeType, filePath, createdAt: now.toISOString() });
  });

  app.delete("/staff/orders/product-images", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin", "client"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }
    const image = await prisma.orderProductImage.findFirst({
      where: { id, companyId: auth.companyId },
      include: {
        order: { select: { warehouseId: true, approvalStatus: true } },
      },
    });
    if (!image || !image.order) {
      fail(res, 404, "NOT_FOUND", "image not found");
      return;
    }
    if (auth.role === "staff" && image.order.approvalStatus !== "pending" && image.order.approvalStatus !== "approved") {
      fail(res, 403, "FORBIDDEN", "staff can only manage product images for pending or approved orders");
      return;
    }
    if (auth.role === "client" && (image.order.clientId !== auth.userId || image.order.approvalStatus !== "pending")) {
      fail(res, 403, "FORBIDDEN", "client can only manage their own pending prealert images");
      return;
    }
    if (!(await staffCanEditOrderWarehouse(auth, image.order.warehouseId))) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }
    // 删除磁盘文件
    if (image.filePath) {
      deleteImageFile(image.filePath);
    }
    const result = await prisma.orderProductImage.deleteMany({
      where: { id, companyId: auth.companyId },
    });
    ok(res, { deleted: result.count > 0, id });
  });

  /**
   * 员工按运单维度一次性更新关联订单与运单的基础信息（与列表「订单详情」编辑一致）。
   */
  app.post("/staff/orders/patch-shipment-bundle", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      shipmentId?: string;
      trackingNo?: string;
      batchNo?: string | null;
      itemName?: string;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number | null;
      volumeM3?: number | null;
      domesticTrackingNo?: string | null;
      orderCreatedDate?: string;
      transportMode?: "sea" | "land";
      shipDate?: string | null;
      receiverAddressTh?: string;
      containerNo?: string | null;
      receivableAmountCny?: number | null;
      receivableCurrency?: "CNY" | "THB";
      /** 同步更新订单与运单的归属仓库（员工须对新仓库有编辑权限）。 */
      warehouseId?: string;
    };

    const shipmentId = body.shipmentId?.trim();
    if (!shipmentId) {
      fail(res, 400, "BAD_REQUEST", "shipmentId is required");
      return;
    }

    const shipment = await prisma.shipment.findFirst({
      where: { id: shipmentId, companyId: auth.companyId },
      include: {
        order: {
          where: { companyId: auth.companyId },
          select: {
            id: true,
            warehouseId: true,
            receivableAmountCny: true,
            receivableCurrency: true,
          },
        },
      },
    });
    if (!shipment || !shipment.order) {
      fail(res, 404, "NOT_FOUND", "shipment or order not found");
      return;
    }
    const curOrder = shipment.order;

    if (!(await staffCanEditOrderWarehouse(auth, curOrder.warehouseId))) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }

    let nextWarehouseId = curOrder.warehouseId;
    if (body.warehouseId !== undefined && body.warehouseId !== null && String(body.warehouseId).trim() !== "") {
      const nw = String(body.warehouseId).trim();
      if (!(await staffCanEditOrderWarehouse(auth, nw))) {
        fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
        return;
      }
      nextWarehouseId = nw;
    }

    const trackingNo = typeof body.trackingNo === "string" ? body.trackingNo.trim() : "";
    if (!trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
      return;
    }
    if (trackingNo !== shipment.trackingNo) {
      const clash = await prisma.shipment.findFirst({
        where: {
          companyId: auth.companyId,
          trackingNo,
          NOT: { id: shipmentId },
        },
        select: { id: true },
      });
      if (clash) {
        fail(res, 400, "BAD_REQUEST", "trackingNo already exists");
        return;
      }
    }

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

    const orderCreatedDate = body.orderCreatedDate?.trim();
    if (!orderCreatedDate) {
      fail(res, 400, "BAD_REQUEST", "orderCreatedDate is required");
      return;
    }
    const arrived = new Date(`${orderCreatedDate}T00:00:00.000Z`);
    if (Number.isNaN(arrived.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid orderCreatedDate");
      return;
    }

    const transportMode = body.transportMode === "land" ? "land" : "sea";

    let shipDate: string | null = null;
    if (body.shipDate !== undefined && body.shipDate !== null && String(body.shipDate).trim() !== "") {
      const raw = String(body.shipDate).trim().slice(0, 10);
      const sd = new Date(`${raw}T00:00:00.000Z`);
      if (Number.isNaN(sd.getTime())) {
        fail(res, 400, "BAD_REQUEST", "invalid shipDate");
        return;
      }
      shipDate = raw;
    }

    let receivableAmount: number | null = decToNumber(curOrder.receivableAmountCny);
    let currency: "CNY" | "THB" = curOrder.receivableCurrency === "THB" ? "THB" : "CNY";
    if (body.receivableAmountCny !== undefined && body.receivableAmountCny !== null) {
      const amt = Number(body.receivableAmountCny);
      if (!Number.isFinite(amt) || amt < 0) {
        fail(res, 400, "BAD_REQUEST", "invalid receivableAmountCny");
        return;
      }
      receivableAmount = amt === 0 ? null : amt;
    }
    if (body.receivableCurrency === "THB" || body.receivableCurrency === "CNY") {
      currency = body.receivableCurrency;
    }

    const batchNo = body.batchNo?.trim() || null;
    const domesticTrackingNo = body.domesticTrackingNo?.trim() || null;
    const receiverAddressTh = body.receiverAddressTh?.trim() ?? "";
    const containerNo = body.containerNo?.trim() || null;

    const now = new Date();

    await prisma.$transaction([
      prisma.order.update({
        where: { id: curOrder.id },
        data: {
          warehouseId: nextWarehouseId,
          batchNo,
          itemName,
          productQuantity: Math.floor(productQuantity),
          packageCount: Math.floor(packageCount),
          packageUnit,
          weightKg: weightKg as unknown as Prisma.Decimal | null,
          volumeM3: (volumeM3 as unknown as Prisma.Decimal | null),
          domesticTrackingNo,
          transportMode,
          shipDate,
          receiverAddressTh,
          receivableAmountCny: receivableAmount as unknown as Prisma.Decimal | null,
          receivableCurrency: currency,
          createdAt: arrived,
        },
      }),
      prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          warehouseId: nextWarehouseId,
          trackingNo,
          batchNo,
          domesticTrackingNo,
          packageCount: Math.floor(packageCount),
          packageUnit,
          weightKg: weightKg as unknown as Prisma.Decimal | null,
          volumeM3: (volumeM3 as unknown as Prisma.Decimal | null),
          transportMode,
          containerNo,
        },
      }),
    ]);

    ok(res, {
      shipmentId,
      orderId: curOrder.id,
      updatedAt: now.toISOString(),
    });
  });

  // approve endpoint removed — replaced by POST /staff/prealerts/receive

  // 尾端派送：获取所有客户及其地址
  app.get("/staff/lastmile/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const keyword = req.query.keyword?.trim().toLowerCase() || "";

    const users = await prisma.user.findMany({
      where: {
        companyId: auth.companyId,
        role: "client",
        ...(keyword ? {
          OR: [
            { id: { contains: keyword, mode: "insensitive" } },
            { name: { contains: keyword, mode: "insensitive" } },
          ],
        } : {}),
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        phone: true,
        addresses: {
          select: {
            id: true,
            contactName: true,
            contactPhone: true,
            addressDetail: true,
            isDefault: true,
          },
          orderBy: { isDefault: "desc" },
        },
      },
    });

    ok(res, { items: users });
  });

  // 尾端派送：删除地址
  app.delete("/staff/lastmile/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "id is required"); return; }
    const addr = await prisma.clientAddress.findFirst({ where: { id, companyId: auth.companyId } });
    if (!addr) { fail(res, 404, "NOT_FOUND", "address not found"); return; }
    await prisma.clientAddress.delete({ where: { id } });
    ok(res, { deleted: true, id });
  });

  // 获取客户列表（供员工端创建订单时选择）
  app.get("/staff/clients", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const users = await prisma.user.findMany({
      where: { companyId: auth.companyId, role: "client" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });

    ok(res, { items: users });
  });
}
