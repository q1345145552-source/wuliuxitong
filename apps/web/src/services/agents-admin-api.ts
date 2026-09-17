/**
 * 超管「代理管理」+「返现单」接口（2026-09-16，B2）。
 * 后端：apps/api/src/modules/agents/admin-routes.ts。
 * ⚠️ 列表和开代理是 /admin/agents/list、/admin/agents/create，**不是** /admin/agents ——
 *    那是页面网址，浏览器请求会被 Next 当成打开页面，拿回 HTML（2026-09-16 页面实测踩到）。
 * ⚠️ 这些类型是手写的，TypeScript 不会去核对后端（CLAUDE.md #22）：
 *    改了后端 ok(res, {...}) 的字段，回来同步改这里。
 */
import { apiBaseUrl, apiRequest } from "./core-api";

export interface AgentPriceTriple {
  normal: number;
  inspection: number;
  sensitive: number;
}

export interface AdminAgentItem {
  id: string;
  name: string;
  slug: string | null;
  customDomain: string | null;
  logoUrl: string | null;
  clientCount: number;
  loginId: string;
  loginStatus: "active" | "inactive";
  prices: AgentPriceTriple;
  createdAt: string;
  updatedAt: string;
}

export interface AgentLogoUpload {
  mime: string;
  base64: string;
}

export interface CreateAgentPayload {
  name: string;
  slug: string;
  customDomain: string;
  prices: AgentPriceTriple;
  loginId: string;
  password: string;
  phone?: string;
  logo?: AgentLogoUpload | null;
}

export interface UpdateAgentPayload {
  id: string;
  name: string;
  slug: string;
  customDomain: string;
  prices: AgentPriceTriple;
  logo?: AgentLogoUpload | null;
  removeLogo?: boolean;
}

export interface AgentRebateStatementItem {
  id: string;
  agentId: string;
  agentName: string;
  month: string;
  lineCount: number;
  totalVolumeM3: number;
  totalRebate: number;
  status: "unpaid" | "paid";
  generatedAt: string;
  paidAt: string | null;
  paidBy: string | null;
}

export interface AgentRebateLineItem {
  id: string;
  prealertId: string;
  trackingNo: string;
  planNo: string;
  clientId: string;
  mark: string;
  productNames: string;
  volumes: AgentPriceTriple;
  clientPrices: AgentPriceTriple;
  agentPrices: AgentPriceTriple;
  rebateAmount: number;
  prealertCreatedAt: string;
  signedAt: string | null;
  paidAt: string | null;
  loadedAt: string | null;
  shippedAt: string | null;
  thailandReceivedAt: string;
}

const jsonPost = { "Content-Type": "application/json" } as const;

export async function fetchAdminAgents(): Promise<AdminAgentItem[]> {
  const data = await apiRequest<{ items: AdminAgentItem[] }>(`${apiBaseUrl()}/admin/agents/list`);
  return data.items ?? [];
}

export async function createAdminAgent(payload: CreateAgentPayload): Promise<{ id: string; loginId: string }> {
  return apiRequest(`${apiBaseUrl()}/admin/agents/create`, { method: "POST", headers: jsonPost, body: JSON.stringify(payload) });
}

export async function updateAdminAgent(payload: UpdateAgentPayload): Promise<{ id: string; updated: boolean }> {
  return apiRequest(`${apiBaseUrl()}/admin/agents/update`, { method: "POST", headers: jsonPost, body: JSON.stringify(payload) });
}

export async function setAdminAgentLoginStatus(id: string, status: "active" | "inactive"): Promise<{ id: string; loginStatus: "active" | "inactive" }> {
  return apiRequest(`${apiBaseUrl()}/admin/agents/login-status`, { method: "POST", headers: jsonPost, body: JSON.stringify({ id, status }) });
}

export async function resetAdminAgentPassword(id: string, password: string): Promise<{ id: string; loginId: string; updated: boolean }> {
  return apiRequest(`${apiBaseUrl()}/admin/agents/reset-password`, { method: "POST", headers: jsonPost, body: JSON.stringify({ id, password }) });
}

export async function fetchAgentRebateStatements(filter: { agentId?: string; month?: string; status?: string } = {}): Promise<AgentRebateStatementItem[]> {
  const qs = new URLSearchParams();
  if (filter.agentId) qs.set("agentId", filter.agentId);
  if (filter.month) qs.set("month", filter.month);
  if (filter.status) qs.set("status", filter.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const data = await apiRequest<{ items: AgentRebateStatementItem[] }>(`${apiBaseUrl()}/admin/agents/rebates${suffix}`);
  return data.items ?? [];
}

/** 返现单的「已返 / 撤回」流水（2026-09-18）：最近的在最前面，只有超管看得到 */
export interface AgentRebateHistoryItem {
  at: string;
  actorName: string;
  actorRole: string;
  action: "paid" | "undoPaid" | "other";
  reason: string;
  amount: number | null;
}

export async function fetchAgentRebateDetail(id: string): Promise<{ statement: AgentRebateStatementItem; lines: AgentRebateLineItem[]; history: AgentRebateHistoryItem[] }> {
  return apiRequest(`${apiBaseUrl()}/admin/agents/rebates/detail?id=${encodeURIComponent(id)}`);
}

export async function markAgentRebatePaid(id: string): Promise<{ id: string; status: "paid"; paidAt: string | null; alreadyPaid: boolean }> {
  return apiRequest(`${apiBaseUrl()}/admin/agents/rebates/mark-paid`, { method: "POST", headers: jsonPost, body: JSON.stringify({ id }) });
}

/** 撤回「已返」（2026-09-18 老板拍板）：必须写原因，会记进操作记录 */
export async function undoAgentRebatePaid(id: string, reason: string): Promise<{ id: string; status: "unpaid"; alreadyUnpaid: boolean }> {
  return apiRequest(`${apiBaseUrl()}/admin/agents/rebates/undo-paid`, { method: "POST", headers: jsonPost, body: JSON.stringify({ id, reason }) });
}
