import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { saveImageToDisk } from "../orders/image-storage";

// ============================================================================
// 客户端路由注册
// ============================================================================

export function registerWhrConsolidationClientRoutes(app: MinimalHttpApp): void {
  // ==========================================================================
  // 1. 查看我被选中的拼柜计划
  // ==========================================================================
  app.get("/client/whr-consolidation/plans", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const myCustomers = await prisma.whrConsolidationPlanCustomer.findMany({
      where: { clientId: auth.userId, companyId: auth.companyId },
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    });

    if (myCustomers.length === 0) {
      ok(res, { items: [] });
      return;
    }

    // 计算每个计划的总占用方数（所有参与客户的方数之和）
    const planIds = myCustomers.map((c) => c.planId);
    const planVolumeSums = await prisma.whrConsolidationPlanCustomer.groupBy({
      by: ["planId"],
      where: { planId: { in: planIds } },
      _sum: { totalVolumeM3: true },
    });
    const volumeMap = new Map<string, number>();
    for (const row of planVolumeSums) {
      volumeMap.set(row.planId, row._sum.totalVolumeM3?.toNumber() ?? 0);
    }

    ok(res, {
      items: myCustomers.map((c) => ({
        planId: c.planId,
        planNo: c.plan.planNo,
        warehouse: c.plan.warehouse,
        containerType: c.plan.containerType,
        destinationTh: c.plan.destinationTh,
        totalVolumeM3: c.plan.totalVolumeM3.toNumber(),
        usedVolumeM3: volumeMap.get(c.planId) ?? 0,
        myStatus: c.status,
        myTotalVolumeM3: c.totalVolumeM3.toNumber(),
        myTotalFee: c.totalFee?.toNumber() ?? null,
        myUnitPriceNormal: c.unitPriceNormal.toNumber(),
        myUnitPriceInspection: c.unitPriceInspection.toNumber(),
        myUnitPriceSensitive: c.unitPriceSensitive.toNumber(),
        mySignedAt: c.signedAt?.toISOString() ?? null,
        myPaymentProofs: (c as any).paymentProofs ?? [],
        myPaymentProofUploadedAt: c.paymentProofUploadedAt?.toISOString() ?? null,
        myPaymentReviewedAt: c.paymentReviewedAt?.toISOString() ?? null,
        myPaymentRejectReason: c.paymentRejectReason,
        myThailandReceiptFileName: c.thailandReceiptFileName,
        myThailandReceiptBase64: c.thailandReceiptBase64,
        myThailandReceivedAt: c.thailandReceivedAt?.toISOString() ?? null,
        myCancelReason: c.cancelReason,
        createdAt: c.plan.createdAt.toISOString(),
      })),
    });
  });

  // ==========================================================================
  // 2. 创建预报单
  // ==========================================================================
  app.post("/client/whr-consolidation/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      expressNo?: string;
      mark?: string;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.mark?.trim()) {
      fail(res, 400, "BAD_REQUEST", "唛头为必填");
      return;
    }

    // 找到该客户在这个计划下的记录
    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId: body.planId, clientId: auth.userId, companyId: auth.companyId },
    });

    if (!customer) {
      fail(res, 403, "FORBIDDEN", "您不在该拼柜计划中");
      return;
    }
    if (customer.status !== "filling" && customer.status !== "received_pending_payment") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可创建预报单，仅填货中状态可操作");
      return;
    }

    const prealert = await prisma.$transaction(async (tx) => {
      // 生成预报单号 WHRP + 4位数字
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(83011)`;
      const last = await tx.whrConsolidationPrealert.findFirst({
        where: { trackingNo: { startsWith: "WHRP" } },
        orderBy: { trackingNo: "desc" },
        select: { trackingNo: true },
      });
      const nextNum = last ? parseInt(last.trackingNo.replace("WHRP", ""), 10) + 1 : 1;
      const trackingNo = `WHRP${String(nextNum).padStart(4, "0")}`;

      const created = await tx.whrConsolidationPrealert.create({
        data: {
          customerId: customer.id,
          companyId: auth.companyId,
          trackingNo,
          expressNo: body.expressNo?.trim() || null,
          mark: body.mark!.trim(),
          status: "pending",
        },
      });

      // 更新预报单计数
      const count = await tx.whrConsolidationPrealert.count({
        where: { customerId: customer.id },
      });
      await tx.whrConsolidationPlanCustomer.update({
        where: { id: customer.id },
        data: { totalPrealerts: count },
      });

      return created;
    });

    ok(res, {
      id: prealert.id,
      trackingNo: prealert.trackingNo,
      mark: prealert.mark,
      status: prealert.status,
    });
  });

  // ==========================================================================
  // 3. 保存预报单货品（覆盖式更新）
  //    原子操作：删旧 + 插新 + 更新客户方数/件数汇总
  // ==========================================================================
  app.post("/client/whr-consolidation/prealerts/items", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      prealertId?: string;
      items?: {
        productName?: string;
        packageCount?: number;
        quantityPerBox?: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        unitWeightKg?: number;
        material?: string;
        cargoValue?: string;
        cargoType?: string; // normal | inspection | sensitive
        imageFileName?: string;
        imageMime?: string;
        imageBase64?: string;
      }[];
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    if (!body.items || !Array.isArray(body.items)) {
      fail(res, 400, "BAD_REQUEST", "items 数组为必填");
      return;
    }

    // 校验客户身份
    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId: body.planId, clientId: auth.userId, companyId: auth.companyId },
    });

    if (!customer) {
      fail(res, 403, "FORBIDDEN", "您不在该拼柜计划中");
      return;
    }
    if (customer.status !== "filling" && customer.status !== "received_pending_payment") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可操作");
      return;
    }

    // 校验预报单属于该客户
    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: { id: body.prealertId, customerId: customer.id },
    });

    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }

    // 校验必填字段
    for (let i = 0; i < body.items.length; i++) {
      const it = body.items[i];
      if (!it.productName?.trim()) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 行品名为必填`);
        return;
      }
      if (!it.packageCount || it.packageCount <= 0) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 行件数必须大于0`);
        return;
      }
    }

    // 事务：删旧 → 插新 → 更新汇总
    const result = await prisma.$transaction(async (tx) => {
      // 删除旧货品
      await tx.whrConsolidationPrealertItem.deleteMany({
        where: { prealertId: body.prealertId! },
      });

      // 插入新货品
      const itemData = body.items!.map((it, idx) => {
        const pkg = it.packageCount!;
        const qpb = it.quantityPerBox ?? 1;
        const totalQty = pkg * qpb;
        const uWeight = it.unitWeightKg ?? null;
        const tWeight = uWeight != null ? uWeight * totalQty : null;
        const len = it.lengthCm ?? null;
        const wid = it.widthCm ?? null;
        const hgt = it.heightCm ?? null;
        const vol =
          len != null && wid != null && hgt != null && len > 0 && wid > 0 && hgt > 0
            ? Math.round((len * wid * hgt) / 1000000 * pkg * 1000000) / 1000000
            : null;

        // 产品图片存盘
        let imgPath: string | null = null;
        if (it.imageBase64?.trim()) {
          imgPath = saveImageToDisk(
            `whr_item_${Date.now()}_${idx}`,
            it.imageMime || "image/jpeg",
            it.imageBase64.trim()
          );
        }

        return {
          prealertId: body.prealertId!,
          companyId: auth.companyId,
          productName: it.productName!.trim(),
          packageCount: pkg,
          quantityPerBox: qpb,
          totalQuantity: totalQty,
          lengthCm: len,
          widthCm: wid,
          heightCm: hgt,
          unitWeightKg: uWeight,
          totalWeightKg: tWeight,
          volumeM3: vol,
          material: it.material?.trim() || "",
          cargoValue: it.cargoValue?.trim() || "",
          cargoType: it.cargoType || "normal",
          productImageFileName: imgPath ? (imgPath.split("/").pop() || "") : null,
          productImageMime: it.imageMime || null,
          productImageBase64: imgPath,
          sortOrder: idx,
        };
      });

      await tx.whrConsolidationPrealertItem.createMany({ data: itemData });

      // 重新计算该客户的总方数和总件数（所有预报单的所有货品）
      const allItems = await tx.whrConsolidationPrealertItem.findMany({
        where: {
          prealert: { customerId: customer.id },
        },
        select: { volumeM3: true, packageCount: true },
      });

      const totalVol = allItems.reduce(
        (sum, it) => sum + (it.volumeM3?.toNumber() ?? 0),
        0
      );
      const totalPkg = allItems.reduce(
        (sum, it) => sum + it.packageCount,
        0
      );

      // 校验不超计划总方数
      const plan = await tx.whrConsolidationPlan.findUnique({
        where: { id: body.planId! },
        select: { totalVolumeM3: true },
      });
      if (plan && totalVol > plan.totalVolumeM3.toNumber()) {
        throw new Error(
          `货品总方数 ${totalVol.toFixed(3)} 超过计划上限 ${plan.totalVolumeM3.toNumber()} 方`
        );
      }

      const updated = await tx.whrConsolidationPlanCustomer.update({
        where: { id: customer.id },
        data: {
          totalVolumeM3: Math.round(totalVol * 1000) / 1000,
          totalPackages: totalPkg,
        },
      });

      return { updated, count: itemData.length };
    });

    ok(res, {
      prealertId: body.prealertId,
      totalVolumeM3: result.updated.totalVolumeM3.toNumber(),
      totalPackages: result.updated.totalPackages,
      itemCount: result.count,
    });
  });

  // ==========================================================================
  // 4. 上传付款凭证
  // ==========================================================================
  app.post("/client/whr-consolidation/pay", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      fileName?: string;
      mime?: string;
      base64?: string;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.base64?.trim()) {
      fail(res, 400, "BAD_REQUEST", "付款凭证为必填");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId: body.planId, clientId: auth.userId, companyId: auth.companyId },
    });

    if (!customer) {
      fail(res, 403, "FORBIDDEN", "您不在该拼柜计划中");
      return;
    }
    if (customer.status !== "received_pending_payment") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可付款，仅待付款状态可操作");
      return;
    }

    const proofs: any[] = (body as any).proofs || [];
    if (!proofs.length) {
      fail(res, 400, "BAD_REQUEST", "请至少上传一张付款凭证");
      return;
    }

    const now = new Date();
    const savedProofs = proofs.map((p: any) => {
      const imgPath = saveImageToDisk(
        `whr_payment_${customer.id}_${Date.now()}`,
        p.mime || "image/png",
        p.base64
      );
      return {
        fileName: p.fileName || imgPath.split("/").pop() || "payment.png",
        mime: p.mime || "image/png",
        base64Path: imgPath,
        uploadedAt: now.toISOString(),
      };
    });

    const updated = await prisma.whrConsolidationPlanCustomer.update({
      where: { id: customer.id },
      data: {
        paymentProofs: savedProofs as any,
        paymentProofUploadedAt: now,
        // 清空旧的审核信息
        paymentReviewedAt: null,
        paymentReviewedBy: null,
        paymentRejectReason: null,
      } as any,
    });

    ok(res, {
      customerId: customer.id,
      status: updated.status,
      paymentProofUploadedAt: now.toISOString(),
      proofCount: savedProofs.length,
    });
  });


  // ==========================================================================
  // 4b. 保存收货地址
  // ==========================================================================
  app.post("/client/whr-consolidation/address", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; deliveryAddress?: string };
    if (!body.planId?.trim()) { fail(res, 400, "BAD_REQUEST", "planId 为必填"); return; }
    if (!body.deliveryAddress?.trim()) { fail(res, 400, "BAD_REQUEST", "收货地址为必填"); return; }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId: body.planId, clientId: auth.userId, companyId: auth.companyId },
    });
    if (!customer) { fail(res, 403, "FORBIDDEN", "您不在该拼柜计划中"); return; }
    if (customer.status !== "filling" && customer.status !== "received_pending_payment") { fail(res, 400, "BAD_REQUEST", "当前状态不可修改地址"); return; }

    await prisma.whrConsolidationPlanCustomer.update({
      where: { id: customer.id },
      data: { deliveryAddress: body.deliveryAddress.trim() },
    });

    ok(res, { customerId: customer.id, deliveryAddress: body.deliveryAddress.trim() });
  });

  // ==========================================================================
  // 5. 查看我的详情（预报单 + 货品 + 状态日志）
  // ==========================================================================
  app.get("/client/whr-consolidation/my-detail", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const planId = (req.query as any)?.planId as string | undefined;
    if (!planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId, clientId: auth.userId, companyId: auth.companyId },
      include: {
        prealerts: {
          orderBy: { createdAt: "asc" },
          include: {
            items: { orderBy: { sortOrder: "asc" } },
          },
        },
        statusLogs: { orderBy: { createdAt: "desc" }, take: 50 },
      },
    });

    if (!customer) {
      fail(res, 403, "FORBIDDEN", "您不在该拼柜计划中");
      return;
    }

    ok(res, {
      customerId: customer.id,
      status: customer.status,
      unitPriceNormal: customer.unitPriceNormal.toNumber(),
      unitPriceInspection: customer.unitPriceInspection.toNumber(),
      unitPriceSensitive: customer.unitPriceSensitive.toNumber(),
      totalVolumeM3: customer.totalVolumeM3.toNumber(),
      totalFee: customer.totalFee?.toNumber() ?? null,
      signedAt: customer.signedAt?.toISOString() ?? null,
      warehouseReceiptFileName: customer.warehouseReceiptFileName,
      warehouseReceiptBase64: customer.warehouseReceiptBase64,
      deliveryAddress: customer.deliveryAddress,
      paymentProofBase64: customer.paymentProofBase64,
      paymentProofMime: customer.paymentProofMime,
      paymentProofUploadedAt: customer.paymentProofUploadedAt?.toISOString() ?? null,
      paymentReviewedAt: customer.paymentReviewedAt?.toISOString() ?? null,
      paymentRejectReason: customer.paymentRejectReason,
      thailandReceiptFileName: customer.thailandReceiptFileName,
      thailandReceiptBase64: customer.thailandReceiptBase64,
      thailandReceivedAt: customer.thailandReceivedAt?.toISOString() ?? null,
      cancelReason: customer.cancelReason,
      cancelledAt: customer.cancelledAt?.toISOString() ?? null,
      totalPrealerts: customer.totalPrealerts,
      totalPackages: customer.totalPackages,
      prealerts: customer.prealerts.map((pa) => ({
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
      statusLogs: customer.statusLogs.map((sl) => ({
        id: sl.id,
        operatorName: sl.operatorName,
        operatorRole: sl.operatorRole,
        fromStatus: sl.fromStatus,
        toStatus: sl.toStatus,
        remark: sl.remark,
        createdAt: sl.createdAt.toISOString(),
      })),
    });
  });
}
