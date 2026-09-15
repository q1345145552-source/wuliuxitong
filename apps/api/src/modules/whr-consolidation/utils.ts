import { BusinessError } from "../core/business-error";
import { checkTotalsWritable } from "../core/decimal-guard";
import { logger } from "../core/logger";
import { prisma } from "../../db/prisma";
import { computeRebate } from "./rebate";

// ============================================================================
// 常量
// ============================================================================

/** 预报单状态流转顺序（不含 cancelled） */
export const PREALERT_STATUS_ORDER = [
  "pending",
  "received_pending_payment",
  "payment_submitted",
  "paid",
  "loading",
  "shipped",
  "thailand_received",
] as const;

/** 已取消的预报单不参与任何方数/费用/件数汇总 */
export const ACTIVE_PREALERT_WHERE = { status: { not: "cancelled" } } as const;

/** 客户还能自行编辑货品的状态：只有待签收 */
export const EDITABLE_PREALERT_STATUS = "pending";

/** 装柜之后不可再取消 */
export const NON_CANCELLABLE_STATUSES = ["loading", "shipped", "thailand_received", "cancelled"];

// ============================================================================
// 小工具
// ============================================================================

/** 金额保留 2 位 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 方数保留 3 位 */
export function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/** Prisma Decimal | number | null → number */
export function toNum(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v.toNumber === "function") return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

interface UnitPrices {
  unitPriceNormal: any;
  unitPriceInspection: any;
  unitPriceSensitive: any;
}

interface FeeItem {
  cargoType: string | null;
  volumeM3: any;
}

/**
 * 按货物类型分档计费：方数 × 对应单价
 * 纯函数，不碰数据库，方便三处调用点（签收计费 / 改单价重算 / 审核重算）保持一致口径。
 */
export function calcFeeFromItems(items: FeeItem[], prices: UnitPrices): number {
  let volNormal = 0;
  let volInspection = 0;
  let volSensitive = 0;
  for (const it of items) {
    const v = toNum(it.volumeM3);
    if (it.cargoType === "inspection") volInspection += v;
    else if (it.cargoType === "sensitive") volSensitive += v;
    else volNormal += v;
  }
  return round2(
    volNormal * toNum(prices.unitPriceNormal) +
      volInspection * toNum(prices.unitPriceInspection) +
      volSensitive * toNum(prices.unitPriceSensitive),
  );
}

export const CARGO_TYPE_LABEL: Record<string, string> = {
  normal: "普货",
  inspection: "商检货",
  sensitive: "敏感货",
};

export interface FeeBreakdownRow {
  cargoType: string;
  label: string;
  volumeM3: number;
  unitPrice: number;
  amount: number;
}

export interface FeeBreakdown {
  /** 只包含方数 > 0 的档位 */
  rows: FeeBreakdownRow[];
  totalVolumeM3: number;
  /** 按当前单价算出来的金额 */
  computedFee: number;
  /** 库里锁定的金额（签收时算好的） */
  storedFee: number | null;
  /** 两者是否一致；不一致说明签收之后管理员调过单价，结算以 storedFee 为准 */
  matchesStored: boolean;
}

/**
 * 生成「总费用是怎么算出来的」明细，给三端展示用。
 *
 * 单价取的是客户当前的三档单价。对未付款的单子，改单价会触发重算，
 * 所以 computedFee 和 storedFee 一定相等；已付款的单子金额是锁死的，
 * 若之后管理员调过价，这里会用 matchesStored=false 把差异显式标出来，
 * 而不是让两个数字在界面上各说各话。
 */
