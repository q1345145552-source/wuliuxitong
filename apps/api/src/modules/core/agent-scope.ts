/* ==========================================================================
   代理账号的「名下范围」工具 + 服务端统一闸（2026-09-16）
   --------------------------------------------------------------------------
   需求：docs/交接文档-附件-代理账号确认单/final.md（不进 git）
     1.2 代理只看自己名下客户；3.6 / 4.1 / 5.7 代理的客户不能用 AI、不能用普通版集货。

   ⚠️ 所有 /agent/* 接口必须经 requireAgent + 名下范围；查不到一律回同一种 404，
      不许区分「不存在」和「不是你的」。
   ⚠️ 这个文件是 B 阶段共享只读的：要改写进报告由编排者改。
   ========================================================================== */

import { prisma } from "../../db/prisma";
import type { HttpRequest, HttpResponse } from "../../server";
import { fail, requireAuth } from "./http-utils";

type Auth = NonNullable<HttpRequest["auth"]>;

/** requireAgent 放行后拿到的身份：agentId 一定非空 */
export type AgentAuth = Auth & { role: "agent"; agentId: string };

/** 代理的客户（client 且 agentId 非空）碰这些前缀一律 403 */
export const AGENT_CLIENT_BLOCKED_PREFIXES = ["/client/consolidation", "/client/ai"] as const;
export const AGENT_CLIENT_BLOCKED_MESSAGE = "该功能暂未开放";

/**
 * 代理本人（role=agent）只许碰这些前缀，别的一律 403。
 *
 * ⚠️ 这是**第二道**闸（2026-09-16 A2 加，规格里没写死，写进了报告）：
 * 第一道是现有 140 处 requireRole 名单都不含 agent。但总有接口只 requireAuth、
 * 或者直接读 req.auth 再按 `role === "client" ? 只看自己 : 全公司` 分支 ——
 * 那种写法里 agent 会掉进「全公司」那一支。代理能用的东西设计上全部在 /agent/*，
 * 所以在最外层一刀切，以后新写的接口忘了挡也漏不出去。
 * /auth/* 要留着：退出登录、改自己密码、登录页品牌都在这下面。
 */
export const AGENT_ALLOWED_PREFIXES = ["/agent", "/auth"] as const;

/** 按「路径段」匹配前缀：/client/ai 命中 /client/ai 和 /client/ai/xxx，不命中 /client/aiyyy */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * 服务端统一闸（server.ts 路由分发前调用）。纯函数，方便自测。
 * @returns 要拦就返回给人看的那句话；放行返回 null
 */
export function agentGateRejection(
  auth: Pick<Auth, "role" | "agentId"> | undefined,
  path: string,
): string | null {
  if (!auth) return null;
  if (auth.role === "client" && auth.agentId) {
    if (AGENT_CLIENT_BLOCKED_PREFIXES.some((p) => underPrefix(path, p))) return AGENT_CLIENT_BLOCKED_MESSAGE;
    return null;
  }
  if (auth.role === "agent") {
    if (AGENT_ALLOWED_PREFIXES.some((p) => underPrefix(path, p))) return null;
    return "permission denied";
  }
  return null;
}

/**
 * /agent/* 接口的入口：必须 role=agent 且 agentId 非空，否则 403。
 * agentId 为空的 agent 账号是脏数据（开代理时一个事务同时建 agents 行和 users 行），
 * 当成没有权限处理，绝不能当成「不限范围」。
 */
export function requireAgent(req: HttpRequest, res: HttpResponse): AgentAuth | null {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  if (auth.role !== "agent" || !auth.agentId) {
    fail(res, 403, "FORBIDDEN", "permission denied");
    return null;
  }
  return auth as AgentAuth;
}

/**
 * 这个代理名下全部客户的 id（role=client、同公司）。
 * ⚠️ 参数为空一律返回空数组（CLAUDE.md #27：加过滤必须判空）——
 *    `where: { agentId: undefined }` 在 Prisma 里等于**不加条件**，会把全公司客户拉出来。
 */
export async function listAgentClientIds(agentId: string, companyId: string): Promise<string[]> {
  if (!agentId || !companyId) return [];
  const rows = await prisma.user.findMany({
    where: { agentId, companyId, role: "client" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => r.id);
}

/**
 * 这个客户是不是这个代理名下的。只认 role=agent 的身份；别的角色一律 false。
 * 同样判空：clientId / agentId 为空直接 false，不去查库。
 */
export async function agentOwnsClient(
  auth: Pick<Auth, "role" | "agentId" | "companyId">,
  clientId: string,
): Promise<boolean> {
  if (auth.role !== "agent" || !auth.agentId || !auth.companyId || !clientId) return false;
  const row = await prisma.user.findFirst({
    where: { id: clientId, agentId: auth.agentId, companyId: auth.companyId, role: "client" },
    select: { id: true },
  });
  return row !== null;
}
