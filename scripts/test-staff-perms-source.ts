/**
 * 员工端加两项权限（2026-10-19 老板「那就给员工加权限吧」）—— 不连库那一半。连库的在 test-staff-perms-db.ts。
 *
 *   A1 菜单：员工多一组「账号」→「客户账号」(/staff/client-accounts)，顶栏标题对；超管菜单不挂（超管有自己的客户管理）
 *   A2 「客户账号」页真跑（假 React，接口换成桩）：只列唛头（不带名字）、搜唛头不分大小写、封禁的标「已封禁」；
 *      点「重置密码」开弹窗（key 带前缀，同层有按数字给 key 的 Toast）；没填 / 太长当场拦、不发请求；
 *      发的是去掉前后空格的新密码；成功关弹窗、提示条说清；失败写在弹窗里；重置中不让关（✕ / Esc）；
 *      弹窗不在了才回来的照样出提示条（成功绿 / 失败红，审查第 1 轮）；名单读失败说清、能刷新
 *   E1 编辑运单共用一个框（modules/orders/WaybillEditDialog.tsx）：超管页、员工页都挂它，两页都不再自己写编辑框
 *   E2 编辑框真跑：不在「运单管理」时不画（visible=false 返回 null）、组件留着，填的内容回来还在；标题 / 产品图取列表里最新那张
 *   E3 员工页：「运单详情」里给「编辑运单」（有订单、不是待入库才给）；点了关详情、开编辑框；开 / 关 / 点 ✕ / 离开运单管理都给「第几次」+1（真跑）；
 *      编辑框拿到的是员工页那份跟推送刷新的客户名单、页面的忙 / 提示条 / 刷新
 *   B1 后端：/admin/orders/update 给员工 / 超管；删运单、员工页旧的保存（patch-shipment-bundle）照旧只给超管；
 *      重置密码那条只认客户号、写的时候再核一次是客户号
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

type Row = Record<string, any>;
const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 6).join("\n   ")}`); }
}

/* ───────────── 假 React（同 test-arrival-notice-snapshot-source.ts） ───────────── */
let hooks: any[] = [], index = 0, effects: Array<() => unknown> = [], cleanups: Array<() => void> = [], dirty = false;
const fakeReact = {
  // 父页面和弹窗各用一套 hook：setter 要认准建它那一套（事件在画之外触发时，全局 hooks 可能已经换成别的组件的）
  useState(init: any) {
    const arr = hooks, i = index++;
    if (!(i in arr)) arr[i] = typeof init === "function" ? init() : init;
    return [arr[i], (v: any) => { const n = typeof v === "function" ? v(arr[i]) : v; if (!Object.is(n, arr[i])) { arr[i] = n; dirty = true; } }];
  },
  useRef(init: any) { const arr = hooks, i = index++; return arr[i] ?? (arr[i] = { current: init }); },
  useMemo(fn: any, deps: unknown[]) {
    const i = index++, old = hooks[i];
    if (!old || deps.some((d, j) => !Object.is(d, old.deps[j]))) hooks[i] = { deps, value: fn() };
    return hooks[i].value;
  },
  useEffect(fn: any, deps: unknown[]) {
    const i = index++, old = hooks[i];
    if (!old || deps.some((d, j) => !Object.is(d, old[j]))) { hooks[i] = deps; effects.push(fn); }
  },
  useCallback(fn: any) { index++; return fn; },
  useLayoutEffect() { index++; },
};
const runtime = { jsx: (type: any, p: any, key: any) => ({ type, props: p, key }), jsxs: (type: any, p: any, key: any) => ({ type, props: p, key }), Fragment: "fragment" };

