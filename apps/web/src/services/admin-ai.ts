import type { AiKnowledgeItem, StatusLabelConfig } from "../../../../packages/shared-types/entities";
import { apiBaseUrl, apiRequest } from "./core-api";

export function fetchStatusLabels(): Promise<StatusLabelConfig[]> {
  return apiRequest(`${apiBaseUrl()}/admin/system/status-labels`);
}

export function updateStatusLabels(items: StatusLabelConfig[]): Promise<{ updated: number }> {
  return apiRequest(`${apiBaseUrl()}/admin/system/status-labels`, { method: "POST", body: JSON.stringify({ items }) });
}

export function resetStatusLabels(): Promise<{ reset: boolean; total: number }> {
  return apiRequest(`${apiBaseUrl()}/admin/system/status-labels/reset`, { method: "POST" });
}

export function fetchKnowledgeList(): Promise<AiKnowledgeItem[]> {
  return apiRequest(`${apiBaseUrl()}/admin/ai/knowledge`);
}

export function createKnowledgeItem(payload: { title: string; content: string }): Promise<AiKnowledgeItem> {
  return apiRequest(`${apiBaseUrl()}/admin/ai/knowledge`, { method: "POST", body: JSON.stringify(payload) });
}

export function deleteKnowledgeItem(id: string): Promise<{ deleted: boolean; id: string }> {
  const query = new URLSearchParams(); query.set("id", id);
  return apiRequest(`${apiBaseUrl()}/admin/ai/knowledge?${query.toString()}`, { method: "DELETE" });
}
