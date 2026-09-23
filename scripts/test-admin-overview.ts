/**
 * 运营看板直观化回归：真编译/渲染页面挂载的组件，执行真实分组与取数回调。
 * 不启动服务器、不发网络请求、不连接数据库；所有请求只用可控内存 Promise。
 * 静态 HTML 和真实导航回调能证明显示内容与接线，不能代替浏览器导航/历史和手机布局验收。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { ok, requireRole } from "../apps/api/src/modules/core/http-utils";
import { CONTAINER_STATUS_LABEL } from "../apps/api/src/modules/containers/status-flow";

type RecordValue = Record<string, any>;
const root = path.resolve("apps/web/src");
const pageFile = path.join(root, "app/admin/page.tsx");
const componentFile = path.join(root, "components/admin/AdminOperationsOverview.tsx");
const requireWeb = createRequire(pageFile);
const cache = new Map<string, RecordValue>();
function compile(source: string, filename: string, requireFn: (id: string) => any = requireWeb, globals: RecordValue = {}): RecordValue {
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`(function(exports,require,module){${output}\n})`, { Error, ...globals }, { filename })(module.exports, requireFn, module);
  return module.exports;
}
function load(filename: string, globals: RecordValue = {}, moduleCache = cache): RecordValue {
  const previous = moduleCache.get(filename);
  if (previous) return previous;
  const exports = compile(readFileSync(filename, "utf8"), filename, (id) => {
    if (id.endsWith(".module.css")) {
      // Node 不执行 CSS；只映射真实样式类名，组件 JSX、数值与分支均执行生产实现。
      const css = readFileSync(path.resolve(path.dirname(filename), id), "utf8");
      const classes = Object.fromEntries([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => [match[1], match[1]]));
      return { default: classes };
    }
    if (!id.startsWith(".")) {
      assert.ok(["react", "react/jsx-runtime", "react-dom/server", "next/link"].includes(id), `Unexpected external import: ${id}`);
      return requireWeb(id);
    }
    const base = path.resolve(path.dirname(filename), id);
    const resolved = [base + ".ts", base + ".tsx", base].find(existsSync);
    assert.ok(resolved, `Missing import: ${id}`);
    return load(resolved, globals, moduleCache);
  }, globals);
  moduleCache.set(filename, exports);
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
function serviceWrapper(name: string, bindings: RecordValue): (...args: any[]) => Promise<unknown> {
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

// 新 helper 缺席时仅为旧版本红测提供空绑定；不替代修复后的真实实现。
function accountWriteHarness() {
  const accountWriteState = { current: { revision: 0, active: 0 } };
  const bindings: RecordValue = { accountWriteState, useCallback: (fn: unknown) => fn };
  for (const name of ['beginAccountWrite', 'isAccountSnapshotCurrent']) {
    const present = findNodes((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && n.name.getText(ast) === name).length;
    bindings[name] = present ? pageExpression(name, bindings) : name === 'beginAccountWrite' ? () => () => {} : () => true;
  }
  return bindings;
}
function overviewLoader(kind: "overview" | "ops", seed: RecordValue | null = null, failed = false, syncFailure = false) {
  const state = { data: seed, error: failed, calls: 0, applied: [] as RecordValue[] };
  const ref = { current: false };
  const account = accountWriteHarness();
  const refreshPending = { current: false };
  const refreshPromise = { current: null as Promise<void> | null };
  const clock = fakeClock();
  const requests: Array<ReturnType<typeof deferred<RecordValue>> & { signal?: AbortSignal }> = [];
  const fetch = (signal?: AbortSignal) => {
    state.calls++;
    if (syncFailure && state.calls === 1) throw new Error('fixture synchronous failure');
    const request = { ...deferred<RecordValue>(), signal };
    requests.push(request);
    const onAbort = () => { request.reject(signal?.reason ?? new Error("fixture request aborted")); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    void request.promise.then(
      () => signal?.removeEventListener("abort", onAbort),
      () => signal?.removeEventListener("abort", onAbort),
    );
    return request.promise;
  };
  const run: (refreshAfterWrite?: boolean) => Promise<unknown> = pageExpression(kind === "overview" ? "loadOverview" : "loadOpsOverview", {
    useCallback: (callback: unknown) => callback,
    AbortController, window: clock, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    ...account, overviewInFlight: ref, opsOverviewInFlight: ref,
    overviewRefreshPending: refreshPending, overviewRefreshPromise: refreshPromise,
    fetchAdminOverview: fetch, fetchAdminOpsOverview: fetch,
    setOverview: (value: RecordValue) => { state.data = value; state.applied.push(value); },
    setOpsOverview: (value: RecordValue) => { state.data = value; },
    setOverviewError: (value: boolean) => { state.error = value; },
    setOpsError: (value: boolean) => { state.error = value; },
  });
  return { state, ref: kind === "overview" ? { get current() { return refreshPromise.current !== null; } } : ref,
    requests, run, clock, refreshPending, refreshPromise, account };
}
for (const kind of ["overview", "ops"] as const) {
  test(`${kind} 首次请求期间不伪造数据，重复调用复用未完成请求`, async () => {
    const loader = overviewLoader(kind);
    const first = loader.run();
    const duplicate = loader.run();
    assert.equal(loader.state.calls, 1, "轮询不应重复发起仍在途的总览请求");
    if (kind === "overview") assert.equal(first, duplicate, "普通读取必须返回同一个真实 Promise");
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
    await assert.rejects(first, /总览接口 30 秒未响应/);
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
    await assert.rejects(first, /总览接口 30 秒未响应/);
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

// 真写回调与真 loader 组合，必须让旧 GET 在写成功时仍未返回；仅测先完成再调用会漏掉丢刷新。
async function flushMicrotasks() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function mutationCaller(kind: "staff" | "client" | "ban" | "edit", loadOverview: (force?: boolean) => Promise<unknown>, options: {
  account?: RecordValue; write?: (signal?: AbortSignal) => Promise<unknown>; reload?: () => Promise<unknown>;
  banKind?: "员工" | "客户"; status?: string; confirmedStatus?: string; clock?: ReturnType<typeof fakeClock>;
} = {}) {
  const state = { writes: 0, reloads: 0, messages: [] as string[], toasts: [] as string[], loading: false, cleared: 0, signals: [] as (AbortSignal | undefined)[],
    staff: [{ id: "u-test", status: options.status ?? "active" }], clients: [{ id: "u-test", status: options.status ?? "active" }] };
  const reload = async () => { state.reloads++; return options.reload?.(); };
  const write = async (signal?: AbortSignal) => { state.writes++; state.signals.push(signal); return options.write?.(signal); };
  const clock = options.clock ?? fakeClock();
  const bindings: RecordValue = {
    AbortController, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    ...(options.account ?? accountWriteHarness()),
    loading: false, setLoading: (value: boolean) => { state.loading = value; },
    setToast: (text: string) => { state.toasts.push(text); }, setMessage: (text: string) => { if (text) state.messages.push(text); },
    staffForm: { id: "", name: "员工测试", phone: "13000000000", password: "" },
    clientForm: { id: "", name: "客户测试", companyName: "", phone: "13000000001", email: "", password: "", agentId: "" },
    editingClientId: "u-test", editingClientAgentId: null, setEditingClientId: () => {}, setEditingClientAgentId: () => {},
    agentOptions: [], setStaffForm: () => { state.cleared++; }, setClientForm: () => { state.cleared++; }, setShowStaffModal: () => {}, setShowClientModal: () => {},
    setStaffList: (fn: (rows: typeof state.staff) => typeof state.staff) => { state.staff = fn(state.staff); },
    setClientList: (fn: (rows: typeof state.clients) => typeof state.clients) => { state.clients = fn(state.clients); },
    createAdminStaff: (_payload: unknown, signal?: AbortSignal) => write(signal),
    createAdminClient: (_payload: unknown, signal?: AbortSignal) => write(signal),
    updateAdminClient: (_payload: unknown, signal?: AbortSignal) => write(signal),
    toggleUserBan: async (_id: string, signal?: AbortSignal) => { await write(signal); return { id: "u-test", status: options.confirmedStatus ?? "inactive" }; }, window: { confirm: () => true },
    loadStaff: reload, loadClients: reload, loadOverview,
  };
  if (findNodes((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'runAccountWrite').length) {
    bindings.runAccountWrite = pageExpression('runAccountWrite', bindings);
  }
  if (findNodes((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'refreshAccountViews').length) {
    bindings.refreshAccountViews = pageExpression('refreshAccountViews', bindings);
  }
  const callback = pageExpression(kind === "staff" ? "submitAddStaff" : kind === "client" ? "submitAddClient" : kind === "edit" ? "submitEditClient" : "confirmToggleBan", bindings);
  return { state, run: (): Promise<void> => kind === "ban" ? callback("u-test", "测试", options.status ?? "active", reload, options.banKind ?? "员工") : callback() };
}

for (const kind of ["staff", "client", "ban", "edit"] as const) {
  test(`${kind}真实写成功发生在旧GET途中：旧响应不落地，补发刷新并等待新响应`, async () => {
    const seed = { fixture: "last displayed" }, loader = overviewLoader("overview", seed);
    const old = loader.run();
    const mutation = mutationCaller(kind, loader.run, { account: loader.account });
    let completed = false;
    const written = mutation.run().then(() => { completed = true; });
    await flushMicrotasks();
    assert.equal(mutation.state.writes, 1);
    assert.equal(loader.state.calls, 1, '仍应单飞，写后刷新排队而非并发覆盖');
    loader.requests[0].resolve({ fixture: "pre-write snapshot" });
    await flushMicrotasks();
    assert.equal(loader.state.calls, 2, '旧请求结束后必须真实补发GET，不能等下次10秒轮询');
    assert.equal(completed, false, '写回调应等待写后的新GET，而不是仅等旧GET或直接返回');
    assert.equal(loader.state.data, seed);
    assert.deepEqual(loader.state.applied, [], '已知写前的旧结果不应重新标成最新');
    loader.requests[1].resolve({ fixture: "post-write snapshot" });
    await Promise.all([old, written]);
    assert.deepEqual(loader.state.data, { fixture: "post-write snapshot" });
    assert.deepEqual(mutation.state.messages, []);
    assert.equal(loader.ref.current, false);
    assert.equal(loader.refreshPromise.current, null);
    assert.equal(loader.clock.pending.size, 0);
  });
}
// 写成功与刷新失败是两类结果；直接执行三个真实调用点，不用假包装替它们吞错。
for (const kind of ['staff', 'client', 'ban', 'edit'] as const) {
  for (const failure of ['list', 'overview', 'both'] as const) {
    test(`${kind}写成功但${failure}刷新失败：仅提示成功后的刷新问题，不提示写失败`, async () => {
      const loader = overviewLoader('overview');
      const mutation = mutationCaller(kind, loader.run, { account: loader.account,
        reload: async () => { if (failure !== 'overview') throw new Error('fixture list unavailable'); },
      });
      const done = mutation.run();
      await flushMicrotasks();
      if (failure === 'list') loader.requests[0].resolve({ fixture: 'fresh' });
      else loader.requests[0].reject(new Error('fixture overview unavailable'));
      await done;
      assert.equal(mutation.state.writes, 1);
      assert.equal(mutation.state.toasts.length, 1);
      assert.equal(mutation.state.cleared, kind === 'ban' ? 0 : 1);
      assert.equal(mutation.state.messages.length, 1);
      assert.match(mutation.state.messages[0], /刷新失败/);
      assert.match(mutation.state.messages[0], /勿重复操作/);
      assert.doesNotMatch(mutation.state.messages[0], /添加失败|更新失败|封禁失败|10\s*秒|This operation was aborted/);
      assert.equal(mutation.state.loading, false);
      assert.equal(loader.refreshPromise.current, null);
    });
  }
  test(`${kind}写失败不清表单/不报成功，释放写标记后允许正常读恢复`, async () => {
    const loader = overviewLoader('overview');
    const mutation = mutationCaller(kind, loader.run, { account: loader.account, write: async () => { throw new Error('403 FORBIDDEN'); } });
    await mutation.run();
    assert.equal(mutation.state.cleared, 0);
    assert.equal(mutation.state.toasts.length, 0);
    assert.match(mutation.state.messages[0], /失败/);
    assert.equal(mutation.state.loading, false);
    assert.equal(loader.account.accountWriteState.current.active, 0);
    const read = loader.run(); loader.requests.at(-1)!.resolve({ fixture: 'recovery' }); await read;
    assert.equal(loader.state.data?.fixture, 'recovery');
  });
  for (const response of ['success', 'error'] as const) {
    test(`${kind}写已发出但响应未到，旧GET先${response}不得落地；写响应后真实刷新`, async () => {
      const seed = { fixture: 'last displayed' }, loader = overviewLoader('overview', seed);
      const old = loader.run(), ack = deferred<void>();
      const mutation = mutationCaller(kind, loader.run, { account: loader.account, write: () => ack.promise });
      const done = mutation.run();
      if (response === 'success') loader.requests[0].resolve({ fixture: 'pre-write' });
      else loader.requests[0].reject(new Error('pre-write failure'));
      const result = await Promise.allSettled([old]);
      assert.equal(loader.state.data, seed, '写响应尚未返回时，也不能显示写前快照');
      assert.equal(loader.state.error, false, '旧失败不得污染新一轮写入');
      assert.equal(result[0].status, 'fulfilled');
      assert.equal(loader.state.calls, 1, '不因写入尚未结束而空转GET');
      ack.resolve(); await flushMicrotasks();
      assert.equal(loader.state.calls, 2);
      loader.requests[1].resolve({ fixture: 'post-write' }); await done;
      assert.equal(loader.state.data?.fixture, 'post-write');
      assert.equal(loader.account.accountWriteState.current.active, 0);
    });
  }
}
for (const kind of ['员工', '客户'] as const) {
  for (const status of ['active', 'inactive']) {
    test(`${kind}封禁切换后列表刷新失败仍采用服务器确认的${status}状态`, async () => {
      const original = status === 'active' ? 'inactive' : 'active';
      const mutation = mutationCaller('ban', async () => {}, { banKind: kind, status: original, confirmedStatus: status,
        reload: async () => { throw new Error('list offline'); },
      });
      await mutation.run();
      assert.equal((kind === '员工' ? mutation.state.staff : mutation.state.clients)[0].status, status);
      assert.equal((kind === '员工' ? mutation.state.clients : mutation.state.staff)[0].status, original, '不能改错另一类列表');
    });
  }
}
// 实际列表loader要与写入共用失效边界，不能让轮询晚到覆盖已确认的封禁状态。
for (const kind of ['staff', 'client'] as const) {
  test(`${kind}列表：写前/写途中GET在写后才返回也不能覆盖，写后新GET正常落地`, async () => {
    const account = accountWriteHarness(), requests: Array<ReturnType<typeof deferred<any[]>>> = [];
    let rows = [{ id: 'u-test', status: 'inactive' }];
    const read = pageExpression(kind === 'staff' ? 'loadStaff' : 'loadClients', { ...account,
      fetchAdminStaff: () => { const q = deferred<any[]>(); requests.push(q); return q.promise; },
      fetchAdminClients: () => { const q = deferred<any[]>(); requests.push(q); return q.promise; }, fetchAgentOptions: async () => [],
      setStaffList: (value: typeof rows) => { rows = value; }, setClientList: (value: typeof rows) => { rows = value; }, setAgentOptions: () => {},
    });
    const before = read(), finish = account.beginAccountWrite(), during = read();
    finish();
    requests[0].resolve([{ id: 'u-test', status: 'active' }]); await before;
    assert.equal(rows[0].status, 'inactive');
    requests[1].resolve([{ id: 'u-test', status: 'active' }]); await during;
    assert.equal(rows[0].status, 'inactive');
    const after = read(); requests[2].resolve([{ id: 'u-test', status: 'active' }]); await after;
    assert.equal(rows[0].status, 'active');
  });
}
test('写期间新起的总览GET不落地；多个重叠写入结束前不展示中间快照', async () => {
  const loader = overviewLoader('overview'), finishA = loader.account.beginAccountWrite();
  const finishB = loader.account.beginAccountWrite();
  const first = loader.run(); finishA();
  loader.requests[0].resolve({ fixture: 'intermediate' }); await first;
  assert.equal(loader.state.data, null);
  finishB();
  const fresh = loader.run(true); loader.requests[1].resolve({ fixture: 'final' }); await fresh;
  assert.deepEqual(loader.state.data, { fixture: 'final' });
  assert.equal(loader.account.accountWriteState.current.active, 0);
});
test('写后刷新必须等待两个读取都落定：列表先失败也不能提前解锁再写', async () => {
  const loader = overviewLoader('overview');
  const mutation = mutationCaller('staff', loader.run, { account: loader.account, reload: async () => { throw new Error('offline'); } });
  const done = mutation.run(); await flushMicrotasks();
  assert.equal(mutation.state.loading, true);
  loader.requests[0].resolve({ fixture: 'fresh' }); await done;
  assert.equal(mutation.state.loading, false);
});
test('写期间新发GET即使在写响应前完成，也不能显示中间快照', async () => {
  const loader = overviewLoader('overview'), finish = loader.account.beginAccountWrite();
  const read = loader.run(); loader.requests[0].resolve({ fixture: 'during write' }); await read;
  assert.equal(loader.state.data, null);
  assert.equal(loader.state.error, false);
  finish();
  const fresh = loader.run(true); loader.requests[1].resolve({ fixture: 'fresh' }); await fresh;
  assert.deepEqual(loader.state.data, { fixture: 'fresh' });
});
test('写后列表永久挂起时30秒退出等待，迟到拒绝已接住，后续写入仍可用', async () => {
  const clock = fakeClock(), list = deferred<void>();
  const mutation = mutationCaller('staff', async () => {}, { clock, reload: () => list.promise });
  const done = mutation.run(); await flushMicrotasks();
  assert.equal(mutation.state.loading, true);
  clock.advance(29999); await flushMicrotasks(); assert.equal(mutation.state.loading, true);
  clock.advance(1); await done;
  assert.equal(mutation.state.loading, false);
  assert.match(mutation.state.messages[0], /员工已添加.*账号列表刷新失败/);
  assert.equal(clock.pending.size, 0);
  list.reject(new Error('late list failure')); await flushMicrotasks();
  const recovery = mutationCaller('staff', async () => {}, { clock }); await recovery.run();
  assert.equal(recovery.state.messages.length, 0);
  assert.equal(clock.pending.size, 0);
});
test('总览超时不得误报写入失败，写成功后的提示不泄露英文 abort 文案', async () => {
  const loader = overviewLoader('overview');
  const mutation = mutationCaller('client', loader.run, { account: loader.account });
  const done = mutation.run(); await flushMicrotasks(); loader.clock.advance(30000); await done;
  assert.match(mutation.state.messages[0], /客户已添加.*看板刷新失败/);
  assert.doesNotMatch(mutation.state.messages[0], /添加失败|aborted/);
  assert.equal(mutation.state.toasts.length, 1);
});
for (const kind of ['staff', 'client', 'ban', 'edit'] as const) {
  for (const late of ['resolve', 'reject'] as const) {
    test(`${kind}写请求挂起30秒后解除读冻结，提示结果未确认；迟到${late}不报成功/不重复写`, async () => {
      const clock = fakeClock(), loader = overviewLoader('overview', { fixture: 'old display' });
      const ack = deferred<void>();
      const mutation = mutationCaller(kind, loader.run, { clock, account: loader.account, write: () => ack.promise });
      const done = mutation.run(); await flushMicrotasks();
      assert.equal(loader.account.accountWriteState.current.active, 1);
      clock.advance(29999); await flushMicrotasks();
      assert.equal(mutation.state.loading, true);
      clock.advance(1); await done;
      assert.equal(loader.account.accountWriteState.current.active, 0);
      assert.equal(mutation.state.loading, false);
      assert.equal(mutation.state.signals[0]?.aborted, true, '必须把取消信号传到真实写服务');
      assert.match(mutation.state.messages[0], /结果未确认.*勿重复操作/);
      assert.doesNotMatch(mutation.state.messages[0], /添加失败|更新失败|封禁失败|成功/);
      assert.equal(mutation.state.cleared, 0);
      assert.equal(mutation.state.toasts.length, 0);
      const recovery = loader.run(); loader.requests.at(-1)!.resolve({ fixture: 'current server snapshot' }); await recovery;
      assert.equal(loader.state.data?.fixture, 'current server snapshot');
      if (late === 'resolve') ack.resolve(); else ack.reject(new Error('late write rejection'));
      await flushMicrotasks();
      assert.equal(mutation.state.writes, 1, '超时不得自动重试非幂等写入');
      assert.equal(mutation.state.toasts.length, 0, '迟到写返回不得重入成功流程');
      assert.equal(mutation.state.cleared, 0);
      assert.equal(loader.account.accountWriteState.current.active, 0);
      assert.equal(clock.pending.size, 0);
    });
  }
  test(`${kind}写服务按 AbortSignal 拒绝时，超时仍保留未知结果语义`, async () => {
    const clock = fakeClock();
    const mutation = mutationCaller(kind, async () => {}, { clock, write: (signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    const done = mutation.run(); await flushMicrotasks(); clock.advance(30000); await done;
    assert.match(mutation.state.messages[0], /结果未确认/);
    assert.equal(mutation.state.toasts.length, 0);
    assert.equal(mutation.state.loading, false);
  });
}
for (const [name, endpoint] of [
  ['createAdminStaff', '/admin/users'], ['createAdminClient', '/admin/users/client'],
  ['updateAdminClient', '/admin/users/client/update'], ['toggleUserBan', '/admin/users/toggle-ban'],
]) {
  test(`${name}实际写服务透传取消信号，旧签名、请求体和解包不变且不重试`, async () => {
    for (const withSignal of [false, true]) {
      const c = new AbortController(), body = { id: 'u-test', name: '合成', phone: '13000000000' };
      const response = { raw: true }, parsed = { id: 'u-test', status: 'inactive' }; let count = 0;
      const call = serviceWrapper(name, { apiBaseUrl: () => 'https://fixture.invalid', authHeaders: () => ({ Authorization: 'Bearer fixture' }),
        fetch: async (url: string, options: RecordValue) => {
          count++; assert.equal(url, 'https://fixture.invalid' + endpoint); assert.equal(options.method, 'POST');
          assert.equal(options.headers.Authorization, 'Bearer fixture'); assert.equal(options.headers['Content-Type'], 'application/json');
          assert.equal(options.signal, withSignal ? c.signal : undefined);
          assert.deepEqual(JSON.parse(options.body), name === 'toggleUserBan' ? { id: 'u-test' } : body);
          return response;
        }, parseApiResponse: async (value: unknown) => { assert.equal(value, response); return parsed; },
      });
      assert.equal(await call(name === 'toggleUserBan' ? 'u-test' : body, withSignal ? c.signal : undefined), parsed);
      assert.equal(count, 1);
    }
  });
}
test('真实编辑客户后旧列表晚到不能把新名字盖回去', async () => {
  const account = accountWriteHarness(), reads: Array<ReturnType<typeof deferred<any[]>>> = [];
  let rows = [{ id: 'u-test', name: '改前', status: 'active' }];
  const read = pageExpression('loadClients', { ...account, fetchAdminClients: () => { const q = deferred<any[]>(); reads.push(q); return q.promise; },
    fetchAgentOptions: async () => [], setClientList: (value: typeof rows) => { rows = value; }, setAgentOptions: () => {},
  });
  const old = read();
  const mutation = mutationCaller('edit', async () => {}, { account, reload: read });
  const written = mutation.run(); await flushMicrotasks();
  reads[1].resolve([{ id: 'u-test', name: '改后', status: 'active' }]); await written;
  assert.equal(rows[0].name, '改后');
  reads[0].resolve([{ id: 'u-test', name: '改前', status: 'active' }]); await old;
  assert.equal(rows[0].name, '改后', '编辑客户也必须走写版本边界');
});
test('多个写后刷新合并；纯轮询不排队；补发期间再次写入仍补第三次且不落旧值', async () => {
  const loader = overviewLoader('overview');
  const pending = [loader.run(), loader.run(true), loader.run(true), loader.run()];
  loader.requests[0].resolve({ fixture: 'old' });
  await flushMicrotasks();
  assert.equal(loader.state.calls, 2);
  pending.push(loader.run(true), loader.run(true), loader.run());
  loader.requests[1].resolve({ fixture: 'superseded during followup' });
  await flushMicrotasks();
  assert.equal(loader.state.calls, 3);
  assert.deepEqual(loader.state.applied, []);
  pending.push(loader.run(), loader.run());
  loader.requests[2].resolve({ fixture: 'latest' });
  await Promise.all(pending);
  assert.equal(loader.state.calls, 3, '纯轮询不得制造无穷补发');
  assert.deepEqual(loader.state.applied, [{ fixture: 'latest' }]);
  assert.equal(loader.refreshPending.current, false);
  assert.equal(loader.clock.pending.size, 0);
});
for (const failure of ['error', 'timeout'] as const) {
  test(`写后排队刷新不被旧请求${failure}吞掉，补发成功可清除旧错误`, async () => {
    const seed = { fixture: 'last good' }, loader = overviewLoader('overview', seed, true);
    const old = loader.run(), refresh = loader.run(true);
    const done = Promise.all([old, refresh]);
    void done.catch(() => {}); // 旧实现会拒绝；预期红测也不能产生未处理拒绝掩盖断言。
    if (failure === 'timeout') loader.clock.advance(30000);
    else loader.requests[0].reject(new Error('stale request failed'));
    await flushMicrotasks();
    assert.equal(loader.state.calls, 2);
    assert.equal(loader.state.data, seed);
    assert.equal(loader.state.error, true);
    assert.equal(loader.clock.pending.size, 1, '补发应有独立30秒超时，旧timer已清');
    loader.requests[1].resolve({ fixture: 'recovered' });
    await done;
    assert.equal(loader.state.error, false);
    assert.equal(loader.ref.current, false);
    assert.equal(loader.clock.pending.size, 0);
  });
}
test('同步抛错也释放全部状态，后续请求不复用已拒绝的旧Promise', async () => {
  const loader = overviewLoader('overview', null, false, true);
  await assert.rejects(loader.run(), /fixture synchronous failure/);
  assert.equal(loader.ref.current, false);
  assert.equal(loader.refreshPromise.current, null);
  assert.equal(loader.clock.pending.size, 0);
  const next = loader.run(true);
  assert.equal(loader.state.calls, 2);
  loader.requests[0].resolve({ fixture: 'recovery' });
  await next;
  assert.equal(loader.state.error, false);
});
test('旧响应结束的微任务边界遇到新写入，必须开启新请求而非丢进已结束队列', async () => {
  const loader = overviewLoader('overview');
  const first = loader.run();
  loader.requests[0].resolve({ fixture: 'before mutation' });
  let refresh: Promise<unknown> | undefined;
  await Promise.resolve().then(() => { refresh = loader.run(true); });
  await flushMicrotasks();
  assert.equal(loader.state.calls, 2);
  loader.requests[1].resolve({ fixture: 'after mutation' });
  await Promise.all([first, refresh]);
  assert.deepEqual(loader.state.data, { fixture: 'after mutation' });
  assert.equal(loader.ref.current, false);
  assert.equal(loader.refreshPromise.current, null);
});
test('补发自身失败须通知所有等待者，保留旧数据并释放闸门，下一次能恢复', async () => {
  const seed = { fixture: 'last good' }, loader = overviewLoader('overview', seed);
  const pending = [loader.run(), loader.run(true), loader.run(true)];
  const rejected = pending.map(promise => assert.rejects(promise, /latest failed/));
  loader.requests[0].resolve({ fixture: 'stale' });
  await flushMicrotasks();
  assert.equal(loader.state.calls, 2);
  loader.requests[1].reject(new Error('latest failed'));
  await Promise.all(rejected);
  assert.equal(loader.state.data, seed);
  assert.equal(loader.state.error, true);
  assert.equal(loader.ref.current, false);
  assert.equal(loader.refreshPromise.current, null);
  assert.equal(loader.clock.pending.size, 0);
  const recovery = loader.run(true);
  loader.requests[2].resolve({ fixture: 'fresh' });
  await recovery;
  assert.deepEqual(loader.state.data, { fixture: 'fresh' });
  assert.equal(loader.state.error, false);
});

// 直接提取实际注册的 handler，执行真实权限检查/响应封装；仅 Prisma 和统计依赖使用严格内存桩。
function backendOverview(options: { empty?: boolean; failStalled?: boolean } = {}) {
  const filename = path.resolve('apps/api/src/modules/admin/routes.ts');
  const source = readFileSync(filename, 'utf8');
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const callbacks: ts.Expression[] = [];
  (function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.getText(tree) === 'app.get' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === '/admin/dashboard/overview') callbacks.push(node.arguments[1]);
    ts.forEachChild(node, visit);
  })(tree);
  assert.equal(callbacks.length, 1);
  const seen: Array<{ name: string; args: RecordValue }> = [];
  const raw: Array<{ sql: string; values: unknown[] }> = [];
  const companyId = 'fixture-company';
  function capture(name: string, args: RecordValue) {
    assert.equal(args.where.companyId, companyId, `${name}公司隔离不能丢失`);
    seen.push({ name, args });
  }
  const prisma = {
    user: { count: async (args: RecordValue) => { capture('user.count', args); return options.empty ? 0 : args.where.role === 'staff' ? 3 : 111; } },
    order: { count: async (args: RecordValue) => { capture('order.count', args); return options.empty ? 0 : 7; } },
    shipment: { aggregate: async (args: RecordValue) => { capture('shipment.aggregate', args); return { _sum: { volumeM3: options.empty ? null : { toString: () => '12.3456' } } }; } },
    container: { count: async (args: RecordValue) => {
      capture('container.count', args);
      if (options.empty) return 0;
      const status = args.where.currentStatus;
      if (status === undefined) return 20;
      if (status === 'LOADING') return 2;
      if (status === 'SIGNED') return 4;
      assert.deepEqual(Array.from(status.in), ['IN_WAREHOUSE_TH', 'DELIVERY_BOOKED', 'OUT_FOR_DELIVERY', 'DELIVERING']);
      return 5;
    } },
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?'); raw.push({ sql, values });
      assert.doesNotMatch(sql, /date_trunc\s*\(|sea_days|land_days/, '不可再计算已删除的时效趋势');
      assert.match(sql, /FROM containers c/);
      assert.match(sql, /c\.company_id = \?/);
      assert.deepEqual(values, [companyId]);
      if (options.failStalled) throw new Error('stalled query failed');
      return options.empty ? [] : [
        { container_no: 'TEST-SEA', transport_mode: 'sea', current_status: 'SEA_IN_TRANSIT', loaded_days: 35, idle_days: 9, shipment_count: 6n, reason: 'overdue' },
        { container_no: 'TEST-OLD', transport_mode: 'land', current_status: 'HISTORICAL_STATUS', loaded_days: null, idle_days: null, shipment_count: 2n, reason: 'idle' },
      ];
    },
  };
  /* 整柜排除条件（2026-09-23）：老板定的「整柜不算进看板数字」。
     ⚠️ 从**真模块**里读，不在这儿自己造一份 —— 那样改了源码测试照样绿。 */
  const fclScope = load(path.resolve('apps/api/src/modules/core/fcl-scope.ts'), {}, new Map());
  const { EXCLUDE_FCL_ORDER, EXCLUDE_FCL_SHIPMENT } = fclScope as RecordValue;
  assert.ok(EXCLUDE_FCL_ORDER && EXCLUDE_FCL_SHIPMENT, '整柜排除条件没读到，fcl-scope 是不是改了导出名');

  const handler = compile(`export default function bind(ctx: any) {
    const { prisma, countShipmentOverview, requireRole, ok, CONTAINER_STATUS_LABEL, EXCLUDE_FCL_ORDER, EXCLUDE_FCL_SHIPMENT } = ctx;
    return (${callbacks[0].getText(tree)});
  }`, filename).default({ prisma, requireRole, ok, CONTAINER_STATUS_LABEL, EXCLUDE_FCL_ORDER, EXCLUDE_FCL_SHIPMENT,
    countShipmentOverview: async (args: RecordValue) => {
      capture('countShipmentOverview', { where: args }); assert.equal(args.parentTrackingNo, null);
      return { inTransitCount: options.empty ? 0 : 332 };
    },
  });
  const response = { statusCode: 0, body: null as RecordValue | null, requestId: 'overview-fixture',
    status(code: number) { this.statusCode = code; return this; }, json(body: RecordValue) { this.body = body; return this; },
  };
  return { seen, raw, response, run: (role: string | null = 'admin') => handler({ headers: {}, auth: role ? { role, companyId, userId: 'fixture-user' } : undefined }, response) };
}
for (const empty of [false, true]) {
  test(`真实总览handler移除趋势查询/字段，保留全部计数与柜子预警（empty=${empty}）`, async () => {
    const api = backendOverview({ empty }); await api.run();
    assert.equal(api.response.statusCode, 200);
    assert.equal(api.response.body?.code, 'OK');
    const data = api.response.body!.data;
    assert.deepEqual(Object.keys(data).sort(), ['staffAccountCount', 'clientAccountCount', 'newOrderCountToday', 'inTransitOrderCount',
      'receivedVolumeM3Today', 'containerLoadingCount', 'containerOnTheWayCount', 'containerAtWarehouseCount', 'containerDoneCount', 'containerTotalCount', 'stalledContainers'].sort());
    for (const [key, value] of Object.entries({ staffAccountCount: 3, clientAccountCount: 111, newOrderCountToday: 7, inTransitOrderCount: 332,
      receivedVolumeM3Today: 12.346, containerLoadingCount: 2, containerOnTheWayCount: 9, containerAtWarehouseCount: 5, containerDoneCount: 4, containerTotalCount: 20 })) {
      assert.equal(data[key], empty ? 0 : value, `计数口径不能随移除趋势而变化：${key}`);
    }
    assert.equal(api.raw.length, 1, '仅保留卡住柜子的SQL');
    assert.equal(api.seen.length, 9);
    const shipment = api.seen.find(x => x.name === 'shipment.aggregate')!.args;
    assert.equal(shipment.where.parentTrackingNo, null);
    assert.equal(shipment.where.updatedAt, undefined);
    assert.equal(shipment.where.createdAt.gte.getUTCHours(), 16, '北京零点为前一日UTC16点');
    assert.equal(shipment.where.createdAt.gte.getUTCMinutes(), 0);
    assert.equal(data.stalledContainers.length, empty ? 0 : 2);
    if (!empty) {
      assert.equal(data.stalledContainers[0].shipmentCount, 6);
      assert.equal(data.stalledContainers[0].loadedDays, 35);
      assert.equal(data.stalledContainers[0].reason, 'overdue');
      assert.equal(data.stalledContainers[1].currentStatusZh, 'HISTORICAL_STATUS');
      assert.equal(data.stalledContainers[1].loadedDays, null);
      assert.equal(data.stalledContainers[1].idleDays, null);
    }
  });
}
test('总览非管理员/未登录仍拒绝且不查库，预警查询失败不能返回假成功', async () => {
  for (const role of ['staff', 'client', null]) {
    const api = backendOverview(); await api.run(role);
    assert.equal(api.response.statusCode, role ? 403 : 401);
    assert.equal(api.seen.length, 0); assert.equal(api.raw.length, 0);
  }
  const failed = backendOverview({ failStalled: true });
  await assert.rejects(failed.run(), /stalled query failed/);
  assert.equal(failed.response.body, null);
});
test('已无消费者的时效响应类型与KPI动画/账本样式不再残留', () => {
  const type = apiAst.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === 'AdminOverview');
  assert.ok(type);
  assert.ok(!type.members.some(member => member.name?.getText(apiAst) === 'transitTrend'));
  for (const file of ['app/globals.css', 'app/ledger.css']) {
    assert.doesNotMatch(readFileSync(path.join(root, file), 'utf8'), /\.kpi-flash\b|\.ledger-kpi\b|@keyframes\s+kpiFlash\b/);
  }
});

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
const { createElement, isValidElement, Children } = requireWeb("react");
// Node 的 next/link 包入口是 dist/client/link（pages 版），不是 App Router 构建 alias 的 app-dir/link。
// 此处验证真实元素/SSR及本组件onNavigate/helper；框架自己的事件筛选、跨页和历史仍需独立浏览器验收。
const NextLink = requireWeb("next/link").default;
const { renderToStaticMarkup } = requireWeb("react-dom/server");