export function buildFeeBreakdown(
  items: FeeItem[],
  prices: UnitPrices,
  storedFee: any,
): FeeBreakdown {
  const volumes: Record<string, number> = { normal: 0, inspection: 0, sensitive: 0 };
  for (const it of items) {
    const key = it.cargoType === "inspection" || it.cargoType === "sensitive" ? it.cargoType : "normal";
    volumes[key] += toNum(it.volumeM3);
  }

  const priceOf: Record<string, number> = {
    normal: toNum(prices.unitPriceNormal),
    inspection: toNum(prices.unitPriceInspection),
    sensitive: toNum(prices.unitPriceSensitive),
  };

  const rows: FeeBreakdownRow[] = [];
  let totalVolumeM3 = 0;
  for (const cargoType of ["normal", "inspection", "sensitive"]) {
    const volumeM3 = round3(volumes[cargoType]);
    totalVolumeM3 += volumes[cargoType];
    if (volumeM3 <= 0) continue;
    rows.push({
      cargoType,
      label: CARGO_TYPE_LABEL[cargoType],
      volumeM3,
      unitPrice: priceOf[cargoType],
      amount: round2(volumes[cargoType] * priceOf[cargoType]),
    });
  }

  const computedFee = calcFeeFromItems(items, prices);
  const stored = storedFee == null ? null : round2(toNum(storedFee));

  return {
    rows,
    totalVolumeM3: round3(totalVolumeM3),
    computedFee,
    storedFee: stored,
    matchesStored: stored == null ? true : Math.abs(stored - computedFee) < 0.01,
  };
}

/** 把多张预报单的明细合并成一份客户级明细 */
export function mergeFeeBreakdowns(list: FeeBreakdown[]): FeeBreakdown {
  const byType = new Map<string, FeeBreakdownRow>();
  let totalVolumeM3 = 0;
  let computedFee = 0;
  let storedFee = 0;
  let hasStored = false;
  let matchesStored = true;

  for (const b of list) {
    totalVolumeM3 += b.totalVolumeM3;
    computedFee += b.computedFee;
    if (b.storedFee != null) {
      hasStored = true;
      storedFee += b.storedFee;
    }
    if (!b.matchesStored) matchesStored = false;
    for (const r of b.rows) {
      const prev = byType.get(r.cargoType);
      if (prev) {
        prev.volumeM3 = round3(prev.volumeM3 + r.volumeM3);
        prev.amount = round2(prev.amount + r.amount);
        // 单价理论上一致；万一历史单价不同，这里保留最新的一档，界面上会提示差异
        prev.unitPrice = r.unitPrice;
      } else {
        byType.set(r.cargoType, { ...r });
      }
    }
  }

  const order = ["normal", "inspection", "sensitive"];
  return {
    rows: order.filter((t) => byType.has(t)).map((t) => byType.get(t)!),
    totalVolumeM3: round3(totalVolumeM3),
    computedFee: round2(computedFee),
    storedFee: hasStored ? round2(storedFee) : null,
    matchesStored,
  };
}

/** 单件货品的方数：长×宽×高(cm) / 1e6 × 件数 */
export function calcItemVolumeM3(
  lengthCm: number | null | undefined,
  widthCm: number | null | undefined,
  heightCm: number | null | undefined,
  packageCount: number,
): number | null {
  if (!lengthCm || !widthCm || !heightCm) return null;
  if (lengthCm <= 0 || widthCm <= 0 || heightCm <= 0) return null;
  const raw = ((lengthCm * widthCm * heightCm) / 1_000_000) * packageCount;
  // 库里是 Decimal(10,6)，这里先截到 6 位，避免浮点尾数被静默四舍五入后和前端显示对不上
  return Math.round((raw + Number.EPSILON) * 1_000_000) / 1_000_000;
}

// ============================================================================
// 重算：预报单费用
// ============================================================================

/**
 * 重算单张预报单的费用并落库。
 * 已取消的预报单费用一律清 0。
 */
export async function recalcPrealertFee(prealertId: string, tx: any = prisma): Promise<number> {
  const pa = await tx.whrConsolidationPrealert.findUnique({
    where: { id: prealertId },
    select: {
      status: true,
      planCustomer: {
        select: { unitPriceNormal: true, unitPriceInspection: true, unitPriceSensitive: true },
      },
      items: { select: { cargoType: true, volumeM3: true } },
    },
  });
  if (!pa) return 0;

  const totalFee = pa.status === "cancelled" ? 0 : calcFeeFromItems(pa.items, pa.planCustomer);
  /**
   * ⚠️ 金额列是 `Decimal(12,2)`（最大 9999999999.99）。
   * 复核实测：101 方 × 99999999.99 = 10099999998.99 —— **每个输入都合法**，
   * 算出来的金额爆掉，写库直接失败。（2026-08-29 第十一轮补）
   */
  const feeIssue = checkTotalsWritable({ fees: [["这张预报单的金额", totalFee]] });
  if (feeIssue) {
    throw new BusinessError(`${feeIssue}。请把这张预报单拆开，或者检查单价是不是填错了`, 400, "VALIDATION_ERROR");
  }

  await tx.whrConsolidationPrealert.update({
    where: { id: prealertId },
    data: { totalFee },
  });

  return totalFee;
}

