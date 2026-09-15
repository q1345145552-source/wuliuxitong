import type { MinimalHttpApp } from "../../server";

/**
 * 超管「代理管理」+「返现单」接口（2026-09-16 空壳，B2 填内容）。
 * 设计：docs/交接文档-附件-代理账号确认单/做法-技术设计.md 第 3、5 节（不进 git）。
 * ⚠️ 全部接口 requireRole(["admin"])；开代理一个事务同时建 agents 行和 users(role=agent) 行。
 */
export function registerAgentAdminRoutes(_app: MinimalHttpApp): void {
  // B2：GET/POST /admin/agents ...
}
