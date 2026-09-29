/**
 * AI 客服答复的「数字对不对」自测（不连数据库、不连 DeepSeek）。
 *
 * 覆盖 2026-08-28 一起修的三条 —— 少修任何一条，客户看到的数字都还是错的：
 *   1. 模型润色时改了数字，没人核对         → ai-service.ts refineAnswerWithModel/enforceDraftNumbers
 *   2. 「今天/本月」按服务器时区（UTC）算，比北京时间早 8 小时 → resolveTimeWindow
 *   3. 时间筛选用 updatedAt（最后更新）而不是 createdAt（下单） → inTimeWindow
 *
 * ⚠️ 必须在 **两个时区**下各跑一遍（见 package.json 的 test:ai-numbers）：
 *   生产容器是 UTC，开发机在中国是 UTC+8。第 2 条的 bug 只在 UTC 下暴露 ——
 *   这正是「本地测没问题、线上数字不对」反复发生的原因。
 */
import assert from "node:assert/strict";
import { ClientAiService } from "../apps/api/src/modules/ai/ai-service";
import type {
  AiKnowledgeGapRecord,
  AiOrder,
  AiSessionMemoryRecord,
  AuthContext,
  QueryScope,
} from "../apps/api/src/modules/ai/ai-types";
import type {
  AiKnowledgeItem,
  AiQueryAuditLog,
  Shipment,
  StatusLabelConfig,
} from "../packages/shared-types/entities";
import type { ShipmentStatus } from "../packages/shared-types/shipment-status";

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const TZ_LABEL = process.env.TZ ?? "(系统默认)";

const AUTH: AuthContext = { userId: "u_client_1", companyId: "c_1", role: "client" };

/**
 * ⚠️ 模型桩必须**真的改到草稿**，否则测试就是假绿。
 *
 * 2026-08-28 复核抓到的教训：第 1、4 项原来写死替换「总单量：N 单」，
 * 后来「在途」范围的答复改成打「符合条件：N 单」，正则不再匹配 →
 * 桩返回的就是原文 → `enforceDraftNumbers` 第一行 `polished === draft` 直接返回 →
 * 两项测试一路绿灯，**其实一次都没验到数字校验**。
 * 现在只要正则没匹配上就当场断言失败，答复格式再变也瞒不过去。
 */
/**
 * 把草稿里第 a、b 个「数据记号」对调。
 *
 * ⚠️ 这个辅助要能同时对付两种草稿：改造前桩收到的是**真数字**（`10 单`），
 * 改造后收到的是**占位符**（`⟦N1⟧`）。写死其中一种，另一种会因为匹配不到而
 * 「测试假失败」——看起来像 bug，其实是桩没写对。
 */
const TOKEN_RE = /⟦N\d+⟧|-?\d+(?:\.\d+)?\s*(?:千克|公斤|kg|立方米|立方|方|m³|单|票|张|件|箱)|\d{1,2}:\d{2}/g;
function swapTokens(a: number, b: number) {
  return (draft: string): string => {
    const hits = draft.match(TOKEN_RE) ?? [];
    assert.ok(hits.length > Math.max(a, b), `草稿里数据记号不够（只有 ${hits.length} 个）：\n${draft}`);
    let i = -1;
    return draft.replace(TOKEN_RE, (m) => {
      i += 1;
      if (i === a) return hits[b]!;
      if (i === b) return hits[a]!;
      return m;
    });
  };
}
/** 把第 n 个数据记号替换成 replacement（真数字/占位符两种草稿都适用） */
function replaceToken(n: number, replacement: string) {
  return (draft: string): string => {
    const hits = draft.match(TOKEN_RE) ?? [];
    assert.ok(hits.length > n, `草稿里数据记号不够（只有 ${hits.length} 个）：\n${draft}`);
    let i = -1;
    return draft.replace(TOKEN_RE, (m) => {
      i += 1;
      return i === n ? replacement : m;
    });
  };
}

function rewriteDraft(...edits: Array<[RegExp, string]>) {
  return (draft: string): string => {
    let next = draft;
    for (const [pattern, replacement] of edits) {
      const applied = next.replace(pattern, replacement);
      assert.notEqual(applied, next, `测试桩没改到草稿（${pattern} 没匹配上）：\n${draft}`);
      next = applied;
    }
    return next;
  };
}

/** 单量那一行：「全部运单」打「总单量」，按状态筛过打「符合条件」 */
const COUNT_LINE = /(总单量|符合条件)：\d+ 单/;

/** 北京当天零点对应的真实时刻（UTC 毫秒） */
function beijingMidnightMs(dayDelta = 0): number {
  const beijing = new Date(Date.now() + CHINA_OFFSET_MS);
  beijing.setUTCHours(0, 0, 0, 0);
  beijing.setUTCDate(beijing.getUTCDate() + dayDelta);
  return beijing.getTime() - CHINA_OFFSET_MS;
}

/** 北京「本月 1 号」零点对应的真实时刻 */
function beijingMonthStartMs(): number {
  const beijing = new Date(Date.now() + CHINA_OFFSET_MS);
  return Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), 1) - CHINA_OFFSET_MS;
}

function shipment(input: {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  status?: ShipmentStatus;
  /** 不传 = 这一单**没填**重量/体积（不是 0）—— 空值不能显示成 0 */
  weightKg?: number;
  volumeM3?: number;
  orderId?: string;
  trackingNo?: string;
  parentTrackingNo?: string;
}): Shipment {
  return {
    id: input.id,
    companyId: AUTH.companyId,
    orderId: input.orderId ?? `o_${input.id}`,
    trackingNo: input.trackingNo ?? `TH${input.id.toUpperCase()}`,
    ...(input.parentTrackingNo ? { parentTrackingNo: input.parentTrackingNo } : {}),
    currentStatus: input.status ?? "loaded",
    ...(input.weightKg === undefined ? {} : { weightKg: input.weightKg }),
    ...(input.volumeM3 === undefined ? {} : { volumeM3: input.volumeM3 }),
    packageCount: 1,
    transportMode: "sea",
    createdAt: new Date(input.createdAtMs).toISOString(),
    updatedAt: new Date(input.updatedAtMs).toISOString(),
  } as Shipment;
}

/**
 * 品名可以按运单 id 单独指定。
 * `itemName` 是订单上那个「第一个货品」，`productNames` 是全部货品行 ——
 * 这两者不一致正是「耳机排第二个查不到」那个 bug 的现场。
 */
const orderNames = new Map<string, { itemName: string; productNames: string[] }>();
/** 订单级的整票重量/体积；设了它就以它为准（跟运单列表同口径） */
const orderTotals = new Map<string, { weightKg?: number; volumeM3?: number }>();

function order(id: string): AiOrder {
  const named = orderNames.get(id);
  const totals = orderTotals.get(id);
  return {
    id: `o_${id}`,
    ...(totals?.weightKg === undefined ? {} : { weightKg: totals.weightKg }),
    ...(totals?.volumeM3 === undefined ? {} : { volumeM3: totals.volumeM3 }),
    companyId: AUTH.companyId,
    clientId: AUTH.userId,
    pickupAddressCn: "",
    deliveryAddressTh: "",
    receiverName: "",
    receiverPhone: "",
    serviceType: "standard",
    itemName: named?.itemName ?? "测试品名",
    productNames: named?.productNames ?? [named?.itemName ?? "测试品名"],
    productQuantity: 1,
    packageCount: 1,
  } as AiOrder;
}

/** 模型桩：意图解析那次一律返回空（走规则解析），润色那次交给测试自己决定 */
function buildService(input: {
  shipments: Shipment[];
  polish: (draft: string) => string;
  /** 意图解析那次调用返回什么（默认返回空串，让它退回规则解析） */
  intent?: string;
  /** 记下每次发给模型的上下文，用来验证有没有塞没用的东西进去 */
  contexts?: string[];
}) {
  const memoryRows = new Map<string, AiSessionMemoryRecord>();
  const audits: AiQueryAuditLog[] = [];
  return {
    audits,
    service: new ClientAiService({
      dataSource: {
        async listOrders(_scope: QueryScope): Promise<AiOrder[]> {
          // 一张订单可能挂着父单 + 多个子单，这里按 orderId 去重
          const seen = new Set<string>();
          const result: AiOrder[] = [];
          for (const item of input.shipments) {
            const key = item.orderId.replace(/^o_/, "");
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(order(key));
          }
          return result;
        },
        async listShipments(_scope: QueryScope): Promise<Shipment[]> {
          return input.shipments;
        },
      },
      auditStore: {
        async add(log: AiQueryAuditLog) {
          audits.push(log);
        },
        async listByCompany() {
          return audits;
        },
      },
      knowledgeGapStore: {
        async add(_record: AiKnowledgeGapRecord) {},
        async listByCompany() {
          return [];
        },
        async resolve() {
          return true;
        },
      },
      llmClient: {
        async summarizeWithContext({ question, context }) {
          input.contexts?.push(context);
          if (question.includes("意图解析器")) return input.intent ?? "";
          const parsed = JSON.parse(context) as { answerDraft?: string };
          return input.polish(parsed.answerDraft ?? "");
        },
      },
      statusLabelStore: {
        async list(): Promise<StatusLabelConfig[]> {
          return [];
        },
        async getLabel() {
          return undefined;
        },
        async upsert() {},
        async resetDefaults() {},
      },
      knowledgeStore: {
        async list(): Promise<AiKnowledgeItem[]> {
          return [];
        },
        async add(item) {
          return { ...item, id: "k_1", createdAt: new Date().toISOString() } as AiKnowledgeItem;
        },
        async remove() {
          return true;
        },
      },
      memoryStore: {
        async get(key: string) {
          return memoryRows.get(key);
        },
        async set(record: AiSessionMemoryRecord) {
          memoryRows.set(record.key, record);
        },
        async cleanupOlderThan() {},
        async listByCompany() {
          return Array.from(memoryRows.values());
        },
        async removeByFilter() {
          return 0;
        },
      },
    }),
  };
}

async function ask(input: {
  shipments: Shipment[];
  message: string;
  polish?: (draft: string) => string;
  intent?: string;
}) {
  const contexts: string[] = [];
  const { service, audits } = buildService({
    shipments: input.shipments,
    polish: input.polish ?? (() => ""),
    intent: input.intent,
    contexts,
  });
  const response = await service.chat({
    auth: AUTH,
    body: { message: input.message, sessionId: `sess_test_${Math.random()}` },
  });
  return { answer: response.answer, audit: audits[0], contexts };
}

