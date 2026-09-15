/* ==========================================================================
   每月返现单生成（2026-09-16，B2；确认单 4.11 / 4.12 / 4.13 / 4.20）
   --------------------------------------------------------------------------
   API 进程里一个定时检查（照 exchange-rate/rate-sync.ts 的写法）：
   启动时跑一次、之后每小时一次。对每个代理、每个「已经过完」的月份（北京时间），
   还没出过单、又有符合条件的预报单，就出一张。

   符合条件 = 仓库版预报单 status=thailand_received、付款快照 paid_agent_id=这个代理、
             还没进过任何返现单明细。怎么分到哪个月见 agent-rules.ts 的 planAgentStatements。

   ⚠️ 幂等，重复跑不会重复出单，三道：
     ① 进程内 running 标记：上一轮没跑完（比如库慢）下一轮直接跳过；
     ② 每个代理一个事务，第一句 `SELECT ... FROM agents ... FOR UPDATE` 排队，
        锁里重读「已出过的月份」和「已进过单的预报单」再决定；
     ③ 数据库兜底：UNIQUE(agent_id, month)、agent_rebate_lines.prealert_id UNIQUE。
   ⚠️ 锁序：agents 行 → 只读预报单 → 只插返现单表。不锁计划/预报单/钱包，
     跟 long-term-price.ts【客户价锁 → agents FOR SHARE → 计划 → 预报单】不会反向等待。
   ⚠️ 出了就不改（4.13）：这里只 create，从不 update / delete 已有的单和明细。
     「已返」在 admin-routes.ts 里，只改状态、时间、操作人。
   ⚠️ 金额用付款那一刻的快照（4.14）：返现 = 快照里的 rebate_amount（B1 付款时用 rebate.ts 算好写入）；
     快照返现为空的老数据才按快照三档价 + 货品方数现算。方数、品名取出单这一刻的货品行。
   ========================================================================== */

import { prisma } from "../../db/prisma";
import { logger } from "../core/logger";
import { computeRebate } from "../whr-consolidation/rebate";
import { planAgentStatements, toCents, toMilliM3 } from "./agent-rules";

type Tx = any;

const HOUR_MS = 60 * 60 * 1000;

interface PrealertForRebate {
  id: string;
  trackingNo: string;
  mark: string;
  createdAt: Date;
  signedAt: Date | null;
  paymentReviewedAt: Date | null;
  thailandReceivedAt: Date;
  paidPriceNormal: unknown;
  paidPriceInspection: unknown;
  paidPriceSensitive: unknown;
  paidAgentPriceNormal: unknown;
  paidAgentPriceInspection: unknown;
  paidAgentPriceSensitive: unknown;
  rebateAmount: unknown;
  planCustomer: { clientId: string; plan: { planNo: string } };
  items: Array<{ productName: string; cargoType: string | null; volumeM3: unknown }>;
  statusLogs: Array<{ toStatus: string; createdAt: Date }>;
}

export interface RebateRunResult {
  agents: number;
  statementsCreated: number;
  linesCreated: number;
  /** 快照不全、没法算的预报单 id（写了日志，等人查） */
  skippedPrealerts: string[];
}

