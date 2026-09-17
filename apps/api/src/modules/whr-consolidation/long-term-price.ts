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
import { canSeeOperatorIdentity } from "../core/operator-visibility";
import { BusinessError } from "../core/business-error";
import { requireUnitPrice } from "../core/decimal-guard";
import { recalcCustomerTotals, recalcUnpaidPrealertFees, toNum } from "./utils";

export interface WhrPriceTriple {
  normal: number;
  inspection: number;
  sensitive: number;
}

type Tx = any;

/**
 * 「客户长期价」这套功能的总开关（2026-09-18）。
 *
 * 老板拍板改成「每个柜当场填价」并让代理端前端下线，但要求**后端保留、以后可能会用**。
 * 光把页面入口拆掉不够：这两个写接口（代理 `POST /agent/clients/price`、超管 `POST /admin/clients/whr-price`）
 * 一旦被人直接调到（代理自己就能登录、或者谁开着旧页面），`setClientWhrPrice` 会把这位客户
 * **所有**在跑的柜里的三档价一次覆盖掉、还重算没付款的单 —— 等于把当场填的价悄悄抹了（Opus 复核 2026-09-18 第 2 条）。
 * 所以功能关闭期间两个写接口一律拒绝；要开回来，把这里改成 true（前端那个开关在 apps/web/src/modules/agent/agent-features.ts）。
 * 读的那几条（客户列表带出长期价等）不受影响。
 */
export const LONG_TERM_PRICE_WRITE_ENABLED = false;
export const LONG_TERM_PRICE_OFF_MESSAGE = "客户长期价这个功能暂时关闭了（2026-09-18 起价格改成建柜 / 加客户 / 改单价时当场填）";

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

/** 一位客户的「最低价」：他所属代理那三档价。湘泰自己的客户没有下限（agentId 为空） */
export interface AgentPriceFloor {
  agentId: string;
  clientName: string;
  floor: WhrPriceTriple;
}

/**
 * 【第一步】锁住这些客户所属代理那几行，把「最低价」读出来。
 *
 * 为什么要跟判断拆开（Opus 第三轮复核第 10 条）：锁序写死是
 * 【客户价排队锁 → agents FOR SHARE → 计划行 FOR UPDATE】，
 * 所以 agents 必须在锁计划**之前**拿；可是「改单价」要比的那三档，得等锁住计划、
 * **重读**柜里那一行之后才算得出来（只改传上来的档、其余沿用现价）。
 * 上一版为了顺序对，拿**事务外**读到的现价先判了一遍 ——
 * 别人刚把另外两档改低，就会给出一个跟锁里复判不一样的结论，把合法的改动拦下来。
 * 现在：先用这个函数**只拿锁、只读下限**，锁完计划、重读那一行之后再用下面那个函数判。
 *
 * 建柜 / 加客户那两条路三档价都来自请求本身、没有「重读之后才知道」的问题，
 * 可以直接用下面的 `assertPlanPricesNotBelowAgent`（它就是这两步连着做）。
 */
export async function lockAgentPriceFloors(
  tx: Tx,
  companyId: string,
  clientIds: string[],
  /** 看报错的人是谁（同 assertNotBelowAgentFloors 的说明）：这里那句「代理不存在」也要分人说，必填 */
  viewerRole: string,
): Promise<Map<string, AgentPriceFloor>> {
  const out = new Map<string, AgentPriceFloor>();
  const wanted = [...new Set(clientIds)];
  if (wanted.length === 0) return out;
  const clients: Array<{ id: string; name: string; agentId: string | null }> = await tx.user.findMany({
    where: { id: { in: wanted }, companyId, role: "client" },
    select: { id: true, name: true, agentId: true },
  });
  /**
   * ⚠️ 查不到就 throw，**不许静默跳过**（CLAUDE.md #27：加了过滤必须加「查不到就 return」）。
   * 「改单价」那条路的 clientId 是从柜里那一行拿的，users 那行要是 companyId / role 对不上，
   * 上一版会 `continue` 把这道算钱的闸整条跳过 —— 等于没闸（Opus 第三轮复核第 12 条）。
   */
  if (clients.length !== wanted.length) {
    throw new BusinessError("这几位客户里有查不到的（可能刚被改过），请刷新页面后重试", 400, "BAD_REQUEST");
  }
  const agentIds = [...new Set(clients.map((c) => c.agentId).filter((id): id is string => !!id))];
  const prices = new Map<string, WhrPriceTriple>();
  // ⚠️ 排序写在循环这一行（`[...x].sort()`）：取锁循环的顺序必须**当场看得见**，
  //    不能靠「上面那个变量已经排过了」—— 下一个改代码的人看不见就等于没有（test-lock-order.ts 第 6 项）
  for (const agentId of [...agentIds].sort()) {
    // 按 id 排序逐个拿共享锁（调高代理价那边拿的是排他锁，两边自然排队）
    const rows = await tx.$queryRaw<Array<{ price_normal: unknown; price_inspection: unknown; price_sensitive: unknown }>>`SELECT price_normal, price_inspection, price_sensitive FROM agents WHERE id = ${agentId} AND company_id = ${companyId} FOR SHARE`;
    if (!rows || rows.length === 0) {
      /**
       * ⚠️ 这句话也要分人说：原来一律说「这个客户**所属的代理**不存在」，
       * 等于告诉员工「这个客户归某个代理」—— 跟下面那条下限提示是同一类泄漏（Opus 第三轮复核第 2 条）。
       */
      throw new BusinessError(
        canSeeOperatorIdentity(viewerRole)
          ? "这个客户所属的代理不存在，请联系管理员"
          : "这个客户的价格设置有问题，请联系超级管理员",
        400,
        "BAD_REQUEST",
      );
    }
    prices.set(agentId, {
      normal: toNum(rows[0].price_normal),
      inspection: toNum(rows[0].price_inspection),
      sensitive: toNum(rows[0].price_sensitive),
    });
  }
  for (const c of clients) {
    if (!c.agentId) continue; // 湘泰自己的客户不受这道闸管
    out.set(c.id, { agentId: c.agentId, clientName: c.name, floor: prices.get(c.agentId)! });
  }
  return out;
}

