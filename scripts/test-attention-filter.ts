/** Run the real shared filter and client pagination service with synthetic responses only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.env.FIXTURE_SOURCE_ROOT ?? process.cwd();
const abnormal = ["delayDeparted", "delayInTransit", "borderDelay", "portClosed", "customsInspectCn", "customsInspect", "customsInspectTh", "exception"];
const normal = ["created", "inWarehouseCN", "holdLoading", "loaded", "unloading", "inWarehouseTH", "deliveryBooked", "outForDelivery", "delivered", "returned", "cancelled", "legacyUnknown", "inspectClearedCn", "inspectClearedTh", "customsCleared", null, undefined];
let failures = 0, checks = 0;
async function check(name: string, fn: () => unknown) {
  checks++;
  try { await fn(); console.log("PASS", name); } catch (e) { failures++; console.log("FAIL", name, String(e)); }
}
/** 把真前端源码（TS 转 CJS）装进一个 vm 上下文里跑；两种夹具共用 */
function makeContext(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  const stored = new Map([["auth_session_v1", JSON.stringify({ userId: "fixture-client", companyId: "fixture-company", role: "client", token: "fixture-token" })]]);
  const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k), key: (i: number) => [...stored.keys()][i] ?? null, get length() { return stored.size; } };
  const context = vm.createContext({ window: { localStorage, location: { pathname: "/client" } }, console, URLSearchParams, Response, Request, Headers, AbortController, atob, setTimeout, clearTimeout, process: { env: {} }, fetch: fetchImpl });
  const cache = new Map<string, Record<string, any>>();
  function load(relative: string): Record<string, any> {
    const file = path.resolve(root, relative);
    if (cache.has(file)) return cache.get(file)!;
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} }; cache.set(file, mod.exports);
    const require = (name: string) => { assert.ok(name.startsWith("."), "Unexpected external module: " + name); return load(path.resolve(path.dirname(file), name + (path.extname(name) ? "" : ".ts"))); };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: file })(require, mod, mod.exports);
    return mod.exports;
  }
  return { stored, load };
}

function setup() {
  const requests: { url: URL; init?: RequestInit }[] = [];
  let rows = Array.from({ length: 620 }, (_, i) => ({ id: "order-" + i, currentStatus: i >= 600 && i < 608 ? abnormal[i - 600] : "loaded" }));
  let failPage = 0;
  const { stored, load } = makeContext(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://fixture.invalid"); requests.push({ url, init });
    assert.equal(url.pathname, "/client/orders");
    const page = Number(url.searchParams.get("page")), size = Number(url.searchParams.get("pageSize"));
    return new Response(JSON.stringify(page === failPage ? { code: "ERROR", message: "synthetic page failure" } : { code: "OK", data: { items: rows.slice((page - 1) * size, page * size), total: rows.length } }), { status: page === failPage ? 500 : 200 });
  });
  return { shared: load("packages/shared-types/shipment-status.ts"), service: load("apps/web/src/services/business-api.ts"), requests, stored, rows, fail: (page: number) => { failPage = page; } };
}

/**
 * 真路由夹具（Codex 2026-09-06 复核 P2-3 后补）：前端服务的 fetch 直接打到**真的** GET /client/orders 处理函数，
 * 数据库换成会认 skip/take 的内存桩。这样「后端先 skip/take 再内存筛、total 是筛前的数」这条真实契约
 * 才被测到 —— 上一版夹具是自己切页、又把 total 改成 8，后端 attention 分支整个删掉也照样绿。
 */
