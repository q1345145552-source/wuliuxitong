import { AI_STATUS_SCOPES, type AiStatusScope } from "./ai-types";
import type {
  AiChatRequest,
  AiChatResponse,
  AiSuggestionResponse,
} from "../../../../../packages/shared-types/common-response";
import type { AiKnowledgeItem, AiQueryAuditLog, Shipment } from "../../../../../packages/shared-types/entities";
import { isInTransitStatus, classifyStatusGroup, type ShipmentStatus } from "../../../../../packages/shared-types/shipment-status";
import { pickSlowestStatus } from "../shipments/parent-status";
import { logger } from "../core/logger";
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
// 「在途」= 已装柜到派送完成之前的所有环节。2026-08-13 把新加的 8 个也算进在途。
// ⚠️ 2026-08-21：原来这里手写了一份在途状态清单，**漏掉了全部 5 个陆运状态**
// （到达凭祥口岸 / 口岸滞留 / 过境越南 / 海关查验 / 老挝边境已放行）——
// 客户问 AI「现在在途多少票」，陆运的货一票都不算（生产实测漏掉 30 张父单）。
// 现在改用 shared-types 里从流程表自动推导的那份，跟管理员看板同一个口径，
// 以后往流程里加环节这里会自己跟上。**别再在这里写死清单。**
/** 合并后的「一票货」：父单 + 它全部子单算作一条，memberIds 留着原始行 id */
type Ticket = Shipment & { memberIds: string[] };

/**
 * 中国时区固定 +8（不实行夏令时）。
 * ⚠️ 生产容器没设 TZ（docker-compose.yml 里没有），Node 的本地时区就是 UTC，
 * 所有 `setHours` / `getFullYear` 之类的本地时区方法都会得到 UTC 的日期。
 * 本文件涉及日期的地方一律用这个偏移量手动换算，不依赖服务器时区，
 * 这样开发机（UTC+8）和线上容器（UTC）跑出来是同一个结果。
 * 与管理员看板（admin/routes.ts）同一口径。
 */
export const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 时间词的同义写法。
 * ⚠️ 2026-08-28 实测：推荐问题列表里那句「我这个月一共发了多少货？」原来**一个时间筛选都没走** ——
 * 代码只认「本月」，不认「这个月」，于是客户问的是本月、系统给的是开户至今的总数。
 * （模型解析出 timeHint 时能兜住，但模型没返回或调用失败时就直接报全量，客户看到的数字大得离谱。）
 * 往下加同义词时注意：只加**同一个时间窗**的不同说法，不要在这里发明新窗口。
 */
const TODAY_RE = /(今天|今日)/;
const YESTERDAY_RE = /(昨天|昨日)/;
const THIS_WEEK_RE = /(本周|这周|本星期|这星期|这个星期)/;
const THIS_MONTH_RE = /(本月|这个月|这月|当月)/;

const GREETING_RE = /(你好|您好|hi|hello|哈喽|在吗|你在吗)/i;
const SERVICE_QA_RE =
  /(时效|多久|几天|清关|报关|费用|运费|计费|体积重|实重|禁运|违禁|能寄|可以寄|赔付|理赔|破损|丢件|签收|派送|上门|对账|发票|资料|装箱单|轨迹|查不到)/;

interface TimeWindow {
  start?: Date;
  end?: Date;
  label: string;
}

/* 2026-09-03 加 "arrived"：老板把「已到仓」拆成独立分组后，客户问
   「我到仓了几单」原来一个词都对不上，会掉进 "all" 当成查全部，答出来的数
   跟他自己点「已到仓」按钮看到的对不上。
   清单本体在 ai-types.ts 的 AI_STATUS_SCOPES，这里只取类型。 */
type StatusScope = AiStatusScope;
type SummaryMetric = "count" | "volume" | "weight" | "mixed";
interface ProductScope {
  keyword?: string;
  label: string;
}
/** 发给模型的知识库条数与每条字数上限 —— 上下文越长，每条消息付的 token 越多 */
const LLM_KNOWLEDGE_MAX_ITEMS = 8;
const LLM_KNOWLEDGE_MAX_CHARS = 500;