/**
 * 【第二步】拿上一步读到的下限判这几档价，低了就 400。不碰数据库。
 *
 * @param viewerRole 看这条报错的人是谁。员工（staff）**不许看到代理价、也不许知道这个客户归代理**
 *   （9-15 确认单：员工在任何地方都看不到客户属于哪个代理、代理价、返现；接口返回里有就算泄漏）。
 *   所以给员工的话里不带数字、不提代理；超管才看得到具体下限（Opus 第二轮复核第 2 条）。
 *   ⚠️ **必填，不给默认值**：默认成 "admin" 的话，以后谁新加入口漏传，失效方向就是「把代理价报给员工」
 *   （Opus / DeepSeek 第三轮复核）。
 */
export function assertNotBelowAgentFloors(
  floors: Map<string, AgentPriceFloor>,
  entries: Array<{ clientId: string; clientName?: string; prices: WhrPriceTriple }>,
  viewerRole: string,
): void {
  const canSeeAgentPrice = canSeeOperatorIdentity(viewerRole); // 只有超管
  const issues: string[] = [];
  for (const entry of entries) {
    const hit = floors.get(entry.clientId);
    if (!hit) continue; // 湘泰自己的客户不受这道闸管（查不到客户在上一步就 throw 了）
    for (const key of ["normal", "inspection", "sensitive"] as const) {
      if (toCents(entry.prices[key]) < toCents(hit.floor[key])) {
        const who = entry.clientName ?? hit.clientName ?? entry.clientId;
        issues.push(canSeeAgentPrice
          ? `${who}的${PRICE_LABEL[key]}单价不能低于给代理的价 ${formatPrice(hit.floor[key])} 元/方`
          : `${who}的${PRICE_LABEL[key]}单价填低了，这个客户有最低价限制，请联系超级管理员确认后再填`);
      }
    }
  }
  if (issues.length > 0) throw new BusinessError(issues.join("；"), 400, "BAD_REQUEST");
}

/**
 * 柜里给客户填的三档价**不能低于湘泰给他所属代理的价**（2026-09-18 恢复「每柜当场填」时补回来）。
 * 这是上面两步连着做：锁代理行读下限 → 判。三档价来自请求本身的入口（建柜 / 加客户）用它。
 *
 * 9-15 那批定的规矩（确认单 4.7）原来由 `setClientWhrPrice` 把着；价格改成每个柜当场填以后，
 * 建柜 / 加客户 / 改单价这三个入口都要自己把这道闸补上 —— 不然代理客户的柜价能填得比代理价低，
 * 付款照收、返现算出来是负数被记成 0（utils.ts），等于湘泰每方少收（代理价 − 客户价）（DeepSeek 复核 2026-09-18 第 1 条）。
 *
 * ⚠️ 锁序跟 setClientWhrPrice 一致：调用方先拿「客户价排队锁」，这里再对 agents 行拿 FOR SHARE，之后才锁计划。
 * 反过来（先锁计划再锁 agents）会跟改长期价那条路对着拿锁。
 */