/**
 * 重算某客户名下所有「尚未付款」的预报单费用。
 * 已付款/已装柜/已发运的单子金额已经结清，不能因为后来改单价就被改掉。
 */
export async function recalcUnpaidPrealertFees(planCustomerId: string, tx: any = prisma): Promise<void> {
  const prealerts = await tx.whrConsolidationPrealert.findMany({
    where: {
      customerId: planCustomerId,
      status: { in: ["pending", "received_pending_payment", "payment_submitted"] },
    },
    select: { id: true },
  });
  for (const pa of prealerts) {
    await recalcPrealertFee(pa.id, tx);
  }
}

// ============================================================================
// 付款快照（2026-09-16，确认单 4.14 / 4.10）
// ============================================================================

/**
 * 撤销付款 / 作废已付款的单时，快照整组清空（再付款会重新记）。
 * 用法：`data: { status: ..., ...CLEARED_PAID_SNAPSHOT }`
 */
export const CLEARED_PAID_SNAPSHOT = {
  paidPriceNormal: null,
  paidPriceInspection: null,
  paidPriceSensitive: null,
  paidAgentId: null,
  paidAgentPriceNormal: null,
  paidAgentPriceInspection: null,
  paidAgentPriceSensitive: null,
  rebateAmount: null,
} as const;

export interface PaidSnapshot {
  paidPriceNormal: number;
  paidPriceInspection: number;
  paidPriceSensitive: number;
  paidAgentId: string | null;
  paidAgentPriceNormal: number | null;
  paidAgentPriceInspection: number | null;
  paidAgentPriceSensitive: number | null;
  rebateAmount: number | null;
}

/**
 * 算「付款那一刻」的价格快照：客户三档价 + 客户所属代理 + 代理三档价 + 这票返现。
 *
 * ⚠️ **必须在调用方已经锁住计划和这张预报单之后调**（付款那条路的锁序是【计划 → 预报单 → 钱包】）：
 *    · 客户价读的是柜里这位客户那一行（plan_customers）—— 改长期价那边改这一行之前也要先锁计划，
 *      所以锁住计划之后读到的就是「这次扣钱用的那个价」，跟 totalFee 同一口径。
 *    · 货品、货型在锁住预报单之后读，跟扣的钱对得上。
 * ⚠️ 代理行**故意不加锁**、普通读：改长期价那条路是「代理行 FOR SHARE → 计划」，
 *    这里若在锁完计划之后再去拿代理行的锁，就是反着拿；再碰上「调高代理价」的 FOR UPDATE 排队，
 *    三方会绕成死锁。读已提交的代理价对快照来说足够：代理价改了只影响之后付款的单。
 * ⚠️ 客户归属（users.agent_id）也是普通读：改归属只许在客户还没有任何集货记录时做
 *    （admin/routes.ts），能走到付款的客户归属已经改不动了。
 * ⚠️ 返现算出负数（客户价低于代理价，存价时已拦住，理论上不会发生）→ 记 0 并写警告日志，
 *    不拦付款：钱是客户付给湘泰的，返现单是湘泰付给代理的，不能因为返现数据异常让客户付不了款。
 */
