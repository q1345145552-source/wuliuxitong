/**
 * 客服对话的接口（2026-09-28）。后端见 apps/api/src/modules/cs-chat/routes.ts。
 * ⚠️ 类型是手写的，跟后端 toWireMessage 逐字段对齐（CLAUDE.md 第 22 条：TypeScript 不会去核对后端）。
 */
import { apiBaseUrl, apiRequest } from "./core-api";
import type { UploadImage } from "../modules/shared/image-compress";

/** 左边菜单红点监听的事件：标了已读 / 发了消息之后发一下，红点不用等下一轮 */
export const CHAT_UNREAD_EVENT = "xt-chat-unread-changed";

/** 消息里带的那张单（2026-10-02 老板：「可以选择是哪个运单…整柜的也可以」） */
export type ChatRef = {
  /** shipment = 普通运单；fcl = 整柜 */
  type: "shipment" | "fcl";
  id: string;
  /** 运单号 / 整柜的提单号（不是柜号：客户不能看到柜号） */
  no: string;
  /** 品名（发送时记下的） */
  title: string | null;
  /** 现在的状态码（每次取消息现查），用 shipmentStatusZh 翻中文；查不到是 null */
  status: string | null;
  /** 单子删了 / 不在这个客户名下了：只剩发送时记下的单号 */
  gone: boolean;
};

export type ChatMessage = {
  id: string;
  /** client = 客户发的；cs = 员工 / 超管发的 */
  side: "client" | "cs";
  /** 是不是自己发的（气泡放右边） */
  mine: boolean;
  /** 气泡上方的名字：「我」「客服」、客户唛头；员工 / 超管看同事发的是「客服·名字」（客户那边永远只是「客服」） */
  senderLabel: string;
  content: string | null;
  imageUrl: string | null;
  createdAt: string;
  /** 撤回了（2026-10-02）：内容、图片、单子都是空的，只写「xx 撤回了一条消息」 */
  recalled: boolean;
  ref: ChatRef | null;
};

export type ChatPage = {
  messages: ChatMessage[];
  hasMore: boolean;
  serverTime: string;
  /**
   * 对方看到了哪一刻（客户看 = 客服这边任何人看过；员工看 = 客户看过）：我方发的、不晚于它的显示「已读」。
   * 没看过是 null（2026-10-02 老板：「直接显示已读，每条信息都显示，类似 LINE 那种」）
   */
  peerReadAt: string | null;
};

export type ChatConversation = {
  clientId: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  /** 最新一条还在的是我们发的：摘要前面写「我方：」 */
  lastFromUs: boolean;
  unreadCount: number;
  /** 后来被划到代理名下：记录能看，不能再发 */
  closed: boolean;
  /** 客户说了话、我们还没回（看过也算没回，2026-10-02 老板：已读不回容易漏） */
  pendingReply: boolean;
  /** 从什么时候开始等的 */
  pendingSince: string | null;
};

/** 发消息时能选的一张单 */
export type ChatRefOption = {
  id: string;
  no: string;
  title: string | null;
  status: string;
  /** 整票件数（运单 = 父单剩余 + 全部子单，跟员工列表 totalPackageCount 同口径）；null = 还没点数 */
  packageCount: number | null;
  packageUnit: string | null;
};

export type ChatRefList = {
  shipments: ChatRefOption[];
  fcl: ChatRefOption[];
  /** 只列了最近 30 张：页面要写出来，更早的靠搜 */
  shipmentsTruncated: boolean;
  fclTruncated: boolean;
};

export type ChatSendInput = { content?: string; image?: UploadImage; ref?: { type: "shipment" | "fcl"; id: string } };

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
    ...(input.ref ? { ref: { type: input.ref.type, id: input.ref.id } } : {}),
  };
  return apiRequest(`${apiBaseUrl()}${url}`, { method: "POST", body: JSON.stringify(body) });
}

/** 撤回自己发的（2 分钟内，2026-10-02） */
export function recallChatMessage(scope: ChatScope, messageId: string): Promise<{ message: ChatMessage }> {
  const url = scope.kind === "client" ? "/client/chat/recall" : "/staff/chat/recall";
  const body = { ...(scope.kind === "staff" ? { clientId: scope.clientId } : {}), messageId };
  return apiRequest(`${apiBaseUrl()}${url}`, { method: "POST", body: JSON.stringify(body) });
}