/** 一票预报单 → 一行明细的数据（纯函数，测试直接用）。快照不全返回 null */
export function buildRebateLine(pa: PrealertForRebate): {
  prealertId: string;
  trackingNo: string;
  planNo: string;
  clientId: string;
  mark: string;
  productNames: string;
  volumeNormalM3: number;
  volumeInspectionM3: number;
  volumeSensitiveM3: number;
  clientPriceNormal: unknown;
  clientPriceInspection: unknown;
  clientPriceSensitive: unknown;
  agentPriceNormal: unknown;
  agentPriceInspection: unknown;
  agentPriceSensitive: unknown;
  rebateAmount: number;
  prealertCreatedAt: Date;
  signedAt: Date | null;
  paidAt: Date | null;
  loadedAt: Date | null;
  shippedAt: Date | null;
  thailandReceivedAt: Date;
} | null {
  const clientPrices = { normal: pa.paidPriceNormal, inspection: pa.paidPriceInspection, sensitive: pa.paidPriceSensitive };
  const agentPrices = { normal: pa.paidAgentPriceNormal, inspection: pa.paidAgentPriceInspection, sensitive: pa.paidAgentPriceSensitive };
  if ([...Object.values(clientPrices), ...Object.values(agentPrices)].some((v) => v === null || v === undefined)) return null;

  const computed = computeRebate(pa.items, clientPrices, agentPrices);
  let rebate = pa.rebateAmount === null || pa.rebateAmount === undefined ? computed.rebateAmount : toCents(pa.rebateAmount) / 100;
  if (rebate < 0) {
    // 存价时就拦住了「客户价低于代理价」，真出现负数是数据有问题：记 0、留日志（跟付款写快照同一个口径）
    logger.warn("返现单：这票返现是负数，按 0 记", { prealertId: pa.id, trackingNo: pa.trackingNo, rebate });
    rebate = 0;
  }

  const earliest = (status: string): Date | null => {
    const hits = pa.statusLogs.filter((l) => l.toStatus === status).map((l) => l.createdAt.getTime());
    return hits.length > 0 ? new Date(Math.min(...hits)) : null;
  };
  const names = [...new Set(pa.items.map((i) => (i.productName ?? "").trim()).filter(Boolean))];

  return {
    prealertId: pa.id,
    trackingNo: pa.trackingNo,
    planNo: pa.planCustomer.plan.planNo,
    clientId: pa.planCustomer.clientId,
    mark: pa.mark,
    productNames: names.join("、"),
    volumeNormalM3: computed.volumes.normal,
    volumeInspectionM3: computed.volumes.inspection,
    volumeSensitiveM3: computed.volumes.sensitive,
    clientPriceNormal: clientPrices.normal,
    clientPriceInspection: clientPrices.inspection,
    clientPriceSensitive: clientPrices.sensitive,
    agentPriceNormal: agentPrices.normal,
    agentPriceInspection: agentPrices.inspection,
    agentPriceSensitive: agentPrices.sensitive,
    rebateAmount: rebate,
    // 6 个时间（4.20）：建单 / 仓库签收 / 付款 / 装柜 / 发运 / 泰国签收
    prealertCreatedAt: pa.createdAt,
    signedAt: pa.signedAt,
    paidAt: pa.paymentReviewedAt,
    loadedAt: earliest("loading"),
    shippedAt: earliest("shipped"),
    thailandReceivedAt: pa.thailandReceivedAt,
  };
}

