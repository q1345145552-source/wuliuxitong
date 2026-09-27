/**
 * 客服对话的接口（2026-09-28）。后端见 apps/api/src/modules/cs-chat/routes.ts。
 * ⚠️ 类型是手写的，跟后端 toWireMessage 逐字段对齐（CLAUDE.md 第 22 条：TypeScript 不会去核对后端）。
 */
import { apiBaseUrl, apiRequest } from "./core-api";
import type { UploadImage } from "../modules/shared/image-compress";

/** 左边菜单红点监听的事件：标了已读 / 发了消息之后发一下，红点不用等下一轮 */
export const CHAT_UNREAD_EVENT = "xt-chat-unread-changed";

export type ChatMessage = {
  id: string;
  /** client = 客户发的；cs = 员工 / 超管发的 */
  side: "client" | "cs";
  /** 是不是自己发的（气泡放右边） */
  mine: boolean;
  /** 气泡上方的名字：「我」「客服」、客户唛头；超管看员工发的是「客服·名字」 */
  senderLabel: string;
  content: string | null;
  imageUrl: string | null;
  createdAt: string;
};

export type ChatPage = { messages: ChatMessage[]; hasMore: boolean; serverTime: string };

export type ChatConversation = {
  clientId: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  lastFromClient: boolean;
  unreadCount: number;
  /** 后来被划到代理名下：记录能看，不能再发 */
  closed: boolean;
};

export type ChatSendInput = { content?: string; image?: UploadImage };

/** 哪一头在用：客户（只有自己那一条对话）/ 客服（按唛头选对话） */
export type ChatScope = { kind: "client" } | { kind: "staff"; clientId: string };

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function fetchChatMessages(scope: ChatScope, opts: { since?: string; before?: string } = {}): Promise<ChatPage> {
  const base = scope.kind === "client" ? "/client/chat/messages" : "/staff/chat/messages";
  const clientId = scope.kind === "staff" ? scope.clientId : undefined;
  return apiRequest<ChatPage>(`${apiBaseUrl()}${base}${query({ clientId, since: opts.since, before: opts.before })}`);
}

export function sendChatMessage(scope: ChatScope, input: ChatSendInput): Promise<{ message: ChatMessage }> {
  const url = scope.kind === "client" ? "/client/chat/send" : "/staff/chat/send";
  const body = {
    ...(scope.kind === "staff" ? { clientId: scope.clientId } : {}),
    ...(input.content ? { content: input.content } : {}),
    ...(input.image ? { image: { fileName: input.image.fileName, mime: input.image.mime, base64: input.image.base64 } } : {}),
  };
  return apiRequest(`${apiBaseUrl()}${url}`, { method: "POST", body: JSON.stringify(body) });
}

export function markChatRead(scope: ChatScope, upTo?: string): Promise<{ ok: boolean }> {
  const url = scope.kind === "client" ? "/client/chat/read" : "/staff/chat/read";
  const body = { ...(scope.kind === "staff" ? { clientId: scope.clientId } : {}), ...(upTo ? { upTo } : {}) };
  return apiRequest(`${apiBaseUrl()}${url}`, { method: "POST", body: JSON.stringify(body) });
}

export function fetchChatConversations(q?: string): Promise<{ items: ChatConversation[] }> {
  return apiRequest(`${apiBaseUrl()}/staff/chat/conversations${query({ q: q?.trim() || undefined })}`);
}

/** 菜单红点用：客户 = 客服发来的未读条数；员工 / 超管 = 所有客户发来的未读条数 */
export function fetchChatUnread(role: "client" | "staff" | "admin"): Promise<{ count: number }> {
  const url = role === "client" ? "/client/chat/unread" : "/staff/chat/unread";
  return apiRequest(`${apiBaseUrl()}${url}`);
}

/** 按 id 合并（轮询会往前多取 5 秒，重复的那几条要去掉），再按时间排 */
export function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  let changed = false;
  for (const m of incoming) {
    if (!byId.has(m.id)) { byId.set(m.id, m); changed = true; }
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}
