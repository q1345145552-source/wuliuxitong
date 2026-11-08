/**
 * 管理员工作台「客户管理」按归属筛（2026-11-08 老板：「客户管理那边要加筛选，比如筛选是哪个代理的客户或者我们自己的」）。
 *
 * 客户名单是 GET /admin/users?role=client 一次全拿回来的（没有分页），所以在页面上筛就够，不用改接口。
 * 跟搜索框叠着用：先按归属筛，再按搜索词筛。
 * 纯函数，不引 react，测试（scripts/test-admin-client-filter.ts）直接跑。
 */

/** 下拉框的值：全部 / 湘泰自己的客户（没挂代理）/ 某个代理名下的 */
export type ClientAgentFilter = { kind: "all" } | { kind: "self" } | { kind: "agent"; agentId: string };

export const CLIENT_AGENT_FILTER_ALL: ClientAgentFilter = { kind: "all" };

/** 筛选只看这几样，页面上的客户行（AdminUserItem）直接能传进来 */
export interface ClientRowForFilter {
  id: string;
  name?: string | null;
  companyName?: string | null;
  phone?: string | null;
  email?: string | null;
  agentId?: string | null;
  agentName?: string | null;
}

export interface AgentOptionForFilter {
  id: string;
  name: string;
  /** 代理登录账号，同名时拿来区分；没有就空 */
  loginId?: string | null;
}

/** 下拉框里的一项：label 是给人看的（同名代理后面带账号） */
export interface ClientAgentFilterOption {
  id: string;
  label: string;
}

/** 下拉框 <option> 的 value。代理用 agent: 前缀，跟「all」「self」永远撞不上 */
export function clientAgentFilterValue(filter: ClientAgentFilter): string {
  if (filter.kind === "agent") return `agent:${filter.agentId}`;
  return filter.kind;
}

/** 反过来：下拉框选中的 value → 筛选条件。认不出来的当「全部」 */
export function parseClientAgentFilter(value: string): ClientAgentFilter {
  if (value === "self") return { kind: "self" };
  if (value.startsWith("agent:") && value.length > "agent:".length) return { kind: "agent", agentId: value.slice("agent:".length) };
  return CLIENT_AGENT_FILTER_ALL;
}

/**
 * 下拉框里列哪些代理：代理名单（按开代理的先后）在前；名单里没有、但客户身上挂着的代理补在后面
 * （第一次拉代理名单就失败、手上还是空名单时，照样能按客户身上的代理筛）。
 * 当前选中的代理两边都找不到（比如刚被删了）也留一项，不然下拉框显示的跟实际筛的对不上。
 * 代理能重名（库里名字不唯一）：同名的几个后面带上登录账号，没有账号的带编号尾巴，不然分不清选的是哪个（Codex 审查）。
 */
export function clientAgentFilterOptions(
  agents: readonly AgentOptionForFilter[],
  clients: readonly ClientRowForFilter[],
  selected: ClientAgentFilter,
): ClientAgentFilterOption[] {
  const rows: AgentOptionForFilter[] = [];
  const seen = new Set<string>();
  for (const a of agents) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    rows.push({ id: a.id, name: a.name, loginId: a.loginId });
  }
  for (const c of clients) {
    if (!c.agentId || seen.has(c.agentId)) continue;
    seen.add(c.agentId);
    rows.push({ id: c.agentId, name: c.agentName || "代理" });
  }
  if (selected.kind === "agent" && !seen.has(selected.agentId)) {
    rows.push({ id: selected.agentId, name: "已不在名单里的代理" });
  }
  const sameName = new Map<string, number>();
  for (const r of rows) sameName.set(r.name, (sameName.get(r.name) ?? 0) + 1);
  return rows.map((r) => ({
    id: r.id,
    label: (sameName.get(r.name) ?? 0) > 1 ? `${r.name}（${r.loginId ? `账号 ${r.loginId}` : `编号尾 ${r.id.slice(-6)}`}）` : r.name,
  }));
}

/** 这个客户归不归这个筛选。没挂代理（agentId 空）就是湘泰自己的客户，跟卡片上「所属代理」那一格同一个判断 */
export function matchesClientAgentFilter(client: ClientRowForFilter, filter: ClientAgentFilter): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "self") return !client.agentId;
  return client.agentId === filter.agentId;
}

/**
 * 先按归属筛，再按搜索词筛（账号、客户名字、公司名字、电话、邮箱 —— 命中任意一样就算；
 * 不分大小写，两头的空格去掉，跟原来的搜索一样）。原来的顺序不变。
 */
export function filterAdminClients<T extends ClientRowForFilter>(clients: readonly T[], query: string, filter: ClientAgentFilter): T[] {
  const q = query.trim().toLowerCase();
  return clients.filter((u) =>
    matchesClientAgentFilter(u, filter)
    && (!q || [u.id, u.name, u.companyName, u.phone, u.email].some((v) => (v ?? "").toLowerCase().includes(q))),
  );
}

/** 列表上方那句「筛出几个」和空状态里，归属那半句怎么说（跟下拉框显示的一样）；全部时没有这半句 */
export function clientAgentFilterLabel(filter: ClientAgentFilter, options: readonly ClientAgentFilterOption[]): string {
  if (filter.kind === "all") return "";
  if (filter.kind === "self") return "湘泰自己的客户";
  const label = options.find((o) => o.id === filter.agentId)?.label ?? "代理";
  return `代理「${label}」的客户`;
}
