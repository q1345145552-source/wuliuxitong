import type {
  AiChatRequest,
  AiChatResponse,
  AiSuggestionResponse,
} from "../../../../../packages/shared-types/common-response";
import type { AiKnowledgeItem, AiQueryAuditLog, Shipment } from "../../../../../packages/shared-types/entities";
import type { ShipmentStatus } from "../../../../../packages/shared-types/shipment-status";
import type {
  AiSessionMemoryStore,
  AiKnowledgeGapStore,
  AiKnowledgeStore,
  AiService,
  AuditStore,
  AuthContext,
  DeepSeekClient,
  QueryDataSource,
  StatusLabelStore,
} from "./ai-types";

interface AiServiceDeps {
  dataSource: QueryDataSource;
  auditStore: AuditStore;
  knowledgeGapStore: AiKnowledgeGapStore;
  llmClient: DeepSeekClient;
  statusLabelStore: StatusLabelStore;
  knowledgeStore: AiKnowledgeStore;
  memoryStore: AiSessionMemoryStore;
}

const SUGGESTIONS = [
  "我的单号 THCN0001 到哪了？",
  "我的货现在到哪里了？",
  "最近 7 天在途订单有多少？",
  "我还有多少货没完成？",
  "我路上有多少方的货？",
  "我这个月一共发了多少货？",
  "我这个月发货总重量是多少？",
  "耳机订单有多少单？",
  "手机壳在途有多少单？",
  "本月已完成订单有多少？",
  "最近 3 天异常件有多少？",
  "最近 7 天取消/退回有多少？",
  "寄到泰国一般要多久？",
  "清关一般需要多久？",
  "海运和陆运时效有什么区别？",
  "发货后多久能查到轨迹？",
  "为什么我的单号查不到？",
  "运费怎么计算？按体积还是重量？",
  "体积重和实重按哪个计费？",
  "有没有最低计费重量？",
  "是否支持代收货款？",
  "可以走带电产品吗？",
  "哪些物品不能寄？",
  "液体/粉末/食品能发吗？",
  "需要提供哪些清关资料？",
  "发票和装箱单有什么要求？",
  "客户签收后发现少货怎么办？",
  "包裹破损怎么处理赔付？",
  "可以周末派送吗？",
  "可以送货上门吗？",
  "能开对账单和发票吗？",
];

const COMPLETED_STATUSES: ShipmentStatus[] = ["delivered", "returned", "cancelled"];
const EXCEPTION_STATUSES: ShipmentStatus[] = ["exception", "returned", "cancelled"];
const GREETING_RE = /(你好|您好|hi|hello|哈喽|在吗|你在吗)/i;
const SERVICE_QA_RE =
  /(时效|多久|几天|清关|报关|费用|运费|计费|体积重|实重|禁运|违禁|能寄|可以寄|赔付|理赔|破损|丢件|签收|派送|上门|对账|发票|资料|装箱单|轨迹|查不到)/;

interface TimeWindow {
  start?: Date;
  end?: Date;
  label: string;
}

type StatusScope = "all" | "inTransit" | "completed" | "unfinished" | "exception";
type SummaryMetric = "count" | "volume" | "weight" | "mixed";
interface ProductScope {
  keyword?: string;
  label: string;
}
interface ModelIntent {
  intent?: "greeting" | "tracking" | "summary" | "unknown";
  trackingNo?: string;
  itemName?: string;
  statusScope?: StatusScope;
  timeHint?: string;
  metric?: SummaryMetric;
  confidence?: number;
}
interface SessionMemory {
  intent?: "tracking" | "summary";
  itemName?: string;
  statusScope?: StatusScope;
  timeHint?: string;
  metric?: SummaryMetric;
  updatedAt: number;
}

export class ClientAiService implements AiService {
  private static readonly MEMORY_TTL_MS = 30 * 60 * 1000;

  constructor(private readonly deps: AiServiceDeps) {}

  getSuggestions(): AiSuggestionResponse {
    return { suggestions: SUGGESTIONS };
  }