function fakeOrder(id: string, currentStatus: string): any {
  return {
    id, clientId: "CLIENT1", warehouseId: "wh_yiwu_01", receiverAddressTh: "曼谷",
    orderNo: `NO-${id}`, itemName: "[测试] 货", transportMode: "sea",
    domesticTrackingNo: null, approvalStatus: "approved",
    productQuantity: 1, packageCount: 1, packageUnit: "box",
    weightKg: null, volumeM3: null, receivableAmountCny: null,
    receivableCurrency: "CNY", paymentStatus: "unpaid", paidAt: null, paidBy: null,
    shipDate: null, cargoType: "normal",
    createdAt: new Date(0), updatedAt: new Date(0),
    shipments: [{ id: `s_${id}`, trackingNo: `T-${id}`, currentStatus, remark: null, statusLogs: [] }],
  };
}
async function setupRealRoute(statusAt: (index: number) => string) {
  process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
  process.env.NODE_ENV = "test";
  const orderRows = Array.from({ length: 620 }, (_, i) => fakeOrder("order-" + i, statusAt(i)));
  (globalThis as any).__prisma = {
    order: {
      async count() { return orderRows.length; },
      async findMany(args: { skip?: number; take?: number }) { return orderRows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? orderRows.length)); },
    },
    shipment: { async findMany() { return []; } },
    orderProductImage: { async findMany() { return []; } },
    orderProduct: { async findMany() { return []; } },
  };
  const routes = new Map<string, (req: any, res: any) => Promise<void> | void>();
  const fakeApp: any = { get(p: string, h: any) { routes.set(`GET ${p}`, h); }, post() {}, put() {}, delete() {}, listen() {} };
  const mod = await import("../apps/api/src/modules/orders/routes");
  (mod as any).registerOrderRoutes(fakeApp);
  const handler = routes.get("GET /client/orders");
  assert.ok(handler, "没注册到 GET /client/orders");
  const pages: { query: Record<string, string>; status: number; items: any[]; total: number }[] = [];
  const { stored, load } = makeContext(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://fixture.invalid");
    assert.equal(url.pathname, "/client/orders");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token");
    const query: Record<string, string> = {}; url.searchParams.forEach((v, k) => { query[k] = v; });
    let status = 0; let payload: any = {};
    const res: any = { status(c: number) { status = c; return res; }, json(v: unknown) { payload = v; } };
    await handler!({ method: "GET", path: "/client/orders", query, headers: {}, body: undefined, auth: { userId: "CLIENT1", companyId: "c_001", role: "client", name: "测试客户", agentId: null } }, res);
    pages.push({ query, status, items: payload?.data?.items ?? [], total: payload?.data?.total ?? -1 });
    return new Response(JSON.stringify(payload), { status });
  });
  return { shared: load("packages/shared-types/shipment-status.ts"), service: load("apps/web/src/services/business-api.ts"), pages, stored };
}
function verifyMembership(fn: (status: unknown, filter: string) => boolean) {
  for (const s of abnormal) assert.equal(fn(s, "attention"), true, "Missing " + s);
  for (const s of normal) assert.equal(fn(s, "attention"), false, "Unexpected " + s);
}
async function main() {
  await check("8 abnormal statuses included; normal stages / returned / cancelled / unknown excluded", () => verifyMembership(setup().shared.matchesShipmentListFilter));
  await check("attention never reclassifies transit, arrived, historical or missing states", () => {
    const { shared } = setup();
    for (const s of [...abnormal, ...normal]) {
      assert.equal(shared.matchesShipmentListFilter(s, "all"), true);
      for (const g of ["pending", "transit", "arrived", "delivered"]) assert.equal(shared.matchesShipmentListFilter(s, g), shared.classifyStatusGroup(s) === g);
    }
    assert.equal(shared.classifyStatusGroup("unloading"), "transit");
    assert.equal(shared.classifyStatusGroup("outForDelivery"), "arrived");
  });
  await check("old API that ignores statusGroup=attention: client still filters abnormal rows beyond page 500 with unchanged auth", async () => {
    // 夹具不认 statusGroup、整页原样返回 —— 模拟没重启的老后端；客户端那道兜底筛必须照样筛对
    const f = setup(), result = await f.service.fetchClientOrders({ statusGroup: "attention" });
    assert.deepEqual(Array.from(result, (r: any) => r.currentStatus).sort(), [...abnormal].sort());
    assert.deepEqual(f.requests.map(r => r.url.searchParams.get("page")), ["1", "2"]);
    for (const r of f.requests) { assert.equal(r.url.searchParams.get("statusGroup"), "attention"); assert.equal(r.url.searchParams.get("pageSize"), "500"); assert.equal(new Headers(r.init?.headers).get("Authorization"), "Bearer fixture-token"); }
    assert.ok(f.stored.has("auth_session_v1"));
  });
  await check("new API that honours statusGroup=attention: server-filtered pages yield the same rows and the param is actually sent", async () => {
    // 2026-09-05 起后端认 attention（每页只回异常单）。这里让夹具按参数筛，结果必须和老后端一致，且请求真的带了参数
    const f = setup();
    const serverFiltered = Array.from({ length: 620 }, (_, i) => ({ id: "order-" + i, currentStatus: i >= 600 && i < 608 ? abnormal[i - 600] : "loaded" }));
    f.rows.length = 0; // 夹具按 rows 切页；换成「服务端已筛过」的行集
    for (const row of serverFiltered.filter((r) => abnormal.includes(r.currentStatus))) f.rows.push(row);
    const result = await f.service.fetchClientOrders({ statusGroup: "attention" });
    assert.deepEqual(Array.from(result, (r: any) => r.currentStatus).sort(), [...abnormal].sort());
    assert.deepEqual(f.requests.map(r => r.url.searchParams.get("page")), ["1"], "服务端筛过后只剩 8 行，应只拉一页");
    assert.ok(f.requests.every((r) => r.url.searchParams.get("statusGroup") === "attention"), "请求必须带 statusGroup=attention，否则后端没法只回异常单");
  });
  await check("REAL route + real client service: server filters attention per page, abnormal rows spread 3/5 across two pages, total stays pre-filter 620", async () => {
    // 异常单故意散在两页：第一页（0..499）放 3 张，第二页（500..619）放 5 张；其余全是在途 loaded
    const spread = new Map<number, string>([[100, abnormal[0]], [200, abnormal[1]], [300, abnormal[2]], [500, abnormal[3]], [510, abnormal[4]], [520, abnormal[5]], [530, abnormal[6]], [540, abnormal[7]]]);
    const f = await setupRealRoute((i) => spread.get(i) ?? "loaded");
    const result = await f.service.fetchClientOrders({ statusGroup: "attention" });
    assert.deepEqual(Array.from(result, (r: any) => r.currentStatus).sort(), [...abnormal].sort(), "两页的异常单没取齐");
    assert.deepEqual(f.pages.map((p) => p.query.page), ["1", "2"], "total 是筛前的 620，必须翻满两页，不许因为第一页只回 3 条就停");
    // ⭐ 服务端真的筛了：每一页回来的都只有异常单。后端 attention 分支被删掉时第一页会回 500 条，这里当场红
    assert.deepEqual(f.pages.map((p) => p.items.length), [3, 5], `每页回的条数不对：${JSON.stringify(f.pages.map((p) => p.items.length))}（后端没按 attention 筛？）`);
    for (const p of f.pages) {
      assert.equal(p.status, 200);
      assert.equal(p.query.statusGroup, "attention", "请求没带 statusGroup=attention");
      assert.equal(p.total, 620, "total 必须是筛前总数（先 skip/take 再内存筛的既定契约），不许被 attention 改掉");
      assert.ok(p.items.every((it: any) => abnormal.includes(it.currentStatus)), "服务端回了非异常单");
      // 异常是关注维度不是阶段：statusGroup 仍是各自阶段（在途 / 关闭），不许被改写成别的
      for (const it of p.items) assert.equal(it.statusGroup, f.shared.classifyStatusGroup(it.currentStatus), `${it.currentStatus} 的阶段被改写成 ${it.statusGroup}`);
    }
    // 对照：同一批数据不带分组，两页各回满
    const all = await setupRealRoute((i) => spread.get(i) ?? "loaded");
    assert.equal((await all.service.fetchClientOrders()).length, 620);
    assert.deepEqual(all.pages.map((p) => p.items.length), [500, 120]);
  });
  await check("resolved abnormal shipment leaves attention on refresh", async () => {
    const f = setup(); assert.equal((await f.service.fetchClientOrders({ statusGroup: "attention" })).length, 8);
    f.rows[600].currentStatus = "loaded";
    const result = await f.service.fetchClientOrders({ statusGroup: "attention" }); assert.equal(result.length, 7); assert.ok(!result.some((r: any) => r.id === "order-600"));
  });
  await check("all and historical/group query parameters remain compatible", async () => {
    for (const statusGroup of [undefined, "pending", "transit", "arrived", "delivered", "closed", "attention"]) {
      const f = setup(); await f.service.fetchClientOrders(statusGroup ? { statusGroup } : undefined);
      assert.ok(f.requests.every(r => r.url.searchParams.get("statusGroup") === (statusGroup ?? null)));
    }
  });
  await check("page failure rejects instead of returning a false empty or partial list", async () => {
    const f = setup(); f.fail(2); await assert.rejects(() => f.service.fetchClientOrders({ statusGroup: "attention" }), /synthetic page failure/);
  });
  await check("mutation guard catches missing inspection and normal unloading leakage", () => {
    const real = setup().shared.matchesShipmentListFilter;
    verifyMembership(real);
    assert.throws(() => verifyMembership((s, g) => s === "customsInspectCn" ? false : real(s, g)));
    assert.throws(() => verifyMembership((s, g) => s === "unloading" ? true : real(s, g)));
    assert.throws(() => verifyMembership((s, g) => s === "returned" ? true : real(s, g)));
  });
  console.log(`CHECKS ${checks}; FAILURES ${failures}`); process.exitCode = failures ? 1 : 0;
}
void main();