export async function assertPlanPricesNotBelowAgent(
  tx: Tx,
  companyId: string,
  entries: Array<{ clientId: string; clientName?: string; prices: WhrPriceTriple }>,
  viewerRole: string,
): Promise<void> {
  if (entries.length === 0) return;
  const floors = await lockAgentPriceFloors(tx, companyId, entries.map((e) => e.clientId), viewerRole);
  assertNotBelowAgentFloors(floors, entries, viewerRole);
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

/**
 * 代理给**自己名下**客户改长期价（`POST /agent/clients/price` 的全部业务逻辑）。
 *
 * ⚠️ 为什么从路由里搬出来（2026-09-18 复核第 6 条）：功能关闭之后接口进门就 400，
 * 「这个客户是不是你名下的」那道闸**再也没有测试走得到**了 —— 等哪天开回来，它坏了没人知道。
 * 搬到这里之后，测试可以绕开开关直接调这个函数，接口那边只剩「判角色 → 判开关 → 收参数 → 调它」。
 *
 * ⚠️ 归属判断必须在锁里做（CLAUDE.md #28）：超管改客户归属也先拿同一把客户价锁，
 * 事务外判完再进来，中间客户被改到别的代理名下，就成了「A 代理改了 B 代理客户的价」。
 * 锁序：客户价排队锁在最前，跟 setClientWhrPrice 一致（同一会话可重入，不会自己等自己）。
 */
export async function setAgentClientWhrPrice(input: {
  companyId: string;
  agentId: string;
  clientId: string;
  prices: Record<keyof WhrPriceTriple, unknown>;
  actor: { userId: string; role: string };
  /** 查不到时统一的说法：不区分「不存在」和「不是你名下的」 */
  notFoundMessage?: string;
}): Promise<{ updatedPlanRows: number }> {
  // 参数不合法就别碰数据库（跟 setClientWhrPrice 同一套校验）
  parseWhrPriceInput(input.prices);
  return prisma.$transaction(
    async (tx) => {
      await lockClientWhrPrice(tx, input.clientId);
      const owned = await tx.user.findFirst({
        where: { id: input.clientId, agentId: input.agentId, companyId: input.companyId, role: "client" },
        select: { id: true },
      });
      if (!owned) throw new BusinessError(input.notFoundMessage ?? "客户不存在或不在你名下", 404, "NOT_FOUND");
      return setClientWhrPrice(
        { companyId: input.companyId, clientId: input.clientId, prices: input.prices, actor: input.actor },
        tx,
      );
    },
    { timeout: 30000, maxWait: 10000 },
  );
}

/** 「这个客户归代理管」那句话放这里：超管那条路和测试都从这儿拿，别两处各写一份 */
export const AGENT_CLIENT_PRICE_READONLY_MESSAGE = "这个客户归代理管，价格由代理自己填，超级管理员这里不能改";

/**
 * 超管给**湘泰自己的客户**改长期价（`POST /admin/clients/whr-price` 的全部业务逻辑）。
 *
 * ⚠️ 跟 `setAgentClientWhrPrice` 同一个理由搬出来（Opus 第三轮复核第 6 条）：
 * 功能关闭之后接口进门就 400，「代理客户超管不许改」那道闸**再也没有测试走得到**了。
 * 搬到这里之后测试可以绕开开关直接测它，接口那边只剩「判角色 → 判开关 → 收参数 → 调它」。
 *
 * ⚠️ 归属判断必须在锁里做（CLAUDE.md #28）：事务外判完再进来，中间客户被改到代理名下，
 * 就成了「超管改了代理客户的价」。锁序：客户价排队锁在最前，跟 setClientWhrPrice 一致。
 */
export async function setNonAgentClientWhrPrice(input: {
  companyId: string;
  clientId: string;
  prices: Record<keyof WhrPriceTriple, unknown>;
  actor: { userId: string; role: string };
}): Promise<{ updatedPlanRows: number }> {
  // 参数不合法就别碰数据库（跟 setClientWhrPrice 同一套校验）
  parseWhrPriceInput(input.prices);
  return prisma.$transaction(
    async (tx) => {
      await lockClientWhrPrice(tx, input.clientId);
      const fresh = await tx.user.findFirst({
        where: { id: input.clientId, companyId: input.companyId, role: "client" },
        select: { agentId: true },
      });
      if (!fresh) throw new BusinessError("客户不存在", 404, "NOT_FOUND");
      if (fresh.agentId) throw new BusinessError(AGENT_CLIENT_PRICE_READONLY_MESSAGE, 403, "FORBIDDEN");
      return setClientWhrPrice(
        { companyId: input.companyId, clientId: input.clientId, prices: input.prices, actor: input.actor },
        tx,
      );
    },
    { timeout: 30000, maxWait: 10000 },
  );
}
