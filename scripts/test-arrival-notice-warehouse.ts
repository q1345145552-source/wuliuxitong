/**
 * 到货通知按仓库看（2026-11-20 老板：「这个地方有点乱……我觉得应该分仓库」，选 A「上面加一排仓库按钮」）—— 不连库那一半。
 * 连库的在 test-arrival-notices-db.ts 的 N54（后端按仓库筛、两种数字怎么数）。
 *
 * 整页真跑（假 React，接口换成桩，同 test-arrival-notice-snapshot-source.ts 的搭法）：
 *   W1 第一次打开（没记过）：看全部、请求不带仓库；按钮「全部仓库 / 义乌仓 / 广州仓 / 东莞仓 / 深圳仓」各带数字；没有「其他」
 *   W2 点「广州仓」：回第 1 页、请求带 wh_guangzhou_01、这台电脑记住、按钮按下去了、页签数字照后端回的
 *   W3 记住的仓下次打开直接用；记的是认不出的值就看全部；读不了本机存储也照样能看
 *   W4 「其他」：有没选仓库的才出来；记住的是它也出来
 *   W5 空着时说清是哪个仓空
 *   W6 看着某个仓点「登记到货」，仓库先填那个仓；看全部 / 其他照旧填上次登记选的
 *   W7 存完不在正看的仓下面：提示说在哪个仓；在的、看全部的不多说
 *   W8 上线那几分钟的老后端没回仓库数字（它也不认仓库参数、回的是全部）：整排仓库按钮藏起来、空列表不带「X仓：」、存完不多说那句；
 *      同一个页面里下一次碰上新后端就恢复（不用重开）
 *   W11 刚换了仓、新的还没回来 / 没取到：旧列表、页签 / 仓库数字、分页一起变灰，列表和分页锁住（inert）；旧的是空列表时说「正在加载…」、不说「X仓：没有…」；
 *       回来了恢复；没取到时点「重试」或再点一下同一个仓都能恢复
 *   W12 存完挪到了别的仓：屏上这份作废（变灰锁住）、大声刷新；刷新失败要报且一直锁着、点「重试」恢复；没挪仓的照旧悄悄刷；
 *       说不准在哪个仓（undefined）：不点名、照样作废大声刷新；作废之前就发出去、晚回来的那次不算刷新过；
 *       新登记到别的仓：只大声刷新、不锁（新卡本来不在屏上）；刷成了按现在看的仓重拉、挪走的卡没了
 *   W15 作废之前就在路上的悄悄重拉（推送）、作废之后那次大声刷新先失败、悄悄那次后成功：列表接着锁、报错和「重试」都还在；
 *       列表灰着（没报错）时再点同一个仓也会重拉
 *   W13 这页只在浏览器里画（外壳挂上之前是骨架），所以开页时读本机存储不会跟服务端那份对不上
 *   W10 门闩接线：列表的条件（listKey / 显示的是哪份 / 取数）都带仓库；弹窗真跑时新登记的仓库框先填正看的仓、修改时用原来的
 *   W9 后端：仓库参数只认四个仓 + other，「其他」把 NULL 单独 OR 进来；两种数字各数各的那一维
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 6).join("\n   ")}`); }
}

/* ───────────── 假 React（同 test-arrival-notice-snapshot-source.ts） ───────────── */
let hooks: any[] = [], index = 0, effects: Array<() => unknown> = [], cleanups: Array<() => void> = [], dirty = false;
const fakeReact = {
  useState(init: any) {
    const i = index++;
    if (!(i in hooks)) hooks[i] = typeof init === "function" ? init() : init;
    return [hooks[i], (v: any) => { const n = typeof v === "function" ? v(hooks[i]) : v; if (!Object.is(n, hooks[i])) { hooks[i] = n; dirty = true; } }];
  },
  useRef(init: any) { const i = index++; return hooks[i] ?? (hooks[i] = { current: init }); },
  useMemo(fn: any, deps: unknown[]) {
    const i = index++, old = hooks[i];
    if (!old || deps.some((d, j) => !Object.is(d, old.deps[j]))) hooks[i] = { deps, value: fn() };
    return hooks[i].value;
  },
  useEffect(fn: any, deps: unknown[]) {
    const i = index++, old = hooks[i];
    if (!old || deps.some((d, j) => !Object.is(d, old[j]))) { hooks[i] = deps; effects.push(fn); }
  },
  // 跟真 React 一样按依赖记住（不记的话每画一次就换一个 load，effect 每次都重跑一遍取数，照不出「悄悄刷 / 要报错」的区别）
  useCallback(fn: any, deps: unknown[]) {
    const i = index++, old = hooks[i];
    if (!old || !deps || deps.some((d, j) => !Object.is(d, old.deps[j]))) hooks[i] = { deps, value: fn };
    return hooks[i].value;
  },
  // 页面靠它把最新的 load 放进 loadRef：这里当场跑（不用等画完）
  useLayoutEffect(fn: any) { index++; fn(); },
};
const runtime = { jsx: (type: any, p: any, key: any) => ({ type, props: p, key }), jsxs: (type: any, p: any, key: any) => ({ type, props: p, key }), Fragment: "fragment" };

