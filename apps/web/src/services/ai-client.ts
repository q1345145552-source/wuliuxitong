import type { AiChatRequest, AiChatResponse } from "../../../../packages/shared-types/common-response";
import { apiBaseUrl, apiRequest } from "./core-api";

export function sendAiMessage(payload: AiChatRequest): Promise<AiChatResponse> {
  return apiRequest(`${apiBaseUrl()}/client/ai/chat`, { method: "POST", body: JSON.stringify(payload) });
}
