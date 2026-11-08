/* ==========================================================================
   代理申请：给海外仓财务系统后端调的两条（2026-11-08，老板：「财务提交，物流审批」）
   --------------------------------------------------------------------------
   POST /integrations/finance/v1/agent-applications   交一张申请
   GET  /integrations/finance/v1/agent-applications?warehouseId=12   按仓查（新的在前，最多 20 张）

   · 认证跟财务对接其它接口一样：Authorization: Bearer <FINANCE_LINK_SECRET>；开关没开 / 配置不合格 503 LINK_DISABLED，
     密钥不对 401 LINK_SECRET_INVALID（requireFinanceSecret）。路径在 paths.ts 的 FINANCE_LINK_PATHS 里精确放行。
   · 公司怎么定（CLAUDE.md #27）：这两条没有登录用户。拆派仓那种服务器对服务器的对接是用环境变量 CHAIPAI_COMPANY_ID 指定的，
     这一轮说好不加环境变量 —— 所以取「有正常超管账号的那家公司」，**只认正好一家**，而且要跟表里已有申请的公司一致；
     没有、不止一家、跟已有申请对不上都 503 不收，不猜（线上 2026-11-08 只读核过：超管、员工、代理、客户都在同一家公司）。
     以后真有第二家公司，再加配置。
   · 一个仓同一时间只能有一张在审的：靠 agent_applications 的 (company_id, pending_warehouse_id) 唯一约束，
     两个请求同时交，数据库只让一张进去，另一张回 409 APPLICATION_PENDING。
   · 交申请时**不查登录账号有没有人用**（不然能拿来试探物流有哪些账号），撞了由超管审批时换。
   · 返回字段在 agent-application-views.ts 逐个列，选库也只选那几列。
   ========================================================================== */

import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail } from "../core/http-utils";
import {
  type AgentApplicationRow,
  APPLICATION_PENDING_MESSAGE,
  APPLICATIONS_PER_WAREHOUSE_MAX,
  FINANCE_APPLICATION_SELECT,
  mapFinanceAgentApplication,
  parseAgentApplicationBody,
  parseWarehouseIdQuery,
} from "./agent-application-views";
import { AGENT_APPLICATIONS_PATH } from "./paths";
import { linkError, requireFinanceSecret } from "./routes";

/**
 * 申请算哪家公司的：有正常（status=active）超管账号的公司，正好一家才用；0 家或 2 家以上返回 null（调用方 503）。
 * 还要跟**已经收进来的申请**对得上（Codex 审查）：表里已有的申请都属于同一家公司，而且就是这一家，才用它 ——
 * 不然以后真有第二家公司、前一家超管全停用时，申请会悄悄改记到另一家（前一家的历史也查不到了）。对不上就 null，不猜。
 * 每次现查（超管账号、申请都很少，查得很快），不缓存。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveApplicationCompanyId(db: any = prisma): Promise<string | null> {
  const admins = await db.user.findMany({
    where: { role: "admin", status: "active" },
    select: { companyId: true },
    distinct: ["companyId"],
    take: 2,
  });
  if (admins.length !== 1) return null;
  const companyId = admins[0].companyId;
  const bound = await db.agentApplication.findMany({ select: { companyId: true }, distinct: ["companyId"], take: 2 });
  if (bound.length > 1 || (bound.length === 1 && bound[0].companyId !== companyId)) return null;
  return companyId;
}

const COMPANY_UNKNOWN_MESSAGE = "物流系统现在收不了代理申请，请联系湘泰";

/**
 * 交申请排队（咨询锁 83090，号段接着 finance-link/routes.ts 的 83080）：「定公司 → 核对已有申请的公司 → 写进去」三步
 * 在同一个事务里、一张一张来（Codex 第 2 轮）。不然表还空着时、正好换超管那一下，两个请求能各自记到不同的公司。
 * 事务第一句、手里没有行锁；申请很少，排队不碍事。scripts/test-lock-order.ts 的 LOCK_HELPERS 登记着它。
 */
async function lockAgentApplicationIntake(tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(83090)`;
}

function isPendingConflict(error: unknown): boolean {
  const e = error as { code?: string; meta?: { target?: unknown } };
  if (e?.code !== "P2002") return false;
  const target = JSON.stringify(e.meta?.target ?? "");
  return target.includes("pending_warehouse_id") || target.includes("pendingWarehouseId");
}

export function registerFinanceAgentApplicationRoutes(app: MinimalHttpApp): void {
  app.post(AGENT_APPLICATIONS_PATH, async (req, res) => {
    if (!requireFinanceSecret(req, res)) return;
    const parsed = parseAgentApplicationBody(req.body);
    if (!parsed.ok) { fail(res, 400, "BAD_REQUEST", parsed.message); return; }

    const input = parsed.value;
    let row: AgentApplicationRow | null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row = await prisma.$transaction(async (tx: any) => {
        await lockAgentApplicationIntake(tx);
        const companyId = await resolveApplicationCompanyId(tx);
        if (!companyId) return null;
        return tx.agentApplication.create({
          data: {
            companyId,
            warehouseId: input.warehouseId,
            warehouseName: input.warehouseName,
            submitterName: input.submittedBy,
            agentName: input.agentName,
            contactName: input.contactName,
            contactPhone: input.contactPhone,
            loginId: input.loginId,
            remark: input.remark,
            status: "pending",
            // 在审标记：处理（通过 / 驳回）时清空，这个仓才能再交
            pendingWarehouseId: input.warehouseId,
          },
          select: FINANCE_APPLICATION_SELECT,
        });
      }, { timeout: 10_000, maxWait: 5_000 });
    } catch (error) {
      if (isPendingConflict(error)) { linkError(res, 409, "APPLICATION_PENDING", APPLICATION_PENDING_MESSAGE); return; }
      throw error;
    }
    if (!row) { linkError(res, 503, "AGENT_APPLY_UNAVAILABLE", COMPANY_UNKNOWN_MESSAGE); return; }
    res.status(201).json({ application: mapFinanceAgentApplication(row) });
  });

  app.get(AGENT_APPLICATIONS_PATH, async (req, res) => {
    if (!requireFinanceSecret(req, res)) return;
    const wid = parseWarehouseIdQuery(req.query.warehouseId);
    if (!wid.ok) { fail(res, 400, "BAD_REQUEST", wid.message); return; }
    const companyId = await resolveApplicationCompanyId();
    if (!companyId) { linkError(res, 503, "AGENT_APPLY_UNAVAILABLE", COMPANY_UNKNOWN_MESSAGE); return; }

    const rows = await prisma.agentApplication.findMany({
      where: { companyId, warehouseId: wid.value },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: APPLICATIONS_PER_WAREHOUSE_MAX,
      select: FINANCE_APPLICATION_SELECT,
    });
    res.status(200).json({ items: rows.map(mapFinanceAgentApplication) });
  });
}
