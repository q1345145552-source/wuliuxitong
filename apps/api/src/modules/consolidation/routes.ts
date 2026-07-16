import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { saveImageToDisk, readImageAsBase64 } from "../orders/image-storage";
import * as XLSX from "xlsx";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 生成任务编号 JH + 7位数字（如 JH0000001）
 * 使用数据库事务锁防止并发冲突
 */
async function generateTaskNo(): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(83001)`;
    const last = await tx.consolidationTask.findFirst({
      where: { taskNo: { startsWith: "JH" } },
      orderBy: { taskNo: "desc" },
      select: { taskNo: true },
    });
    const nextNum = last ? parseInt(last.taskNo.replace("JH", ""), 10) + 1 : 1;
    return `JH${String(nextNum).padStart(7, "0")}`;
  });
}

/**
 * 生成预报单运单号 JH-YW + 7位数字（如 JH-YW0000001）
 */
async function generateTrackingNo(): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(83002)`;
    const last = await tx.consolidationPrealert.findFirst({
      where: { trackingNo: { startsWith: "JH-YW" } },
      orderBy: { trackingNo: "desc" },
      select: { trackingNo: true },
    });
    const nextNum = last ? parseInt(last.trackingNo.replace("JH-YW", ""), 10) + 1 : 1;
    return `JH-YW${String(nextNum).padStart(7, "0")}`;
  });
}

/**
 * 重新计算任务汇总数据（总件数、总体积、预报单数量）
 * 只统计已签收（received）的预报单
 */
async function recalcTaskTotals(taskId: string): Promise<void> {
  const prealerts = await prisma.consolidationPrealert.findMany({
    where: { taskId, status: "received" },
    include: {
      products: { select: { packageCount: true, volume: true } },
    },
  });

  let totalPackages = 0;
  let totalVolumeM3 = 0;

  for (const pa of prealerts) {
    for (const p of pa.products) {
      totalPackages += p.packageCount;
      totalVolumeM3 += Number(p.volume ?? 0);
    }
  }

  await prisma.consolidationTask.update({
    where: { id: taskId },
    data: {
      totalPackages,
      totalVolumeM3: totalVolumeM3,
      totalPrealerts: prealerts.length,
    },
  });
}

/**
 * 计算任务体积使用百分比，返回 0-100 的数字
 */
function calcVolumePercent(task: { totalVolumeM3: any; maxVolumeM3: any }): number {
  const total = Number(task.totalVolumeM3 ?? 0);
  const max = Number(task.maxVolumeM3 ?? 68);
  if (max <= 0) return 0;
  return parseFloat(((total / max) * 100).toFixed(1));
}

// ============================================================================
// 格式化辅助
// ============================================================================

function formatTask(task: any) {
  return {
    ...task,
    maxVolumeM3: Number(task.maxVolumeM3 ?? 0),
    totalVolumeM3: Number(task.totalVolumeM3 ?? 0),
    bookingFee: task.bookingFee ? Number(task.bookingFee) : null,
    customsFee: task.customsFee ? Number(task.customsFee) : null,
    loadingFee: task.loadingFee ? Number(task.loadingFee) : null,
    totalFee: task.totalFee ? Number(task.totalFee) : null,
    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
    updatedAt: task.updatedAt instanceof Date ? task.updatedAt.toISOString() : task.updatedAt,
  };
}

function formatPrealert(pa: any) {
  return {
    ...pa,
    signedAt: pa.signedAt instanceof Date ? pa.signedAt.toISOString() : pa.signedAt ?? null,
    createdAt: pa.createdAt instanceof Date ? pa.createdAt.toISOString() : pa.createdAt,
    updatedAt: pa.updatedAt instanceof Date ? pa.updatedAt.toISOString() : pa.updatedAt,
  };
}

function formatProduct(p: any) {
  return {
    ...p,
    unitWeight: p.unitWeight ? Number(p.unitWeight) : null,
    totalWeight: p.totalWeight ? Number(p.totalWeight) : null,
    length: p.length ? Number(p.length) : null,
    width: p.width ? Number(p.width) : null,
    height: p.height ? Number(p.height) : null,
    volume: p.volume ? Number(p.volume) : null,
    createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
  };
}

function formatStatusLog(log: any) {
  return {
    ...log,
    createdAt: log.createdAt instanceof Date ? log.createdAt.toISOString() : log.createdAt,
  };
}

// ============================================================================
// 路由注册
// ============================================================================