/** 给一个代理出单。一个事务，锁 agents 行排队 */
async function generateForAgent(agentId: string, now: Date, result: RebateRunResult): Promise<void> {
  await prisma.$transaction(
    async (tx: Tx) => {
      const locked = await tx.$queryRaw`SELECT id, company_id FROM agents WHERE id = ${agentId} FOR UPDATE`;
      const agentRow = (locked as Array<{ id: string; company_id: string }>)[0];
      if (!agentRow) return;
      const companyId = agentRow.company_id;

      // 锁里重读：已经出过的月份、池子
      const statements: Array<{ month: string }> = await tx.agentRebateStatement.findMany({
        where: { agentId },
        select: { month: true },
      });
      const existingMonths = new Set(statements.map((s) => s.month));

      const candidates: PrealertForRebate[] = await tx.whrConsolidationPrealert.findMany({
        where: {
          companyId,
          paidAgentId: agentId,
          status: "thailand_received",
          thailandReceivedAt: { not: null },
        },
        select: {
          id: true,
          trackingNo: true,
          mark: true,
          createdAt: true,
          signedAt: true,
          paymentReviewedAt: true,
          thailandReceivedAt: true,
          paidPriceNormal: true,
          paidPriceInspection: true,
          paidPriceSensitive: true,
          paidAgentPriceNormal: true,
          paidAgentPriceInspection: true,
          paidAgentPriceSensitive: true,
          rebateAmount: true,
          planCustomer: { select: { clientId: true, plan: { select: { planNo: true } } } },
          items: { select: { productName: true, cargoType: true, volumeM3: true }, orderBy: { sortOrder: "asc" } },
          statusLogs: {
            where: { toStatus: { in: ["loading", "shipped"] } },
            select: { toStatus: true, createdAt: true },
          },
        },
      });
      if (candidates.length === 0) return;

      const assigned: Array<{ prealertId: string }> = await tx.agentRebateLine.findMany({
        where: { prealertId: { in: candidates.map((c) => c.id) } },
        select: { prealertId: true },
      });
      const assignedIds = new Set(assigned.map((a) => a.prealertId));

      // 快照不全的先挑出来：不进单、留日志（不然每小时都算一遍错数）
      const pool: Array<PrealertForRebate & { line: NonNullable<ReturnType<typeof buildRebateLine>> }> = [];
      for (const pa of candidates) {
        if (assignedIds.has(pa.id)) continue;
        const line = buildRebateLine(pa);
        if (!line) {
          result.skippedPrealerts.push(pa.id);
          logger.warn("返现单：这票付款快照不全，没进返现单", { agentId, prealertId: pa.id, trackingNo: pa.trackingNo });
          continue;
        }
        pool.push({ ...pa, line });
      }

      for (const plan of planAgentStatements(pool, existingMonths, now)) {
        const lineCount = plan.items.length;
        const totalMilli = plan.items.reduce(
          (s, p) => s + toMilliM3(p.line.volumeNormalM3) + toMilliM3(p.line.volumeInspectionM3) + toMilliM3(p.line.volumeSensitiveM3),
          0,
        );
        const totalCents = plan.items.reduce((s, p) => s + toCents(p.line.rebateAmount), 0);
        await tx.agentRebateStatement.create({
          data: {
            companyId,
            agentId,
            month: plan.month,
            lineCount,
            totalVolumeM3: totalMilli / 1000,
            totalRebate: totalCents / 100,
            status: "unpaid",
            generatedAt: now,
            lines: { create: plan.items.map((p) => ({ ...p.line, companyId })) },
          },
        });
        result.statementsCreated += 1;
        result.linesCreated += lineCount;
        logger.info("返现单已生成", { agentId, month: plan.month, lineCount, totalRebate: totalCents / 100 });
      }
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

/**
 * 跑一轮：所有公司的所有代理。单个代理出错不影响别的代理。
 * @param now 测试时传假的「现在」
 * @param options.agentIds 只跑这几个代理（自测在共用测试库上跑时用，免得给别人的测试代理出单；
 *                         出了单代理行就删不掉 —— 外键 RESTRICT）。不传 = 全部
 */
export async function generateAgentRebateStatements(
  now: Date = new Date(),
  options: { agentIds?: string[] } = {},
): Promise<RebateRunResult> {
  const result: RebateRunResult = { agents: 0, statementsCreated: 0, linesCreated: 0, skippedPrealerts: [] };
  // ⚠️ 传了空数组 = 一个都不跑（CLAUDE.md #27：`{ in: [] }` 以外的「空条件」不许变成「不加条件」）
  if (options.agentIds && options.agentIds.length === 0) return result;
  const agents: Array<{ id: string }> = await prisma.agent.findMany({
    where: options.agentIds ? { id: { in: options.agentIds } } : undefined,
    select: { id: true },
    orderBy: { id: "asc" },
  });
  result.agents = agents.length;
  for (const a of agents) {
    try {
      await generateForAgent(a.id, now, result);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "P2002") {
        // 唯一约束兜住了重复出单（理论上锁已经挡住，这里只是兜底），当成「已经出过」
        logger.info("返现单：这个月已经出过了（唯一约束兜底）", { agentId: a.id });
        continue;
      }
      logger.error("返现单生成失败", { agentId: a.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

let running = false;
let started = false;

/** 进程内只跑一轮；上一轮没完就跳过 */
export async function runAgentRebateOnce(now: Date = new Date()): Promise<RebateRunResult | null> {
  if (running) return null;
  running = true;
  try {
    return await generateAgentRebateStatements(now);
  } finally {
    running = false;
  }
}

/**
 * 启动返现单定时生成：启动时跑一次，之后每小时一次。
 * 每月 1 号北京时间 0 点过后的第一轮就会出上个月的单（最晚晚一个小时）。
 */
export function startAgentRebateScheduler(): void {
  if (started) return;
  started = true;
  /**
   * 本机临时起的 API 自测实例设 AGENT_REBATE_SCHEDULER=off：测试库是几个人共用的，
   * 自测实例一启动就会给所有人的测试代理出单，别人删测试代理时撞外键删不掉。
   * 线上不设这个变量 = 照常跑。
   */
  if (process.env.AGENT_REBATE_SCHEDULER?.trim().toLowerCase() === "off") {
    logger.info("返现单定时生成已关闭（AGENT_REBATE_SCHEDULER=off）");
    return;
  }
  const run = () => {
    runAgentRebateOnce()
      .then((r) => {
        if (r && (r.statementsCreated > 0 || r.skippedPrealerts.length > 0)) {
          logger.info("返现单定时检查", { ...r, skippedPrealerts: r.skippedPrealerts.length });
        }
      })
      .catch((error) => {
        logger.error("返现单定时检查失败", { error: error instanceof Error ? error.message : String(error) });
      });
  };
  void run();
  const timer = setInterval(run, HOUR_MS);
  timer.unref?.();
}
