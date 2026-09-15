/**
 * 客户端订单分组（statusGroup）口径自测（2026-09-03 老板当天二次拍板后补）。
 *
 * 为什么要有：这个口径 2026-09-03 一天之内改了两次
 *   ① 早上：到仓后整段从「在途」拆出来 → arrived
 *   ② 下午：老板重新定边界 —— 「正在卸柜」算**在途**（柜子还在卸、货没进仓），
 *      「已到仓」= 进泰国仓到客户签收之前的整段（含预约派送、尾端派送中），
 *      派送不单独分格，签收了才跳「已签收」。
 * 改一次没测试，下次再改（或有人手滑把 unloading 加回 arrived）没人拦得住。
 *
 * 2026-09-03 再补：顶部那排数字（GET /staff|client/shipments/overview）现在跟按钮
 * 共用同一套口径（「已到仓」含预约派送和派送中、「正在卸柜」算在途），也一起盯住——
 * 这两处历史上就是各写各的，顶部显示 119、点按钮出来 159，同一批货两个数。
 *
 * 盯三件事：
 *   1. 31 个真实状态逐个映射对（真调 GET /client/orders 路由，看响应里的 statusGroup，
 *      不是 grep 源码 —— 把分类函数包进 if(false) 这个测试会红）
 *   2. statusGroup= 筛选参数真的只放对应分组的单过（含老页面缓存发的 unfinished/completed）
 *   3. ⭐ 全覆盖闸：直接 import 海运/陆运状态流，凡是流程里出现过的状态
 *      都必须在本文件的期望表里有一行 —— 以后加状态忘了归类，这里当场红
 *
 * ⚠️ 全程不连数据库（照 test-fcl-inquiries.ts 的夹具写法）：import 之前把
 * globalThis.__prisma 换成假的，PrismaClient 根本不会被 new 出来。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { STATUS_FLOW, STATUS_FLOW_LAND, EXCEPTION_STATUSES } from "../apps/api/src/modules/shipments/status-flow";
import { IN_TRANSIT_STATUSES, AT_WAREHOUSE_STATUSES, ATTENTION_STATUSES, isInTransitStatus } from "../packages/shared-types/shipment-status";
import { AI_STATUS_SCOPES } from "../apps/api/src/modules/ai/ai-types";
import { readFileSync } from "node:fs";

type Handler = (req: any, res: any) => Promise<void> | void;
type Group = "pending" | "transit" | "arrived" | "delivered" | "closed";

const failures: string[] = [];
let totalChecks = 0;
async function check(name: string, body: () => Promise<void>): Promise<void> {
  totalChecks += 1;
  try { await body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

/* ── 期望表：状态 → 应该落进哪个按钮。这张表就是老板拍的口径，改口径先改这里 ── */
const EXPECT: Record<string, Group> = {
  // 未发出：货还在国内仓
  created: "pending", inWarehouseCN: "pending", holdLoading: "pending",

  // 在途：从国内仓发出，到进泰国仓之前（含「正在卸柜」）
  loaded: "transit", customsInspectCn: "transit", inspectClearedCn: "transit",
  exportCleared: "transit", customsTH: "transit", customsCleared: "transit",
  delayDeparted: "transit", etaUpdated: "transit", portClosed: "transit",
  berthed: "transit", departed: "transit", delayInTransit: "transit",
  arrivedPort: "transit", customsInspectTh: "transit", inspectClearedTh: "transit",
  atPortCn: "transit", borderDelay: "transit", inVietnam: "transit",
  customsInspect: "transit", laosCleared: "transit",
  // ⭐ 2026-09-03 老板拍板：柜子还在卸、货还没进仓，算在途。别挪走。
  unloading: "transit",

  // 已到仓：进了泰国仓之后、客户签收之前的整段（派送不单独分格）
  inWarehouseTH: "arrived", deliveryBooked: "arrived", outForDelivery: "arrived",

  // 已签收 / 退回取消异常
  delivered: "delivered",
  exception: "closed", returned: "closed", cancelled: "closed",
};

let orderRows: any[] = [];
(globalThis as any).__prisma = {
  order: {
    async count() { return orderRows.length; },
    async findMany() { return orderRows; },
  },
  // 下面几个都不该影响分组，返回空即可（真被调到也不炸）
  shipment: { async findMany() { return []; } },
  orderProductImage: { async findMany() { return []; } },
  orderProduct: { async findMany() { return []; } },
};