export function registerConsolidationRoutes(app: MinimalHttpApp): void {
  // --------------------------------------------------------------------------
  // 客户端接口
  // --------------------------------------------------------------------------

  // 1) 创建集货任务
  app.post("/client/consolidation/tasks", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { destinationTh?: string };
    if (!body.destinationTh?.trim()) {
      fail(res, 400, "BAD_REQUEST", "目的地地址为必填");
      return;
    }

    const taskNo = await generateTaskNo();
    const task = await prisma.consolidationTask.create({
      data: {
        taskNo,
        companyId: auth.companyId,
        clientId: auth.userId,
        destinationTh: body.destinationTh.trim(),
        status: "collecting",
        maxVolumeM3: 68,
        currency: "CNY",
        paymentStatus: "unpaid",
      },
    });

    ok(res, formatTask(task));
  });

  // 2) 查询任务列表
  app.get("/client/consolidation/tasks", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const statusFilter = (req.query as any)?.status as string | undefined;
    const where: any = { companyId: auth.companyId, clientId: auth.userId };

    if (statusFilter === "active") {
      where.status = { notIn: ["completed", "cancelled"] };
    }

    const tasks = await prisma.consolidationTask.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        prealerts: { select: { id: true, status: true } },
      },
    });

    const result = tasks.map((t) => {
      const volumePercent = calcVolumePercent(t);
      return {
        ...formatTask(t),
        volumePercent,
        isNearFull: volumePercent >= 85,
        prealertCount: t.prealerts.length,
      };
    });

    ok(res, result);
  });

  // 3) 任务详情
  app.get("/client/consolidation/tasks/detail", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const taskId = (req.query as any)?.taskId as string | undefined;
    if (!taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({
      where: { id: taskId },
      include: {
        prealerts: {
          orderBy: { createdAt: "asc" },
          include: {
            products: { orderBy: { sortOrder: "asc" } },
          },
        },
        statusLogs: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!task || task.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权访问该任务");
      return;
    }

    ok(res, {
      ...formatTask(task),
      volumePercent: calcVolumePercent(task),
      isNearFull: calcVolumePercent(task) >= 85,
      prealerts: task.prealerts.map((pa) => ({
        ...formatPrealert(pa),
        products: pa.products.map(formatProduct),
      })),
      statusLogs: task.statusLogs.map(formatStatusLog),
    });
  });

  // 4) 更新任务目的地
  app.post("/client/consolidation/tasks/update", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string; destinationTh?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }
    if (!body.destinationTh?.trim()) {
      fail(res, 400, "BAD_REQUEST", "目的地地址为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({ where: { id: body.taskId } });
    if (!task || task.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权操作该任务");
      return;
    }
    if (task.status !== "collecting") {
      fail(res, 400, "BAD_REQUEST", "只有收集中状态的任务才能修改");
      return;
    }

    const updated = await prisma.consolidationTask.update({
      where: { id: body.taskId },
      data: { destinationTh: body.destinationTh.trim() },
    });

    ok(res, formatTask(updated));
  });

  // 5) 创建预报单
  app.post("/client/consolidation/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      taskId?: string;
      mark?: string;
      expressNo?: string;
      products?: Array<{
        productName?: string;
        packageCount?: number;
        quantityPerBox?: number;
        unitWeightKg?: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        material?: string;
        cargoValue?: string;
        productImage?: { fileName?: string; mime?: string; base64?: string };
      }>;
    };

    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }
    if (!body.mark?.trim()) {
      fail(res, 400, "BAD_REQUEST", "唛头为必填");
      return;
    }
    if (!body.products || body.products.length === 0) {
      fail(res, 400, "BAD_REQUEST", "至少需要一个产品行");
      return;
    }

    // 校验任务
    const task = await prisma.consolidationTask.findUnique({ where: { id: body.taskId } });
    if (!task || task.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权操作该任务");
      return;
    }
    if (task.status !== "collecting") {
      fail(res, 400, "BAD_REQUEST", "只有收集中状态的任务才能添加预报单");
      return;
    }

    // 校验产品行必填字段
    for (let i = 0; i < body.products.length; i++) {
      const p = body.products[i];
      if (!p.productName?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的产品名为必填`); return; }
      if (!p.packageCount || p.packageCount < 1) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的件数必须大于0`); return; }
      if (!p.quantityPerBox || p.quantityPerBox < 1) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的装箱数量必须大于0`); return; }
      if (p.unitWeightKg === undefined || p.unitWeightKg === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的单件重量为必填`); return; }
      if (p.lengthCm === undefined || p.lengthCm === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的长为必填`); return; }
      if (p.widthCm === undefined || p.widthCm === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的宽为必填`); return; }
      if (p.heightCm === undefined || p.heightCm === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的高为必填`); return; }
      if (!p.material?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的材质为必填`); return; }
      if (!p.cargoValue?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的货值为必填`); return; }
    }

    const trackingNo = await generateTrackingNo();

    const productData = body.products.map((p, idx) => {
      const totalQuantity = p.packageCount! * p.quantityPerBox!;
      const totalWeightKg = parseFloat((p.unitWeightKg! * totalQuantity).toFixed(2));
      const volumeM3 = parseFloat(
        ((p.lengthCm! * p.widthCm! * p.heightCm!) / 1_000_000 * p.packageCount!).toFixed(6),
      );

      return {
        productName: p.productName!.trim(),
        packageCount: p.packageCount!,
        quantityPerBox: p.quantityPerBox!,
        totalQuantity,
        unitWeight: p.unitWeightKg!,
        totalWeight: totalWeightKg,
        length: p.lengthCm!,
        width: p.widthCm!,
        height: p.heightCm!,
        volume: volumeM3,
        material: p.material!.trim(),
        cargoValue: p.cargoValue!.trim(),
        sortOrder: idx,
      };
    });

    // 处理产品图片
    const imageDataList: Array<{
      idx: number;
      fileName: string;
      mime: string;
      base64: string | null;
    }> = [];
    for (let i = 0; i < body.products.length; i++) {
      const img = body.products[i].productImage;
      if (img?.base64 && img.mime) {
        const savedPath = saveImageToDisk(
          `consolidation_${Date.now()}`,
          img.mime,
          img.base64,
        );
        imageDataList.push({
          idx: i,
          fileName: img.fileName || savedPath.split("/").pop() || "",
          mime: img.mime,
          base64: savedPath,
        });
      }
    }

    const prealert = await prisma.consolidationPrealert.create({
      data: {
        taskId: body.taskId,
        companyId: auth.companyId,
        clientId: auth.userId,
        trackingNo,
        expressNo: body.expressNo?.trim() || null,
        mark: body.mark.trim(),
        status: "pending",
        products: {
          create: productData.map((pd, idx) => {
            const img = imageDataList.find((im) => im.idx === idx);
            return {
              ...pd,
              productImageFileName: img?.fileName || null,
              productImageMime: img?.mime || null,
              productImageBase64: img?.base64 || null,
            };
          }),
        },
      },
    });

    await recalcTaskTotals(body.taskId);

    ok(res, formatPrealert(prealert));
  });

  // 6) 更新预报单
  app.post("/client/consolidation/prealerts/update", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      prealertId?: string;
      mark?: string;
      expressNo?: string;
      products?: Array<{
        productName?: string;
        packageCount?: number;
        quantityPerBox?: number;
        unitWeightKg?: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        material?: string;
        cargoValue?: string;
        productImage?: { fileName?: string; mime?: string; base64?: string };
      }>;
    };

    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const pa = await prisma.consolidationPrealert.findUnique({
      where: { id: body.prealertId },
      include: { task: true },
    });
    if (!pa || pa.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权操作该预报单");
      return;
    }
    if (pa.status !== "pending") {
      fail(res, 400, "BAD_REQUEST", "已签收的预报单不能修改");
      return;
    }
    // 校验产品
    if (body.products && body.products.length > 0) {
      for (let i = 0; i < body.products.length; i++) {
        const p = body.products[i];
        if (!p.productName?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的产品名为必填`); return; }
        if (!p.packageCount || p.packageCount < 1) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的件数必须大于0`); return; }
        if (!p.quantityPerBox || p.quantityPerBox < 1) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的装箱数量必须大于0`); return; }
        if (p.unitWeightKg === undefined || p.unitWeightKg === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的单件重量为必填`); return; }
        if (p.lengthCm === undefined || p.lengthCm === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的长为必填`); return; }
        if (p.widthCm === undefined || p.widthCm === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的宽为必填`); return; }
        if (p.heightCm === undefined || p.heightCm === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的高为必填`); return; }
        if (!p.material?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的材质为必填`); return; }
        if (!p.cargoValue?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的货值为必填`); return; }
      }
    }

    // 事务内：先删旧产品行，再建新的
    const updated = await prisma.$transaction(async (tx) => {
      if (body.products) {
        await tx.consolidationPrealertProduct.deleteMany({
          where: { prealertId: body.prealertId },
        });

        const productData = body.products.map((p, idx) => {
          const totalQuantity = p.packageCount! * p.quantityPerBox!;
          const totalWeightKg = parseFloat((p.unitWeightKg! * totalQuantity).toFixed(2));
          const volumeM3 = parseFloat(
            ((p.lengthCm! * p.widthCm! * p.heightCm!) / 1_000_000 * p.packageCount!).toFixed(6),
          );
          return {
            prealertId: body.prealertId!,
            productName: p.productName!.trim(),
            packageCount: p.packageCount!,
            quantityPerBox: p.quantityPerBox!,
            totalQuantity,
            unitWeight: p.unitWeightKg!,
            totalWeight: totalWeightKg,
            length: p.lengthCm!,
            width: p.widthCm!,
            height: p.heightCm!,
            volume: volumeM3,
            material: p.material!.trim(),
            cargoValue: p.cargoValue!.trim(),
            sortOrder: idx,
          };
        });

        // 处理图片
        for (let i = 0; i < body.products.length; i++) {
          const img = body.products[i].productImage;
          if (img?.base64 && img.mime) {
            const savedPath = saveImageToDisk(
              `consolidation_${Date.now()}`,
              img.mime,
              img.base64,
            );
            productData[i] = {
              ...productData[i],
              productImageFileName: img.fileName || savedPath.split("/").pop() || "",
              productImageMime: img.mime,
              productImageBase64: savedPath,
            };
          }
        }

        await tx.consolidationPrealertProduct.createMany({ data: productData });
      }

      const updateData: any = {};
      if (body.mark?.trim()) updateData.mark = body.mark.trim();
      if (body.expressNo !== undefined) updateData.expressNo = body.expressNo?.trim() || null;

      return tx.consolidationPrealert.update({
        where: { id: body.prealertId },
        data: updateData,
      });
    });

    await recalcTaskTotals(pa.taskId);

    ok(res, formatPrealert(updated));
  });

  // 7) 删除预报单
  app.post("/client/consolidation/prealerts/delete", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { prealertId?: string };
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const pa = await prisma.consolidationPrealert.findUnique({
      where: { id: body.prealertId },
    });
    if (!pa || pa.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权删除该预报单");
      return;
    }
    if (pa.status !== "pending") {
      fail(res, 400, "BAD_REQUEST", "已签收的预报单不能删除");
      return;
    }

    await prisma.consolidationPrealert.delete({
      where: { id: body.prealertId },
    });

    await recalcTaskTotals(pa.taskId);

    ok(res, { deleted: true, id: body.prealertId });
  });

  // 8) 提交付款凭证（客户上传截图 → 待员工审核）
  app.post("/client/consolidation/pay", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      taskId?: string;
      proofBase64?: string;
      proofFileName?: string;
      proofMime?: string;
    };

    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }
    if (!body.proofBase64?.trim()) {
      fail(res, 400, "BAD_REQUEST", "付款凭证为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({ where: { id: body.taskId } });
    if (!task || task.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权操作该任务");
      return;
    }
    if (task.status !== "quoted") {
      fail(res, 400, "BAD_REQUEST", "只有已报价的任务才能提交付款");
      return;
    }
    // 允许 unpaid 和 pending_review（被拒绝后重新提交）
    if (task.paymentStatus !== "unpaid" && task.paymentStatus !== "pending_review") {
      fail(res, 400, "BAD_REQUEST", "当前状态不允许提交付款");
      return;
    }

    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: {
          paymentStatus: "pending_review",
          paymentProofFileName: body.proofFileName?.trim() || null,
          paymentProofMime: body.proofMime?.trim() || null,
          paymentProofBase64: body.proofBase64!.trim(),
          paymentProofUploadedAt: now,
          paymentRejectReason: null, // 清除旧的拒绝原因
          // 任务状态保持 quoted，不推进到 paid
        },
      });

      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: task.paymentStatus === "pending_review" ? "quoted" : "quoted",
          toStatus: "quoted", // 状态不变，只记日志
          remark: "客户提交付款凭证，等待审核",
        },
      });

      return null;
    });

    ok(res, { success: true, taskId: body.taskId });
  });

  // ==========================================================================
  // ==========================================================================
  // 付款审核接口（员工 / 管理员）
  // ==========================================================================

  // 审核通过 — 确认付款
  app.post("/staff/consolidation/review-payment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({ where: { id: body.taskId } });
    if (!task || task.companyId !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "无权操作该任务");
      return;
    }
    if (task.paymentStatus !== "pending_review") {
      fail(res, 400, "BAD_REQUEST", "当前没有待审核的付款");
      return;
    }

    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: {
          paymentStatus: "paid",
          paidAt: now,
          paymentReviewedAt: now,
          paymentReviewedBy: auth.userId,
          status: "paid",
        },
      });

      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "quoted",
          toStatus: "paid",
          remark: "付款审核通过",
        },
      });

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, paymentStatus: "paid" });
  });

  // 审核拒绝 — 退回付款
  app.post("/staff/consolidation/reject-payment", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string; reason?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }
    if (!body.reason?.trim()) {
      fail(res, 400, "BAD_REQUEST", "拒绝原因为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({ where: { id: body.taskId } });
    if (!task || task.companyId !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "无权操作该任务");
      return;
    }
    if (task.paymentStatus !== "pending_review") {
      fail(res, 400, "BAD_REQUEST", "当前没有待审核的付款");
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: {
          paymentStatus: "unpaid",
          paymentRejectReason: body.reason!.trim(),
          paymentReviewedAt: new Date(),
          paymentReviewedBy: auth.userId,
          // 任务状态保持 quoted
        },
      });

      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "quoted",
          toStatus: "quoted",
          remark: `付款审核不通过：${body.reason!.trim()}`,
        },
      });

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, paymentStatus: "unpaid" });
  });

  // ==========================================================================
  // 员工端接口
  // ==========================================================================


  // 1) 任务列表（员工视角，看所有客户）
  app.get("/staff/consolidation/tasks", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const statusFilter = (req.query as any)?.status as string | undefined;
    const where: any = { companyId: auth.companyId };
    if (statusFilter) where.status = statusFilter;

    const tasks = await prisma.consolidationTask.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { id: true, name: true, phone: true } },
        prealerts: {
          include: { products: true },
        },
      },
    });

    const result = tasks.map((t) => ({
      ...formatTask(t),
      clientName: t.client.name,
      clientPhone: t.client.phone,
      volumePercent: calcVolumePercent(t),
      isNearFull: calcVolumePercent(t) >= 85,
      prealerts: t.prealerts.map((pa) => ({
        ...formatPrealert(pa),
        products: pa.products.map(formatProduct),
      })),
    }));

    ok(res, result);
  });

  // 2) 任务详情（员工视角）
  app.get("/staff/consolidation/tasks/detail", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const taskId = (req.query as any)?.taskId as string | undefined;
    if (!taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({
      where: { id: taskId },
      include: {
        client: { select: { id: true, name: true, phone: true } },
        prealerts: {
          orderBy: { createdAt: "asc" },
          include: { products: { orderBy: { sortOrder: "asc" } } },
        },
        statusLogs: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }

    ok(res, {
      ...formatTask(task),
      clientName: task.client.name,
      clientPhone: task.client.phone,
      volumePercent: calcVolumePercent(task),
      isNearFull: calcVolumePercent(task) >= 85,
      prealerts: task.prealerts.map((pa) => ({
        ...formatPrealert(pa),
        products: pa.products.map(formatProduct),
      })),
      statusLogs: task.statusLogs.map(formatStatusLog),
    });
  });

  // 3) 签收预报单
  app.post("/staff/consolidation/prealerts/receive", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { prealertId?: string; proofBase64?: string; proofFileName?: string; proofMime?: string };
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const pa = await prisma.consolidationPrealert.findUnique({ where: { id: body.prealertId } });
    if (!pa) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (pa.status !== "pending") {
      fail(res, 400, "BAD_REQUEST", "该预报单已签收");
      return;
    }
    if (!body.proofBase64?.trim()) {
      fail(res, 400, "BAD_REQUEST", "签收照片为必填");
      return;
    }

    const now = new Date();

    // 处理签收照片（必填）
    const proofPath = saveImageToDisk(`consolidation_receive_${Date.now()}`, body.proofMime || "image/png", body.proofBase64!);

    await prisma.consolidationPrealert.update({
      where: { id: body.prealertId },
      data: {
        status: "received",
        signedAt: now,
        receivedProofFileName: body.proofFileName?.trim() || proofPath.split("/").pop() || "",
        receivedProofMime: body.proofMime?.trim() || "image/png",
        receivedProofBase64: proofPath,
      },
    });

    await recalcTaskTotals(pa.taskId);

    ok(res, { success: true, prealertId: body.prealertId, status: "received" });
  });

  // 4) 确认满柜
  app.post("/staff/consolidation/tasks/confirm-full", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({ where: { id: body.taskId } });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }
    if (task.status !== "collecting") {
      fail(res, 400, "BAD_REQUEST", "只有收集中状态的任务才能确认满柜");
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: { status: "full_confirmed" },
      });

      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "collecting",
          toStatus: "full_confirmed",
        },
      });

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, status: "full_confirmed" });
  });

  // 5) 报价
  app.post("/staff/consolidation/tasks/quote", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      taskId?: string;
      bookingFee?: number;
      customsFee?: number;
      loadingFee?: number;
    };

    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }
    if (body.bookingFee === undefined || body.bookingFee === null) {
      fail(res, 400, "BAD_REQUEST", "订舱费为必填");
      return;
    }
    if (body.customsFee === undefined || body.customsFee === null) {
      fail(res, 400, "BAD_REQUEST", "清关费为必填");
      return;
    }
    if (body.loadingFee === undefined || body.loadingFee === null) {
      fail(res, 400, "BAD_REQUEST", "装柜费为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({ where: { id: body.taskId } });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }
    if (task.status !== "full_confirmed" && task.status !== "quoted") {
      fail(res, 400, "BAD_REQUEST", "只有已满柜或已报价状态的任务才能报价");
      return;
    }

    const totalFee = parseFloat((body.bookingFee + body.customsFee + body.loadingFee).toFixed(2));
    const isFirstQuote = task.status === "full_confirmed";

    await prisma.$transaction(async (tx) => {
      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: {
          bookingFee: body.bookingFee,
          customsFee: body.customsFee,
          loadingFee: body.loadingFee,
          totalFee,
          ...(isFirstQuote ? { status: "quoted" } : {}),
        },
      });

      if (isFirstQuote) {
        await tx.consolidationStatusLog.create({
          data: {
            taskId: body.taskId!,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: auth.role,
            operatorName: auth.name || auth.userId,
            fromStatus: "full_confirmed",
            toStatus: "quoted",
            remark: `报价：订舱${body.bookingFee} + 清关${body.customsFee} + 装柜${body.loadingFee} = ${totalFee}`,
          },
        });
      }

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, totalFee, isFirstQuote });
  });

  // 6) 推进状态
  app.post("/staff/consolidation/tasks/advance-status", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string; toStatus?: string; remark?: string };

    if (!body.taskId?.trim() || !body.toStatus?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 和 toStatus 为必填");
      return;
    }

    // 状态流转校验
    const validTransitions: Record<string, string> = {
      paid: "loading",
      loading: "in_transit",
      in_transit: "customs",
      customs: "delivering",
      delivering: "completed",
    };

    const task = await prisma.consolidationTask.findUnique({ where: { id: body.taskId } });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }

    const expectedNext = validTransitions[task.status];
    if (!expectedNext) {
      fail(res, 400, "BAD_REQUEST", `当前状态 ${task.status} 不允许推进`);
      return;
    }
    if (body.toStatus !== expectedNext) {
      fail(res, 400, "BAD_REQUEST", `当前状态 ${task.status} 只能转到 ${expectedNext}，不能转到 ${body.toStatus}`);
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: { status: body.toStatus },
      });

      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: task.status,
          toStatus: body.toStatus!,
          remark: body.remark?.trim() || null,
        },
      });

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, fromStatus: task.status, toStatus: body.toStatus });
  });

  // 7) 装柜
  app.post("/staff/consolidation/tasks/loading", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string; containerNo?: string; loadingDate?: string };

    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({ where: { id: body.taskId } });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }
    if (task.status !== "paid") {
      fail(res, 400, "BAD_REQUEST", "只有已付款的任务才能装柜");
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: {
          containerNo: body.containerNo?.trim() || null,
          loadingDate: body.loadingDate?.trim() || null,
          status: "loading",
        },
      });

      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "paid",
          toStatus: "loading",
          remark: body.containerNo ? `柜号: ${body.containerNo}` : null,
        },
      });

      return null;
    });

    ok(res, { success: true, taskId: body.taskId, status: "loading" });
  });

  // 8) 取消任务
  app.post("/staff/consolidation/tasks/cancel", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { taskId?: string };
    if (!body.taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({ where: { id: body.taskId } });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }

    const cancellable = ["collecting", "full_confirmed", "quoted"];
    if (!cancellable.includes(task.status)) {
      fail(res, 400, "BAD_REQUEST", `当前状态 ${task.status} 不允许取消，只能取消收集中/已满柜/已报价的任务`);
      return;
    }

    await prisma.$transaction(async (tx) => {
      // 删除产品行
      const prealerts = await tx.consolidationPrealert.findMany({
        where: { taskId: body.taskId },
        select: { id: true },
      });
      for (const pa of prealerts) {
        await tx.consolidationPrealertProduct.deleteMany({ where: { prealertId: pa.id } });
      }
      // 删除预报单
      await tx.consolidationPrealert.deleteMany({ where: { taskId: body.taskId } });
      // 删除状态日志
      await tx.consolidationStatusLog.deleteMany({ where: { taskId: body.taskId } });
      // 更新任务状态
      await tx.consolidationTask.update({
        where: { id: body.taskId },
        data: { status: "cancelled" },
      });
      // 写取消日志
      await tx.consolidationStatusLog.create({
        data: {
          taskId: body.taskId!,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: task.status,
          toStatus: "cancelled",
        },
      });
      return null;
    });

    ok(res, { success: true, taskId: body.taskId, status: "cancelled" });
  });

  // 9) 导出数据（前端负责生成 Excel）
  app.get("/staff/consolidation/tasks/export", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const taskId = (req.query as any)?.taskId as string | undefined;
    if (!taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({
      where: { id: taskId },
      select: { taskNo: true },
    });

    const prealerts = await prisma.consolidationPrealert.findMany({
      where: { taskId, status: "received" },
      orderBy: { createdAt: "asc" },
      include: { products: { orderBy: { sortOrder: "asc" } } },
    });

    // 构建导出数据（不含快递单号 expressNo）
    const rows: any[] = [];
    for (const pa of prealerts) {
      for (const p of pa.products) {
        rows.push({
          mark: pa.mark,
          trackingNo: pa.trackingNo,
          productName: p.productName,
          packageCount: p.packageCount,
          quantityPerBox: p.quantityPerBox,
          totalQuantity: p.totalQuantity,
          unitWeight: p.unitWeight ? Number(p.unitWeight) : null,
          totalWeight: p.totalWeight ? Number(p.totalWeight) : null,
          lengthCm: p.length ? Number(p.length) : null,
          widthCm: p.width ? Number(p.width) : null,
          heightCm: p.height ? Number(p.height) : null,
          volumeM3: p.volume ? Number(p.volume) : null,
          material: p.material,
          cargoValue: p.cargoValue,
          productImageBase64: (() => {
            if (!p.productImageBase64) return null;
            if (p.productImageBase64.startsWith("data:image/")) return p.productImageBase64;
            if (p.productImageBase64.startsWith("/images/")) {
              const b64 = readImageAsBase64(p.productImageBase64);
              if (!b64) return null;
              const mimeType = (p.productImageMime || "image/jpeg").replace("image/", "");
              return `data:image/${mimeType};base64,${b64}`;
            }
            return p.productImageBase64;
          })(),
        });
      }
    }

    ok(res, {
      taskNo: task?.taskNo ?? "",
      taskId,
      totalRows: rows.length,
      headers: [
        { key: "mark", label: "唛头" },
        { key: "trackingNo", label: "运单号" },
        { key: "productName", label: "产品名称" },
        { key: "packageCount", label: "件数" },
        { key: "quantityPerBox", label: "装箱数量" },
        { key: "totalQuantity", label: "总数量" },
        { key: "unitWeight", label: "单件重量" },
        { key: "totalWeight", label: "总重量" },
        { key: "lengthCm", label: "长(cm)" },
        { key: "widthCm", label: "宽(cm)" },
        { key: "heightCm", label: "高(cm)" },
        { key: "volumeM3", label: "体积(m³)" },
        { key: "material", label: "材质" },
        { key: "cargoValue", label: "货值" },
        { key: "productImageBase64", label: "产品图片" },
      ],
      rows,
    });
  });

  // ==========================================================================
  // 管理员端接口
  // ==========================================================================

  // 1) 管理员任务列表
  app.get("/admin/consolidation/tasks", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const statusFilter = (req.query as any)?.status as string | undefined;
    const where: any = { companyId: auth.companyId };
    if (statusFilter) where.status = statusFilter;

    const tasks = await prisma.consolidationTask.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { id: true, name: true, phone: true } },
        prealerts: { include: { products: true } },
      },
    });

    const result = tasks.map((t) => ({
      ...formatTask(t),
      clientName: t.client.name,
      clientPhone: t.client.phone,
      volumePercent: calcVolumePercent(t),
      isNearFull: calcVolumePercent(t) >= 85,
      prealerts: t.prealerts.map((pa) => ({
        ...formatPrealert(pa),
        products: pa.products.map(formatProduct),
      })),
    }));

    ok(res, result);
  });

  // 2) 管理员删除任务
  app.delete("/admin/consolidation/tasks", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const taskId = (req.query as any)?.taskId as string | undefined;
    if (!taskId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "taskId 为必填");
      return;
    }

    const task = await prisma.consolidationTask.findUnique({ where: { id: taskId } });
    if (!task) {
      fail(res, 404, "NOT_FOUND", "任务不存在");
      return;
    }

    await prisma.consolidationTask.delete({ where: { id: taskId } });

    ok(res, { deleted: true, taskId });
  });

  // 3) 管理员强制编辑预报单
  app.post("/admin/consolidation/prealerts/force-edit", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      prealertId?: string;
      mark?: string;
      expressNo?: string;
      products?: Array<{
        productName?: string;
        packageCount?: number;
        quantityPerBox?: number;
        unitWeightKg?: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        material?: string;
        cargoValue?: string;
        productImage?: { fileName?: string; mime?: string; base64?: string };
      }>;
    };

    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const pa = await prisma.consolidationPrealert.findUnique({
      where: { id: body.prealertId },
      include: { task: true },
    });
    if (!pa) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }

    // 校验产品行
    if (body.products && body.products.length > 0) {
      for (let i = 0; i < body.products.length; i++) {
        const p = body.products[i];
        if (!p.productName?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的产品名为必填`); return; }
        if (!p.packageCount || p.packageCount < 1) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的件数必须大于0`); return; }
        if (!p.quantityPerBox || p.quantityPerBox < 1) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的装箱数量必须大于0`); return; }
        if (p.unitWeightKg === undefined || p.unitWeightKg === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的单件重量为必填`); return; }
        if (p.lengthCm === undefined || p.lengthCm === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的长为必填`); return; }
        if (p.widthCm === undefined || p.widthCm === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的宽为必填`); return; }
        if (p.heightCm === undefined || p.heightCm === null) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的高为必填`); return; }
        if (!p.material?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的材质为必填`); return; }
        if (!p.cargoValue?.trim()) { fail(res, 400, "BAD_REQUEST", `产品行${i + 1}的货值为必填`); return; }
      }
    }

    await prisma.$transaction(async (tx) => {
      if (body.products) {
        await tx.consolidationPrealertProduct.deleteMany({ where: { prealertId: body.prealertId } });

        const productData = body.products.map((p, idx) => {
          const totalQuantity = p.packageCount! * p.quantityPerBox!;
          const totalWeightKg = parseFloat((p.unitWeightKg! * totalQuantity).toFixed(2));
          const volumeM3 = parseFloat(
            ((p.lengthCm! * p.widthCm! * p.heightCm!) / 1_000_000 * p.packageCount!).toFixed(6),
          );
          return {
            prealertId: body.prealertId!,
            productName: p.productName!.trim(),
            packageCount: p.packageCount!,
            quantityPerBox: p.quantityPerBox!,
            totalQuantity,
            unitWeight: p.unitWeightKg!,
            totalWeight: totalWeightKg,
            length: p.lengthCm!,
            width: p.widthCm!,
            height: p.heightCm!,
            volume: volumeM3,
            material: p.material!.trim(),
            cargoValue: p.cargoValue!.trim(),
            sortOrder: idx,
          };
        });

        for (let i = 0; i < body.products.length; i++) {
          const img = body.products[i].productImage;
          if (img?.base64 && img.mime) {
            const savedPath = saveImageToDisk(`consolidation_admin_${Date.now()}`, img.mime, img.base64);
            productData[i] = {
              ...productData[i],
              productImageFileName: img.fileName || savedPath.split("/").pop() || "",
              productImageMime: img.mime,
              productImageBase64: savedPath,
            };
          }
        }

        await tx.consolidationPrealertProduct.createMany({ data: productData });
      }

      const updateData: any = {};
      if (body.mark?.trim()) updateData.mark = body.mark.trim();
      if (body.expressNo !== undefined) updateData.expressNo = body.expressNo?.trim() || null;

      await tx.consolidationPrealert.update({
        where: { id: body.prealertId },
        data: updateData,
      });

      return null;
    });

    await recalcTaskTotals(pa.taskId);

    ok(res, { success: true, prealertId: body.prealertId });
  });

  // 4) 管理员删除预报单
  app.post("/admin/consolidation/prealerts/delete", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { prealertId?: string };
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const pa = await prisma.consolidationPrealert.findUnique({ where: { id: body.prealertId } });
    if (!pa) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }

    await prisma.consolidationPrealert.delete({ where: { id: body.prealertId } });
    await recalcTaskTotals(pa.taskId);

    ok(res, { deleted: true, prealertId: body.prealertId });
  });
}
