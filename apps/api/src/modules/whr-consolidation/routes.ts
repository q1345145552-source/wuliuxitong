import { DECIMAL_10_2, requireDecimal, requireUnitPrice } from "../core/decimal-guard";
import { parseNumericStrict } from "../core/int-guard";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { logger } from "../core/logger";
import { BusinessError } from "../core/business-error";
import { verifyPassword } from "../auth/crypto-utils";
import { canSeeOperatorIdentity, hideOperatorInRemark } from "../core/operator-visibility";
import { lockPlanAliveById, lockPlanAliveByPrealert, lockPlanByPrealert, PlanCancelledError, PlanMissingError } from "./plan-guard";
import {
  computePendingRefunds,
  refundPendingOnDelete,
  refundToConsolidation,
} from "../wallet/consolidation-balance";
import {
  CLEARED_PAID_SNAPSHOT,
  NON_CANCELLABLE_STATUSES,
  buildFeeBreakdown,
  buildPaidSnapshot,
  mergeFeeBreakdowns,
  recalcCustomerTotals,
  recalcPrealertFee,
  recalcUnpaidPrealertFees,
  syncPlanStatus,
  toNum,
} from "./utils";
import { assertNotBelowAgentFloors, assertPlanPricesNotBelowAgent, lockAgentPriceFloors, lockClientWhrPrice, REPRICE_PLAN_STATUSES } from "./long-term-price";

/**
 * 2026-09-18 起这个文件不再读客户长期价来定价（`long-term-price.ts` 和 `client_whr_prices` 表都留着，
 * 老板说后端暂时保留、以后可能会用）。柜里的三档单价一律是建柜 / 加客户 / 改单价时当场填的。
 *
 * ⚠️ 两样东西照旧要：
 *  ① **客户价排队锁**（`lockClientWhrPrice`）：改客户归属那条路靠它保证「数完业务记录到改完归属之间，
 *     没有新的柜记录插队」（admin/routes.ts 的注释和 scripts/test-lock-order.ts 都写着这条）。
 *  ② **代理价下限**（`assertPlanPricesNotBelowAgent`）：代理客户的柜价不能低于湘泰给代理的价（确认单 4.7）。
 *  锁序统一成【客户价排队锁 → agents FOR SHARE → 计划】，跟 setClientWhrPrice 同方向，别对着拿。
 */

/**
 * 删柜的「发运红线」（2026-09-16，确认单 4.15）：柜只要已经发出去，谁都不能删，输管理员密码也不行。
 * 仓库版：计划 shipped / completed，或者柜里有任何一张预报单 shipped / thailand_received。
 * 纯函数，事务外（给预览）和锁里（说了算）用同一份。
 * @returns 拦就返回给人看的原因；没到红线返回 null（还是按原来的规矩：开始走流程要输密码）
 */
export const WHR_SHIPPED_PLAN_STATUSES = ["shipped", "completed"];
export const WHR_SHIPPED_PREALERT_STATUSES = ["shipped", "thailand_received"];
export function whrPlanShippedReason(planStatus: string, prealertStatuses: readonly string[]): string | null {
  const shippedCount = prealertStatuses.filter((s) => WHR_SHIPPED_PREALERT_STATUSES.includes(s)).length;
  if (WHR_SHIPPED_PLAN_STATUSES.includes(planStatus) || shippedCount > 0) {
    return shippedCount > 0
      ? `这个柜已经发运（有 ${shippedCount} 张预报单已发运或已到泰国签收），已发出去的柜谁都不能删，输管理员密码也不行`
      : "这个柜已经发运，已发出去的柜谁都不能删，输管理员密码也不行";
  }
  return null;
}

/** 列表查询上限，避免计划数变多之后接口整包返回 */
const PLAN_LIST_TAKE = 500;
/** 一个计划最多参与客户数 */
const MAX_CUSTOMERS_PER_PLAN = 100;

/** 货型取值 */
const CARGO_TYPES = ["normal", "inspection", "sensitive"];
const CARGO_TYPE_ZH: Record<string, string> = { normal: "普货", inspection: "商检货", sensitive: "敏感货" };

/**
 * 允许管理员改货型 / 删单件货物的状态（用户 2026-08-15 拍板）。
 *
 * 口径是「客户还没交钱」：
 *   pending                  货还没到，客户自己就能改
 *   received_pending_payment 仓库已收货、账单已生成但还没付款
 *                            —— 货型报错通常正是收货时才发现的，卡在 pending 等于功能用不了
 * payment_submitted 及之后一律不给动：钱已经交了，改了对不上账。
 */
const ITEM_EDITABLE_STATUSES = ["pending", "received_pending_payment"];

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 在**已有事务内**生成拼柜计划编号 WHR + 7位数字（如 WHR0000001）。
 *
 * 必须和 create 在同一个事务里调用：pg_advisory_xact_lock 随事务结束释放，
 * 原来的写法在独立事务里取完最大值就把锁放了，两个并发请求会拿到同一个号，
 * planNo 上有唯一约束，第二个插入直接 500。
 * 另外按数值取最大而不是字符串排序，位数变化后才不会算错。
 */