/** 本机存储：store 为 null = 读写都抛错（隐私模式） */
let store: Map<string, string> | null = new Map();
(globalThis as any).window = {
  setTimeout, clearTimeout, confirm: () => true,
  localStorage: {
    getItem: (k: string) => { if (!store) throw new Error("denied"); return store.has(k) ? store.get(k)! : null; },
    setItem: (k: string, v: string) => { if (!store) throw new Error("denied"); store.set(k, String(v)); },
  },
};

type Counts = Record<string, number>;
let calls: Array<Record<string, unknown>> = [];
/** hold = true：取数先挂着，测试自己决定什么时候回 / 失败 */
let hold = false;
let held: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
let failAll = false;
let reply: { items: any[]; counts: Counts; warehouseCounts?: Counts } = { items: [], counts: {}, warehouseCounts: undefined };
function load(rel: string, extraExports = ""): any {
  const file = path.join(ROOT, rel);
  const realRequire = createRequire(file);
  const out = ts.transpileModule(fs.readFileSync(file, "utf8") + extraExports, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: file,
  }).outputText;
  const mod = { exports: {} as any };
  new Function("exports", "require", "module", out)(mod.exports, (id: string) => {
    if (id === "react") return fakeReact;
    if (id === "react/jsx-runtime") return runtime;
    if (id === "../layout/DetailModal") return { __esModule: true, default: function DetailModal(p: any) { return { type: "modal", props: p }; } };
    const real = realRequire(id);
    if (id === "../../services/arrival-notice-api") {
      return {
        ...real,
        fetchArrivalNotices: async (opts: Record<string, unknown>) => {
          calls.push({ ...opts });
          if (hold) await new Promise<void>((resolve, reject) => held.push({ resolve, reject }));
          if (failAll) throw new Error("网络断了");
          return { items: reply.items, total: reply.items.length, page: opts.page ?? 1, pageSize: 30, counts: reply.counts, ...(reply.warehouseCounts ? { warehouseCounts: reply.warehouseCounts } : {}) };
        },
      };
    }
    if (id === "../../services/business-api") return { ...real, fetchStaffClients: async () => [] };
    // 记下页面交给实时推送的列表重拉函数（「运输」那一类；另一个是「账号」推送重拉客户名单），测试里当成「推送来了」调（悄悄重拉）
    if (id === "../realtime/useRealtime") return { useLiveRefresh(o: any) { if (o.topics.includes("shipping")) liveRefresh = o.refresh; } };
    return real;
  }, mod);
  return mod.exports;
}
let liveRefresh: ((isStillWanted: () => boolean) => Promise<void>) | null = null;
const View = load("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx", "\nexport { emptyDraft, NoticeEditor };");

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

let viewTree: any;
function render() {
  for (let n = 0; n < 30; n++) {
    index = 0; dirty = false; viewTree = View.default({});
    const queue = effects; effects = [];
    for (const fn of queue) { const c = fn(); if (typeof c === "function") cleanups.push(c as () => void); }
    if (!dirty) return;
  }
  throw new Error("整页无限重画");
}
async function settle() {
  render();
  // 搜索框有 300 毫秒防抖（会把页码拨回 1），等它走完再看
  await new Promise<void>((r) => setTimeout(r, 330));
  for (let i = 0; i < 6; i++) { await new Promise<void>((r) => setImmediate(r)); render(); }
}
async function mount() {
  cleanups.forEach((c) => c());
  hooks = []; effects = []; cleanups = []; calls = [];
  await settle();
}
const whBar = () => nodes((n) => n.props?.className === "an-warehouses", viewTree)[0];
const whButtons = () => nodes((n) => n.type === "button" && /\ban-wh\b/.test(n.props?.className ?? ""), whBar());
const whLabels = () => whButtons().map((b) => text(b));
const pressed = () => whButtons().filter((b) => b.props["aria-pressed"] === true).map((b) => text(b));
const clickWh = async (label: string) => {
  const b = whButtons().find((x) => text(x).startsWith(label));
  assert.ok(b, `没有「${label}」按钮：${whLabels().join(" / ")}`);
  b.props.onClick();
  await settle();
};
const lastCall = () => calls[calls.length - 1];
const toastMessage = () => nodes((n) => typeof n.type === "function" && n.type.name === "Toast", viewTree)[0]?.props.message ?? "";
const editorEl = () => nodes((n) => typeof n.type === "function" && n.type.name === "NoticeEditor", viewTree)[0];

const COUNTS = { todo: 9, notified: 4, inbound: 0, formal: 196, all: 201 };
const WH = { all: 9, wh_yiwu_01: 1, wh_guangzhou_01: 3, wh_dongguan_01: 0, wh_shenzhen_01: 5, other: 0 };

