/**
 * 运营看板直观化回归：真编译/渲染页面挂载的组件，执行真实分组与取数回调。
 * 不启动服务器、不发网络请求、不连接数据库；所有请求只用可控内存 Promise。
 * 静态 HTML 能证明显示内容和接线，不能代替真实浏览器的手机布局验收。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

type RecordValue = Record<string, any>;
const root = path.resolve("apps/web/src");
const pageFile = path.join(root, "app/admin/page.tsx");
const componentFile = path.join(root, "components/admin/AdminOperationsOverview.tsx");
const requireWeb = createRequire(pageFile);
const cache = new Map<string, RecordValue>();
function compile(source: string, filename: string, requireFn: (id: string) => any = requireWeb): RecordValue {
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(exports,require,module){${output}\n})`, {}, { filename })(module.exports, requireFn, module);
  return module.exports;
}
function load(filename: string): RecordValue {
  const previous = cache.get(filename);
  if (previous) return previous;
  const exports = compile(readFileSync(filename, "utf8"), filename, (id) => {
    if (id.endsWith(".module.css")) {
      // Node 不执行 CSS；只映射真实样式类名，组件 JSX、数值与分支均执行生产实现。
      const css = readFileSync(path.resolve(path.dirname(filename), id), "utf8");
      const classes = Object.fromEntries([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => [match[1], match[1]]));
      return { default: classes };
    }
    if (!id.startsWith(".")) {
      assert.ok(["react", "react/jsx-runtime", "react-dom/server"].includes(id), `Unexpected external import: ${id}`);
      return requireWeb(id);
    }
    const base = path.resolve(path.dirname(filename), id);
    const resolved = [base + ".ts", base + ".tsx", base].find(existsSync);
    assert.ok(resolved, `Missing import: ${id}`);
    return load(resolved);
  });
  cache.set(filename, exports);
  return exports;
}
const pageSource = readFileSync(pageFile, "utf8");
const ast = ts.createSourceFile(pageFile, pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNodes<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  (function visit(node: ts.Node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); })(ast);
  return found;
}
function variable(name: string): ts.VariableDeclaration {
  const matches = findNodes((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
  assert.equal(matches.length, 1, `须定位页面真实变量 ${name}`);
  assert.ok(matches[0].initializer, `${name} 没有 initializer`);
  return matches[0];
}
function pageExpression(name: string, bindings: RecordValue): any {
  const contextNames = Object.keys(bindings);
  const run = compile(`export default function run(ctx: any) {
    const { ${contextNames.join(", ")} } = ctx;
    return (${variable(name).initializer!.getText(ast)});
  }`, `mounted-${name}.tsx`).default;
  return run(bindings);
}
function textContent(html: string): string {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}
function contains(html: string, values: string[]): void {
  const content = textContent(html);
  for (const value of values) assert.ok(content.includes(value), `看板漏显示 ${JSON.stringify(value)}\n实际：${content}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { deadline: number; callback: () => void }>();
  const setTimeout = (callback: () => void, delay = 0) => {
    const id = ++nextId;
    pending.set(id, { deadline: now + delay, callback });
    return id;
  };
  const clearTimeout = (id: number) => { pending.delete(id); };
  function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const next = [...pending].filter(([, timer]) => timer.deadline <= target).sort((a, b) => a[1].deadline - b[1].deadline)[0];
      if (!next) break;
      pending.delete(next[0]);
      now = next[1].deadline;
      next[1].callback();
    }
    now = target;
  }
  return { pending, setTimeout, clearTimeout, advance };
}
const tests: Array<[string, () => unknown | Promise<unknown>]> = [];
function test(name: string, body: () => unknown | Promise<unknown>) { tests.push([name, body]); }

// 真服务包装函数也执行：只把最底层 fetch 换成内存桩，证明 signal 没在中间丢掉。
const apiFile = path.join(root, "services/business-api.ts");
const apiAst = ts.createSourceFile(apiFile, readFileSync(apiFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function serviceWrapper(name: string, bindings: RecordValue): (signal?: AbortSignal) => Promise<unknown> {
  const declarations = apiAst.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(declarations.length, 1, `须定位真实 API 包装函数 ${name}`);
  const body = declarations[0].getText(apiAst).replace(/^export\s+/, "");
  return compile(`export default function build(ctx: any) {
    const { fetch, apiBaseUrl, authHeaders, parseApiResponse } = ctx;
    ${body}
    return ${name};
  }`, `mounted-${name}.ts`).default(bindings);
}
for (const [name, endpoint] of [["fetchAdminOverview", "/admin/dashboard/overview"], ["fetchAdminOpsOverview", "/admin/ops/overview"]]) {
  test(`${name} 真服务包装透传signal，旧无参调用/GET路径/认证及响应拆包不变`, async () => {
    for (const withSignal of [false, true]) {
      const response = { fixture: "raw response" };
      const payload = { fixture: "parsed payload" };
      const controller = new AbortController();
      let calls = 0;
      const call = serviceWrapper(name, {
        apiBaseUrl: () => "https://fixture.invalid", authHeaders: () => ({ Authorization: "Bearer fixture" }),
        fetch: async (url: string, options: RecordValue) => {
          calls++;
          assert.equal(url, `https://fixture.invalid${endpoint}`);
          assert.equal(options.method, "GET");
          assert.equal(options.headers.Authorization, "Bearer fixture");
          assert.equal(options.signal, withSignal ? controller.signal : undefined);
          return response;
        },
        parseApiResponse: async (raw: unknown) => { assert.equal(raw, response); return payload; },
      });
      assert.equal(await call(withSignal ? controller.signal : undefined), payload);
      assert.equal(calls, 1);
    }
  });
}

const sharedStatus = load(path.resolve("packages/shared-types/shipment-status.ts"));
function countShipments(rows: RecordValue[]) {
  const count = pageExpression("shipmentCounts", {
    useMemo: (callback: () => unknown) => callback(), orderList: rows,
    AT_WAREHOUSE_STATUSES: sharedStatus.AT_WAREHOUSE_STATUSES,
    COMPLETED_STATUSES: sharedStatus.COMPLETED_STATUSES,
  });
  return JSON.parse(JSON.stringify(count));
}
type Bucket = "processing" | "inTransit" | "atWarehouse" | "delivered" | "exception";
const expectedGroups: Record<string, Bucket> = {
  "": "processing", created: "processing", inWarehouseCN: "processing", holdLoading: "processing",
  loaded: "inTransit", customsInspectCn: "inTransit", inspectClearedCn: "inTransit", exportCleared: "inTransit",
  delayDeparted: "inTransit", etaUpdated: "inTransit", portClosed: "inTransit", berthed: "inTransit",
  departed: "inTransit", delayInTransit: "inTransit", arrivedPort: "inTransit", customsInspectTh: "inTransit",
  inspectClearedTh: "inTransit", customsTH: "inTransit", customsCleared: "inTransit", unloading: "inTransit",
  atPortCn: "inTransit", borderDelay: "inTransit", inVietnam: "inTransit", customsInspect: "inTransit", laosCleared: "inTransit",
  pickedUp: "inTransit", customsPending: "inTransit", inTransit: "inTransit", historicalUnknown: "inTransit",
  inWarehouseTH: "atWarehouse", deliveryBooked: "atWarehouse", outForDelivery: "atWarehouse",
  delivered: "delivered", returned: "exception", cancelled: "exception", exception: "exception",
};
test("真实页面分组覆盖海陆流程全部状态，未知旧状态仍为在途", () => {
  for (const status of [...sharedStatus.SHIPMENT_STATUS_FLOW, ...sharedStatus.SHIPMENT_STATUS_FLOW_LAND]) {
    assert.ok(Object.hasOwn(expectedGroups, status), `新状态 ${status} 须明确归类，不能默默漏测`);
  }
  for (const [currentStatus, group] of Object.entries(expectedGroups)) {
    const expected = { processing: 0, inTransit: 0, atWarehouse: 0, delivered: 0, exception: 0 };
    expected[group] = 1;
    for (const approvalStatus of ["approved", "pending", "rejected"]) {
      assert.deepEqual(countShipments([{ currentStatus, approvalStatus }]), expected, `${currentStatus}/${approvalStatus} 分错组`);
    }
  }
  assert.equal(countShipments([{ currentStatus: null }, {}]).processing, 2, "缺失状态仍属于未发出");
});
test("真实页面分组逐票计数且不改输入，空列表是五个真实 0", () => {
  const rows = Object.keys(expectedGroups).map((currentStatus) => Object.freeze({ currentStatus }));
  const before = JSON.stringify(rows);
  const counts = countShipments(rows);
  assert.equal(Object.values(counts).reduce((sum: number, n) => sum + Number(n), 0), rows.length);
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(countShipments([]), { processing: 0, inTransit: 0, atWarehouse: 0, delivered: 0, exception: 0 });
});

function overviewLoader(kind: "overview" | "ops", seed: RecordValue | null = null, failed = false) {
  const state = { data: seed, error: failed, calls: 0 };
  const ref = { current: false };
  const clock = fakeClock();
  const requests: Array<ReturnType<typeof deferred<RecordValue>> & { signal?: AbortSignal }> = [];
  const fetch = (signal?: AbortSignal) => {
    state.calls++;
    const request = { ...deferred<RecordValue>(), signal };
    requests.push(request);
    const onAbort = () => { request.reject(new Error("fixture request aborted")); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    void request.promise.then(
      () => signal?.removeEventListener("abort", onAbort),
      () => signal?.removeEventListener("abort", onAbort),
    );
    return request.promise;
  };
  const run: () => Promise<unknown> = pageExpression(kind === "overview" ? "loadOverview" : "loadOpsOverview", {
    useCallback: (callback: unknown) => callback,
    AbortController, window: clock, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    overviewInFlight: ref, opsOverviewInFlight: ref,
    fetchAdminOverview: fetch, fetchAdminOpsOverview: fetch,
    setOverview: (value: RecordValue) => { state.data = value; },
    setOpsOverview: (value: RecordValue) => { state.data = value; },
    setOverviewError: (value: boolean) => { state.error = value; },
    setOpsError: (value: boolean) => { state.error = value; },
  });
  return { state, ref, requests, run, clock };
}
for (const kind of ["overview", "ops"] as const) {
  test(`${kind} 首次请求期间不伪造数据，重复调用复用未完成请求`, async () => {
    const loader = overviewLoader(kind);
    const first = loader.run();
    const duplicate = loader.run();
    assert.equal(loader.state.calls, 1, "轮询不应重复发起仍在途的总览请求");
    assert.equal(loader.state.data, null);
    assert.equal(loader.state.error, false);
    loader.requests[0].resolve({ fixture: "first" });
    await Promise.all([first, duplicate]);
    assert.deepEqual(loader.state.data, { fixture: "first" });
    assert.equal(loader.ref.current, false, "成功也必须释放 inFlight");
  });
  test(`${kind} 首次失败不变成 0，失败后解锁允许恢复`, async () => {
    const loader = overviewLoader(kind);
    const first = loader.run();
    loader.requests[0].reject(new Error("fixture unavailable"));
    await assert.rejects(first, /fixture unavailable/);
    assert.equal(loader.state.data, null);
    assert.equal(loader.state.error, true);
    assert.equal(loader.ref.current, false, "失败必须 finally 释放 inFlight");
    const recovery = loader.run();
    assert.equal(loader.state.calls, 2);
    loader.requests[1].resolve({ fixture: "recovered" });
    await recovery;
    assert.deepEqual(loader.state.data, { fixture: "recovered" });
    assert.equal(loader.state.error, false);
  });
  test(`${kind} 刷新失败保留旧数，重试未成功前错误提示不能提前消失`, async () => {
    const old = { fixture: "previous" };
    const loader = overviewLoader(kind, old);
    const first = loader.run();
    assert.equal(loader.state.data, old);
    loader.requests[0].reject(new Error("fixture refresh failed"));
    await assert.rejects(first, /fixture refresh failed/);
    assert.equal(loader.state.data, old);
    assert.equal(loader.state.error, true);
    const recovery = loader.run();
    assert.equal(loader.state.error, true, "只有刷新成功才能取消旧数据提示");
    assert.equal(loader.state.data, old);
    loader.requests[1].resolve({ fixture: "fresh" });
    await recovery;
    assert.equal(loader.state.error, false);
    assert.equal(loader.state.data?.fixture, "fresh");
  });
  test(`${kind} 请求30秒有界超时会中断，保留旧数并解锁，后续刷新能恢复`, async () => {
    const previous = { fixture: "previous before timeout" };
    const loader = overviewLoader(kind, previous);
    const first = loader.run();
    const signal = loader.requests[0].signal;
    assert.ok(signal, "真实取数调用必须传入 AbortSignal，不能只安排一个不影响请求的定时器");
    assert.equal(loader.clock.pending.size, 1, "总览请求必须设置有界超时，不能永久锁住inFlight");
    assert.equal([...loader.clock.pending.values()][0].deadline, 30000);
    loader.clock.advance(29999);
    assert.equal(signal.aborted, false, "30秒前不应提前中断");
    assert.equal(loader.state.error, false);
    loader.clock.advance(1);
    assert.equal(signal.aborted, true, "达到30秒应主动中断请求");
    await assert.rejects(first, /fixture request aborted/);
    assert.equal(loader.state.error, true);
    assert.equal(loader.state.data, previous);
    assert.equal(loader.ref.current, false);
    assert.equal(loader.clock.pending.size, 0);
    const retry = loader.run();
    assert.equal(loader.state.calls, 2, "超时后下一轮必须能真实重新发请求");
    loader.requests[1].resolve({ fixture: "fresh after timeout" });
    await retry;
    assert.equal(loader.state.error, false);
    assert.deepEqual(loader.state.data, { fixture: "fresh after timeout" });
    assert.equal(loader.clock.pending.size, 0);
  });
  test(`${kind} 首次请求超时不冒充零数据，成功或普通失败均取消超时器`, async () => {
    const firstLoader = overviewLoader(kind);
    const first = firstLoader.run();
    assert.ok(firstLoader.requests[0].signal);
    firstLoader.clock.advance(30000);
    await assert.rejects(first, /fixture request aborted/);
    assert.equal(firstLoader.state.data, null);
    assert.equal(firstLoader.state.error, true);
    assert.equal(firstLoader.ref.current, false);
    for (const fail of [false, true]) {
      const loader = overviewLoader(kind);
      const request = loader.run();
      const signal = loader.requests[0].signal;
      assert.ok(signal);
      if (fail) {
        loader.requests[0].reject(new Error("fixture ordinary error"));
        await assert.rejects(request, /fixture ordinary error/);
      } else {
        loader.requests[0].resolve({ fixture: "fast" });
        await request;
      }
      assert.equal(loader.clock.pending.size, 0, "请求完成后必须清理timer");
      loader.clock.advance(30000);
      assert.equal(signal.aborted, false, "已结束的请求不能仍被泄漏的timer中断");
      assert.equal(loader.ref.current, false);
    }
  });
}

function ordersLoader(seed: RecordValue[] = [], loaded = false) {
  const state = { list: seed, loaded, error: false };
  const requests: ReturnType<typeof deferred<RecordValue[]>>[] = [];
  const { createRequestGate } = load(path.join(root, "modules/shared/request-gate.ts"));
  const run: () => Promise<"applied" | "stale"> = pageExpression("loadOrders", {
    useCallback: (callback: unknown) => callback, orderListGate: createRequestGate(),
    fetchAdminOrders: () => { const request = deferred<RecordValue[]>(); requests.push(request); return request.promise; },
    setOrderList: (value: RecordValue[]) => { state.list = value; },
    setOrdersLoaded: (value: boolean) => { state.loaded = value; },
    setOrdersError: (value: boolean) => { state.error = value; },
  });
  return { state, requests, run };
}
test("运单列表首次失败仍未载入，真实空列表成功后才允许展示 0", async () => {
  const loader = ordersLoader();
  const first = loader.run();
  loader.requests[0].reject(new Error("orders unavailable"));
  await assert.rejects(first, /orders unavailable/);
  assert.equal(loader.state.loaded, false);
  assert.equal(loader.state.error, true);
  const recovery = loader.run();
  loader.requests[1].resolve([]);
  assert.equal(await recovery, "applied");
  assert.equal(loader.state.loaded, true);
  assert.equal(loader.state.error, false);
  assert.deepEqual(loader.state.list, []);
});
test("运单刷新失败保留旧列表及 loaded 标志，成功恢复清错", async () => {
  const old = [{ trackingNo: "YW001", currentStatus: "loaded" }];
  const loader = ordersLoader(old, true);
  const first = loader.run();
  loader.requests[0].reject(new Error("orders refresh failed"));
  await assert.rejects(first, /orders refresh failed/);
  assert.equal(loader.state.loaded, true);
  assert.equal(loader.state.error, true);
  assert.equal(loader.state.list, old);
  const retry = loader.run();
  assert.equal(loader.state.error, true);
  loader.requests[1].resolve([{ trackingNo: "YW002" }]);
  await retry;
  assert.equal(loader.state.error, false);
});
test("运单并发：慢旧成功/失败不能覆盖快新结果或污染错误提示", async () => {
  for (const oldFails of [false, true]) {
    const loader = ordersLoader();
    const old = loader.run();
    const latest = loader.run();
    const list = [{ trackingNo: "YW009" }];
    loader.requests[1].resolve(list);
    assert.equal(await latest, "applied");
    if (oldFails) loader.requests[0].reject(new Error("stale failure"));
    else loader.requests[0].resolve([{ trackingNo: "YW001" }]);
    assert.equal(await old, "stale");
    assert.equal(loader.state.list, list);
    assert.equal(loader.state.loaded, true);
    assert.equal(loader.state.error, false);
  }
});
test("运单并发：新请求失败后旧成功不能伪造首次加载成功", async () => {
  const loader = ordersLoader();
  const old = loader.run();
  const latest = loader.run();
  loader.requests[1].reject(new Error("current failed"));
  await assert.rejects(latest, /current failed/);
  loader.requests[0].resolve([{ trackingNo: "YW001" }]);
  assert.equal(await old, "stale");
  assert.equal(loader.state.loaded, false);
  assert.equal(loader.state.error, true);
  assert.deepEqual(loader.state.list, []);
});
test("运单原数字降序排序保留，超安全整数的编号不损失精度", async () => {
  const loader = ordersLoader();
  const promise = loader.run();
  loader.requests[0].resolve([
    { trackingNo: "YW9007199254740992" }, { trackingNo: "YW0009" },
    { trackingNo: "YW9007199254740993" }, { trackingNo: "YW0010" },
  ]);
  await promise;
  assert.deepEqual(loader.state.list.map((row) => row.trackingNo), ["YW9007199254740993", "YW9007199254740992", "YW0010", "YW0009"]);
});

// 从真页面 AST 提取完整 overview 区域，防止只测组件而漏掉实际挂载或传参。
const sections = findNodes((node): node is ts.JsxElement => ts.isJsxElement(node) &&
  node.openingElement.tagName.getText(ast) === "section" &&
  node.openingElement.attributes.properties.some((property) => ts.isJsxAttribute(property) &&
    property.name.getText(ast) === "id" && property.initializer && ts.isStringLiteral(property.initializer) && property.initializer.text === "overview"));
assert.equal(sections.length, 1, "须定位管理员真正的运营看板区域");
const mounts = findNodes((node): node is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "AdminOperationsOverview");
assert.equal(mounts.length, 1, "新看板须实际挂载一次，不能只新增未用组件");
assert.ok(mounts[0].pos >= sections[0].pos && mounts[0].end <= sections[0].end, "新组件须位于真实 overview 区域");
const MountedOverview = compile(`export default function MountedOverview(ctx: any) {
  const { overview, opsOverview, shipmentCounts, ordersLoaded, overviewError, ordersError, opsError, AdminOperationsOverview } = ctx;
  const sectionStyle = {}, activeSection = "overview";
  return (${sections[0].getText(ast)});
}`, "mounted-admin-overview.tsx").default;
const AdminOperationsOverview = load(componentFile).default;
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");

const overview = {
  staffAccountCount: 3, clientAccountCount: 111, newOrderCountToday: 7, inTransitOrderCount: 332, receivedVolumeM3Today: 12.345,
  containerLoadingCount: 2, containerOnTheWayCount: 71, containerAtWarehouseCount: 220, containerDoneCount: 3, containerTotalCount: 296,
  transitTrend: [{ label: "NEVER_RENDER_TREND_LABEL", seaDays: 13.1, landDays: null, samples: 17 }],
  stalledContainers: [{ containerNo: "SEA-OVERDUE-01", transportMode: "sea", currentStatus: "ARRIVED_PORT", currentStatusZh: "已到港", loadedDays: 35, idleDays: 9, shipmentCount: 6, reason: "overdue" }],
};
const shipmentCounts = { processing: 13, inTransit: 332, atWarehouse: 117, delivered: 1222, exception: 8 };
const opsOverview = {
  customsAlerts: [{ id: "customs-01", shipmentTrackingNo: "YW-CUSTOMS-01", shipmentId: "INTERNAL-SHIPMENT-ID", status: "inspection", remark: "等待补充装箱单", updatedAt: "2026-09-20T00:00:00Z" }],
  supplierPriceAlerts: [{ routeCode: "CN-TH-SEA", supplierName: "供应商甲", transportMode: "sea", seasonTag: "旺季", currency: "CNY", previousQuotePrice: 100, latestQuotePrice: 112.34, delta: 12.34, updatedAt: "2026-09-20T00:00:00Z" }],
};
function render(overrides: RecordValue = {}): string {
  return renderToStaticMarkup(createElement(MountedOverview, {
    overview, opsOverview, shipmentCounts, ordersLoaded: true, overviewError: false, ordersError: false, opsError: false,
    AdminOperationsOverview, ...overrides,
  }));
}
function metricGroups(html: string): Array<Record<string, string>> {
  return [...html.matchAll(/<dl\b[^>]*>([\s\S]*?)<\/dl>/g)].map((match) => Object.fromEntries(
    [...match[1].matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt><dd\b[^>]*>([\s\S]*?)<\/dd>/g)]
      .map((metric) => [textContent(metric[1]), textContent(metric[2])]),
  ));
}
const emptyOverview = {
  staffAccountCount: 0, clientAccountCount: 0, newOrderCountToday: 0, inTransitOrderCount: 0, receivedVolumeM3Today: 0,
  containerLoadingCount: 0, containerOnTheWayCount: 0, containerAtWarehouseCount: 0, containerDoneCount: 0, containerTotalCount: 0,
  transitTrend: [], stalledContainers: [],
};
const emptyOps = { customsAlerts: [], supplierPriceAlerts: [] };
const zeroCounts = { processing: 0, inTransit: 0, atWarehouse: 0, delivered: 0, exception: 0 };

test("页面实际挂载数字看板：三类数量不串字段，每个数值带正确单位", () => {
  const html = render();
  assert.match(html, /^<section id="overview"/);
  assert.deepEqual(metricGroups(html), [
    { 今日新增订单: "7 单", 今日收货体积: "12.3 m³", 当前在途运单: "332 票" },
    { 未发出: "13 票", 在途: "332 票", 已到泰国仓: "117 票", 已签收: "1,222 票", "异常/其他": "8 票" },
    { 装柜中: "2 个柜", 在路上: "71 个柜", 已到泰国仓: "220 个柜", 已完成: "3 个柜" },
  ]);
  contains(html, ["员工账号 3 个", "客户账号 111 个", "共 296 个柜", "不含两种集货业务", "按当前已加载的普通运单列表统计"]);
});
test("看板移除图表和路线示意，所有数字无需悬停，柜子预警排在进度前", () => {
  const html = render();
  assert.doesNotMatch(html, /<svg\b|<canvas\b|NEVER_RENDER_TREND_LABEL|时效分析图|运单状态分布|路线概览/);
  assert.doesNotMatch(sections[0].getText(ast), /<LineChart\b|<BarChart\b|<ResponsiveContainer\b|<Tooltip\b/);
  assert.ok(html.indexOf('id="overview-stalled-heading"') < html.indexOf('id="overview-shipments-heading"'));
});
test("只有真实存在的运单/装柜入口，标签保留浏览器原生链接语义", () => {
  const links = [...render().matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(links, ["/staff/container-loading", "/admin#orders", "/staff/container-loading"]);
});
test("初始未加载：总览/进度均占位，不伪装 0 或无预警", () => {
  const html = render({ overview: null, opsOverview: null, ordersLoaded: false });
  contains(html, ["总览数据加载中", "运单进度加载中", "关务与报价提醒加载中", "卡住的柜子数据加载中"]);
  assert.ok(metricGroups(html).flatMap((group) => Object.values(group)).every((value) => value.startsWith("— ")));
  assert.doesNotMatch(textContent(html), /暂无超期|没有卡住|暂无.*告警|\b0 (?:单|票|个柜|m³)/);
});
test("真实空成功可以显示 0，无关务/报价提醒时不占空面板", () => {
  const html = render({ overview: emptyOverview, opsOverview: emptyOps, shipmentCounts: zeroCounts });
  assert.deepEqual(metricGroups(html), [
    { 今日新增订单: "0 单", 今日收货体积: "0.0 m³", 当前在途运单: "0 票" },
    { 未发出: "0 票", 在途: "0 票", 已到泰国仓: "0 票", 已签收: "0 票", "异常/其他": "0 票" },
    { 装柜中: "0 个柜", 在路上: "0 个柜", 已到泰国仓: "0 个柜", 已完成: "0 个柜" },
  ]);
  contains(html, ["暂无超期或长时间未推进的柜子"]);
  assert.doesNotMatch(html, /id="overview-customs-heading"|id="overview-prices-heading"|加载中|加载失败/);
});
test("三个接口首次失败：独立错误提示，不用空列表掩盖失败", () => {
  const html = render({ overview: null, opsOverview: null, ordersLoaded: false, overviewError: true, ordersError: true, opsError: true });
  contains(html, ["总览加载失败", "运单进度加载失败", "关务与报价提醒加载失败", "无法判断是否存在超期", "暂不能判断是否有待处理事项"]);
  assert.ok(metricGroups(html).flatMap((group) => Object.values(group)).every((value) => value.startsWith("— ")));
  assert.doesNotMatch(textContent(html), /暂无超期|没有卡住|加载中/);
});
test("部分失败互不串联，overview 失败不清空已成功的运单进度", () => {
  const html = render({ overview: null, overviewError: true });
  contains(html, ["总览加载失败"]);
  assert.equal(metricGroups(html)[1].在途, "332 票");
  contains(html, ["YW-CUSTOMS-01", "供应商甲"]);
  assert.doesNotMatch(textContent(html), /运单进度加载失败|关务与报价提醒加载失败/);
});
test("刷新失败保留旧数字与预警，并准确标注上次结果", () => {
  const html = render({ overviewError: true, ordersError: true, opsError: true });
  contains(html, ["总览更新失败", "运单进度更新失败", "关务与报价提醒更新失败", "保留上次", "SEA-OVERDUE-01", "YW-CUSTOMS-01", "供应商甲"]);
  assert.equal(metricGroups(html)[0].今日新增订单, "7 单");
  assert.equal(metricGroups(html)[1].在途, "332 票");
  assert.equal(metricGroups(html)[2].在路上, "71 个柜");
  contains(render({ overview: emptyOverview, overviewError: true }), ["上次结果：暂无超期或长时间未推进的柜子"]);
});
test("旧 API 缺预警数组不能崩溃或声称无异常", () => {
  const html = render({ overview: { ...overview, stalledContainers: undefined }, opsOverview: {} });
  contains(html, ["暂未提供卡住的柜子数据", "无法判断是否存在超期", "数据未完整提供", "不能据此判断没有待处理事项"]);
  assert.doesNotMatch(textContent(html), /暂无超期|没有卡住的柜子|undefined|null|NaN/);
  assert.equal(metricGroups(html)[0].今日新增订单, "7 单");
});
test("缺失或非有限数字用占位，不能转成 0/NaN/Infinity", () => {
  const html = render({
    overview: { ...overview, newOrderCountToday: null, receivedVolumeM3Today: Number.NaN, containerAtWarehouseCount: undefined },
    shipmentCounts: { ...shipmentCounts, exception: Number.POSITIVE_INFINITY },
  });
  const metrics = metricGroups(html);
  assert.equal(metrics[0].今日新增订单, "— 单");
  assert.equal(metrics[0].今日收货体积, "— m³");
  assert.equal(metrics[1]["异常/其他"], "— 票");
  assert.equal(metrics[2].已到泰国仓, "— 个柜");
  assert.doesNotMatch(textContent(html), /NaN|Infinity|undefined|null/);
});
test("柜子预警保留柜号/运输/票数/后端状态和原因，未知天数不写 0", () => {
  const base = overview.stalledContainers[0];
  const html = render({ overview: { ...overview, stalledContainers: [
    base,
    { ...base, containerNo: "LAND-IDLE-02", transportMode: "land", currentStatusZh: "越南境内", idleDays: 9, reason: "idle" },
    { ...base, containerNo: "SEA-UNKNOWN-03", loadedDays: null },
    { ...base, containerNo: "LAND-UNKNOWN-04", transportMode: "land", idleDays: null, reason: "idle" },
  ] } });
  contains(html, ["SEA-OVERDUE-01", "海运", "6 票货", "当前：已到港", "装柜 35 天未到仓", "LAND-IDLE-02", "陆运", "当前：越南境内", "9 天未更新状态", "装柜天数未提供", "长时间未更新（天数未提供）"]);
  assert.doesNotMatch(textContent(html), /装柜 0 天|0 天未更新|null 天|undefined 天/);
});
test("预警数量是展示数而非总数，后端 10/20/10 条边界不再被前端偷偷截 6 条", () => {
  const stalled = Array.from({ length: 10 }, (_, i) => ({ ...overview.stalledContainers[0], containerNo: `LIMIT-CONTAINER-${i}` }));
  const customs = Array.from({ length: 20 }, (_, i) => ({ ...opsOverview.customsAlerts[0], id: `customs-${i}`, shipmentTrackingNo: `LIMIT-CUSTOMS-${i}` }));
  const prices = Array.from({ length: 10 }, (_, i) => ({ ...opsOverview.supplierPriceAlerts[0], routeCode: `LIMIT-PRICE-${i}` }));
  const html = render({ overview: { ...overview, stalledContainers: stalled }, opsOverview: { customsAlerts: customs, supplierPriceAlerts: prices } });
  contains(html, ["展示 10 个", "展示 20 条", "展示 10 条", "当前展示数量不代表全部", "并非全量关务记录", "并非全量报价记录"]);
  for (const row of stalled) contains(html, [row.containerNo]);
  for (const row of customs) contains(html, [row.shipmentTrackingNo]);
  for (const row of prices) contains(html, [row.routeCode]);
  assert.doesNotMatch(textContent(html), /共\s*(?:10|20)\s*(?:个|条)|总计\s*(?:10|20)/);
});
test("关务展示外部运单号优先，旧 ID 与未关联都有清楚回退", () => {
  const base = opsOverview.customsAlerts[0];
  const html = render({ opsOverview: { ...opsOverview, customsAlerts: [
    base,
    { ...base, id: "customs-02", shipmentTrackingNo: null, shipmentId: "FALLBACK-ID-02", status: "pending", remark: "" },
    { ...base, id: "customs-03", shipmentTrackingNo: null, shipmentId: undefined, status: "released" },
  ] } });
  contains(html, ["查验", "待处理", "放行", "运单 YW-CUSTOMS-01", "运单 FALLBACK-ID-02", "运单 未关联", "等待补充装箱单", "无备注"]);
  assert.ok(!html.includes("INTERNAL-SHIPMENT-ID"), "真实运单号存在时不应暴露内部 ID 占位");
});
test("报价保留完整比较维度、正负变动、两位小数及币种，不只依赖颜色", () => {
  const html = render({ opsOverview: { ...opsOverview, supplierPriceAlerts: [
    opsOverview.supplierPriceAlerts[0],
    { routeCode: "CN-TH-LAND", supplierName: "供应商乙", transportMode: "land", seasonTag: "淡季", currency: "THB", previousQuotePrice: 20, latestQuotePrice: 15.5, delta: -4.5, updatedAt: "2026-09-20T00:00:00Z" },
  ] } });
  contains(html, ["CN-TH-SEA", "供应商甲", "海运", "旺季", "CNY 100.00 → 112.34", "变动 +12.34 CNY", "CN-TH-LAND", "供应商乙", "陆运", "淡季", "THB 20.00 → 15.50", "变动 -4.50 THB"]);
});
test("后台字符串和超长柜号原样可见但必须 HTML 转义，不执行注入内容", () => {
  const hostile = '<script>alert("fixture")</script>&END';
  const longNo = `LONG-${"Z".repeat(160)}-END`;
  const html = render({
    overview: { ...overview, stalledContainers: [{ ...overview.stalledContainers[0], containerNo: longNo, currentStatusZh: hostile }] },
    opsOverview: { customsAlerts: [{ ...opsOverview.customsAlerts[0], remark: hostile }], supplierPriceAlerts: [{ ...opsOverview.supplierPriceAlerts[0], supplierName: hostile }] },
  });
  assert.ok(html.includes(longNo));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.doesNotMatch(html, /<script\b/);
  contains(html, [hostile]);
});
test("渲染不修改 API 响应或分组数据，字段读取保持纯展示", () => {
  const data = { overview, opsOverview, shipmentCounts };
  const before = JSON.stringify(data);
  function freeze(value: unknown) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
  }
  freeze(data);
  render();
  assert.equal(JSON.stringify(data), before);
});

async function main() {
  let passed = 0;
  for (const [name, body] of tests) {
    // 被测请求若永久 pending，Node 原本会在没有句柄时以 0 退出而不打印 SUMMARY。
    // 每例独立 watchdog 保证这种回归明确失败；不是给被测代码补超时。
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(body),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("测试未完成：被测 Promise 超过 1 秒仍未落定")), 1000); }),
      ]);
      passed++;
      console.log(`PASS ${name}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  console.log(`SUMMARY ${passed}/${tests.length} passed`);
  if (passed !== tests.length) process.exitCode = 1;
}
void main();
