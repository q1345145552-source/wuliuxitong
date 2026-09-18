import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { ok, requireRole } from "../core/http-utils";
import { whrBucket, taskBucket, isDead, type Bucket } from "./money-rules";

/* ==========================================================================
   财务管理（2026-08-27 重做）
   --------------------------------------------------------------------------
   ⚠️ **这一页只统计集货拼柜的两个功能，不再碰运单。**

   老板 2026-08-26 原话：「运单号不要计算价格，跟金钱无关。
   和金钱相关的只有整柜的那两个功能。」

   改之前这一页是按「每张运单」列重量体积和付款状态的 —— 方向就跟生意对不上：
   1063 张订单里 0 张录过应收金额、0 张标过已付款，那一页从上线到现在是空的。

   两个集货版本算钱的方式不一样（别搞混）：
   - **普通版**（consolidation_tasks）：员工在「报价」里手填订舱费+清关费+装柜费，
     系统只做加法，跟方数货型无关。
   - **仓库版**（whr_consolidation_prealerts）：管理员给每个客户手填三档单价（元/方），
     **仓库签收那一刻系统按「方数 × 单价」自动算**。整个模块没有手填总金额的入口。
   ========================================================================== */

/** Decimal | null → number（合计用，没填按 0 参与求和） */
function num(v: any): number {
  if (v === null || v === undefined) return 0;
  return Number(v.toString());
}

/** Decimal | null → number | null（明细行用，没填要留空，不能显示成 0） */
function numOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  return Number(v.toString());
}

/**
 * 仓库版状态 → 中文。取值以生产库实测为准（2026-08-27）：
 * pending / received_pending_payment / thailand_received 三种在用，
 * 其余是代码里写得出但生产还没出现过的。
 */
const WHR_STATUS_ZH: Record<string, string> = {
  pending: "等收货",
  received_pending_payment: "已收货待付款",
  payment_submitted: "已交凭证待审核",
  paid: "已付款",
  loading: "装柜中",
  shipped: "已发运",
  thailand_received: "已到泰国",
  cancelled: "已取消",
};

/** 普通版任务状态 → 中文 */
const TASK_STATUS_ZH: Record<string, string> = {
  collecting: "收集中",
  full_confirmed: "已满待报价",
  quoted: "已报价待付款",
  paid: "已付款",
  loading: "装柜中",
  in_transit: "运输中",
  customs: "清关中",
  delivering: "派送中",
  completed: "已完成",
  cancelled: "已取消",
};

/**
 * ⚠️ 用**黑名单**判断「这单还算不算数」，不要用白名单（CLAUDE.md 第 13 条）。
 * 白名单漏掉一个新状态，那批单子就会从财务页上凭空消失。
 */

export function registerFinanceRoutes(app: MinimalHttpApp): void {
  app.get("/admin/finance/summary", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const [tasks, prealerts, wallets] = await Promise.all([
      prisma.consolidationTask.findMany({
        where: { companyId: auth.companyId },
        select: {
          id: true, taskNo: true, status: true, paymentStatus: true,
          totalFee: true, bookingFee: true, customsFee: true, loadingFee: true,
          createdAt: true,
          clientId: true,
        },
      }),
      prisma.whrConsolidationPrealert.findMany({
        where: { companyId: auth.companyId },
        select: {
          id: true, trackingNo: true, mark: true, status: true,
          totalFee: true, createdAt: true,
          // ⚠️ 必须把**父计划的状态**也读出来（2026-08-27 修）。
          // 整个柜被取消时，底下的预报单状态**不会**跟着变成 cancelled ——
          // 只看预报单自己的状态，这张单还是「已收货待付款」，会被算进待收款去催。
          // 柜子收款页跳过了取消的柜，财务页没跳，两页对不上就是这么来的。
          planCustomer: { select: { clientId: true, plan: { select: { status: true } } } },
        },
      }),
      prisma.clientWalletAccount.findMany({
        where: { companyId: auth.companyId, currency: "CNY" },
        select: { clientId: true, balance: true },
      }),
    ]);

    type Row = {
      bucket: Bucket;
      kind: "normal" | "warehouse";
      kindLabel: string;
      no: string;
      client: string;
      /** 唛头（账号），只给搜索用：仓库版那一行显示的是客户自填的唛头，跟账号不一样 */
      clientId: string;
      status: string;
      statusZh: string;
      amount: number | null;
      paid: boolean;
      createdAt: string;
    };

    const rows: Row[] = [];

    for (const t of tasks) {
      rows.push({
        bucket: taskBucket(t.status, t.paymentStatus, t.totalFee != null),
        kind: "normal",
        kindLabel: "普通版",
        no: t.taskNo,
        // 显示唛头（账号），不显示客户名字：名字只给内部看，也会重名（2026-09-19）
        client: t.clientId || "—",
        clientId: t.clientId,
        status: t.status,
        statusZh: TASK_STATUS_ZH[t.status] ?? t.status,
        // 已取消的单不欠也不收，金额显示「—」——否则有人把表里的数加起来会跟上面四个数字对不上
        amount: isDead(t.status) ? null : numOrNull(t.totalFee),
        paid: t.paymentStatus === "paid",
        createdAt: t.createdAt.toISOString(),
      });
    }
    for (const p of prealerts) {
      // 父计划取消 = 整柜作废，底下每张单都不算数
      const planDead = isDead(p.planCustomer?.plan?.status ?? "");
      rows.push({
        bucket: planDead ? "dead" : whrBucket(p.status),
        kind: "warehouse",
        kindLabel: "仓库版",
        no: p.trackingNo,
        // 仓库版这张表上没有客户名，只有唛头；唛头本来就是客户在系统里的标识
        client: p.mark || "—",
        clientId: p.planCustomer?.clientId ?? "",
        status: p.status,
        statusZh: planDead ? "整柜已取消" : (WHR_STATUS_ZH[p.status] ?? p.status),
        amount: planDead || isDead(p.status) ? null : numOrNull(p.totalFee),
        paid: !planDead && whrBucket(p.status) === "received",
        createdAt: p.createdAt.toISOString(),
      });
    }
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    /* ── 四个数字 ──────────────────────────────────────────────
       待收款：货已经到仓、报了价、客户还没付 —— 这是真正该去催的钱
       已收款：客户已经付了
       未报价：单子建了但还没到收款环节（仓库版「等收货」）—— 不算应收
       客户余额：客户充值了还没花掉的钱
       ⚠️ 已取消的单一律不进任何一个数字
    */
    let receivable = 0, receivableCount = 0;
    let received = 0, receivedCount = 0;
    let notYet = 0, notYetCount = 0;

    for (const r of rows) {
      const amt = r.amount ?? 0;
      if (r.bucket === "received") { received += amt; receivedCount++; }
      else if (r.bucket === "receivable") { receivable += amt; receivableCount++; }
      else if (r.bucket === "notYet") { notYet += amt; notYetCount++; }
      // dead（已取消）一律不进任何一个数字
    }

    const balance = wallets.reduce((s, w) => s + num(w.balance), 0);
    const round2 = (n: number) => Math.round(n * 100) / 100;

    ok(res, {
      receivableAmount: round2(receivable),
      receivableCount,
      receivedAmount: round2(received),
      receivedCount,
      notYetAmount: round2(notYet),
      notYetCount,
      balanceAmount: round2(balance),
      balanceClientCount: wallets.filter((w) => num(w.balance) > 0).length,
      rows,
    });
  });
}
