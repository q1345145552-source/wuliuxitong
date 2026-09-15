import type {
  AiChatRequest,
  AiChatResponse,
  AiSuggestionResponse,
} from "../../../../../packages/shared-types/common-response";
import type {
  AiKnowledgeItem,
  AiQueryAuditLog,
  Order,
  StatusLabelConfig,
  Shipment,
} from "../../../../../packages/shared-types/entities";
import type { ShipmentStatus } from "../../../../../packages/shared-types/shipment-status";
import type { UserRole } from "../../../../../packages/shared-types/role";

/**
 * AI 能识别的「查哪一批运单」范围 —— **全模块唯一一份清单**（2026-09-03 收拢）。
 *
 * ⚠️ 加范围之前这串东西在 5 个地方各写了一遍：本文件的类型、ai-service 的
 * StatusScope、解析模型返回值的白名单、给模型看的提示词、以及 ai-prisma-store
 * 里两处 as 断言。2026-09-03 加「已到仓」时前三处漏改，TypeScript 只拦住了两处，
 * 提示词那句漏了模型根本不知道有这个选项。现在一处改，五处跟着走。
 */
export const AI_STATUS_SCOPES = ["all", "inTransit", "arrived", "completed", "unfinished", "exception"] as const;
export type AiStatusScope = (typeof AI_STATUS_SCOPES)[number];

export interface AuthContext {
  userId: string;
  companyId: string;
  role: UserRole;
}

export interface QueryScope {
  companyId: string;
  /**
   * 必填：AI 对话只对 client 角色开放，数据必须收窄到该客户自己的单，
   * 否则模型上下文里会带上同公司其他客户的运单。设为必填而非可选，
   * 就是为了让漏传时直接编译报错。
   */
  clientId: string;
}

/**
 * AI 模块自己用的订单视图：在 Order 之上带一份**这张单全部货品的品名**。
 *
 * ⚠️ `Order.itemName` 存的只是**第一个**货品（下单接口里的 primaryName，
 * orders/routes.ts:222）。只看它的话，「耳机」排在第二个货品的订单一张都查不到，
 * 客户问「耳机有多少单」会得到「未查询到品名『耳机』相关订单」——
 * 而他明明发了耳机。所以品名统计必须看全部货品行。
 */
export type AiOrder = Order & { productNames: string[] };

export interface QueryDataSource {
  listOrders(scope: QueryScope): Promise<AiOrder[]>;
  listShipments(scope: QueryScope): Promise<Shipment[]>;
}

export interface AuditStore {
  add(log: AiQueryAuditLog): Promise<void>;
  listByCompany(companyId: string): Promise<AiQueryAuditLog[]>;
}

export interface DeepSeekClient {
  summarizeWithContext(input: {
    question: string;
    context: string;
  }): Promise<string>;
}

export interface StatusLabelStore {
  list(): Promise<StatusLabelConfig[]>;
  getLabel(status: ShipmentStatus): Promise<string | undefined>;
  upsert(items: StatusLabelConfig[]): Promise<void>;
  resetDefaults(): Promise<void>;
}

export interface AiKnowledgeStore {
  list(companyId: string): Promise<AiKnowledgeItem[]>;
  add(item: Omit<AiKnowledgeItem, "id" | "createdAt">): Promise<AiKnowledgeItem>;
  remove(companyId: string, id: string): Promise<boolean>;
}

export interface AiKnowledgeGapRecord {
  id: string;
  companyId: string;
  userId: string;
  sessionId?: string;
  question: string;
  answerSummary: string;
  knowledgeCountAtAsk: number;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface AiKnowledgeGapStore {
  add(record: AiKnowledgeGapRecord): Promise<void>;
  listByCompany(companyId: string, status?: "open" | "resolved"): Promise<AiKnowledgeGapRecord[]>;
  resolve(input: { companyId: string; id: string; resolvedBy: string }): Promise<boolean>;
}

export interface AiService {
  getSuggestions(): AiSuggestionResponse;
  chat(input: {
    auth: AuthContext;
    body: AiChatRequest;
  }): Promise<AiChatResponse>;
}

export interface AiSessionMemoryRecord {
  key: string;
  companyId: string;
  userId: string;
  sessionId: string;
  intent?: "tracking" | "summary";
  itemName?: string;
  statusScope?: AiStatusScope;
  timeHint?: string;
  metric?: "count" | "volume" | "weight" | "mixed";
  updatedAt: string;
}

export interface AiSessionMemoryStore {
  get(key: string): Promise<AiSessionMemoryRecord | undefined>;
  set(record: AiSessionMemoryRecord): Promise<void>;
  cleanupOlderThan(iso: string): Promise<void>;
  listByCompany(companyId: string): Promise<AiSessionMemoryRecord[]>;
  removeByFilter(input: {
    companyId: string;
    sessionId?: string;
    userId?: string;
  }): Promise<number>;
}

export interface ShipmentProgressResult {
  shipment?: Shipment;
  latestStatus?: ShipmentStatus;
}