let clientsReply: () => Promise<any> = async () => [];
let resetCalls: Array<{ id: string; password: string; resolve: (v: any) => void; reject: (e: unknown) => void }> = [];
function load(rel: string, stubs: Record<string, any> = {}): any {
  const file = path.join(ROOT, rel);
  const realRequire = createRequire(file);
  const out = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: file,
  }).outputText;
  const mod = { exports: {} as any };
  new Function("exports", "require", "module", out)(mod.exports, (id: string) => {
    if (id === "react") return fakeReact;
    if (id === "react/jsx-runtime") return runtime;
    if (id in stubs) return stubs[id];
    return realRequire(id);
  }, mod);
  return mod.exports;
}
const DetailModalStub = { __esModule: true, default: function DetailModal(p: any) { return { type: "modal", props: p }; } };
const ToastStub = { __esModule: true, default: function Toast(p: any) { return { type: "toast", props: p }; } };
const Accounts = load("apps/web/src/modules/client-accounts/ClientAccountsView.tsx", {
  "../layout/DetailModal": DetailModalStub,
  "../layout/Toast": ToastStub,
  "../../services/business-api": {
    fetchStaffClients: () => clientsReply(),
    resetStaffClientPassword: (id: string, password: string) => new Promise((resolve, reject) => resetCalls.push({ id, password, resolve, reject })),
  },
});

function expand(n: any): any {
  if (n == null || typeof n !== "object") return n;
  if (Array.isArray(n)) return n.map(expand);
  if (typeof n.type === "function") return expand(n.type(n.props));
  return { ...n, props: { ...n.props, children: expand(n.props?.children) } };
}
function nodes(test: (n: any) => boolean, root: any): any[] {
  if (!root || typeof root !== "object") return [];
  if (Array.isArray(root)) return root.flatMap((n) => nodes(test, n));
  return [...(test(root) ? [root] : []), ...nodes(test, root.props?.children ?? null)];
}
function text(n: any): string {
  if (n == null || typeof n === "boolean") return "";
  if (Array.isArray(n)) return n.map(text).join("");
  return typeof n === "object" ? text(n.props?.children) : String(n);
}

/** 把页面（不展开子组件）画一遍：effect 跑完、state 稳定为止 */
let tree: any;
function renderPage() {
  for (let n = 0; n < 30; n++) {
    index = 0; dirty = false; tree = Accounts.default({});
    const queue = effects; effects = [];
    for (const fn of queue) { const c = fn(); if (typeof c === "function") cleanups.push(c as () => void); }
    if (!dirty) return;
  }
  throw new Error("无限重画");
}
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise<void>((r) => setImmediate(r)); renderPage(); } };
/** 弹窗是子组件：单独拿一套 hook 跑它（父组件的 hook 不动） */
function renderModal(el: any, state: { hooks: any[]; effects: Array<() => unknown> }) {
  const saved = { hooks, index, effects, dirty };
  hooks = state.hooks; effects = state.effects;
  let out: any;
  for (let n = 0; n < 30; n++) {
    index = 0; dirty = false; out = expand(el.type(el.props));
    const queue = effects; effects = [];
    for (const fn of queue) { const c = fn(); if (typeof c === "function") (state as any).cleanups = [...((state as any).cleanups ?? []), c]; }
    if (!dirty) break;
  }
  state.hooks = hooks; state.effects = effects;
  hooks = saved.hooks; index = saved.index; effects = saved.effects; dirty = saved.dirty;
  return out;
}

