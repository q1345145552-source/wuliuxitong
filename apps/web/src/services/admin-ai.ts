import type { AiKnowledgeItem, StatusLabelConfig } from "../../../../packages/shared-types/entities";
import { authHeaders, apiBaseUrl, parseApiResponse } from "./core-api";

export async function fetchStatusLabels(): Promise<StatusLabelConfig[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/system/status-labels`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
  });
  return parseApiResponse<StatusLabelConfig[]>(response);
}

export async function updateStatusLabels(items: StatusLabelConfig[]): Promise<{ updated: number }> {
  const response = await fetch(`${apiBaseUrl()}/admin/system/status-labels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ items }),
  });
  return parseApiResponse<{ updated: number }>(response);
}

export async function resetStatusLabels(): Promise<{ reset: boolean; total: number }> {
  const response = await fetch(`${apiBaseUrl()}/admin/system/status-labels/reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
  });
  return parseApiResponse<{ reset: boolean; total: number }>(response);
}

export async function fetchKnowledgeList(): Promise<AiKnowledgeItem[]> {
  const response = await fetch(`${apiBaseUrl()}/admin/ai/knowledge`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
  });
  return parseApiResponse<AiKnowledgeItem[]>(response);
}

export async function createKnowledgeItem(payload: {
  title: string;
  content: string;
}): Promise<AiKnowledgeItem> {
  const response = await fetch(`${apiBaseUrl()}/admin/ai/knowledge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse<AiKnowledgeItem>(response);
}

export async function deleteKnowledgeItem(id: string): Promise<{ deleted: boolean; id: string }> {
  const query = new URLSearchParams();
  query.set("id", id);
  const response = await fetch(`${apiBaseUrl()}/admin/ai/knowledge?${query.toString()}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
  });
  return parseApiResponse<{ deleted: boolean; id: string }>(response);
}