async function main(): Promise<void> {
  console.log("到货通知按仓库看（不连库）");

  await check("W1 第一次打开（没记过）：看全部、请求不带仓库；五个按钮各带数字，「全部仓库」按下；没有「其他」", async () => {
    store = new Map();
    reply = { items: [], counts: COUNTS, warehouseCounts: WH };
    await mount();
    assert.equal(lastCall().warehouse, "", "没记过 = 看全部");
    assert.equal(lastCall().tab, "todo");
    assert.deepEqual(whLabels(), ["全部仓库9", "义乌仓1", "广州仓3", "东莞仓0", "深圳仓5"]);
    assert.deepEqual(pressed(), ["全部仓库9"]);
    assert.equal(whBar().props.role, "group");
  });

  await check("W2 翻到第 2 页再点「广州仓」：回第 1 页、请求带 wh_guangzhou_01、记住、按钮按下；页签数字照后端回的", async () => {
    store = new Map();
    // 列表多于一页才有「下一页」：让后端回 31 条，先翻到第 2 页
    reply = { items: Array.from({ length: 31 }, (_, i) => ({ id: `n${i}`, images: [], products: [], prealertMatches: [] })), counts: COUNTS, warehouseCounts: WH };
    await mount();
    const next = nodes((n) => n.type === "button" && text(n) === "下一页", viewTree)[0];
    assert.ok(next, "没画出「下一页」");
    next.props.onClick(); await settle();
    assert.equal(lastCall().page, 2);
    // 广州仓那次要回非空：空的话页面自己会退回上一页（「删掉最后一条别停在空白页」），照不出换仓没回第 1 页
    reply = { items: Array.from({ length: 3 }, (_, i) => ({ id: `g${i}`, images: [], products: [], prealertMatches: [] })), counts: { todo: 3, notified: 0, inbound: 0, formal: 0, all: 3 }, warehouseCounts: WH };
    const before = calls.length;
    await clickWh("广州仓");
    // 不数次数（换仓时 load 换了、effect 跑一次，搜索框防抖也可能再跑一次），只看换仓之后有没有按第 2 页查过
    const after = calls.slice(before);
    assert.ok(after.length > 0 && after.every((c) => c.page === 1 && c.warehouse === "wh_guangzhou_01"), `换仓那一下就要按第 1 页查：${JSON.stringify(after)}`);
    assert.deepEqual([lastCall().warehouse, lastCall().page, lastCall().tab], ["wh_guangzhou_01", 1, "todo"]);
    assert.equal(store!.get("xt_arrival_list_warehouse"), "wh_guangzhou_01", "这台电脑要记住");
    assert.deepEqual(pressed(), ["广州仓3"]);
    const tabCount = nodes((n) => n.type === "button" && n.props?.role === "tab" && n.props["aria-selected"] === true, viewTree)[0];
    assert.equal(text(tabCount), "待通知3", "页签数字按选的仓");
    await clickWh("全部仓库");
    assert.equal(lastCall().warehouse, "");
    assert.equal(store!.get("xt_arrival_list_warehouse"), "", "点回全部也要记住（下次打开是全部）");
  });

  await check("W3 记住的仓下次打开直接用；认不出的值看全部；读不了本机存储也照样能看、点了不报错", async () => {
    store = new Map([["xt_arrival_list_warehouse", "wh_shenzhen_01"]]);
    reply = { items: [], counts: COUNTS, warehouseCounts: WH };
    await mount();
    assert.equal(calls[0].warehouse, "wh_shenzhen_01", "第一次请求就要带记住的仓（不能先拉一遍全部）");
    assert.deepEqual(pressed(), ["深圳仓5"]);
    for (const junk of ["wh_bangkok", "WH_YIWU_01", "all", "全部"]) {
      store = new Map([["xt_arrival_list_warehouse", junk]]);
      await mount();
      assert.equal(calls[0].warehouse, "", `记的是「${junk}」：看全部`);
    }
    store = null;
    await mount();
    assert.equal(calls[0].warehouse, "");
    await clickWh("义乌仓");
    assert.equal(lastCall().warehouse, "wh_yiwu_01", "记不住也照样能切");
    store = new Map();
  });

  await check("W4 「其他」：有没选仓库的才出来（带数字、有说明）；记住的是它也出来；点它请求带 other", async () => {
    store = new Map();
    reply = { items: [], counts: COUNTS, warehouseCounts: { ...WH, all: 11, other: 2 } };
    await mount();
    assert.deepEqual(whLabels(), ["全部仓库11", "义乌仓1", "广州仓3", "东莞仓0", "深圳仓5", "其他2"]);
    const other = whButtons()[5];
    assert.match(other.props.title, /没选仓库/);
    await clickWh("其他");
    assert.equal(lastCall().warehouse, "other");
    reply = { items: [], counts: COUNTS, warehouseCounts: WH };
    store = new Map([["xt_arrival_list_warehouse", "other"]]);
    await mount();
    assert.equal(calls[0].warehouse, "other");
    assert.deepEqual(whLabels().slice(-1), ["其他0"], "正看着「其他」，数字变 0 了按钮也不能消失（不然没法点回别的说不清）");
    assert.deepEqual(pressed(), ["其他0"]);
  });

  await check("W5 空着的时候说清是哪个仓空；看全部照原来的话", async () => {
    store = new Map([["xt_arrival_list_warehouse", "wh_dongguan_01"]]);
    reply = { items: [], counts: { todo: 0, notified: 0, inbound: 0, formal: 0, all: 0 }, warehouseCounts: WH };
    await mount();
    const empty = () => text(nodes((n) => n.props?.className === "an-empty", viewTree)[0]);
    assert.equal(empty(), "东莞仓：没有要通知的到货。新到的货点右上角「登记到货」。");
    await clickWh("全部仓库");
    assert.equal(empty(), "没有要通知的到货。新到的货点右上角「登记到货」。");
  });

  await check("W6 看着某个仓点「登记到货」：仓库先填那个仓；看全部 / 其他照旧填上次登记选的；上次登记的认不出就空着", async () => {
    store = new Map([["xt_arrival_last_warehouse", "wh_yiwu_01"]]);
    assert.equal(View.emptyDraft("wh_guangzhou_01").warehouseId, "wh_guangzhou_01");
    assert.equal(View.emptyDraft("").warehouseId, "wh_yiwu_01");
    assert.equal(View.emptyDraft("other").warehouseId, "wh_yiwu_01");
    store = new Map([["xt_arrival_last_warehouse", "wh_bangkok"]]);
    assert.equal(View.emptyDraft("").warehouseId, "");
    store = null;
    assert.equal(View.emptyDraft("").warehouseId, "", "读不了本机存储就空着");
    assert.equal(View.emptyDraft("wh_shenzhen_01").warehouseId, "wh_shenzhen_01", "读不了本机存储照样先填正看的仓");
    store = new Map();
    // 页面把正看的仓交给弹窗
    store = new Map([["xt_arrival_list_warehouse", "wh_guangzhou_01"]]);
    reply = { items: [], counts: COUNTS, warehouseCounts: WH };
    await mount();
    const add = nodes((n) => n.type === "button" && text(n) === "＋ 登记到货", viewTree)[0];
    add.props.onClick(); render();
    assert.equal(editorEl().props.viewingWarehouse, "wh_guangzhou_01");
  });

  /** 单独把弹窗真跑一遍（借一套自己的 hooks，跑完还回去），拿仓库那个下拉的值 */
  const editorWarehouseValue = (props: Record<string, unknown>): string => {
    const saved = { hooks, index, effects };
    hooks = []; index = 0; effects = [];
    try {
      const t = View.NoticeEditor({ clients: [], bannedClients: new Set(), clientsFailed: false, onClose() {}, onSaved() {}, onChanged() {}, ...props });
      const sel = nodes((n) => n.type === "select" && nodes((o) => o.type === "option" && o.props?.value === "wh_yiwu_01", n.props?.children).length > 0, t)[0];
      assert.ok(sel, "弹窗里找不到仓库下拉");
      return sel.props.value;
    } finally { hooks = saved.hooks; index = saved.index; effects = saved.effects; }
  };

  await check("W6b 弹窗真跑：新登记的仓库框先填正看的仓；看全部填上次登记的；修改时用这条原来的仓、不被正看的仓盖掉", () => {
    store = new Map([["xt_arrival_last_warehouse", "wh_yiwu_01"]]);
    assert.equal(editorWarehouseValue({ editor: { mode: "new", seq: 1 }, viewingWarehouse: "wh_shenzhen_01" }), "wh_shenzhen_01");
    assert.equal(editorWarehouseValue({ editor: { mode: "new", seq: 1 }, viewingWarehouse: "" }), "wh_yiwu_01");
    const item = { id: "e1", clientId: "ZZA01", trackingNo: "YW1", warehouseId: "wh_dongguan_01", transportMode: "sea", arrivedAt: "2026-11-20", weightKg: null, volumeM3: null, remark: null,
      products: [], itemName: null, packageCount: null, cargoType: null, domesticTrackingNo: null, notifiedAt: null, convertedTo: null, shipmentId: null, images: [], prealertMatches: [] };
    assert.equal(editorWarehouseValue({ editor: { mode: "edit", item, seq: 2 }, viewingWarehouse: "wh_shenzhen_01" }), "wh_dongguan_01", "修改时不能被正看的仓盖掉");
    store = new Map();
  });

  await check("W7 存完不在正看的仓下面：提示说在哪个仓；在的、看全部的不多说；没选仓库的算「其他」", async () => {
    store = new Map([["xt_arrival_list_warehouse", "wh_guangzhou_01"]]);
    reply = { items: [], counts: COUNTS, warehouseCounts: WH };
    const saveAndRead = async (warehouseId: string | null) => {
      const add = nodes((n) => n.type === "button" && text(n) === "＋ 登记到货", viewTree)[0];
      add.props.onClick(); render();
      editorEl().props.onSaved("已登记，可以复制文案通知客户了", warehouseId); render();
      assert.equal(editorEl(), undefined, "存完弹窗要关");
      return toastMessage();
    };
    await mount();
    assert.equal(await saveAndRead("wh_yiwu_01"), "已登记，可以复制文案通知客户了。这条在「义乌仓」下面，现在看的是「广州仓」，所以这里不显示");
    assert.equal(await saveAndRead("wh_guangzhou_01"), "已登记，可以复制文案通知客户了");
    assert.equal(await saveAndRead(null), "已登记，可以复制文案通知客户了。这条在「其他」下面，现在看的是「广州仓」，所以这里不显示");
    assert.equal(await saveAndRead("wh_retired_zz"), "已登记，可以复制文案通知客户了。这条在「其他」下面，现在看的是「广州仓」，所以这里不显示");
    await clickWh("全部仓库");
    assert.equal(await saveAndRead("wh_yiwu_01"), "已登记，可以复制文案通知客户了", "看全部：哪个仓都看得到，不多说");
    store = new Map([["xt_arrival_list_warehouse", "other"]]);
    await mount();
    assert.equal(await saveAndRead(null), "已登记，可以复制文案通知客户了", "看「其他」时存了没选仓库的：就在这里");
    // 弹窗里两条保存路（新登记 / 修改、超管改已转运单）都把存完的仓库交回来
    const v = read("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
    assert.equal((v.match(/props\.onSaved\(/g) ?? []).length, 2, "props.onSaved 多了 / 少了一处，看看新的那处带没带仓库");
    assert.match(v, /props\.onSaved\(message, landsIn\);/);
    assert.match(v, /props\.onSaved\(doneMessage, landsIn\);/);
    assert.match(v, /const \{ item \} = await saveArrivalNotice\(id, draft, base\);\s*id = item\.id;\s*landsIn = item\.warehouseId;/, "新登记 / 修改：按后端存上的仓库说");
    // 改已转运单那条路怎么交回仓库（刷新成功 / 失败没改仓 / 失败改了仓说不准）在 test-arrival-notice-converted-edit.ts 的 B14 真跑弹窗钉住
  });

  await check("W8 上线那几分钟的老后端没回仓库数字（也不认仓库参数、回的是全部）：整排藏起来，不能亮着「深圳仓」底下列全部；空列表不带「深圳仓：」；存完不多说那句；同一页面下次碰上新后端就恢复", async () => {
    store = new Map([["xt_arrival_list_warehouse", "wh_shenzhen_01"]]);
    reply = { items: [], counts: COUNTS };
    await mount();
    assert.equal(whBar(), undefined, "老后端：仓库那排要藏起来");
    const add = nodes((n) => n.type === "button" && text(n) === "＋ 登记到货", viewTree)[0];
    add.props.onClick(); render();
    assert.equal(editorEl().props.viewingWarehouse, "", "旧后端：关闭隐藏的筛选默认值，保留原有登记偏好");
    editorEl().props.onSaved("已登记，可以复制文案通知客户了", "wh_yiwu_01"); render();
    assert.equal(toastMessage(), "已登记，可以复制文案通知客户了", "老后端哪条都在这一页，不能说「这里不显示」");
    assert.equal(text(nodes((n) => n.props?.className === "an-empty", viewTree)[0]), "没有要通知的到货。新到的货点右上角「登记到货」。", "仓库那排藏了：空列表不能写「深圳仓：」");
    // 同一个页面（不重开）下一次碰上新后端：照常出来（这里用换页签触发一次取数）
    reply = { items: [], counts: COUNTS, warehouseCounts: WH };
    const notifiedTab = nodes((n) => n.type === "button" && n.props?.role === "tab" && text(n).startsWith("已通知"), viewTree)[0];
    notifiedTab.props.onClick(); await settle();
    assert.deepEqual(pressed(), ["深圳仓5"], "新后端回来了：整排照常出来、还是记住的深圳仓");
    store = new Map();
  });

  const listEl = () => nodes((n) => typeof n.props?.className === "string" && /^an-list\b/.test(n.props.className), viewTree)[0];
  const alertText = () => text(nodes((n) => n.props?.role === "alert", viewTree)[0]);
  const flushHeld = async (fail = false) => {
    const q = held; held = [];
    q.forEach((h) => (fail ? h.reject(new Error("网络断了")) : h.resolve()));
    for (let i = 0; i < 4; i++) { await new Promise<void>((r) => setImmediate(r)); render(); }
  };

  await check("W11 刚换了仓、新的还没回来：旧列表 / 数字 / 分页一起变灰，列表和分页锁住；旧的是空的说「正在加载…」不说「X仓：没有…」；回来了恢复；没取到一直锁着、报错，点「重试」或再点同一个仓能恢复", async () => {
    store = new Map();
    const gz = Array.from({ length: 3 }, (_, i) => ({ id: `g${i}`, images: [], products: [], prealertMatches: [] }));
    reply = { items: gz, counts: COUNTS, warehouseCounts: WH };
    await mount();
    assert.equal(listEl().props.className, "an-list");
    assert.equal(listEl().props.inert, undefined);
    hold = true;
    await clickWh("深圳仓");
    assert.equal(listEl().props.className, "an-list is-stale", "新仓还没回来：旧列表要变灰");
    const pageEl = () => nodes((n) => typeof n.props?.className === "string" && /^an-page\b/.test(n.props.className), viewTree)[0];
    assert.equal(pageEl().props.className, "an-page is-stale", "页签 / 仓库按钮上的数字也是广州的：整页标上，数字一起变淡");
    assert.equal(listEl().props.inert, true, "旧卡片点不了");
    assert.equal(listEl().props["aria-busy"], true);
    reply = { items: [], counts: COUNTS, warehouseCounts: WH };
    await flushHeld();
    hold = false;
    await settle();
    assert.equal(listEl().props.className, "an-list", "回来了就恢复");
    assert.equal(text(nodes((n) => n.props?.className === "an-empty", viewTree)[0]), "深圳仓：没有要通知的到货。新到的货点右上角「登记到货」。");
    // 空着的时候再换仓：等新的那会儿不能拿「广州仓」去说旧的空列表
    hold = true;
    await clickWh("广州仓");
    assert.equal(nodes((n) => n.props?.className === "an-empty", viewTree).length, 0, "新仓还没回来，不能说「广州仓：没有…」");
    assert.equal(text(nodes((n) => typeof n.props?.className === "string" && n.props.className.includes("an-late"), viewTree)[0]), "正在加载…", "旧的是空列表：等的时候说一句");
    // 没取到：一直锁着，报错；「正在加载…」不说了
    await flushHeld(true);
    hold = false;
    render();
    assert.equal(listEl().props.className, "an-list is-stale", "没取到：还是上一个仓的，接着锁着");
    assert.match(alertText(), /列表没取到：网络断了/);
    assert.equal(nodes((n) => typeof n.props?.className === "string" && n.props.className.includes("an-late"), viewTree).length, 0);
    // 再点一下同一个仓（员工最可能的第一反应）：真去重拉，恢复
    reply = { items: gz, counts: { todo: 3, notified: 0, inbound: 0, formal: 0, all: 3 }, warehouseCounts: WH };
    await clickWh("广州仓");
    assert.equal(listEl().props.className, "an-list", "再点同一个仓要重拉、恢复");
    assert.equal(alertText(), "");
    // 换仓又没取到 → 点「重试」也能恢复
    failAll = true;
    await clickWh("义乌仓");
    assert.equal(listEl().props.className, "an-list is-stale");
    failAll = false;
    const retry = nodes((n) => n.type === "button" && text(n) === "重试", viewTree)[0];
    assert.ok(retry, "报错里要有「重试」");
    retry.props.onClick(); await settle();
    assert.equal(listEl().props.className, "an-list", "点「重试」恢复");
    assert.equal(pageEl().props.className, "an-page");
    // 分页：多于一页时，换仓等新的那会儿分页也锁住
    reply = { items: Array.from({ length: 31 }, (_, i) => ({ id: `p${i}`, images: [], products: [], prealertMatches: [] })), counts: COUNTS, warehouseCounts: WH };
    await clickWh("全部仓库");
    const pager = () => nodes((n) => typeof n.props?.className === "string" && /^an-pager\b/.test(n.props.className), viewTree)[0];
    assert.equal(pager().props.className, "an-pager");
    hold = true;
    await clickWh("深圳仓");
    assert.equal(pager().props.className, "an-pager is-stale", "分页还是全部仓的：变灰");
    assert.equal(pager().props.inert, true, "分页点不了");
    await flushHeld();
    hold = false;
    await settle();
  });

  await check("W12 改了列表里一张卡、存完挪到了别的仓：屏上这份作废（变灰锁住）、大声刷新；失败报错且一直锁着、点「重试」恢复；没挪仓的照旧悄悄刷；说不准的不点名照样作废；作废前发出去晚回来的不算", async () => {
    store = new Map([["xt_arrival_list_warehouse", "wh_guangzhou_01"]]);
    const card0 = { id: "g0", warehouseId: "wh_guangzhou_01", clientId: "ZZA01", trackingNo: "GZ1", images: [], products: [], prealertMatches: [], convertedTo: null, notifiedAt: null };
    reply = { items: [card0], counts: COUNTS, warehouseCounts: WH };
    await mount();
    const cards = () => nodes((n) => typeof n.type === "function" && n.type.name === "NoticeCard", viewTree);
    const editAndSave = async (wh: string | null | undefined) => {
      cards()[0].props.onEdit(); render();
      assert.equal(editorEl().props.editor.mode, "edit", "点的是列表里那张卡的「修改」");
      editorEl().props.onSaved("已保存", wh);
      for (let i = 0; i < 4; i++) { await new Promise<void>((r) => setImmediate(r)); render(); }
    };
    failAll = true;
    await editAndSave("wh_guangzhou_01");
    assert.equal(alertText(), "", "没挪仓：悄悄刷，失败不报（原来的规矩）");
    assert.equal(listEl().props.className, "an-list");
    await editAndSave("wh_yiwu_01");
    assert.match(toastMessage(), /这条在「义乌仓」下面，现在看的是「广州仓」/);
    assert.match(alertText(), /列表没取到：网络断了/, "挪到别的仓：刷新失败要报");
    assert.equal(listEl().props.className, "an-list is-stale", "那张卡还列着：变灰");
    assert.equal(listEl().props.inert, true, "还能点的话就跟「这里不显示」对不上：锁住");
    failAll = false;
    nodes((n) => n.type === "button" && text(n) === "重试", viewTree)[0].props.onClick(); await settle();
    assert.equal(listEl().props.className, "an-list", "点「重试」刷成了：恢复");
    // 刷新成功的正常情况：按现在看的广州仓重拉，挪走的那张卡没了，恢复
    reply = { items: [], counts: COUNTS, warehouseCounts: WH };
    reply.items = [card0];
    const beforeMove = calls.length;
    cards()[0].props.onEdit(); render();
    reply.items = []; // 后端那边它已经在义乌了：广州这页不再有它
    editorEl().props.onSaved("已保存", "wh_yiwu_01");
    await settle();
    assert.ok(calls.slice(beforeMove).length > 0 && calls.slice(beforeMove).every((c) => c.warehouse === "wh_guangzhou_01"), "存完按现在看的仓重拉");
    assert.equal(listEl().props.className, "an-list");
    assert.equal(cards().length, 0, "挪走的那张卡从广州仓列表里没了");
    // 下面几步还要拿这张卡来改：让它「回来」（推送来一次悄悄重拉）
    reply.items = [card0];
    await liveRefresh!(() => true);
    await settle();
    assert.equal(cards().length, 1);
    // 说不准（超管改已转运单、卡片没刷新成）：不点名哪个仓，照样作废 + 大声刷新
    failAll = true;
    await editAndSave(undefined);
    assert.equal(toastMessage(), "已保存", "说不准就不点名");
    assert.equal(listEl().props.className, "an-list is-stale");
    assert.match(alertText(), /列表没取到/);
    failAll = false;
    nodes((n) => n.type === "button" && text(n) === "重试", viewTree)[0].props.onClick(); await settle();
    assert.equal(listEl().props.className, "an-list");
    // 新登记到别的仓、刷新失败：屏上这份本来就有效（新卡不在这里），报错但不锁（审查第 5 轮 dsh）
    await settle();
    failAll = true;
    nodes((n) => n.type === "button" && text(n) === "＋ 登记到货", viewTree)[0].props.onClick(); render();
    assert.equal(editorEl().props.editor.mode, "new");
    editorEl().props.onSaved("已登记，可以复制文案通知客户了", "wh_yiwu_01");
    for (let i = 0; i < 4; i++) { await new Promise<void>((r) => setImmediate(r)); render(); }
    assert.match(toastMessage(), /这条在「义乌仓」下面/);
    assert.match(alertText(), /列表没取到/, "刷新照样大声，失败要报");
    assert.equal(listEl().props.className, "an-list", "新登记的不在屏上：列表不锁");
    failAll = false;
    nodes((n) => n.type === "button" && text(n) === "重试", viewTree)[0].props.onClick(); await settle();
    // 作废之前就发出去、晚回来的那次不算刷新过：连着挪两次，第一次那趟先回来 —— 还得锁着，第二次那趟回来才恢复
    hold = true;
    await editAndSave("wh_yiwu_01");
    await editAndSave("wh_shenzhen_01");
    assert.equal(held.length, 2, `应该挂着两趟刷新：${held.length}`);
    held.shift()!.resolve();
    for (let i = 0; i < 4; i++) { await new Promise<void>((r) => setImmediate(r)); render(); }
    assert.equal(listEl().props.className, "an-list is-stale", "第二次作废之前发出去的那趟不算");
    held.shift()!.resolve();
    hold = false;
    for (let i = 0; i < 4; i++) { await new Promise<void>((r) => setImmediate(r)); render(); }
    assert.equal(listEl().props.className, "an-list", "第二次作废之后发出去的那趟回来了：恢复");
    store = new Map();
  });

  await check("W15 作废前就在路上的悄悄重拉（推送）晚回来：不算刷新过、也不清掉作废后那次的报错和「重试」；列表灰着时再点同一个仓也重拉", async () => {
    store = new Map([["xt_arrival_list_warehouse", "wh_guangzhou_01"]]);
    const card0 = { id: "g0", warehouseId: "wh_guangzhou_01", clientId: "ZZA01", trackingNo: "GZ1", images: [], products: [], prealertMatches: [], convertedTo: null, notifiedAt: null };
    reply = { items: [card0], counts: COUNTS, warehouseCounts: WH };
    await mount();
    assert.ok(liveRefresh, "页面没接实时推送");
    const tick = async () => { for (let i = 0; i < 4; i++) { await new Promise<void>((r) => setImmediate(r)); render(); } };
    const cards = () => nodes((n) => typeof n.type === "function" && n.type.name === "NoticeCard", viewTree);
    hold = true;
    void liveRefresh!(() => true); await tick();          // A：推送来的悄悄重拉，挂着
    cards()[0].props.onEdit(); render();
    editorEl().props.onSaved("已保存", "wh_yiwu_01"); await tick(); // 作废 + B：大声刷新，挂着
    assert.equal(held.length, 2, `应该挂着 A、B 两趟：${held.length}`);
    const [a, b] = held; held = [];
    b.reject(new Error("网络断了")); await tick();
    assert.match(alertText(), /列表没取到：网络断了/);
    a.resolve(); await tick();
    assert.equal(listEl().props.className, "an-list is-stale", "A 是作废之前发出去的：不算刷新过，接着锁");
    assert.match(alertText(), /列表没取到/, "A 回来不许把 B 的报错清掉（清了就锁着又没地方点重试）");
    assert.ok(nodes((n) => n.type === "button" && text(n) === "重试", viewTree)[0], "「重试」还在");
    hold = false;
    nodes((n) => n.type === "button" && text(n) === "重试", viewTree)[0].props.onClick(); await settle();
    assert.equal(listEl().props.className, "an-list", "重试成功：恢复");
    // 灰着、没报错（作废后那趟还在路上）时再点一下同一个仓：真去重拉
    hold = true;
    cards()[0].props.onEdit(); render();
    editorEl().props.onSaved("已保存", "wh_yiwu_01"); await tick();
    assert.equal(alertText(), "");
    const before = calls.length;
    await clickWh("广州仓");
    assert.ok(calls.length > before, "灰着时再点同一个仓要重拉");
    held.forEach((h) => h.resolve()); held = [];
    hold = false;
    await tick();
    assert.equal(listEl().props.className, "an-list");
    store = new Map();
  });

  await check("W13 这页只在浏览器里画：外壳挂上之前是骨架、不画页面内容，到货通知在工作台外壳的名单里（开页读本机存储才不会跟服务端那份对不上）", () => {
    const frame = read("apps/web/src/modules/layout/WorkbenchFrame.tsx");
    assert.match(frame, /"\/staff\/arrival-notices": "到货通知",/, "到货通知不在工作台外壳里了：开页时读本机存储要改成挂上之后再读");
    const shell = read("apps/web/src/modules/layout/RoleShell.tsx");
    const start = shell.indexOf("\n  if (!mounted) {\n");
    const branch = shell.slice(start, shell.indexOf("\n  if (!session) {\n", start));
    assert.ok(start > 0 && branch.length > 0, "RoleShell 里找不到「挂上之前」那段");
    assert.ok(branch.includes("shell-skeleton") && !branch.includes("children"), "外壳挂上之前要只画骨架、不画页面内容");
    assert.match(shell, /const \[mounted, setMounted\] = useState\(\(\) => readOnRemount\(\(\) => true, false\)\);/);
    const v = read("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
    assert.match(v, /useState<WarehouseView>\(\(\) => \(typeof window === "undefined" \? "" : readListWarehouse\(\)\)\)/);
  });

  await check("W14 变灰的样式真在：列表 / 分页变淡点不了、数字一起变淡（都晚 0.25 秒才显出来）；「正在加载…」晚 0.25 秒淡入；选中的仓停鼠标也保留深边", () => {
    const css = read("apps/web/src/app/globals.css");
    assert.ok(css.includes(".an-list.is-stale, .an-pager.is-stale { opacity: 0.45; pointer-events: none; transition: opacity 0.15s ease 0.25s; }"));
    assert.ok(css.includes(".an-page.is-stale :is(.an-tab-count, .an-wh-count) { opacity: 0.3; transition: opacity 0.15s ease 0.25s; }"));
    assert.ok(css.includes(".an-late { animation: an-late-in 0.15s ease 0.25s both; }"));
    assert.ok(css.includes(".an-wh.is-active, .an-wh.is-active:hover:not(:disabled) { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink);"));
    // 页面上数字那两个 span 的类名没改（不然上面那条样式就挂空了）
    const v = read("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
    assert.ok(v.includes('<span className="an-wh-count">') && v.includes('<span className="an-tab-count">'));
  });

  await check("W10 门闩接线：列表条件、显示的是哪份、取数、load 的依赖都带仓库（依赖数组写漏了假 React 照不出来，看源码钉住）", () => {
    const v = read("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
    assert.match(v, /const listKey = useMemo\(\(\) => \(\{ tab, keyword, page, warehouse \}\), \[tab, keyword, page, warehouse\]\);/);
    assert.match(v, /const key = JSON\.stringify\(\[tab, keyword, page, warehouse\]\);/);
    assert.match(v, /await fetchArrivalNotices\(\{ tab, keyword, page, pageSize: PAGE_SIZE, warehouse \}\);/);
    assert.match(v, /\}, \[tab, keyword, page, warehouse, listKey, gate\]\);/);
    assert.match(v, /createQueryGate<\{ tab: string; keyword: string; page: number; warehouse: string \}>\(\)/);
  });

  await check("W9 后端：仓库参数只认四个仓 + other；「其他」把 NULL 单独 OR 进来；页签数字带仓库条件、仓库数字不带；四个仓跟登记那份同一张单子", () => {
    const api = read("apps/api/src/modules/arrival-notices/routes.ts");
    assert.match(api, /const WAREHOUSE_FILTERS = \[\.\.\.ARRIVAL_WAREHOUSE_IDS, "other"\] as const;/);
    assert.match(api, /if \(w === "other"\) return \{ OR: \[\{ warehouseId: null \}, \{ warehouseId: \{ notIn: \[\.\.\.ARRIVAL_WAREHOUSE_IDS\] \} \}\] \};/);
    assert.match(api, /for \(const t of TABS\) counts\.push\(await tx\.arrivalNotice\.count\(\{ where: \{ AND: \[base, search, tabWhere\(t, gone\), byWarehouse\] \} \}\)\);/);
    assert.match(api, /groupBy\(\{ by: \["warehouseId"\], where: \{ AND: \[base, search, tabWhere\(tab, gone\)\] \}/);
    const { ARRIVAL_WAREHOUSE_IDS } = require("../apps/api/src/modules/arrival-notices/rules");
    const v = read("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
    const pageIds = [...v.slice(v.indexOf("const WAREHOUSES = ["), v.indexOf("];", v.indexOf("const WAREHOUSES = ["))).matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...pageIds].sort(), [...ARRIVAL_WAREHOUSE_IDS].sort(), "页面的仓库按钮跟后端认的四个仓对不上");
    const svc = read("apps/web/src/services/arrival-notice-api.ts");
    const typeIds = [...(svc.match(/export type ArrivalWarehouseFilter = ([^;]+);/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(typeIds.sort(), [...ARRIVAL_WAREHOUSE_IDS, "other"].sort());
  });

  cleanups.forEach((c) => c());
  console.log(`\n${passed} 项通过，${failed} 项失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