async function main(): Promise<void> {
  console.log("员工加权限（不连库）");

  await check("A1 菜单：员工多一组「账号」→「客户账号」(/staff/client-accounts)，顶栏标题「客户账号」；超管菜单不挂它", async () => {
    const { roleFunctionGroups } = await import("../apps/web/src/modules/layout/menu-config");
    const groups = (roleFunctionGroups as any).staff as Array<{ groupLabel: string; items: Array<{ id: string; label: string; href: string }> }>;
    const g = groups.find((x) => x.groupLabel === "账号");
    assert.ok(g, "员工菜单没有「账号」这一组");
    assert.deepEqual(g!.items, [{ id: "staff-func-client-accounts", label: "客户账号", href: "/staff/client-accounts" }]);
    const adminHrefs = ((roleFunctionGroups as any).admin as any[]).flatMap((x) => x.items.map((i: any) => i.href));
    assert.ok(!adminHrefs.includes("/staff/client-accounts"), "超管有自己的客户管理，不挂员工这页");
    // 路径放变量里动态取：WorkbenchFrame 是 .tsx，测试脚本那份 tsconfig 没开 jsx（同 test-review-1018-source S10）
    const framePath = "../apps/web/src/modules/layout/WorkbenchFrame";
    const { resolveWorkbench } = await import(framePath);
    assert.deepEqual(resolveWorkbench("/staff/client-accounts"), { allowedRole: ["staff", "admin"], title: "客户账号" });
    assert.match(read("apps/web/src/app/staff/client-accounts/page.tsx"), /return <ClientAccountsView \/>;/);
  });

  await check("A2 「客户账号」页真跑：只列唛头、搜唛头、封禁的标出来；重置密码弹窗拦空 / 太长、发去掉空格的、成功关弹窗 + 提示条、失败写弹窗里、重置中不让关、弹窗不在了也出提示条；名单读失败说清", async () => {
    // 名单读失败
    hooks = []; effects = []; cleanups = [];
    clientsReply = async () => { throw new Error("网断了"); };
    renderPage(); await settle();
    assert.match(text(tree), /客户名单没拉下来：网断了/);
    // 刷新成功
    clientsReply = async () => [{ id: "ABC-01", name: "张三公司", status: "active" }, { id: "xyz-9", name: "李四", status: "disabled" }, { id: "QQ", name: "王五", status: "active" }];
    nodes((n) => n.type === "button" && text(n) === "刷新", tree)[0].props.onClick();
    await settle();
    const rows = () => nodes((n) => n.type === "tr", tree).slice(1).map((tr) => tr.props.children.map(text));
    assert.deepEqual(rows(), [["ABC-01", "正常", "重置密码"], ["xyz-9", "已封禁", "重置密码"], ["QQ", "正常", "重置密码"]]);
    assert.ok(!/张三|李四|王五/.test(text(tree)), "客户名字不能出现（只显示唛头，2026-09-19）");
    // 搜唛头（不分大小写）
    nodes((n) => n.type === "input" && n.props.placeholder === "搜唛头", tree)[0].props.onChange({ target: { value: "XYZ" } });
    renderPage();
    assert.deepEqual(rows().map((r) => r[0]), ["xyz-9"]);
    assert.match(text(tree), /共 3 个客户，搜到 1 个/);
    // 开弹窗
    nodes((n) => n.type === "button" && text(n) === "重置密码", tree)[0].props.onClick();
    renderPage();
    const modalEl = () => nodes((n) => typeof n.type === "function" && n.type.name === "ResetPasswordModal", tree)[0];
    assert.ok(modalEl(), "没开弹窗");
    assert.equal(modalEl().key, "reset-1", "弹窗 key 要带前缀（同层有 key={toast.seq} 的 Toast，教训 39）");
    const mState = { hooks: [] as any[], effects: [] as Array<() => unknown> };
    let m = renderModal(modalEl(), mState);
    // 开发环境的严格模式：挂上 → 卸掉 → 再挂上，effect 各跑一遍（浏览器实点就是卡在这：只在卸掉时置 false，再挂上以后一直 false）
    for (const c of (mState as any).cleanups ?? []) c();
    (mState as any).cleanups = [];
    for (let i = 0; i < mState.hooks.length; i++) if (Array.isArray(mState.hooks[i])) mState.hooks[i] = undefined; // effect 的依赖清掉 = 下次画时再跑一遍
    m = renderModal(modalEl(), mState);
    assert.equal(m.props.subtitle, "唛头 xyz-9");
    const submit = () => nodes((n) => n.type === "form", m)[0].props.onSubmit({ preventDefault() {} });
    const pw = (v: string) => { nodes((n) => n.type === "input", m)[0].props.onChange({ target: { value: v } }); m = renderModal(modalEl(), mState); };
    assert.equal(nodes((n) => n.type === "input", m)[0].props.type, "text", "新密码要看得见（员工要告诉客户）");
    // 没填
    submit(); m = renderModal(modalEl(), mState);
    assert.match(text(m), /请填新密码/);
    assert.equal(resetCalls.length, 0, "没填也发了请求");
    // 太长
    pw("x".repeat(129)); submit(); m = renderModal(modalEl(), mState);
    assert.match(text(m), /太长了/);
    assert.equal(resetCalls.length, 0);
    // 失败：写在弹窗里
    pw("  654321  "); submit(); m = renderModal(modalEl(), mState);
    assert.deepEqual(resetCalls.map((c) => [c.id, c.password]), [["xyz-9", "654321"]], "发的要是去掉前后空格的新密码");
    assert.match(text(m), /重置中…/);
    resetCalls.shift()!.reject(new Error("这里只能重置客户的密码"));
    await new Promise<void>((r) => setImmediate(r)); m = renderModal(modalEl(), mState);
    assert.match(text(m), /这里只能重置客户的密码/);
    // 成功：关弹窗、提示条
    submit(); m = renderModal(modalEl(), mState);
    resetCalls.shift()!.resolve({ updated: true, id: "xyz-9" });
    await new Promise<void>((r) => setImmediate(r)); renderPage();
    assert.equal(modalEl(), undefined, "成功了弹窗要关");
    const toast = nodes((n) => n.type === ToastStub.default, tree)[0];
    assert.equal(toast.props.message, "唛头 xyz-9 的密码已重置，请把新密码告诉客户");
    assert.equal(toast.key, 1);
    // 重置中不让关（✕ 和 Esc 都走 confirmClose，审查第 1 轮两家）
    nodes((n) => n.type === "button" && text(n) === "重置密码", tree)[0].props.onClick(); renderPage();
    assert.equal(modalEl().key, "reset-2");
    const m2 = { hooks: [] as any[], effects: [] as Array<() => unknown> };
    let mm = renderModal(modalEl(), m2);
    assert.equal(mm.props.confirmClose(), true, "没在重置时能关");
    nodes((n) => n.type === "input", mm)[0].props.onChange({ target: { value: "abc" } }); mm = renderModal(modalEl(), m2);
    nodes((n) => n.type === "form", mm)[0].props.onSubmit({ preventDefault() {} }); mm = renderModal(modalEl(), m2);
    assert.equal(mm.props.confirmClose(), false, "重置中点 ✕ / 按 Esc 不许关（关了结果回来没地方说）");
    // 万一弹窗还是没了（整页切走之类）：成功照样出提示条 —— 密码真改了，员工得知道
    for (const c of (m2 as any).cleanups ?? []) c();
    resetCalls.shift()!.resolve({ updated: true, id: "xyz-9" });
    await new Promise<void>((r) => setImmediate(r)); renderPage();
    let t2 = nodes((n) => n.type === ToastStub.default, tree)[0];
    assert.deepEqual([t2.key, t2.props.message, t2.props.tone], [2, "唛头 xyz-9 的密码已重置，请把新密码告诉客户", "success"], "弹窗不在了，成功也要出提示条");
    // 弹窗不在了才失败：走红色提示条
    nodes((n) => n.type === "button" && text(n) === "重置密码", tree)[0].props.onClick(); renderPage();
    const m3 = { hooks: [] as any[], effects: [] as Array<() => unknown> };
    let m3t = renderModal(modalEl(), m3);
    nodes((n) => n.type === "input", m3t)[0].props.onChange({ target: { value: "def" } }); m3t = renderModal(modalEl(), m3);
    nodes((n) => n.type === "form", m3t)[0].props.onSubmit({ preventDefault() {} });
    for (const c of (m3 as any).cleanups ?? []) c();
    resetCalls.shift()!.reject(new Error("网断了"));
    await new Promise<void>((r) => setImmediate(r)); renderPage();
    t2 = nodes((n) => n.type === ToastStub.default, tree)[0];
    assert.deepEqual([t2.props.message, t2.props.tone], ["唛头 xyz-9 的密码没重置上：网断了", "error"]);
    // 前端调的接口就是后端那条（页面测试把接口换成了桩，这里核真代码里的路径和发的东西）
    const api = read("apps/web/src/services/business-api.ts");
    const fnAt = api.indexOf("export async function resetStaffClientPassword(");
    assert.match(api.slice(fnAt, api.indexOf("\n}", fnAt)), /fetch\(`\$\{apiBaseUrl\(\)\}\/staff\/clients\/set-password`, \{\s*method: "POST",[\s\S]*?body: JSON\.stringify\(\{ id, password \}\),/);
  });

  await check("E1 编辑运单只有一个框：超管页、员工页都挂 WaybillEditDialog，两页都不再自己写编辑框", () => {
    const admin = read("apps/web/src/app/admin/page.tsx");
    const staff = read("apps/web/src/app/staff/page.tsx");
    for (const [name, src] of [["超管页", admin], ["员工页", staff]] as const) {
      assert.match(src, /import WaybillEditDialog from "\.\.\/\.\.\/modules\/orders\/WaybillEditDialog";/, `${name}没引共用的编辑框`);
      assert.equal((src.match(/<WaybillEditDialog\b/g) ?? []).length, 1, `${name}要挂一个（只一个）编辑框`);
      assert.ok(!src.includes('title="编辑运单"'), `${name}又自己写了一个编辑框`);
      assert.ok(!/updateAdminOrder\(/.test(code(name === "超管页" ? "apps/web/src/app/admin/page.tsx" : "apps/web/src/app/staff/page.tsx")), `${name}自己调了改单接口（要走编辑框）`);
    }
  });

  await check("E2 编辑框真跑：不在运单管理时不画、组件留着，填的内容回来还在；标题 / 产品图取列表里最新那张", () => {
    const Dlg = load("apps/web/src/modules/orders/WaybillEditDialog.tsx", { "../layout/DetailModal": DetailModalStub, "../layout/MarkPicker": { __esModule: true, default: function MarkPicker() { return null; } } });
    const order: Row = { id: "s1", orderId: "o1", trackingNo: "ZZ-1", clientId: "C1", remark: "R0", products: [{ id: "p1", itemName: "鞋", packageCount: 2, cargoType: "normal", domesticTrackingNo: "SF1" }], orderUpdatedAt: "V0" };
    const st = { hooks: [] as any[], effects: [] as Array<() => unknown> };
    const props: Row = { initial: order, current: { ...order, trackingNo: "ZZ-1", productImages: [] }, visible: true, clientList: [{ id: "C1", status: "active" }], sessionRef: { current: 1 }, busy: false, setBusy() {}, onClose() {}, confirmClose: () => true, onToast() {}, reloadList: async () => {} };
    const el = () => ({ type: Dlg.default, props });
    let t = renderModal(el(), st);
    assert.equal(t.type, "modal");
    const remark = () => nodes((n) => n.type === "input" && n.props.placeholder === "备注（可选）", t)[0];
    remark().props.onChange({ target: { value: "填到一半" } });
    t = renderModal(el(), st);
    props.visible = false;
    t = renderModal(el(), st);
    assert.equal(t, null, "不在运单管理时不画（不占着键盘 / 滚动锁）");
    props.visible = true;
    props.current = { ...order, trackingNo: "ZZ-1-改过号", productImages: [{ id: "i1", fileName: "a.jpg", imageUrl: "/images/a.jpg" }] };
    t = renderModal(el(), st);
    assert.equal(remark().props.value, "填到一半", "回到运单管理，填的内容要还在");
    assert.equal(t.props.subtitle, "ZZ-1-改过号", "标题取列表里最新那张");
    assert.equal(nodes((n) => n.type === "img", t).length, 1, "产品图取列表里最新那张");
    // 表单只在挂上那一刻建：列表刷新（initial 换成新对象）不许冲掉正在填的
    props.initial = { ...order, remark: "别人改的" };
    t = renderModal(el(), st);
    assert.equal(remark().props.value, "填到一半");
  });

  await check("E3 员工页：「运单详情」给「编辑运单」（有订单、不是待入库）→ 关详情、开编辑框；开 / 关 / ✕ / 离开运单管理都 +1（真跑）；编辑框拿员工页那份客户名单和忙 / 提示条 / 刷新", () => {
    const staffFile = "apps/web/src/app/staff/page.tsx";
    const src = read(staffFile);
    assert.match(src, /\{item\.orderId && item\.currentStatus !== "pendingInbound" \? \(\s*<button[\s\S]{0,200}?onClick=\{\(\) => \{ setShipmentTableExpandedId\(null\); startWaybillEdit\(item\); \}\}[\s\S]{0,300}?编辑运单\s*<\/button>/, "详情里「编辑运单」的条件 / 动作不对");
    // 详情不再写「只读」；「可编辑」按能不能开编辑运单（原来按只给超管的 canEdit，员工一律「否」，审查第 1 轮两家）
    assert.ok(!src.includes("运单详情（只读）"), "员工能改运单了，详情还写着「只读」");
    assert.match(src, /<InfoItem label="可编辑" value=\{item\.orderId && item\.currentStatus !== "pendingInbound" \? "是" : "否"\} \/>/);
    assert.match(src, /可编辑: item\.orderId && item\.currentStatus !== "pendingInbound" \? "是" : "否",/, "导出的「可编辑」列也要跟着");
    assert.match(src, /<WaybillEditDialog\s*key=\{`waybill-\$\{waybillEditId\}`\}\s*initial=\{waybillEditMeta\}\s*current=\{waybillEditRow\}\s*visible=\{activeSection === "staff-order-shipment"\}\s*clientList=\{staffClients\}\s*sessionRef=\{waybillEditSessionRef\}\s*busy=\{loading\}\s*setBusy=\{setLoading\}\s*onClose=\{closeWaybillEdit\}\s*confirmClose=\{beginCloseWaybillEdit\}\s*onToast=\{setToast\}\s*reloadList=\{loadPageData\}/, "员工页交给编辑框的东西不对");
    // 真跑开 / 关 / ✕
    const fn = (name: string) => {
      const source = ts.createSourceFile(staffFile, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let found: ts.Node | undefined;
      const walk = (n: ts.Node) => { if (!found && ts.isVariableDeclaration(n) && n.name.getText() === name && n.initializer) found = n.initializer; if (!found) n.forEachChild(walk); };
      walk(source);
      assert.ok(found, `员工页找不到 ${name}`);
      return found!.getText(source);
    };
    const session = { current: 0 }, closeReq = { current: false };
    const log: Row[] = [];
    const ctx: Row = {
      waybillEditSessionRef: session, waybillEditCloseRequestedRef: closeReq,
      setWaybillEditId: (v: string) => log.push({ id: v }), setWaybillEditMeta: (v: Row) => log.push({ meta: v?.id }), setToast: (t: string) => log.push({ toast: t }),
    };
    const run = (name: string) => { const sandbox: Row = { module: { exports: {} }, ...ctx }; vm.runInNewContext(ts.transpileModule(`module.exports = ${fn(name)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox); return sandbox.module.exports; };
    const start = run("startWaybillEdit"), close = run("closeWaybillEdit"), beginClose = run("beginCloseWaybillEdit");
    start({ id: "s9", orderId: "o9", currentStatus: "pendingInbound" });
    assert.deepEqual(log, [{ toast: "这票货还是「待入库」，资料请到「到货通知」里补，补全后点「转正式运单」" }], "待入库的不开");
    assert.equal(session.current, 0);
    log.length = 0;
    closeReq.current = true;
    start({ id: "s1", orderId: "o1", currentStatus: "inWarehouseCN" });
    assert.deepEqual(log, [{ id: "o1" }, { meta: "s1" }]);
    assert.deepEqual([session.current, closeReq.current], [1, false], "打开要 +1、清掉「已经点了 ✕」");
    assert.equal(beginClose(), true);
    assert.deepEqual([session.current, closeReq.current], [2, true], "点 ✕ 那一刻 +1、记下");
    log.length = 0;
    close();
    assert.deepEqual([session.current, closeReq.current, log], [3, false, [{ id: "" }]]);
    // 离开运单管理：真跑员工页跟着 # 切分区那段
    const sourceFile = ts.createSourceFile(staffFile, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect: string | undefined;
    const walk = (n: ts.Node) => { if (!effect && ts.isCallExpression(n) && n.expression.getText() === "useEffect" && n.arguments[0]?.getText().includes("const syncSectionByHash")) effect = n.getText(sourceFile); if (!effect) n.forEachChild(walk); };
    walk(sourceFile);
    assert.ok(effect, "找不到员工页跟着 # 切分区那段");
    let listener: (() => void) | null = null;
    const win = { location: { hash: "#staff-order-shipment" }, addEventListener: (_t: string, l: () => void) => { listener = l; }, removeEventListener() {} };
    const sections: string[] = [], cleared: string[] = [];
    const s2 = { current: 0 }, c2 = { current: false };
    const sandbox: Row = {
      module: { exports: {} }, window: win, useEffect: (f: () => unknown) => { f(); },
      setActiveSection: (x: string) => sections.push(x), waybillEditSessionRef: s2, waybillEditCloseRequestedRef: c2, setWaybillEditId: (x: string) => cleared.push(x),
      isStaffSectionId: (v: string) => ["staff-order-shipment", "staff-prealert-review", "staff-lastmile"].includes(v),
    };
    vm.runInNewContext(ts.transpileModule(`module.exports = function () { ${effect}; };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
    sandbox.module.exports();
    const go = (h: string) => { win.location.hash = h; listener!(); };
    assert.equal(s2.current, 0, "一打开就在运单管理，不算离开");
    go("#staff-lastmile");
    assert.equal(s2.current, 1, "去了别的栏目要 +1");
    assert.deepEqual(cleared, [], "没点 ✕ 的弹窗离开时不关（回来还在）");
    go("#staff-order-shipment");
    assert.equal(s2.current, 1, "回到运单管理不 +1");
    go("#whatever");
    assert.equal(s2.current, 1, "不认识的 # 不切页、不算离开");
    c2.current = true;
    go("#staff-prealert-review");
    assert.deepEqual([s2.current, cleared, c2.current], [2, [""], false], "点了 ✕ 还在放动画就离开：替它关完");
  });

  await check("B1 后端：改运单给员工 / 超管；删运单、员工页旧的保存照旧只给超管；重置密码只认客户号、写的时候再核一次", () => {
    const admin = read("apps/api/src/modules/admin/routes.ts");
    const head = (route: string, file = admin) => { const at = file.indexOf(`app.post("${route}"`); assert.ok(at >= 0, route); return file.slice(at, at + 800).replace(/\/\*[\s\S]*?\*\//g, "").slice(0, 200); };
    assert.match(head("/admin/orders/update"), /requireRole\(req, res, \["admin", "staff"\]\)/);
    assert.match(head("/admin/orders/delete"), /requireRole\(req, res, \["admin"\]\)/, "删运单照旧只给超管");
    const orders = read("apps/api/src/modules/orders/routes.ts");
    assert.match(head("/staff/orders/patch-shipment-bundle", orders).replace(/\/\*[\s\S]*?\*\//g, ""), /requireRole\(req, res, \["admin"\]\)/, "员工页旧的「保存订单信息」照旧只给超管");
    const at = orders.indexOf('app.post("/staff/clients/set-password"');
    const body = orders.slice(at, orders.indexOf("\n  });", at));
    assert.match(body, /requireRole\(req, res, \["staff", "admin"\]\)/);
    assert.match(body, /where: \{ id, companyId: auth\.companyId \}/, "按公司找人");
    assert.match(body, /if \(user\.role !== "client"\) \{ fail\(res, 403/, "只认客户号");
    assert.match(body, /updateMany\(\{ where: \{ id: user\.id, companyId: auth\.companyId, role: "client" \}/, "写的时候再核一次是客户号");
    assert.match(body, /clearLoginFailures\(user\.id\);/, "重置完要清连错计数");
    assert.ok(!/checkPasswordStrength/.test(body), "客户密码不卡强度（2026-08-07 客户端不动）");
    assert.ok(!/password[^\n]*logger|logger[^\n]*password\b/.test(body.replace(/staff reset client password/, "")), "日志里不许带密码");
    // 重置密码不推送（名单、运单都没变；原来落到「运单」那一类，全公司页面白拉一遍）
    assert.match(read("apps/api/src/modules/realtime/topics.ts"), /const SKIP_EXACT[\s\S]*?"\/staff\/clients\/set-password",/);
    assert.match(orders, /要改资料请到「运单管理」里改）";/, "确认收货的提示别再叫员工找超管");
  });

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