  async chat(input: { auth: AuthContext; body: AiChatRequest }): Promise<AiChatResponse> {
    const { auth, body } = input;
    this.assertClientRole(auth);
    const question = typeof body.message === "string" ? body.message.trim() : "";
    if (!question) {
      throw new Error("BAD_REQUEST:message is required");
    }
    const sessionId = body.sessionId ?? `sess_${Date.now()}`;
    const memory = await this.getSessionMemory(auth, sessionId);
    const isFollowUp = this.isFollowUpMessage(question);

    const orders = await this.deps.dataSource.listOrders({ companyId: auth.companyId });
    const shipments = await this.deps.dataSource.listShipments({ companyId: auth.companyId });
    const knowledgeItems = await this.deps.knowledgeStore.list(auth.companyId);

    const modelIntent = await this.parseIntentWithModel(question, orders, memory);
    const trackingNo = this.extractTrackingNo(question) ?? modelIntent.trackingNo?.trim().toUpperCase();
    let answerDraft: string;
    let evidenceShipmentIds: string[] = [];
    let evidenceOrderIds: string[] = [];
    let nextMemory: Partial<SessionMemory> | null = null;
    let shouldCreateKnowledgeGap = false;

    if (trackingNo) {
      const shipment = shipments.find((item) => item.trackingNo === trackingNo);
      if (!shipment) {
        answerDraft = this.formatNotFoundAnswer(trackingNo);
      } else {
        answerDraft = await this.formatProgressAnswer(shipment);
        evidenceShipmentIds = [shipment.id];
        evidenceOrderIds = [shipment.orderId];
      }
      nextMemory = { intent: "tracking" };
    } else if (this.isGreetingMessage(question) || modelIntent.intent === "greeting") {
      answerDraft = this.formatGreetingAnswer();
    } else if (this.isServiceQaIntent(question)) {
      const relevantKnowledge = this.pickRelevantKnowledge(question, knowledgeItems);
      const hasRelevantKnowledge = relevantKnowledge.length > 0;
      answerDraft = this.formatServiceQaAnswer(question, knowledgeItems.length, relevantKnowledge);
      shouldCreateKnowledgeGap = !hasRelevantKnowledge;
    } else if (this.shouldAskClarification(question, modelIntent)) {
      answerDraft = this.formatClarificationAnswer();
    } else if (this.isSummaryIntent(question) || modelIntent.intent === "summary" || modelIntent.intent === "unknown") {
      let timeHint = modelIntent.timeHint?.trim() || undefined;
      if (!timeHint && isFollowUp) {
        timeHint = memory?.timeHint;
      }
      const timeWindow = this.resolveTimeWindow(timeHint || question, new Date());
      let statusScope = modelIntent.statusScope ?? this.resolveStatusScope(question);
      if (statusScope === "all" && isFollowUp && memory?.statusScope) {
        statusScope = memory.statusScope;
      }
      const productScope = this.resolveProductScope(
        question,
        orders,
        modelIntent.itemName,
        isFollowUp ? memory?.itemName : undefined,
      );
      const metric = this.resolveMetric(
        question,
        modelIntent.metric,
        isFollowUp ? memory?.metric : undefined,
      );
      const filteredShipments = this.filterShipmentsByScope(
        shipments,
        orders,
        timeWindow,
        statusScope,
        productScope,
      );
      const evidenceOrderIdSet = new Set(
        filteredShipments.map((item) => item.orderId).filter((id): id is string => Boolean(id)),
      );
      evidenceShipmentIds = filteredShipments.map((item) => item.id);
      evidenceOrderIds = orders
        .filter((item) => evidenceOrderIdSet.has(item.id))
        .map((item) => item.id);
      const summary = this.buildCompanySummary(filteredShipments);
      answerDraft = this.formatSummaryAnswer(summary, {
        timeLabel: timeWindow.label,
        statusLabel: this.statusScopeLabel(statusScope),
        productLabel: productScope.label,
        metric,
      });
      if (summary.totalCount === 0 && productScope.keyword) {
        const productOrderCount = this.countOrdersByProduct(productScope.keyword, orders);
        if (productOrderCount === 0) {
          const similar = this.suggestItemNames(productScope.keyword, orders);
          answerDraft = this.formatNoDataByProductAnswer(productScope.keyword, similar);
        } else {
          answerDraft = this.formatNoDataInCurrentScopeAnswer(
            productScope.keyword,
            timeWindow.label,
            this.statusScopeLabel(statusScope),
          );
        }
      }
      nextMemory = {
        intent: "summary",
        statusScope,
        itemName: productScope.keyword,
        timeHint: timeWindow.label === "当前公司账号数据" ? undefined : timeWindow.label,
        metric,
      };
    } else {
      const summary = this.buildCompanySummary(shipments);
      answerDraft = this.formatSummaryAnswer(summary, {
        timeLabel: "当前公司账号数据",
        statusLabel: "全部运单",
        productLabel: "全部品类",
        metric: "count",
      });
      evidenceShipmentIds = shipments.map((item) => item.id);
      evidenceOrderIds = orders.map((item) => item.id);
      nextMemory = { intent: "summary", metric: "count" };
    }

    const llmContext = JSON.stringify(
      {
        companyId: auth.companyId,
        question,
        answerDraft,
        knowledgeItems: knowledgeItems.slice(0, 8).map((item) => ({
          id: item.id,
          title: item.title,
          content: item.content,
        })),
        evidenceShipmentIds,
        evidenceOrderIds,
      },
      null,
      2,
    );
    const refinedAnswer = await this.refineAnswerWithModel(question, llmContext, answerDraft);
    if (!shouldCreateKnowledgeGap) {
      shouldCreateKnowledgeGap = this.shouldRecordKnowledgeGap({
        question,
        answer: refinedAnswer,
        knowledgeCount: knowledgeItems.length,
        evidenceOrderIds,
        evidenceShipmentIds,
      });
    }

    const response: AiChatResponse = {
      sessionId,
      answer: refinedAnswer,
      evidence: {
        orderIds: evidenceOrderIds,
        shipmentIds: evidenceShipmentIds,
        updatedAt: new Date().toISOString(),
      },
    };

    const auditLog: AiQueryAuditLog = {
      id: `aiq_${Date.now()}`,
      userId: auth.userId,
      companyId: auth.companyId,
      sessionId: response.sessionId,
      question,
      answerSummary: response.answer.slice(0, 200),
      referencedOrderIds: response.evidence.orderIds,
      referencedShipmentIds: response.evidence.shipmentIds,
      queriedAt: new Date().toISOString(),
    };
    await this.deps.auditStore.add(auditLog);
    if (shouldCreateKnowledgeGap) {
      await this.deps.knowledgeGapStore.add({
        id: `gap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        companyId: auth.companyId,
        userId: auth.userId,
        sessionId,
        question,
        answerSummary: response.answer.slice(0, 300),
        knowledgeCountAtAsk: knowledgeItems.length,
        status: "open",
        createdAt: new Date().toISOString(),
      });
    }
    if (nextMemory) {
      await this.setSessionMemory(auth, sessionId, nextMemory);
    }

    return response;
  }

  private async parseIntentWithModel(
    question: string,
    orders: Array<{ itemName: string }>,
    memory?: SessionMemory,
  ): Promise<ModelIntent> {
    // If key is unavailable or model parsing fails, fallback to rule-based parsing.
    const itemNames = Array.from(
      new Set(
        orders
          .map((item) => item.itemName?.trim())
          .filter((name): name is string => Boolean(name))
          .slice(0, 40),
      ),
    );
    const parseContext = JSON.stringify(
      {
        question,
        hintItemNames: itemNames,
        expectedJsonSchema: {
          intent: "greeting|tracking|summary|unknown",
          trackingNo: "string",
          itemName: "string",
          statusScope: "all|inTransit|completed|unfinished|exception",
          timeHint: "string",
          metric: "count|volume|weight|mixed",
          confidence: "0~1",
        },
        previousContext: memory ?? {},
      },
      null,
      2,
    );
    try {
      const parsedText = await this.deps.llmClient.summarizeWithContext({
        question: [
          "你是意图解析器，请理解用户语句并提取查询条件。",
          "仅输出一个 JSON 对象，不要输出任何解释文字，不要输出 markdown。",
          '示例：{"intent":"summary","trackingNo":"","itemName":"耳机","statusScope":"all","timeHint":"最近7天","metric":"count","confidence":0.92}',
          "如果没有对应字段，用空字符串。",
          '如果用户是追问（例如"那耳机呢/那本月呢"），请结合 previousContext 补全缺失条件。',
        ].join("\n"),
        context: parseContext,
      });
      const parsed = this.tryParseIntentJson(parsedText);
      return parsed ?? {};
    } catch {
      return {};
    }
  }

  private tryParseIntentJson(text: string): ModelIntent | null {
    const cleaned = text.trim();
    if (!cleaned) return null;
    const fenced = cleaned.match(/^```(?:json|text|markdown)?\s*([\s\S]*?)\s*```$/i);
    const body = fenced?.[1]?.trim() ?? cleaned;
    const jsonCandidate = body.match(/\{[\s\S]*\}/)?.[0] ?? body;
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      const intentRaw = typeof parsed.intent === "string" ? parsed.intent : "";
      const intent =
        intentRaw === "greeting" || intentRaw === "tracking" || intentRaw === "summary" || intentRaw === "unknown"
          ? intentRaw
          : undefined;
      const statusRaw = typeof parsed.statusScope === "string" ? parsed.statusScope : "";
      const statusScope =
        statusRaw === "all" ||
        statusRaw === "inTransit" ||
        statusRaw === "completed" ||
        statusRaw === "unfinished" ||
        statusRaw === "exception"
          ? statusRaw
          : undefined;
      const metricRaw = typeof parsed.metric === "string" ? parsed.metric : "";
      const metric =
        metricRaw === "count" || metricRaw === "volume" || metricRaw === "weight" || metricRaw === "mixed"
          ? metricRaw
          : undefined;
      return {
        intent,
        trackingNo: typeof parsed.trackingNo === "string" ? parsed.trackingNo : undefined,
        itemName: typeof parsed.itemName === "string" ? parsed.itemName : undefined,
        statusScope,
        timeHint: typeof parsed.timeHint === "string" ? parsed.timeHint : undefined,
        metric,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      };
    } catch {
      return null;
    }
  }

  private assertClientRole(auth: AuthContext): void {
    if (auth.role !== "client") {
      throw new Error("FORBIDDEN_ROLE");
    }
  }

  private extractTrackingNo(message: string): string | undefined {
    if (!message) return undefined;
    const match = message.match(/[A-Za-z]{2,}\d{3,}/);
    return match?.[0]?.toUpperCase();
  }

  private isGreetingMessage(message: string): boolean {
    return message.length <= 20 && GREETING_RE.test(message);
  }

  private isSummaryIntent(message: string): boolean {
    return /(统计|汇总|总量|多少|几单|数量|重量|体积|在途|完成|异常|近\d+天|最近\d+天|今天|昨日|本周|本月)/.test(
      message,
    );
  }

  private isServiceQaIntent(message: string): boolean {
    return SERVICE_QA_RE.test(message);
  }

  private resolveStatusScope(message: string): StatusScope {
    if (/(未完成|没完成|未签收|未结束)/.test(message)) return "unfinished";
    if (/(异常|退回|取消)/.test(message)) return "exception";
    if (/(完成|签收|已完成)/.test(message)) return "completed";
    if (/(在途|运输中|在路上|路上)/.test(message)) return "inTransit";
    return "all";
  }

  private resolveTimeWindow(message: string, now: Date): TimeWindow {
    const dayMatch = message.match(/(?:最近|近)\s*(\d{1,3})\s*天/);
    if (dayMatch) {
      const days = Number(dayMatch[1]);
      if (!Number.isNaN(days) && days > 0) {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - (days - 1));
        return { start, label: `最近${days}天` };
      }
    }
    if (message.includes("今天")) {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return { start, end, label: "今天" };
    }
    if (message.includes("昨日") || message.includes("昨天")) {
      const end = new Date(now);
      end.setHours(0, 0, 0, 0);
      const start = new Date(end);
      start.setDate(start.getDate() - 1);
      return { start, end, label: "昨天" };
    }
    if (message.includes("本周")) {
      const start = new Date(now);
      const day = start.getDay();
      const offset = day === 0 ? 6 : day - 1;
      start.setDate(start.getDate() - offset);
      start.setHours(0, 0, 0, 0);
      return { start, label: "本周" };
    }
    if (message.includes("本月")) {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start, label: "本月" };
    }
    return { label: "当前公司账号数据" };
  }

  private resolveProductScope(
    message: string,
    orders: Array<{ itemName: string }>,
    modelItemName?: string,
    memoryItemName?: string,
  ): ProductScope {
    if (this.isLikelyGenericSummaryMessage(message)) {
      const exactFromData = this.matchKnownItemFromMessage(message, orders);
      if (exactFromData) return { keyword: exactFromData, label: `品名：${exactFromData}` };
      if (memoryItemName) return { keyword: memoryItemName, label: `品名：${memoryItemName}` };
      return { label: "全部品类" };
    }

    const modelKeyword = this.normalizeProductKeyword(modelItemName);
    if (modelKeyword) {
      return { keyword: modelKeyword, label: `品名：${modelKeyword}` };
    }

    const explicitFromQuestion = this.extractProductKeyword(message);
    if (explicitFromQuestion) {
      return { keyword: explicitFromQuestion, label: `品名：${explicitFromQuestion}` };
    }

    const byPattern =
      message.match(/(?:多少个|多少|几个|几单|统计|汇总)?\s*([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})\s*(?:订单|运单)/) ??
      message.match(/品名[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})/) ??
      message.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})\s*(?:有多少|多少单)/);
    const candidate = this.normalizeProductKeyword(byPattern?.[1]);
    if (candidate) {
      return { keyword: candidate, label: `品名：${candidate}` };
    }

    const matched = this.matchKnownItemFromMessage(message, orders);
    if (matched) {
      return { keyword: matched, label: `品名：${matched}` };
    }
    if (memoryItemName) {
      return { keyword: memoryItemName, label: `品名：${memoryItemName}` };
    }

    return { label: "全部品类" };
  }

  private extractProductKeyword(message: string): string | undefined {
    const cleaned = message
      .replace(/[？?。！!,.，]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const patterns = [
      /(?:我有|我想看|帮我查|查询|统计)?\s*多少(?:个)?\s*([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})\s*(?:的)?\s*(?:订单|运单)/,
      /([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})\s*(?:订单|运单)\s*(?:有)?\s*多少/,
      /品名[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})/,
    ];
    for (const pattern of patterns) {
      const m = cleaned.match(pattern);
      if (!m?.[1]) continue;
      const candidate = this.normalizeProductKeyword(
        m[1]
        .trim()
        .replace(/^(我有|请问|帮我查|查询|统计|看看)/, "")
        .replace(/(的|订单|运单)$/g, "")
        .trim(),
      );
      if (candidate && candidate.length <= 20) return candidate;
    }
    return undefined;
  }

  private normalizeProductKeyword(raw?: string): string | undefined {
    const keyword = raw?.trim().replace(/[？?。！!,.，]/g, "");
    if (!keyword) return undefined;
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]{1,20}$/.test(keyword)) return undefined;
    if (/(最近|今天|昨天|本周|本月|在途|路上|运输|完成|未完成|多少|几单|统计|汇总|有多少|还有|查询范围)/.test(keyword)) {
      return undefined;
    }
    if (/\d+天/.test(keyword)) return undefined;
    const blocked = new Set([
      "我",
      "我还",
      "还有",
      "多少",
      "几个",
      "几单",
      "货",
      "订单",
      "运单",
      "未完成",
      "没完成",
      "完成",
      "在途",
      "全部",
      "所有",
      "当前",
      "数据",
    ]);
    if (blocked.has(keyword)) return undefined;
    if (keyword.length <= 2 && /(我还|还有)/.test(keyword)) return undefined;
    return keyword;
  }

  private isLikelyGenericSummaryMessage(message: string): boolean {
    const text = message.replace(/\s+/g, "");
    return /(还有多少货|多少货没完成|多少货未完成|未完成的货|没完成的货|在途的货|路上有多少方|路上多少方|在途有多少方|多少方的货|多少立方的货)/.test(
      text,
    );
  }

  private resolveMetric(
    question: string,
    modelMetric?: SummaryMetric,
    memoryMetric?: SummaryMetric,
  ): SummaryMetric {
    if (/(多少方|体积|立方)/.test(question)) return "volume";
    if (/(重量|多重|多少公斤|多少千克|多少吨)/.test(question)) return "weight";
    if (/(多少单|几单|数量|多少个|多少票)/.test(question)) return "count";
    return modelMetric ?? memoryMetric ?? "count";
  }

  private matchKnownItemFromMessage(message: string, orders: Array<{ itemName: string }>): string | undefined {
    const lowerMessage = message.toLowerCase();
    return orders
      .map((item) => item.itemName?.trim())
      .filter((name): name is string => Boolean(name))
      .find((name) => lowerMessage.includes(name.toLowerCase()));
  }

  private filterShipmentsByScope(
    shipments: Shipment[],
    orders: Array<{ id: string; itemName: string }>,
    timeWindow: TimeWindow,
    statusScope: StatusScope,
    productScope: ProductScope,
  ): Shipment[] {
    const matchedOrderIds =
      productScope.keyword === undefined
        ? null
        : new Set(
            orders
              .filter((item) => {
                const name = item.itemName ?? "";
                const keyword = productScope.keyword as string;
                return name.includes(keyword) || keyword.includes(name);
              })
              .map((item) => item.id),
          );
    return shipments
      .filter((item) => (matchedOrderIds ? matchedOrderIds.has(item.orderId) : true))
      .filter((item) => this.inTimeWindow(item, timeWindow))
      .filter((item) => this.matchStatusScope(item, statusScope));
  }

  private inTimeWindow(shipment: Shipment, timeWindow: TimeWindow): boolean {
    if (!timeWindow.start && !timeWindow.end) return true;
    const ts = Date.parse(shipment.updatedAt || shipment.createdAt);
    if (Number.isNaN(ts)) return false;
    if (timeWindow.start && ts < timeWindow.start.getTime()) return false;
    if (timeWindow.end && ts >= timeWindow.end.getTime()) return false;
    return true;
  }

  private matchStatusScope(shipment: Shipment, statusScope: StatusScope): boolean {
    if (statusScope === "all") return true;
    if (statusScope === "inTransit") return shipment.currentStatus === "inTransit";
    if (statusScope === "completed") return COMPLETED_STATUSES.includes(shipment.currentStatus);
    if (statusScope === "unfinished") return !COMPLETED_STATUSES.includes(shipment.currentStatus);
    return EXCEPTION_STATUSES.includes(shipment.currentStatus);
  }

  private statusScopeLabel(statusScope: StatusScope): string {
    if (statusScope === "inTransit") return "在途运单";
    if (statusScope === "completed") return "已完成运单";
    if (statusScope === "unfinished") return "未完成运单";
    if (statusScope === "exception") return "异常/退回/取消运单";
    return "全部运单";
  }

  private buildCompanySummary(shipments: Shipment[]): {
    totalCount: number;
    inTransitCount: number;
    completedCount: number;
    totalWeightKg: number;
    totalVolumeM3: number;
  } {
    return shipments.reduce(
      (acc, item) => {
        acc.totalCount += 1;
        if (item.currentStatus === "inTransit") {
          acc.inTransitCount += 1;
        }
        if (COMPLETED_STATUSES.includes(item.currentStatus)) {
          acc.completedCount += 1;
        }
        acc.totalWeightKg += item.weightKg ?? 0;
        acc.totalVolumeM3 += item.volumeM3 ?? 0;
        return acc;
      },
      {
        totalCount: 0,
        inTransitCount: 0,
        completedCount: 0,
        totalWeightKg: 0,
        totalVolumeM3: 0,
      },
    );
  }

  private async refineAnswerWithModel(
    question: string,
    llmContext: string,
    fallbackAnswer: string,
  ): Promise<string> {
    try {
      const refined = await this.deps.llmClient.summarizeWithContext({
        question: `${question}\n请严格使用"业务客服模板"风格输出，保持字段齐全。仅输出最终中文答复正文，不要返回JSON、不要返回代码块、不要解释过程。`,
        context: llmContext,
      });
      if (!refined?.trim()) return fallbackAnswer;
      return this.normalizeModelAnswer(refined, fallbackAnswer);
    } catch {
      // Model failure should not block core business answer.
      return fallbackAnswer;
    }
  }

  private normalizeModelAnswer(rawAnswer: string, fallbackAnswer: string): string {
    const text = rawAnswer.trim();
    if (!text) return fallbackAnswer;

    // Strip markdown code fences if model wraps content.
    const fenced = text.match(/^```(?:json|text|markdown)?\s*([\s\S]*?)\s*```$/i);
    const content = fenced?.[1]?.trim() ?? text;
    const noKeyPrefix = "系统暂未配置 DeepSeek API Key。基于业务数据给出结果：";

    // When API key is missing, DeepSeek client may return a prefixed JSON context string.
    // We only expose the business answer, not the prefix/debug payload.
    if (content.startsWith(noKeyPrefix)) {
      const payloadText = content.slice(noKeyPrefix.length).trim();
      try {
        const parsed = JSON.parse(payloadText) as { answer?: unknown; answerDraft?: unknown };
        if (typeof parsed.answer === "string" && parsed.answer.trim()) {
          return parsed.answer.trim();
        }
        if (typeof parsed.answerDraft === "string" && parsed.answerDraft.trim()) {
          return parsed.answerDraft.trim();
        }
      } catch {
        return fallbackAnswer;
      }
    }

    // If model returns JSON payload, prefer "answer"/"answerDraft".
    try {
      const parsed = JSON.parse(content) as { answer?: unknown; answerDraft?: unknown };
      if (typeof parsed.answer === "string" && parsed.answer.trim()) {
        return parsed.answer.trim();
      }
      if (typeof parsed.answerDraft === "string" && parsed.answerDraft.trim()) {
        return parsed.answerDraft.trim();
      }
    } catch {
      // Not JSON, continue with plain text.
    }

    return content;
  }

  private formatNotFoundAnswer(trackingNo: string): string {
    return [
      "【查询结论】",
      `未找到运单号：${trackingNo}`,
      "",
      "【可能原因】",
      "1) 运单号输入有误",
      "2) 订单刚创建，物流信息尚未同步",
      "",
      "【建议操作】",
      "请核对运单号后重试，或提供国内快递单号给客服协助查询。",
    ].join("\n");
  }

  private async formatProgressAnswer(shipment: Shipment): Promise<string> {
    const statusLabel =
      (await this.deps.statusLabelStore.getLabel(shipment.currentStatus)) ?? shipment.currentStatus;
    return [
      "【查询结论】",
      `运单号：${shipment.trackingNo}`,
      `当前状态：${statusLabel}（${shipment.currentStatus}）`,
      `最近位置：${shipment.currentLocation ?? "暂无定位信息"}`,
      `最近更新时间：${shipment.updatedAt}`,
      "",
      "【建议操作】",
      shipment.currentStatus === "delivered"
        ? "该运单已签收，建议核对收货数量并归档。"
        : "该运单仍在运输流程中，建议稍后再次查询最新节点。",
    ].join("\n");
  }

  private formatGreetingAnswer(): string {
    return [
      "你好，我是湘泰物流AI客服助手。",
      "",
      "你可以直接问我：",
      "1) 运单进度（例：我的单号 THCN0001 到哪了）",
      "2) 统计汇总（例：最近7天在途运单有多少）",
      "3) 异常/完成统计（例：本月已完成运单数量）",
    ].join("\n");
  }

  private formatSummaryAnswer(
    summary: {
      totalCount: number;
      inTransitCount: number;
      completedCount: number;
      totalWeightKg: number;
      totalVolumeM3: number;
    },
    scope: { timeLabel: string; statusLabel: string; productLabel: string; metric: SummaryMetric },
  ): string {
    const focusHintBase =
      scope.statusLabel === "未完成运单"
        ? `你当前还有 ${summary.totalCount} 单未完成，正在运输中的有 ${summary.inTransitCount} 单。`
        : scope.statusLabel === "在途运单"
          ? `你当前在途运输中的有 ${summary.inTransitCount} 单。`
          : scope.statusLabel === "已完成运单"
            ? `你当前已完成的有 ${summary.completedCount} 单。`
            : `你当前一共查到 ${summary.totalCount} 单。`;
    const metricHint =
      scope.metric === "volume"
        ? `体积合计大约 ${summary.totalVolumeM3.toFixed(3)} 立方米。`
        : scope.metric === "weight"
          ? `重量合计大约 ${summary.totalWeightKg.toFixed(2)} 千克。`
          : "";
    const focusHint = metricHint ? `${focusHintBase}${metricHint}` : focusHintBase;
    return [
      "【查询结果】",
      focusHint,
      "",
      "【统计明细】",
      `查询范围：${scope.timeLabel}，${scope.statusLabel}，${scope.productLabel}`,
      `总单量：${summary.totalCount} 单`,
      `在途中：${summary.inTransitCount} 单`,
      `已完成：${summary.completedCount} 单`,
      `总重量约：${summary.totalWeightKg.toFixed(2)} 千克`,
      `总体积约：${summary.totalVolumeM3.toFixed(3)} 立方米`,
    ].join("\n");
  }

  private shouldAskClarification(question: string, modelIntent: ModelIntent): boolean {
    if (this.isGreetingMessage(question)) return false;
    if (this.extractTrackingNo(question)) return false;
    if (this.isSummaryIntent(question)) return false;
    if (this.isServiceQaIntent(question)) return false;
    if (modelIntent.intent === "summary" || modelIntent.intent === "tracking" || modelIntent.intent === "greeting") {
      return false;
    }
    return question.length > 2;
  }

  private formatClarificationAnswer(): string {
    return [
      "我理解你是在查物流数据，但还不太确定你想看哪一项。",
      "",
      "你可以这样问我：",
      "1) 在途还有多少单",
      "2) 最近7天一共多少立方米",
      "3) 耳机订单有多少单",
      "4) 单号 THCN0001 到哪了",
    ].join("\n");
  }

  private formatServiceQaAnswer(
    question: string,
    knowledgeCount: number,
    relevantKnowledge: AiKnowledgeItem[],
  ): string {
    if (relevantKnowledge.length === 0) {
      return [
        "【客服答复】",
        `已收到你的问题：「${question}」`,
        `我会优先参考你们公司已投喂的业务知识（当前 ${knowledgeCount} 条）进行回答。`,
        "",
        "【参考知识】",
        "当前知识库中暂无与该问题直接相关的具体说明。",
        "",
        "【结论】",
        "当前可用知识信息不足，暂时无法给出确切答复。",
        "",
        "【说明】",
        "如涉及费用、时效、赔付等最终条款，请以你们公司最新公告与人工客服确认为准。",
      ].join("\n");
    }
    const referenceLines = relevantKnowledge.slice(0, 3).map((item, index) => {
      const summary = this.summarizeKnowledgeContent(item.content);
      return `${index + 1}. ${item.title}：${summary}`;
    });
    const directHint = this.buildServiceQaDirectHint(question, relevantKnowledge[0]);
    return [
      "【客服答复】",
      `已收到你的问题：「${question}」`,
      knowledgeCount > 0
        ? `我会优先参考你们公司已投喂的业务知识（当前 ${knowledgeCount} 条）进行回答。`
        : "当前未检测到公司专属知识投喂，我会先按通用物流服务规则给你建议。",
      "",
      "【参考知识】",
      ...referenceLines,
      "",
      "【结论】",
      directHint,
      "",
      "【说明】",
      "如涉及费用、时效、赔付等最终条款，请以你们公司最新公告与人工客服确认为准。",
    ].join("\n");
  }

  private hasRelevantKnowledge(question: string, knowledgeItems: AiKnowledgeItem[]): boolean {
    if (knowledgeItems.length === 0) return false;
    return this.pickRelevantKnowledge(question, knowledgeItems).length > 0;
  }

  private pickRelevantKnowledge(question: string, knowledgeItems: AiKnowledgeItem[]): AiKnowledgeItem[] {
    if (knowledgeItems.length === 0) return [];
    const normalizedQuestion = question.replace(/\s+/g, "");
    const hints = [
      "清关",
      "报关",
      "时效",
      "多久",
      "几天",
      "费用",
      "运费",
      "计费",
      "赔付",
      "理赔",
      "签收",
      "派送",
      "发票",
      "对账",
      "禁运",
      "资料",
      "装箱单",
      "轨迹",
    ].filter((item) => normalizedQuestion.includes(item));
    if (hints.length === 0) {
      return knowledgeItems.slice(0, 2);
    }
    return knowledgeItems
      .map((item) => {
        const content = `${item.title}${item.content}`.replace(/\s+/g, "");
        const score = hints.reduce((acc, hint) => (content.includes(hint) ? acc + 1 : acc), 0);
        return { item, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item)
      .slice(0, 3);
  }

  private summarizeKnowledgeContent(content: string): string {
    const plain = content.replace(/\s+/g, " ").trim();
    if (!plain) return "暂无详细内容";
    return plain.length > 80 ? `${plain.slice(0, 80)}...` : plain;
  }

  private buildServiceQaDirectHint(question: string, topKnowledge?: AiKnowledgeItem): string {
    if (!topKnowledge) return "基于当前资料，建议先联系人工客服确认。";
    const questionText = question.replace(/\s+/g, "");
    if (/(多久|几天|时效|清关)/.test(questionText)) {
      return `根据「${topKnowledge.title}」的说明，清关/时效请以该条目内容为准，通常可按其中时长范围向客户答复。`;
    }
    if (/(费用|运费|计费|体积重|实重)/.test(questionText)) {
      return `根据「${topKnowledge.title}」的说明，费用与计费规则请按该条目执行，并以最新对账口径为准。`;
    }
    return `根据「${topKnowledge.title}」可给出初步答复，具体执行请按该条目细则。`;
  }

  private shouldRecordKnowledgeGap(input: {
    question: string;
    answer: string;
    knowledgeCount: number;
    evidenceOrderIds: string[];
    evidenceShipmentIds: string[];
  }): boolean {
    const noEvidence = input.evidenceOrderIds.length === 0 && input.evidenceShipmentIds.length === 0;
    const noInfoAnswer = /(信息不足|无法给出|无法确认|暂无与|暂无相关|请咨询人工客服|请以.*人工客服|无法给出确切答复)/.test(
      input.answer,
    );
    if (this.isServiceQaIntent(input.question) && (input.knowledgeCount === 0 || noInfoAnswer)) {
      return true;
    }
    return noEvidence && noInfoAnswer;
  }

  private isFollowUpMessage(question: string): boolean {
    const text = question.replace(/\s+/g, "");
    return /^(那|那我|那这个|那本月|那最近|那耳机|呢|然后|还有呢|那还有)/.test(text);
  }

  private async getSessionMemory(auth: AuthContext, sessionId: string): Promise<SessionMemory | undefined> {
    const now = Date.now();
    await this.deps.memoryStore.cleanupOlderThan(new Date(now - ClientAiService.MEMORY_TTL_MS).toISOString());
    const row = await this.deps.memoryStore.get(this.sessionMemoryKey(auth, sessionId));
    if (!row) return undefined;
    return {
      intent: row.intent,
      itemName: row.itemName,
      statusScope: row.statusScope,
      timeHint: row.timeHint,
      metric: row.metric,
      updatedAt: Date.parse(row.updatedAt) || now,
    };
  }

  private async setSessionMemory(
    auth: AuthContext,
    sessionId: string,
    patch: Partial<SessionMemory>,
  ): Promise<void> {
    const key = this.sessionMemoryKey(auth, sessionId);
    const prevRow = await this.deps.memoryStore.get(key);
    const prev: SessionMemory | undefined = prevRow
      ? {
          intent: prevRow.intent,
          itemName: prevRow.itemName,
          statusScope: prevRow.statusScope,
          timeHint: prevRow.timeHint,
          metric: prevRow.metric,
          updatedAt: Date.parse(prevRow.updatedAt) || Date.now(),
        }
      : undefined;
    const next: SessionMemory = {
      intent: patch.intent ?? prev?.intent,
      itemName: patch.itemName ?? prev?.itemName,
      statusScope: patch.statusScope ?? prev?.statusScope,
      timeHint: patch.timeHint ?? prev?.timeHint,
      metric: patch.metric ?? prev?.metric,
      updatedAt: Date.now(),
    };
    await this.deps.memoryStore.set({
      key,
      companyId: auth.companyId,
      userId: auth.userId,
      sessionId,
      intent: next.intent,
      itemName: next.itemName,
      statusScope: next.statusScope,
      timeHint: next.timeHint,
      metric: next.metric,
      updatedAt: new Date(next.updatedAt).toISOString(),
    });
  }

  private sessionMemoryKey(auth: AuthContext, sessionId: string): string {
    return `${auth.companyId}:${auth.userId}:${sessionId}`;
  }

  private suggestItemNames(keyword: string, orders: Array<{ itemName: string }>): string[] {
    const names = Array.from(
      new Set(
        orders
          .map((item) => item.itemName?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    );
    return names
      .filter((name) => name.includes(keyword) || keyword.includes(name))
      .slice(0, 5);
  }

  private formatNoDataByProductAnswer(keyword: string, similarNames: string[]): string {
    return [
      "【查询结论】",
      `未查询到品名「${keyword}」相关订单。`,
      "",
      "【建议操作】",
      similarNames.length > 0
        ? `可尝试这些相近品名：${similarNames.join("、")}。`
        : "请确认品名是否与系统录入一致，或提供单号进行查询。",
    ].join("\n");
  }

  private formatNoDataInCurrentScopeAnswer(
    keyword: string,
    timeLabel: string,
    statusLabel: string,
  ): string {
    return [
      "【查询结论】",
      `已识别到品名「${keyword}」，但在当前筛选范围内暂无匹配结果。`,
      "",
      "【筛选范围】",
      `${timeLabel} / ${statusLabel}`,
      "",
      "【建议操作】",
      '可改成"全部时间"或"全部状态"再试，或直接提供单号让我帮你查明细。',
    ].join("\n");
  }

  private countOrdersByProduct(keyword: string, orders: Array<{ itemName: string }>): number {
    return orders.filter((item) => item.itemName.includes(keyword) || keyword.includes(item.itemName)).length;
  }
}
