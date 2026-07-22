import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { syncPlanStatus } from "./utils";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 生成拼柜计划编号 WHR + 7位数字（如 WHR0000001）
 * 使用数据库事务锁防止并发冲突
 */
async function generatePlanNo(): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(83010)`;
    const last = await tx.whrConsolidationPlan.findFirst({
      where: { planNo: { startsWith: "WHR" } },
      orderBy: { planNo: "desc" },
      select: { planNo: true },
    });
    const nextNum = last ? parseInt(last.planNo.replace("WHR", ""), 10) + 1 : 1;
    return `WHR${String(nextNum).padStart(7, "0")}`;
  });
}

/**
 * 重新计算客户总费用
 * 按每种货品类型的方数 × 对应单价汇总
 */
async function recalcCustomerTotalFee(customerId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const customer = await tx.whrConsolidationPlanCustomer.findUnique({
      where: { id: customerId },
      select: {
        unitPriceNormal: true,
        unitPriceInspection: true,
        unitPriceSensitive: true,
      },
    });
    if (!customer) return 0;

    // 查该客户下所有已签收预报单的货品
    const items = await tx.whrConsolidationPrealertItem.findMany({
      where: {
        prealert: { customerId, status: "received" },
      },
      select: { volumeM3: true, cargoType: true },
    });

    let totalFee = 0;
    for (const item of items) {
      const vol = item.volumeM3?.toNumber() ?? 0;
      if (item.cargoType === "inspection") {
        totalFee += vol * customer.unitPriceInspection.toNumber();
      } else if (item.cargoType === "sensitive") {
        totalFee += vol * customer.unitPriceSensitive.toNumber();
      } else {
        totalFee += vol * customer.unitPriceNormal.toNumber();
      }
    }

    const rounded = Math.round(totalFee * 100) / 100;
    await tx.whrConsolidationPlanCustomer.update({
      where: { id: customerId },
      data: { totalFee: rounded },
    });

    return rounded;
  });
}

// ============================================================================
// 路由注册
// ============================================================================

export function registerWhrConsolidationRoutes(app: MinimalHttpApp): void {
  // ==========================================================================
  // 1. 创建拼柜计划
  // ==========================================================================
  app.post("/admin/whr-consolidation/plans", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      warehouse?: string;
      containerType?: string;
      destinationTh?: string;
      totalVolumeM3?: number;
      customers?: {
        clientId?: string;
        unitPriceNormal?: number;
        unitPriceInspection?: number;
        unitPriceSensitive?: number;
      }[];
    };

    // 校验必填字段
    if (!body.destinationTh?.trim()) {
      fail(res, 400, "BAD_REQUEST", "目的地为必填");
      return;
    }
    if (!body.customers || !Array.isArray(body.customers) || body.customers.length === 0) {
      fail(res, 400, "BAD_REQUEST", "至少选择一个客户");
      return;
    }
    for (let i = 0; i < body.customers.length; i++) {
      const c = body.customers[i];
      if (!c.clientId?.trim()) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 个客户ID为必填`);
        return;
      }
      if (c.unitPriceNormal == null || c.unitPriceNormal <= 0) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 个客户普货单价必须大于0`);
        return;
      }
      if (c.unitPriceInspection == null || c.unitPriceInspection <= 0) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 个客户商检单价必须大于0`);
        return;
      }
      if (c.unitPriceSensitive == null || c.unitPriceSensitive <= 0) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 个客户敏感货单价必须大于0`);
        return;
      }
    }

    const planNo = await generatePlanNo();

    const plan = await prisma.$transaction(async (tx) => {
      const created = await tx.whrConsolidationPlan.create({
        data: {
          companyId: auth.companyId,
          planNo,
          warehouse: body.warehouse?.trim() || "义乌",
          containerType: body.containerType?.trim() || "40HQ",
          destinationTh: body.destinationTh!.trim(),
          totalVolumeM3: body.totalVolumeM3 ?? 68,
          status: "collecting",
          createdBy: auth.userId,
          creatorName: auth.name,
        },
      });

      const customerData = body.customers!.map((c) => ({
        planId: created.id,
        companyId: auth.companyId,
        clientId: c.clientId!.trim(),
        unitPriceNormal: c.unitPriceNormal!,
        unitPriceInspection: c.unitPriceInspection!,
        unitPriceSensitive: c.unitPriceSensitive!,
        status: "filling",
      }));

      await tx.whrConsolidationPlanCustomer.createMany({ data: customerData });

      return created;
    });

    ok(res, { id: plan.id, planNo: plan.planNo });
  });

  // ==========================================================================
  // 2. 获取拼柜计划列表
  // ==========================================================================
  app.get("/admin/whr-consolidation/plans", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const plans = await prisma.whrConsolidationPlan.findMany({
      where: { companyId: auth.companyId },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { customers: true } },
      },
    });

    ok(res, {
      items: plans.map((p) => ({
        id: p.id,
        planNo: p.planNo,
        warehouse: p.warehouse,
        containerType: p.containerType,
        destinationTh: p.destinationTh,
        totalVolumeM3: p.totalVolumeM3.toNumber(),
        status: p.status,
        createdBy: p.createdBy,
        creatorName: p.creatorName,
        customerCount: p._count.customers,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    });
  });

  // ==========================================================================
  // 3. 获取计划详情（含客户、预报单、货品、状态日志）
  // ==========================================================================
  app.get("/admin/whr-consolidation/plans/detail", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const planId = (req.query as any)?.planId as string | undefined;
    if (!planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }

    const plan = await prisma.whrConsolidationPlan.findFirst({
      where: { id: planId, companyId: auth.companyId },
      include: {
        customers: {
          orderBy: { createdAt: "asc" },
          include: {
            client: { select: { id: true, name: true, phone: true, companyName: true } },
            prealerts: {
              orderBy: { createdAt: "asc" },
              include: {
                items: { orderBy: { sortOrder: "asc" } },
              },
            },
            statusLogs: { orderBy: { createdAt: "desc" } },
          },
        },
      },
    });

    if (!plan) {
      fail(res, 404, "NOT_FOUND", "计划不存在");
      return;
    }

    ok(res, {
      id: plan.id,
      planNo: plan.planNo,
      warehouse: plan.warehouse,
      containerType: plan.containerType,
      destinationTh: plan.destinationTh,
      totalVolumeM3: plan.totalVolumeM3.toNumber(),
      status: plan.status,
      createdBy: plan.createdBy,
      creatorName: plan.creatorName,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
      customers: plan.customers.map((c) => ({
        id: c.id,
        clientId: c.clientId,
        clientName: c.client.name,
        clientPhone: c.client.phone,
        clientCompany: c.client.companyName,
        unitPriceNormal: c.unitPriceNormal.toNumber(),
        unitPriceInspection: c.unitPriceInspection.toNumber(),
        unitPriceSensitive: c.unitPriceSensitive.toNumber(),
        totalVolumeM3: c.totalVolumeM3.toNumber(),
        totalFee: c.totalFee?.toNumber() ?? null,
        deliveryAddress: c.deliveryAddress,
        status: c.status,
        signedAt: c.signedAt?.toISOString() ?? null,
        warehouseReceiptFileName: c.warehouseReceiptFileName,
        warehouseReceiptBase64: c.warehouseReceiptBase64,
        paymentProofs: (c as any).paymentProofs ?? [],
        paymentProofUploadedAt: c.paymentProofUploadedAt?.toISOString() ?? null,
        paymentReviewedAt: c.paymentReviewedAt?.toISOString() ?? null,
        paymentReviewedBy: c.paymentReviewedBy,
        paymentRejectReason: c.paymentRejectReason,
        thailandReceiptFileName: c.thailandReceiptFileName,
        thailandReceiptBase64: c.thailandReceiptBase64,
        thailandReceivedAt: c.thailandReceivedAt?.toISOString() ?? null,
        cancelReason: c.cancelReason,
        cancelledAt: c.cancelledAt?.toISOString() ?? null,
        totalPrealerts: c.totalPrealerts,
        totalPackages: c.totalPackages,
        totalItems: c.prealerts.reduce((sum, pa) => sum + pa.items.length, 0),
        prealerts: c.prealerts.map((pa) => ({
          id: pa.id,
          trackingNo: pa.trackingNo,
          expressNo: pa.expressNo,
          mark: pa.mark,
          status: pa.status,
          receivedAt: pa.receivedAt?.toISOString() ?? null,
          createdAt: pa.createdAt.toISOString(),
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
        statusLogs: c.statusLogs.map((sl) => ({
          id: sl.id,
          operatorName: sl.operatorName,
          operatorRole: sl.operatorRole,
          fromStatus: sl.fromStatus,
          toStatus: sl.toStatus,
          remark: sl.remark,
          createdAt: sl.createdAt.toISOString(),
        })),
      })),
    });
  });

  // ==========================================================================
  // 4. 修改客户单价
  // ==========================================================================
  app.post("/admin/whr-consolidation/customers/price", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      customerId?: string;
      unitPriceNormal?: number;
      unitPriceInspection?: number;
      unitPriceSensitive?: number;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.customerId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "customerId 为必填");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: body.customerId, planId: body.planId, companyId: auth.companyId },
    });

    if (!customer) {
      fail(res, 404, "NOT_FOUND", "客户记录不存在");
      return;
    }

    // 构建更新数据（只改传了的单价）
    const updateData: any = {};
    if (body.unitPriceNormal != null && body.unitPriceNormal > 0) {
      updateData.unitPriceNormal = body.unitPriceNormal;
    }
    if (body.unitPriceInspection != null && body.unitPriceInspection > 0) {
      updateData.unitPriceInspection = body.unitPriceInspection;
    }
    if (body.unitPriceSensitive != null && body.unitPriceSensitive > 0) {
      updateData.unitPriceSensitive = body.unitPriceSensitive;
    }

    if (Object.keys(updateData).length === 0) {
      fail(res, 400, "BAD_REQUEST", "至少需要修改一种单价");
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.whrConsolidationPlanCustomer.update({
        where: { id: body.customerId! },
        data: updateData,
      });

      return true;
    });

    // 重新计算总费用
    const newTotalFee = await recalcCustomerTotalFee(body.customerId);

    ok(res, {
      customerId: body.customerId,
      totalFee: newTotalFee,
    });
  });

  // ==========================================================================
  // 5. 审核客户付款
  // ==========================================================================
  app.post("/admin/whr-consolidation/customers/review", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      customerId?: string;
      action?: string; // "approve" | "reject"
      rejectReason?: string;
      unitPriceNormal?: number;
      unitPriceInspection?: number;
      unitPriceSensitive?: number;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.customerId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "customerId 为必填");
      return;
    }
    if (!body.action || !["approve", "reject"].includes(body.action)) {
      fail(res, 400, "BAD_REQUEST", "action 必须是 approve 或 reject");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: body.customerId, planId: body.planId, companyId: auth.companyId },
    });

    if (!customer) {
      fail(res, 404, "NOT_FOUND", "客户记录不存在");
      return;
    }
    if (customer.status !== "received_pending_payment") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可审核，仅待付款状态可操作");
      return;
    }

    if (body.action === "approve") {
      // 审核通过
      await prisma.$transaction(async (tx) => {
        await tx.whrConsolidationPlanCustomer.update({
          where: { id: body.customerId! },
          data: {
            status: "paid",
            paymentReviewedAt: new Date(),
            paymentReviewedBy: auth.userId,
            paymentRejectReason: null,
          },
        });

        await tx.whrConsolidationStatusLog.create({
          data: {
            customerId: body.customerId!,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: auth.role,
            operatorName: auth.name,
            fromStatus: "received_pending_payment",
            toStatus: "paid",
            remark: "审核通过",
          },
        });

        await syncPlanStatus(body.planId!, tx);

        return true;
      });

      ok(res, { customerId: body.customerId, status: "paid" });
    } else {
      // 审核拒绝
      if (!body.rejectReason?.trim()) {
        fail(res, 400, "BAD_REQUEST", "拒绝原因为必填");
        return;
      }

      await prisma.$transaction(async (tx) => {
        const rejectData: any = {
          status: "received_pending_payment",
          paymentRejectReason: body.rejectReason!.trim(),
          // 清空付款凭证，客户重新上传
          paymentProofs: [] as any,
          paymentProofUploadedAt: null,
          paymentReviewedAt: new Date(),
          paymentReviewedBy: auth.userId,
        };

        // 如果管理员同时修改了单价
        if (body.unitPriceNormal != null && body.unitPriceNormal > 0) {
          rejectData.unitPriceNormal = body.unitPriceNormal;
        }
        if (body.unitPriceInspection != null && body.unitPriceInspection > 0) {
          rejectData.unitPriceInspection = body.unitPriceInspection;
        }
        if (body.unitPriceSensitive != null && body.unitPriceSensitive > 0) {
          rejectData.unitPriceSensitive = body.unitPriceSensitive;
        }

        await tx.whrConsolidationPlanCustomer.update({
          where: { id: body.customerId! },
          data: rejectData,
        });

        const remarkParts: string[] = ["审核不通过"];
        if (body.rejectReason?.trim()) remarkParts.push(body.rejectReason.trim());

        await tx.whrConsolidationStatusLog.create({
          data: {
            customerId: body.customerId!,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: auth.role,
            operatorName: auth.name,
            fromStatus: "received_pending_payment",
            toStatus: "received_pending_payment",
            remark: remarkParts.join("；"),
          },
        });

        return true;
      });

      // 如果改了单价则重算费用
      if (
        body.unitPriceNormal != null ||
        body.unitPriceInspection != null ||
        body.unitPriceSensitive != null
      ) {
        await recalcCustomerTotalFee(body.customerId);
      }

      ok(res, { customerId: body.customerId, status: "received_pending_payment" });
    }
  });

  // ==========================================================================
  // 6. 取消客户资格
  // ==========================================================================
  app.post("/admin/whr-consolidation/customers/cancel", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      customerId?: string;
      cancelReason?: string;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.customerId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "customerId 为必填");
      return;
    }
    if (!body.cancelReason?.trim()) {
      fail(res, 400, "BAD_REQUEST", "取消原因为必填");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: body.customerId, planId: body.planId, companyId: auth.companyId },
    });

    if (!customer) {
      fail(res, 404, "NOT_FOUND", "客户记录不存在");
      return;
    }

    const cancellable = ["filling", "received_pending_payment"];
    if (!cancellable.includes(customer.status)) {
      fail(res, 400, "BAD_REQUEST", `当前状态 ${customer.status} 不可取消，仅填货中和待付款状态可操作`);
      return;
    }

    const previousStatus = customer.status;

    await prisma.$transaction(async (tx) => {
      await tx.whrConsolidationPlanCustomer.update({
        where: { id: body.customerId! },
        data: {
          status: "cancelled",
          cancelReason: body.cancelReason!.trim(),
          cancelledAt: new Date(),
        },
      });

      await tx.whrConsolidationStatusLog.create({
        data: {
          customerId: body.customerId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: "admin",
          operatorName: auth.name,
          fromStatus: previousStatus,
          toStatus: "cancelled",
          remark: body.cancelReason!.trim(),
        },
      });

      await syncPlanStatus(body.planId!, tx);

      return true;
    });

    ok(res, { customerId: body.customerId, status: "cancelled" });
  });
}
