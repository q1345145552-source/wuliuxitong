import { checkTotalsWritable } from "../core/decimal-guard";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { saveImageToDisk, deleteImageFile } from "../orders/image-storage";
import { BusinessError } from "../core/business-error";
import { canSeeOperatorIdentity, hideOperatorInRemark } from "../core/operator-visibility";
import { lockPrealertExpecting, lockPlanAliveByPrealert, PlanCancelledError, PlanMissingError } from "./plan-guard";
import {
  buildFeeBreakdown,
  calcFeeFromItems,
  deriveLatestStatus,
  recalcCustomerTotals,
  round3,
  syncPlanStatus,
  toNum,
} from "./utils";

/** 单张凭证 base64 上限（约 8MB 原图） */
const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;
/** 操作区 / 拆派视图一次最多拉多少个计划 */
const PLAN_TAKE = 200;
/** 每个计划最多展开的客户数、每个客户最多展开的预报单数 */
const CUSTOMER_TAKE = 100;
const PREALERT_TAKE = 500;

function isValidBase64(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(s.trim());
}

export function registerWhrConsolidationStaffRoutes(app: MinimalHttpApp): void {
  // =======================================================================
  // 0. 操作区数据（按预报单状态分组，按计划聚合）
  // =======================================================================
  app.get("/staff/whr-consolidation/operations", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const plans = await prisma.whrConsolidationPlan.findMany({
      where: {
        companyId: auth.companyId,
        status: { notIn: ["completed", "cancelled"] },
      },
      orderBy: { createdAt: "desc" },
      take: PLAN_TAKE,
      include: {
        customers: {
          take: CUSTOMER_TAKE,
          include: {
            client: { select: { id: true, name: true, phone: true, companyName: true } },
            prealerts: {
              where: { status: { not: "cancelled" } },
              take: PREALERT_TAKE,
              include: { items: { select: { volumeM3: true, packageCount: true } } },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    const statusGroups = [
      "pending",
      "received_pending_payment",
      "payment_submitted",
      "paid",
      "loading",
      "shipped",
    ];

    ok(res, {
      plans: plans.map((p) => {
        const sections: Record<string, any[]> = {};
        for (const sg of statusGroups) sections[sg] = [];
        let planUsedVolume = 0;

        for (const c of p.customers) {
          for (const pa of c.prealerts) {
            const totalVol = pa.items.reduce((s: number, it: any) => s + toNum(it.volumeM3), 0);
            const totalPkg = pa.items.reduce((s: number, it: any) => s + (it.packageCount ?? 0), 0);
            planUsedVolume += totalVol;

            const row: any = {
              prealertId: pa.id,
              trackingNo: pa.trackingNo,
              expressNo: pa.expressNo,
              mark: pa.mark,
              status: pa.status,
              clientId: c.clientId,
              customerId: c.id,
              clientName: c.client.name,
              clientPhone: c.client.phone,
              clientCompany: c.client.companyName,
              deliveryAddress: c.deliveryAddress,
              addressMissing: !c.deliveryAddress?.trim(),
              itemCount: pa.items.length,
              volumeM3: round3(totalVol),
              packageCount: totalPkg,
              totalFee: pa.totalFee == null ? null : toNum(pa.totalFee),
            };
            if (pa.status === "payment_submitted") {
              row.paymentProofs = pa.paymentProofs ?? [];
            }
            if (pa.status === "shipped") {
              row.thailandReceiptProofs = pa.thailandReceiptProofs ?? [];
            }
            if (sections[pa.status] !== undefined) sections[pa.status].push(row);
          }
        }

        return {
          planId: p.id,
          planNo: p.planNo,
          warehouse: p.warehouse,
          containerType: p.containerType,
          destinationTh: p.destinationTh,
          totalVolumeM3: toNum(p.totalVolumeM3),
          usedVolumeM3: round3(planUsedVolume),
          status: p.status,
          sections,
        };
      }),
    });
  });

  // =======================================================================
  // 0b. 单张预报单详情（审核弹窗用，避免为了一条单去拉整个计划）
  // =======================================================================
  app.get("/staff/whr-consolidation/prealert-detail", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const prealertId = (req.query as any)?.prealertId as string | undefined;
    if (!prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const pa = await prisma.whrConsolidationPrealert.findFirst({
      where: { id: prealertId, companyId: auth.companyId },
      include: {
        items: { orderBy: { sortOrder: "asc" } },
        statusLogs: { orderBy: { createdAt: "desc" }, take: 50 },
        planCustomer: {
          include: {
            client: { select: { id: true, name: true, phone: true, companyName: true } },
          },
        },
      },
    });

    if (!pa) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }

    const c = pa.planCustomer;
    const feeBreakdown = buildFeeBreakdown(
      pa.items,
      {
        unitPriceNormal: c.unitPriceNormal,
        unitPriceInspection: c.unitPriceInspection,
        unitPriceSensitive: c.unitPriceSensitive,
      },
      pa.totalFee,
    );
    ok(res, {
      id: pa.id,
      planId: c.planId,
      trackingNo: pa.trackingNo,
      expressNo: pa.expressNo,
      mark: pa.mark,
      status: pa.status,
      totalFee: pa.totalFee == null ? null : toNum(pa.totalFee),
      feeBreakdown,
      signedAt: pa.signedAt?.toISOString() ?? null,
      warehouseReceiptProofs: pa.warehouseReceiptProofs ?? [],
      thailandReceiptProofs: pa.thailandReceiptProofs ?? [],
      paymentProofs: pa.paymentProofs ?? [],
      paymentProofUploadedAt: pa.paymentProofUploadedAt?.toISOString() ?? null,
      paymentRejectReason: pa.paymentRejectReason,
      cancelReason: pa.cancelReason,
      customerId: c.id,
      clientId: c.clientId,
      clientName: c.client.name,
      clientPhone: c.client.phone,
      clientCompany: c.client.companyName,
      deliveryAddress: c.deliveryAddress,
      unitPriceNormal: toNum(c.unitPriceNormal),
      unitPriceInspection: toNum(c.unitPriceInspection),
      unitPriceSensitive: toNum(c.unitPriceSensitive),
      items: pa.items.map((it: any) => ({
        id: it.id,
        productName: it.productName,
        packageCount: it.packageCount,
        quantityPerBox: it.quantityPerBox,
        totalQuantity: it.totalQuantity,
        lengthCm: it.lengthCm == null ? null : toNum(it.lengthCm),
        widthCm: it.widthCm == null ? null : toNum(it.widthCm),
        heightCm: it.heightCm == null ? null : toNum(it.heightCm),
        unitWeightKg: it.unitWeightKg == null ? null : toNum(it.unitWeightKg),
        totalWeightKg: it.totalWeightKg == null ? null : toNum(it.totalWeightKg),
        volumeM3: it.volumeM3 == null ? null : toNum(it.volumeM3),
        material: it.material,
        cargoValue: it.cargoValue,
        cargoType: it.cargoType,
        productImageFileName: it.productImageFileName,
        productImageBase64: it.productImageBase64,
        sortOrder: it.sortOrder,
      })),
      statusLogs: pa.statusLogs.map((sl) => ({
        id: sl.id,
        // 2026-09-15：操作人只给超级管理员；备注开头的「管理员」也只给超级管理员
        operatorName: canSeeOperatorIdentity(auth.role) ? sl.operatorName : undefined,
        operatorRole: canSeeOperatorIdentity(auth.role) ? sl.operatorRole : undefined,
        fromStatus: sl.fromStatus,
        toStatus: sl.toStatus,
        remark: hideOperatorInRemark(sl.remark, auth.role),
        createdAt: sl.createdAt.toISOString(),
      })),
    });
  });

  // =======================================================================
  // 1. 仓库签收（预报单级别）
  // =======================================================================
  app.post("/staff/whr-consolidation/prealert-sign", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      prealertId?: string;
      receiptProofs?: { fileName?: string; mime?: string; base64?: string }[];
    };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    const proofs = Array.isArray(body.receiptProofs) ? body.receiptProofs.filter(p => p?.base64?.trim() && isValidBase64(p.base64)) : [];
    if (proofs.length === 0) {
      fail(res, 400, "BAD_REQUEST", "请至少上传一张收货凭证照片");
      return;
    }
    if (proofs.some(p => (p.base64?.length ?? 0) > MAX_IMAGE_BASE64_LENGTH)) {
      fail(res, 400, "BAD_REQUEST", "收货凭证照片过大，请压缩后再上传");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      include: {
        planCustomer: {
          select: {
            id: true,
            unitPriceNormal: true,
            unitPriceInspection: true,
            unitPriceSensitive: true,
          },
        },
        items: { select: { cargoType: true, volumeM3: true } },
      },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (prealert.status !== "pending") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可签收，仅待签收状态可操作");
      return;
    }
    if (prealert.items.length === 0) {
      fail(res, 400, "BAD_REQUEST", "预报单尚无货品，无法签收");
      return;
    }

    // 方数为 0 直接签收会产生一张 ¥0 的账单，这里挡住并提示补录尺寸
    const totalVolume = prealert.items.reduce((s, it) => s + toNum(it.volumeM3), 0);
    if (totalVolume <= 0) {
      fail(res, 400, "BAD_REQUEST", "该预报单货品缺少长宽高，方数为 0，签收会导致金额为 0，请先让客户补录尺寸");
      return;
    }

    // 这个金额只是先算出来给下面的失败提示用；**真正入账的金额在事务里锁完重算**（见下）
    const now = new Date();

    // 多张图片先写盘，事务失败再删掉，避免事务里做文件 IO
    const receiptProofs: { fileName: string; mime: string; base64Path: string; uploadedAt: string }[] = [];
    try {
      for (const pf of proofs) {
        const path = saveImageToDisk(
          `whr_warehouse_receipt_${prealert.id}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
          pf.mime?.trim() || "image/png",
          pf.base64!.trim(),
        );
        receiptProofs.push({
          fileName: pf.fileName?.trim() || path.split("/").pop() || "",
          mime: pf.mime?.trim() || "image/png",
          base64Path: path,
          uploadedAt: now.toISOString(),
        });
      }
    } catch {
      fail(res, 400, "BAD_REQUEST", "收货凭证保存失败，请重试");
      return;
    }

    let signResult = { totalFee: 0, volumeM3: 0 };
    try {
      signResult = await prisma.$transaction(async (tx) => {
        // ⚠️ 整柜取消了就不该再签收计费（2026-08-27 第二版：挪进事务并加锁）。
        // 放在事务第一句 = 锁序【计划 → 预报单】的第一环；
        // 第一版放在事务外面，读到「柜还活着」之后柜被取消了，账单照样生成。
        await lockPlanAliveByPrealert(tx, prealert.id);

        /**
         * ⚠️ 单价和方数必须**锁完再读一遍，金额在事务里算**（2026-08-27 补）。
         *
         * 原来金额是在事务外面算好的：仓库点「签收」的同一刻管理员正好把单价
         * 从 800 改成 1000，签收照样按 800 出账；而管理员那边的「重算」只动
         * 未付款的单，这张刚签收的单谁也不会再碰 —— 差价就永远收不回来了。
         * 现在锁住计划之后重新读单价和货品，算出来的一定是最新的。
         */
        const live = await tx.whrConsolidationPrealert.findUnique({
          where: { id: prealert.id },
          select: {
            status: true,
            planCustomer: {
              select: { unitPriceNormal: true, unitPriceInspection: true, unitPriceSensitive: true },
            },
            items: { select: { cargoType: true, volumeM3: true } },
          },
        });
        if (!live) throw new BusinessError("预报单不存在", 404, "NOT_FOUND");
        if (live.status !== "pending") {
          throw new BusinessError("这张预报单刚刚被别人处理过了，签收没有执行，请刷新后再看");
        }

        /**
         * ⚠️ 「货还在不在」也要锁完重查（2026-08-31 补，排查报告第 10 条）。
         * 事务外那两道「无货品 / 方数为 0」的检查只配当提示：客户在待签收状态
         * 可以清空货品，赶在存凭证照片那零点几秒里清掉，这里不复查就会签出一张
         * ¥0 的账单 —— 单子进「待付款」但付款接口不收 0 元，客户也改不了货，
         * 这张单就卡死了，只能找管理员处理。
         */
        const liveVolume = live.items.reduce((s, it) => s + toNum(it.volumeM3), 0);
        if (live.items.length === 0 || liveVolume <= 0) {
          throw new BusinessError("货品刚被客户改过（已清空或方数为 0），签收没有执行，请刷新后重新核对再签收");
        }
        // 货品跟本次请求进门时读的那份对不上也拦下来（2026-08-31 补：货型构成也算进比对，
        // 普货改成商检这种「尺寸不变、单价变了」的改法以前溜得过去）。
        // 说清楚这道闸的斤两：它只拦「这个请求处理中那零点几秒」里发生的改动 ——
        // 师傅几分钟前打开页面、客户中途改货、师傅再点签收，这里两次读到的都是改后数据，
        // 照样放行。要拦那种得让前端把页面上那份货品快照随请求带上来，目前还没做。
        // 钱不会算错（金额用的是锁里重读的最新数据），这里只是尽力提醒。
        const cargoMix = (items: { cargoType: string }[]) =>
          items.map((it) => it.cargoType).sort().join(",");
        if (
          live.items.length !== prealert.items.length ||
          round3(liveVolume) !== round3(totalVolume) ||
          cargoMix(live.items) !== cargoMix(prealert.items)
        ) {
          throw new BusinessError("货品刚被客户改过，签收没有执行，请刷新后重新核对再签收");
        }

        const totalFee = calcFeeFromItems(live.items, live.planCustomer);
        /**
         * ⚠️⚠️ **签收这条路自己算 totalFee、自己写库，绕过了 recalcPrealertFee**
         * （2026-08-29 第十二轮补）。
         * 我第十一轮把金额闸加在 `recalcPrealertFee()` 里，
         * 复核马上找出这一处 —— 它根本不走那个函数，超大金额照样裸报数据库错误，
         * 员工看到的是「服务器繁忙」而不是人话。
         *
         * ⚠️ 这是**仓库版签收**：金额就是「方数 × 单价」，签收这一下就定了收多少钱。
         *    写不进去比写错了还糟 —— 货已经签收了，账却没落上。
         */
        const feeIssue = checkTotalsWritable({ fees: [["这张预报单的金额", totalFee]] });
        if (feeIssue) {
          throw new BusinessError(`${feeIssue}。请检查这张预报单的方数和单价`, 400, "VALIDATION_ERROR");
        }

        await tx.whrConsolidationPrealert.update({
          where: { id: prealert.id },
          data: {
            status: "received_pending_payment",
            signedAt: now,
            receivedAt: now,
            totalFee,
            warehouseReceiptProofs: receiptProofs,
          },
        });
        await tx.whrConsolidationStatusLog.create({
          data: {
            prealertId: prealert.id,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: auth.role,
            operatorName: auth.name || auth.userId,
            fromStatus: "pending",
            toStatus: "received_pending_payment",
            // 方数用锁里重读的那份写，别用事务外的旧数字 —— 金额是新算的，
            // 方数写旧的会让同一条记录自己对不上（2026-08-31，排查报告第 10 条）
            remark: `仓库签收，${round3(liveVolume)} 方，系统自动计费 ¥${totalFee}`,
          },
        });
        await recalcCustomerTotals(prealert.customerId, tx);
        await syncPlanStatus(body.planId!, tx);
        return { totalFee, volumeM3: round3(liveVolume) };
      });
    } catch (e) {
      for (const pf of receiptProofs) {
        try { deleteImageFile(pf.base64Path); } catch { /* ignore */ }
      }
      // 整柜已取消 / 找不到柜：给员工一句人话，别抛成 500
      if (e instanceof PlanCancelledError || e instanceof PlanMissingError) {
        fail(res, 400, "BAD_REQUEST", e.message);
        return;
      }
      throw e;
    }

    ok(res, {
      prealertId: prealert.id,
      status: "received_pending_payment",
      totalFee: signResult.totalFee,
      // 方数返回锁里重读的那份，跟入账口径一致（2026-08-31，排查报告第 10 条）
      volumeM3: signResult.volumeM3,
      signedAt: now.toISOString(),
    });
  });

  // =======================================================================
  // 2. 装柜确认（预报单级别）
  // =======================================================================
  app.post("/staff/whr-consolidation/loading-confirm", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; prealertId?: string };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      select: { id: true, status: true },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (prealert.status !== "paid") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可装柜，仅已付款状态可操作");
      return;
    }

    await prisma.$transaction(async (tx) => {
      // 锁住再确认状态没变（2026-08-27 补，见 plan-guard.lockPrealertExpecting 里的说明）
      // ⚠️ 必须**先锁计划、再锁子单**（2026-08-27 补）。这一步后面会调 syncPlanStatus
      // 去改计划行；如果先锁子单，就跟「删除整柜」那条路（计划→子单）反着，会死锁。
      await lockPlanAliveByPrealert(tx, prealert.id);
      await lockPrealertExpecting(tx, prealert.id, "paid", "装柜");
      await tx.whrConsolidationPrealert.update({
        where: { id: prealert.id },
        data: { status: "loading" },
      });
      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "paid",
          toStatus: "loading",
          remark: "装柜确认",
        },
      });
      await syncPlanStatus(body.planId!, tx);
      return true;
    });
    ok(res, { prealertId: prealert.id, status: "loading" });
  });

  // =======================================================================
  // 3. 发运确认（预报单级别）
  // =======================================================================
  app.post("/staff/whr-consolidation/ship-confirm", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; prealertId?: string };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      select: { id: true, status: true },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (prealert.status !== "loading") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可发运，仅装柜中状态可操作");
      return;
    }

    await prisma.$transaction(async (tx) => {
      // 锁住再确认状态没变（2026-08-27 补，见 plan-guard.lockPrealertExpecting 里的说明）
      // ⚠️ 必须**先锁计划、再锁子单**（2026-08-27 补）。这一步后面会调 syncPlanStatus
      // 去改计划行；如果先锁子单，就跟「删除整柜」那条路（计划→子单）反着，会死锁。
      await lockPlanAliveByPrealert(tx, prealert.id);
      await lockPrealertExpecting(tx, prealert.id, "loading", "发运");
      await tx.whrConsolidationPrealert.update({
        where: { id: prealert.id },
        data: { status: "shipped" },
      });
      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "loading",
          toStatus: "shipped",
          remark: "发运确认",
        },
      });
      await syncPlanStatus(body.planId!, tx);
      return true;
    });
    ok(res, { prealertId: prealert.id, status: "shipped" });
  });

  // =======================================================================
  // 4. 泰国签收（预报单级别）
  // =======================================================================
  app.post("/staff/whr-consolidation/thailand-sign", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      prealertId?: string;
      proofs?: { fileName?: string; mime?: string; base64?: string }[];
    };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    const proofs = Array.isArray(body.proofs) ? body.proofs.filter(p => p?.base64?.trim() && isValidBase64(p.base64)) : [];
    if (proofs.length === 0) {
      fail(res, 400, "BAD_REQUEST", "请至少上传一张泰国签收单");
      return;
    }
    if (proofs.some(p => (p.base64?.length ?? 0) > MAX_IMAGE_BASE64_LENGTH)) {
      fail(res, 400, "BAD_REQUEST", "泰国签收单过大，请压缩后再上传");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      select: { id: true, status: true },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (prealert.status !== "shipped") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可签收，仅已发运状态可操作");
      return;
    }

    const now = new Date();
    const thaiProofs: { fileName: string; mime: string; base64Path: string; uploadedAt: string }[] = [];
    try {
      for (const pf of proofs) {
        const path = saveImageToDisk(
          `whr_thailand_sign_${prealert.id}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
          pf.mime?.trim() || "image/png",
          pf.base64!.trim(),
        );
        thaiProofs.push({
          fileName: pf.fileName?.trim() || path.split("/").pop() || "",
          mime: pf.mime?.trim() || "image/png",
          base64Path: path,
          uploadedAt: now.toISOString(),
        });
      }
    } catch {
      fail(res, 400, "BAD_REQUEST", "泰国签收单保存失败，请重试");
      return;
    }

    try {
      await prisma.$transaction(async (tx) => {
        // 锁住再确认状态没变（2026-08-27 补）
        // ⚠️ 必须**先锁计划、再锁子单**（2026-08-27 补）。这一步后面会调 syncPlanStatus
      // 去改计划行；如果先锁子单，就跟「删除整柜」那条路（计划→子单）反着，会死锁。
      await lockPlanAliveByPrealert(tx, prealert.id);
      await lockPrealertExpecting(tx, prealert.id, "shipped", "泰国签收");
        await tx.whrConsolidationPrealert.update({
          where: { id: prealert.id },
          data: {
            status: "thailand_received",
            thailandReceivedAt: now,
            thailandReceiptProofs: thaiProofs,
          },
        });
        await tx.whrConsolidationStatusLog.create({
          data: {
            prealertId: prealert.id,
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
    } catch (e) {
      for (const pf of thaiProofs) {
        try { deleteImageFile(pf.base64Path); } catch { /* ignore */ }
      }
      throw e;
    }

    ok(res, {
      prealertId: prealert.id,
      status: "thailand_received",
      thailandReceivedAt: now.toISOString(),
    });
  });

  // =======================================================================
  // 5. 尾端拆派视图（预报单级别）
  // =======================================================================
  app.get("/staff/whr-consolidation/dispatch-view", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const plans = await prisma.whrConsolidationPlan.findMany({
      where: { companyId: auth.companyId },
      orderBy: { createdAt: "desc" },
      take: PLAN_TAKE,
      include: {
        customers: {
          take: CUSTOMER_TAKE,
          include: {
            client: { select: { id: true, name: true, phone: true, companyName: true } },
            prealerts: {
              where: { status: { in: ["paid", "loading", "shipped", "thailand_received"] } },
              take: PREALERT_TAKE,
              include: { items: { orderBy: { sortOrder: "asc" } } },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    ok(res, {
      items: plans
        .map((p) => ({
          planId: p.id,
          planNo: p.planNo,
          warehouse: p.warehouse,
          containerType: p.containerType,
          destinationTh: p.destinationTh,
          totalVolumeM3: toNum(p.totalVolumeM3),
          planStatus: p.status,
          createdAt: p.createdAt.toISOString(),
          customers: p.customers
            // 只保留真正有可派送预报单的客户，空客户在拆派视图里没有意义
            .filter((c) => c.prealerts.length > 0)
            .map((c) => {
              const allItems = c.prealerts.flatMap((pa) => pa.items);
              return {
                id: c.id,
                clientId: c.clientId,
                clientName: c.client.name,
                clientPhone: c.client.phone,
                clientCompany: c.client.companyName,
                // 客户维度的状态由所有预报单推导，不再拿第一条单的状态冒充
                status: deriveLatestStatus(c.prealerts.map((pa) => pa.status)),
                unitPriceNormal: toNum(c.unitPriceNormal),
                unitPriceInspection: toNum(c.unitPriceInspection),
                unitPriceSensitive: toNum(c.unitPriceSensitive),
                totalVolumeM3: round3(allItems.reduce((s, it) => s + toNum(it.volumeM3), 0)),
                totalFee: c.totalFee == null ? null : toNum(c.totalFee),
                deliveryAddress: c.deliveryAddress,
                addressMissing: !c.deliveryAddress?.trim(),
                totalItems: allItems.length,
                totalPackages: allItems.reduce((s, it) => s + (it.packageCount ?? 0), 0),
                createdAt: c.createdAt.toISOString(),
                prealerts: c.prealerts.map((pa) => ({
                  id: pa.id,
                  trackingNo: pa.trackingNo,
                  mark: pa.mark,
                  expressNo: pa.expressNo,
                  status: pa.status,
                  receivedAt: pa.receivedAt?.toISOString() ?? null,
                  signedAt: pa.signedAt?.toISOString() ?? null,
                  warehouseReceiptProofs: pa.warehouseReceiptProofs ?? [],
                  thailandReceiptProofs: pa.thailandReceiptProofs ?? [],
                  items: pa.items.map((it: any) => ({
                    id: it.id,
                    productName: it.productName,
                    packageCount: it.packageCount,
                    quantityPerBox: it.quantityPerBox,
                    totalQuantity: it.totalQuantity,
                    lengthCm: it.lengthCm == null ? null : toNum(it.lengthCm),
                    widthCm: it.widthCm == null ? null : toNum(it.widthCm),
                    heightCm: it.heightCm == null ? null : toNum(it.heightCm),
                    unitWeightKg: it.unitWeightKg == null ? null : toNum(it.unitWeightKg),
                    totalWeightKg: it.totalWeightKg == null ? null : toNum(it.totalWeightKg),
                    volumeM3: it.volumeM3 == null ? null : toNum(it.volumeM3),
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
        }))
        .filter((p) => p.customers.length > 0),
    });
  });
}