/** 发消息时选单子：客户 = 自己的；客服 = 正在聊的这个客户的 */
export function fetchChatRefs(scope: ChatScope, q: string): Promise<ChatRefList> {
  const base = scope.kind === "client" ? "/client/chat/refs" : "/staff/chat/refs";
  const clientId = scope.kind === "staff" ? scope.clientId : undefined;
  return apiRequest(`${apiBaseUrl()}${base}${query({ clientId, q: q.trim() || undefined })}`);
}

export function markChatRead(scope: ChatScope, upTo?: string): Promise<{ ok: boolean }> {
  const url = scope.kind === "client" ? "/client/chat/read" : "/staff/chat/read";
  const body = { ...(scope.kind === "staff" ? { clientId: scope.clientId } : {}), ...(upTo ? { upTo } : {}) };
  return apiRequest(`${apiBaseUrl()}${url}`, { method: "POST", body: JSON.stringify(body) });
}

export function fetchChatConversations(q?: string, filter?: "pending"): Promise<{ items: ChatConversation[]; truncated?: boolean; pendingCount?: number }> {
  return apiRequest(`${apiBaseUrl()}/staff/chat/conversations${query({ q: q?.trim() || undefined, filter })}`);
}

/**
 * 菜单红点用：客户 = 客服发来的未读条数；员工 / 超管 = 所有客户发来的未读条数。
 * latestAt = 最新一条没看的是什么时候发的（没有是 null）：比上次的新就响提示音（2026-10-02）
 */
export function fetchChatUnread(role: "client" | "staff" | "admin"): Promise<{
  count: number;
  latestAt: string | null;
  /** 员工 / 超管才有：每个有未读的客户唛头 → 各自最新一条没看的时间（提示音按客户分开判断，dsh 第二轮复查） */
  latestByClient?: Record<string, string>;
  /** 服务器回这次结果时的时间：提示音拿它划「打开网页时的线」 */
  serverTime?: string;
}> {
  const url = role === "client" ? "/client/chat/unread" : "/staff/chat/unread";
  return apiRequest(`${apiBaseUrl()}${url}`);
}

/* ---------- 浏览器系统通知（2026-10-02，见 modules/cs-chat/chat-push.ts）---------- */

function pushBase(role: "client" | "staff" | "admin"): string {
  return role === "client" ? "/client/chat/push" : "/staff/chat/push";
}

/** 服务器开没开通知（没配密钥 = 不开，页面上不显示「开启通知」）+ 浏览器订阅要用的公钥 */
export function fetchChatPushKey(role: "client" | "staff" | "admin"): Promise<{ enabled: boolean; publicKey: string | null }> {
  return apiRequest(`${apiBaseUrl()}${pushBase(role)}/key`);
}

/** 存这个浏览器的订阅（endpoint + 两把加密公钥，就是浏览器 PushSubscription.toJSON() 那份） */
export function saveChatPushSubscription(role: "client" | "staff" | "admin", sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<{ ok: boolean }> {
  return apiRequest(`${apiBaseUrl()}${pushBase(role)}/subscribe`, { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }) });
}

export function deleteChatPushSubscription(role: "client" | "staff" | "admin", endpoint: string): Promise<{ ok: boolean }> {
  return apiRequest(`${apiBaseUrl()}${pushBase(role)}/unsubscribe`, { method: "POST", body: JSON.stringify({ endpoint }) });
}

/** 同一条消息，手里那份跟新取回来的有没有要紧的不一样：撤回了 / 单子的状态变了 */
function messageChanged(a: ChatMessage, b: ChatMessage): boolean {
  /* 撤回只往前走（2026-10-02 复核）：网慢时两轮轮询会交叠，晚回来的那份可能是撤回之前读的 ——
     拿它一换，已撤回的又变回原文，而且之后再也不会有轮询带回这一条，原文就一直留在屏幕上 */
  if (a.recalled && !b.recalled) return false;
  if (Boolean(a.recalled) !== Boolean(b.recalled)) return true;
  const ra = a.ref ?? null;
  const rb = b.ref ?? null;
  if (!ra || !rb) return ra !== rb;
  return ra.status !== rb.status || ra.gone !== rb.gone;
}

/**
 * 按 id 合并（轮询会往前多取 5 秒，重复的那几条要去掉），再按时间排。
 * 已经有的那条：撤回了 / 单子状态变了就换成新的（2026-10-02：对方撤回，3 秒内这边跟着变）；别的不动
 */
export function mergeChatMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  let changed = false;
  for (const m of incoming) {
    const old = byId.get(m.id);
    if (!old || messageChanged(old, m)) { byId.set(m.id, m); changed = true; }
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}