export async function buildPaidSnapshot(prealertId: string, tx: any): Promise<PaidSnapshot> {
  const pa = await tx.whrConsolidationPrealert.findUnique({
    where: { id: prealertId },
    select: {
      trackingNo: true,
      companyId: true,
      items: { select: { cargoType: true, volumeM3: true } },
      planCustomer: {
        select: { clientId: true, unitPriceNormal: true, unitPriceInspection: true, unitPriceSensitive: true },
      },
    },
  });
  if (!pa) throw new BusinessError("预报单不存在", 404, "NOT_FOUND");

  const clientPrices = {
    normal: toNum(pa.planCustomer.unitPriceNormal),
    inspection: toNum(pa.planCustomer.unitPriceInspection),
    sensitive: toNum(pa.planCustomer.unitPriceSensitive),
  };
  const snapshot: PaidSnapshot = {
    paidPriceNormal: clientPrices.normal,
    paidPriceInspection: clientPrices.inspection,
    paidPriceSensitive: clientPrices.sensitive,
    paidAgentId: null,
    paidAgentPriceNormal: null,
    paidAgentPriceInspection: null,
    paidAgentPriceSensitive: null,
    rebateAmount: null,
  };

  // 同公司过滤 + 判空（CLAUDE.md #27）：查不到客户就当湘泰自己的客户，代理那几列留空
  const client = await tx.user.findFirst({
    where: { id: pa.planCustomer.clientId, companyId: pa.companyId },
    select: { agentId: true },
  });
  if (!client?.agentId) return snapshot;

  snapshot.paidAgentId = client.agentId;
  const agent = await tx.agent.findFirst({
    where: { id: client.agentId, companyId: pa.companyId },
    select: { priceNormal: true, priceInspection: true, priceSensitive: true },
  });
  if (!agent) {
    // 外键是 RESTRICT，正常删不掉代理；真查不到说明数据坏了，记下来但不拦付款
    logger.warn("付款快照：客户所属代理查不到，返现记 0", { 预报单: pa.trackingNo, 代理: client.agentId });
    snapshot.rebateAmount = 0;
    return snapshot;
  }
  const agentPrices = {
    normal: toNum(agent.priceNormal),
    inspection: toNum(agent.priceInspection),
    sensitive: toNum(agent.priceSensitive),
  };
  snapshot.paidAgentPriceNormal = agentPrices.normal;
  snapshot.paidAgentPriceInspection = agentPrices.inspection;
  snapshot.paidAgentPriceSensitive = agentPrices.sensitive;

  const { rebateAmount } = computeRebate(pa.items, clientPrices, agentPrices);
  if (rebateAmount < 0) {
    logger.warn("付款快照：返现算出负数（客户价低于代理价），记 0", {
      预报单: pa.trackingNo,
      代理: client.agentId,
      算出来的返现: rebateAmount,
    });
    snapshot.rebateAmount = 0;
  } else {
    snapshot.rebateAmount = rebateAmount;
  }
  return snapshot;
}

// ============================================================================
// 重算：客户汇总
// ============================================================================

/**
 * 重算客户的全部汇总字段：总方数 / 总件数 / 预报单数 / 总费用。
 *
 * 关键：**已取消的预报单一律不计入**，取消才真正释放方数。
 * 之前 totalPrealerts 只增不减、取消后方数不释放、totalFee 只统计待付款单，
 * 三个字段各自漂移，这里统一成一个入口重算。
 */
export async function recalcCustomerTotals(planCustomerId: string, tx: any = prisma): Promise<{
  totalVolumeM3: number;
  totalPackages: number;
  totalPrealerts: number;
  totalFee: number;
}> {
  const prealerts = await tx.whrConsolidationPrealert.findMany({
    where: { customerId: planCustomerId, ...ACTIVE_PREALERT_WHERE },
    select: {
      totalFee: true,
      items: { select: { volumeM3: true, packageCount: true } },
    },
  });

  let totalVolumeM3 = 0;
  let totalPackages = 0;
  let totalFee = 0;
  for (const pa of prealerts) {
    for (const it of pa.items) {
      totalVolumeM3 += toNum(it.volumeM3);
      totalPackages += it.packageCount ?? 0;
    }
    totalFee += toNum(pa.totalFee);
  }

  const result = {
    totalVolumeM3: round3(totalVolumeM3),
    totalPackages,
    totalPrealerts: prealerts.length,
    totalFee: round2(totalFee),
  };

  /**
   * ⚠️⚠️ **汇总也要卡，不能只卡单行**（2026-08-29 第十一轮补）。
   *
   * 复核实测：每一行单独都合法，加起来才爆 ——
   *   · 两行各 15 亿 / 16 亿件 → 合计 31 亿，而 `totalPackages` 是 `Int`
   *     （最大 2147483647）→ 溢出
   *   · 101 方 × 99999999.99 = 10099999998.99，而 `totalFee` 是 `Decimal(12,2)`
   *     （最大 9999999999.99）→ **写库直接失败**
   * 我前几轮修的都是「单行」和「单行的派生值」，跨行汇总一个都没卡。
   *
   * ⚠️ 这里抛的是 BusinessError，会被最外层翻成 400 而不是 500「服务器繁忙」——
   *    员工至少知道是「数字太大」而不是「系统坏了」。
   * ⚠️ 放在**写库之前**：写下去就是 Prisma 报错，那时候已经晚了。
   */
  // 走共用的 checkTotalsWritable —— 四个汇总点一份实现（2026-08-29 第十二轮）
  const overflow = checkTotalsWritable({
    counts: [["这位客户的总件数", result.totalPackages]],
    volumes: [["这位客户的总方数", result.totalVolumeM3]],
    fees: [["这位客户的总金额", result.totalFee]],
  });
  if (overflow) {
    throw new BusinessError(`${overflow}。请把这个客户名下的预报单拆开`, 400, "VALIDATION_ERROR");
  }

  await tx.whrConsolidationPlanCustomer.update({
    where: { id: planCustomerId },
    data: result,
  });

  return result;
}