/** 只用到品名的地方用这个最小形状（订单自己的 itemName + 全部货品行的品名） */
type ProductNameSource = { itemName?: string; productNames?: string[] };
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

    // assertClientRole 已保证 role === "client"，此时 auth.userId 即客户 ID，
    // 与 /client/orders 的 `clientId: auth.userId` 口径一致
    const scope = { companyId: auth.companyId, clientId: auth.userId };
    const orders = await this.deps.dataSource.listOrders(scope);
    const shipments = await this.deps.dataSource.listShipments(scope);
    /**
     * ⚠️ 汇总一律用 tickets，**不要用 shipments**（2026-08-25 修）。
     *
     * `shipments` 是数据库原始行，分柜后一票货会占好几行（父单 + 每个子单各一行）。
     * 原来汇总直接数行数，等于**把一票货数成好几票**：
     *   生产实测 —— 客户问「在途多少票」，AI 答 726，实际 367；
     *   问「一共多少票」，AI 答 1862，实际 978。**真客户已经这么问过 9 次。**
     * 而管理员看板 2026-08-21 已经改成只数父单了，AI 不改就是两边对着报不同的数。
     *
     * ⚠️ 单号精确查询那条分支**必须继续用 shipments 原始行** ——
     * 客户可能拿子单号（如 SZ260801388-2）来查，合并后就查不到了。
     */
    const tickets = this.collapseToTickets(shipments);
    // 重量/体积一律走这个映射，别再对父子单直接求和（历史分柜数据会重复计算）
    const orderTotals = this.buildOrderTotals(orders, shipments);
    const knowledgeItems = await this.deps.knowledgeStore.list(auth.companyId);

    const modelIntent = await this.parseIntentWithModel(question, orders, memory);
    // ⚠️ 模型返回的单号必须先验一遍，见 acceptModelTrackingNo 的说明。
    // 原来是 `正则抓的 ?? 模型给的`，模型在 trackingNo 里随便填个非空值，
    // 后面所有统计逻辑就被跳过了：客户问「我这个月发了多少货」，
    // 拿到的却是「未找到运单号 XXXX」。
    const trackingNo =
      this.extractTrackingNo(question) ?? this.acceptModelTrackingNo(modelIntent.trackingNo, question);
    let answerDraft: string;
    let evidenceShipmentIds: string[] = [];
    let evidenceOrderIds: string[] = [];
    let nextMemory: Partial<SessionMemory> | null = null;
    let shouldCreateKnowledgeGap = false;
    /**
     * 这条答复里有没有**系统自己算出来的业务数据**（单量/重量/方数/状态/时间）。
     * 有的话一律不给模型润色 —— 见下面 refinedAnswer 那段的长注释。
     * ⚠️ 用分支标记、不用「扫一眼有没有数字」：服务问答里那句
     * 「已投喂的业务知识（当前 0 条）」也带数字，按数字判会把润色整个废掉，
     * 而用户拍板的是**统计类**不润色，不是全部。
     */
    let answerHasBusinessData = false;

    /**
     * 抓到的单号在这个客户名下**找不到**、而这句话又明显是统计问题时，
     * 不要霸占分支。带字母数字的产品型号（"ABC1234"）会被正则误认成运单号，
     * 客户问「我这个月 ABC1234 发了多少单」原来只会得到「未找到运单号」。
     * 单号找得到、或者这句话本来就是查单号（"到哪了"），照旧走查单分支。
     *
     * ⚠️ 但客户**明说了「单号」**的时候，查不到就得明说查不到。
     * 2026-08-28 复核实测：他有 3 单（已完成 2 / 在途 1），
     * 问「单号 THCN9999 完成了吗」时，因为这句话带「完成」被当成统计问题，
     * 系统让开了查单分支，转头回他「已完成的有 2 单」——
     * 他问的是某一票货，拿到的是一个跟他问题无关的数字。
     * 「单号 THCN9999 这个月发了多少单」同理，回的是本月 3 单。
     */
    const matchedShipment = trackingNo
      ? shipments.find((item) => item.trackingNo === trackingNo)
      : undefined;
    const useTrackingBranch =
      Boolean(trackingNo) &&
      (Boolean(matchedShipment) ||
        this.mentionsTrackingNoExplicitly(question) ||
        !this.isSummaryIntent(question));

    if (useTrackingBranch && trackingNo) {
      const shipment = matchedShipment;
      if (!shipment) {
        answerDraft = this.formatNotFoundAnswer(trackingNo);
      } else {
        answerDraft = await this.formatProgressAnswer(shipment);
        evidenceShipmentIds = [shipment.id];
        evidenceOrderIds = [shipment.orderId];
      }
      // 单号、状态、最近更新时间都是系统查出来的事实，同样不给模型改
      answerHasBusinessData = true;
      nextMemory = { intent: "tracking" };
    } else if (
      /* 问数量的不当成打招呼（2026-09-29 Codex 全系统检查）：「你好，我本月有多少单」原来只回一句欢迎语 */
      (this.isGreetingMessage(question) || this.acceptModelGreeting(question, modelIntent)) &&
      !this.isCountQuestion(question)
    ) {
      answerDraft = this.formatGreetingAnswer();
    } else if (this.isServiceQaIntent(question) && !this.isCountQuestion(question)) {
      /* 问数量的不进服务问答（同上）：「签收」「派送」既是服务问题的关键词、也是状态词，
         「本月已签收多少单」「派送中有多少单」原来被当成服务问题，回的是「当前可用知识信息不足」，一个数都没有。 */
      const relevantKnowledge = this.pickRelevantKnowledge(question, knowledgeItems);
      const hasRelevantKnowledge = relevantKnowledge.length > 0;
      answerDraft = this.formatServiceQaAnswer(question, knowledgeItems.length, relevantKnowledge);
      shouldCreateKnowledgeGap = !hasRelevantKnowledge;
    } else if (this.shouldAskClarification(question, modelIntent, trackingNo)) {
      answerDraft = this.formatClarificationAnswer();
    } else if (this.isSummaryIntent(question) || this.isCountQuestion(question) || modelIntent.intent === "summary" || modelIntent.intent === "unknown") {
      /**
       * ⚠️ 时间和状态都是**问句里说了就听问句的**，模型只补客户没说的那部分。
       * 2026-08-28 复核实测：原来模型返回的 timeHint / statusScope 排在前面，
       * 客户问「这个月在途多少单」而模型返回「今天、已完成」时，
       * 系统真的回答了「今天已完成 1 单」—— 问的和答的根本不是一回事。
       */
      const askedNow = new Date();
      /**
       * ⚠️ 顺序：**先认品名，再拿剩下的问句去解析时间和状态**。
       *
       * 2026-08-28 复核实测：品名真的叫「完成品」的客户问「完成品有多少单」，
       * 品名里那个「完成」被当成状态词，系统自动加了「已完成」筛选 ——
       * 他一共 3 单，答复只报了 1 单。更糟的是「我的完成品还有多少在途」：
       * 品名里的「完成」抢在客户真正说的「在途」前面，答的是已完成。
       * 品名叫「本月货」的同理，会被自动加上「本月」。
       */
      const productScope = this.resolveProductScope(
        question,
        orders,
        modelIntent.itemName,
        isFollowUp ? memory?.itemName : undefined,
      );
      const restQuestion = this.stripProductKeyword(question, productScope.keyword);
      const ruleTimeWindow = this.resolveTimeWindow(restQuestion, askedNow);
      let timeWindow = ruleTimeWindow;
      if (ruleTimeWindow.label === "当前公司账号数据") {
        const hint = modelIntent.timeHint?.trim() || (isFollowUp ? memory?.timeHint : undefined);
        if (hint) timeWindow = this.resolveTimeWindow(hint, askedNow);
      }
      /**
       * ⚠️ `undefined` 才表示「客户没提状态」，这时候模型才有资格补。
       * 客户明确说了（含「一共/全部/所有」这类要全部的说法）就一锤定音。
       * 优先级：**问句明确条件 → 模型补充 → 会话记忆 → 默认全部**。
       */
      const explicitStatusScope = this.resolveStatusScope(restQuestion);
      const statusScope: StatusScope =
        explicitStatusScope ??
        modelIntent.statusScope ??
        (isFollowUp ? memory?.statusScope : undefined) ??
        "all";
      const metric = this.resolveMetric(
        restQuestion,
        modelIntent.metric,
        isFollowUp ? memory?.metric : undefined,
      );
      const filteredShipments = this.filterShipmentsByScope(
        tickets,
        orders,
        timeWindow,
        statusScope,
        productScope,
      );
      const evidenceOrderIdSet = new Set(
        filteredShipments.map((item) => item.orderId).filter((id): id is string => Boolean(id)),
      );
      // 证据要展开成原始行 id（一票货可能对应父单+多个子单），方便事后追溯
      evidenceShipmentIds = filteredShipments.flatMap((item) => (item as Ticket).memberIds ?? [item.id]);
      evidenceOrderIds = orders
        .filter((item) => evidenceOrderIdSet.has(item.id))
        .map((item) => item.id);
      const summary = this.buildCompanySummary(filteredShipments, orderTotals);
      // 按品名查时，命中的单里可能还夹着别的货。重量体积是**整票**统计的，
      // 不拆到单个品名（拆就得自己发明一套算法，而方数是要印给客户看的）。
      // 有这种单就明说一句，免得客户拿「耳机 3 单 500 公斤」来质疑数字。
      const mixedProductOrders = productScope.keyword
        ? orders.filter(
            (item) => evidenceOrderIdSet.has(item.id) && this.orderItemNames(item).length > 1,
          ).length
        : 0;
      answerDraft = this.formatSummaryAnswer(summary, {
        timeLabel: timeWindow.label,
        statusLabel: this.statusScopeLabel(statusScope),
        productLabel: productScope.label,
        metric,
        // 按状态筛过之后，「在途/已完成」的分项是拿筛剩下的再统计的，会自相矛盾，
        // 所以只有「全部运单」才打那两行。详见 formatSummaryAnswer 的注释。
        showStatusBreakdown: statusScope === "all",
        productNote:
          mixedProductOrders > 0
            ? `其中 ${mixedProductOrders} 单同时还有别的品名，重量体积按整票统计。`
            : undefined,
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
      answerHasBusinessData = true;
      nextMemory = {
        intent: "summary",
        statusScope,
        itemName: productScope.keyword,
        timeHint: timeWindow.label === "当前公司账号数据" ? undefined : timeWindow.label,
        metric,
      };
    } else {
      const summary = this.buildCompanySummary(tickets, orderTotals);
      answerDraft = this.formatSummaryAnswer(summary, {
        timeLabel: "当前公司账号数据",
        statusLabel: "全部运单",
        productLabel: "全部品类",
        metric: "count",
        showStatusBreakdown: true,
      });
      evidenceShipmentIds = shipments.map((item) => item.id);
      evidenceOrderIds = orders.map((item) => item.id);
      answerHasBusinessData = true;
      nextMemory = { intent: "summary", metric: "count" };
    }

    /**
     * 给模型的上下文只放它**用得上**的东西。
     *
     * ⚠️ 原来这里把 evidenceShipmentIds / evidenceOrderIds 两个**完整数组**塞了进去，
     * 还用 `JSON.stringify(..., null, 2)` 缩进输出、每个 id 单独一行。
     * 客户问「我一共多少单」时这就是他名下全部运单行的 id ——
     * 按代码注释里的生产数据，一个客户 1862 行，光这一段就上万个字符。
     * 模型的任务只是「把 answerDraft 换个说法」，一个 id 都用不上，纯烧 token，
     * 而且每条消息要付两次（猜意图 + 润色）。
     * 现在只给条数；完整的 id 照旧放在接口返回的 evidence 里，事后追溯不受影响。
     *
     * 知识库也从「整篇原文」改成截断，8 条各 500 字封顶 ——
     * 原来一条几千字的规章能把上下文顶爆。
     * companyId 也拿掉了：模型不需要，没必要把内部 id 发给第三方。
     */
    /**
     * 🚨 遮罩在这里做一次，**提示词和上下文共用同一份**（2026-08-28 复核后重做）。
     * 只遮提示词是不够的：上下文 JSON 里的 answerDraft 还是真数字，模型照样看得见；
     * 而且它一旦照着上下文回真数字，回填校验会把每一次润色都判成
     * 「自己写了数字」而退回 —— 等于润色永远不生效。
     */
    const maskedDraft = this.maskNumbers(answerDraft);
    const llmContext = JSON.stringify({
      question,
      answerDraft: maskedDraft.text,
      knowledgeItems: knowledgeItems.slice(0, LLM_KNOWLEDGE_MAX_ITEMS).map((item) => ({
        title: item.title,
        content: this.truncate(item.content, LLM_KNOWLEDGE_MAX_CHARS),
      })),
      evidenceShipmentCount: evidenceShipmentIds.length,
      evidenceOrderCount: evidenceOrderIds.length,
    });
    /**
     * ⚠️⚠️ **带数字的答复一律不给模型润色**（用户 2026-08-28 拍板）。
     *
     * 之前一直在跟模型斗智：先比数字集合、再换占位符、再焊住整行、再要求「数据行逐字一致」。
     * 每一版都被复核找到新的绕法，最后一版实测是**两头不讨好**：
     *   · 员工正常改个措辞（「一共查到」→「您目前一共查到」）→ 整段被退回，润色等于没生效；
     *   · 模型另起一句不带数字的假话（「以上订单均已完成。」）→ 照样放行，
     *     跟下面「已完成：1 单」自相矛盾，客户看了更糊涂。
     *
     * 根子在于：**只要让模型碰这段话，就永远堵不完**。
     * 所以改成——草稿里只要有一个数据占位符，就直接把系统写好的原话发出去，
     * 连模型都不调。好处不止是数字不会错：
     *   · 假话不可能出现（模型根本没参与）；
     *   · 这个接口是全系统唯一直接花钱的地方，统计类消息从此少调一次 DeepSeek；
     *   · 客户看到的东西可复现，出问题能照着代码复盘。
     * 代价是统计回答固定是模板腔，不会因人而异 —— 用户认了。
     *
     * 服务问答那类（知识库答复、打招呼、澄清反问）里没有系统算出来的数字，
     * 照旧走润色，那才是润色真正有用的地方。
     */
    const refinedAnswer = answerHasBusinessData
      ? answerDraft
      : await this.refineAnswerWithModel(question, llmContext, answerDraft, maskedDraft);
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
      // 2026-08-31：只用时间戳做编号，两条对话撞同一毫秒会撞主键，第二条整个 500
      //（答案已算出、DeepSeek 的钱已花，白白作废）。照下面 gap_ 的写法加随机后缀防撞。
      id: `aiq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
    orders: ProductNameSource[],
    memory?: SessionMemory,
  ): Promise<ModelIntent> {
    // If key is unavailable or model parsing fails, fallback to rule-based parsing.
    // ⚠️ 先去重再截断。原来是先 slice(0,40) 再去重，重复品名会占掉名额，
    // 实际给模型的候选可能只剩个位数 —— 模型认不出品名，就更依赖它自己瞎猜。
    const itemNames = Array.from(new Set(orders.flatMap((item) => this.orderItemNames(item)))).slice(
      0,
      40,
    );
    const parseContext = JSON.stringify(
      {
        question,
        hintItemNames: itemNames,
        expectedJsonSchema: {
          intent: "greeting|tracking|summary|unknown",
          trackingNo: "string",
          itemName: "string",
          // 提示词里的可选值也从同一份清单生成，模型才知道有「已到仓」这个选项
          statusScope: AI_STATUS_SCOPES.join("|"),
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
      /* 2026-09-03：白名单改成照着 AI_STATUS_SCOPES 查，别再手写一串 ——
         加范围时这里漏改的话，模型答对了也会被这道闸吞掉，静悄悄退回「查全部」。 */
      const statusScope = (AI_STATUS_SCOPES as readonly string[]).includes(statusRaw)
        ? (statusRaw as StatusScope)
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

  /**
   * 从问句里抓运单号。
   *
   * ⚠️ 末尾那个 `(?:-\d+)?` 是 2026-08-28 复核补的：分柜出来的子单号长这样
   * `SZ260801388-2`，原来的正则只抓到 `SZ260801388` —— 客户查子单，
   * 系统拿父单号去找，回给他的是**父单的状态和时间**。
   * 只读核对过：真实子单 16/16 全被截成父单，其中 2 单状态不同、9 单更新时间不同。
   */
  private extractTrackingNo(message: string): string | undefined {
    if (!message) return undefined;
    const match = message.match(/[A-Za-z]{2,}\d{3,}(?:-\d+)?/);
    return match?.[0]?.toUpperCase();
  }

  /**
   * 要不要采信模型给的运单号。
   *
   * 模型返回的这个值原来**一点校验都没有**，只要非空就直接走「查单号」分支，
   * 把统计逻辑整个跳过。两道门：
   * ① 长得像单号（两位以上字母 + 三位以上数字，允许 `-2` 这种子单后缀）；
   * ② **必须真的在客户那句话里出现过** —— 忽略空格和横杠再比，
   *    这样客户写「TH-CN 0001」时模型帮忙归一化成 THCN0001 仍然认，
   *    但模型凭空编一个就一定过不了这关。
   */
  private acceptModelTrackingNo(raw: string | undefined, question: string): string | undefined {
    const candidate = raw?.trim().toUpperCase();
    if (!candidate) return undefined;
    if (!/^[A-Z]{2,}\d{3,}(?:-\d+)?$/.test(candidate)) return undefined;
    const compact = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!compact(question).includes(compact(candidate))) return undefined;
    return candidate;
  }

  /** 截断长文本，末尾加省略号，避免把模型上下文顶爆 */
  private truncate(text: string, maxChars: number): string {
    const value = text ?? "";
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
  }

  /**
   * 客户是不是**明说**了「单号」。
   * 明说了就得给他单号的答复 —— 哪怕查不到，也要明说「未找到运单号 XXX」，
   * 不能让开分支去统计他别的单。「运单号」「快递单号」「提单号」都含「单号」两个字。
   */
  private mentionsTrackingNoExplicitly(message: string): boolean {
    return /(单号|追踪号|快递号)/.test(message);
  }

  private isGreetingMessage(message: string): boolean {
    return message.length <= 20 && GREETING_RE.test(message);
  }

  /**
   * 模型说「这句是打招呼」，要不要认。
   *
   * ⚠️ 只在**规则认不出这句话在问什么**的时候才认 —— 模型只能补空位。
   * 2026-08-28 复核实测：客户问「我这个月发了多少单」、模型返回 greeting 时，
   * 系统真的回了欢迎语，一个数字都没有。
   */
  private acceptModelGreeting(question: string, modelIntent: ModelIntent): boolean {
    if (modelIntent.intent !== "greeting") return false;
    if (this.isSummaryIntent(question)) return false;
    if (this.isServiceQaIntent(question)) return false;
    return true;
  }

  private isSummaryIntent(message: string): boolean {
    // 2026-09-03 补「到仓」：「哪些货到仓了」原来不算统计问题，会被反问一句
    return /(统计|汇总|总量|多少|几单|数量|重量|体积|在途|完成|异常|到仓|近\d+天|最近\d+天|今天|今日|昨天|昨日|本周|这周|本星期|这星期|本月|这个月|这月|当月)/.test(
      message,
    );
  }

  private isServiceQaIntent(message: string): boolean {
    return SERVICE_QA_RE.test(message);
  }

  /**
   * 明确在问「多少单 / 几票 / 几件」这种**数量**（2026-09-29）。
   * 比「统计意图」窄：不含单独的「多少」—— 「运费多少」「清关要多少天」是服务问题，不能抢过来。
   */
  private isCountQuestion(message: string): boolean {
    return /(多少单|几单|多少票|几票|多少件|几件|单量|多少个(运)?单|多少个订单)/.test(message);
  }

  /**
   * 从问句里认状态。
   *
   * ⚠️ 返回 `undefined` 表示**客户压根没提状态**，跟「客户明确说要全部」（`"all"`）是两回事。
   * 2026-08-28 复核实测：原来这两种情况都返回 `"all"`，调用处只好写成
   * 「只要是 all 就让模型改」—— 于是客户问「我一共有多少单」、模型返回「已完成」时，
   * 系统真的只报了已完成的那 1 单（一共 3 单）。
   *
   * ⚠️ 顺序：**具体状态词排在「要全部」的词前面**。
   * 「这个月一共完成了多少单」既有「一共」又有「完成」，必须按已完成算。
   * 这条顺序由第 46 项测试盯着 —— 之前 39 项里没有一句话同时带两种词，写反了也发现不了。
   *
   * ⚠️ 这里新增的「一共/总共/统共/总计/全部/所有/加起来」必须和
   * `BLOCKED_PRODUCT_KEYWORDS`、`normalizeProductKeyword` 里的剥词表同步 ——
   * 不同步的话这些词会被当成**品名**去查（实测「总计多少单」→「未查询到品名『总计』相关订单」）。
   */
  private resolveStatusScope(message: string): StatusScope | undefined {
    /* ⚠️ 否定必须**最先判**，否则整句意思会被读反。
       2026-09-03 复核实测：加了「到仓」这个范围之后，客户问「还有多少单没到仓」
       会命中下面的「到仓」→ 按**已到仓**去查，把「还没到的」问成「已经到了的」，
       数字正好是反面那一批；而且这个错范围还会写进会话记忆，接着追问一路错下去。
       这里返回 undefined（= 当作客户没明确说状态），交给模型判断、兜底走「全部」
       并附上分项 —— 宁可不精准，也绝不给一个方向相反的数。 */
    if (/(还没|没有|尚未|未曾|不曾|没|未)\s*(到仓|进仓|到达仓库|到泰国仓|到货|发出|发走|装柜)/.test(message)) {
      return undefined;
    }
    if (/(未完成|没完成|未签收|未结束)/.test(message)) return "unfinished";
    if (/(异常|退回|取消)/.test(message)) return "exception";
    if (/(完成|签收|已完成)/.test(message)) return "completed";
    /* 「到仓」= 到**泰国仓**。客户嘴里的「国内仓」是发货前那一头，带这些词就不算已到仓。
       ⚠️ 2026-09-03 复核后收窄：原来还认「进仓 / 到货了 / 到了没 / 派送中 / 正在派送」，
          · 「派送」被 SERVICE_QA_RE 抢在前面截走，那两个词从来走不到这里，是死的；
          · 「进仓 / 到货了 / 到了没」在客户口语里也可能是在问国内仓，会答反。
          宁可少认几种说法（退回「查全部」并附分项），也不要认错方向。 */
    /* ⚠️ 问「什么时候到仓」的人要的是**日期**，不是「已经到了几单」。
       2026-09-03 自查实测：不排掉的话，客户问「我的货什么时候到仓」，
       系统一本正经答「已到仓运单 3 单」—— 答非所问，比不答更糟。
       这类问句退回「没指定状态」，走全部+分项，至少不会声称一个错的范围。 */
    const 问的是时间 = /(什么时候|啥时候|何时|几号|哪天|哪一天|多长时间|还要几天|预计.*到)/.test(message);
    if (
      !问的是时间 &&
      !/(国内仓|中国仓|发货仓|国内那个仓)/.test(message) &&
      /(到仓|已到仓|到达仓库|到泰国仓|到了泰国)/.test(message)
    ) return "arrived";
    if (/(在途|运输中|在路上|路上)/.test(message)) return "inTransit";
    // 客户明确说了「要全部」——到此为止，模型不许再改成某个状态
    if (/(一共|总共|统共|总计|加起来|全部|所有)/.test(message)) return "all";
    return undefined;
  }

  /**
   * 把已经认出来的品名从问句里拿掉，**剩下的**才拿去解析时间、状态和指标。
   *
   * ⚠️ 品名里带「完成」「在途」「本月」这类词的客户不是个别现象。
   * 2026-08-28 复核实测（品名真的叫这些名字）：
   *   ·「完成品有多少单」  → 品名里的「完成」被当成状态，一共 3 单只报了 1 单；
   *   ·「我的完成品还有多少在途」→ 品名里的「完成」抢在客户说的「在途」前面，答的是已完成；
   *   ·「本月货有多少单」  → 品名里的「本月」被当成时间，一共 4 单只报了 1 单。
   *
   * 品名是客户自己填的，什么字符都可能有（`A+B`、`(特价)`），所以要先转义再做正则；
   * 换成空格而不是直接删掉，免得前后两截粘成一个新词。
   * 整句话就是品名时剥成空串是**对的** —— 那本来就没提时间和状态，交给默认值。
   */
  private stripProductKeyword(question: string, keyword?: string): string {
    const needle = keyword?.trim();
    if (!needle) return question;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return question.replace(new RegExp(escaped, "gi"), " ");
  }

  /**
   * 「今天 / 昨天 / 本周 / 本月」一律按**北京时间**算（口径已由用户确认，2026-08-28）。
   *
   * ⚠️ 原来用的是 `setHours(0,0,0,0)`，取的是**服务器本地时区**的零点。
   * 生产容器没设 TZ，本地时区就是 UTC —— UTC 零点 = 北京早上 8 点，于是：
   *   · 北京时间 0 点到 8 点之间下的单，会被算进「昨天」；
   *   · 每月 1 号早 8 点前下的单，会被算进「上个月」。
   * 而开发机在中国（UTC+8），本地跑起来又是对的 ——
   * 这就是「本地测没问题、线上数字对不上」的根因。
   *
   * 下面全部走 `getUTC*` / `setUTC*`，一个本地时区方法都不用，
   * 所以服务器时区是 UTC 还是 UTC+8，算出来都是同一个北京日历日。
   * 与管理员看板（admin/routes.ts）同一口径，保证同一天两边报的数一致。
   */
  private resolveTimeWindow(message: string, now: Date): TimeWindow {
    // 把真实时刻挪成「北京墙上时间」：它的 UTC 字段就是北京的年月日时分秒
    const beijingNow = new Date(now.getTime() + CHINA_OFFSET_MS);
    // 北京某天的零点，再挪回真实时刻（用于和数据库里的 UTC 时间戳比较）
    const beijingMidnight = (dayDelta: number): Date => {
      const d = new Date(beijingNow.getTime());
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() + dayDelta);
      return new Date(d.getTime() - CHINA_OFFSET_MS);
    };

    const dayMatch = message.match(/(?:最近|近)\s*(\d{1,3})\s*天/);
    if (dayMatch) {
      const days = Number(dayMatch[1]);
      if (!Number.isNaN(days) && days > 0) {
        return { start: beijingMidnight(-(days - 1)), label: `最近${days}天` };
      }
    }
    if (TODAY_RE.test(message)) {
      return { start: beijingMidnight(0), end: beijingMidnight(1), label: "今天" };
    }
    if (YESTERDAY_RE.test(message)) {
      return { start: beijingMidnight(-1), end: beijingMidnight(0), label: "昨天" };
    }
    if (THIS_WEEK_RE.test(message)) {
      // 周一算一周第一天；在 beijingNow 上取 getUTCDay 得到的就是「北京的星期几」
      const day = beijingNow.getUTCDay();
      const offset = day === 0 ? 6 : day - 1;
      return { start: beijingMidnight(-offset), label: "本周" };
    }
    if (THIS_MONTH_RE.test(message)) {
      const start = new Date(
        Date.UTC(beijingNow.getUTCFullYear(), beijingNow.getUTCMonth(), 1) - CHINA_OFFSET_MS,
      );
      return { start, label: "本月" };
    }
    return { label: "当前公司账号数据" };
  }

  private resolveProductScope(
    message: string,
    orders: ProductNameSource[],
    modelItemName?: string,
    memoryItemName?: string,
  ): ProductScope {
    if (this.isLikelyGenericSummaryMessage(message)) {
      const exactFromData = this.matchKnownItemFromMessage(message, orders);
      if (exactFromData) return { keyword: exactFromData, label: `品名：${exactFromData}` };
      if (memoryItemName) return { keyword: memoryItemName, label: `品名：${memoryItemName}` };
      return { label: "全部品类" };
    }

    /**
     * ⚠️ 顺序很重要：**客户在问句里明确说的排在最前，模型返回的排在最后**。
     * 2026-08-28 复核实测：原来模型返回的品名排第一，
     * 客户问「耳机有多少单」而模型返回「手机壳」时，系统真的去查了手机壳并报了它的数。
     * 模型只该补客户**没说清楚**的那部分（比如追问「那本月呢」时把品名带过来）。
     */
    const explicitFromQuestion = this.extractProductKeyword(message);
    if (explicitFromQuestion) {
      // 正则抓出来的片段可能被截短了（字符集里没有空格），先补回库里的完整品名
      const keyword = this.expandToKnownItem(explicitFromQuestion, message, orders) ?? explicitFromQuestion;
      return { keyword, label: `品名：${keyword}` };
    }

    const byPattern =
      message.match(/(?:多少个|多少|几个|几单|统计|汇总)?\s*([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})\s*(?:订单|运单)/) ??
      message.match(/品名[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})/) ??
      message.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})\s*(?:有多少|多少单)/);
    const candidate = this.normalizeProductKeyword(byPattern?.[1], true); // 句子片段
    if (candidate) {
      // 这条正则同样会把「我有多少ABC DEF的订单」截成「DEF」，一样要补回完整品名
      const keyword = this.expandToKnownItem(candidate, message, orders) ?? candidate;
      return { keyword, label: `品名：${keyword}` };
    }

    const matched = this.matchKnownItemFromMessage(message, orders);
    if (matched) {
      return { keyword: matched, label: `品名：${matched}` };
    }
    // 问句里实在认不出来，才轮到模型给的（而且必须对得上库里的真实品名，见下）
    const modelKeyword = this.acceptModelItemName(modelItemName, orders);
    if (modelKeyword) {
      return { keyword: modelKeyword, label: `品名：${modelKeyword}` };
    }
    if (memoryItemName) {
      return { keyword: memoryItemName, label: `品名：${memoryItemName}` };
    }

    return { label: "全部品类" };
  }

  /**
   * 要不要采信模型给的品名。跟 `acceptModelTrackingNo` 一个道理：**模型的话得能对上账**。
   *
   * ⚠️ 原来只做长度和控制字符检查，模型把**整句问话**当品名返回也照单全收。
   * 2026-08-28 复核实测：问「统计一下」，模型返回品名「统计一下我这个月发了多少单」、
   * `confidence` 只有 0.01，系统照样拿它去查 ——
   * 客户得到的是「未查询到品名『统计一下我这个月发了多少单』相关订单」，统计根本没跑。
   * `confidence` 是模型自己给自己打的分，拦不住任何东西，**这里不参与判断**。
   *
   * 现在的门槛：必须**等于**这个客户名下某个真实品名。
   * 比较时把全角转半角、去掉空格和大小写差异（模型爱做这种「归一化」），
   * 但**返回的是库里那个品名原文** —— 拿归一化后的串去查是查不到货的
   * （`matchesProductKeyword` 只做小写包含，不折全角），客户看到的品名也会变形。
   */
  private acceptModelItemName(
    raw: string | undefined,
    orders: ProductNameSource[],
  ): string | undefined {
    const candidate = this.normalizeProductKeyword(raw);
    if (!candidate) return undefined;
    const fold = (text: string): string =>
      text
        .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/\s+/g, "")
        .toLowerCase();
    const target = fold(candidate);
    if (!target) return undefined;
    return Array.from(new Set(orders.flatMap((item) => this.orderItemNames(item)))).find(
      (name) => fold(name) === target,
    );
  }

  /**
   * 正则抓出来的品名片段，如果只是**某个真实品名被截短的一截**，就补回完整品名。
   *
   * ⚠️ 抓品名的正则字符集 `[一-龥A-Za-z0-9_-]` **不含空格**。
   * 客户自己敲「ABC DEF订单有多少单」时只抓到「DEF」，而统计是「货品名里含这个词就算」——
   * 2026-08-28 复核实测（他有 ABC DEF 2 单、XYZ DEF 1 单）：
   *   ·「ABC DEF订单有多少单」→ 品名「DEF」→ 报 3 单，真实 2 单；
   *   ·「XYZ DEF订单有多少单」→ 品名「DEF」→ 报 3 单，真实 1 单（报大 3 倍）。
   * 第 31 项测试只测了「模型返回 ABC DEF」，客户直接输入这条一直没人测。
   *
   * 三道门，缺一个都会变成「替客户瞎猜」：
   * ① 完整品名必须**比片段长**（没截短就别动）；
   * ② 完整品名必须**含有**这个片段；
   * ③ 完整品名必须**原样出现在客户那句话里** ——
   *    客户只说了「DEF」而库里有「ABC DEF」时，绝不替他补成 ABC DEF。
   * 多个都满足就取最长的（跟 matchKnownItemFromMessage 同一个道理）。
   */
  private expandToKnownItem(
    fragment: string,
    message: string,
    orders: ProductNameSource[],
  ): string | undefined {
    const lowerMessage = message.toLowerCase();
    const needle = fragment.toLowerCase();
    return Array.from(new Set(orders.flatMap((item) => this.orderItemNames(item))))
      .filter((name) => name.length > fragment.length)
      .filter((name) => name.toLowerCase().includes(needle))
      .filter((name) => lowerMessage.includes(name.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0];
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
        true, // 这是从问句里抓出来的片段
      );
      if (candidate && candidate.length <= 20) return candidate;
    }
    return undefined;
  }

  /** 肯定不是品名的词，跟 resolveStatusScope / 时间词表一起维护 */
  private static readonly BLOCKED_PRODUCT_KEYWORDS = new Set([
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
    // 跟 resolveStatusScope 新增的「要全部」词表同步（2026-08-28）
    "总计",
    "加起来",
    "当前",
    "数据",
  ]);

  /**
   * @param fromSentence 这个词是不是**从客户那句话里正则抓出来的片段**。
   *   只有片段才做「剥掉人称/副词/动词」那一步。
   *   ⚠️ 2026-08-28 复核指出：模型返回的品名、和从数据库品名里认出来的名字，
   *   都是**已知的真实品名**，绝不能剥 —— 否则品名「我的美妆」会被剥成「美妆」、
   *   「壳的」会被剥成「壳」，统计范围直接错掉。
   */
  private normalizeProductKeyword(raw?: string, fromSentence = false): string | undefined {
    const keyword = raw?.trim().replace(/[？?。！!,.，]/g, "");
    if (!keyword) return undefined;
    if (fromSentence) {
      // 从句子里抓的片段才用严格字符集：这里宁可放弃，也别把半句话当成品名
      if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]{1,20}$/.test(keyword)) return undefined;
    } else {
      /**
       * 模型返回的、或从数据库认出来的，是**真实品名**，只做基本的长度和控制字符检查。
       * ⚠️ 原来这里对所有来源都套那个严格字符集，品名带空格（"ABC DEF"）
       * 或全角字符（"ＡＢＣ１２３"）会被整个丢掉 → 品名范围退回「全部品类」→
       * 客户问一个品名，系统把他**全部**的单都报给他，数字大得离谱。
       */
      if (keyword.length > 40) return undefined;
      if (/[\r\n\t]/.test(keyword)) return undefined;
    }
    // ⚠️ 这份「不是品名」的词表必须跟上面的时间词、和 resolveStatusScope 的状态词同步，
    // 漏一个词就会把整句问话当成品名。2026-08-28 实测漏掉的三种：
    //   ·「我这个月一共发了多少单」→ 品名"我这个月一共发了"（原表只有「本月」没有「这个月」）
    //   ·「今日发了多少单」        → 品名"今日发了"（原表只有「今天」没有「今日」）
    //   ·「最近 3 天异常件有多少？」→ 品名"天异常件"（原表有「完成/在途」，独独漏了「异常/退回/取消」）
    // 最后这句还是**系统自己摆在客户面前的推荐问题**，一点就回「未查询到品名『天异常件』相关订单」。
    /**
     * ⚠️ 这道词表只对**从句子里抓出来的片段**做「包含即拒」。
     * 真实品名（模型返回的、从数据库认出来的）只在**整个名字就等于**某个词时才拒 ——
     * 否则品名叫「运输箱」「完成品」的客户，一问就会退回「全部品类」，
     * 系统把他**全部**的单都报给他，数字大得离谱。
     */
    const looksLikeSentence =
      /* 2026-09-03 补「到仓|进仓|到达仓库|泰国仓|到货」——
         加了「已到仓」这个查询范围之后，客户问「已到仓的订单有多少」，
         品名识别排在状态识别前面，会把「已到仓」当成品名抓走（还会把这几个字
         从问句里剥掉，状态词跟着没了），最后回一句「未查询到品名『已到仓』相关订单」。
         跟 2026-08-28 那个「最近3天异常件」→ 品名「天异常件」是同一个坑，
         这张表必须跟 resolveStatusScope 的词表一起维护。 */
      /* 2026-09-29 补「派送|签收」：问数量的句子不再被服务问答截走以后，「派送中有多少单」
         会走到这里，不补的话「派送中」被当成品名，回「未查询到品名『派送中』」。 */
      /(最近|今天|今日|昨天|昨日|本周|这周|本星期|这星期|这个星期|本月|这个月|这月|当月|在途|路上|运输|完成|未完成|异常|退回|取消|到仓|进仓|到达仓库|泰国仓|国内仓|到货|装柜|发出|发走|派送|签收|什么时候|多少|几单|统计|汇总|有多少|还有|查询范围)/.test(
        keyword,
      );
    if (fromSentence && looksLikeSentence) return undefined;
    if (fromSentence && /\d+天/.test(keyword)) return undefined;
    if (ClientAiService.BLOCKED_PRODUCT_KEYWORDS.has(keyword)) return undefined;
    if (fromSentence && keyword.length <= 2 && /(我还|还有)/.test(keyword)) return undefined;

    if (!fromSentence) return keyword;

    /**
     * 再剥掉「我 / 我的 / 一共 / 发了」这类跟品名无关的词。
     *
     * 抓品名的正则是 `(任意 1-20 字)(?:有多少|多少单)`，中文没有词边界，
     * 前面那截会被整个抓进来：「我一共有多少单」→ 品名"我一共有"、
     * 「我一共发了多少单」→ 品名"我一共发了"。
     * 客户拿到的是「未查询到品名『我一共有』相关订单」，统计根本没跑。
     *
     * ⚠️ 只剥**开头的人称/副词**和**结尾的动词**，绝不做全局替换 ——
     * 否则「共享单车」会被剥成「享单车」、「有机玻璃」会被剥掉「有」。
     * 也不剥单个「共」字，同样是怕误伤「共享…」这类真品名。
     * 剥完是空的，就说明这句话里压根没提品名，按「全部品类」处理。
     */
    const stripped = keyword
      .replace(/^(?:我们|咱们|我|你们|你|咱)?(?:的)?/, "")
      // ⚠️ 这里是 `+` 不是 `?`：「加起来一共」剥掉「加起来」还剩「一共」，
      // 只剥一次的话它照样会被当成品名（实测「加起来一共多少单」→ 品名「加起来一共」）。
      .replace(/^(?:一共|总共|统共|总计|加起来|一起|大概|大约)+/, "")
      .replace(/(?:发了|发的|寄了|寄的|发过|寄过|下了|有|是|的)$/, "")
      .trim();
    if (!stripped) return undefined;
    if (ClientAiService.BLOCKED_PRODUCT_KEYWORDS.has(stripped)) return undefined;
    return stripped;
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

  /**
   * 一张订单的**全部**品名（第一个货品 + 所有货品行），去空去重。
   *
   * ⚠️ 只看 `order.itemName` 是不够的：那存的是第一个货品（orders/routes.ts 的 primaryName）。
   * 客户问「耳机有多少单」，耳机排在第二个货品的订单原来一张都查不到，
   * 还会回一句「未查询到品名『耳机』相关订单」—— 而他明明发了耳机。
   */
  private orderItemNames(order: ProductNameSource): string[] {
    const names = [order.itemName, ...(order.productNames ?? [])]
      .map((name) => name?.trim())
      .filter((name): name is string => Boolean(name));
    return Array.from(new Set(names));
  }

  /**
   * 这张订单算不算「关键词」这个品名。
   *
   * ⚠️ 原来的判断是 `name.includes(keyword) || keyword.includes(name)`，三个坑：
   *   ① 品名是空字符串时 `keyword.includes("")` **恒为真** ——
   *      那张单会被算进**任何**品名的统计（下单接口只 trim 不校验非空，空品名进得来）；
   *   ② 反向包含让品名「壳」的订单被算进「手机壳」的查询，数字凭空变大；
   *   ③ 只比对第一个货品，见 orderItemNames 的说明。
   *
   * 现在只用**正向包含**：货品名里含有客户说的那个词才算。
   * 反向包含（客户说「苹果手机壳」、库里存的是「手机壳」）不再计入统计 ——
   * 那种情况会走「查不到」分支，由 suggestItemNames 提示相近品名，
   * 让客户自己确认，而不是替他把数字算宽。**宁可提示查不到，也不能报错的数。**
   */
  private matchesProductKeyword(order: ProductNameSource, keyword: string): boolean {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return false;
    return this.orderItemNames(order).some((name) => name.toLowerCase().includes(needle));
  }

  /**
   * 从客户这句话里认出一个**库里真实存在**的品名。
   *
   * 两条规则都是为了别乱认（这次把匹配范围扩到全部货品行之后，风险变大了）：
   * ① **一个字的品名不算**。真有客户把品名写成「货」「单」「件」的，
   *    那样几乎每一句话都会被当成品名查询，统计范围直接错掉。
   * ② **认最长的那个**。客户同时有「壳」和「手机壳」两个品名、问的是「手机壳」时，
   *    按数组顺序先撞上「壳」就会把两种货一起算进去。按长度从长到短找，先中「手机壳」。
   */
  private matchKnownItemFromMessage(message: string, orders: ProductNameSource[]): string | undefined {
    const lowerMessage = message.toLowerCase();
    return Array.from(new Set(orders.flatMap((item) => this.orderItemNames(item))))
      .filter((name) => name.length >= 2)
      .sort((a, b) => b.length - a.length)
      .find((name) => lowerMessage.includes(name.toLowerCase()));
  }

  private filterShipmentsByScope(
    shipments: Shipment[],
    orders: Array<ProductNameSource & { id: string }>,
    timeWindow: TimeWindow,
    statusScope: StatusScope,
    productScope: ProductScope,
  ): Shipment[] {
    const keyword = productScope.keyword;
    const matchedOrderIds =
      keyword === undefined
        ? null
        : new Set(
            orders.filter((item) => this.matchesProductKeyword(item, keyword)).map((item) => item.id),
          );
    return shipments
      .filter((item) => (matchedOrderIds ? matchedOrderIds.has(item.orderId) : true))
      .filter((item) => this.inTimeWindow(item, timeWindow))
      .filter((item) => this.matchStatusScope(item, statusScope));
  }

  /**
   * 时间窗按**下单时间**（createdAt）筛，不是最后更新时间。
   *
   * ⚠️ 原来取的是 `updatedAt`：半年前发的货只要这个月有过一次状态推进
   * （到港、清关、派送都会改 updatedAt），就会被算进「本月发货」。
   * 推荐问题里就摆着「我这个月一共发了多少货？」，货越多、在途越久的客户偏得越离谱。
   *
   * 口径已由用户确认（2026-08-28）：「这个月发了多少货」= 这个月**下的单**。
   * 预报单创建时在同一段逻辑里就建了运单行（orders/routes.ts:290），
   * 所以运单的 createdAt 就是下单时间；分柜出来的子单 createdAt 是分柜时间，
   * 但汇总走的是 collapseToTickets 合并后的父单行，取到的仍是原始下单时间。
   */
  private inTimeWindow(shipment: Shipment, timeWindow: TimeWindow): boolean {
    if (!timeWindow.start && !timeWindow.end) return true;
    const ts = Date.parse(shipment.createdAt || shipment.updatedAt);
    if (Number.isNaN(ts)) return false;
    if (timeWindow.start && ts < timeWindow.start.getTime()) return false;
    if (timeWindow.end && ts >= timeWindow.end.getTime()) return false;
    return true;
  }

  private matchStatusScope(shipment: Shipment, statusScope: StatusScope): boolean {
    if (statusScope === "all") return true;
    /* 2026-09-03：改用排除法的 isInTransitStatus。原来用 IN_TRANSIT_STATUSES 白名单，
       ① 到了泰国仓的货也被算成在途（老板拍板：到仓不算在途）；
       ② 老数据里流程表没有的状态一张都数不到。两个毛病都会让 AI 报的数
       跟客户自己点「在途」按钮查出来的对不上。 */
    if (statusScope === "inTransit") return isInTransitStatus(shipment.currentStatus);
    // 2026-09-03：走跟客户端分组按钮同一个函数，AI 报的数跟客户点按钮看到的一致
    if (statusScope === "arrived") return classifyStatusGroup(shipment.currentStatus) === "arrived";
    if (statusScope === "completed") return COMPLETED_STATUSES.includes(shipment.currentStatus);
    if (statusScope === "unfinished") return !COMPLETED_STATUSES.includes(shipment.currentStatus);
    return EXCEPTION_STATUSES.includes(shipment.currentStatus);
  }

  private statusScopeLabel(statusScope: StatusScope): string {
    if (statusScope === "inTransit") return "在途运单";
    if (statusScope === "arrived") return "已到仓运单（含预约派送、派送中）";
    if (statusScope === "completed") return "已完成运单";
    if (statusScope === "unfinished") return "未完成运单";
    if (statusScope === "exception") return "异常/退回/取消运单";
    return "全部运单";
  }

  /**
   * 把数据库原始行合并成「一票货」（2026-08-25 新增）。
   *
   * 分柜后一票货在 shipments 表里占好几行：父单一行、每个子单一行。
   * 客户心里的「一票」是父单那一票，所以汇总必须按 `parentTrackingNo ?? trackingNo`
   * 分组，每组算 1 票。生产实测 1862 行 = 978 票。
   *
   * 几个口径：
   * - **状态**取父单的。父单状态由 syncParentStatusFromChildren 维护，
   *   本来就等于「走得最慢的子单」，跟运单列表、管理员看板同一个口径。
   *   万一这组里没有父单行，就用同一个 pickSlowestStatus 现算一遍 —— 用的是同一份规则，
   *   不会出现两处算法打架。
   * - **重量/体积/件数**是**整组相加**。分柜时这三样会从父单扣、分到子单上
   *  （2026-08-22 的修复），父单 + 全部子单加起来才等于整票的量。
   *   ⚠️ 这跟改之前的行为一致（原来也是把所有行加起来），所以这次只影响「票数」，不影响重量体积。
   * - **memberIds** 留着原始行 id，证据链要展开回具体哪几行。
   */
  private collapseToTickets(shipments: Shipment[]): Ticket[] {
    const groups = new Map<string, Shipment[]>();
    for (const row of shipments) {
      const key = row.parentTrackingNo ?? row.trackingNo;
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }

    const tickets: Ticket[] = [];
    for (const [key, rows] of groups) {
      // 没分过柜的占绝大多数，原样返回，别做无谓的对象拷贝
      if (rows.length === 1 && !rows[0].parentTrackingNo) {
        tickets.push({ ...rows[0], memberIds: [rows[0].id] });
        continue;
      }
      const parent = rows.find((r) => !r.parentTrackingNo);
      const base = parent ?? rows[0];
      const status =
        parent?.currentStatus ??
        (pickSlowestStatus(
          rows.map((r) => r.currentStatus),
          base.transportMode,
        ) as Shipment["currentStatus"] | null) ??
        base.currentStatus;
      const sum = (pick: (r: Shipment) => number | undefined) =>
        rows.reduce((acc, r) => acc + (Number(pick(r) ?? 0) || 0), 0);

      // ⚠️ 一票货的「下单时间」取家族里**最早**的那个。
      // 正常有父单时父单就是最早的；但历史上有父单行缺失的家族，
      // 这里 base 会退成 rows[0]（数据按 updatedAt desc 排），
      // 取到的可能是**分柜时间**，会把老订单算进分柜那个月。
      const earliestCreatedAt = rows
        .map((r) => r.createdAt)
        .filter((value): value is string => Boolean(value))
        .sort()[0];
      tickets.push({
        ...base,
        trackingNo: key,
        parentTrackingNo: undefined,
        createdAt: earliestCreatedAt ?? base.createdAt,
        currentStatus: status,
        weightKg: sum((r) => r.weightKg),
        volumeM3: sum((r) => r.volumeM3),
        packageCount: sum((r) => r.packageCount),
        memberIds: rows.map((r) => r.id),
      });
    }
    return tickets;
  }

  /**
   * 一票货的重量/体积取值，跟运单列表**同一个口径**
   * （`shipments/total-metrics.ts` 的 `resolveOrderTotalMetric`）：
   * **订单合计优先，缺失时才合计这张订单的父子运单家族，整组都没有就是「不知道」。**
   *
   * ⚠️ 原来 AI 是无条件把父单和子单的重量体积**相加**。现在分柜时父单会被扣减
   * （`shipments/routes.ts` 那段 `volumeAllocation.remaining`），所以新数据相加是对的；
   * 但**历史上分柜的父单还挂着整票的量**，相加就会重复计算。
   * 2026-08-28 复核只读核对测试库：8 个家族里重量虚增 746.87 kg、体积虚增 0.583 m³，
   * 24 个有运单的客户里已经有 3 个会被报大。
   * 改用订单合计打头之后，历史数据也不会算错。
   *
   * ⚠️ **整组都没填时返回 undefined，绝不合计成 0** —— 老板的规矩：空值不显示 0。
   */
  private buildOrderTotals(
    orders: Array<{ id: string; weightKg?: number; volumeM3?: number }>,
    shipments: Shipment[],
  ): Map<string, { weightKg?: number; volumeM3?: number }> {
    const family = new Map<string, { weights: number[]; volumes: number[] }>();
    for (const row of shipments) {
      if (!row.orderId) continue;
      const bucket = family.get(row.orderId) ?? { weights: [], volumes: [] };
      if (typeof row.weightKg === "number") bucket.weights.push(row.weightKg);
      if (typeof row.volumeM3 === "number") bucket.volumes.push(row.volumeM3);
      family.set(row.orderId, bucket);
    }
    const sumPresent = (values: number[]): number | undefined =>
      values.length === 0 ? undefined : values.reduce((acc, value) => acc + value, 0);

    const totals = new Map<string, { weightKg?: number; volumeM3?: number }>();
    for (const order of orders) {
      const bucket = family.get(order.id);
      totals.set(order.id, {
        weightKg: order.weightKg ?? sumPresent(bucket?.weights ?? []),
        volumeM3: order.volumeM3 ?? sumPresent(bucket?.volumes ?? []),
      });
    }
    return totals;
  }

  private buildCompanySummary(
    tickets: Shipment[],
    orderTotals: Map<string, { weightKg?: number; volumeM3?: number }>,
  ): {
    totalCount: number;
    inTransitCount: number;
    completedCount: number;
    /** 整组都没填时是 undefined，不是 0 */
    totalWeightKg?: number;
    totalVolumeM3?: number;
    /** 没填重量/体积、因而没计入合计的票数，要如实告诉客户 */
    weightUnknownCount: number;
    volumeUnknownCount: number;
  } {
    let totalCount = 0;
    let inTransitCount = 0;
    let completedCount = 0;
    let weightSum: number | undefined;
    let volumeSum: number | undefined;
    let weightUnknownCount = 0;
    let volumeUnknownCount = 0;
    // 同一张订单只计一次量（正常一张订单一票货，这里防的是异常数据）
    const countedOrderIds = new Set<string>();

    for (const ticket of tickets) {
      totalCount += 1;
      // 2026-09-03：同上，排除法口径，跟顶部数字/分组按钮一致
      if (isInTransitStatus(ticket.currentStatus)) inTransitCount += 1;
      if (COMPLETED_STATUSES.includes(ticket.currentStatus)) completedCount += 1;

      const orderId = ticket.orderId;
      if (!orderId || countedOrderIds.has(orderId)) continue;
      countedOrderIds.add(orderId);
      const total = orderTotals.get(orderId);
      if (typeof total?.weightKg === "number") weightSum = (weightSum ?? 0) + total.weightKg;
      else weightUnknownCount += 1;
      if (typeof total?.volumeM3 === "number") volumeSum = (volumeSum ?? 0) + total.volumeM3;
      else volumeUnknownCount += 1;
    }

    return {
      totalCount,
      inTransitCount,
      completedCount,
      totalWeightKg: weightSum,
      totalVolumeM3: volumeSum,
      weightUnknownCount,
      volumeUnknownCount,
    };
  }


  private async refineAnswerWithModel(
    question: string,
    llmContext: string,
    fallbackAnswer: string,
    masked: { text: string; values: string[]; sample: string },
  ): Promise<string> {
    try {
      const refined = await this.deps.llmClient.summarizeWithContext({
        question: [
          '请严格使用"业务客服模板"风格输出，保持字段齐全。仅输出最终中文答复正文，不要返回JSON、不要返回代码块、不要解释过程。',
          `⚠️ 文中形如 ${masked.sample} 的记号是占位符，代表系统算好的数据。`,
          "必须原样保留每一个占位符：一个不能少、不能多、不能重复、不能改写、**顺序也不能变**。",
          "你只能调整占位符之间的措辞，**不许自己写出任何数字**（阿拉伯数字和中文数字都不行）。",
          `用户问题：${question}`,
        ].join("\n"),
        context: llmContext,
      });
      if (!refined?.trim()) return fallbackAnswer;
      const polishedMasked = this.normalizeModelAnswer(refined, masked.text);
      return this.unmaskNumbers(polishedMasked, masked, fallbackAnswer, question);
    } catch {
      // Model failure should not block core business answer.
      return fallbackAnswer;
    }
  }

  /**
   * 把草稿里每一处「数字（含单位）」换成占位符 ⟦N1⟧ ⟦N2⟧…，让模型**从头到尾看不到真实数字**。
   *
   * 为什么不再用「比对数字」的思路（2026-08-28 复核后重做）：
   * 旧的 enforceDraftNumbers 拿数字集合比，天生看不出**顺序和归属**，实测这些全被放行 ——
   *   · 总量 3 单 ↔ 在途 2 单 互换（集合一模一样）
   *   · 已完成 7 改成别处出现过的 3
   *   · 3 单 写成「三单」、写成 −3 单（Unicode 负号）
   *   · 去掉单位之后再交换
   * 只要模型还能碰到数字，就永远有下一种绕法。占位符方案从根上断掉这条路。
   *
   * 连单位一起吃掉是有意的：`746.87 千克` 整体变一个占位符，模型没法把数字和单位拆开重组。
   * 时间 `11:28` 一并覆盖。
   */
  /**
   * 把草稿里的数据换成占位符，让模型从头到尾看不到真实数字。
   *
   * ⚠️ **名称必须和数字焊在同一个占位符里。**
   * 2026-08-28 生产实测：客户一共 3 单，AI 答「已完成 3 单、总单量 1 单」。
   * 模型**一个占位符都没动**，只把「总单量：」「已完成：」这两个**文字标签**调换了位置 ——
   * 回填时的五道检查（各出现一次 / 编号合法 / 顺序一致 / 外面没数字 / 外面没中文数量词）
   * 全都只盯占位符本身，没有一道管「这个数挂在哪个名称底下」，于是五道全过。
   *
   * 所以统计明细那种「名称：数字+单位」的行，**连名称一起**遮成一个占位符。
   * 模型看到的是光秃秃的 ⟦N2⟧⟦N3⟧⟦N4⟧，想换名称也无从下手；
   * 想调换行的顺序，又会被「顺序一致」那道拦下。
   * 代价是统计明细那几行模型改不动了 —— 那本来就是数据表，不是需要润色的人话。
   */
  private maskNumbers(draft: string): { text: string; values: string[]; sample: string } {
    const values: string[] = [];
    const NUM_UNIT = String.raw`-?\d+(?:\.\d+)?\s*(?:千克|公斤|kg|KG|Kg|立方米|立方|方|m³|M³|单|票|张|件|箱|%)`;
    /**
     * 一趟扫完，按**文档顺序**编号 —— 分两趟扫会让编号和出现顺序对不上，
     * 「顺序一致」那道检查会把每一次润色都误判成违规。
     * 顺序要紧：先吃「名称：数字+单位」（连名称一起），再吃「数字+单位」，
     * 再吃时间，最后才是裸数字。
     */
    const re = new RegExp(
      String.raw`(?<=^|\n)[^\n：:]{1,16}[：:]\s*${NUM_UNIT}` +
        String.raw`|${NUM_UNIT}` +
        String.raw`|\d{1,2}:\d{2}(?::\d{2})?` +
        String.raw`|-?\d+(?:\.\d+)?`,
      "g",
    );
    const text = draft.replace(re, (whole) => {
      values.push(whole);
      return `⟦N${values.length}⟧`;
    });
    return { text, values, sample: values.length > 0 ? "⟦N1⟧" : "⟦N⟧" };
  }

  /**
   * 把占位符换回真实数字。任何一点对不上就整段作废、发原始草稿。
   */
  private unmaskNumbers(
    polishedMasked: string,
    masked: { text: string; values: string[] },
    draft: string,
    question: string,
  ): string {
    const bail = (why: string) => {
      logger.warn("[ai] 润色稿动了数据占位符，已丢弃、改发原始答案", {
        question: question.slice(0, 100),
        原因: why,
      });
      return draft;
    };

    for (let i = 1; i <= masked.values.length; i += 1) {
      const hits = polishedMasked.split(`⟦N${i}⟧`).length - 1;
      if (hits !== 1) return bail(`占位符 ⟦N${i}⟧ 出现了 ${hits} 次，应该正好 1 次`);
    }
    const order = Array.from(polishedMasked.matchAll(/⟦N(\d+)⟧/g)).map((m) => Number(m[1]));
    const unknown = order.filter((n) => n < 1 || n > masked.values.length);
    if (unknown.length > 0) return bail(`出现了不存在的占位符编号：${unknown.join(",")}`);

    /**
     * ⚠️ 顺序也必须一致。只查「各出现一次」不够：把 ⟦N1⟧ 和 ⟦N2⟧ 对调，
     * 两边计数都还是 1，但回填之后「总单量」就拿到了「在途中」的数 ——
     * 正是旧版被互换绕过的那个坑，换成占位符之后不查顺序照样绕得过。
     */
    const expected = masked.values.map((_v, i) => i + 1).join(",");
    if (order.join(",") !== expected) {
      return bail(`占位符顺序被改了（期望 ${expected}，实际 ${order.join(",")}）`);
    }

    /**
     * ⚠️⚠️ **带数据的那一行，一个字都不许改。**
     *
     * 2026-08-28 复核实测的第二种改义（第一种是调换「总单量：」「已完成：」标签）：
     * 模型**一个占位符都没动**，只把普通句子
     *   「你当前一共查到 ⟦N1⟧。」 改成 「你当前已完成 ⟦N1⟧。」
     * 回填之后客户看到「你当前已完成 3 单」——**实际只完成 1 单**。
     *
     * 上一版只把「标签：数字」那种整行焊进占位符，句子里的说明文字管不到。
     * 光靠列举「哪些词不许改」是堵不完的（一共/已完成/在途/共计/总共…），
     * 所以这里换成白名单思路：**含占位符的行必须和草稿逐字一致**。
     * 模型要润色，只能在**不含数据的行**上加话（打招呼、结尾寒暄），
     * 那正是润色该干的事。改到了数据那句话，整段退回原始草稿。
     *
     * 只忽略行首尾空白 —— 空白不改变意思，模型爱加空格。
     */
    const dataLinesOf = (text: string): string[] =>
      text.split("\n").map((line) => line.trim()).filter((line) => line.includes("⟦N"));
    const draftDataLines = dataLinesOf(masked.text);
    const polishedDataLines = dataLinesOf(polishedMasked);
    if (draftDataLines.length !== polishedDataLines.length) {
      return bail(
        `带数据的行数对不上（草稿 ${draftDataLines.length} 行，润色稿 ${polishedDataLines.length} 行）`,
      );
    }
    for (let i = 0; i < draftDataLines.length; i += 1) {
      if (draftDataLines[i] !== polishedDataLines[i]) {
        return bail(
          `带数据的那句话被改写了：草稿「${draftDataLines[i]}」→ 润色稿「${polishedDataLines[i]}」`,
        );
      }
    }

    const withoutPlaceholders = polishedMasked.replace(/⟦N\d+⟧/g, "");
    if (/\d/.test(this.normalizeDigits(withoutPlaceholders))) {
      return bail("模型在占位符之外自己写了数字");
    }
    /**
     * 中文数字也要拦，但**只拦「像个数量」的写法** —— 后面跟着单位（三单、五千克），
     * 或者前面有「共 / 计 / 约」。不能见「一」「十」就拦：
     * 「一共」「十分」这些正常措辞里全是它们，一刀切会让润色几乎每次被退回，等于白做。
     */
    const CN = "[〇零一二两三四五六七八九十百千万]";
    const cnQuantity = new RegExp(
      `(?:${CN}+\\s*(?:单|票|张|件|箱|千克|公斤|立方米|立方|方)|(?:共|计|约)\\s*${CN}+)`,
    );
    if (cnQuantity.test(withoutPlaceholders)) {
      return bail("模型在占位符之外写了中文数量词");
    }

    return polishedMasked.replace(/⟦N(\d+)⟧/g, (_m, n) => masked.values[Number(n) - 1] ?? "");
  }

  /** 全角数字转半角、去掉千位分隔符，好让两边用同一个写法比对 */
  private normalizeDigits(text: string): string {
    let normalized = text
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/．/g, ".");
    let previous = "";
    while (previous !== normalized) {
      previous = normalized;
      normalized = normalized.replace(/(\d)[,，](\d{3})(?!\d)/g, "$1$2");
    }
    return normalized;
  }

  private normalizeModelAnswer(rawAnswer: string, fallbackAnswer: string): string {
    const text = rawAnswer.trim();
    if (!text) return fallbackAnswer;

    // Sanitize HTML/script injection from model output
    const sanitize = (s: string) => s
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<img[^>]*onerror\s*=[^>]*>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/javascript\s*:/gi, "");

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

    return sanitize(content);
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
      `最近更新时间：${this.formatBeijingTime(shipment.updatedAt)}`,
      "",
      "【建议操作】",
      shipment.currentStatus === "delivered"
        ? "该运单已签收，建议核对收货数量并归档。"
        : "该运单仍在运输流程中，建议稍后再次查询最新节点。",
    ].join("\n");
  }

  /**
   * ISO 时间戳（UTC）显示成北京时间的「YYYY-MM-DD HH:mm」。
   * 原来把 `2026-08-28T03:28:00.000Z` 原样发给客户：那是 UTC，
   * 客户按北京时间看会觉得少了 8 小时，而且这串格式本身也没人看得懂。而且模型润色时多半会把它改写成「8月28日 11:28」，
   * 那个 11 草稿里没有，会被 enforceDraftNumbers 判成改了数字、整段退回草稿。
   * 在草稿这一步就换成北京时间，两个问题一起解决。
   */
  private formatBeijingTime(iso?: string): string {
    if (!iso) return "暂无";
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    const beijing = new Date(ts + CHINA_OFFSET_MS);
    const pad = (value: number) => String(value).padStart(2, "0");
    return [
      `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`,
      `${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}`,
    ].join(" ");
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
      /** 整组都没填时是 undefined —— 这时候一个字都不写，绝不打成 0（老板的规矩） */
      totalWeightKg?: number;
      totalVolumeM3?: number;
      weightUnknownCount: number;
      volumeUnknownCount: number;
    },
    scope: {
      timeLabel: string;
      statusLabel: string;
      productLabel: string;
      metric: SummaryMetric;
      /**
       * 要不要打「在途中 / 已完成」这两行分项。
       *
       * ⚠️ summary 是拿**已经按状态筛过**的结果统计的。客户问「我在途有多少单」，
       * 明细里原来会打出「总单量：3 单 / 在途中：3 单 / 已完成：0 单」——
       * 那个 0 不是他真的一单都没完成，只是被筛掉了。
       * 这段文字还会原样交给模型润色，模型很容易顺口写成「您已完成 0 单」。
       * 所以只有「全部运单」这一种范围才打分项，其他一律只报「符合条件多少单」。
       */
      showStatusBreakdown: boolean;
      /** 按品名查、且命中的单里夹着别的货时的一句说明；没有就不打这一行 */
      productNote?: string;
    },
  ): string {
    const focusHintBase =
      scope.statusLabel === "未完成运单"
        ? `你当前还有 ${summary.totalCount} 单未完成，正在运输中的有 ${summary.inTransitCount} 单。`
        : scope.statusLabel === "在途运单"
          ? `你当前在途运输中的有 ${summary.inTransitCount} 单。`
          : scope.statusLabel === "已完成运单"
            ? `你当前已完成的有 ${summary.completedCount} 单。`
            : `你当前一共查到 ${summary.totalCount} 单。`;
    /**
     * ⚠️ 重量/体积**没填就不写**，不能打成 0 —— 打成 0 客户会以为货没重量。
     * 有一部分没填时，如实说清楚有几单没计入。
     */
    const weightText =
      typeof summary.totalWeightKg === "number"
        ? `${summary.totalWeightKg.toFixed(2)} 千克`
        : undefined;
    const volumeText =
      typeof summary.totalVolumeM3 === "number"
        ? `${summary.totalVolumeM3.toFixed(3)} 立方米`
        : undefined;
    const metricHint =
      scope.metric === "volume"
        ? volumeText
          ? `体积合计大约 ${volumeText}。`
          : "这些单还没有体积数据。"
        : scope.metric === "weight"
          ? weightText
            ? `重量合计大约 ${weightText}。`
            : "这些单还没有重量数据。"
          : "";
    const focusHint = metricHint ? `${focusHintBase}${metricHint}` : focusHintBase;
    const missingNote = (unknownCount: number) =>
      unknownCount > 0 ? `（另有 ${unknownCount} 单没有数据，未计入）` : "";
    return [
      "【查询结果】",
      focusHint,
      "",
      "【统计明细】",
      `查询范围：${scope.timeLabel}，${scope.statusLabel}，${scope.productLabel}`,
      ...(scope.productNote ? [scope.productNote] : []),
      ...(scope.showStatusBreakdown
        ? [
            `总单量：${summary.totalCount} 单`,
            `在途中：${summary.inTransitCount} 单`,
            `已完成：${summary.completedCount} 单`,
          ]
        : [`符合条件：${summary.totalCount} 单`]),
      ...(weightText ? [`总重量约：${weightText}${missingNote(summary.weightUnknownCount)}`] : []),
      ...(volumeText ? [`总体积约：${volumeText}${missingNote(summary.volumeUnknownCount)}`] : []),
    ].join("\n");
  }

  private shouldAskClarification(
    question: string,
    modelIntent: ModelIntent,
    trackingNo?: string,
  ): boolean {
    if (this.isGreetingMessage(question)) return false;
    if (trackingNo) return false;
    if (this.extractTrackingNo(question)) return false;
    if (this.isSummaryIntent(question)) return false;
    if (this.isServiceQaIntent(question)) return false;
    /**
     * ⚠️ 模型的 intent 只能**补**规则认不出的那一档，不能凭空造出一条路。
     * 原来 `"tracking"` 也在这个白名单里：模型嘴上说「客户在查单号」、`trackingNo` 却是空的，
     * 系统于是既不反问、也进不了统计分支（统计分支只认 summary/unknown），
     * 直接掉进最后那个兜底分支，把这个客户**名下全部运单**的总数报了出去 ——
     * 2026-08-28 复核实测：问「我的货呢」，模型返回 tracking + 空单号，答复是「一共 3 单」。
     * 单号真拿得到的话，上面那道 `trackingNo` 判断已经先返回 false 了。
     */
    if (modelIntent.intent === "summary" || modelIntent.intent === "greeting") {
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
    /**
     * ⚠️ 判断依据是「这一轮**管不管**这个字段」，不是「这一轮的值是不是空」。
     *
     * 原来写的是 `新值 ?? 旧值`：这一轮已经不按品名查了（`itemName` 是空），
     * 旧的「耳机」照样被留下来，客户再说一句「那本月呢」就又变回耳机。
     * 2026-08-28 复核实测（耳机 2 单 / 别的货 3 单，本月共 3 单）：
     *   轮1「耳机有多少单」→ 2 单；轮2「我一共有多少单」→ 5 单（品名已经清掉了）；
     *   轮3「那本月呢」→ 却回「本月 耳机 1 单」。
     *
     * 用 `in` 判断键在不在：统计分支每轮都会把五个字段**全部**写进来（空也写），
     * 于是「这轮没有品名」能真的把品名清掉；查单分支只写 `intent`，
     * 其余字段不归它管，照旧保留。
     */
    const next: SessionMemory = {
      intent: "intent" in patch ? patch.intent : prev?.intent,
      itemName: "itemName" in patch ? patch.itemName : prev?.itemName,
      statusScope: "statusScope" in patch ? patch.statusScope : prev?.statusScope,
      timeHint: "timeHint" in patch ? patch.timeHint : prev?.timeHint,
      metric: "metric" in patch ? patch.metric : prev?.metric,
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

  /**
   * 「查不到」时提示相近品名。
   * 这里**故意保留双向包含**（含空品名过滤）：它只是给客户几个候选让他自己确认，
   * 不参与任何数字统计，宽一点更有用。
   */
  private suggestItemNames(keyword: string, orders: ProductNameSource[]): string[] {
    const needle = keyword.trim().toLowerCase();
    const names = Array.from(new Set(orders.flatMap((item) => this.orderItemNames(item))));
    return names
      .filter((name) => {
        const lower = name.toLowerCase();
        return lower.includes(needle) || needle.includes(lower);
      })
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

  /** 用来区分「这个品名一张单都没有」和「有，但不在当前时间/状态范围里」，口径跟统计一致 */
  private countOrdersByProduct(keyword: string, orders: ProductNameSource[]): number {
    return orders.filter((item) => this.matchesProductKeyword(item, keyword)).length;
  }
}