function fakeOrder(id: string, currentStatus: string | null): any {
  return {
    id, clientId: "CLIENT1", warehouseId: "wh_yiwu_01", receiverAddressTh: "曼谷",
    orderNo: `NO-${id}`, itemName: "[测试] 货", transportMode: "sea",
    domesticTrackingNo: null, approvalStatus: "approved",
    productQuantity: 1, packageCount: 1, packageUnit: "box",
    weightKg: null, volumeM3: null, receivableAmountCny: null,
    receivableCurrency: "CNY", paymentStatus: "unpaid", paidAt: null, paidBy: null,
    shipDate: null, cargoType: "normal",
    createdAt: new Date(0), updatedAt: new Date(0),
    shipments: currentStatus === null
      ? []
      : [{ id: `s_${id}`, trackingNo: `T-${id}`, currentStatus, remark: null, statusLogs: [] }],
  };
}

async function main(): Promise<void> {
  const routes = new Map<string, Handler>();
  const fakeApp: any = {
    get(p: string, h: Handler) { routes.set(`GET ${p}`, h); },
    post(p: string, h: Handler) { routes.set(`POST ${p}`, h); },
    put(p: string, h: Handler) { routes.set(`PUT ${p}`, h); },
    delete(p: string, h: Handler) { routes.set(`DELETE ${p}`, h); },
    listen() {},
  };
  const mod = await import("../apps/api/src/modules/orders/routes");
  (mod as any).registerOrderRoutes(fakeApp);

  const handler = routes.get("GET /client/orders");
  assert.ok(handler, "没注册到 GET /client/orders");

  async function call(query: Record<string, string> = {}): Promise<{ status: number; items: any[] }> {
    let status = 0;
    let payload: { data?: any } = {};
    const res: any = { status(c: number) { status = c; return res; }, json(v: unknown) { payload = v as typeof payload; } };
    await handler!({
      method: "GET", path: "", query, headers: {}, body: undefined,
      auth: { userId: "CLIENT1", companyId: "c_001", role: "client", name: "测试客户", agentId: null },
    }, res);
    return { status, items: payload.data?.items ?? [] };
  }

  const ALL = Object.keys(EXPECT);
  console.log("客户端订单分组口径（statusGroup）");

  await check(`1) ${ALL.length} 个状态逐个映射对（真走路由，看响应里的 statusGroup）`, async () => {
    orderRows = ALL.map((s, i) => fakeOrder(`o${i}`, s));
    const r = await call();
    assert.equal(r.status, 200, `应该 200，实际 ${r.status}`);
    assert.equal(r.items.length, ALL.length, `不传分组应该全returned，实际 ${r.items.length}`);
    const wrong: string[] = [];
    r.items.forEach((item: any, i: number) => {
      if (item.statusGroup !== EXPECT[ALL[i]]) {
        wrong.push(`${ALL[i]}：期望 ${EXPECT[ALL[i]]}，实际 ${item.statusGroup}`);
      }
    });
    assert.equal(wrong.length, 0, `分错了 ${wrong.length} 个：\n${wrong.join("\n")}`);
  });

  await check("2) ⭐「正在卸柜」必须算在途 —— 老板 09-03 拍板，别挪回已到仓", async () => {
    orderRows = [fakeOrder("u1", "unloading")];
    const r = await call();
    assert.equal(r.items[0]?.statusGroup, "transit", `unloading 该是 transit，实际 ${r.items[0]?.statusGroup}`);
    // 反向再确认一次：点「已到仓」按钮时它不许出现
    orderRows = [fakeOrder("u1", "unloading")];
    const arrivedOnly = await call({ statusGroup: "arrived" });
    assert.equal(arrivedOnly.items.length, 0, "点「已到仓」不该查出正在卸柜的单");
  });

  await check("3)「已到仓」= 已到仓 + 预约派送 + 派送中（派送不单独分格，签收了才走）", async () => {
    orderRows = ALL.map((s, i) => fakeOrder(`o${i}`, s));
    const r = await call({ statusGroup: "arrived" });
    const got = r.items.map((x: any) => x.currentStatus).sort();
    assert.deepEqual(got, ["deliveryBooked", "inWarehouseTH", "outForDelivery"].sort(),
      `「已到仓」查出来的状态不对：${JSON.stringify(got)}`);
  });

  await check("4) 五个分组的筛选参数各自只放对的单过，加起来不多不少", async () => {
    let sum = 0;
    for (const group of ["pending", "transit", "arrived", "delivered", "closed"] as Group[]) {
      orderRows = ALL.map((s, i) => fakeOrder(`o${i}`, s));
      const r = await call({ statusGroup: group });
      const expected = ALL.filter((s) => EXPECT[s] === group);
      const got = r.items.map((x: any) => x.currentStatus).sort();
      assert.deepEqual(got, [...expected].sort(), `${group} 查出来的不对：${JSON.stringify(got)}`);
      const bad = r.items.find((x: any) => x.statusGroup !== group);
      assert.ok(!bad, `${group} 里混进了 ${bad?.currentStatus}（${bad?.statusGroup}）`);
      sum += r.items.length;
    }
    assert.equal(sum, ALL.length, `五个分组加起来 ${sum}，应该正好 ${ALL.length} 张，有单丢了或重了`);
  });

  await check("4b) statusGroup=attention 只放 ATTENTION_STATUSES 的单过（2026-09-05 起后端也认，客户端不再整页拉全量）", async () => {
    orderRows = ALL.map((s, i) => fakeOrder(`o${i}`, s));
    const r = await call({ statusGroup: "attention" });
    const got = r.items.map((x: any) => x.currentStatus).sort();
    const expected = ALL.filter((s) => (ATTENTION_STATUSES as readonly string[]).includes(s)).sort();
    assert.ok(expected.length >= 8, `期望表里的异常状态少于 8 个（${expected.length}），夹具本身不对`);
    assert.deepEqual(got, expected, `「异常」查出来的不对：${JSON.stringify(got)}`);
    // 异常是关注维度、不改阶段：这些单的 statusGroup 仍是各自的阶段（在途/关闭），不许被改写成别的
    for (const item of r.items) assert.equal(item.statusGroup, EXPECT[item.currentStatus], `${item.currentStatus} 的阶段被改写成了 ${item.statusGroup}`);
    // 反向：正常卸柜 / 派送中 / 已签收 不许混进来
    orderRows = [fakeOrder("n1", "unloading"), fakeOrder("n2", "outForDelivery"), fakeOrder("n3", "delivered")];
    assert.equal((await call({ statusGroup: "attention" })).items.length, 0, "正常状态混进了「异常」");
  });

  await check("5) 老页面缓存发的 unfinished / completed 还认（unfinished 含已到仓）", async () => {
    orderRows = ALL.map((s, i) => fakeOrder(`o${i}`, s));
    const un = await call({ statusGroup: "unfinished" });
    const unExpect = ALL.filter((s) => ["pending", "transit", "arrived"].includes(EXPECT[s]));
    assert.deepEqual(un.items.map((x: any) => x.currentStatus).sort(), [...unExpect].sort(),
      "unfinished 应该 = 未发出 + 在途 + 已到仓");
    orderRows = ALL.map((s, i) => fakeOrder(`o${i}`, s));
    const done = await call({ statusGroup: "completed" });
    const doneExpect = ALL.filter((s) => ["delivered", "closed"].includes(EXPECT[s]));
    assert.deepEqual(done.items.map((x: any) => x.currentStatus).sort(), [...doneExpect].sort(),
      "completed 应该 = 已签收 + 退回取消异常");
  });

  await check("6) 没运单 / 状态为空的老数据归「未发出」，不许漏出别的格", async () => {
    orderRows = [fakeOrder("n1", null), fakeOrder("n2", "")];
    const r = await call();
    assert.deepEqual(r.items.map((x: any) => x.statusGroup), ["pending", "pending"],
      "没运单和空状态都该是 pending");
  });

  await check("7) 不认识的状态兜底进「在途」，绝不凭空消失", async () => {
    orderRows = [fakeOrder("x1", "someNewStatusNobodyClassified")];
    const all = await call();
    assert.equal(all.items[0]?.statusGroup, "transit", "陌生状态该兜底进 transit");
    orderRows = [fakeOrder("x1", "someNewStatusNobodyClassified")];
    const un = await call({ statusGroup: "unfinished" });
    assert.equal(un.items.length, 1, "陌生状态在 unfinished 里也要看得到，不能整单消失");
  });

  await check("8) ⭐ 全覆盖闸：海运/陆运流程 + 异常态里每个状态都在期望表里", async () => {
    const inFlow = new Set<string>([...STATUS_FLOW, ...STATUS_FLOW_LAND, ...EXCEPTION_STATUSES]);
    const missing = [...inFlow].filter((s) => !(s in EXPECT));
    assert.equal(missing.length, 0,
      `这些状态在流程里有、但本测试的期望表没归类（新加状态要来这里补一行，并确认老板要它落哪个按钮）：${missing.join(", ")}`);
    // 反向：期望表里不许有流程里根本不存在的状态（防止照着旧文档抄错状态名）
    const ghost = ALL.filter((s) => !inFlow.has(s));
    assert.equal(ghost.length, 0, `期望表里这些状态在两条流程里都不存在，可能拼错了：${ghost.join(", ")}`);
  });

  /* ══════════ 顶部那排数字（三端共用 countShipmentOverview）══════════
     这里换一套假库：按 where.currentStatus 回答条数，真调 overview 路由。 */
  const DIST: Record<string, number> = {
    // ⚠️ 这三个都必须非 0：全填 0 的话「未发出 vs 在途」那条边界等于没测——
    //    后端要是把 inWarehouseCN 漏出「未发出」，减法会把它算进在途而测试照样绿。
    created: 86, inWarehouseCN: 9, holdLoading: 5,
    loaded: 100, customsInspectCn: 12, departed: 168, etaUpdated: 28,
    customsTH: 140, customsCleared: 21, atPortCn: 34, inVietnam: 14,
    laosCleared: 14, delayDeparted: 4, unloading: 20,
    inWarehouseTH: 119, deliveryBooked: 7, outForDelivery: 40,
    delivered: 1558, exception: 3, returned: 2, cancelled: 1,
  };
  const TOTAL = Object.values(DIST).reduce((a, b) => a + b, 0);

  function countByWhere(where: any): number {
    const cs = where?.currentStatus;
    if (cs === undefined) return TOTAL;
    const keys: string[] = typeof cs === "string" ? [cs] : (cs.in ?? []);
    // 「本月已签收」那条额外带 updatedAt；这里全部当成本月内
    return keys.reduce((sum, k) => sum + (DIST[k] ?? 0), 0);
  }
  (globalThis as any).__prisma.shipment.count = async (args: any) => countByWhere(args?.where);

  const shipMod = await import("../apps/api/src/modules/shipments/routes");
  (shipMod as any).registerShipmentRoutes(fakeApp);

  async function overview(path: string, role: string): Promise<any> {
    let payload: { data?: any } = {};
    const res: any = { status() { return res; }, json(v: unknown) { payload = v as typeof payload; } };
    const h = routes.get(`GET ${path}`);
    assert.ok(h, `没注册到 GET ${path}`);
    await h!({ method: "GET", path: "", query: {}, headers: {}, body: undefined,
      auth: { userId: "CLIENT1", companyId: "c_001", role, name: "测试", agentId: null } }, res);
    return payload.data;
  }

  await check("9) 顶部「已到仓」= 已到仓 + 预约派送 + 派送中（跟按钮一个口径）", async () => {
    const d = await overview("/staff/shipments/overview", "staff");
    const want = DIST.inWarehouseTH + DIST.deliveryBooked + DIST.outForDelivery;
    assert.equal(d.atWarehouseCount, want,
      `该是 ${want}（119+7+40），实际 ${d.atWarehouseCount}——只数 inWarehouseTH 就会是 119`);
  });

  await check("10) ⭐ 顶部「在途」和按钮「在途」必须是同一个数（含正在卸柜）", async () => {
    const d = await overview("/staff/shipments/overview", "staff");
    /* 按钮口径：从 EXPECT 表取 transit 那批来加。
       ⚠️ EXPECT 不是凭空写的：第 1 项已经拿它跟**真路由返回的 statusGroup** 逐个比对过，
       所以「EXPECT = 真分类函数」这一环是被第 1 项钉死的，这里不是自己跟自己比。 */
    const byButton = Object.entries(DIST)
      .filter(([st]) => EXPECT[st] === "transit")
      .reduce((sum, [, n]) => sum + n, 0);
    assert.equal(d.inTransitCount, byButton,
      `顶部在途 ${d.inTransitCount} ≠ 按钮在途 ${byButton}，两边口径又分家了`);
    assert.ok(byButton >= DIST.unloading, "正在卸柜没算进在途");
  });

  await check("11) 对账等式：未发出 + 已到仓 + 已完成 + 异常 + 在途 = 总数（一张不丢不重）", async () => {
    const d = await overview("/staff/shipments/overview", "staff");
    const sum = d.createdCount + d.atWarehouseCount + d.doneCount + d.exceptionCount + d.inTransitCount;
    assert.equal(sum, d.totalCount,
      `加起来 ${sum} ≠ 总数 ${d.totalCount}——派送中被减两次的话这里会少 ${DIST.outForDelivery}`);
    assert.equal(d.totalCount, TOTAL);
  });

  await check("12) 客户端和员工端顶部口径完全一致（只有 where 不同）", async () => {
    const a = await overview("/staff/shipments/overview", "staff");
    const b = await overview("/client/shipments/overview", "client");
    for (const k of ["inTransitCount", "attentionCount", "atWarehouseCount", "doneCount"]) {
      assert.equal(a[k], b[k], `${k} 两端不一样：员工 ${a[k]} / 客户 ${b[k]}`);
    }
  });

  await check("13) ⭐ 共享清单闸：IN_TRANSIT_STATUSES / AT_WAREHOUSE_STATUSES 必须跟期望表逐字一致", async () => {
    /* 2026-09-03 复核挖出来的洞：老板拍板后只改了客户端两处，
       packages/shared-types 里的 IN_TRANSIT_STATUSES 仍把「已到仓/预约派送/派送中」
       算成在途，而管理员看板 KPI、管理员状态分布图、AI 问答三处都吃这份清单——
       同一个后台「在途」两个数。现在三处统一从共享清单取，这道闸把清单钉在期望表上：
       谁再往一边加状态、另一边忘了跟，这里当场红。 */
    const wantTransit = ALL.filter((s) => EXPECT[s] === "transit").sort();
    const gotTransit = [...IN_TRANSIT_STATUSES].sort();
    assert.deepEqual(gotTransit, wantTransit,
      `共享的「在途」清单跟按钮口径对不上：\n  多了 ${gotTransit.filter((x) => !wantTransit.includes(x)).join(",") || "无"}` +
      `\n  少了 ${wantTransit.filter((x) => !gotTransit.includes(x as any)).join(",") || "无"}`);

    const wantArrived = ALL.filter((s) => EXPECT[s] === "arrived").sort();
    assert.deepEqual([...AT_WAREHOUSE_STATUSES].sort(), wantArrived,
      "共享的「已到仓」清单跟按钮口径对不上");

    assert.ok(IN_TRANSIT_STATUSES.includes("unloading" as any),
      "「正在卸柜」被从共享的在途清单里拿掉了——老板口径是它算在途");
    assert.ok(!AT_WAREHOUSE_STATUSES.some((x) => IN_TRANSIT_STATUSES.includes(x)),
      "「已到仓」的状态同时出现在「在途」清单里，两格会重复计数");
  });

  await check("14) isInTransitStatus 对 31 个状态的判断必须跟按钮口径一字不差", async () => {
    const wrong: string[] = [];
    for (const st of ALL) {
      const want = EXPECT[st] === "transit";
      if (isInTransitStatus(st) !== want) {
        wrong.push(`${st}：按钮说${want ? "在途" : "不在途"}，isInTransitStatus 说${want ? "不在途" : "在途"}`);
      }
    }
    assert.equal(wrong.length, 0, `AI 和按钮会给客户两个数：\n${wrong.join("\n")}`);
  });

  await check("15) ⭐ 老状态必须兜底进「在途」——白名单会把它们数丢", async () => {
    /* 2026-09-03 复核实测：管理员 KPI 用 IN_TRANSIT_STATUSES 白名单数出 14，
       顶部数字用减法数出 17，差的三张就是这几个只在老数据里出现、
       流程表里查不到的状态。判断单张运单一律用排除法的 isInTransitStatus。 */
    for (const legacy of ["pickedUp", "customsPending", "inTransit", "receivedCN", "someStatusFromTheFuture"]) {
      assert.ok(isInTransitStatus(legacy), `老状态「${legacy}」被判成不在途，这批货会从「在途」里消失`);
      assert.ok(!IN_TRANSIT_STATUSES.includes(legacy as any),
        `「${legacy}」竟然在白名单里了——这条断言是用来说明「白名单会漏、排除法不会」的，前提变了要重写`);
    }
    assert.equal(isInTransitStatus(null), false, "没状态不该算在途");
    assert.equal(isInTransitStatus(""), false, "空状态不该算在途");
  });

  await check("16) ⭐「延迟/查验」那格必须罩住全部查验类状态（含国内、泰国）", async () => {
    /* 2026-09-03 复核挖出来的：这份名单原来是手写的
       [delayDeparted, delayInTransit, borderDelay, customsInspect, exception]，
       漏掉国内海关查验、泰国海关查验、港口封港。
       「国内海关查验」是 08-13 加进流程的，加的时候没人回来补这份名单，
       被扣在国内查验的货因此一直不进这一格 —— 那正是最该提醒的一种货。
       现在查验类从流程表推导，这道闸盯着它别再漏。 */
    const allFlow = new Set<string>([...STATUS_FLOW, ...STATUS_FLOW_LAND]);
    const 全部查验类 = [...allFlow].filter((s) => s.startsWith("customsInspect"));
    assert.ok(全部查验类.length >= 3, `流程表里查验类只找到 ${全部查验类.length} 个，太少了，推导规则可能失效`);
    const missing = 全部查验类.filter((s) => !ATTENTION_STATUSES.includes(s as any));
    assert.equal(missing.length, 0, `这些查验状态没进「延迟/查验」：${missing.join(", ")}`);

    for (const must of ["delayDeparted", "delayInTransit", "borderDelay", "portClosed", "exception"]) {
      assert.ok(ATTENTION_STATUSES.includes(must as any), `「${must}」不在「延迟/查验」里`);
    }
    // 正常在途的货不该被塞进这一格，否则这个数字天天亮着就没人看了
    for (const normal of ["loaded", "departed", "inWarehouseTH", "delivered", "created"]) {
      assert.ok(!ATTENTION_STATUSES.includes(normal as any), `「${normal}」是正常状态，不该进「延迟/查验」`);
    }

    /* ⭐ 关键的一条：上面只证明了「共享清单是对的」，不证明**顶部那格真的在用它**。
       复核实测：把 overview-counts.ts 改回手写旧清单，上面几条照样全绿。
       所以这里真调 /staff/shipments/overview，拿返回的 attentionCount 对数。 */
    const d = await overview("/staff/shipments/overview", "staff");
    const 应该是 = ATTENTION_STATUSES.reduce((sum, st) => sum + (DIST[st] ?? 0), 0);
    assert.equal(d.attentionCount, 应该是,
      `顶部「延迟/查验」返回 ${d.attentionCount}，按共享清单该是 ${应该是}——` +
      `说明那边没在用 ATTENTION_STATUSES（比如又改回手写清单了）`);
    assert.ok(DIST.customsInspectCn > 0, "样本里得有国内海关查验的单，不然这条等于没测");
    assert.ok(d.attentionCount >= DIST.customsInspectCn,
      `国内海关查验那 ${DIST.customsInspectCn} 张没算进「延迟/查验」`);
  });

  await check("17) AI 范围清单的接线闸（真问真答在 test-ai-answer-numbers 第 64~68 项）", async () => {
    /* ⚠️ 这一项只证明「清单和提示词接对了线」，**不证明 AI 真能答对**。
       复核实测：把 matchStatusScope 里的 arrived 分支删掉，这一项照样绿。
       客户实际问话的验证在 scripts/test-ai-answer-numbers.ts 第 64~68 项
       （真造运单、真走 service.chat、看客户收到的那段字），别只靠这一条。 */
    /* 这串清单原来在 5 个地方各写一遍（类型、解析白名单、给模型看的提示词、
       两处 as 断言）。加「已到仓」时前三处漏改，提示词那句漏了模型就根本
       不知道有这个选项。现在都从 AI_STATUS_SCOPES 取，这道闸盯着别再散开。 */
    assert.ok(AI_STATUS_SCOPES.includes("arrived" as any), "AI 没有「已到仓」这个查询范围");
    for (const must of ["all", "inTransit", "completed", "unfinished", "exception"]) {
      assert.ok(AI_STATUS_SCOPES.includes(must as any), `AI 范围清单少了 ${must}`);
    }
    // 提示词里给模型的可选值就是这份清单拼出来的，不能再手写
    const src = readFileSync(new URL("../apps/api/src/modules/ai/ai-service.ts", import.meta.url), "utf8");
    assert.ok(src.includes("AI_STATUS_SCOPES.join(\"|\")"),
      "给模型看的提示词没有用 AI_STATUS_SCOPES 拼，又变回手写清单了");
    assert.ok(!/statusScope: "all\|inTransit\|completed/.test(src),
      "提示词里还留着写死的旧清单");
  });

  await check("18) ⭐ 管理员导出的「状态组」是实时算的，不是数据库那个死字段", async () => {
    /* 2026-09-03 复核挖出来的：这一列原来直接发数据库 orders.status_group，
       而**全系统没有任何代码更新过它** —— 生产库 1252 张单全是 "unfinished"。
       管理员导出的 Excel 里那一列因此永远是同一个英文单词，等于废列。
       这个用例故意让数据库字段和运单真实状态**对着干**：
       库里写着 unfinished，货其实已经到泰国仓了。要是还读库里那个字段，这里就红。 */
    const 造假单 = (id: string, currentStatus: string) => ({
      id, orderId: `o_${id}`, trackingNo: `T-${id}`, parentTrackingNo: null,
      currentStatus, batchNo: null, containerNo: null, domesticTrackingNo: null,
      packageCount: 1, weightKg: null, volumeM3: null, remark: null,
      warehouseId: "wh_yiwu_01", transportMode: "sea",
      createdAt: new Date(0), updatedAt: new Date(0),
      order: {
        id: `o_${id}`, clientId: "CLIENT1", itemName: "测试", productQuantity: 1,
        packageUnit: "box", cargoType: "normal", approvalStatus: "approved",
        receivableAmountCny: null, receivableCurrency: "CNY", paymentStatus: "unpaid",
        paidAt: null, paidBy: null, shipDate: null, weightKg: null, volumeM3: null,
        createdAt: new Date(0),
        statusGroup: "unfinished",
        client: { name: "测试客户" },
      },
    });
    const 样本 = [
      造假单("a", "inWarehouseTH"), 造假单("b", "unloading"),
      造假单("c", "created"), 造假单("d", "delivered"), 造假单("e", "outForDelivery"),
    ];
    (globalThis as any).__prisma.shipment.count = async () => 样本.length;
    (globalThis as any).__prisma.shipment.findMany = async () => 样本;
    (globalThis as any).__prisma.orderProduct = { async findMany() { return []; } };

    const adminMod = await import("../apps/api/src/modules/admin/routes");
    (adminMod as any).registerAdminRoutes(fakeApp);
    const h = routes.get("GET /admin/orders");
    assert.ok(h, "没注册到 GET /admin/orders");
    let payload: { data?: any } = {};
    const res: any = { status() { return res; }, json(v: unknown) { payload = v as typeof payload; } };
    await h!({ method: "GET", path: "", query: {}, headers: {}, body: undefined,
      auth: { userId: "A1", companyId: "c_001", role: "admin", name: "管理员", agentId: null } }, res);

    const items = payload.data?.items ?? [];
    assert.equal(items.length, 5, `应该返回 5 条，实际 ${items.length}`);
    const got = Object.fromEntries(items.map((x: any) => [x.currentStatus, x.statusGroup]));
    assert.deepEqual(got, {
      inWarehouseTH: "arrived", unloading: "transit",
      created: "pending", delivered: "delivered", outForDelivery: "arrived",
    }, `状态组算错了（库里那个字段全是 unfinished，如果结果里出现 unfinished 就是还在读死字段）：${JSON.stringify(got)}`);
    assert.ok(!items.some((x: any) => x.statusGroup === "unfinished"),
      "还在发数据库那个从没更新过的 status_group 字段");
  });

  console.log(`\n共 ${totalChecks} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  console.log("✅ 全部通过");
}

main().catch((error) => { console.error(error); process.exit(1); });
