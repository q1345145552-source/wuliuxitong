import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { saveImageToDisk } from "../orders/image-storage";
import { syncPlanStatus } from "./utils";

// ============================================================================
// 员工端路由注册
// ============================================================================

export function registerWhrConsolidationStaffRoutes(app: MinimalHttpApp): void {
  // ==========================================================================
  // 1. 仓库签收
  //    filling → received_pending_payment，按货物类型分档计费
  // ==========================================================================
  app.post("/staff/whr-consolidation/warehouse-sign", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      customerId?: string;
      receiptFileName?: string;
      receiptMime?: string;
      receiptBase64?: string;
    };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.customerId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "customerId 为必填");
      return;
    }
    if (!body.receiptBase64?.trim()) {
      fail(res, 400, "BAD_REQUEST", "收货凭证照片为必填，请拍照上传");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: body.customerId, planId: body.planId, companyId: auth.companyId },
      include: {
        prealerts: {
          where: { status: "pending" },
          include: { items: true },
        },
      },
    });

    if (!customer) {
      fail(res, 404, "NOT_FOUND", "客户记录不存在");
      return;
    }
    if (customer.status !== "filling") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可签收，仅填货中状态可操作");
      return;
    }
    if (customer.totalVolumeM3.eq(0)) {
      fail(res, 400, "BAD_REQUEST", "客户尚无货品，无法签收");
      return;
    }

    // 按货物类型分档计费
    let feeNormal = 0;
    let feeInspection = 0;
    let feeSensitive = 0;

    for (const pa of customer.prealerts) {
      for (const item of pa.items) {
        const vol = item.volumeM3?.toNumber() ?? 0;
        if (item.cargoType === "inspection") {
          feeInspection += vol;
        } else if (item.cargoType === "sensitive") {
          feeSensitive += vol;
        } else {
          feeNormal += vol;
        }
      }
    }

    const totalFee =
      Math.round(
        (feeNormal * customer.unitPriceNormal.toNumber() +
          feeInspection * customer.unitPriceInspection.toNumber() +
          feeSensitive * customer.unitPriceSensitive.toNumber()) *
          100
      ) / 100;

    const now = new Date();
    const prealertIds = customer.prealerts.map((pa) => pa.id);

    // 保存收货凭证照片到磁盘
    const receiptPath = saveImageToDisk(
      `whr_warehouse_receipt_${Date.now()}`,
      body.receiptMime?.trim() || "image/png",
      body.receiptBase64!.trim()
    );

    await prisma.$transaction(async (tx) => {
      // 更新客户状态 + 费用 + 收货凭证
      await tx.whrConsolidationPlanCustomer.update({
        where: { id: body.customerId! },
        data: {
          status: "received_pending_payment",
          signedAt: now,
          totalFee,
          warehouseReceiptFileName: body.receiptFileName?.trim() || receiptPath.split("/").pop() || "",
          warehouseReceiptMime: body.receiptMime?.trim() || "image/png",
          warehouseReceiptBase64: receiptPath,
        },
      });

      // 批量更新该客户下所有 pending 预报单为 received
      if (prealertIds.length > 0) {
        await tx.whrConsolidationPrealert.updateMany({
          where: { id: { in: prealertIds }, status: "pending" },
          data: { status: "received", receivedAt: now },
        });
      }

      // 写状态日志
      await tx.whrConsolidationStatusLog.create({
        data: {
          customerId: body.customerId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "filling",
          toStatus: "received_pending_payment",
          remark: `仓库签收，系统自动计费 ¥${totalFee}（普货 ¥${Math.round(feeNormal * customer.unitPriceNormal.toNumber() * 100) / 100} + 商检 ¥${Math.round(feeInspection * customer.unitPriceInspection.toNumber() * 100) / 100} + 敏感 ¥${Math.round(feeSensitive * customer.unitPriceSensitive.toNumber() * 100) / 100}）`,
        },
      });

      await syncPlanStatus(body.planId!, tx);

      return true;
    });

    ok(res, {
      customerId: body.customerId,
      status: "received_pending_payment",
      totalFee,
      prealertCount: prealertIds.length,
      signedAt: now.toISOString(),
    });
  });

  // ==========================================================================
  // 2. 尾端拆派视图
  //    已付款及之后状态的客户 + 预报单 + 货品明细 + 收货地址
  // ==========================================================================
  app.get("/staff/whr-consolidation/dispatch-view", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const plans = await prisma.whrConsolidationPlan.findMany({
      where: { companyId: auth.companyId },
      orderBy: { createdAt: "desc" },
      include: {
        customers: {
          where: {
            status: { in: ["paid", "loading", "shipped", "thailand_received"] },
          },
          include: {
            client: { select: { id: true, name: true, phone: true, companyName: true } },
            prealerts: {
              orderBy: { createdAt: "asc" },
              include: { items: { orderBy: { sortOrder: "asc" } } },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    ok(res, {
      items: plans
        .filter((p) => p.customers.length > 0)
        .map((p) => ({
          planId: p.id,
          planNo: p.planNo,
          warehouse: p.warehouse,
          containerType: p.containerType,
          destinationTh: p.destinationTh,
          totalVolumeM3: p.totalVolumeM3.toNumber(),
          planStatus: p.status,
          customers: p.customers.map((c) => {
            const flatItems = c.prealerts.flatMap((pa) => pa.items);
            const totalItems = flatItems.length;
            const totalVolume = c.totalVolumeM3.toNumber();
            const totalPackages = flatItems.reduce((sum, it) => sum + it.packageCount, 0);
            return {
              id: c.id,
              clientId: c.clientId,
              clientName: c.client.name,
              clientPhone: c.client.phone,
              clientCompany: c.client.companyName,
              status: c.status,
              unitPriceNormal: c.unitPriceNormal.toNumber(),
              unitPriceInspection: c.unitPriceInspection.toNumber(),
              unitPriceSensitive: c.unitPriceSensitive.toNumber(),
              totalVolumeM3: totalVolume,
              totalFee: c.totalFee?.toNumber() ?? null,
              deliveryAddress: c.deliveryAddress,
              warehouseReceiptFileName: c.warehouseReceiptFileName,
              warehouseReceiptBase64: c.warehouseReceiptBase64,
              thailandReceiptFileName: c.thailandReceiptFileName,
              thailandReceiptBase64: c.thailandReceiptBase64,
              totalItems,
              totalPackages,
              createdAt: c.createdAt.toISOString(),
              prealerts: c.prealerts.map((pa) => ({
                id: pa.id,
                trackingNo: pa.trackingNo,
                mark: pa.mark,
                expressNo: pa.expressNo,
                status: pa.status,
                receivedAt: pa.receivedAt?.toISOString() ?? null,
                items: pa.items.map((it: any) => ({
                  id: it.id,
                  productName: it.productName,
                  packageCount: it.packageCount,
                  quantityPerBox: it.quantityPerBox,
                  totalQuantity: it.totalQuantity,
                  lengthCm: it.lengthCm?.toNumber() ?? null,
                  widthCm: it.widthCm?.toNumber() ?? null,
                  heightCm: it.heightCm?.toNumber() ?? null,
                  unitWeightKg: it.unitWeightKg?.toNumber() ?? null,
                  totalWeightKg: it.totalWeightKg?.toNumber() ?? null,
                  volumeM3: it.volumeM3?.toNumber() ?? null,
                  material: it.material,
                  cargoValue: it.cargoValue,
                  cargoType: it.cargoType,
                  productImageFileName: it.productImageFileName,
                  productImageBase64: it.productImageBase64,
                  sortOrder: it.sortOrder,
                })),
              })),
            };
          }),
        })),
    });
  });

  // ==========================================================================
  // 3. 装柜确认
  //    paid → loading
  // ==========================================================================
  app.post("/staff/whr-consolidation/loading-confirm", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      customerId?: string;
      receiptFileName?: string;
      receiptMime?: string;
      receiptBase64?: string;
    };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.customerId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "customerId 为必填");
      return;
    }
    if (!body.receiptBase64?.trim()) {
      fail(res, 400, "BAD_REQUEST", "收货凭证照片为必填，请拍照上传");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: body.customerId, planId: body.planId, companyId: auth.companyId },
    });

    if (!customer) {
      fail(res, 404, "NOT_FOUND", "客户记录不存在");
      return;
    }
    if (customer.status !== "paid") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可装柜，仅已付款状态可操作");
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.whrConsolidationPlanCustomer.update({
        where: { id: body.customerId! },
        data: { status: "loading" },
      });

      await tx.whrConsolidationStatusLog.create({
        data: {
          customerId: body.customerId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "paid",
          toStatus: "loading",
        },
      });

      await syncPlanStatus(body.planId!, tx);

      return true;
    });

    ok(res, { customerId: body.customerId, status: "loading" });
  });

  // ==========================================================================
  // 4. 发运确认
  //    loading → shipped
  // ==========================================================================
  app.post("/staff/whr-consolidation/ship-confirm", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      customerId?: string;
      receiptFileName?: string;
      receiptMime?: string;
      receiptBase64?: string;
    };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.customerId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "customerId 为必填");
      return;
    }
    if (!body.receiptBase64?.trim()) {
      fail(res, 400, "BAD_REQUEST", "收货凭证照片为必填，请拍照上传");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: body.customerId, planId: body.planId, companyId: auth.companyId },
    });

    if (!customer) {
      fail(res, 404, "NOT_FOUND", "客户记录不存在");
      return;
    }
    if (customer.status !== "loading") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可发运，仅装柜中状态可操作");
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.whrConsolidationPlanCustomer.update({
        where: { id: body.customerId! },
        data: { status: "shipped" },
      });

      await tx.whrConsolidationStatusLog.create({
        data: {
          customerId: body.customerId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "loading",
          toStatus: "shipped",
        },
      });

      await syncPlanStatus(body.planId!, tx);

      return true;
    });

    ok(res, { customerId: body.customerId, status: "shipped" });
  });

  // ==========================================================================
  // 5. 泰国签收
  //    shipped → thailand_received，上传签收单
  // ==========================================================================
  app.post("/staff/whr-consolidation/thailand-sign", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      customerId?: string;
      fileName?: string;
      mime?: string;
      base64?: string;
    };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.customerId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "customerId 为必填");
      return;
    }
    if (!body.base64?.trim()) {
      fail(res, 400, "BAD_REQUEST", "泰国签收单为必填");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: body.customerId, planId: body.planId, companyId: auth.companyId },
    });

    if (!customer) {
      fail(res, 404, "NOT_FOUND", "客户记录不存在");
      return;
    }
    if (customer.status !== "shipped") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可签收，仅已发运状态可操作");
      return;
    }

    const now = new Date();
    const proofPath = saveImageToDisk(
      `whr_thailand_sign_${Date.now()}`,
      body.mime || "image/png",
      body.base64!
    );

    await prisma.$transaction(async (tx) => {
      await tx.whrConsolidationPlanCustomer.update({
        where: { id: body.customerId! },
        data: {
          status: "thailand_received",
          thailandReceivedAt: now,
          thailandReceiptFileName: body.fileName?.trim() || proofPath.split("/").pop() || "",
          thailandReceiptMime: body.mime?.trim() || "image/png",
          thailandReceiptBase64: proofPath,
        },
      });

      await tx.whrConsolidationStatusLog.create({
        data: {
          customerId: body.customerId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "shipped",
          toStatus: "thailand_received",
          remark: "泰国签收单已上传",
        },
      });

      await syncPlanStatus(body.planId!, tx);

      return true;
    });

    ok(res, {
      customerId: body.customerId,
      status: "thailand_received",
      thailandReceivedAt: now.toISOString(),
    });
  });
}