async function generatePlanNoInTx(tx: any): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(83010)`;
  const rows = await tx.$queryRaw<{ maxno: bigint | number | null }[]>`
    SELECT MAX(CAST(SUBSTRING(plan_no FROM 4) AS BIGINT)) AS maxno
    FROM whr_consolidation_plans
    WHERE plan_no ~ '^WHR[0-9]+$'
  `;
  const nextNum = Number(rows?.[0]?.maxno ?? 0) + 1;
  return `WHR${String(nextNum).padStart(7, "0")}`;
}

/*
 * 改单价（2026-09-18 恢复）后的重算就是 recalcUnpaidPrealertFees + recalcCustomerTotals 两句（utils.ts），
 * 跟 long-term-price.ts 那条路共用同一份口径 —— 别再单独包一个 repriceCustomer 出来。
 */

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

    /**
     * 2026-09-18 老板拍板改回来：**每个柜当场填三档单价**（他原话：「不要去设置价格，之前的逻辑是正确的，
     * 每次柜价格都不一样的。所以所有人都不需要设置价格」）。9-16 那套「客户长期价自动带出」不再用 ——
     * 长期价的表和代码都留着（long-term-price.ts），只是没有任何地方读它来定价了。
     */
    const body = (req.body ?? {}) as {
      warehouse?: string;
      containerType?: string;
      destinationTh?: string;
      totalVolumeM3?: number;
      customers?: { clientId?: string; unitPriceNormal?: number; unitPriceInspection?: number; unitPriceSensitive?: number }[];
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
    if (body.customers.length > MAX_CUSTOMERS_PER_PLAN) {
      fail(res, 400, "BAD_REQUEST", `一个计划最多 ${MAX_CUSTOMERS_PER_PLAN} 个客户`);
      return;
    }
    /**
     * ⚠️ 柜总方数（2026-08-29 收紧）：原来只判「大于 0」，**没有上限、不限小数位**。
     * 库里是 `Decimal(10,2)`，所以：小数最多 2 位、整数最多 8 位。
     * 上限一填大，全系统唯一那道「本柜已用方数不许超上限」的闸就废了。
     * ⚠️ 这里卡的是**数据库能不能存**；老板要是想再加业务上限
     *   （比如「一个柜最多 200 方」），那是另一回事，得他给数字。
     */
    const totalVolumeM3 = body.totalVolumeM3 == null ? 68 : parseNumericStrict(body.totalVolumeM3);
    const volIssue = requireDecimal(totalVolumeM3, "总方数", DECIMAL_10_2);
    if (volIssue) {
      fail(res, 400, "BAD_REQUEST", volIssue);
      return;
    }

    const seenClientIds = new Set<string>();
    for (let i = 0; i < body.customers.length; i++) {
      const c = body.customers[i];
      if (!c.clientId?.trim()) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 个客户ID为必填`);
        return;
      }
      // 同一个客户不能在同一个计划里出现两次（数据库没有这个唯一约束，在这里挡住）
      if (seenClientIds.has(c.clientId.trim())) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 个客户重复选择，同一客户在一个计划中只能出现一次`);
        return;
      }
      seenClientIds.add(c.clientId.trim());
      const priceChecks: Array<[string, number | undefined]> = [
        ["普货", c.unitPriceNormal],
        ["商检货", c.unitPriceInspection],
        ["敏感货", c.unitPriceSensitive],
      ];
      for (const [label, val] of priceChecks) {
        // ⚠️ 用 requireUnitPrice（2026-08-29）：只判「大于 0」不够 ——
        // 0.001 也大于 0，库里是 Decimal(10,2)，会被**存成 0.00**，这一柜白送。
        const priceIssue = val == null ? `第 ${i + 1} 个客户${label}单价为必填` : requireUnitPrice(val, `第 ${i + 1} 个客户${label}单价`);
        if (priceIssue) {
          fail(res, 400, "BAD_REQUEST", priceIssue);
          return;
        }
      }
    }

    // 客户必须存在、属于本公司、且确实是客户角色
    const clientIds = Array.from(seenClientIds);
    const validClients = await prisma.user.findMany({
      where: { id: { in: clientIds }, companyId: auth.companyId, role: "client" },
      select: { id: true },
    });
    if (validClients.length !== clientIds.length) {
      const validSet = new Set(validClients.map((u) => u.id));
      const missing = clientIds.filter((id) => !validSet.has(id));
      fail(res, 400, "BAD_REQUEST", `以下客户不存在或不属于本公司：${missing.join(", ")}`);
      return;
    }

    // 编号生成和插入放同一个事务，锁才有意义
    const plan = await prisma.$transaction(async (tx) => {
      // 锁序：客户价排队锁（按 clientId 排序）→ 代理价下限（agents FOR SHARE）→ 取号建柜
      for (const clientId of [...clientIds].sort()) {
        await lockClientWhrPrice(tx, clientId);
      }
      await assertPlanPricesNotBelowAgent(
        tx,
        auth.companyId,
        body.customers!.map((c) => ({
          clientId: c.clientId!.trim(),
          prices: {
            normal: Number(c.unitPriceNormal),
            inspection: Number(c.unitPriceInspection),
            sensitive: Number(c.unitPriceSensitive),
          },
        })),
        auth.role,
      );
      const planNo = await generatePlanNoInTx(tx);
      const created = await tx.whrConsolidationPlan.create({
        data: {
          companyId: auth.companyId,
          planNo,
          warehouse: body.warehouse?.trim() || "义乌",
          containerType: body.containerType?.trim() || "40HQ",
          destinationTh: body.destinationTh!.trim(),
          totalVolumeM3,
          status: "collecting",
          createdBy: auth.userId,
          creatorName: auth.name,
        },
      });

      await tx.whrConsolidationPlanCustomer.createMany({
        data: body.customers!.map((c) => ({
          planId: created.id,
          companyId: auth.companyId,
          clientId: c.clientId!.trim(),
          unitPriceNormal: Number(c.unitPriceNormal),
          unitPriceInspection: Number(c.unitPriceInspection),
          unitPriceSensitive: Number(c.unitPriceSensitive),
        })),
      });

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
      take: PLAN_LIST_TAKE,
      include: {
        _count: { select: { customers: true } },
      },
    });

    // 批量查询每个计划的已用方数（不含已取消客户）
    const volumeSums = await prisma.whrConsolidationPlanCustomer.groupBy({
      by: ["planId"],
      where: { planId: { in: plans.map(p => p.id) } },
      _sum: { totalVolumeM3: true },
    });
    const volumeMap = new Map(volumeSums.map(r => [r.planId, r._sum?.totalVolumeM3?.toNumber() ?? 0]));

    ok(res, {
      items: plans.map((p) => ({
        id: p.id,
        planNo: p.planNo,
        warehouse: p.warehouse,
        containerType: p.containerType,
        destinationTh: p.destinationTh,
        totalVolumeM3: toNum(p.totalVolumeM3),
        status: p.status,
        // 2026-09-15：创建人（账号 id / 名字）只给超级管理员，这个接口员工也能调
        createdBy: canSeeOperatorIdentity(auth.role) ? p.createdBy : undefined,
        creatorName: canSeeOperatorIdentity(auth.role) ? p.creatorName : undefined,
        customerCount: p._count.customers,
        usedVolumeM3: Math.round((volumeMap.get(p.id) ?? 0) * 1000) / 1000,
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
          take: MAX_CUSTOMERS_PER_PLAN,
          include: {
            client: { select: { id: true, name: true, phone: true, companyName: true } },
            prealerts: {
              orderBy: { createdAt: "asc" },
              take: 500,
              include: {
                items: { orderBy: { sortOrder: "asc" } },
                statusLogs: { orderBy: { createdAt: "desc" }, take: 50 },
              },
            },
          },
        },
      },
    });

    if (!plan) {
      fail(res, 404, "NOT_FOUND", "计划不存在");
      return;
    }

    // 计划已用方数：排除已取消的预报单
    const planUsedVolumeM3 =
      Math.round(
        plan.customers.reduce(
          (sum, c) =>
            sum +
            c.prealerts
              .filter((pa) => pa.status !== "cancelled")
              .reduce((s, pa) => s + pa.items.reduce((n, it) => n + toNum(it.volumeM3), 0), 0),
          0,
        ) * 1000,
      ) / 1000;

    ok(res, {
      id: plan.id,
      planNo: plan.planNo,
      warehouse: plan.warehouse,
      containerType: plan.containerType,
      destinationTh: plan.destinationTh,
      totalVolumeM3: toNum(plan.totalVolumeM3),
      usedVolumeM3: planUsedVolumeM3,
      status: plan.status,
      // 2026-09-15：创建人只给超级管理员（员工端计划详情也调这个接口）
      createdBy: canSeeOperatorIdentity(auth.role) ? plan.createdBy : undefined,
      creatorName: canSeeOperatorIdentity(auth.role) ? plan.creatorName : undefined,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
      customers: plan.customers.map((c) => {
        const prices = {
          unitPriceNormal: c.unitPriceNormal,
          unitPriceInspection: c.unitPriceInspection,
          unitPriceSensitive: c.unitPriceSensitive,
        };
        const breakdownByPrealert = new Map<string, ReturnType<typeof buildFeeBreakdown>>();
        for (const pa of c.prealerts) {
          breakdownByPrealert.set(pa.id, buildFeeBreakdown(pa.items, prices, pa.totalFee));
        }
        const customerBreakdown = mergeFeeBreakdowns(
          c.prealerts.filter((pa) => pa.status !== "cancelled").map((pa) => breakdownByPrealert.get(pa.id)!),
        );
        return {
        id: c.id,
        clientId: c.clientId,
        clientName: c.client.name,
        clientPhone: c.client.phone,
        clientCompany: c.client.companyName,
        unitPriceNormal: toNum(c.unitPriceNormal),
        unitPriceInspection: toNum(c.unitPriceInspection),
        unitPriceSensitive: toNum(c.unitPriceSensitive),
        totalVolumeM3: toNum(c.totalVolumeM3),
        totalFee: c.totalFee == null ? null : toNum(c.totalFee),
        feeBreakdown: customerBreakdown,
        deliveryAddress: c.deliveryAddress,
        totalPrealerts: c.totalPrealerts,
        totalPackages: c.totalPackages,
        totalItems: c.prealerts.reduce((sum, pa) => sum + pa.items.length, 0),
        // 客户级时间线不再重复下发一份，前端从 prealerts[].statusLogs 聚合即可
        prealerts: c.prealerts.map((pa) => ({
          id: pa.id,
          trackingNo: pa.trackingNo,
          expressNo: pa.expressNo,
          mark: pa.mark,
          status: pa.status,
          receivedAt: pa.receivedAt?.toISOString() ?? null,
          signedAt: pa.signedAt?.toISOString() ?? null,
          warehouseReceiptProofs: pa.warehouseReceiptProofs ?? [],
          totalFee: pa.totalFee == null ? null : toNum(pa.totalFee),
          feeBreakdown: breakdownByPrealert.get(pa.id) ?? null,
          paymentProofs: pa.paymentProofs ?? [],
          paymentProofUploadedAt: pa.paymentProofUploadedAt?.toISOString() ?? null,
          paymentReviewedAt: pa.paymentReviewedAt?.toISOString() ?? null,
          paymentRejectReason: pa.paymentRejectReason,
          thailandReceiptProofs: pa.thailandReceiptProofs ?? [],
          thailandReceivedAt: pa.thailandReceivedAt?.toISOString() ?? null,
          cancelReason: pa.cancelReason,
          cancelledAt: pa.cancelledAt?.toISOString() ?? null,
          createdAt: pa.createdAt.toISOString(),
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
        })),
        };
      }),
    });
  });

  // ==========================================================================
  // 4. 修改客户单价 —— 已停用（2026-09-16，确认单 4.4 / 4.7 / 4.19）
  //    柜里的单价跟着客户长期价走：湘泰自己的客户由超管在「客户管理」改，代理的客户由代理改，
  //    改完「计划中/收货中/装柜中」柜里没付款的单自动重算（long-term-price.ts）。
  //    这里留着路由回 410 + 人话，开着旧页面的人点了能看懂，而不是 404。
  // ==========================================================================
  /**
   * 2026-09-18 老板拍板恢复：柜里能单独改单价（「每次柜价格都不一样的」）。
   * 9-16 到 9-18 之间这个接口被停用过（那阵子改价走客户长期价），现在回到老规矩：
   * 只改传上来的那几档，改完这位客户**没付款**的单按新价重算（已付款的金额在付款那一刻就定死了）。
   */
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

    /**
     * ⚠️ 单价校验放在**碰数据库之前**（2026-08-29 第十轮复核）：参数不合法没必要先查库；
     * 更要紧的是「断开这道闸、金额测试照样全绿」—— 因为测试走到那里之前就被连库拦下了。
     */
    const updateData: Record<string, number> = {};
    const priceFields: Array<[string, string, number | undefined]> = [
      ["unitPriceNormal", "普货单价", body.unitPriceNormal],
      ["unitPriceInspection", "商检货单价", body.unitPriceInspection],
      ["unitPriceSensitive", "敏感货单价", body.unitPriceSensitive],
    ];
    for (const [field, label, raw] of priceFields) {
      if (raw == null) continue;
      // 0.001 也大于 0，但 Decimal(10,2) 会把它存成 0.00 —— 这一柜白送
      const issue = requireUnitPrice(raw, label);
      if (issue) {
        fail(res, 400, "BAD_REQUEST", issue);
        return;
      }
      updateData[field] = Number(raw);
    }
    if (Object.keys(updateData).length === 0) {
      fail(res, 400, "BAD_REQUEST", "至少需要修改一种单价");
      return;
    }

    /**
     * 事务外这次查只为早点给提示（说了算的是锁里那一次，CLAUDE.md #28）。
     * ⚠️ 只取 id / clientId：三档价拆成两步之后是**锁里重读**那一份说了算，
     * 这里再取一份只会让下一个人以为它还有用（Opus / DeepSeek 第四轮复核）。
     */
    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: body.customerId.trim(), planId: body.planId.trim(), companyId: auth.companyId },
      select: { id: true, clientId: true },
    });
    if (!customer) {
      fail(res, 404, "NOT_FOUND", "客户记录不存在");
      return;
    }

    // 改价 + 重算放同一个事务，避免只改了价没重算就崩了
    const result = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁序必须是【客户价排队锁 → agents FOR SHARE → 计划行】，跟本文件头和 long-term-price.ts 一致。
       * 上一版这里是「先锁计划、闸里才拿 agents」——跟改长期价那条路反着拿，
       * 再碰上「调高代理价」的 FOR UPDATE 排队，三方会绕成死锁（DeepSeek 第二轮复核第 3 条；
       * utils.ts 付款那条路早就踩过同一个坑）。
       *
       * ⚠️ 但**判断不能用事务外那份现价**（Opus 第三轮复核第 10 条）：这次只改一档、其余沿用现价，
       * 事务外读到的那两档可能已经被别人改低 → 用它判会把本来合法的这一档也拦下来，
       * 员工看到一条莫名其妙的报错。所以拆成两步：
       *   ① `lockAgentPriceFloors`：只按锁序把 agents 的共享锁拿到手、读出下限（不判断）；
       *   ② 锁完计划、重读柜里那一行之后，用**锁里的真值**判一次（`assertNotBelowAgentFloors`，不碰库）。
       */
      await lockClientWhrPrice(tx, customer.clientId);
      const floors = await lockAgentPriceFloors(tx, auth.companyId, [customer.clientId], auth.role);
      const mergedPrices = (row: { unitPriceNormal: unknown; unitPriceInspection: unknown; unitPriceSensitive: unknown }) => ({
        normal: updateData.unitPriceNormal ?? toNum(row.unitPriceNormal),
        inspection: updateData.unitPriceInspection ?? toNum(row.unitPriceInspection),
        sensitive: updateData.unitPriceSensitive ?? toNum(row.unitPriceSensitive),
      });

      await lockPlanAliveById(tx, body.planId!.trim());

      // 锁后重读这一行：事务外那次查只是提示，这中间客户可能已经被移出柜（复核第 7 条）
      const fresh = await tx.whrConsolidationPlanCustomer.findFirst({
        where: { id: customer.id, planId: body.planId!.trim(), companyId: auth.companyId },
        select: { id: true, clientId: true, unitPriceNormal: true, unitPriceInspection: true, unitPriceSensitive: true },
      });
      if (!fresh) throw new BusinessError("这个客户刚刚被移出这个柜了，请刷新后再看", 404, "NOT_FOUND");

      /**
       * 只有还在「计划中 / 收货中 / 装柜中」的柜能改价（`REPRICE_PLAN_STATUSES`，跟长期价那条路同一份名单）。
       * 已完成（每一票都泰国签收）的柜里单子都付过款了，改价不会改金额，只会让柜详情显示
       * 「付款后柜里单价改过」—— 看起来像账错了（复核第 8 条）；已取消的柜由 lockPlanAliveById 拦。
       * ⚠️ 别写成「已发运的柜不许改」：柜子的 `shipped` 状态**没有任何代码会写**（唯一写柜状态的是
       * utils.ts 的 syncPlanStatus，只写 collecting / loading / completed），货发运完柜状态还是 `loading`，
       * 所以**已发运的柜照样能改单价** —— 这跟 9-16 之前的老行为一致（Opus 第三轮复核第 1 条 d）。
       */
      const planRow = await tx.whrConsolidationPlan.findFirst({
        where: { id: body.planId!.trim(), companyId: auth.companyId },
        select: { status: true },
      });
      if (!planRow || !REPRICE_PLAN_STATUSES.includes(planRow.status)) {
        throw new BusinessError("这个柜已经走完了（柜里每一票都泰国签收），不能再改单价", 400, "BAD_REQUEST");
      }

      // 用**锁里重读**的那一行算出「改完之后的三档」，再拿上面锁好的下限判一次（不碰库）
      assertNotBelowAgentFloors(floors, [{ clientId: fresh.clientId, prices: mergedPrices(fresh) }], auth.role);

      await tx.whrConsolidationPlanCustomer.update({ where: { id: fresh.id }, data: updateData });
      // 跟长期价那条路同样两句（口径只有一份，见 long-term-price.ts）
      await recalcUnpaidPrealertFees(fresh.id, tx);
      const totals = await recalcCustomerTotals(fresh.id, tx);
      return { totalFee: totals.totalFee };
    }, { timeout: 30000, maxWait: 10000 });

    ok(res, { customerId: customer.id, totalFee: result.totalFee });
  });

  // ==========================================================================
  // 4b. 给已有计划新增参与客户（2026-08-07）
  //     原来客户只能在建计划时一次性选定，建完就再也加不进去了。
  // ==========================================================================
  app.post("/admin/whr-consolidation/customers/add", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    /**
     * 2026-09-18 老板拍板改回来：加客户时**当场填三档单价**（每个柜价格都不一样）。
     * 9-16 那套「按客户长期价自动带出」不再用，长期价的表和代码留着但没人读它定价。
     */
    const body = (req.body ?? {}) as {
      planId?: string;
      clientId?: string;
      unitPriceNormal?: number;
      unitPriceInspection?: number;
      unitPriceSensitive?: number;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.clientId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "请选择客户");
      return;
    }
    const clientId = body.clientId.trim();

    const priceChecks: Array<[string, number | undefined]> = [
      ["普货单价", body.unitPriceNormal],
      ["商检货单价", body.unitPriceInspection],
      ["敏感货单价", body.unitPriceSensitive],
    ];
    const prices: Record<string, number> = {};
    for (const [label, raw] of priceChecks) {
      const issue = raw == null ? `${label}为必填` : requireUnitPrice(raw, label);
      if (issue) {
        fail(res, 400, "BAD_REQUEST", issue);
        return;
      }
      prices[label] = Number(raw);
    }
    const price = {
      normal: prices["普货单价"],
      inspection: prices["商检货单价"],
      sensitive: prices["敏感货单价"],
    };

    const plan = await prisma.whrConsolidationPlan.findFirst({
      where: { id: body.planId.trim(), companyId: auth.companyId },
      select: { id: true, status: true },
    });
    if (!plan) {
      fail(res, 404, "NOT_FOUND", "拼柜计划不存在");
      return;
    }
    // 已经装柜/发运/完成/取消的计划不能再往里塞人，否则费用和方数都对不上了
    if (!["planning", "collecting"].includes(plan.status)) {
      fail(res, 400, "BAD_REQUEST", "该计划已开始装柜或已发运，不能再新增客户");
      return;
    }

    const client = await prisma.user.findFirst({
      where: { id: clientId, companyId: auth.companyId, role: "client" },
      select: { id: true },
    });
    if (!client) {
      fail(res, 400, "BAD_REQUEST", "客户不存在或不属于本公司");
      return;
    }

    const exists = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId: plan.id, clientId, companyId: auth.companyId },
      select: { id: true },
    });
    if (exists) {
      fail(res, 400, "BAD_REQUEST", "该客户已在这个计划里，不能重复添加");
      return;
    }

    /**
     * ⚠️ 查重 + 插入放进同一个事务并先锁计划行（2026-08-31 补，排查报告第 27 条）。
     * 原来是「事务外查他在不在 → 直接插」两步走：两个员工同时给同一个柜加
     * 同一个客户（或一个人开两个页面），两边都查到「不在」，就会插出两行 ——
     * 客户的预报单会随机挂在其中一行上，「我的详情」页只显示一行，改价也只改到一行。
     * 上面事务外那道查重只配当「早点给个好看的提示」，说了算的是锁里这一道。
     * 数据库层的「柜 + 客户」唯一约束要动表结构，另行安排，这里先用锁把口子堵上。
     */
    const created = await prisma.$transaction(async (tx) => {
      // 锁序：客户价排队锁 → 代理价下限（agents FOR SHARE）→ 计划行（顺便拦已取消的柜）
      await lockClientWhrPrice(tx, clientId);
      await assertPlanPricesNotBelowAgent(tx, auth.companyId, [{ clientId, prices: price }], auth.role);
      await lockPlanAliveById(tx, plan.id);

      // 锁完重读计划状态：事务外那道「不能再新增客户」的检查只配当提示
      const freshPlan = await tx.whrConsolidationPlan.findUnique({
        where: { id: plan.id },
        select: { status: true },
      });
      if (!freshPlan || !["planning", "collecting"].includes(freshPlan.status)) {
        throw new BusinessError("该计划刚刚被别人操作过（已开始装柜或已发运），不能再新增客户，请刷新后再看");
      }

      const dup = await tx.whrConsolidationPlanCustomer.findFirst({
        where: { planId: plan.id, clientId, companyId: auth.companyId },
        select: { id: true },
      });
      if (dup) {
        throw new BusinessError("该客户已在这个计划里，不能重复添加");
      }

      const liveCount = await tx.whrConsolidationPlanCustomer.count({
        where: { planId: plan.id, companyId: auth.companyId },
      });
      if (liveCount >= MAX_CUSTOMERS_PER_PLAN) {
        throw new BusinessError(`一个计划最多 ${MAX_CUSTOMERS_PER_PLAN} 个客户`);
      }

      const row = await tx.whrConsolidationPlanCustomer.create({
        data: {
          planId: plan.id,
          companyId: auth.companyId,
          clientId,
          unitPriceNormal: price.normal,
          unitPriceInspection: price.inspection,
          unitPriceSensitive: price.sensitive,
        },
        select: { id: true },
      });
      return { id: row.id, price };
    });

    // 回的是锁里真正写进去的价（员工也看得到柜里单价，这不是代理信息）
    ok(res, {
      customerId: created.id,
      unitPriceNormal: created.price.normal,
      unitPriceInspection: created.price.inspection,
      unitPriceSensitive: created.price.sensitive,
    });
  });

  // ==========================================================================
  // 4b-2. 客户长期价一览（2026-09-16，建柜 / 新增客户弹窗用，管理员和员工都能调）
  //       只回「客户 id + 三档价」，**不回所属代理、不回谁填的**（确认单 4.6：员工那边不标代理）。
  //       没填价的客户不在 items 里，前端据此显示「暂未配对价格，请联系管理员」。
  // ==========================================================================
  app.get("/admin/whr-consolidation/client-prices", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const rows = await prisma.clientWhrPrice.findMany({
      where: { companyId: auth.companyId, client: { companyId: auth.companyId, role: "client" } },
      select: { clientId: true, priceNormal: true, priceInspection: true, priceSensitive: true },
      orderBy: { clientId: "asc" },
    });
    ok(res, {
      items: rows.map((r) => ({
        clientId: r.clientId,
        unitPriceNormal: toNum(r.priceNormal),
        unitPriceInspection: toNum(r.priceInspection),
        unitPriceSensitive: toNum(r.priceSensitive),
      })),
    });
  });

  // ==========================================================================
  // 4b-3. 超管替客户填泰国收货地址（2026-09-16，确认单 3.12）
  //       代理把地址给超管，超管在柜详情里填。规则照客户自己填那条（client-routes.ts）：
  //       这位客户在这个柜里已有货物发运 / 到泰国签收，就不许再改。
  // ==========================================================================
  app.post("/admin/whr-consolidation/address", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; customerId?: string; deliveryAddress?: string };
    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    const customerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
    const address = typeof body.deliveryAddress === "string" ? body.deliveryAddress.trim() : "";
    if (!planId) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!customerId) {
      fail(res, 400, "BAD_REQUEST", "customerId 为必填");
      return;
    }
    if (!address) {
      fail(res, 400, "BAD_REQUEST", "收货地址为必填");
      return;
    }
    if (address.length > 500) {
      fail(res, 400, "BAD_REQUEST", "收货地址过长（最多 500 字）");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: customerId, planId, companyId: auth.companyId },
      select: { id: true },
    });
    if (!customer) {
      fail(res, 404, "NOT_FOUND", "这个柜里没有这位客户");
      return;
    }

    const saved = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 先锁计划再判「发没发运」（CLAUDE.md #28）：发运确认那条路也是先锁计划再改预报单，
       * 两边排队之后，这里重查到的一定是最新状态，不会出现「刚发运完地址又被改了」。
       */
      const planRows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM whr_consolidation_plans WHERE id = ${planId} FOR UPDATE`;
      if (!planRows || planRows.length === 0) throw new BusinessError("找不到这个柜（可能已被删除）", 404, "NOT_FOUND");
      if (planRows[0].status === "cancelled") throw new BusinessError("这个柜已经取消了，不用再填地址");
      // 锁住之后重查这位客户还在不在柜里：事务外查到之后可能刚被员工移出柜，
      // 不查就去改会撞上「这一行没了」变成服务器错误（2026-09-15，Codex 第二轮 O1-R1）
      const current = await tx.whrConsolidationPlanCustomer.findFirst({
        where: { id: customer.id, planId, companyId: auth.companyId },
        select: { id: true },
      });
      if (!current) throw new BusinessError("这位客户刚刚被移出这个柜了，请刷新后再看", 404, "NOT_FOUND");
      const shipped = await tx.whrConsolidationPrealert.count({
        where: { customerId: current.id, status: { in: WHR_SHIPPED_PREALERT_STATUSES } },
      });
      if (shipped > 0) {
        throw new BusinessError("这位客户在这个柜里已有货物发运，收货地址不能再改");
      }
      await tx.whrConsolidationPlanCustomer.update({
        where: { id: current.id },
        data: { deliveryAddress: address },
      });
      return address;
    });

    logger.info("超管替客户填泰国收货地址（仓库版）", { 操作人: auth.userId, 柜: planId, 计划客户: customer.id });
    ok(res, { customerId: customer.id, deliveryAddress: saved });
  });

  // ==========================================================================
  // 4c. 从计划里移除参与客户（2026-08-07）
  //     ⚠️ 数据库对 whr_consolidation_prealerts 设的是 onDelete: Cascade，
  //     删这一行会把该客户的预报单、货物明细、产品图、状态日志全部级联删掉。
  //     所以名下只要还有任何一条预报单（含已取消的）就一律不让删。
  // ==========================================================================
  app.post("/admin/whr-consolidation/customers/remove", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; customerId?: string };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.customerId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "customerId 为必填");
      return;
    }

    const plan = await prisma.whrConsolidationPlan.findFirst({
      where: { id: body.planId.trim(), companyId: auth.companyId },
      select: { id: true, status: true },
    });
    if (!plan) {
      fail(res, 404, "NOT_FOUND", "拼柜计划不存在");
      return;
    }
    // 货已经发走了，参与名单就不该再动 —— 和「新增客户」用同一条口径
    if (!["planning", "collecting"].includes(plan.status)) {
      fail(res, 400, "BAD_REQUEST", "该计划已开始装柜或已发运，不能再移除客户");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: body.customerId.trim(), planId: plan.id, companyId: auth.companyId },
      select: { id: true, clientId: true },
    });
    if (!customer) {
      fail(res, 404, "NOT_FOUND", "客户记录不存在");
      return;
    }

    const prealertCount = await prisma.whrConsolidationPrealert.count({
      where: { customerId: customer.id },
    });
    if (prealertCount > 0) {
      fail(
        res,
        400,
        "BAD_REQUEST",
        `该客户名下还有 ${prealertCount} 个预报单，删除会把这些单据连同货物明细、产品图一起删掉。请先逐个取消这些预报单，或者保留该客户。`,
      );
      return;
    }

    /**
     * ⚠️ 上面几道检查都在事务外面，只配当「早点给个好看的提示」（2026-09-15，Codex 审查 O1，改动前就有的缝）。
     * 原来数完「没有预报单」就直接删：数完那一刻客户正好新建了一张预报单，这一删会被数据库级联连带删掉 ——
     * 客户刚建的单凭空消失。客户建预报单那条路先锁计划行（client-routes.ts lockPlanAliveById），
     * 这里也先锁计划行，两边排上队；锁住之后重读计划状态、重查客户记录、重数预报单，说了算的是锁里这一次。
     */
    const removed = await prisma.$transaction(async (tx) => {
      const planRows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM whr_consolidation_plans WHERE id = ${plan.id} FOR UPDATE`;
      if (!planRows || planRows.length === 0) {
        throw new BusinessError("拼柜计划不存在", 404, "NOT_FOUND");
      }
      if (!["planning", "collecting"].includes(planRows[0].status)) {
        throw new BusinessError("该计划刚刚被别人操作过（已开始装柜或已发运），不能再移除客户，请刷新后再看");
      }
      const stillThere = await tx.whrConsolidationPlanCustomer.findFirst({
        where: { id: customer.id, planId: plan.id, companyId: auth.companyId },
        select: { id: true },
      });
      if (!stillThere) {
        throw new BusinessError("客户记录不存在（可能刚被别人移除了），请刷新后再看", 404, "NOT_FOUND");
      }
      const countInLock = await tx.whrConsolidationPrealert.count({ where: { customerId: customer.id } });
      if (countInLock > 0) {
        throw new BusinessError(
          `该客户名下刚刚新建了预报单（现有 ${countInLock} 个），删除会把这些单据连同货物明细、产品图一起删掉。请先逐个取消这些预报单，或者保留该客户。`,
        );
      }
      await tx.whrConsolidationPlanCustomer.delete({ where: { id: customer.id } });
      return { removed: true, clientId: customer.clientId };
    });

    ok(res, removed);
  });

  // ==========================================================================
  // 4d. 撤销付款并退款（2026-08-07）
  //     客户在集货里付款是当场扣余额、不可撤销的，这里是唯一的后手：
  //     客户点错了，管理员把钱退回集货余额、单子回到「待付款」，客户可重付。
  //     退多少不看当前报价，看流水里**实际扣过**的钱 —— 报价后来改过也不会退错。
  // ==========================================================================
  app.post("/admin/whr-consolidation/payments/revoke", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { prealertId?: string; reason?: string };
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: { id: body.prealertId.trim(), companyId: auth.companyId },
      include: { planCustomer: { select: { clientId: true } } },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    // 这里只做「早点给个好看的提示」，真正说了算的判断在下面事务里重做一遍。
    if (prealert.status !== "paid") {
      fail(res, 400, "BAD_REQUEST", "只有「已付款」的预报单能撤销；已装柜或已发运的不能退");
      return;
    }

    const { balanceAfter, refundable, repricedFee, paidFee } = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 先锁子单，再退款（2026-08-27 补）。
       * 全模块统一锁序是【计划 → 子单 → 钱包】。这里原来直接退款，
       * 等于「先锁钱包、后锁子单」—— 跟付款那条路正好反着，
       * 两边同时发生就是死锁（外部复审用真实 PostgreSQL 行锁复现过 40P01）。
       *
       * ⚠️ 2026-09-15 起还要**先锁计划**：撤销完要按现价重算这张单和客户汇总（写 plan_customers，见下面），
       * 改长期价那条路是「计划 → plan_customers → 预报单」，这里不先锁计划就会跟它交叉。
       * 用「只锁不判死活」的版本 —— 柜作废了也得能退钱（plan-guard.ts 文件头）。
       */
      await lockPlanByPrealert(tx, prealert.id);
      await tx.$queryRaw`SELECT id FROM whr_consolidation_prealerts WHERE id = ${prealert.id} FOR UPDATE`;

      /**
       * ⚠️ 状态和退款金额必须锁完再算（2026-08-27 补）。
       * 原来这两样都在事务外面读：两个管理员同时点「撤销」，两边都读到
       * 「已付款 / 可退 400」，行锁只是让他们排队，第二个照样拿着旧数字
       * 再退一次 —— 客户白拿 400。现在锁住之后重新读一遍，第二个会看到
       * 状态已经变了、可退金额是 0，直接被拦下。
       */
      const nowRow = await tx.whrConsolidationPrealert.findUnique({
        where: { id: prealert.id },
        select: { status: true, totalFee: true },
      });
      if (!nowRow) throw new BusinessError("预报单不存在", 404, "NOT_FOUND");
      if (nowRow.status !== "paid") {
        throw new BusinessError("这张预报单刚刚被别人改过状态了，撤销没有执行，请刷新后再看");
      }

      // 实际净扣金额 = 流水里这单的 pay（负数）和 refund（正数）相加后取反
      const rows = await tx.consolidationBalanceLedger.findMany({
        where: { refType: "whr", refId: prealert.id },
        select: { amount: true },
      });
      const refundable = -rows.reduce((sum, r) => sum + Number(r.amount), 0);
      if (!(refundable > 0)) {
        throw new BusinessError("这张预报单没有可退的金额（可能刚刚已经退过了）");
      }

      await tx.whrConsolidationPrealert.update({
        where: { id: prealert.id },
        // 撤销付款清空付款快照（2026-09-16，确认单 4.14）：再付款时按那一刻的价重新记
        data: { status: "received_pending_payment", paymentReviewedAt: null, ...CLEARED_PAID_SNAPSHOT } as any,
      });

      /**
       * ⚠️ 回到「待付款」就按柜里现在的单价重算（2026-09-15，Codex 审查 P1-1 实测复现）。
       * 付款之后长期价改过的话，改价那边只改柜里的单价、不动已付款的金额（4.14）。原来这里只退钱改状态，
       * 金额还是旧价算的 1300；客户重付扣 1300，付款快照却按柜里的新价记，返现按 1700 那套价算成 600 ——
       * 扣的钱和记的价对不上。现在跟别的没付款的单一样按现价重算（4.4），重付时扣的钱和快照是同一个价。
       * 顺序照锁序：预报单 → 客户汇总（plan_customers）→ 最后才碰钱包。
       */
      const paidFee = nowRow.totalFee == null ? 0 : Number(nowRow.totalFee);
      const repricedFee = await recalcPrealertFee(prealert.id, tx);
      await recalcCustomerTotals(prealert.customerId, tx);

      const after = await refundToConsolidation(tx as any, {
        companyId: auth.companyId,
        clientId: prealert.planCustomer.clientId,
        amount: refundable,
        refType: "whr",
        refId: prealert.id,
        refNo: prealert.trackingNo,
        remark: body.reason?.trim() ? `管理员撤销付款：${body.reason.trim()}` : "管理员撤销付款",
        operatorId: auth.userId,
        operatorName: auth.name || auth.userId,
      });
      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: "admin",
          operatorName: auth.name || auth.userId,
          fromStatus: "paid",
          toStatus: "received_pending_payment",
          remark: `管理员撤销付款，退回集货余额 ¥${refundable.toFixed(2)}${body.reason?.trim() ? `（${body.reason.trim()}）` : ""}`,
        },
      });
      return { balanceAfter: after, refundable, repricedFee, paidFee };
    });

    const repriced = Math.abs(repricedFee - paidFee) >= 0.005;
    ok(res, {
      prealertId: prealert.id,
      refunded: refundable,
      balanceAfter,
      status: "received_pending_payment",
      totalFee: repricedFee,
      message: repriced
        ? `已退回 ¥${refundable.toFixed(2)} 到客户集货余额，单子回到待付款；付款后单价改过，重新付款按现在的单价 ¥${repricedFee.toFixed(2)}`
        : `已退回 ¥${refundable.toFixed(2)} 到客户集货余额，单子回到待付款`,
    });
  });

  // ==========================================================================
  // 5. 审核付款（预报单级别）
  // ==========================================================================
  app.post("/admin/whr-consolidation/prealerts/review", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    /**
     * 2026-09-16：拒绝时「顺带改单价」去掉了（确认单 4.4：单价跟长期价走，柜里不再单独改价）。
     * 旧页面传来的 unitPrice* 一律不认。这条审核流程本来就走不到（没有任何地方写 payment_submitted）。
     */
    const body = (req.body ?? {}) as {
      planId?: string;
      prealertId?: string;
      action?: string;
      rejectReason?: string;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    if (!body.action || !["approve", "reject"].includes(body.action)) {
      fail(res, 400, "BAD_REQUEST", "action 必须是 approve 或 reject");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      select: { id: true, status: true, customerId: true },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (prealert.status !== "payment_submitted") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可审核，仅待审核状态可操作");
      return;
    }

    if (body.action === "approve") {
      await prisma.$transaction(async (tx) => {
        // ⚠️ 整柜取消了就不该再把单子改成「已付款」（2026-08-27 补）。
        // 这条路第一版被我漏掉了 —— 外部复审实测：取消父柜之后
        // approve 仍能把子单改成 paid，reject 仍能改单价并重算费用。
        await lockPlanAliveByPrealert(tx, prealert.id);

        /**
         * ⚠️ 上面的锁只管住了**父柜**，这张单自己的状态还是事务外面读的（2026-08-27 补）。
         * 后果：单子在这几毫秒里被人取消了，审核照样能把它改回去 ——
         * 一张已取消的单突然又变成「已付款」，账目上凭空多一笔。
         */
        const freshA = await tx.whrConsolidationPrealert.findUnique({
          where: { id: prealert.id },
          select: { status: true, totalFee: true },
        });
        if (!freshA) throw new BusinessError("预报单不存在", 404, "NOT_FOUND");
        if (freshA.status !== "payment_submitted") {
          throw new BusinessError("这张预报单刚刚被别人处理过了，审核没有执行，请刷新后再看");
        }

        // 付款生效这一刻记价格快照（确认单 4.14），跟客户余额付款那条路同一个函数；
        // 单子上的金额也交进去核对，代理客户的单跟柜里单价对不上就拦下（2026-09-15，见 buildPaidSnapshot）
        const snapshot = await buildPaidSnapshot(prealert.id, tx, freshA.totalFee == null ? 0 : Number(freshA.totalFee));
        await tx.whrConsolidationPrealert.update({
          where: { id: prealert.id },
          data: {
            status: "paid",
            paymentReviewedAt: new Date(),
            paymentReviewedBy: auth.userId,
            paymentRejectReason: null,
            ...snapshot,
          },
        });
        await tx.whrConsolidationStatusLog.create({
          data: {
            prealertId: prealert.id,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: auth.role,
            operatorName: auth.name || auth.userId,
            fromStatus: "payment_submitted",
            toStatus: "paid",
            remark: "审核通过",
          },
        });
        await recalcCustomerTotals(prealert.customerId, tx);
        await syncPlanStatus(body.planId!, tx);
        return true;
      });
      ok(res, { prealertId: prealert.id, status: "paid" });
      return;
    }

    // ---- 拒绝 ----
    if (!body.rejectReason?.trim()) {
      fail(res, 400, "BAD_REQUEST", "拒绝原因为必填");
      return;
    }
    if (body.rejectReason.trim().length > 500) {
      fail(res, 400, "BAD_REQUEST", "拒绝原因过长");
      return;
    }

    const rejectResult = await prisma.$transaction(async (tx) => {
      // ⚠️ reject 会重算费用，同样要拦（2026-08-27 补）
      await lockPlanAliveByPrealert(tx, prealert.id);

      /**
       * ⚠️ 上面的锁只管住了**父柜**，这张单自己的状态还是事务外面读的（2026-08-27 补）。
       * 后果：单子在这几毫秒里被人取消了，审核照样能把它改回去 ——
       * 一张已取消的单突然又变成「已付款」，账目上凭空多一笔。
       */
      const freshB = await tx.whrConsolidationPrealert.findUnique({
        where: { id: prealert.id },
        select: { status: true },
      });
      if (!freshB) throw new BusinessError("预报单不存在", 404, "NOT_FOUND");
      if (freshB.status !== "payment_submitted") {
        throw new BusinessError("这张预报单刚刚被别人处理过了，审核没有执行，请刷新后再看");
      }

      await tx.whrConsolidationPrealert.update({
        where: { id: prealert.id },
        data: {
          status: "received_pending_payment",
          paymentRejectReason: body.rejectReason!.trim(),
          paymentProofs: [] as any,
          paymentProofUploadedAt: null,
          paymentReviewedAt: new Date(),
          paymentReviewedBy: auth.userId,
        } as any,
      });

      // 退回待付款，按柜里现在的单价（跟着长期价走）重算这张单的应付金额
      const newFee = await recalcPrealertFee(prealert.id, tx);
      await recalcCustomerTotals(prealert.customerId, tx);

      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "payment_submitted",
          toStatus: "received_pending_payment",
          remark: `审核不通过；${body.rejectReason!.trim()}`,
        },
      });

      return { newFee };
    });

    ok(res, {
      prealertId: prealert.id,
      status: "received_pending_payment",
      totalFee: rejectResult.newFee,
    });
  });

  // ==========================================================================
  // 6. 取消预报单资格（装柜前任何状态均可取消，取消后释放方数）
  // ==========================================================================
  app.post("/admin/whr-consolidation/prealerts/cancel", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      prealertId?: string;
      cancelReason?: string;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    if (!body.cancelReason?.trim()) {
      fail(res, 400, "BAD_REQUEST", "取消原因为必填");
      return;
    }
    if (body.cancelReason.trim().length > 500) {
      fail(res, 400, "BAD_REQUEST", "取消原因过长");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      select: { id: true, status: true, customerId: true },
    });

    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }

    if (NON_CANCELLABLE_STATUSES.includes(prealert.status)) {
      fail(
        res,
        400,
        "BAD_REQUEST",
        prealert.status === "cancelled"
          ? "该预报单已取消，无需重复操作"
          : "该预报单已装柜，不能再取消",
      );
      return;
    }

    const previousStatus = prealert.status;

    const totals = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 必须**先锁计划、再锁子单**（2026-08-27 补）。
       * 取消这条路后面会调 syncPlanStatus 去改计划行；如果先锁子单，
       * 就跟「删除整柜」那条路（计划 → 子单）正好反着，两个人同时操作就是死锁。
       * 这里用的是「只锁不判死活」的版本：柜子已经作废了，底下的单子照样要能取消。
       */
      await lockPlanByPrealert(tx, prealert.id);

      // 锁住再复查一遍状态（2026-08-27 补）：上面那次判断是在事务外面做的，
      // 两个人同时点「取消」都能过。退款金额是在锁里算的所以钱不会退两次，
      // 但会平白多出一条重复的取消记录和一次重复通知，所以这里把第二个人挡掉。
      await tx.$queryRaw`SELECT id FROM whr_consolidation_prealerts WHERE id = ${prealert.id} FOR UPDATE`;
      const fresh = await tx.whrConsolidationPrealert.findUnique({
        where: { id: prealert.id },
        select: { status: true },
      });
      if (!fresh) throw new BusinessError("预报单不存在", 404, "NOT_FOUND");
      if (NON_CANCELLABLE_STATUSES.includes(fresh.status)) {
        throw new BusinessError(
          fresh.status === "cancelled"
            ? "该预报单已取消，无需重复操作"
            : "该预报单已装柜，不能再取消",
        );
      }

      await tx.whrConsolidationPrealert.update({
        where: { id: prealert.id },
        data: {
          status: "cancelled",
          cancelReason: body.cancelReason!.trim(),
          cancelledAt: new Date(),
          // 2026-09-16：已付款的单作废时下面会把钱退回去，付款快照跟「撤销付款」一样清掉，
          // 免得一张退了钱的单还挂着返现金额（返现单只算泰国签收的，这里清掉是让数据自己说得通）
          ...CLEARED_PAID_SNAPSHOT,
        },
      });

      /**
       * ⚠️ 已经收过钱的单，作废时必须**在同一个事务里把钱退回去**（2026-08-27 补）。
       *
       * 原来的洞（外部复审实测）：`paid` 状态是允许取消的，取消只把状态改掉、
       * 费用清零，**余额和流水一动不动** —— 客户的钱就这么留在公司账上。
       * 更麻烦的是取消之后状态变成 cancelled，「撤销付款」那条路会因为状态不对返回 400，
       * **退款入口被彻底封死**，只能手工去数据库改。
       *
       * 退多少：把这张单的 pay(负) 和 refund(正) 加起来取反 —— 已经退过的不会重复退，
       * 跟「删除单据时退款」用的是同一套算法。
       */
      const pending = await computePendingRefunds(tx as any, [{ refType: "whr", refId: prealert.id }]);
      if (pending.length > 0) {
        await refundPendingOnDelete(tx as any, {
          companyId: auth.companyId,
          refType: "whr",
          refId: prealert.id,
          refunds: pending,
          remark: `作废预报单退款（${body.cancelReason!.trim()}）`,
          operatorId: auth.userId,
          operatorName: auth.name || auth.userId,
        });
      }

      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          // 用锁内重查到的状态（2026-08-28 改）：previousStatus 是事务外读的那份，
          // 加了锁后复查之后，真正说了算的是 fresh.status
          fromStatus: fresh.status,
          toStatus: "cancelled",
          remark: body.cancelReason!.trim(),
        },
      });

      // 取消的单费用清 0，然后重算客户的方数/件数/单数/费用 —— 这才是真正的「释放方数」
      await recalcPrealertFee(prealert.id, tx);
      const t = await recalcCustomerTotals(prealert.customerId, tx);
      await syncPlanStatus(body.planId!, tx);
      return t;
    });

    ok(res, {
      prealertId: prealert.id,
      status: "cancelled",
      customerVolume: totals.totalVolumeM3,
      customerTotalFee: totals.totalFee,
      customerPrealerts: totals.totalPrealerts,
    });
  });

  // ==========================================================================
  // 9b. 管理员改单件货物的货型（仓库版，2026-08-15 新增）
  //     客户报单时经常把商检/敏感报成普货，仓库收货才发现。
  //     2026-09-16 起：改完没付款的单按新货型自动重算金额（柜里「改单价」停用了，不自动算就没人能调）。
  // ==========================================================================
  app.post("/admin/whr-consolidation/prealerts/item-cargo-type", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { itemId?: string; cargoType?: string };

    if (!body.itemId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "itemId 为必填");
      return;
    }
    if (!body.cargoType || !CARGO_TYPES.includes(body.cargoType)) {
      fail(res, 400, "BAD_REQUEST", "货型不合法");
      return;
    }

    const item = await prisma.whrConsolidationPrealertItem.findFirst({
      where: { id: body.itemId, companyId: auth.companyId },
      select: {
        id: true,
        productName: true,
        cargoType: true,
        prealert: { select: { id: true, status: true, customerId: true } },
      },
    });

    if (!item) {
      fail(res, 404, "NOT_FOUND", "货物明细不存在");
      return;
    }
    if (!ITEM_EDITABLE_STATUSES.includes(item.prealert.status)) {
      fail(res, 400, "BAD_REQUEST", "该预报单客户已付款或已进入装柜流程，货型不能再改");
      return;
    }
    if (item.cargoType === body.cargoType) {
      fail(res, 400, "BAD_REQUEST", "货型没有变化");
      return;
    }

    const toZh = CARGO_TYPE_ZH[body.cargoType]!;

    const cargoResult = await prisma.$transaction(async (tx) => {
      // ⚠️ 整柜取消了就不该再动这张单；锁序【计划 → 预报单】，
      // 照紧挨着的 9c 删货物接口的锁法（2026-08-31 补，排查报告第 28 条）
      await lockPlanAliveByPrealert(tx, item.prealert.id);

      /**
       * ⚠️ 这张单的状态和这件货的货型也要**锁完重查**（2026-08-31 补，排查报告第 28 条）。
       * 上面那道「已付款不能改」的检查在事务外面：客户点付款的同一瞬间管理员点改货型，
       * 两边都拿进门时那份旧状态判断，一张已付款的单子货型照样被改掉 ——
       * 客户付的是普货的钱，单子上却写着商检，对账时说不清。
       * 货型也重读：另一个管理员刚改过的话，日志里的「由X改为Y」才不会写错。
       */
      const freshItem = await tx.whrConsolidationPrealertItem.findUnique({
        where: { id: item.id },
        select: { cargoType: true, prealert: { select: { status: true } } },
      });
      if (!freshItem) {
        throw new BusinessError("货物明细刚刚被别人删除了，货型没有改，请刷新后再看", 404, "NOT_FOUND");
      }
      if (!ITEM_EDITABLE_STATUSES.includes(freshItem.prealert.status)) {
        throw new BusinessError("这张预报单刚刚被别人处理过了（已付款或已进入装柜流程），货型没有改，请刷新后再看");
      }
      if (freshItem.cargoType === body.cargoType) {
        throw new BusinessError("货型没有变化（可能刚被别人改过），请刷新后再看");
      }
      const fromZh = CARGO_TYPE_ZH[freshItem.cargoType] ?? freshItem.cargoType;

      await tx.whrConsolidationPrealertItem.update({
        where: { id: item.id },
        data: { cargoType: body.cargoType! },
      });

      /**
       * 2026-09-16 改：**没付款的单按新货型重算金额**（原来 08-15 拍板「故意不重算、要调自己改单价」）。
       * 柜里「改单价」停用了，不自动算的话这张单的钱就没人能调了。
       * 能走到这里的一定是锁里重查过的「待签收 / 待付款」，已付款的单根本进不来，金额不会被动。
       * 方数、件数不受影响：换货型不改长宽高，也不改件数。
       */
      const newFee = await recalcPrealertFee(item.prealert.id, tx);
      const totals = await recalcCustomerTotals(item.prealert.customerId, tx);

      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: item.prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: freshItem.prealert.status,
          toStatus: freshItem.prealert.status,
          remark:
            freshItem.prealert.status === "received_pending_payment"
              ? `管理员把「${item.productName}」的货型由${fromZh}改为${toZh}，应付金额按新货型重算为 ¥${newFee}`
              : `管理员把「${item.productName}」的货型由${fromZh}改为${toZh}`,
        },
      });
      return { newFee, status: freshItem.prealert.status, customerTotalFee: totals.totalFee };
    });

    ok(res, {
      itemId: item.id,
      cargoType: body.cargoType,
      // 真算出来、真写进去的金额（CLAUDE.md #28 ④）
      prealertStatus: cargoResult.status,
      totalFee: cargoResult.newFee,
      customerTotalFee: cargoResult.customerTotalFee,
    });
  });

  // ==========================================================================
  // 9c. 管理员删单件货物明细（仓库版，2026-08-15 新增）
  //     原来只能删整张预报单，客户多报一件就得整张作废重来。
  //     ⚠️ 这是删数据，删完方数和金额都会变，界面必须先弹窗说清楚影响。
  // ==========================================================================
  app.post("/admin/whr-consolidation/prealerts/item-delete", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { itemId?: string };

    if (!body.itemId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "itemId 为必填");
      return;
    }

    const item = await prisma.whrConsolidationPrealertItem.findFirst({
      where: { id: body.itemId, companyId: auth.companyId },
      select: {
        id: true,
        productName: true,
        packageCount: true,
        prealert: {
          select: {
            id: true,
            status: true,
            customerId: true,
            _count: { select: { items: true } },
          },
        },
      },
    });

    if (!item) {
      fail(res, 404, "NOT_FOUND", "货物明细不存在");
      return;
    }
    if (!ITEM_EDITABLE_STATUSES.includes(item.prealert.status)) {
      fail(res, 400, "BAD_REQUEST", "该预报单客户已付款或已进入装柜流程，货物不能再删");
      return;
    }
    // 最后一件不给删：空预报单签收时会被挡住，留一张删不掉又签不了的单更麻烦。
    // 整张不要了要走「取消预报单」，那条路会清费用、退方数、写流转记录。
    if (item.prealert._count.items <= 1) {
      fail(res, 400, "BAD_REQUEST", "这是该预报单最后一件货物，不能删。整张不要了请用「取消预报单」");
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      // ⚠️ 整柜取消了就不该再动这张单（2026-08-27 第二版：挪进事务并加锁）
      await lockPlanAliveByPrealert(tx, item.prealert.id);

      /**
       * ⚠️ 这张单自己的状态和剩余件数也要**锁完重查**（2026-08-27 补）。
       * 上面那两道检查在事务外面：客户正好在这一刻付了款，货照样被删掉，
       * 而金额是按删之前的货算的 —— 客户付了 5 件的钱只收到 4 件。
       * 「最后一件」那道也一样，两个人同时删不同的货，能把单子删空。
       */
      const freshPa = await tx.whrConsolidationPrealert.findUnique({
        where: { id: item.prealert.id },
        select: { status: true, _count: { select: { items: true } } },
      });
      if (!freshPa) throw new BusinessError("预报单不存在", 404, "NOT_FOUND");
      if (!ITEM_EDITABLE_STATUSES.includes(freshPa.status)) {
        throw new BusinessError("该预报单客户已付款或已进入装柜流程，货物不能再删");
      }
      if (freshPa._count.items <= 1) {
        throw new BusinessError("这是该预报单最后一件货物，不能删。整张不要了请用「取消预报单」");
      }

      await tx.whrConsolidationPrealertItem.delete({ where: { id: item.id } });

      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: item.prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: item.prealert.status,
          toStatus: item.prealert.status,
          remark: `管理员删除了货物「${item.productName}」（${item.packageCount}件）`,
        },
      });

      /**
       * 2026-09-16 改：**没付款的单按剩下的货重算金额**，再汇总到客户（原来 08-15 拍板「不重算金额」）。
       * 柜里「改单价」停用了，不自动算的话多收的钱就没人能调了。
       * 能走到这里的一定是锁里重查过的「待签收 / 待付款」，已付款的单进不来。
       * 界面弹窗和提示文字同步改了（admin/whr-consolidation/page.tsx）。
       */
      const newFee = await recalcPrealertFee(item.prealert.id, tx);
      const totals = await recalcCustomerTotals(item.prealert.customerId, tx);
      return { totals, newFee, status: freshPa.status };
    });

    ok(res, {
      itemId: item.id,
      customerVolume: result.totals.totalVolumeM3,
      prealertStatus: result.status,
      totalFee: result.newFee,
    });
  });

  /**
   * 删除整个集货计划（仓库版，管理员，2026-08-07 新增）。
   *
   * ⚠️ 级联链最长的一个：
   *   计划 → 计划客户(Cascade) → 预报单(Cascade) → 货物明细 + 状态日志(Cascade)
   * 删一个计划 = 上面全部一起没。CLAUDE.md 第 2.6 条特意警告过这条链。
   *
   * 安全规则（用户 2026-08-07 定）：默认拦住已经开始走流程的，
   * 要删必须带管理员密码强删。判定复用 NON_CANCELLABLE_STATUSES
   * （loading / shipped / thailand_received / cancelled）再加上已付款相关状态。
   *
   * dryRun 只预检不删，界面靠它显示「会删掉几个客户、几张预报单」。
   */
  app.post("/admin/whr-consolidation/plans/delete", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; confirmPassword?: string; dryRun?: boolean };
    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    if (!planId) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }

    const plan = await prisma.whrConsolidationPlan.findFirst({
      where: { id: planId, companyId: auth.companyId },
      include: {
        customers: {
          select: {
            id: true,
            prealerts: { select: { id: true, status: true, trackingNo: true } },
          },
        },
      },
    });
    if (!plan) {
      fail(res, 404, "NOT_FOUND", "集货计划不存在");
      return;
    }

    const allPrealerts = plan.customers.flatMap((c) => c.prealerts);
    const [itemCount, logCount] = await Promise.all([
      prisma.whrConsolidationPrealertItem.count({
        where: { prealertId: { in: allPrealerts.map((p) => p.id) } },
      }),
      prisma.whrConsolidationStatusLog.count({
        where: { prealertId: { in: allPrealerts.map((p) => p.id) } },
      }),
    ]);

    /**
     * 发运红线（2026-09-16，确认单 4.15）：已经发出去的柜谁都不能删，输管理员密码也不行。
     * 预览照样回（hardBlocked=true），界面据此不给密码框；真删的时候锁里再判一次。
     */
    const shippedReason = whrPlanShippedReason(plan.status, allPrealerts.map((p) => p.status));

    // 已经收过钱或已发货的，算「开始走流程了」
    const STARTED = ["payment_submitted", "paid", "loading", "shipped", "thailand_received"];
    const started = allPrealerts.filter((p) => STARTED.includes(p.status));
    const blockers = [];
    if (started.length > 0) {
      blockers.push(`有 ${started.length} 张预报单已付款或已发货（${started.slice(0, 3).map((p) => p.trackingNo).join("、")}${started.length > 3 ? " 等" : ""}）`);
    }
    if (!["planning", "collecting", "cancelled"].includes(plan.status)) {
      blockers.push(`计划状态已是「${plan.status}」，不是计划中/收货中`);
    }

    const willDelete = {
      计划客户: plan.customers.length,
      预报单: allPrealerts.length,
      货物明细: itemCount,
      状态日志: logCount,
    };

    // 客户已经付过的钱，删之前要退回去（2026-08-08 补）。
    // 不退的话单子删了钱还挂在客户账上，客户来问都查不到 —— 实测确认过这个洞。
    const pendingRefunds = await computePendingRefunds(
      prisma,
      allPrealerts.map((p) => ({ refType: "whr", refId: p.id })),
    );
    const refundTotal = pendingRefunds.reduce((s, r) => s + r.amount, 0);

    if (body.dryRun) {
      ok(res, {
        planNo: plan.planNo, willDelete, blockers, refundTotal, refundCount: pendingRefunds.length,
        hardBlocked: shippedReason !== null,
        hardBlockReason: shippedReason,
      });
      return;
    }

    // 发运红线在查密码之前就拦：带没带密码、密码对不对，都一样删不了
    if (shippedReason) {
      fail(res, 409, "VALIDATION_ERROR", shippedReason);
      return;
    }

    // 密码只要填对了就记下来，事务里会再查一次「现在还有没有拦截条件」
    let passwordVerified = false;
    if (body.confirmPassword?.trim()) {
      const admin = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { passwordHash: true },
      });
      if (!admin || !verifyPassword(body.confirmPassword, admin.passwordHash ?? "")) {
        fail(res, 403, "FORBIDDEN", "管理员密码不对，没有删除");
        return;
      }
      passwordVerified = true;
    }
    if (blockers.length > 0 && !passwordVerified) {
      fail(res, 409, "VALIDATION_ERROR",
        `这个集货计划不能直接删除：${blockers.join("；")}。确实要删请输入管理员密码。`);
      return;
    }

    /**
     * 退款和删除必须在同一个事务里：不然会出现「钱退了单子还在」或者反过来。
     *
     * ⚠️⚠️ **退款金额必须在事务里重算**（2026-08-27 补）。
     * 上面那次 computePendingRefunds 是在事务**外面**算的，只够给 dryRun 预览用。
     * 外部复审实测：算完退款、还没进事务删除，这中间客户付了一笔款
     *（余额 500→400、流水已写），删除照样按**旧金额**退 —— 那笔钱就漏退了，
     * 单子还被级联删掉，客户来问都查不到。
     *
     * 现在的顺序：**先锁住计划行 → 事务内重算退款 → 退款 → 删除**。
     * 付款那条路第一件事也是锁同一行（见 plan-guard.ts 的统一锁序），
     * 所以并发的付款要么排在删除前面（重算时会被算进去），要么排在后面（计划已没了，付不成）。
     */
    const actualRefunds = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM whr_consolidation_plans WHERE id = ${planId} FOR UPDATE`;

      /**
       * ⚠️ 退款会锁钱包行，而下面的级联删除会锁子单行 —— 顺序就成了「钱包 → 子单」，
       * 跟付款那条路的「子单 → 钱包」正好反着，两边撞上就是死锁（我上一版改出来的）。
       * 所以退款之前**先把这个柜底下的子单全锁掉**，把顺序拉回统一的
       * 【计划 → 子单 → 钱包】。
       */
      /**
       * ⚠️ 子单清单也得**锁住计划之后重新拉一遍**（2026-08-27 补）。
       * 原来用的是事务外面那份 allPrealerts 快照：管理员点删除的那几秒里，
       * 客户新报了一单还付了钱，这单不在旧清单里 —— 级联删除会把它删掉，
       * 但退款算的是旧清单，这笔钱就漏退了。锁住计划之后再拉，才拉得全。
       */
      const liveIds = (
        await tx.whrConsolidationPrealert.findMany({
          where: { planCustomer: { planId } },
          select: { id: true },
        })
      ).map((pa) => pa.id);
      if (liveIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM whr_consolidation_prealerts WHERE id = ANY(${liveIds}) FOR UPDATE`;
      }

      /**
       * ⚠️ 「能不能直接删」也要**锁完重查一遍**（2026-08-27 补）。
       * 上面那份拦截清单是事务外面算的：点删除那一刻柜里还没人付款，于是不用输密码；
       * 等事务真跑起来时客户已经付了 —— 一个已收钱的柜就这么被无密码删掉了。
       */
      const nowPlan = await tx.whrConsolidationPlan.findUnique({
        where: { id: planId },
        select: { status: true },
      });
      if (!nowPlan) throw new BusinessError("集货计划不存在", 404, "NOT_FOUND");
      /**
       * ⚠️ 发运红线锁完再判一次（CLAUDE.md #28）：事务外那次判断之后、锁住之前，
       * 员工可能正好点了「发运确认」（那条路也是先锁计划），这里不重判就会带着密码把已发运的柜删掉。
       */
      const liveStatuses = (
        await tx.whrConsolidationPrealert.findMany({
          where: { planCustomer: { planId } },
          select: { status: true },
        })
      ).map((pa) => pa.status);
      const shippedNow = whrPlanShippedReason(nowPlan.status, liveStatuses);
      if (shippedNow) {
        throw new BusinessError(shippedNow, 409, "VALIDATION_ERROR");
      }
      const startedNow = await tx.whrConsolidationPrealert.count({
        where: { planCustomer: { planId }, status: { in: STARTED } },
      });
      const blockedNow =
        startedNow > 0 || !["planning", "collecting", "cancelled"].includes(nowPlan.status);
      if (blockedNow && !passwordVerified) {
        throw new BusinessError(
          "这个柜刚刚有了新动静（有人付款或状态变了），删除没有执行。请刷新后确认，确实要删请输入管理员密码。",
          409,
          "VALIDATION_ERROR",
        );
      }

      const fresh = await computePendingRefunds(
        tx as any,
        liveIds.map((id) => ({ refType: "whr", refId: id })),
      );
      if (fresh.length > 0) {
        await refundPendingOnDelete(tx as any, {
          companyId: auth.companyId,
          refType: "whr",
          refId: plan.id,
          refunds: fresh,
          remark: `管理员删除集货计划 ${plan.planNo}，退回已付款项`,
          operatorId: auth.userId,
          operatorName: auth.name || auth.userId,
        });
      }
      await tx.whrConsolidationPlan.delete({ where: { id: planId } });
      return fresh;
    });

    logger.warn("删除集货计划（仓库版）", {
      操作人: auth.userId, 计划号: plan.planNo, 计划状态: plan.status,
      连带删除: willDelete, 是否强删: blockers.length > 0,
      退款客户数: actualRefunds.length,
      退款总额: actualRefunds.reduce((n, r) => n + r.amount, 0),
      预览时算的: refundTotal,
    });

    ok(res, {
      deleted: true, planNo: plan.planNo, willDelete, forced: blockers.length > 0,
      // 回给前端的必须是**真退了多少**，不是上面预览时算的那个数（2026-08-27 补）
      refundTotal: actualRefunds.reduce((n, r) => n + r.amount, 0),
      refundCount: actualRefunds.length,
    });
  });
}