type UiElement = { type: unknown; props: RecordValue };
function componentLinks(component = AdminOperationsOverview): UiElement[] {
  const links: UiElement[] = [];
  function visit(node: unknown) {
    if (!isValidElement(node)) return;
    const element = node as UiElement;
    if (element.type === NextLink || element.type === "a") links.push(element);
    Children.forEach(element.props.children, visit);
  }
  visit(component({ overview, opsOverview, shipmentCounts }));
  return links;
}

/** 只替换浏览器边界；组件 onNavigate、共享 navigateToHash、页面 hash 监听均执行真实源码。 */
function navigationHarness(initialUrl: string) {
  let currentUrl = new URL(initialUrl);
  const pushes: Array<{ data: unknown; title: string; url: string }> = [];
  const events: Array<{ type: string; oldURL: string; newURL: string }> = [];
  const sequence: string[] = [];
  const listeners = new Set<() => void>();
  const sectionChanges: string[] = [];
  class BoundaryHashChangeEvent {
    oldURL: string;
    newURL: string;
    constructor(public type: string, init: { oldURL: string; newURL: string }) {
      this.oldURL = init.oldURL;
      this.newURL = init.newURL;
    }
  }
  const browser = {
    get location() { return currentUrl; },
    history: { pushState(data: unknown, title: string, url: string) {
      sequence.push("pushState");
      pushes.push({ data, title, url });
      currentUrl = new URL(url, currentUrl);
    } },
    dispatchEvent(event: BoundaryHashChangeEvent) {
      assert.ok(event instanceof BoundaryHashChangeEvent, "须构造 HashChangeEvent，不能伪造没有 URL 的普通事件");
      assert.equal(event.type, "hashchange");
      assert.equal(event.newURL, currentUrl.href, "先写入 URL 再通知页面");
      sequence.push(event.type);
      events.push({ type: event.type, oldURL: event.oldURL, newURL: event.newURL });
      for (const listener of listeners) listener();
      return true;
    },
    addEventListener(type: string, listener: () => void) { assert.equal(type, "hashchange"); listeners.add(listener); },
    removeEventListener(type: string, listener: () => void) { assert.equal(type, "hashchange"); listeners.delete(listener); },
  };
  // 不复写“hash -> 分区”逻辑，提取页面真实 effect 与白名单判定函数。
  const effects = findNodes((node): node is ts.CallExpression => ts.isCallExpression(node) &&
    node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("const syncSectionByHash") === true);
  assert.equal(effects.length, 1, "须定位页面实际注册的 hashchange effect");
  let cleanup: (() => void) | undefined;
  compile(`export default function bind(ctx: any) {
    const { window, useEffect, setActiveSection } = ctx;
    const SECTION_IDS = ${variable("SECTION_IDS").initializer!.getText(ast)};
    const isSectionId = ${variable("isSectionId").initializer!.getText(ast)};
    ${effects[0].getText(ast)};
  }`, "mounted-admin-hash-listener.ts").default({
    window: browser,
    useEffect: (effect: () => (() => void)) => { cleanup = effect(); },
    setActiveSection: (section: string) => { sectionChanges.push(section); },
  });
  const component = load(componentFile, { window: browser, URL, HashChangeEvent: BoundaryHashChangeEvent }, new Map()).default;
  const links = componentLinks(component);
  const orderLink = links.find((link) => link.props.href === "#orders");
  assert.ok(orderLink, "运单入口须为相对 fragment，不能丢掉当前查询串或改写路径");
  function navigateOrders() {
    assert.equal(typeof orderLink!.props.onNavigate, "function", "同页 Link 必须接入真实导航回调");
    let prevented = 0;
    orderLink!.props.onNavigate({ preventDefault() { prevented++; sequence.push("preventDefault"); } });
    assert.equal(prevented, 1, "须且只须取消一次 Next 默认导航，再交共享 helper 处理");
  }
  return { links, orderLink, pushes, events, sequence, sectionChanges, navigateOrders,
    href: () => currentUrl.href, dispose: () => { cleanup?.(); assert.equal(listeners.size, 0); } };
}