/**
 * 同一个会话里连着问几轮（追问记忆要靠它才测得到）。
 * ⚠️ `ask` 每次都新建一个 service、新的 sessionId，跨轮记忆一律是空的 ——
 * 用它测「上一轮记住了什么」永远是绿的（假绿）。这里共用同一个 service 和 sessionId。
 */
async function askSeries(input: { shipments: Shipment[]; messages: string[] }) {
  const { service } = buildService({ shipments: input.shipments, polish: () => "" });
  const sessionId = `sess_series_${Math.random()}`;
  const answers: string[] = [];
  for (const message of input.messages) {
    const response = await service.chat({ auth: AUTH, body: { message, sessionId } });
    answers.push(response.answer);
  }
  return answers;
}

/**
 * 「总单量」只在查询范围是「全部运单」时才打；
 * 按状态筛过之后打的是「符合条件」——因为那时候「已完成：0 单」是筛出来的假象，不能打。
 */
function totalCountOf(answer: string): number {
  const matched = answer.match(/(?:总单量|符合条件)：(\d+) 单/);
  assert.ok(matched, `答复里没有单量那一行：\n${answer}`);
  return Number(matched[1]);
}

const failures: string[] = [];
let totalChecks = 0;
async function check(name: string, body: () => Promise<void>): Promise<void> {
  totalChecks += 1;
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

async function main() {
  const nowMs = Date.now();
  console.log(`AI 答复数字校验（TZ=${TZ_LABEL}）`);

  // ── 1. 模型把算好的数字改了 → 必须整段退回原始草稿 ────────────────────────
  await check("1) 模型改了数字 → 整段退回原始草稿", async () => {
    const shipments = [
      shipment({ id: "a1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "a2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "a3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我在途有多少单",
      // 复刻生产事故：真实 367，模型答 726
      polish: rewriteDraft([COUNT_LINE, "$1：726 单"]),
    });
    assert.equal(totalCountOf(answer), 3, "模型改过的数字被发给客户了");
    assert.ok(!answer.includes("726"), "模型编的 726 出现在最终答复里");
  });

  // ── 2. 数字没被动 → 允许模型润色，不能一刀切退回草稿 ─────────────────────
  await check("2) 带数字的答复：根本不调模型，直接发系统写好的原话", async () => {
    /**
     * 用户 2026-08-28 拍板：统计类回答不再让 DeepSeek 润色。
     * 之前一直在跟模型斗智，最后一版实测两头不讨好 ——
     * 正常改措辞会被整段退回（润色等于没生效），
     * 而模型另起一句不带数字的假话（「以上订单均已完成。」）照样放行。
     * 现在草稿里只要有一个数据占位符就直接发原话，模型碰都碰不到。
     *
     * ⚠️ 这一项同时盯着**省钱**：这个接口是全系统唯一直接花钱的地方，
     * 统计类消息从此少调一次 DeepSeek。润色调用一旦被谁改回来，这里会红。
     */
    const shipments = [shipment({ id: "b1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer, contexts } = await ask({
      shipments,
      message: "我在途有多少单",
      // 这个桩要是被调用了，答复里就会出现「亲，帮你查好了」
      polish: (draft) => `亲，帮你查好了。\n${draft}\n有问题随时找我。`,
    });
    assert.ok(!answer.includes("亲，帮你查好了"), `带数字的答复还是被润色了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
    const polishCalls = contexts.filter((c) => c.includes("answerDraft"));
    assert.equal(polishCalls.length, 0, `带数字的答复不该调模型，实际调了 ${polishCalls.length} 次（白花钱）`);
  });

  // ── 3. 千位分隔符不算「改了数字」（1,234.56 和 1234.56 是同一个数）────────
  await check("3) 模型想给数字换个写法（加千位分隔符）→ 客户看到的仍是系统的原样", async () => {
    /**
     * ⚠️ 这一项的预期在 2026-08-28 变了，不是放宽而是收紧。
     * 旧契约：模型能看到 `1234.56`，把它写成 `1,234.56` 属于「没改数值」，放行。
     * 新契约（占位符方案）：模型看到的是 ⟦N⟧，**根本碰不到数字**。
     * 它若在占位符之外自己写出 `1,234.56`，那就是凭空造数 —— 必须退回原始草稿。
     * 客户最终看到的永远是系统格式化的那个数。
     */
    const shipments = [
      shipment({ id: "c1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, weightKg: 1234.56 }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我在途有多少单",
      polish: (draft) => `${draft}\n（合计约 1,234.56 千克）`,
    });
    assert.ok(!answer.includes("1,234.56"), `模型自己写的数字发给了客户：\n${answer}`);
    assert.ok(answer.includes("1234.56"), `系统算好的数字丢了：\n${answer}`);
  });

  // ── 4. 审计日志存的必须是最终发出去的那句（校验后的）──────────────────────
  await check("4) 审计日志存的是校验后的答复", async () => {
    const shipments = [shipment({ id: "d1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer, audit } = await ask({
      shipments,
      message: "我在途有多少单",
      polish: rewriteDraft([COUNT_LINE, "$1：999 单"]),
    });
    /**
     * ⚠️ 只写「不含 999」是假绿：把审计内容改成**空串**，这两条断言照样通过
     * （空串不含 999；`"".slice(0,20)` 是空串，任何字符串都 startsWith 空串）。
     * 2026-08-28 变异测试实测：`answerSummary: ""` 时 56 项一项都没挂。
     * 现在要求它**真的等于**发给客户那段话的前 200 字。
     */
    assert.ok(audit.answerSummary.length > 0, "审计日志里的答复是空的");
    assert.equal(audit.answerSummary, answer.slice(0, 200), "审计存的不是发给客户的那段话");
    assert.ok(audit.answerSummary.includes("符合条件：1 单"), "审计里没存校验后的真实数字");
    assert.ok(!audit.answerSummary.includes("999"), "审计日志里存了模型编的数字");
  });

  // ── 5.「今天」按北京时间：北京今天 0 点刚过下的单必须算今天 ────────────────
  //    ⚠️ 第 5、6 条必须成对存在，缺一条就抓不住 bug：
  //    旧代码的「今天」= 北京昨天 8 点 → 今天 8 点（整体偏了 8 小时）。
  //    北京时间 0-8 点跑测试时，第 5 条会侥幸通过、第 6 条挂；
  //    8 点之后跑则反过来。两条一起才保证任何时刻跑都能抓到。
  await check("5) 「今天」按北京时间：凌晨的单算今天", async () => {
    const justAfterBeijingMidnight = beijingMidnightMs(0) + 1000;
    assert.ok(justAfterBeijingMidnight <= nowMs, "跑测试的时刻正好卡在北京 0 点整，请稍后重试");
    const shipments = [
      shipment({ id: "e1", createdAtMs: justAfterBeijingMidnight, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "我今天发了多少单" });
    assert.equal(totalCountOf(answer), 1, `北京今天凌晨的单没算进「今天」（TZ=${TZ_LABEL}）`);
  });

  // ── 6.「今天」不能把北京昨天 23:59 的单算进来 ──────────────────────────────
  await check("6) 「今天」不含北京昨天深夜的单", async () => {
    const beforeBeijingMidnight = beijingMidnightMs(0) - 60_000;
    const shipments = [
      shipment({ id: "f1", createdAtMs: beforeBeijingMidnight, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "我今天发了多少单" });
    assert.equal(totalCountOf(answer), 0, `北京昨天深夜的单被算进了「今天」（TZ=${TZ_LABEL}）`);
  });

  // ── 7.「本月」按下单时间，不按最后更新时间 ────────────────────────────────
  //    半年前的老单这个月刚推进过状态 → 不算本月；本月 1 号凌晨下的单 → 算本月
  await check("7) 「本月」按下单时间，不按最后更新时间", async () => {
    const halfYearAgo = nowMs - 180 * 86400_000;
    const shipments = [
      shipment({ id: "g_old", createdAtMs: halfYearAgo, updatedAtMs: nowMs }),
      shipment({ id: "g_new", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs }),
    ];
    // 两种问法都要走统计分支：推荐问题里那句用的是「多少货」，
    // 但客户随口会说「多少单」——后者曾被当成品名查询（见 normalizeProductKeyword 的注释）
    for (const message of ["我这个月一共发了多少货？", "我这个月一共发了多少单"]) {
      const { answer } = await ask({ shipments, message });
      assert.equal(
        totalCountOf(answer),
        1,
        `「本月」口径不对（问法：${message}，TZ=${TZ_LABEL}）：\n${answer}`,
      );
    }
  });

  // ── 8. 分柜的父子单仍然只算一票（别让这轮改动碰坏 2026-08-25 的合并逻辑）──
  await check("8) 分柜父子单仍然只算一票", async () => {
    const created = nowMs - 86400_000;
    const parent = shipment({ id: "h_p", createdAtMs: created, updatedAtMs: nowMs });
    const child = {
      ...shipment({ id: "h_c", createdAtMs: nowMs - 3600_000, updatedAtMs: nowMs }),
      trackingNo: `${parent.trackingNo}-2`,
      parentTrackingNo: parent.trackingNo,
    } as Shipment;
    const { answer } = await ask({ shipments: [parent, child], message: "我在途有多少单" });
    assert.equal(totalCountOf(answer), 1, "父单+子单被数成了两票");
  });

  // ── 9. 系统自己推荐给客户的统计问题，必须都走统计、都带上正确的时间范围 ──────
  //    实测过的三种误判：整句被当成品名（「我这个月一共发了」「今日发了」「天异常件」）、
  //    以及「这个月」不认识导致一个时间筛选都不走、直接报开户至今的总数。
  await check("9) 推荐问题都能正确解析出时间范围", async () => {
    const shipments = [
      shipment({ id: "i1", createdAtMs: beijingMidnightMs(0) + 1000, updatedAtMs: nowMs }),
    ];
    const cases: Array<[string, string]> = [
      ["我这个月一共发了多少货？", "本月"],
      ["我这个月一共发了多少单", "本月"],
      ["我这个月发货总重量是多少？", "本月"],
      ["本月已完成订单有多少？", "本月"],
      ["最近 7 天在途订单有多少？", "最近7天"],
      ["最近 3 天异常件有多少？", "最近3天"],
      ["我今天发了多少单", "今天"],
      ["今日发了多少单", "今天"],
      ["昨天发了多少单", "昨天"],
      ["本周发了多少单", "本周"],
      ["这周发了多少单", "本周"],
    ];
    for (const [message, expectedLabel] of cases) {
      const { answer } = await ask({ shipments, message });
      assert.ok(
        !answer.includes("未查询到品名"),
        `「${message}」被当成品名查询了：\n${answer}`,
      );
      assert.ok(
        answer.includes(`查询范围：${expectedLabel}，`),
        `「${message}」的时间范围不是「${expectedLabel}」：\n${answer}`,
      );
    }
  });

  // ── 10. 品名统计：多品名订单、空品名、反向包含 ────────────────────────────
  await check("10) 品名排在第二个的货也能查到", async () => {
    orderNames.set("j1", { itemName: "手机壳", productNames: ["手机壳", "耳机"] });
    orderNames.set("j2", { itemName: "数据线", productNames: ["数据线"] });
    const shipments = [
      shipment({ id: "j1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "j2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "耳机订单有多少单？" });
    assert.ok(!answer.includes("未查询到品名"), `耳机那张单没查到：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
    assert.ok(
      answer.includes("其中 1 单同时还有别的品名"),
      `没有说明这单还夹着别的货：\n${answer}`,
    );
  });

  await check("11) 空品名的订单不会被算进任何品名的统计", async () => {
    // 下单接口对品名只做 trim、不校验非空，所以空品名进得来。
    // 旧写法 keyword.includes("") 恒为真 → 这张单会被算进每一个品名的查询。
    orderNames.set("k1", { itemName: "", productNames: [""] });
    orderNames.set("k2", { itemName: "耳机", productNames: ["耳机"] });
    const shipments = [
      shipment({ id: "k1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "k2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "耳机订单有多少单？" });
    assert.equal(totalCountOf(answer), 1, `空品名那张单被算进来了：\n${answer}`);
  });

  await check("12) 品名「壳」的单不会被算进「手机壳」的查询", async () => {
    orderNames.set("m1", { itemName: "壳", productNames: ["壳"] });
    const shipments = [shipment({ id: "m1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "手机壳订单有多少单？" });
    assert.ok(
      answer.includes("未查询到品名") || totalCountOf(answer) === 0,
      `「壳」被算进「手机壳」了：\n${answer}`,
    );
  });

  await check("13) 查不到时仍然提示相近品名（宽松匹配只用在提示上）", async () => {
    orderNames.set("n1", { itemName: "壳", productNames: ["壳"] });
    const shipments = [shipment({ id: "n1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "手机壳订单有多少单？" });
    /**
     * ⚠️ 只写 `includes("壳")` 是假绿：答复里回显的问句本身就有「手机壳」三个字，
     * 把整段相近品名建议删掉，这条断言照样通过。
     * 2026-08-28 变异测试实测：把建议改成永远走兜底文案时，56 项一项都没挂。
     * 现在盯**那一行建议本身**。
     */
    assert.ok(answer.includes("可尝试这些相近品名：壳。"), `没给出相近品名提示：\n${answer}`);
    assert.ok(
      !answer.includes("请确认品名是否与系统录入一致"),
      `明明有相近品名，却回了兜底文案：\n${answer}`,
    );
  });

  await check("14) 认品名时认最长的那个，一个字的品名不认", async () => {
    // 客户同时有「壳」和「手机壳」：问「手机壳」不能先撞上「壳」把两种货一起算进去。
    orderNames.set("p1", { itemName: "壳", productNames: ["壳"] });
    orderNames.set("p2", { itemName: "手机壳", productNames: ["手机壳"] });
    const shipments = [
      shipment({ id: "p1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "p2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "我的手机壳还有多少货没完成？" });
    assert.ok(answer.includes("品名：手机壳"), `没认成手机壳：\n${answer}`);
    assert.equal(totalCountOf(answer), 1, `把「壳」那张单也算进来了：\n${answer}`);
  });

  await check("15) 品名叫「货」的客户，问「这个月发了多少货」不会被当成品名查询", async () => {
    orderNames.set("q1", { itemName: "货", productNames: ["货"] });
    orderNames.set("q2", { itemName: "耳机", productNames: ["耳机"] });
    const shipments = [
      shipment({ id: "q1", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs }),
      shipment({ id: "q2", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "我这个月一共发了多少货？" });
    assert.ok(answer.includes("全部品类"), `被当成品名「货」查询了：\n${answer}`);
    assert.equal(totalCountOf(answer), 2);
  });

  // ── 16~19. 这一轮收尾的四条 ───────────────────────────────────────────────
  await check("16) 按状态筛之后不再打自相矛盾的「已完成：0 单」", async () => {
    const shipments = [
      shipment({ id: "r1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "r2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const filtered = await ask({ shipments, message: "我在途有多少单" });
    assert.ok(
      !filtered.answer.includes("已完成：0 单"),
      `还在打那个会让人误会的 0：\n${filtered.answer}`,
    );
    assert.equal(totalCountOf(filtered.answer), 2);
    // 「全部运单」时分项是真实的，必须照旧打出来
    const all = await ask({ shipments, message: "我一共有多少单" });
    assert.ok(all.answer.includes("在途中："), `全部范围下的分项被误删了：\n${all.answer}`);
    assert.ok(all.answer.includes("已完成："), `全部范围下的分项被误删了：\n${all.answer}`);
  });

  await check("17) 模型编一个单号，抢不走统计分支", async () => {
    const shipments = [
      shipment({ id: "s1", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我这个月一共发了多少货？",
      // 模型在 trackingNo 里瞎填一个问句里根本没有的单号
      intent: JSON.stringify({ intent: "tracking", trackingNo: "THCN9999" }),
    });
    assert.ok(!answer.includes("未找到运单号"), `被模型编的单号带偏了：\n${answer}`);
    assert.ok(answer.includes("查询范围："), `没走统计分支：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
  });

  await check("18) 客户写「TH-CN 0001」时，模型归一化出来的单号仍然采信", async () => {
    const target = shipment({ id: "t1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs });
    const { answer } = await ask({
      shipments: [{ ...target, trackingNo: "THCN0001" } as Shipment],
      message: "我的单号 TH-CN 0001 到哪了",
      intent: JSON.stringify({ intent: "tracking", trackingNo: "THCN0001" }),
    });
    assert.ok(answer.includes("THCN0001"), `没认出这个单号：\n${answer}`);
    assert.ok(!answer.includes("未找到运单号"), `认成查无此单了：\n${answer}`);
  });

  await check("19) 发给模型的上下文里不再塞整份运单 id 列表", async () => {
    const shipments = Array.from({ length: 50 }, (_, i) =>
      shipment({ id: `u${i}`, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    );
    const { contexts } = await ask({ shipments, message: "我一共有多少单" });
    assert.ok(contexts.length >= 1, "没抓到发给模型的上下文");
    for (const context of contexts) {
      assert.ok(!context.includes("evidenceShipmentIds"), `上下文里还有整份运单 id：\n${context}`);
      assert.ok(!context.includes("evidenceOrderIds"), `上下文里还有整份订单 id：\n${context}`);
      assert.ok(!context.includes("s_u49"), "上下文里出现了具体的运单 id");
    }
    const longest = Math.max(...contexts.map((c) => c.length));
    assert.ok(longest < 4000, `上下文还是太长了：${longest} 字符`);
  });

  await check("20) 「我一共有多少单」这类问法不会被当成品名", async () => {
    // 抓品名的正则会把「我一共有」整个抓进去。中文没有词边界，
    // 光靠黑名单堵不住，得把开头的人称/副词和结尾的动词剥掉。
    orderNames.set("v1", { itemName: "共享单车配件", productNames: ["共享单车配件"] });
    orderNames.set("v2", { itemName: "有机玻璃", productNames: ["有机玻璃"] });
    const shipments = [
      shipment({ id: "v1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "v2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    for (const message of ["我一共有多少单", "我一共发了多少单", "我总共有多少单"]) {
      const { answer } = await ask({ shipments, message });
      assert.ok(!answer.includes("未查询到品名"), `「${message}」被当成品名了：\n${answer}`);
      assert.equal(totalCountOf(answer), 2, `「${message}」算错了：\n${answer}`);
    }
    // 反过来：剥词不能把真品名剥坏（"共享…"不能剥成"享…"，"有机玻璃"不能剥掉"有"）
    for (const [message, expected] of [
      ["共享单车配件有多少单", "品名：共享单车配件"],
      ["有机玻璃有多少单", "品名：有机玻璃"],
      ["我的有机玻璃有多少单", "品名：有机玻璃"],
    ] as Array<[string, string]>) {
      const { answer } = await ask({ shipments, message });
      assert.ok(answer.includes(expected), `「${message}」认错品名：\n${answer}`);
    }
  });

  // ── 21~27. 2026-08-28 复核（Codex）报出来、我核实属实的几条 ────────────────
  await check("21) 数字调包：10 单 / 3 千克 被换成 3 单 / 10 千克 要拦住", async () => {
    // 只比「数字集合」的话这里两边一模一样 {10,3}，会放行 —— 必须连单位一起比
    const shipments = Array.from({ length: 10 }, (_, i) =>
      shipment({ id: `w${i}`, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, weightKg: 0.3 }),
    );
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      polish: rewriteDraft([/总单量：10 单/, "总单量：3 单"], [/3\.00 千克/, "10.00 千克"]),
    });
    assert.ok(answer.includes("总单量：10 单"), `数字被调包了还发出去：\n${answer}`);
    assert.ok(answer.includes("3.00 千克"), `重量被调包了还发出去：\n${answer}`);
  });

  await check("22) 单位调包：重量的数字挪到体积上要拦住", async () => {
    const shipments = [
      shipment({
        id: "x1",
        createdAtMs: nowMs - 86400_000,
        updatedAtMs: nowMs,
        weightKg: 5,
        volumeM3: 2,
      }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      polish: rewriteDraft([/5\.00 千克/, "5.00 立方米"]),
    });
    assert.ok(answer.includes("5.00 千克"), `重量被说成体积了还发出去：\n${answer}`);
  });

  await check("23) 正负号：3 单被写成 -3 单要拦住", async () => {
    const shipments = Array.from({ length: 3 }, (_, i) =>
      shipment({ id: `y${i}`, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    );
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      polish: rewriteDraft([/总单量：3 单/, "总单量：-3 单"]),
    });
    assert.ok(!answer.includes("-3 单"), `负号被放行了：\n${answer}`);
  });

  await check("24) 分柜子单号不再被截成父单号", async () => {
    const parent = shipment({
      id: "z_p",
      createdAtMs: nowMs - 86400_000,
      updatedAtMs: nowMs,
      trackingNo: "SZ260801388",
      status: "loaded",
    });
    const child = shipment({
      id: "z_c",
      createdAtMs: nowMs - 3600_000,
      updatedAtMs: nowMs,
      orderId: parent.orderId,
      trackingNo: "SZ260801388-2",
      parentTrackingNo: "SZ260801388",
      status: "arrivedPort",
    });
    const { answer } = await ask({
      shipments: [parent, child],
      message: "我的单号 SZ260801388-2 到哪了",
    });
    assert.ok(answer.includes("SZ260801388-2"), `子单号被截成父单号了：\n${answer}`);
    assert.ok(answer.includes("arrivedPort"), `回的是父单的状态：\n${answer}`);
  });

  await check("25) 模型返回的时间/状态盖不过问句里明确说的", async () => {
    const shipments = [
      shipment({
        id: "aa1",
        createdAtMs: beijingMonthStartMs() + 1000,
        updatedAtMs: nowMs,
        status: "loaded",
      }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我这个月在途有多少单",
      // 模型胡说成「今天、已完成」
      intent: JSON.stringify({ intent: "summary", timeHint: "今天", statusScope: "completed" }),
    });
    assert.ok(answer.includes("查询范围：本月，在途运单"), `被模型带偏了：\n${answer}`);
  });

  await check("26) 模型返回的品名盖不过问句里明确说的", async () => {
    orderNames.set("bb1", { itemName: "耳机", productNames: ["耳机"] });
    orderNames.set("bb2", { itemName: "手机壳", productNames: ["手机壳"] });
    const shipments = [
      shipment({ id: "bb1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "bb2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({
      shipments,
      message: "耳机订单有多少单？",
      intent: JSON.stringify({ intent: "summary", itemName: "手机壳" }),
    });
    assert.ok(answer.includes("品名：耳机"), `被模型换成手机壳了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
  });

  await check("27) 剥词不碰模型返回的真实品名", async () => {
    // 品名真的就叫「我的美妆」，剥词会把它剥成「美妆」→ 统计范围就错了
    orderNames.set("cc1", { itemName: "我的美妆", productNames: ["我的美妆"] });
    orderNames.set("cc2", { itemName: "美妆刷", productNames: ["美妆刷"] });
    const shipments = [
      shipment({ id: "cc1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "cc2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({
      shipments,
      message: "帮我看看这个品类",
      intent: JSON.stringify({ intent: "summary", itemName: "我的美妆" }),
    });
    assert.ok(answer.includes("品名：我的美妆"), `品名被剥坏了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1, `剥成「美妆」后把美妆刷也算进来了：\n${answer}`);
  });

  await check("28) 历史分柜父单挂着整票量时不重复统计", async () => {
    // 老数据：父单没被扣减，父子加起来是整票的两倍。订单合计才是真的。
    orderTotals.set("dd", { weightKg: 100, volumeM3: 1 });
    const parent = shipment({
      id: "dd_p",
      createdAtMs: nowMs - 86400_000,
      updatedAtMs: nowMs,
      orderId: "o_dd",
      trackingNo: "THDD",
      weightKg: 100,
      volumeM3: 1,
    });
    const child = shipment({
      id: "dd_c",
      createdAtMs: nowMs - 3600_000,
      updatedAtMs: nowMs,
      orderId: "o_dd",
      trackingNo: "THDD-2",
      parentTrackingNo: "THDD",
      weightKg: 100,
      volumeM3: 1,
    });
    const { answer } = await ask({ shipments: [parent, child], message: "我一共有多少单" });
    assert.ok(answer.includes("100.00 千克"), `重量被重复统计了：\n${answer}`);
    assert.ok(!answer.includes("200.00"), `重量被重复统计了：\n${answer}`);
    /**
     * ⚠️ 只验重量是假绿：**体积**走的是另一条累加语句，把它改成加两倍
     * （1.000 → 2.000），上面两条断言照样通过。
     * 2026-08-28 变异测试实测：体积翻倍时 56 项一项都没挂。
     */
    assert.ok(answer.includes("1.000 立方米"), `体积被重复统计了：\n${answer}`);
    assert.ok(!answer.includes("2.000"), `体积被重复统计了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1, `父子单被当成两票货：\n${answer}`);
  });

  await check("29) 没填重量体积时不显示 0.00，而是压根不打这一行", async () => {
    const shipments = [
      shipment({ id: "ee1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "我一共有多少单" });
    assert.ok(!answer.includes("0.00 千克"), `空值被显示成 0 了：\n${answer}`);
    assert.ok(!answer.includes("0.000 立方米"), `空值被显示成 0 了：\n${answer}`);
    assert.ok(!answer.includes("总重量约"), `没数据还打了重量行：\n${answer}`);
    /**
     * ⚠️ 少了这一条就是假绿：上面只禁了重量行，**体积行**没禁 ——
     * 让它打一句「总体积约：暂无数据」，56 项一项都没挂（2026-08-28 变异测试实测）。
     * 体积行是印给客户看方数的，多打一行没有的东西比少打更容易被当成真数据。
     */
    assert.ok(!answer.includes("总体积约"), `没数据还打了体积行：\n${answer}`);
  });

  await check("30) 缺父单的家族取最早的下单时间，不取分柜时间", async () => {
    // 只有子单、没有父单行的历史家族：不能拿分柜时间当下单时间
    const oldCreated = nowMs - 200 * 86400_000;
    const rows = [
      shipment({
        id: "ff_new",
        createdAtMs: beijingMonthStartMs() + 1000,
        updatedAtMs: nowMs,
        orderId: "o_ff",
        trackingNo: "THFF-2",
        parentTrackingNo: "THFF",
      }),
      shipment({
        id: "ff_old",
        createdAtMs: oldCreated,
        updatedAtMs: nowMs,
        orderId: "o_ff",
        trackingNo: "THFF-1",
        parentTrackingNo: "THFF",
      }),
    ];
    const { answer } = await ask({ shipments: rows, message: "我这个月一共发了多少货？" });
    assert.equal(totalCountOf(answer), 0, `半年前的老单被算进本月了：\n${answer}`);
  });

  await check("31) 品名带空格或全角字符时不会退回「全部品类」", async () => {
    // 退回全部品类 = 客户问一个品名，系统把他全部的单都报给他
    for (const [id, name] of [
      ["gg1", "ABC DEF"],
      ["gg2", "ＡＢＣ１２３"],
    ] as Array<[string, string]>) {
      orderNames.set(id, { itemName: name, productNames: [name] });
    }
    orderNames.set("gg3", { itemName: "别的货", productNames: ["别的货"] });
    const shipments = ["gg1", "gg2", "gg3"].map((id) =>
      shipment({ id, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    );
    for (const name of ["ABC DEF", "ＡＢＣ１２３"]) {
      const { answer } = await ask({
        shipments,
        message: "帮我看看这个品类",
        intent: JSON.stringify({ intent: "summary", itemName: name }),
      });
      assert.ok(answer.includes(`品名：${name}`), `品名「${name}」被丢掉了：\n${answer}`);
      assert.equal(totalCountOf(answer), 1, `品名「${name}」退回了全部品类：\n${answer}`);
    }
  });

  await check("32) 品名里含「运输」「完成」这类词时不会退回「全部品类」", async () => {
    orderNames.set("hh1", { itemName: "运输箱", productNames: ["运输箱"] });
    orderNames.set("hh2", { itemName: "别的货", productNames: ["别的货"] });
    const shipments = ["hh1", "hh2"].map((id) =>
      shipment({ id, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    );
    const { answer } = await ask({
      shipments,
      message: "帮我看看这个品类",
      intent: JSON.stringify({ intent: "summary", itemName: "运输箱" }),
    });
    assert.ok(answer.includes("品名：运输箱"), `真品名被词表拒掉了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1, `退回了全部品类：\n${answer}`);
  });

  await check("33) 但整句问话仍然拦得住（词表只是不再误伤真品名）", async () => {
    orderNames.set("ii1", { itemName: "运输箱", productNames: ["运输箱"] });
    const shipments = [shipment({ id: "ii1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "我在途有多少单" });
    assert.ok(answer.includes("全部品类"), `整句问话被当成品名了：\n${answer}`);
  });

  // ══ P1-1 复核抓到的绕过（2026-08-28）══════════════════════════════════
  // 旧闸用「数字集合」比较，看不出顺序和归属，下面这些全被放行过。
  // 正确做法是让模型从头到尾看不到真实数字（占位符方案）。

  await check("34) 同单位两个数字互换 → 必须拦住", async () => {
    // ⚠️ 三个数必须**互不相同**，否则互换等于没换，测试会假绿
    const shipments = [
      shipment({ id: "p1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "p2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "p3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    // ⚠️ 记号 0 是开头「查到 N 单」那句，1 才是「总单量」——
    // 换 0/1 时两处都是同一个数，等于没换，测试会假绿（第一版就踩了这个）
    const { answer } = await ask({ shipments, message: "我一共有多少单", polish: swapTokens(1, 2) });
    assert.equal(totalCountOf(answer), 3, `数字被互换后仍发给了客户：\n${answer}`);
  });

  await check("35) 数字换成中文（三单）→ 必须拦住", async () => {
    const shipments = [shipment({ id: "q1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "我一共有多少单", polish: replaceToken(1, "三单") });
    assert.ok(!answer.includes("三单"), `模型写的中文数字发给了客户：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
  });

  await check("36) Unicode 负号（−3 单）→ 必须拦住", async () => {
    const shipments = [shipment({ id: "r1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "我一共有多少单", polish: replaceToken(1, "\u22123 单") });
    assert.ok(!answer.includes("\u2212"), `Unicode 负号发给了客户：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
  });

  await check("37) 去掉单位后再交换 → 必须拦住", async () => {
    // 两个数字都是草稿里本来就有的，只是位置对调、单位去掉 ——
    // 旧闸「数字集合」和「数字单位对」两关都查不出来
    const shipments = [
      shipment({ id: "s1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "s2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "s3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      polish: (draft) => {
        const hits = draft.match(TOKEN_RE) ?? [];
        assert.ok(hits.length >= 2, `草稿里数据记号不够：\n${draft}`);
        const bare = (t: string) => t.replace(/\s*(?:单|票|张|件|箱|千克|公斤|kg|立方米|立方|方|m³)$/, "");
        let i = -1;
        return draft.replace(TOKEN_RE, (m) => {
          i += 1;
          if (i === 1) return bare(hits[2]!);
          if (i === 2) return bare(hits[1]!);
          return m;
        });
      },
    });
    assert.equal(totalCountOf(answer), 3, `去掉单位的交换被放行了：\n${answer}`);
  });

  await check("38) 模型吞掉一处数据 → 必须拦住", async () => {
    const shipments = [shipment({ id: "t1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer } = await ask({ shipments, message: "我一共有多少单", polish: replaceToken(1, "若干") });
    assert.ok(!answer.includes("若干"), `模型把数据吞成「若干」还发出去了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
  });

  await check("39) 模型想在统计答复上加寒暄也没机会（它压根没被调用）", async () => {
    const shipments = [shipment({ id: "u1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer, contexts } = await ask({
      shipments,
      message: "我一共有多少单",
      polish: (draft) => `亲，一共帮你查好了，十分感谢等待。\n${draft}`,
    });
    assert.ok(!answer.includes("十分感谢等待"), `统计答复还是被润色了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1);
    assert.equal(contexts.filter((c) => c.includes("answerDraft")).length, 0, "不该调模型");
  });

  // ══ P1-5 复核抓到的「模型说了算」（2026-08-28）══════════════════════════
  // 原来 "all" 同时表示「客户明确要全部」和「客户压根没提状态」，
  // 调用处只好写成「是 all 就让模型改」——客户明说的也被模型盖掉了。
  // 规矩：**问句里明确说了的，模型不许覆盖；模型只能补客户没说的。**

  await check("40) 客户说「一共」时，模型返回的状态盖不过他", async () => {
    // 数字互不相同：一共 3 单，其中在途 2 单、已完成 1 单
    const shipments = [
      shipment({ id: "jj1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "jj2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "jj3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      // 模型胡说成「已完成」——旧代码会照做，只报那 1 单
      intent: JSON.stringify({ intent: "summary", statusScope: "completed", confidence: 0.9 }),
    });
    assert.ok(answer.includes("全部运单"), `客户说了「一共」，还是被模型改成别的状态了：\n${answer}`);
    assert.equal(totalCountOf(answer), 3, `只报了已完成的那 1 单：\n${answer}`);
  });

  await check("41) 明确的统计问题，模型说「打招呼」也不许改", async () => {
    // 本月 3 单（在途 2 / 已完成 1），另有 1 单是 40 天前的，不该算进本月
    const shipments = [
      shipment({ id: "kk1", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "kk2", createdAtMs: beijingMonthStartMs() + 2000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "kk3", createdAtMs: beijingMonthStartMs() + 3000, updatedAtMs: nowMs, status: "delivered" }),
      shipment({ id: "kk4", createdAtMs: beijingMonthStartMs() - 40 * 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我这个月发了多少单",
      intent: JSON.stringify({ intent: "greeting", confidence: 0.9 }),
    });
    assert.ok(!answer.includes("我是湘泰物流AI客服助手"), `统计问题被模型变成欢迎语了：\n${answer}`);
    assert.ok(answer.includes("查询范围：本月"), `没按本月统计：\n${answer}`);
    assert.equal(totalCountOf(answer), 3, `本月单量不对：\n${answer}`);
  });

  await check("42) 模型把整句问话当品名（置信度 0.01）→ 必须忽略", async () => {
    const shipments = [
      shipment({ id: "ll1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "ll2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "ll3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer } = await ask({
      shipments,
      message: "统计一下",
      // confidence 只有 0.01，旧代码照样采信 —— 那个字段一处都没用上
      intent: JSON.stringify({
        intent: "summary",
        itemName: "统计一下我这个月发了多少单",
        confidence: 0.01,
      }),
    });
    assert.ok(!answer.includes("未查询到品名"), `模型编的品名被当真了：\n${answer}`);
    assert.ok(answer.includes("全部品类"), `没退回全部品类：\n${answer}`);
    assert.equal(totalCountOf(answer), 3, `单量不对：\n${answer}`);
  });

  await check("43) 模型说「在查单号」却给不出单号 → 必须反问，不能报全部", async () => {
    const shipments = [
      shipment({ id: "mm1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "mm2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "mm3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我的货呢",
      intent: JSON.stringify({ intent: "tracking", trackingNo: "", confidence: 0.9 }),
    });
    assert.ok(answer.includes("还不太确定你想看哪一项"), `没反问，直接报数了：\n${answer}`);
    assert.ok(!answer.includes("总单量"), `把他名下全部单都报出去了：\n${answer}`);
  });

  await check("44) 「总计 / 加起来」不再被当成品名", async () => {
    const shipments = [
      shipment({ id: "nn1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "nn2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "nn3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    // 「一共/总共」当年补过，「总计/加起来」漏了 → 客户拿到「未查询到品名『总计』相关订单」
    for (const message of ["总计多少单", "我总计发了多少单", "加起来一共多少单"]) {
      const { answer } = await ask({ shipments, message });
      assert.ok(!answer.includes("未查询到品名"), `「${message}」被当成品名了：\n${answer}`);
      assert.ok(answer.includes("全部品类"), `「${message}」没按全部品类统计：\n${answer}`);
      assert.equal(totalCountOf(answer), 3, `「${message}」单量不对：\n${answer}`);
    }
  });

  await check("45) 正向：客户没提状态时，模型仍然可以补", async () => {
    // 别改过头 —— 「还没到的有多少」这类规则认不出的说法，得靠模型
    const shipments = [
      shipment({ id: "oo1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "oo2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "oo3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer } = await ask({
      shipments,
      message: "帮我看看",
      intent: JSON.stringify({ intent: "summary", statusScope: "completed", confidence: 0.9 }),
    });
    assert.ok(answer.includes("已完成运单"), `模型补的状态没生效：\n${answer}`);
    assert.equal(totalCountOf(answer), 1, `没按已完成筛：\n${answer}`);
  });

  await check("46) 「这个月一共完成了多少单」→ 仍按已完成算", async () => {
    // 「一共」和「完成」同时出现时，具体状态词必须排在前面。
    // ⚠️ 现有 39 项里没有一句话同时带这两种词 —— 顺序写反了也没人发现，所以补这一项。
    const shipments = [
      shipment({ id: "pp1", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "pp2", createdAtMs: beijingMonthStartMs() + 2000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "pp3", createdAtMs: beijingMonthStartMs() + 3000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer } = await ask({ shipments, message: "这个月一共完成了多少单" });
    assert.ok(
      answer.includes("查询范围：本月，已完成运单"),
      `「一共」抢在「完成」前面了：\n${answer}`,
    );
    assert.equal(totalCountOf(answer), 1, `没按已完成筛：\n${answer}`);
  });

  // ══ P1-3：品名本身含状态词/时间词（2026-08-28）════════════════════════
  // 真实品名叫「完成品」「在途箱」「本月货」的客户，一问就被自动加上筛选，
  // 报出来的数字比真实少一大截。正确做法：**先认全真实品名，再从剩下的问句里解析时间和状态。**

  await check("47) 品名叫「完成品」时不再被自动加「已完成」筛选", async () => {
    // 完成品 3 单（已完成 1 / 在途 2），另有别的货 1 单 —— 数字互不相同
    orderNames.set("qq1", { itemName: "完成品", productNames: ["完成品"] });
    orderNames.set("qq2", { itemName: "完成品", productNames: ["完成品"] });
    orderNames.set("qq3", { itemName: "完成品", productNames: ["完成品"] });
    orderNames.set("qq4", { itemName: "别的货", productNames: ["别的货"] });
    const shipments = [
      shipment({ id: "qq1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
      shipment({ id: "qq2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "qq3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "qq4", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
    ];
    const { answer } = await ask({ shipments, message: "完成品有多少单" });
    assert.ok(answer.includes("品名：完成品"), `品名没认出来：\n${answer}`);
    assert.ok(answer.includes("全部运单"), `品名里的「完成」被当成状态筛选了：\n${answer}`);
    assert.equal(totalCountOf(answer), 3, `只报了已完成的那 1 单：\n${answer}`);
  });

  await check("48) 品名里的状态词盖不过客户真正说的状态", async () => {
    orderNames.set("rr1", { itemName: "完成品", productNames: ["完成品"] });
    orderNames.set("rr2", { itemName: "完成品", productNames: ["完成品"] });
    orderNames.set("rr3", { itemName: "完成品", productNames: ["完成品"] });
    const shipments = [
      shipment({ id: "rr1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
      shipment({ id: "rr2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "rr3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
    ];
    // 客户明明问的是「在途」，旧代码被品名里的「完成」抢先，答的是已完成
    const { answer } = await ask({ shipments, message: "我的完成品还有多少在途" });
    assert.ok(answer.includes("在途运单"), `品名里的「完成」抢在客户说的「在途」前面了：\n${answer}`);
    assert.equal(totalCountOf(answer), 2, `在途单量不对：\n${answer}`);
  });

  await check("49) 品名叫「本月货」时不再被自动加「本月」筛选", async () => {
    // 本月货 4 单，其中只有 1 单是本月下的
    for (const id of ["ss1", "ss2", "ss3", "ss4"]) {
      orderNames.set(id, { itemName: "本月货", productNames: ["本月货"] });
    }
    const shipments = [
      shipment({ id: "ss1", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs }),
      shipment({ id: "ss2", createdAtMs: beijingMonthStartMs() - 40 * 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "ss3", createdAtMs: beijingMonthStartMs() - 50 * 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "ss4", createdAtMs: beijingMonthStartMs() - 60 * 86400_000, updatedAtMs: nowMs }),
    ];
    const { answer } = await ask({ shipments, message: "本月货有多少单" });
    assert.ok(answer.includes("品名：本月货"), `品名没认出来：\n${answer}`);
    assert.ok(
      answer.includes("查询范围：当前公司账号数据"),
      `品名里的「本月」被当成时间筛选了：\n${answer}`,
    );
    assert.equal(totalCountOf(answer), 4, `只报了本月那 1 单：\n${answer}`);

    // 护栏：客户**真的**又说了一次「本月」，那就该按本月筛
    const second = await ask({ shipments, message: "本月货本月发了多少单" });
    assert.ok(second.answer.includes("查询范围：本月"), `客户说了本月却没筛：\n${second.answer}`);
    assert.equal(totalCountOf(second.answer), 1, `本月单量不对：\n${second.answer}`);
  });

  await check("50) 剥掉品名之后，剩下的状态词照样生效", async () => {
    // 在途箱 2 单（已完成 1 / 在途 1），别的货 1 单
    orderNames.set("tt1", { itemName: "在途箱", productNames: ["在途箱"] });
    orderNames.set("tt2", { itemName: "在途箱", productNames: ["在途箱"] });
    orderNames.set("tt3", { itemName: "别的货", productNames: ["别的货"] });
    const shipments = [
      shipment({ id: "tt1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
      shipment({ id: "tt2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "tt3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
    ];
    const { answer } = await ask({ shipments, message: "在途箱已完成多少单" });
    assert.ok(answer.includes("品名：在途箱"), `品名没认出来：\n${answer}`);
    assert.ok(answer.includes("已完成运单"), `剥掉品名后「已完成」也被剥没了：\n${answer}`);
    assert.equal(totalCountOf(answer), 1, `已完成单量不对：\n${answer}`);

    // 同一批数据，不带状态词时要报全部 2 单（证明上面那 1 单是筛出来的，不是漏了）
    const all = await ask({ shipments, message: "在途箱有多少单" });
    assert.ok(all.answer.includes("全部运单"), `品名里的「在途」被当成状态筛选了：\n${all.answer}`);
    assert.equal(totalCountOf(all.answer), 2, `在途箱总单量不对：\n${all.answer}`);
  });

  // ══ P1-2：客户**自己敲**带空格的品名（2026-08-28）═════════════════════
  // 第 31 项只测了「模型返回 ABC DEF」，没测客户直接输入。
  // 抓品名的正则字符集里没有空格，「ABC DEF订单有多少单」被截成「DEF」，
  // 而匹配是「货品名里含这个词就算」—— 于是把 XYZ DEF 也算了进去，**数字报大**。

  await check("51) 客户直接敲带空格的品名不再被截半、不再报大", async () => {
    // ABC DEF 2 单 / XYZ DEF 1 单 / 别的货 1 单 —— 数字互不相同
    orderNames.set("uu1", { itemName: "ABC DEF", productNames: ["ABC DEF"] });
    orderNames.set("uu2", { itemName: "ABC DEF", productNames: ["ABC DEF"] });
    orderNames.set("uu3", { itemName: "XYZ DEF", productNames: ["XYZ DEF"] });
    orderNames.set("uu4", { itemName: "别的货", productNames: ["别的货"] });
    const shipments = ["uu1", "uu2", "uu3", "uu4"].map((id) =>
      shipment({ id, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    );
    // 三种写法都得认成整个「ABC DEF」，都得报 2 单（旧代码全被截成「DEF」→ 报 3 单）
    for (const message of ["ABC DEF订单有多少单", "ABC DEF 订单有多少单", "我有多少ABC DEF的订单"]) {
      const { answer } = await ask({ shipments, message });
      assert.ok(answer.includes("品名：ABC DEF"), `「${message}」品名被截半了：\n${answer}`);
      assert.equal(totalCountOf(answer), 2, `「${message}」把 XYZ DEF 也算进来了：\n${answer}`);
    }
    // 另一个品名同样，报大得更离谱：真实 1 单，旧代码报 3 单
    const other = await ask({ shipments, message: "XYZ DEF订单有多少单" });
    assert.ok(other.answer.includes("品名：XYZ DEF"), `品名被截半了：\n${other.answer}`);
    assert.equal(totalCountOf(other.answer), 1, `报大了：\n${other.answer}`);
    // 「品名：」这种写法旧代码截成「ABC」，数字碰巧对，但回给客户的品名是错的
    const labeled = await ask({ shipments, message: "品名：ABC DEF 有多少单" });
    assert.ok(labeled.answer.includes("品名：ABC DEF"), `回给客户的品名不对：\n${labeled.answer}`);
    assert.equal(totalCountOf(labeled.answer), 2, `单量不对：\n${labeled.answer}`);
  });

  await check("52) 但客户只说了半个词时，不许自作主张补全", async () => {
    // 客户库里只有「ABC DEF」，他问的是「DEF」—— 问句里压根没有 ABC，不能替他补
    orderNames.set("vv1", { itemName: "ABC DEF", productNames: ["ABC DEF"] });
    orderNames.set("vv2", { itemName: "ABC DEF", productNames: ["ABC DEF"] });
    orderNames.set("vv3", { itemName: "ＡＢＣ１２３", productNames: ["ＡＢＣ１２３"] });
    orderNames.set("vv4", { itemName: "别的货", productNames: ["别的货"] });
    const shipments = ["vv1", "vv2", "vv3", "vv4"].map((id) =>
      shipment({ id, createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    );
    const { answer } = await ask({ shipments, message: "DEF订单有多少单" });
    assert.ok(answer.includes("品名：DEF"), `替客户补成整个品名了：\n${answer}`);
    assert.ok(!answer.includes("品名：ABC DEF"), `替客户补成整个品名了：\n${answer}`);
    assert.equal(totalCountOf(answer), 2, `单量不对：\n${answer}`);
    // 全角品名直接敲进来照旧要认得（这条本来就是绿的，防改坏）
    const fullWidth = await ask({ shipments, message: "ＡＢＣ１２３订单有多少单" });
    assert.ok(fullWidth.answer.includes("品名：ＡＢＣ１２３"), `全角品名认不出了：\n${fullWidth.answer}`);
    assert.equal(totalCountOf(fullWidth.answer), 1, `全角品名单量不对：\n${fullWidth.answer}`);
  });

  // ══ P1-4：客户明说了「单号」，查不到就得明说查不到（2026-08-28）═════════
  // 原来只要这句话像统计问题，查不到的单号就被让开，转头去统计他别的单 ——
  // 客户问的是某一票货，拿到的却是一个跟他问题无关的数字。

  await check("53) 客户明说「单号」但查不到 → 必须报查无此单", async () => {
    // 3 单：已完成 2 / 在途 1，单号 THCN0001~0003 —— 数字互不相同
    const shipments = [
      { ...shipment({ id: "ww1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }), trackingNo: "THCN0001" },
      { ...shipment({ id: "ww2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }), trackingNo: "THCN0002" },
      { ...shipment({ id: "ww3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }), trackingNo: "THCN0003" },
    ] as Shipment[];
    for (const message of ["单号 THCN9999 完成了吗", "单号 THCN9999 这个月发了多少单"]) {
      const { answer } = await ask({ shipments, message });
      assert.ok(answer.includes("未找到运单号"), `没报查无此单：\n${answer}`);
      assert.ok(answer.includes("THCN9999"), `没把客户问的单号回显出来：\n${answer}`);
      assert.ok(!answer.includes("总单量"), `转头去统计他别的单了：\n${answer}`);
      assert.ok(!answer.includes("符合条件"), `转头去统计他别的单了：\n${answer}`);
    }
  });

  await check("54) 但没说「单号」的产品型号，照旧走统计", async () => {
    // 「ABC1234」这种产品型号会被正则误认成运单号 —— 客户没说「单号」就不能霸占分支
    const shipments = [
      { ...shipment({ id: "xx1", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs, status: "delivered" }), trackingNo: "THCN0001" },
      { ...shipment({ id: "xx2", createdAtMs: beijingMonthStartMs() + 2000, updatedAtMs: nowMs, status: "delivered" }), trackingNo: "THCN0002" },
      { ...shipment({ id: "xx3", createdAtMs: beijingMonthStartMs() + 3000, updatedAtMs: nowMs, status: "loaded" }), trackingNo: "THCN0003" },
    ] as Shipment[];
    const { answer } = await ask({ shipments, message: "我这个月 ABC1234 发了多少单" });
    assert.ok(!answer.includes("未找到运单号"), `产品型号被当成单号霸占了分支：\n${answer}`);
    assert.equal(totalCountOf(answer), 3, `本月单量不对：\n${answer}`);

    // 真存在的单号照旧查得到
    const real = await ask({ shipments, message: "单号 THCN0001 完成了吗" });
    assert.ok(real.answer.includes("THCN0001"), `真单号查不到了：\n${real.answer}`);
    assert.ok(!real.answer.includes("未找到运单号"), `真单号被判成查无此单：\n${real.answer}`);
  });

  // ══ P1-6：追问记忆残留（2026-08-28）══════════════════════════════════
  // 记忆是「新值 ?? 旧值」合并的，第二轮已经不按品名查了，旧的「耳机」还留着，
  // 第三轮「那本月呢」又把它捡回来 —— 客户看到的数字莫名其妙变小。

  await check("55) 已经清掉的品名，追问时不许自己回来", async () => {
    // 耳机 2 单（本月 1）／别的货 3 单（本月 2）—— 全部 5、本月 3、耳机 2、本月耳机 1，四个数互不相同
    orderNames.set("yy1", { itemName: "耳机", productNames: ["耳机"] });
    orderNames.set("yy2", { itemName: "耳机", productNames: ["耳机"] });
    orderNames.set("zz1", { itemName: "别的货", productNames: ["别的货"] });
    orderNames.set("zz2", { itemName: "别的货", productNames: ["别的货"] });
    orderNames.set("zz3", { itemName: "别的货", productNames: ["别的货"] });
    const shipments = [
      shipment({ id: "yy1", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs }),
      shipment({ id: "yy2", createdAtMs: beijingMonthStartMs() - 40 * 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "zz1", createdAtMs: beijingMonthStartMs() + 2000, updatedAtMs: nowMs }),
      shipment({ id: "zz2", createdAtMs: beijingMonthStartMs() + 3000, updatedAtMs: nowMs }),
      shipment({ id: "zz3", createdAtMs: beijingMonthStartMs() - 50 * 86400_000, updatedAtMs: nowMs }),
    ];
    const [first, second, third] = await askSeries({
      shipments,
      messages: ["耳机有多少单", "我一共有多少单", "那本月呢"],
    });
    assert.equal(totalCountOf(first!), 2, `第一轮耳机单量不对：\n${first}`);
    assert.equal(totalCountOf(second!), 5, `第二轮没退回全部品类：\n${second}`);
    assert.ok(third!.includes("全部品类"), `第三轮把清掉的「耳机」捡回来了：\n${third}`);
    assert.ok(third!.includes("查询范围：本月"), `第三轮没按本月：\n${third}`);
    assert.equal(totalCountOf(third!), 3, `第三轮单量不对（被旧品名缩小了）：\n${third}`);
  });

  await check("56) 但真正的追问，还是要能把品名带过去", async () => {
    orderNames.set("ab1", { itemName: "耳机", productNames: ["耳机"] });
    orderNames.set("ab2", { itemName: "耳机", productNames: ["耳机"] });
    orderNames.set("ac1", { itemName: "别的货", productNames: ["别的货"] });
    orderNames.set("ac2", { itemName: "别的货", productNames: ["别的货"] });
    orderNames.set("ac3", { itemName: "别的货", productNames: ["别的货"] });
    const shipments = [
      shipment({ id: "ab1", createdAtMs: beijingMonthStartMs() + 1000, updatedAtMs: nowMs }),
      shipment({ id: "ab2", createdAtMs: beijingMonthStartMs() - 40 * 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "ac1", createdAtMs: beijingMonthStartMs() + 2000, updatedAtMs: nowMs }),
      shipment({ id: "ac2", createdAtMs: beijingMonthStartMs() + 3000, updatedAtMs: nowMs }),
      shipment({ id: "ac3", createdAtMs: beijingMonthStartMs() - 50 * 86400_000, updatedAtMs: nowMs }),
    ];
    // 上一轮问的就是耳机，紧接着「那本月呢」——品名必须带过去（本月耳机 1 单）
    const [, followUp] = await askSeries({ shipments, messages: ["耳机有多少单", "那本月呢"] });
    assert.ok(followUp!.includes("品名：耳机"), `追问时把品名丢了：\n${followUp}`);
    assert.ok(followUp!.includes("查询范围：本月"), `追问时没按本月：\n${followUp}`);
    assert.equal(totalCountOf(followUp!), 1, `本月耳机单量不对：\n${followUp}`);
  });

  // ══ 数字对上了，名称却被换了（2026-08-28 生产实测）═══════════════════
  // 老板实测：一共 3 单，AI 却答「已完成 3 单、总单量 1 单」。
  // 占位符方案的五道检查全都只盯**占位符本身**（各出现一次 / 编号合法 / 顺序一致 /
  // 外面没数字 / 外面没中文数量词），没有一道管「数字挂在哪个名称底下」。
  // 模型把 ⟦N⟧ 留在原位、只调换「总单量：」「已完成：」这两个**文字标签**，五道全过。

  await check("57) 模型只调换名称、不动占位符 → 也必须拦住", async () => {
    // 一共 3 单：在途 2 / 已完成 1 —— 三个数互不相同，换了就一定看得出来
    const shipments = [
      shipment({ id: "ad1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "ad2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "ad3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer, contexts } = await ask({
      shipments,
      message: "我一共有多少单",
      // 占位符一个不动，只把两个名称对调
      polish: (draft) =>
        draft
          .replace(/总单量：/g, "@@TMP@@")
          .replace(/已完成：/g, "总单量：")
          .replace(/@@TMP@@/g, "已完成："),
    });

    // ① 客户看到的数字必须挂在正确的名称底下
    assert.ok(!/已完成：3 单/.test(answer), `「已完成」拿到了总数：\n${answer}`);
    assert.ok(!/总单量：1 单/.test(answer), `「总单量」拿到了已完成的数：\n${answer}`);
    assert.ok(/总单量：3 单/.test(answer), `总单量不对：\n${answer}`);
    assert.ok(/在途中：2 单/.test(answer), `在途不对：\n${answer}`);
    assert.ok(/已完成：1 单/.test(answer), `已完成不对：\n${answer}`);

    /**
     * ② 光验①会「假绿」：不同版本的修法都能让①过，但理由完全不同。
     *    现在（2026-08-28 用户拍板后）真正的保证是：
     *    **带数字的答复根本不调模型** —— 名称也好数字也好，模型一个都碰不到。
     *    所以这里直接盯这条：一次润色调用都不许有。
     */
    assert.equal(
      contexts.filter((c) => c.includes("answerDraft")).length,
      0,
      "统计答复被送去润色了 —— 只要模型碰得到，名称就有被换掉的可能",
    );
  });

  await check("58) 只改数字旁边那句话的意思 → 也必须拦住", async () => {
    /**
     * 2026-08-28 第二种改义（第一种是第 57 项那个调换标签）。
     * 复核实测：模型**一个占位符都没动**，只把普通句子
     *   「你当前一共查到 ⟦N1⟧。」改成「你当前已完成 ⟦N1⟧。」
     * 客户看到「你当前已完成 3 单」，而实际只完成 1 单。
     * 第 57 项那版修法只焊住了「标签：数字」的整行，句子里的说明文字管不到。
     */
    const shipments = [
      shipment({ id: "ae1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "ae2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "ae3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      polish: (draft) => draft.replace(/你当前一共查到/g, "你当前已完成"),
    });
    assert.ok(
      !/你当前已完成\s*3\s*单/.test(answer),
      `总数被说成了「已完成」（实际只完成 1 单）：\n${answer}`,
    );
    assert.ok(/你当前一共查到 3 单/.test(answer), `没退回原始草稿：\n${answer}`);
    assert.ok(/已完成：1 单/.test(answer), `已完成的数不对：\n${answer}`);
  });

  await check("59) 换个说法改义（在途说成已完成）→ 一样拦住", async () => {
    // 别只堵「一共查到」这四个字：能改义的说法堵不完，所以规则是「带数据的行一个字都不许改」
    const shipments = [
      shipment({ id: "af1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "af2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "af3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我在途有多少单",
      // 在途 2 单 → 说成「已经送达」
      polish: (draft) => draft.replace(/你当前在途运输中的有/g, "你当前已经送达的有"),
    });
    assert.ok(!/已经送达/.test(answer), `在途被说成送达了：\n${answer}`);
    assert.ok(/在途运输中的有 2 单/.test(answer), `没退回原始草稿：\n${answer}`);
  });

  await check("60) 不含数字的答复仍然会被润色（润色本来就该用在这种地方）", async () => {
    /**
     * 别把话说死成「一律不润色」。服务问答（时效、清关、能不能寄…）里没有系统算出来的数字，
     * 那种答复正是润色有价值的地方，不能一起砍掉。
     */
    const shipments = [shipment({ id: "ag1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs })];
    const { answer, contexts } = await ask({
      shipments,
      // 走服务问答分支（SERVICE_QA_RE 里的「能寄」），答复里没有统计数字
      message: "锂电池能寄吗",
      polish: (draft) => `亲，帮你确认过了。\n${draft}`,
    });
    assert.ok(answer.includes("帮你确认过了"), `不含数字的答复被误杀了：\n${answer}`);
    assert.equal(
      contexts.filter((c) => c.includes("answerDraft")).length,
      1,
      "不含数字的答复应该调一次模型",
    );
  });

  await check("61) 模型另起一句不带数字的假话 → 也到不了客户手里", async () => {
    /**
     * 2026-08-28 复核实测的漏口：上一版只保护「含占位符的行」，
     * 模型另起一句**不含任何数字**的话
     *   「以上订单均已完成。」
     * 五道检查一道都拦不住，而下面写着「已完成：1 单」，整段自相矛盾。
     * 现在统计答复根本不调模型，这条从源头没了 —— 这一项就是盯着别把它改回去。
     */
    const shipments = [
      shipment({ id: "ah1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "ah2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "loaded" }),
      shipment({ id: "ah3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer } = await ask({
      shipments,
      message: "我一共有多少单",
      polish: (draft) => `${draft}\n以上订单均已完成。`,
    });
    assert.ok(!answer.includes("以上订单均已完成"), `模型编的假结论发给客户了：\n${answer}`);
    assert.ok(/总单量：3 单/.test(answer) && /已完成：1 单/.test(answer), `数字不对：\n${answer}`);
  });

  await check("62) 查单进度也不给模型碰（状态和时间同样是系统查出来的事实）", async () => {
    const target = shipment({ id: "ai1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs });
    const { answer, contexts } = await ask({
      shipments: [{ ...target, trackingNo: "THAI0001" } as Shipment],
      message: "单号 THAI0001 到哪了",
      polish: (draft) => `${draft}\n预计明天送达。`,
    });
    assert.ok(!answer.includes("预计明天送达"), `模型给客户编了个送达时间：\n${answer}`);
    assert.equal(contexts.filter((c) => c.includes("answerDraft")).length, 0, "查单进度不该调模型");
  });

  await check("63) 兜底分支的统计答复同样不给模型碰", async () => {
    /**
     * 2026-08-29 独立变异实测：把**兜底分支**（ai-service.ts 最后那个 else，
     * 「什么都没匹配上、直接报名下全部单量」）的 `answerHasBusinessData = true`
     * 删掉，**62 项 × 2 时区照样全绿** —— 前面 57~62 项测的都是别的分支，
     * 谁也没走到这一条上，等于这个分支的「不润色」没有任何测试守着。
     *
     * 怎么走到兜底分支（这几个条件缺一不可，改动前先读 ai-service.ts:236-349）：
     *   · 没有运单号；
     *   · 不是问候语、不是服务问答；
     *   · 问句里**没有**任何统计词（「多少」「几单」「本月」…），
     *     否则会被 isSummaryIntent 收走；
     *   · 问句长度 ≤ 2，否则 shouldAskClarification 会先反问；
     *   · 模型返回的 intent 是 "tracking"（不是 summary / unknown / greeting）。
     * 「货」这一个字正好全中。
     */
    const shipments = [
      shipment({ id: "az1", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "departed" }),
      shipment({ id: "az2", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "departed" }),
      shipment({ id: "az3", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs, status: "delivered" }),
    ];
    const { answer, contexts } = await ask({
      shipments,
      message: "货",
      intent: JSON.stringify({ intent: "tracking" }),
      polish: (draft) => `${draft}\n您的货物均已妥投，感谢信赖。`,
    });

    // ⚠️ 三个数字互不相同（3 / 2 / 1），相同的数会假绿
    assert.ok(/总单量：3 单/.test(answer), `兜底分支总单量不对：\n${answer}`);
    assert.ok(/在途中：2 单/.test(answer), `兜底分支在途不对：\n${answer}`);
    assert.ok(/已完成：1 单/.test(answer), `兜底分支已完成不对：\n${answer}`);
    assert.ok(
      !answer.includes("均已妥投"),
      `兜底分支的答复被模型润色了 —— 它报的是客户名下**全部**单量，最不能让模型碰：\n${answer}`,
    );
    assert.equal(
      contexts.filter((c) => c.includes("answerDraft")).length,
      0,
      "兜底分支的统计答复被送去润色了",
    );
  });

  /* ══════════ 「已到仓」查询范围（2026-09-03 加，复核实测出来的坑）══════════
     这一批全部是**真问真答**：造真运单、走真 service.chat、看客户实际收到的那段字。
     上一版只断言了「AI_STATUS_SCOPES 数组里有 arrived」和「提示词是拼出来的」，
     两条都绿，而客户最常问的那几句其实一句都答不对 —— 典型的假绿。 */
  {
    const arrivedFixture = () => [
      shipment({ id: "w1", status: "inWarehouseTH", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "w2", status: "deliveryBooked", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "w3", status: "outForDelivery", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "t1", status: "departed", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "t2", status: "unloading", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
      shipment({ id: "p1", status: "created", createdAtMs: nowMs - 86400_000, updatedAtMs: nowMs }),
    ];

    await check("64) ⭐「已到仓」的常见问法不能被当成品名，而且要答对数（已到仓 3 单）", async () => {
      /* 复核实测的原始现场：品名识别排在状态识别前面，「已到仓」被当成品名抓走，
         客户收到的是「未查询到品名『已到仓』相关订单」。 */
      for (const message of [
        "已到仓的订单有多少",
        "到仓的订单有多少",
        "已到仓有多少单",
        "到仓的有多少单",
        "已到仓的货有多少方",
        "到仓了几单",
      ]) {
        const { answer } = await ask({ shipments: arrivedFixture(), message });
        assert.ok(!answer.includes("未查询到品名"), `「${message}」被当成品名查了：\n${answer}`);
        assert.ok(answer.includes("已到仓运单"), `「${message}」没按已到仓查：\n${answer}`);
        assert.equal(totalCountOf(answer), 3, `「${message}」数字不对（该是 3 单）：\n${answer}`);
      }
    });

    await check("65) ⭐ 否定句绝不能答成「已到仓」—— 那是方向相反的数", async () => {
      /* 这是 2026-09-03 加「到仓」时**自己改出来的回归**：
         客户问「还有多少单没到仓」，系统按已到仓查，答的正好是反面那批货的数量。
         现在的口径：认不准就退回「全部」并附分项，宁可不精准也不能给反的数。 */
      for (const message of [
        "还没到仓的有几单",
        "没到仓的还有多少单",
        "还有多少单没到仓",
        "未到仓的有多少",
        "还没到泰国仓的有几单",
      ]) {
        const { answer } = await ask({ shipments: arrivedFixture(), message });
        assert.ok(
          !answer.includes("已到仓运单"),
          `「${message}」被当成「已到仓」查了，客户拿到的是反面那批的数：\n${answer}`,
        );
        assert.ok(!answer.includes("未查询到品名"), `「${message}」被当成品名查了：\n${answer}`);
        assert.notEqual(totalCountOf(answer), 3, `「${message}」答出了已到仓那批的数（3）：\n${answer}`);
      }
    });

    await check("66) 老的问法不受影响（在途 / 异常 / 全部 的回归保护）", async () => {
      const inTransit = await ask({ shipments: arrivedFixture(), message: "在途的订单有多少" });
      assert.ok(inTransit.answer.includes("在途运单"), `在途问法坏了：\n${inTransit.answer}`);
      // 在途 = departed + unloading（正在卸柜按老板口径算在途）
      assert.equal(totalCountOf(inTransit.answer), 2, `在途该是 2 单：\n${inTransit.answer}`);

      const exception = await ask({ shipments: arrivedFixture(), message: "异常的订单有多少" });
      assert.ok(exception.answer.includes("异常"), `异常问法坏了：\n${exception.answer}`);
    });

    await check("67) 加了「到仓」词表之后，真品名还查得到（别误伤客户的货名）", async () => {
      const ships = arrivedFixture();
      orderNames.set("w1", { itemName: "耳机", productNames: ["耳机"] });
      const { answer } = await ask({ shipments: ships, message: "耳机有多少单" });
      orderNames.delete("w1");
      assert.ok(answer.includes("品名"), `真品名查不到了：\n${answer}`);
      assert.ok(!answer.includes("未查询到品名"), `真品名被误伤：\n${answer}`);
    });

    await check("68) 说「国内仓」的不算「已到仓」，也不许被当成品名", async () => {
      /* ⚠️ 这条原来只断言「不能算已到仓」—— 太松：被当成品名同样满足这个条件，
         2026-09-03 自查实测就是这么漏过去的（答「未查询到品名『到国内仓』相关订单」）。
         两条都得断。 */
      for (const message of ["到国内仓的有多少单", "国内仓还有多少货"]) {
        const { answer } = await ask({ shipments: arrivedFixture(), message });
        assert.ok(!answer.includes("已到仓运单"), `「${message}」按泰国仓的已到仓答了：\n${answer}`);
        assert.ok(!answer.includes("未查询到品名"), `「${message}」被当成品名查了：\n${answer}`);
      }
    });

    await check("69) ⭐ 问「什么时候到仓」要的是日期，不能答成「已到仓几单」", async () => {
      /* 自查实测：不排掉时间问句的话，客户问「我的货什么时候到仓」，
         系统答「已到仓运单 3 单」—— 答非所问，比不答更糟。 */
      for (const message of ["什么时候到仓", "我的货什么时候到仓", "货几号到仓", "哪天到仓"]) {
        const { answer } = await ask({ shipments: arrivedFixture(), message });
        assert.ok(
          !answer.includes("已到仓运单"),
          `「${message}」问的是时间，却答成了已到仓的单量：\n${answer}`,
        );
      }
    });

    await check("70) 否定 + 别的状态词也不能被当成品名（装柜 / 发出）", async () => {
      /* 否定闸里写了「装柜/发出」，但品名词表当时没同步，
         「没装柜的有多少」会被抓成品名「没装柜」，客户收到一句答非所问的话。 */
      for (const message of ["没装柜的有多少", "还没发出的有几单", "未发出的有几单"]) {
        const { answer } = await ask({ shipments: arrivedFixture(), message });
        assert.ok(!answer.includes("未查询到品名"), `「${message}」被当成品名查了：\n${answer}`);
        assert.ok(!answer.includes("已到仓运单"), `「${message}」按已到仓答了：\n${answer}`);
      }
    });
  }

    await check("71) ⭐ 问「已签收 / 派送中 多少单」给数字，不当成服务问题（2026-09-29 Codex 全系统检查）", async () => {
      /* 「签收」「派送」既是服务问题关键词、也是状态词。原来服务问答排在统计前面，
         「本月已签收多少单」回的是「当前可用知识信息不足」，数据库里明明有 2 单。 */
      const now = Date.now();
      const fx = [
        shipment({ id: "sg1", createdAtMs: now - 3600_000, updatedAtMs: now - 3600_000, status: "delivered" }),
        shipment({ id: "sg2", createdAtMs: now - 7200_000, updatedAtMs: now - 7200_000, status: "delivered" }),
        shipment({ id: "sg3", createdAtMs: now - 7200_000, updatedAtMs: now - 7200_000, status: "outForDelivery" }),
      ];
      const signed = await ask({ shipments: fx, message: "本月已签收多少单" });
      assert.ok(!signed.answer.includes("知识信息不足"), `被当成服务问题了：\n${signed.answer}`);
      assert.equal(totalCountOf(signed.answer), 2, `已签收应该是 2 单：\n${signed.answer}`);
      /* 「派送中」没有单独的查询范围（9-03 定的：认不准的状态词退回「全部 + 分项」，宁可不精准也不答反），
         这里只要求给出数字、不被当成服务问题、也不被当成品名。 */
      const delivering = await ask({ shipments: fx, message: "派送中有多少单" });
      assert.ok(!delivering.answer.includes("知识信息不足"), `被当成服务问题了：\n${delivering.answer}`);
      assert.ok(!delivering.answer.includes("未查询到品名"), `「派送中」被当成品名了：\n${delivering.answer}`);
      assert.equal(totalCountOf(delivering.answer), 3, `应该按全部 3 单答（附分项）：\n${delivering.answer}`);
    });

    await check("72) ⭐「你好，我本月有多少单」给数字，不只回欢迎语", async () => {
      const now = Date.now();
      const fx = [
        shipment({ id: "hi1", createdAtMs: now - 3600_000, updatedAtMs: now - 3600_000 }),
        shipment({ id: "hi2", createdAtMs: now - 3600_000, updatedAtMs: now - 3600_000 }),
      ];
      const { answer } = await ask({ shipments: fx, message: "你好，我本月有多少单" });
      assert.equal(totalCountOf(answer), 2, `应该答本月 2 单：\n${answer}`);
      // 单纯打招呼照旧回欢迎语；服务问题照旧走服务问答
      const hello = await ask({ shipments: fx, message: "你好" });
      assert.ok(!/(总单量|符合条件)：/.test(hello.answer), `单纯打招呼不该报单量：\n${hello.answer}`);
      const svc = await ask({ shipments: fx, message: "清关要几天" });
      assert.ok(!/(总单量|符合条件)：/.test(svc.answer), `服务问题不该报单量：\n${svc.answer}`);
      const fee = await ask({ shipments: fx, message: "运费多少" });
      assert.ok(!/(总单量|符合条件)：/.test(fee.answer), `「运费多少」不该报单量：\n${fee.answer}`);
      // 带「几件 / 多少件」的服务问题（dsh 复核）：照旧走服务问答，不许回一个无关的单量
      // 反过来：带「丢了 / 少件」但问的是数量的，要给数字，不许被服务问答截走、也不许反问（dsh 第二轮复查）
      for (const message of ["少件的有多少", "丢了多少件", "到了几件", "我有几件货", "我有多少件货", "这个月丢了几单", "少件的有几票",
        // 带服务话题词、问的却是数量（dsh 第三轮：第二版把这些全答成了客服模板）
        "有多少单查不到轨迹", "有几票查不到轨迹", "有多少单在清关", "有多少单还没对账", "有多少单缺装箱单",
        "有多少单需要上门派送", "有多少单开了发票", "有多少单缺资料", "有多少单运费没结", "在途的有多少？",
        "本月清关完成了多少单", "今天派送了几票"]) {
        const r = await ask({ shipments: fx, message });
        assert.ok(/(总单量|符合条件)：/.test(r.answer), `「${message}」问的是数量，应该给数字：\n${r.answer}`);
      }
      for (const message of ["破损了几件怎么办", "有几件货破损了怎么赔", "几件货能寄吗", "丢了几件怎么办", "丢件了几件怎么办", "丢了几单怎么赔",
        "几件货运费多少", "清关要多少天", "几件货要多久到", "运费多少", "清关要几天",
        // Codex 第三轮：问时长的「多少天 / 几小时」、方言「咋办 / 咋赔」
        "签收需要多少天", "派送还要多少小时", "派送还要几小时", "丢了几件该咋办", "丢了几件咋赔"]) {
        const r = await ask({ shipments: fx, message });
        assert.ok(!/(总单量|符合条件)：/.test(r.answer), `「${message}」是服务问题，不该报单量：\n${r.answer}`);
        assert.ok(!/还不太确定/.test(r.answer), `「${message}」是服务问题，不该反问「你想看哪一项」：\n${r.answer}`);
      }
    });

  if (failures.length > 0) {
    throw new Error(`${failures.length}/${totalChecks} 项不通过（TZ=${TZ_LABEL}）：${failures.join("；")}`);
  }
  console.log(`AI 答复数字校验：${totalChecks} 项全部通过（TZ=${TZ_LABEL}）`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