// ============================================================================
// 计划容量
// ============================================================================

/**
 * 统计整个计划已占用的方数（所有客户、排除已取消预报单）。
 * excludeCustomerId 用于「这个客户改完之后」的预演计算。
 */
export async function sumPlanUsedVolume(
  planId: string,
  tx: any = prisma,
  excludeCustomerId?: string,
): Promise<number> {
  const customers = await tx.whrConsolidationPlanCustomer.findMany({
    where: { planId },
    select: {
      id: true,
      prealerts: {
        where: ACTIVE_PREALERT_WHERE,
        select: { items: { select: { volumeM3: true } } },
      },
    },
  });

  let total = 0;
  for (const c of customers) {
    if (excludeCustomerId && c.id === excludeCustomerId) continue;
    for (const pa of c.prealerts) {
      for (const it of pa.items) total += toNum(it.volumeM3);
    }
  }
  return round3(total);
}

// ============================================================================
// 计划状态
// ============================================================================

/**
 * 同步计划状态。只看未取消的预报单：
 * - 还有 pending          → collecting（集货中）
 * - 全部离开 pending       → loading（装柜中）
 * - 全部 thailand_received → completed（已完成）
 *
 * 修正点：原实现把「全部取消」也判成 completed，一个货都没发的计划会显示已完成。
 * 现在没有任何有效预报单时不动状态。
 */
export async function syncPlanStatus(planId: string, tx: any = prisma): Promise<string | null> {
  const plan = await tx.whrConsolidationPlan.findUnique({
    where: { id: planId },
    select: {
      status: true,
      customers: {
        select: {
          prealerts: { where: ACTIVE_PREALERT_WHERE, select: { status: true } },
        },
      },
    },
  });

  if (!plan) return null;
  if (plan.status === "completed" || plan.status === "cancelled") return plan.status;

  const statuses: string[] = plan.customers.flatMap((c: any) =>
    c.prealerts.map((pa: any) => pa.status),
  );

  // 没有任何有效预报单（全被取消 / 还没人报）→ 保持现状，不误判为已完成
  if (statuses.length === 0) return plan.status;

  let newStatus: string;
  if (statuses.every((s) => s === "thailand_received")) {
    newStatus = "completed";
  } else if (statuses.every((s) => s !== "pending")) {
    newStatus = "loading";
  } else {
    newStatus = "collecting";
  }

  if (plan.status !== newStatus) {
    await tx.whrConsolidationPlan.update({
      where: { id: planId },
      data: { status: newStatus },
    });
  }

  return newStatus;
}

/**
 * 一个客户在某计划下的「最新状态」：取所有未取消预报单里最靠后的那个阶段。
 * 全部取消时返回 cancelled，而不是回落成 pending。
 */
export function deriveLatestStatus(prealertStatuses: string[]): string {
  const active = prealertStatuses.filter((s) => s !== "cancelled");
  if (active.length === 0) {
    return prealertStatuses.length > 0 ? "cancelled" : "pending";
  }
  let latest: string = PREALERT_STATUS_ORDER[0];
  for (const s of PREALERT_STATUS_ORDER) {
    if (active.includes(s)) latest = s;
  }
  return latest;
}
