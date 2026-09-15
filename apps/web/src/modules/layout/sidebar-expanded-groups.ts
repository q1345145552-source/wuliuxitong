import type { AuthRole } from "../../auth/auth-session";

/**
 * 侧边栏哪些功能分组是展开的：默认值 + localStorage 记忆（从 RoleShell 挪出来，方便脚本直接测）。
 */
export const EXPANDED_GROUPS_KEY = "xt_sidebar_expanded_groups";
export const DEFAULT_EXPANDED_GROUPS = ["运单管理", "我的运单"];

/**
 * 代理的展开记忆单独存、默认展开「我的客户」（2026-09-16 第 2 轮复核）。
 *
 * 原来的问题：代理只有「我的客户」一组，7 项全带 #；登录落地 /agent 不带 #，自动展开对不上，
 * 默认展开的名单里也没有它 —— 第一次进来左边只剩「代理工作台」一行，功能全藏在收起的组里。
 * 为什么单独一个键：展开记忆原来是所有角色共用一个键。老板在自己浏览器里点过管理端的分组、
 * 再登代理号，读到的是管理端的记忆（里面没有「我的客户」），照样整组收起。
 * ⚠️ 管理员/员工/客户继续用老键、老默认值 —— 他们现有的展开记忆和落地时的样子一点不变。
 * ⚠️ 没改成「路径对上某组第一项、只是没带 # 也自动展开」：那样管理员落地 /admin 会把「运营看板」
 *    也自动展开（变了），而且自动展开每次刷新都会把用户手动收起的组又打开。
 */
export const AGENT_EXPANDED_GROUPS_KEY = "xt_sidebar_expanded_groups_agent";
export const AGENT_DEFAULT_EXPANDED_GROUPS = ["我的客户"];

export function expandedGroupsKey(role: AuthRole | null | undefined): string {
  return role === "agent" ? AGENT_EXPANDED_GROUPS_KEY : EXPANDED_GROUPS_KEY;
}

export function defaultExpandedGroups(role: AuthRole | null | undefined): string[] {
  return role === "agent" ? AGENT_DEFAULT_EXPANDED_GROUPS : DEFAULT_EXPANDED_GROUPS;
}

/**
 * 读记忆。没记过返回 null（调用方用默认值）。
 * localStorage 本身可能抛错（Safari 无痕模式、用户关掉网站数据），
 * 所以读写都要包起来 —— 记不住是小事，把整个工作台顶掉是大事。
 */
export function readExpandedGroups(role: AuthRole | null | undefined): string[] | null {
  try {
    const raw = window.localStorage.getItem(expandedGroupsKey(role));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : null;
  } catch {
    return null;
  }
}

/** 记忆 + 默认值合起来：有记忆就完全照记忆（用户收起的不许被默认值重新打开），没记忆才用默认值 */
export function initialExpandedGroups(role: AuthRole | null | undefined): Set<string> {
  return new Set(readExpandedGroups(role) ?? defaultExpandedGroups(role));
}

export function saveExpandedGroups(role: AuthRole, groups: Set<string>): void {
  try {
    window.localStorage.setItem(expandedGroupsKey(role), JSON.stringify([...groups]));
  } catch {
    /* 隐私模式 / 配额满：记不住就算了，不影响使用 */
  }
}
