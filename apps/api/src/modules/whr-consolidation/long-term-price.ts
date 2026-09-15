/* ==========================================================================
   仓库版集货：客户长期价（2026-09-16，确认单 4.3 / 4.4 / 4.7 / 4.14 / 4.19）
   --------------------------------------------------------------------------
   原来每进一个柜当场手填三档价；现在每个客户填一次长期价，加进柜子时自动带出。
   改了长期价以后：这个客户在「计划中/收货中/装柜中」柜里的三档价跟着改，
   只重算**没付款**的单（已付款的金额在付款那一刻就定死了，4.14）。

   ⚠️ 这里**不管调用者权限**：谁能改谁的价（超管只改湘泰客户、代理只改自己名下客户、
      员工一律不能改）由各自的接口判断，判完再来调。
   ⚠️ 这个文件是 B 阶段共享只读的：要改写进报告由编排者改。

   ## 锁序（改之前先读 scripts/test-lock-order.ts 和 plan-guard.ts 文件头）

   全模块统一【计划 → 预报单/客户/明细 → 钱包】。setClientWhrPrice 在它前面多两站：

     ① 客户价排队锁  pg_advisory_xact_lock(83020, hashtext(clientId))   —— lockClientWhrPrice
     ② 代理行        SELECT ... FROM agents ... FOR SHARE（客户归代理时）
     ③ 计划行        按 planId 排序逐个 FOR UPDATE
     ④ plan_customers → 预报单（recalcUnpaidPrealertFees）→ plan_customers（recalcCustomerTotals）

   ⚠️ 给 B 阶段的约定：
     · 凡是「读长期价写进柜里」的路（建柜、新增客户），必须先 lockClientWhrPrice 再锁计划，
       否则：新增客户读到旧价 → 我这边改完价时它还没提交、我看不见那一行 → 柜里留着旧价。
       多个客户（建柜）按 clientId 排序逐个锁。
     · 改客户归属（超管）也先 lockClientWhrPrice —— 我在锁里读 agentId 判代理价下限。
     · 调高代理价（超管）先 `SELECT ... FROM agents WHERE id = ? FOR UPDATE` 再查名下客户价；
       我这边拿的是同一行的 FOR SHARE，两边自然排队，不会出现「客户价低于新代理价」。
   ========================================================================== */

import { prisma } from "../../db/prisma";
import { BusinessError } from "../core/business-error";
import { requireUnitPrice } from "../core/decimal-guard";
import { recalcCustomerTotals, recalcUnpaidPrealertFees, toNum } from "./utils";

export interface WhrPriceTriple {
  normal: number;
  inspection: number;
  sensitive: number;
}

type Tx = any;

/** 改长期价时，这几种状态的柜跟着改价（没付款的单重算）。shipped / completed / cancelled 不动 */
export const REPRICE_PLAN_STATUSES = ["planning", "collecting", "loading"];

const PRICE_LABEL: Record<keyof WhrPriceTriple, string> = {
  normal: "普货",
  inspection: "商检货",
  sensitive: "敏感货",
};

const toCents = (n: number): number => Math.round(n * 100);
const formatPrice = (n: number): string => String(Number(n.toFixed(2)));

/** 客户长期价；没填过返回 null */
export async function getClientWhrPrice(clientId: string, tx: Tx = prisma): Promise<WhrPriceTriple | null> {
  if (!clientId) return null;
  const row = await tx.clientWhrPrice.findUnique({
    where: { clientId },
    select: { priceNormal: true, priceInspection: true, priceSensitive: true },
  });
  if (!row) return null;
  return { normal: toNum(row.priceNormal), inspection: toNum(row.priceInspection), sensitive: toNum(row.priceSensitive) };
}

/** 湘泰给代理的三档价；代理不存在返回 null */
export async function getAgentPrices(agentId: string, tx: Tx = prisma): Promise<WhrPriceTriple | null> {
  if (!agentId) return null;
  const row = await tx.agent.findUnique({
    where: { id: agentId },
    select: { priceNormal: true, priceInspection: true, priceSensitive: true },
  });
  if (!row) return null;
  return { normal: toNum(row.priceNormal), inspection: toNum(row.priceInspection), sensitive: toNum(row.priceSensitive) };
}

/**
 * 客户价排队锁（事务级，提交/回滚自动放）。**必须传事务**。
 * 排在计划锁前面 —— 见文件头「锁序」。
 */