const overview = {
  staffAccountCount: 3, clientAccountCount: 111, newOrderCountToday: 7, inTransitOrderCount: 332, receivedVolumeM3Today: 12.345,
  containerLoadingCount: 2, containerOnTheWayCount: 71, containerAtWarehouseCount: 220, containerDoneCount: 3, containerTotalCount: 296,
  // 故意模拟旧接口多余字段：滚动发布时，即使旧API仍返回趋势，新看板也不应显示它。
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
  stalledContainers: [],
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
  assert.deepEqual(links, ["/staff/container-loading", "#orders", "/staff/container-loading"]);
});
test("真实看板三个入口均为 next/link，而不是只渲染出相同 HTML 的原生 a", () => {
  const links = componentLinks();
  assert.equal(links.length, 3);
  for (const link of links) assert.equal(link.type, NextLink, `入口 ${link.props.href} 仍会绕过 Next 导航`);
});
for (const entry of ["/admin#overview", "/admin", "/admin?filter=a%20b&scope=orders#overview", "/admin/?filter=a%20b#overview"]) {
  test(`真实运单回调从 ${entry} 切分区，保留路径/query且先push再发hashchange`, () => {
    const initialUrl = new URL(entry, "https://fixture.invalid").href;
    const nav = navigationHarness(initialUrl);
    try {
      const expected = new URL("#orders", initialUrl).href;
      // href 本身也能用于复制链接/新标签打开；不依赖 onClick 才能拼出目的地址。
      assert.equal(new URL(nav.orderLink.props.href, initialUrl).href, expected);
      assert.equal(nav.orderLink.props.onClick, undefined, "不能用无条件 onClick 阻止 Cmd/Ctrl/中键打开");
      assert.deepEqual(nav.sectionChanges, ["overview"]);
      nav.navigateOrders();
      assert.equal(nav.href(), expected);
      assert.deepEqual(nav.sequence, ["preventDefault", "pushState", "hashchange"]);
      assert.deepEqual(nav.pushes, [{ data: null, title: "", url: expected }]);
      assert.deepEqual(nav.events, [{ type: "hashchange", oldURL: initialUrl, newURL: expected }]);
      assert.deepEqual(nav.sectionChanges, ["overview", "orders"], "真实页面监听必须收到通知并切换显示分区");
    } finally { nav.dispose(); }
  });
}
test("已在orders重复导航不新增历史/事件；真实页面和地址都保持orders", () => {
  for (const initialUrl of ["https://fixture.invalid/admin#orders", "https://fixture.invalid/admin/?q=kept#orders"]) {
    const nav = navigationHarness(initialUrl);
    try {
      nav.navigateOrders();
      nav.navigateOrders();
      assert.equal(nav.href(), initialUrl);
      assert.deepEqual(nav.pushes, []);
      assert.deepEqual(nav.events, []);
      assert.deepEqual(nav.sequence, ["preventDefault", "preventDefault"]);
      assert.deepEqual(nav.sectionChanges, ["orders"]);
    } finally { nav.dispose(); }
  }
});
test("两个跨页入口保留完整href与真实Link默认行为，不被同页hash回调拦截", () => {
  const links = componentLinks().filter((link) => link.props.href === "/staff/container-loading");
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.equal(link.type, NextLink);
    assert.equal(link.props.onNavigate, undefined);
    assert.equal(link.props.onClick, undefined);
    assert.equal(link.props.replace, undefined, "跨页仍新增历史记录，不能改成replace");
    assert.equal(new URL(link.props.href, "https://fixture.invalid/admin?q=kept#overview").href,
      "https://fixture.invalid/staff/container-loading");
  }
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
