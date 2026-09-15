import type { MinimalHttpApp } from "../../server";

/**
 * 代理工作台接口 /agent/*（2026-09-16 空壳，B3 填内容）。
 * ⚠️ 每个接口必须经 core/agent-scope.ts 的 requireAgent + 名下范围；
 *    给代理的每个字段明确列出（CLAUDE.md #31），查不到统一 404。
 */
export function registerAgentPortalRoutes(_app: MinimalHttpApp): void {
  // B3：GET /agent/me、/agent/clients ...
}