export async function lockClientWhrPrice(tx: Tx, clientId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(83020, hashtext(${clientId}))`;
}

/**
 * 三档价校验（不碰数据库）：都必填、都过 requireUnitPrice。
 * 返回 number 三档；不合法抛 BusinessError（最外层转 400）。
 */
export function parseWhrPriceInput(prices: Record<keyof WhrPriceTriple, unknown> | null | undefined): WhrPriceTriple {
  const out = {} as WhrPriceTriple;
  for (const key of ["normal", "inspection", "sensitive"] as const) {
    const raw = prices?.[key];
    const label = `${PRICE_LABEL[key]}单价`;
    const issue = raw == null || raw === "" ? `${label}为必填` : requireUnitPrice(raw, label);
    if (issue) throw new BusinessError(issue, 400, "BAD_REQUEST");
    out[key] = Number(raw);
  }
  return out;
}

/**
 * 客户价不许低于代理价（4.3 / 4.7）。纯函数，方便自测。
 * @returns 有问题返回人话（多档一起列出来），没问题返回 null
 */
export function checkNotBelowAgentPrice(prices: WhrPriceTriple, agentPrices: WhrPriceTriple): string | null {
  const issues: string[] = [];
  for (const key of ["normal", "inspection", "sensitive"] as const) {
    if (toCents(prices[key]) < toCents(agentPrices[key])) {
      issues.push(`${PRICE_LABEL[key]}不能低于湘泰给你的价 ${formatPrice(agentPrices[key])} 元/方`);
    }
  }
  return issues.length > 0 ? issues.join("；") : null;
}

export interface SetClientWhrPriceInput {
  companyId: string;
  clientId: string;
  prices: Record<keyof WhrPriceTriple, unknown>;
  actor: { userId: string; role: string };
}

/**
 * 填 / 改客户长期价，并把没付款的单按新价重算。
 *
 * 不传 tx 就自己开事务；传了就在调用方的事务里做（调用方负责它前面拿的锁不违反锁序）。
 * @returns updatedPlanRows 改了几个柜里这位客户的那一行
 */
export async function setClientWhrPrice(input: SetClientWhrPriceInput, tx?: Tx): Promise<{ updatedPlanRows: number }> {
  // 参数不合法就别碰数据库
  const prices = parseWhrPriceInput(input.prices);
  if (!input.companyId || !input.clientId) {
    throw new BusinessError("客户不存在", 404, "NOT_FOUND");
  }
  if (!tx) {
    return prisma.$transaction((t) => setClientWhrPrice(input, t), { timeout: 30000, maxWait: 10000 });
  }

  // ① 客户价排队锁：同一个客户同时改价、同时被加进柜，都在这里排队
  await lockClientWhrPrice(tx, input.clientId);

  // 锁里再读客户（归属可能刚被改过）
  const client = await tx.user.findFirst({
    where: { id: input.clientId, companyId: input.companyId, role: "client" },
    select: { id: true, agentId: true },
  });
  if (!client) throw new BusinessError("客户不存在", 404, "NOT_FOUND");

  // ② 客户归代理：代理行拿共享锁（调高代理价那边拿排他锁），再判下限
  if (client.agentId) {
    const agentRows = await tx.$queryRaw<Array<{ price_normal: unknown; price_inspection: unknown; price_sensitive: unknown }>>`SELECT price_normal, price_inspection, price_sensitive FROM agents WHERE id = ${client.agentId} AND company_id = ${input.companyId} FOR SHARE`;
    if (!agentRows || agentRows.length === 0) {
      throw new BusinessError("这个客户所属的代理不存在，请联系管理员", 400, "BAD_REQUEST");
    }
    const agentPrices: WhrPriceTriple = {
      normal: toNum(agentRows[0].price_normal),
      inspection: toNum(agentRows[0].price_inspection),
      sensitive: toNum(agentRows[0].price_sensitive),
    };
    const belowIssue = checkNotBelowAgentPrice(prices, agentPrices);
    if (belowIssue) throw new BusinessError(belowIssue, 400, "BAD_REQUEST");
  }

  // ③ 找出这个客户在跑的柜，按 planId 排序逐个锁；锁完重读状态，锁之前被发运/取消的跳过
  const candidates: Array<{ planId: string }> = await tx.whrConsolidationPlanCustomer.findMany({
    where: { clientId: client.id, companyId: input.companyId, plan: { status: { in: REPRICE_PLAN_STATUSES } } },
    select: { planId: true },
  });
  const candidatePlanIds = [...new Set(candidates.map((c) => c.planId))];
  const livePlanIds: string[] = [];
  for (const planId of [...candidatePlanIds].sort()) {
    const planRows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM whr_consolidation_plans WHERE id = ${planId} FOR UPDATE`;
    if (planRows[0] && REPRICE_PLAN_STATUSES.includes(planRows[0].status)) livePlanIds.push(planId);
  }

  // ④ 存长期价
  await tx.clientWhrPrice.upsert({
    where: { clientId: client.id },
    create: {
      clientId: client.id,
      companyId: input.companyId,
      priceNormal: prices.normal,
      priceInspection: prices.inspection,
      priceSensitive: prices.sensitive,
      updatedBy: input.actor.userId,
      updatedByRole: input.actor.role,
    },
    update: {
      companyId: input.companyId,
      priceNormal: prices.normal,
      priceInspection: prices.inspection,
      priceSensitive: prices.sensitive,
      updatedBy: input.actor.userId,
      updatedByRole: input.actor.role,
    },
  });

  if (livePlanIds.length === 0) return { updatedPlanRows: 0 };

  // ⑤ 锁里重查柜里这位客户的行，改价 → 只重算没付款的单 → 重算客户汇总（跟原 repriceCustomer 同一套）
  const planCustomers: Array<{ id: string; planId: string }> = await tx.whrConsolidationPlanCustomer.findMany({
    where: { clientId: client.id, companyId: input.companyId, planId: { in: livePlanIds } },
    select: { id: true, planId: true },
    orderBy: { planId: "asc" },
  });
  for (const pc of planCustomers) {
    await tx.whrConsolidationPlanCustomer.update({
      where: { id: pc.id },
      data: {
        unitPriceNormal: prices.normal,
        unitPriceInspection: prices.inspection,
        unitPriceSensitive: prices.sensitive,
      },
    });
    /**
     * ⚠️ 这两句就是 routes.ts 里 repriceCustomer 的全部内容（那个函数没导出，
     * 而 routes.ts 归 B1）。两边口径必须一致：只重算 pending / received_pending_payment /
     * payment_submitted 的单，已付款的金额不动（4.14）。
     */
    await recalcUnpaidPrealertFees(pc.id, tx);
    await recalcCustomerTotals(pc.id, tx);
  }

  return { updatedPlanRows: planCustomers.length };
}
